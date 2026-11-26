// Loads the built extension into real Chromium and drives it against local
// pages and a local stand-in for the translation service. No network needed.
// Usage: npm run test:e2e
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article</title></head>
<body style="font: 16px/1.5 sans-serif; max-width: 640px; margin: 20px auto">
  <nav><ul><li><a href="#">Home</a></li><li><a href="#">About us</a></li></ul></nav>
  <h1 id="title">The quiet art of slow reading</h1>
  <p id="p1">Reading slowly is a <a href="#">deliberate choice</a>, and <code>pace</code> matters.</p>
  <p id="zh">这一段已经是中文了，不需要再翻译。</p>
  <pre id="code">const answer = computeTheAnswer();</pre>
  <div id="mixed">Intro sentence before a block.<p id="nested">Nested paragraph inside.</p>Closing words after it.</div>
  <p id="numbers">2026 · 42%</p>
  <ul id="api"><li><a href="#"><code>getElementById()</code></a></li></ul>
  <button id="btn">Subscribe now</button>
  <p id="sel">Select this sentence to translate it.</p>
  <div style="height: 4000px"></div>
  <p id="far">This paragraph is far below the fold.</p>
</body></html>`;

const PLAYER = `<!doctype html><html><head><meta charset="utf-8"><title>Video</title></head><body>
  <div id="movie_player" class="html5-video-player ytp-autohide" style="position: relative; width: 640px; height: 360px; background: #000">
    <video style="width: 100%; height: 100%"></video>
    <div class="ytp-caption-window-container">native captions</div>
    <button class="ytp-subtitles-button" aria-pressed="true">CC</button>
  </div>
  <script>fetch('/api/timedtext?v=vid1&lang=en&fmt=json3');</script>
</body></html>`;

// Shaped like X: user-written text carries a lang attribute, the app's own
// labels, names and handles do not.
const X_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X</title></head><body>
  <nav><a href="#">Home</a> <a href="#">Explore</a> <a href="#">Notifications</a></nav>
  <main id="timeline">
    <article id="post1">
      <div><a href="#"><span>Lex Fridman</span></a> <span>@lexfridman</span> · <span>Mar 21</span></div>
      <div data-testid="tweetText" lang="en" dir="auto"><span>Hello from the future</span></div>
      <div><span>22</span> <span>Reply</span> <span>146</span> <span>Repost</span></div>
    </article>
    <div data-testid="UserDescription" dir="auto"><span>No state is the best state.</span></div>
  </main>
</body></html>`;

const framesPage = (otherOrigin) => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
  <h1 id="title">Frames around the world</h1>
  <iframe id="same" src="/inner?n=same"></iframe>
  <iframe id="cross" src="${otherOrigin}/inner?n=cross"></iframe>
  <iframe id="doc" srcdoc="<p id='p'>Text written straight into a srcdoc frame.</p>"></iframe>
</body></html>`;

const innerPage = (name) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p id="p">Paragraph inside the ${name} frame.</p></body></html>`;

const SHADOW_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
  <h1 id="title">Components everywhere</h1>
  <open-card id="open"><span>Slotted light paragraph text.</span></open-card>
  <closed-card id="closed"></closed-card>
  <script>
    customElements.define('open-card', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<style>:host { display: block }</style><p id="inner">Text inside an open shadow root.</p>' +
          '<nested-card></nested-card><div><slot></slot></div>';
      }
    });
    customElements.define('nested-card', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<p id="deep">Text two shadow roots deep.</p>';
      }
    });
    customElements.define('closed-card', class extends HTMLElement {
      constructor() {
        super();
        window.closedRoot = this.attachShadow({ mode: 'closed' });
        window.closedRoot.innerHTML = '<p id="sealed">Text inside a closed shadow root.</p>';
      }
    });
  </script>
</body></html>`;

// A post whose line breaks are newlines in one text node, as on X, and a
// paragraph whose lines are separated by <br>.
const LINES_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
  <div id="post" style="white-space: pre-wrap"><span>It works :)

- First line of the list
- Second line with a <a href="#">link</a> inside</span></div>
  <p id="verse">First line of the verse<br>Second line of the verse</p>
</body></html>`;

const CAPTIONS = {
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello there, friends.' }] },
    { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Welcome back to the kitchen.' }] },
  ],
};

