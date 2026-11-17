#!/usr/bin/env node
// Browser E2E for reasoning effort. Starts the mock LLM and the real web server,
// then drives headless Chromium to pick an effort level in the composer, send a
// message, and confirm the level actually reached the provider request. Also
// checks that switching back to "auto" stops sending reasoning_effort.
//
// Run: node test/e2e-effort.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN = 'e2e-effort-token';

// Ask the kernel for free ports so a leftover server can never hijack the run.
const freePort = () => new Promise((resolve, reject) => {
  const srv = require('net').createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
};

// Like waitFor, but returns the first truthy value instead of discarding it.
const waitForValue = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
};

const waitForPort = (port) => waitFor(async () => {
  try {
    const net = require('net');
    return await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
    });
  } catch { return false; }
}, 15000, `port ${port}`);

let MOCK_PORT = 0;

const captured = async () => {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/captured`);
  if (!r.ok) throw new Error(`mock /captured: ${r.status}`);
  return r.json();
};

const clearCaptured = async () => {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/captured`, { method: 'DELETE' });
  if (r.status !== 204) throw new Error(`mock /captured DELETE: ${r.status}`);
};

const isChatRequest = (p) => {
  const sys = (p.messages || []).find((m) => m.role === 'system');
  const content = String((sys && sys.content) || '');
  // Match both the agent system prompt and the older short chat prompt.
  return !!sys && /You are (?:an expert AI coding assistant running inside shmakk|shmakk, a thoughtful)/i.test(content);
};

// Pipes truncate console output when process.exit follows right after, so the
// verdict is written synchronously.
const say = (msg, stream = 1) => { try { fs.writeSync(stream, `${msg}\n`); } catch {} };

let browser = null;
const procs = [];
const cleanup = () => {
  try { if (browser) browser.close(); } catch {}
  procs.forEach((p) => { try { p.kill(); } catch {} });
};
process.on('unhandledRejection', (e) => { say(`E2E FAIL: ${e && e.message}` , 2); cleanup(); process.exit(1); });

(async () => {

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shmakk-effort-'));
  const PORT = await freePort();
  MOCK_PORT = await freePort();

  let mockOut = '';
  const mock = spawn('node', ['test/mock-llm.js', String(MOCK_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  mock.stdout.on('data', (c) => { mockOut += c; });
  mock.stderr.on('data', (c) => { mockOut += c; });
  procs.push(mock);
  await waitForPort(MOCK_PORT);

  let webErr = '';
  const web = spawn('node', ['bin/shmakk.js', '--web', '--port', String(PORT), '--no-open'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      SHMAKK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      SHMAKK_API_KEY: 'x',
      SHMAKK_MODEL: 'mock',
      SHMAKK_WEB_TOKEN: TOKEN,
      // Keep conversations and settings inside the temp dir.
      XDG_STATE_HOME: path.join(tmp, 'state'),
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
    },
  });
  web.stderr.on('data', (c) => { webErr += c; });
  procs.push(web);
  const exited = new Promise((_, reject) => web.once('exit', (code) => reject(new Error(`web server exited (${code}): ${webErr.trim()}`))));
  await Promise.race([waitForPort(PORT), exited]);

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const step = (m) => say(`step: ${m}`);
    await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea', { timeout: 20000 });

    step('checking default effort');

    // 1. The effort control appears once the mock /models catalog is ingested
    // (models without reasoning_effort hide it entirely) and starts on "auto".
    const trigger = page.locator('button:has(svg.lucide-gauge)');
    await waitFor(async () => (await trigger.count()) === 1, 10000, 'effort control after capability discovery');
    if (!/auto/.test(await trigger.innerText())) throw new Error(`effort should start on auto, got "${await trigger.innerText()}"`);

    step('picking high');

    // 2. Pick "high" from the dropdown.
    await trigger.click();
    await page.getByRole('menuitemradio', { name: /^high$/ }).click();
    await waitFor(async () => /high/.test(await trigger.innerText()), 5000, 'effort chip to read high');

    step('checking settings persisted');

    // 3. The choice is persisted in settings.
    const settings = await page.evaluate(async () => (await fetch('/api/settings')).json());
    if (settings.reasoningEffort !== 'high') throw new Error(`settings.reasoningEffort = ${JSON.stringify(settings.reasoningEffort)}`);

    step('sending message with high');

    // 4. Sending a message carries reasoning_effort to the provider.
    await clearCaptured();
    await page.locator('textarea').fill('hello effort e2e');
    await page.locator('button[aria-label="Send"]').click();
    await page.getByText('[mock chat]').first().waitFor({ timeout: 20000 });
    const sent = await waitForValue(async () => {
      const all = (await captured()).filter(isChatRequest);
      return all.length ? all : false;
    }, 10000, 'chat request at the mock').catch(async (e) => {
      const raw = await captured();
      say(`DEBUG captured=${raw.length} prompts=${JSON.stringify(raw.map((p) => String(((p.messages || []).find((m) => m.role === 'system') || {}).content || '').slice(0, 80)))}`, 2);
      throw e;
    });
    const highReq = sent[sent.length - 1];
    if (highReq.reasoning_effort !== 'high') throw new Error(`expected reasoning_effort=high, got ${JSON.stringify(highReq.reasoning_effort)}`);

    step('switching back to auto');

    // 5. Switching back to auto drops the override from the next request.
    await trigger.click();
    await page.getByRole('menuitemradio', { name: /^auto/ }).click();
    await waitFor(async () => /auto/.test(await trigger.innerText()), 5000, 'effort chip to read auto');
    const clearSettings = await page.evaluate(async () => (await fetch('/api/settings')).json());
    if (clearSettings.reasoningEffort !== null) throw new Error(`settings.reasoningEffort should be null, got ${JSON.stringify(clearSettings.reasoningEffort)}`);

    await clearCaptured();
    await page.locator('textarea').fill('hello default effort');
    await page.locator('button[aria-label="Send"]').click();
    const autoSent = await waitForValue(async () => {
      const all = (await captured()).filter(isChatRequest);
      return all.length ? all : false;
    }, 20000, 'chat request after clearing effort');
    const autoReq = autoSent[autoSent.length - 1];
    if ('reasoning_effort' in autoReq) throw new Error(`auto should not send reasoning_effort, got ${JSON.stringify(autoReq.reasoning_effort)}`);

    say('E2E OK: effort chip auto -> high -> request reasoning_effort=high -> auto -> no override');
    await browser.close();
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    say(`E2E FAIL: ${e.message}`, 2);
    if (browser) {
      try {
        const pages = browser.contexts()[0].pages();
        const pg = pages[pages.length - 1];
        say(`DEBUG url=${pg.url()}`, 2);
        say(`DEBUG body=${(await pg.locator('body').innerText()).slice(0, 700).replace(/\n/g, ' | ')}`, 2);
      } catch {}
    }
    say(`DEBUG mock: ${mockOut.slice(-700).replace(/\n/g, ' | ')}`, 2);
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
})();
