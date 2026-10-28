/**
 * Deterministic ordering helpers for exporting board images, and the visual
 * rows that the same reading order is built from, which alignment also moves.
 *
 * Selection order is deliberately kept separate from board/z-order. The UI can
 * therefore preserve Shift-click order while marquee and Select All operations
 * supply a visual reading order.
 */

const finite = value => Number.isFinite(value) ? value : 0;

function itemRect(item, getBounds) {
  const raw = getBounds ? getBounds(item) : item;
  const x = finite(raw?.x);
  const y = finite(raw?.y);
  const w = Math.max(0, finite(raw?.w));
  const h = Math.max(0, finite(raw?.h));
  return {
    x, y, w, h,
    right: x + w,
    bottom: y + h,
    cx: x + w / 2,
    cy: y + h / 2,
  };
}

export function uniqueIds(ids = []) {
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

const decorate = (items, getBounds) => items.map((item, index) => ({ item, index, rect: itemRect(item, getBounds) }));
const stable = (a, b, primary, secondary) =>
  primary(a.rect) - primary(b.rect)
  || secondary(a.rect) - secondary(b.rect)
  || a.index - b.index;

/**
 * Sort items by a direction or by visual reading order. Visual order clusters
 * overlapping items into rows, then reads rows top-to-bottom and left-to-right.
 * A vertical stack naturally becomes one item per row.
 */
export function sortItemsForExport(items = [], order = 'visual', getBounds) {
  const decorated = decorate(items, getBounds);

  if (order === 'horizontal') {
    return decorated.sort((a, b) => stable(a, b, r => r.x, r => r.y)).map(d => d.item);
  }
  if (order === 'vertical') {
    return decorated.sort((a, b) => stable(a, b, r => r.y, r => r.x)).map(d => d.item);
  }
  return visualRows(decorated).flatMap(row => row.entries.map(entry => entry.item));
}

/**
 * Line the rows of a selection up like lines of text. Each visual row moves
 * sideways as one block, so the spacing inside it is kept: 'left' starts every
 * row at the selection's left edge, 'right' ends it at the right edge, and
 * 'center' centres it between the two. Items alone in their row, as in a
 * column, simply line up. Items `follows` picks out (arrows, pen marks) never
 * shape a row or its edges; each moves with the row whose band holds its
 * centre, or stays put between rows.
 */
export function rowAlignShifts(items = [], align = 'left', getBounds, follows = () => false) {
  const anchors = [];
  const followers = [];
  for (const entry of decorate(items, getBounds)) (follows(entry.item) ? followers : anchors).push(entry);
  const rows = visualRows(anchors);
  if (!rows.length) return { rows: 0, shifts: [] };
  for (const row of rows) {
    row.left = Math.min(...row.entries.map(entry => entry.rect.x));
    row.right = Math.max(...row.entries.map(entry => entry.rect.right));
  }
  const left = Math.min(...rows.map(row => row.left));
  const right = Math.max(...rows.map(row => row.right));
  const shifts = [];
  for (const row of rows) {
    row.dx = align === 'right' ? right - row.right
      : align === 'center' ? (left + right - row.left - row.right) / 2
        : left - row.left;
    for (const entry of row.entries) shifts.push({ item: entry.item, dx: row.dx });
  }
  for (const entry of followers) {
    const row = rows.find(r => entry.rect.cy >= r.top && entry.rect.cy <= r.bottom);
    shifts.push({ item: entry.item, dx: row ? row.dx : 0 });
  }
  return { rows: rows.length, shifts };
}

/**
 * Cluster decorated items into rows: an item joins the row it overlaps most
 * once that overlap reaches 35% of the smaller height. Rows come back top to
 * bottom with their entries left to right.
 */
function visualRows(decorated) {
  const rows = [];
  decorated.sort((a, b) => stable(a, b, r => r.y, r => r.x));
  for (const entry of decorated) {
    let bestRow = null;
    let bestScore = -1;
    for (const row of rows) {
      const overlap = Math.min(entry.rect.bottom, row.bottom) - Math.max(entry.rect.y, row.top);
      if (overlap <= 0) continue;
      const smallerHeight = Math.max(1, Math.min(entry.rect.h, row.bottom - row.top));
      const score = overlap / smallerHeight;
      if (score >= 0.35 && score > bestScore) {
        bestRow = row;
        bestScore = score;
      }
    }
    if (!bestRow) {
      rows.push({ top: entry.rect.y, bottom: entry.rect.bottom, entries: [entry] });
      continue;
    }
    bestRow.entries.push(entry);
    bestRow.top = Math.min(bestRow.top, entry.rect.y);
    bestRow.bottom = Math.max(bestRow.bottom, entry.rect.bottom);
  }

  rows.sort((a, b) => a.top - b.top || a.entries[0].index - b.entries[0].index);
  for (const row of rows) row.entries.sort((a, b) => stable(a, b, r => r.x, r => r.y));
  return rows;
}

/** Keep still-selected explicit IDs, then append new IDs in visual order. */
export function reconcileSelectionOrder(preferredIds = [], selectedItems = [], getBounds) {
  const itemById = new Map(selectedItems.map(item => [item.id, item]));
  const result = uniqueIds(preferredIds).filter(id => itemById.has(id));
  const used = new Set(result);
  const missing = sortItemsForExport(
    selectedItems.filter(item => !used.has(item.id)),
    'visual',
    getBounds,
  );
  result.push(...missing.map(item => item.id));
  return result;
}

/**
 * Resolve selected roots into exportable image items. Group roots expand to
 * their image children in visual order, while duplicate child references are
 * removed without disturbing the user's selection sequence.
 */
export function resolveExportItems({
  selectedItems = [],
  preferredIds = [],
  order = 'selection',
  isImage,
  isGroup,
  childrenOfGroup,
  getBounds,
} = {}) {
  const byId = new Map(selectedItems.map(item => [item.id, item]));
  const orderedRootIds = reconcileSelectionOrder(preferredIds, selectedItems, getBounds);
  const expanded = [];
  const used = new Set();
  const add = item => {
    if (!item || !isImage(item) || used.has(item.id)) return;
    used.add(item.id);
    expanded.push(item);
  };

  for (const id of orderedRootIds) {
    const item = byId.get(id);
    if (isGroup(item)) {
      const children = sortItemsForExport(
        (childrenOfGroup(item.id) || []).filter(isImage),
        'visual',
        getBounds,
      );
      children.forEach(add);
    } else {
      add(item);
    }
  }

  if (order === 'horizontal' || order === 'vertical' || order === 'visual') {
    return sortItemsForExport(expanded, order, getBounds);
  }
  return expanded;
}

export function paddedSequence(index, total, minDigits = 2) {
  const safeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  const safeTotal = Math.max(safeIndex, Math.trunc(Number(total) || 0));
  const digits = Math.max(minDigits, String(safeTotal).length);
  return String(safeIndex).padStart(digits, '0');
}

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/i;

/**
 * Give the exported bytes an honest, deterministic extension. A dotted stem
 * such as "3.9B" is not an image extension and must remain part of the name.
 */
export function finalizeExportFilename(name, extension) {
  const ext = String(extension || 'png').replace(/^\.+/, '').toLowerCase() || 'png';
  const base = String(name || 'image').replace(IMAGE_EXTENSION_RE, '') || 'image';
  return `${base}.${ext}`;
}
