/* 生成设置页静态预览（用于截图）：把 chrome.* 桩注入真实 options.html
 * 用法：node tools/gen-preview.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');

const stub = `<script>
(() => {
  window.chrome = {
    storage: {
      sync: { get: (d) => Promise.resolve({ ...d }), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), remove: () => Promise.resolve() },
    },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
    runtime: { sendMessage: () => Promise.resolve({ ok: true, text: '你好，这是翻译测试。', provider: 'mock' }) },
  };
})();
</script>`;

let out = html.replace('<head>', '<head>\n  <base href="../options/" />');
out = out.replace('<script src="../shared/langs.js"></script>', stub + '\n  <script src="../shared/langs.js"></script>');
if (out === html) {
  console.error('未找到注入点，options.html 结构可能已变化');
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, 'test/options-preview.html'), out);
console.log('已生成 test/options-preview.html');
