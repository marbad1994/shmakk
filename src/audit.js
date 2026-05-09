const fs = require('fs');
const os = require('os');
const path = require('path');

function logPath() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'aiterm', 'audit.log');
}

function append(entry) {
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never let audit failures bubble */ }
}

module.exports = { append, logPath };
