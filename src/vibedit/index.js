// vibedit — in-browser overlay chat + recorder, integrated into shmakk.
// Starts a visible Playwright Chromium browser, injects the overlay into
// every page load, and runs the control WebSocket server for chat/save/flow.
//
// The target can be:
//   - A URL (http://... or https://...)
//   - An HTML file (opened directly as file://)
//   - A package.json or directory containing one (dev server auto-started)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startControlServer } = require('./control');
const { ensureVibeditState } = require('./state');

const VIBEDIT_CONTROL_PORT = 0;

// URL pattern matched against dev server stdout lines.
const DEV_URL_RE = /(https?:\/\/localhost:\d{1,5}|https?:\/\/127\.0\.0\.1:\d{1,5}|https?:\/\/\[::1\]:\d{1,5})/;

// ── resolveTarget ──────────────────────────────────────────────────────────

function resolveTarget(target) {
  const resolved = path.resolve(target);

  // Already a URL — pass through.
  if (/^https?:\/\//.test(target)) {
    return { url: target, proc: null };
  }

  // The target is a package.json file.
  if (path.basename(resolved) === 'package.json' && fs.existsSync(resolved)) {
    return startDevServer(path.dirname(resolved));
  }

  // The target is an HTML file — open directly as file://.
  if (/\.html?$/i.test(resolved) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return { url: `file://${resolved}`, proc: null };
  }

  // The target is a directory — check for package.json first, then index.html.
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const pkg = path.join(resolved, 'package.json');
    if (fs.existsSync(pkg)) return startDevServer(resolved);
    const idx = path.join(resolved, 'index.html');
    if (fs.existsSync(idx)) return { url: `file://${idx}`, proc: null };
    return { url: null, proc: null, error: `no package.json or index.html in ${resolved}` };
  }

  // The target is some other file — open as file://.
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return { url: `file://${resolved}`, proc: null };
  }

  // Resolve relative to cwd, same logic.
  const cwdResolved = path.resolve(process.cwd(), target);
  if (path.basename(cwdResolved) === 'package.json' && fs.existsSync(cwdResolved)) {
    return startDevServer(path.dirname(cwdResolved));
  }
  if (/\.html?$/i.test(cwdResolved) && fs.existsSync(cwdResolved) && fs.statSync(cwdResolved).isFile()) {
    return { url: `file://${cwdResolved}`, proc: null };
  }
  if (fs.existsSync(cwdResolved) && fs.statSync(cwdResolved).isDirectory()) {
    const pkg = path.join(cwdResolved, 'package.json');
    if (fs.existsSync(pkg)) return startDevServer(cwdResolved);
    const idx = path.join(cwdResolved, 'index.html');
    if (fs.existsSync(idx)) return { url: `file://${idx}`, proc: null };
  }
  if (fs.existsSync(cwdResolved) && fs.statSync(cwdResolved).isFile()) {
    return { url: `file://${cwdResolved}`, proc: null };
  }

  // Fallback: assume it's a URL.
  return { url: target, proc: null };
}

// ── startDevServer ─────────────────────────────────────────────────────────
// Reads package.json, picks the dev/start/serve script, spawns it, and
// watches stdout for the URL the dev server prints.

function detectPackageManager(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'bun.lockb')) || fs.existsSync(path.join(projectDir, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function pickDevScript(pkg) {
  const scripts = pkg.scripts || {};
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  if (scripts.serve) return 'serve';
  if (scripts.develop) return 'develop';
  return null;
}

function startDevServer(projectDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { url: null, proc: null, error: `failed to read ${path.join(projectDir, 'package.json')}` };
  }

  const scriptName = pickDevScript(pkg);
  if (!scriptName) {
    return { url: null, proc: null, error: 'no dev, start, or serve script in package.json' };
  }

  const pm = detectPackageManager(projectDir);
  const args = pm === 'npm' || pm === 'yarn' ? ['run', scriptName] : [scriptName];
  const cmd = pm;

  console.log(`[shmakk vibedit] starting: ${cmd} ${args.join(' ')} (in ${projectDir})`);

  const proc = spawn(cmd, args, {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  const urlPromise = new Promise((resolveUrl) => {
    let found = false;

    function onLine(line) {
      if (found) return;
      const m = line.match(DEV_URL_RE);
      if (m) {
        found = true;
        const url = m[1].replace(/\/+$/, '');
        console.log(`[shmakk vibedit] detected dev server: ${url}`);
        resolveUrl(url);
      }
    }

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const ln of lines) onLine(ln);
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const ln of lines) onLine(ln);
    });

    proc.on('close', (code) => {
      if (!found) resolveUrl(null);
    });

    proc.on('error', () => {
      if (!found) resolveUrl(null);
    });
  });

  return { urlPromise, proc };
}

