// Screen + audio capture with a shared monotonic clock and a precise,
// per-frame/per-block timestamped timeline for later STT/vision alignment.
//
// One ffmpeg process grabs the screen (video) and the microphone (audio) and
// muxes them into a single file. Because both streams live in one process and
// one container, they share one timeline and start at 0 together, which is the
// foundation every downstream step (timestamped transcript, frame extraction,
// vision analysis) relies on.
//
// While recording we also write a sidecar `.timeline.jsonl` that records:
//   • lifecycle events (start/pause/resume/stop) with monotonic ns + wall ms
//   • every video frame: index `n`, source `pts`, `pts_time` (seconds)
//   • every audio block (optional): index `n`, `pts_time`, sample count
// On stop, `ffprobe` fills in a `.manifest.json` with stream metadata and the
// final duration, so later steps can map transcript times back to exact frames.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { MonotonicClock } = require('./clock');

// ── configuration ───────────────────────────────────────────────────────────

const DEFAULT_FPS = Math.max(1, parseInt(process.env.SHMAKK_CAPTURE_FPS || '15', 10));
const DEFAULT_AUDIO_DEVICE = process.env.SHMAKK_CAPTURE_AUDIO || 'default';
const DEFAULT_VIDEO_DEVICE = process.env.SHMAKK_CAPTURE_VIDEO || '';
const TRACE_AUDIO = process.env.SHMAKK_CAPTURE_TRACE_AUDIO !== '0';

// Linux backends we know how to turn into ffmpeg input args. kmsgrab reads the
// KMS/DRM framebuffer directly and works under Wayland; x11grab needs an X11
// or XWayland display. `pipewire` drives the ScreenCast portal (the only
// correct way to capture a composited Wayland desktop) and feeds raw video into
// ffmpeg through a FIFO; see portal-capture.py.
const SUPPORTED_VIDEO_BACKENDS = ['x11grab', 'kmsgrab', 'pipewire'];

// Helper that negotiates the ScreenCast portal and pipes the stream into a FIFO.
const PORTAL_HELPER = path.join(__dirname, 'portal-capture.py');

function captureDir() {
  return path.resolve(process.env.SHMAKK_CAPTURE_DIR || path.join(os.tmpdir(), 'shmakk-capture'));
}

