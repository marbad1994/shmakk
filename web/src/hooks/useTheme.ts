import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'system' | 'dark' | 'light';

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.dispatchEvent(new Event('shmakk:theme'));
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem('shmakk.theme') as ThemePref) || 'system');
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (pref === 'system') apply('system'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  const set = useCallback((p: ThemePref) => {
    localStorage.setItem('shmakk.theme', p);
    setPref(p);
    apply(p);
  }, []);
  return [pref, set] as const;
}
