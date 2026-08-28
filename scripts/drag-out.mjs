/**
 * Naming for images dragged out of a board into another application.
 * Used by index.html and scripts/test-drag-out.mjs.
 *
 * A drop hands the receiving app real files, so unlike a clipboard write the
 * names matter: two files called "ref.png" landing in one folder is a silent
 * overwrite or a prompt the user did not ask for. Names are therefore made
 * unique across the dragged set before anything is written to disk.
 */

import { finalizeExportFilename } from './export-order.mjs';

/* Windows-reserved device names. A file called "con.png" cannot be created,
   and the failure surfaces as a drag that drops nothing. */
const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Strip path separators, control characters, and anything Windows rejects. */
export function sanitizeDragOutStem(name) {
  let stem = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    /* A trailing dot or space is legal to ask for and impossible to create. */
    .replace(/[. ]+$/, '')
    .trim();
  if (!stem) return 'image';
  if (RESERVED_STEMS.has(stem.toLowerCase())) stem = `${stem}_`;
  /* Leave room for a "_12" disambiguator and the extension inside MAX_PATH. */
  return stem.slice(0, 96) || 'image';
}

/**
 * The stem a dragged item should carry: its own name, else the source image's,
 * else a stable positional fallback. The extension is added separately so the
 * bytes decide it — a cropped JPEG that re-encodes to PNG must not keep ".jpg".
 */
export function dragOutStem(item, imageRecord, index = 0) {
  const raw = String(item?.name || imageRecord?.name || '').trim();
  const withoutExt = raw.replace(/\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/i, '');
  return sanitizeDragOutStem(withoutExt || `image-${Math.max(1, Math.trunc(index) + 1)}`);
}

/**
 * Make one filename per entry, unique within the set and case-insensitively so
 * (Windows and macOS both fold case, so "Ref.png" and "ref.png" collide).
 * Order is preserved: entry N in, filename N out.
 *
 * @param {Array<{stem?: string, ext?: string}>} entries
 * @returns {string[]}
 */
export function buildDragOutNames(entries = []) {
  const used = new Set();
  return entries.map((entry, index) => {
    const stem = sanitizeDragOutStem(entry?.stem || `image-${index + 1}`);
    const ext = String(entry?.ext || 'png').replace(/^\.+/, '').toLowerCase() || 'png';
    let candidate = finalizeExportFilename(stem, ext);
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = finalizeExportFilename(`${stem}_${suffix}`, ext);
      suffix++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
