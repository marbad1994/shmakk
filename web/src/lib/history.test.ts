import { describe, expect, it } from 'vitest';
import { historyGroups } from './history';
import type { ConvMeta } from './types';

const conv = (id: string, over: Partial<ConvMeta> = {}): ConvMeta => ({
  id, title: id, createdAt: Date.now(), updatedAt: Date.now(), pinned: false,
  workspace: null, preview: '', mode: 'code', projectId: null, automationId: null, ...over,
});

describe('historyGroups', () => {
  it('leaves project chats out of the time buckets', () => {
    const groups = historyGroups([conv('free'), conv('filed', { projectId: 'p1' })], 'code');
    expect(groups.flatMap((g) => g.list.map((c) => c.id))).toEqual(['free']);
  });

  it('hides project chats from pinned and automation runs too', () => {
    const old = Date.now() - 3 * 86400e3;
    const groups = historyGroups([
      conv('pin', { pinned: true }),
      conv('pin-filed', { pinned: true, projectId: 'p1' }),
      conv('run', { automationId: 'a1', updatedAt: old }),
      conv('run-filed', { automationId: 'a1', updatedAt: old, projectId: 'p1' }),
    ], 'code');
    expect(groups.map((g) => [g.label, g.list.map((c) => c.id)])).toEqual([
      ['Pinned', ['pin']],
      ['Automation runs', ['run']],
    ]);
  });

  it('keeps other modes and freed chats', () => {
    const groups = historyGroups([
      conv('code-chat'),
      conv('design-chat', { mode: 'design' }),
      conv('back-home', { projectId: null }),
    ], 'code');
    const ids = groups.flatMap((g) => g.list.map((c) => c.id));
    expect(ids).toEqual(['code-chat', 'back-home']);
  });
});
