// SSH remote execution and file transfer for shmakk.
//
// Hosts are defined in .shmakk/hosts.json (project-local) or
// ~/.config/shmakk/hosts.json (global). If a host config has
// allow_ssh_config: true, ~/.ssh/config Host entries are also
// available as targets.
//
// Schema (hosts.json):
//   {
//     "hosts": {
//       "devbox": {
//         "host": "user@192.168.1.100",
//         "port": 22,
//         "auto_approve": false,
//         "timeout_sec": 30
//       }
//     },
//     "allow_ssh_config": false,
//     "default_timeout_sec": 30
//   }

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ── Config loading ─────────────────────────────────────────────────────

function loadHostConfig(workspaceRoot) {
  const candidates = [];
  // Project-local config
  if (workspaceRoot) {
    candidates.push(path.join(workspaceRoot, '.shmakk', 'hosts.json'));
  }
  // Global config
  candidates.push(path.join(os.homedir(), '.config', 'shmakk', 'hosts.json'));

  let merged = { hosts: {}, allow_ssh_config: false, default_timeout_sec: 30 };

  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.hosts && typeof cfg.hosts === 'object') {
        Object.assign(merged.hosts, cfg.hosts);
      }
      if (typeof cfg.allow_ssh_config === 'boolean') {
        merged.allow_ssh_config = merged.allow_ssh_config || cfg.allow_ssh_config;
      }
      if (typeof cfg.default_timeout_sec === 'number') {
        merged.default_timeout_sec = cfg.default_timeout_sec;
      }
    } catch {
      // Missing or malformed — skip
    }
  }

  // Optionally import ~/.ssh/config hosts
  if (merged.allow_ssh_config) {
    const sshConfigHosts = parseSSHConfig();
    for (const [name, entry] of Object.entries(sshConfigHosts)) {
      if (!merged.hosts[name]) {
        merged.hosts[name] = entry;
      }
    }
  }

  return merged;
}

function parseSSHConfig() {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  const hosts = {};
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentHost = null;
    let currentEntry = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const m = line.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;

      const key = m[1].toLowerCase();
      const value = m[2].trim();

      if (key === 'host') {
        // Save previous entry
        if (currentHost && currentEntry) {
          currentEntry._aliases = currentHost.split(/\s+/);
          for (const alias of currentEntry._aliases) {
            if (alias !== '*') hosts[alias] = currentEntry;
          }
        }
        currentHost = value;
        currentEntry = { host: null, port: 22, auto_approve: false, _from_ssh_config: true };
      } else if (currentEntry) {
        if (key === 'hostname') currentEntry.host = value;
        else if (key === 'port') currentEntry.port = parseInt(value, 10) || 22;
        else if (key === 'user') {
          // Merge user into the host string
          const h = currentEntry.host || value;
          currentEntry.host = `${value}@${h.replace(/^[^@]+@/, '')}`;
        }
      }
    }
    // Save last entry
    if (currentHost && currentEntry) {
      currentEntry._aliases = currentHost.split(/\s+/);
      for (const alias of currentEntry._aliases) {
        if (alias !== '*') hosts[alias] = currentEntry;
      }
    }
  } catch {
    // No config or unreadable
  }
  return hosts;
}

// ── Config writing (used by the GUI) ────────────────────────────────────
//
// The GUI edits the same files the CLI reads: <workspace>/.shmakk/hosts.json
// and ~/.config/shmakk/hosts.json. Edits are targeted (one host at a time) so
// unknown keys written by hand survive.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// user@host, IPv4/IPv6 literals and DNS names. No shell metacharacters and no
// leading dash, so the value cannot be read as an ssh option.
const HOST_RE = /^[A-Za-z0-9._][A-Za-z0-9._@:-]*$/;

function configFiles(workspaceRoot) {
  return {
    workspace: workspaceRoot ? path.join(workspaceRoot, '.shmakk', 'hosts.json') : null,
    global: path.join(os.homedir(), '.config', 'shmakk', 'hosts.json'),
  };
}

function readHostFile(file, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { hosts: {} }; }
  try {
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      if (!cfg.hosts || typeof cfg.hosts !== 'object') cfg.hosts = {};
      return cfg;
    }
  } catch {
    // fall through to the strict check below
  }
  if (opts.strict) throw new Error(`${file} is not valid hosts.json; fix it by hand first`);
  return { hosts: {} };
}

function writeHostFile(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function configFileFor(scope, workspaceRoot) {
  const files = configFiles(workspaceRoot);
  const file = scope === 'workspace' ? files.workspace : files.global;
  if (!file) throw new Error('no workspace is open, save to the global config instead');
  return file;
}

function normalizeEntry(entry = {}) {
  const host = String(entry.host || '').trim();
  if (!HOST_RE.test(host)) {
    throw new Error('host must look like user@example.com (letters, digits, dot, dash, underscore, @)');
  }
  const rawPort = entry.port === '' || entry.port == null ? 22 : Number(entry.port);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error('port must be a whole number between 1 and 65535');
  }
  const rawTimeout = entry.timeout_sec === '' || entry.timeout_sec == null ? 30 : Number(entry.timeout_sec);
  if (!Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 3600) {
    throw new Error('timeout must be 1-3600 seconds');
  }
  return { host, port: rawPort, auto_approve: !!entry.auto_approve, timeout_sec: rawTimeout };
}

