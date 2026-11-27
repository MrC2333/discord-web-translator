/* Discord 外语翻译器 — 后台 Service Worker
 *
 * 为什么放在后台：内容脚本的 fetch 会受页面 CORS / CSP 限制，
 * 而扩展 Service Worker 凭 host_permissions 可以自由请求翻译接口。
 *
 * 职责：多翻译源调度（自动回退）、请求节流、结果缓存、错误归一化。
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'auto', // auto | google | tencent | bing | mymemory | deepl | youdao | libre | llm
  llmBase: 'https://api.deepseek.com/v1',
  llmKey: '',
  llmModel: 'deepseek-chat',
  // 腾讯混元（OpenAI 兼容接口，一个 API Key 即可）
  hunyuanKey: '',
  hunyuanModel: 'hunyuan-lite',
  deeplKey: '',
  youdaoAppKey: '',
  youdaoAppSecret: '',
  libreUrl: '',
  libreKey: '',
  googleUrl: '', // 可选：Google 反向代理 / 镜像地址（本机网络被验证码拦截时用）
  showFab: true,
  skipSameLang: true,
};

const LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  it: 'Italiano',
  ar: 'العربية',
  tr: 'Türkçe',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  hi: 'हिन्दी',
  pl: 'Polski',
  nl: 'Nederlands',
  uk: 'Українська',
};

// 各翻译源对目标语言代码的要求不同
const TARGET_MAP = {
  bing: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'pt-BR': 'pt' },
  google: {},
  mymemory: {},
  llm: {},
};

// 令牌桶限速：允许少量突发（cap），整体按 interval 补充令牌。
// 串行排队会让并发失效，这里改成「突发 2 个 + 每 160ms 补 1 个」。
const LIMITER = {
  google: { cap: 2, interval: 160 },
  // 腾讯对短时间高频请求比较敏感：降低突发、放慢补充，减少被限流/系统繁忙
  tencent: { cap: 1, interval: 280 },
  bing: { cap: 2, interval: 180 },
  // MyMemory 对每分钟请求数很敏感：放慢到 1.5 秒一次，避免批量翻译时自己打出 429
  mymemory: { cap: 1, interval: 1500 },
};

const buckets = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bucketOf(provider) {
  if (!buckets[provider]) {
    const cfg = LIMITER[provider] || { cap: 1, interval: 300 };
    buckets[provider] = { tokens: cfg.cap, cap: cfg.cap, interval: cfg.interval, last: Date.now() };
  }
  return buckets[provider];
}

function acquireToken(bucket) {
  return new Promise((resolve) => {
    const tick = () => {
      const now = Date.now();
      const add = Math.floor((now - bucket.last) / bucket.interval);
      if (add > 0) {
        bucket.tokens = Math.min(bucket.cap, bucket.tokens + add);
        bucket.last += add * bucket.interval;
      }
      if (bucket.tokens > 0) {
        bucket.tokens -= 1;
        resolve();
        return;
      }
      setTimeout(tick, Math.max(20, bucket.interval - (now - bucket.last)));
    };
    tick();
  });
}

/** 取到令牌后再执行请求（并发由调用方控制，这里只做整体限速） */
function limited(provider, task) {
  return acquireToken(bucketOf(provider)).then(task);
}

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 翻译源熔断：连续失败 2 次的源在冷却期内被跳过，                      */
/* 避免「自动」模式下每条消息都先等一个不可用的接口超时。               */
/* 注意：语种不支持属于单条消息的问题，不参与熔断，否则一条俄语消息就   */
/* 会把腾讯整源熔断，导致后面所有语言都翻译不了。                       */
/* ------------------------------------------------------------------ */

const health = {};
const FAIL_SKIP_AFTER = 2; // 连续失败次数达到后熔断
const COOLDOWN = {
  network: 600e3, // 网络/接口故障：10 分钟（被墙的源不必频繁重试）
  rate: 120e3, // 限流：2 分钟（429 通常是分钟级窗口）
  quota: 900e3, // 免费额度用尽：15 分钟
  auth: 600e3, // Key/鉴权问题：10 分钟
  unsupported: 0, // 语种不支持：不熔断
};

