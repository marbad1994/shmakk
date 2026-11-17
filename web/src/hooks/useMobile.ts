import { useEffect, useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(cb: () => void) {
  const mq = matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** True on phone-sized viewports (matches Tailwind's `max-md:`). */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => matchMedia(QUERY).matches, () => false);
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;

/** Light haptic tick where the platform supports it (Android; iOS ignores it). */
export function haptic(ms = 8) {
  try { if (isTouch()) navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

/**
 * Keeps the layout glued to the *visual* viewport. On iOS the layout viewport
 * doesn't shrink when the keyboard opens, so without this the composer would
 * sit underneath it. Also reports whether the keyboard is up.
 */
export function useVisualViewport(onKeyboard: (open: boolean) => void) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let last = false;
    let frame = 0;
    let baseline = vv.height;
    let orientation = window.screen.orientation?.angle ?? window.orientation;
    const update = () => {
      const angle = window.screen.orientation?.angle ?? window.orientation;
      if (angle !== orientation) { baseline = vv.height; orientation = angle; }
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement &&
        (focused.matches('input, textarea, [contenteditable="true"]') || !!focused.closest('.xterm'));
      if (!editing) baseline = vv.height;
      else baseline = Math.max(baseline, vv.height);
      // Only a focused editor and a meaningful viewport reduction indicate a keyboard.
      // Screen height is deliberately excluded: landscape and split-screen are smaller too.
      const open = editing && Math.max(baseline - vv.height, window.innerHeight - vv.height) > 120;
      const root = document.documentElement;
      root.style.setProperty('--app-h', `${vv.height}px`);
      root.style.setProperty('--app-top', `${vv.offsetTop}px`);
      root.style.setProperty('--app-bottom', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
      root.dataset.keyboard = open ? 'open' : 'closed';
      if (open !== last) { last = open; onKeyboard(open); }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      for (const key of ['--app-h', '--app-top', '--app-bottom']) document.documentElement.style.removeProperty(key);
      delete document.documentElement.dataset.keyboard;
    };
  }, [onKeyboard]);
}

/** Edge-swipe to open and swipe-left to close a left drawer. */
export function useDrawerSwipe(open: boolean, setOpen: (v: boolean) => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      tracking = e.touches.length === 1 && (open
        ? e.target instanceof Element && !!e.target.closest('[aria-label="Navigation"]')
        : t.clientX < 28 && !(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable], .xterm')));
      startX = t.clientX;
      startY = t.clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (Math.abs(dx) < 56 || dy > Math.abs(dx)) return;
      if (!open && dx > 0) setOpen(true);
      else if (open && dx < 0) setOpen(false);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => { window.removeEventListener('touchstart', onStart); window.removeEventListener('touchend', onEnd); };
  }, [open, setOpen, enabled]);
}
