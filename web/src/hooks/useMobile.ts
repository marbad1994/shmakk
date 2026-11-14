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
    const update = () => {
      document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
      // iOS scrolls the page to reveal the focused field; undo that, we handle it.
      if (window.scrollY) window.scrollTo(0, 0);
      const open = window.innerHeight - vv.height > 120 || (isTouch() && vv.height < screen.height * 0.6);
      if (open !== last) { last = open; onKeyboard(open); }
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
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
      tracking = open ? true : t.clientX < 28;
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
