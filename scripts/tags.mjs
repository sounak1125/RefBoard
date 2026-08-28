/**
 * Tag values, and the filter that decides what a tagged board shows.
 * Used by index.html and scripts/test-tags.mjs.
 *
 * Tags are compared case-insensitively but stored as typed, so "Lighting" and
 * "lighting" are one tag and the board keeps whichever spelling arrived first.
 * Everything here is pure: the renderer owns state, this owns the rules.
 */

/* Long enough for "warm rim lighting", short enough to stay a chip. */
export const TAG_MAX_LENGTH = 32;

/* A ceiling rather than a target. It exists so a scripted or pasted payload
   cannot give one item a thousand tags and stall every filter pass. */
export const TAGS_MAX_PER_ITEM = 24;

/**
 * One tag, cleaned up: no control characters, no runs of whitespace, no commas
 * (they separate tags in the input), and no leading "#" — people type it out of
 * habit and would otherwise get "#lighting" and "lighting" as two tags.
 * @returns {string} the cleaned tag, or '' if nothing usable is left.
 */
export function normalizeTag(raw) {
  const cleaned = String(raw ?? '')
    // Control characters would render as boxes in a chip and break the file.
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .trim();
  return cleaned.slice(0, TAG_MAX_LENGTH).trim();
}

/** Case-insensitive identity. Kept in one place so nothing compares raw. */
export const tagKey = tag => normalizeTag(tag).toLowerCase();

/**
 * Clean a whole list: drop the unusable, collapse case-duplicates keeping the
 * first spelling, and cap the length.
 */
export function normalizeTags(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAGS_MAX_PER_ITEM) break;
  }
  return out;
}

/** Split typed input on commas so "a, b, c" adds three tags in one go. */
export function parseTagInput(text) {
  return normalizeTags(String(text ?? '').split(','));
}

/** @returns {string[]} a new list — callers snapshot for undo before applying. */
export function addTags(tags, incoming) {
  return normalizeTags([...(Array.isArray(tags) ? tags : []), ...(Array.isArray(incoming) ? incoming : [incoming])]);
}

export function removeTag(tags, tag) {
  const key = tagKey(tag);
  if (!key) return normalizeTags(tags);
  return normalizeTags(tags).filter(existing => existing.toLowerCase() !== key);
}

export function hasTag(tags, tag) {
  const key = tagKey(tag);
  if (!key) return false;
  return normalizeTags(tags).some(existing => existing.toLowerCase() === key);
}

/**
 * Every tag in use, most-used first, then alphabetically so the order is stable
 * between renders. Most-used first is what makes the panel useful on a board
 * with a hundred tags: the ones worth filtering by are at the top.
 *
 * @param {Array} items board items
 * @param {(item: any) => boolean} isTaggable which kinds carry tags
 * @returns {Array<{tag: string, count: number}>}
 */
export function collectBoardTags(items = [], isTaggable = () => true) {
  const counts = new Map();
  for (const item of items) {
    if (!isTaggable(item)) continue;
    for (const tag of normalizeTags(item?.tags)) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) =>
    b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Does this item survive the filter?
 *
 * An empty filter shows everything. 'any' widens as you select more tags,
 * 'all' narrows — the two useful readings of a multi-tag selection.
 */
export function itemMatchesTags(item, activeTags, mode = 'any') {
  const active = normalizeTags(activeTags);
  if (!active.length) return true;
  const own = new Set(normalizeTags(item?.tags).map(tag => tag.toLowerCase()));
  if (!own.size) return false;
  const keys = active.map(tag => tag.toLowerCase());
  return mode === 'all' ? keys.every(key => own.has(key)) : keys.some(key => own.has(key));
}

/**
 * Drop filter tags the board no longer has, so deleting the last item carrying
 * a tag cannot leave a filter active that nothing can ever satisfy.
 */
export function pruneActiveTags(activeTags, boardTags = []) {
  const available = new Set(boardTags.map(entry => tagKey(entry?.tag ?? entry)));
  return normalizeTags(activeTags).filter(tag => available.has(tag.toLowerCase()));
}

/* ================= colours ================= */

/* A tag can carry a colour, which the board paints as a soft glow behind every
   item wearing it — "these are the ones with the problem" readable at a glance,
   without reading a single label. Chosen to stay legible against the dark
   workspace and to be distinguishable from each other at low saturation. */
export const TAG_COLOR_PALETTE = [
  '#5aa2ff', // blue
  '#4cc86a', // green
  '#f0b429', // amber
  '#ff6b6b', // red
  '#b57bff', // violet
  '#33c9c0', // teal
  '#ff8f4d', // orange
  '#ef6fb0', // pink
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** @returns {string} a lowercase #rrggbb, or '' when there is no usable colour. */
export function normalizeTagColor(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withHash = raw.startsWith('#') ? raw : '#' + raw;
  // #abc is a legal CSS colour and worth accepting from a hand-edited file.
  const expanded = /^#[0-9a-f]{3}$/i.test(withHash)
    ? '#' + withHash.slice(1).split('').map(c => c + c).join('')
    : withHash;
  return HEX_COLOR.test(expanded) ? expanded.toLowerCase() : '';
}

/**
 * Clean a whole tag-colour map. Keys are tag identities, so the map survives a
 * tag being renamed in case only, and an unusable colour drops the entry rather
 * than painting something arbitrary.
 */
export function normalizeTagColors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawTag, rawColor] of Object.entries(value)) {
    const key = tagKey(rawTag);
    if (!key) continue;
    const color = normalizeTagColor(rawColor);
    if (!color) continue;
    out[key] = color;
  }
  return out;
}

/** The next palette colour nothing is using yet, so two tags rarely collide. */
export function suggestTagColor(colors = {}) {
  const used = new Set(Object.values(normalizeTagColors(colors)));
  return TAG_COLOR_PALETTE.find(color => !used.has(color)) || TAG_COLOR_PALETTE[0];
}

/**
 * The glow an item should wear: the colour of the first of its tags that has
 * one. First rather than blended, because two glows mixed into a third colour
 * would name a tag that does not exist.
 */
export function tagGlowColor(tags, colors = {}) {
  const map = normalizeTagColors(colors);
  for (const tag of normalizeTags(tags)) {
    const color = map[tag.toLowerCase()];
    if (color) return color;
  }
  return '';
}

/** Drop colours for tags the board no longer carries, so the map cannot grow forever. */
export function pruneTagColors(colors, boardTags = []) {
  const available = new Set(boardTags.map(entry => tagKey(entry?.tag ?? entry)));
  const map = normalizeTagColors(colors);
  const out = {};
  for (const [key, color] of Object.entries(map)) {
    if (available.has(key)) out[key] = color;
  }
  return out;
}
