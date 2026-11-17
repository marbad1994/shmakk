// PTY terminals for the web UI. Each terminal is either the full shmakk CLI
// (the real thing, running inside a PTY — complete CLI parity by definition)
// or a plain login shell.

const path = require('path');

let pty = null;
let ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = e; }

function isAvailable() { return !!pty; }
function unavailableReason() { return ptyError ? String(ptyError.message || ptyError).split('\n')[0] : null; }

// Translate the web UI's settings into CLI flags so the embedded shmakk
// behaves the same as the chat does.
function cliFlags(settings, workspace) {
  const flags = [];
  if (settings.review) flags.push('--review');
  if (settings.yesFiles) flags.push('--yes-files');
  if (settings.noCorrection) flags.push('--no-correction');
  if (settings.noAi) flags.push('--no-ai');
  if (settings.debug) flags.push('--debug');
  if (settings.profile) flags.push('--profile', settings.profile);
  if (workspace) flags.push('--workspace', workspace);
  return flags;
}

class TerminalHub {
  constructor() {
    this.terms = new Map(); // id → { proc, owner }
  }

  open({ id, kind = 'shmakk', cols = 100, rows = 28, cwd, settings = {}, owner, onData, onExit }) {
    if (!pty) throw new Error(`terminal unavailable: ${unavailableReason() || 'node-pty not installed'}`);
    if (this.terms.has(id)) this.close(id);

    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete env.SHMAKK_PID; // never let a nested CLI signal the web server
    let file;
    let args;
    if (kind === 'shell') {
      file = process.env.SHELL || '/bin/bash';
      args = ['-l'];
    } else {
      // Works under Electron too: run its binary in plain-Node mode.
      file = process.execPath;
      args = [path.join(__dirname, '..', '..', 'bin', 'shmakk.js'), ...cliFlags(settings, cwd)];
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    }

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols | 0),
      rows: Math.max(5, rows | 0),
      cwd,
      env,
    });
    proc.onData((d) => onData(d));
    proc.onExit(({ exitCode }) => {
      if (this.terms.get(id)?.proc === proc) this.terms.delete(id);
      onExit(exitCode ?? 0);
    });
    this.terms.set(id, { proc, owner });
    return true;
  }

  input(id, data) {
    const t = this.terms.get(id);
    if (t) { try { t.proc.write(data); } catch {} }
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t) { try { t.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch {} }
  }

  close(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    try { t.proc.kill(); } catch {}
  }

  closeOwnedBy(owner) {
    for (const [id, t] of Array.from(this.terms)) if (t.owner === owner) this.close(id);
  }

  closeAll() {
    for (const id of Array.from(this.terms.keys())) this.close(id);
  }
}

module.exports = { TerminalHub, isAvailable, unavailableReason, cliFlags };
