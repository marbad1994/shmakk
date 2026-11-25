// `shmakk --desktop` — start the Electron shell that lives in ../../desktop.
// Electron is deliberately not a dependency of the CLI package (it is a
// ~100 MB download); it is installed on demand inside desktop/.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DESKTOP_DIR = path.join(__dirname, '..', '..', 'desktop');

function findElectron() {
  if (process.env.SHMAKK_ELECTRON && fs.existsSync(process.env.SHMAKK_ELECTRON)) return process.env.SHMAKK_ELECTRON;
  const candidates = [
    path.join(DESKTOP_DIR, 'node_modules', 'electron'),
    path.join(__dirname, '..', '..', 'node_modules', 'electron'),
  ];
  for (const dir of candidates) {
    try {
      // The electron package's main export is the path to its binary.
      const bin = require(dir);
      if (typeof bin === 'string' && fs.existsSync(bin)) return bin;
    } catch {}
  }
  try {
    const bin = require('electron');
    if (typeof bin === 'string' && fs.existsSync(bin)) return bin;
  } catch {}
  return null;
}

function launchDesktop(opts = {}) {
  const electron = findElectron();
  if (!electron) {
    process.stderr.write([
      '[shmakk] the desktop app needs Electron, which is not installed yet.',
      '',
      '  One-time setup:',
      `    cd ${DESKTOP_DIR}`,
      '    npm install',
      '',
      '  Then run `shmakk --desktop` again — or use `shmakk --web` for the same',
      '  interface in your browser.',
      '',
    ].join('\n'));
    return Promise.resolve(1);
  }
  const args = [DESKTOP_DIR];
  if (opts.workspace) args.push('--workspace', path.resolve(opts.workspace));
  if (opts.review) args.push('--review');
  if (opts.yesFiles) args.push('--yes-files');
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.debug) args.push('--debug');
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, args, { stdio: 'inherit', env });
    child.on('error', (e) => { process.stderr.write(`[shmakk] failed to start Electron: ${e.message}\n`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

module.exports = { launchDesktop, findElectron, DESKTOP_DIR };
