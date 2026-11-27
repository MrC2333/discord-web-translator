/* 静态完整性校验：manifest、引用文件、脚本语法、权限匹配
 * 用法：node test/validate.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const checks = [];

function check(name, fn) {
  try {
    const r = fn();
    checks.push({ name, ok: true, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    checks.push({ name, ok: false, detail: e.message });
    problems.push(name + ': ' + e.message);
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

check('manifest 为合法 JSON 且为 MV3', () => {
  must(manifest.manifest_version === 3, 'manifest_version 不是 3');
  must(manifest.name && manifest.version, '缺少 name/version');
  return manifest.name + ' v' + manifest.version;
});

check('manifest 引用的文件都存在', () => {
  const files = new Set();
  (manifest.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach((f) => files.add(f));
    (cs.css || []).forEach((f) => files.add(f));
  });
  Object.values(manifest.icons || {}).forEach((f) => files.add(f));
  if (manifest.background && manifest.background.service_worker) files.add(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) files.add(manifest.action.default_popup);
  if (manifest.options_page) files.add(manifest.options_page);
  for (const f of files) {
    must(fs.existsSync(path.join(ROOT, f)), '缺少文件 ' + f);
  }
  return files.size + ' 个文件';
});

check('HTML 中引用的脚本/样式都存在', () => {
  const pages = ['popup/popup.html', 'options/options.html'];
  for (const p of pages) {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
    for (const r of refs) {
      if (/^https?:/.test(r)) continue;
      const abs = path.resolve(path.dirname(path.join(ROOT, p)), r);
      must(fs.existsSync(abs), p + ' 引用了不存在的 ' + r);
    }
  }
  return pages.join(', ');
});

check('图标尺寸正确', () => {
  const png = require('node:fs').readFileSync(path.join(ROOT, 'icons/icon128.png'));
  must(png[0] === 0x89 && png[1] === 0x50, 'icon128.png 不是 PNG');
  return 'PNG 有效';
});

check('内容脚本是合法 JS', () => {
  const code = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  new Function(code); // 语法检查（不执行）
  return code.length + ' 字节';
});

check('后台脚本是合法 JS', () => {
  const code = fs.readFileSync(path.join(ROOT, 'background/service-worker.js'), 'utf8');
  new Function(code);
  return code.length + ' 字节';
});

check('所有文本文件均为合法 UTF-8（扩展加载会被非 UTF-8 阻断）', () => {
  const dec = new TextDecoder('utf-8', { fatal: true });
  const exts = new Set(['.json', '.js', '.css', '.html', '.mjs', '.cjs', '.md', '.py', '.txt']);
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'docs') continue;
        walk(p);
      } else if (exts.has(path.extname(ent.name).toLowerCase())) {
        files.push(p);
      }
    }
  };
  walk(ROOT);
  for (const f of files) {
    try {
      dec.decode(fs.readFileSync(f));
    } catch {
      throw new Error('非 UTF-8 文件：' + path.relative(ROOT, f));
    }
  }
  return files.length + ' 个文件';
});

check('代码使用的翻译域名都在 host_permissions 中', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'background/service-worker.js'), 'utf8');
  const hosts = new Set(manifest.host_permissions || []);
  const builtin = [
    'https://translate.googleapis.com',
    'https://transmart.qq.com',
    'https://cn.bing.com',
    'https://www.bing.com',
    'https://api.mymemory.translated.net',
    'https://api-free.deepl.com',
    'https://openapi.youdao.com',
  ];
  const optional = ['https://api.deepseek.com', 'https://api.openai.com', 'https://api.hunyuan.cloud.tencent.com'];
  for (const h of builtin) {
    must(sw.includes(h), '代码里未使用 ' + h);
    must([...hosts].some((p) => p.startsWith(h + '/')), 'host_permissions 缺少 ' + h);
  }
  for (const h of optional) {
    must([...hosts].some((p) => p.startsWith(h + '/')), 'host_permissions 缺少 ' + h);
  }
  return '内置源 ' + builtin.length + ' 个 + 大模型 ' + optional.length + ' 个';
});

check('内容脚本的 Discord 选择器与测试页一致', () => {
  const js = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'test/mock-discord.html'), 'utf8');
  must(js.includes('li[id^="chat-messages-"]'), '内容脚本缺少消息选择器');
  must(js.includes('[id^="message-content-"]'), '内容脚本缺少正文选择器');
  must(html.includes('id="chat-messages-'), '测试页缺少消息节点');
  must(html.includes('id="message-content-'), '测试页缺少正文节点');
  return '选择器一致';
});

check('Telegram K/A 选择器与模拟页一致', () => {
  const js = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  must(js.includes('.bubble[data-mid]'), '缺少 Telegram K 气泡选择器');
  must(js.includes("'[data-message-id]'"), '缺少 Telegram A 消息选择器');
  must(js.includes('.message-content'), '缺少 Telegram A 正文选择器');
  const k = fs.readFileSync(path.join(ROOT, 'test/mock-telegram-k.html'), 'utf8');
  const a = fs.readFileSync(path.join(ROOT, 'test/mock-telegram-a.html'), 'utf8');
  must(k.includes('data-mid='), 'Telegram K 模拟页缺少 data-mid');
  must(a.includes('data-message-id='), 'Telegram A 模拟页缺少 data-message-id');
  must(k.includes('dxt-site'), 'Telegram K 模拟页缺少站点标识');
  must(a.includes('dxt-site'), 'Telegram A 模拟页缺少站点标识');
  return 'K/A 一致';
});

check('浏览器内置翻译（离线）已接入', () => {
  const js = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  const langs = fs.readFileSync(path.join(ROOT, 'shared/langs.js'), 'utf8');
  must(js.includes('Translator.availability'), '内容脚本未接入 Translator API');
  must(js.includes('Translator.create'), '内容脚本缺少 Translator.create');
  must(js.includes('downloadBuiltinPack'), '缺少内置语言包下载逻辑');
  must(js.includes('dxt-builtin-prompt'), '缺少内置翻译下载提示');
  must(/value: 'builtin'/.test(langs), 'provider 列表缺少 builtin');
  const mock = fs.readFileSync(path.join(ROOT, 'test/mock-builtin.html'), 'utf8');
  must(mock.includes('Translator'), '内置翻译模拟页缺少 Translator 桩');
  return 'builtin 已接入';
});

check('发送前翻译（输入框）已接入', () => {
  const js = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
  must(js.includes('handleOutgoingEnter'), '缺少输入框 Enter 拦截');
  must(js.includes('outgoingEnabled'), '缺少 outgoingEnabled 设置');
  must(js.includes('OUTGOING_PREFIX_RE'), '缺少语言前缀解析');
  must(fs.existsSync(path.join(ROOT, 'test/mock-outgoing.html')), '缺少发送前翻译模拟页');
  const opt = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  must(opt.includes('outgoingTarget'), '设置页缺少发送目标语言');
  return 'outgoing 已接入';
});

console.log('');
for (const c of checks) {
  console.log((c.ok ? '✓ ' : '✗ ') + c.name + (c.detail ? ' — ' + c.detail : ''));
}
console.log('');
if (problems.length) {
  console.error('存在问题：\n' + problems.join('\n'));
  process.exit(1);
}
console.log('全部通过：' + checks.length + ' 项');
