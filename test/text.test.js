import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batches, inTargetScript, mapLimit, normalize, shouldTranslate } from '../src/text.js';

test('normalize collapses whitespace', () => {
  assert.equal(normalize('  Hello \n\t world  '), 'Hello world');
});

test('shouldTranslate skips text with nothing to translate', () => {
  for (const text of ['', 'a', '42', '3.14 %', '— · —', 'https://example.com/a', 'me@example.com', '👍👍']) {
    assert.equal(shouldTranslate(text, 'zh-CN'), false, text);
  }
  assert.equal(shouldTranslate('Hello world', 'zh-CN'), true);
  assert.equal(shouldTranslate('Go', 'zh-CN'), true);
});

test('shouldTranslate skips text already in a CJK, Hangul or Cyrillic target', () => {
  assert.equal(shouldTranslate('今天天气很好', 'zh-CN'), false);
  assert.equal(shouldTranslate('今日はいい天気ですね', 'zh-CN'), true);
  assert.equal(shouldTranslate('今日はいい天気ですね', 'ja'), false);
  assert.equal(shouldTranslate('안녕하세요 여러분', 'ko'), false);
  assert.equal(shouldTranslate('Привет, мир', 'ru'), false);
  assert.equal(shouldTranslate('今天天气很好', 'en'), true);
  // Mostly Chinese with a product name still reads as Chinese.
  assert.equal(inTargetScript('我们用 React 写前端页面和组件', 'zh-CN'), true);
});

test('batches respects item and character limits in order', () => {
  const texts = ['aaaa', 'bb', 'cccccc', 'd', 'e'];
  assert.deepEqual(batches(texts, { maxItems: 2, maxChars: 100 }), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(batches(texts, { maxItems: 10, maxChars: 7 }), [[0, 1], [2, 3], [4]]);
  // A single text over the limit still gets its own batch.
  assert.deepEqual(batches(['x'.repeat(50), 'y'], { maxItems: 10, maxChars: 10 }), [[0], [1]]);
});

test('mapLimit keeps order and caps concurrency', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running--;
    return i * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
  assert.equal(peak, 2);
});