// 探测节流：全部熔断时，每 10 秒给一个源一次「恢复探测」，避免唯一可用源被长期锁死
const PROBE_INTERVAL_MS = 10000;
let lastProbeAt = 0;

function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/engine is not found|not supported|unsupported|不支持|invalid language|no such language/i.test(msg)) {
    return 'unsupported';
  }
  if (/429|rate limit|too many|too frequent|频繁|限流/i.test(msg)) return 'rate';
  if (/额度|quota|每日/i.test(msg)) return 'quota';
  if (/401|403|unauthorized|鉴权|api key/i.test(msg)) return 'auth';
  return 'network';
}

function healthOf(provider) {
  if (!health[provider]) {
    health[provider] = { fails: 0, skipUntil: 0, lastError: '', lastClass: '', lastFailAt: 0 };
  }
  return health[provider];
}

function providerHealthy(provider) {
  return healthOf(provider).skipUntil <= Date.now();
}

function markProviderFailure(provider, err) {
  const h = healthOf(provider);
  h.lastError = String((err && err.message) || err);
  h.lastClass = classifyError(err);
  if (h.lastClass === 'unsupported') return; // 只影响这一条消息，不熔断整个源
  h.fails += 1;
  h.lastFailAt = Date.now();
  if (h.fails >= FAIL_SKIP_AFTER) {
    h.skipUntil = Date.now() + (COOLDOWN[h.lastClass] || COOLDOWN.network);
  }
}

function markProviderSuccess(provider) {
  const h = healthOf(provider);
  h.fails = 0;
  h.skipUntil = 0;
  h.lastError = '';
  h.lastClass = '';
}

function resetHealth() {
  for (const k of Object.keys(health)) delete health[k];
  lastProbeAt = 0;
}

/* ------------------------------------------------------------------ */
/* 缓存：chrome.storage.local，30 天过期，最多 1200 条                  */
/* ------------------------------------------------------------------ */

const CACHE_KEY = 'dxt_cache_v1';
const CACHE_MAX = 1200;
const CACHE_TTL = 30 * 864e5;
let cache = null;
let saveTimer = null;

async function loadCache() {
  if (cache) return cache;
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    cache = r[CACHE_KEY] || {};
  } catch {
    cache = {};
  }
  const now = Date.now();
  for (const k of Object.keys(cache)) {
    if (!cache[k] || now - (cache[k].at || 0) > CACHE_TTL) delete cache[k];
  }
  return cache;
}

function scheduleCacheSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    try {
      chrome.storage.local.set({ [CACHE_KEY]: cache });
    } catch {
      /* ignore */
    }
  }, 1000);
}

function hashText(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ */
/* 文本切分（Google 单请求 URL/表单不宜过长）                           */
/* ------------------------------------------------------------------ */

function splitText(text, max = 1500) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf('。', max));
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function guessSourceLang(text) {
  const c = { cjk: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, thai: 0, latin: 0 };
  for (const ch of text) {
    const n = ch.codePointAt(0);
    if ((n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf)) c.cjk++;
    else if (n >= 0x3040 && n <= 0x30ff) c.kana++;
    else if (n >= 0xac00 && n <= 0xd7af) c.hangul++;
    else if (n >= 0x0400 && n <= 0x04ff) c.cyrillic++;
    else if (n >= 0x0600 && n <= 0x06ff) c.arabic++;
    else if (n >= 0x0e00 && n <= 0x0e7f) c.thai++;
    else if (/[A-Za-z\u00c0-\u024f]/.test(ch)) c.latin++;
  }
  if (c.kana > 0) return 'ja';
  if (c.hangul > 0) return 'ko';
  if (c.cjk > 0) return 'zh-CN';
  if (c.cyrillic > 0) return 'ru';
  if (c.arabic > 0) return 'ar';
  if (c.thai > 0) return 'th';
  return 'en';
}

/* ------------------------------------------------------------------ */
/* 翻译源：Google（gtx 免费接口）                                       */
/* ------------------------------------------------------------------ */

