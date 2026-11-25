// Image format support for the vision pipeline.
//
// Vision providers only take a handful of formats (png, jpeg, gif, webp), but
// people paste bmp, tiff, ico, avif, heic and svg all the time. So we
//  1. recognise every format we know about, by extension *and* by magic bytes
//     (a .png that is really a JPEG still works, and a .heic is not text),
//  2. leave provider-safe formats untouched,
//  3. convert everything else to PNG with whichever local converter is
//     installed (ffmpeg, ImageMagick, macOS sips), and
//  4. hand back an explicit "skipped" record when nothing can read it, so the
//     caller can tell the model an image exists instead of sending garbage.
//
// No npm dependencies: conversion shells out, and only when it is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Formats that OpenAI-compatible and Anthropic vision APIs accept as-is.
const PROVIDER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MIME_BY_EXT = new Map(Object.entries({
  '.png': 'image/png',
  '.apng': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.dib': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
}));

const EXT_BY_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
  ['image/tiff', '.tiff'],
  ['image/avif', '.avif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/x-icon', '.ico'],
]);

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 20000;

// ── Format detection ───────────────────────────────────────────────────────

function extOf(p) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? `.${m[1]}` : '';
}

function mimeFromExt(p) {
  return MIME_BY_EXT.get(extOf(p)) || null;
}

function isImagePath(p) {
  return MIME_BY_EXT.has(extOf(p));
}

function looksLikeSvg(buf) {
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (!head.startsWith('<?xml') && !head.startsWith('<svg') && !head.startsWith('<!doctype svg')) return false;
  return head.includes('<svg') || head.includes('http://www.w3.org/2000/svg');
}

/** Detect an image format from its first bytes. Returns null for non-images. */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const at = (start, end) => buf.toString('latin1', start, end);
  if (buf.length >= 8 && buf[0] === 0x89 && at(1, 4) === 'PNG' && buf[4] === 0x0d) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = at(0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length > 26) return 'image/bmp';
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return 'image/tiff';
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return 'image/tiff';
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'image/x-icon';
  if (buf.length >= 12 && at(4, 8) === 'ftyp') {
    const brand = at(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(hei[cxs]|he[iv]m|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (buf[0] === 0x38 && buf[1] === 0x42 && buf[2] === 0x50 && buf[3] === 0x53) return 'image/vnd.adobe.photoshop';
  if (looksLikeSvg(buf)) return 'image/svg+xml';
  return null;
}

/** Best mime for a file: real content wins, the extension is the fallback. */
function mimeForFile(p, buf) {
  return sniffMime(buf) || mimeFromExt(p) || null;
}

function isProviderMime(mime) {
  return PROVIDER_MIMES.has(String(mime || '').toLowerCase());
}

function cleanMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!m) return null;
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
  return m;
}

// ── Local converters ───────────────────────────────────────────────────────

const CONVERTERS = [
  {
    name: 'ffmpeg',
    probe: ['-version'],
    args: (src, out) => ['-v', 'error', '-y', '-i', src, '-frames:v', '1', out],
  },
  {
    name: 'magick',
    probe: ['-version'],
    args: (src, out) => [src, `png:${out}`],
  },
  {
    name: 'convert',
    probe: ['-version'],
    args: (src, out) => [src, `png:${out}`],
  },
  {
    name: 'sips',
    probe: ['-h'],
    args: (src, out) => ['-s', 'format', 'png', src, '--out', out],
  },
];

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return resolve({ missing: true });
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

let converterPromise = null;

/** The first installed converter, or null. Probed once per process. */
function pickConverter() {
  if (!converterPromise) {
    converterPromise = (async () => {
      const forced = process.env.SHMAKK_IMAGE_CONVERTER;
      const candidates = forced ? CONVERTERS.filter((c) => c.name === forced) : CONVERTERS;
      if (forced && !candidates.length) return null;
      for (const c of candidates) {
        const res = await run(c.name, c.probe, 5000);
        if (!res.missing) return c;
      }
      return null;
    })();
  }
  return converterPromise;
}

