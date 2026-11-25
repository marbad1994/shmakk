// A clock that keeps ticking when the tab is in the background.
// Timers on a hidden page are throttled (down to once a minute after a few
// minutes), which would stop screenshots while you show another window.
// Dedicated workers are not throttled that way.
let timer: ReturnType<typeof setInterval> | null = null;
self.onmessage = (e: MessageEvent<number>) => {
  if (timer) clearInterval(timer);
  timer = e.data > 0 ? setInterval(() => (self as unknown as Worker).postMessage(0), e.data) : null;
};