/* Google 的 tk 令牌算法（经典 TKK 方案，参考 Stichoza/google-translate-php） */
function googleRl(a, b) {
  for (let c = 0; c < b.length - 2; c += 3) {
    let d = b.charCodeAt(c + 2);
    d = d >= 97 ? d - 87 : d - 48;
    d = b[c + 1] === '+' ? a >>> d : a << d;
    a = b[c] === '+' ? (a + d) & 0xffffffff : a ^ d;
  }
  return a;
}

function googleTk(text) {
  const tkk = [406398, 2087938574];
  const d = [];
  let e = 0;
  for (let f = 0; f < text.length; f++) {
    let g = text.charCodeAt(f);
    if (g < 128) {
      d[e++] = g;
    } else {
      if (g < 2048) {
        d[e++] = (g >> 6) | 192;
      } else {
        if (
          (g & 0xfc00) === 0xd800 &&
          f + 1 < text.length &&
          (text.charCodeAt(f + 1) & 0xfc00) === 0xdc00
        ) {
          g = 0x10000 + ((g & 0x3ff) << 10) + (text.charCodeAt(++f) & 0x3ff);
          d[e++] = (g >> 18) | 240;
          d[e++] = ((g >> 12) & 63) | 128;
        } else {
          d[e++] = (g >> 12) | 224;
        }
        d[e++] = ((g >> 6) & 63) | 128;
      }
      d[e++] = (g & 63) | 128;
    }
  }
  let a = tkk[0];
  for (const v of d) {
    a += v;
    a = googleRl(a, '+-a^+6');
  }
  a = googleRl(a, '+-3^+b+-f');
  a ^= tkk[1];
  if (a < 0) a = (a & 0x7fffffff) + 0x80000000;
  a = a % 1000000;
  return a + '.' + (a ^ tkk[0]);
}

async function googleRequest(base, chunk, tl, useTk) {
  const url = useTk
    ? base +
      '/translate_a/single?client=webapp&hl=en&dt=t&sl=auto&tl=' +
      encodeURIComponent(tl) +
      '&ie=UTF-8&oe=UTF-8&tk=' +
      encodeURIComponent(googleTk(chunk))
    : base + '/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) + '&dt=t&dj=1';
  const res = await limited('google', () =>
    fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(chunk),
      },
      5000
    )
  );
  if (res.status === 429 || res.status >= 500) {
    const err = new Error('Google HTTP ' + res.status);
    err.retryable = true;
    throw err;
  }
  if (!res.ok) throw new Error('Google HTTP ' + res.status);
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Google 返回格式异常（可能被限流，请换翻译源）');
  }
  const t = Array.isArray(data)
    ? (data[0] || []).map((s) => (s && s[0]) || '').join('')
    : (data.sentences || []).map((s) => s.trans || '').join('');
  if (!t) throw new Error('Google 返回为空');
  return { text: t, lang: (Array.isArray(data) ? data[2] : data.src) || '' };
}

async function googleTranslate(text, target, settings) {
  const tl = target;
  const mirror =
    settings && typeof settings.googleUrl === 'string'
      ? settings.googleUrl.trim().replace(/\/+$/, '')
      : '';
  const base = mirror || 'https://translate.googleapis.com';
  const parts = [];
  let lang = '';
  for (const chunk of splitText(text, 1500)) {
    let lastErr = null;
    let ok = false;
    // 先带 tk（client=webapp），失败再回退到老的 gtx 方式
    for (const useTk of [true, false]) {
      try {
        const r = await googleRequest(base, chunk, tl, useTk);
        parts.push(r.text);
        lang = lang || r.lang;
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        // 网络层失败（被墙/DNS/TLS）换参数也没用，直接失败，避免多等一轮
        const netErr =
          (e && e.name === 'AbortError') || /Failed to fetch|NetworkError|Load failed/i.test(String((e && e.message) || ''));
        if (netErr) break;
      }
    }
    if (!ok) throw lastErr || new Error('Google 翻译失败');
  }
  return { text: parts.join('\n'), lang };
}

