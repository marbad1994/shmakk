// Browser connector — connects to a running Chrome instance via CDP.
// Unlike browser.js (which launches its own headless browser), this
// module connects to an already-running Chrome that the user launched
// with --remote-debugging-port. This preserves the user's logged-in
// sessions, cookies, extensions, and other state.
//
// Usage from agent tools:
//   const bc = require('./core/browserConnector');
//   await bc.ensureConnected();          // connect if not already
//   await bc.navigate({ url: '...' });    // or click, type, readPage, etc.
//
// Usage from CLI:
//   shmakk connect-browser               // connect to default port 9222
//   shmakk connect-browser --port 9230   // connect to a custom port

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

let pw = null;          // playwright module (lazy-loaded)
let browser = null;     // ConnectedBrowser instance
let page = null;        // Active page
let _debugPort = 9222;  // CDP port

const SCREENSHOT_DIR = '/tmp/shmakk-screenshots';
const CONNECTION_STATE_PATH = path.join(os.homedir(), '.config', 'shmakk', 'browser-connection.json');

// ── Logger ────────────────────────────────────────────────────────────────

function log(level, message, detail) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `[shmakk:browser:${level.toUpperCase()}]`;
  if (detail !== undefined) {
    process.stderr.write(`${prefix} ${ts} ${message} ${JSON.stringify(detail)}\n`);
  } else {
    process.stderr.write(`${prefix} ${ts} ${message}\n`);
  }
}

// ── Availability ──────────────────────────────────────────────────────────

function isAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

function isConnected() {
  return !!(browser && browser.isConnected());
}

// ── CDP port detection ────────────────────────────────────────────────────

// Discovers a running Chrome instance by scanning the browser's
// DevToolsActivePort file or by probing HTTP on the CDP port.
function detectCDPPort() {
  // Try well-known profile locations
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config', 'google-chrome', 'DevToolsActivePort'),
    path.join(home, '.config', 'chromium', 'DevToolsActivePort'),
    path.join(home, '.config', 'google-chrome-unstable', 'DevToolsActivePort'),
    path.join(home, 'snap', 'chromium', 'common', 'chromium', 'DevToolsActivePort'),
    path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome', 'DevToolsActivePort'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8').trim();
        const port = parseInt(content.split('\n')[0], 10);
        if (port > 0 && port < 65536) {
          log('info', `detected CDP port ${port} from ${candidate}`);
          return port;
        }
      }
    } catch { /* ignore unreadable files */ }
  }

  return null;
}

// Probe HTTP endpoint to verify Chrome's CDP is listening.
async function probeCDP(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && data.webSocketDebuggerUrl) {
            log('info', `CDP probe successful`, { browser: data.Browser, port });
            resolve(true);
          } else {
            resolve(false);
          }
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Find a running Chrome CDP port. Returns null if none found.
async function findCDPPort() {
  const detected = detectCDPPort();
  if (detected) {
    const ok = await probeCDP(detected);
    if (ok) return detected;
  }

  // Fall back to scanning common ports
  const commonPorts = [9222, 9223, 9229, 9230, 9333, 9444];
  for (const port of commonPorts) {
    if (await probeCDP(port)) return port;
  }

  return null;
}

// ── Connection management ─────────────────────────────────────────────────

