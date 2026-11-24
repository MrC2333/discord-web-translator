/* 真实扩展加载测试（Edge headless + CDP）
 *
 * 验证：
 *  1. 扩展能被浏览器加载（manifest 合法、Service Worker 可响应）
 *  2. 设置页正常渲染、chrome.storage 可用
 *  3. 内容脚本能注入真实的 discord.com 页面（出现悬浮开关）
 *
 * 用法：node test/e2e-extension.mjs
 * 需要本机安装 Edge。测试会启动一个使用临时配置目录的无头浏览器。
 */
'use strict';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PORT = 9600 + (process.pid % 300);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dxt-edge-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000, label = '') {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error('等待超时' + (label ? ': ' + label : '') + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let raw = ev.data;
      if (typeof raw !== 'string') raw = Buffer.from(raw).toString('utf8');
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error('WebSocket 错误')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }

  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
      );
    }
    return r.result && r.result.value;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

function extensionId() {
  const hash = createHash('sha256').update(EXT).digest('hex').slice(0, 32);
  return hash
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

/** 从调试目标中找出本扩展的真实 ID（后台 Service Worker 的 URL） */
async function findExtensionId() {
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  for (const t of targets) {
    const m = /^chrome-extension:\/\/([a-p]{32})\/background\/service-worker\.js/.exec(t.url || '');
    if (m) return m[1];
  }
  return null;
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

(async () => {
  const results = [];
  const record = (ok, name, detail) => {
    results.push({ ok, name, detail });
    console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  };

  const child = spawn(
    EDGE,
    [
      '--user-data-dir=' + PROFILE,
      '--load-extension=' + EXT,
      '--disable-extensions-except=' + EXT,
      '--remote-debugging-port=' + PORT,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions-file-access-check',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  child.on('error', (e) => console.error('Edge 启动失败:', e.message));

  let cdp = null;
  try {
    await waitFor(async () => (await httpJson(`http://127.0.0.1:${PORT}/json/version`)).Browser, 20000, '浏览器启动');
    const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有页面目标');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    record(true, 'Edge 无头模式启动并连接 CDP');

    // 0) 从调试目标里读取扩展真实 ID（后台 Service Worker 已启动）
    const id = await waitFor(findExtensionId, 30000, '扩展 Service Worker');
    record(!!id, '扩展被浏览器加载（Service Worker 已启动）', 'ID=' + id);

    // 1) 设置页
    await cdp.send('Page.navigate', { url: `chrome-extension://${id}/options/options.html` });
    await sleep(1800);
    const info = await cdp.eval(
      `({ url: location.href, title: document.title, hasForm: !!document.getElementById('saveBtn'), hasLangs: Array.isArray(window.DXT_LANGS) && window.DXT_LANGS.length > 10, providerOpts: Array.from(document.getElementById('provider').options).map(o => o.text) })`
    );
    if (/chrome-error/.test(info.url || '')) {
      throw new Error('扩展 ID 计算不匹配，无法打开设置页: ' + id);
    }
    record(info.hasForm && info.hasLangs, '扩展设置页可加载', info.title + ' [' + info.providerOpts.join(' / ') + ']');
    await sleep(900); // 等一帧渲染完成再截图
    await cdp.screenshot(path.join(__dirname, 'shot-options.png'));

    // 2) chrome.storage 可用性（设置页里读写）
    const storageOk = await cdp.eval(
      `(async () => { await chrome.storage.sync.set({ __e2e: 123 }); const r = await chrome.storage.sync.get('__e2e'); return r.__e2e === 123; })()`
    );
    record(storageOk === true, 'chrome.storage 可用');

    // 3) Service Worker 响应
    const ping = await cdp.eval(
      `(async () => { try { return await chrome.runtime.sendMessage({ type: 'ping' }); } catch (e) { return 'ERR:' + e.message; } })()`
    );
    record(!!(ping && ping.version), '后台 Service Worker 响应', JSON.stringify(ping));

    // 4) 真实翻译链路（可能因网络/限流失败，失败也应返回结构化错误）
    const tr = await cdp.eval(
      `(async () => { try { return await chrome.runtime.sendMessage({ type: 'translate', text: 'Hello world, how are you?', provider: 'auto', target: 'zh-CN' }); } catch (e) { return { ok: false, error: 'ERR:' + e.message }; } })()`
    );
    record(!!tr && (tr.ok === true || typeof tr.error === 'string'), '翻译请求链路可达', JSON.stringify(tr).slice(0, 160));

    // 5) 内容脚本注入真实 discord.com
    await cdp.send('Page.navigate', { url: 'https://discord.com/login' });
    let dc = null;
    const dcDeadline = Date.now() + 25000;
    while (Date.now() < dcDeadline) {
      await sleep(1000);
      try {
        dc = await cdp.eval(
          `({ url: location.href, title: document.title, fab: !!document.querySelector('.dxt-fab'), bodyLen: document.body ? document.body.innerHTML.length : 0 })`
        );
        if (dc.fab) break;
      } catch {
        /* 页面跳转中 */
      }
    }
    const injected = !!(dc && dc.fab === true);
    record(
      injected,
      '内容脚本注入 discord.com',
      `url=${dc && dc.url} fab=${dc && dc.fab} bodyLen=${dc && dc.bodyLen} title=${dc && dc.title}`
    );
    await cdp.screenshot(path.join(__dirname, 'shot-discord.png'));

    // 6) 在真实 discord.com 页面注入模拟消息，验证「内容脚本 + 真实 API」全链路
    if (injected) {
      await cdp.eval(`(() => {
        const host = document.createElement('div');
        host.id = 'dxt-e2e-host';
        host.style.cssText = 'position:fixed;left:20px;top:20px;width:520px;background:#313338;padding:12px;z-index:99999;border-radius:8px;';
        host.innerHTML = '<ol style="list-style:none;margin:0;padding:0;">' +
          '<li id="chat-messages-777001"><div id="message-content-777001" class="messageContent_e2e" style="user-select:text">Hey everyone, the new season starts next week. Are you ready?</div></li>' +
          '<li id="chat-messages-777002"><div id="message-content-777002" class="messageContent_e2e" style="user-select:text">こんにちは！新しいシーズンを楽しみにしています。</div></li>' +
          '<li id="chat-messages-777003"><div id="message-reply-context-777003" class="repliedMessage_e2e" style="font-size:12px;color:#949ba4;user-select:text"><span>Replying to @Alice</span><div id="message-content-777004" class="messageContent_e2e" style="user-select:text">the new season starts next week</div></div><div id="message-content-777003" class="messageContent_e2e" style="user-select:text">Yes! I already bought the pass, see you there.</div></li>' +
          '<li id="chat-messages-777005"><div id="message-content-777005" class="messageContent_e2e" style="user-select:text">ok <span class="edited_abc" aria-label="已编辑">(已编辑)</span></div></li>' +
          '</ol>';
        document.body.appendChild(host);
        return true;
      })()`);
      await sleep(8000);
      const injectedMsgs = await cdp.eval(`(() => {
        const rows = Array.from(document.querySelectorAll('#dxt-e2e-host li[id^="chat-messages-"]')).map((li) => {
          const contents = Array.from(li.querySelectorAll('[id^="message-content-"]')).map((c) => {
            const t = c.querySelector('.dxt-trans');
            const qt = c.querySelector('.dxt-quote-trans');
            return {
              id: c.id,
              state: c.dataset.dxtState || '',
              text: t ? t.textContent : '',
              quote: qt ? qt.textContent : '',
            };
          });
          return { id: li.id, contents };
        });
        return rows;
      })()`);
      const bodyIds = ['777001', '777002', '777003', '777005'];
      const bodiesOk = bodyIds.every((id) =>
        injectedMsgs.some((r) => r.contents.some((c) => c.id.endsWith(id) && c.text && !c.text.includes('已编辑')))
      );
      const quoteOk = injectedMsgs.some((r) => r.contents.some((c) => c.quote));
      const allOk = injectedMsgs.length === 4 && bodiesOk && quoteOk;
      record(allOk, '真实 discord.com 页面消息翻译（含引用正文、已编辑消息）', JSON.stringify(injectedMsgs).slice(0, 320));
      if (allOk) await cdp.screenshot(path.join(__dirname, 'shot-discord-translated.png'));

      // 7) 批量吞吐测试：再注入 10 条消息，统计全部翻译完成耗时
      await cdp.eval(`(() => {
        const host = document.createElement('div');
        host.id = 'dxt-perf-host';
        host.style.cssText = 'position:fixed;left:560px;top:20px;width:560px;background:#313338;padding:12px;z-index:99999;border-radius:8px;';
        let html = '<ol style="list-style:none;margin:0;padding:0;">';
        const lines = [
          'The match starts in five minutes, everyone get ready.',
          'I think the update is really good this time.',
          'Can someone send the invite link again?',
          'We need one more player for the raid tonight.',
          'That boss was way too hard yesterday.',
          'My settings got reset after the patch.',
          'Anyone know how to fix the lag on the second map?',
          'The new battle pass looks amazing.',
          'I will be online after dinner, see you then.',
          'Thanks for the help earlier, that was quick.',
        ];
        lines.forEach((t, i) => {
          const n = 778001 + i;
          html += '<li id="chat-messages-' + n + '"><div id="message-content-' + n + '" class="messageContent_e2e" style="user-select:text">' + t + '</div></li>';
        });
        host.innerHTML = html + '</ol>';
        document.body.appendChild(host);
        return true;
      })()`);
      const t0 = Date.now();
      let done = 0;
      while (Date.now() - t0 < 30000) {
        done = await cdp.eval(`document.querySelectorAll('#dxt-perf-host .dxt-trans').length`);
        if (done >= 10) break;
        await sleep(250);
      }
      const elapsed = Date.now() - t0;
      record(done >= 10, '批量翻译吞吐（10 条）', done + '/10 条，用时 ' + elapsed + 'ms');

      // 8) 划词翻译：用真实鼠标拖选消息文字 → 出现「译」按钮 → 点击出结果卡片
      const msgRect = await cdp.eval(`(() => {
        const el = document.getElementById('message-content-777001');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      let selected = 0;
      if (msgRect) {
        const y = msgRect.y + 8;
        const x1 = msgRect.x + 4;
        const x2 = Math.min(msgRect.x + msgRect.w - 6, 1240);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: x1,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        for (let i = 1; i <= 5; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x1 + ((x2 - x1) * i) / 5,
            y,
            button: 'left',
            buttons: 1,
          });
        }
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: x2,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        await sleep(400);
        selected = await cdp.eval(`(window.getSelection() || '').toString().length`);
      }
      const pillVisible = await cdp.eval(`!!document.querySelector('.dxt-sel-pill')`);
      let selBody = null;
      if (pillVisible) {
        await cdp.eval(`document.querySelector('.dxt-sel-pill').click()`);
        await sleep(4000);
        selBody = await cdp.eval(`(() => {
          const c = document.querySelector('.dxt-sel-card');
          if (!c) return null;
          const b = c.querySelector('.dxt-sel-body');
          return { text: b.textContent, failed: b.classList.contains('dxt-sel-error') };
        })()`);
      }
      record(
        selected > 0 && pillVisible && !!(selBody && !selBody.failed && selBody.text),
        '划词翻译（选中 → 按钮 → 卡片）',
        pillVisible
          ? selBody
            ? selBody.text.slice(0, 40)
            : '无结果卡片'
          : '未出现按钮（选区长度 ' + selected + '）'
      );
    }

    // 6) 控制台错误收集（提前开启太麻烦，这里看扩展页面自身是否干净）
    const errors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error')
    );
    record(errors.length === 0, '扩展页面无运行时错误', errors.length ? JSON.stringify(errors[0]).slice(0, 200) : '0');
  } catch (e) {
    record(false, 'E2E 执行', e.message);
  } finally {
    try {
      if (cdp) cdp.ws.close();
    } catch {}
    try {
      child.kill();
      // 连同子进程一起结束，避免残留实例占用端口
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
    await sleep(800);
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {}
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();



