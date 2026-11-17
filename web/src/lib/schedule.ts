// Friendly schedule ⇄ cron. The server only understands 5-field cron; this
// lets people pick "weekdays at 09:00" without learning it.

export type Freq = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron';
export interface Schedule { freq: Freq; every: number; time: string; days: number[]; dayOfMonth: number; cron: string }

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const defaultSchedule = (): Schedule => ({ freq: 'weekdays', every: 15, time: '09:00', days: [1], dayOfMonth: 1, cron: '0 9 * * 1-5' });

export function toCron(s: Schedule): string {
  const [h, m] = s.time.split(':').map((x) => Number(x) || 0);
  switch (s.freq) {
    case 'minutes': return `*/${Math.max(1, Math.min(59, s.every || 15))} * * * *`;
    case 'hourly': return `${m} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${(s.days.length ? [...s.days].sort() : [1]).join(',')}`;
    case 'monthly': return `${m} ${h} ${Math.max(1, Math.min(31, s.dayOfMonth || 1))} * *`;
    default: return s.cron.trim();
  }
}

/** Best-effort inverse, so editing an automation shows the friendly form again. */
export function fromCron(cron: string): Schedule {
  const base = { ...defaultSchedule(), cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return { ...base, freq: 'cron' };
  const [mi, h, dom, mon, dow] = f;
  const num = (x: string) => /^\d+$/.test(x);
  const time = num(mi) && num(h) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : base.time;
  if (mon !== '*') return { ...base, freq: 'cron' };
  const step = /^\*\/(\d+)$/.exec(mi);
  if (step && h === '*' && dom === '*' && dow === '*') return { ...base, freq: 'minutes', every: Number(step[1]) };
  if (num(mi) && h === '*' && dom === '*' && dow === '*') return { ...base, freq: 'hourly', time: `00:${mi.padStart(2, '0')}` };
  if (num(mi) && num(h) && dom === '*') {
    if (dow === '*') return { ...base, freq: 'daily', time };
    if (dow === '1-5') return { ...base, freq: 'weekdays', time };
    if (/^[0-6](,[0-6])*$/.test(dow)) return { ...base, freq: 'weekly', time, days: dow.split(',').map(Number) };
  }
  if (num(mi) && num(h) && num(dom) && dow === '*') return { ...base, freq: 'monthly', time, dayOfMonth: Number(dom) };
  return { ...base, freq: 'cron' };
}

export function describe(s: Schedule): string {
  switch (s.freq) {
    case 'minutes': return `Every ${s.every} minutes`;
    case 'hourly': return `Every hour at :${s.time.split(':')[1]}`;
    case 'daily': return `Every day at ${s.time}`;
    case 'weekdays': return `Weekdays at ${s.time}`;
    case 'weekly': return `${(s.days.length ? [...s.days].sort() : [1]).map((d) => DAY_NAMES[d]).join(', ')} at ${s.time}`;
    case 'monthly': return `Day ${s.dayOfMonth} of every month at ${s.time}`;
    default: return `cron ${s.cron}`;
  }
}
