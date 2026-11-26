// Languages a page or subtitle can be translated into. `google` is the code the
// free Google endpoint expects; `name` is how the prompt names it for AI engines.
export const LANGUAGES = {
  'zh-CN': { name: 'Simplified Chinese', label: '简体中文', google: 'zh-CN' },
  'zh-TW': { name: 'Traditional Chinese', label: '繁體中文', google: 'zh-TW' },
  en: { name: 'English', label: 'English', google: 'en' },
  ja: { name: 'Japanese', label: '日本語', google: 'ja' },
  ko: { name: 'Korean', label: '한국어', google: 'ko' },
  es: { name: 'Spanish', label: 'Español', google: 'es' },
  fr: { name: 'French', label: 'Français', google: 'fr' },
  de: { name: 'German', label: 'Deutsch', google: 'de' },
  pt: { name: 'Portuguese', label: 'Português', google: 'pt' },
  ru: { name: 'Russian', label: 'Русский', google: 'ru' },
};

export const DEFAULTS = {
  targetLanguage: null,
  engine: 'google',
  openaiKey: '',
  openaiModel: 'gpt-6-luna',
  customBaseUrl: '',
  customKey: '',
  customModel: '',
  displayStyle: 'faded',
  selectionMode: 'icon',
  alwaysSites: [],
  youtubeSubtitles: true,
  autoPause: false,
  floatingButton: true,
  fabTop: 0.55,
  // Only the end-to-end test sets these, to point the engines at a local mock.
  googleUrl: '',
  apiBaseUrl: '',
};

export const DISPLAY_STYLES = ['plain', 'faded', 'dashed', 'highlight'];

// An unset target follows the browser, so a first run already reads right.
export function resolveLanguage(setting, browserLanguage = navigator.language) {
  if (LANGUAGES[setting]) return setting;
  const browser = browserLanguage ?? '';
  if (/^zh-(TW|HK|MO|Hant)/i.test(browser)) return 'zh-TW';
  if (/^zh/i.test(browser)) return 'zh-CN';
  const base = browser.split('-')[0].toLowerCase();
  return LANGUAGES[base] ? base : 'en';
}

// People translate into their own language, so the interface follows it.
export function uiLanguage(targetLanguage) {
  return targetLanguage.startsWith('zh') ? 'zh' : 'en';
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  settings.targetLanguage = resolveLanguage(settings.targetLanguage);
  return settings;
}

