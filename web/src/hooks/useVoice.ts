// Voice in the browser — the GUI counterpart of --stt / --tts / --sts.
//
// Speech-to-text: record from the mic until you stop talking, then transcribe
// with the server's local Whisper model; falls back to the browser's
// SpeechRecognition when the server models are not installed.
// Text-to-speech: server Kokoro voices, falling back to speechSynthesis.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { speakable } from '@/lib/utils';
import { useApp } from '@/store/app';

export type MicState = 'idle' | 'listening' | 'busy';

const SILENCE_MS = 1300;
const MAX_MS = 30000;
const RMS_THRESHOLD = 0.018;

function encodeWav(samples: Float32Array, rate: number) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function toWav16k(blob: Blob) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * 16000);
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return encodeWav(out.getChannelData(0), 16000);
  } finally {
    void ctx.close();
  }
}

interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void;
}

export function useVoice() {
  const features = useApp((s) => s.features);
  const settings = useApp((s) => s.settings);
  const [mic, setMic] = useState<MicState>('idle');
  const [speaking, setSpeaking] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakGen = useRef(0);

  const stopSpeaking = useCallback(() => {
    speakGen.current++;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (markdown: string) => {
    const text = speakable(markdown).slice(0, 3500);
    if (!text) return;
    stopSpeaking();
    const gen = ++speakGen.current;
    setSpeaking(true);
    const done = () => { if (speakGen.current === gen) setSpeaking(false); };
    try {
      if (features.tts) {
        const blob = await api.post<Blob>('/api/voice/speak', { text, voice: settings.ttsVoice || undefined });
        if (speakGen.current !== gen) return;
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        await new Promise<void>((resolve) => {
          audio.onended = audio.onerror = audio.onpause = () => resolve();
          audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(audio.src);
      } else if ('speechSynthesis' in window) {
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(text);
          if (settings.voiceLanguage) u.lang = settings.voiceLanguage;
          u.onend = u.onerror = () => resolve();
          speechSynthesis.speak(u);
        });
      } else {
        toast.error('No text-to-speech available. Run `npm run setup:voice` for local voices.');
      }
    } catch (e) {
      toast.error(`Speech failed: ${(e as Error).message}`);
    } finally {
      done();
    }
  }, [features.tts, settings.ttsVoice, settings.voiceLanguage, stopSpeaking]);

  /** Record one utterance and resolve with its transcript ('' if nothing was said). */
  const listen = useCallback(async (): Promise<string> => {
    if (mic !== 'idle') { stopRef.current?.(); return ''; }
    stopSpeaking();

    if (!features.stt) {
      const Ctor = (window as unknown as Record<string, new () => SpeechRecognitionLike>).SpeechRecognition
        || (window as unknown as Record<string, new () => SpeechRecognitionLike>).webkitSpeechRecognition;
      if (!Ctor) { toast.error('Speech-to-text is not available. Run `npm run setup:voice` to install the local Whisper model.'); return ''; }
      return new Promise<string>((resolve) => {
        const rec = new Ctor();
        let text = '';
        rec.lang = settings.voiceLanguage || navigator.language;
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (e) => { text = e.results[0][0].transcript; };
        rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast.error(`Mic: ${e.error}`); };
        rec.onend = () => { setMic('idle'); stopRef.current = null; resolve(text.trim()); };
        stopRef.current = () => rec.stop();
        setMic('listening');
        rec.start();
      });
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast.error('Microphone access was denied.');
      return '';
    }
    setMic('listening');
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const heard = await new Promise<boolean>((resolve) => {
      const data = new Float32Array(analyser.fftSize);
      const started = performance.now();
      let lastVoice = 0;
      let spoke = false;
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearInterval(timer); recorder.onstop = () => resolve(spoke); recorder.stop(); };
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const x of data) sum += x * x;
        const now = performance.now();
        if (Math.sqrt(sum / data.length) > RMS_THRESHOLD) { spoke = true; lastVoice = now; }
        if ((spoke && now - lastVoice > SILENCE_MS) || now - started > MAX_MS || (!spoke && now - started > 8000)) finish();
      }, 80);
      stopRef.current = finish;
      recorder.start(250);
    });
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    stopRef.current = null;
    if (!heard || !chunks.length) { setMic('idle'); return ''; }

    setMic('busy');
    try {
      const wav = await toWav16k(new Blob(chunks, { type: recorder.mimeType }));
      const lang = settings.voiceLanguage ? `?language=${encodeURIComponent(settings.voiceLanguage)}` : '';
      const r = await api.upload<{ text: string }>(`/api/voice/transcribe${lang}`, wav, 'audio/wav');
      return (r.text || '').trim();
    } catch (e) {
      toast.error(`Transcription failed: ${(e as Error).message}`);
      return '';
    } finally {
      setMic('idle');
    }
  }, [features.stt, mic, settings.voiceLanguage, stopSpeaking]);

  const cancelListening = useCallback(() => stopRef.current?.(), []);
  useEffect(() => () => { stopRef.current?.(); stopSpeaking(); }, [stopSpeaking]);

  return { mic, speaking, listen, cancelListening, speak, stopSpeaking };
}