// Persist the last connection port for reconnection.
function saveConnectionState(state) {
  try {
    const dir = path.dirname(CONNECTION_STATE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONNECTION_STATE_PATH, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
  } catch {
    // Best-effort; not critical.
  }
}

function loadConnectionState() {
  try {
    if (fs.existsSync(CONNECTION_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(CONNECTION_STATE_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

async function ensurePage(args) {
  const port = (args && Number(args.debugPort)) || _debugPort;
  _debugPort = port;

  if (page && !page.isClosed()) {
    return page;
  }

  if (!pw) {
    try {
      pw = require('playwright');
    } catch {
      throw new Error(
        'playwright not installed. Run:\n' +
        '  npm install playwright\n' +
        '  npx playwright install chromium',
      );
    }
  }

  if (!browser || !browser.isConnected()) {
    const wsEndpoint = `http://127.0.0.1:${port}`;
    try {
      browser = await pw.chromium.connectOverCDP(wsEndpoint);
      log('info', `connected to Chrome via CDP port ${port}`);
      saveConnectionState({ port, connectedAt: Date.now() });
    } catch (e) {
      throw new Error(
        `Cannot connect to Chrome at port ${port}. Make sure Chrome is running with:\n` +
        `  google-chrome-stable --remote-debugging-port=${port}\n` +
        `Details: ${e.message}`,
      );
    }
  }

  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('No browser contexts found. Chrome may have no open windows.');
  }

  // Prefer the default context (has user data) over incognito ones.
  let ctx = contexts.find((c) => {
    try { return c.cookies && !c.isIncognito?.(); } catch { return true; }
  }) || contexts[0];

  const pages = ctx.pages();
  page = pages[pages.length - 1] || await ctx.newPage();
  return page;
}

async function connect(args) {
  const port = (args && Number(args.port)) || _debugPort;

  // Auto-detect if no explicit port and not already connected.
  if (!args || !args.port) {
    if (isConnected()) {
      return { ok: true, connected: true, port: _debugPort, note: 'already connected' };
    }
    const autoPort = await findCDPPort();
    if (autoPort) {
      _debugPort = autoPort;
    } else {
      return {
        ok: false,
        error: 'No running Chrome instance found. Start Chrome with:\n' +
               '  google-chrome-stable --remote-debugging-port=9222',
        hint: 'Pass --port to specify a custom CDP port',
      };
    }
  } else {
    _debugPort = port;
  }

  try {
    const p = await ensurePage({ debugPort: _debugPort });
    return {
      ok: true,
      connected: true,
      port: _debugPort,
      url: p.url(),
      title: await p.title(),
    };
  } catch (e) {
    return { ok: false, error: e.message, port: _debugPort };
  }
}

async function disconnect() {
  if (browser) {
    try { await browser.close(); } catch (e) {
      log('warn', 'error closing browser', { error: e.message });
    }
    browser = null;
    page = null;
    log('info', 'disconnected from Chrome');
  }
  return { ok: true, disconnected: true };
}

// ── Browser commands ──────────────────────────────────────────────────────

async function navigate(args) {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'url required' };

  const p = await ensurePage(args);
  try {
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return {
      ok: true,
      url: p.url(),
      title: await p.title(),
      status: resp ? resp.status() : null,
    };
  } catch (e) {
    return { error: `navigate failed: ${e.message}` };
  }
}

async function click(args) {
  const sel = String(args.selector || '').trim();
  if (!sel) return { error: 'selector required' };

  const p = await ensurePage(args);
  try {
    await p.click(sel, { timeout: 5000 });
    await p.waitForTimeout(500);
    return { ok: true, clicked: sel, url: p.url(), title: await p.title() };
  } catch (e) {
    return { error: `click failed: ${e.message}` };
  }
}

async function type(args) {
  const sel = String(args.selector || '').trim();
  const text = String(args.text ?? '');
  if (!sel) return { error: 'selector required' };

  const p = await ensurePage(args);
  try {
    await p.fill(sel, text, { timeout: 5000 });
    return { ok: true, selector: sel, typed: text.length + ' chars' };
  } catch (e) {
    try {
      await p.click(sel, { timeout: 3000 });
      await p.keyboard.type(text);
      return { ok: true, selector: sel, typed: text.length + ' chars', method: 'keyboard' };
    } catch (e2) {
      return { error: `type failed: ${e2.message}` };
    }
  }
}

async function readPage(args) {
  const p = await ensurePage(args);
  try {
    const data = await p.evaluate(() => {
      const r = {
        title: document.title,
        url: location.href,
      };

      // Headings
      r.headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .slice(0, 20)
        .map((h) => ({ level: h.tagName.toLowerCase(), text: h.textContent.trim().slice(0, 200) }))
        .filter((h) => h.text);

      // Links
      r.links = Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 30)
        .map((a) => ({ text: a.textContent.trim().slice(0, 100), href: a.href }))
        .filter((l) => l.text && l.href);

      // Form inputs
      r.inputs = Array.from(document.querySelectorAll('input, textarea, select'))
        .slice(0, 20)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          label: el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '',
          value: el.type === 'password' ? '***' : (el.value || '').slice(0, 100),
        }));

      // Buttons
      r.buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .slice(0, 15)
        .map((b) => ({
          text: (b.textContent || b.value || '').trim().slice(0, 100),
          id: b.id || '',
        }))
        .filter((b) => b.text);

      // Visible text content
      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            const tag = el.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'svg'].includes(tag)) return NodeFilter.FILTER_REJECT;
            try {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            } catch { /* ignore */ }
            return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        },
      );

      const texts = [];
      let totalLen = 0;
      while (walker.nextNode() && totalLen < 4000) {
        const t = walker.currentNode.textContent.trim();
        if (t) { texts.push(t); totalLen += t.length; }
      }
      r.text = texts.join(' ').slice(0, 4000);

      return r;
    });

    return data;
  } catch (e) {
    return { error: `read_page failed: ${e.message}` };
  }
}

