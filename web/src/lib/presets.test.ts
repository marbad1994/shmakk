import { describe, expect, it } from 'vitest';
import { nextStart, PRESET_WINDOW, PRESETS, randomStart, windowAt } from './presets';
import type { Mode } from './types';

const MODES: Mode[] = ['chat', 'code', 'design', 'cowork'];

describe('preset pools', () => {
  it('has a healthy, evenly paged pool for every space', () => {
    for (const mode of MODES) {
      const pool = PRESETS[mode];
      expect(pool.length).toBeGreaterThanOrEqual(8);
      expect(pool.length % PRESET_WINDOW).toBe(0);
    }
  });

  it('does not repeat a prompt inside a pool', () => {
    for (const mode of MODES) {
      const texts = PRESETS[mode].map((s) => s.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('marks shell shortcuts so they open in shell mode', () => {
    expect(PRESETS.code.some((s) => s.shell)).toBe(true);
  });
});

describe('windowAt', () => {
  it('shows a full, distinct page', () => {
    const page = windowAt(PRESETS.chat, 0);
    expect(page).toHaveLength(PRESET_WINDOW);
    expect(new Set(page.map((s) => s.text)).size).toBe(PRESET_WINDOW);
  });

  it('wraps around the end of the pool', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(windowAt(pool, 4)).toEqual(['e', 'f', 'a', 'b']);
  });

  it('is empty for an empty pool', () => {
    expect(windowAt([], 0)).toEqual([]);
  });
});

describe('nextStart', () => {
  it('cycles through every page and back', () => {
    const len = PRESETS.code.length;
    const seen = new Set<number>();
    let start = 0;
    for (let i = 0; i < len / PRESET_WINDOW; i++) {
      seen.add(start);
      start = nextStart(start, len);
    }
    expect(start).toBe(0);
    expect(seen.size).toBe(len / PRESET_WINDOW);
  });

  it('copes with an empty pool', () => {
    expect(nextStart(3, 0)).toBe(0);
  });
});

describe('randomStart', () => {
  it('never picks the page that is already on screen', () => {
    const len = PRESETS.design.length;
    for (let cur = 0; cur < len; cur += PRESET_WINDOW) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const next = randomStart(len, cur, PRESET_WINDOW, () => r);
        expect(next).not.toBe(cur);
        expect(next % PRESET_WINDOW).toBe(0);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(len);
      }
    }
  });

  it('stays put when there is only one page', () => {
    expect(randomStart(PRESET_WINDOW, 0)).toBe(0);
    expect(randomStart(0, 0)).toBe(0);
  });
});