// ── waitReachable ──────────────────────────────────────────────────────────

async function waitReachable(url, timeoutMs) {
  // file:// URLs don't need reachability checks.
  if (url.startsWith('file://')) return true;

  return new Promise((resolve) => {
    const deadline = Date.now() + (timeoutMs || 30000);
    const tryConnect = () => {
      if (Date.now() >= deadline) return resolve(false);
      const req = http.get(url, (res) => { res.resume(); resolve(true); });
      req.on('error', () => setTimeout(tryConnect, 500));
      req.setTimeout(2000, () => { req.destroy(); setTimeout(tryConnect, 500); });
    };
    tryConnect();
  });
}

// ── startVibedit ───────────────────────────────────────────────────────────

// Resolve the built-in extension path. Returns the absolute path if the
// manifest exists, otherwise null.
function resolveExtensionPath() {
  const extPath = path.resolve(__dirname, '..', '..', 'extensions', 'vibedit');
  if (fs.existsSync(path.join(extPath, 'manifest.json'))) return extPath;
  return null;
}

async function startVibedit(opts) {
  let { projectDir, appUrl, onSpec, useExtension } = opts;

  // Resolve target.
  const target = resolveTarget(appUrl);
  let resolvedUrl;
  let devProc = null;

  if (target.urlPromise) {
    // Dev server was spawned — wait for the URL with a 60s timeout.
    console.log('[shmakk vibedit] waiting for dev server URL...');
    resolvedUrl = await Promise.race([
      target.urlPromise,
      new Promise((r) => setTimeout(() => r(null), 60000)),
    ]);
    devProc = target.proc;
    if (!resolvedUrl) {
      console.error('[shmakk vibedit] dev server did not print a URL within 60s');
      if (devProc) { try { devProc.kill(); } catch {} }
      return null;
    }
  } else if (target.error) {
    console.error(`[shmakk vibedit] ${target.error}`);
    return null;
  } else {
    resolvedUrl = target.url;
  }

  const state = ensureVibeditState(projectDir);

  const port = opts.port ?? VIBEDIT_CONTROL_PORT;

  // Launch visible browser.
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  console.log(`[shmakk vibedit] app: ${resolvedUrl}`);

  // Start control server (WebSocket + HTTP) with page ref for screenshots.
  const control = await startControlServer({
    port,
    stateDir: state.stateDir,
    sessionsDir: state.sessionsDir,
    specsDir: state.specsDir,
    pendingSpecFile: state.pendingSpecFile,
    automationsDir: state.automationsDir,
    pageStateFile: state.pageStateFile,
    page,
    projectDir,
    onSpec,
  });
  const controlPort = control.port;
  console.log(`[shmakk vibedit] control: ws://127.0.0.1:${controlPort}`);

  // Inject overlay on every document load (survives HMR reloads).
  const overlayJs = fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8');
  const boot = `window.__VIBEDIT__ = { port: ${controlPort} };\n${overlayJs}`;
  await context.addInitScript({ content: boot });

  // Wait for app to be reachable, then navigate.
  const reachable = await waitReachable(resolvedUrl, 30000);
  if (!reachable && !resolvedUrl.startsWith('file://')) {
    console.warn(`[shmakk vibedit] warning: ${resolvedUrl} is not responding yet, navigating anyway`);
  }

  let navigated = false;
  for (let attempt = 1; attempt <= 3 && !navigated; attempt++) {
    try {
      await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      navigated = true;
    } catch (err) {
      console.warn(`[shmakk vibedit] navigation attempt ${attempt} failed: ${err.message.split('\n')[0]}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!navigated) {
    console.error(`[shmakk vibedit] could not open ${resolvedUrl}`);
  }

  let closed = false;
  const shutdown = async (reason = 'requested') => {
    if (closed) return;
    closed = true;
    console.log(`\n[shmakk vibedit] shutting down (${reason})`);
    try { await browser.close(); } catch {}
    control.close();
    if (devProc) {
      try { devProc.kill('SIGTERM'); } catch {}
      // Give it a moment, then force kill.
      setTimeout(() => { try { devProc.kill('SIGKILL'); } catch {} }, 3000);
    }
  };

  page.on('close', () => { shutdown('browser window closed'); });
  browser.on('disconnected', () => { shutdown('browser disconnected'); });

  return { browser, control, port: controlPort, shutdown };
}

module.exports = { startVibedit, VIBEDIT_CONTROL_PORT };
