// Screen + microphone recorder for Show & tell, running in the browser.
//
// Nothing is recorded as video. While recording we sample the shared screen
// every half second into a tiny grayscale thumbnail and keep a full frame
// whenever it differs enough from the last kept one, and at least every few
// seconds so a still screen under narration is covered. Kept frames upload in the
// background, so stopping is quick. The microphone is recorded with
// MediaRecorder and converted to 16 kHz mono WAV here, which is what the
// server's Whisper expects; no ffmpeg needed anywhere.

export interface LiveSegment { start: number; end: number; text: string }

export interface RecorderEvents {
  onFrame?: (n: number) => void;
  onLevel?: (level: number) => void;
  onTranscript?: (segments: LiveSegment[], interim: string) => void;
  onEnded?: () => void; // the person stopped sharing from the browser's own bar
  onError?: (message: string) => void;
}

export interface RecorderResult { clip: number; durationSec: number; audio: Blob | null; segments: LiveSegment[]; frames: number; uploadErrors: number }

const TICK_MS = 250;
const SAMPLE_EVERY = 2; // ticks per screen sample (500 ms)
const CHANGE_THRESHOLD = 0.055;
const MAX_GAP_SEC = 3;
const MAX_WIDTH = 1600;

const SHARE_ENDED = 'Screen sharing stopped before the recording started. Click Start and share a screen again.';
const PLAY_FAILED = 'The shared screen could not be used for recording.';

