import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/engines.js';
import { DEFAULTS } from '../src/i18n.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = await handler(url, init, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  impl.calls = calls;
  return impl;
}

const chatReply = (translations) => ({
  body: { choices: [{ message: { content: JSON.stringify({ translations }) } }] },
});

test('google sends every text as a q field and drops same-language results', async () => {
  const fetch = fakeFetch(() => ({ body: [['你好', 'en'], ['你好', 'zh-CN'], ['猫', 'en']] }));
  const result = await translate(['Hello', '你好', 'Cat'], 'zh-CN', 'page', { ...DEFAULTS }, fetch);
  assert.deepEqual(result, ['你好', null, '猫']);
  const { url, init } = fetch.calls[0];
  assert.match(url, /translate_a\/t\?client=gtx&sl=auto&tl=zh-CN$/);
  assert.deepEqual(init.body.getAll('q'), ['Hello', '你好', 'Cat']);
});

test('google splits long input into several requests and keeps order', async () => {
  const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
  const fetch = fakeFetch((url, init) => ({ body: init.body.getAll('q').map((q) => [q.toUpperCase(), 'en']) }));
  const result = await translate(texts, 'fr', 'page', { ...DEFAULTS }, fetch);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(result, texts.map((text) => text.toUpperCase()));
});

test('google maps HTTP failures to error codes', async () => {
  await assert.rejects(
    translate(['Hi'], 'zh-CN', 'page', { ...DEFAULTS }, fakeFetch(() => ({ status: 429, body: {} }))),
    { code: 'rate' },
  );
  await assert.rejects(
    translate(['Hi'], 'zh-CN', 'page', { ...DEFAULTS }, async () => {
      throw new TypeError('Failed to fetch');
    }),
    { code: 'network' },
  );
});

test('openai needs a key', async () => {
  await assert.rejects(translate(['Hi'], 'zh-CN', 'page', { ...DEFAULTS, engine: 'openai' }, fakeFetch(() => ({}))), {
    code: 'noKey',
  });
});

test('openai batches texts as a JSON array with a strict schema', async () => {
  const fetch = fakeFetch((url, init) => {
    const strings = JSON.parse(JSON.parse(init.body).messages[1].content);
    return chatReply(strings.map((s) => (s === 'Bonjour' ? '' : `译:${s}`)));
  });
  const settings = { ...DEFAULTS, engine: 'openai', openaiKey: 'sk-test' };
  const result = await translate(['Hello', 'Bonjour', 'World'], 'zh-CN', 'subtitle', settings, fetch);
  assert.deepEqual(result, ['译:Hello', null, '译:World']);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.response_format.type, 'json_schema');
  assert.match(body.messages[0].content, /Simplified Chinese/);
  assert.match(body.messages[0].content, /subtitle lines/);
});

test('a reply with the wrong number of lines is retried once', async () => {
  const fetch = fakeFetch((url, init, n) => (n === 1 ? chatReply(['only one']) : chatReply(['一', '二'])));
  const settings = { ...DEFAULTS, engine: 'openai', openaiKey: 'sk-test' };
  assert.deepEqual(await translate(['one', 'two'], 'zh-CN', 'page', settings, fetch), ['一', '二']);
  assert.equal(fetch.calls.length, 2);

  const broken = fakeFetch(() => chatReply(['only one']));
  await assert.rejects(translate(['one', 'two'], 'zh-CN', 'page', settings, broken), { code: 'format' });
});

test('custom endpoints use their own URL, model and json_object', async () => {
  const fetch = fakeFetch(() => ({
    body: { choices: [{ message: { content: '```json\n{"translations":["Hallo"]}\n```' } }] },
  }));
  const settings = {
    ...DEFAULTS,
    engine: 'custom',
    customBaseUrl: 'https://api.deepseek.com/v1/',
    customKey: '',
    customModel: 'deepseek-chat',
  };
  assert.deepEqual(await translate(['Hello'], 'de', 'page', settings, fetch), ['Hallo']);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning_effort, undefined);
});
