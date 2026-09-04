/**
 * A save must not cost a second write of the file or a decode of every original.
 *
 * Every streamed save used to pass a null preview, finish, and then schedule a
 * backfill that read the whole .refboard back and rewrote it with a 50 KB JPEG
 * spliced into the header: two full writes and a full read per save, silent
 * autosaves included. And the preview composite decoded every image at full
 * resolution to draw it a few dozen pixels wide on a 720 px canvas.
 *
 * The preview is now captured up front from resident surfaces and written into
 * the header by the save itself. The backfill survives only as the self-heal
 * for boards saved by older builds without a preview.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- the preview rides in the header --- */
const save = html.match(/async function performBoardSave\(opts = \{\}\) \{[\s\S]*?\nasync function saveBoardFile/)?.[0];
assert.ok(save, 'performBoardSave should be findable');
const captureAt = save.indexOf('captureBoardFilePreviewBase64(720)');
const beginAt = save.indexOf('beginBoardSave(');
assert.ok(captureAt > 0 && beginAt > captureAt, 'the preview is captured before the streamed save begins');
assert.match(save, /snapshot\.core, preview, saveAs/, 'the captured preview is passed into the header');
assert.doesNotMatch(save, /scheduleBoardPreviewBackfill\(/, 'a save never schedules a rewrite of the file it just wrote');
assert.match(save, /if \(preview\) cachedCurrentBoardThumb = preview;/, 'the landing thumbnail cache is filled from the inline preview, as the backfill used to do');
assert.match(html, /if \(meta\.path && !cachedCurrentBoardThumb\)[\s\S]*?scheduleBoardPreviewBackfill\(meta\.path\)/,
  'the backfill still self-heals boards saved by older builds without a preview');

/* --- the composite draws from what is already decoded --- */
const picker = fn('previewSurfaceFor');
assert.match(picker, /im\.proxy/, 'the proxy is a candidate');
assert.match(picker, /im\.lod\?\.entries/, 'resident LOD tiers are candidates');
assert.match(picker, /im\.bitmap/, 'a resident full bitmap is a candidate');
assert.match(picker, /candidates\.sort\(\(a, b\) => Math\.max\(a\.w, a\.h\) - Math\.max\(b\.w, b\.h\)\)/, 'the smallest sufficient surface wins');
assert.match(picker, /PREVIEW_SURFACE_ENOUGH/, 'the shortfall tolerance is named');
assert.doesNotMatch(picker, /withFullBitmap|ensureFullBitmap|requestImageDecode/, 'choosing a surface never decodes');

const composite = fn('boundedCompositeCanvas');
assert.match(composite, /await previewSurfaceFor\(im, Math\.ceil\(Math\.max\(it\.w, it\.h\) \* scale\)\)/, 'each image asks for a surface sized to its footprint on the composite');
assert.match(composite, /pickSurface: \(\) => pick/, 'the chosen surface is handed to drawBoardItem directly');
assert.match(composite, /else await withFullBitmap\(im, \(\) => drawBoardItem\(g, it, \{ noLod: true \}\)\)/, 'a full decode is the fallback, not the rule');
assert.equal((composite.match(/withFullBitmap/g) || []).length, 1, 'exactly one decode path remains, on the fallback branch');

/* --- drawBoardItem honours the explicit surface without touching the display pipeline --- */
assert.match(html, /\} else if \(opts\.pickSurface\) \{[\s\S]*?kind: 'pick',[\s\S]*?\} else if \(!opts\.noLod\) \{/,
  'an explicit surface is taken before the LOD branch');
const drawImageBranch = html.match(/\} else if \(opts\.pickSurface\) \{[\s\S]*?\} else if \(!opts\.noLod\) \{/)[0];
assert.doesNotMatch(drawImageBranch, /getImageLodForDraw|requestImageDecode|queueImageLod/, 'the pick branch queues nothing');

console.log('save preview contract passed');
