const pty = require('node-pty');
const { EventEmitter } = require('events');
const { detectShell } = require('./shell');
const { configureForShell } = require('./hooks');
const { createMarkerStream, createStdinFilter } = require('./markers');

function getSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

const VOICE_HOTKEY = 0x0f; // Ctrl+O — triggers voice recording

function startSession({ debug = false, voiceEnabled = false } = {}) {
  const shell = detectShell();
  const cfg = configureForShell(shell.name);
  const { cols, rows } = getSize();

  if (debug) {
    process.stderr.write(`[shmakk] shell=${shell.path} args=${cfg.args.join(' ')}\n`);
  }

  const child = pty.spawn(shell.path, cfg.args, {
    name: process.env.TERM || 'xterm-256color',
    cols, rows,
    cwd: process.cwd(),
    // SHMAKK_PID lets `shmakk --status/--exit/--restart` find us from
    // inside the inner shell.
    env: { ...process.env, SHMAKK: '1', SHMAKK_PID: String(process.pid), ...cfg.env },
  });

  const ev = new EventEmitter();
  // Stack of stdin handlers: top of stack receives data. Null at bottom
  // means "relay to child PTY".
  const stdinStack = [];
  const topHandler = () => stdinStack.length ? stdinStack[stdinStack.length - 1] : null;

  const feed = createMarkerStream((type, data) => ev.emit(type, data));
  const filterStdin = createStdinFilter();

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const onStdin = (data) => {
    const h = topHandler();
    if (h) return h(data);

    // Voice hotkey detection — only when voice is enabled
    if (voiceEnabled) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 1 && buf[0] === VOICE_HOTKEY) {
        ev.emit('voice');
        return;
      }
    }

    const cleaned = filterStdin(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (cleaned.length) child.write(cleaned);
  };
  const onPty = (data) => {
    const cleaned = feed(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (cleaned.length) ev.emit('output', cleaned);
  };
  const onResize = () => {
    const s = getSize();
    try { child.resize(s.cols, s.rows); } catch {}
  };

  stdin.on('data', onStdin);
  child.onData(onPty);
  process.stdout.on('resize', onResize);

  const exitPromise = new Promise((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      stdin.removeListener('data', onStdin);
      process.stdout.removeListener('resize', onResize);
      if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
      stdin.pause();
      cfg.cleanup();
      resolve({ exitCode: exitCode ?? 0, signal });
    });
  });

  return {
    ev,
    stdoutWrite: (s) => stdout.write(s),
    childWrite: (s) => child.write(s),
    // Push a handler; returns a release fn that pops it. Stacked so nested
    // captures (e.g. ask() inside an AI tap) don't wipe the outer handler.
    captureStdin(handler) {
      stdinStack.push(handler);
      return () => {
        const i = stdinStack.lastIndexOf(handler);
        if (i !== -1) stdinStack.splice(i, 1);
      };
    },
    waitExit: () => exitPromise,
    kill: () => { try { child.kill(); } catch {} },
  };
}

module.exports = { startSession };
