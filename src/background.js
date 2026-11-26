import { EngineError, translate } from './engines.js';
import { loadSettings } from './i18n.js';
import { setActive, tabActive, toggleTab } from './tabs.js';

const CACHE_LIMIT = 5000;
const cache = new Map();
let settingsPromise = null;

function settings() {
  settingsPromise ??= loadSettings();
  return settingsPromise;
}

chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'local') settingsPromise = null;
});

function cacheKey(s, target, purpose, text) {
  const model = s.engine === 'custom' ? `${s.customBaseUrl}|${s.customModel}` : s.engine === 'openai' ? s.openaiModel : '';
  return `${s.engine}|${model}|${target}|${purpose}|${text}`;
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// Translates what the cache does not have yet, in one engine call per request.
async function translateTexts(texts, purpose) {
  const s = await settings();
  const target = s.targetLanguage;
  const keys = texts.map((text) => cacheKey(s, target, purpose, text));
  const missing = [...new Set(texts.filter((_, i) => !cache.has(keys[i])))];
  if (missing.length) {
    const translations = await translate(missing, target, purpose, s);
    missing.forEach((text, i) => remember(cacheKey(s, target, purpose, text), translations[i]));
  }
  return keys.map((key) => cache.get(key) ?? null);
}

// Each frame asks on start whether its tab is being translated. A new top-level
// document starts from the site setting, and frames that started before it follow.
async function frameReady(sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  if (sender.frameId !== 0) return tabActive(tabId);
  const s = await settings();
  const active = s.alwaysSites.includes(new URL(sender.url).hostname);
  await setActive(tabId, active);
  return active;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'frameReady') {
    frameReady(sender).then((active) => sendResponse({ active }));
    return true;
  }
  if (message?.type === 'startTab' && sender.tab) {
    setActive(sender.tab.id, true).then(() => sendResponse({}));
    return true;
  }
  if (message?.type !== 'translate') return false;
  translateTexts(message.texts, message.purpose ?? 'page')
    .then((translations) => sendResponse({ translations }))
    .catch((err) => {
      if (!(err instanceof EngineError)) console.error(err);
      sendResponse({ error: err instanceof EngineError ? err.code : 'server' });
    });
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-page') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.id) await toggleTab(target.id);
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-page',
      title: chrome.i18n.getMessage('menuTranslatePage'),
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: chrome.i18n.getMessage('menuTranslateSelection'),
      contexts: ['selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'translate-page') toggleTab(tab.id);
  if (info.menuItemId === 'translate-selection') {
    // The card opens in the frame the text was selected in.
    chrome.tabs
      .sendMessage(tab.id, { type: 'translateSelection', text: info.selectionText }, { frameId: info.frameId ?? 0 })
      .catch(() => {});
  }
});

// Exposed for the end-to-end test, which cannot press the shortcut.
globalThis.translateTexts = translateTexts;
globalThis.toggleTab = toggleTab;
