// shmakk desktop — an Electron shell around the web interface.
//
// The shmakk server runs inside this process on a random loopback port with
// a one-off token; the window is the only client. Closing the app stops the
// server and everything it started.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function loadServer() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'webui', 'server.js'),                   // running from the repo / npm package
    path.join(process.resourcesPath || '', 'shmakk', 'src', 'webui', 'server.js'), // packaged app
  ];
  for (const c of candidates) if (fs.existsSync(c)) return require(c);
  return require('shmakk/src/webui/server');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') out.workspace = argv[++i];
    else if (argv[i] === '--profile') out.profile = argv[++i];
    else if (argv[i] === '--review') out.review = true;
    else if (argv[i] === '--yes-files') out.yesFiles = true;
    else if (argv[i] === '--debug') out.debug = true;
  }
  return out;
}

const statePath = () => path.join(app.getPath('userData'), 'window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function saveState(state) { try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch { /* best effort */ } }

let win = null;
let server = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start).catch((e) => { dialog.showErrorBox('shmakk could not start', String(e && e.stack || e)); app.quit(); });
}

async function start() {
  const args = parseArgs(process.argv.slice(1));
  const state = loadState();
  const workspace = args.workspace || state.workspace || os.homedir();

  const { startWebServer } = loadServer();
  server = await startWebServer({
    port: 0,
    host: '127.0.0.1',
    token: crypto.randomBytes(24).toString('base64url'),
    workspace: fs.existsSync(workspace) ? workspace : os.homedir(),
    open: false,
    quiet: true,
    review: args.review,
    yesFiles: args.yesFiles,
    debug: args.debug,
    profile: args.profile,
    onShutdown: () => app.quit(), // "Quit shmakk" in the UI
  });

  // Mic access is requested by voice input; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(server.baseUrl) && (permission === 'media' || permission === 'notifications' || permission === 'clipboard-sanitized-write'));
  });

  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 840,
    x: state.x,
    y: state.y,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'shmakk',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e100f' : '#f7f6f2',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 16, y: 17 } : undefined,
    autoHideMenuBar: !mac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Only the shmakk UI lives in this window; everything else opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(server.baseUrl)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    saveState({ ...b, maximized: win.isMaximized(), workspace: server.app.getWorkspace() });
  };
  win.on('close', remember);
  win.on('closed', () => { win = null; });

  ipcMain.handle('shmakk:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a workspace', defaultPath: server.app.getWorkspace(), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.on('shmakk:open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  Menu.setApplicationMenu(buildMenu(mac));
  await win.loadURL(server.url);
}

function send(action) { return () => { if (win) win.webContents.send('shmakk:menu', action); }; }

function buildMenu(mac) {
  const view = (label, id, accelerator) => ({ label, accelerator, click: send(`view:${id}`) });
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new-chat') },
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: async () => {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
          if (!r.canceled && r.filePaths[0]) server.app.setWorkspace(r.filePaths[0]);
        } },
        { type: 'separator' },
        view('Settings…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: send('palette') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: send('toggle-terminal') },
        { type: 'separator' },
        view('Chat', 'chat'), view('Skills', 'skills'), view('Memory & Rules', 'memory'), view('Plan', 'plan'),
        view('Changes', 'changes'), view('Session Recall', 'recall'), view('Agents & Workflows', 'team'),
        view('MCP Servers', 'mcp'), view('Activity', 'activity'),
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'shmakk on GitHub', click: () => shell.openExternal('https://github.com/marbad1994/shmakk') }] },
  ]);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting || !server) return;
  // Stop running tasks, terminals and MCP servers before the process exits.
  quitting = true;
  e.preventDefault();
  Promise.race([server.close(), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.exit(0));
});
