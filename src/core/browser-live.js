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
  const has = !!(getPage);
  sendToAll({ t: 'state', open: has, url: lastUrl || '' });
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
  const page = getPage ? await getPage() : null;
  if (!page) return;
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
    await cdpSession.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
    streaming = true;
  } catch {
    // Streaming is best-effort; the browser still works headless.
    streaming = false;
  }
}

async function stopScreencast() {
  if (!streaming || !cdpSession) { cdpSession = null; streaming = false; return; }
  try { await cdpSession.send('Page.stopScreencast'); } catch {}
  try { cdpSession.detach(); } catch {}
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
    if (subscribers.size === 0) stopScreencast();
  };
}

// Called by browser.js whenever it changes the page URL.
function notify(url) {
  if (url) emitUrl(url);
}

// `show` command: navigate and make sure the stream + pane are live.
async function show(url) {
  if (!getPage) return { error: 'browser unavailable' };
  const page = await getPage();
  if (!page) return { error: 'browser unavailable' };
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
        await cdpSession.send('Input.dispatchKeyEvent', {
          type: event.down === false ? 'keyUp' : 'keyDown',
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
  stopScreencast();
  subscribers.clear();
  lastMeta = null;
  lastUrl = null;
}

module.exports = { setPageProvider, subscribe, input, notify, show, reset };
