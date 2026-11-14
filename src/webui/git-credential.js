#!/usr/bin/env node
// Git credential helper for repositories cloned through the web UI.
//
// Clones get `credential.helper` pointed at this script, so `git push` /
// `git fetch` inside a cloud session authenticate with the connected GitHub
// account — without the token ever being written into .git/config, a remote
// URL, or the agent's environment.

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.argv[2] !== 'get') process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  // Only ever answer for the configured GitHub host.
  let want = 'github.com';
  try { want = new URL(process.env.SHMAKK_GITHUB_URL || 'https://github.com').host; } catch { /* default */ }
  const host = (/^host=(.+)$/m.exec(input) || [])[1];
  if (host !== want) return;
  let token = process.env.SHMAKK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) {
    try {
      const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      token = JSON.parse(fs.readFileSync(path.join(base, 'shmakk', 'web.json'), 'utf8')).github?.token || '';
    } catch { /* not connected */ }
  }
  if (token) process.stdout.write(`username=x-access-token\npassword=${token}\n`);
});
