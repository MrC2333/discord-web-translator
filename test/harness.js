/* Mock chrome.* API for content-script testing on a plain page.
 * 用一组固定映射模拟翻译结果，避免测试依赖外网。
 */
(() => {
  'use strict';

  const MAP = [
    [
      'Hey everyone, the new season starts next week. Are you ready for the update?',
      '大家好，新赛季下周就开始了。你们准备好迎接更新了吗？',
      'en',
    ],
    [
      'こんにちは！新しいシーズンをとても楽しみにしています。',
      '你好！我非常期待新赛季。',
      'ja',
    ],
    [
      'Привет всем! Я из России, рад познакомиться с вами.',
      '大家好！我来自俄罗斯，很高兴认识你们。',
      'ru',
    ],
    [
      'Good morning! Can anyone help me with the quest on the second island?',
      '早上好！有人能帮我做第二个岛上的任务吗？',
      'en',
    ],
    [
      'EDIT: the season was delayed to next month, sorry everyone.',
      '编辑：赛季推迟到下个月了，抱歉各位。',
      'en',
    ],
    [
      '<@123456789> the /join command is broken for me, can someone check the logs?',
      '@123456789 对我来说 /join 命令坏了，有人能看一下日志吗？',
      'en',
    ],
    [
      'Also, the patch notes are here: https://example.com/patch — check them out!',
      '另外，补丁说明在这里：https://example.com/patch —— 看看吧！',
      'en',
    ],
    ['ok', '好的', 'en'],
    ['Good', '好', 'en'],
    ['Hello everyone, are you ready for the update?', '大家好，准备好迎接更新了吗？', 'en'],
    ['こんにちは！今日はいい天気ですね。', '你好！今天天气真好。', 'ja'],
    ['Photo caption: the new map looks great', '图片说明：新地图看起来很棒', 'en'],
    ['Keep in mind this guy is a scam', '记住这家伙是个骗子', 'en'],
    ['This message has reactions and must still be translated.', '这条消息有反应，但仍然应该被翻译。', 'en'],
    [
      'New patch notes are live The update brings a new map and balance changes. Read more on the website.',
      '新补丁说明已上线。本次更新带来一张新地图和平衡性调整，更多内容请见官网。',
      'en',
    ],
    ['Спасибо всем за игру!', '谢谢大家陪我玩！', 'ru'],
    ['Привет! Как дела?', '你好！最近怎么样？', 'ru'],
    [
      'Yes! I already bought the pass, see you there.',
      '是的！我已经买了通行证，到时候见。',
      'en',
    ],
    [
      'the new season starts next week',
      '新赛季下周开始',
      'en',
    ],
    [
      '```\nconst answer = 42; // 这段代码不应该被翻译破坏\n```\nPlease review this snippet when you have time.',
      '```\nconst answer = 42; // 这段代码不应该被翻译破坏\n```\n有时间的话请帮忙看看这段代码。',
      'en',
    ],
    [
      '```\nconst answer = 42; // 这段代码不应该被翻译破坏\n```',
      '```\nconst answer = 42; // 这段代码不应该被翻译破坏\n```',
      'en',
    ],
  ];

  function fakeTranslate(text) {
    const hay = String(text || '').replace(/\s+/g, ' ').trim();
    // 长 key 优先，避免短句抢先匹配
    const sorted = [...MAP].sort((a, b) => b[0].length - a[0].length);
    for (const [src, dst, lang] of sorted) {
      if (hay.indexOf(src) !== -1) return { text: dst, lang };
    }
    return { text: '【译文】' + text, lang: 'auto' };
  }

  const store = {};
  const listeners = [];

  const chromeShim = {
    storage: {
      sync: {
        get: (defaults) => Promise.resolve({ ...defaults, ...store }),
        set: (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          listeners.forEach((fn) => fn(changes, 'sync'));
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn),
      },
    },
    runtime: {
      lastError: null,
      onMessage: {
        addListener: (fn) => {
          chromeShim._onMessage = fn;
        },
      },
      sendMessage: (msg, cb) => {
        setTimeout(() => {
          if (!msg || msg.type !== 'translate') {
            cb({ ok: false, error: 'unsupported' });
            return;
          }
          if (msg.text.includes('TRIGGER_FAIL')) {
            cb({ ok: false, error: 'mock failure' });
            return;
          }
          const r = fakeTranslate(msg.text);
          cb({ ok: true, text: r.text, lang: r.lang, provider: 'mock' });
        }, 40);
      },
    },
    tabs: {
      sendMessage: () => Promise.resolve({ ok: false }),
    },
  };

  // 覆盖页面自带的 window.chrome（普通页面里 chrome 对象是可配置的）
  try {
    Object.defineProperty(window, 'chrome', { value: chromeShim, configurable: true, writable: true });
  } catch {
    window.chrome = chromeShim;
  }

  window.__DXT_MOCK__ = { fakeTranslate, store };
})();