/* ------------------------------------------------------------------ */
/* 翻译源：Bing（网页版 translator 免费接口；cn.bing.com 国内可用）      */
/* ------------------------------------------------------------------ */

let bingSession = { host: '', ig: '', iid: '', key: '', token: '', exp: 0 };

const BING_HOSTS = ['https://cn.bing.com', 'https://www.bing.com'];
let bingHostIdx = 0;

function parseBingPage(html) {
  const ig = (html.match(/IG:"([0-9A-F]+)"/i) || [])[1];
  const iid = (html.match(/data-iid="([^"]+)"/) || [])[1];
  const helper = (html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/) || [])[1] || '';
  const parts = helper.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  if (!ig || !iid || !parts[0] || !parts[1]) return null;
  return { ig, iid, key: parts[0], token: parts[1] };
}

async function bingGetSession(force = false) {
  if (!force && bingSession.token && Date.now() < bingSession.exp) return bingSession;
  let lastErr = null;
  for (let i = 0; i < BING_HOSTS.length; i++) {
    const host = BING_HOSTS[(bingHostIdx + i) % BING_HOSTS.length];
    try {
      const res = await limited('bing', () =>
        fetchWithTimeout(
          host + '/translator',
          {
            headers: { Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
            credentials: 'include',
          },
          8000
        )
      );
      if (!res.ok) throw new Error('Bing 页面 HTTP ' + res.status);
      const html = await res.text();
      const sess = parseBingPage(html);
      if (!sess) throw new Error('Bing 页面缺少翻译参数');
      let servedHost = host;
      try {
        const u = new URL(res.url);
        if (u.origin) servedHost = u.origin;
      } catch {
        /* 保留原 host */
      }
      bingHostIdx = (bingHostIdx + i) % BING_HOSTS.length;
      bingSession = { host: servedHost, ...sess, exp: Date.now() + 30 * 60000 };
      return bingSession;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Bing 页面不可用');
}

async function bingTranslate(text, target) {
  const tl = (TARGET_MAP.bing && TARGET_MAP.bing[target]) || target;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sess = await bingGetSession(attempt > 0);
      const body = new URLSearchParams({
        fromLang: 'auto-detect',
        text,
        to: tl,
        token: sess.token,
        key: sess.key,
      }).toString();
      const res = await limited('bing', () =>
        fetchWithTimeout(
          sess.host + '/ttranslatev3?isVertical=1&&IG=' + sess.ig + '&IID=' + encodeURIComponent(sess.iid),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            credentials: 'include',
            body,
          },
          8000
        )
      );
      if (res.status === 401 || res.status === 403) {
        bingSession.exp = 0;
        bingHostIdx = (bingHostIdx + 1) % BING_HOSTS.length;
        const err = new Error('Bing HTTP ' + res.status);
        err.retryable = true;
        throw err;
      }
      if (res.status === 429 || res.status >= 500) {
        const err = new Error('Bing HTTP ' + res.status);
        err.retryable = true;
        throw err;
      }
      if (!res.ok) throw new Error('Bing HTTP ' + res.status);
      const raw = await res.text();
      if (!raw.trim()) {
        bingSession.exp = 0;
        bingHostIdx = (bingHostIdx + 1) % BING_HOSTS.length;
        const err = new Error('Bing 返回为空');
        err.retryable = true;
        throw err;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        bingSession.exp = 0;
        throw new Error('Bing 返回格式异常');
      }
      const item = Array.isArray(data) ? data[0] : null;
      const translation = item && item.translations && item.translations[0];
      if (!translation || !translation.text) throw new Error('Bing 返回为空');
      return { text: translation.text, lang: (item.detectedLanguage || {}).language || '' };
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') break;
      if (!e.retryable || attempt === 2) break;
      await sleep(400);
    }
  }
  throw lastErr;
}

/* 翻译源：腾讯翻译君（网页版接口，国内可直连、免 Key）                  */
/* ------------------------------------------------------------------ */

