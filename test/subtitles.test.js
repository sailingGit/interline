import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cueAt, groupWords, parseCaptions, parseJson3 } from '../src/subtitles.js';

test('manual json3 captions become one cue per event, without overlaps', () => {
  const cues = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello\nthere' }] },
      { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'How ' }, { utf8: 'are you?' }] },
      { tStartMs: 4000, dDurationMs: 100 },
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: '  ' }] },
    ],
  });
  assert.deepEqual(cues, [
    { start: 0, end: 1500, text: 'Hello there' },
    { start: 1500, end: 3500, text: 'How are you?' },
  ]);
});

test('automatic captions are regrouped into sentences', () => {
  const data = {
    events: [
      { tStartMs: 0, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'so' }, { utf8: ' today', tOffsetMs: 300 }, { utf8: ' we', tOffsetMs: 600 }] },
      { tStartMs: 900, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 1000, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'cook.' }, { utf8: ' Then', tOffsetMs: 400 }] },
      { tStartMs: 5000, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'we' }, { utf8: ' eat', tOffsetMs: 200 }] },
    ],
  };
  const cues = parseCaptions('https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&fmt=json3', JSON.stringify(data));
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['so today we cook.', 'Then', 'we eat'],
  );
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].start, 1400);
  // The pause after "Then" ends its cue where the next one starts.
  assert.equal(cues[1].end, 3200);
  assert.equal(cues[2].start, 5000);
});

test('long runs of words without punctuation are cut', () => {
  const words = Array.from({ length: 30 }, (_, i) => ({ start: i * 200, text: `w${i}` }));
  const cues = groupWords(words);
  assert.ok(cues.length >= 3);
  assert.ok(cues.every((cue) => cue.text.split(' ').length <= 14));
});

test('CJK recognition output is joined without spaces', () => {
  const cues = groupWords([
    { start: 0, text: '今天' },
    { start: 200, text: '我们' },
    { start: 400, text: '做饭。' },
  ]);
  assert.equal(cues[0].text, '今天我们做饭。');
});

test('srv3 XML is parsed with the given XML parser', () => {
  const fakeDoc = {
    getElementsByTagName: () => [
      { getAttribute: (n) => ({ t: '1000', d: '2000' })[n], textContent: ' Hello  world ', getElementsByTagName: () => [] },
    ],
  };
  const cues = parseCaptions('https://www.youtube.com/api/timedtext?v=abc', '<timedtext/>', () => fakeDoc);
  assert.deepEqual(cues, [{ start: 1000, end: 3000, text: 'Hello world' }]);
});

test('cueAt finds the cue on screen, or -1 between cues', () => {
  const cues = [
    { start: 0, end: 1000, text: 'a' },
    { start: 2000, end: 3000, text: 'b' },
    { start: 3000, end: 4000, text: 'c' },
  ];
  assert.equal(cueAt(cues, 500), 0);
  assert.equal(cueAt(cues, 1500), -1);
  assert.equal(cueAt(cues, 3000), 2);
  assert.equal(cueAt(cues, 9000), -1);
  assert.equal(cueAt([], 0), -1);
});
