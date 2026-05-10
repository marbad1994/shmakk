// History parser — reads bash, zsh, fish history files and builds a
// frequency map of command usage for tie-breaking in corrections.
//
// Frequency map format:
//   { "git": 4521, "ls": 10982, "npm": 893, "cat": 542, ... }
//
// Stored at: .shmakk/state/command-freq.json
//
// The user controls what goes in — no auto-learning from corrections.

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.cwd(), '.shmakk', 'state');
const FREQ_FILE = path.join(STATE_DIR, 'command-freq.json');

// ── Parsers per shell format ──────────────────────────────────────────────

// Bash: one command per line, no timestamps.
function parseBashHistory(content) {
  const freq = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cmd = trimmed.split(/\s+/)[0];
    if (cmd) freq[cmd] = (freq[cmd] || 0) + 1;
  }
  return freq;
}

// Zsh: : <timestamp>:<duration>;<command>
// Example: : 1776037585:0;ll
function parseZshHistory(content) {
  const freq = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: : ts:duration;command
    const semi = trimmed.indexOf(';');
    if (trimmed.startsWith(':') && semi !== -1) {
      const cmd = trimmed.slice(semi + 1).trim().split(/\s+/)[0];
      if (cmd) freq[cmd] = (freq[cmd] || 0) + 1;
    } else {
      // Fallback: treat as bare command
      const cmd = trimmed.split(/\s+/)[0];
      if (cmd) freq[cmd] = (freq[cmd] || 0) + 1;
    }
  }
  return freq;
}

// Fish: YAML-like format
// - cmd: <command>
//   when: <timestamp>
function parseFishHistory(content) {
  const freq = {};
  let inEntry = false;
  let lastCmd = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- cmd:')) {
      // flush previous
      if (lastCmd) freq[lastCmd] = (freq[lastCmd] || 0) + 1;
      lastCmd = trimmed.slice(6).trim();
      inEntry = true;
    } else if (inEntry && trimmed.startsWith('when:')) {
      // end of entry — next line will start a new one or EOF
      inEntry = false;
    } else if (!trimmed) {
      inEntry = false;
    }
  }
  // Flush last entry
  if (lastCmd) freq[lastCmd] = (freq[lastCmd] || 0) + 1;
  return freq;
}

// Detect format and parse a single history file.
// Returns a frequency map for that file.
function parseHistoryFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    process.stderr.write(`[shmakk] warning: cannot read ${filePath}: ${e.message}\n`);
    return {};
  }
  if (!content.trim()) return {};

  const name = path.basename(filePath);

  // Fish history: YAML-like with "- cmd:" entries
  if (name === 'fish_history' || content.includes('- cmd:')) {
    return parseFishHistory(content);
  }

  // Zsh history: lines start with ": <timestamp>:"
  if (content.match(/^:\s+\d+:\d+;/m)) {
    return parseZshHistory(content);
  }

  // Bash history: one command per line (default fallback)
  return parseBashHistory(content);
}

// Auto-detect common history files on this system.
function autoDetectHistoryFiles() {
  const home = process.env.HOME || '/home/' + (process.env.USER || 'unknown');
  const candidates = [
    path.join(home, '.bash_history'),
    path.join(home, '.zsh_history'),
    path.join(home, '.local/share/fish/fish_history'),
    path.join(home, '.config/fish/fish_history'),
  ];
  return candidates.filter((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}

// Parse one or more history files and merge into a single frequency map.
function buildFreqMap(filePaths) {
  const merged = {};
  for (const fp of filePaths) {
    const freq = parseHistoryFile(fp);
    for (const [cmd, count] of Object.entries(freq)) {
      merged[cmd] = (merged[cmd] || 0) + count;
    }
  }
  return merged;
}

// ── Load / save the frequency map ─────────────────────────────────────────

function freqMapPath(baseDir) {
  return path.join(baseDir || process.cwd(), '.shmakk', 'state', 'command-freq.json');
}

function loadFreqMap(baseDir) {
  const fp = freqMapPath(baseDir);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveFreqMap(freqMap, baseDir) {
  const dir = path.join(baseDir || process.cwd(), '.shmakk', 'state');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const fp = path.join(dir, 'command-freq.json');
  fs.writeFileSync(fp, JSON.stringify(freqMap, null, 2) + '\n');
  return fp;
}

module.exports = {
  parseBashHistory,
  parseZshHistory,
  parseFishHistory,
  parseHistoryFile,
  autoDetectHistoryFiles,
  buildFreqMap,
  loadFreqMap,
  saveFreqMap,
};