const MESSAGES = {
  zh: {
    name: '行间翻译',
    translatePage: '翻译此网页',
    showOriginal: '显示原文',
    targetLanguage: '翻译成',
    engine: '翻译引擎',
    'engine.google': 'Google 翻译（免费）',
    'engine.openai': 'OpenAI',
    'engine.custom': '自定义（OpenAI 兼容）',
    displayStyle: '译文样式',
    'style.plain': '普通',
    'style.faded': '淡色',
    'style.dashed': '虚线下划线',
    'style.highlight': '高亮背景',
    alwaysSite: '总是翻译 {host}',
    youtubeSubtitles: 'YouTube 双语字幕',
    autoPause: '每句字幕播完自动暂停',
    floatingButton: '页面右侧显示翻译按钮',
    moreSettings: '更多设置',
    shortcut: '快捷键 {key} 切换翻译',
    unsupported: '这个页面不能翻译',
    needKey: '这个引擎需要 API Key，请先在设置里填写',
    loading: '翻译中…',
    retry: '翻译失败，点击重试',
    copy: '复制',
    copied: '已复制',
    speak: '朗读',
    close: '关闭',
    translateSelection: '翻译选中文字',
    'error.noKey': '还没有填写 API Key',
    'error.auth': 'API Key 无效或没有权限',
    'error.rate': '请求太频繁，稍后再试',
    'error.network': '连不上翻译服务，请检查网络',
    'error.server': '翻译服务出错了',
    'error.format': '翻译结果格式不对',
    'options.title': '行间翻译 设置',
    'options.general': '通用',
    'options.engineSection': '翻译引擎',
    'options.reading': '阅读与字幕',
    'options.openaiKey': 'OpenAI API Key',
    'options.openaiKeyHelp': '只保存在本机浏览器里，只发给 OpenAI。',
    'options.model': '模型',
    'options.baseUrl': 'API 地址',
    'options.baseUrlHelp': '任何兼容 OpenAI Chat Completions 的服务，比如 DeepSeek、Kimi、本地 Ollama。',
    'options.customKey': 'API Key',
    'options.googleHelp': '免费，不需要 Key。原文会发给 Google 翻译。',
    'options.selectionMode': '划词翻译',
    'selection.icon': '选中文字后显示翻译按钮',
    'selection.off': '关闭',
    'options.sites': '总是翻译的网站',
    'options.sitesHelp': '每行一个域名，比如 news.ycombinator.com',
    'options.save': '保存',
    'options.saved': '已保存',
    'options.needModel': '请填写模型名称',
    'options.badUrl': 'API 地址格式不对',
    'options.noAccess': '没有获得访问这个 API 地址的权限',
  },
  en: {
    name: 'Interline',
    translatePage: 'Translate this page',
    showOriginal: 'Show original',
    targetLanguage: 'Translate into',
    engine: 'Engine',
    'engine.google': 'Google Translate (free)',
    'engine.openai': 'OpenAI',
    'engine.custom': 'Custom (OpenAI-compatible)',
    displayStyle: 'Translation style',
    'style.plain': 'Plain',
    'style.faded': 'Faded',
    'style.dashed': 'Dashed underline',
    'style.highlight': 'Highlight',
    alwaysSite: 'Always translate {host}',
    youtubeSubtitles: 'Bilingual YouTube subtitles',
    autoPause: 'Pause after each subtitle line',
    floatingButton: 'Show the translate button on the page edge',
    moreSettings: 'More settings',
    shortcut: 'Press {key} to toggle',
    unsupported: 'This page cannot be translated',
    needKey: 'This engine needs an API key. Add one in settings.',
    loading: 'Translating…',
    retry: 'Translation failed. Click to retry',
    copy: 'Copy',
    copied: 'Copied',
    speak: 'Read aloud',
    close: 'Close',
    translateSelection: 'Translate selection',
    'error.noKey': 'No API key yet',
    'error.auth': 'The API key is invalid or lacks access',
    'error.rate': 'Too many requests, try again shortly',
    'error.network': 'Cannot reach the translation service',
    'error.server': 'The translation service failed',
    'error.format': 'The translation came back in the wrong format',
    'options.title': 'Interline settings',
    'options.general': 'General',
    'options.engineSection': 'Translation engine',
    'options.reading': 'Reading and subtitles',
    'options.openaiKey': 'OpenAI API key',
    'options.openaiKeyHelp': 'Stored only in this browser and sent only to OpenAI.',
    'options.model': 'Model',
    'options.baseUrl': 'API base URL',
    'options.baseUrlHelp': 'Any service compatible with OpenAI Chat Completions, such as DeepSeek or a local Ollama.',
    'options.customKey': 'API key',
    'options.googleHelp': 'Free, no key needed. Text is sent to Google Translate.',
    'options.selectionMode': 'Selection translation',
    'selection.icon': 'Show a translate button after selecting text',
    'selection.off': 'Off',
    'options.sites': 'Always translate these sites',
    'options.sitesHelp': 'One host per line, for example news.ycombinator.com',
    'options.save': 'Save',
    'options.saved': 'Saved',
    'options.needModel': 'Enter a model name',
    'options.badUrl': 'The API base URL is not valid',
    'options.noAccess': 'Access to this API host was not granted',
  },
};

export function translator(language) {
  const messages = MESSAGES[language] ?? MESSAGES.en;
  return (key, values = {}) =>
    (messages[key] ?? MESSAGES.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}
