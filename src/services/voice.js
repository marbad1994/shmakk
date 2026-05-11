// Voice input service for shmakk.
// VAD-based recording: starts on speech, stops after silence.
// Transcribes via in-process Whisper ONNX. Supports TTS interrupt.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const AUDIO_DIR = path.join(os.tmpdir(), 'shmakk-voice');
const MAX_RECORD_SEC = 30;
const SILENCE_SEC = parseFloat(process.env.SHMAKK_VOICE_SILENCE_SEC || '1.0');
const SILENCE_THRESHOLD = process.env.SHMAKK_VOICE_SILENCE_THRESHOLD || '1%';
const SILENCE_START_SEC = parseFloat(process.env.SHMAKK_VOICE_SILENCE_START_SEC || '0.5');
const PAD_START_SEC = parseFloat(process.env.SHMAKK_VOICE_PAD_START_SEC || '0.3');

// Track active TTS playback process so we can kill it on interrupt
let _ttsProc = null;
let _ttsKilled = false;
exports._setTtsProc = (proc) => { _ttsProc = proc; _ttsKilled = false; };
exports._isTtsKilled = () => _ttsKilled;

function _killTts() {
  if (_ttsProc) {
    try { _ttsProc.kill('SIGTERM'); } catch {}
    _ttsProc = null;
  }
  _ttsKilled = true;
}

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

/**
 * Detect an available audio recorder.
 * Sox is preferred because it supports VAD silence detection.
 * Returns { cmd, args, ext, label } or null if none found.
 */
