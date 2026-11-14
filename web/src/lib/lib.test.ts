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

import { defaultSchedule, describe as describeSchedule, fromCron, toCron } from './schedule';

describe('schedule', () => {
  it('builds cron from friendly choices', () => {
    const s = defaultSchedule();
    expect(toCron(s)).toBe('0 9 * * 1-5');
    expect(toCron({ ...s, freq: 'minutes', every: 10 })).toBe('*/10 * * * *');
    expect(toCron({ ...s, freq: 'weekly', time: '18:30', days: [5, 1] })).toBe('30 18 * * 1,5');
    expect(toCron({ ...s, freq: 'monthly', time: '07:05', dayOfMonth: 15 })).toBe('5 7 15 * *');
  });
  it('round-trips and falls back to raw cron for anything exotic', () => {
    for (const c of ['0 9 * * 1-5', '*/10 * * * *', '30 18 * * 1,5', '5 7 15 * *', '15 6 * * *', '20 * * * *']) expect(toCron(fromCron(c))).toBe(c);
    expect(fromCron('0 0 1 1 *').freq).toBe('cron');
    expect(describeSchedule(fromCron('30 18 * * 1,5'))).toBe('Mon, Fri at 18:30');
  });
});
