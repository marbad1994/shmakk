// Voice input service for shmakk.
// VAD-based recording: starts on speech, stops after silence.
// Transcribes via in-process Whisper ONNX. Supports TTS interrupt.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const AUDIO_DIR = path.join(os.tmpdir(), 'shmakk-voice');
const MAX_RECORD_SEC = 30;
const SILENCE_SEC = parseFloat(process.env.SHMAKK_VOICE_SILENCE_SEC || '1.8');
const SILENCE_THRESHOLD = process.env.SHMAKK_VOICE_SILENCE_THRESHOLD || '2%';
const SILENCE_START_SEC = parseFloat(process.env.SHMAKK_VOICE_SILENCE_START_SEC || '0.15');
const PAD_START_SEC = parseFloat(process.env.SHMAKK_VOICE_PAD_START_SEC || '0.3');
// Post-recording RMS gate (0..1, on int16 normalized). Below this is treated
// as noise/silence and never sent to Whisper. Tunable for noisy rooms.
const MIN_RMS = parseFloat(process.env.SHMAKK_VOICE_MIN_RMS || '0.003');
// Minimum captured speech duration in seconds (anything shorter is noise).
const MIN_SPEECH_SEC = parseFloat(process.env.SHMAKK_VOICE_MIN_SPEECH_SEC || '0.5');

// Track active TTS playback process so we can kill it on interrupt
let _ttsProc = null;
let _ttsKilled = false;
function _setTtsProc(proc) { _ttsProc = proc; _ttsKilled = false; }
function _isTtsKilled() { return _ttsKilled; }

function _killTts() {
  if (_ttsProc) {
    try { _ttsProc.kill('SIGTERM'); } catch {}
    _ttsProc = null;
  }
  _ttsKilled = true;
  // Also cancel sentence streaming (avoids wasted generation)
  try {
    const tts = require('./tts');
    tts.stopSpeaking();
  } catch {}
}

// Track active recorder process so we can kill it on Ctrl+C
let _recorderProc = null;

function _killRecorder() {
  if (_recorderProc) {
    try { _recorderProc.kill('SIGTERM'); } catch {}
    _recorderProc = null;
  }
}

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

/**
 * Detect an available audio recorder.
 * Sox is preferred because it supports VAD silence detection.
 * Returns { cmd, args, ext, label } or null if none found.
 */
// Cached recorder detection — only runs once per process lifetime
let _cachedRecorder = undefined;
function detectRecorder() {
  if (_cachedRecorder !== undefined) return _cachedRecorder;

  // Use a single `which` call with all candidates for instant detection
  let whichOut = '';
  try {
    whichOut = execSync('which rec sox ffmpeg arecord 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    });
  } catch {}

  const found = new Set(
    whichOut.split('\n').map(s => s.trim()).filter(Boolean)
  );

  // 1. rec (sox frontend) — preferred
  if (found.has('rec') || [...found].some(p => p.endsWith('/rec'))) {
    _cachedRecorder = { cmd: 'rec', ext: '.wav', label: 'rec (Sox)', vad: true, useSoxInput: false };
    return _cachedRecorder;
  }

  // 2. sox with explicit pulse input
  if (found.has('sox') || [...found].some(p => p.endsWith('/sox'))) {
    _cachedRecorder = { cmd: 'sox', ext: '.wav', label: 'sox (Sox)', vad: true, useSoxInput: true };
    return _cachedRecorder;
  }

  // 3. ffmpeg — no VAD, fixed duration fallback
  if (found.has('ffmpeg') || [...found].some(p => p.endsWith('/ffmpeg'))) {
    _cachedRecorder = { cmd: 'ffmpeg', ext: '.wav', label: 'ffmpeg', vad: false };
    return _cachedRecorder;
  }

  // 4. arecord — no VAD, fixed duration fallback
  if (found.has('arecord') || [...found].some(p => p.endsWith('/arecord'))) {
    _cachedRecorder = { cmd: 'arecord', ext: '.wav', label: 'arecord (ALSA)', vad: false };
    return _cachedRecorder;
  }

  _cachedRecorder = null;
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

    // Track for external kill (Ctrl+C)
    _recorderProc = proc;

    const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} },
      (maxDurationSec + 5) * 1000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (_recorderProc === proc) _recorderProc = null;
      // sox exits 0 normally; ffmpeg exits 255 on SIGTERM; 143 = killed by SIGTERM
      if (code === 0 || code === null || code === 255 || code === 143 || code === 141) resolve();
      else reject(new Error(`recorder exited ${code}`));
    });
    proc.on('error', (err) => { clearTimeout(timeout); if (_recorderProc === proc) _recorderProc = null; reject(err); });
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

