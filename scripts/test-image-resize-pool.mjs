import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageResizePool } from './image-resize-pool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

/* A worker the test answers by hand. */
function harness({ size = 2, failCreate = false } = {}) {
  const workers = [];
  const fallbacks = [];
  const timers = [];
  const pool = createImageResizePool({
    size,
    idleMs: 1000,
    createWorker() {
      if (failCreate) throw new Error('no workers here');
      const w = {
        sent: [],
        terminated: false,
        postMessage(msg) { this.sent.push(msg); },
        terminate() { this.terminated = true; },
        reply(data) { this.onmessage({ data }); },
      };
      workers.push(w);
      return w;
    },
    fallback(blob, options) {
      fallbacks.push({ blob, options });
      return Promise.resolve({ fallbackBitmap: blob });
    },
    setTimer(fn, ms) { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimer(id) { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  return { pool, workers, fallbacks, timers };
}

/* --- one job per worker, no more than `size` workers, the rest queue in order --- */
{
  const { pool, workers } = harness({ size: 2 });
  const opts = { resizeWidth: 10, resizeHeight: 5, resizeQuality: 'high' };
  const p = ['a', 'b', 'c', 'd'].map(blob => pool.resize(blob, opts));
  assert.equal(workers.length, 2, 'spawns up to size workers');
  assert.deepEqual(workers.map(w => w.sent.length), [1, 1], 'one job in flight per worker');
  assert.equal(workers[0].sent[0].blob, 'a');
  assert.equal(workers[1].sent[0].blob, 'b');
  assert.deepEqual(workers[0].sent[0].options, opts, 'options reach the worker unchanged');
  assert.equal(pool.stats().queued, 2);

  workers[1].reply({ id: workers[1].sent[0].id, bitmap: 'B' });
  assert.equal(await p[1], 'B', 'resolves with the worker bitmap');
  assert.equal(workers[1].sent[1].blob, 'c', 'the freed worker takes the oldest queued job');

  workers[0].reply({ id: workers[0].sent[0].id, error: 'bad png' });
  await assert.rejects(p[0], /bad png/, 'a per-image failure rejects like createImageBitmap would');
  assert.equal(workers[0].sent[1].blob, 'd', 'a failed job frees its worker too');

  // A stale reply (wrong id) must not settle the current job.
  workers[0].reply({ id: 999, bitmap: 'stale' });
  assert.equal(pool.stats().busy, 2, 'a reply for another id is ignored');
  workers[0].reply({ id: workers[0].sent[1].id, bitmap: 'D' });
  workers[1].reply({ id: workers[1].sent[1].id, bitmap: 'C' });
  assert.deepEqual([await p[2], await p[3]], ['C', 'D']);
  const s = pool.stats();
  assert.equal(s.completed, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.fallbacks, 0);
  assert.equal(s.workersCreated, 2, 'workers are reused, not respawned per job');
}

/* --- a dead worker hands everything outstanding, and later, to the fallback --- */
{
  const { pool, workers, fallbacks } = harness({ size: 1 });
  const first = pool.resize('x', { resizeWidth: 1, resizeHeight: 1 });
  const queued = pool.resize('y', { resizeWidth: 2, resizeHeight: 2 });
  workers[0].onerror(new Event('error'));
  assert.deepEqual(await first, { fallbackBitmap: 'x' }, 'the in-flight job is finished on the page');
  assert.deepEqual(await queued, { fallbackBitmap: 'y' }, 'the queued job is finished on the page');
  assert.ok(workers[0].terminated, 'the broken worker is terminated');
  const later = await pool.resize('z', { resizeWidth: 3, resizeHeight: 3 });
  assert.deepEqual(later, { fallbackBitmap: 'z' }, 'later jobs go straight to the fallback');
  assert.equal(workers.length, 1, 'a broken pool does not respawn');
  assert.equal(fallbacks.length, 3);
  assert.ok(pool.stats().broken);
}

/* --- an undeliverable reply breaks the pool the same way --- */
{
  const { pool, workers } = harness({ size: 1 });
  const job = pool.resize('m', {});
  workers[0].onmessageerror(new Event('messageerror'));
  assert.deepEqual(await job, { fallbackBitmap: 'm' });
}

/* --- no Worker at all: every job uses the fallback --- */
{
  const { pool, workers, fallbacks } = harness({ failCreate: true });
  assert.deepEqual(await pool.resize('q', {}), { fallbackBitmap: 'q' });
  assert.equal(workers.length, 0);
  assert.equal(fallbacks.length, 1);
}

/* --- idle workers are let go, and come back on demand --- */
{
  const { pool, workers, timers } = harness({ size: 2 });
  const job = pool.resize('i', {});
  assert.equal(timers.filter(t => t.live).length, 0, 'no idle timer while a job is in flight');
  workers[0].reply({ id: workers[0].sent[0].id, bitmap: 'I' });
  await job;
  const idle = timers.filter(t => t.live);
  assert.equal(idle.length, 1, 'an idle pool arms one timer');
  assert.equal(idle[0].ms, 1000);
  idle[0].fn();
  assert.ok(workers[0].terminated, 'idle workers are terminated');
  assert.equal(pool.stats().workers, 0);
  const again = pool.resize('j', {});
  assert.equal(workers.length, 2, 'a new job spawns a fresh worker');
  workers[1].reply({ id: workers[1].sent[0].id, bitmap: 'J' });
  assert.equal(await again, 'J');
}

/* --- a new job cancels a pending idle shutdown --- */
{
  const { pool, workers, timers } = harness({ size: 1 });
  const a = pool.resize('a', {});
  workers[0].reply({ id: workers[0].sent[0].id, bitmap: 'A' });
  await a;
  const armed = timers.filter(t => t.live)[0];
  const b = pool.resize('b', {});
  assert.equal(armed.live, false, 'the idle timer is cleared by new work');
  assert.equal(workers[0].sent.length, 2, 'the warm worker takes the job');
  workers[0].reply({ id: workers[0].sent[1].id, bitmap: 'B' });
  assert.equal(await b, 'B');
  assert.ok(!workers[0].terminated);
}

/* --- the page does no resize-on-decode of its own --- */
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));
  // Every createImageBitmap call on the page, with its argument list.
  const calls = [...script.matchAll(/createImageBitmap\(([^;]*?)\)\s*[;,)]/gs)].map(m => m[1]);
  assert.ok(calls.length > 0, 'found the page createImageBitmap calls');
  const resizing = calls.filter(args => /resize(?:Width|Height)/.test(args));
  assert.deepEqual(resizing, [], 'no page createImageBitmap call passes resize options');
  assert.match(script, /new Worker\('\.\/scripts\/image-resize-worker\.mjs', \{ type: 'module' \}\)/,
    'the pool loads the worker by a literal path the build-files guard can see');
  assert.match(script, /fallback: \(blob, options\) => createImageBitmap\(blob, options\)/,
    'the page fallback is plain createImageBitmap');
  for (const caller of ['createStableImageProxy', 'runImageLodJob', 'clipboardImageData']) {
    const start = script.indexOf(`function ${caller}(`);
    assert.ok(start > 0, `${caller} exists`);
    const body = script.slice(start, script.indexOf('\n}\n', start));
    assert.match(body, /resizeImageBlob\(/, `${caller} resizes through the pool`);
  }
  await tick();
}

console.log('image resize pool tests passed');
