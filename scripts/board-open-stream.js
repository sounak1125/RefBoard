'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { boardHeaderPrefix } = require('./board-save-format');

const IMAGES_MARKER = Buffer.from(',"images":[');
const DATA_MARKER = Buffer.from('"data":"data:');
const BASE64_MARKER = Buffer.from(';base64,');
const CHUNK_SIZE = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

async function readChunk(handle, position, size = CHUNK_SIZE) {
  const buffer = Buffer.allocUnsafe(size);
  const { bytesRead } = await handle.read(buffer, 0, size, position);
  return buffer.subarray(0, bytesRead);
}

async function readBoardPreview(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let nextPos = 0;
    let header = Buffer.alloc(0);
    let markerAt = -1;

    while (markerAt < 0 && nextPos < stat.size) {
      const chunk = await readChunk(handle, nextPos);
      if (!chunk.length) break;
      nextPos += chunk.length;
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_HEADER_BYTES) throw new Error('Board header is too large');
      markerAt = header.indexOf(IMAGES_MARKER);
    }
    if (markerAt < 0) return null;
    const core = JSON.parse(header.subarray(0, markerAt).toString('utf8') + '}');
    return typeof core.preview === 'string' && core.preview.length ? core.preview : null;
  } finally {
    await handle.close();
  }
}

async function scanBoardFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let nextPos = 0;
    let header = Buffer.alloc(0);
    let markerAt = -1;

    while (markerAt < 0 && nextPos < stat.size) {
      const chunk = await readChunk(handle, nextPos);
      if (!chunk.length) break;
      nextPos += chunk.length;
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_HEADER_BYTES) throw new Error('Board header is too large');
      markerAt = header.indexOf(IMAGES_MARKER);
    }
    if (markerAt < 0) throw new Error('Board images section not found');

    const core = JSON.parse(header.subarray(0, markerAt).toString('utf8') + '}');
    let scanBuf = header.subarray(markerAt + IMAGES_MARKER.length);
    let scanAbs = markerAt + IMAGES_MARKER.length;
    const images = [];

    async function appendChunk() {
      if (nextPos >= stat.size) return false;
      const chunk = await readChunk(handle, nextPos);
      if (!chunk.length) return false;
      nextPos += chunk.length;
      scanBuf = Buffer.concat([scanBuf, chunk]);
      return true;
    }

    while (true) {
      let dataAt = scanBuf.indexOf(DATA_MARKER);
      while (dataAt < 0) {
        if (scanBuf.indexOf(Buffer.from(']}')) >= 0 || nextPos >= stat.size) {
          return { core, images, size: stat.size };
        }
        if (!await appendChunk()) return { core, images, size: stat.size };
        dataAt = scanBuf.indexOf(DATA_MARKER);
      }

      const objectAt = scanBuf.lastIndexOf(Buffer.from('{'), dataAt);
      if (objectAt < 0) throw new Error('Invalid board image metadata');
      let base64At = scanBuf.indexOf(BASE64_MARKER, dataAt + DATA_MARKER.length);
      while (base64At < 0) {
        if (!await appendChunk()) throw new Error('Invalid board image data');
        base64At = scanBuf.indexOf(BASE64_MARKER, dataAt + DATA_MARKER.length);
      }

      const metaPrefix = scanBuf.subarray(objectAt, dataAt).toString('utf8');
      if (!metaPrefix.endsWith(',')) throw new Error('Invalid board image metadata separator');
      const meta = JSON.parse(metaPrefix.slice(0, -1) + '}');
      const localDataStart = base64At + BASE64_MARKER.length;
      const dataStart = scanAbs + localDataStart;
      let quoteAt = scanBuf.indexOf(0x22, localDataStart);

      if (quoteAt >= 0) {
        const dataEnd = scanAbs + quoteAt;
        images.push({ ...meta, dataStart, dataLength: dataEnd - dataStart, index: images.length });
        scanBuf = scanBuf.subarray(quoteAt + 1);
        scanAbs = dataEnd + 1;
        continue;
      }

      // Base64 may be hundreds of megabytes across the board, but one image is
      // never accumulated during the scan. Only offsets are retained.
      scanBuf = Buffer.alloc(0);
      scanAbs = nextPos;
      while (nextPos < stat.size) {
        const chunkStart = nextPos;
        const chunk = await readChunk(handle, nextPos);
        if (!chunk.length) break;
        nextPos += chunk.length;
        quoteAt = chunk.indexOf(0x22);
        if (quoteAt < 0) continue;
        const dataEnd = chunkStart + quoteAt;
        images.push({ ...meta, dataStart, dataLength: dataEnd - dataStart, index: images.length });
        scanBuf = chunk.subarray(quoteAt + 1);
        scanAbs = dataEnd + 1;
        break;
      }
      if (quoteAt < 0) throw new Error('Unterminated board image data');
    }
  } finally {
    await handle.close();
  }
}

