// Tabs opened before the extension was installed or updated have no content
// script yet. Rather than asking for a reload, it is injected on first use.
export async function sendToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Not injected yet, or never injectable.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // chrome:// pages, the Web Store and other browsers' internal pages.
    return null;
  }
}
