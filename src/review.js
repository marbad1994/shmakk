// Y/n prompt with cooperative cancellation. The returned `ask` accepts an
// optional `{ onCancel, onWhy, notifyBody }` object.  When `notifyBody` is
// provided it is used as the desktop notification text instead of the
// terminal-only `question` string.

function makePrompter(pty, write, opts = {}) {
  return function ask(question, defaultYes, { onCancel, onWhy, notifyBody } = {}) {
    return new Promise((resolve) => {
      const tag = defaultYes ? '[Y/n/?]' : '[y/N/?]';
      write(`${question} ${tag} `);
      let buf = '';

      function finishYesNo(ans) {
        write('\n');
        release();
        return resolve(ans);
      }

      // Notification with Yes/No buttons races against terminal input
      let notifResult = null;
      if (opts.notify) {
        try {
          const { notifyAsk } = require('./notify');
          const raw = notifyBody || question || '';
          const clean = typeof raw === 'string'
            ? raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
            : String(raw || '').trim();

          // Summary: short label. Body: the full command/description.
          const summary = clean.length > 60 ? clean.slice(0, 57) + '…' : (clean || 'shmakk');
          notifResult = notifyAsk(summary, clean.slice(0, 200));

          notifResult.promise.then((action) => {
            if (action === 'yes') {
              release();
              write('\n\x1b[2m[approved via notification]\x1b[0m\n');
              resolve(true);
            } else if (action === 'no') {
              release();
              write('\n\x1b[2m[declined via notification]\x1b[0m\n');
              resolve(false);
            }
            // null = dismissed: keep waiting for terminal input
          });
        } catch {}
      }

      const release = pty.captureStdin((data) => {
        for (const ch of data.toString('utf8')) {
          const code = ch.charCodeAt(0);
          if (!buf && (ch === 'y' || ch === 'Y')) {
            if (notifResult) notifResult.cancel();
            return finishYesNo(true);
          }
          if (!buf && (ch === 'n' || ch === 'N')) {
            if (notifResult) notifResult.cancel();
            return finishYesNo(false);
          }
          if (!buf && ch === '?') {
            write('\n');
            if (onWhy) onWhy();
            write(`${question} ${tag} `);
            continue;
          }
          if (ch === '\r' || ch === '\n') {
            write('\n');
            const ans = buf.trim().toLowerCase();
            if (!ans) {
              release();
              return resolve(defaultYes);
            }
            if (ans === '?') {
              if (onWhy) onWhy();
              buf = '';
              write(`${question} ${tag} `);
              return;
            }
            if (notifResult) notifResult.cancel();
            release();
            return resolve(ans === 'y' || ans === 'yes');
          }
          if (code === 0x7f || code === 0x08) {
            if (buf.length) { buf = buf.slice(0, -1); write('\b \b'); }
          } else if (code === 0x03) { // Ctrl-C
            write('^C\n');
            if (notifResult) notifResult.cancel();
            release();
            if (onCancel) onCancel();
            return resolve(false);
          } else if (code >= 0x20) {
            buf += ch;
            write(ch);
          }
        }
      });
    });
  };
}

function decisionBanner({ input, decision, mode }) {
  const lines = [];
  lines.push('');
  lines.push('\x1b[36m── shmakk ──\x1b[0m');
  lines.push(`  input:    ${input}`);
  lines.push(`  category: ${decision.category}`);
  if (decision.proposed) lines.push(`  proposed: ${decision.proposed}`);
  lines.push(`  safety:   ${decision.safety}`);
  if (decision.reason) lines.push(`  reason:   ${decision.reason}`);
  if (mode === 'review') {
    const wouldAuto = decision.safety === 'safe' && decision.category === 'command_correction';
    lines.push(`  auto-mode: ${wouldAuto ? 'would auto-run' : 'would ask confirmation'}`);
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { makePrompter, decisionBanner };
