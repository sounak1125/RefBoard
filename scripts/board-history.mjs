/**
 * Delta-based board history.
 *
 * Every undo entry used to be a JSON snapshot of the whole board, taken at the
 * start of every gesture. Taking it was cheap (a third of a millisecond for
 * 2,000 items); what it cost was everything after: up to 64 MB of retained
 * strings, and a restore that parsed the whole board, replaced every item
 * object (so a live gesture or selection held orphans), and fixed groups up
 * in O(n^2).
 *
 * An entry is now the difference between two snapshots. `begin()` takes a
 * baseline (every item as JSON text, see snapshotBoard) and the entry is
 * finalised lazily, at the next `begin()` or at `undo()`, by
 * diffing the baseline against the board then: only changed properties of
 * changed items, items added or removed, the id order if it changed, and the
 * board props if they changed. Applying an entry mutates the live items in
 * place, so identity, selection and indexes survive, and touches only what
 * the entry names. An operation that changed nothing leaves no entry.
 *
 * Entries carry both directions, so undo applies `before` and redo applies
 * `after`; nothing is re-snapshotted when history moves. Owners may attach an
 * `extra` (a bitmap history reference) to an entry; such an entry is kept
 * even when the item delta is empty.
 */

/** Marks a property that does not exist on one side of a change. */
export const ABSENT = Object.freeze({ absent: true });

const isPlainObject = v => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneData(value[key]);
    return out;
  }
  return value;
}

export function sameData(a, b) {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !sameData(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * A snapshot: id order, every item as its JSON text by id, and the board
 * props as text. Text, not clones: V8 stringifies a small object faster than
 * a recursive copy, a string compare finds an unchanged item in one step, and
 * only the few items that differ are ever parsed. On 2,000 items this is a
 * fraction of a millisecond; a recursive clone plus recursive compare was ten
 * times that, slower than the whole-board snapshot it replaced.
 */
export function snapshotBoard(items, props = {}) {
  const order = [];
  const byId = new Map();
  for (const it of items || []) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    if (byId.has(id)) continue;
    order.push(id);
    byId.set(id, JSON.stringify(it));
  }
  return { order, byId, props: JSON.stringify(props ?? {}) };
}

function diffItem(before, after) {
  let b = null, a = null;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const inB = Object.prototype.hasOwnProperty.call(before, key);
    const inA = Object.prototype.hasOwnProperty.call(after, key);
    if (inB && inA && sameData(before[key], after[key])) continue;
    if (!b) { b = {}; a = {}; }
    b[key] = inB ? before[key] : ABSENT;
    a[key] = inA ? after[key] : ABSENT;
  }
  return b ? { before: b, after: a } : null;
}

/** null when the two snapshots describe the same board. */
export function diffSnapshots(before, after) {
  const changed = [];
  const removed = [];
  const added = [];
  for (const [id, text] of before.byId) {
    const next = after.byId.get(id);
    if (next === undefined) { removed.push([id, JSON.parse(text)]); continue; }
    if (next === text) continue;
    const d = diffItem(JSON.parse(text), JSON.parse(next));
    if (d) changed.push({ id, before: d.before, after: d.after });
  }
  for (const [id, text] of after.byId) if (!before.byId.has(id)) added.push([id, JSON.parse(text)]);
  const orderChanged = before.order.length !== after.order.length
    || before.order.some((id, i) => id !== after.order[i]);
  const propsChanged = before.props !== after.props;
  if (!changed.length && !removed.length && !added.length && !orderChanged && !propsChanged) return null;
  return {
    changed,
    removed,
    added,
    order: orderChanged ? { before: before.order.slice(), after: after.order.slice() } : null,
    props: propsChanged ? { before: JSON.parse(before.props), after: JSON.parse(after.props) } : null,
  };
}

/**
 * Apply one side of a delta to live data. Items are mutated in place; a new
 * array is returned only when membership or order changed. `direction` is
 * 'before' (undo) or 'after' (redo).
 */