const TENCENT_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'zh-TW',
  'pt-BR': 'pt',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  it: 'it',
  ru: 'ru',
  ar: 'ar',
  tr: 'tr',
  th: 'th',
  vi: 'vi',
  id: 'id',
  hi: 'hi',
  pl: 'pl',
  nl: 'nl',
  uk: 'uk',
};

async function tencentTranslate(text, target) {
  const tl = TENCENT_LANG[target] || target;
  const chunks = splitText(text, 1800);
  const parts = [];
  let lang = '';
  for (const chunk of chunks) {
    const body = JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0-Mac OS' },
      type: 'text',
      model_category: 'normal',
      source: { lang: 'auto', text_list: [chunk] },
      target: { lang: tl },
    });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await limited('tencent', () =>
          fetchWithTimeout(
            'https://transmart.qq.com/api/imt',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            },
            6000
          )
        );
        if (res.status === 429 || res.status >= 500) {
          const err = new Error('腾讯翻译 HTTP ' + res.status);
          err.retryable = true;
          throw err;
        }
        if (!res.ok) throw new Error('腾讯翻译 HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.header || data.header.ret_code !== 'succ') {
          const msg = (data && data.message) || '未知错误';
          const err = new Error('腾讯翻译失败：' + msg);
          // 系统繁忙/请求频繁这类是可恢复的，值得重试一次
          err.retryable = /繁忙|频繁|稍后|重试|busy|retry|timeout/i.test(msg);
          throw err;
        }
        const t = (data.auto_translation || [])[0];
        if (typeof t !== 'string' || !t.trim()) throw new Error('腾讯翻译返回为空');
        parts.push(t);
        lang = lang || data.src_lang || '';
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // 超时通常是网络/出口问题，立刻换下一个源比再等一次更划算
        if (e && e.name === 'AbortError') throw e;
        if (!e.retryable || attempt === 1) break;
        await sleep(700);
      }
    }
    if (lastErr) throw lastErr;
  }
  return { text: parts.join('\n'), lang };
}

/* ------------------------------------------------------------------ */
/* 翻译源：MyMemory（免费，限每日额度）                                 */
/* ------------------------------------------------------------------ */

async function myMemoryTranslate(text, target) {
  const src = guessSourceLang(text);
  const q = encodeURIComponent(text.slice(0, 1900));
  const langpair = `${src}|${target}`;
  const res = await limited('mymemory', () =>
    fetchWithTimeout(
      'https://api.mymemory.translated.net/get?q=' + q + '&langpair=' + encodeURIComponent(langpair),
      {},
      8000
    )
  );
  if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
  const data = await res.json();
  const t = data && data.responseData && data.responseData.translatedText;
  if (typeof t !== 'string' || !t.trim()) throw new Error('MyMemory 返回为空');
  if (/MYMEMORY WARNING/i.test(t)) throw new Error('MyMemory 今日免费额度已用完');
  return { text: t, lang: src };
}

/* ------------------------------------------------------------------ */
/* 翻译源：OpenAI 兼容大模型（DeepSeek / OpenAI / 自建）                */
/* ------------------------------------------------------------------ */

async function llmTranslate(text, target, settings) {
  const base = (settings.llmBase || DEFAULTS.llmBase).replace(/\/+$/, '');
  const key = (settings.llmKey || '').trim();
  if (!key) throw new Error('未配置大模型 API Key（请在扩展设置中填写）');
  const model = (settings.llmModel || DEFAULTS.llmModel).trim();
  const body = {
    model,
    temperature: 0,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          '你是一个聊天软件里的翻译引擎。把用户给出的消息翻译成' +
          (LANG_NAMES[target] || target) +
          '。要求：保留 @提及、#频道、链接、代码、emoji 与换行；不要解释、不要加引号，只输出译文；如果原文已经是目标语言，原样返回。',
      },
      { role: 'user', content: text },
    ],
  };
  const res = await fetchWithTimeout(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    throw new Error('大模型 HTTP ' + res.status + (detail ? '：' + detail : ''));
  }
  const data = await res.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out || !String(out).trim()) throw new Error('大模型返回为空');
  return { text: String(out).trim(), lang: '' };
}

