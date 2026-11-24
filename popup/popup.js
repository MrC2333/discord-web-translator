/* Discord 外语翻译器 — 弹窗逻辑 */
'use strict';

const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'auto',
};

const $ = (id) => document.getElementById(id);

function fillSelect(sel, items, value, useValue) {
  sel.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    if (useValue) {
      opt.value = it.value;
      opt.textContent = it.label;
    } else {
      opt.value = it.code;
      opt.textContent = it.label;
    }
    sel.appendChild(opt);
  }
  sel.value = value;
}

async function activeDiscordTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !/^https:\/\/([\w-]+\.)?discord\.com\//.test(tab.url)) return null;
  return tab;
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function init() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  fillSelect($('target'), window.DXT_LANGS, settings.target, false);
  fillSelect($('provider'), window.DXT_PROVIDERS, settings.provider, true);
  $('enabled').checked = settings.enabled !== false;

  $('enabled').addEventListener('change', (e) => {
    chrome.storage.sync.set({ enabled: e.target.checked });
  });
  $('target').addEventListener('change', (e) => {
    chrome.storage.sync.set({ target: e.target.value });
  });
  $('provider').addEventListener('change', (e) => {
    chrome.storage.sync.set({ provider: e.target.value });
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const tab = await activeDiscordTab();
  if (!tab) {
    setStatus('请先打开 Discord 网页版（discord.com）再使用。');
    $('translateAll').disabled = true;
    $('diagnose').disabled = true;
    return;
  }

  const providerLabel =
    (window.DXT_PROVIDERS.find((p) => p.value === settings.provider) || {}).label || settings.provider;
  setStatus('已连接到 Discord 标签页 · 翻译源：' + providerLabel);

  $('translateAll').addEventListener('click', async () => {
    $('translateAll').disabled = true;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'translate-all' });
      setStatus(
        res && res.ok
          ? '已开始翻译，译文会显示在每条消息下方。'
          : '没有收到页面响应，请刷新 Discord 页面后重试。',
        res && res.ok ? 'ok' : 'err'
      );
    } catch (e) {
      setStatus('无法连接页面脚本，请刷新 Discord 页面后重试。', 'err');
    }
    setTimeout(() => {
      $('translateAll').disabled = false;
    }, 1500);
  });

  $('diagnose').addEventListener('click', async () => {
    $('diagnose').disabled = true;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' });
      if (!res || !res.ok) throw new Error('页面脚本未响应');
      const text = JSON.stringify(res, null, 2);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        /* fallback */
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setStatus('诊断信息已复制，请粘贴给开发者。', 'ok');
    } catch (e) {
      setStatus(
        '诊断失败：' + (e && e.message ? e.message : e) + '，请刷新 Discord 页面后重试。',
        'err'
      );
    }
    setTimeout(() => {
      $('diagnose').disabled = false;
    }, 1500);
  });
}

init().catch((e) => {
  setStatus('初始化失败：' + (e && e.message ? e.message : e), 'err');
});
