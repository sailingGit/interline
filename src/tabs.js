// Translation is on or off for a whole tab, and every frame in it follows,
// including iframes that load later. The state lives in session storage so a
// restarted service worker still knows it.
const key = (tabId) => `tab:${tabId}`;

export async function tabActive(tabId) {
  return (await chrome.storage.session.get(key(tabId)))[key(tabId)] === true;
}

// Tabs opened before the extension was installed or updated have no content
// script yet. Rather than asking for a reload, it is injected on first use.
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch {
    // Some frames may be out of reach; the top frame is what matters.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

// Messages the tab's top frame. Null means the page cannot run the extension:
// chrome:// pages, the Web Store and the like.
export async function topFrame(tabId, message) {
  const send = () => chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  try {
    return await send();
  } catch {
    // Not injected yet, or never injectable.
  }
  try {
    await inject(tabId);
    return await send();
  } catch {
    return null;
  }
}

export async function setActive(tabId, active) {
  if (active) await chrome.storage.session.set({ [key(tabId)]: true });
  else await chrome.storage.session.remove(key(tabId));
  try {
    // Without a frameId this reaches every frame in the tab.
    await chrome.tabs.sendMessage(tabId, { type: 'setActive', active });
  } catch {
    // No frame is listening; the state still applies to frames that load later.
  }
}

export async function tabState(tabId) {
  const page = await topFrame(tabId, { type: 'state' });
  return page && { active: await tabActive(tabId), host: page.host };
}

export async function toggleTab(tabId) {
  const state = await tabState(tabId);
  if (!state) return null;
  await setActive(tabId, !state.active);
  return { active: !state.active, host: state.host };
}
