// Runs before first paint so the saved theme never flashes. Kept as a file
// (not inline) so the page can ship a strict Content-Security-Policy.
(function () {
  try {
    var pref = localStorage.getItem('shmakk.theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (window.shmakkDesktop) {
      document.documentElement.classList.add('is-desktop');
      if (window.shmakkDesktop.platform === 'darwin') document.documentElement.classList.add('is-mac');
    }
  } catch (e) {}
})();
