import assert from 'node:assert/strict';
import {
  boardTransformAssetKey,
  effectiveFramingScale,
  framingScaleFromEffective,
  normalizeBoardTransform,
  visualSourceGeometry,
} from './animatics-visual-transform.mjs';

const portrait = normalizeBoardTransform({
  crop: { l:.1, t:.2, r:.9, b:.8 },
  rot:90,
  flipX:true,
  gray:true,
  w:90,
  h:160,
});
assert.deepEqual(portrait.crop, { l:.1, t:.2, r:.9, b:.8 });
assert.equal(portrait.rotation, 90);
assert.equal(portrait.flipX, true);
assert.equal(portrait.gray, true);

const geometry = visualSourceGeometry(900,1600,portrait);
assert.equal(Math.round(geometry.source.x), 90);
assert.equal(Math.round(geometry.source.y), 320);
assert.equal(Math.round(geometry.source.width), 720);
assert.equal(Math.round(geometry.source.height), 960);
assert.equal(Math.round(geometry.rotatedWidth), 160, 'rotating a 9:16 board item must create a 16:9 visual width');
assert.equal(Math.round(geometry.rotatedHeight), 90, 'rotating a 9:16 board item must create a 16:9 visual height');

const fillScale = effectiveFramingScale({fit:'cover',scale:1},1920,1080,900,1600);
assert.ok(Math.abs(fillScale - 256 / 81) < 1e-9, 'Fill must expose its effective scale relative to Fit');
const internal = framingScaleFromEffective(2,{fit:'cover'},1920,1080,900,1600);
assert.ok(Math.abs(effectiveFramingScale({fit:'cover',scale:internal},1920,1080,900,1600)-2)<1e-9, 'effective scale conversion must round-trip');

const firstKey=boardTransformAssetKey('image-1',portrait);
const sameKey=boardTransformAssetKey('image-1',{...portrait});
const changedKey=boardTransformAssetKey('image-1',{...portrait,rotation:0});
assert.equal(firstKey,sameKey,'equivalent board transforms must share an export asset');
assert.notEqual(firstKey,changedKey,'different rotations of the same board image must export separately');

assert.equal(normalizeBoardTransform({rotation:270,width:1,height:1}).rotation,-90,'rotation normalization must remain stable across save and reopen');

console.log('animatics visual transform tests passed');
