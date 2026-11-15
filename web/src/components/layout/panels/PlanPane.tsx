import { ListChecks } from 'lucide-react';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/button';
import { Empty, Spinner } from '@/components/ui/misc';
import { PlanDetail, PlanList, usePlans } from '@/components/work/PlanBoard';

/** The plan you are most likely watching: running first, then needing you, then newest. */
export function PlanPane() {
  const { data, isLoading } = usePlans();
  const focus = useApp((s) => s.focusPlanId);
  const openPlan = useApp((s) => s.openPlan);
  const setView = useApp((s) => s.setView);
  const plans = data?.plans ?? [];
  if (isLoading) return <div className="grid h-full place-items-center"><Spinner className="size-5" /></div>;
  if (!plans.length) return <div className="p-4"><Empty icon={<ListChecks />} title="No plans yet">Big requests, Show &amp; tell recordings and Edit in browser all turn into plans here.</Empty></div>;
  const rank = (s: string) => (s === 'running' ? 0 : s === 'needs_attention' || s === 'awaiting_review' ? 1 : s === 'queued' || s === 'paused' || s === 'draft' ? 2 : 3);
  const current = (focus && plans.find((p) => p.id === focus)) || [...plans].sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt)[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <PlanDetail key={current.id} planId={current.id} compact />
        {plans.length > 1 ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-[12.5px] text-dim">Other plans ({plans.length - 1})</summary>
            <div className="mt-2"><PlanList plans={plans.filter((p) => p.id !== current.id)} selected={null} onSelect={(id) => useApp.setState({ focusPlanId: id })} /></div>
          </details>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-line px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => { openPlan(current.id); setView('plan'); }}>Open in Plans</Button>
      </div>
    </div>
  );
}
