// Static, no-execution command glossary.
//
// We never run binaries to extract help. Instead we:
//   1. List executables on PATH (just names + paths).
//   2. Parse fish completion files: `complete -c CMD -s X -l LONG -a '...'`
//   3. Parse bash-completion files for `--long-flag` tokens (best-effort).
//
// This is intentionally less rich than running `--help`, but it is safe:
// no programs are launched, no TTY/X/Wayland/dbus interaction occurs, and
// nothing on the user's system can be modified by the scan.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HELP_KEEP_BYTES = 4 * 1024;

function defaultGlossaryPath() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'shmakk', 'command-glossary.json');
}

// ── PATH enumeration ───────────────────────────────────────────────────────

function listPathBinaries() {
  const seen = new Map();
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        if (!(st.mode & 0o111)) continue;
      } catch { continue; }
      if (!seen.has(e.name)) seen.set(e.name, []);
      const list = seen.get(e.name);
      if (!list.includes(full)) list.push(full);
    }
  }
  return seen;
}

// ── fish completions ───────────────────────────────────────────────────────
//
// Lines look like:
//   complete -c git -n '__fish_git_using_command status' -l short -d 'short fmt'
//   complete -c git -a 'add commit push' -d 'commands'
//   complete -c npm -s g -l global

function fishCompletionDirs() {
  const dirs = [];
  const home = os.homedir();
  if (process.env.XDG_DATA_HOME) {
    dirs.push(path.join(process.env.XDG_DATA_HOME, 'fish', 'vendor_completions.d'));
  }
  dirs.push(
    path.join(home, '.config', 'fish', 'completions'),
    path.join(home, '.local', 'share', 'fish', 'vendor_completions.d'),
    '/usr/share/fish/completions',
    '/usr/share/fish/vendor_completions.d',
    '/usr/local/share/fish/completions',
    '/usr/local/share/fish/vendor_completions.d',
  );
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

const FISH_COMPLETE = /^\s*complete\b(.*)$/;
// extract value of -c / -s / -l / -a / -d, supporting both quoted and bare
function parseCompleteArgs(line) {
  const out = { c: null, s: [], l: [], a: [] };
  // Tokenize respecting single/double quotes. Simple split is unsafe.
  const toks = tokenize(line);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-c' || t === '--command') out.c = toks[++i];
    else if (t === '-s' || t === '--short-option') out.s.push(toks[++i]);
    else if (t === '-l' || t === '--long-option') out.l.push(toks[++i]);
    else if (t === '-o' || t === '--old-option') out.l.push(toks[++i]);
    else if (t === '-a' || t === '--arguments') out.a.push(toks[++i]);
  }
  return out;
}

function tokenize(s) {
  const out = [];
  let i = 0; const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      let v = '';
      while (i < n && s[i] !== q) { v += s[i++]; }
      i++; // closing
      out.push(v);
    } else {
      let v = '';
      while (i < n && !/\s/.test(s[i])) { v += s[i++]; }
      out.push(v);
    }
  }
  return out;
}

function parseFishCompletions(commands) {
  for (const dir of fishCompletionDirs()) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.fish')) continue;
      const cmdName = f.replace(/\.fish$/, '');
      const entry = ensureEntry(commands, cmdName);
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const rawLine of text.split('\n')) {
        const m = FISH_COMPLETE.exec(rawLine);
        if (!m) continue;
        const args = parseCompleteArgs(m[1]);
        const target = args.c || cmdName;
        const e = ensureEntry(commands, target);
        for (const sh of args.s) if (sh) e.flags.add('-' + sh);
        for (const lo of args.l) if (lo) e.flags.add('--' + lo);
        for (const a of args.a) {
          for (const sub of String(a).split(/\s+/)) {
            if (sub && /^[a-z][a-z0-9_-]{0,30}$/i.test(sub)) e.subcommands.add(sub);
          }
        }
        e.sources.add('fish:' + path.basename(dir));
        if (entry !== e) entry.aliasOf = target;
      }
    }
  }
}

// ── bash completions ───────────────────────────────────────────────────────
// Best-effort: extract long flags that appear after the command's COMPREPLY
// generation. We just regex `--[a-z][\w-]*` from the file.

function bashCompletionDirs() {
  return [
    '/usr/share/bash-completion/completions',
    '/usr/local/share/bash-completion/completions',
    '/etc/bash_completion.d',
  ].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

const FLAG_RE = /(--[a-zA-Z][\w-]*)/g;

function parseBashCompletions(commands) {
  for (const dir of bashCompletionDirs()) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const cmdName = f; // bash-completion files are typically named after the command
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const e = ensureEntry(commands, cmdName);
      let m; let count = 0;
      while ((m = FLAG_RE.exec(text)) !== null) {
        e.flags.add(m[1]);
        if (++count > 200) break;
      }
      if (count) e.sources.add('bash:' + path.basename(dir));
    }
  }
}

// ── shape & write ──────────────────────────────────────────────────────────

function ensureEntry(commands, name) {
  if (!commands[name]) {
    commands[name] = {
      paths: [],
      flags: new Set(),
      subcommands: new Set(),
      sources: new Set(),
    };
  }
  return commands[name];
}

function freezeEntry(e) {
  return {
    paths: e.paths,
    flags: Array.from(e.flags).sort().slice(0, 200),
    subcommands: Array.from(e.subcommands).sort().slice(0, 100),
    sources: Array.from(e.sources).sort(),
  };
}

async function buildGlossary({ onProgress } = {}) {
  const bins = listPathBinaries();
  const commands = {};

  let i = 0; const total = bins.size;
  for (const [name, paths] of bins) {
    const e = ensureEntry(commands, name);
    e.paths = paths;
    if (onProgress && ++i % 200 === 0) onProgress(i, total);
  }

  parseFishCompletions(commands);
  parseBashCompletions(commands);

  const out = {};
  for (const [name, e] of Object.entries(commands)) out[name] = freezeEntry(e);
  return { generatedAt: new Date().toISOString(), commands: out };
}

async function updateGlossary() {
  const out = defaultGlossaryPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  process.stderr.write('[shmakk] scanning PATH and completion files (no programs are executed)...\n');
  const data = await buildGlossary({
    onProgress: (d, t) => process.stderr.write(`[shmakk] ${d}/${t} binaries\r`),
  });
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  const n = Object.keys(data.commands).length;
  const withFlags = Object.values(data.commands).filter((e) => e.flags.length).length;
  process.stderr.write(`\n[shmakk] wrote ${n} commands (${withFlags} with completion data) → ${out}\n`);
  return out;
}

function loadGlossary() {
  try {
    const txt = fs.readFileSync(defaultGlossaryPath(), 'utf8');
    return JSON.parse(txt);
  } catch { return null; }
}

module.exports = { updateGlossary, loadGlossary, defaultGlossaryPath, buildGlossary };