type SpeechRec = {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function micError(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone permission was denied, so only the screen is recorded. Allow the microphone in the site settings (lock icon in the address bar) and record again.';
  if (name === 'NotFoundError') return 'No microphone was found, so only the screen is recorded.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app, so only the screen is recorded.';
  return 'Microphone not available, so only the screen is recorded.';
}

export function speechRecognitionAvailable() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

type Grabber = { grabFrame(): Promise<ImageBitmap> };

/** A ticker that survives background-tab throttling; falls back to setInterval. */
function makeTicker(fn: () => void, ms: number): () => void {
  try {
    const w = new Worker(new URL('./ticker.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = () => fn();
    w.postMessage(ms);
    return () => { w.postMessage(0); w.terminate(); };
  } catch {
    const t = window.setInterval(fn, ms);
    return () => window.clearInterval(t);
  }
}

/**
 * Records the screen and microphone as a series of clips: nextClip() ends
 * the current clip (one task) and starts the next without stopping the
 * screen share, so each task can be analysed while recording goes on.
 */
export class ScreenRecorder {
  private display: MediaStream | null = null;
  private grabber: Grabber | null = null;
  private stopTicker: (() => void) | null = null;
  private ticks = 0;
  private clip = 0;
  private clipFrames = 0;
  private mic: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private small = document.createElement('canvas');
  private full = document.createElement('canvas');
  private last: Uint8ClampedArray | null = null;
  private lastKeptT = -Infinity;
  private t0 = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private speech: SpeechRec | null = null;
  private speechWanted = false;
  private segStart: number | null = null;
  private segments: LiveSegment[] = [];
  private queue: Promise<void> = Promise.resolve();
  private frames = 0;
  private uploadErrors = 0;
  private stopped = false;

  constructor(private sessionId: string, private ev: RecorderEvents = {}, private lang = 'en-US') {
    this.small.width = 64;
    this.small.height = 36;
  }

  /** The live screen stream, for a preview element. */
  get stream() { return this.display; }
  get paused() { return this.pausedAt !== null; }
  get clipIndex() { return this.clip; }

  elapsed() {
    const now = this.pausedAt ?? performance.now();
    return Math.max(0, (now - this.t0 - this.pausedTotal) / 1000);
  }

  async start({ microphone = true }: { microphone?: boolean } = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share the screen. Use a current Chrome, Edge or Firefox, or the desktop app.');
    // Microphone FIRST, while the click's user activation is still fresh;
    // asked for after the screen picker, the prompt is often refused.
    if (microphone) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (first) {
        try {
          this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch {
          this.ev.onError?.(micError(first));
        }
      }
    }
    try {
      this.display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    } catch (e) {
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = null;
      throw e;
    }
    const track = this.display.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (!this.stopped) this.ev.onEnded?.(); });

    // Keep the element in the document. A detached one is collected as soon as
    // nothing else holds a reference, and Chrome then aborts a pending play()
    // with "the play() request was interrupted because the media was removed
    // from the document"; a page that is hidden stops updating it too.
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    Object.assign(this.video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    this.video.srcObject = this.display;
    document.body.appendChild(this.video);
    let playFailed: Error | null = null;
    try { await this.video.play(); } catch (e) { playFailed = e as Error; }
    // Grab frames from the track itself where possible: that keeps working when
    // the element cannot play at all, and it reports the real frame size.
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => Grabber }).ImageCapture;
    if (IC) { try { this.grabber = new IC(track); } catch { this.grabber = null; } }

    // The person may have stopped sharing while the picker or play() was busy.
    if (this.stopped || track.readyState === 'ended') {
      this.release();
      throw new Error(SHARE_ENDED);
    }
    // Without ImageCapture the <video> is the only source of frames, so a
    // failed play() is fatal there and harmless everywhere else.
    if (playFailed && !this.grabber) {
      this.release();
      throw new Error(`${PLAY_FAILED} (${playFailed.message})`);
    }

    this.t0 = performance.now();
    // The first sample always keeps a frame (nothing to compare against).
    this.stopTicker = makeTicker(() => this.tick(), TICK_MS);

    if (this.mic) {
      this.startAudio();
      this.meter(this.mic);
      this.startSpeech();
    }
  }

  private startAudio() {
    if (!this.mic) return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    this.chunks = [];
    const chunks = this.chunks;
    this.media = new MediaRecorder(this.mic, mime ? { mimeType: mime } : undefined);
    this.media.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    this.media.start(1000);
    if (this.paused) this.media.pause();
  }

  private async finishAudio(): Promise<Blob | null> {
    const m = this.media;
    if (!m) return null;
    const chunks = this.chunks;
    return new Promise<Blob>((resolve) => {
      m.onstop = () => resolve(new Blob(chunks, { type: m.mimeType || 'audio/webm' }));
      if (m.state !== 'inactive') m.stop(); else resolve(new Blob(chunks, { type: m.mimeType || 'audio/webm' }));
    });
  }

  private tick() {
    this.ticks += 1;
    if (this.level) this.ev.onLevel?.(this.paused ? 0 : this.level());
    if (this.ticks % SAMPLE_EVERY === 0) void this.sample();
  }

  private level: (() => number) | null = null;

  /** Draw the current screen into a canvas (track grab, else the video). */
  private async draw(w: number, h: number, ctx: CanvasRenderingContext2D) {
    if (this.grabber) {
      try {
        const bmp = await this.grabber.grabFrame();
        ctx.drawImage(bmp, 0, 0, w, h);
        const size = { w: bmp.width, h: bmp.height };
        bmp.close();
        return size;
      } catch { /* fall back to the video element */ }
    }
    if (!this.video || this.video.readyState < 2) return null;
    ctx.drawImage(this.video, 0, 0, w, h);
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  private meter(stream: MediaStream) {
    try {
      this.audioCtx = new AudioContext();
      // Created after awaits, so autoplay policy may start it suspended.
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {});
      const src = this.audioCtx.createMediaStreamSource(stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      this.level = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      };
    } catch { /* meter is cosmetic */ }
  }

  private startSpeech() {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = this.lang;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r[0].transcript.trim();
          if (this.segStart === null) this.segStart = Math.max(0, this.elapsed() - 1);
          if (r.isFinal) {
            if (text) this.segments.push({ start: this.segStart, end: this.elapsed(), text });
            this.segStart = null;
          } else interim += `${text} `;
        }
        this.ev.onTranscript?.([...this.segments], interim.trim());
      };
      rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') this.speechWanted = false; };
      // Recognition stops itself after silence; keep it going while recording.
      rec.onend = () => { if (this.speechWanted && !this.paused && !this.stopped) { try { rec.start(); } catch { /* already started */ } } };
      this.speech = rec;
      this.speechWanted = true;
      rec.start();
    } catch { this.speech = null; }
  }

  private sampling = false;
  private async sample() {
    if (this.paused || this.stopped || this.sampling) return;
    const ctx = this.small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    this.sampling = true;
    let drawn;
    try { drawn = await this.draw(64, 36, ctx); } finally { this.sampling = false; }
    if (!drawn) return;
    const px = ctx.getImageData(0, 0, 64, 36).data;
    const gray = new Uint8ClampedArray(64 * 36);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    let diff = 1;
    if (this.last) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - this.last[i]);
      diff = sum / gray.length / 255;
    }
    const t = this.elapsed();
    if (!this.last || diff > CHANGE_THRESHOLD || t - this.lastKeptT > MAX_GAP_SEC) {
      this.last = gray;
      await this.capture(Math.min(1, diff * 4), drawn);
    }
  }

  private async capture(score: number, size: { w: number; h: number }) {
    if (this.stopped || !size.w || !size.h) return;
    const scale = Math.min(1, MAX_WIDTH / size.w);
    this.full.width = Math.round(size.w * scale);
    this.full.height = Math.round(size.h * scale);
    const ctx = this.full.getContext('2d');
    if (!ctx) return;
    const t = this.elapsed();
    const clip = this.clip; // a frame belongs to the clip it was taken in
    if (!(await this.draw(this.full.width, this.full.height, ctx))) return;
    this.lastKeptT = t;
    this.frames += 1;
    this.clipFrames += 1;
    this.ev.onFrame?.(this.clipFrames);
    this.full.toBlob((blob) => {
      if (!blob) return;
      this.queue = this.queue.then(async () => {
        const res = await fetch(`/api/show2plan/${this.sessionId}/frame?clip=${clip}&t=${t.toFixed(2)}&score=${score.toFixed(3)}&type=image/jpeg`, {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg' }, body: blob,
        }).catch(() => null);
        if (!res || !res.ok) this.uploadErrors += 1;
      });
    }, 'image/jpeg', 0.82);
  }

  pause() {
    if (this.paused) return;
    this.pausedAt = performance.now();
    if (this.media && this.media.state === 'recording') this.media.pause();
    try { this.speech?.stop(); } catch { /* ignore */ }
  }

  resume() {
    if (!this.paused || this.pausedAt === null) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
    if (this.media && this.media.state === 'paused') this.media.resume();
    if (this.speech && this.speechWanted) { try { this.speech.start(); } catch { /* ignore */ } }
  }

  /**
   * End the current clip (one task) and start the next, keeping the screen
   * share and microphone open. Resolves with the finished clip once its
   * screenshots are uploaded.
   */
  async nextClip(): Promise<RecorderResult> {
    const done: RecorderResult = { clip: this.clip, durationSec: this.elapsed(), audio: null, segments: [...this.segments], frames: this.clipFrames, uploadErrors: this.uploadErrors };
    const finishing = this.finishAudio();
    // New clip: fresh clock, transcript and first frame.
    this.clip += 1;
    this.clipFrames = 0;
    this.t0 = performance.now();
    this.pausedTotal = 0;
    if (this.pausedAt !== null) this.pausedAt = this.t0;
    this.segments = [];
    this.segStart = null;
    this.last = null;
    this.lastKeptT = -Infinity;
    done.audio = await finishing;
    this.startAudio();
    await this.queue;
    return done;
  }

  async stop(): Promise<RecorderResult> {
    if (this.paused) this.resume();
    const durationSec = this.elapsed();
    this.stopped = true;
    this.speechWanted = false;
    this.stopTicker?.();
    try { this.speech?.stop(); } catch { /* ignore */ }
    const audio = await this.finishAudio();
    this.release();
    await this.queue;
    return { clip: this.clip, durationSec, audio, segments: this.segments, frames: this.clipFrames, uploadErrors: this.uploadErrors };
  }

  /** Stop every track and free audio resources; safe to call twice. */
  release() {
    this.stopped = true;
    this.stopTicker?.();
    this.stopTicker = null;
    try { this.speech?.abort(); } catch { /* ignore */ }
    for (const s of [this.display, this.mic]) s?.getTracks().forEach((t) => t.stop());
    if (this.video) { this.video.pause(); this.video.srcObject = null; this.video.remove(); this.video = null; }
    try { void this.audioCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null;
  }
}

/** Decode any recorded audio and re-encode it as 16 kHz mono 16-bit WAV. */
export async function toWav16k(blob: Blob): Promise<Blob> {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try { decoded = await ctx.decodeAudioData(buf); } finally { void ctx.close(); }
  const rate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
