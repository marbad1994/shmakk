// Artefacts — a cross-workspace vault of files the AI made that are not part
// of the project. Each artefact is a small JSON record stored under the user's
// state dir (same place conversations live), pointing at the file on disk plus
// a snapshot of its contents so the vault, preview and "discuss" keep working
// even if the original file moves or is deleted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

// Largest file body we snapshot. Beyond this the record still exists but the
// content is truncated (opening the file still works).
const MAX_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.md': 'text/markdown', '.mdx': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
  '.json': 'application/json', '.jsonc': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.css': 'text/css', '.scss': 'text/css', '.less': 'text/css', '.html': 'text/html', '.htm': 'text/html',
  '.svg': 'image/svg+xml', '.xml': 'application/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.toml': 'text/toml', '.ini': 'text/plain', '.env': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp', '.php': 'text/x-php', '.swift': 'text/x-swift', '.kt': 'text/x-kotlin', '.sh': 'text/x-shellscript',
  '.fish': 'text/x-shellscript', '.zsh': 'text/x-shellscript', '.bash': 'text/x-shellscript', '.sql': 'text/x-sql',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function artefactsDir() {
  return path.join(store.stateDir(), 'artefacts');
}

function writeAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

function guessMime(filePath) {
  return MIME[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

function hasNullByte(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Normalize raw bytes into a storable body: text stays text, binary is base64.
function normalizeBytes(buf, fullSize) {
  const binary = hasNullByte(buf);
  const truncated = fullSize > buf.length;
  return binary ? { content: buf.toString('base64'), binary: true, truncated } : { content: buf.toString('utf8'), binary: false, truncated };
}

function metaOf(a) {
  return {
    id: a.id,
    name: a.name,
    path: a.path || null,
    relPath: a.relPath || '',
    mimeType: a.mimeType || 'application/octet-stream',
    size: a.size || 0,
    binary: !!a.binary,
    truncated: !!a.truncated,
    note: a.note || null,
    mode: store.MODES.includes(a.mode) ? a.mode : 'chat',
    convId: a.convId || null,
    workspace: a.workspace || null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function relPath(abs, workspace) {
  if (!abs) return '';
  const home = os.homedir();
  if (workspace && abs.startsWith(workspace + path.sep)) return abs.slice(workspace.length + 1);
  if (abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
  return abs;
}

function list({ q = '', mode = null } = {}) {
  const dir = artefactsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  const needle = String(q || '').trim().toLowerCase();
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!a || !a.id) continue;
      if (mode && a.mode !== mode) continue;
      const m = metaOf(a);
      if (needle && !(`${m.name} ${m.relPath} ${m.note || ''}`.toLowerCase().includes(needle))) continue;
      out.push(m);
    } catch { /* skip corrupt record */ }
  }
  return out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
}

function get(id) {
  const sid = store.safeId(id);
  if (!sid) return null;
  try {
    const a = JSON.parse(fs.readFileSync(path.join(artefactsDir(), `${sid}.json`), 'utf8'));
    if (!a || a.id !== sid) return null;
    return { ...metaOf(a), content: typeof a.content === 'string' ? a.content : '' };
  } catch { return null; }
}

function save(a) {
  const m = metaOf(a);
  writeAtomic(
    path.join(artefactsDir(), `${a.id}.json`),
    JSON.stringify({ ...m, content: a.content || '' }),
  );
  return m;
}

function create({ name, path: filePath = null, content = '', mimeType = null, size = null, mode = 'chat', convId = null, workspace = null, note = null, binary = undefined, truncated = undefined } = {}) {
  const now = Date.now();
  const resolvedPath = filePath ? path.resolve(String(filePath)) : null;
  const art = {
    id: store.newId('a'),
    name: String(name || path.basename(resolvedPath || '') || 'artefact').slice(0, 160),
    path: resolvedPath,
    relPath: relPath(resolvedPath, workspace),
    mimeType: mimeType || (resolvedPath ? guessMime(resolvedPath) : 'text/plain'),
    size: typeof size === 'number' ? size : Buffer.byteLength(String(content || ''), 'utf8'),
    binary: false,
    truncated: false,
    note: note ? String(note).slice(0, 500) : null,
    mode: store.MODES.includes(mode) ? mode : 'chat',
    convId: convId || null,
    workspace: workspace || null,
    createdAt: now,
    updatedAt: now,
    content: '',
  };
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  if (typeof binary === 'boolean' && typeof truncated === 'boolean') {
    art.content = String(content || '');
    art.binary = binary;
    art.truncated = truncated;
  } else {
    const normalized = normalizeBytes(buf, art.size);
    art.content = normalized.content;
    art.binary = normalized.binary;
    art.truncated = normalized.truncated;
    if (!art.binary && art.size > MAX_BYTES) {
      art.content = buf.subarray(0, MAX_BYTES).toString('utf8');
      art.truncated = true;
    }
  }
  save(art);
  return metaOf(art);
}

function fromFile(filePath, opts = {}) {
  const abs = path.resolve(String(filePath || ''));
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${abs}`);
  const mimeType = guessMime(abs);
  const raw = st.size <= MAX_BYTES ? fs.readFileSync(abs) : fs.readFileSync(abs, { length: MAX_BYTES });
  const normalized = normalizeBytes(raw, st.size);
  return create({
    name: opts.name ? String(opts.name) : path.basename(abs),
    path: abs,
    content: normalized.content,
    mimeType,
    size: st.size,
    mode: opts.mode,
    convId: opts.convId,
    workspace: opts.workspace,
    note: opts.note,
    binary: normalized.binary,
    truncated: normalized.truncated,
  });
}

function update(id, patch = {}) {
  const sid = store.safeId(id);
  if (!sid) return null;
  const p = path.join(artefactsDir(), `${sid}.json`);
  let a;
  try { a = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  if (!a || a.id !== sid) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) a.name = patch.name.trim().slice(0, 160);
  if ('note' in patch) a.note = patch.note ? String(patch.note).slice(0, 500) : null;
  a.updatedAt = Date.now();
  save(a);
  return metaOf(a);
}

function remove(id) {
  const sid = store.safeId(id);
  if (!sid) return false;
  try { fs.rmSync(path.join(artefactsDir(), `${sid}.json`), { force: true }); return true; } catch { return false; }
}

module.exports = { artefactsDir, list, get, create, fromFile, update, remove, metaOf };
