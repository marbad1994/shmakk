// Browser automation via Playwright (optional dependency).
// Manages a persistent headless browser across the session.
// The agent uses this through the `browser` tool in tools.js.

const path = require('path');
const fs = require('fs');

let pw = null;       // playwright module (lazy-loaded)
let browser = null;   // Browser instance
let context = null;   // BrowserContext
let page = null;      // Active page

const SCREENSHOT_DIR = '/tmp/shmakk-screenshots';

function isAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;

  if (!pw) {
    try {
      pw = require('playwright');
    } catch {
      throw new Error(
        'playwright not installed. Run:\n'
        + '  npm install playwright\n'
        + '  npx playwright install chromium',
      );
    }
  }

  if (!browser || !browser.isConnected()) {
    browser = await pw.chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 shmakk/1.0',
      viewport: { width: 1280, height: 720 },
    });
  }

  page = context.pages()[0] || await context.newPage();
  return page;
}

// ── Commands ──────────────────────────────────────────────────────────────

async function navigate(args) {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'url required' };

  const p = await ensurePage();
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

  const p = await ensurePage();
  try {
    await p.click(sel, { timeout: 5000 });
    await p.waitForTimeout(500); // settle
    return { ok: true, clicked: sel, url: p.url(), title: await p.title() };
  } catch (e) {
    return { error: `click failed: ${e.message}` };
  }
}

async function type(args) {
  const sel = String(args.selector || '').trim();
  const text = String(args.text ?? '');
  if (!sel) return { error: 'selector required' };

  const p = await ensurePage();
  try {
    await p.fill(sel, text, { timeout: 5000 });
    return { ok: true, selector: sel, typed: text.length + ' chars' };
  } catch (e) {
    // fill() can fail on contenteditable; fall back to type()
    try {
      await p.click(sel, { timeout: 3000 });
      await p.keyboard.type(text);
      return { ok: true, selector: sel, typed: text.length + ' chars', method: 'keyboard' };
    } catch (e2) {
      return { error: `type failed: ${e2.message}` };
    }
  }
}

async function readPage() {
  const p = await ensurePage();
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
  const p = await ensurePage();
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const name = `screenshot-${Date.now()}.png`;
    const filePath = path.join(SCREENSHOT_DIR, name);
    await p.screenshot({ path: filePath, fullPage: false });

    const buf = fs.readFileSync(filePath);
    const b64 = buf.toString('base64');
    const stats = fs.statSync(filePath);

    return {
      ok: true,
      path: filePath,
      size: stats.size,
      url: p.url(),
      title: await p.title(),
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

async function evaluate(args) {
  const code = String(args.code || '').trim();
  if (!code) return { error: 'code required' };

  const p = await ensurePage();
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

  const p = await ensurePage();
  try {
    const selected = await p.selectOption(sel, val, { timeout: 5000 });
    return { ok: true, selector: sel, selected };
  } catch (e) {
    return { error: `select failed: ${e.message}` };
  }
}

async function waitFor(args) {
  const p = await ensurePage();
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
  const p = await ensurePage();
  try {
    const delta = dir === 'up' ? -600 : 600;
    await p.mouse.wheel(0, delta);
    await p.waitForTimeout(300);
    return { ok: true, direction: dir };
  } catch (e) {
    return { error: `scroll failed: ${e.message}` };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────

async function dispatchBrowser(args) {
  const cmd = String(args.command || '').toLowerCase();

  switch (cmd) {
    case 'navigate': return navigate(args);
    case 'click': return click(args);
    case 'type': return type(args);
    case 'read_page': return readPage(args);
    case 'screenshot': return screenshot(args);
    case 'evaluate': return evaluate(args);
    case 'select': return selectOption(args);
    case 'wait': return waitFor(args);
    case 'scroll': return scroll(args);
    case 'close':
      if (browser) {
        try { await browser.close(); } catch {}
        browser = null; context = null; page = null;
      }
      return { ok: true, message: 'browser closed' };
    default:
      return { error: `unknown browser command: ${cmd}. Use: navigate, click, type, read_page, screenshot, evaluate, select, wait, scroll, close` };
  }
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null; context = null; page = null;
  }
}

// Safety classification per browser command
function classifyBrowserCommand(args) {
  const cmd = String(args.command || '').toLowerCase();
  if (cmd === 'read_page' || cmd === 'screenshot' || cmd === 'wait' || cmd === 'close') return 'safe';
  return 'uncertain';
}

module.exports = { dispatchBrowser, closeBrowser, isAvailable, classifyBrowserCommand };
