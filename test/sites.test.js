import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleFor } from '../src/sites.js';
import { shouldTranslate } from '../src/text.js';

test('X and Twitter hosts get the posts-only rule', () => {
  for (const host of ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']) {
    assert.ok(ruleFor(host)?.include.includes('tweetText'), host);
  }
  for (const host of ['example.com', 'notx.com', 'x.company.com']) assert.equal(ruleFor(host), null, host);
});

test('handles, hashtags and cashtags are not translated', () => {
  for (const text of ['@jack', '@lex.fridman', '#future', '$TSLA', '#话题']) {
    assert.equal(shouldTranslate(text, 'zh-CN'), false, text);
  }
  assert.equal(shouldTranslate('@jack thanks for this', 'zh-CN'), true);
});
