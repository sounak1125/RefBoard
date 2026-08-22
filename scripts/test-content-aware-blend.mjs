/* Seam removal (§21) and final compositing (§22, §23). */
import assert from 'node:assert/strict';
import {
  loadEngine, grassScene, wallScene, skyScene, ellipseMask, rectMask,
  textureEnergy, hashOutside, countMask,
} from './content-aware-harness.mjs';

const CAF = await loadEngine();
const W = 160, H = 120;

/* --- the band is a band, not the whole region --------------------------- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 80, 60, 22, 18);
  const holeCount = countMask(mask);

  // A field that disagrees everywhere: every pixel takes an unrelated source.
  const nnf = CAF.nnf.create(W, H);
  const random = CAF.makeRandom(4);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    nnf.x[i] = 10 + ((random() * 60) | 0);
    nnf.y[i] = 10 + ((random() * 40) | 0);
    nnf.d[i] = 1;
  }
  const filled = new Uint8ClampedArray(scene.data);
  const { band, capped } = CAF.seamBlender.buildBand(nnf, filled, mask, W, H, 4, 12);
  assert.ok(capped, 'a field that disagrees everywhere trips the band cap');

  /* Once capped, the band must be exactly the rim band — every interior seed is
   * discarded. Its size is then bounded by the blend radius rather than by a
   * fraction of the hole, which matters because on a small hole a legitimate
   * 4px rim already covers much of it. */
  const rim = CAF.dilateMask(CAF.seamBlender.rimSeeds(mask, W, H), W, H, 4);
  let bandCount = 0;
  for (let i = 0; i < W * H; i++) {
    if (!band[i]) continue;
    bandCount++;
    assert.equal(mask[i], 1, 'the band never extends outside the fill region');
    assert.equal(rim[i], 1, 'a capped band contains only rim pixels');
  }
  assert.ok(bandCount < holeCount, `the band is still a proper subset (${bandCount} of ${holeCount})`);

  // And on a large hole the same rim band really is a thin ring.
  const bigMask = ellipseMask(W, H, 80, 60, 50, 44);
  const bigRim = CAF.dilateMask(CAF.seamBlender.rimSeeds(bigMask, W, H), W, H, 4);
  let bigBand = 0, bigHole = 0;
  for (let i = 0; i < W * H; i++) {
    if (bigMask[i]) { bigHole++; if (bigRim[i]) bigBand++; }
  }
  assert.ok(bigBand < bigHole * 0.5,
    `on a large hole the rim band is a ring, not the region (${bigBand} of ${bigHole})`);
}

/* --- blending only moves pixels inside the band ------------------------- */
{
  const scene = wallScene(W, H);
  const mask = rectMask(W, H, 60, 45, 30, 24);
  const nnf = CAF.nnf.create(W, H);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    nnf.x[i] = (i % W) + 40;                    // one uniform, coherent translation
    nnf.y[i] = (i / W) | 0;
    nnf.d[i] = 0.1;
  }
  const source = new Uint8ClampedArray(scene.data);
  const filled = new Uint8ClampedArray(scene.data);
  CAF.patchVoting.coherentCopy({ width: W, height: H, radius: 3 },
    { nnf, hole: Int32Array.from(Array.from({ length: W * H }, (_, i) => i).filter(i => mask[i])),
      source, out: filled, mask, adapt: null });
  const before = new Uint8ClampedArray(filled);

  const info = CAF.seamBlender.blend({ width: W, height: H }, {
    nnf, filled, source, mask, radius: 4, allowance: 10,
  });

  for (let i = 0; i < W * H; i++) {
    if (info.band[i]) continue;
    for (let c = 0; c < 4; c++) {
      assert.equal(filled[i * 4 + c], before[i * 4 + c],
        `blending must not touch pixel ${i} outside the band`);
    }
  }
  assert.ok(info.nodes > 0, 'the rim was actually solved');
}