function detectRecorder() {
  // 1. rec (sox frontend) — preferred
  try {
    const out = execSync('which rec 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    if (out.trim()) return { cmd: out.trim(), ext: '.wav', label: 'rec (Sox)', vad: true, useSoxInput: false };
  } catch {}

  // 2. sox with explicit pulse input
  try {
    const out = execSync('which sox 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    if (out.trim()) return { cmd: out.trim(), ext: '.wav', label: 'sox (Sox)', vad: true, useSoxInput: true };
  } catch {}

  // 2. ffmpeg — no VAD, fixed duration fallback
  try {
    const out = execSync('which ffmpeg 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    if (out.trim()) return { cmd: 'ffmpeg', ext: '.wav', label: 'ffmpeg', vad: false };
  } catch {}

  // 3. arecord — no VAD, fixed duration fallback
  try {
    const out = execSync('which arecord 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    });
    if (out.trim()) return { cmd: 'arecord', ext: '.wav', label: 'arecord (ALSA)', vad: false };
  } catch {}

  return null;
}

/**
 * Record audio — uses VAD silence detection if sox is available.
 * With sox: starts capturing immediately, stops after SILENCE_SEC of quiet.
 * Without sox: falls back to fixed-duration recording.
 */
function recordAudio(recorder, outFile, { maxDurationSec = MAX_RECORD_SEC } = {}) {
  return new Promise((resolve, reject) => {
    let proc;

    if (recorder.vad) {
      // sox VAD: record until silence
      let args;
      if (recorder.useSoxInput) {
        // sox needs explicit input type when used directly (not via rec)
        args = [
          '-q',
          '-t', 'pulseaudio', 'default',
          '-r', '16000', '-c', '1',
          '-t', 'wav', outFile,
          'silence', '1', String(SILENCE_START_SEC), SILENCE_THRESHOLD,
          '1', String(SILENCE_SEC), SILENCE_THRESHOLD,
          'pad', String(PAD_START_SEC), '0',
          'trim', '0', String(maxDurationSec),
        ];
      } else {
        args = [
          '-q',
          '-r', '16000', '-c', '1',
          '-t', 'wav', outFile,
          'silence', '1', String(SILENCE_START_SEC), SILENCE_THRESHOLD,
          '1', String(SILENCE_SEC), SILENCE_THRESHOLD,
          'pad', String(PAD_START_SEC), '0',
          'trim', '0', String(maxDurationSec),
        ];
      }
      proc = spawn(recorder.cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } else if (recorder.cmd === 'ffmpeg') {
      const args = ['-y', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '16000',
        '-t', String(maxDurationSec), outFile];
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } else if (recorder.cmd === 'arecord') {
      const args = ['-q', '-f', 'cd', '-t', 'wav', '-d', String(maxDurationSec), outFile];
      proc = spawn('arecord', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } else {
      return reject(new Error('Unknown recorder'));
    }

    const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} },
      (maxDurationSec + 5) * 1000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      // sox exits 0 normally; ffmpeg exits 255 on SIGTERM
      if (code === 0 || code === null || code === 255 || code === 141) resolve();
      else reject(new Error(`recorder exited ${code}`));
    });
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Transcribe an audio file using in-process Whisper ONNX.
 */
async function transcribeAudio(audioPath, opts = {}) {
  const { transcribe } = require('./stt');
  return transcribe(audioPath, { language: opts.language || 'english' });
}

/**
 * High-level: record from microphone → transcribe → return text.
 * Kills any active TTS playback when recording starts (interrupt).
 */
const STOP_WORDS = new Set(['stop', 'quiet', 'shut up', 'silence', 'enough', 'cancel']);

async function recordAndTranscribe({ language, maxDurationSec, onStart, onStop } = {}) {
  ensureAudioDir();
  const recorder = detectRecorder();
  if (!recorder) {
    throw new Error(
      'No audio recorder found. Install sox (recommended): sudo pacman -S sox'
    );
  }

  // Kill TTS so the AI stops talking when user starts speaking
  _killTts();

  const outFile = path.join(AUDIO_DIR, `voice-${Date.now()}.wav`);
  if (onStart) onStart();
  try {
    await recordAudio(recorder, outFile, { maxDurationSec: maxDurationSec || MAX_RECORD_SEC });
  } catch (err) {
    cleanupFile(outFile);
    throw err;
  }
  if (onStop) onStop();

  try {
    const text = await transcribeAudio(outFile, { language: language || 'english' });
    // Check for stop words — kill TTS and discard
    if (text && STOP_WORDS.has(text.toLowerCase().trim().replace(/[.!?]$/, ''))) {
      _killTts();
      process.stderr.write(`\r\x1b[33m🤫 stopped\x1b[0m\n`);
      return '';
    }
    // Write transcript to stderr so it shows in terminal but isn't injected as input
    if (text) process.stderr.write(`\r\x1b[36m🎤 ${text}\x1b[0m\n`);
    return text;
  } finally {
    cleanupFile(outFile);
  }
}

function cleanupFile(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {}
}

/**
 * Check whether a microphone recorder is available on this system.
 */
function isAvailable() {
  return detectRecorder() !== null;
}

/**
 * Quick microphone test: record 2 seconds, report file size.
 * Returns { ok: bool, recorder: string|null, fileSize: number|null, error: string|null }
 */
async function testMicrophone() {
  const recorder = detectRecorder();
  if (!recorder) {
    return {
      ok: false,
      recorder: null,
      fileSize: null,
      error:
        'No audio recorder found. Install sox, arecord (alsa-utils), or ffmpeg.',
    };
  }

  ensureAudioDir();
  const outFile = path.join(AUDIO_DIR, `mic-test-${Date.now()}${recorder.ext || '.wav'}`);

  try {
    await recordAudio(recorder, outFile, { maxDurationSec: 2 });
    const stat = fs.statSync(outFile);
    const tooSmall = stat.size < 100; // less than 100 bytes = probably silence/error
    return {
      ok: !tooSmall,
      recorder: recorder.label,
      fileSize: stat.size,
      error: tooSmall
        ? `Recorded only ${stat.size} bytes — microphone may be muted or disconnected.`
        : null,
    };
  } catch (err) {
    return { ok: false, recorder: recorder.label, fileSize: null, error: err.message };
  } finally {
    cleanupFile(outFile);
  }
}

module.exports = {
  recordAndTranscribe,
  transcribeAudio,
  testMicrophone,
  isAvailable,
  detectRecorder,
  MAX_RECORD_SEC,
};
