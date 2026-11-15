// Draft text belongs to the conversation or empty space it was typed in, never
// to the composer instance that happens to be mounted. Switching space or
// session mid-run must park the prompt where it was written instead of carrying
// it into the next one.

/** Identity of a composer slot: a conversation, or the empty state of a space. */
export function draftScope(space: string, convId: string | null | undefined) {
  return `${space}:${convId ?? ''}`;
}

/**
 * Park the outgoing draft under the scope we are leaving and hand back the one
 * we are entering. Unknown scopes start empty; revisiting them restores what
 * was typed there.
 */
export function swapDraft<K, V>(drafts: Map<K, V>, from: K, to: K, outgoing: V, empty: V): V {
  if (from === to) return outgoing;
  drafts.set(from, outgoing);
  return drafts.get(to) ?? empty;
}

/**
 * Swap on a scope change, but also cope with a fresh mount: `from` is null the
 * first time the composer renders a slot, so there is nothing to park and the
 * entrance just restores whatever that slot still holds.
 */
export function enterDraft<K, V>(drafts: Map<K, V>, from: K | null, to: K, outgoing: V, empty: V): V {
  if (from === null) return drafts.get(to) ?? empty;
  return swapDraft(drafts, from, to, outgoing, empty);
}

// ── surviving a reload ──────────────────────────────────────────────────────
// The in-memory map covers switching sessions and spaces. It does not cover a
// page reload, so drafts are also mirrored to localStorage, keyed by the same
// scope string. Only text and input mode are stored; staged files stay in
// memory because a base64 image can be many megabytes.

export type DraftMode = 'ask' | 'shell';
export type StoredDraft = { text: string; mode: DraftMode };
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DRAFTS_KEY = 'shmakk:composer-drafts:v1';
const MAX_STORED = 80;

/** localStorage, or null when it is unavailable (SSR, private mode, tests). */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read the saved drafts, ignoring anything corrupt or from an older shape. */
export function loadDrafts(storage: DraftStorage | null | undefined): Map<string, StoredDraft> {
  const drafts = new Map<string, StoredDraft>();
  if (!storage) return drafts;
  try {
    const raw = storage.getItem(DRAFTS_KEY);
    if (!raw) return drafts;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return drafts;
    for (const [scope, value] of Object.entries(saved as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const text = typeof v.text === 'string' ? v.text : '';
      const mode: DraftMode = v.mode === 'shell' ? 'shell' : 'ask';
      if (text || mode !== 'ask') drafts.set(scope, { text, mode });
    }
  } catch {
    // Corrupt payload or storage refusing reads: start clean.
  }
  return drafts;
}

/** Mirror the drafts to storage, dropping empty ones and the oldest overflow. */
export function saveDrafts(storage: DraftStorage | null | undefined, drafts: Iterable<[string, StoredDraft]>): void {
  if (!storage) return;
  try {
    const entries = [...drafts]
      .filter(([, d]) => d.text || d.mode !== 'ask')
      .slice(-MAX_STORED)
      .map(([scope, d]) => [scope, { text: d.text, mode: d.mode }] as const);
    if (!entries.length) storage.setItem(DRAFTS_KEY, '{}');
    else storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Full or blocked storage: drafts still survive in memory.
  }
}

