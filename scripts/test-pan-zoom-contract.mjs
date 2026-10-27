/**
 * A drag-pan steps from the live view.
 *
 * The pan rebuilt the view from a pointerdown snapshot on every move
 * (tx = tx0 + dx). A wheel zoom mid-drag moves tx to keep the cursor anchored,
 * and the next move restored tx0 under the new scale, throwing the board by
 * (board x under cursor) * (scale change): 12,600 px for one wheel notch at
 * 2000%. smoke-pan-zoom.mjs drives the gesture; this pins the shape.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const starts = html.match(/mode = \{ type: 'pan'[^}]*\};/g) || [];
assert.equal(starts.length, 3, 'hand tool, middle/space/alt and right-button pans should all be findable');
for (const start of starts) {
  assert.match(start, /lx: sx, ly: sy/, `a pan remembers the last pointer position: ${start}`);
  assert.doesNotMatch(start, /tx: state\.view\.tx|ty: state\.view\.ty/, `a pan must not snapshot the view: ${start}`);
}

// Anchored on the right-drag distance so this is pointermove's branch, not pointerup's.
const move = html.match(/if \(mode\.type === 'pan'\) \{\s*if \(mode\.right\) mode\.dist = [\s\S]*?\n {2}\} else if/);
assert.ok(move, 'the pointermove pan branch should be findable');
assert.match(move[0], /state\.view\.tx \+= sx - mode\.lx;\s*state\.view\.ty \+= sy - mode\.ly;\s*mode\.lx = sx; mode\.ly = sy;/,
  'each move adds its own delta to the current view');
assert.doesNotMatch(move[0], /state\.view\.t[xy] = mode\./, 'a move must not restore a pointerdown snapshot');

console.log('pan zoom contract passed');
