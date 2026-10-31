/**
 * A small pool of resize workers (scripts/image-resize-worker.mjs).
 *
 * `resize(blob, options)` behaves like createImageBitmap(blob, options): it
 * resolves with an ImageBitmap, or rejects when that image cannot be decoded,
 * so callers keep their existing fallbacks. The difference is where the resize
 * runs -- see the worker for why that matters.
 *
 * Each worker holds one job at a time. That bounds decoded memory to `size`
 * full-resolution images in flight, which is the only reason a 5504 px PNG
 * opening alongside a hundred others cannot spike the renderer.
 *
 * If a worker cannot be created or dies, the pool stops using workers and
 * finishes every outstanding and later job with `fallback` (createImageBitmap
 * on the page). Slower to paint, never a lost image.
 *
 * Idle workers are terminated after `idleMs` and respawned on the next job.
 */
export function createImageResizePool({
  createWorker,
  fallback,
  size = 4,
  idleMs = 30_000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  if (typeof createWorker !== 'function') throw new TypeError('createWorker() is required');
  if (typeof fallback !== 'function') throw new TypeError('fallback() is required');
  const limit = Math.max(1, Math.floor(Number(size) || 1));

  const slots = [];          // { worker, job } -- job is null while idle
  const queue = [];          // jobs waiting for a free slot
  let seq = 0;
  let broken = false;
  let idleTimer = 0;
  const counts = { completed: 0, failed: 0, fallbacks: 0, workersCreated: 0 };

  function runFallback(job) {
    counts.fallbacks++;
    let result;
    try { result = Promise.resolve(fallback(job.blob, job.options)); }
    catch (err) { result = Promise.reject(err); }
    result.then(job.resolve, job.reject);
  }

  function breakPool() {
    if (broken) return;
    broken = true;
    clearTimer(idleTimer);
    idleTimer = 0;
    const stranded = [];
    for (const slot of slots) {
      if (slot.job) stranded.push(slot.job);
      try { slot.worker.terminate(); } catch { /* already gone */ }
    }
    slots.length = 0;
    stranded.push(...queue.splice(0));
    for (const job of stranded) runFallback(job);
  }

  function spawn() {
    let worker;
    try { worker = createWorker(); }
    catch { breakPool(); return null; }
    counts.workersCreated++;
    const slot = { worker, job: null };
    worker.onmessage = ({ data }) => {
      const job = slot.job;
      if (!job || data?.id !== job.id) return;
      slot.job = null;
      if (data.bitmap) { counts.completed++; job.resolve(data.bitmap); }
      else { counts.failed++; job.reject(new Error(data.error || 'Image resize failed')); }
      pump();
    };
    // A script that fails to load or a worker that crashes surfaces here; a
    // reply that cannot be deserialized surfaces as messageerror.
    worker.onerror = () => breakPool();
    worker.onmessageerror = () => breakPool();
    slots.push(slot);
    return slot;
  }

  function scheduleIdle() {
    clearTimer(idleTimer);
    idleTimer = 0;
    if (broken || queue.length || slots.some(slot => slot.job)) return;
    if (!slots.length || !(idleMs > 0)) return;
    idleTimer = setTimer(() => {
      idleTimer = 0;
      if (queue.length || slots.some(slot => slot.job)) return;
      for (const slot of slots.splice(0)) {
        try { slot.worker.terminate(); } catch { /* already gone */ }
      }
    }, idleMs);
  }

  function pump() {
    while (!broken && queue.length) {
      let slot = slots.find(s => !s.job);
      if (!slot && slots.length < limit) slot = spawn();
      if (broken) return;
      if (!slot) break;
      const job = queue.shift();
      slot.job = job;
      try {
        slot.worker.postMessage({ id: job.id, blob: job.blob, options: job.options });
      } catch {
        breakPool();
        return;
      }
    }
    scheduleIdle();
  }

  function resize(blob, options) {
    return new Promise((resolve, reject) => {
      const job = { id: ++seq, blob, options, resolve, reject };
      if (broken) { runFallback(job); return; }
      clearTimer(idleTimer);
      idleTimer = 0;
      queue.push(job);
      pump();
    });
  }

  function stats() {
    return {
      ...counts,
      workers: slots.length,
      busy: slots.filter(slot => slot.job).length,
      queued: queue.length,
      broken,
    };
  }

  return { resize, stats };
}