async function startMock(tls) {
  const mock = { requests: [], failWith: null };
  const handler = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/article') return res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    if (url.pathname === '/frames') {
      const other = req.headers.host.startsWith('localhost') ? req.headers.host.replace('localhost', '127.0.0.1') : req.headers.host;
      return res.writeHead(200, { 'content-type': 'text/html' }).end(framesPage(`http://${other}`));
    }
    if (url.pathname === '/inner') return res.writeHead(200, { 'content-type': 'text/html' }).end(innerPage(url.searchParams.get('n')));
    if (url.pathname === '/lines') return res.writeHead(200, { 'content-type': 'text/html' }).end(LINES_PAGE);
    if (url.pathname === '/shadow') return res.writeHead(200, { 'content-type': 'text/html' }).end(SHADOW_PAGE);
    if (url.pathname === '/x') return res.writeHead(200, { 'content-type': 'text/html' }).end(X_PAGE);
    if (url.pathname === '/watch') return res.writeHead(200, { 'content-type': 'text/html' }).end(PLAYER);
    if (url.pathname === '/api/timedtext') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CAPTIONS));
    }
    if (url.pathname === '/translate_a/t') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const texts = new URLSearchParams(body).getAll('q');
        mock.requests.push({ tl: url.searchParams.get('tl'), texts });
        if (mock.failWith) return res.writeHead(mock.failWith).end('{}');
        const reply = texts.map((text) => [`[${url.searchParams.get('tl')}] ${text}`, 'en']);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
      return;
    }
    res.writeHead(404).end();
  };
  const server = createServer(handler);
  // Site rules match real hostnames, so x.com is resolved to this server over HTTPS.
  const secure = createHttpsServer(tls, handler);
  await new Promise((resolve) => server.listen(0, resolve));
  await new Promise((resolve) => secure.listen(0, resolve));
  mock.origin = `http://localhost:${server.address().port}`;
  mock.securePort = secure.address().port;
  mock.close = () => {
    for (const s of [server, secure]) {
      s.close();
      s.closeAllConnections();
    }
  };
  return mock;
}

function selfSignedCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=x.com'], {
    stdio: 'ignore',
  });
  return { key, cert };
}

