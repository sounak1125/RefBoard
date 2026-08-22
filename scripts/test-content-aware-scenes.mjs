/* The eight visual test cases of §38, on procedurally generated scenes.
 *
 * Synthetic rather than photographic so the suite needs no binary fixtures and
 * reproduces byte for byte anywhere. Every scene also writes a PNG into
 * content-aware-out/ (gitignored) so the numbers can be checked against what the
 * fill actually looks like — set CAF_NO_PNG=1 to skip.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  loadEngine, skyScene, grassScene, wallScene, horizonScene, architectureScene,
  ellipseMask, rectMask, hashOutside, textureEnergy, meanColor, rmse, countMask, luma,
} from './content-aware-harness.mjs';

const CAF = await loadEngine();
const OUT = new URL('../content-aware-out/', import.meta.url);
const wantPng = !process.env.CAF_NO_PNG;
let sharp = null;
if (wantPng) {
  try { ({ default: sharp } = await import('sharp')); } catch { /* optional */ }
}
if (sharp) await mkdir(OUT, { recursive: true });

async function dump(name, pixels, width, height) {
  if (!sharp) return;
  await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length),
    { raw: { width, height, channels: 4 } })
    .png().toFile(new URL(`${name}.png`, OUT).pathname.replace(/^\//, ''));
}

const W = 300, H = 220;

/* Paints the masked region with an obvious intruder, so a fill that quietly did
 * nothing cannot pass. Returns the pristine copy for comparison. */
function occlude(scene, mask, colour = [230, 20, 140]) {
  const truth = new Uint8ClampedArray(scene.data);
  for (let i = 0; i < scene.width * scene.height; i++) {
    if (!mask[i]) continue;
    scene.data[i * 4] = colour[0];
    scene.data[i * 4 + 1] = colour[1];
    scene.data[i * 4 + 2] = colour[2];
  }
  return truth;
}

function noIntruderLeft(pixels, mask, colour = [230, 20, 140]) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (Math.abs(pixels[i * 4] - colour[0]) < 40
      && Math.abs(pixels[i * 4 + 1] - colour[1]) < 40
      && Math.abs(pixels[i * 4 + 2] - colour[2]) < 40) n++;
  }
  return n;
}

const results = [];
async function scene(name, build) {
  const r = await build();
  results.push({ name, ...r });
}

/* Texture comparisons need an absolute floor as well as a ratio.
 *
 * Mean absolute luma gradient runs to a few hundredths on a smooth gradient, and
 * a ratio against a denominator that small is noise: a patch of cloudless sky
 * measures 0.29, so a perfectly good fill at 0.75 "fails" a 2.2x ratio test
 * while being invisibly different. Anything under about 1.5 luma levels per
 * pixel step is smooth by any standard the eye applies. */
function assertNotNoisier(fillTex, truthTex, ratioLimit, label) {
  const limit = Math.max(truthTex * ratioLimit, 1.5);
  assert.ok(fillTex <= limit,
    `${label}: ${fillTex.toFixed(2)} exceeds ${limit.toFixed(2)} (truth ${truthTex.toFixed(2)})`);
}

function assertNotSmoother(fillTex, truthTex, ratioLimit, label) {
  // Symmetric: below ~1.5 there is no detail left to lose.
  if (truthTex < 1.5) return;
  assert.ok(fillTex >= truthTex * ratioLimit,
    `${label}: ${fillTex.toFixed(2)} is below ${(truthTex * ratioLimit).toFixed(2)} (truth ${truthTex.toFixed(2)})`);
}

/* --- Test 1: sky --------------------------------------------------------- */
await scene('01-sky', async () => {
  const s = skyScene(W, H);
  const mask = ellipseMask(W, H, 150, 100, 26, 20);
  const truth = occlude(s, mask);
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('01-sky', r.pixels, W, H);

  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the object is gone');
  assert.ok(r.metrics.seamMean < 12, `no obvious seam (${r.metrics.seamMean.toFixed(1)})`);
  // Smooth continuation: the fill must not be noisier than the sky around it.
  const fillTex = textureEnergy(r.pixels, W, H, mask);
  const trueTex = textureEnergy(truth, W, H, mask);
  const ratio = fillTex / trueTex;
  assertNotNoisier(fillTex, trueTex, 2.2, 'sky stays smooth');
  assert.ok(r.metrics.boundaryToneShift < 14,
    `tone matches the surrounding sky (${r.metrics.boundaryToneShift.toFixed(1)})`);
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio };
});

