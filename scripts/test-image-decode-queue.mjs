/**
 * Focused checks for image full-res decode queue priority upgrade semantics.
 * Mirrors upgradeImageDecodeJob / visibility-skip gating in index.html.
 * Run: node scripts/test-image-decode-queue.mjs
 */

const IMAGE_DECODE_PRI_HIGH = 2;
const IMAGE_DECODE_PRI_DISPLAY = 1;

/** Keep in sync with upgradeImageDecodeJob() in index.html */
function upgradeImageDecodeJob(im, priority, display, itemId) {
  const job = im.decodeJob;
  if (!job) return;
  if (priority > job.priority) {
    job.priority = priority;
    job.display = false;
  }
  if (job.display && itemId) job.itemId = itemId;
}

function wouldVisibilitySkip(job, stillNeeded) {
  return !!(job.display && !stillNeeded);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeJob(overrides = {}) {
  return {
    priority: IMAGE_DECODE_PRI_DISPLAY,
    display: true,
    started: false,
    itemId: 'item-a',
    ...overrides,
  };
}

// High-priority joins a queued display job → upgrade, no visibility cancel.
{
  const im = { decodeJob: makeJob({ started: false }) };
  upgradeImageDecodeJob(im, IMAGE_DECODE_PRI_HIGH, false, null);
  assert(im.decodeJob.priority === IMAGE_DECODE_PRI_HIGH, 'queued: priority raised');
  assert(im.decodeJob.display === false, 'queued: display cleared');
  assert(!wouldVisibilitySkip(im.decodeJob, false), 'queued: high job not visibility-skipped');
}

// High-priority joins an already-started display job → same upgrade (P1 fix).
{
  const im = { decodeJob: makeJob({ started: true }) };
  upgradeImageDecodeJob(im, IMAGE_DECODE_PRI_HIGH, false, null);
  assert(im.decodeJob.priority === IMAGE_DECODE_PRI_HIGH, 'started: priority raised');
  assert(im.decodeJob.display === false, 'started: display cleared');
  assert(im.decodeJob.started === true, 'started: still the same job');
  assert(!wouldVisibilitySkip(im.decodeJob, false), 'started: high job not visibility-skipped when off-screen');
}

// Display-only job may still be skipped when off-screen.
{
  const job = makeJob({ started: true });
  assert(wouldVisibilitySkip(job, false), 'display-only off-screen skips');
  assert(!wouldVisibilitySkip(job, true), 'display-only on-screen does not skip');
}

// Lower/same priority must not downgrade a high job or re-enable display.
{
  const im = { decodeJob: makeJob({
    priority: IMAGE_DECODE_PRI_HIGH,
    display: false,
    started: true,
  }) };
  upgradeImageDecodeJob(im, IMAGE_DECODE_PRI_DISPLAY, true, 'item-b');
  assert(im.decodeJob.priority === IMAGE_DECODE_PRI_HIGH, 'no priority downgrade');
  assert(im.decodeJob.display === false, 'display stays false after high upgrade');
  assert(im.decodeJob.itemId === 'item-a', 'itemId unchanged when not display');
}

// Display→display can refresh itemId for distance prioritization.
{
  const im = { decodeJob: makeJob({ started: false, itemId: 'old' }) };
  upgradeImageDecodeJob(im, IMAGE_DECODE_PRI_DISPLAY, true, 'nearer');
  assert(im.decodeJob.display === true, 'display remains display');
  assert(im.decodeJob.itemId === 'nearer', 'display itemId updated');
}

/**
 * Mirrors requestImageDecode() handling when ensureFullBitmap returns a
 * synchronous non-Promise (missing/empty Blob → null).
 */
function requestImageDecodeHandleResult(im, result) {
  if (!result || typeof result.then !== 'function') {
    if (!im.bitmap) im.decodeFailed = true;
    return 'sync-fail';
  }
  return 'async';
}

// Sync null from ensureFullBitmap must not throw and must mark decodeFailed.
{
  const im = { bitmap: null, decodeFailed: false };
  let threw = false;
  try {
    const path = requestImageDecodeHandleResult(im, null);
    assert(path === 'sync-fail', 'null result uses sync-fail path');
  } catch {
    threw = true;
  }
  assert(!threw, 'sync null must not throw');
  assert(im.decodeFailed === true, 'invalid source marks decodeFailed');
}

// Empty / non-thenable values are treated the same (no .then call).
{
  const im = { bitmap: null, decodeFailed: false };
  assert(requestImageDecodeHandleResult(im, undefined) === 'sync-fail', 'undefined sync-fail');
  assert(im.decodeFailed === true, 'undefined marks decodeFailed');
  const im2 = { bitmap: null, decodeFailed: false };
  assert(requestImageDecodeHandleResult(im2, { then: 1 }) === 'sync-fail', 'non-function then is sync-fail');
  assert(im2.decodeFailed === true, 'non-thenable marks decodeFailed');
}

// Real promises still take the async path and do not eagerly set decodeFailed.
{
  const im = { bitmap: null, decodeFailed: false };
  const p = Promise.resolve(null);
  assert(requestImageDecodeHandleResult(im, p) === 'async', 'promise uses async path');
  assert(im.decodeFailed === false, 'async path does not sync-mark failed');
}

console.log('image-decode-queue: all checks passed');
