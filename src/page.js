import { requestTranslations } from './messaging.js';
import { ruleFor } from './sites.js';
import { normalize, shouldTranslate } from './text.js';

// Subtrees that hold no prose to translate, or that the user is editing.
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'pre', 'textarea', 'input', 'select', 'option',
  'button', 'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'img',
  'picture', 'head', 'kbd', 'samp',
]);
const BLOCK_SELECTOR =
  'address,article,aside,blockquote,dd,details,dialog,div,dl,dt,fieldset,figcaption,figure,footer,form,' +
  'h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,summary,table,tr,td,th,ul,caption';
const BLOCK_TAGS = new Set(BLOCK_SELECTOR.split(','));
// Paragraph-like blocks always get their translation on a line of its own.
const PROSE_TAGS = new Set(['p', 'blockquote', 'dd', 'figcaption']);
const INLINE_MAX_CHARS = 24;
const BATCH_ITEMS = 40;
const BATCH_CHARS = 4000;
const MAX_IN_FLIGHT = 3;

const PAGE_CSS = `
font.il-wrap { font: inherit; color: inherit; }
font.il-block { display: block; margin: 0.3em 0 0.15em; }
font.il-inline { margin-left: 0.4em; }
font.il-text { font: inherit; color: inherit; }
font.il-loading > font.il-text::after { content: "···"; letter-spacing: 1px; opacity: 0.45; animation: il-pulse 1s ease-in-out infinite; }
font.il-error > font.il-text { cursor: pointer; color: #d14343; }
@keyframes il-pulse { 50% { opacity: 0.12; } }
html[data-il-style="faded"] font.il-text { opacity: 0.72; }
html[data-il-style="dashed"] font.il-text { text-decoration: underline dashed rgba(47, 111, 237, 0.75); text-underline-offset: 0.25em; text-decoration-thickness: 1px; }
html[data-il-style="highlight"] font.il-text { background: rgba(255, 204, 0, 0.28); border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; padding: 0 2px; }
`;

function isOurs(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!el?.closest('[data-il], [data-il-ui]');
}

function isSkipped(el) {
  return (
    SKIP_TAGS.has(el.localName) ||
    el.hasAttribute('data-il') ||
    el.hasAttribute('data-il-ui') ||
    el.getAttribute('translate') === 'no' ||
    el.classList.contains('notranslate') ||
    el.getAttribute('aria-hidden') === 'true' ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '' ||
    el.classList.contains('html5-video-player')
  );
}

// 'container' holds blocks of its own; 'inline' flows with the text around it.
function classify(el) {
  const { display } = getComputedStyle(el);
  if (display === 'none') return BLOCK_TAGS.has(el.localName) || el.querySelector(BLOCK_SELECTOR) ? 'container' : 'hidden';
  if (!display.startsWith('inline') && display !== 'contents') return 'container';
  return el.querySelector(BLOCK_SELECTOR) ? 'container' : 'inline';
}

function textOf(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.localName === 'br') return '\n';
  if (isSkipped(node)) return '';
  let text = '';
  for (const child of node.childNodes) text += textOf(child);
  return text;
}

const isBlank = (node) => node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim();

export class PageTranslator {
  constructor({ getSettings, t, onError }) {
    this.getSettings = getSettings;
    this.t = t;
    this.onError = onError;
    this.rule = ruleFor(location.hostname);
    this.active = false;
    this.session = 0;
    this.reset();
  }

  reset() {
    this.blocks = new WeakMap();
    this.queue = [];
    this.dirtyBlocks = new Set();
    this.newRoots = new Set();
    this.inFlight = 0;
    clearTimeout(this.flushTimer);
    clearTimeout(this.mutationTimer);
    this.flushTimer = null;
    this.mutationTimer = null;
  }

  toggle() {
    if (this.active) this.stop();
    else this.start();
  }

  start() {
    if (this.active || !document.body) return;
    this.active = true;
    this.session++;
    this.reset();
    this.applyStyle();
    if (!document.getElementById('il-page-style')) {
      const style = document.createElement('style');
      style.id = 'il-page-style';
      style.textContent = PAGE_CSS;
      (document.head ?? document.documentElement).append(style);
    }
    this.visibility = new IntersectionObserver((entries) => this.onVisible(entries), { rootMargin: '600px 0px' });
    this.mutations = new MutationObserver((records) => this.onMutations(records));
    for (const root of this.roots(document.body)) this.scanBlock(root);
    this.mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.session++;
    this.visibility.disconnect();
    this.mutations.disconnect();
    this.reset();
    for (const wrapper of document.querySelectorAll('font[data-il]')) wrapper.remove();
  }

  // A new target language or engine means every translation on screen is stale.
  restart() {
    if (!this.active) return;
    this.stop();
    this.start();
  }

  applyStyle() {
    document.documentElement.dataset.ilStyle = this.getSettings().displayStyle;
  }

  // Where translation starts: the whole page, or only what a site rule includes.
  roots(node) {
    if (!this.rule) return [node];
    const found = node.matches?.(this.rule.include) ? [node] : [];
    found.push(...(node.querySelectorAll?.(this.rule.include) ?? []));
    // A match inside another match is scanned as part of it.
    return found.filter((el) => !el.parentElement?.closest(this.rule.include));
  }

  scanBlock(block) {
    if (this.blocks.has(block)) return;
    const units = [];
    this.blocks.set(block, units);
    let run = [];
    const flush = () => {
      const unit = this.makeUnit(block, run);
      if (unit) units.push(unit);
      run = [];
    };
    for (const child of block.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (isSkipped(child)) {
        if (BLOCK_TAGS.has(child.localName)) flush();
        continue;
      }
      if (child.localName === 'br') {
        run.push(child);
        continue;
      }
      const kind = classify(child);
      if (kind === 'hidden') continue;
      if (kind === 'container') {
        flush();
        this.scanBlock(child);
      } else {
        run.push(child);
      }
    }
    flush();
    if (units.length) this.visibility.observe(block);
  }