// Whisper hallucination patterns — common output on silence/non-speech.
// Normalize aggressively: lowercase, strip punctuation/whitespace, then match.
const HALLUCINATION_PATTERNS = [
  /^you[.!?]*$/i,
  /^(bye|goodbye)\s*(you)?[.!?]*$/i,
  /^thank\s*you[.!?]*$/i,
  /^(thanks\s*for\s*watching|please\s*subscribe|subscribe)[.!?]*$/i,
  /^(the|a|an|um|uh|uhh|hmm|mhm|bye|goodbye|stop|quiet|go|okay|ok|yeah|yes|no)[.!?]*$/i,
  /^(i'?m\s+)?(sorry|fine)[.!?]*$/i,
  /^[.,;:!?]+$/,
  /^[\s.,;:!?]*$/,
  // very short utterances that are 90%+ punctuation/symbols
  /^[\W_]{1,3}\w{0,2}[\W_]*$/,
];

function filterHallucination(text) {
  if (!text) return text;
  const cleaned = text.trim().replace(/[.,!?;:]+$/, '').trim();
  for (const re of HALLUCINATION_PATTERNS) {
    if (re.test(cleaned)) return '';
  }
  // Single character or just non-alphanumeric
  if (cleaned.length <= 2 && !/[a-z0-9]/i.test(cleaned)) return '';
  return text;
}

async function recordAndTranscribe({ language, maxDurationSec, onStart, onStop, suppressKillTts = false } = {}) {
  ensureAudioDir();
  const recorder = detectRecorder();
  if (!recorder) {
    throw new Error(
      'No audio recorder found. Install sox (recommended): sudo pacman -S sox'
    );
  }

  // Kill TTS so the AI stops talking when user starts speaking.
  // Suppressed in the interrupt-listener path where TTS is intentionally running.
  if (!suppressKillTts) _killTts();

  const outFile = path.join(AUDIO_DIR, `voice-${Date.now()}.wav`);
  if (onStart) onStart();
  try {
    await recordAudio(recorder, outFile, { maxDurationSec: maxDurationSec || MAX_RECORD_SEC });
  } catch (err) {
    cleanupFile(outFile);
    throw err;
  }
  if (onStop) onStop();

  // Energy gate: if the captured audio is too quiet or too short, drop it
  // without invoking Whisper. Whisper invents text from near-silence
  // ("Bye you.", "Thank you for watching."), so we must filter at the
  // audio level, not just the text level.
  try {
    const { rms, durationSec } = audioStats(outFile);
    if (rms < MIN_RMS || durationSec < MIN_SPEECH_SEC) {
      if (rms > 0.0001) { // only log if there was actual audio — skip pure silence
        process.stderr.write(
          `\r\x1b[90m[voice] skip (too quiet): rms=${rms.toFixed(4)} dur=${durationSec.toFixed(2)}s — tune with SHMAKK_VOICE_MIN_RMS\x1b[0m\n`,
        );
      }
      cleanupFile(outFile);
      return '';
    }
    if (process.env.SHMAKK_VOICE_DEBUG) {
      process.stderr.write(
        `\r\x1b[90m[voice] accept: rms=${rms.toFixed(4)} dur=${durationSec.toFixed(2)}s\x1b[0m\n`,
      );
    }
  } catch {}

  try {
    const text = await transcribeAudio(outFile, { language: language || 'english' });
    // Filter common Whisper hallucinations (standalone "You", "Thank you", etc.)
    const filtered = filterHallucination(text);
    // Check for stop words — kill TTS and discard
    if (filtered && STOP_WORDS.has(filtered.toLowerCase().trim().replace(/[.!?]$/, ''))) {
      _killTts();
      process.stderr.write(`\r\x1b[33m🤫 stopped\x1b[0m\n`);
      return '';
    }
    // Write transcript to stderr so it shows in terminal but isn't injected as input
    if (filtered) process.stderr.write(`\r\x1b[36m🎤 ${filtered}\x1b[0m\n`);
    return filtered;
  } finally {
    cleanupFile(outFile);
  }
}

/**
 * Compute audio stats from a captured WAV — used to drop near-silent
 * recordings before they reach Whisper (which hallucinates on silence).
 * Returns { rms, durationSec } where rms is in [0,1] over int16-normalized samples.
 */
function audioStats(wavPath) {
  try {
    const { WaveFile } = require('wavefile');
    const wav = new WaveFile(fs.readFileSync(wavPath));
    const sampleRate = wav.fmt.sampleRate || 16000;
    // toBuffer/getSamples handles bit-depth normalization
    const samples = wav.getSamples(true, Int16Array); // mono, int16
    if (!samples || !samples.length) return { rms: 0, durationSec: 0 };
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 32768;
      sumSq += v * v;
    }
    return {
      rms: Math.sqrt(sumSq / samples.length),
      durationSec: samples.length / sampleRate,
    };
  } catch {
    return { rms: 1, durationSec: 999 }; // fail open — let Whisper try
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
  _killTts,
  _killRecorder,
  _setTtsProc,
  _isTtsKilled,
  /** Preload STT model in background so first transcription is instant. */
  preloadSTT() {
    try { require('./stt')._ensureModel(); } catch {}
  },
};
