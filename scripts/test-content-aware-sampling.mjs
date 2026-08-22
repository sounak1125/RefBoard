/* Source region control (§17) and source mask safety (§18). */
import assert from 'node:assert/strict';
import { loadEngine, grassScene, rectMask, ellipseMask, countMask } from './content-aware-harness.mjs';

const CAF = await loadEngine();
const { samplingArea } = CAF;
const W = 120, H = 90;
const scene = grassScene(W, H);

/* --- the fill region is never a source (§7, §18) ------------------------- */
{
  const fillMask = rectMask(W, H, 50, 40, 20, 16);
  const area = samplingArea.build(fillMask, scene.data, W, H, { forbiddenDilation: 6 }, null);
  for (let i = 0; i < W * H; i++) {
    if (fillMask[i]) assert.equal(area.allowed[i], 0, 'no pixel of the fill region may be sampled');
  }
  // §18: the forbidden zone is strictly larger than the hole, so the object's
  // own halo is excluded too.
  assert.ok(countMask(area.forbidden) > countMask(fillMask), 'the forbidden zone is dilated');
  assert.equal(area.allowed[45 * W + 55], 0, 'a pixel just outside the hole is still forbidden');
  assert.equal(area.allowed[5 * W + 5], 1, 'a distant pixel is available');
}

/* --- valid patch centres ------------------------------------------------- */
{
  const fillMask = rectMask(W, H, 50, 40, 20, 16);
  const area = samplingArea.build(fillMask, scene.data, W, H, { forbiddenDilation: 4 }, null);
  const radius = 4;
  const centers = samplingArea.buildValidCenters(area.allowed, W, H, radius);
  assert.ok(centers.count > 0, 'there are legal centres');
  assert.equal(centers.count, centers.xs.length, 'the centre list matches the count');

  // Every centre must have a fully legal patch around it: this is what stops
  // half a patch of the erased object being dragged into the hole.
  for (let k = 0; k < centers.count; k++) {
    const cx = centers.xs[k], cy = centers.ys[k];
    assert.ok(cx >= radius && cy >= radius && cx < W - radius && cy < H - radius,
      'a centre always leaves room for its whole patch inside the image');
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        assert.equal(area.allowed[(cy + dy) * W + (cx + dx)], 1,
          `patch around ${cx},${cy} must be entirely legal`);
      }
    }
  }
  // And the converse: a pixel adjacent to the forbidden zone must be rejected.
  assert.equal(centers.valid[36 * W + 55], 0, 'a centre whose patch touches the hole is rejected');
}

/* --- a user-painted sampling area is honoured (§17) ---------------------- */
{
  const fillMask = ellipseMask(W, H, 60, 45, 12, 10);
  const painted = new Uint8Array(W * H);
  // Allow only the left third.
  for (let y = 0; y < H; y++) for (let x = 0; x < 40; x++) painted[y * W + x] = 255;
  const area = samplingArea.build(fillMask, scene.data, W, H, { forbiddenDilation: 4 }, painted);
  assert.ok(!area.relaxed, 'a workable painted area is used as given');
  for (let y = 0; y < H; y++) {
    for (let x = 40; x < W; x++) {
      assert.equal(area.allowed[y * W + x], 0, 'excluded pixels are never sampled');
    }
  }
  assert.ok(area.userRejected > 0, 'the exclusion is reported');
}

/* --- an over-painted area degrades safely rather than failing ------------ */
{
  const fillMask = ellipseMask(W, H, 60, 45, 12, 10);
  const painted = new Uint8Array(W * H);
  painted[0] = 255;                             // essentially nothing allowed
  const area = samplingArea.build(fillMask, scene.data, W, H, { forbiddenDilation: 4 }, painted);
  assert.ok(area.relaxed, 'an unusable sampling area is widened rather than throwing');
  assert.ok(area.count > 1000, 'the widened area is genuinely usable');
  for (let i = 0; i < W * H; i++) {
    if (fillMask[i]) assert.equal(area.allowed[i], 0, 'relaxing never re-admits the fill region');
  }
}

/* --- transparent pixels are not source material (§23) ------------------- */
{
  const withHole = { data: new Uint8ClampedArray(scene.data), width: W, height: H };
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) withHole.data[(y * W + x) * 4 + 3] = 0;
  const fillMask = rectMask(W, H, 60, 50, 12, 10);
  const area = samplingArea.build(fillMask, withHole.data, W, H, { forbiddenDilation: 4 }, null);
  assert.equal(area.allowed[5 * W + 5], 0, 'transparent canvas is not source material');
  assert.ok(area.transparentRejected >= 400, 'the transparent count is reported');
}

/* --- the engine refuses when there is genuinely nothing to sample -------- */
{
  const all = new Uint8Array(W * H).fill(1);
  assert.throws(
    () => CAF.fill({ data: new Uint8ClampedArray(scene.data), width: W, height: H }, all, null, { seed: 1 }),
    /no usable source material/,
    'a fully masked image reports the real problem instead of producing noise');
}

/* --- end to end: an excluded object is not reproduced -------------------- */
{
  // A bright bar on the right; the hole sits on the left over plain grass.
  const img = { data: new Uint8ClampedArray(scene.data), width: W, height: H };
  for (let y = 20; y < 70; y++) {
    for (let x = 85; x < 105; x++) {
      const p = (y * W + x) * 4;
      img.data[p] = 255; img.data[p + 1] = 40; img.data[p + 2] = 220;
    }
  }
  const fillMask = ellipseMask(W, H, 35, 45, 11, 9);
  const countMagenta = pixels => {
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (!fillMask[i]) continue;
      if (pixels[i * 4] > 180 && pixels[i * 4 + 1] < 110 && pixels[i * 4 + 2] > 150) n++;
    }
    return n;
  };

  // Force the bar to be the only attractive source by allowing nothing else.
  const onlyBar = new Uint8Array(W * H);
  for (let y = 18; y < 72; y++) for (let x = 83; x < 107; x++) onlyBar[y * W + x] = 255;
  const forced = CAF.fill({ data: new Uint8ClampedArray(img.data), width: W, height: H },
    fillMask, onlyBar, { seed: 7, maskExpansion: 0, quality: 'preview' });
  assert.ok(countMagenta(forced.pixels) > 20,
    'restricting sampling to the bar does pull the bar in — the control has an effect');

  // Now exclude it, and it must not come back.
  const withoutBar = new Uint8Array(W * H).fill(255);
  for (let y = 10; y < 80; y++) for (let x = 75; x < W; x++) withoutBar[y * W + x] = 0;
  const excluded = CAF.fill({ data: new Uint8ClampedArray(img.data), width: W, height: H },
    fillMask, withoutBar, { seed: 7, maskExpansion: 0, quality: 'preview' });
  assert.equal(countMagenta(excluded.pixels), 0,
    'excluding a region from the sampling area keeps it out of the fill');
}

console.log('content-aware sampling area tests passed');
