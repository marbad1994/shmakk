// Python TTS/STT server lifecycle manager.
// Starts the server on first use, stops on process exit.
// Communicates via HTTP to tts-server.py.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PID_FILE = path.join(os.tmpdir(), 'shmakk-tts-server.pid');
const PORT_FILE = path.join(os.tmpdir(), 'shmakk-tts-server.port');

let _port = null;
let _proc = null;
let _starting = null;
let _ready = false;

function _findPython() {
  // Prefer python3.11 (where Kokoro packages are installed)
  const candidates = ['python3.11', 'python3'];
  const { execSync } = require('child_process');
  for (const c of candidates) {
    try {
      const out = execSync(`which ${c} 2>/dev/null`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out.trim()) return out.trim();
    } catch {}
  }
  return 'python3';
}

async function _waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`TTS server did not become ready within ${timeoutMs}ms`);
}

async function start() {
  if (_ready) return _port;
  if (_starting) return _starting;

  // If port file already exists from a previous run, check if server is alive
  if (fs.existsSync(PID_FILE) && fs.existsSync(PORT_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    const oldPort = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    try {
      process.kill(oldPid, 0); // signal 0 = check existence
      const resp = await fetch(`http://127.0.0.1:${oldPort}/health`);
      if (resp.ok) {
        _port = oldPort;
        _ready = true;
        return _port;
      }
    } catch {
      // Stale — clean up
      try { fs.unlinkSync(PID_FILE); } catch {}
      try { fs.unlinkSync(PORT_FILE); } catch {}
    }
  }

  _starting = (async () => {
    const python = _findPython();
    const serverScript = path.join(__dirname, 'tts-server.py');

    // Clean stale files
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(PORT_FILE); } catch {}

    _proc = spawn(python, [
      serverScript,
      '--host', '127.0.0.1',
      '--port', '0', // random port
      '--pid-file', PID_FILE,
      '--port-file', PORT_FILE,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'], // stderr for logging
      detached: false,
    });

    _proc.stderr.on('data', (d) => {
      // Uncomment to debug: process.stderr.write(`[tts-server] ${d}`);
    });

    _proc.on('exit', (code) => {
      _ready = false;
      _proc = null;
      _port = null;
      _starting = null;
    });

    // Wait for port file to appear
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(PORT_FILE)) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!fs.existsSync(PORT_FILE)) {
      throw new Error('TTS server did not write port file');
    }

    const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    await _waitForPort(port);
    _port = port;
    _ready = true;
    _starting = null;
    return port;
  })();

  return _starting;
}

function stop() {
  if (_proc) {
    try { _proc.kill('SIGTERM'); } catch {}
    _proc = null;
  }
  _ready = false;
  _port = null;
  _starting = null;
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(PORT_FILE); } catch {}
}

// Ensure cleanup on exit
process.on('exit', () => stop());
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });

async function getPort() {
  if (_ready) return _port;
  return start();
}

function isRunning() {
  return _ready;
}

module.exports = { start, stop, getPort, isRunning };
