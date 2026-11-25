// Content scripts cannot reach translation hosts across the page's CORS rules,
// so every request goes through the service worker.
export async function requestTranslations(texts, purpose) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'translate', texts, purpose });
  } catch {
    // The extension was reloaded or updated under this page.
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  if (!response || response.error) {
    const code = response?.error ?? 'server';
    throw Object.assign(new Error(code), { code });
  }
  return response.translations;
}