/* ------------------------------------------------------------------ */
/* 翻译源：腾讯混元（OpenAI 兼容接口，一个 API Key 即可）                */
/* ------------------------------------------------------------------ */

const HUNYUAN_BASE = 'https://api.hunyuan.cloud.tencent.com/v1';

async function hunyuanTranslate(text, target, settings) {
  const key = String((settings && settings.hunyuanKey) || '').trim();
  if (!key) throw new Error('未配置腾讯混元 API Key（请在扩展设置中填写）');
  return llmTranslate(text, target, {
    ...settings,
    llmBase: HUNYUAN_BASE,
    llmKey: key,
    llmModel: String((settings && settings.hunyuanModel) || '').trim() || 'hunyuan-lite',
  });
}

/* ------------------------------------------------------------------ */
/* 翻译源：DeepL（官方 API，免费 Key 每月 50 万字符）                  */
/* ------------------------------------------------------------------ */

const DEEPL_TARGET = {
  'zh-CN': 'ZH',
  'zh-TW': 'ZH-HANT',
  en: 'EN',
  ja: 'JA',
  ko: 'KO',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  it: 'IT',
  'pt-BR': 'PT-BR',
  ru: 'RU',
  nl: 'NL',
  pl: 'PL',
  uk: 'UK',
  tr: 'TR',
  id: 'ID',
  ar: 'AR',
};

async function deeplTranslate(text, target, settings) {
  const key = (settings.deeplKey || '').trim();
  if (!key) throw new Error('未配置 DeepL API Key');
  const base = /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = new URLSearchParams({ text, target_lang: DEEPL_TARGET[target] || target.toUpperCase() });
  const res = await fetchWithTimeout(base + '/v2/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'DeepL-Auth-Key ' + key },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error('DeepL HTTP ' + res.status + (detail ? '：' + detail : ''));
  }
  const data = await res.json();
  const item = data && data.translations && data.translations[0];
  if (!item || !item.text) throw new Error('DeepL 返回为空');
  return { text: item.text, lang: item.detected_source_language || '' };
}

/* ------------------------------------------------------------------ */
/* 翻译源：有道智云（官方 API，免费额度，国内可直连）                   */
/* ------------------------------------------------------------------ */

