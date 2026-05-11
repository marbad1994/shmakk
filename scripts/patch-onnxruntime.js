#!/usr/bin/env node
/**
 * Patches the kokoro-js nested onnxruntime-node so its SONAME doesn't conflict
 * with the project-level onnxruntime-node (@huggingface/transformers).
 *
 * Problem:
 *   - @huggingface/transformers → onnxruntime-node 1.24.3 (napi-v6)
 *   - kokoro-js → @huggingface/transformers 3.x → onnxruntime-node 1.21.0 (napi-v3)
 *   - Both ship libonnxruntime.so.1 with the same SONAME
 *   - Whichever loads first "wins"; the second fails with symbol version errors
 *
 * Fix:
 *   - Rename SONAME of the napi-v3 lib to libkokoro_ort.so.1
 *   - Update the napi-v3 binding.node's NEEDED reference accordingly
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KOKORO_ORT_DIR = path.join(
  __dirname, '..', 'node_modules', 'kokoro-js', 'node_modules',
  'onnxruntime-node', 'bin', 'napi-v3', 'linux', 'x64'
);

const ORIG_SO = 'libonnxruntime.so.1';
const NEW_SO = 'libkokoro_ort.so.1';

function patchelf(...args) {
  return execSync(`patchelf ${args.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' });
}

function main() {
  // Check if patchelf is available
  try {
    execSync('which patchelf', { stdio: 'ignore' });
  } catch {
    console.error('[shmakk] patchelf not found. Install it for voice+TTS coexistence.');
    console.error('  pacman -S patchelf   # Arch');
    console.error('  apt install patchelf # Debian/Ubuntu');
    console.error('  brew install patchelf # macOS');
    process.exit(0);
  }

  if (!fs.existsSync(KOKORO_ORT_DIR)) {
    // kokoro-js or its onnxruntime-node not installed — nothing to patch
    return;
  }

  const soPath = path.join(KOKORO_ORT_DIR, ORIG_SO);
  const newSoPath = path.join(KOKORO_ORT_DIR, NEW_SO);
  const bindingPath = path.join(KOKORO_ORT_DIR, 'onnxruntime_binding.node');

  // Already patched?
  if (fs.existsSync(newSoPath)) {
    // Verify it was done correctly
    const soname = execSync(`patchelf --print-soname "${newSoPath}"`, { encoding: 'utf8' }).trim();
    if (soname === NEW_SO) {
      return; // Already patched, nothing to do
    }
    // Otherwise, re-apply from scratch
    fs.unlinkSync(newSoPath);
  }

  if (!fs.existsSync(soPath)) {
    console.error('[shmakk] Expected onnxruntime library not found:', soPath);
    process.exit(1);
  }

  // 1. Change SONAME of the .so file
  patchelf('--set-soname', NEW_SO, soPath);

  // 2. Rename the file
  fs.renameSync(soPath, newSoPath);

  // 3. Update the binding.node's NEEDED reference
  patchelf('--replace-needed', ORIG_SO, NEW_SO, bindingPath);

  console.log('[shmakk] Patched kokoro-js onnxruntime SONAME →', NEW_SO);
}

main();
