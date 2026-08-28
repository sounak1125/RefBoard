/**
 * Dragging board images out into another application.
 *
 * Two halves: the naming logic is exercised directly, and the wiring that
 * cannot run outside Electron (staging to disk, webContents.startDrag) is
 * pinned by contract so a refactor cannot quietly drop the containment checks
 * or the original-bytes guarantee.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildDragOutNames, dragOutStem, sanitizeDragOutStem } from './drag-out.mjs';

/* ================= naming ================= */

// A drop writes real files into a real folder, so two references both called
// "ref.png" must not collapse into one file.
assert.deepEqual(
  buildDragOutNames([{ stem: 'ref', ext: 'png' }, { stem: 'ref', ext: 'png' }, { stem: 'ref', ext: 'png' }]),
  ['ref.png', 'ref_2.png', 'ref_3.png'],
);

// Windows and macOS both fold case, so these three collide as well.
assert.deepEqual(
  buildDragOutNames([{ stem: 'Ref', ext: 'png' }, { stem: 'ref', ext: 'png' }, { stem: 'REF', ext: 'png' }]),
  ['Ref.png', 'ref_2.png', 'REF_3.png'],
);

// Different bytes, different file — a .jpg and a .png are not a collision.
assert.deepEqual(
  buildDragOutNames([{ stem: 'ref', ext: 'png' }, { stem: 'ref', ext: 'jpg' }]),
  ['ref.png', 'ref.jpg'],
);

// Entry N in, filename N out: the drop must match the selection order.
assert.deepEqual(
  buildDragOutNames([{ stem: 'c', ext: 'png' }, { stem: 'a', ext: 'png' }, { stem: 'b', ext: 'png' }]),
  ['c.png', 'a.png', 'b.png'],
);

// A missing stem still yields a usable, unique name rather than ".png".
assert.deepEqual(
  buildDragOutNames([{ ext: 'png' }, { stem: '', ext: 'png' }]),
  ['image-1.png', 'image-2.png'],
);

/* Names the file system would reject. Staging that writes nothing produces a
   drag that drops nothing, with no explanation for the user. */
assert.equal(sanitizeDragOutStem('a/b\\c'), 'a_b_c', 'path separators must not survive');
assert.equal(sanitizeDragOutStem('../../etc/passwd'), '.._.._etc_passwd', 'traversal must not survive');
assert.equal(sanitizeDragOutStem('trailing dot.'), 'trailing dot', 'Windows cannot create a trailing dot');
assert.equal(sanitizeDragOutStem('   '), 'image');
assert.equal(sanitizeDragOutStem(null), 'image');
assert.equal(sanitizeDragOutStem('CON'), 'CON_', 'reserved device names must be escaped');
assert.equal(sanitizeDragOutStem('lpt1'), 'lpt1_');
assert.ok(sanitizeDragOutStem('x'.repeat(400)).length <= 96, 'a long stem must leave room inside MAX_PATH');

/* The extension comes from the bytes, not the name: a cropped JPEG that
   re-encodes to PNG must not keep ".jpg". */
assert.equal(dragOutStem({ name: 'photo.JPEG' }, null, 0), 'photo');
assert.equal(dragOutStem({ name: 'shot.png' }, { name: 'other.png' }, 0), 'shot', 'the item name wins');
assert.equal(dragOutStem({}, { name: 'from-record.webp' }, 0), 'from-record', 'the image record is the fallback');
assert.equal(dragOutStem({}, {}, 4), 'image-5', 'position is the last resort, and 1-based');
assert.equal(dragOutStem({ name: '3.9B' }, null, 0), '3.9B', 'a dotted stem is not an extension');

/* ================= wiring ================= */