/** True when this machine can convert images at all. */
async function hasConverter() {
  return !!(await pickConverter());
}

async function toPng(buf, mime) {
  const conv = await pickConverter();
  if (!conv) return null;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shmakk-img-'));
  const src = path.join(dir, `in${EXT_BY_MIME.get(mime) || '.img'}`);
  const out = path.join(dir, 'out.png');
  try {
    await fs.promises.writeFile(src, buf);
    const res = await run(conv.name, conv.args(src, out), CONVERT_TIMEOUT_MS);
    if (res.code !== 0) return null;
    const png = await fs.promises.readFile(out);
    if (!png.length || png.length > MAX_OUTPUT_BYTES) return null;
    if (sniffMime(png) !== 'image/png') return null;
    return png;
  } catch {
    return null;
  } finally {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Normalisation ──────────────────────────────────────────────────────────

function skipReason() {
  return 'cannot be converted to png on this machine (install ffmpeg or ImageMagick)';
}

/**
 * Make one image safe to send to a vision provider.
 * Returns the image with `mimeType` corrected, `convertedFrom` when it had to
 * be re-encoded, or `unsupported: true` + `reason` when it cannot be sent.
 */
async function normalizeImage(image) {
  const data = typeof image?.data === 'string' ? image.data : '';
  if (!data) return { ...image, mimeType: cleanMime(image?.mimeType) || mimeFromExt(image?.name) || null, unsupported: true, reason: 'no image data' };

  let buf;
  try { buf = Buffer.from(data, 'base64'); } catch { buf = null; }
  if (!buf || !buf.length) return { ...image, mimeType: cleanMime(image?.mimeType) || null, unsupported: true, reason: 'image data is not valid base64' };
  if (buf.length > MAX_INPUT_BYTES) return { ...image, mimeType: cleanMime(image?.mimeType) || null, unsupported: true, reason: 'image is too large to send' };

  const mime = sniffMime(buf) || cleanMime(image?.mimeType) || mimeFromExt(image?.name) || null;
  if (!mime || !mime.startsWith('image/')) {
    return { ...image, mimeType: mime, unsupported: true, reason: 'not a recognised image format' };
  }
  if (PROVIDER_MIMES.has(mime)) return { ...image, mimeType: mime, data, dataLength: data.length };

  const png = await toPng(buf, mime);
  if (!png) return { ...image, mimeType: mime, unsupported: true, reason: skipReason() };
  const converted = png.toString('base64');
  return { ...image, mimeType: 'image/png', data: converted, dataLength: converted.length, convertedFrom: mime };
}

/** Normalise a list of images, splitting what can be sent from what cannot. */
async function normalizeImages(images) {
  const list = (Array.isArray(images) ? images : []).filter((img) => img && img.data);
  const out = await Promise.all(list.map((img) => normalizeImage(img)));
  const usable = [];
  const skipped = [];
  for (let i = 0; i < out.length; i++) {
    const img = out[i];
    if (img.unsupported) skipped.push({ name: img.name || list[i].name, mimeType: img.mimeType, reason: img.reason });
    else usable.push(img);
  }
  return { images: usable, skipped };
}

/** One-line note the model can read when an attachment could not be sent. */
function skippedNote(skipped) {
  const list = (Array.isArray(skipped) ? skipped : []).filter(Boolean);
  if (!list.length) return '';
  const parts = list.map((s) => `${s.name || 'image'} (${s.mimeType || 'unknown type'}${s.reason ? `, ${s.reason}` : ''})`);
  return `[Attached image${list.length > 1 ? 's' : ''} could not be shown: ${parts.join('; ')}]`;
}

module.exports = {
  PROVIDER_MIMES,
  MIME_BY_EXT,
  extOf,
  mimeFromExt,
  mimeForFile,
  isImagePath,
  sniffMime,
  isProviderMime,
  cleanMime,
  hasConverter,
  pickConverter,
  toPng,
  normalizeImage,
  normalizeImages,
  skippedNote,
};
