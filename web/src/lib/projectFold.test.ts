import { describe, expect, it } from 'vitest';
import { OPEN_PROJECTS_KEY, loadOpenProjects, saveOpenProjects, sessionsByProject, toggleOpenProject } from './projectFold';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

describe('open project folders', () => {
  it('starts with every folder folded', () => {
    expect(loadOpenProjects(fakeStorage())).toEqual([]);
    expect(loadOpenProjects(null)).toEqual([]);
  });

  it('survives a reload', () => {
    const storage = fakeStorage();
    saveOpenProjects(['p2', 'p1'], storage);
    expect(loadOpenProjects(storage)).toEqual(['p2', 'p1']);
  });

  it('ignores corrupt or foreign payloads', () => {
    expect(loadOpenProjects(fakeStorage({ [OPEN_PROJECTS_KEY]: 'not json' }))).toEqual([]);
    expect(loadOpenProjects(fakeStorage({ [OPEN_PROJECTS_KEY]: '{"p1":true}' }))).toEqual([]);
    expect(loadOpenProjects(fakeStorage({ [OPEN_PROJECTS_KEY]: '["p1",7,null,"",  "p1"]' }))).toEqual(['p1']);
  });

  it('toggles one project and leaves the others alone', () => {
    expect(toggleOpenProject([], 'p1')).toEqual(['p1']);
    expect(toggleOpenProject(['p1', 'p2'], 'p1')).toEqual(['p2']);
    expect(toggleOpenProject(['p1', 'p2'], 'p3')).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('sessionsByProject', () => {
  it('groups chats and keeps the newest first', () => {
    const map = sessionsByProject([
      { id: 'old', projectId: 'p1', updatedAt: 1 },
      { id: 'free', projectId: null, updatedAt: 9 },
      { id: 'new', projectId: 'p1', updatedAt: 5 },
    ]);
    expect(map.get('p1')?.map((c) => c.id)).toEqual(['new', 'old']);
    expect([...map.keys()]).toEqual(['p1']);
  });
});
