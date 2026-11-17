import { browserStorage, type DraftStorage } from './composerDraft';

/**
 * Which project folders are unfolded in the sidebar. The state lives in
 * localStorage so a reload (or a restart of the web UI) keeps the folders the
 * way the user left them; the list itself is derived from the project ids.
 */

export const OPEN_PROJECTS_KEY = 'shmakk:open-projects:v1';

/** Read the unfolded project ids, ignoring anything corrupt or from an older shape. */
export function loadOpenProjects(storage: DraftStorage | null | undefined = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(OPEN_PROJECTS_KEY);
    if (!raw) return [];
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const ids = saved.filter((x): x is string => typeof x === 'string' && !!x);
    return [...new Set(ids)];
  } catch {
    // Corrupt payload or storage refusing reads: every folder starts folded.
    return [];
  }
}

/** Mirror the unfolded ids to storage. */
export function saveOpenProjects(ids: string[], storage: DraftStorage | null | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(OPEN_PROJECTS_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or quota: folding still works for this page load.
  }
}

/** Unfold a folded project, fold an unfolded one; the rest stay as they are. */
export function toggleOpenProject(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Chats filed under a project, newest first, keyed by project id. */
export function sessionsByProject<T extends { projectId: string | null; updatedAt?: number }>(convs: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const c of convs) {
    if (!c.projectId) continue;
    const list = map.get(c.projectId);
    if (list) list.push(c); else map.set(c.projectId, [c]);
  }
  for (const list of map.values()) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return map;
}
