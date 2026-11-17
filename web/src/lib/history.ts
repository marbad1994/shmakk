import type { ConvMeta, Mode } from '@/lib/types';
import { dayBucket } from '@/lib/utils';

export interface HistoryGroup {
  label: string;
  list: ConvMeta[];
}

/**
 * The sidebar history: pinned chats first, then time buckets, then automation
 * runs. Chats that belong to a project live under that project instead, so they
 * are left out here; the project view is the way back to them.
 */
export function historyGroups(convs: ConvMeta[], mode: Mode): HistoryGroup[] {
  const mine = convs.filter((c) => c.mode === mode && !c.projectId);
  const out: HistoryGroup[] = [];
  const pinned = mine.filter((c) => c.pinned);
  if (pinned.length) out.push({ label: 'Pinned', list: pinned });
  const autoRuns = mine.filter((c) => !c.pinned && c.automationId);
  for (const c of mine.filter((x) => !x.pinned && !x.automationId)) {
    const label = dayBucket(c.updatedAt);
    const g = out.find((x) => x.label === label);
    if (g) g.list.push(c); else out.push({ label, list: [c] });
  }
  if (autoRuns.length) out.push({ label: 'Automation runs', list: autoRuns.slice(0, 15) });
  return out;
}
