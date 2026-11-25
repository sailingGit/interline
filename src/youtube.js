import { requestTranslations } from './messaging.js';
import { cueAt, parseCaptions } from './subtitles.js';
import { shouldTranslate } from './text.js';

const AHEAD = 40;
const REFILL_MARGIN = 12;
const PAUSE_LEAD_MS = 120;

const CSS = `
html.il-yt-on .ytp-caption-window-container { display: none !important; }
.il-yt { position: absolute; left: 0; right: 0; bottom: 8%; z-index: 60; text-align: center; pointer-events: none;
  transition: bottom 0.15s ease; font-family: "YouTube Noto", Roboto, -apple-system, "PingFang SC", sans-serif; }
.html5-video-player:not(.ytp-autohide) .il-yt { bottom: calc(8% + 44px); }
.il-yt-box { display: inline-block; max-width: 86%; padding: 0.2em 0.6em 0.3em; border-radius: 0.3em;
  background: rgba(8, 8, 8, 0.72); pointer-events: auto; }
.il-yt-line { display: block; color: #fff; line-height: 1.35; text-shadow: 0 0 2px rgba(0, 0, 0, 0.6); }
.il-yt-orig .il-yt-word { cursor: pointer; border-radius: 0.15em; }
.il-yt-orig .il-yt-word:hover { background: rgba(255, 255, 255, 0.25); }
.il-yt-tr { color: #ffd65c; font-size: 0.86em; margin-top: 0.1em; }
.il-yt-tr:empty { display: none; }
`;

// Bilingual subtitles: the caption track the player loads is rendered by us,
// original line above, translation below, in sync with the video.
export class YouTubeSubtitles {
  constructor({ getSettings, t, overlay }) {
    this.getSettings = getSettings;
    this.t = t;
    this.overlay = overlay;
    this.tracks = new Map();
    this.index = -1;
    this.pausedAt = -1;
    this.autoOpened = new Set();
    this.frame = null;

    window.addEventListener('message', (event) => this.onMessage(event));
    window.postMessage({ source: 'interline-content' }, location.origin);
    document.addEventListener('yt-navigate-finish', () => this.onNavigate());
    this.onNavigate();
  }

  get videoId() {
    return new URLSearchParams(location.search).get('v');
  }

  get track() {
    return this.tracks.get(this.videoId);
  }

  onMessage(event) {
    if (event.source !== window || event.data?.source !== 'interline-yt') return;
    let cues;
    let params;
    try {
      params = new URL(event.data.url).searchParams;
      cues = parseCaptions(event.data.url, event.data.text, (xml) => new DOMParser().parseFromString(xml, 'text/xml'));
    } catch {
      return;
    }
    if (!cues.length) return;
    const videoId = params.get('v') ?? this.videoId;
    // The hook replays recent tracks for a late content script, so one track can arrive twice.
    if (this.tracks.get(videoId)?.url === event.data.url) return;
    this.tracks.set(videoId, { url: event.data.url, cues, translations: new Array(cues.length).fill(undefined), pending: new Set(), error: null });
    if (videoId === this.videoId) {
      this.index = -1;
      this.translateAhead(0);
      this.run();
    }
  }

  onNavigate() {
    this.index = -1;
    this.pausedAt = -1;
    this.render();
    if (!location.hostname.endsWith('youtube.com') || !location.pathname.startsWith('/watch')) return;
    const videoId = this.videoId;
    // Our subtitles need the player to load a caption track, so turn CC on once per video.
    setTimeout(() => {
      if (!this.getSettings().youtubeSubtitles || videoId !== this.videoId) return;
      if (this.tracks.has(videoId) || this.autoOpened.has(videoId)) return;
      const button = document.querySelector('#movie_player .ytp-subtitles-button');
      if (button?.getAttribute('aria-pressed') === 'false' && button.offsetParent) {
        this.autoOpened.add(videoId);
        button.click();
      }
    }, 2000);
    this.run();
  }