const YOUDAO_TARGET = {
  'zh-CN': 'zh-CHS',
  'zh-TW': 'zh-CHT',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  it: 'it',
  'pt-BR': 'pt',
  ru: 'ru',
  ar: 'ar',
  tr: 'tr',
  th: 'th',
  vi: 'vi',
  id: 'id',
  hi: 'hi',
  pl: 'pl',
  nl: 'nl',
  uk: 'uk',
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function youdaoTranslate(text, target, settings) {
  const appKey = (settings.youdaoAppKey || '').trim();
  const appSecret = (settings.youdaoAppSecret || '').trim();
  if (!appKey || !appSecret) throw new Error('未配置有道 appKey/appSecret');
  const salt = String(Date.now());
  const curtime = String(Math.floor(Date.now() / 1000));
  const input = text.length <= 20 ? text : text.slice(0, 10) + text.length + text.slice(-10);
  const sign = await sha256Hex(appKey + input + salt + curtime + appSecret);
  const body = new URLSearchParams({
    q: text,
    from: 'auto',
    to: YOUDAO_TARGET[target] || 'zh-CHS',
    appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
  });
  const res = await fetchWithTimeout('https://openapi.youdao.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('有道 HTTP ' + res.status);
  const data = await res.json();
  if (data.errorCode && data.errorCode !== '0') throw new Error('有道翻译失败：' + data.errorCode);
  const t = data.translation && data.translation[0];
  if (!t) throw new Error('有道返回为空');
  return { text: t, lang: data.l || '' };
}

/* ------------------------------------------------------------------ */
/* 翻译源：LibreTranslate（自建 / 私有实例）                            */
/* ------------------------------------------------------------------ */

async function libreTranslate(text, target, settings) {
  const base = (settings.libreUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 LibreTranslate 地址');
  const body = {
    q: text,
    source: 'auto',
    target: target === 'zh-TW' ? 'zt' : target.split('-')[0],
    format: 'text',
  };
  if (settings.libreKey && settings.libreKey.trim()) body.api_key = settings.libreKey.trim();
  const res = await fetchWithTimeout(base + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error('LibreTranslate HTTP ' + res.status + (detail ? '：' + detail : ''));
  }
  const data = await res.json();
  if (!data || !data.translatedText) throw new Error('LibreTranslate 返回为空');
  return { text: data.translatedText, lang: (data.detectedLanguage && data.detectedLanguage.language) || '' };
}

/* ------------------------------------------------------------------ */
/* 调度                                                               */
/* ------------------------------------------------------------------ */

// 各免费源支持的目标语言（腾讯对俄语等返回 engine not found，提前排除避免白试）
const PROVIDER_TARGETS = {
  tencent: new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt-BR']),
  deepl: new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt-BR', 'ru', 'nl', 'pl', 'uk', 'tr', 'id', 'ar']),
  youdao: new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt-BR', 'ru', 'ar', 'tr', 'th', 'vi', 'id', 'hi', 'pl', 'nl', 'uk']),
};

const PROVIDER_LABELS = {
  google: 'Google 翻译',
  tencent: '腾讯翻译君',
  bing: 'Bing 翻译',
  mymemory: 'MyMemory',
  deepl: 'DeepL',
  youdao: '有道智云',
  libre: 'LibreTranslate',
  hunyuan: '腾讯混元',
  llm: '大模型',
};

function providerSupports(provider, target) {
  const set = PROVIDER_TARGETS[provider];
  return !set || set.has(target);
}

async function runProvider(provider, text, target, settings) {
  switch (provider) {
    case 'google':
      return await googleTranslate(text, target, settings);
    case 'tencent':
      return await tencentTranslate(text, target);
    case 'bing':
      return await bingTranslate(text, target);
    case 'mymemory':
      return await myMemoryTranslate(text, target);
    case 'deepl':
      return await deeplTranslate(text, target, settings);
    case 'youdao':
      return await youdaoTranslate(text, target, settings);
    case 'libre':
      return await libreTranslate(text, target, settings);
    case 'llm':
      return await llmTranslate(text, target, settings);
    case 'hunyuan':
      return await hunyuanTranslate(text, target, settings);
    default:
      throw new Error('未知翻译源：' + provider);
  }
}

async function translateText(text, target, provider, settings) {
  let all;
  if (provider === 'auto') {
    all = ['google', 'tencent', 'bing', 'mymemory'].filter((p) => providerSupports(p, target));
    // 已配置的付费/自建源也加入自动切换（顺序在免费源之后）
    if (settings && settings.deeplKey && settings.deeplKey.trim() && providerSupports('deepl', target)) {
      all.push('deepl');
    }
    if (settings && settings.youdaoAppKey && settings.youdaoAppSecret && providerSupports('youdao', target)) {
      all.push('youdao');
    }
    if (settings && settings.libreUrl && settings.libreUrl.trim()) {
      all.push('libre');
    }
    if (settings && settings.llmKey && settings.llmKey.trim()) all.push('llm');
    if (settings && settings.hunyuanKey && settings.hunyuanKey.trim()) all.push('hunyuan');
    if (!all.length) throw new Error('该语言暂无可用翻译源，请改用 Google 或大模型');
  } else {
    if (!providerSupports(provider, target)) {
      throw new Error((PROVIDER_LABELS[provider] || provider) + '不支持该语种，请改用 Google 或大模型');
    }
    all = [provider];
  }

  let list = all;
  if (provider === 'auto') {
    const healthy = all.filter(providerHealthy);
    const unhealthy = all.filter((p) => !providerHealthy(p));
    const probeDue = Date.now() - lastProbeAt > PROBE_INTERVAL_MS;
    list = healthy.slice();

    if (unhealthy.length) {
      // 按冷却结束时间排序，最早恢复的优先探测；
      // 时间相同时（同一毫秒被熔断）用失败次数兜底，避免探测总停在同一个源上
      unhealthy.sort(
        (a, b) =>
          healthOf(a).skipUntil - healthOf(b).skipUntil || healthOf(a).fails - healthOf(b).fails
      );
      if (!list.length) {
        // 全部熔断：每次只探测一个（轮流），既给恢复机会，又不至于每条消息全量重试
        list = [unhealthy[0]];
        lastProbeAt = Date.now();
      } else if (list.length <= 1) {
        // 只剩 0~1 个「看起来健康」的源时，额外带上一个熔断源一起试，
        // 否则唯一能用的源一旦被熔断，翻译就会长时间卡住
        list.push(unhealthy[0]);
        lastProbeAt = Date.now();
      } else if (probeDue) {
        // 还有多个健康源时，每 10 秒额外探测一个熔断源
        list.push(unhealthy[0]);
        lastProbeAt = Date.now();
      }
    } else if (!list.length) {
      list = all.slice();
    }
  }
  const errors = [];
  let echoed = null;
  for (const p of list) {
    try {
      const r = await runProvider(p, text, target, settings);
      markProviderSuccess(p);
      // 一些源对俚语/缩写会原样返回（如 thank u → thank u）：
      // 不要立刻接受，继续试下一个源；全部原样返回时才认命
      if (sameText(r.text, text)) {
        if (!echoed) echoed = { ...r, provider: p };
        continue;
      }
      return { ...r, provider: p };
    } catch (e) {
      markProviderFailure(p, e);
      errors.push(p + ': ' + ((e && e.message) || e));
    }
  }
  if (echoed) return echoed;
  const hint =
    provider === 'auto' && !providerSupports('tencent', target)
      ? '（该语种免费源有限，建议在设置中启用大模型翻译）'
      : provider === 'auto'
        ? '（当前免费源均不可用：可在设置中填写 DeepSeek 等大模型 Key，或在设置里切换翻译源）'
        : '';
  throw new Error((errors.join('；') || '翻译失败') + hint);
}

function sameText(a, b) {
  const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) === n(b);
}

async function handleTranslate(msg) {
  const text = String(msg.text || '').trim();
  if (!text) return { ok: false, error: '空文本' };
  if (text.length > 6000) return { ok: false, error: '文本过长' };

  let settings = DEFAULTS;
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    /* ignore */
  }
  const target = msg.target || settings.target;
  const provider = msg.provider || settings.provider;
  const key = hashText(`${provider}|${target}|${text}`);

  const c = await loadCache();
  const hit = c[key];
  // 失败结果只缓存 15 秒，避免一条消息失败后被锁死一分钟
  if (hit && (hit.ok ? true : Date.now() - (hit.at || 0) < 15000)) {
    return hit.ok
      ? { ok: true, text: hit.t, lang: hit.l, provider: hit.p, cached: true }
      : { ok: false, error: hit.e || '翻译失败' };
  }

  try {
    const r = await translateText(text, target, provider, settings);
    c[key] = { ok: true, t: r.text, l: r.lang || '', p: r.provider || provider, at: Date.now() };
    scheduleCacheSave();
    return { ok: true, text: r.text, lang: r.lang || '', provider: r.provider || provider };
  } catch (e) {
    const err = String((e && e.message) || e);
    c[key] = { ok: false, e: err, at: Date.now() };
    scheduleCacheSave();
    return { ok: false, error: err };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'translate') {
    handleTranslate(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // 异步响应
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: '1.5.0' });
    return;
  }
  if (msg.type === 'reset-health') {
    resetHealth();
    sendResponse({ ok: true });
    return;
  }
});

/* 供 Node 单元测试使用（扩展运行时无副作用） */
globalThis.__DXT_TEST__ = {
  googleTranslate,
  tencentTranslate,
  bingTranslate,
  myMemoryTranslate,
  llmTranslate,
  hunyuanTranslate,
  translateText,
  handleTranslate,
  splitText,
  guessSourceLang,
  hashText,
  healthOf,
  providerHealthy,
  markProviderFailure,
  markProviderSuccess,
  resetHealth,
  classifyError,
  providerSupports,
  deeplTranslate,
  youdaoTranslate,
  libreTranslate,
};