async function screenshot(args) {
  const p = await ensurePage(args);
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const name = `screenshot-${Date.now()}.png`;
    const filePath = path.join(SCREENSHOT_DIR, name);
    await p.screenshot({ path: filePath, fullPage: false });
    const stats = fs.statSync(filePath);
    return {
      ok: true,
      path: filePath,
      size: stats.size,
      url: p.url(),
      title: await p.title(),
    };
  } catch (e) {
    return { error: `screenshot failed: ${e.message}` };
  }
}

async function evaluate(args) {
  const code = String(args.code || '').trim();
  if (!code) return { error: 'code required' };

  const p = await ensurePage(args);
  try {
    const result = await p.evaluate(code);
    return { ok: true, result: JSON.stringify(result).slice(0, 8000) };
  } catch (e) {
    return { error: `evaluate failed: ${e.message}` };
  }
}

async function selectOption(args) {
  const sel = String(args.selector || '').trim();
  const val = String(args.text ?? '');
  if (!sel) return { error: 'selector required' };

  const p = await ensurePage(args);
  try {
    const selected = await p.selectOption(sel, val, { timeout: 5000 });
    return { ok: true, selector: sel, selected };
  } catch (e) {
    return { error: `select failed: ${e.message}` };
  }
}

async function waitFor(args) {
  const p = await ensurePage(args);
  const sel = String(args.selector || '').trim();
  const seconds = Number(args.seconds) || 2;

  try {
    if (sel) {
      await p.waitForSelector(sel, { timeout: seconds * 1000 });
      return { ok: true, found: sel };
    }
    await p.waitForTimeout(Math.min(seconds, 10) * 1000);
    return { ok: true, waited: seconds + 's' };
  } catch (e) {
    return { error: `wait failed: ${e.message}` };
  }
}

async function scroll(args) {
  const dir = String(args.direction || 'down').toLowerCase();
  const amount = Number(args.amount) || (dir === 'up' ? -600 : 600);
  const p = await ensurePage(args);
  try {
    await p.mouse.wheel(0, amount);
    await p.waitForTimeout(300);
    return { ok: true, direction: dir, amount };
  } catch (e) {
    return { error: `scroll failed: ${e.message}` };
  }
}

// ── Status ────────────────────────────────────────────────────────────────

async function getStatus() {
  if (!isConnected()) {
    return { connected: false, port: _debugPort };
  }

  try {
    const p = await ensurePage({ debugPort: _debugPort });
    return {
      connected: true,
      port: _debugPort,
      url: p.url(),
      title: await p.title(),
    };
  } catch (e) {
    return { connected: false, port: _debugPort, error: e.message };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const COMMANDS = {
  navigate, click, type, read_page: readPage, screenshot,
  evaluate, select: selectOption, wait: waitFor, scroll,
  connect, disconnect, status: getStatus, close: disconnect,
};

function classifyBrowserAction(args) {
  const cmd = String(args.command || '').toLowerCase();
  if (cmd === 'read_page' || cmd === 'screenshot' || cmd === 'wait' || cmd === 'status') return 'safe';
  if (cmd === 'close' || cmd === 'disconnect') return 'unsafe';
  if (cmd === 'connect') return 'safe'; // connecting is safe; actions after depend on user's session
  return 'uncertain';
}

async function executeBrowserAction(args) {
  if (!isAvailable()) {
    return { error: 'playwright not installed. Run: npm install playwright && npx playwright install chromium' };
  }

  const cmd = String(args.command || '').toLowerCase();
  const fn = COMMANDS[cmd];

  if (!fn) {
    return {
      error: `unknown browser command: ${cmd}. Available: ${Object.keys(COMMANDS).join(', ')}`,
    };
  }

  try {
    return await fn(args);
  } catch (e) {
    log('error', `command '${cmd}' failed`, { error: e.message });
    return { error: `browser ${cmd} failed: ${e.message}` };
  }
}

module.exports = {
  isAvailable,
  isConnected,
  connect,
  disconnect,
  ensurePage,
  executeBrowserAction,
  classifyBrowserAction,
  getStatus,
  findCDPPort,
};