  // Lines are translated in chunks just ahead of playback, not the whole video
  // at once. A chunk is requested once a line close ahead has no translation yet.
  translateAhead(from) {
    const track = this.track;
    if (!track) return;
    const needed = (i) => track.translations[i] === undefined && !track.pending.has(i);
    const soon = Math.min(track.cues.length, from + REFILL_MARGIN);
    let missing = false;
    for (let i = from; i < soon && !missing; i++) missing = needed(i);
    if (!missing) return;
    const target = this.getSettings().targetLanguage;
    const indices = [];
    for (let i = from; i < Math.min(track.cues.length, from + AHEAD); i++) {
      if (!needed(i)) continue;
      if (shouldTranslate(track.cues[i].text, target)) indices.push(i);
      else track.translations[i] = null;
    }
    if (!indices.length) return;
    for (const i of indices) track.pending.add(i);
    requestTranslations(indices.map((i) => track.cues[i].text), 'subtitle')
      .then((translations) => {
        track.error = null;
        indices.forEach((cue, i) => (track.translations[cue] = translations[i]));
      })
      .catch((err) => {
        track.error = err.code;
      })
      .finally(() => {
        for (const i of indices) track.pending.delete(i);
        if (this.track === track && indices.includes(this.index)) this.render(true);
      });
  }

  // Settings changed: a new target language invalidates every translated line.
  reset() {
    for (const track of this.tracks.values()) {
      track.translations.fill(undefined);
      track.pending.clear();
      track.error = null;
    }
    this.index = -1;
    if (this.track) this.translateAhead(0);
    this.run();
  }

  enabled() {
    if (!this.getSettings().youtubeSubtitles || !this.track) return false;
    // Turning CC off in the player turns our subtitles off too.
    const button = document.querySelector('#movie_player .ytp-subtitles-button');
    return button?.getAttribute('aria-pressed') !== 'false';
  }

  run() {
    if (this.frame) return;
    const tick = () => {
      this.frame = null;
      if (!this.track) {
        this.render();
        return;
      }
      this.update();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  update() {
    const video = document.querySelector('#movie_player video');
    const on = this.enabled() && !!video;
    document.documentElement.classList.toggle('il-yt-on', on);
    if (!on) {
      this.box?.remove();
      this.index = -1;
      return;
    }
    const track = this.track;
    const ms = video.currentTime * 1000;
    const index = cueAt(track.cues, ms);
    if (index !== this.index) {
      this.index = index;
      if (index >= 0) this.translateAhead(index);
      this.render();
    }
    if (
      this.getSettings().autoPause &&
      index >= 0 &&
      index !== this.pausedAt &&
      !video.paused &&
      ms >= track.cues[index].end - PAUSE_LEAD_MS
    ) {
      this.pausedAt = index;
      video.pause();
    }
  }

  ensureBox() {
    const player = document.querySelector('#movie_player');
    if (!player) return null;
    if (!document.getElementById('il-yt-style')) {
      const style = document.createElement('style');
      style.id = 'il-yt-style';
      style.textContent = CSS;
      document.head.append(style);
    }
    if (!this.box) {
      this.box = document.createElement('div');
      this.box.className = 'il-yt';
      this.box.setAttribute('data-il-ui', '');
      this.box.innerHTML = '<div class="il-yt-box"><span class="il-yt-line il-yt-orig"></span><span class="il-yt-line il-yt-tr"></span></div>';
      this.box.addEventListener('click', (event) => this.onWordClick(event));
    }
    if (this.box.parentElement !== player) player.append(this.box);
    this.box.style.fontSize = `${Math.max(15, Math.min(34, player.clientWidth * 0.026))}px`;
    return this.box;
  }

  render(translationOnly = false) {
    const track = this.track;
    if (!track || this.index < 0 || !this.enabled()) {
      this.box?.remove();
      return;
    }
    const box = this.ensureBox();
    if (!box) return;
    const cue = track.cues[this.index];
    const translation = track.translations[this.index];
    if (!translationOnly) {
      const orig = box.querySelector('.il-yt-orig');
      orig.replaceChildren(
        ...cue.text.split(/(\s+)/).map((part) => {
          if (/^\s+$/.test(part)) return document.createTextNode(part);
          const word = document.createElement('span');
          word.className = 'il-yt-word';
          word.textContent = part;
          return word;
        }),
      );
    }
    const line = box.querySelector('.il-yt-tr');
    if (translation === undefined) line.textContent = track.error ? `⚠ ${this.t(`error.${track.error}`)}` : '···';
    else line.textContent = translation ?? '';
  }

  // Clicking a word pauses the video and looks it up, like a reading aid.
  onWordClick(event) {
    const word = event.target.closest('.il-yt-word');
    if (!word) return;
    event.stopPropagation();
    document.querySelector('#movie_player video')?.pause();
    const text = word.textContent.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (text) this.overlay.showCard(text, word.getBoundingClientRect());
  }
}