  makeUnit(block, run) {
    let start = 0;
    let end = run.length;
    while (start < end && (isBlank(run[start]) || run[start].localName === 'br')) start++;
    while (end > start && (isBlank(run[end - 1]) || run[end - 1].localName === 'br')) end--;
    const nodes = run.slice(start, end);
    if (!nodes.length) return null;
    const text = normalize(nodes.map(textOf).join(''));
    if (!shouldTranslate(text, this.getSettings().targetLanguage)) return null;
    const inline = !this.rule?.block && text.length <= INLINE_MAX_CHARS && !PROSE_TAGS.has(block.localName);
    return { block, nodes, text, inline, wrapper: null, state: 'idle', session: this.session };
  }

  onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      this.visibility.unobserve(entry.target);
      for (const unit of this.blocks.get(entry.target) ?? []) {
        if (unit.state === 'idle') this.enqueue(unit);
      }
    }
  }

  enqueue(unit) {
    const anchor = unit.nodes.at(-1);
    if (!anchor.isConnected) return;
    if (!unit.wrapper) {
      const wrapper = document.createElement('font');
      wrapper.setAttribute('data-il', '');
      wrapper.setAttribute('translate', 'no');
      wrapper.className = `il-wrap notranslate ${unit.inline ? 'il-inline' : 'il-block'}`;
      const text = document.createElement('font');
      text.className = 'il-text';
      wrapper.append(text);
      wrapper.addEventListener('click', (event) => {
        if (unit.state !== 'failed') return;
        event.preventDefault();
        event.stopPropagation();
        this.enqueue(unit);
      });
      unit.wrapper = wrapper;
      anchor.after(wrapper);
    }
    unit.state = 'queued';
    unit.wrapper.classList.remove('il-error');
    unit.wrapper.classList.add('il-loading');
    unit.wrapper.firstChild.textContent = '';
    unit.wrapper.removeAttribute('title');
    this.queue.push(unit);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 40);
  }

  flush() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length) {
      const batch = [];
      let chars = 0;
      while (this.queue.length && batch.length < BATCH_ITEMS && chars < BATCH_CHARS) {
        const unit = this.queue.shift();
        if (unit.session !== this.session || unit.state !== 'queued' || !unit.wrapper.isConnected) continue;
        batch.push(unit);
        chars += unit.text.length;
      }
      if (!batch.length) return;
      this.inFlight++;
      const session = this.session;
      requestTranslations(batch.map((unit) => unit.text), 'page')
        .then((translations) => batch.forEach((unit, i) => this.fill(unit, translations[i])))
        .catch((err) => {
          batch.forEach((unit) => this.fail(unit, err.code));
          this.onError(err.code);
        })
        .finally(() => {
          if (session !== this.session) return;
          this.inFlight--;
          this.flush();
        });
    }
  }

  fill(unit, translation) {
    if (unit.session !== this.session || unit.state !== 'queued') return;
    if (!translation || normalize(translation) === unit.text) {
      unit.state = 'skipped';
      unit.wrapper.remove();
      return;
    }
    unit.state = 'done';
    unit.wrapper.classList.remove('il-loading');
    unit.wrapper.firstChild.textContent = translation;
  }

  fail(unit, code) {
    if (unit.session !== this.session || unit.state !== 'queued') return;
    unit.state = 'failed';
    unit.wrapper.classList.remove('il-loading');
    unit.wrapper.classList.add('il-error');
    unit.wrapper.firstChild.textContent = '⚠';
    unit.wrapper.title = `${this.t('retry')} · ${this.t(`error.${code}`)}`;
  }

  // Pages keep changing after load: infinite scroll, single-page navigation,
  // re-rendered comments. Changed blocks are rescanned once things settle.
  onMutations(records) {
    for (const record of records) {
      if (isOurs(record.target)) continue;
      if (record.type === 'characterData') {
        this.markDirty(record.target.parentElement);
        continue;
      }
      for (const node of record.addedNodes) {
        if (isOurs(node)) continue;
        if (this.rule && node.nodeType === Node.ELEMENT_NODE) {
          for (const root of this.roots(node)) this.newRoots.add(root);
          this.markDirty(record.target);
        } else if (node.nodeType === Node.ELEMENT_NODE && !isSkipped(node) && classify(node) === 'container') {
          this.newRoots.add(node);
        } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          this.markDirty(record.target);
        }
      }
    }
    if (!this.dirtyBlocks.size && !this.newRoots.size) return;
    this.mutationTimer ??= setTimeout(() => {
      this.mutationTimer = null;
      this.rescan();
    }, 250);
  }

  markDirty(el) {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (this.blocks.has(node)) {
        this.dirtyBlocks.add(node);
        return;
      }
    }
  }

  rescan() {
    if (!this.active) return;
    for (const block of this.dirtyBlocks) {
      if (!block.isConnected) continue;
      for (const unit of this.blocks.get(block) ?? []) {
        unit.state = 'stale';
        unit.wrapper?.remove();
      }
      this.blocks.delete(block);
      this.visibility.unobserve(block);
      this.scanBlock(block);
    }
    for (const root of this.newRoots) {
      if (root.isConnected && !isOurs(root)) this.scanBlock(root);
    }
    this.dirtyBlocks.clear();
    this.newRoots.clear();
  }
}
