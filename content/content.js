/* Discord 外语翻译器 — 内容脚本
 *
 * 在 Discord 网页版里发现消息、判断语言、把译文以「译」块追加到消息下方。
 * 适配点：
 *  - Discord 的 className 是哈希过的，因此选择器只用稳定的 id 前缀：
 *      li[id^="chat-messages-"]  消息行
 *      [id^="message-content-"]  消息正文
 *  - 虚拟列表会卸载/重建消息节点：用 text 级缓存避免重复请求
 *  - 新消息、编辑、频道切换：MutationObserver + 低频兜底扫描
 */
(() => {
  'use strict';
  if (window.__DXT_CONTENT__) return;
  window.__DXT_CONTENT__ = true;

  const MSG_SEL = '[id^="chat-messages-"]';
  const CONTENT_SEL = '[id^="message-content-"]';
  const QUOTE_SEL = '[id^="message-reply-context-"]';
  // 链接预览 / 机器人卡片
  const EMBED_SEL = '[class*="embedWrapper"], [class*="embedFull"], [class*="embedCard"]';
  const TRANS_CLS = 'dxt-trans';
  const QUOTE_TRANS_CLS = 'dxt-quote-trans';
  const EMBED_TRANS_CLS = 'dxt-embed-trans';

  // Telegram Web：K（web.telegram.org/k）与 A（web.telegram.org/a）
  const TG_K_ROW = '.bubble[data-mid]:not(.is-date)';
  const TG_A_ROW = '[data-message-id]';
  const SITE = (() => {
    const meta = document.querySelector('meta[name="dxt-site"]');
    if (meta && meta.content) return meta.content;
    const h = location.hostname;
    if (h.endsWith('discord.com')) return 'discord';
    if (h === 'web.telegram.org' || h.endsWith('.telegram.org')) {
      return location.pathname.startsWith('/a/') ? 'telegram-a' : 'telegram-k';
    }
    return 'other';
  })();

  const DEFAULTS = {
    enabled: true,
    target: 'zh-CN',
    provider: 'auto',
    showFab: true,
    skipSameLang: true,
    selectionTranslate: true,
    selectionAuto: false,
    outgoingEnabled: false,
    outgoingTarget: 'en',
    outgoingKeepOriginal: false,
  };

  let settings = { ...DEFAULTS };
  let alive = true;
  let generation = 0; // 设置变更后作废在途请求

  const stats = { translated: 0, failed: 0 };
  const cache = new Map(); // key -> { ok, text, lang, at }
  const inflight = new Map();
  const sources = new WeakMap(); // 译文节点 -> 原文
  const staleTimers = new Map();
  const pendingProcess = new Set();
  let processTimer = null;
  let consecutiveFailures = 0;
  let lastWarnAt = 0;
  let lastLangWarnAt = 0;
  let fab = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 文本抽取 ---------------- */

  function extractText(root) {
    const collect = (skipUiNoise) => {
      let out = '';
      const walk = (node) => {
        if (node.nodeType === 3) {
          out += node.nodeValue;
          return;
        }
        if (node.nodeType !== 1) return;
        const el = node;
        const cls = el.getAttribute && el.getAttribute('class');
        if (cls && cls.indexOf(TRANS_CLS) !== -1) return;
        if (cls && /spoiler/i.test(cls)) return; // 剧透内容不翻译，避免剧透外泄
        // 「(已编辑)」标记常带隐藏的编辑时间（如 2026年11月24日…）：
        // 这些都不是消息内容，剔除，否则短消息会被误判/翻译成原样
        if (skipUiNoise && cls && /edited|timestamp|tooltip/i.test(cls)) return;
        // embed 的作者名/页脚通常是站点名或日期，翻译没有意义
        if (cls && /embedAuthor|embedFooter|embedProvider/i.test(cls)) return;
        // Telegram 的界面噪音：时间、播放量、反应、时长角标、转发/签名等
        // 注意：必须精确到具体类名，不能用裸 reaction/badge/duration，
        // 否则会把正文根节点上的 has-reactions / has-replies 一起误杀
        if (
          el !== root &&
          cls &&
          /message-time|message-views|message-replies|message-pinned|message-signature|message-imported|message-price|message-effect-icon|message-reaction|message-action-buttons|ReactionStaticEmoji|quick-reaction|message-select-control|message-media-duration|message-duration/i.test(
            cls
          )
        ) {
          return;
        }
        const tag = el.tagName;
        if ((tag === 'IMG' || tag === 'CANVAS') && isTelegram()) {
          // Telegram 的表情/贴纸/预览图：alt 里是表情名或文件信息，不适合翻译
          return;
        }
        if (tag === 'IMG') {
          const alt = el.getAttribute('alt') || '';
          if (alt && !/^:[^:]+:$/.test(alt)) out += ' ' + alt + ' ';
          return;
        }
        if (tag === 'BR') {
          out += '\n';
          return;
        }
        if (tag === 'PRE') {
          out += '\n```\n' + el.textContent + '\n```\n';
          return;
        }
        if (tag === 'CODE') {
          out += '`' + el.textContent + '`';
          return;
        }
        for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
      };
      walk(root);
      return out;
    };

    const clean = (raw) =>
      raw
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        // 兜底：结构不可预测时，仍去掉 (已编辑)/(edited) 字样
        .replace(/[（(]\s*(已编辑|edited)\s*[）)]/gi, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    let text = clean(collect(true));
    // 如果标记恰好包住了整段正文，剔除后为空，退回不剔除的模式
    if (!text) text = clean(collect(false));
    return text;
  }

  const URL_ONLY_RE = /^(https?:\/\/\S+|www\.\S+|discord\.gg\/\S+)$/i;

  function countLetters(t) {
    const m = t.match(/\p{L}/gu);
    return m ? m.length : 0;
  }

  function scriptCounts(text) {
    const c = { latin: 0, cjk: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, thai: 0, devanagari: 0, other: 0 };
    for (const ch of text) {
      const n = ch.codePointAt(0);
      if ((n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf)) c.cjk++;
      else if (n >= 0x3040 && n <= 0x30ff) c.kana++;
      else if (n >= 0xac00 && n <= 0xd7af) c.hangul++;
      else if (n >= 0x0400 && n <= 0x04ff) c.cyrillic++;
      else if (n >= 0x0600 && n <= 0x06ff) c.arabic++;
      else if (n >= 0x0e00 && n <= 0x0e7f) c.thai++;
      else if (n >= 0x0900 && n <= 0x097f) c.devanagari++;
      else if (/[A-Za-z\u00c0-\u024f]/.test(ch)) c.latin++;
      else c.other++;
    }
    return c;
  }

  const EN_STOPWORDS = new Set([
    'the', 'is', 'are', 'you', 'to', 'and', 'it', 'this', 'that', 'what', 'i', 'we', 'they',
    'not', 'for', 'with', 'have', 'do', 'be', 'on', 'in', 'my', 'your', 'of', 'a', 'an',
  ]);
  function englishScore(text) {
    let n = 0;
    for (const w of text.toLowerCase().split(/[^a-z']+/)) if (EN_STOPWORDS.has(w)) n++;
    return n;
  }

  function isSameLanguage(text) {
    const t = settings.target;
    const c = scriptCounts(text);
    const total = c.latin + c.cjk + c.kana + c.hangul + c.cyrillic + c.arabic + c.thai + c.devanagari + c.other;
    if (!total) return true;
    const r = (n) => n / total;
    if (t === 'zh-CN' || t === 'zh-TW') {
      if (c.kana > 0 && r(c.kana) > 0.12) return false; // 日文
      if (c.hangul > 0 && r(c.hangul) > 0.4) return false; // 韩文
      // 只有中文占绝对多数才跳过；中英混排、短外语消息仍然翻译
      return r(c.cjk) > 0.8;
    }
    if (t === 'ja') return c.kana > 0 && r(c.kana) > 0.03;
    if (t === 'ko') return c.hangul > 0 && r(c.hangul) > 0.3;
    if (t === 'ru' || t === 'uk') return c.cyrillic > 0 && r(c.cyrillic) > 0.4;
    if (t === 'ar') return c.arabic > 0 && r(c.arabic) > 0.4;
    if (t === 'th') return c.thai > 0 && r(c.thai) > 0.4;
    if (t === 'hi') return c.devanagari > 0 && r(c.devanagari) > 0.4;
    if (t === 'en') return c.latin > 0 && r(c.latin) > 0.6 && englishScore(text) >= 2;
    return false;
  }

  function normalize(t) {
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function shouldTranslate(text) {
    if (!text || text.length < 2) return false;
    if (text.length > 4000) return false;
    if (countLetters(text) < 2) return false;
    if (URL_ONLY_RE.test(text)) return false;
    if (settings.skipSameLang !== false && isSameLanguage(text)) return false;
    return true;
  }

  /* ---------------- 翻译请求队列 ---------------- */

  // 可见区域的消息走优先队列，避免长频道要等到底部才轮到
  const QUEUE_HI = [];
  const QUEUE_LO = [];
  let active = 0;
  const MAX_ACTIVE = 4;
  const FAIL_COOLDOWN_MS = 10000; // 首次失败 10 秒后重试，之后按 2 倍退避
  const REQUEST_TIMEOUT_MS = 20000;

  function cacheKey(text, target) {
    return `${settings.provider}|${target || settings.target}|${text}`;
  }

  function nextJob() {
    if (QUEUE_HI.length) return QUEUE_HI.shift();
    if (QUEUE_LO.length) return QUEUE_LO.shift();
    return null;
  }

  function drainQueue(reason) {
    while (QUEUE_HI.length) QUEUE_HI.shift().resolve({ ok: false, error: reason });
    while (QUEUE_LO.length) QUEUE_LO.shift().resolve({ ok: false, error: reason });
  }

  function pump() {
    while (active < MAX_ACTIVE) {
      const job = nextJob();
      if (!job) return;
      active++;
      (async () => {
        try {
          const res = await translateAnywhere(job.text, job.target);
          job.resolve(res);
        } catch (e) {
          job.resolve({ ok: false, error: String((e && e.message) || e) });
        } finally {
          active--;
          pump();
        }
      })();
    }
  }

  function isVisible(li) {
    try {
      const r = li.getBoundingClientRect();
      const h = window.innerHeight || 800;
      return r.bottom > -150 && r.top < h + 150;
    } catch {
      return false;
    }
  }

  function requestViaBackground(text, target, providerOverride) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish({ ok: false, error: '翻译超时' }), REQUEST_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(
          {
            type: 'translate',
            text,
            provider: providerOverride || settings.provider,
            target: target || settings.target,
          },
          (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              finish({ ok: false, error: chrome.runtime.lastError.message || '后台无响应' });
              return;
            }
            finish(res && typeof res === 'object' ? res : { ok: false, error: '后台无响应' });
          }
        );
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, error: '扩展已更新，请刷新页面' });
      }
    });
  }

  /* ---------------- 浏览器内置翻译（端侧，免 Key、可离线） ---------------- */
  // Chrome/Edge 138+ 自带 Translator API；语言包下载需要一次用户手势，
  // 下载完成后完全离线可用，适合「所有网络翻译源都不可用」的场景。
  const BUILTIN_TRANSLATORS = new Map(); // `${src}>${tgt}` -> Promise<Translator>
  const BUILTIN_AVAIL = new Map(); // `${src}>${tgt}` -> { state, at }
  let builtinDetector = null;
  let lastBuiltinPair = null;

  function builtinSupported() {
    return typeof Translator !== 'undefined';
  }

  function builtinTargetLang(override) {
    const t = String(override || settings.target || 'zh-CN');
    if (t === 'zh-TW' || t === 'zh-Hant') return 'zh-Hant';
    return t.split('-')[0];
  }

  /** 粗略按文字脚本判断语种（LanguageDetector 不可用时兜底） */
  function guessLangByScript(text) {
    const c = scriptCounts(text);
    if (c.kana > 0) return 'ja';
    if (c.hangul > 0) return 'ko';
    if (c.cyrillic > 0) return 'ru';
    if (c.arabic > 0) return 'ar';
    if (c.thai > 0) return 'th';
    if (c.devanagari > 0) return 'hi';
    if (c.cjk > 0) return 'zh';
    return 'en';
  }

  async function detectLangForBuiltin(text) {
    if (typeof LanguageDetector !== 'undefined') {
      try {
        if (!builtinDetector) builtinDetector = LanguageDetector.create();
        const d = await builtinDetector;
        const res = await d.detect(text.slice(0, 400));
        const top = res && res[0];
        if (top && top.detectedLanguage && top.detectedLanguage !== 'und') {
          return String(top.detectedLanguage).split('-')[0];
        }
      } catch {
        builtinDetector = null; // 检测器不可用，退回脚本判断
      }
    }
    return guessLangByScript(text);
  }

  async function builtinAvailability(src, tgt) {
    const key = src + '>' + tgt;
    const hit = BUILTIN_AVAIL.get(key);
    if (hit && (hit.state === 'available' || Date.now() - hit.at < 60000)) return hit.state;
    let state = 'unavailable';
    try {
      state = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
    } catch {
      state = 'unavailable';
    }
    BUILTIN_AVAIL.set(key, { state, at: Date.now() });
    return state;
  }

  async function getBuiltinTranslator(src, tgt) {
    const key = src + '>' + tgt;
    let p = BUILTIN_TRANSLATORS.get(key);
    if (!p) {
      p = Translator.create({ sourceLanguage: src, targetLanguage: tgt });
      BUILTIN_TRANSLATORS.set(key, p);
      // 创建失败（需要手势/不支持）时清掉缓存，避免一直拿到 rejected promise
      p.catch(() => BUILTIN_TRANSLATORS.delete(key));
    }
    return p;
  }

  function splitForBuiltin(text, max = 3000) {
    if (text.length <= max) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max);
      if (cut < max * 0.5) cut = max;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  async function builtinTranslate(text, targetOverride) {
    if (!builtinSupported()) throw new Error('当前浏览器不支持内置翻译（需要 Chrome/Edge 138+）');
    const tgt = builtinTargetLang(targetOverride);
    const src = await detectLangForBuiltin(text);
    if (src === tgt) return { ok: true, text, lang: src, provider: 'builtin' };
    lastBuiltinPair = { src, tgt };
    const state = await builtinAvailability(src, tgt);
    if (state !== 'available') {
      const err = new Error(
        state === 'downloadable' || state === 'downloading'
          ? '内置翻译语言包尚未下载（点一下即可下载，之后离线可用）'
          : '内置翻译暂不支持该语言对'
      );
      err.needsDownload = true;
      err.pair = { src, tgt };
      throw err;
    }
    const tr = await getBuiltinTranslator(src, tgt);
    const chunks = splitForBuiltin(text);
    const out = [];
    for (const chunk of chunks) out.push(await tr.translate(chunk));
    return { ok: true, text: out.join('\n'), lang: src, provider: 'builtin' };
  }

  /** 只能在用户点击回调里调用：下载语言包 */
  async function downloadBuiltinPack(pair) {
    const { src, tgt } = pair;
    const tr = await Translator.create({ sourceLanguage: src, targetLanguage: tgt });
    BUILTIN_TRANSLATORS.set(src + '>' + tgt, Promise.resolve(tr));
    BUILTIN_AVAIL.set(src + '>' + tgt, { state: 'available', at: Date.now() });
    return tr;
  }

  function showBuiltinPrompt(pair) {
    if (document.getElementById('dxt-builtin-prompt')) return;
    const box = document.createElement('div');
    box.id = 'dxt-builtin-prompt';
    const tip = document.createElement('div');
    tip.className = 'dxt-bp-tip';
    tip.textContent = '翻译源暂时都不可用。下载浏览器内置翻译包后，可离线翻译（只需一次）。';
    const btn = document.createElement('button');
    btn.className = 'dxt-bp-btn';
    btn.textContent = '下载内置翻译包';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '下载中…';
      try {
        await downloadBuiltinPack(pair);
        // 同时把反向语言包也下好（如 en→zh 与 zh→en），发送前翻译才能离线用
        if (pair.src !== pair.tgt) {
          try {
            await downloadBuiltinPack({ src: pair.tgt, tgt: pair.src });
          } catch {
            /* 反向包失败不影响阅读 */
          }
        }
        box.remove();
        toast('内置翻译已就绪，正在重新翻译…');
        // 清掉失败缓存与退避，让消息立刻用内置翻译重试
        cache.clear();
        inflight.clear();
        document.querySelectorAll('[data-dxt-state="fail"]').forEach((el) => {
          delete el.dataset.dxtState;
          delete el.dataset.dxtFailAt;
          delete el.dataset.dxtFails;
        });
        setTimeout(() => scanAll(true), 50);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '重试下载';
        toast('下载失败：' + ((e && e.message) || e));
      }
    });
    box.appendChild(tip);
    box.appendChild(btn);
    (document.body || document.documentElement).appendChild(box);
  }

  async function translateAnywhere(text, target) {
    const tgtOverride = target && target !== settings.target ? target : '';
    if (settings.provider === 'builtin') {
      try {
        return await builtinTranslate(text, tgtOverride || undefined);
      } catch (e) {
        if (e && e.needsDownload) showBuiltinPrompt(e.pair);
        // 发送前翻译（目标语言不同）允许回退到网络源，保证消息能翻出去
        if (tgtOverride) return requestViaBackground(text, tgtOverride, 'auto');
        return { ok: false, error: (e && e.message) || String(e) };
      }
    }
    if (settings.provider === 'auto' && builtinSupported()) {
      // 内置翻译可用时优先：完全离线、无额度限制
      const tgt = builtinTargetLang(tgtOverride || undefined);
      const src = guessLangByScript(text);
      lastBuiltinPair = { src, tgt };
      if (src !== tgt) {
        try {
          const state = await builtinAvailability(src, tgt);
          if (state === 'available') {
            const r = await builtinTranslate(text, tgtOverride || undefined);
            if (r && r.ok && r.text) return r;
          }
        } catch {
          /* 内置不可用时继续走后台 */
        }
      }
    }
    return requestViaBackground(text, tgtOverride || undefined);
  }

  function requestTranslation(text, priority, target) {
    const key = cacheKey(text, target);
    const hit = cache.get(key);
    if (hit && (hit.ok || Date.now() - hit.at < FAIL_COOLDOWN_MS)) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);

    const p = new Promise((resolve) => {
      const job = { text, target, resolve };
      if (priority) QUEUE_HI.push(job);
      else QUEUE_LO.push(job);
      pump();
    }).then((res) => {
      cache.set(key, { ...res, at: Date.now() });
      if (cache.size > 3000) {
        const first = cache.keys().next().value;
        cache.delete(first);
      }
      return res;
    });
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
    return p;
  }

  /* ---------------- 翻译渲染 ---------------- */

  function render(contentEl, source, translated, lang) {
    const old = contentEl.querySelector('.' + TRANS_CLS);
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.className = TRANS_CLS;
    wrap.dataset.dxt = '1';
    wrap.title =
      (lang ? lang + ' → ' : '→ ') + settings.target + '｜点击「译」可收起';

    const badge = document.createElement('span');
    badge.className = 'dxt-badge';
    badge.textContent = '译';
    badge.title = '收起 / 展开译文';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('dxt-collapsed');
    });

    const txt = document.createElement('span');
    txt.className = 'dxt-text';
    txt.textContent = translated;

    wrap.append(badge, txt);
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'dxt-lang';
      tag.textContent = String(lang).toLowerCase();
      wrap.append(tag);
    }
    sources.set(wrap, source);
    contentEl.appendChild(wrap);
  }

  /** 引用区里的被引用正文：用更紧凑的内联样式 */
  function renderQuote(contentEl, source, translated) {
    const old = contentEl.querySelector('.' + QUOTE_TRANS_CLS);
    if (old) old.remove();
    const span = document.createElement('span');
    span.className = QUOTE_TRANS_CLS;
    span.textContent = '译 ' + translated;
    span.title = '被引用消息的翻译';
    sources.set(span, source);
    contentEl.appendChild(span);
  }

  function findContent(li) {
    let el = li.querySelector(CONTENT_SEL);
    if (el) return el;
    // 个别消息类型没有稳定的 content id，退回 class 前缀匹配
    el = li.querySelector('[class*="messageContent"]');
    return el || null;
  }

  /* ---------------- Telegram Web 适配 ---------------- */

  function isTelegram() {
    return SITE === 'telegram-k' || SITE === 'telegram-a';
  }

  function tgRowSelector() {
    return SITE === 'telegram-k' ? TG_K_ROW : TG_A_ROW;
  }

  function tgRows() {
    if (SITE === 'telegram-k') {
      return Array.from(document.querySelectorAll(TG_K_ROW));
    }
    // A 里 data-message-id 也出现在内部标记元素上，只保留带正文容器的消息根节点
    return Array.from(document.querySelectorAll(TG_A_ROW)).filter((el) =>
      el.querySelector('.message-content')
    );
  }

  function tgContents(row) {
    const list =
      SITE === 'telegram-k'
        ? row.querySelectorAll('.bubble-content .message, .bubble-content .caption')
        : row.querySelectorAll('.message-content');
    return Array.from(list).filter((el) => {
      // 纯媒体消息（no-text）没有可翻译文字，直接跳过
      if (el.classList && el.classList.contains('no-text')) return false;
      return countLetters(extractText(el)) > 0;
    });
  }

  function tgScan(force = false) {
    if (!alive) return;
    if (!force && !settings.enabled) return;
    for (const row of tgRows()) {
      for (const c of tgContents(row)) {
        // Telegram 会复用/重渲染消息节点：译文被移除但 state 还停在 done，
        // 会导致这条消息永远不再翻译。这里检测并复位。
        const wrap = c.querySelector('.' + TRANS_CLS) || c.querySelector('.' + QUOTE_TRANS_CLS);
        if (!wrap && c.dataset.dxtState === 'done') {
          delete c.dataset.dxtState;
          delete c.dataset.dxtFailAt;
          delete c.dataset.dxtFails;
        } else if (wrap) {
          // 消息被编辑（Telegram 有「已编辑」标记）：原文变了就重新翻译
          const src = sources.get(wrap);
          const now = extractText(c);
          if (src !== undefined && now !== src) {
            wrap.remove();
            delete c.dataset.dxtState;
            delete c.dataset.dxtFailAt;
            delete c.dataset.dxtFails;
          }
        }
        processContentEl(c, force);
      }
    }
  }

  let tgScanTimer = null;
  function scheduleTgScan() {
    if (tgScanTimer) return;
    tgScanTimer = setTimeout(() => {
      tgScanTimer = null;
      if (settings.enabled) tgScan();
    }, 250);
  }

  /* ---------------- 引用消息（回复）翻译 ---------------- */

  /** 去掉「回复 @某人」这类 UI 前缀，只保留可翻译的引用内容 */
  function quoteBodyText(t) {
    return t
      .replace(/^\s*(回复|回应|Replying to|Reply to|Answered)\s*/i, '')
      .replace(/@[\w.\-\u4e00-\u9fff]+/g, '')
      .replace(/^[:：\-–—\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function processQuote(q, force = false) {
    if (!alive || !q || !q.isConnected) return;
    // 引用区里如果还有独立的 message-content 节点（被引用消息正文），交给内容节点处理
    if (q.querySelector(CONTENT_SEL)) return;
    if (q.querySelector('.' + QUOTE_TRANS_CLS)) return;
    const st = q.dataset.dxtqState;
    if (st === 'busy' || st === 'done' || st === 'skip') return;
    if (!force && !settings.enabled) return;

    const text = extractText(q);
    if (!text) {
      q.dataset.dxtqState = 'skip';
      return;
    }
    const body = quoteBodyText(text);
    // 只有「回复 @某人」这类提示语时不翻译
    if (countLetters(body) < 6) {
      q.dataset.dxtqState = 'skip';
      return;
    }
    if (settings.skipSameLang !== false && isSameLanguage(body)) {
      q.dataset.dxtqState = 'skip';
      return;
    }

    const gen = generation;
    q.dataset.dxtqState = 'busy';
    try {
      const res = await requestTranslation(body, false);
      if (!alive || gen !== generation) return;
      if (!res || !res.ok) {
        q.dataset.dxtqState = 'skip';
        return;
      }
      const translated = String(res.text || '').trim();
      if (!translated || normalize(translated) === normalize(body)) {
        q.dataset.dxtqState = 'done';
        return;
      }
      const span = document.createElement('span');
      span.className = QUOTE_TRANS_CLS;
      span.textContent = '译 ' + translated;
      span.title = '引用消息的翻译';
      q.appendChild(span);
      q.dataset.dxtqState = 'done';
    } catch {
      q.dataset.dxtqState = 'skip';
    }
  }

  /* ---------------- 链接预览 / 机器人卡片（embed）翻译 ---------------- */

  function renderEmbed(embedEl, source, translated) {
    const block = document.createElement('div');
    block.className = EMBED_TRANS_CLS;
    block.textContent = '译 ' + translated;
    block.title = '链接预览/卡片的翻译';
    sources.set(block, source);
    embedEl.insertAdjacentElement('afterend', block);
  }

  async function processEmbed(el, force = false) {
    if (!alive || !el || !el.isConnected) return;
    if (el.dataset.dxtState === 'busy' || el.dataset.dxtState === 'done') return;
    if (!force && !settings.enabled) return;

    const text = extractText(el);
    if (!text || countLetters(text) < 4) {
      el.dataset.dxtState = 'skip';
      return;
    }
    if (settings.skipSameLang !== false && isSameLanguage(text)) {
      el.dataset.dxtState = 'skip';
      return;
    }

    const gen = generation;
    const priority = isVisible(el);
    el.dataset.dxtState = 'busy';
    try {
      const res = await requestTranslation(text, priority);
      if (!alive || gen !== generation) return;
      if (!res || !res.ok) {
        el.dataset.dxtState = 'skip';
        return;
      }
      const translated = String(res.text || '').trim();
      if (!translated || normalize(translated) === normalize(text)) {
        el.dataset.dxtState = 'done';
        return;
      }
      renderEmbed(el, text, translated);
      el.dataset.dxtState = 'done';
      stats.translated++;
      updateFab();
    } catch {
      el.dataset.dxtState = 'skip';
    }
  }

  /* ---------------- 选中文本翻译（划词） ---------------- */

  let selPill = null;
  let selCard = null;
  let lastSel = null; // { text, rect, at }：最近一次有效选区（防止 mouseup 时选区已被页面清掉）

  function removePill() {
    if (selPill) {
      selPill.remove();
      selPill = null;
    }
  }

  function removeCard() {
    if (selCard) {
      selCard.remove();
      selCard = null;
    }
  }

  function selectionAnchorInMessage(sel) {
    const node = sel.anchorNode;
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    if (el.closest('.' + TRANS_CLS)) return false; // 不翻译自家译文
    if (isTelegram()) return !!el.closest(tgRowSelector());
    return !!el.closest(MSG_SEL);
  }

  /** 记录最近一次非空选区（selectionchange 在拖动过程中就会触发） */
  function rememberSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 3000) return;
    if (!selectionAnchorInMessage(sel)) return;
    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect || (!rect.width && !rect.height)) return;
    lastSel = { text, rect, at: Date.now() };
  }

  function handleSelection() {
    if (!alive || settings.selectionTranslate === false) return;

    let text = '';
    let rect = null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const t = sel.toString().trim();
      if (t.length >= 2 && t.length <= 3000 && selectionAnchorInMessage(sel)) {
        try {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r && (r.width || r.height)) {
            text = t;
            rect = r;
          }
        } catch {
          /* ignore */
        }
      }
    }
    // mouseup 时选区常已被页面清空，退回最近一次有效选区的快照
    if (!text && lastSel && Date.now() - lastSel.at < 1500) {
      text = lastSel.text;
      rect = lastSel.rect;
    }
    if (!text || !rect) {
      removePill();
      return;
    }

    if (settings.selectionAuto) {
      removePill();
      openSelCard(rect, text);
      return;
    }
    showSelPill(rect, text);
  }

  function showSelPill(rect, text) {
    removePill();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dxt-sel-pill';
    btn.textContent = '译';
    btn.title = '翻译选中的文字';
    const x = Math.min(window.innerWidth - 46, Math.max(6, rect.right - 34));
    const y = rect.top > 56 ? rect.top - 36 : rect.bottom + 8;
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePill();
      openSelCard(rect, text);
    });
    (document.body || document.documentElement).appendChild(btn);
    selPill = btn;
  }

  function openSelCard(rect, text) {
    removeCard();
    const card = document.createElement('div');
    card.className = 'dxt-sel-card';
    const width = Math.min(430, Math.max(240, window.innerWidth - 24));
    card.style.left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left)) + 'px';
    card.style.width = width + 'px';
    card.style.top = '8px'; // 渲染后再定位到选区旁
    card.innerHTML =
      '<div class="dxt-sel-head">' +
      '<span class="dxt-badge">译</span>' +
      '<span class="dxt-sel-lang"></span>' +
      '<button type="button" class="dxt-sel-copy">复制</button>' +
      '<button type="button" class="dxt-sel-close" title="关闭">×</button>' +
      '</div>' +
      '<div class="dxt-sel-body">翻译中…</div>';

    const body = card.querySelector('.dxt-sel-body');
    const langEl = card.querySelector('.dxt-sel-lang');
    const copyBtn = card.querySelector('.dxt-sel-copy');

    card.querySelector('.dxt-sel-close').addEventListener('click', () => removeCard());
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(body.textContent || '');
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => {
        copyBtn.textContent = '复制';
      }, 1200);
    });

    (document.body || document.documentElement).appendChild(card);
    selCard = card;

    requestAnimationFrame(() => {
      const h = card.offsetHeight || 120;
      const below = rect.bottom + 8;
      const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, rect.top - h - 8);
      card.style.top = top + 'px';
    });

    translateSelection(text).then((res) => {
      if (!selCard || selCard !== card) return;
      if (res && res.ok && res.text) {
        body.textContent = res.text;
        if (res.lang) langEl.textContent = String(res.lang).toLowerCase();
      } else {
        body.textContent = '翻译失败：' + ((res && res.error) || '未知错误');
        body.classList.add('dxt-sel-error');
      }
    });
  }

  function translateSelection(text) {
    return translateAnywhere(text);
  }

  async function copyText(t) {
    if (!t) return false;
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      /* fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function processContentEl(content, force = false) {
    if (!alive) return;
    if (!content || !content.isConnected) return;
    // 引用区里的被引用正文用紧凑样式；普通消息正文用完整样式
    const inQuote = !!content.closest(QUOTE_SEL);
    if (content.querySelector('.' + TRANS_CLS) || content.querySelector('.' + QUOTE_TRANS_CLS)) return;

    const state = content.dataset.dxtState;
    if (state === 'busy' || state === 'done') return;
    if (state === 'fail') {
      const at = Number(content.dataset.dxtFailAt || 0);
      const fails = Math.max(1, Number(content.dataset.dxtFails || 1));
      const wait = Math.min(60000, FAIL_COOLDOWN_MS * Math.pow(2, Math.min(fails - 1, 3)));
      if (Date.now() - at < wait) return;
    }
    if (state === 'skip') return;
    if (!force && !settings.enabled) return;

    const text = extractText(content);
    if (!text || !shouldTranslate(text)) {
      content.dataset.dxtState = 'skip';
      return;
    }

    const gen = generation;
    const priority = isVisible(content);
    content.dataset.dxtState = 'busy';
    content.dataset.dxtBusyAt = String(Date.now());
    try {
      const res = await requestTranslation(text, priority);
      if (!alive || gen !== generation) return;
      if (!res || !res.ok) {
        content.dataset.dxtState = 'fail';
        content.dataset.dxtFailAt = String(Date.now());
        content.dataset.dxtFails = String(Number(content.dataset.dxtFails || 0) + 1);
        onFailure((res && res.error) || '翻译失败');
        return;
      }
      const translated = String(res.text || '').trim();
      if (!translated || normalize(translated) === normalize(text)) {
        content.dataset.dxtState = 'done';
        return;
      }
      if (inQuote) renderQuote(content, text, translated);
      else render(content, text, translated, res.lang);
      content.dataset.dxtState = 'done';
      delete content.dataset.dxtFails;
      consecutiveFailures = 0;
      stats.translated++;
      updateFab();
      // 一旦有消息翻译成功，立刻给失败的消息一次机会（避免整页长时间“停摆”）
      if (stats.failed > 0) {
        stats.failed = 0;
        recoverFailedMessages();
      }
    } catch (e) {
      content.dataset.dxtState = 'fail';
      content.dataset.dxtFailAt = String(Date.now());
      content.dataset.dxtFails = String(Number(content.dataset.dxtFails || 0) + 1);
      onFailure(String((e && e.message) || e));
    }
  }

  /** 处理一条消息行：回复消息里可能有多个 content 节点（被引用正文 + 回复正文） */
  async function processMessage(li, force = false) {
    if (!alive) return;
    if (!li || !li.isConnected) return;
    const list = li.querySelectorAll(CONTENT_SEL);
    if (list.length) {
      for (const c of list) processContentEl(c, force);
    } else {
      const fallback = findContent(li);
      if (fallback) processContentEl(fallback, force);
    }
    li.querySelectorAll(EMBED_SEL).forEach((e) => processEmbed(e, force));
  }

  /** 解除失败锁定并重扫：成功一次 / 切回标签页时调用 */
  let recoverTimer = null;
  function recoverFailedMessages() {
    if (recoverTimer) return;
    recoverTimer = setTimeout(() => {
      recoverTimer = null;
      let n = 0;
      document.querySelectorAll('[data-dxt-state="fail"]').forEach((el) => {
        delete el.dataset.dxtState;
        delete el.dataset.dxtFailAt;
        delete el.dataset.dxtFails;
        n++;
      });
      if (n && settings.enabled) scanAll();
    }, 300);
  }

  function scheduleProcess(li) {
    pendingProcess.add(li);
    if (processTimer) return;
    processTimer = setTimeout(() => {
      processTimer = null;
      const list = Array.from(pendingProcess);
      pendingProcess.clear();
      for (const el of list) {
        el.querySelectorAll(QUOTE_SEL).forEach((q) => processQuote(q));
        processMessage(el);
      }
    }, 220);
  }

  function clearTranslations() {
    document.querySelectorAll('.' + TRANS_CLS).forEach((n) => n.remove());
    document.querySelectorAll('.' + QUOTE_TRANS_CLS).forEach((n) => n.remove());
    document.querySelectorAll('.' + EMBED_TRANS_CLS).forEach((n) => n.remove());
    document.querySelectorAll('[data-dxt-state]').forEach((n) => {
      delete n.dataset.dxtState;
      delete n.dataset.dxtFailAt;
      delete n.dataset.dxtFails;
      delete n.dataset.dxtBusyAt;
    });
    document.querySelectorAll('[data-dxtq-state]').forEach((n) => {
      delete n.dataset.dxtqState;
    });
  }

  /* ---------------- 诊断（排查用，不改页面） ---------------- */

  function diagnoseContent(c) {
    const text = extractText(c);
    const raw = String(c.innerText || '').replace(/\s+/g, ' ');
    let reason = '';
    if (!text) reason = 'empty';
    else if (countLetters(text) < 2) reason = 'no-letters';
    else if (URL_ONLY_RE.test(text)) reason = 'url-only';
    else if (settings.skipSameLang !== false && isSameLanguage(text)) reason = 'same-language';
    else if (
      c.dataset.dxtState === 'done' &&
      !c.querySelector('.' + TRANS_CLS) &&
      !c.querySelector('.' + QUOTE_TRANS_CLS)
    ) {
      reason = 'same-result'; // 翻译结果与原文相同（如拼写错误、专有名词）
    }
    return {
      id: c.id,
      cls: String(c.className || '').slice(0, 80),
      inQuote: !!c.closest(QUOTE_SEL),
      state: c.dataset.dxtState || '',
      len: text.length,
      hasTrans: !!(c.querySelector('.' + TRANS_CLS) || c.querySelector('.' + QUOTE_TRANS_CLS)),
      reason,
      preview: text.slice(0, 32),
      rawHasEdited: /已编辑|edited/i.test(raw),
    };
  }

  function collectTelegramDiagnostics() {
    const rows = tgRows();
    const all = rows.map((row) => ({
      id: row.getAttribute('data-mid') || row.getAttribute('data-message-id') || '',
      contents: tgContents(row).map(diagnoseContent),
    }));
    const problems = all.filter((r) => r.contents.some((c) => !c.hasTrans && c.state !== 'skip'));
    const tail = all.slice(-5);
    const picked = [];
    const seen = new Set();
    for (const r of [...problems, ...tail]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
    const reasonCount = {};
    for (const r of all) {
      for (const c of r.contents) {
        const k = c.hasTrans ? 'translated' : c.reason || c.state || 'unknown';
        reasonCount[k] = (reasonCount[k] || 0) + 1;
      }
    }
    return {
      ok: true,
      site: SITE,
      version: (() => {
        try {
          return chrome.runtime.getManifest().version;
        } catch {
          return '';
        }
      })(),
      url: location.href.slice(0, 120),
      enabled: settings.enabled,
      provider: settings.provider,
      target: settings.target,
      fab: !!document.querySelector('.dxt-fab'),
      counts: {
        rows: rows.length,
        contents: all.reduce((n, r) => n + r.contents.length, 0),
        translated: document.querySelectorAll('.' + TRANS_CLS).length,
      },
      reasons: reasonCount,
      rows: picked.slice(-30),
    };
  }

  function collectDiagnostics() {
    if (isTelegram()) return collectTelegramDiagnostics();
    const all = Array.from(document.querySelectorAll(MSG_SEL)).map((li) => ({
      id: li.id,
      reply: !!li.querySelector(QUOTE_SEL),
      contents: Array.from(li.querySelectorAll(CONTENT_SEL)).map(diagnoseContent),
      embeds: Array.from(li.querySelectorAll(EMBED_SEL)).map((e) => {
        const text = extractText(e);
        const next = e.nextElementSibling;
        return {
          state: e.dataset.dxtState || '',
          len: text.length,
          hasTrans: !!(next && next.classList && next.classList.contains(EMBED_TRANS_CLS)),
          preview: text.slice(0, 32),
        };
      }),
    }));
    // 重点收集「没译文」的行，再附上最近几条，便于定位个例
    const problems = all.filter(
      (r) =>
        r.contents.length === 0 ||
        r.contents.some((c) => !c.hasTrans && c.state !== 'skip') ||
        r.embeds.some((e) => !e.hasTrans && e.state !== 'skip')
    );
    const tail = all.slice(-5);
    const picked = [];
    const seen = new Set();
    for (const r of [...problems, ...tail]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
    const rows = picked.slice(-30);
    const reasonCount = {};
    for (const r of all) {
      for (const c of r.contents) {
        const k = c.hasTrans ? 'translated' : c.reason || c.state || 'unknown';
        reasonCount[k] = (reasonCount[k] || 0) + 1;
      }
      for (const e of r.embeds) {
        const k = e.hasTrans ? 'embed-translated' : e.state || 'embed-empty';
        reasonCount[k] = (reasonCount[k] || 0) + 1;
      }
    }
    return {
      ok: true,
      version: (() => {
        try {
          return chrome.runtime.getManifest().version;
        } catch {
          return '';
        }
      })(),
      url: location.href.slice(0, 120),
      enabled: settings.enabled,
      provider: settings.provider,
      target: settings.target,
      fab: !!document.querySelector('.dxt-fab'),
      counts: {
        rows: document.querySelectorAll(MSG_SEL).length,
        contents: document.querySelectorAll(CONTENT_SEL).length,
        translated: document.querySelectorAll('.' + TRANS_CLS).length,
        quoteTranslated: document.querySelectorAll('.' + QUOTE_TRANS_CLS).length,
        embeds: document.querySelectorAll(EMBED_SEL).length,
        embedTranslated: document.querySelectorAll('.' + EMBED_TRANS_CLS).length,
      },
      reasons: reasonCount,
      rows,
    };
  }

  function scanAll(force = false) {
    if (!alive) return;
    if (!force && !settings.enabled) return;
    if (isTelegram()) {
      tgScan(force);
      return;
    }
    // 直接按内容节点扫描：回复消息里被引用的正文与回复正文是两个独立节点
    document.querySelectorAll(CONTENT_SEL).forEach((c) => processContentEl(c, force));
    document.querySelectorAll(QUOTE_SEL).forEach((q) => processQuote(q, force));
    document.querySelectorAll(EMBED_SEL).forEach((e) => processEmbed(e, force));
  }

  /* ---------------- 编辑检测 ---------------- */

  function resetContentState(content) {
    delete content.dataset.dxtState;
    delete content.dataset.dxtFailAt;
    delete content.dataset.dxtFails;
    delete content.dataset.dxtBusyAt;
  }

  function scheduleStaleCheck(content) {
    if (staleTimers.has(content)) clearTimeout(staleTimers.get(content));
    staleTimers.set(
      content,
      setTimeout(() => {
        staleTimers.delete(content);
        if (!content.isConnected) return;
        const wrap =
          content.querySelector('.' + TRANS_CLS) || content.querySelector('.' + QUOTE_TRANS_CLS);
        if (!wrap) {
          // 译文节点被移除（编辑、重新渲染）：清掉旧状态后重新翻译
          resetContentState(content);
          if (settings.enabled) processContentEl(content);
          return;
        }
        const src = sources.get(wrap);
        const now = extractText(content);
        if (src !== undefined && now !== src) {
          wrap.remove();
          resetContentState(content);
          if (settings.enabled) processContentEl(content);
        }
      }, 200)
    );
  }

  /* ---------------- MutationObserver ---------------- */

  const observer = new MutationObserver((muts) => {
    if (!alive) return;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(CONTENT_SEL)) processContentEl(n);
          if (n.matches && n.matches(QUOTE_SEL)) processQuote(n);
          if (n.matches && n.matches(EMBED_SEL)) processEmbed(n);
          if (n.matches && n.matches(MSG_SEL)) {
            scheduleProcess(n);
            continue;
          }
          if (n.querySelectorAll) {
            const inner = n.querySelectorAll(MSG_SEL);
            for (const li of inner) scheduleProcess(li);
            if (!inner.length) {
              n.querySelectorAll(CONTENT_SEL).forEach((c) => processContentEl(c));
              n.querySelectorAll(QUOTE_SEL).forEach((q) => processQuote(q));
              n.querySelectorAll(EMBED_SEL).forEach((e) => processEmbed(e));
            }
          }
        }
      }
      let target = m.target;
      if (target && target.nodeType === 3) target = target.parentElement;
      if (target && target.closest) {
        const content = target.closest(CONTENT_SEL);
        if (content) scheduleStaleCheck(content);
        const quote = target.closest(QUOTE_SEL);
        if (quote && !quote.querySelector(CONTENT_SEL)) scheduleQuoteStaleCheck(quote);
      }
    }
    if (isTelegram()) scheduleTgScan();
  });

  function scheduleQuoteStaleCheck(quote) {
    if (staleTimers.has(quote)) clearTimeout(staleTimers.get(quote));
    staleTimers.set(
      quote,
      setTimeout(() => {
        staleTimers.delete(quote);
        if (!quote.isConnected) return;
        if (quote.querySelector(CONTENT_SEL)) return; // 已改为按内容节点处理
        if (!quote.querySelector('.' + QUOTE_TRANS_CLS)) {
          delete quote.dataset.dxtqState;
          if (settings.enabled) processQuote(quote);
        }
      }, 200)
    );
  }

  /* ---------------- 悬浮开关 / 提示 ---------------- */

  function ensureFab() {
    if (fab) return;
    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'dxt-fab';
    fab.textContent = '译';
    fab.addEventListener('click', () => {
      // 处于错误状态时，点击优先重试失败消息
      if (consecutiveFailures >= 3) {
        consecutiveFailures = 0;
        document.querySelectorAll('[data-dxt-state="fail"]').forEach((n) => {
          delete n.dataset.dxtState;
          delete n.dataset.dxtFailAt;
          delete n.dataset.dxtFails;
          delete n.dataset.dxtBusyAt;
        });
        scanAll(true);
        toast('已重试失败的消息');
        updateFab();
        return;
      }
      setEnabled(!settings.enabled);
    });
    (document.body || document.documentElement).appendChild(fab);
    updateFab();
  }

  function updateFab() {
    if (!fab) return;
    fab.style.display = settings.showFab === false ? 'none' : '';
    fab.dataset.on = settings.enabled ? 'true' : 'false';
    fab.dataset.error = consecutiveFailures >= 3 ? 'true' : 'false';
    if (consecutiveFailures >= 3) {
      fab.title = '翻译失败：点击重试';
    } else {
      fab.title = settings.enabled
        ? 'Discord 翻译：自动翻译已开启（点击关闭）'
        : 'Discord 翻译：自动翻译已关闭（点击开启）';
    }
  }

  function toast(msg) {
    let el = document.getElementById('dxt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dxt-toast';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el.__dxtTimer);
    el.__dxtTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 6000);
  }

  function onFailure(error) {
    stats.failed++;
    consecutiveFailures++;
    updateFab();
    const msg = String(error || '');
    // 语种本身不受当前免费源支持：给出针对性提示，而不是反复刷「服务不可用」
    if (/不支持该语种|免费源有限|该语言暂无可用翻译源/.test(msg)) {
      if (Date.now() - lastLangWarnAt > 30000) {
        lastLangWarnAt = Date.now();
        toast('该语种当前免费源支持有限，建议在设置中启用「大模型」翻译（DeepSeek 等）。');
      }
      return;
    }
    if (consecutiveFailures >= 3 && Date.now() - lastWarnAt > 60000) {
      lastWarnAt = Date.now();
      // 所有网络源都失败时，主动提供「离线内置翻译」的下载入口
      if (settings.provider !== 'builtin' && builtinSupported() && lastBuiltinPair) {
        showBuiltinPrompt(lastBuiltinPair);
        toast('翻译源暂时不可用，可下载浏览器内置翻译包离线使用。');
      } else {
        toast('翻译暂时失败，会自动重试：' + msg.slice(0, 60));
      }
    }
  }

  async function setEnabled(v) {
    settings.enabled = !!v;
    try {
      await chrome.storage.sync.set({ enabled: settings.enabled });
    } catch {
      /* ignore */
    }
    applyEnabled();
  }

  function applyEnabled() {
    generation++;
    drainQueue('设置已更新');
    if (settings.enabled) {
      scanAll();
    } else {
      clearTranslations();
    }
    updateFab();
  }

  /* ---------------- 发送前翻译（输入框） ---------------- */

  const OUTGOING_LANGS = new Set([
    'zh', 'zh-cn', 'zh-tw', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'pt', 'it',
    'ar', 'tr', 'th', 'vi', 'id', 'hi', 'pl', 'nl', 'uk',
  ]);
  const OUTGOING_PREFIX_RE = /^\s*([a-z]{2}(?:-[a-z]{2})?)\s*[:：]\s*/i;
  let outgoingBusy = false;
  let outgoingComposing = false;
  // 输入法组词期间（中文/日文等）回车是在选词，不是发送
  window.addEventListener(
    'compositionstart',
    () => {
      outgoingComposing = true;
    },
    true
  );
  window.addEventListener(
    'compositionend',
    () => {
      setTimeout(() => {
        outgoingComposing = false;
      }, 80);
    },
    true
  );

  function composerFromTarget(t) {
    if (!t || t.nodeType !== 1 || !t.closest) return null;
    const el = t.closest('[contenteditable="true"]');
    if (!el) return null;
    if (el.getAttribute('role') === 'searchbox') return null;
    return el;
  }

  /** 粗略判断文字是否已经是目标语言（避免把英文再翻一遍） */
  function looksLikeTargetLang(text, target) {
    const c = scriptCounts(text);
    const t = String(target || '').toLowerCase();
    const hasLatin = c.latin > 0;
    const noCjk = c.cjk === 0 && c.kana === 0 && c.hangul === 0;
    if (t.startsWith('zh')) return c.cjk > 0 && c.kana === 0 && c.hangul === 0;
    if (t.startsWith('ja')) return c.kana > 0;
    if (t.startsWith('ko')) return c.hangul > 0;
    if (t.startsWith('ru') || t.startsWith('uk')) return c.cyrillic > 0;
    if (t.startsWith('ar')) return c.arabic > 0;
    if (t.startsWith('th')) return c.thai > 0;
    if (t.startsWith('hi')) return c.devanagari > 0;
    // 拉丁语系（en/fr/de/es/...）：全是拉丁字母就认为已是目标语言
    return hasLatin && noCjk && c.cyrillic === 0 && c.arabic === 0;
  }

  function sameTextClient(a, b) {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return n(a) === n(b);
  }

  async function setComposerText(composer, text) {
    const current = () => (composer.innerText || '').replace(/\u200b/g, '').trim();
    if (sameTextClient(current(), text)) return true;

    const selectAll = () => {
      composer.focus();
      try {
        document.execCommand('selectAll');
      } catch {
        /* ignore */
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !composer.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try {
        document.dispatchEvent(new Event('selectionchange'));
      } catch {
        /* ignore */
      }
    };

    // 只走「模拟粘贴」：这是唯一能让 Slate 真正更新内部模型的方式。
    // execCommand 只会改 DOM，模型不同步会导致之后发送/编辑错乱甚至崩溃。
    for (let attempt = 0; attempt < 2; attempt++) {
      selectAll();
      await sleep(150); // 等 selectionchange 传播，Slate 才会把选区同步成全选
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        composer.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
        );
      } catch {
        /* 换一次重试 */
      }
      await sleep(100);
      if (sameTextClient(current(), text)) return true;
    }
    return false;
  }

  async function sendComposer(composer, expected) {
    // 先置忙，确保接下来这次合成的 Enter 不会被自己再拦截一次
    outgoingBusy = true;
    // 关键：等编辑器把译文真正写进 DOM / 内部状态，再派发 Enter。
    // 否则 Slate/React 可能拿旧状态把原文发出去（表现为「看到翻译了，发出去还是原文」）。
    const deadline = Date.now() + 1500;
    let el = composer;
    let retried = false;
    let tries = 0;
    while (expected && Date.now() < deadline) {
      const active = document.activeElement;
      if (active && active.getAttribute && active.getAttribute('contenteditable') === 'true') {
        el = active; // React 可能重建过编辑器节点，用当前聚焦的那个
      }
      const now = (el.innerText || '').replace(/\u200b/g, '').trim();
      if (sameTextClient(now, expected)) break;
      tries++;
      if (!retried && tries >= 6) {
        // 迟迟没写进去：再写一次，避免节点被替换后内容丢失
        retried = true;
        await setComposerText(el, expected);
      }
      await sleep(40);
    }
    await sleep(150); // 再留一帧给 React/Slate 提交内部状态
    try {
      el.focus();
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      outgoingBusy = false;
    }, 400);
  }

  async function handleOutgoingEnter(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (outgoingComposing || e.keyCode === 229) return; // 输入法选词中，交给输入法处理
    if (outgoingBusy) return; // 自己派发的 Enter，放行
    if (!settings.enabled || !settings.outgoingEnabled) return;
    const composer = composerFromTarget(e.target);
    if (!composer) return;

    const raw = composer.innerText || '';
    const text = raw.replace(/\u200b/g, '').trim();
    if (!text || text.length > 2000) return;

    e.preventDefault();
    e.stopPropagation();

    let target = settings.outgoingTarget || 'en';
    let body = text;
    let usedPrefix = false;
    const m = text.match(OUTGOING_PREFIX_RE);
    if (m && OUTGOING_LANGS.has(m[1].toLowerCase())) {
      const rest = text.slice(m[0].length).trim();
      if (rest) {
        target = m[1].toLowerCase();
        body = rest;
        usedPrefix = true;
      }
    }

    if (looksLikeTargetLang(body, target)) {
      // 已经是目标语言：去掉语言前缀后原样发送
      if (usedPrefix) await setComposerText(composer, body);
      await sendComposer(composer, body);
      return;
    }

    outgoingBusy = true;
    let out = body;
    try {
      const res = await requestTranslation(body, true, target);
      out = res && res.ok ? String(res.text || '') : '';
      if (!out || sameTextClient(out, body)) out = body;
      if (settings.outgoingKeepOriginal && out !== body) out = out + '\n' + body;
    } catch {
      out = body;
    }
    const applied = await setComposerText(composer, out);
    if (!applied) {
      // 写不进去就取消发送：绝不发混合内容，也不破坏输入框
      toast('发送前翻译失败：已取消发送（再按一次回车可直接发送原文）');
      outgoingBusy = false;
      return;
    }
    await sendComposer(composer, out);
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...s };
    } catch {
      /* 使用默认值 */
    }

    if (settings.showFab !== false) ensureFab();
    applyEnabled();

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 划词翻译：选中消息里的文字后出现「译」按钮（可在设置里改为选中即翻译）
    // selectionchange 在拖动过程中就会触发，先记住选区，mouseup 时即使选区被页面清掉也能用快照
    document.addEventListener('selectionchange', rememberSelection);
    // 发送前翻译：拦截输入框里的 Enter
    window.addEventListener('keydown', handleOutgoingEnter, true);
    window.addEventListener(
      'mouseup',
      (e) => {
        if (e.target && e.target.closest && e.target.closest('.dxt-sel-pill, .dxt-sel-card')) return;
        handleSelection();
      },
      true
    );
    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('.dxt-sel-pill') || t.closest('.dxt-sel-card'))) return;
      lastSel = null;
      removePill();
      removeCard();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        removePill();
        removeCard();
      }
    });
    window.addEventListener('scroll', () => removePill(), true);
    window.addEventListener('resize', () => {
      removePill();
      removeCard();
    });

    // 兜底扫描：兜住虚拟列表回收、SPA 路由切换等漏网场景
    setInterval(() => {
      if (!alive || !settings.enabled) return;
      if (document.visibilityState === 'hidden') return;
      // 队列积压时先消化积压，避免越扫越多
      if (QUEUE_HI.length + QUEUE_LO.length > 8) return;
      scanAll();
    }, 3000);

    // 清理卡死的 busy 状态（后台被回收、请求异常等极端情况）
    setInterval(() => {
      if (!alive) return;
      document.querySelectorAll('[data-dxt-state="busy"]').forEach((n) => {
        if (Date.now() - Number(n.dataset.dxtBusyAt || 0) > 25000) {
          delete n.dataset.dxtState;
          delete n.dataset.dxtBusyAt;
        }
      });
    }, 10000);

    // 切回标签页时，给失败消息一次立即重试的机会
    document.addEventListener('visibilitychange', () => {
      if (!alive || document.visibilityState !== 'visible') return;
      if (!settings.enabled) return;
      recoverFailedMessages();
      scanAll();
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let changed = false;
        for (const [k, v] of Object.entries(changes)) {
          if (k === 'llmKey' || k === 'llmBase' || k === 'llmModel') continue;
          if (settings[k] !== v.newValue) {
            settings[k] = v.newValue;
            changed = true;
          }
        }
        if (!changed) return;
        if (changes.showFab) updateFab();
        // 只有影响翻译结果的设置才需要清空重译；划词开关之类只更新状态即可
        const retranslateKeys = ['enabled', 'target', 'provider', 'skipSameLang'];
        const needRetranslate = retranslateKeys.some((k) => k in changes);
        if (!needRetranslate) return;
        generation++;
        drainQueue('设置已更新');
        clearTranslations();
        // 用户手动换源/换语言：立即解除后台熔断，马上尝试新源
        try {
          chrome.runtime.sendMessage({ type: 'reset-health' });
        } catch {
          /* ignore */
        }
        if (settings.enabled) scanAll();
        updateFab();
      });
    } catch {
      /* ignore */
    }

    try {
      chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'translate-all') {
          // 手动触发时同时解除熔断并重试失败消息
          try {
            chrome.runtime.sendMessage({ type: 'reset-health' });
          } catch {
            /* ignore */
          }
          recoverFailedMessages();
          scanAll(true);
          respond({ ok: true, translated: stats.translated });
          return;
        }
        if (msg.type === 'get-stats') {
          respond({ ok: true, translated: stats.translated, failed: stats.failed, enabled: settings.enabled });
          return;
        }
        if (msg.type === 'diagnose') {
          respond(collectDiagnostics());
          return;
        }
      });
    } catch {
      /* ignore */
    }

    window.addEventListener('pagehide', () => {
      alive = false;
      observer.disconnect();
    });
  }

  init();
})();

