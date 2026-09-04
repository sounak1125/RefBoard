/**
 * id -> item lookup for the board's item array.
 *
 * `byId` used to be `state.items.find`. That is O(n) per call, and its callers
 * are the hot ones: twice per moved item per pointermove, three passes per
 * arrow-key repeat, once per item in undo's group fix-up (O(n^2) per undo), and
 * once per queued LOD job per queue pick. On a 500-image board a select-all
 * drag ran about a million comparisons per mouse event.
 *
 * The array is replaced wholesale in a dozen places and pushed to in a few, so
 * rather than asking every mutation site to maintain an index, the index
 * validates itself against the live array on every lookup. A changed array
 * identity or length rebuilds it. A hit is confirmed at its recorded position,
 * so an in-place sort cannot hand back the wrong object; a failed confirmation
 * rebuilds once. Duplicate ids resolve to the first occurrence, as find() did.
 *
 * The one mutation it cannot see is an element replaced at a fixed length by an
 * item with a *different* id. Nothing in the renderer does that; every site
 * either reassigns the array or pushes.
 */
export function createItemIndex(items) {
  if (typeof items !== 'function') throw new TypeError('items() is required');
  let indexedArray = null;
  let indexedLength = -1;
  let positions = new Map();
  let rebuilds = 0;

  function rebuild(arr) {
    positions = new Map();
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (it && it.id != null && !positions.has(it.id)) positions.set(it.id, i);
    }
    indexedArray = arr;
    indexedLength = arr.length;
    rebuilds++;
  }

  function byId(id) {
    if (id == null) return undefined;
    const arr = items();
    if (!Array.isArray(arr)) return undefined;
    if (arr !== indexedArray || arr.length !== indexedLength) rebuild(arr);
    let pos = positions.get(id);
    if (pos === undefined) return undefined;
    const it = arr[pos];
    if (it && it.id === id) return it;
    // Same array, same length, item not where it was: an in-place reorder.
    rebuild(arr);
    pos = positions.get(id);
    return pos === undefined ? undefined : arr[pos];
  }

  byId.stats = () => ({ rebuilds, size: positions.size });
  return byId;
}
