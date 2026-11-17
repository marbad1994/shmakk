#!/usr/bin/env node
// Throwaway browser E2E for the file-attachment feature. Starts a mock LLM and
// the real web server, then drives headless Chromium to attach a file, send a
// message, and confirm the chip renders in both the composer and the user bubble
// and that a streamed reply comes back.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN = 'e2e-attach-token';
const PORT = 8642;
const MOCK_PORT = 8787;

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
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

(async () => {
  const procs = [];
  const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shmakk-attach-'));
  const sample = path.join(tmp, 'notes-e2e.txt');
  fs.writeFileSync(sample, '# Release notes\n- ship attachments\n- keep them off the stored item\n');

  const mock = spawn('node', ['test/mock-llm.js', String(MOCK_PORT)], { stdio: 'ignore' });
  procs.push(mock);
  await waitForPort(MOCK_PORT);

  const web = spawn('node', ['bin/shmakk.js', '--web', '--port', String(PORT), '--no-open'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      SHMAKK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      SHMAKK_API_KEY: 'x',
      SHMAKK_MODEL: 'mock',
      SHMAKK_WEB_TOKEN: TOKEN,
      // Keep the server's state (conversations, settings) inside the temp dir
      // so this throwaway E2E never writes into the user's real state.
      XDG_STATE_HOME: path.join(tmp, 'state'),
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
    },
  });
  procs.push(web);
  await waitForPort(PORT);

  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });

    // Wait for the composer.
    await page.waitForSelector('textarea', { timeout: 20000 });

    // 1. The attach button is present.
    const attach = page.locator('button[aria-label="Attach files"]');
    if (await attach.count() !== 1) throw new Error('attach button not found');

    // 2. Attaching a file renders a chip in the composer.
    await page.setInputFiles('input[type="file"]', sample);
    const chip = page.getByText('notes-e2e.txt');
    await chip.first().waitFor({ timeout: 10000 });

    // 3. Send is enabled by the file alone (empty text) and sends.
    const sendBtn = page.locator('button[aria-label="Send"]');
    if (await sendBtn.isDisabled()) throw new Error('send should be enabled with a file attached');
    await sendBtn.click();

    // 4. The user bubble shows the file chip and a reply streams back.
    await page.getByText('[mock chat]').waitFor({ timeout: 20000 });
    const bubbleChips = await page.getByText('notes-e2e.txt').count();
    if (bubbleChips < 1) throw new Error('file chip missing from user bubble');

    console.log('E2E OK: attach → chip → send (file-only) → bubble chip → streamed reply');
    await browser.close();
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error('E2E FAIL:', e.message);
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
})();