const [main, preload, html] = await Promise.all([
  readFile(new URL('../main.js', import.meta.url), 'utf8'),
  readFile(new URL('../preload.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);

/** The body of a named function, so assertions read it instead of the whole file. */
function functionBody(source, declaration, opener = ') {') {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  // Start counting at the body brace, not at a destructured parameter's brace.
  const openerAt = source.indexOf(opener, start);
  assert.notEqual(openerAt, -1, `expected "${opener}" after ${declaration}`);
  let depth = 0;
  for (let i = source.indexOf('{', openerAt); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${declaration}`);
}

for (const channel of ['stage-drag-out', 'start-drag-out']) {
  assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main.js must handle '${channel}'`);
  assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload must expose '${channel}'`);
}

const stageHandler = functionBody(main, "ipcMain.handle('stage-drag-out'", '=> {');
const startHandler = functionBody(main, "ipcMain.handle('start-drag-out'", '=> {');

/* Staging writes renderer-supplied names into a temp directory. A name that
   climbs out of it would let a crafted board overwrite files elsewhere. */
assert.ok(
  stageHandler.includes('path.basename(String(f?.name'),
  'stage-drag-out must reduce a supplied name to its basename',
);
assert.ok(
  stageHandler.includes('if (!target.startsWith(root + path.sep)) continue;'),
  'stage-drag-out must refuse a name that resolves outside the staging directory',
);

/* The drag itself may only hand over paths this renderer just staged. */
assert.ok(
  startHandler.includes('entry.startsWith(root + path.sep) && fsSync.existsSync(entry)'),
  'start-drag-out must confine dragged paths to the staging directory and require them to exist',
);
assert.ok(
  /if \(!files\.length\) return \{ started: false \};/.test(startHandler),
  'start-drag-out must refuse to start a drag carrying nothing',
);

/* Windows throws on startDrag without a real icon, so a thumbnail that failed
   to decode has to fall back rather than kill the drag. */
assert.ok(
  startHandler.includes('image = nativeImage.createFromPath(appIconPath());'),
  'start-drag-out must fall back to the app icon when the thumbnail is unusable',
);
assert.ok(
  startHandler.includes('event.sender.startDrag({ file: files[0], files, icon: image })'),
  'start-drag-out must start a native drag carrying every staged file',
);

/* Staged files outlive the drop by design, so something has to bound them. */
assert.ok(main.includes('function sweepDragOutStaging()'), 'main.js must define a staging sweep');
assert.ok(
  /sweepDragOutStaging\(\);\s*\r?\n\s*setupIpc\(\);/.test(main),
  'the staging sweep must run at startup, before any drag can stage into it',
);

/* The grip is a drag source. Without draggable there is no dragstart at all,
   and without preventDefault Chromium runs its own web drag instead of the
   native file drag that main starts. */
assert.ok(
  /id="sDragOut"[^>]*draggable="true"/.test(html),
  'the drag grip must be a draggable element',
);
assert.ok(
  html.includes("dragOutBtn.addEventListener('dragstart', runDragOut);"),
  'the grip must run the drag on dragstart',
);
assert.ok(
  functionBody(html, 'async function runDragOut(e)').includes('e.preventDefault();'),
  'dragstart must preventDefault so the native drag replaces the web drag',
);

/* dragstart cannot await, so the files must already be on their way by then. */
assert.ok(
  html.includes("dragOutBtn.addEventListener('pointerdown', beginDragOutStaging);"),
  'staging must begin on pointerdown, not on dragstart',
);

/* The same guarantee Ctrl+C makes: an image nobody has altered hands over its
   own bytes instead of a re-encode. */
assert.ok(
  html.includes("itemToExportBlob(it, 'original', hasActiveCrop(it))"),
  'drag out must request original bytes and honour an active crop',
);

/* A drag and an export of the same selection must agree on which images those
   are — groups expanded the same way, in the same order. */
assert.ok(
  functionBody(html, 'function dragOutItems()').includes('resolveExportItems({'),
  'drag out must resolve its images through resolveExportItems, like the export dialog',
);

/* A browser build has no main process to stage into, so the grip must not
   offer a drag that can never start. */
assert.ok(
  html.includes('if (!dragOutSupported()) dragOutBtn.hidden = true;'),
  'the grip must hide itself when the drag-out bridge is absent',
);
assert.ok(html.includes('.tb[hidden]{ display:none; }'), 'hidden must beat the .tb display rule');

console.log('drag out ok — naming, staging containment, icon fallback and grip wiring all hold');