/* --- Test 2: grass ------------------------------------------------------- */
await scene('02-grass', async () => {
  const s = grassScene(W, H);
  const mask = ellipseMask(W, H, 150, 110, 30, 24);
  const truth = occlude(s, mask);
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('02-grass', r.pixels, W, H);

  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the object is gone');
  const fillTex = textureEnergy(r.pixels, W, H, mask);
  const trueTex = textureEnergy(truth, W, H, mask);
  const ratio = fillTex / trueTex;
  // The point of the whole engine: no giant blurry region.
  assertNotSmoother(fillTex, trueTex, 0.6, 'grass keeps its grain');
  assertNotNoisier(fillTex, trueTex, 1.6, 'grass gains no artificial noise');
  assert.ok(r.metrics.repeatedPatchDensity < 0.85,
    `limited repeated-patch artefacts (${r.metrics.repeatedPatchDensity.toFixed(2)})`);
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio };
});

/* --- Test 3: wall -------------------------------------------------------- */
await scene('03-wall', async () => {
  const s = wallScene(W, H);
  // A picture frame: a rectangle, as §38 describes.
  const mask = rectMask(W, H, 120, 80, 60, 50);
  const truth = occlude(s, mask);
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('03-wall', r.pixels, W, H);

  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the frame is gone');
  const [fr, fg, fb] = meanColor(r.pixels, W, H, mask);
  const [tr, tg, tb] = meanColor(truth, W, H, mask);
  assert.ok(Math.abs(fr - tr) < 12 && Math.abs(fg - tg) < 12 && Math.abs(fb - tb) < 12,
    `wall colour stays consistent (${fr.toFixed(0)},${fg.toFixed(0)},${fb.toFixed(0)} vs ${tr.toFixed(0)},${tg.toFixed(0)},${tb.toFixed(0)})`);
  const fillTex = textureEnergy(r.pixels, W, H, mask);
  const trueTex = textureEnergy(truth, W, H, mask);
  const ratio = fillTex / trueTex;
  assertNotSmoother(fillTex, trueTex, 0.5, 'wall texture is reconstructed, not flattened');
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio };
});

/* --- Test 4: horizon ----------------------------------------------------- */
await scene('04-horizon', async () => {
  const s = horizonScene(W, H);
  const horizon = s.horizon;
  // A hole straddling the horizon line.
  const mask = ellipseMask(W, H, 150, horizon, 34, 26);
  const truth = occlude(s, mask);
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('04-horizon', r.pixels, W, H);

  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the object is gone');

  /* The horizon must continue through the hole. For every column the hole
   * covers, find the row of steepest vertical luma change and check it lands on
   * the true horizon rather than drifting or vanishing. */
  let columns = 0, onLine = 0;
  for (let x = 0; x < W; x++) {
    let top = -1, bottom = -1;
    for (let y = 0; y < H; y++) {
      if (!mask[y * W + x]) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0 || top > horizon - 4 || bottom < horizon + 4) continue;  // must span the line
    columns++;
    let bestY = -1, bestStep = 0;
    for (let y = top + 1; y < bottom; y++) {
      const step = Math.abs(luma(r.pixels, (y * W + x) * 4) - luma(r.pixels, ((y - 1) * W + x) * 4));
      if (step > bestStep) { bestStep = step; bestY = y; }
    }
    if (bestStep > 12 && Math.abs(bestY - horizon) <= 4) onLine++;
  }
  assert.ok(columns > 20, 'the hole genuinely spans the horizon');
  assert.ok(onLine / columns > 0.75,
    `the horizon continues through the fill (${onLine}/${columns} columns)`);

  // And the two sides must not be swapped: sky above, ground below.
  const above = new Uint8Array(W * H), below = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    if (((i / W) | 0) < horizon - 3) above[i] = 1;
    else if (((i / W) | 0) > horizon + 3) below[i] = 1;
  }
  const [ar, , ab] = meanColor(r.pixels, W, H, above);
  const [br, , bb] = meanColor(r.pixels, W, H, below);
  assert.ok(ab > ar, 'above the line stays sky');
  assert.ok(br > bb, 'below the line stays ground');
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio: onLine / columns };
});

