import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from './ansi';
import { parseDiff } from './diff';
import { speakable, tildify } from './utils';

describe('ansi', () => {
  it('maps SGR codes to classes and merges runs', () => {
    expect(parseAnsi('\x1b[1m\x1b[32mok\x1b[0m done')).toEqual([{ text: 'ok', cls: 'ansi-b ansi-32' }, { text: ' done', cls: '' }]);
  });
  it('drops cursor movement, OSC titles and keeps the last carriage-return rewrite', () => {
    expect(stripAnsi('\x1b]0;title\x07a\x1b[2Kb')).toBe('ab');
    expect(stripAnsi('10%\r50%\r100%\n')).toBe('100%\n');
  });
});

describe('diff', () => {
  it('numbers lines and counts changes', () => {
    const d = parseDiff('--- a/x.js\n+++ b/x.js\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more');
    expect(d.path).toBe('x.js');
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['hunk', undefined, undefined], ['ctx', 3, 3], ['del', 4, undefined], ['add', undefined, 4], ['add', undefined, 5],
    ]);
  });
});

describe('utils', () => {
  it('turns markdown into speakable text', () => {
    expect(speakable('## Done\nUse `npm test` — see [docs](http://x).\n```js\ncode()\n```')).toBe('Done Use npm test — see docs. (code omitted)');
  });
  it('abbreviates the home directory', () => {
    expect(tildify('/home/me/code', '/home/me')).toBe('~/code');
  });
});
