/**
 * Small policy object for RefBoard's decoded-image working set.
 * Records are owned by the renderer; this module only tracks/pins/evicts them.
 *
 * `maxFullPixels` accepts a function so the ceiling can follow a user setting
 * and the live size of the other decoded pools instead of being frozen at
 * construction time.
 *
 * `isProtected` lets the owner exempt records from eviction for a reason the
 * LRU clock cannot see: the frame that just drew them, or the admission plan
 * that is about to. Without it, being drawn only bumped the clock, and a decode
 * finishing for one image could close the bitmap of another that was still on
 * screen -- which then re-requested its decode and closed a third. On a dense
 * board that loop is a visible sharp/soft cycle at a fixed view.
 */
export function createImageResidencyController({
  maxFullPixels = 24_000_000,
  records,
  closeBitmap = bitmap => bitmap?.close?.(),
  isProtected = null,
} = {}) {
  if (typeof records !== 'function') throw new TypeError('records() is required');
  let clock = 0;

  function budget() {
    const raw = typeof maxFullPixels === 'function' ? maxFullPixels() : maxFullPixels;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

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

  function protectedByOwner(record) {
    if (typeof isProtected !== 'function') return false;
    try { return !!isProtected(record); } catch { return false; }
  }

  function stats() {
    let fullPixels = 0, decodedCount = 0, pinnedCount = 0, protectedCount = 0;
    for (const raw of records()) {
      const record = prepare(raw);
      if (record?.bitmap) {
        decodedCount++;
        fullPixels += pixels(record);
        if (protectedByOwner(record)) protectedCount++;
      }
      if (record?.fullPinCount > 0) pinnedCount++;
    }
    return { fullPixels, decodedCount, pinnedCount, protectedCount, maxFullPixels: budget() };
  }

  function evict({ protect = null } = {}) {
    const cap = budget();
    let { fullPixels, decodedCount } = stats();
    if (fullPixels <= cap) return 0;
    const candidates = [...records()]
      .map(prepare)
      .filter(record => record?.bitmap && record !== protect && !record.decodePromise
        && record.fullPinCount === 0 && !protectedByOwner(record))
      .sort((a, b) => a.fullLastUsed - b.fullLastUsed);
    let count = 0;
    for (const record of candidates) {
      if (fullPixels <= cap) break;
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