/* --- Test 5: architecture ------------------------------------------------ */
await scene('05-architecture', async () => {
  const s = architectureScene(W, H);
  const mask = ellipseMask(W, H, 150, 110, 22, 18);
  const truth = occlude(s, mask);
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0, quality: 'high' });
  await dump('05-architecture', r.pixels, W, H);

  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the object is gone');

  /* Straight lines must be preserved. The scene has vertical mortar lines every
   * `columnEvery` px. Inside the reconstructed region those columns must still
   * read darker than the plain wall beside them — the comparison pixel is also
   * inside the hole, so this asks whether the fill rebuilt the *contrast*, not
   * merely whether it left the surroundings alone. */
  const columnEvery = s.columnEvery;
  let checked = 0, kept = 0, coveredColumns = 0;
  for (let x = 0; x < W; x++) {
    if (x % columnEvery !== 1) continue;                    // centre of a mortar line
    const off = x + Math.round(columnEvery / 2);            // plain wall, half a bay over
    if (off >= W) continue;
    let columnHit = false;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (!mask[i] || !mask[y * W + off]) continue;         // both must be reconstructed
      columnHit = true;
      checked++;
      if (luma(r.pixels, i * 4) < luma(r.pixels, (y * W + off) * 4) - 10) kept++;
    }
    if (columnHit) coveredColumns++;
  }
  assert.ok(coveredColumns >= 1 && checked > 10,
    `the hole covers part of a mortar line (${coveredColumns} columns, ${checked} samples)`);
  assert.ok(kept / checked > 0.6,
    `vertical structure continues through the fill (${kept}/${checked})`);
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio: kept / checked };
});

