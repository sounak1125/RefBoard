/**
 * A web-dropped image records where it came from, and that survives a save.
 *
 * Attribution is a first-class feature on a reference board: the drop handler
 * already reads the URL, and previously discarded it after taking a filename.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.ok(
  html.includes("async function addImages(blobs, atBoardPos, { sourceUrl = '' } = {})"),
  'addImages must accept the originating URL',
);
assert.ok(
  html.includes('...(sourceUrl ? { source: sourceUrl } : {})'),
  'the source must be recorded on the item, not dropped',
);
assert.ok(
  html.includes('await addImages([new File([b], name, { type: b.type })], pos, { sourceUrl: url });'),
  'fetching an image from a web drop must pass the URL through',
);

/* The field survives the board file only because normalizeItem spreads unknown
   fields for images. If that ever became a whitelist, `source` would be lost
   silently on the next save, so pin the spread. */
assert.match(
  html,
  /return \{\s*\r?\n\s*\.\.\.it,\s*\r?\n\s*kind: 'image',/,
  'normalizeItem must keep spreading unknown image fields, or source is dropped on save',
);

/* Only navigable URLs may reach the shell: a data: or blob: URL is not a place
   the user can go back to, and must never be handed to openExternal. */
const guard = html.match(/function itemSourceUrl\(it\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(guard, 'itemSourceUrl should be findable');
assert.ok(guard.includes('https?:'), 'itemSourceUrl must restrict sources to http(s)');
assert.ok(guard.includes('.test(url)'), 'itemSourceUrl must actually test the URL, not just build it');

assert.ok(html.includes("l: 'Open source page'"), 'the context menu must offer the source page');
assert.ok(html.includes("l: 'Copy source link'"), 'the context menu must offer copying the source link');

/* The menu entry must be gated on the guard, not on the raw field. */
assert.ok(
  html.includes('const sourceUrl = sel === 1 ? itemSourceUrl(selItems[0]) : \'\';'),
  'the menu must resolve the source through the http(s) guard',
);

console.log('image source contract tests passed');
