# Contributing

感谢参与！提交前请先阅读以下约定。

## 开发环境

- Node.js ≥ 18（仅用于测试脚本，扩展本身无构建步骤）
- Chrome / Edge（加载已解压扩展调试）

```bash
git clone https://github.com/<your-name>/discord-web-translator.git
cd discord-web-translator
npm test          # 静态校验 + 单元测试
npm run test:e2e  # 真实浏览器 E2E（需要桌面环境 + Edge）
```

调试：在 `chrome://extensions` 打开开发者模式 → 加载已解压的扩展程序 → 选择仓库根目录；修改 `content/content.js` 后在扩展页点刷新，再刷新 Discord 页面。

## 代码约定

- 纯 JavaScript（MV3，无构建、无依赖），缩进 2 空格，文件 UTF-8 无 BOM
- 内容脚本只用 Discord 稳定的 `id` 前缀选择器，不依赖哈希过的 class
- 新增翻译源：在 `background/service-worker.js` 里实现 `xxxTranslate(text, target, settings)`，加入 `runProvider`、`PROVIDER_LABELS`、`PROVIDER_TARGETS`（如有限制）、`translateText` 的 auto 列表，并在 `shared/langs.js` 补充选项
- 修改 UI 文案时同步更新 `options/options.html` 的使用说明

## 测试

- `npm test` 必须通过（CI 也会跑）
- 涉及翻译源逻辑的改动，请在 `test/background.test.cjs` 补 mock 用例
- 涉及消息 DOM/渲染的改动，请在 `test/mock-discord.html` 补对应结构，并验证 `state`、`reason`（诊断信息）符合预期

## 提交 PR

- 一个 PR 聚焦一件事；修复 bug 请附复现步骤（消息内容、是否回复、是否已编辑等）
- 涉及 Discord DOM 的修复，最好附上消息行的 outerHTML 片段（正文可打码）
- 更新 `CHANGELOG.md` 的 Unreleased/当前版本小节

## 报告问题

请提供：

1. 浏览器与扩展版本（弹窗底部或诊断信息里的 `version`）
2. 是「完全没译文」还是「译文不对」；消息是否带引用/已编辑/代码块/剧透
3. 弹窗「复制诊断信息」的输出（会把消息前 32 字带出，敏感内容请先替换）
