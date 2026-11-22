// Live browser sharing: streams the shared headless-browser page (the one the
// `browser` tool drives) to the web UI as a screencast, and injects the user's
// pointer/keyboard events back into that same page via CDP. The AI and the
// user therefore always see the *same* page, not two divergent copies.
//
// browser.js owns the Playwright page; this module owns the screencast stream
// and the input bridge. The web UI pane attaches/detaches through the
// /ws/browser socket, and browser.js calls notify() when it navigates.

let getPage = null;             // () => Promise<Page> set by browser.js
let subscribers = new Set();    // websocket handlers { send, close }
let cdpSession = null;          // active Page CDP session while streaming
let lastMeta = null;            // most recent screencast frame metadata
let lastUrl = null;
let streaming = false;
let hasPage = false;            // a page has been created and is streamable

function setPageProvider(fn) {
  getPage = fn;
}

function sendToAll(msg) {
  const data = JSON.stringify(msg);
  for (const sub of subscribers) {
    try { if (sub.send) sub.send(data); } catch {}
  }
}

function emitFrame(b64, meta, url) {
  lastMeta = meta;
  if (url) lastUrl = url;
  const msg = {
    t: 'frame',
    data: b64,
    metadata: meta || null,
    url: lastUrl || '',
    ts: Date.now(),
  };
  for (const sub of subscribers) {
    try { if (sub.throttle && !sub.throttle.allow()) continue; sub.send(JSON.stringify(msg)); } catch {}
  }
}

function emitState() {
  sendToAll({ t: 'state', open: hasPage || streaming, url: lastUrl || '' });
}

function emitUrl(url) {
  lastUrl = url;
  sendToAll({ t: 'url', url });
}

function makeThrottle(fps = 10) {
  let last = 0;
  return { allow: () => { const now = Date.now(); if (now - last < 1000 / fps) return false; last = now; return true; } };
}

async function startScreencast() {
  if (streaming) return;
  let page = null;
  try {
    page = await currentPage();
  } catch { return; }
  if (!page || typeof page === 'string') return;
  hasPage = true;
  try {
    cdpSession = await page.context().newCDPSession(page);
    cdpSession.on('Page.screencastFrame', async (payload) => {
      try {
        emitFrame(payload.data, payload.metadata || null, payload.metadata && payload.metadata.title || lastUrl);
      } catch {}
      if (cdpSession) {
        try { await cdpSession.send('Page.screencastFrameAck', { sessionId: payload.sessionId }); } catch {}
      }
    });
    cdpSession.on('Page.frameNavigated', (payload) => {
      if (payload.frame && payload.frame.url) emitUrl(payload.frame.url);
    });
    await cdpSession.send('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
    streaming = true;
  } catch {
    // Streaming is best-effort; the browser still works headless.
    streaming = false;
  }
}

async function stopScreencast() {
  if (!streaming || !cdpSession) { cdpSession = null; streaming = false; return; }
  try { await cdpSession.send('Page.stopScreencast'); } catch {}
  // detach() returns a promise that rejects once the page/browser is gone.
  try { await cdpSession.detach(); } catch {}
  cdpSession = null;
  streaming = false;
}

// A pane attached. Returns an unsubscribe function.
function subscribe(handlers) {
  const sub = {
    send: (s) => { try { handlers.onMessage(s); } catch {} },
    throttle: makeThrottle(10),
  };
  subscribers.add(sub);
  emitState();
  // Kick the stream on when the first pane attaches.
  startScreencast().then(() => emitState());
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) {
      stopScreencast();
      // Hand the page back at a normal desktop size for the agent.
      resetViewport().catch(() => {});
    }
  };
}

// Called by browser.js whenever it changes the page URL.
function notify(url) {
  if (url) emitUrl(url);
}

// `show` command: navigate and make sure the stream + pane are live.
async function show(url) {
  const page = await currentPage();
  if (typeof page === 'string') return { error: page };
  hasPage = true;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    return { error: `navigate failed: ${e.message}` };
  }
  lastUrl = page.url();
  emitUrl(lastUrl);
  await startScreencast();
  emitState();
  return { ok: true, url: page.url(), title: await page.title() };
}

// Resolve the shared page, turning "no provider / launch failed" into a
// human-readable reason the pane can show instead of hanging.
async function currentPage() {
  if (!getPage) return 'the browser is not wired up yet';
  try {
    const page = await getPage();
    return page || 'the browser could not be started';
  } catch (e) {
    return String((e && e.message) || e).split('\n')[0];
  }
}

// Navigate the shared page (address bar / server chips in the browser pane).
async function navigate(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { error: 'only http(s) URLs' };
  return show(url);
}

