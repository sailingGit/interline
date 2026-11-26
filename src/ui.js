import { requestTranslations } from './messaging.js';
import { normalize } from './text.js';

const MAX_SELECTION = 3000;
const CARD_WIDTH = 340;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --bg: #ffffff; --fg: #1f2329; --muted: #6b7280; --line: rgba(0,0,0,0.1); --accent: #2f6fed; }
@media (prefers-color-scheme: dark) {
  .layer { --bg: #23262d; --fg: #e8eaed; --muted: #9aa0a6; --line: rgba(255,255,255,0.12); --accent: #6d9bff; }
}
[hidden] { display: none !important; }
.icon { position: absolute; width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); box-shadow: 0 2px 10px rgba(0,0,0,0.18); cursor: pointer; padding: 0;
  display: grid; place-items: center; }
.icon img { width: 18px; height: 18px; display: block; }
.icon:hover { border-color: var(--accent); }
.card { position: absolute; width: ${CARD_WIDTH}px; max-width: calc(100vw - 16px); background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,0.22); padding: 12px 14px 10px; }
.source { color: var(--muted); font-size: 12.5px; max-height: 4.6em; overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 3; -webkit-box-orient: vertical; margin-bottom: 6px; white-space: pre-wrap; }
.result { white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow: auto; }
.result.loading { color: var(--muted); }
.result.error { color: #d14343; }
.actions { display: flex; gap: 4px; justify-content: flex-end; margin-top: 8px; border-top: 1px solid var(--line); padding-top: 6px; }
.actions button { all: unset; cursor: pointer; color: var(--muted); font-size: 12px; padding: 2px 8px; border-radius: 6px; }
.actions button:hover { color: var(--fg); background: var(--line); }
.toast { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 320px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-left: 3px solid #d14343; border-radius: 8px; padding: 10px 14px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
.fab { position: fixed; right: 0; z-index: 2147483646; width: 40px; height: 36px; padding: 0 0 0 9px;
  border: 1px solid var(--line); border-right: 0; border-radius: 18px 0 0 18px; background: var(--bg);
  box-shadow: 0 2px 12px rgba(0,0,0,0.16); cursor: pointer; display: flex; align-items: center;
  transform: translateX(10px); transition: transform 0.15s ease, background 0.15s ease; touch-action: none;
  --bg: #ffffff; --line: rgba(0,0,0,0.1); }
@media (prefers-color-scheme: dark) { .fab { --bg: #23262d; --line: rgba(255,255,255,0.14); } }
.fab:hover, .fab.dragging { transform: none; }
.fab img { width: 22px; height: 22px; display: block; pointer-events: none; transition: filter 0.15s ease; }
.fab:not(.on) img { filter: grayscale(0.85) opacity(0.8); }
.fab.on { background: #ece9ff; border-color: #a99cff; }
@media (prefers-color-scheme: dark) { .fab.on { background: #2f2a52; border-color: #6d5fe0; } }
`;

// Everything Interline draws over a page lives in one shadow root, out of reach
// of the page's own styles.
export class Overlay {
  constructor({ getSettings, t }) {
    this.getSettings = getSettings;
    this.t = t;
    this.host = document.createElement('div');
    this.host.setAttribute('data-il-ui', '');
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="layer">
        <button class="icon" hidden><img alt="" /></button>
        <div class="card" hidden>
          <div class="source"></div>
          <div class="result"></div>
          <div class="actions">
            <button data-action="speak"></button>
            <button data-action="copy"></button>
            <button data-action="close"></button>
          </div>
        </div>
      </div>
      <div class="toast" hidden></div>
      <button class="fab" hidden><img alt="" /></button>`;
    this.icon = this.root.querySelector('.icon');
    this.icon.querySelector('img').src = chrome.runtime.getURL('icons/icon-32.png');
    this.card = this.root.querySelector('.card');
    this.toastEl = this.root.querySelector('.toast');
    this.fab = this.root.querySelector('.fab');
    this.fab.querySelector('img').src = chrome.runtime.getURL('icons/icon-32.png');
    this.fabActive = false;
    this.localize();
    this.request = 0;

    this.icon.addEventListener('mousedown', (event) => event.preventDefault());
    this.icon.addEventListener('click', () => {
      this.icon.hidden = true;
      if (this.pending) this.showCard(this.pending.text, this.pending.rect);
    });
    this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());
    this.root.querySelector('[data-action="copy"]').addEventListener('click', (event) => this.copy(event.currentTarget));
    this.root.querySelector('[data-action="speak"]').addEventListener('click', () => this.speak());

    document.addEventListener('mouseup', (event) => setTimeout(() => this.onMouseUp(event), 0), true);
    document.addEventListener(
      'mousedown',
      (event) => {
        if (!event.composedPath().includes(this.host)) this.hide();
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  }

  localize() {
    this.icon.title = this.t('translateSelection');
    this.fab.title = this.t(this.fabActive ? 'showOriginal' : 'translatePage');
    for (const action of ['speak', 'copy', 'close']) {
      this.root.querySelector(`[data-action="${action}"]`).textContent = this.t(action);
    }
  }

  setTranslator(t) {
    this.t = t;
    this.localize();
  }

  mount() {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  // The button on the right edge that translates the page or shows the original.
  // It can be dragged up and down; a drag is not a click.
  enableFab(onClick, onMoved) {
    let drag = null;
    this.fab.addEventListener('pointerdown', (event) => {
      drag = { startY: event.clientY, top: this.fab.getBoundingClientRect().top, moved: false };
      this.fab.setPointerCapture(event.pointerId);
    });
    this.fab.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) < 4) return;
      drag.moved = true;
      this.fab.classList.add('dragging');
      this.placeFab((drag.top + dy) / window.innerHeight);
    });
    this.fab.addEventListener('pointerup', () => {
      // The click that follows a drag must not toggle translation.
      this.justDragged = !!drag?.moved;
      drag = null;
      this.fab.classList.remove('dragging');
      if (this.justDragged) onMoved(this.fabTop);
    });
    this.fab.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.justDragged) {
        this.justDragged = false;
        return;
      }
      onClick();
    });
  }

  placeFab(fraction) {
    const max = (window.innerHeight - 44) / window.innerHeight;
    this.fabTop = Math.min(max, Math.max(8 / window.innerHeight, fraction));
    this.fab.style.top = `${(this.fabTop * 100).toFixed(2)}%`;
  }

  updateFab({ visible, active, top }) {
    if (visible) this.mount();
    this.fab.hidden = !visible;
    this.fabActive = active;
    this.fab.classList.toggle('on', active);
    this.fab.title = this.t(active ? 'showOriginal' : 'translatePage');
    if (top !== undefined && !this.fab.classList.contains('dragging')) this.placeFab(top);
  }

  onMouseUp(event) {
    // A copy left behind on this page by an older version of the extension.
    if (!chrome.runtime?.id) return;
    if (event.composedPath().includes(this.host)) return;
    if (this.getSettings().selectionMode === 'off') return;
    const selected = selectionInfo();
    if (!selected) {
      this.icon.hidden = true;
      return;
    }
    this.pending = selected;
    this.mount();
    const { left, top } = place(selected.rect.right + 4, selected.rect.bottom + 6, 28, 28);
    Object.assign(this.icon.style, { left: `${left}px`, top: `${top}px` });
    this.icon.hidden = false;
  }

  // Called from the context menu, and from a click on a subtitle word.
  translateSelection(text) {
    const selected = selectionInfo();
    const rect = selected?.rect ?? new DOMRect(window.innerWidth - CARD_WIDTH - 24, 24, 0, 0);
    this.showCard(normalize(text ?? selected?.text ?? ''), rect);
  }

  async showCard(text, rect) {
    if (!text) return;
    this.mount();
    this.icon.hidden = true;
    const source = this.card.querySelector('.source');
    const result = this.card.querySelector('.result');
    source.textContent = text;
    result.textContent = this.t('loading');
    result.className = 'result loading';
    this.card.hidden = false;
    this.cardText = text;
    this.translation = '';
    this.position(rect);

    const request = ++this.request;
    try {
      const [translation] = await requestTranslations([text], 'selection');
      if (request !== this.request) return;
      this.translation = translation ?? text;
      result.textContent = this.translation;
      result.className = 'result';
    } catch (err) {
      if (request !== this.request) return;
      result.textContent = this.t(`error.${err.code}`);
      result.className = 'result error';
    }
    this.position(rect);
  }

  position(rect) {
    const height = this.card.offsetHeight || 120;
    const width = this.card.offsetWidth || CARD_WIDTH;
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 8 > 8 ? rect.top - height - 8 : below;
    const spot = place(rect.left, top, width, height);
    Object.assign(this.card.style, { left: `${spot.left}px`, top: `${spot.top}px` });
  }

  hide() {
    this.request++;
    this.icon.hidden = true;
    this.card.hidden = true;
    this.pending = null;
  }

  async copy(button) {
    try {
      await navigator.clipboard.writeText(this.translation || this.cardText);
      button.textContent = this.t('copied');
      setTimeout(() => (button.textContent = this.t('copy')), 1200);
    } catch {
      // The page's permissions policy can block the clipboard; nothing to do.
    }
  }

  speak() {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(this.cardText));
  }

  toast(message) {
    this.mount();
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), 5000);
  }
}

function selectionInfo() {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = normalize(selection.toString());
  if (!text || text.length > MAX_SELECTION || !/\p{L}/u.test(text)) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, rect };
}

// Page coordinates for a box near a viewport point, kept on screen.
function place(x, y, width, height) {
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  return { left: left + window.scrollX, top: top + window.scrollY };
}
