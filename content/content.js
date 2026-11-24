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
  const TRANS_CLS = 'dxt-trans';
  const QUOTE_TRANS_CLS = 'dxt-quote-trans';

  const DEFAULTS = {
    enabled: true,
    target: 'zh-CN',
    provider: 'auto',
    showFab: true,
    skipSameLang: true,
    selectionTranslate: true,
    selectionAuto: false,
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
        const tag = el.tagName;
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

  function cacheKey(text) {
    return `${settings.provider}|${settings.target}|${text}`;
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
          const res = await requestViaBackground(job.text);
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

  function requestViaBackground(text) {
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
          { type: 'translate', text, provider: settings.provider, target: settings.target },
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

  function requestTranslation(text, priority) {
    const key = cacheKey(text);
    const hit = cache.get(key);
    if (hit && (hit.ok || Date.now() - hit.at < FAIL_COOLDOWN_MS)) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);

    const p = new Promise((resolve) => {
      const job = { text, resolve };
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
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: '翻译超时' }), REQUEST_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(
          { type: 'translate', text, provider: settings.provider, target: settings.target },
          (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message || '后台无响应' });
              return;
            }
            resolve(res && typeof res === 'object' ? res : { ok: false, error: '后台无响应' });
          }
        );
      } catch (e) {
        clearTimeout(timer);
        resolve({ ok: false, error: '扩展已更新，请刷新页面' });
      }
    });
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
      return;
    }
    const fallback = findContent(li);
    if (fallback) processContentEl(fallback, force);
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

  function collectDiagnostics() {
    const all = Array.from(document.querySelectorAll(MSG_SEL)).map((li) => ({
      id: li.id,
      reply: !!li.querySelector(QUOTE_SEL),
      contents: Array.from(li.querySelectorAll(CONTENT_SEL)).map(diagnoseContent),
    }));
    // 重点收集「没译文」的行，再附上最近几条，便于定位个例
    const problems = all.filter(
      (r) => r.contents.length === 0 || r.contents.some((c) => !c.hasTrans && c.state !== 'skip')
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
      },
      reasons: reasonCount,
      rows,
    };
  }

  function scanAll(force = false) {
    if (!alive) return;
    if (!force && !settings.enabled) return;
    // 直接按内容节点扫描：回复消息里被引用的正文与回复正文是两个独立节点
    document.querySelectorAll(CONTENT_SEL).forEach((c) => processContentEl(c, force));
    document.querySelectorAll(QUOTE_SEL).forEach((q) => processQuote(q, force));
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
      toast(
        '翻译暂时失败，会自动重试：' +
          msg.slice(0, 70) +
          '（也可在扩展设置中更换翻译源）'
      );
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

