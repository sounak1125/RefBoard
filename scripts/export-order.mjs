/**
 * Deterministic ordering helpers for exporting board images.
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

/**
 * Sort items by a direction or by visual reading order. Visual order clusters
 * overlapping items into rows, then reads rows top-to-bottom and left-to-right.
 * A vertical stack naturally becomes one item per row.
 */
export function sortItemsForExport(items = [], order = 'visual', getBounds) {
  const decorated = items.map((item, index) => ({ item, index, rect: itemRect(item, getBounds) }));
  const stable = (a, b, primary, secondary) =>
    primary(a.rect) - primary(b.rect)
    || secondary(a.rect) - secondary(b.rect)
    || a.index - b.index;

  if (order === 'horizontal') {
    return decorated.sort((a, b) => stable(a, b, r => r.x, r => r.y)).map(d => d.item);
  }
  if (order === 'vertical') {
    return decorated.sort((a, b) => stable(a, b, r => r.y, r => r.x)).map(d => d.item);
  }

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
  return rows.flatMap(row => row.entries
    .sort((a, b) => stable(a, b, r => r.x, r => r.y))
    .map(entry => entry.item));
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
