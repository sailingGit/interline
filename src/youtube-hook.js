// Runs in YouTube's own page world. The player fetches caption tracks with a
// signed URL that cannot be rebuilt from outside, so the responses it already
// receives are copied to the content script instead.
(() => {
  if (window.__interlineHook) return;
  window.__interlineHook = true;

  const recent = [];
  const isCaptions = (url) => typeof url === 'string' && url.includes('/api/timedtext');
  const post = (url, text) => {
    const message = { source: 'interline-yt', url: new URL(url, location.href).href, text };
    recent.push(message);
    if (recent.length > 4) recent.shift();
    window.postMessage(message, location.origin);
  };

  // The content script starts after the page, so it asks for what it missed.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'interline-content') return;
    for (const message of recent) window.postMessage(message, location.origin);
  });

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (isCaptions(url) && response.ok) response.clone().text().then((text) => post(url, text), () => {});
    } catch {
      // Never break the player over a caption copy.
    }
    return response;
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__interlineUrl = String(url);
    return open.call(this, method, url, ...rest);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isCaptions(this.__interlineUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.status !== 200) return;
          let text;
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
          else if (this.responseType === 'arraybuffer') text = new TextDecoder().decode(this.response);
          if (text) post(this.__interlineUrl, text);
        } catch {
          // Same as above.
        }
      });
    }
    return send.apply(this, args);
  };
})();