export function applyDelta({ items, props }, delta, direction) {
  if (direction !== 'before' && direction !== 'after') throw new TypeError('direction must be before or after');
  const current = new Map();
  for (const it of items || []) if (it && it.id != null) current.set(String(it.id), it);
  let nextItems = null;
  if (delta.order) {
    // Items that exist in the target state but not now come back from the
    // clones the delta kept: removed ones for undo, added ones for redo.
    const resurrect = new Map(direction === 'before' ? delta.removed : delta.added);
    nextItems = [];
    for (const id of delta.order[direction]) {
      const live = current.get(id);
      if (live) { nextItems.push(live); continue; }
      const clone = resurrect.get(id);
      if (clone) { const copy = cloneData(clone); nextItems.push(copy); current.set(id, copy); }
    }
  }
  const changedIds = [];
  for (const change of delta.changed) {
    const live = current.get(change.id);
    if (!live) continue;
    const target = change[direction];
    for (const key of Object.keys(target)) {
      if (target[key] === ABSENT) delete live[key];
      else live[key] = cloneData(target[key]);
    }
    changedIds.push(change.id);
  }
  const nextProps = delta.props ? cloneData(delta.props[direction]) : null;
  return { items: nextItems, props: nextProps, changedIds };
}

/** Rough retained size, for the byte budget. */
export function estimateDeltaBytes(delta) {
  if (!delta) return 0;
  const text = JSON.stringify(delta, (key, value) => (value === ABSENT ? null : value instanceof Map ? [...value] : value));
  return text.length * 2;
}

/**
 * The stacks. `snapshot()` returns the board now; `release(entry)` is told
 * about every entry that leaves history so the owner can drop what it holds.
 */
export function createBoardHistory({
  snapshot,
  limit = () => 200,
  byteBudget = () => 64 * 1024 * 1024,
  minEntries = 3,
  release = () => {},
} = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('snapshot() is required');
  const undoStack = [];
  const redoStack = [];
  let pending = null;
  let baselines = 0;

  const value = fn => (typeof fn === 'function' ? fn() : fn);

  function bytes() {
    let total = 0;
    for (const e of undoStack) total += e.bytes || 0;
    for (const e of redoStack) total += e.bytes || 0;
    return total;
  }

  function trim() {
    const max = Math.max(1, Number(value(limit)) || 1);
    while (undoStack.length > max) release(undoStack.shift());
    const budget = Math.max(0, Number(value(byteBudget)) || 0);
    let total = bytes();
    while (total > budget && undoStack.length > minEntries) {
      const dropped = undoStack.shift();
      total -= dropped.bytes || 0;
      release(dropped);
    }
  }

  function clearRedo() {
    for (const e of redoStack) release(e);
    redoStack.length = 0;
  }

  /**
   * Turn the pending baseline into an entry, if the board changed since.
   * Returns the entry, or null; the snapshot it took is left in `lastTaken`
   * so a begin() in the same tick can reuse it instead of taking another.
   */
  let lastTaken = null;
  function finalize() {
    lastTaken = null;
    if (!pending) return null;
    const { base, extra } = pending;
    pending = null;
    const now = snapshot();
    lastTaken = now;
    const delta = diffSnapshots(base, now);
    if (!delta && !extra) return null;
    const entry = { delta, ...(extra || {}), bytes: estimateDeltaBytes(delta) };
    undoStack.push(entry);
    clearRedo();
    trim();
    return entry;
  }

  /**
   * Start an operation. The previous one, if still open, is finalised first,
   * and the board has not changed between that and this, so its snapshot is
   * the new baseline: one snapshot per gesture, not two.
   */
  function begin(extra = null) {
    finalize();
    pending = { base: lastTaken || snapshot(), extra };
    lastTaken = null;
    baselines++;
  }

  /** Any entry produced by the pending baseline is discarded. */
  function discardPending() {
    if (pending?.extra) release(pending.extra);
    pending = null;
  }

  function undo() {
    finalize();
    const entry = undoStack.pop();
    if (!entry) return null;
    redoStack.push(entry);
    return entry;
  }

  function redo() {
    // A pending operation that changed anything has already cleared redo.
    if (finalize()) return null;
    const entry = redoStack.pop();
    if (!entry) return null;
    undoStack.push(entry);
    trim();
    return entry;
  }

  function clear() {
    discardPending();
    for (const e of undoStack) release(e);
    for (const e of redoStack) release(e);
    undoStack.length = 0;
    redoStack.length = 0;
  }

  return {
    undoStack, redoStack,
    begin, finalize, discardPending, undo, redo, clear, trim, bytes,
    hasPending: () => !!pending,
    stats: () => ({ entries: undoStack.length, redoEntries: redoStack.length, bytes: bytes(), baselines, pending: !!pending }),
  };
}
