import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

type HSVA = { h: number; s: number; v: number; a: number };
type RGBA = { r: number; g: number; b: number; a: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function rgbaToHsva({ r, g, b, a }: RGBA): HSVA {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max, a };
}

function hsvaToRgba({ h, s, v, a }: HSVA): RGBA {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

/** Parse any CSS colour (hex/rgb/hsl/named) into HSVA via a canvas context. */
function parseColor(value: string): HSVA {
  const v = (value ?? '').trim();
  if (!v) return { h: 0, s: 0, v: 0, a: 1 };
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return { h: 0, s: 0, v: 0, a: 1 };
    ctx.fillStyle = '#010203';
    ctx.fillStyle = v;
    const n = ctx.fillStyle;
    if (typeof n !== 'string') return { h: 0, s: 0, v: 0, a: 1 };
    if (n.startsWith('#')) {
      const hex = n.slice(1);
      if (hex.length === 3) {
        return rgbaToHsva({ r: parseInt(hex[0], 16) * 17, g: parseInt(hex[1], 16) * 17, b: parseInt(hex[2], 16) * 17, a: 1 });
      }
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some((x) => Number.isNaN(x))) return { h: 0, s: 0, v: 0, a: 1 };
      return rgbaToHsva({ r, g, b, a: 1 });
    }
    const m = n.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return rgbaToHsva({ r: clamp(p[0] ?? 0, 0, 255), g: clamp(p[1] ?? 0, 0, 255), b: clamp(p[2] ?? 0, 0, 255), a: clamp(p[3] ?? 1, 0, 1) });
    }
  } catch { /* keep default */ }
  return { h: 0, s: 0, v: 0, a: 1 };
}

function toCss(hsva: HSVA): string {
  const { r, g, b, a } = hsvaToRgba(hsva);
  const hex = [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  if (a >= 0.999) return `#${hex}`;
  const aStr = Math.round(a * 1000) / 1000;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${aStr})`;
}

function toHex(hsva: HSVA): string {
  const { r, g, b } = hsvaToRgba(hsva);
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

const CHECKER: CSSProperties = {
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg,#c7c7cc 25%,transparent 25%),linear-gradient(-45deg,#c7c7cc 25%,transparent 25%),' +
    'linear-gradient(45deg,transparent 75%,#c7c7cc 75%),linear-gradient(-45deg,transparent 75%,#c7c7cc 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
};

// Window-level pointer dragging so a drag continues outside the small handle.
function usePointerDrag(apply: (fx: number, fy: number) => void) {
  const active = useRef<{ id: number; rect: DOMRect } | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = active.current;
      if (!s || e.pointerId !== s.id) return;
      applyRef.current((e.clientX - s.rect.left) / s.rect.width, (e.clientY - s.rect.top) / s.rect.height);
    };
    const stop = (e: PointerEvent) => { if (active.current && e.pointerId === active.current.id) active.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      active.current = { id: e.pointerId, rect };
      applyRef.current((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    },
  };
}

/** A colour swatch that opens a floating wheel (SV square + hue/alpha sliders). */
export function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const hsva = useMemo(() => parseColor(value), [value]);
  const set = useCallback((patch: Partial<HSVA>) => onChange(toCss({ ...hsva, ...patch })), [hsva, onChange]);

  const openPicker = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 236, H = 292;
    let top = r.bottom + 8;
    let left = r.left;
    if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 8);
    if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8);
    setPos({ top, left });
    setOpen(true);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { r, g, b } = hsvaToRgba(hsva);
  const svDown = usePointerDrag((fx, fy) => set({ s: clamp(fx, 0, 1), v: 1 - clamp(fy, 0, 1) }));
  const hueDown = usePointerDrag((fx) => set({ h: clamp(fx, 0, 1) * 360 }));
  const alphaDown = usePointerDrag((fx) => set({ a: clamp(fx, 0, 1) }));

  const [hex, setHex] = useState(() => toHex(hsva));
  const hexFocused = useRef(false);
  useEffect(() => { if (!hexFocused.current) setHex(toHex(hsva)); }, [hsva]);

  const onHex = (v: string) => {
    setHex(v);
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v.trim());
    if (!m) return;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const nr = parseInt(h.slice(0, 2), 16), ng = parseInt(h.slice(2, 4), 16), nb = parseInt(h.slice(4, 6), 16);
    onChange(toCss(rgbaToHsva({ r: nr, g: ng, b: nb, a: hsva.a })));
  };

  const thumb = 'absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]';

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label="Pick colour"
        title={value || 'Pick colour'}
        onClick={openPicker}
        className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-inset ring-line-strong"
      >
        <span className="absolute inset-0" style={CHECKER} />
        <span className="absolute inset-0" style={{ background: toCss(hsva) }} />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              className="fixed z-50 w-[236px] rounded-xl border border-line bg-panel p-2.5 shadow-pop"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="size-6 shrink-0 overflow-hidden rounded-md ring-1 ring-inset ring-line-strong" style={{ ...CHECKER, display: 'block' }}>
                  <span className="block size-full" style={{ background: toCss(hsva) }} />
                </span>
                <input
                  value={hex}
                  onFocus={() => { hexFocused.current = true; }}
                  onBlur={() => { hexFocused.current = false; setHex(toHex(hsva)); }}
                  onChange={(e) => onHex(e.target.value)}
                  spellCheck={false}
                  className="h-6 w-full min-w-0 rounded-md border border-line bg-sunken px-2 font-mono text-[11px] text-fg outline-none focus:border-accent/45"
                />
              </div>

              <div
                {...svDown}
                className="relative h-40 w-full cursor-crosshair rounded-md"
                style={{ backgroundColor: `hsl(${hsva.h}, 100%, 50%)`, backgroundImage: 'linear-gradient(to right, #fff, rgba(255,255,255,0)), linear-gradient(to top, #000, rgba(0,0,0,0))' }}
              >
                <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%` }} />
              </div>

              <div className="mt-2.5 grid gap-2.5">
                <div {...hueDown} className="relative h-3 w-full cursor-pointer rounded-full" style={{ background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)' }}>
                  <span className={thumb} style={{ left: `${(hsva.h / 360) * 100}%` }} />
                </div>
                <div {...alphaDown} className="relative h-3 w-full cursor-pointer rounded-full" style={CHECKER}>
                  <div className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(to right, rgba(${r},${g},${b},0), rgb(${r},${g},${b}))` }} />
                  <span className={thumb} style={{ left: `${hsva.a * 100}%` }} />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