/** Create or update one host in the given scope. Returns the stored entry. */
function saveHost(scope, workspaceRoot, name, entry) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error('name must be 1-63 characters: letters, digits, dot, dash, underscore');
  }
  const file = configFileFor(scope, workspaceRoot);
  const cfg = readHostFile(file, { strict: true });
  const clean = normalizeEntry(entry);
  cfg.hosts[name] = clean;
  writeHostFile(file, cfg);
  return { name, ...clean, source: scope };
}

/** Delete one host from the given scope. Returns false when it was not there. */
function deleteHost(scope, workspaceRoot, name) {
  const file = configFileFor(scope, workspaceRoot);
  const cfg = readHostFile(file, { strict: true });
  if (!cfg.hosts[name]) return false;
  delete cfg.hosts[name];
  writeHostFile(file, cfg);
  return true;
}

/** Toggle importing ~/.ssh/config Host entries (stored in the global config). */
function setAllowSshConfig(workspaceRoot, enabled) {
  const file = configFileFor('global', workspaceRoot);
  const cfg = readHostFile(file, { strict: true });
  cfg.allow_ssh_config = !!enabled;
  writeHostFile(file, cfg);
  return cfg.allow_ssh_config;
}

/** Try a real connection: returns { ok, latencyMs, output|error }. */
function testHost(entry, signal) {
  let clean;
  try { clean = normalizeEntry(entry); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8'];
  if (clean.port !== 22) args.push('-p', String(clean.port));
  args.push(clean.host, 'echo shmakk-ssh-ok');
  const timeout = Math.min(clean.timeout_sec, 60) * 1000;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = execFile('ssh', args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const latencyMs = Date.now() - started;
      const out = (stdout || '').toString().trim();
      if (err) {
        const msg = (stderr || '').toString().trim() || err.message;
        if (err.killed) resolve({ ok: false, latencyMs, error: `no answer after ${timeout / 1000}s`, stderr: msg });
        else if (err.code === 'ENOENT') resolve({ ok: false, latencyMs, error: 'the ssh client is not installed' });
        else resolve({ ok: false, latencyMs, error: msg, stderr: msg });
        return;
      }
      resolve({ ok: out.includes('shmakk-ssh-ok'), latencyMs, output: out });
    });
    if (signal) {
      const onAbort = () => { try { child.kill('SIGINT'); } catch {} };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function resolveHost(cfg, name) {
  const entry = cfg.hosts[name];
  if (!entry) return null;
  if (!entry.host) return null;
  return entry;
}

// ── SSH command builder ─────────────────────────────────────────────────

function buildSSHArgs(entry, cmd) {
  const args = [];
  if (entry.port && entry.port !== 22) {
    args.push('-p', String(entry.port));
  }
  // Common options for non-interactive remote execution
  args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'ConnectTimeout=10');
  args.push(entry.host);
  args.push(cmd);
  return args;
}

function buildSCPArgs(entry, src, dest, direction) {
  // direction: 'push' → local src → remote dest
  //            'pull' → remote src → local dest
  const args = [];
  if (entry.port && entry.port !== 22) {
    args.push('-P', String(entry.port));
  }
  args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'ConnectTimeout=10');

  if (direction === 'push') {
    args.push(src, `${entry.host}:${dest}`);
  } else {
    args.push(`${entry.host}:${src}`, dest);
  }
  return args;
}

// ── Execution ───────────────────────────────────────────────────────────

function sshRun(entry, cmd, signal) {
  const timeout = (entry.timeout_sec || 30) * 1000;
  const args = buildSSHArgs(entry, cmd);

  return new Promise((resolve) => {
    const child = execFile('ssh', args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString().trim() || err.message;
        // Distinguish known SSH errors
        if (err.killed) {
          resolve({ error: `SSH timed out after ${timeout / 1000}s`, exitCode: null, stderr: msg });
        } else {
          resolve({
            error: `SSH failed (exit ${err.code}): ${msg}`,
            exitCode: err.code,
            stderr: msg,
            stdout: (stdout || '').toString().trim(),
          });
        }
        return;
      }
      resolve({
        ok: true,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
      });
    });

    if (signal) {
      const onAbort = () => { try { child.kill('SIGINT'); } catch {} };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function sshTransfer(entry, src, dest, direction, signal) {
  const timeout = (entry.timeout_sec || 60) * 1000;
  const args = buildSCPArgs(entry, src, dest, direction);

  return new Promise((resolve) => {
    const child = execFile('scp', args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString().trim() || err.message;
        if (err.killed) {
          resolve({ error: `SCP timed out after ${timeout / 1000}s`, stderr: msg });
        } else {
          resolve({
            error: `SCP failed (exit ${err.code}): ${msg}`,
            exitCode: err.code,
            stderr: msg,
          });
        }
        return;
      }
      resolve({ ok: true, stdout: (stdout || '').toString().trim() });
    });

    if (signal) {
      const onAbort = () => { try { child.kill('SIGINT'); } catch {} };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Host listing ────────────────────────────────────────────────────────

function listHosts(cfg) {
  return Object.entries(cfg.hosts).map(([name, entry]) => ({
    name,
    host: entry.host,
    port: entry.port || 22,
    auto_approve: !!entry.auto_approve,
    from_ssh_config: !!entry._from_ssh_config,
  }));
}

module.exports = {
  loadHostConfig,
  parseSSHConfig,
  resolveHost,
  sshRun,
  sshTransfer,
  listHosts,
  configFiles,
  readHostFile,
  saveHost,
  deleteHost,
  setAllowSshConfig,
  testHost,
};
