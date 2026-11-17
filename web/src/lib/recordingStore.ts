// Show & tell recording state, kept outside the dialog: while you record, the
// dialog is closed and only the floating control bar (and its pop-out window)
// is on screen. "Next task" ends the current clip and sends it for analysis in
// the background, so each task is analysed while you keep recording.

import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ScreenRecorder, toWav16k, type LiveSegment, type RecorderResult } from '@/lib/recorder';

export type Deliverable = 'tasks' | 'automation';
export type RecPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'review';

/** A clip as the client knows it; the server status adds analysis progress. */
export interface ClipInfo { n: number; state: 'uploading' | 'sent' | 'skipped' | 'failed'; durationSec: number; error?: string }

interface RecordingState {
  phase: RecPhase;
  deliverable: Deliverable;
  sessionId: string | null;
  clip: number;           // index of the clip being recorded
  paused: boolean;
  startedAt: number;      // performance.now() of the current clip, for the timer
  pausedMs: number;
  pausedAt: number | null;
  level: number;
  frames: number;         // screenshots kept in the current clip
  segments: LiveSegment[];
  interim: string;
  micNote: string | null;
  error: string | null;
  clips: ClipInfo[];      // finished clips
  start(opts: { microphone: boolean; deliverable: Deliverable; lang: string }): Promise<boolean>;
  togglePause(): void;
  next(): Promise<void>;
  stop(): Promise<void>;
  discard(): void;
  elapsed(): number;
}

let recorder: ScreenRecorder | null = null;

/** A clip with no speech and almost no screen activity is not a task. */
function isEmpty(r: RecorderResult) {
  return r.durationSec < 2 && !r.segments.length;
}

export const useRecording = create<RecordingState>((set, get) => {
  async function send(r: RecorderResult) {
    const { sessionId, deliverable } = get();
    if (!sessionId) return;
    if (isEmpty(r)) {
      set((s) => ({ clips: [...s.clips, { n: r.clip, state: 'skipped', durationSec: r.durationSec }] }));
      return;
    }
    set((s) => ({ clips: [...s.clips, { n: r.clip, state: 'uploading', durationSec: r.durationSec }] }));
    const mark = (patch: Partial<ClipInfo>) => set((s) => ({ clips: s.clips.map((c) => (c.n === r.clip ? { ...c, ...patch } : c)) }));
    try {
      if (r.audio && r.audio.size > 2000) {
        try {
          const wav = await toWav16k(r.audio);
          await api.upload(`/api/show2plan/${sessionId}/audio?clip=${r.clip}`, wav, 'audio/wav');
        } catch { /* the live transcript is the fallback */ }
      }
      await api.post(`/api/show2plan/${sessionId}/process`, {
        clip: r.clip,
        mode: deliverable,
        oneRequest: true,
        durationSec: r.durationSec,
        liveTranscript: { segments: r.segments },
      });
      mark({ state: 'sent' });
    } catch (e) {
      mark({ state: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  const reset = () => set({
    phase: 'idle', sessionId: null, clip: 0, paused: false, startedAt: 0, pausedMs: 0, pausedAt: null, level: 0, frames: 0,
    segments: [], interim: '', micNote: null, error: null, clips: [],
  });

  return {
    phase: 'idle', deliverable: 'tasks', sessionId: null, clip: 0, paused: false, startedAt: 0, pausedMs: 0, pausedAt: null,
    level: 0, frames: 0, segments: [], interim: '', micNote: null, error: null, clips: [],

    elapsed() {
      const s = get();
      if (!s.startedAt) return 0;
      const now = s.pausedAt ?? performance.now();
      return Math.max(0, (now - s.startedAt - s.pausedMs) / 1000);
    },

    async start({ microphone, deliverable, lang }) {
      if (get().phase !== 'idle' && get().phase !== 'review') return false;
      if (get().sessionId) { const old = get().sessionId; void api.del(`/api/show2plan/${old}`).catch(() => {}); }
      reset();
      set({ phase: 'starting', deliverable });
      let id: string | null = null;
      try {
        const s = await api.post<{ id: string }>('/api/show2plan');
        id = s.id;
        set({ sessionId: id });
        const rec = new ScreenRecorder(id, {
          onFrame: (n) => set({ frames: n }),
          onLevel: (level) => set({ level }),
          onTranscript: (segments, interim) => set({ segments, interim }),
          onEnded: () => { void get().stop(); },
          onError: (micNote) => set({ micNote }),
        }, lang);
        await rec.start({ microphone });
        recorder = rec;
        set({ phase: 'recording', startedAt: performance.now(), pausedMs: 0, pausedAt: null });
        return true;
      } catch (e) {
        recorder?.release();
        recorder = null;
        if (id) void api.del(`/api/show2plan/${id}`).catch(() => {});
        const msg = e instanceof Error ? e.message : String(e);
        reset();
        set({ error: /denied|NotAllowed|Permission/i.test(msg) ? 'Screen sharing was cancelled or blocked. Click Start and choose a screen, window or tab to share.' : msg });
        return false;
      }
    },

    togglePause() {
      if (!recorder || get().phase !== 'recording') return;
      if (recorder.paused) {
        recorder.resume();
        const { pausedAt, pausedMs } = get();
        set({ paused: false, pausedAt: null, pausedMs: pausedMs + (pausedAt ? performance.now() - pausedAt : 0) });
      } else {
        recorder.pause();
        set({ paused: true, pausedAt: performance.now() });
      }
    },

    async next() {
      if (!recorder || get().phase !== 'recording' || get().deliverable === 'automation') return;
      const paused = get().paused;
      set({ clip: get().clip + 1, frames: 0, segments: [], interim: '', startedAt: performance.now(), pausedMs: 0, pausedAt: paused ? performance.now() : null });
      const r = await recorder.nextClip();
      void send(r);
      if (!isEmpty(r)) toast(`Task ${r.clip + 1} sent for analysis`, { duration: 1800 });
    },

    async stop() {
      if (!recorder || get().phase !== 'recording') return;
      set({ phase: 'finishing' });
      const rec = recorder;
      recorder = null;
      const r = await rec.stop();
      await send(r);
      set({ phase: 'review', level: 0 });
    },

    discard() {
      recorder?.release();
      recorder = null;
      const id = get().sessionId;
      if (id) void api.del(`/api/show2plan/${id}`).catch(() => {});
      reset();
    },
  };
});

/** The live screen stream, for a preview. */
export function recordingStream() { return recorder?.stream ?? null; }
