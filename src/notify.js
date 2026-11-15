// Desktop notification support via notify-send (libnotify).
// Falls back silently if notify-send is not available or no notification
// daemon is running.

const { execFile, execFileSync } = require('child_process');
const { existsSync } = require('fs');

const NOTIFY_BIN = 'notify-send';

function available() {
  try {
    if (existsSync('/usr/bin/notify-send')) return true;
    if (existsSync('/usr/local/bin/notify-send')) return true;
    execFileSync('command', ['-v', NOTIFY_BIN], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Fire a desktop notification. Never throws — failures are silent.
// Delegates to a subprocess so the main loop isn't blocked.
function notify(summary, body, urgency) {
  if (!available()) return;
  const args = [summary || 'shmakk'];
  if (body) args.push(body);
  args.push('--app-name=shmakk', '--category=im.received');
  if (urgency === 'critical') args.push('--urgency=critical');
  if (urgency === 'low') args.push('--urgency=low');
  execFile(NOTIFY_BIN, args, (err) => {
    void err;
  });
}

// Interactive notification with Yes/No action buttons.
// Returns { promise, proc } where:
//   promise resolves to 'yes', 'no', or null (dismissed/error)
//   proc is the child process (call .kill() to cancel)
function notifyAsk(summary, body) {
  if (!available()) return { promise: Promise.resolve(null), proc: null };

  const args = [
    summary || 'shmakk',
    body || '',
    '--app-name=shmakk',
    '--category=im.received',
    '--urgency=critical',
    '--expire-time=30000',
    '--action=yes=Yes',
    '--action=no=No',
    '--wait',
  ];

  let settled = false;
  let proc;

  const promise = new Promise((resolve) => {
    proc = execFile(NOTIFY_BIN, args, { timeout: 60000, encoding: 'utf8' }, (err, stdout) => {
      if (settled) return;
      settled = true;
      if (err) {
        resolve(null);
        return;
      }
      const action = (stdout || '').trim().toLowerCase();
      if (action === 'yes' || action === 'no') {
        resolve(action);
      } else {
        resolve(null);
      }
    });
  });

  return {
    promise,
    get proc() { return proc; },
    cancel() {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
    },
  };
}

module.exports = { notify, notifyAsk, available };