// History and reload for the shared page.
async function command(name) {
  const page = await currentPage();
  if (typeof page === 'string') return { error: page };
  try {
    if (name === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    else if (name === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
    else if (name === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 });
    else return { error: `unknown command ${name}` };
  } catch (e) {
    return { error: e.message };
  }
  lastUrl = page.url();
  emitUrl(lastUrl);
  return { ok: true, url: lastUrl };
}

// Match the shared page's viewport to the pane, so a narrow dock renders the
// site at the dock's width instead of a shrunken 1280px canvas.
//
// Verified against CDP: `Page.screencastFrame` is always captured at the page's
// CSS viewport size (device pixel ratio does not raise it, and maxWidth/maxHeight
// can only downscale). So the only way to fill a pane edge to edge, with the
// page actually responding to its container, is to move the viewport.
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

async function setViewport(width, height) {
  const w = Math.max(320, Math.min(2560, Math.round(Number(width) || 0)));
  const h = Math.max(240, Math.min(1600, Math.round(Number(height) || 0)));
  const page = await currentPage();
  if (typeof page === 'string') return { error: page };
  try {
    await page.setViewportSize({ width: w, height: h });
    await startScreencast();
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true, width: w, height: h };
}

// The pane is gone: put the page back to a normal desktop size, otherwise the
// agent keeps driving a phone-width browser afterwards.
async function resetViewport() {
  const page = await currentPage();
  if (typeof page === 'string') return { error: page };
  try {
    await page.setViewportSize(DEFAULT_VIEWPORT);
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true };
}

// Read the element under a point (fractions of the screencast frame). Used by
// the pane's edit tool: click an element, describe the change.
async function inspect(x, y) {
  const page = await currentPage();
  if (typeof page === 'string') return { error: page };
  const meta = lastMeta || { deviceWidth: 1280, deviceHeight: 720 };
  const px = Math.round((Number(x) || 0) * (meta.deviceWidth || 1));
  const py = Math.round((Number(y) || 0) * (meta.deviceHeight || 1));
  try {
    const detail = await page.evaluate(({ px, py }) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      const path = (node) => {
        const parts = [];
        let cur = node;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          let part = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift(`${part}#${cur.id}`); break; }
          const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) part += `.${cls.join('.')}`;
          const siblings = cur.parentElement ? Array.from(cur.parentElement.children).filter((n) => n.tagName === cur.tagName) : [];
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
          parts.unshift(part);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return {
        tag: el.tagName.toLowerCase(),
        selector: path(el),
        text,
        role: el.getAttribute('role') || null,
        name: el.getAttribute('aria-label') || el.getAttribute('name') || null,
        href: el.getAttribute('href') || null,
        rect: {
          x: rect.left / (window.innerWidth || 1),
          y: rect.top / (window.innerHeight || 1),
          w: rect.width / (window.innerWidth || 1),
          h: rect.height / (window.innerHeight || 1),
        },
        page: { href: location.href, title: document.title },
      };
    }, { px, py });
    return { ok: true, detail };
  } catch (e) {
    return { error: e.message };
  }
}

// Inject a user event (from the pane) into the shared page via CDP.
async function input(event) {
  const page = getPage ? await getPage() : null;
  if (!page || !cdpSession) return;
  const meta = lastMeta || { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 };

  try {
    switch (event.type) {
      case 'mouse': {
        const x = Math.round((event.x || 0) * (meta.deviceWidth || 1));
        const y = Math.round((event.y || 0) * (meta.deviceHeight || 1));
        const button = event.button === 'right' ? 'right' : event.button === 'middle' ? 'middle' : 'left';
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button, clickCount: 1,
        });
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button, clickCount: 1,
        });
        break;
      }
      case 'wheel': {
        const x = Math.round((event.x || 0) * (meta.deviceWidth || 1));
        const y = Math.round((event.y || 0) * (meta.deviceHeight || 1));
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y,
          deltaX: Number(event.deltaX || 0), deltaY: Number(event.deltaY || 0),
        });
        break;
      }
      case 'key': {
        const keyType = event.keyType || (event.down === false ? 'keyUp' : 'keyDown');
        await cdpSession.send('Input.dispatchKeyEvent', {
          type: keyType,
          key: event.key || '',
          code: event.code || '',
          text: event.text || undefined,
          modifiers: event.modifiers || 0,
        });
        break;
      }
      case 'text': {
        await cdpSession.send('Input.insertText', { text: String(event.text || '') });
        break;
      }
      default:
    }
  } catch {}
}

function reset() {
  hasPage = false;
  lastMeta = null;
  lastUrl = null;
  // Keep subscribers: panes stay connected across a browser restart, they just
  // drop back to the "no page open" state until the next show/navigate.
  stopScreencast().then(() => emitState()).catch(() => emitState());
}

module.exports = { setPageProvider, subscribe, input, notify, show, navigate, command, setViewport, resetViewport, inspect, reset };
