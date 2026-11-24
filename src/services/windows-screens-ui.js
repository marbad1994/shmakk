// Opens the screen priority widget: a small Electron window that draws the
// connected screens in their real layout and sets their priority by click.
//
// The widget itself lives in desktop/screens and writes the same
// ~/.config/shmakk/screens.json that window_screens and windows-reorder read.
// Keeping this launcher here lets the CLI and the tray indicator share it.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function widgetDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'desktop', 'screens'),
    path.join(process.resourcesPath || '', 'shmakk', 'desktop', 'screens'),
    path.join(process.resourcesPath || '', 'desktop', 'screens'),
  ];
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'main.js'))) return c;
  return null;
}

function electronBinary(dir) {
  const local = path.join(dir, '..', 'node_modules', 'electron');
  try {
    const bin = require(local);
    if (typeof bin === 'string' && fs.existsSync(bin)) return bin;
  } catch {}
  const packaged = path.join(process.resourcesPath || '', 'electron', 'electron');
  if (fs.existsSync(packaged)) return packaged;
  for (const p of ['/usr/bin/electron', '/usr/bin/electron32', '/usr/bin/electron33', '/usr/bin/electron34']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Start the widget detached so it outlives this process. A second launch is
 * harmless: the widget holds a single instance lock and just raises itself.
 * Returns { ok, pid } or { error }.
 */
function openScreensWidget(opts = {}) {
  const dir = widgetDir();
  if (!dir) return { error: 'screen widget not found: expected desktop/screens/main.js' };
  const bin = electronBinary(dir);
  if (!bin) return { error: 'Electron is not installed: cd desktop && npm install' };

  const args = [dir];
  if (opts.remoteDebuggingPort) args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`);
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');

  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  child.unref();
  return { ok: true, pid: child.pid, dir };
}

module.exports = { openScreensWidget, widgetDir, electronBinary };
