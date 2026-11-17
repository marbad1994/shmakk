// Minimal, dependency-free tar (gzip) pack/unpack for session bundles.
//
// Workspace transfers stream through the HTTP API, so the tarball is produced
// and consumed incrementally without pulling whole trees into memory. Node has
// no built-in tar, so this implements the subset shmakk uses: regular files,
// directories and symlinks, in ustar format. It only has to interoperate with
// itself (both ends run shmakk), so the reader is deliberately permissive.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const RECORD = 512;

// Directories we never move across machines. Git objects, installed packages
// and build output are large and re-derivable; the working tree is what counts.
const EXCLUDE = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.yarn', '.pnpm-store',
]);

function pad(str, len) {
  const s = String(str);
  return (s.length >= len ? s.slice(0, len) : s).padEnd(len, '\0');
}

function headerFor(name, size, typeflag, linkname) {
  const buf = Buffer.alloc(RECORD);
  buf.write(pad(name, 100), 0, 100, 'ascii');
  buf.write(pad('0000644', 8), 100, 8, 'ascii'); // mode
  buf.write(pad('0000000', 8), 108, 8, 'ascii'); // uid
  buf.write(pad('0000000', 8), 116, 8, 'ascii'); // gid
  buf.write(pad(size.toString(8).padStart(11, '0'), 12), 124, 12, 'ascii');
  buf.write(pad('00000000000', 12), 136, 12, 'ascii'); // mtime
  buf.write('        ', 148, 8, 'ascii'); // chksum placeholder
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write(pad(linkname || '', 100), 157, 100, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  // Checksum: the unsigned sum of every byte, chksum field counted as spaces.
  let sum = 0;
  for (let i = 0; i < RECORD; i++) sum += buf[i];
  buf.write(pad(sum.toString(8).padStart(6, '0'), 8), 148, 8, 'ascii');
  return buf;
}

async function* walk(dir, prefix) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (EXCLUDE.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      yield { type: 'dir', rel };
      yield* walk(abs, rel);
    } else if (ent.isFile()) {
      yield { type: 'file', rel, abs };
    } else if (ent.isSymbolicLink()) {
      let target = '';
      try { target = await fs.promises.readlink(abs); } catch {}
      yield { type: 'symlink', rel, target };
    }
  }
}

async function* packTree(root, prefix) {
  for await (const e of walk(path.resolve(root), prefix)) {
    if (e.type === 'dir') {
      yield headerFor(`${e.rel}/`, 0, '5', '');
    } else if (e.type === 'symlink') {
      yield headerFor(e.rel, 0, '2', e.target);
    } else {
      const size = (await fs.promises.stat(e.abs)).size;
      yield headerFor(e.rel, size, '0', '');
      const fh = await fs.promises.open(e.abs, 'r');
      try {
        for await (const chunk of fh.createReadStream()) yield chunk;
      } finally { await fh.close(); }
      const padLen = (RECORD - (size % RECORD)) % RECORD;
      if (padLen) yield Buffer.alloc(padLen);
    }
  }
}

function gzipGen(gen) { return Readable.from(gen).pipe(zlib.createGzip()); }

/**
 * Pack the contents of `root` into a gzip tar Readable. The directory's own
 * name is not included; its children become the archive root.
 */
function packDir(root) {
  return gzipGen((async function* () {
    yield* packTree(root, '');
    yield Buffer.alloc(RECORD);
    yield Buffer.alloc(RECORD);
  })());
}

/**
 * Pack a session bundle: a `conversation.json` entry, then the workspace tree
 * under a `workspace/` prefix (when provided).
 */
function packBundle(conv, workspaceDir) {
  return gzipGen((async function* () {
    const json = Buffer.from(JSON.stringify(conv), 'utf8');
    yield headerFor('conversation.json', json.length, '0', '');
    yield json;
    const padLen = (RECORD - (json.length % RECORD)) % RECORD;
    if (padLen) yield Buffer.alloc(padLen);
    if (workspaceDir) yield* packTree(workspaceDir, 'workspace');
    yield Buffer.alloc(RECORD);
    yield Buffer.alloc(RECORD);
  })());
}

/**
 * Extract a gzip tar stream into `dest`. Rejects any entry whose resolved path
 * escapes `dest`. Returns the parsed `conversation.json` entry when present,
 * otherwise null.
 */
async function unpackStream(stream, dest) {
  const nodeStream = typeof stream.pipe === 'function' ? stream : Readable.from(stream);
  const src = nodeStream.pipe(zlib.createGunzip());
  const destAbs = path.resolve(dest);
  let buf = Buffer.alloc(0);
  let header = null; // entry being written: { name, size, typeflag, target }
  let remaining = 0;
  let pad = 0;
  let fh = null;
  let convRaw = null;

  for await (const chunk of src) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (!header) {
        if (buf.length < RECORD) break;
        const rec = buf.slice(0, RECORD);
        buf = buf.slice(RECORD);
        if (rec.every((b) => b === 0)) return convRaw ? JSON.parse(convRaw.toString('utf8')) : null;
        const name = rec.slice(0, 100).toString('utf8').replace(/\0.*$/, '').replace(/\/+$/, '');
        if (!name) continue;
        const size = parseInt(rec.slice(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8) || 0;
        const typeflag = String.fromCharCode(rec[156]);
        const target = path.resolve(destAbs, name);
        if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
          throw new Error(`archive entry escapes destination: ${name}`);
        }
        header = { name, size, typeflag, target };
        remaining = size;
        pad = (RECORD - (size % RECORD)) % RECORD;

        if (typeflag === '5') {
          await fs.promises.mkdir(target, { recursive: true });
          header = null;
          continue;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (typeflag === '2') {
          const linkname = rec.slice(157, 257).toString('utf8').replace(/\0.*$/, '');
          try { await fs.promises.symlink(linkname, target); } catch {}
          header = null;
          continue;
        }
        if (name === 'conversation.json') {
          // Capture into memory; it is small.
          header.capture = true;
          header.captureBuf = Buffer.alloc(0);
        }
        fh = header.capture ? null : await fs.promises.open(target, 'w');
        continue;
      }

      if (remaining > 0) {
        if (buf.length === 0) break;
        const take = Math.min(remaining, buf.length);
        const slice = buf.slice(0, take);
        if (header.capture) header.captureBuf = Buffer.concat([header.captureBuf, slice]);
        else await fh.write(slice);
        buf = buf.slice(take);
        remaining -= take;
        continue;
      }
      if (pad > 0) {
        if (buf.length === 0) break;
        const take = Math.min(pad, buf.length);
        buf = buf.slice(take);
        pad -= take;
        continue;
      }
      if (fh) await fh.close();
      if (header.capture) convRaw = header.captureBuf;
      fh = null;
      header = null;
    }
  }
  if (fh) await fh.close();
  return convRaw ? JSON.parse(convRaw.toString('utf8')) : null;
}

module.exports = { packDir, packBundle, unpackStream, headerFor, RECORD, EXCLUDE };
