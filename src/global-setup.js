const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function ensureLine(filePath, line) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {}
  if (content.includes(line)) return false;
  const next = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${next}${line}\n`, 'utf8');
  return true;
}

function main() {
  const home = os.homedir();
  const prefix = run('npm config get prefix') || '/usr/local';
  const npmBin = path.join(prefix, 'bin');
  const shell = process.env.SHELL || '';

  const fishConf = path.join(home, '.config/fish/config.fish');
  const bashrc = path.join(home, '.bashrc');
  const zshrc = path.join(home, '.zshrc');

  const fishLine = `fish_add_path -g ${npmBin}`;
  const shLine = `export PATH="${npmBin}:$PATH"`;

  let changed = false;

  if (shell.includes('fish')) {
    changed = ensureLine(fishConf, fishLine) || changed;
  } else if (shell.includes('zsh')) {
    changed = ensureLine(zshrc, shLine) || changed;
  } else {
    changed = ensureLine(bashrc, shLine) || changed;
  }

  // Also add fish config as many users launch fish from other login shells.
  changed = ensureLine(fishConf, fishLine) || changed;

  console.log('Global PATH setup');
  console.log('-----------------');
  console.log('npm prefix :', prefix);
  console.log('npm bin    :', npmBin);
  console.log('shell      :', shell || '(unknown)');
  if (changed) {
    console.log('\nUpdated shell config. Open a new terminal, then run:');
    console.log('  shmakk --help');
  } else {
    console.log('\nShell config already contains npm global bin path.');
    console.log('Open a new terminal, then run:');
    console.log('  shmakk --help');
  }
}

main();
