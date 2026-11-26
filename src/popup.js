import { DISPLAY_STYLES, LANGUAGES, loadSettings, translator, uiLanguage } from './i18n.js';
import { tabState, toggleTab } from './tabs.js';

const $ = (id) => document.getElementById(id);
const ENGINES = ['google', 'openai', 'custom'];

function needsSetup(settings) {
  if (settings.engine === 'openai') return !settings.openaiKey;
  if (settings.engine === 'custom') return !settings.customBaseUrl || !settings.customModel;
  return false;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const settings = await loadSettings();
  const t = translator(uiLanguage(settings.targetLanguage));
  document.documentElement.lang = uiLanguage(settings.targetLanguage) === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

  const fill = (select, entries, value) => {
    select.replaceChildren(...entries.map(([code, label]) => new Option(label, code)));
    select.value = value;
  };
  fill($('targetLanguage'), Object.entries(LANGUAGES).map(([code, { label }]) => [code, label]), settings.targetLanguage);
  fill($('engine'), ENGINES.map((engine) => [engine, t(`engine.${engine}`)]), settings.engine);
  fill($('displayStyle'), DISPLAY_STYLES.map((style) => [style, t(`style.${style}`)]), settings.displayStyle);
  $('youtubeSubtitles').checked = settings.youtubeSubtitles;
  $('autoPause').checked = settings.autoPause;
  $('floatingButton').checked = settings.floatingButton;

  const warning = $('warning');
  warning.hidden = !needsSetup(settings);
  warning.textContent = t('needKey');

  const tab = await activeTab();
  const state = tab ? await tabState(tab.id) : null;
  const toggle = $('toggle');
  toggle.disabled = !state;
  toggle.textContent = !state ? t('unsupported') : state.active ? t('showOriginal') : t('translatePage');
  toggle.classList.toggle('on', !!state?.active);

  $('alwaysRow').hidden = !state?.host;
  if (state?.host) {
    $('alwaysLabel').textContent = t('alwaysSite', { host: state.host });
    $('always').checked = settings.alwaysSites.includes(state.host);
  }

  const commands = await chrome.commands.getAll();
  const key = commands.find((command) => command.name === 'toggle-page')?.shortcut;
  $('shortcut').textContent = key ? t('shortcut', { key }) : '';
  return { settings, tab, state };
}

async function main() {
  let current = await render();

  $('toggle').addEventListener('click', async () => {
    if (!current.state) return;
    await toggleTab(current.tab.id);
    current = await render();
  });

  for (const id of ['targetLanguage', 'engine', 'displayStyle']) {
    $(id).addEventListener('change', async () => {
      await chrome.storage.local.set({ [id]: $(id).value });
      current = await render();
    });
  }

  for (const id of ['youtubeSubtitles', 'autoPause', 'floatingButton']) {
    $(id).addEventListener('change', () => chrome.storage.local.set({ [id]: $(id).checked }));
  }

  $('always').addEventListener('change', async () => {
    const host = current.state.host;
    const sites = current.settings.alwaysSites.filter((site) => site !== host);
    if ($('always').checked) sites.push(host);
    await chrome.storage.local.set({ alwaysSites: sites });
    current = await render();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

main();
