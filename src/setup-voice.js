#!/usr/bin/env node
// shmakk voice setup — checks all dependencies for --stt / --tts / --sts
// Run via: npm run setup:voice  or  node src/setup-voice.js

const { execSync } = require('child_process');

const ok    = (s) => process.stdout.write(`  \x1b[32m✓\x1b[0m ${s}\n`);
const warn  = (s) => process.stdout.write(`  \x1b[33m⚠\x1b[0m ${s}\n`);
const fail  = (s) => process.stdout.write(`  \x1b[31m✗\x1b[0m ${s}\n`);
const title = (s) => process.stdout.write(`\n\x1b[1m${s}\x1b[0m\n`);

let allGood = true;

function cmd(c) {
  try {
    return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { return null; }
}

title('shmakk voice setup check');

// ── Node deps ────────────────────────────────────────────────────────────────
title('Node.js optional dependencies');

for (const dep of ['@huggingface/transformers', 'kokoro-js', 'wavefile']) {
  try {
    require.resolve(dep);
    ok(dep);
  } catch {
    fail(`${dep} — not installed`);
    allGood = false;
  }
}

// ── System audio recorder ────────────────────────────────────────────────────
title('Audio recorder (microphone input)');

const recorders = ['rec', 'sox', 'ffmpeg', 'arecord'];
let recorderFound = false;
for (const r of recorders) {
  if (cmd(`which ${r}`)) {
    ok(`${r} found`);
    recorderFound = true;
    break;
  }
}
if (!recorderFound) {
  fail('No audio recorder found');
  warn('Install sox:  sudo pacman -S sox        (Arch/EndeavourOS)');
  warn('              sudo apt install sox       (Debian/Ubuntu)');
  warn('              brew install sox           (macOS)');
  allGood = false;
}

// ── System audio player ──────────────────────────────────────────────────────
title('Audio player (TTS playback)');

const players = ['paplay', 'aplay', 'afplay'];
let playerFound = false;
for (const p of players) {
  if (cmd(`which ${p}`)) {
    ok(`${p} found`);
    playerFound = true;
    break;
  }
}
if (!playerFound) {
  fail('No audio player found');
  warn('Install:  sudo pacman -S libpulse        (Arch/EndeavourOS)');
  allGood = false;
}

// ── Audio server ─────────────────────────────────────────────────────────────
title('Audio server');

const paInfo = cmd('pactl info');
if (paInfo) {
  const server = paInfo.match(/Server Name:\s*(.+)/)?.[1] || 'unknown';
  ok(`Running: ${server}`);
} else {
  fail('PulseAudio/PipeWire not running');
  warn('Start:  systemctl --user start pipewire-pulse');
  allGood = false;
}

// ── Microphone ───────────────────────────────────────────────────────────────
title('Microphone sources');

const sources = cmd('pactl list sources short');
if (sources) {
  sources.split('\n').filter(Boolean).forEach(s => {
    ok(s.trim().split('\t')[1] || s.trim());
  });
} else {
  warn('Could not list audio sources');
}

// ── Summary ──────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (allGood) {
  process.stdout.write('\x1b[32m\x1b[1m✓ All good! Try: shmakk --sts\x1b[0m\n\n');
} else {
  process.stdout.write('\x1b[33m\x1b[1m⚠ Issues found above. Fix them then re-run: npm run setup:voice\x1b[0m\n\n');
  process.stdout.write('Quick fix (Arch/EndeavourOS):\n');
  process.stdout.write('  sudo pacman -S sox\n');
  process.stdout.write('  npm install --include=optional\n\n');
  process.exit(1);
}
