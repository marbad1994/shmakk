/**
 * Pick a voice deterministically based on current time.
 * Changes every 2-5 hours (varied per day) so it feels random but is consistent
 * within a session. No state needed — pure function of wall-clock time.
 */
function _scheduleVoice(voices) {
  const now = new Date();
  const day = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();

  // Use day as seed to determine bucket sizes for this day (2-5h each)
  // Simple LCG-style hash
  const daySeed = (day * 2654435761) >>> 0;

  // Build time buckets for the day using the day seed
  let bucketStart = 0;
  let bucket = 0;
  let bucketSeed = daySeed;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();

  while (bucketStart < minuteOfDay) {
    bucketSeed = (bucketSeed * 1664525 + 1013904223) >>> 0;
    const bucketMinutes = 120 + (bucketSeed % 180); // 2h to 5h in minutes
    if (bucketStart + bucketMinutes > minuteOfDay) break;
    bucketStart += bucketMinutes;
    bucket++;
  }

  // Pick voice from bucket + day seed
  const voiceSeed = (daySeed ^ (bucket * 2246822519)) >>> 0;
  return voices[voiceSeed % voices.length].id;
}
// Text-to-speech via Kokoro ONNX using kokoro-js.
// No Python, no server — 100% JS, runs locally in-process.
// Model auto-downloads on first use (~334MB quantized Kokoro-82M).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { WaveFile } = require('wavefile');

let _tts = null;
let _loadPromise = null;

async function _ensureModel() {
  if (_tts) return _tts;

  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    let KokoroTTS;
    try {
      ({ KokoroTTS } = require('kokoro-js'));
    } catch {
      throw new Error(
        'Voice deps not installed. Run: npm run setup:voice\n' +
        'Or: npm install --include=optional'
      );
    }
    _tts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: process.env.SHMAKK_TTS_DTYPE || 'fp16' },
    );
    return _tts;
  })();

  return _loadPromise;
}

/**
 * List available Kokoro voices.
 * @returns {Promise<Array<{id: string, name: string, language: string, gender: string}>>}
 */
async function listVoices() {
  const tts = await _ensureModel();
  const voices = [];
  for (const [id, meta] of Object.entries(tts.voices)) {
    voices.push({
      id,
      name: meta.name || id,
      language: meta.language || 'unknown',
      gender: (meta.gender || '').toLowerCase(),
    });
  }
  return voices;
}

/**
 * Write a Float32Array as a WAV file.
 */
function _writeWav(floatData, sampleRate, outputPath) {
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '32f', floatData);
  fs.writeFileSync(outputPath, wav.toBuffer());
}

/**
 * Generate speech from text.
 *
 * @param {string} text - text to speak
 * @param {object} [opts]
 * @param {string} [opts.voice] - voice name (default: "af_heart")
 * @param {string} [opts.outputPath] - WAV output path (default: temp file)
 * @returns {Promise<{audioPath: string, voice: string}>}
 */
async function generate(text, opts = {}) {
  if (!text || !text.trim()) {
    throw new Error('Empty text for TTS');
  }

  const voice = opts.voice || process.env.SHMAKK_TTS_VOICE || 'af_bella';
  const tts = await _ensureModel();

  // Validate voice
  if (!tts.voices[voice]) {
    // Try to find a matching voice (case-insensitive)
    const lower = voice.toLowerCase();
    const match = Object.keys(tts.voices).find(
      (v) => v.toLowerCase() === lower,
    );
    if (match) {
      opts.voice = match;
    } else {
      const available = Object.keys(tts.voices).slice(0, 8).join(', ');
      throw new Error(
        `Unknown voice: ${voice}. Available: ${available}...`,
      );
    }
  }

  const result = await tts.generate(text, { voice: opts.voice || voice });

  // result is a RawAudio with .audio (Float32Array) and .sampling_rate
  const audioData = result.audio;
  const sampleRate = result.sampling_rate || 24000;

  const outPath =
    opts.outputPath ||
    path.join(os.tmpdir(), `shmakk-tts-${Date.now()}.wav`);

  _writeWav(audioData, sampleRate, outPath);
  return { audioPath: outPath, voice: opts.voice || voice };
}

/**
 * Check whether a system audio player is available.
 */
function playerAvailable(name) {
  try {
    const r = spawnSync('which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return r.status === 0 && r.stdout && r.stdout.length > 0;
  } catch {
    return false;
  }
}

/**
 * Play a WAV file through system audio.
 * Detects aplay (ALSA), paplay (PulseAudio), afplay (macOS).
 * Returns true if a player was found and launched.
 */
function playAudio(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  let cmd, args;

  // macOS
  if (playerAvailable('afplay')) {
    cmd = 'afplay';
    args = [audioPath];
  }

  // Linux: PulseAudio
  if (!cmd && playerAvailable('paplay')) {
    cmd = 'paplay';
    args = [audioPath];
  }

  // Linux: ALSA
  if (!cmd && playerAvailable('aplay')) {
    cmd = 'aplay';
    args = ['-q', audioPath];
  }

  if (!cmd) {
    return false;
  }

  // Track process for interrupt support (voice._setTtsProc)
  const proc = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  try { require('./voice')._setTtsProc(proc); } catch {}
  return true;
}

/**
 * Split text into sentences for streaming TTS.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Speak text sentence by sentence — first sentence starts playing
 * immediately while the rest are generated, cutting perceived latency.
 * Returns a promise that resolves when all audio is queued.
 */
async function speakStreaming(text, opts = {}) {
  const tts = await _ensureModel();
  const voices = Object.keys(tts.voices);
  // Use scheduled voice unless explicitly overridden via env or opts
  const voice = opts.voice
    || process.env.SHMAKK_TTS_VOICE
    || _scheduleVoice(voices.map(id => ({ id })));
  const sentences = splitSentences(text);
  if (!sentences.length) return;

  // Generate and play each sentence sequentially but start playing
  // the first one as soon as it's ready without waiting for the rest.
  for (const sentence of sentences) {
    // Check if interrupted before each sentence
    const { _isTtsKilled } = require('./voice');
    if (_isTtsKilled && _isTtsKilled()) break;
    try {
      const { audioPath } = await generate(sentence, { voice });
      playAudio(audioPath);
      // Clean up after a delay
      setTimeout(() => { try { fs.unlinkSync(audioPath); } catch {} }, 10000);
    } catch {}
  }
}

async function speak(text, opts = {}) {
  return speakStreaming(text, opts);
}

/**
 * Check whether model files are cached locally.
 */
function isCached() {
  try {
    const hfHome =
      process.env.HF_HOME ||
      process.env.XDG_CACHE_HOME ||
      path.join(os.homedir(), '.cache', 'huggingface');

    const modelDir = path.join(
      hfHome,
      'transformers',
      'models--onnx-community--Kokoro-82M-v1.0-ONNX',
    );
    return fs.existsSync(modelDir);
  } catch {
    return false;
  }
}

module.exports = { generate, speak, speakStreaming, playAudio, listVoices, isCached };
