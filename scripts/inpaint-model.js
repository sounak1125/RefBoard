'use strict';

/**
 * The content-aware fill model: where it is kept, whether a usable copy is on
 * this machine, and fetching it once.
 *
 * The model is not in the installer. The first fill downloads it into
 * userData/models/<id>/, streaming it through SHA-256 as it arrives, and only
 * a file whose size and hash both match is moved into place. A `.part` left
 * by an interrupted download is resumed with a Range request.
 *
 * Hashing 208 MB on every check would cost about a second of disk, so a
 * verified file is recorded next to it with its size and mtime, and later
 * checks trust that record while both still match.
 *
 * Every function takes the model description as `spec`, defaulting to the one
 * the app ships with, so the tests can exercise the same code on a small file.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

/* Carve's 512x512 export of big-LaMa (Apache-2.0), re-hosted on a RefBoard
   release so the app never depends on a third-party URL. */
const INPAINT_MODEL = Object.freeze({
  id: 'lama-512-v1',
  file: 'lama_fp32.onnx',
  bytes: 208044816,
  sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
  url: 'https://github.com/sounak1125/RefBoard/releases/download/inpaint-model-v1/lama_fp32.onnx',
});

function modelFilePath(userDataDir, spec = INPAINT_MODEL) {
  return path.join(userDataDir, 'models', spec.id, spec.file);
}

const markerPath = file => `${file}.verified.json`;

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest('hex');
}

async function readMarker(file) {
  try {
    return JSON.parse(await fsp.readFile(markerPath(file), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(file, stat, spec) {
  return fsp.writeFile(markerPath(file), JSON.stringify({ sha256: spec.sha256, size: stat.size, mtimeMs: stat.mtimeMs }));
}

/** True when `file` is the expected model, byte for byte. */
async function verifyModelFile(file, spec = INPAINT_MODEL) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== spec.bytes) return false;
  const marker = await readMarker(file);
  if (marker && marker.sha256 === spec.sha256 && marker.size === stat.size && marker.mtimeMs === stat.mtimeMs) {
    return true;
  }
  if (await hashFile(file) !== spec.sha256) return false;
  // A read-only location only costs the next check another hash.
  await writeMarker(file, stat, spec).catch(() => {});
  return true;
}

/** The first verified copy among the downloaded one and any extra candidates. */
async function findModel({ userDataDir, extraCandidates = [], spec = INPAINT_MODEL }) {
  for (const candidate of [modelFilePath(userDataDir, spec), ...extraCandidates]) {
    if (await verifyModelFile(candidate, spec)) return candidate;
  }
  return null;
}

function abortError() {
  const err = new Error('The download was cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * Download the model into place and resolve with its path. `fetchImpl` is
 * Electron's net.fetch in the app (system proxy, redirects) and Node's fetch in
 * tests; progress arrives as { received, total }.
 */
async function downloadModel({
  userDataDir, fetchImpl, spec = INPAINT_MODEL, url = spec.url, onProgress = () => {}, signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('downloadModel needs a fetch implementation');
  const finalPath = modelFilePath(userDataDir, spec);
  const partPath = `${finalPath}.part`;
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  let received = 0;
  let hash = crypto.createHash('sha256');
  try {
    const part = await fsp.stat(partPath);
    if (part.size > 0 && part.size < spec.bytes) {
      for await (const chunk of fs.createReadStream(partPath, { highWaterMark: 1 << 20 })) hash.update(chunk);
      received = part.size;
    } else {
      await fsp.rm(partPath, { force: true });
    }
  } catch { /* nothing to resume */ }

  if (signal?.aborted) throw abortError();
  let res;
  try {
    res = await fetchImpl(url, { headers: received ? { Range: `bytes=${received}-` } : {}, signal, redirect: 'follow' });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw abortError();
    throw new Error(`The model download could not start (${err?.message || err})`);
  }
  if (received && res.status === 200) {
    // The server ignored the range and sent the whole file: start over.
    received = 0;
    hash = crypto.createHash('sha256');
  } else if (!(res.status === 200 || (received && res.status === 206))) {
    throw new Error(`The model download failed (HTTP ${res.status})`);
  }

  const out = fs.createWriteStream(partPath, { flags: received ? 'a' : 'w' });
  const closed = once(out, 'close');
  let failure = null;
  try {
    onProgress({ received, total: spec.bytes });
    for await (const value of res.body) {
      if (signal?.aborted) throw abortError();
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      received += chunk.length;
      if (received > spec.bytes) throw new Error('The model download was larger than expected');
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      onProgress({ received, total: spec.bytes });
    }
  } catch (err) {
    failure = err;
  } finally {
    out.end();
    await closed;
  }
  if (failure) {
    if (signal?.aborted || failure.name === 'AbortError') throw abortError();
    if (received > spec.bytes) await fsp.rm(partPath, { force: true });
    throw failure;
  }

  if (received !== spec.bytes) {
    throw new Error(`The model download stopped early (${received} of ${spec.bytes} bytes)`);
  }
  if (hash.digest('hex') !== spec.sha256) {
    await fsp.rm(partPath, { force: true });
    throw new Error('The downloaded model failed its checksum');
  }
  await fsp.rename(partPath, finalPath);
  await writeMarker(finalPath, await fsp.stat(finalPath), spec);
  return finalPath;
}

module.exports = {
  INPAINT_MODEL,
  modelFilePath,
  verifyModelFile,
  findModel,
  downloadModel,
};
