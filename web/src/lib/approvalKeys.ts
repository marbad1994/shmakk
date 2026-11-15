// Keyboard shortcuts for a pending approval card.
//
// A pending question owns the keyboard: Y/Enter allows, N/Esc declines. The
// composer normally keeps focus while the question is up, so a plain y/n typed
// there has to answer the question instead of leaking into the draft. Once the
// user has typed something in the composer, the letters belong to them again.

export type ApprovalDecision = 'yes' | 'no' | null;

export interface ApprovalKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  tagName?: string | null;
  /** Current composer text, when the event came from a textarea. */
  value?: string;
}

const TYPING = new Set(['TEXTAREA', 'INPUT']);

export function resolveApprovalKey(e: ApprovalKeyEvent): ApprovalDecision {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  const tag = (e.tagName || '').toUpperCase();
  const typing = TYPING.has(tag);
  // An empty composer is still "typing surface", but y/n there is an answer,
  // not a draft: the caller cancels the keypress so nothing is inserted.
  const emptyComposer = tag === 'TEXTAREA' && !e.value;
  if (typing && !emptyComposer) return null;

  const key = e.key.toLowerCase();
  if (key === 'y') return 'yes';
  if (key === 'n') return 'no';
  // Escape only declines away from text fields; in the composer it means stop.
  if (key === 'escape' && !typing) return 'no';
  return null;
}