async function readBoardImageBytes(filePath, image) {
  const start = Number(image?.dataStart);
  const length = Number(image?.dataLength);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error('Invalid board image range');
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const encoded = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(encoded, offset, length - offset, start + offset);
      if (!bytesRead) throw new Error('Unexpected end of board image');
      offset += bytesRead;
    }
    return Buffer.from(encoded.toString('ascii'), 'base64');
  } finally {
    await handle.close();
  }
}

/**
 * Splice an embedded preview into an existing .refboard file by rewriting only
 * the header before ,"images":[ and copying the image payload bytes unchanged.
 * Uses the same atomic backup/rename pattern as finish-board-save.
 */
async function rewriteBoardFilePreview(filePath, preview, opts = {}) {
  if (typeof preview !== 'string' || !preview.length) {
    throw new Error('Invalid board preview');
  }
  const target = String(filePath || '');
  if (!target) throw new Error('Missing board path');

  const token = opts.token || crypto.randomUUID();
  const pid = opts.pid || process.pid;
  const tempPath = `${target}.preview-${pid}-${token}`;
  let backupPath = null;

  const readHandle = await fs.open(target, 'r');
  try {
    const stat = await readHandle.stat();
    let nextPos = 0;
    let header = Buffer.alloc(0);
    let markerAt = -1;

    while (markerAt < 0 && nextPos < stat.size) {
      const chunk = await readChunk(readHandle, nextPos);
      if (!chunk.length) break;
      nextPos += chunk.length;
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_HEADER_BYTES) throw new Error('Board header is too large');
      markerAt = header.indexOf(IMAGES_MARKER);
    }
    if (markerAt < 0) throw new Error('Board images section not found');

    const core = JSON.parse(header.subarray(0, markerAt).toString('utf8') + '}');
    const { preview: _ignored, ...rest } = core;
    const newHeader = boardHeaderPrefix(rest, preview);
    const tailStart = markerAt + IMAGES_MARKER.length;

    let writeHandle = null;
    try {
      writeHandle = await fs.open(tempPath, 'wx');
      await writeHandle.write(newHeader);
      let copyPos = tailStart;
      while (copyPos < stat.size) {
        const chunk = await readChunk(readHandle, copyPos, Math.min(CHUNK_SIZE, stat.size - copyPos));
        if (!chunk.length) break;
        await writeHandle.write(chunk);
        copyPos += chunk.length;
      }
      await writeHandle.sync();
      await writeHandle.close();
      writeHandle = null;
    } catch (err) {
      try { await writeHandle?.close(); } catch { /* already closed */ }
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  } finally {
    await readHandle.close();
  }

  try {
    if (fsSync.existsSync(target)) {
      backupPath = `${target}.backup-${pid}-${token}`;
      await fs.rename(target, backupPath);
    }
    await fs.rename(tempPath, target);
    if (backupPath) await fs.unlink(backupPath).catch(() => {});
    return { written: true, filePath: target };
  } catch (err) {
    if (backupPath && !fsSync.existsSync(target)) {
      await fs.rename(backupPath, target).catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

module.exports = { scanBoardFile, readBoardImageBytes, readBoardPreview, rewriteBoardFilePreview };
