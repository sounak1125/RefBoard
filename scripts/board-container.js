'use strict';

/**
 * The single-file board container.
 *
 * A board is one `.refboard` file again. Inside, it is an append-only log:
 *
 *   [magic 8][u32 stub length][head stub, padded to 512 KB]
 *   [image records ...]
 *   [index JSON][u64 index offset][u64 index length][trailer magic]
 *
 * A save appends only images the file does not already hold, then appends a
 * fresh index and trailer. Nothing already written is rewritten, so a crash
 * mid-save leaves the previous index intact; opening scans back from the end
 * for the last valid trailer. Deleted images and superseded indexes become
 * dead bytes; when enough have piled up the next save copies the live records
 * into a fresh file and swaps it in.
 *
 * The head stub exists for Explorer. The thumbnail handler regex-scans the
 * first 512 KB of the file for the preview, and on some shell streams it
 * cannot seek, so the tail is out of reach: the preview must be at the front.
 * Each save overwrites the stub in place with the current preview. The app
 * itself reads the index at the tail, which also carries the preview.
 *
 * Records use the same layout as the sidecar store (scripts/board-sidecar.js),
 * so its append and read helpers work on this file unchanged.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { appendSidecarImage, readSidecarImage } = require('./board-sidecar');

const INDEX_FORMAT = 'refboard-container-1';
// 'RFBD', a NUL, format byte 1, two reserved bytes.
const CONTAINER_MAGIC = Buffer.from([0x52, 0x46, 0x42, 0x44, 0x00, 0x01, 0x00, 0x00]);
const TRAILER_MAGIC = Buffer.from('RFBDIDX1', 'latin1');
const HEAD_REGION_BYTES = 512 * 1024;
const STUB_OFFSET = CONTAINER_MAGIC.length + 4;
const STUB_BYTES = HEAD_REGION_BYTES - STUB_OFFSET;
const TRAILER_BYTES = 8 + 8 + TRAILER_MAGIC.length;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const RECOVERY_SCAN_CHUNK = 4 * 1024 * 1024;
/* Compaction copies the whole live board, so it waits for a quarter of the
   file to be dead. The floor is small because a small board is cheap to copy
   and would otherwise grow to the floor before its first compaction. */
const COMPACT_MIN_GARBAGE_BYTES = 4 * 1024 * 1024;
const COMPACT_MIN_GARBAGE_RATIO = 0.25;

function isContainerHead(buffer) {
  const head = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  return head.length >= CONTAINER_MAGIC.length && head.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC);
}

async function writeAll(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!bytesWritten) throw new Error('Short write to board file');
    written += bytesWritten;
  }
}

async function readAll(handle, length, position) {
  const out = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(out, read, length - read, position + read);
    if (!bytesRead) throw new Error('Unexpected end of board file');
    read += bytesRead;
  }
  return out;
}

function normalizeIndexImage(image) {
  const offset = Number(image?.offset);
  const length = Number(image?.length);
  if (!Number.isSafeInteger(offset) || offset < HEAD_REGION_BYTES) throw new Error(`Invalid record offset for image ${image?.id}`);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`Invalid record length for image ${image?.id}`);
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

/** The tail index. `preview` is the last key so it sits nearest the end. */
function containerIndexJson(core, preview, images) {
  const { preview: _preview, images: _images, format: _format, ...rest } = core || {};
  const header = {
    format: INDEX_FORMAT,
    ...rest,
    app: 'refboard',
    version: 5,
    images: (images || []).map(normalizeIndexImage),
    ...(typeof preview === 'string' && preview.length ? { preview } : {}),
  };
  return JSON.stringify(header);
}

/**
 * The head stub: a small JSON document that carries the preview for tools that
 * read only the front of the file. Padded with spaces to the region size. A
 * preview too large for the region is left out of the stub (the index at the
 * tail still has it) rather than truncated into something unreadable.
 */