async function launch(root, securePort) {
  const extension = join(root, 'extension');
  await cp('dist', extension, { recursive: true });
  // The caption hook only runs on YouTube; the test copy also runs it on the mock player.
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.content_scripts[1].matches.push('http://localhost/*');
  // Stands in for a tab opened before the extension was installed.
  manifest.content_scripts[0].exclude_matches = ['http://localhost/*preinstalled*'];
  manifest.host_permissions.push('http://localhost/*', 'https://x.com/*');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const extensionId = [...createHash('sha256').update(extension).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
  const context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium',
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    viewport: { width: 1000, height: 800 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      // A system proxy would resolve x.com itself and never reach the mock.
      '--no-proxy-server',
      `--host-resolver-rules=MAP x.com 127.0.0.1:${securePort}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    worker,
    extensionId,
    // Like a click on the toolbar button for the tab whose URL contains `urlPart`.
    toggle: (urlPart) =>
      worker.evaluate(async (part) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part));
        return toggleTab(tab.id);
      }, urlPart),
    close: async () => {
      await context.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label} (last: ${last})`);
}

const translationOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const wrappers = [...el.querySelectorAll(':scope > font[data-il]')];
    return wrappers.map((w) => ({ text: w.textContent, inline: w.classList.contains('il-inline'), state: w.className }));
  }, selector);

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'interline-e2e-')));
const { key, cert } = selfSignedCert(root);
const mock = await startMock({ key: await readFile(key), cert: await readFile(cert) });
const ext = await launch(root, mock.securePort);
const errors = [];
try {
  await ext.worker.evaluate(
    (origin) => chrome.storage.local.set({ googleUrl: `${origin}/translate_a/t`, targetLanguage: 'zh-CN' }),
    mock.origin,
  );
  const page = await ext.context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${mock.origin}/article`);
  await page.waitForTimeout(300);

  await step('page translation puts translations under visible paragraphs', async () => {
    await ext.toggle('/article');
    await waitFor(async () => (await translationOf(page, '#p1'))[0]?.text.startsWith('[zh-CN]'), 'p1 translation');
    assert.deepEqual(await translationOf(page, '#p1'), [
      { text: '[zh-CN] Reading slowly is a deliberate choice, and pace matters.', inline: false, state: 'il-wrap notranslate il-block' },
    ]);
    const title = await translationOf(page, '#title');
    assert.equal(title[0].text, '[zh-CN] The quiet art of slow reading');
  });

  await step('short navigation items get inline translations', async () => {
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('nav li')].map((li) => li.querySelector('font[data-il]')?.className),
    );
    assert.ok(items.every((name) => name?.includes('il-inline')), JSON.stringify(items));
  });

  await step('text already in the target language, code, code-only lines, numbers and buttons are left alone', async () => {
    for (const id of ['#zh', '#code', '#numbers', '#btn', '#api']) {
      assert.deepEqual(await page.evaluate((sel) => document.querySelector(sel).querySelectorAll('font[data-il]').length, id), 0, id);
    }
    const sent = mock.requests.flatMap((r) => r.texts);
    assert.ok(!sent.some((text) => text.includes('中文') || text.includes('computeTheAnswer') || text.includes('Subscribe')));
  });

  await step('a block with text around a nested paragraph gets three translations in place', async () => {
    const order = await page.evaluate(() =>
      [...document.querySelector('#mixed').childNodes].map((node) =>
        node.nodeType === 3 ? `text:${node.nodeValue}` : node.matches('font[data-il]') ? `tr:${node.textContent}` : `el:${node.id}`,
      ),
    );
    assert.deepEqual(order, [
      'text:Intro sentence before a block.',
      'tr:[zh-CN] Intro sentence before a block.',
      'el:nested',
      'text:Closing words after it.',
      'tr:[zh-CN] Closing words after it.',
    ]);
    assert.equal((await translationOf(page, '#nested'))[0].text, '[zh-CN] Nested paragraph inside.');
  });

  await step('paragraphs below the fold wait until they are scrolled near', async () => {
    assert.deepEqual(await translationOf(page, '#far'), []);
    assert.ok(!mock.requests.flatMap((r) => r.texts).includes('This paragraph is far below the fold.'));
    const before = mock.requests.length;
    await page.locator('#far').scrollIntoViewIfNeeded();
    await waitFor(async () => (await translationOf(page, '#far'))[0]?.text.startsWith('[zh-CN]'), 'far translation');
    assert.equal(mock.requests.length, before + 1);
  });

  await step('visible paragraphs are batched into few requests', async () => {
    assert.ok(mock.requests.length <= 3, `${mock.requests.length} requests`);
  });

  await step('content added later is translated too, once', async () => {
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'added';
      p.innerHTML = 'A comment loaded <b>after</b> the page.';
      document.querySelector('#far').before(p);
    });
    await waitFor(async () => (await translationOf(page, '#added'))[0]?.text.startsWith('[zh-CN]'), 'added translation');
    await page.waitForTimeout(500);
    assert.equal((await translationOf(page, '#added')).length, 1);
    assert.equal((await translationOf(page, '#far')).length, 1);
  });

  await step('changing text re-translates that paragraph from scratch', async () => {
    await page.evaluate(() => (document.querySelector('#added b').textContent = 'well after'));
    await waitFor(
      async () => (await translationOf(page, '#added'))[0]?.text === '[zh-CN] A comment loaded well after the page.',
      'updated translation',
    );
    assert.equal((await translationOf(page, '#added')).length, 1);
  });

  await step('the display style setting reaches the page', async () => {
    await ext.worker.evaluate(() => chrome.storage.local.set({ displayStyle: 'highlight' }));
    await waitFor(
      () => page.evaluate(() => [...document.querySelectorAll('font[data-il]')].every((w) => w.dataset.ilStyle === 'highlight')),
      'style',
    );
  });

  await step('toggling again restores the original page', async () => {
    const state = await ext.toggle('/article');
    assert.equal(state.active, false);
    assert.equal(await page.evaluate(() => document.querySelectorAll('font[data-il]').length), 0);
    assert.equal(await page.locator('#p1').innerText(), 'Reading slowly is a deliberate choice, and pace matters.');
  });

  await step('a new target language re-translates an active page', async () => {
    await ext.toggle('/article');
    await page.locator('#title').scrollIntoViewIfNeeded();
    await waitFor(async () => (await translationOf(page, '#title'))[0]?.text.startsWith('[zh-CN]'), 'zh title');
    await ext.worker.evaluate(() => chrome.storage.local.set({ targetLanguage: 'ja' }));
    await waitFor(async () => (await translationOf(page, '#title'))[0]?.text.startsWith('[ja]'), 'ja title');
    assert.equal((await translationOf(page, '#title')).length, 1);
    await ext.worker.evaluate(() => chrome.storage.local.set({ targetLanguage: 'zh-CN' }));
    await ext.toggle('/article');
  });

  await step('selecting text offers a translate button that opens a card', async () => {
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#sel'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.locator('#sel').dispatchEvent('mouseup');
    const icon = page.locator('[data-il-ui] .icon');
    await icon.waitFor({ state: 'visible' });
    await icon.click();
    const result = page.locator('[data-il-ui] .card .result');
    await waitFor(async () => (await result.textContent()) === '[zh-CN] Select this sentence to translate it.', 'card');
    await page.keyboard.press('Escape');
    await page.locator('[data-il-ui] .card').waitFor({ state: 'hidden' });
  });

  await step('failures are marked on the paragraph and explained once', async () => {
    mock.failWith = 429;
    await ext.toggle('/article');
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'fails';
      p.textContent = 'This one will hit a rate limit.';
      document.querySelector('#title').after(p);
    });
    await waitFor(async () => (await translationOf(page, '#fails'))[0]?.state.includes('il-error'), 'error mark');
    await waitFor(() => page.locator('[data-il-ui] .toast').isVisible(), 'toast');
    assert.match(await page.locator('[data-il-ui] .toast').textContent(), /请求太频繁/);
    mock.failWith = null;
    await page.locator('#fails font[data-il]').click();
    await waitFor(async () => (await translationOf(page, '#fails'))[0]?.text === '[zh-CN] This one will hit a rate limit.', 'retry');
    await ext.toggle('/article');
  });

  const fab = page.locator('[data-il-ui] .fab');

  await step('the floating button translates the page and shows the original again', async () => {
    await page.evaluate(() => scrollTo(0, 0));
    await fab.waitFor({ state: 'visible' });
    assert.equal(await fab.evaluate((el) => el.classList.contains('on')), false);
    await fab.click();
    await waitFor(async () => (await translationOf(page, '#title')).some((w) => w.text.startsWith('[zh-CN]')), 'translated by button');
    await waitFor(() => fab.evaluate((el) => el.classList.contains('on')), 'button on');
    await fab.click();
    await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('font[data-il]').length)) === 0, 'restored by button');
    assert.equal(await fab.evaluate((el) => el.classList.contains('on')), false);
  });

  await step('dragging the floating button moves it without toggling translation', async () => {
    const box = await fab.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
    await page.mouse.up();
    const moved = await fab.boundingBox();
    assert.ok(Math.abs(moved.y - (box.y - 120)) < 3, `${box.y} -> ${moved.y}`);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll('font[data-il]').length), 0);
    const saved = await ext.worker.evaluate(() => chrome.storage.local.get('fabTop'));
    assert.ok(Math.abs(saved.fabTop * 800 - moved.y) < 3, JSON.stringify(saved));
  });

  await step('the floating button can be turned off', async () => {
    await ext.worker.evaluate(() => chrome.storage.local.set({ floatingButton: false }));
    await fab.waitFor({ state: 'hidden' });
    await ext.worker.evaluate(() => chrome.storage.local.set({ floatingButton: true }));
    await fab.waitFor({ state: 'visible' });
  });

  const lines = await ext.context.newPage();
  lines.on('pageerror', (err) => errors.push(err.message));
  await lines.goto(`${mock.origin}/lines`);
  const layout = (selector) =>
    lines.evaluate((sel) => {
      const describe = (node) =>
        node.nodeType === 3 ? `text:${node.nodeValue}` : node.matches('font[data-il]') ? `tr:${node.textContent}` : `${node.localName}`;
      return [...document.querySelector(sel).childNodes].map(describe);
    }, selector);

  await step('posts with line breaks are translated line by line', async () => {
    await ext.toggle('/lines');
    await waitFor(async () => (await layout('#post span')).filter((n) => n.startsWith('tr:[zh-CN]')).length === 3, 'three lines');
    assert.deepEqual(await layout('#post span'), [
      'text:It works :)\n',
      'tr:[zh-CN] It works :)',
      'text:\n',
      'text:- First line of the list\n',
      'tr:[zh-CN] - First line of the list',
      'text:- Second line with a ',
      'a',
      'text: inside',
      'tr:[zh-CN] - Second line with a link inside',
    ]);
    assert.deepEqual(await layout('#verse'), [
      'text:First line of the verse',
      'br',
      'tr:[zh-CN] First line of the verse',
      'text:Second line of the verse',
      'tr:[zh-CN] Second line of the verse',
    ]);
  });

  await step('showing the original puts split lines back together', async () => {
    await ext.toggle('/lines');
    assert.deepEqual(await layout('#post span'), [
      'text:It works :)\n\n- First line of the list\n- Second line with a ',
      'a',
      'text: inside',
    ]);
    assert.deepEqual(await layout('#verse'), ['text:First line of the verse', 'br', 'text:Second line of the verse']);
    await lines.close();
  });

  const video = await ext.context.newPage();
  video.on('pageerror', (err) => errors.push(err.message));
  await video.goto(`${mock.origin}/watch?v=vid1`);

  await step('captions the player loads become bilingual subtitles', async () => {
    await video.evaluate(() => (document.querySelector('video').currentTime = 0.5));
    await waitFor(async () => (await video.locator('.il-yt-tr').textContent()) === '[zh-CN] Hello there, friends.', 'first line');
    assert.equal(await video.locator('.il-yt-orig').textContent(), 'Hello there, friends.');
    assert.equal(await video.locator('.ytp-caption-window-container').isVisible(), false);
    await video.evaluate(() => (document.querySelector('video').currentTime = 2.5));
    await waitFor(async () => (await video.locator('.il-yt-tr').textContent()) === '[zh-CN] Welcome back to the kitchen.', 'second line');
  });

  await step('both subtitle lines were translated in one request', async () => {
    const subtitleRequests = mock.requests.filter((r) => r.texts.includes('Hello there, friends.'));
    assert.equal(subtitleRequests.length, 1);
    assert.deepEqual(subtitleRequests[0].texts, ['Hello there, friends.', 'Welcome back to the kitchen.']);
  });

  await step('clicking a subtitle word looks it up', async () => {
    await video.locator('.il-yt-word', { hasText: 'kitchen' }).click();
    await waitFor(async () => (await video.locator('[data-il-ui] .card .result').textContent()) === '[zh-CN] kitchen', 'word card');
  });

  await step('turning CC off in the player hides our subtitles and restores the native ones', async () => {
    await video.evaluate(() => document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false'));
    await waitFor(async () => (await video.locator('.il-yt').count()) === 0, 'subtitles hidden');
    assert.equal(await video.locator('.ytp-caption-window-container').isVisible(), true);
  });

  const x = await ext.context.newPage();
  x.on('pageerror', (err) => errors.push(err.message));
  await x.goto('https://x.com/x');

  await step('on X only posts and bios are translated, each on its own line', async () => {
    const before = mock.requests.length;
    await ext.toggle('x.com');
    await waitFor(async () => (await translationOf(x, '#post1 [data-testid="tweetText"]'))[0]?.text.startsWith('[zh-CN]'), 'post');
    assert.deepEqual(await translationOf(x, '#post1 [data-testid="tweetText"]'), [
      { text: '[zh-CN] Hello from the future', inline: false, state: 'il-wrap notranslate il-block' },
    ]);
    assert.equal((await translationOf(x, '[data-testid="UserDescription"]'))[0]?.text, '[zh-CN] No state is the best state.');
    assert.equal(await x.evaluate(() => document.querySelectorAll('font[data-il]').length), 2);
    const sent = mock.requests.slice(before).flatMap((r) => r.texts);
    for (const text of ['Lex Fridman', '@lexfridman', 'Home', 'Reply']) assert.ok(!sent.includes(text), text);
  });

  await step('posts that load later on X are translated', async () => {
    await x.evaluate(() => {
      const post = document.createElement('article');
      post.id = 'post2';
      post.innerHTML =
        '<div><a href="#"><span>Someone</span></a> <span>@someone</span></div>' +
        '<div data-testid="tweetText" lang="en" dir="auto"><span>A reply that arrived later</span></div>';
      document.querySelector('#timeline').append(post);
    });
    await waitFor(
      async () => (await translationOf(x, '#post2 [data-testid="tweetText"]'))[0]?.text === '[zh-CN] A reply that arrived later',
      'later post',
    );
    assert.equal(await x.evaluate(() => document.querySelectorAll('font[data-il]').length), 3);
    await ext.toggle('x.com');
  });

  const frames = await ext.context.newPage();
  frames.on('pageerror', (err) => errors.push(err.message));
  await frames.goto(`${mock.origin}/frames`);
  await frames.waitForTimeout(500);
  const frameText = (match) =>
    frames
      .frames()
      .find((f) => f.url().includes(match))
      ?.evaluate(() => document.querySelector('#p font[data-il]')?.textContent ?? null);

  await step('same-origin, cross-origin and srcdoc iframes are translated with the page', async () => {
    await ext.toggle('/frames');
    for (const [match, text] of [
      ['n=same', 'Paragraph inside the same frame.'],
      ['n=cross', 'Paragraph inside the cross frame.'],
      ['about:srcdoc', 'Text written straight into a srcdoc frame.'],
    ]) {
      await waitFor(async () => (await frameText(match)) === `[zh-CN] ${text}`, match);
    }
  });

  await step('an iframe added after translation started follows the tab', async () => {
    await frames.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = '/inner?n=late';
      document.body.append(frame);
    });
    await waitFor(async () => (await frameText('n=late')) === '[zh-CN] Paragraph inside the late frame.', 'late frame');
  });

  await step('turning translation off clears every frame', async () => {
    const state = await ext.toggle('/frames');
    assert.equal(state.active, false);
    for (const match of ['n=same', 'n=cross', 'about:srcdoc', 'n=late']) {
      await waitFor(async () => (await frameText(match)) === null, `${match} cleared`);
    }
  });

  const shadow = await ext.context.newPage();
  shadow.on('pageerror', (err) => errors.push(err.message));
  await shadow.goto(`${mock.origin}/shadow`);
  await shadow.waitForTimeout(300);
  const shadowState = () =>
    shadow.evaluate(() => {
      const open = document.querySelector('#open').shadowRoot;
      const nested = open.querySelector('nested-card').shadowRoot;
      const read = (root, sel) => root.querySelector(`${sel} font[data-il]`)?.textContent ?? null;
      return {
        inner: read(open, '#inner'),
        deep: read(nested, '#deep'),
        sealed: read(window.closedRoot, '#sealed'),
        slotted: document.querySelector('#open > font[data-il]')?.textContent ?? null,
        innerDisplay: (() => {
          const w = open.querySelector('#inner font[data-il]');
          return w && getComputedStyle(w).display;
        })(),
        later: read(open, '#later'),
      };
    });

  await step('open, nested and closed shadow roots are translated, styled inside the component', async () => {
    await ext.toggle('/shadow');
    await waitFor(async () => {
      const state = await shadowState();
      return state.inner && state.deep && state.sealed && state.slotted;
    }, 'shadow translations');
    const state = await shadowState();
    assert.equal(state.inner, '[zh-CN] Text inside an open shadow root.');
    assert.equal(state.deep, '[zh-CN] Text two shadow roots deep.');
    assert.equal(state.sealed, '[zh-CN] Text inside a closed shadow root.');
    assert.equal(state.slotted, '[zh-CN] Slotted light paragraph text.');
    assert.equal(state.innerDisplay, 'block');
  });

  await step('content a component renders later is translated', async () => {
    await shadow.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'later';
      p.textContent = 'Added inside the shadow root later.';
      document.querySelector('#open').shadowRoot.append(p);
    });
    await waitFor(async () => (await shadowState()).later === '[zh-CN] Added inside the shadow root later.', 'later in shadow');
  });

  await step('turning translation off clears shadow roots too', async () => {
    await ext.toggle('/shadow');
    const state = await shadowState();
    assert.deepEqual([state.inner, state.deep, state.sealed, state.slotted, state.later], [null, null, null, null, null]);
  });

  await step('popup and settings pages render without errors', async () => {
    for (const name of ['popup', 'options']) {
      const ui = await ext.context.newPage();
      ui.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
      await ui.goto(`chrome-extension://${ext.extensionId}/${name}.html`);
      await waitFor(() => ui.locator('#engine option').count(), `${name} engines`);
      assert.equal(await ui.locator('#targetLanguage').inputValue(), 'zh-CN');
      await ui.close();
    }
  });

  await step('a tab opened before install is injected on first use', async () => {
    const old = await ext.context.newPage();
    old.on('pageerror', (err) => errors.push(err.message));
    await old.goto(`${mock.origin}/article?preinstalled`);
    await old.waitForTimeout(300);
    assert.equal(await old.evaluate(() => document.querySelectorAll('[data-il-ui]').length), 0);
    const state = await ext.worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes('preinstalled'));
      return toggleTab(tab.id);
    });
    assert.deepEqual(state, { active: true, host: 'localhost' });
    await waitFor(async () => (await translationOf(old, '#title')).some((w) => w.text.startsWith('[zh-CN]')), 'injected translation');
    await old.close();
  });

  await step('no page errors', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await ext.close();
  mock.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
