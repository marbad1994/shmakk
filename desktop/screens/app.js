// Renderer for the screen priority widget. It draws the connected screens in
// their real arrangement and turns clicks into a priority order; the ordering
// itself is decided in the main process, this file only renders and reports.

const api = window.screenPriority;
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const mirrorEl = document.getElementById('mirror');
const resetEl = document.getElementById('reset');
const closeEl = document.getElementById('close');

const PAD = 22;
const MAX_SCALE = 1;

let state = null;
let order = [];
let busy = false;

function say(text, tone) {
  statusEl.textContent = text || '';
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function rankWord(n) {
  return ['main', 'secondary', 'third', 'fourth', 'fifth', 'sixth'][n - 1] || `#${n}`;
}

function describeScreen(s) {
  const bits = [`${s.box.w} by ${s.box.h}`, `${s.scale}x`];
  if (s.orientation && s.orientation !== 'landscape') bits.push(s.orientation);
  return bits.join(', ');
}

function render() {
  canvas.textContent = '';
  const screens = (state && state.screens) || [];

  if (!screens.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state && state.error
      ? `No screen layout available: ${state.error}`
      : 'No connected screens reported.';
    canvas.appendChild(empty);
    return;
  }

  const minX = Math.min(...screens.map((s) => s.box.x));
  const minY = Math.min(...screens.map((s) => s.box.y));
  const maxX = Math.max(...screens.map((s) => s.box.x + s.box.w));
  const maxY = Math.max(...screens.map((s) => s.box.y + s.box.h));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  const availW = Math.max(40, canvas.clientWidth - PAD * 2);
  const availH = Math.max(40, canvas.clientHeight - PAD * 2);
  const scale = Math.min(availW / spanX, availH / spanY, MAX_SCALE);
  const offX = PAD + (availW - spanX * scale) / 2;
  const offY = PAD + (availH - spanY * scale) / 2;

  for (const s of screens) {
    const rank = order.indexOf(s.name) + 1;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'screen';
    tile.dataset.name = s.name;
    if (rank) {
      tile.dataset.ranked = String(rank);
      tile.setAttribute('aria-label', `${s.name}, rank ${rank} (${rankWord(rank)}), ${describeScreen(s)}`);
    } else {
      tile.setAttribute('aria-label', `${s.name}, unranked, ${describeScreen(s)}`);
    }

    tile.style.left = `${Math.round(offX + (s.box.x - minX) * scale)}px`;
    tile.style.top = `${Math.round(offY + (s.box.y - minY) * scale)}px`;
    tile.style.width = `${Math.round(s.box.w * scale)}px`;
    tile.style.height = `${Math.round(s.box.h * scale)}px`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = rank ? String(rank) : '';
    tile.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    tile.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = describeScreen(s);
    tile.appendChild(meta);

    if (Number.isFinite(s.kscreenPriority)) {
      const plasma = document.createElement('span');
      plasma.className = 'plasma';
      plasma.textContent = `Plasma priority ${s.kscreenPriority}`;
      tile.appendChild(plasma);
    }

    tile.addEventListener('click', () => toggle(s.name));
    canvas.appendChild(tile);
  }
}

function adopt(next) {
  state = next;
  order = (next.order || []).slice();
  mirrorEl.checked = next.kscreen !== false;
  render();
}

function statusFor(result, next) {
  if (!result) return '';
  if (result.error) return result.error;
  const main = (next.order || [])[0];
  if (!main) return 'No priority set';
  const word = rankWord(1);
  if (!result.kscreen) return `${main} is ${word}`;
  if (result.kscreen.ok) return `${main} is ${word}, Plasma updated`;
  const reason = result.kscreen.error ? `: ${result.kscreen.error}` : '';
  return `Saved, Plasma not updated${reason}`;
}

async function apply(mutate, { tone = null } = {}) {
  if (busy) return;
  busy = true;
  resetEl.disabled = true;
  try {
    const res = await mutate();
    if (res && res.state) adopt(res.state);
    const text = statusFor(res && res.result, state || {});
    say(text, (res && res.result && (res.result.error || (res.result.kscreen && res.result.kscreen.ok === false))) ? 'error' : tone);
  } catch (e) {
    say(String(e && e.message ? e.message : e), 'error');
  } finally {
    busy = false;
    resetEl.disabled = false;
  }
}

function toggle(name) {
  const at = order.indexOf(name);
  if (at >= 0) order.splice(at, 1);
  else order.push(name);
  const wanted = order.slice();
  apply(async () => {
    const res = await api.set(wanted, mirrorEl.checked);
    return res;
  });
}

resetEl.addEventListener('click', () => {
  if (!order.length) return say('Nothing to reset');
  apply(() => api.reset());
});

closeEl.addEventListener('click', () => api.close());

mirrorEl.addEventListener('change', () => {
  const wanted = order.slice();
  apply(() => api.set(wanted, mirrorEl.checked));
});

// Screens get plugged in and rearranged while the window is open.
setInterval(async () => {
  if (busy || !api) return;
  try {
    const next = await api.state();
    const before = (state && state.screens || []).map((s) => `${s.name}:${s.box.x},${s.box.y},${s.box.w},${s.box.h}`).join('|');
    const after = (next.screens || []).map((s) => `${s.name}:${s.box.x},${s.box.y},${s.box.w},${s.box.h}`).join('|');
    if (before !== after) adopt(next);
  } catch {}
}, 4000);

window.addEventListener('resize', () => render());

api.state().then(adopt).catch((e) => say(String(e && e.message ? e.message : e), 'error'));
