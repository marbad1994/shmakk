// Deliverables — files the AI hands back to the user as download links in chat.
//
// Unlike artefacts (a browsable vault with content snapshots) or files in the
// workspace (which show up as diffs), a deliverable is a "here, take this"
// payload: the agent writes bytes, gets back a URL, and drops that URL into
// its reply. The web UI turns those URLs into download buttons; images can be
// shown inline with a `?view=1` URL.
//
// Files live under the user's state dir (same place conversations live), never
// in the workspace, so producing a deliverable does not dirty the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');

function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'shmakk', 'web');
}

function deliverDir() {
  return path.join(stateDir(), 'deliver');
}

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

function guessMime(filePath) {
  return MIME[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

function safeId(id) {
  return /^d_[a-z0-9]{6,40}$/i.test(String(id || '')) ? String(id) : null;
}

function newId() {
  return `d_${Date.now().toString(36)}${require('crypto').randomBytes(4).toString('hex')}`;
}

function writeAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

// Create a deliverable from text content or a base64 data payload.
// Returns { id, url, viewUrl, name, mimeType, size, markdown }.
function create({ name = 'file', content = '', mimeType = null, data = null } = {}) {
  const id = newId();
  let buf;
  if (data != null) {
    // data is a base64 string; the name/mime carry the type.
    buf = Buffer.from(String(data).replace(/\s+/g, ''), 'base64');
  } else {
    buf = Buffer.from(String(content ?? ''), 'utf8');
  }

  const safeName = String(name || 'file').replace(/[\\/]+/g, '_').slice(0, 160) || 'file';
  const type = mimeType || guessMime(safeName);
  const filePath = path.join(deliverDir(), id);
  writeAtomic(filePath, buf);
  writeAtomic(path.join(deliverDir(), `${id}.json`), JSON.stringify({
    id,
    name: safeName,
    mimeType: type,
    size: buf.length,
    createdAt: Date.now(),
  }));

  const url = `/api/deliver/${id}`;
  const viewUrl = `${url}?view=1`;
  const isImage = /^image\//.test(type);
  return {
    id,
    url,
    viewUrl,
    name: safeName,
    mimeType: type,
    size: buf.length,
    // A ready-to-paste markdown link. The web UI renders it as a button.
    markdown: isImage ? `![${safeName}](${viewUrl})` : `[Download ${safeName}](${url})`,
  };
}

// Read a deliverable for serving. `view` inlines it (images, HTML previews)
// instead of forcing a download.
function serve(id, { view = false } = {}) {
  const sid = safeId(id);
  if (!sid) return null;
  const metaPath = path.join(deliverDir(), `${sid}.json`);
  const filePath = path.join(deliverDir(), sid);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const inline = !!view && (/^image\//.test(meta.mimeType) || /^text\/|^application\/(xhtml|xml|json)/.test(meta.mimeType));
  return {
    data: buf,
    name: meta.name || 'file',
    mimeType: meta.mimeType || 'application/octet-stream',
    size: meta.size || buf.length,
    inline,
  };
}

module.exports = { create, serve, deliverDir };