function headStubBuffer(preview) {
  const withPreview = typeof preview === 'string' && preview.length
    ? JSON.stringify({ format: INDEX_FORMAT, preview, app: 'refboard', version: 5 })
    : null;
  let text = withPreview && Buffer.byteLength(withPreview, 'utf8') <= STUB_BYTES
    ? withPreview
    : JSON.stringify({ format: INDEX_FORMAT, app: 'refboard', version: 5 });
  const buf = Buffer.alloc(STUB_BYTES, 0x20);
  buf.write(text, 0, 'utf8');
  return buf;
}

async function writeHead(handle, preview) {
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32LE(STUB_BYTES, 0);
  await writeAll(handle, Buffer.concat([CONTAINER_MAGIC, lengthBuf, headStubBuffer(preview)]), 0);
}

function trailerBuffer(indexOffset, indexLength) {
  const buf = Buffer.alloc(TRAILER_BYTES);
  buf.writeBigUInt64LE(BigInt(indexOffset), 0);
  buf.writeBigUInt64LE(BigInt(indexLength), 8);
  TRAILER_MAGIC.copy(buf, 16);
  return buf;
}

function parseTrailer(buf, trailerEnd) {
  if (buf.length !== TRAILER_BYTES || !buf.subarray(16).equals(TRAILER_MAGIC)) return null;
  const indexOffset = Number(buf.readBigUInt64LE(0));
  const indexLength = Number(buf.readBigUInt64LE(8));
  if (!Number.isSafeInteger(indexOffset) || !Number.isSafeInteger(indexLength)) return null;
  if (indexLength <= 0 || indexLength > MAX_INDEX_BYTES) return null;
  if (indexOffset < HEAD_REGION_BYTES || indexOffset + indexLength + TRAILER_BYTES !== trailerEnd) return null;
  return { indexOffset, indexLength };
}

async function readIndexAt(handle, trailer) {
  const text = (await readAll(handle, trailer.indexLength, trailer.indexOffset)).toString('utf8');
  const index = JSON.parse(text);
  if (index?.format !== INDEX_FORMAT || !Array.isArray(index.images)) throw new Error('Invalid board index');
  index.images = index.images.map(normalizeIndexImage);
  return index;
}

/**
 * The newest valid index. The trailer at the very end is the normal case; if
 * it is torn (a crash mid-save), scan back for the last trailer magic whose
 * index parses. Returns null only when no index exists at all.
 */
async function readContainerIndex(handle, size) {
  if (size >= HEAD_REGION_BYTES + TRAILER_BYTES) {
    const trailer = parseTrailer(await readAll(handle, TRAILER_BYTES, size - TRAILER_BYTES), size);
    if (trailer) {
      try { return { index: await readIndexAt(handle, trailer), ...trailer, recovered: false }; } catch { /* fall through to recovery */ }
    }
  }
  // Recovery: walk back through the file looking for trailer magics.
  let end = size;
  while (end > HEAD_REGION_BYTES) {
    const start = Math.max(HEAD_REGION_BYTES, end - RECOVERY_SCAN_CHUNK);
    const chunk = await readAll(handle, end - start, start);
    let at = chunk.lastIndexOf(TRAILER_MAGIC);
    while (at >= 0) {
      const trailerStart = start + at - 16;
      if (trailerStart >= HEAD_REGION_BYTES) {
        const trailer = parseTrailer(await readAll(handle, TRAILER_BYTES, trailerStart), trailerStart + TRAILER_BYTES);
        if (trailer) {
          try { return { index: await readIndexAt(handle, trailer), ...trailer, recovered: true }; } catch { /* keep looking */ }
        }
      }
      at = at > 0 ? chunk.lastIndexOf(TRAILER_MAGIC, at - 1) : -1;
    }
    // Overlap by a trailer so a magic split across chunks is still seen.
    end = start + TRAILER_MAGIC.length;
    if (start === HEAD_REGION_BYTES) break;
  }
  return null;
}