function newId() {
  return `cap_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function which(bin) {
  try {
    const out = require('child_process').execSync(`command -v ${bin} 2>/dev/null`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function restoreTokenPath() {
  return path.join(captureDir(), 'screencast.restore');
}

function readRestoreToken() {
  try { return fs.readFileSync(restoreTokenPath(), 'utf8').trim() || null; } catch { return null; }
}

function writeRestoreToken(token) {
  if (!token) return;
  try { fs.writeFileSync(restoreTokenPath(), String(token).trim() + '\n'); } catch {}
}

// Check whether the PipeWire ScreenCast capture path is usable on this box.
// Returns { available, reasons }.
function detectPipewire() {
  if (process.platform !== 'linux') {
    return { available: false, reasons: ['PipeWire portal capture is Linux-only'] };
  }
  const reasons = [];
  const python = which('python3');
  const mkfifo = which('mkfifo');
  const helper = fs.existsSync(PORTAL_HELPER);
  if (!python) {
    reasons.push('python3 not found (install python + python-dbus + python-gobject)');
  } else {
    const gstpy = require('child_process').spawnSync(
      python,
      ['-c', "import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst"],
      { encoding: 'utf8', timeout: 3000 },
    );
    if (gstpy.status !== 0) reasons.push('python3 gst bindings missing (install gst-python)');
  }
  if (!mkfifo) reasons.push('mkfifo not found (install coreutils)');
  if (!helper) reasons.push(`portal helper missing (${PORTAL_HELPER})`);
  const insp = which('gst-inspect-1.0');
  if (insp) {
    const r = require('child_process').spawnSync(insp, ['pipewiresrc'], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) reasons.push('gst-plugin-pipewire missing (install gst-plugin-pipewire)');
  }
  return { available: reasons.length === 0, reasons };
}

// ── backend detection ──────────────────────────────────────────────────────

/**
 * Parse SHMAKK_CAPTURE_VIDEO as `backend[:device]`, e.g. "kmsgrab" or
 * "kmsgrab:/dev/dri/card1". Returns null when unset or blank.
 */
function parseVideoOverride(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const idx = s.indexOf(':');
  return {
    backend: idx === -1 ? s : s.slice(0, idx),
    device: idx === -1 ? '' : s.slice(idx + 1),
    raw: s,
  };
}

function detectVideo() {
  const platform = process.platform;
  if (platform === 'linux') {
    const display = process.env.DISPLAY || ':0.0';
    const sessionType = process.env.XDG_SESSION_TYPE || '';
    const wayland = sessionType === 'wayland' || (!!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);
    const override = parseVideoOverride(process.env.SHMAKK_CAPTURE_VIDEO);

    if (override) {
      if (!SUPPORTED_VIDEO_BACKENDS.includes(override.backend)) {
        return {
          backend: override.backend,
          label: 'Unsupported video backend',
          invalid: true,
          note: `Unsupported SHMAKK_CAPTURE_VIDEO value "${override.raw}". Supported backends: ${SUPPORTED_VIDEO_BACKENDS.join(', ')}.`,
        };
      }
      if (override.backend === 'kmsgrab') {
        return {
          backend: 'kmsgrab',
          label: 'KMS/DRM screen (Wayland)',
          device: override.device || '/dev/dri/card0',
          note: 'kmsgrab reads the KMS framebuffer directly and works under Wayland, but usually needs root or membership in the video/render group.',
        };
      }
      if (override.backend === 'pipewire') {
        const pw = detectPipewire();
        return pw.available
          ? { backend: 'pipewire', label: 'PipeWire screen (ScreenCast portal)' }
          : {
              backend: 'pipewire',
              label: 'PipeWire screen (ScreenCast portal)',
              invalid: true,
              note: 'PipeWire portal capture unavailable: ' + pw.reasons.join('; '),
            };
      }
      return { backend: 'x11grab', label: 'X11 screen (forced)', display: override.device || display };
    }

    if (wayland) {
      const pw = detectPipewire();
      if (pw.available) {
        return { backend: 'pipewire', label: 'PipeWire screen (ScreenCast portal)' };
      }
      return {
        backend: 'x11grab',
        label: 'X11 / XWayland screen',
        display,
        note: 'Wayland session detected, but PipeWire portal capture is unavailable (' + pw.reasons.join('; ') + '). Falling back to x11grab, which usually captures an empty X root.',
      };
    }
    return { backend: 'x11grab', label: 'X11 screen', display };
  }
  if (platform === 'darwin') {
    return { backend: 'avfoundation', label: 'macOS screen', device: DEFAULT_VIDEO_DEVICE || '1' };
  }
  if (platform === 'win32') {
    return { backend: 'gdigrab', label: 'Windows desktop', device: DEFAULT_VIDEO_DEVICE || 'desktop' };
  }
  return null;
}

function detectAudio() {
  const platform = process.platform;
  if (platform === 'linux') {
    return { backend: 'pulse', label: 'PulseAudio / PipeWire microphone', device: DEFAULT_AUDIO_DEVICE };
  }
  if (platform === 'darwin') {
    return { backend: 'avfoundation', label: 'macOS microphone', device: DEFAULT_AUDIO_DEVICE || 'default' };
  }
  if (platform === 'win32') {
    return { backend: 'dshow', label: 'Windows microphone', device: DEFAULT_AUDIO_DEVICE || 'default' };
  }
  return null;
}

/**
 * Report what capture capability is available on this machine.
 * @returns {{available: boolean, platform: string, ffmpeg: string|null,
 *            ffprobe: string|null, video: object|null, audio: object|null,
 *            reasons: string[]}}
 */
function detect() {
  const ffmpeg = which('ffmpeg');
  const ffprobe = which('ffprobe');
  const video = detectVideo();
  const audio = detectAudio();
  const reasons = [];
  if (!ffmpeg) reasons.push('ffmpeg not found (install ffmpeg)');
  if (!ffprobe) reasons.push('ffprobe not found (install ffmpeg)');
  if (!video) reasons.push('no screen capture backend for this platform');
  if (video && video.invalid) reasons.push(video.note);
  if (!audio) reasons.push('no audio capture backend for this platform');
  return {
    available: !!(ffmpeg && ffprobe && video && !video.invalid && audio),
    platform: process.platform,
    sessionType: process.env.XDG_SESSION_TYPE || null,
    ffmpeg,
    ffprobe,
    video,
    audio,
    reasons,
  };
}

function isAvailable() {
  return detect().available;
}

// ── ffmpeg arg builders (pure, exported for tests) ─────────────────────────

function videoInputArgs(video, opts = {}) {
  const fps = opts.fps || DEFAULT_FPS;
  const size = opts.width && opts.height ? [`-video_size`, `${opts.width}x${opts.height}`] : [];
  if (video.backend === 'x11grab') {
    return ['-f', 'x11grab', '-framerate', String(fps), ...size, '-i', video.display || process.env.DISPLAY || ':0.0'];
  }
  if (video.backend === 'kmsgrab') {
    return ['-f', 'kmsgrab', '-framerate', String(fps), '-i', video.device || '/dev/dri/card0'];
  }
  if (video.backend === 'pipewire') {
    const fifo = opts.fifo;
    if (!fifo) throw new Error('pipewire capture requires a FIFO path');
    const w = opts.width || 1920;
    const h = opts.height || 1080;
    return ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', fifo];
  }
  if (video.backend === 'avfoundation') {
    return ['-f', 'avfoundation', '-framerate', String(fps), '-i', video.device || '1'];
  }
  if (video.backend === 'gdigrab') {
    return ['-f', 'gdigrab', '-framerate', String(fps), ...size, '-i', video.device || 'desktop'];
  }
  throw new Error(`unsupported video backend: ${video && video.backend}`);
}

function audioInputArgs(audio, opts = {}) {
  if (audio.backend === 'pulse') {
    return ['-f', 'pulse', '-thread_queue_size', '1024', '-i', audio.device || 'default'];
  }
  if (audio.backend === 'avfoundation') {
    return ['-f', 'avfoundation', '-i', audio.device || 'default'];
  }
  if (audio.backend === 'dshow') {
    return ['-f', 'dshow', '-i', `audio=${audio.device || 'default'}`];
  }
  throw new Error(`unsupported audio backend: ${audio && audio.backend}`);
}

/**
 * Build the full ffmpeg argument list for a capture session.
 * @param {object} p - { video, audio, outputPath, fps, width, height, traceAudio }
 */
function buildFfmpegArgs(p) {
  const fps = p.fps || DEFAULT_FPS;
  const out = [
    '-hide_banner',
    '-loglevel', 'info',
    ...videoInputArgs(p.video, p),
    ...audioInputArgs(p.audio, p),
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-vf', 'showinfo',
  ];
  if (p.traceAudio !== false) out.push('-af', 'ashowinfo');
  out.push('-f', 'matroska', p.outputPath);
  return out;
}

// ── ffmpeg log parsing ─────────────────────────────────────────────────────

/**
 * Parse one ffmpeg showinfo / ashowinfo log line.
 * @returns {null|{kind:'video'|'audio', n:number, pts:number, ptsTime:number, samples:number|null}}
 */
function parseInfoLine(line) {
  if (typeof line !== 'string') return null;
  const video = line.includes('Parsed_showinfo_');
  const audio = line.includes('Parsed_ashowinfo_');
  if (!video && !audio) return null;

  const n = /n:\s*(\d+)/.exec(line);
  const pts = /pts:\s*(\d+)/.exec(line);
  const ptsTime = /pts_time:\s*(-?[0-9.eE+]+)/.exec(line);
  if (!n || !ptsTime) return null;

  const samples = /nb_samples:\s*(\d+)/.exec(line);
  return {
    kind: video ? 'video' : 'audio',
    n: parseInt(n[1], 10),
    pts: pts ? parseInt(pts[1], 10) : null,
    ptsTime: parseFloat(ptsTime[1]),
    samples: samples ? parseInt(samples[1], 10) : null,
  };
}

// ── ffprobe ─────────────────────────────────────────────────────────────────

function probeMedia(filePath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/**
 * Extract the audio track from a media container (e.g. the muxed `.mkv`) into
 * a mono 16 kHz WAV, the format the STT service expects. Returns the WAV path.
 */
function extractAudioTrack(mediaPath, outWavPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ff = which('ffmpeg');
    if (!ff) return reject(new Error('ffmpeg not found (install ffmpeg)'));
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWavPath];
    execFile(ff, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(`audio extraction failed: ${err.message}`));
      if (!fs.existsSync(outWavPath)) return reject(new Error('audio extraction produced no file'));
      resolve(outWavPath);
    });
  });
}

// ── capture session ────────────────────────────────────────────────────────

/**
 * A single capture session.
 *
 * @param {object} opts
 *   - outputDir    (optional) directory; defaults to SHMAKK_CAPTURE_DIR or tmp
 *   - fps, width, height  (optional) video settings
 *   - traceAudio   (optional, default true) log per-audio-block timestamps
 *   - video, audio (optional) backend overrides from detect()
 *   - onEvent      (optional) callback invoked for every timeline event
 */
function createSession(opts = {}) {
  const id = opts.id || newId();
  const dir = opts.outputDir || captureDir();
  fs.mkdirSync(dir, { recursive: true });

  const fps = opts.fps || DEFAULT_FPS;
  const paths = {
    dir,
    muxed: path.join(dir, `${id}.mkv`),
    manifest: path.join(dir, `${id}.manifest.json`),
    timeline: path.join(dir, `${id}.timeline.jsonl`),
    transcript: path.join(dir, `${id}.transcript.json`),
    framesDir: path.join(dir, `${id}.frames`),
    frames: path.join(dir, `${id}.frames.json`),
    analysis: path.join(dir, `${id}.analysis.json`),
    plan: path.join(dir, `${id}.plan.json`),
    automation: path.join(dir, `${id}.automation.json`),
    fifo: path.join(dir, `${id}.video.fifo`),
  };

  const video = opts.video || detectVideo();
  const audio = opts.audio || detectAudio();

  let state = 'idle'; // idle | recording | paused | stopping | done | error
  let proc = null;
  let helperProc = null; // portal + gst-launch helper (pipewire backend only)
  let fifoPath = null;   // raw-video FIFO path (pipewire backend only)
  let clock = null;
  let seq = 0;
  let frameCount = 0;
  let audioBlocks = 0;
  let startedAt = null;
  let stoppedAt = null;
  let lastError = null;
  let stopResolve = null;
  let stopTimer = null;
  let stderrTail = '';

  const meta = () => ({
    id,
    state,
    fps,
    width: opts.width || null,
    height: opts.height || null,
    traceAudio: opts.traceAudio !== false,
    video: video ? { backend: video.backend, label: video.label, note: video.note || null } : null,
    audio: audio ? { backend: audio.backend, label: audio.label } : null,
    startedAt,
    stoppedAt,
    frameCount,
    audioBlocks,
    durationSec: clock && startedAt ? clock.elapsedSec() : 0,
    paths,
    error: lastError,
  });

  function appendEvent(ev) {
    const rec = { seq: seq++, ...ev };
    try {
      fs.appendFileSync(paths.timeline, JSON.stringify(rec) + '\n');
    } catch {}
    if (typeof opts.onEvent === 'function') {
      try { opts.onEvent(rec); } catch {}
    }
  }

  function wallSample(tSec) {
    const wallMs = clock ? clock.originWallMs + tSec * 1000 : Date.now();
    return { tSec, wallMs, iso: new Date(wallMs).toISOString() };
  }

  function recordInfo(info) {
    if (!info || !clock) return;
    const tSec = info.ptsTime >= 0 ? info.ptsTime : 0;
    const monoNs = clock.mediaToMonoNs(tSec);
    if (info.kind === 'video') {
      frameCount += 1;
      appendEvent({
        t: 'frame',
        n: info.n,
        pts: info.pts,
        ptsTime: info.ptsTime,
        monoNs: monoNs.toString(),
        ...wallSample(tSec),
      });
    } else {
      audioBlocks += 1;
      appendEvent({
        t: 'audio',
        n: info.n,
        pts: info.pts,
        ptsTime: info.ptsTime,
        samples: info.samples,
        monoNs: monoNs.toString(),
        ...wallSample(tSec),
      });
    }
  }

  function onStderr(chunk) {
    const text = chunk.toString('utf8');
    const lines = (stderrTail + text).split(/\r?\n/);
    stderrTail = lines.pop() || '';
    for (const line of lines) {
      const info = parseInfoLine(line);
      if (info) recordInfo(info);
      else if (line.trim() && /(error|failed|permission denied|no such|invalid)/i.test(line)) {
        appendEvent({ t: 'log', level: 'error', text: line.trim().slice(0, 500) });
      }
    }
  }

  function killHelper() {
    if (helperProc) { try { helperProc.kill('SIGTERM'); } catch {} helperProc = null; }
    if (fifoPath) { try { fs.rmSync(fifoPath, { force: true }); } catch {} fifoPath = null; }
  }

  // Start the ScreenCast portal helper and wait for its metadata line. Resolves
  // with { width, height, nodeId, restoreToken } once the FIFO is set up; the
  // helper then blocks writing raw video until ffmpeg opens the FIFO.
  function startPipewireVideo() {
    return new Promise((resolve, reject) => {
      const fifo = paths.fifo;
      try { fs.rmSync(fifo, { force: true }); } catch {}
      try {
        execFileSync('mkfifo', [fifo]);
      } catch (e) {
        return reject(new Error(`mkfifo failed: ${e.message}`));
      }
      fifoPath = fifo;

      const helperArgs = [PORTAL_HELPER, '--fifo', fifo, '--cursor', opts.cursor || 'embedded'];
      const restore = opts.restoreToken || readRestoreToken();
      if (restore) helperArgs.push('--restore-token', restore);

      const helper = spawn(process.env.SHMAKK_CAPTURE_PYTHON || 'python3', helperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      helperProc = helper;

      let outBuf = '';
      let errBuf = '';
      let settled = false;
      const settle = (err, meta) => {
        if (settled) return;
        settled = true;
        if (err) {
          if (helperProc) { try { helperProc.kill('SIGTERM'); } catch {} }
          helperProc = null;
          if (fifoPath) { try { fs.rmSync(fifoPath, { force: true }); } catch {} fifoPath = null; }
          reject(err);
        } else {
          resolve(meta);
        }
      };

      helper.stdout.on('data', (chunk) => {
        outBuf += chunk.toString('utf8');
        const nl = outBuf.indexOf('\n');
        if (nl !== -1) {
          const line = outBuf.slice(0, nl).trim();
          try {
            const meta = JSON.parse(line);
            if (!meta || !(meta.width >= 1) || !(meta.height >= 1)) {
              settle(new Error(`portal helper reported invalid capture size: ${line}`));
              return;
            }
            if (meta.restoreToken) writeRestoreToken(meta.restoreToken);
            settle(null, meta);
          } catch (e) {
            settle(new Error(`portal helper returned invalid metadata: ${line}`));
          }
        }
      });
      helper.stderr.on('data', (c) => { errBuf += c.toString('utf8'); });
      helper.on('error', (e) => settle(new Error(`failed to start portal helper: ${e.message}`)));
      helper.on('exit', (code) => {
        if (!settled) settle(new Error(`portal helper exited early (code=${code}): ${(errBuf.slice(-400) || '').trim() || 'no output'}`));
      });
      const timer = setTimeout(() => settle(new Error('portal helper timed out (screen-share dialog open?)')), 60000);
      if (timer.unref) timer.unref();
    });
  }

  function finalizeErr(err) {
    killHelper();
    if (stopResolve) { const r = stopResolve; stopResolve = null; r(); }
    lastError = String((err && err.message) || err || 'capture failed');
    state = 'error';
    appendEvent({ t: 'error', message: lastError, ...wallSample(clock ? clock.elapsedSec() : 0) });
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (state === 'recording' || state === 'paused') return resolve(meta());
      if (!video || !audio) {
        lastError = 'no capture backend available';
        state = 'error';
        return reject(new Error(lastError));
      }

      clock = new MonotonicClock();
      startedAt = clock.originIso;
      state = 'recording';

      const launch = () => {
        const args = buildFfmpegArgs({ video, audio, outputPath: paths.muxed, fps, width: opts.width, height: opts.height, fifo: fifoPath, traceAudio: opts.traceAudio });
        appendEvent({ t: 'start', args: { video: video.backend, audio: audio.backend, fps }, ...wallSample(0) });

        proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        proc.stderr.on('data', onStderr);
        proc.on('error', (err) => { finalizeErr(err); reject(err); });

        proc.on('spawn', () => resolve(meta()));

        proc.on('exit', (code, signal) => {
          if (stopTimer) clearTimeout(stopTimer);
          const wasActive = state === 'recording' || state === 'paused';
          if (wasActive) {
            // Unexpected exit while we expected to keep recording.
            killHelper();
            lastError = `ffmpeg exited early (code=${code}, signal=${signal})`;
            state = 'error';
            appendEvent({ t: 'error', message: lastError, ...wallSample(clock ? clock.elapsedSec() : 0) });
          } else if (state === 'stopping') {
            state = 'done';
            stoppedAt = new Date().toISOString();
          }
          proc = null;
          if (stopResolve) { const r = stopResolve; stopResolve = null; r(); }
        });
      };

      if (video.backend === 'pipewire') {
        startPipewireVideo().then((dims) => {
          opts.width = dims.width;
          opts.height = dims.height;
          appendEvent({ t: 'pipewire', nodeId: dims.nodeId, width: dims.width, height: dims.height, ...wallSample(0) });
          launch();
        }).catch((e) => {
          lastError = String(e.message || e);
          state = 'error';
          killHelper();
          appendEvent({ t: 'error', message: lastError, ...wallSample(clock ? clock.elapsedSec() : 0) });
          reject(new Error(lastError));
        });
      } else {
        launch();
      }
    });
  }

  function pause() {
    if (state !== 'recording') throw new Error(`cannot pause while ${state}`);
    if (process.platform === 'win32') throw new Error('pause/resume is not supported on Windows');
    try { proc.kill('SIGSTOP'); } catch (e) { throw new Error(`pause failed: ${e.message}`); }
    if (helperProc) { try { helperProc.kill('SIGSTOP'); } catch {} }
    state = 'paused';
    appendEvent({ t: 'pause', ...wallSample(clock.elapsedSec()) });
    return meta();
  }

  function resume() {
    if (state !== 'paused') throw new Error(`cannot resume while ${state}`);
    try { proc.kill('SIGCONT'); } catch (e) { throw new Error(`resume failed: ${e.message}`); }
    if (helperProc) { try { helperProc.kill('SIGCONT'); } catch {} }
    state = 'recording';
    appendEvent({ t: 'resume', ...wallSample(clock.elapsedSec()) });
    return meta();
  }

  function stop() {
    return new Promise((resolve) => {
      if (state === 'done' || state === 'error' || state === 'idle') return resolve(meta());
      if (state === 'paused') { try { proc.kill('SIGCONT'); } catch {} }
      state = 'stopping';
      stopResolve = resolve;
      appendEvent({ t: 'stop', ...wallSample(clock ? clock.elapsedSec() : 0) });

      const forceKill = (sig) => { if (proc) { try { proc.kill(sig); } catch {} } };

      // Ask ffmpeg to finalize, then escalate to SIGTERM/SIGKILL.
      if (proc && proc.stdin) { try { proc.stdin.write('q\n'); } catch {} }
      // Stop the portal/gst source so ffmpeg sees EOF on the FIFO.
      killHelper();
      stopTimer = setTimeout(() => forceKill('SIGTERM'), 5000);
      stopTimer.unref();
      const hardStop = setTimeout(() => forceKill('SIGKILL'), 12000);
      hardStop.unref();
    });
  }

  /**
   * Extract the recording's audio and run the existing STT service over it to
   * produce a timestamped transcript, persisted as `<id>.transcript.json`
   * next to the recording. Requires `npm run setup:voice`.
   *
   * @param {object} [opts] - { language }
   * @returns {Promise<object>} transcript { text, segments, durationSec, language, path }
   */
  async function transcribe(opts = {}) {
    if (state !== 'done' && state !== 'error') throw new Error(`cannot transcribe while ${state}; stop the recording first`);
    const wav = path.join(dir, `${id}.audio.wav`);
    try {
      await extractAudioTrack(paths.muxed, wav);
      const { transcribeTimestamped } = require('./stt');
      const result = await transcribeTimestamped(wav, { language: opts.language });
      const transcript = { id, ...result, path: paths.transcript, createdAt: new Date().toISOString() };
      fs.writeFileSync(paths.transcript, JSON.stringify(transcript, null, 2));
      return transcript;
    } finally {
      try { fs.rmSync(wav, { force: true }); } catch {}
    }
  }

  /**
   * Extract key frames from the recording using the transcript's timing and
   * speech cues, persisted as `<id>.frames.json` next to the recording with
   * the PNGs under `<id>.frames/`. Requires ffmpeg (already a capture
   * dependency) and a transcript (auto-transcribes if missing, which needs
   * `npm run setup:voice`).
   *
   * @param {object} [opts] - frame selection overrides (budget, minGapSec,
   *   maxWidth, format, ...) plus { language } for auto-transcription.
   * @returns {Promise<object>} frame result { mediaPath, durationSec, frames, skipped, ... }
   */
  async function frames(opts = {}) {
    if (state !== 'done' && state !== 'error') throw new Error(`cannot extract frames while ${state}; stop the recording first`);
    const { extractKeyFrames } = require('./frames');

    let transcript = null;
    try {
      if (fs.existsSync(paths.transcript)) transcript = JSON.parse(fs.readFileSync(paths.transcript, 'utf8'));
    } catch {}
    if (!transcript || !Array.isArray(transcript.segments)) {
      transcript = await transcribe({ language: opts.language });
    }

    const probe = await probeMedia(paths.muxed);
    const videoStream = probe && Array.isArray(probe.streams)
      ? probe.streams.find((s) => s.codec_type === 'video')
      : null;
    const durationSec = Number((probe && probe.format && probe.format.duration) || transcript.durationSec || 0);

    const result = await extractKeyFrames({
      mediaPath: paths.muxed,
      transcript,
      durationSec,
      fps,
      width: videoStream && videoStream.width ? Number(videoStream.width) : (opts.width || null),
      height: videoStream && videoStream.height ? Number(videoStream.height) : (opts.height || null),
      outputDir: paths.framesDir,
      ...opts,
    });

    const summary = { id, ...result, createdAt: new Date().toISOString() };
    try { fs.writeFileSync(paths.frames, JSON.stringify(summary, null, 2)); } catch {}
    return summary;
  }

  // Run the vision model over extracted frames + transcript and cache the result.
  async function analyze(opts = {}) {
    if (state !== 'done' && state !== 'error') throw new Error(`cannot analyze while ${state}; stop the recording first`);
    const { analyzeRecording } = require('./vision');

    let frameResult = null;
    try {
      if (fs.existsSync(paths.frames)) frameResult = JSON.parse(fs.readFileSync(paths.frames, 'utf8'));
    } catch {}
    if (!frameResult || !Array.isArray(frameResult.frames) || !frameResult.frames.length) frameResult = await frames(opts);

    let transcript = null;
    try {
      if (fs.existsSync(paths.transcript)) transcript = JSON.parse(fs.readFileSync(paths.transcript, 'utf8'));
    } catch {}

    // `mode` picks the contract the model answers in: 'tasks' describes change,
    // 'automation' describes actions to replay. It has to be chosen before the
    // call, not after, because it changes the prompt and the output budget.
    const mode = opts.mode === 'automation' ? 'automation' : 'tasks';
    const result = await analyzeRecording({
      frames: frameResult.frames,
      transcript,
      signal: opts.signal,
      visionClient: opts.visionClient,
      instructions: opts.instructions,
      mode,
    });
    // Keep the exact frames the model saw, in vision order: step evidence is
    // mapped back by position, so a re-selected set would point at the wrong
    // screenshots.
    const summary = { id, ...result, frames: frameResult.frames, createdAt: new Date().toISOString() };
    try { fs.writeFileSync(paths.analysis, JSON.stringify(summary, null, 2)); } catch {}
    return summary;
  }

  async function plan(opts = {}) {
    const { toPlan } = require('./showtell');
    const a = await analyze(opts);
    if (!a.analysis) throw new Error('vision analysis produced no structured understanding');
    const result = { id, ...toPlan(a.analysis, opts), sourceAnalysis: a.analysis, createdAt: new Date().toISOString() };
    try { fs.writeFileSync(paths.plan, JSON.stringify(result, null, 2)); } catch {}
    return result;
  }

  // Turn the recording into a replayable spec.
  //
  // The narration here is a sequence of actions, not prose to interpret, so the
  // frames are read with the automation contract and the result is normalized
  // by pure code. Nothing between normalizeAutomation and the caller is allowed
  // to reinterpret the steps: whatever the model said is what gets replayed, and
  // the warnings it raised are what the review list shows.
  async function automation(opts = {}) {
    const { normalizeAutomation } = require('./automation');
    const a = await analyze({ ...opts, mode: 'automation' });
    if (!a.analysis) throw new Error('vision analysis produced no structured understanding');
    const playback = normalizeAutomation(a.analysis, { frames: a.frames || [] });
    const result = { id, ...playback, sourceAnalysis: a.analysis, createdAt: new Date().toISOString() };
    try { fs.writeFileSync(paths.automation, JSON.stringify(result, null, 2)); } catch {}
    return result;
  }

  async function finalize() {
    if (state !== 'done' && state !== 'error') return meta();
    const probe = await probeMedia(paths.muxed);
    const manifest = {
      id,
      state,
      startedAt,
      stoppedAt,
      fps,
      traceAudio: opts.traceAudio !== false,
      video: video ? { backend: video.backend, label: video.label } : null,
      audio: audio ? { backend: audio.backend, label: audio.label } : null,
      frameCount,
      audioBlocks,
      clockOrigin: clock ? { wallMs: clock.originWallMs, iso: clock.originIso } : null,
      media: probe,
      paths,
      error: lastError,
    };
    try { fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2)); } catch {}
    return manifest;
  }

  return { start, stop, pause, resume, finalize, transcribe, frames, analyze, plan, automation, meta, id, paths };
}

// ── capture manager (used by the web UI / API) ────────────────────────────

function createCaptureManager({ getWorkspace, broadcast } = {}) {
  const sessions = new Map();

  function start(opts = {}) {
    const session = createSession(opts);
    sessions.set(session.id, session);
    return session.start().then((meta) => {
      if (broadcast) broadcast({ t: 'capture.changed', id: session.id, state: meta.state });
      return meta;
    });
  }

  function get(id) {
    const s = sessions.get(id);
    return s ? s.meta() : null;
  }

  function list() {
    return Array.from(sessions.values()).map((s) => s.meta());
  }

  async function pause(id) {
    const s = require_(id);
    const m = s.pause();
    if (broadcast) broadcast({ t: 'capture.changed', id, state: m.state });
    return m;
  }

  async function resume(id) {
    const s = require_(id);
    const m = s.resume();
    if (broadcast) broadcast({ t: 'capture.changed', id, state: m.state });
    return m;
  }

  async function stop(id) {
    const s = require_(id);
    await s.stop();
    const manifest = await s.finalize();
    if (broadcast) broadcast({ t: 'capture.changed', id, state: manifest.state });
    return manifest;
  }

  async function transcribe(id, opts = {}) {
    const s = require_(id);
    const transcript = await s.transcribe(opts);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: s.meta().state, transcript: true });
    return transcript;
  }

  async function frames(id, opts = {}) {
    const s = require_(id);
    const result = await s.frames(opts);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: s.meta().state, frames: true });
    return result;
  }

  async function analyze(id, opts = {}) {
    const s = require_(id);
    const result = await s.analyze(opts);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: s.meta().state, analysis: true });
    return result;
  }

  async function plan(id, opts = {}) {
    const s = require_(id);
    const result = await s.plan(opts);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: s.meta().state, plan: true });
    return result;
  }

  async function automation(id, opts = {}) {
    const s = require_(id);
    const result = await s.automation(opts);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: s.meta().state, automation: true });
    return result;
  }

  async function remove(id) {
    const s = sessions.get(id);
    if (!s) return false;
    if (s.meta().state === 'recording' || s.meta().state === 'paused') await s.stop();
    for (const p of [
      s.paths.muxed, s.paths.manifest, s.paths.timeline, s.paths.transcript,
      s.paths.frames, s.paths.framesDir, path.join(s.paths.dir, `${id}.audio.wav`),
      s.paths.analysis, s.paths.plan, s.paths.automation, s.paths.fifo,
    ]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    sessions.delete(id);
    if (broadcast) broadcast({ t: 'capture.changed', id, state: 'removed' });
    return true;
  }

  function require_(id) {
    const s = sessions.get(id);
    if (!s) throw new Error(`capture session not found: ${id}`);
    return s;
  }

  async function shutdown() {
    for (const s of sessions.values()) {
      try { await s.stop(); } catch {}
    }
    sessions.clear();
  }

  return {
    detect,
    isAvailable,
    start,
    get,
    list,
    pause,
    resume,
    stop,
    transcribe,
    frames,
    analyze,
    plan,
    automation,
    remove,
    shutdown,
  };
}

module.exports = {
  detect,
  isAvailable,
  detectVideo,
  parseVideoOverride,
  detectAudio,
  createSession,
  createCaptureManager,
  buildFfmpegArgs,
  parseInfoLine,
  probeMedia,
  extractAudioTrack,
  captureDir,
  newId,
};
