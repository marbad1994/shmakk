// Y/n prompt with cooperative cancellation. The returned `ask` accepts an
// optional `{ onCancel }` callback that fires when the user hits Ctrl-C.

function makePrompter(pty, write) {
  return function ask(question, defaultYes, { onCancel, onWhy } = {}) {
    return new Promise((resolve) => {
      const tag = defaultYes ? '[Y/n/?]' : '[y/N/?]';
      write(`${question} ${tag} `);
      let buf = '';
      function finishYesNo(ans) {
        write('\n');
        release();
        return resolve(ans);
      }
      const release = pty.captureStdin((data) => {
        for (const ch of data.toString('utf8')) {
          const code = ch.charCodeAt(0);
          if (!buf && (ch === 'y' || ch === 'Y')) return finishYesNo(true);
          if (!buf && (ch === 'n' || ch === 'N')) return finishYesNo(false);
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
            release();
            return resolve(ans === 'y' || ans === 'yes');
          }
          if (code === 0x7f || code === 0x08) {
            if (buf.length) { buf = buf.slice(0, -1); write('\b \b'); }
          } else if (code === 0x03) { // Ctrl-C
            write('^C\n');
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
