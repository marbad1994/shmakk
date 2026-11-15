// Mobile app automation via ADB (Android Debug Bridge).
// Manages a persistent ADB connection to an Android device/emulator
// across the session. The agent uses this through the `mobile` tool
// in tools.js.
//
// Requires: adb on PATH, device connected or emulator running.

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCREENSHOT_DIR = '/tmp/shmakk-screenshots';

let _deviceId = null; // cached device serial, set on first ensure

function isAvailable() {
  try {
    execFileSync('adb', ['version'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function adb(args, opts = {}) {
  const fullArgs = _deviceId ? ['-s', _deviceId, ...args] : args;
  const { stdout } = execFileSync('adb', fullArgs, {
    timeout: opts.timeout || 15000,
    maxBuffer: opts.maxBuffer || 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'buffer',
  });
  return (stdout || '').toString();
}

function adbAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = _deviceId ? ['-s', _deviceId, ...args] : args;
    execFile('adb', fullArgs, {
      timeout: opts.timeout || 15000,
      maxBuffer: opts.maxBuffer || 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || '').toString());
    });
  });
}

function ensureDevice() {
  if (_deviceId) return _deviceId;

  try {
    const devices = adb(['devices']);
    const lines = devices.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*'));
    const online = lines.filter(l => /\tdevice/.test(l)).map(l => l.split('\t')[0].trim());

    if (online.length === 0) {
      throw new Error(
        'No Android device/emulator found. Connect a device via USB or start an emulator.\n' +
        'Run: adb devices  to check available devices.'
      );
    }

    _deviceId = online[0];
    return _deviceId;
  } catch (e) {
    if (e.message.includes('No Android device')) throw e;
    throw new Error(`ADB error: ${e.message}`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────

async function screenshot(args) {
  try {
    ensureDevice();
    const ts = Date.now();
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const remotePath = '/sdcard/shmakk_screen.png';
    const localPath = path.join(SCREENSHOT_DIR, `mobile-${ts}.png`);

    // Capture screenshot on device
    adb(['shell', 'screencap', '-p', remotePath]);

    // Pull to local
    adb(['pull', remotePath, localPath]);

    // Clean up remote file
    try { adb(['shell', 'rm', remotePath]); } catch {}

    // Return base64 for vision LLMs
    const buf = fs.readFileSync(localPath);
    const b64 = buf.toString('base64');

    return {
      ok: true,
      path: localPath,
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

async function click(args) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (isNaN(x) || isNaN(y)) return { error: 'x and y coordinates required' };

  try {
    ensureDevice();
    adb(['shell', 'input', 'tap', String(x), String(y)]);
    return { ok: true, action: 'click', x, y };
  } catch (e) {
    return { error: `click failed: ${e.message}` };
  }
}

async function type(args) {
  const text = String(args.text || '');
  if (!text) return { error: 'text required' };

  try {
    ensureDevice();
    // Escape special shell chars for input text
    const escaped = text.replace(/(['"\\])/g, '\\$1');
    adb(['shell', 'input', 'text', escaped]);
    return { ok: true, action: 'type', length: text.length };
  } catch (e) {
    return { error: `type failed: ${e.message}` };
  }
}

async function swipe(args) {
  const x1 = Number(args.x1);
  const y1 = Number(args.y1);
  const x2 = Number(args.x2);
  const y2 = Number(args.y2);
  const duration = Number(args.duration) || 300;

  if ([x1, y1, x2, y2].some(isNaN)) {
    return { error: 'x1, y1, x2, y2 coordinates required' };
  }

  try {
    ensureDevice();
    adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]);
    return { ok: true, action: 'swipe', from: [x1, y1], to: [x2, y2], duration };
  } catch (e) {
    return { error: `swipe failed: ${e.message}` };
  }
}

async function key(args) {
  const code = String(args.code || '').toUpperCase();
  if (!code) return { error: 'key code required (e.g. BACK, HOME, ENTER, DELETE)' };

  try {
    ensureDevice();
    adb(['shell', 'input', 'keyevent', `KEYCODE_${code}`]);
    return { ok: true, action: 'key', code };
  } catch (e) {
    return { error: `key failed: ${e.message}` };
  }
}

async function readPage(args) {
  try {
    ensureDevice();
    const remotePath = '/sdcard/shmakk_ui.xml';
    const localPath = path.join(os.tmpdir(), `shmakk-ui-${Date.now()}.xml`);

    adb(['shell', 'uiautomator', 'dump', remotePath]);
    adb(['pull', remotePath, localPath]);
    try { adb(['shell', 'rm', remotePath]); } catch {}

    const xml = fs.readFileSync(localPath, 'utf8');
    try { fs.unlinkSync(localPath); } catch {}

    // Parse basic structure from accessibility tree
    const elements = [];
    const tagRe = /<node[^>]*>/g;
    let match;
    while ((match = tagRe.exec(xml)) !== null) {
      const tag = match[0];
      const textMatch = tag.match(/text="([^"]*)"/);
      const classMatch = tag.match(/class="([^"]*)"/);
      const boundsMatch = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      const clickable = tag.includes('clickable="true"');
      const checkable = tag.includes('checkable="true"');
      const scrollable = tag.includes('scrollable="true"');
      const focused = tag.includes('focused="true"');
      const enabled = tag.includes('enabled="true"');

      elements.push({
        text: textMatch ? textMatch[1] : '',
        className: classMatch ? classMatch[1].split('.').pop() : '',
        bounds: boundsMatch ? {
          x: parseInt(boundsMatch[1]),
          y: parseInt(boundsMatch[2]),
          w: parseInt(boundsMatch[3]) - parseInt(boundsMatch[1]),
          h: parseInt(boundsMatch[4]) - parseInt(boundsMatch[2]),
        } : null,
        clickable,
        checkable,
        scrollable,
        focused,
        enabled,
      });
    }

    return {
      ok: true,
      elements: elements.slice(0, 200), // Cap for size
      totalElements: elements.length,
      truncated: elements.length > 200,
    };
  } catch (e) {
    return { error: `read_page failed: ${e.message}` };
  }
}

async function listApps(args) {
  try {
    ensureDevice();
    const filter = String(args.filter || '').trim();
    const output = adb(['shell', 'pm', 'list', 'packages', ...(filter ? [filter] : [])]);
    const packages = output.split('\n')
      .filter(l => l.startsWith('package:'))
      .map(l => l.replace('package:', '').trim());

    return { ok: true, packages, count: packages.length };
  } catch (e) {
    return { error: `list_apps failed: ${e.message}` };
  }
}

async function launch(args) {
  const pkg = String(args.package || '').trim();
  if (!pkg) return { error: 'package name required' };

  try {
    ensureDevice();
    // Try launching the main activity first
    const output = adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 10000 });
    return { ok: true, action: 'launch', package: pkg };
  } catch (e) {
    return { error: `launch failed: ${e.message}` };
  }
}

async function close(args) {
  const pkg = String(args.package || '').trim();
  if (!pkg) return { error: 'package name required' };

  try {
    ensureDevice();
    adb(['shell', 'am', 'force-stop', pkg]);
    return { ok: true, action: 'close', package: pkg };
  } catch (e) {
    return { error: `close failed: ${e.message}` };
  }
}

async function wait(args) {
  const ms = Number(args.ms) || 1000;
  await new Promise(r => setTimeout(r, Math.min(ms, 30000)));
  return { ok: true, action: 'wait', ms };
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const COMMANDS = { screenshot, click, type, swipe, key, read_page: readPage, list_apps: listApps, launch, close, wait };

function classifyMobileCommand(args) {
  const cmd = String(args.command || '');
  // All mobile commands are potentially destructive (interact with a real device)
  if (cmd === 'screenshot' || cmd === 'read_page' || cmd === 'list_apps' || cmd === 'wait') return 'safe';
  if (cmd === 'click' || cmd === 'type' || cmd === 'swipe' || cmd === 'key') return 'uncertain';
  if (cmd === 'launch' || cmd === 'close') return 'unsafe';
  return 'uncertain';
}

async function dispatchMobile(args, signal) {
  if (!isAvailable()) {
    return { error: 'adb not found. Install Android SDK platform tools.' };
  }
  const cmd = String(args.command || '');
  const fn = COMMANDS[cmd];
  if (!fn) return { error: `unknown mobile command: ${cmd}. Available: ${Object.keys(COMMANDS).join(', ')}` };
  try {
    const result = await fn(args);
    return result;
  } catch (e) {
    return { error: `mobile ${cmd} failed: ${e.message}` };
  }
}

module.exports = { dispatchMobile, classifyMobileCommand, isAvailable };
