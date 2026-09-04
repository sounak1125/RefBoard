/**
 * The spatial index wiring, pinned by shape. See scripts/spatial-index.mjs.
 *
 * Culling, hit-testing, marquee, group frames and the workspace bounds all
 * read from one lazily rebuilt index instead of scanning every item. The index
 * rebuilds on the workspace-bounds invalidation signal, so every geometry
 * mutation path must raise it; the ones that used to get away without doing so
 * are pinned here too.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- construction and invalidation --- */
assert.match(html, /import \{ createSpatialIndex \} from '\.\/scripts\/spatial-index\.mjs';/, 'the module is imported');
assert.ok(packageJson.build.files.includes('scripts/spatial-index.mjs'), 'the module ships in the package');
assert.match(html, /const layout = createSpatialIndex\(\{\s*items: \(\) => state\.items,\s*bounds: itemBoardAABB,/, 'the index is built over state.items with the rotated box');
assert.match(html, /function invalidateWorkspaceBBox\(\) \{ workspaceBBoxCache = null; layout\.invalidate\(\); \}/, 'the workspace-bounds signal also invalidates the index');

/* --- readers --- */
assert.match(fn('childrenOfGroup'), /return layout\.children\(gid\);/, 'children come from the index, not a filter over all items');
assert.match(fn('groupUiRect'), /const kids = childrenOfGroup\(group\.id\);[\s\S]*?const bb = bboxOf\(kids\);/, 'a group frame takes membership from the index and geometry live');
assert.doesNotMatch(fn('boundsOf'), /layout\./, 'boundsOf stays live: gestures read it between a mutation and its announcement');
assert.match(fn('isItemVisible'), /layout\.boundsOf\(it\) \|\| itemBoardAABB\(it\)/, 'visibility uses the cached box');
const cull = fn('collectVisibleItems');
assert.match(cull, /layout\.queryRect\(/, 'culling queries the grid');
assert.match(cull, /for \(const g of layout\.groups\(\)\) if \(isItemVisible\(g, viewport\)\) groups\.push\(g\);/, 'groups are tested by hand');
assert.match(cull, /while \(gi < groups\.length && layout\.zOf\(groups\[gi\]\) < z\) push\(groups\[gi\+\+\]\);/, 'groups are merged back in z order');
assert.doesNotMatch(cull, /for \(const it of state\.items\)/, 'culling no longer scans every item');
const hit = fn('itemAt');
assert.match(hit, /const tol = 6 \/ state\.view\.s;\s*const candidates = layout\.queryRect\(bx - tol, by - tol, tol \* 2, tol \* 2\);/, 'the hit test queries a tolerance rect so arrows at low zoom are still hit');
assert.match(hit, /for \(let i = candidates\.length - 1; i >= 0; i--\)/, 'candidates are walked topmost first');
assert.doesNotMatch(hit, /state\.items\.length - 1/, 'the hit test no longer scans every item');
assert.match(fn('imageItemAt'), /for \(const it of layout\.queryPoint\(bx, by\)\)/, 'the wheel-focus lookup queries the point');
assert.match(fn('groupFrameAt'), /const groups = layout\.groups\(\);/, 'group frame hits scan only groups');
assert.match(fn('groupAt'), /const groups = layout\.groups\(\);/, 'group hits scan only groups');
assert.match(fn('marqueeSelectionIds'), /for \(const it of layout\.queryRect\(bx1, by1, bx2 - bx1, by2 - by1\)\)/, 'the marquee queries its rect');
assert.match(fn('workspaceContentBBox'), /layout\.contentBounds\(\) \|\| bboxOf\(state\.items\)/, 'the workspace bounds come from the index');
assert.match(html, /layout\.memo\('imageItemIds'/, 'the per-frame image id set is memoised until the next rebuild');

/* --- every geometry path raises the signal --- */
const pointermove = html.match(/window\.addEventListener\('pointermove', e => \{[\s\S]*?\r?\n\}\);\r?\n/)?.[0];
assert.ok(pointermove, 'the pointermove handler should be findable');
const branch = type => {
  const start = pointermove.indexOf(`mode.type === '${type}'`);
  assert.ok(start >= 0, `pointermove has a ${type} branch`);
  const next = pointermove.indexOf('} else if (mode.type ===', start + 1);
  return pointermove.slice(start, next < 0 ? undefined : next);
};
for (const type of ['move', 'resize', 'rotate', 'groupResize', 'arrowEndpoint']) {
  assert.match(branch(type), /invalidateWorkspaceBBox\(\);/, `the ${type} gesture announces its geometry change`);
}
assert.equal((branch('resize').match(/invalidateWorkspaceBBox\(\);/g) || []).length, 2, 'both resize paths (edge and corner) announce');
for (const name of ['arrangeAll', 'normalizeImagesBy', 'rotateSelection', 'applyGroupProportionalResize']) {
  assert.match(fn(name), /invalidateWorkspaceBBox\(\);/, `${name} announces its geometry change`);
}
assert.match(html, /const restoreIdleSelectionUi = mode\.type === 'rotate';\s*\/\/[^\n]*\n\s*invalidateWorkspaceBBox\(\);\s*mode = null;/, 'every gesture end re-validates');

assert.match(html, /canvas\.addEventListener\('pointerdown', (?:async )?e => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*invalidateWorkspaceBBox\(\);/, 'every click hit-tests current geometry');

/* --- test hook --- */
assert.match(html, /^  itemAt,$/m, 'the hit test is reachable from the harness');
assert.match(html, /invalidateLayout: invalidateWorkspaceBBox,/, 'the harness can raise the signal');
assert.match(html, /get spatialIndexStats\(\) \{ return layout\.stats\(\); \}/, 'index stats are reachable from the harness');

console.log('spatial index contract passed');