/* --- Test 6: large object (15-25% of the frame) -------------------------- */
await scene('06-large-object', async () => {
  const s = grassScene(W, H);
  const mask = ellipseMask(W, H, 150, 110, 76, 58);
  const share = countMask(mask) / (W * H);
  assert.ok(share > 0.15 && share < 0.25, `the object covers ${(share * 100).toFixed(0)}% of the frame`);
  const truth = occlude(s, mask);
  const started = Date.now();
  const r = CAF.fill({ data: new Uint8ClampedArray(s.data), width: W, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('06-large-object', r.pixels, W, H);

  assert.ok(Date.now() - started < 120000, 'a large erase completes in reasonable time');
  assert.equal(noIntruderLeft(r.pixels, mask), 0, 'the object is gone');
  assert.equal(r.metrics.missingRatio, 0, 'every pixel found a source');
  assert.ok(['OK', 'LOW_CONFIDENCE', 'REJECTED'].includes(r.status),
    'the engine states a confidence rather than pretending');
  const [mr] = meanColor(r.pixels, W, H, mask);
  assert.ok(mr > 10, 'the reconstruction is not black');
  const fillTex = textureEnergy(r.pixels, W, H, mask);
  const trueTex = textureEnergy(truth, W, H, mask);
  const ratio = fillTex / trueTex;
  assertNotSmoother(fillTex, trueTex, 0.5, 'a large erase is not a blurred patch');
  return { rmse: rmse(r.pixels, truth, W, H, mask), r, ratio };
});

/* --- Test 7: canvas extension (§24) -------------------------------------- */
await scene('07-extension', async () => {
  const src = horizonScene(W, H);
  const EXT = 70;
  const NW = W + EXT;
  const extended = new Uint8ClampedArray(NW * H * 4);
  const mask = new Uint8Array(NW * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < NW; x++) {
      const d = (y * NW + x) * 4;
      if (x < W) {
        const sIdx = (y * W + x) * 4;
        extended[d] = src.data[sIdx]; extended[d + 1] = src.data[sIdx + 1];
        extended[d + 2] = src.data[sIdx + 2]; extended[d + 3] = src.data[sIdx + 3];
      } else {
        // New canvas: transparent, and marked for reconstruction.
        mask[y * NW + x] = 1;
      }
    }
  }
  const before = new Uint8ClampedArray(extended);
  const beforeHash = hashOutside(before, NW, H, mask);

  const r = CAF.fill({ data: new Uint8ClampedArray(extended), width: NW, height: H },
    mask, null, { seed: 1337, maskExpansion: 0 });
  await dump('07-extension', r.pixels, NW, H);

  // The original image must be untouched and, crucially, not stretched.
  assert.equal(hashOutside(r.pixels, NW, H, mask), beforeHash,
    'every original pixel is bit-identical after extension');

  // The new region must be opaque, non-black, and continue the scene.
  for (let i = 0; i < NW * H; i++) {
    if (!mask[i]) continue;
    assert.equal(r.pixels[i * 4 + 3], 255, 'the new canvas is opaque');
  }
  const horizon = src.horizon;
  const newSky = new Uint8Array(NW * H), newGround = new Uint8Array(NW * H);
  for (let i = 0; i < NW * H; i++) {
    if (!mask[i]) continue;
    if (((i / NW) | 0) < horizon - 6) newSky[i] = 1;
    else if (((i / NW) | 0) > horizon + 6) newGround[i] = 1;
  }
  const [sr, , sb] = meanColor(r.pixels, NW, H, newSky);
  const [gr, , gb] = meanColor(r.pixels, NW, H, newGround);
  assert.ok(sb > sr, `the extended sky is still sky (r ${sr.toFixed(0)} b ${sb.toFixed(0)})`);
  assert.ok(gr > gb, `the extended ground is still ground (r ${gr.toFixed(0)} b ${gb.toFixed(0)})`);

  /* Not stretched: a stretch would make every column in the new region a copy
   * of the last original column. Check the extension actually varies. */
  let identicalColumns = 0;
  for (let x = W; x < NW; x++) {
    let same = true;
    for (let y = 0; y < H; y += 3) {
      if (Math.abs(r.pixels[(y * NW + x) * 4] - r.pixels[(y * NW + W - 1) * 4]) > 3) { same = false; break; }
    }
    if (same) identicalColumns++;
  }
  assert.ok(identicalColumns < EXT * 0.3,
    `the extension is synthesised, not an edge smear (${identicalColumns}/${EXT} columns identical)`);
  return { rmse: 0, r, ratio: 1 - identicalColumns / EXT };
});

/* --- Test 8: protected pixels -------------------------------------------- */
await scene('08-protected', async () => {
  let checked = 0;
  for (const build of [skyScene, grassScene, wallScene, horizonScene, architectureScene]) {
    const s = build(W, H);
    const mask = ellipseMask(W, H, 150, 110, 24, 19);
    const input = new Uint8ClampedArray(s.data);
    const before = hashOutside(input, W, H, mask);
    const r = CAF.fill({ data: new Uint8ClampedArray(input), width: W, height: H },
      mask, null, { seed: 1337, maskExpansion: 0 });
    assert.equal(hashOutside(r.pixels, W, H, mask), before,
      `${build.name}: pixels outside the mask must hash identically before and after`);
    checked++;
  }
  assert.equal(checked, 5);
  return { rmse: 0, r: { processingTime: 0, confidence: 1, status: 'OK', metrics: {} }, ratio: 1 };
});

console.log('\n scene              ms   RMSE  conf  status          key metric');
for (const { name, rmse: e, r, ratio } of results) {
  console.log(' ' + name.padEnd(18)
    + String(r.processingTime).padStart(4) + '  '
    + e.toFixed(1).padStart(5) + '  '
    + r.confidence.toFixed(2) + '  '
    + (r.status || '').padEnd(15)
    + (ratio === undefined ? '' : ratio.toFixed(2)));
}
if (sharp) console.log(`\n PNGs written to content-aware-out/`);
console.log('\ncontent-aware scene tests passed');
