// Design mode: every design conversation owns a folder of self-contained
// HTML/CSS files that the agent writes and the UI previews live.
//
// Previews are served from /artifact/<conv>/<sig>/<path> with a CSP `sandbox`
// header, so a generated page can run its own scripts and load fonts/images
// but lives in an opaque origin: it cannot read the app's cookies, storage or
// API. The signature (HMAC of the conversation id) stands in for the cookie,
// which a sandboxed frame would not send.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const VERSIONS = '.versions';
const MAX_VERSIONS = 30;
const PREVIEWABLE = new Set(['.html', '.htm', '.svg']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function designsRoot() { return path.join(store.stateDir(), 'designs'); }

function designDir(convId) {
  const id = store.safeId(convId);
  if (!id) return null;
  return path.join(designsRoot(), id);
}

function ensureDir(convId) {
  const dir = designDir(convId);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) {
      const st = fs.statSync(abs);
      out.push({ path: path.relative(base, abs).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
    if (out.length > 500) break;
  }
  return out;
}

// index.html first, then other pages, then assets.
function listFiles(dir) {
  const rank = (f) => (f.path === 'index.html' ? 0 : PREVIEWABLE.has(path.extname(f.path).toLowerCase()) ? 1 : 2);
  return walk(dir).sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    .map((f) => ({ ...f, previewable: PREVIEWABLE.has(path.extname(f.path).toLowerCase()) }));
}

function fingerprint(dir) {
  const h = crypto.createHash('sha1');
  for (const f of walk(dir).sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    try { h.update(fs.readFileSync(path.join(dir, f.path))); } catch {}
  }
  return h.digest('hex');
}

function listVersions(dir) {
  const root = path.join(dir, VERSIONS);
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)); } catch { return []; }
  return names.map(Number).sort((a, b) => a - b).map((n) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(root, String(n), '.meta.json'), 'utf8')); } catch {}
    return { n, at: meta.at || 0, note: meta.note || '', files: meta.files || [] };
  });
}

// Copy the current files into .versions/<n> if anything changed since the last
// snapshot. Returns the new version, or null when nothing changed.
function snapshot(dir, note = '') {
  const files = walk(dir);
  if (!files.length) return null;
  const versions = listVersions(dir);
  const fp = fingerprint(dir);
  const root = path.join(dir, VERSIONS);
  const last = versions[versions.length - 1];
  if (last) {
    try { if (JSON.parse(fs.readFileSync(path.join(root, String(last.n), '.meta.json'), 'utf8')).fingerprint === fp) return null; } catch {}
  }
  const n = (last ? last.n : 0) + 1;
  const dest = path.join(root, String(n));
  for (const f of files) {
    const to = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, f.path), to);
  }
  const meta = { at: Date.now(), note: String(note).slice(0, 140), files: files.map((f) => f.path), fingerprint: fp };
  fs.writeFileSync(path.join(dest, '.meta.json'), JSON.stringify(meta));
  for (const old of versions.slice(0, Math.max(0, versions.length + 1 - MAX_VERSIONS))) {
    fs.rmSync(path.join(root, String(old.n)), { recursive: true, force: true });
  }
  return { n, at: meta.at, note: meta.note, files: meta.files };
}

// Bring an old version back as the working copy (snapshotting the current one first).
function restore(dir, n) {
  const src = path.join(dir, VERSIONS, String(Number(n)));
  if (!fs.existsSync(src)) return false;
  snapshot(dir, 'before restore');
  for (const f of walk(dir)) fs.rmSync(path.join(dir, f.path), { force: true });
  for (const f of walk(src)) {
    const to = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f.path), to);
  }
  return true;
}

function sign(secret, convId) {
  return crypto.createHmac('sha256', String(secret)).update(`artifact:${convId}`).digest('base64url').slice(0, 32);
}

// Resolve an artifact request to a file inside the design folder, or null.
function resolveArtifact(secret, convId, sig, relPath) {
  const dir = designDir(convId);
  if (!dir) return null;
  const want = sign(secret, convId);
  const a = Buffer.from(String(sig || '')); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const rel = String(relPath || '').replace(/^\/+/, '') || 'index.html';
  if (rel.split('/').some((seg) => seg === '..' || (seg.startsWith('.') && seg !== VERSIONS))) return null;
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    const realDir = fs.realpathSync(dir);
    if (!real.startsWith(realDir + path.sep) || !fs.statSync(real).isFile()) return null;
    return { file: real, type: TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream' };
  } catch { return null; }
}

const ARTIFACT_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src 'self' 'unsafe-inline' data: blob: https:; connect-src 'none'; frame-ancestors 'self'";

const DESIGN_HINT = `
Specialist mode: Product Designer (Design mode)
You design interfaces and deliver them as real, viewable files — the user watches a live preview next to this chat.

Deliverables
- Write self-contained HTML with CSS in a <style> block. The main screen is index.html; put further screens in their own .html files (pricing.html, settings.html, …) and link between them with relative links.
- Use write_file for new files and edit_file for refinements. Never paste whole files into the chat — the preview is the deliverable.
- No build step, no frameworks, no placeholder "lorem ipsum": write realistic copy and plausible data. Inline SVG for icons and illustrations. Web fonts via <link> are fine. Small vanilla JS only when interaction is the point.

Craft
- Start from intent: who is this for, what is the one thing they should do on this screen? State your direction in one or two sentences before building.
- Establish a small system first — CSS custom properties for color, type scale, spacing, radius — then compose with it. Consistent spacing rhythm; clear hierarchy; generous whitespace.
- Responsive by default (fluid layout, sensible breakpoints) and accessible (semantic HTML, contrast ≥ 4.5:1, visible focus states, real <button>/<a>/<label>).
- Have a point of view. Avoid the generic template look; pick a distinctive but appropriate type pairing, palette and layout.

Working style
- When asked for options, create variations as separate files (option-a.html, option-b.html) so they can be compared side by side.
- When refining, change only what was asked and keep the rest stable.
- Finish with a short note: what you made, the key decisions, and one or two things worth trying next.`;

module.exports = { designsRoot, designDir, ensureDir, listFiles, listVersions, snapshot, restore, sign, resolveArtifact, ARTIFACT_CSP, DESIGN_HINT, VERSIONS };
