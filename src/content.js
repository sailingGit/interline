import { loadSettings, translator, uiLanguage } from './i18n.js';
import { PageTranslator } from './page.js';
import { Overlay } from './ui.js';
import { YouTubeSubtitles } from './youtube.js';

// Errors that every following request would hit too are shown once, not per paragraph.
const PERSISTENT_ERRORS = new Set(['noKey', 'auth', 'rate', 'network']);

async function main() {
  let settings = await loadSettings();
  let t = translator(uiLanguage(settings.targetLanguage));
  const getSettings = () => settings;
  let lastToast = null;

  const overlay = new Overlay({ getSettings, t });
  const page = new PageTranslator({
    getSettings,
    t: (...args) => t(...args),
    onError: (code) => {
      if (!PERSISTENT_ERRORS.has(code) || lastToast === code) return;
      lastToast = code;
      overlay.toast(t(`error.${code}`));
    },
  });
  const isTop = window === window.top;
  const showFab = () =>
    overlay.updateFab({ visible: isTop && settings.floatingButton, active: page.active, top: settings.fabTop });
  if (isTop) {
    overlay.enableFab(
      () => chrome.runtime.sendMessage({ type: 'toggleTab' }).catch(() => {}),
      (top) => chrome.storage.local.set({ fabTop: top }),
    );
    showFab();
  }
  // The caption hook runs in YouTube's top frame only, so the subtitles do too.
  const youtube = isTop ? new YouTubeSubtitles({ getSettings, t: (...args) => t(...args), overlay }) : null;
  const alwaysHere = () => settings.alwaysSites.includes(location.hostname);
  chrome.runtime
    .sendMessage({ type: 'frameReady' })
    .then((reply) => {
      if (reply?.active) page.start();
      if (isTop) showFab();
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const previous = settings;
    settings = await loadSettings();
    t = translator(uiLanguage(settings.targetLanguage));
    overlay.setTranslator(t);
    const retranslate = ['targetLanguage', 'engine', 'openaiModel', 'customBaseUrl', 'customModel', 'openaiKey', 'customKey'].some(
      (key) => key in changes,
    );
    if (retranslate) {
      lastToast = null;
      page.restart();
      youtube?.reset();
    }
    if ('displayStyle' in changes && page.active) page.applyStyle();
    if (isTop && 'alwaysSites' in changes && alwaysHere() && !previous.alwaysSites.includes(location.hostname)) {
      chrome.runtime.sendMessage({ type: 'startTab' }).catch(() => {});
    }
    if ('youtubeSubtitles' in changes) youtube?.run();
    if (isTop && ('floatingButton' in changes || 'fabTop' in changes || 'targetLanguage' in changes)) showFab();
  });

  return (message) => {
    if (message?.type === 'setActive') {
      lastToast = null;
      if (message.active) page.start();
      else page.stop();
      if (isTop) showFab();
      return { active: page.active };
    }
    if (message?.type === 'state') return { host: location.hostname };
    if (message?.type === 'translateSelection') overlay.translateSelection(message.text);
    return {};
  };
}

function listen(ready) {
  // Registered before settings load, so a message sent right after the script
  // is injected into an already open tab is not lost.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!['setActive', 'state', 'translateSelection'].includes(message?.type)) return false;
    ready.then((handle) => sendResponse(handle(message)));
    return true;
  });
}

if (!window.__interline) {
  window.__interline = true;
  listen(main());
}
