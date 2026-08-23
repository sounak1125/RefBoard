'use strict';
/* Worker entry for the content-aware fill engine (§27).
 *
 * Loads the engine modules as plain scripts sharing a `self.CAF` namespace, so
 * the same sources run unchanged under vm.runInContext() in the Node tests.
 *
 * Protocol
 *   in   { type: 'fill', id, width, height, pixels, mask, samplingMask?, timeBudgetMs?, options? }
 *   in   { type: 'cancel', id }
 *   out  { type: 'progress', id, stage, percent }
 *   out  { type: 'result',   id, result }
 *   out  { type: 'error',    id, error, cancelled? }
 *
 * All heavy buffers travel as transferables in both directions.
 *
 * Cancelling a fill that is already running (§27)
 * ----------------------------------------------
 * The solve is synchronous, so it cannot drain its own message queue: a
 * 'cancel' posted after the job started is not seen until the job ends. Two
 * mechanisms therefore do the real work, and both are honoured here:
 *
 *   - `timeBudgetMs`, checked at every level and sweep, which ends the run
 *     cleanly and reports `cancelled: true`;
 *   - `worker.terminate()` from the host, which is immediate and releases every
 *     buffer with the thread.
 *
 * The renderer uses terminate() for the Cancel button and the budget as a
 * backstop. The 'cancel' message remains meaningful for a job that has not
 * started yet. A shared-memory flag would allow true mid-run cooperative
 * cancellation, but SharedArrayBuffer needs cross-origin isolation, which a
 * file:// page cannot have.
 */
importScripts(
  './common.js',
  './options.js',
  './mask-processor.js',
  './sampling-area.js',
  './structure-analyzer.js',
  './confidence.js',
  './image-pyramid.js',
  './nnf.js',
  './patch-distance.js',
  './patchmatch.js',
  './patch-voting.js',
  './shift-labeling.js',
  './color-adapter.js',
  './seam-blender.js',
  './inpaint-fallback.js',
  './quality-report.js',
  './debug-capture.js',
  './content-aware-fill.js'
);

(function (root) {
  const CAF = root.CAF;
  const cancelled = new Set();
  let activeId = null;

  const PROGRESS_INTERVAL_MS = 80;

  function runFill(message) {
    const id = message.id;
    activeId = id;
    let lastPost = 0;

    let lastStage = null;
    const onProgress = (stage, percent) => {
      const now = Date.now();
      /* Throttled, because the solve reports far more often than a UI can use
       * and every post is a structured clone across the worker boundary — but
       * never so throttled that a stage goes unannounced. A fill that finishes
       * quickly would otherwise report only "Preparing image" and "Complete",
       * which tells the user nothing about what it did. */
      const stageChanged = stage !== lastStage;
      if (!stageChanged && now - lastPost < PROGRESS_INTERVAL_MS && percent < 1) return;
      lastPost = now;
      lastStage = stage;
      root.postMessage({ type: 'progress', id, stage, percent: percent * 100 });
    };

    const deadline = message.timeBudgetMs > 0 ? Date.now() + message.timeBudgetMs : Infinity;
    const isCancelled = () => cancelled.has(id) || Date.now() > deadline;

    const options = Object.assign({}, message.options || {}, { onProgress, isCancelled });

    const result = CAF.fill(
      { data: message.pixels, width: message.width, height: message.height },
      message.mask,
      message.samplingMask || null,
      options
    );

    if (cancelled.has(id)) throw new CAF.Cancelled();

    const payload = {
      pixels: result.pixels,
      metrics: result.metrics,
      confidence: result.confidence,
      lowConfidence: result.lowConfidence,
      hardRejected: result.hardRejected,
      unsafeReasons: result.unsafeReasons,
      flaggedReasons: result.flaggedReasons,
      lowConfidenceReasons: result.lowConfidenceReasons,
      status: result.status,
      algorithmUsed: result.algorithmUsed,
      processingTime: result.processingTime,
    };
    const transfer = [result.pixels.buffer];

    if (message.options && message.options.debug) {
      payload.confidenceMap = result.confidenceMap;
      transfer.push(result.confidenceMap.buffer);
      payload.debugInfo = {
        notes: result.debugInfo.notes,
        layers: result.debugInfo.layers.map(layer => ({
          name: layer.name, width: layer.width, height: layer.height, data: layer.data,
        })),
      };
      for (const layer of payload.debugInfo.layers) transfer.push(layer.data.buffer);
    }

    root.postMessage({ type: 'result', id, result: payload }, transfer);
  }

  root.onmessage = event => {
    const message = event.data || {};
    if (message.type === 'cancel') {
      if (message.id) cancelled.add(message.id);
      else if (activeId) cancelled.add(activeId);
      return;
    }
    if (message.type !== 'fill') return;
    const id = message.id;
    try {
      runFill(message);
    } catch (err) {
      const isCancel = err && err.name === 'Cancelled';
      root.postMessage({
        type: 'error',
        id,
        cancelled: isCancel,
        error: isCancel ? 'Content-aware fill cancelled' : String((err && err.stack) || err),
      });
    } finally {
      cancelled.delete(id);
      if (activeId === id) activeId = null;
    }
  };
})(self);
