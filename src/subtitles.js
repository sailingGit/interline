// Turns YouTube's caption responses into a flat list of cues, one on screen at a time.

const SENTENCE_END = /[.?!。？！…]["'”’)]?$/;
const MAX_WORDS = 14;
const MAX_CHARS = 90;
const PAUSE_MS = 1200;
const TAIL_MS = 1800;

function joinWords(words) {
  // Latin-script words are separated by spaces; CJK recognition output is not.
  return words.reduce((text, word) => {
    if (!text) return word;
    const glue = /[\p{Script=Latin}\d]$/u.test(text) || /^[\p{Script=Latin}\d]/u.test(word) ? ' ' : '';
    return text + glue + word;
  }, '');
}

// Automatic captions arrive a word or two per segment with no sentence breaks,
// so words are regrouped into readable lines at punctuation, pauses or a length limit.
export function groupWords(words) {
  const cues = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({ start: current[0].start, end: current.at(-1).start + TAIL_MS, text: joinWords(current.map((w) => w.text)) });
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    if (previous && word.start - previous.start > PAUSE_MS) flush();
    current.push(word);
    const text = joinWords(current.map((w) => w.text));
    if (SENTENCE_END.test(word.text) || current.length >= MAX_WORDS || text.length >= MAX_CHARS) flush();
  }
  flush();
  return cues;
}

// No two cues overlap, so the line under the video is always the latest one.
export function tidy(cues) {
  const sorted = cues.filter((cue) => cue.text).sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    sorted[i].end = Math.min(sorted[i].end, sorted[i + 1].start);
  }
  return sorted.filter((cue) => cue.end > cue.start);
}

export function parseJson3(data, { asr = false } = {}) {
  const events = (data?.events ?? []).filter((event) => event.segs);
  if (asr) {
    const words = [];
    for (const event of events) {
      for (const seg of event.segs) {
        const text = (seg.utf8 ?? '').trim();
        if (text) words.push({ start: event.tStartMs + (seg.tOffsetMs ?? 0), text });
      }
    }
    return tidy(groupWords(words));
  }
  return tidy(
    events.map((event) => ({
      start: event.tStartMs,
      end: event.tStartMs + (event.dDurationMs ?? 0),
      text: event.segs.map((seg) => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim(),
    })),
  );
}

// srv3 XML: <p t="start" d="duration">text or <s> words</p>.
export function parseSrv3(xml, parseXml, { asr = false } = {}) {
  const doc = parseXml(xml);
  const paragraphs = [...doc.getElementsByTagName('p')];
  if (asr) {
    const words = [];
    for (const p of paragraphs) {
      const start = Number(p.getAttribute('t'));
      const spans = [...p.getElementsByTagName('s')];
      for (const s of spans) {
        const text = s.textContent.trim();
        if (text) words.push({ start: start + Number(s.getAttribute('t') ?? 0), text });
      }
    }
    if (words.length) return tidy(groupWords(words));
  }
  return tidy(
    paragraphs.map((p) => ({
      start: Number(p.getAttribute('t')),
      end: Number(p.getAttribute('t')) + Number(p.getAttribute('d') ?? 0),
      text: p.textContent.replace(/\s+/g, ' ').trim(),
    })),
  );
}

export function parseCaptions(url, body, parseXml) {
  const params = new URL(url).searchParams;
  const asr = params.get('kind') === 'asr';
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) return parseJson3(JSON.parse(trimmed), { asr });
  if (trimmed.startsWith('<') && parseXml) return parseSrv3(trimmed, parseXml, { asr });
  return [];
}

// Index of the cue showing at `ms`, or -1 between cues.
export function cueAt(cues, ms) {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found >= 0 && ms < cues[found].end ? found : -1;
}
