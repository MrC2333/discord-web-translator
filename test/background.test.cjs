/* 后台逻辑单元测试（Node，无需浏览器）
 *
 * 用法：node test/background.test.cjs
 * 通过 mock fetch 验证各翻译源的请求构造、响应解析、自动回退与缓存。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ---------- chrome API 桩 ---------- */
const syncStore = {};
const localStore = {};
let fetchCalls = [];

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} } },
  storage: {
    sync: {
      get: async (defaults) => ({ ...defaults, ...syncStore }),
    },
    local: {
      get: async (key) => {
        const out = {};
        if (key) out[key] = localStore[key];
        return out;
      },
      set: async (obj) => {
        Object.assign(localStore, obj);
      },
    },
  },
};

/* ---------- mock fetch ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function text(str, status = 200) {
  return new Response(str, { status, headers: { 'content-type': 'text/plain' } });
}

const jwt = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64'),
  Buffer.from(JSON.stringify({ exp: 9999999999, iat: 1, region: 'eastasia', pad: 'x'.repeat(80) })).toString('base64'),
  'sig',
].join('.');

globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), options });
  const u = String(url);

  if (u.includes('cn.bing.com/translator') || u.includes('www.bing.com/translator')) {
    return text(
      '<html><script>var params_AbusePreventionHelper = [1795754774393,"TOKEN123",3600000];</script>' +
        '<div data-iid="translator.5023"></div><script>IG:"49D9021A58264985821928461241A358"</script></html>'
    );
  }
  if (u.includes('/ttranslatev3')) {
    return json([
      { translations: [{ text: '你好，世界', to: 'zh-Hans' }], detectedLanguage: { language: 'en' } },
    ]);
  }
  if (u.includes('transmart.qq.com')) {
    let body = {};
    try {
      body = JSON.parse(options.body || '{}');
    } catch {}
    const text = (body.source && body.source.text_list && body.source.text_list[0]) || '';
    if (text.includes('UNSUPPORTED')) {
      return json({ header: { ret_code: 'error' }, message: 'Required engine is not found' });
    }
    return json({
      header: { type: 'auto_translation', ret_code: 'succ' },
      auto_translation: ['你好，世界'],
      src_lang: 'en',
      tgt_lang: 'zh',
    });
  }
  if (u.includes('api.mymemory.translated.net')) {
    const q = decodeURIComponent((u.match(/[?&]q=([^&]+)/) || [])[1] || '');
    if (q.includes('QUOTA')) {
      return json({
        responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' },
        responseStatus: 200,
      });
    }
    return json({ responseData: { translatedText: '你好，世界' }, responseStatus: 200 });
  }
  if (u.includes('translate.googleapis.com')) {
    const body = options.body || '';
    if (body.includes('CAPTCHA')) return text('<html>sorry</html>');
    if (syncStore.__googleClassic) {
      return json([[['你好', 'hello', null, null, 1]], null, 'en']);
    }
    return json({ sentences: [{ trans: '你好，世界', orig: 'hello world' }], src: 'en' });
  }
  if (u.includes('deepl.com')) {
    return json({ translations: [{ text: '你好，世界', detected_source_language: 'EN' }] });
  }
  if (u.includes('openapi.youdao.com')) {
    return json({ errorCode: '0', translation: ['你好，世界'], l: 'en' });
  }
  if (u.includes('libretest.local')) {
    return json({ translatedText: '你好，世界', detectedLanguage: { language: 'en' } });
  }
  throw new Error('unexpected url: ' + u);
};

/* ---------- 加载被测试的 service worker ---------- */
const code = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
eval(code);
const T = globalThis.__DXT_TEST__;
assert.ok(T, '__DXT_TEST__ 未导出');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let passed = 0;
  const ok = (name) => {
    passed++;
    console.log('✓ ' + name);
  };

  /* 1. Google dj=1 格式 */
  {
    const r = await T.googleTranslate('hello world', 'zh-CN');
    assert.strictEqual(r.text, '你好，世界');
    assert.strictEqual(r.lang, 'en');
    ok('Google dj=1 响应解析');
  }

  /* 2. Google 经典数组格式 */
  {
    syncStore.__googleClassic = true;
    const r = await T.googleTranslate('hello', 'zh-CN');
    assert.strictEqual(r.text, '你好');
    assert.strictEqual(r.lang, 'en');
    syncStore.__googleClassic = false;
    ok('Google 经典数组格式解析');
  }

  /* 3. Google 返回 HTML（被限流）应报错 */
  {
    let err = null;
    try {
      await T.googleTranslate('CAPTCHA test', 'zh-CN');
    } catch (e) {
      err = e;
    }
    assert.ok(err && /格式异常/.test(err.message), '应抛出格式异常');
    ok('Google 限流页面识别');
  }

  /* 4. Bing 网页版翻译（cn.bing.com） */
  {
    syncStore.__x = 1;
    const r = await T.bingTranslate('hello world', 'zh-CN');
    assert.strictEqual(r.text, '你好，世界');
    assert.strictEqual(r.lang, 'en');
    ok('Bing 网页版翻译解析');
  }

  /* 4b. 腾讯翻译君：成功与引擎不支持 */
  {
    const r = await T.tencentTranslate('hello world', 'zh-CN');
    assert.strictEqual(r.text, '你好，世界');
    assert.strictEqual(r.lang, 'en');
    let err = null;
    try {
      await T.tencentTranslate('UNSUPPORTED here', 'zh-CN');
    } catch (e) {
      err = e;
    }
    assert.ok(err && /引擎|腾讯翻译失败/.test(err.message));
    ok('腾讯翻译君解析与错误处理');
  }

  /* 5. MyMemory 正常与额度耗尽 */
  {
    const r = await T.myMemoryTranslate('hello world', 'zh-CN');
    assert.strictEqual(r.text, '你好，世界');
    let err = null;
    try {
      await T.myMemoryTranslate('QUOTA please', 'zh-CN');
    } catch (e) {
      err = e;
    }
    assert.ok(err && /额度/.test(err.message));
    ok('MyMemory 解析与额度检测');
  }

  /* 6. 文本切分 */
  {
    const long = 'Sentence one. '.repeat(400);
    const chunks = T.splitText(long, 1500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 1501));
    assert.strictEqual(chunks.join(''), long);
    ok('长文本切分');
  }

  /* 7. 源语言猜测 */
  {
    assert.strictEqual(T.guessSourceLang('こんにちは'), 'ja');
    assert.strictEqual(T.guessSourceLang('你好世界'), 'zh-CN');
    assert.strictEqual(T.guessSourceLang('Привет'), 'ru');
    assert.strictEqual(T.guessSourceLang('hello'), 'en');
    ok('源语言猜测');
  }

  /* 8. handleTranslate + 缓存命中 */
  {
    const callsBefore = fetchCalls.length;
    const r1 = await T.handleTranslate({ type: 'translate', text: 'cache me please', provider: 'google', target: 'zh-CN' });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.text, '你好，世界');
    const callsAfter = fetchCalls.length;
    assert.ok(callsAfter > callsBefore);

    const r2 = await T.handleTranslate({ type: 'translate', text: 'cache me please', provider: 'google', target: 'zh-CN' });
    assert.strictEqual(r2.cached, true);
    assert.strictEqual(fetchCalls.length, callsAfter, '第二次不应再发请求');
    ok('handleTranslate 与缓存');
  }

  /* 9. auto 模式：Google、腾讯都失败后回退到 Bing */
  {
    const origFetch = globalThis.fetch;
    let blocked = 0;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('translate.googleapis.com') || u.includes('transmart.qq.com')) {
        blocked++;
        throw new Error('network down');
      }
      return origFetch(url, options);
    };
    const r = await T.handleTranslate({ type: 'translate', text: 'fallback test 42', provider: 'auto', target: 'zh-CN' });
    globalThis.fetch = origFetch;
    assert.ok(blocked >= 2, 'Google 与腾讯都应尝试过');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.provider, 'bing');
    ok('auto 模式自动回退');
  }

  /* 10. 全部失败时返回错误 */
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    const r = await T.handleTranslate({ type: 'translate', text: 'all fail 77', provider: 'auto', target: 'zh-CN' });
    globalThis.fetch = origFetch;
    assert.strictEqual(r.ok, false);
    assert.ok(/offline/.test(r.error));
    ok('全部失败返回错误');
  }

  /* 11. 熔断：连续失败的源在冷却期内被跳过 */
  {
    T.markProviderSuccess('google');
    T.markProviderSuccess('tencent');
    T.markProviderSuccess('bing');
    T.markProviderSuccess('mymemory');
    T.markProviderFailure('google', new Error('Failed to fetch'));
    T.markProviderFailure('google', new Error('Failed to fetch'));
    assert.strictEqual(T.providerHealthy('google'), false, 'Google 应被熔断');

    const callsBefore = fetchCalls.filter((c) => c.url.includes('translate.googleapis.com')).length;
    const r = await T.handleTranslate({
      type: 'translate',
      text: 'circuit breaker test',
      provider: 'auto',
      target: 'zh-CN',
    });
    const callsAfter = fetchCalls.filter((c) => c.url.includes('translate.googleapis.com')).length;
    assert.strictEqual(callsAfter, callsBefore, '熔断期间不应再请求 Google');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.provider, 'tencent');
    ok('翻译源熔断生效');
  }

  /* 12. 429 会重试一次（可重试错误） */
  {
    T.markProviderSuccess('google');
    const origFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('translate.googleapis.com')) {
        n++;
        if (n === 1) return new Response('rate limited', { status: 429 });
        return json({ sentences: [{ trans: '重试成功' }], src: 'en' });
      }
      return origFetch(url, options);
    };
    const r = await T.googleTranslate('retry me', 'zh-CN');
    globalThis.fetch = origFetch;
    assert.strictEqual(r.text, '重试成功');
    assert.strictEqual(n, 2, '429 应重试一次');
    ok('限流错误自动重试');
  }

  /* 13. 网络错误不重试（快速失败，交给下一个源） */
  {
    T.markProviderSuccess('google');
    const origFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('translate.googleapis.com')) {
        n++;
        throw new Error('Failed to fetch');
      }
      throw new Error('unexpected');
    };
    let err = null;
    try {
      await T.googleTranslate('network fail', 'zh-CN');
    } catch (e) {
      err = e;
    }
    globalThis.fetch = origFetch;
    assert.ok(err, '应抛出错误');
    assert.strictEqual(n, 1, '网络错误不应重试');
    ok('网络错误快速失败');
  }

  /* 14. 语种不支持不触发熔断（否则一条俄语消息会废掉腾讯整个源） */
  {
    T.markProviderSuccess('tencent');
    T.markProviderFailure('tencent', new Error('腾讯翻译失败：Required engine is not found'));
    T.markProviderFailure('tencent', new Error('腾讯翻译失败：Required engine is not found'));
    assert.strictEqual(T.providerHealthy('tencent'), true, '不支持的语种不应熔断');
    assert.strictEqual(T.classifyError(new Error('Required engine is not found')), 'unsupported');
    assert.strictEqual(T.classifyError(new Error('Google HTTP 429')), 'rate');
    assert.strictEqual(T.classifyError(new Error('Failed to fetch')), 'network');
    ok('错误分类与「语种不支持不熔断」');
  }

  /* 15. 全部源熔断后仍能自动恢复 */
  {
    T.resetHealth();
    for (const p of ['google', 'tencent', 'bing', 'mymemory']) {
      T.markProviderFailure(p, new Error('Failed to fetch'));
      T.markProviderFailure(p, new Error('Failed to fetch'));
    }
    assert.strictEqual(T.providerHealthy('google'), false);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('translate.googleapis.com')) throw new Error('blocked');
      return origFetch(url, options);
    };
    let r = null;
    for (let i = 0; i < 4 && !(r && r.ok); i++) {
      r = await T.handleTranslate({
        type: 'translate',
        text: 'recover from all down ' + i,
        provider: 'auto',
        target: 'zh-CN',
      });
    }
    globalThis.fetch = origFetch;
    assert.ok(r && r.ok, '应能从全部熔断中恢复');
    assert.strictEqual(r.provider, 'tencent', '应恢复到可用源');
    ok('全部熔断后自动恢复');
  }
  /* 16. 语种能力：腾讯不支持俄语，显式选择时应给出明确提示 */
  {
    assert.strictEqual(T.providerSupports('tencent', 'ru'), false);
    assert.strictEqual(T.providerSupports('tencent', 'zh-CN'), true);
    assert.strictEqual(T.providerSupports('google', 'ru'), true);
    let err = null;
    try {
      await T.translateText('Привет', 'ru', 'tencent', {});
    } catch (e) {
      err = e;
    }
    assert.ok(err && /不支持该语种/.test(err.message));
    ok('翻译源语种能力判断');
  }

  /* 17. 俄语自动模式应跳过腾讯，并在全失败时给出提示 */
  {
    T.resetHealth();
    const origFetch = globalThis.fetch;
    let tencentCalled = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes('transmart.qq.com')) {
        tencentCalled = true;
        return json({ header: { ret_code: 'succ' }, auto_translation: ['不该走到这里'] });
      }
      throw new Error('offline');
    };
    let err = null;
    try {
      await T.translateText('Привет', 'ru', 'auto', {});
    } catch (e) {
      err = e;
    }
    globalThis.fetch = origFetch;
    assert.strictEqual(tencentCalled, false, '腾讯不应被请求');
    assert.ok(err && /免费源有限/.test(err.message));
    ok('俄语自动模式跳过腾讯并提示');
  }

  /* 18. DeepL 解析 */
  {
    const r = await T.deeplTranslate('hello world', 'zh-CN', { deeplKey: 'test:fx' });
    assert.strictEqual(r.text, '你好，世界');
    ok('DeepL 解析');
  }

  /* 19. 有道智云解析 */
  {
    const r = await T.youdaoTranslate('hello world', 'zh-CN', { youdaoAppKey: 'k', youdaoAppSecret: 's' });
    assert.strictEqual(r.text, '你好，世界');
    ok('有道智云解析');
  }

  /* 20. LibreTranslate 解析 */
  {
    const r = await T.libreTranslate('hello world', 'zh-CN', { libreUrl: 'https://libretest.local' });
    assert.strictEqual(r.text, '你好，世界');
    ok('LibreTranslate 解析');
  }

  /* 21. 自动切换：免费源全不可用时切到已配置的 DeepL */
  {
    T.resetHealth();
    for (const p of ['google', 'tencent', 'bing', 'mymemory']) {
      T.markProviderFailure(p, new Error('Failed to fetch'));
      T.markProviderFailure(p, new Error('Failed to fetch'));
    }
    const r = await T.translateText('auto switch test', 'zh-CN', 'auto', { deeplKey: 'test:fx' });
    assert.strictEqual(r.provider, 'deepl');
    assert.strictEqual(r.text, '你好，世界');
    ok('自动切换到新翻译源');
  }

  /* 18. 源原样返回时继续尝试下一个源（短俚语很常见） */
  {
    T.resetHealth();
    const origFetch = globalThis.fetch;
    let tencentCalled = false;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('translate.googleapis.com')) {
        return json({ sentences: [{ trans: 'thank u' }], src: 'en' });
      }
      if (u.includes('transmart.qq.com')) {
        tencentCalled = true;
        return json({ header: { ret_code: 'succ' }, auto_translation: ['谢谢你'], src_lang: 'en' });
      }
      return origFetch(url, options);
    };
    const r = await T.translateText('thank u', 'zh-CN', 'auto', {});
    globalThis.fetch = origFetch;
    assert.strictEqual(tencentCalled, true);
    assert.strictEqual(r.text, '谢谢你');
    assert.strictEqual(r.provider, 'tencent');
    ok('原样返回时继续尝试下一个源');
  }

  /* 19. 全部熔断时轮换探测：不会只试固定的两个源 */
  {
    T.resetHealth();
    for (const p of ['google', 'tencent', 'bing', 'mymemory']) {
      T.markProviderFailure(p, new Error('Failed to fetch'));
      T.markProviderFailure(p, new Error('Failed to fetch'));
    }
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('translate.googleapis.com')) throw new Error('Failed to fetch');
      if (u.includes('transmart.qq.com')) {
        return json({ header: { ret_code: 'succ' }, auto_translation: ['探测成功'], src_lang: 'en' });
      }
      throw new Error('offline');
    };
    // 第一次探测最早的 google，必然失败
    let firstErr = null;
    try {
      await T.translateText('probe one', 'zh-CN', 'auto', {});
    } catch (e) {
      firstErr = e;
    }
    // 第二次应该轮到 tencent 并成功
    const r = await T.translateText('probe two', 'zh-CN', 'auto', {});
    globalThis.fetch = origFetch;
    assert.ok(firstErr, '第一次探测应失败');
    assert.strictEqual(r.provider, 'tencent');
    assert.strictEqual(r.text, '探测成功');
    ok('全部熔断后轮换探测');
  }

  /* 20. 腾讯「系统繁忙」自动重试一次 */
  {
    T.resetHealth();
    const origFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('transmart.qq.com')) {
        n++;
        if (n === 1) return json({ header: { ret_code: 'error' }, message: '系统繁忙，请稍后重试' });
        return json({ header: { ret_code: 'succ' }, auto_translation: ['重试成功'], src_lang: 'en' });
      }
      throw new Error('unexpected');
    };
    const r = await T.tencentTranslate('busy test', 'zh-CN');
    globalThis.fetch = origFetch;
    assert.strictEqual(n, 2);
    assert.strictEqual(r.text, '重试成功');
    ok('腾讯系统繁忙自动重试');
  }

  console.log(`\n全部通过：${passed} 项`);
})().catch((e) => {
  console.error('✗ 测试失败：', e);
  process.exit(1);
});
