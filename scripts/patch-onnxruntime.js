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
 *
 * This script must be idempotent AND resilient to npm re-extracting the
 * package (which restores the original binding.node and libonnxruntime.so.1
 * while leaving any previously-renamed lib behind).
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
const BINDING = 'onnxruntime_binding.node';

function patchelf(...args) {
  return execSync(`patchelf ${args.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' });
}

function getNeeded(bindingPath) {
  try {
    return patchelf('--print-needed', bindingPath).split('\n').map((s) => s.trim());
  } catch {
    return [];
  }
}

function getSoname(soPath) {
  try {
    return patchelf('--print-soname', soPath).trim();
  } catch {
    return null;
  }
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
  const bindingPath = path.join(KOKORO_ORT_DIR, BINDING);

  const bindingPatched = getNeeded(bindingPath).includes(NEW_SO);
  const libOk = fs.existsSync(newSoPath) && getSoname(newSoPath) === NEW_SO;

  // Fully patched and consistent? Nothing to do.
  if (bindingPatched && libOk) {
    return;
  }

  // Ensure the renamed library exists with the correct SONAME.
  // Prefer patching a freshly-extracted original if present; otherwise fix
  // (or re-create from scratch) the renamed copy.
  if (fs.existsSync(soPath)) {
    // Drop any stale renamed copy so rename() can't leave mismatched files.
    if (fs.existsSync(newSoPath)) {
      fs.unlinkSync(newSoPath);
    }
    patchelf('--set-soname', NEW_SO, soPath);
    fs.renameSync(soPath, newSoPath);
  } else if (fs.existsSync(newSoPath)) {
    // Only the renamed lib exists but its SONAME is wrong — re-apply.
    patchelf('--set-soname', NEW_SO, newSoPath);
  } else {
    console.error('[shmakk] Expected onnxruntime library not found:', soPath);
    process.exit(1);
  }

  // Update the binding.node's NEEDED reference if it still points at the
  // original SONAME.
  if (!bindingPatched) {
    patchelf('--replace-needed', ORIG_SO, NEW_SO, bindingPath);
  }

  console.log('[shmakk] Patched kokoro-js onnxruntime SONAME →', NEW_SO);
}

main();
