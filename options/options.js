/* Discord 外语翻译器 — 设置页逻辑 */
'use strict';

const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'auto',
  llmBase: 'https://api.deepseek.com/v1',
  llmKey: '',
  llmModel: 'deepseek-chat',
  deeplKey: '',
  youdaoAppKey: '',
  youdaoAppSecret: '',
  libreUrl: '',
  libreKey: '',
  googleUrl: '',
  showFab: true,
  skipSameLang: true,
  selectionTranslate: true,
  selectionAuto: false,
};

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'dxt_cache_v1';

function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.code || it.value;
    opt.textContent = it.label;
    sel.appendChild(opt);
  }
  sel.value = value;
}

function setResult(el, text, kind) {
  el.textContent = text;
  el.className = 'test-result' + (kind ? ' ' + kind : '');
}

function setSaveHint(text, kind) {
  const el = $('saveHint');
  el.textContent = text;
  el.className = 'save-hint' + (kind ? ' ' + kind : '');
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    target: $('target').value,
    provider: $('provider').value,
    llmBase: $('llmBase').value.trim(),
    llmKey: $('llmKey').value.trim(),
    llmModel: $('llmModel').value.trim() || 'deepseek-chat',
    deeplKey: $('deeplKey').value.trim(),
    youdaoAppKey: $('youdaoAppKey').value.trim(),
    youdaoAppSecret: $('youdaoAppSecret').value.trim(),
    libreUrl: $('libreUrl').value.trim(),
    libreKey: $('libreKey').value.trim(),
    googleUrl: $('googleUrl').value.trim(),
    showFab: $('showFab').checked,
    skipSameLang: $('skipSameLang').checked,
    selectionTranslate: $('selectionTranslate').checked,
    selectionAuto: $('selectionAuto').checked,
  };
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + '/*';
  } catch {
    return null;
  }
}

async function ensureHostPermission(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) return true;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function applyForm() {
  const s = readForm();
  const okLlm = await ensureHostPermission(s.llmBase);
  const okLibre = s.libreUrl ? await ensureHostPermission(s.libreUrl) : true;
  const okGoogle = s.googleUrl ? await ensureHostPermission(s.googleUrl) : true;
  if ((!okLlm && s.provider === 'llm') || (!okLibre && s.libreUrl) || (!okGoogle && s.googleUrl)) {
    setSaveHint('未授予访问该接口地址的权限，对应翻译源可能失败。', 'err');
  }
  await chrome.storage.sync.set(s);
  return s;
}

async function updateCacheInfo() {
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const n = Object.keys(r[CACHE_KEY] || {}).length;
    setResult($('cacheInfo'), '当前缓存 ' + n + ' 条');
  } catch {
    /* ignore */
  }
}

async function testProvider() {
  const btn = $('testBtn');
  btn.disabled = true;
  setResult($('testResult'), '测试中…');
  try {
    const s = await applyForm();
    const res = await chrome.runtime.sendMessage({
      type: 'translate',
      text: 'Hello, welcome to Discord! This is a translation test.',
      provider: s.provider,
      target: s.target,
    });
    if (res && res.ok) {
      setResult($('testResult'), '✓ ' + res.text + '（来源：' + (res.provider || s.provider) + '）', 'ok');
    } else {
      setResult($('testResult'), '✗ ' + ((res && res.error) || '失败'), 'err');
    }
  } catch (e) {
    setResult($('testResult'), '✗ ' + (e && e.message ? e.message : e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  fillSelect($('target'), window.DXT_LANGS, settings.target);
  fillSelect($('provider'), window.DXT_PROVIDERS, settings.provider);
  $('enabled').checked = settings.enabled !== false;
  $('showFab').checked = settings.showFab !== false;
  $('skipSameLang').checked = settings.skipSameLang !== false;
  $('selectionTranslate').checked = settings.selectionTranslate !== false;
  $('selectionAuto').checked = settings.selectionAuto === true;
  $('llmBase').value = settings.llmBase;
  $('llmKey').value = settings.llmKey;
  $('llmModel').value = settings.llmModel;
  $('deeplKey').value = settings.deeplKey || '';
  $('youdaoAppKey').value = settings.youdaoAppKey || '';
  $('youdaoAppSecret').value = settings.youdaoAppSecret || '';
  $('libreUrl').value = settings.libreUrl || '';
  $('libreKey').value = settings.libreKey || '';
  $('googleUrl').value = settings.googleUrl || '';

  $('saveBtn').addEventListener('click', async () => {
    try {
      await applyForm();
      setSaveHint('已保存，Discord 页面会自动应用。', 'ok');
      setTimeout(() => setSaveHint(''), 3000);
    } catch (e) {
      setSaveHint('保存失败：' + (e && e.message ? e.message : e), 'err');
    }
  });

  $('testBtn').addEventListener('click', testProvider);

  $('clearCache').addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove(CACHE_KEY);
      await updateCacheInfo();
      setResult($('cacheInfo'), '缓存已清除', 'ok');
    } catch (e) {
      setResult($('cacheInfo'), '清除失败：' + (e && e.message ? e.message : e), 'err');
    }
  });

  $('provider').addEventListener('change', () => {
    const isLlm = $('provider').value === 'llm';
    $('llmCard').style.opacity = isLlm ? '1' : '0.75';
  });
  $('provider').dispatchEvent(new Event('change'));

  await updateCacheInfo();
}

init().catch((e) => {
  setSaveHint('初始化失败：' + (e && e.message ? e.message : e), 'err');
});
