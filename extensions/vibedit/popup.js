// shmakk Browser Automator extension — popup script
// Shows connection status and port info.

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const portEl = document.getElementById('port');

chrome.storage.local.get(['browserAutomatorPort', 'vibeditPort'], (data) => {
  const port = data['browserAutomatorPort'] || data['vibeditPort'] || 3947;
  portEl.textContent = 'Port: ' + port;
});

// Ask the background for current connection status
chrome.runtime.sendMessage({ type: 'register' }, (resp) => {
  if (chrome.runtime.lastError) {
    statusText.textContent = 'Extension error';
    return;
  }
  if (resp && resp.connected) {
    dot.classList.add('on');
    statusText.textContent = 'Connected to browser-daemon';
  } else {
    statusText.textContent = 'Not connected (run shmakk browser-daemon)';
  }
});
