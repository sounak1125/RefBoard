'use strict';

/**
 * The sidecar board format.
 *
 * A board is two files: `<name>.refboard`, a small JSON index, and
 * `<name>.refboard.images`, an append-only store of the original image bytes.
 * The old single-file format embedded every image as a base64 data URL, so an
 * autosave after a three-pixel move rewrote every image byte of the board
 * (1.33x inflated) and a 2 GB board took 2 GB of I/O per save. Here a save
 * appends only images the store does not already hold, then rewrites the
 * index, which is items and view and a preview: about a megabyte for five
 * hundred images.
 *
 * Index: `{"format":"refboard-sidecar-1","preview":...,...core,"images":[...]}`.
 * `format` first so the file identifies itself in its first bytes; `preview`
 * second so the Explorer thumbnail handler, which regex-scans the first 512 KB,
 * still finds it; `images` last so the legacy header reader, which parses
 * everything before `,"images":[`, still gets a valid document. Each image
 * entry carries `offset` and `length` into the store.
 *
 * Store: an 8-byte magic, then records of `RBIM` + u32 meta length + meta JSON
 * ({id, type, size}) + payload. `offset` points at the payload. The record
 * header exists so the store can be scanned and an index rebuilt if the index
 * is ever lost. Records are never modified: a save appends, a deleted image's
 * bytes become garbage, and a compaction copies the referenced records into a
 * fresh store when garbage passes a threshold. A crash mid-append leaves a torn
 * tail that nothing references; the next append starts after it.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { replaceBoardFile } = require('./board-file-replace');

const INDEX_FORMAT = 'refboard-sidecar-1';
const INDEX_HEAD = `{"format":"${INDEX_FORMAT}"`;
const STORE_SUFFIX = '.images';
// 'RFBIMG', a NUL, then a format byte of 1: no text tool mistakes it for JSON.
const STORE_MAGIC = Buffer.from([0x52, 0x46, 0x42, 0x49, 0x4d, 0x47, 0x00, 0x01]);
const RECORD_MAGIC = Buffer.from('RBIM', 'latin1');
const RECORD_FIXED = RECORD_MAGIC.length + 4;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_META_BYTES = 64 * 1024;
const COPY_CHUNK = 4 * 1024 * 1024;
const COMPACT_MIN_GARBAGE_BYTES = 64 * 1024 * 1024;
const COMPACT_MIN_GARBAGE_RATIO = 0.25;

function sidecarStorePath(indexPath) {
  return `${path.resolve(String(indexPath || ''))}${STORE_SUFFIX}`;
}

function isSidecarIndexHead(buffer) {
  const head = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  return head.subarray(0, INDEX_HEAD.length).toString('utf8') === INDEX_HEAD;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Invalid image bytes');
}

function normalizeIndexImage(image) {
  const offset = Number(image?.offset);
  const length = Number(image?.length);
  if (!Number.isSafeInteger(offset) || offset < STORE_MAGIC.length) throw new Error(`Invalid store offset for image ${image?.id}`);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`Invalid store length for image ${image?.id}`);
  return {
    id: String(image.id || ''),
    type: String(image.type || 'application/octet-stream'),
    name: String(image.name || ''),
    w: Math.max(0, Math.round(Number(image.w) || 0)),
    h: Math.max(0, Math.round(Number(image.h) || 0)),
    size: Math.max(0, Math.round(Number(image.size) || length)),
    offset,
    length,
  };
}

function sidecarIndexJson(core, preview, images) {
  const { preview: _preview, images: _images, format: _format, ...rest } = core || {};
  const header = {
    format: INDEX_FORMAT,
    ...(typeof preview === 'string' && preview.length ? { preview } : {}),
    ...rest,
    app: 'refboard',
    version: 4,
    images: (images || []).map(normalizeIndexImage),
  };
  return JSON.stringify(header);
}

/** null when the file is not a sidecar index (a legacy embedded board, say). */
async function readSidecarIndex(indexPath) {
  const target = path.resolve(String(indexPath || ''));
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(INDEX_HEAD.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < head.length || !isSidecarIndexHead(head)) return null;
    if (stat.size > MAX_INDEX_BYTES) throw new Error('Board index is too large');
    const text = (await handle.readFile()).toString('utf8');
    const index = JSON.parse(text);
    if (index?.format !== INDEX_FORMAT || !Array.isArray(index.images)) throw new Error('Invalid board index');
    index.images = index.images.map(normalizeIndexImage);
    return index;
  } finally {
    await handle.close();
  }
}

