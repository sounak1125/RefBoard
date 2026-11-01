/**
 * Where a new snip goes on the board. The first one lands at the centre of the
 * view (addImages does that); each following one sits to the right of the one
 * before it, top-aligned, so grabbing frames from a video in a row builds a
 * strip instead of a pile.
 *
 * `previous` is the board-space bounding box of the last snip, or null when it
 * is gone from the board; `size` is the new item's width and height.
 * Returns the new item's top-left corner, or null to keep addImages' centre.
 */
export const SNIP_ROW_GAP = 24;

export function snipRowPosition(previous, size, gap = SNIP_ROW_GAP) {
  if (!previous || !size) return null;
  const { x, y, w } = previous;
  if (![x, y, w, size.w, size.h].every(Number.isFinite)) return null;
  return { x: x + w + gap, y };
}
