// `shmakk windows-daemon`: owns dev.shmakk.Windows on the session bus and
// records the events the KWin watcher script sends into the window store.
//
// Needs the optional dependencies dbus-next and better-sqlite3.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const W = require('../services/windows');
const P = require('../services/windows-proactive');
const R = require('../services/windows-reorder');
const T = require('../services/windows-tray');

const KWIN_PACKAGE = path.join(__dirname, '..', '..', 'kwin', 'shmakk-watch');
const PLUGIN_ID = 'shmakk-watch';

const HELP = `shmakk windows-daemon - window awareness for KDE Plasma

Usage:
  shmakk windows-daemon                 record window events (foreground)
  shmakk windows-daemon --proactive M   suggestions: off | suggest | auto
  shmakk windows-daemon --install-kwin  install and enable the KWin watcher
  shmakk windows-daemon --status        show store and daemon status
  shmakk windows-daemon --no-tray       skip the panel indicator
  shmakk windows-daemon --tray-check    is the indicator on the panel?
  shmakk windows-daemon --install-autostart
  shmakk windows-daemon --reorder       same as Ctrl+Alt+; (daemon must run)
  shmakk windows-daemon --swap-screens  same as Ctrl+Alt+'

Store: ${W.defaultDbPath()} (override with SHMAKK_WINDOWS_DB)
Agent tools: window_list, window_usage, window_predict, window_layout,
window_screens, window_pairs.
Window titles reach the model only with SHMAKK_WINDOWS_TITLES=1.

Proactive suggestions (default: suggest) fire after you stay in a window for
SHMAKK_WINDOWS_DWELL_SEC (30) when the next-app prediction reaches
SHMAKK_WINDOWS_MIN_P (0.6); auto mode arranges at SHMAKK_WINDOWS_AUTO_P (0.8).
The agent can change the mode at runtime with the window_proactive tool.

The indicator is a StatusNotifierItem in the Plasma panel: cycle the layout,
swap screens, pick the suggestion mode, focus an open window, quit. Turn it
off with --no-tray or SHMAKK_WINDOWS_TRAY=0. --install-autostart writes
~/.config/autostart/shmakk-windows.desktop so it starts with the session.
`;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

async function installKwin() {
  const log = (s) => process.stdout.write(`[shmakk windows] ${s}\n`);
  const listed = await run('kpackagetool6', ['--type=KWin/Script', '--list']);
  const upgrade = listed.ok && listed.out.split('\n').some((l) => l.trim() === PLUGIN_ID);
  let r = await run('kpackagetool6', ['--type=KWin/Script', upgrade ? '--upgrade' : '--install', KWIN_PACKAGE]);
  if (!r.ok) {
    if (r.code === 'ENOENT') log('kpackagetool6 not found. Install it: sudo pacman -S kpackage');
    else log(`kpackagetool6 failed: ${r.err || r.out}`);
    return 1;
  }
  log(`${upgrade ? 'upgraded' : 'installed'} ${PLUGIN_ID}`);
  if (upgrade) {
    // Unload the running copy so the reconfigure below loads the new version.
    await run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting',
      '--method', 'org.kde.kwin.Scripting.unloadScript', W.gstr(PLUGIN_ID)]);
  }
  r = await run('kwriteconfig6', ['--file', 'kwinrc', '--group', 'Plugins', '--key', `${PLUGIN_ID}Enabled`, 'true']);
  if (!r.ok) { log(`kwriteconfig6 failed: ${r.err || r.out}`); return 1; }
  r = await run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/KWin', '--method', 'org.kde.KWin.reconfigure']);
  if (!r.ok) { log(`could not ask KWin to reload (${r.err}); log out and back in instead`); return 1; }
  log('enabled; KWin reloaded its scripts');
  return 0;
}

const AUTOSTART = path.join(process.env.HOME || '', '.config', 'autostart', 'shmakk-windows.desktop');

