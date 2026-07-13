/**
 * Small policy object for RefBoard's decoded-image working set.
 * Records are owned by the renderer; this module only tracks/pins/evicts them.
 */
export function createImageResidencyController({
  maxFullPixels = 24_000_000,
  records,
  closeBitmap = bitmap => bitmap?.close?.(),
} = {}) {
  if (typeof records !== 'function') throw new TypeError('records() is required');
  let clock = 0;

  function prepare(record) {
    if (!record) return record;
    if (!Number.isFinite(record.fullLastUsed)) record.fullLastUsed = 0;
    if (!Number.isFinite(record.fullPinCount)) record.fullPinCount = 0;
    return record;
  }

  function pixels(record) {
    return record?.bitmap ? Math.max(0, Number(record.w) || 0) * Math.max(0, Number(record.h) || 0) : 0;
  }

  function touch(record) {
    if (!record) return;
    prepare(record).fullLastUsed = ++clock;
  }

  function pin(record) {
    if (!record) return;
    prepare(record).fullPinCount++;
    touch(record);
  }

  function unpin(record) {
    if (!record) return;
    prepare(record).fullPinCount = Math.max(0, record.fullPinCount - 1);
  }

  function close(record) {
    if (!record?.bitmap || prepare(record).fullPinCount > 0 || record.decodePromise) return false;
    const bitmap = record.bitmap;
    record.bitmap = null;
    try { closeBitmap(bitmap); } catch {}
    return true;
  }

  function stats() {
    let fullPixels = 0, decodedCount = 0, pinnedCount = 0;
    for (const raw of records()) {
      const record = prepare(raw);
      if (record?.bitmap) {
        decodedCount++;
        fullPixels += pixels(record);
      }
      if (record?.fullPinCount > 0) pinnedCount++;
    }
    return { fullPixels, decodedCount, pinnedCount, maxFullPixels };
  }

  function evict({ protect = null } = {}) {
    let { fullPixels, decodedCount } = stats();
    if (fullPixels <= maxFullPixels) return 0;
    const candidates = [...records()]
      .map(prepare)
      .filter(record => record?.bitmap && record !== protect && !record.decodePromise && record.fullPinCount === 0)
      .sort((a, b) => a.fullLastUsed - b.fullLastUsed);
    let count = 0;
    for (const record of candidates) {
      if (fullPixels <= maxFullPixels) break;
      // A single source may exceed the whole budget. Retain the most-recent
      // working image so high zoom does not enter a decode/evict loop.
      if (decodedCount <= 1) break;
      const amount = pixels(record);
      if (close(record)) {
        fullPixels = Math.max(0, fullPixels - amount);
        decodedCount--;
        count++;
      }
    }
    return count;
  }

  return { prepare, pixels, touch, pin, unpin, close, stats, evict };
}
