import { describe, expect, it } from 'vitest';
import { DRAFTS_KEY, draftScope, enterDraft, loadDrafts, saveDrafts, swapDraft, type StoredDraft } from './composerDraft';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

describe('draftScope', () => {
  it('separates spaces and their empty slots', () => {
    expect(draftScope('code', 'abc')).toBe('code:abc');
    expect(draftScope('code', null)).toBe('code:');
    expect(draftScope('design', '')).toBe('design:');
    expect(draftScope('code', null)).not.toBe(draftScope('design', null));
  });
});

describe('swapDraft', () => {
  it('parks the outgoing prompt and leaves the new scope empty', () => {
    const drafts = new Map<string, string>();
    expect(swapDraft(drafts, 'code:a', 'code:', 'half typed', '')).toBe('');
    expect(drafts.get('code:a')).toBe('half typed');
  });

  it('does not leak a prompt into a different space', () => {
    const drafts = new Map<string, string>();
    swapDraft(drafts, 'code:a', 'chat:', 'fix the sidebar', '');
    expect(swapDraft(drafts, 'chat:', 'design:', '', '')).toBe('');
  });

  it('restores the draft of a scope you come back to', () => {
    const drafts = new Map<string, string>();
    swapDraft(drafts, 'code:a', 'code:b', 'for a', '');
    expect(swapDraft(drafts, 'code:b', 'code:a', '', '')).toBe('for a');
  });

  it('keeps attachments with their own draft object', () => {
    const drafts = new Map<string, object>();
    const a = { text: 'x', files: ['one.png'] };
    const empty = { text: '', files: [] };
    swapDraft(drafts, 'code:a', 'code:b', a, empty);
    expect(swapDraft(drafts, 'code:b', 'code:a', empty, empty)).toBe(a);
  });

  it('keeps the live prompt when the scope did not change', () => {
    const drafts = new Map<string, string>([['code:a', 'kept']]);
    expect(swapDraft(drafts, 'code:a', 'code:a', 'edited', '')).toBe('edited');
  });
});

describe('enterDraft', () => {
  it('restores a parked slot on a fresh mount without parking anything', () => {
    const drafts = new Map<string, string>([['design:', 'coffee']]);
    expect(enterDraft(drafts, null, 'design:', '', '')).toBe('coffee');
    expect(drafts.size).toBe(1);
  });

  it('falls back to the empty draft for a slot never visited', () => {
    expect(enterDraft(new Map(), null, 'code:', '', '')).toBe('');
  });

  it('behaves like swapDraft once a scope is known', () => {
    const drafts = new Map<string, string>();
    expect(enterDraft(drafts, 'code:a', 'design:', 'half typed', '')).toBe('');
    expect(drafts.get('code:a')).toBe('half typed');
  });
});

describe('loadDrafts', () => {
  it('starts empty without storage', () => {
    expect(loadDrafts(null).size).toBe(0);
    expect(loadDrafts(undefined).size).toBe(0);
  });

  it('round-trips text and mode through storage', () => {
    const storage = fakeStorage();
    const drafts = new Map<string, StoredDraft>([
      ['code:a', { text: 'fix the sidebar', mode: 'ask' }],
      ['code:', { text: 'git status', mode: 'shell' }],
    ]);
    saveDrafts(storage, drafts);
    expect(loadDrafts(storage)).toEqual(drafts);
    expect(storage.data.get(DRAFTS_KEY)).toBeTruthy();
  });

  it('survives a corrupt payload', () => {
    expect(loadDrafts(fakeStorage({ [DRAFTS_KEY]: 'not json' })).size).toBe(0);
  });

  it('skips entries that are not draft objects', () => {
    const storage = fakeStorage({ [DRAFTS_KEY]: JSON.stringify({ a: null, b: 'x', c: { text: 'ok' } }) });
    const loaded = loadDrafts(storage);
    expect(loaded.get('c')).toEqual({ text: 'ok', mode: 'ask' });
    expect(loaded.has('a')).toBe(false);
    expect(loaded.has('b')).toBe(false);
  });

  it('treats an unknown mode as ask', () => {
    const storage = fakeStorage({ [DRAFTS_KEY]: JSON.stringify({ 'code:a': { text: 'hi', mode: 'weird' } }) });
    expect(loadDrafts(storage).get('code:a')?.mode).toBe('ask');
  });
});

describe('saveDrafts', () => {
  it('drops empty drafts so a reload does not resurrect a sent prompt', () => {
    const storage = fakeStorage();
    saveDrafts(storage, new Map<string, StoredDraft>([
      ['code:a', { text: '', mode: 'ask' }],
      ['code:b', { text: 'keep me', mode: 'ask' }],
    ]));
    const loaded = loadDrafts(storage);
    expect(loaded.has('code:a')).toBe(false);
    expect(loaded.get('code:b')?.text).toBe('keep me');
  });

  it('keeps a shell-mode slot even when it is empty', () => {
    const storage = fakeStorage();
    saveDrafts(storage, new Map<string, StoredDraft>([['code:', { text: '', mode: 'shell' }]]));
    expect(loadDrafts(storage).get('code:')).toEqual({ text: '', mode: 'shell' });
  });

  it('only writes text and mode, never staged files', () => {
    const storage = fakeStorage();
    const withFiles = { text: 'hello', mode: 'ask' as const, files: [{ name: 'big.png', data: 'A'.repeat(100) }] };
    saveDrafts(storage, new Map([['code:a', withFiles]]));
    const raw = storage.getItem(DRAFTS_KEY) || '';
    expect(raw).not.toContain('big.png');
    expect(JSON.parse(raw)['code:a']).toEqual({ text: 'hello', mode: 'ask' });
  });

  it('caps how many slots it keeps', () => {
    const storage = fakeStorage();
    const many = new Map<string, StoredDraft>();
    for (let i = 0; i < 120; i++) many.set(`code:${i}`, { text: `draft ${i}`, mode: 'ask' });
    saveDrafts(storage, many);
    const loaded = loadDrafts(storage);
    expect(loaded.size).toBe(80);
    expect(loaded.has('code:0')).toBe(false);
    expect(loaded.has('code:119')).toBe(true);
  });

  it('does nothing without storage', () => {
    expect(() => saveDrafts(null, new Map())).not.toThrow();
  });
});