/* --- interior detail survives blending (§21: no global blur) ------------ */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 80, 60, 24, 20);
  const result = CAF.fill({ data: new Uint8ClampedArray(scene.data), width: W, height: H },
    mask, null, { seed: 11, maskExpansion: 0 });

  // The deep interior, well away from the rim, must keep its grain.
  const interior = CAF.erodeMask(mask, W, H, 8);
  assert.ok(countMask(interior) > 100, 'there is an interior to measure');
  const fillTexture = textureEnergy(result.pixels, W, H, interior);
  const trueTexture = textureEnergy(scene.data, W, H, interior);
  assert.ok(fillTexture > trueTexture * 0.55,
    `interior grain must survive (${fillTexture.toFixed(2)} vs ${trueTexture.toFixed(2)})`);
}

/* --- §22: outside the effective mask is bit-identical -------------------- */
{
  for (const scene of [grassScene(W, H), skyScene(W, H), wallScene(W, H)]) {
    const mask = ellipseMask(W, H, 80, 60, 20, 16);
    const input = new Uint8ClampedArray(scene.data);
    const result = CAF.fill({ data: new Uint8ClampedArray(input), width: W, height: H },
      mask, null, { seed: 5, maskExpansion: 0 });
    // With no expansion the effective mask is the caller's mask exactly.
    for (let i = 0; i < W * H; i++) {
      if (result.effectiveMask[i]) continue;
      for (let c = 0; c < 4; c++) {
        assert.equal(result.pixels[i * 4 + c], input[i * 4 + c],
          `pixel ${i} channel ${c} outside the mask must be untouched`);
      }
    }
    assert.equal(hashOutside(result.pixels, W, H, result.effectiveMask),
      hashOutside(input, W, H, result.effectiveMask), 'hash of untouched pixels matches');
  }
}

/* --- mask expansion widens the effective mask, and says so -------------- */
{
  const scene = wallScene(W, H);
  const mask = ellipseMask(W, H, 80, 60, 20, 16);
  const input = new Uint8ClampedArray(scene.data);
  const result = CAF.fill({ data: new Uint8ClampedArray(input), width: W, height: H },
    mask, null, { seed: 5, maskExpansion: 4 });
  assert.equal(result.maskExpansion, 4, 'the expansion actually applied is reported');
  assert.ok(countMask(result.effectiveMask) > countMask(mask),
    'the effective mask is larger than the requested one');
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) assert.equal(result.effectiveMask[i], 1, 'expansion only adds');
    if (result.effectiveMask[i]) continue;
    for (let c = 0; c < 4; c++) {
      assert.equal(result.pixels[i * 4 + c], input[i * 4 + c],
        'outside the *effective* mask is still bit-identical');
    }
  }
}

/* --- §23: alpha handling ------------------------------------------------- */
{
  const scene = grassScene(W, H);
  // A semi-transparent corner far from the hole must survive untouched.
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) scene.data[(y * W + x) * 4 + 3] = 120;
  const mask = ellipseMask(W, H, 80, 60, 18, 15);
  const input = new Uint8ClampedArray(scene.data);
  const result = CAF.fill({ data: new Uint8ClampedArray(input), width: W, height: H },
    mask, null, { seed: 9, maskExpansion: 0 });

  assert.equal(result.pixels[(3 * W + 3) * 4 + 3], 120, 'alpha outside the fill is preserved');
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    assert.equal(result.pixels[i * 4 + 3], 255, 'reconstructed pixels become opaque');
  }
}

/* --- edgeBlend 0 disables the solve entirely ---------------------------- */
{
  const scene = wallScene(W, H);
  const mask = rectMask(W, H, 70, 50, 20, 16);
  const result = CAF.fill({ data: new Uint8ClampedArray(scene.data), width: W, height: H },
    mask, null, { seed: 2, maskExpansion: 0, edgeBlend: 0 });
  assert.equal(result.options.edgeBlend, 0, 'the option is respected');
  assert.ok(result.pixels.length === W * H * 4, 'and the fill still completes');
}

console.log('content-aware blending tests passed');