async function initializeContainer(handle) {
  await handle.truncate(0);
  await writeHead(handle, null);
  await handle.sync();
  return { handle, size: HEAD_REGION_BYTES, index: null, indexOffset: null, indexLength: 0, recovered: false };
}

/**
 * Open a board file for appending or reading. `create` makes a missing file;
 * `truncate` starts over. The result carries the newest index, if any.
 */
async function openContainer(filePath, { create = false, truncate = false, write = true } = {}) {
  const target = path.resolve(String(filePath || ''));
  let handle = null;
  try {
    handle = await fs.open(target, truncate ? 'w+' : write ? 'r+' : 'r');
  } catch (err) {
    if (err.code !== 'ENOENT' || !create) throw err;
    handle = await fs.open(target, 'w+');
    return initializeContainer(handle);
  }
  try {
    if (truncate) return await initializeContainer(handle);
    const size = (await handle.stat()).size;
    if (size < HEAD_REGION_BYTES) {
      if (!create) throw new Error('Not a RefBoard board file');
      return await initializeContainer(handle);
    }
    const head = await readAll(handle, CONTAINER_MAGIC.length, 0);
    if (!head.equals(CONTAINER_MAGIC)) throw new Error('Not a RefBoard board file');
    const found = await readContainerIndex(handle, size);
    return {
      handle, size,
      index: found?.index || null,
      indexOffset: found?.indexOffset ?? null,
      indexLength: found?.indexLength ?? 0,
      recovered: !!found?.recovered,
    };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/** Append one image record; `container.size` advances. */
function appendContainerImage(container, image, data) {
  return appendSidecarImage(container, image, data);
}

function readContainerImage(handle, image, size) {
  return readSidecarImage(handle, image, size);
}

/**
 * Append a fresh index and trailer, then refresh the head stub, then flush.
 * The trailer goes last so a crash before it leaves the previous one valid.
 */
async function writeContainerIndex(container, core, preview, images) {
  // The head stub is the preview's home. The tail index repeats it only when
  // it was too large for the stub; otherwise every save would append another
  // copy of a 100 KB JPEG that nothing reads.
  const previewInStub = typeof preview === 'string' && preview.length
    && Buffer.byteLength(JSON.stringify({ format: INDEX_FORMAT, preview, app: 'refboard', version: 5 }), 'utf8') <= STUB_BYTES;
  const text = Buffer.from(containerIndexJson(core, previewInStub ? null : preview, images), 'utf8');
  const indexOffset = container.size;
  await writeAll(container.handle, text, indexOffset);
  await writeAll(container.handle, trailerBuffer(indexOffset, text.length), indexOffset + text.length);
  await container.handle.sync();
  await writeHead(container.handle, preview);
  await container.handle.sync();
  container.size = indexOffset + text.length + TRAILER_BYTES;
  container.indexOffset = indexOffset;
  container.indexLength = text.length;
  return { indexOffset, indexLength: text.length, size: container.size };
}

const RECORD_MAGIC = Buffer.from('RBIM', 'latin1');

function recordHeader(image, length) {
  const meta = Buffer.from(JSON.stringify({
    id: String(image?.id || ''),
    type: String(image?.type || 'application/octet-stream'),
    size: length,
  }), 'utf8');
  const head = Buffer.alloc(RECORD_MAGIC.length + 4 + meta.length);
  RECORD_MAGIC.copy(head, 0);
  head.writeUInt32LE(meta.length, RECORD_MAGIC.length);
  meta.copy(head, RECORD_MAGIC.length + 4);
  return head;
}

function recordHeaderLength(image, length) {
  return recordHeader(image, length).length;
}

/** Bytes nothing references: dead records, superseded indexes, torn tails. */
function containerGarbageBytes(size, images, indexLength = 0) {
  const live = HEAD_REGION_BYTES
    + (images || []).reduce((total, image) => {
      const length = Number(image?.length) || 0;
      return total + recordHeaderLength(image, length) + length;
    }, 0)
    + (indexLength > 0 ? indexLength + TRAILER_BYTES : 0);
  return Math.max(0, (Number(size) || 0) - live);
}

function shouldCompactContainer(size, garbage, {
  minBytes = COMPACT_MIN_GARBAGE_BYTES,
  minRatio = COMPACT_MIN_GARBAGE_RATIO,
} = {}) {
  const total = Number(size) || 0;
  const waste = Number(garbage) || 0;
  return waste >= minBytes && waste >= total * minRatio;
}

/**
 * Write a fresh container holding the given records (copied from `source`,
 * which may be this same file or a sidecar store) and the given index, then
 * swap it over `filePath`. Returns the images with their new offsets. The
 * caller must not hold `filePath` open for writing.
 */
async function rebuildContainer(filePath, { sourcePath, core, preview, images, onProgress = null }) {
  const target = path.resolve(String(filePath || ''));
  const tempPath = `${target}.saving-${process.pid}-${crypto.randomUUID()}`;
  const source = await fs.open(path.resolve(String(sourcePath)), 'r');
  let out = null;
  try {
    const sourceSize = (await source.stat()).size;
    out = await fs.open(tempPath, 'wx');
    await writeHead(out, null);
    const fresh = { handle: out, size: HEAD_REGION_BYTES };
    const moved = [];
    for (const image of images || []) {
      const length = Number(image.length);
      if (!Number.isSafeInteger(image.offset) || !Number.isSafeInteger(length) || length <= 0 || image.offset + length > sourceSize) {
        throw new Error(`Image ${image.id} is beyond the source`);
      }
      // Same record layout the append helper writes: magic, meta length, meta, payload.
      const head = recordHeader(image, length);
      const start = fresh.size;
      await writeAll(out, head, start);
      let copied = 0;
      while (copied < length) {
        const chunk = await readAll(source, Math.min(4 * 1024 * 1024, length - copied), image.offset + copied);
        await writeAll(out, chunk, start + head.length + copied);
        copied += chunk.length;
      }
      fresh.size = start + head.length + length;
      moved.push(normalizeIndexImage({ ...image, offset: start + head.length, length }));
      onProgress?.(moved.length);
    }
    await writeContainerIndex(fresh, core, preview, moved);
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

/** The preview, from the head stub (front of the file) or the tail index. */
async function readContainerPreview(filePath) {
  const target = path.resolve(String(filePath || ''));
  const handle = await fs.open(target, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < HEAD_REGION_BYTES) return null;
    const head = await readAll(handle, STUB_OFFSET, 0);
    if (!head.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) return null;
    const stubLength = Math.min(head.readUInt32LE(CONTAINER_MAGIC.length), STUB_BYTES);
    const stub = (await readAll(handle, stubLength, STUB_OFFSET)).toString('utf8').trimEnd();
    try {
      const parsed = JSON.parse(stub);
      if (typeof parsed?.preview === 'string' && parsed.preview.length) return parsed.preview;
    } catch { /* stub torn; use the index */ }
    const found = await readContainerIndex(handle, size);
    return typeof found?.index?.preview === 'string' && found.index.preview.length ? found.index.preview : null;
  } finally {
    await handle.close();
  }
}

module.exports = {
  INDEX_FORMAT,
  CONTAINER_MAGIC,
  HEAD_REGION_BYTES,
  TRAILER_BYTES,
  COMPACT_MIN_GARBAGE_BYTES,
  COMPACT_MIN_GARBAGE_RATIO,
  isContainerHead,
  containerIndexJson,
  openContainer,
  readContainerIndex,
  appendContainerImage,
  readContainerImage,
  writeContainerIndex,
  containerGarbageBytes,
  shouldCompactContainer,
  rebuildContainer,
  readContainerPreview,
};
