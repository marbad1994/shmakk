// shmakk screen priority — a small window that draws the connected screens in
// their real layout, so priority is set by clicking the screens themselves.
//
// The order is the same one `window_screens` and `windows-reorder` read from
// ~/.config/shmakk/screens.json. Writing it here means the Plasma/KWin side
// (kscreen-doctor output.<name>.priority.<n>) stays in step.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Works from the repo tree and from a packaged app that ships shmakk/ as
// extra resources; mirrors how desktop/main.js finds the web server.
function loadScreensModule() {
  const candidates = [
    path.join(__dirname, '..', '..', 'src', 'services', 'windows-screens.js'),
    path.join(process.resourcesPath || '', 'shmakk', 'src', 'services', 'windows-screens.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return require(c);
  return require('shmakk/src/services/windows-screens');
}

/**
 * Logical box of an output: kscreen reports the mode size in pixels and lets
 * the compositor scale and rotate it, so the drawn rectangle has to undo both.
 */
function logicalBox(s) {
  const scale = Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1;
  let w = Math.round((s.width || 0) / scale);
  let h = Math.round((s.height || 0) / scale);
  if (s.rotation === 2 || s.rotation === 8) [w, h] = [h, w];
  return { x: s.x || 0, y: s.y || 0, w: w || 0, h: h || 0 };
}

let win = null;

async function state() {
  const S = loadScreensModule();
  const cfg = S.readConfig();
  const queried = await S.queryScreensSafe();
  const screens = (queried.screens || []).filter((s) => s.enabled);
  const names = new Set(screens.map((s) => s.name));
  const order = (cfg.order || []).filter((n) => names.has(n));

  return {
    ok: queried.ok,
    error: queried.ok ? null : queried.error,
    order,
    stored: cfg.order || [],
    kscreen: cfg.kscreen !== false,
    screens: screens
      .map((s) => ({
        name: s.name,
        width: s.width,
        height: s.height,
        scale: s.scale,
        rotation: s.rotation,
        orientation: s.orientation,
        kscreenPriority: s.priority,
        rank: order.indexOf(s.name) + 1,
        box: logicalBox(s),
      }))
      .sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y),
  };
}

async function setOrder(order, kscreen) {
  const S = loadScreensModule();
  const wanted = (Array.isArray(order) ? order : []).map(String).filter(Boolean);
  const useKscreen = kscreen !== false;

  // No priority at all: write the empty order straight to the file, since
  // setPriorities insists on at least one name.
  if (!wanted.length) {
    S.writeConfig({ order: [], kscreen: useKscreen });
    return { state: await state(), result: { ok: true, order: [], kscreen: null } };
  }

  const queried = await S.queryScreensSafe();
  const result = await S.setPriorities(wanted, { screens: queried.screens, kscreen: useKscreen });
  return { state: await state(), result };
}

function createWindow() {
  win = new BrowserWindow({
    width: 660,
    height: 480,
    minWidth: 460,
    minHeight: 320,
    title: 'Screen priority',
    icon: path.join(__dirname, '..', 'icon.png'),
    backgroundColor: '#0e100f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    ipcMain.handle('screens:state', () => state());
    ipcMain.handle('screens:set', (_e, payload = {}) => setOrder(payload.order, payload.kscreen));
    ipcMain.handle('screens:reset', async () => {
      const S = loadScreensModule();
      S.writeConfig({ order: [] });
      return { state: await state(), result: { ok: true, order: [], kscreen: null } };
    });
    ipcMain.on('screens:close', () => { if (win) win.close(); });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
