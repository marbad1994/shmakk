// Electron app automation via Chrome DevTools Protocol (CDP).
// Connects to an Electron app running with --remote-debugging-port.
// Plays the same role as browser.js but for Electron desktop apps.
//
// Usage: Launch the Electron app with:
//   electron --remote-debugging-port=9222 path/to/app
// Then the agent can use the `electron` tool to interact with it.

const fs = require('fs');
const path = require('path');

let pw = null;
let browser = null;
let page = null;
let _debugPort = 9222; // default CDP port

const SCREENSHOT_DIR = '/tmp/shmakk-screenshots';

function isAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

async function ensurePage(args) {
  const port = Number(args.debugPort) || _debugPort;
  _debugPort = port;

  if (page && !page.isClosed()) return page;

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
    } catch (e) {
      throw new Error(
        `Cannot connect to Electron at port ${port}. Make sure the app is running with:\n` +
        `  electron --remote-debugging-port=${port} path/to/app\n` +
        `Details: ${e.message}`,
      );
    }
  }

  const contexts = browser.contexts();
  const ctx = contexts[0];
  const pages = ctx.pages();
  page = pages[0] || await ctx.newPage();
  return page;
}

// ── Commands ──────────────────────────────────────────────────────────────

async function screenshot(args) {
  const p = await ensurePage(args);
  try {
    const ts = Date.now();
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filePath = path.join(SCREENSHOT_DIR, `electron-${ts}.png`);
    await p.screenshot({ path: filePath, fullPage: args.fullPage !== false });

    const buf = fs.readFileSync(filePath);
    const b64 = buf.toString('base64');

    return {
      ok: true,
      path: filePath,
      mimeType: 'image/png',
      images: [{
        mimeType: 'image/png',
        data: b64,
        dataLength: b64.length,
        truncated: false,
      }],
    };
  } catch (e) {
    return { error: `screenshot failed: ${e.message}` };
  }
}

async function navigate(args) {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'url required' };

  const p = await ensurePage(args);
  try {
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
  const text = String(args.text || '');
  if (!sel) return { error: 'selector required' };
  if (!text) return { error: 'text required' };

  const p = await ensurePage(args);
  try {
    await p.fill(sel, text, { timeout: 5000 });
    return { ok: true, typed: text, selector: sel };
  } catch (e) {
    return { error: `type failed: ${e.message}` };
  }
}

async function readPage(args) {
  const p = await ensurePage(args);
  try {
    const title = await p.title();
    const url = p.url();
    const bodyText = await p.evaluate(() => document.body ? document.body.innerText : '');

    const links = await p.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: (a.textContent || '').trim().slice(0, 200),
        href: a.href,
      }));
    });

    const forms = await p.evaluate(() => {
      return Array.from(document.querySelectorAll('form')).slice(0, 20).map(f => ({
        action: f.action,
        method: f.method,
        inputs: Array.from(f.querySelectorAll('input, select, textarea, button')).slice(0, 20).map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          value: (el.value || '').slice(0, 100),
        })),
      }));
    });

    let content = `Title: ${title}\nURL: ${url}\n\n`;
    content += bodyText.slice(0, 8000);

    return {
      ok: true,
      title,
      url,
      content: content.slice(0, 12000),
      links: links.slice(0, 50),
      forms: forms.slice(0, 10),
    };
  } catch (e) {
    return { error: `read_page failed: ${e.message}` };
  }
}

async function evaluate(args) {
  const code = String(args.code || '').trim();
  if (!code) return { error: 'code required' };

  const p = await ensurePage(args);
  try {
    const result = await p.evaluate(code);
    return { ok: true, result: JSON.stringify(result).slice(0, 4000) };
  } catch (e) {
    return { error: `evaluate failed: ${e.message}` };
  }
}

async function select(args) {
  const sel = String(args.selector || '').trim();
  const value = String(args.value || '');
  if (!sel) return { error: 'selector required' };
  if (!value) return { error: 'value required' };

  const p = await ensurePage(args);
  try {
    await p.selectOption(sel, value, { timeout: 5000 });
    return { ok: true, selected: value, selector: sel };
  } catch (e) {
    return { error: `select failed: ${e.message}` };
  }
}

async function wait(args) {
  const sel = args.selector ? String(args.selector).trim() : null;
  const seconds = Number(args.seconds) || 1;

  const p = await ensurePage(args);
  try {
    if (sel) {
      await p.waitForSelector(sel, { timeout: Math.min(seconds * 1000, 30000) });
    } else {
      await p.waitForTimeout(Math.min(seconds * 1000, 30000));
    }
    return { ok: true, waited: seconds, selector: sel || 'timeout' };
  } catch (e) {
    return { error: `wait failed: ${e.message}` };
  }
}

async function scroll(args) {
  const direction = args.direction === 'up' ? 'up' : 'down';
  const amount = Number(args.amount) || 300;

  const p = await ensurePage(args);
  try {
    await p.evaluate(({ direction, amount }) => {
      window.scrollBy(0, direction === 'down' ? amount : -amount);
    }, { direction, amount });
    await p.waitForTimeout(300);
    return { ok: true, scrolled: direction, amount };
  } catch (e) {
    return { error: `scroll failed: ${e.message}` };
  }
}

async function close(args) {
  try {
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
    }
    return { ok: true, closed: true };
  } catch (e) {
    browser = null;
    page = null;
    return { ok: true, closed: true, note: 'force closed' };
  }
}

// Connect to a specific Electron debug port
async function connect(args) {
  const port = Number(args.debugPort) || 9222;
  _debugPort = port;
  try {
    const p = await ensurePage(args);
    return {
      ok: true,
      connected: true,
      port,
      url: p.url(),
      title: await p.title(),
    };
  } catch (e) {
    return { error: `connect failed: ${e.message}` };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const COMMANDS = {
  screenshot, navigate, click, type, read_page: readPage,
  evaluate, select, wait, scroll, close, connect,
};

function classifyElectronCommand(args) {
  const cmd = String(args.command || '');
  if (cmd === 'screenshot' || cmd === 'read_page' || cmd === 'wait') return 'safe';
  if (cmd === 'click' || cmd === 'type' || cmd === 'scroll' || cmd === 'evaluate' || cmd === 'select' || cmd === 'navigate') return 'uncertain';
  if (cmd === 'close' || cmd === 'connect') return 'unsafe';
  return 'uncertain';
}

async function dispatchElectron(args, signal) {
  if (!isAvailable()) {
    return { error: 'playwright not installed. Run: npm install playwright && npx playwright install chromium' };
  }
  const cmd = String(args.command || '');
  const fn = COMMANDS[cmd];
  if (!fn) return { error: `unknown electron command: ${cmd}. Available: ${Object.keys(COMMANDS).join(', ')}` };
  try {
    const result = await fn(args);
    return result;
  } catch (e) {
    return { error: `electron ${cmd} failed: ${e.message}` };
  }
}

module.exports = { dispatchElectron, classifyElectronCommand, isAvailable };
