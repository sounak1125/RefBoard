/**
 * Copy-operation sequencing and serialized clipboard writes.
 * Used by index.html and scripts/test-clipboard-copy-order.mjs.
 */

export function createCopyOperationGate() {
  let seq = 0;
  return {
    begin() {
      return ++seq;
    },
    isCurrent(op) {
      return op === seq;
    },
    get current() {
      return seq;
    },
  };
}

/**
 * Serializes clipboard writes so they never run concurrently.
 * Before each write starts, skips if `isCurrent(op)` is false.
 * Failures are contained so the queue keeps serving later ops.
 */
export function createClipboardWriteQueue() {
  let chain = Promise.resolve();

  return {
    enqueue(op, isCurrent, writeFn) {
      const run = chain.then(async () => {
        if (!isCurrent(op)) return { ok: false, stale: true };
        try {
          await writeFn();
          // Another copy may have begun while we were writing; caller decides
          // whether to treat this as success for toast/local state.
          return { ok: true, stale: !isCurrent(op) };
        } catch (error) {
          return { ok: false, stale: !isCurrent(op), error };
        }
      });

      // Keep the chain alive even if a writeFn throws outside our try
      // (should not happen) or if callers ignore the returned promise.
      chain = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };
}

/**
 * Expand selected root IDs into the concrete item IDs a Cut/Delete should remove.
 * Group roots include their children at capture time.
 *
 * @param {Iterable<string>} rootIds
 * @param {(groupId: string) => Iterable<string>} getChildIds
 * @returns {Set<string>}
 */
export function expandSelectionDeleteIds(rootIds, getChildIds) {
  const toDelete = new Set();
  for (const id of rootIds) {
    if (typeof id !== 'string' || !id) continue;
    toDelete.add(id);
    const kids = getChildIds?.(id);
    if (!kids) continue;
    for (const cid of kids) {
      if (typeof cid === 'string' && cid) toDelete.add(cid);
    }
  }
  return toDelete;
}

/**
 * Cut may delete only after a winning copy that still owns its captured IDs.
 * @param {{ ok?: boolean, deleteIds?: string[] } | boolean | null | undefined} copyResult
 * @returns {string[] | null} ids to delete, or null if cut must no-op
 */
export function deleteIdsAfterSuccessfulCutCopy(copyResult) {
  if (!copyResult || copyResult.ok !== true) return null;
  if (!Array.isArray(copyResult.deleteIds) || !copyResult.deleteIds.length) return null;
  return copyResult.deleteIds.slice();
}
