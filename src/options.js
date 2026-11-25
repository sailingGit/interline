import { DISPLAY_STYLES, LANGUAGES, loadSettings, translator, uiLanguage } from './i18n.js';

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['targetLanguage', 'displayStyle', 'selectionMode', 'engine', 'openaiKey', 'openaiModel', 'customBaseUrl', 'customKey', 'customModel'];
const CHECKS = ['youtubeSubtitles', 'autoPause'];
let t = translator('en');

for (const [code, { label }] of Object.entries(LANGUAGES)) $('targetLanguage').add(new Option(label, code));

// The page follows the language picked here, before it is even saved.
function localize() {
  const language = uiLanguage($('targetLanguage').value);
  t = translator(language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = t('options.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  const style = $('displayStyle').value;
  $('displayStyle').replaceChildren(...DISPLAY_STYLES.map((s) => new Option(t(`style.${s}`), s)));
  $('displayStyle').value = style || 'faded';
  const engine = $('engine').value;
  $('engine').replaceChildren(...['google', 'openai', 'custom'].map((e) => new Option(t(`engine.${e}`), e)));
  $('engine').value = engine || 'google';
  $('saved').textContent = '';
}

function showEngineFields() {
  for (const el of document.querySelectorAll('[data-engine]')) el.hidden = el.dataset.engine !== $('engine').value;
}

// Must stay in the click's task: Chrome only prompts during a user gesture.
async function customSetupError() {
  if (!$('customModel').value.trim()) return t('options.needModel');
  let origin;
  try {
    const { protocol, hostname } = new URL($('customBaseUrl').value.trim());
    if (!/^https?:$/.test(protocol)) return t('options.badUrl');
    origin = `${protocol}//${hostname}/*`;
  } catch {
    return t('options.badUrl');
  }
  return (await chrome.permissions.request({ origins: [origin] })) ? null : t('options.noAccess');
}

$('targetLanguage').addEventListener('change', localize);
$('engine').addEventListener('change', showEngineFields);

loadSettings().then((settings) => {
  for (const field of TEXT_FIELDS) {
    if (field !== 'displayStyle' && field !== 'engine') $(field).value = settings[field] ?? '';
  }
  localize();
  $('displayStyle').value = settings.displayStyle;
  $('engine').value = settings.engine;
  for (const field of CHECKS) $(field).checked = settings[field];
  $('alwaysSites').value = settings.alwaysSites.join('\n');
  showEngineFields();
});

$('save').addEventListener('click', async () => {
  const error = $('engine').value === 'custom' ? await customSetupError() : null;
  if (error) {
    $('saved').textContent = error;
    return;
  }
  const values = Object.fromEntries(TEXT_FIELDS.map((field) => [field, $(field).value.trim()]));
  for (const field of CHECKS) values[field] = $(field).checked;
  values.alwaysSites = [
    ...new Set(
      $('alwaysSites')
        .value.split(/\s+/)
        .map((line) => line.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase())
        .filter(Boolean),
    ),
  ];
  await chrome.storage.local.set(values);
  $('saved').textContent = t('options.saved');
});
