// OSC marker emitted by injected shell hooks:
//   ESC ] 6973 ; <type> ; <payload> BEL
// Types:
//   B  command starting    payload = base64(command line)
//   C  command finished    payload = exit code (decimal)
//   D  cwd update          payload = base64(absolute path)

const OSC = '\x1b]6973;';
const BEL = '\x07';
const PARTIAL_KEEP = 64; // bytes of unfinished sequence we hold across chunks

function b64decode(s) {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; }
}

function createMarkerStream(emit) {
  // emit(event, payload) — events: 'command', 'exit', 'cwd'
  // returns a function: feed(buf) -> cleanedBuf (Buffer)
  let pending = '';

  return function feed(chunk) {
    pending += chunk.toString('utf8');
    let out = '';
    let i = 0;
    while (i < pending.length) {
      const start = pending.indexOf(OSC, i);
      if (start === -1) {
        out += pending.slice(i);
        i = pending.length;
        break;
      }
      out += pending.slice(i, start);
      const end = pending.indexOf(BEL, start + OSC.length);
      if (end === -1) {
        // incomplete marker — keep it in pending for next chunk
        pending = pending.slice(start);
        return Buffer.from(out, 'utf8');
      }
      const body = pending.slice(start + OSC.length, end);
      const semi = body.indexOf(';');
      const type = semi === -1 ? body : body.slice(0, semi);
      const data = semi === -1 ? '' : body.slice(semi + 1);
      switch (type) {
        case 'B': emit('command', b64decode(data)); break;
        case 'C': emit('exit', parseInt(data, 10)); break;
        case 'D': emit('cwd', b64decode(data)); break;
      }
      i = end + 1;
    }
    // Possibly trailing incomplete ESC near the end without OSC prefix yet
    const lastEsc = pending.lastIndexOf('\x1b', pending.length - 1);
    if (lastEsc !== -1 && lastEsc >= i && (pending.length - lastEsc) < PARTIAL_KEEP &&
        !pending.slice(lastEsc).includes(BEL)) {
      out = out.slice(0, out.length - (pending.length - lastEsc));
      pending = pending.slice(lastEsc);
      return Buffer.from(out, 'utf8');
    }
    pending = '';
    return Buffer.from(out, 'utf8');
  };
}

// Strip terminal-response sequences (DA, DSR, OSC color queries) from stdin
// before forwarding to the child PTY. These come back from the terminal in
// reply to queries the shell or its plugins make at startup; if they arrive
// after the shell is already at the prompt, they appear as typed input.
//
// Examples we strip:
//   ESC ] N ; ... BEL                     (OSC with BEL term)
//   ESC ] N ; ... ESC \                   (OSC with ST term)
//   ESC [ <digits>;<digits> R             (cursor position report / DSR)
//   ESC [ ? <digits>(;<digits>)* c        (primary device attributes)
//   ESC [ > <digits>(;<digits>)* c        (secondary device attributes)
//
// User-typed bare ESC (Escape key) is preserved.

function createStdinFilter() {
  let pending = Buffer.alloc(0);
  const HOLD_MAX = 128;
  return function feed(chunk) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    const out = [];
    let i = 0;
    while (i < pending.length) {
      const b = pending[i];
      if (b !== 0x1b) { out.push(b); i++; continue; }
      // Look at what follows ESC.
      const tail = pending.slice(i);
      const tailStr = tail.toString('binary');
      // OSC: ESC ] ... (BEL | ESC \)
      let m = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(tailStr);
      if (m) { i += m[0].length; continue; }
      // CSI response: ESC [ optional ?> digits ; digits R/c
      m = /^\x1b\[[\?>]?[\d;]*[Rc]/.exec(tailStr);
      if (m) { i += m[0].length; continue; }
      // Possibly incomplete — hold short tail for next chunk
      if (tail.length < HOLD_MAX && (
        /^\x1b\][^\x07\x1b]*$/.test(tailStr) ||
        /^\x1b\[[\?>]?[\d;]*$/.test(tailStr) ||
        tailStr === '\x1b' || tailStr === '\x1b['
      )) {
        pending = tail;
        return Buffer.from(out);
      }
      // Bare ESC or unknown sequence — pass through
      out.push(b); i++;
    }
    pending = Buffer.alloc(0);
    return Buffer.from(out);
  };
}

module.exports = { createMarkerStream, createStdinFilter, OSC, BEL };
