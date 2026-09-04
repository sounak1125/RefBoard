/**
 * Board-space spatial index over the item array.
 *
 * Every frame culled by scanning all items; every hover hit-tested by scanning
 * all items twice; a marquee scanned them per pointermove; and each group's
 * frame was recomputed by filtering all items for its children, per group, per
 * scan. On a 500-image board that is thousands of rectangle tests per mouse
 * move before anything is drawn.
 *
 * This keeps, per item, its board-space bounding box and z position, bucketed
 * into a uniform grid, plus each group's children and their union bounds. The
 * renderer has many geometry mutation sites, so the index is never maintained
 * incrementally: it rebuilds lazily when the owner says geometry changed (the
 * same signal that already invalidates the workspace bounds), when the item
 * array is replaced or grows, or when a hit is found at a position that no
 * longer holds it. A rebuild is one pass over the items; a query is one or a
 * few cells. Groups are not bucketed: their rectangle depends on the zoom
 * (screen-pixel padding), and there are few of them, so callers scan
 * `groups()` and use `childrenBounds()`.
 *
 * Results are always in z order (array position) so a hit test can take the
 * topmost candidate and a cull can draw in board order.
 */
export function createSpatialIndex({
  items,
  bounds,
  isGroup = () => false,
  groupIdOf = it => it?.groupId || null,
  minCell = 64,
  maxCell = 1 << 16,
} = {}) {
  if (typeof items !== 'function') throw new TypeError('items() is required');
  if (typeof bounds !== 'function') throw new TypeError('bounds(item) is required');

  let dirty = true;
  let indexedArray = null;
  let indexedLength = -1;
  let cellSize = 256;
  let cells = new Map();
  let entries = new Map();      // item -> { x, y, w, h, z }
  let groupList = [];
  let childrenByGroup = new Map();
  let childBounds = new Map();
  let content = null;
  let memos = new Map();
  let rebuilds = 0;

  const key = (cx, cy) => `${cx},${cy}`;
  const cellOf = v => Math.floor(v / cellSize);

  function rebuild() {
    const arr = items();
    cells = new Map();
    entries = new Map();
    groupList = [];
    childrenByGroup = new Map();
    childBounds = new Map();
    memos = new Map();
    content = null;
    const boxes = [];
    let edgeSum = 0;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;

    for (let z = 0; z < arr.length; z++) {
      const it = arr[z];
      if (!it) continue;
      if (isGroup(it)) {
        groupList.push(it);
        entries.set(it, { x: 0, y: 0, w: 0, h: 0, z, group: true });
        continue;
      }
      const b = bounds(it);
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const e = { x: b.x, y: b.y, w: Math.max(0, b.w || 0), h: Math.max(0, b.h || 0), z, group: false };
      entries.set(it, e);
      boxes.push([it, e]);
      edgeSum += Math.max(e.w, e.h);
      if (e.x < x1) x1 = e.x;
      if (e.y < y1) y1 = e.y;
      if (e.x + e.w > x2) x2 = e.x + e.w;
      if (e.y + e.h > y2) y2 = e.y + e.h;
      const gid = groupIdOf(it);
      if (gid) {
        let list = childrenByGroup.get(gid);
        if (!list) childrenByGroup.set(gid, list = []);
        list.push(it);
        let cb = childBounds.get(gid);
        if (!cb) childBounds.set(gid, cb = { x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h });
        else {
          if (e.x < cb.x1) cb.x1 = e.x;
          if (e.y < cb.y1) cb.y1 = e.y;
          if (e.x + e.w > cb.x2) cb.x2 = e.x + e.w;
          if (e.y + e.h > cb.y2) cb.y2 = e.y + e.h;
        }
      }
    }
    if (boxes.length) content = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };

    // Cells about twice the typical item, so most items touch one to four cells.
    const typical = boxes.length ? edgeSum / boxes.length : 256;
    cellSize = Math.min(maxCell, Math.max(minCell, Math.ceil(typical * 2) || minCell));
    for (const [it, e] of boxes) {
      const cx0 = cellOf(e.x), cx1 = cellOf(e.x + e.w), cy0 = cellOf(e.y), cy1 = cellOf(e.y + e.h);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = key(cx, cy);
          let list = cells.get(k);
          if (!list) cells.set(k, list = []);
          list.push(it);
        }
      }
    }
    indexedArray = arr;
    indexedLength = arr.length;
    dirty = false;
    rebuilds++;
  }

  function ensure() {
    const arr = items();
    if (dirty || arr !== indexedArray || arr.length !== indexedLength) rebuild();
  }

  /**
   * A hit whose recorded position no longer holds it means the array was
   * reordered in place. Rebuild, and tell the caller to run its query again.
   */
  function stale(it) {
    const e = entries.get(it);
    if (e && indexedArray[e.z] === it) return false;
    rebuild();
    return true;
  }

  function intersects(e, x, y, w, h) {
    return e.x < x + w && e.x + e.w > x && e.y < y + h && e.y + e.h > y;
  }

  function queryRect(x, y, w, h) {
    ensure();
    if (!content || !(w >= 0) || !(h >= 0)) return [];
    // Nothing lives outside the content bounds, so a huge viewport clamps to
    // them; if it still spans more cells than there are items, a scan is cheaper.
    const qx0 = Math.max(x, content.x), qy0 = Math.max(y, content.y);
    const qx1 = Math.min(x + w, content.x + content.w), qy1 = Math.min(y + h, content.y + content.h);
    if (qx1 < qx0 || qy1 < qy0) return [];
    const cx0 = cellOf(qx0), cx1 = cellOf(qx1), cy0 = cellOf(qy0), cy1 = cellOf(qy1);
    const out = [];
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > entries.size) {
      for (const [it, e] of entries) if (!e.group && intersects(e, x, y, w, h)) out.push(it);
    } else {
      const seen = new Set();
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const list = cells.get(key(cx, cy));
          if (!list) continue;
          for (const it of list) {
            if (seen.has(it)) continue;
            seen.add(it);
            if (intersects(entries.get(it), x, y, w, h)) out.push(it);
          }
        }
      }
    }
    out.sort((a, b) => entries.get(a).z - entries.get(b).z);
    if (out.length && stale(out[out.length - 1])) return queryRect(x, y, w, h);
    return out;
  }

  /** Non-group items whose box contains the point, topmost first. */
  function queryPoint(x, y) {
    ensure();
    if (!content) return [];
    const list = cells.get(key(cellOf(x), cellOf(y)));
    if (!list) return [];
    const out = [];
    for (const it of list) {
      const e = entries.get(it);
      if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) out.push(it);
    }
    out.sort((a, b) => entries.get(b).z - entries.get(a).z);
    if (out.length && stale(out[0])) return queryPoint(x, y);
    return out;
  }

  function boundsOf(it) {
    ensure();
    const e = entries.get(it);
    return e && !e.group ? { x: e.x, y: e.y, w: e.w, h: e.h } : null;
  }

  function zOf(it) {
    ensure();
    return entries.get(it)?.z ?? -1;
  }

  function groups() {
    ensure();
    return groupList;
  }

  function children(gid) {
    ensure();
    const list = childrenByGroup.get(gid);
    return list ? list.slice() : [];
  }

  function childrenBounds(gid) {
    ensure();
    const cb = childBounds.get(gid);
    return cb ? { x: cb.x1, y: cb.y1, w: cb.x2 - cb.x1, h: cb.y2 - cb.y1 } : null;
  }

  function contentBounds() {
    ensure();
    return content ? { ...content } : null;
  }

  /** Cache a derived value until the next rebuild. */
  function memo(name, compute) {
    ensure();
    if (memos.has(name)) return memos.get(name);
    const value = compute(indexedArray);
    memos.set(name, value);
    return value;
  }

  function invalidate() { dirty = true; }

  function stats() {
    return { rebuilds, cellSize, cells: cells.size, items: entries.size, groups: groupList.length, dirty };
  }

  return { ensure, invalidate, queryRect, queryPoint, boundsOf, zOf, groups, children, childrenBounds, contentBounds, memo, stats };
}