async function writeSidecarIndex(indexPath, core, preview, images) {
  const target = path.resolve(String(indexPath || ''));
  const text = sidecarIndexJson(core, preview, images);
  const tempPath = `${target}.saving-${process.pid}-${crypto.randomUUID()}`;
  let handle = null;
  try {
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (err) {
    try { await handle?.close(); } catch { /* already closed */ }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
  await replaceBoardFile(target, tempPath);
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') };
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!bytesWritten) throw new Error('Short write to board image store');
    written += bytesWritten;
  }
}

async function readAll(handle, length, position) {
  const out = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(out, read, length - read, position + read);
    if (!bytesRead) throw new Error('Unexpected end of board image store');
    read += bytesRead;
  }
  return out;
}

async function initializeStore(handle) {
  await handle.truncate(0);
  await writeAll(handle, STORE_MAGIC, 0);
  await handle.sync();
  return { handle, size: STORE_MAGIC.length };
}

/**
 * Open a store for appending or reading. `create` makes a missing or empty
 * store; `truncate` starts a fresh one regardless (used when the index being
 * saved over is not a sidecar index, so nothing can reference the old bytes).
 */
async function openSidecarStore(storePath, { create = false, truncate = false } = {}) {
  const target = path.resolve(String(storePath || ''));
  let handle = null;
  try {
    handle = await fs.open(target, truncate ? 'w+' : 'r+');
  } catch (err) {
    if (err.code !== 'ENOENT' || !create) throw err;
    handle = await fs.open(target, 'w+');
    return initializeStore(handle);
  }
  try {
    if (truncate) return await initializeStore(handle);
    const stat = await handle.stat();
    if (stat.size < STORE_MAGIC.length) {
      if (!create) throw new Error('Board image store is empty');
      return await initializeStore(handle);
    }
    const head = await readAll(handle, STORE_MAGIC.length, 0);
    if (!head.equals(STORE_MAGIC)) throw new Error('Not a RefBoard image store');
    return { handle, size: stat.size };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

function recordHeader(image, length) {
  const meta = Buffer.from(JSON.stringify({
    id: String(image?.id || ''),
    type: String(image?.type || 'application/octet-stream'),
    size: length,
  }), 'utf8');
  if (meta.length > MAX_RECORD_META_BYTES) throw new Error('Image metadata too large');
  const head = Buffer.alloc(RECORD_FIXED + meta.length);
  RECORD_MAGIC.copy(head, 0);
  head.writeUInt32LE(meta.length, RECORD_MAGIC.length);
  meta.copy(head, RECORD_FIXED);
  return head;
}

/** Append one image; `store.size` advances. Returns the index entry fragment. */
async function appendSidecarImage(store, image, data) {
  const bytes = toBuffer(data);
  if (!bytes.length) throw new Error('Empty image bytes');
  const head = recordHeader(image, bytes.length);
  const start = store.size;
  await writeAll(store.handle, head, start);
  await writeAll(store.handle, bytes, start + head.length);
  store.size = start + head.length + bytes.length;
  return { id: String(image.id || ''), offset: start + head.length, length: bytes.length };
}

async function readSidecarImage(handle, image, storeSize = Infinity) {
  const offset = Number(image?.offset);
  const length = Number(image?.length);
  if (!Number.isSafeInteger(offset) || offset < STORE_MAGIC.length || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error('Invalid board image range');
  }
  if (offset + length > storeSize) throw new Error('Board image range is beyond the store');
  return readAll(handle, length, offset);
}

/**
 * Bytes in the store that no index entry references. A record's header is a
 * function of its id, type and length, all of which the index carries, so the
 * live total is exact and the remainder is dead records plus any torn tail.
 */
function sidecarGarbageBytes(storeSize, images) {
  const live = STORE_MAGIC.length + (images || []).reduce((total, image) => {
    const length = Number(image?.length) || 0;
    return total + recordHeader(image, length).length + length;
  }, 0);
  return Math.max(0, (Number(storeSize) || 0) - live);
}

function shouldCompactSidecar(storeSize, garbage, {
  minBytes = COMPACT_MIN_GARBAGE_BYTES,
  minRatio = COMPACT_MIN_GARBAGE_RATIO,
} = {}) {
  const size = Number(storeSize) || 0;
  const waste = Number(garbage) || 0;
  return waste >= minBytes && waste >= size * minRatio;
}

/**
 * Copy the referenced records into a fresh store and swap it in. Returns the
 * images with their new offsets. The caller must not hold the store open.
 */
async function compactSidecarStore(storePath, images) {
  const target = path.resolve(String(storePath || ''));
  const tempPath = `${target}.compact-${process.pid}-${crypto.randomUUID()}`;
  const source = await fs.open(target, 'r');
  let out = null;
  const moved = [];
  try {
    const sourceSize = (await source.stat()).size;
    out = await fs.open(tempPath, 'wx');
    const fresh = { handle: out, size: 0 };
    await writeAll(out, STORE_MAGIC, 0);
    fresh.size = STORE_MAGIC.length;
    for (const image of images || []) {
      const entry = normalizeIndexImage(image);
      if (entry.offset + entry.length > sourceSize) throw new Error(`Image ${entry.id} is beyond the store`);
      const head = recordHeader(entry, entry.length);
      const start = fresh.size;
      await writeAll(out, head, start);
      let copied = 0;
      while (copied < entry.length) {
        const chunk = await readAll(source, Math.min(COPY_CHUNK, entry.length - copied), entry.offset + copied);
        await writeAll(out, chunk, start + head.length + copied);
        copied += chunk.length;
      }
      fresh.size = start + head.length + entry.length;
      moved.push({ ...entry, offset: start + head.length });
    }
    await out.sync();
    await out.close();
    out = null;
    await source.close();
    await fs.rename(tempPath, target);
    return { images: moved, size: fresh.size };
  } catch (err) {
    try { await out?.close(); } catch { /* already closed */ }
    await source.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/** Walk the record headers. Stops at the first torn or foreign bytes. */
async function scanSidecarStore(storePath) {
  const target = path.resolve(String(storePath || ''));
  const handle = await fs.open(target, 'r');
  try {
    const size = (await handle.stat()).size;
    const records = [];
    if (size < STORE_MAGIC.length || !(await readAll(handle, STORE_MAGIC.length, 0)).equals(STORE_MAGIC)) {
      return { records, size, valid: false };
    }
    let position = STORE_MAGIC.length;
    let torn = false;
    while (position + RECORD_FIXED <= size) {
      const fixed = await readAll(handle, RECORD_FIXED, position);
      if (!fixed.subarray(0, RECORD_MAGIC.length).equals(RECORD_MAGIC)) { torn = true; break; }
      const metaLength = fixed.readUInt32LE(RECORD_MAGIC.length);
      if (metaLength > MAX_RECORD_META_BYTES || position + RECORD_FIXED + metaLength > size) { torn = true; break; }
      let meta;
      try { meta = JSON.parse((await readAll(handle, metaLength, position + RECORD_FIXED)).toString('utf8')); } catch { torn = true; break; }
      const offset = position + RECORD_FIXED + metaLength;
      const length = Number(meta?.size) || 0;
      if (length <= 0 || offset + length > size) { torn = true; break; }
      records.push({ id: String(meta.id || ''), type: String(meta.type || ''), offset, length });
      position = offset + length;
    }
    return { records, size, valid: true, torn, end: position };
  } finally {
    await handle.close();
  }
}

module.exports = {
  INDEX_FORMAT,
  STORE_SUFFIX,
  STORE_MAGIC,
  COMPACT_MIN_GARBAGE_BYTES,
  COMPACT_MIN_GARBAGE_RATIO,
  sidecarStorePath,
  isSidecarIndexHead,
  sidecarIndexJson,
  readSidecarIndex,
  writeSidecarIndex,
  openSidecarStore,
  appendSidecarImage,
  readSidecarImage,
  sidecarGarbageBytes,
  shouldCompactSidecar,
  compactSidecarStore,
  scanSidecarStore,
};
