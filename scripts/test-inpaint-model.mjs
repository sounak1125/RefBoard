/**
 * The content-aware fill model manager, against a local HTTP server.
 *
 * The real model is 208 MB, so these run the same code on a small file with
 * its own size and hash. What they pin: only a file that matches both is ever
 * moved into place, an interrupted download resumes instead of starting over,
 * a server that ignores Range still ends with the right file, and a
 * cancellation leaves the partial download to resume from.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INPAINT_MODEL, modelFilePath, verifyModelFile, findModel, downloadModel } = require('./inpaint-model.js');

// The shipped description: the app downloads exactly this file, from a RefBoard release.
assert.equal(INPAINT_MODEL.bytes, 208044816);
assert.match(INPAINT_MODEL.sha256, /^[0-9a-f]{64}$/);
assert.match(INPAINT_MODEL.url, /^https:\/\/github\.com\/sounak1125\/RefBoard\/releases\/download\/[^/]+\/lama_fp32\.onnx$/);
assert.ok(Object.isFrozen(INPAINT_MODEL), 'the shipped model description must not be mutable at runtime');

const payload = crypto.randomBytes(3 * 1024 * 1024 + 4321);
const spec = {
  id: 'test-model',
  file: 'model.bin',
  bytes: payload.length,
  sha256: crypto.createHash('sha256').update(payload).digest('hex'),
};
const wrong = Buffer.from(payload);
wrong[wrong.length >> 1] ^= 0xff;

const served = [];
const server = http.createServer((req, res) => {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  served.push({ url: req.url, range: req.headers.range || null });
  if (req.url === '/model.bin') {
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'Content-Length': payload.length - start });
    res.end(payload.subarray(start));
  } else if (req.url === '/no-range.bin') {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  } else if (req.url === '/wrong.bin') {
    res.writeHead(200, { 'Content-Length': wrong.length });
    res.end(wrong);
  } else if (req.url === '/cut.bin') {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.write(payload.subarray(0, 1024 * 1024), () => res.destroy());
  } else if (req.url === '/slow.bin') {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.write(payload.subarray(0, 64 * 1024));
    setTimeout(() => res.end(payload.subarray(64 * 1024)), 2000);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-inpaint-model-'));
let userData = tmp;
const fresh = async name => { userData = path.join(tmp, name); await fs.mkdir(userData, { recursive: true }); };
const download = (url, extra = {}) => downloadModel({ userDataDir: userData, fetchImpl: fetch, spec, url: `${base}${url}`, ...extra });
const finalPath = () => modelFilePath(userData, spec);
const partPath = () => `${finalPath()}.part`;
const exists = p => fs.stat(p).then(() => true, () => false);

try {
  // Nothing on disk: no model.
  await fresh('empty');
  assert.equal(await findModel({ userDataDir: userData, spec }), null);

  // A clean download lands in place, reports progress up to the total, and is found afterwards.
  await fresh('clean');
  const progress = [];
  const file = await download('/model.bin', { onProgress: p => progress.push(p) });
  assert.equal(file, finalPath());
  assert.deepEqual(await fs.readFile(file), payload);
  assert.equal(await exists(partPath()), false, 'the .part file is renamed, not left behind');
  assert.ok(progress.length >= 2, 'progress is reported while the download runs');
  assert.deepEqual(progress.at(-1), { received: payload.length, total: payload.length });
  assert.ok(progress.every((p, i) => i === 0 || p.received >= progress[i - 1].received), 'progress never goes backwards');
  assert.equal(await findModel({ userDataDir: userData, spec }), file);

  // The verified record is trusted only while size and mtime still match: a corrupted copy is rejected.
  const marker = JSON.parse(await fs.readFile(`${file}.verified.json`, 'utf8'));
  assert.equal(marker.sha256, spec.sha256);
  await fs.writeFile(file, wrong);
  assert.equal(await verifyModelFile(file, spec), false, 'a rewritten file has a new mtime and must be re-hashed');
  assert.equal(await findModel({ userDataDir: userData, spec }), null);

  // A copy elsewhere (the dev lab) is accepted when it verifies.
  const elsewhere = path.join(tmp, 'elsewhere.bin');
  await fs.writeFile(elsewhere, payload);
  assert.equal(await findModel({ userDataDir: userData, spec, extraCandidates: [elsewhere] }), elsewhere);

  // An interrupted download resumes with a Range request and only fetches the rest.
  await fresh('resume');
  await fs.mkdir(path.dirname(finalPath()), { recursive: true });
  await fs.writeFile(partPath(), payload.subarray(0, 1000000));
  served.length = 0;
  assert.deepEqual(await fs.readFile(await download('/model.bin')), payload);
  assert.equal(served.at(-1).range, 'bytes=1000000-', 'the resume asks only for the missing bytes');

  // A server that ignores Range sends the whole file; the download starts over and still ends correct.
  await fresh('no-range');
  await fs.mkdir(path.dirname(finalPath()), { recursive: true });
  await fs.writeFile(partPath(), Buffer.alloc(500000, 7));
  assert.deepEqual(await fs.readFile(await download('/no-range.bin')), payload);

  // Wrong bytes of the right size fail the checksum, and nothing is moved into place.
  await fresh('wrong');
  await assert.rejects(download('/wrong.bin'), /checksum/);
  assert.equal(await exists(finalPath()), false);
  assert.equal(await exists(partPath()), false, 'a file that failed its checksum is not kept to resume from');

  // A dropped connection keeps the partial file, so the next attempt resumes.
  await fresh('cut');
  await assert.rejects(download('/cut.bin'));
  assert.equal(await exists(finalPath()), false);
  assert.ok((await fs.stat(partPath())).size > 0, 'the partial download is kept to resume from');
  assert.deepEqual(await fs.readFile(await download('/model.bin')), payload);

  // HTTP errors are reported, not written to disk.
  await fresh('missing');
  await assert.rejects(download('/nope.bin'), /HTTP 404/);
  assert.equal(await exists(finalPath()), false);

  // Cancelling stops the download with an AbortError and keeps what arrived.
  await fresh('cancel');
  const controller = new AbortController();
  const cancelled = download('/slow.bin', {
    signal: controller.signal,
    onProgress: p => { if (p.received > 0) controller.abort(); },
  });
  await assert.rejects(cancelled, err => err.name === 'AbortError');
  assert.equal(await exists(finalPath()), false);
} finally {
  server.closeAllConnections?.();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('inpaint model download tests passed');
