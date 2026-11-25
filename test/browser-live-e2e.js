// End-to-end check for the live browser pane pipeline (src/core/browser-live.js)
// without the web UI or the model in the loop. It drives a real Chromium page,
// subscribes like a WebSocket pane would, and asserts that
//   show   -> state + url + at least one JPEG frame
//   input  -> the click/text actually lands in the shared page
//   reset  -> subscribers survive and see "no page open", stream restarts after
//
// Run: node test/browser-live-e2e.js   (npm run test-browser-live)

const assert = require('node:assert');
const { chromium } = require('playwright');
const live = require('../src/core/browser-live');

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>Live test</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  #btn { position: absolute; left: 40px; top: 40px; width: 200px; height: 80px; }
  #inp { position: absolute; left: 40px; top: 160px; width: 300px; height: 40px; }
</style>
<button id="btn">click me</button>
<input id="inp">
<script>
  window.__clicked = 0;
  document.getElementById('btn').onclick = () => {
    window.__clicked += 1;
    document.title = 'clicked';
  };
</script>`;

const JPEG_MAGIC = '/9j/';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = pred();
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

async function main() {
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let page = await context.newPage();
  live.setPageProvider(async () => page);

  const msgs = [];
  const unsub = live.subscribe({ onMessage: (s) => msgs.push(JSON.parse(s)) });
  const ofType = (t) => msgs.filter((m) => m.t === t);

  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_HTML);

  // 1. show() navigates, opens the pane state, and starts a screencast.
  const shown = await live.show(url);
  assert.ok(shown && shown.ok, `show() failed: ${JSON.stringify(shown)}`);
  assert.strictEqual(shown.title, 'Live test', 'show() should report the page title');
  console.log('show ok:', shown.url.slice(0, 40), '|', shown.title);

  const stateOpen = await waitFor(() => ofType('state').find((m) => m.open === true));
  assert.ok(stateOpen, 'subscriber should get { t: "state", open: true }');

  const urlMsg = await waitFor(() => ofType('url').at(-1));
  assert.ok(urlMsg && urlMsg.url.startsWith('data:text/html'), 'subscriber should get the page url');

  // A frame only arrives on damage; nudge a repaint if nothing comes through.
  let frame = await waitFor(() => ofType('frame').at(-1), 3000);
  if (!frame) {
    await page.evaluate(() => { document.body.style.background = '#eeeeee'; });
    frame = await waitFor(() => ofType('frame').at(-1), 3000);
  }
  assert.ok(frame, 'expected at least one screencast frame');
  assert.ok(frame.data.startsWith(JPEG_MAGIC), 'frame should be base64 JPEG');
  assert.ok(Buffer.from(frame.data, 'base64').length > 500, 'frame should be a non-trivial image');
  assert.ok(frame.metadata && frame.metadata.deviceWidth > 0, 'frame should carry screencast metadata');
  console.log('frame ok:', Math.round(frame.data.length / 1024) + 'kB b64,',
    frame.metadata.deviceWidth + 'x' + frame.metadata.deviceHeight);

  // 2. Click at page fraction, the way the pane sends it.
  const box = await page.evaluate(() => {
    const r = document.getElementById('btn').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const vp = page.viewportSize();
  await live.input({ type: 'mouse', x: (box.x + box.w / 2) / vp.width, y: (box.y + box.h / 2) / vp.height });
  const clicked = await waitFor(() => page.evaluate(() => window.__clicked > 0).then((v) => v || null), 2000);
  assert.ok(clicked, 'click event should reach the shared page');
  console.log('click ok: window.__clicked =', await page.evaluate(() => window.__clicked));

  // 3. Text injection into a focused field.
  const inp = await page.evaluate(() => {
    const r = document.getElementById('inp').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await live.input({ type: 'mouse', x: (inp.x + inp.w / 2) / vp.width, y: (inp.y + inp.h / 2) / vp.height });
  await live.input({ type: 'text', text: 'hello shmakk' });
  const typed = await waitFor(() => page.evaluate(() => document.getElementById('inp').value === 'hello shmakk').then((v) => v || null), 2000);
  assert.ok(typed, 'text should land in the focused input');
  console.log('text ok:', await page.evaluate(() => document.getElementById('inp').value));

  // 4. reset() must not drop the pane: it reports closed, then streams again.
  msgs.length = 0;
  live.reset();
  const stateClosed = await waitFor(() => ofType('state').find((m) => m.open === false));
  assert.ok(stateClosed, 'reset() should tell subscribers the page is gone');

  page = await context.newPage();
  const again = await live.show(url + '#again');
  assert.ok(again && again.ok, 'show() after reset should work');
  let frame2 = await waitFor(() => ofType('frame').at(-1), 3000);
  if (!frame2) {
    await page.evaluate(() => { document.body.style.background = '#dddddd'; });
    frame2 = await waitFor(() => ofType('frame').at(-1), 3000);
  }
  assert.ok(frame2, 'stream should restart for the existing subscriber after reset()');
  console.log('reset/restart ok: still', 'subscribed, new frame arrived');

  unsub();
  await browser.close();
  await sleep(150);

  process.off('unhandledRejection', onRejection);
  assert.deepStrictEqual(rejections.map((e) => String(e)), [], 'no unhandled rejections');

  console.log('\nbrowser-live e2e: all checks passed');
}

main().catch((e) => {
  console.error('browser-live e2e FAILED:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
