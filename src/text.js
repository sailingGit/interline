// Pure text helpers shared by the page, selection and subtitle translators.

export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const SCRIPTS = {
  han: /\p{Script=Han}/u,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
};

function scriptShares(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  const shares = { letters: letters.length, han: 0, kana: 0, hangul: 0, cyrillic: 0 };
  for (const letter of letters) {
    for (const [script, pattern] of Object.entries(SCRIPTS)) {
      if (pattern.test(letter)) shares[script]++;
    }
  }
  return shares;
}

// Text already written in the target's script needs no translation. Latin-script
// targets cannot be told apart this way, so the engine's own detection decides.
export function inTargetScript(text, target) {
  const s = scriptShares(text);
  if (!s.letters) return false;
  const share = (n) => n / s.letters > 0.6;
  if (target.startsWith('zh')) return share(s.han) && s.kana === 0;
  if (target === 'ja') return share(s.han + s.kana) && s.kana > 0;
  if (target === 'ko') return share(s.hangul);
  if (target === 'ru') return share(s.cyrillic);
  return false;
}

export function shouldTranslate(text, target) {
  if (text.length < 2 || text.length > 5000) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  const cjk = letters.some((letter) => SCRIPTS.han.test(letter) || SCRIPTS.kana.test(letter) || SCRIPTS.hangul.test(letter));
  if (letters.length < 2 && !cjk) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(text)) return false;
  // Handles, hashtags and cashtags are names, not words.
  if (/^[@#$][\p{L}\p{N}_.]+$/u.test(text)) return false;
  return !inTargetScript(text, target);
}

// Splits texts into batches by count and total length, keeping their order.
// Each batch lists indices into `texts`.
export function batches(texts, { maxItems, maxChars }) {
  const out = [];
  let current = [];
  let chars = 0;
  texts.forEach((text, index) => {
    if (current.length && (current.length >= maxItems || chars + text.length > maxChars)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += text.length;
  });
  if (current.length) out.push(current);
  return out;
}

// Runs `task` over `items` with at most `limit` running at once.
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
