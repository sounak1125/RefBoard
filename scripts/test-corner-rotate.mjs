import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

const context = {};
vm.runInNewContext(`
  const RESIZE_HANDLE_HIT = 14;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  ${extractFunction('pointSegmentDistance')}
  ${extractFunction('handlesHitOnPts')}
  ${extractFunction('rotateHitOnPts')}
  ${extractFunction('snapRotateDelta')}
  ${extractFunction('rotateVec')}
  ${extractFunction('rotateItemAroundOrigin')}
  ${extractFunction('rotateCursorForHandle')}
  this.handlesHitOnPts = handlesHitOnPts;
  this.rotateHitOnPts = rotateHitOnPts;
  this.snapRotateDelta = snapRotateDelta;
  this.rotateItemAroundOrigin = rotateItemAroundOrigin;
  this.rotateCursorForHandle = rotateCursorForHandle;
`, context);

const pts = [[0, 0], [200, 0], [200, 100], [0, 100]];
assert.equal(context.handlesHitOnPts(200, 100, pts)?.corner, 'se', 'the SE handle itself should remain a resize hit');
assert.equal(context.rotateHitOnPts(200, 100, pts), null, 'sitting on the corner square should not be a rotate hit');

const se = pts[2];
const centerX = 100, centerY = 50;
const outX = se[0] - centerX, outY = se[1] - centerY;
const outLen = Math.hypot(outX, outY);
const ux = outX / outLen, uy = outY / outLen;
const outward = [se[0] + ux * 22, se[1] + uy * 22];
const inward = [se[0] - ux * 22, se[1] - uy * 22];

assert.equal(context.handlesHitOnPts(outward[0], outward[1], pts), null, 'the outer ring should miss the resize handle');
assert.equal(context.rotateHitOnPts(outward[0], outward[1], pts)?.corner, 'se', '22px outward from a corner should rotate');
assert.equal(context.rotateHitOnPts(inward[0], inward[1], pts), null, '22px inward over the image should not rotate');

assert.equal(context.snapRotateDelta(40, true), 0);
assert.equal(context.snapRotateDelta(50, true), 90);
assert.equal(context.snapRotateDelta(40, false), 40);

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

const image = { x: 10, y: 20, w: 100, h: 50, rot: 0 };
const imageStart = { ...image };
context.rotateItemAroundOrigin(image, imageStart, { x: 60, y: 45 }, 90);
assert.equal(image.rot, 90, 'single-item rotate should change rot');
closeTo(image.w, 100, 'single-item rotate should keep width');
closeTo(image.h, 50, 'single-item rotate should keep height');
closeTo(image.x + image.w / 2, 60, 'single-item rotate should keep center x');
closeTo(image.y + image.h / 2, 45, 'single-item rotate should keep center y');

const note = { kind: 'note', x: 0, y: 0, w: 80, h: 40, rot: 15 };
const noteStart = { ...note };
context.rotateItemAroundOrigin(note, noteStart, { x: 40, y: 20 }, 90);
assert.equal(note.rot, 105, 'notes should rotate with the same helper');
closeTo(note.x + note.w / 2, 40, 'note rotate should keep center x');
closeTo(note.y + note.h / 2, 20, 'note rotate should keep center y');

const a = { x: 0, y: 0, w: 100, h: 100, rot: 0 };
const b = { x: 200, y: 0, w: 100, h: 100, rot: 20 };
const origin = { x: 150, y: 50 };
context.rotateItemAroundOrigin(a, { ...a }, origin, 90);
context.rotateItemAroundOrigin(b, { ...b }, origin, 90);
assert.equal(a.rot, 90);
assert.equal(b.rot, 110);
closeTo(a.x + a.w / 2, 150, 'first item should orbit onto the bbox vertical');
closeTo(a.y + a.h / 2, -50, 'first item should orbit clockwise in canvas space');
closeTo(b.x + b.w / 2, 150, 'second item should orbit onto the bbox vertical');
closeTo(b.y + b.h / 2, 150, 'second item should orbit clockwise in canvas space');

const cursor = context.rotateCursorForHandle({ corner: 'se' }, 0);
assert.match(cursor, /^url\("data:image\/svg\+xml,/);
assert.match(cursor, /, grab$/);
assert.match(cursor, /-webkit-image-set\(/, 'HiDPI glyphs so the cursor stays sharp on scaled displays');
assert.match(decodeURIComponent(cursor), /width="64"/);
assert.match(cursor, / 16 16,/, 'hotspot stays at normal-cursor center');
const encoded = cursor.match(/^url\("data:image\/svg\+xml,([^"]+)"\)/)[1];
const svg = decodeURIComponent(encoded);
assert.match(svg, /width="32"/);
assert.match(svg, /viewBox="0 0 32 32"/);
assert.match(svg, /#fff/, 'white PureRef glyph');
assert.match(svg, /A[\d.]+ [\d.]+ 0 0 1/, '90° corner-hugging arc');
assert.match(svg, /shape-rendering="geometricPrecision"/);
assert.doesNotMatch(svg, /width="20"/, 'rotate cursor must not shrink below normal pointer size');
assert.doesNotMatch(svg, /stroke-width="6"/, 'the oversized 6px halo must not remain');
assert.doesNotMatch(svg, /M16\.5 5v3\.2h-3\.2/, 'the old one-way refresh tips must not remain');
assert.doesNotMatch(svg, /A10\.2 10\.2 0 1 0/, 'the old 270° ring must not remain');
assert.match(svg, /rotate\(0 16 16\)/);
const nw = context.rotateCursorForHandle({ corner: 'nw' }, 0);
assert.match(decodeURIComponent(nw.match(/^url\("data:image\/svg\+xml,([^"]+)"\)/)[1]), /rotate\(180 16 16\)/);

assert.match(html, /if \(h\.rotate\)/, 'updateCursor and pointerdown should branch on rotate hits');
assert.match(html, /rotateCursorForHandle\(h, h\.group \? 0 : \(h\.it\?\.rot \|\| 0\)\)/);
assert.match(html, /resizeCursorForHandle\(h, h\.group \? 0 : \(h\.it\?\.rot \|\| 0\)\)/, 'single-item and group-frame resize should still use rotated resize cursors');
assert.match(html, /type: 'rotate'/);
assert.match(html, /snapRotateDelta\(/);
assert.match(html, /Drag outside a corner/);
assert.match(html, /Rotate from a corner \(Shift snaps 90°\)/);
const multiSelDraw = html.match(/if \(selectedCount > 1 && !lightDrag\) \{[\s\S]*?\} else if \(selectedCount === 1\)/);
assert.ok(multiSelDraw, 'multi-select drawing should remain a distinct branch');
assert.match(multiSelDraw[0], /drawSelectionOutline\(it\)/, 'multi-select should still outline each item');
assert.doesNotMatch(multiSelDraw[0], /drawSelectionUi\(/, 'multi-select should not stroke the outer bounding box');
assert.match(multiSelDraw[0], /drawCornerHandles/, 'multi-select should still show the corner cubes');
assert.match(multiSelDraw[0], /drawEdgePills/, 'multi-select should still show the edge handles');

console.log('corner rotate contract tests passed');