function autostartEntry() {
  const bin = path.join(__dirname, '..', '..', 'bin', 'shmakk.js');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=shmakk windows',
    'Comment=Record window focus and show the windows indicator',
    `Exec="${process.execPath}" "${bin}" windows-daemon`,
    'Terminal=false',
    'X-KDE-autostart-after=panel',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

async function installAutostart() {
  const dir = path.dirname(AUTOSTART);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTOSTART, autostartEntry());
  } catch (e) {
    process.stderr.write(`[shmakk windows] could not write ${AUTOSTART}: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(`[shmakk windows] wrote ${AUTOSTART}\n`);
  process.stdout.write('[shmakk windows] it starts with the next login; run `shmakk windows-daemon` now to start it here\n');
  return 0;
}

async function trayCheck() {
  let dbus;
  try {
    dbus = require('dbus-next');
  } catch {
    process.stderr.write('[shmakk windows] dbus-next is not installed. Run: npm install dbus-next\n');
    return 1;
  }
  const bus = dbus.sessionBus();
  try {
    let expected = null;
    if (W.isAvailable()) {
      const db = W.getDB();
      if (db) { expected = W.getKv(db, 'trayItem'); W.closeDb(db); }
    }
    for (const line of await T.describeTray(bus, dbus.Message, expected)) process.stdout.write(`${line}\n`);
  } finally {
    bus.disconnect();
  }
  return 0;
}

async function status() {
  const running = await W.daemonRunning();
  process.stdout.write(`daemon:  ${running ? 'running' : 'not running'}\n`);
  if (!W.isAvailable()) {
    process.stdout.write('store:   better-sqlite3 not installed\n');
    return 0;
  }
  const db = W.getDB();
  const open = W.listOpenWindows(db);
  const spans = db.prepare('SELECT COUNT(*) AS n FROM spans').get().n;
  const last = db.prepare("SELECT v FROM kv WHERE k = 'lastEvent'").get();
  process.stdout.write(`store:   ${W.defaultDbPath()}\n`);
  process.stdout.write(`windows: ${open.length} open, ${spans} focus spans recorded\n`);
  process.stdout.write(`last:    ${last && last.v ? new Date(Number(last.v)).toLocaleString() : 'no events yet'}\n`);
  const stored = W.getKv(db, 'proactiveMode');
  const st = P.stats(db, Date.now() - 7 * 24 * 60 * 60 * 1000);
  const parts = Object.entries(st).map(([k, n]) => `${n} ${k}`);
  process.stdout.write(`proactive: ${P.MODES.includes(stored) ? stored : P.defaultOptions().mode} (${parts.length ? parts.join(', ') : 'no suggestions'} in 7 days)\n`);
  const m = P.muted(db);
  if (m.length) process.stdout.write(`muted:   ${m.join('; ')}\n`);
  return 0;
}

async function serve(mode, options = {}) {
  const log = (s) => process.stdout.write(`[shmakk windows] ${s}\n`);
  let dbus;
  try {
    dbus = require('dbus-next');
  } catch {
    process.stderr.write('[shmakk windows] dbus-next is not installed. Run: npm install dbus-next\n');
    return 1;
  }
  if (!W.isAvailable()) {
    process.stderr.write('[shmakk windows] better-sqlite3 is not installed. Run: npm install better-sqlite3\n');
    return 1;
  }
  const db = W.getDB();
  if (!db) {
    process.stderr.write(`[shmakk windows] could not open ${W.defaultDbPath()}\n`);
    return 1;
  }
  W.closeDangling(db);
  W.prune(db);
  if (mode) W.setKv(db, 'proactiveMode', mode);

  const engine = P.createProactive({ db, W, log });
  const reorder = R.createReorder({ db, W, notify: P.notifySend, log, screens: W.Screens });
  let events = 0;
  const { Interface } = dbus.interface;
  class WindowsIface extends Interface {
    Event(json) {
      let ev;
      try { ev = JSON.parse(json); } catch { return; }
      if (ev && ev.kind === 'command') {
        reorder.handle(ev).catch((e) => log(`${ev.command}: ${e.message}`));
        return;
      }
      try {
        if (W.recordEvent(db, ev)) {
          events++;
          engine.onEvent(ev);
          if (tray) tray.refresh();
        }
      } catch (e) {
        if (process.env.SHMAKK_DEBUG) process.stderr.write(`[shmakk windows] ${e.message}\n`);
      }
    }
  }
  WindowsIface.configureMembers({ methods: { Event: { inSignature: 's', outSignature: '' } } });

  const bus = dbus.sessionBus();
  bus.export(W.OBJ_PATH, new WindowsIface(W.IFACE));
  const reply = await bus.requestName(W.BUS_NAME, dbus.NameFlag.DO_NOT_QUEUE);
  if (reply !== dbus.RequestNameReply.PRIMARY_OWNER) {
    process.stderr.write(`[shmakk windows] ${W.BUS_NAME} is already owned; another daemon is running\n`);
    bus.disconnect();
    return 1;
  }
  log(`listening on ${W.BUS_NAME}, store ${W.defaultDbPath()}, proactive ${engine.mode()}`);

  // The panel indicator reads this synchronously on every menu rebuild, so it
  // stays cheap: open windows from the store, screen names from the config.
  const trayState = () => {
    let windows = [];
    try {
      windows = W.listOpenWindows(db).slice(0, 8).map((w) => ({ id: w.id, app: P.prettyApp(w.app) }));
    } catch {}
    let names = [];
    try {
      const cfg = W.Screens.readConfig();
      if (Array.isArray(cfg.order) && cfg.order.length) names = cfg.order;
    } catch {}
    if (!names.length) names = [...new Set(windows.map((w) => w.screen).filter(Boolean))];
    const stored = W.getKv(db, 'proactiveMode');
    return {
      mode: P.MODES.includes(stored) ? stored : engine.mode(),
      windows,
      screens: names.map((name) => ({ name, enabled: true })),
      muted: P.muted(db),
      daemon: true,
    };
  };

  const wantTray = options.tray !== false && process.env.SHMAKK_WINDOWS_TRAY !== '0';
  let tray = null;
  if (wantTray) {
    try {
      tray = await T.startTray({
        bus, dbus, db, W, P, reorder,
        getState: trayState,
        log,
        onQuit: () => shutdown('tray'),
      });
    } catch (e) {
      log(`tray: could not start (${e.message})`);
      tray = null;
    }
    if (tray) W.setKv(db, 'trayItem', tray.name);
  }

  try {
    await W.requestSnapshot();
  } catch (e) {
    log(`snapshot request failed (${e.message}); waiting for watcher events`);
  }
  setTimeout(() => {
    if (!events) log('no events yet. Is the watcher installed? Run: shmakk windows-daemon --install-kwin');
  }, 5000).unref();

  const pruneTimer = setInterval(() => { try { W.prune(db); } catch {} }, 6 * 60 * 60 * 1000);
  pruneTimer.unref();

  const shutdown = (why) => {
    log(why ? `shutting down (${why})` : 'shutting down');
    if (tray) {
      tray.stop();
      try { W.setKv(db, 'trayItem', ''); } catch {}
    }
    engine.stop();
    reorder.stop();
    try { W.closeDangling(db); } catch {}
    W.closeDb(db);
    bus.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return new Promise(() => {});
}

async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((a) => a !== 'windows-daemon');
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return 0; }
  if (args.includes('--install-kwin')) return installKwin();
  if (args.includes('--status')) return status();
  if (args.includes('--tray-check')) return trayCheck();
  if (args.includes('--install-autostart')) return installAutostart();
  const tray = !args.includes('--no-tray');
  const noTray = args.indexOf('--no-tray');
  if (noTray >= 0) args.splice(noTray, 1);
  for (const cmd of W.COMMANDS) {
    if (!args.includes(`--${cmd}`)) continue;
    if (cmd === 'reorder' && !(await W.daemonRunning())) {
      process.stderr.write('[shmakk windows] reorder needs the daemon running: shmakk windows-daemon\n');
      return 1;
    }
    try {
      const r = await W.runCommand(cmd, { keepAlive: true });
      await r.done;
      return 0;
    } catch (e) {
      process.stderr.write(`[shmakk windows] ${cmd} failed: ${e.message}\n`);
      return 1;
    }
  }
  let mode = null;
  const pi = args.indexOf('--proactive');
  if (pi >= 0) {
    mode = args[pi + 1];
    if (!P.MODES.includes(mode)) {
      process.stderr.write(`[shmakk windows] --proactive takes ${P.MODES.join(' | ')}\n`);
      return 2;
    }
    args.splice(pi, 2);
  }
  const unknown = args.find((a) => a.startsWith('-'));
  if (unknown) {
    process.stderr.write(`[shmakk windows] unknown option: ${unknown}\n${HELP}`);
    return 2;
  }
  return serve(mode, { tray });
}

if (require.main === module) {
  main().then((code) => { if (code) process.exit(code); }).catch((err) => {
    process.stderr.write(`[shmakk windows] fatal: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { main, HELP, KWIN_PACKAGE };
