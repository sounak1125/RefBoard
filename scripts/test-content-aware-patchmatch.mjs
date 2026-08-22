/* NNF construction (§7, §8), propagation and random search (§10, §11),
 * pyramid handoff (§12) and determinism. */
import assert from 'node:assert/strict';
import { loadEngine, grassScene, wallScene, ellipseMask, rectMask } from './content-aware-harness.mjs';

const CAF = await loadEngine();
const W = 140, H = 110;

function setup(scene, mask, radius = 4) {
  const info = CAF.maskProcessor.prepare(mask, W, H, { maskExpansion: 0, despeckle: false });
  const area = CAF.samplingArea.build(info.fill, scene.data, W, H, { forbiddenDilation: 5 }, null);
  const centers = CAF.samplingArea.buildValidCenters(area.allowed, W, H, radius);
  const hole = [];
  for (let i = 0; i < W * H; i++) if (info.fill[i]) hole.push(i);
  const holeArr = Int32Array.from(hole);
  const { order } = CAF.confidence.fillOrder(info.fill, W, H);
  const conf = CAF.confidence.create(info.fill, W, H);
  const lab = CAF.rgbaToLab(scene.data, W, H);
  const analysis = CAF.structureAnalyzer.analyze(scene.data, info.fill, W, H, order);
  const weights = CAF.patchDistance.buildPatchWeights(holeArr, conf, info.fill, W, H, radius);
  const scorer = CAF.patchDistance.createScorer({
    width: W, height: H, radius, lab, gx: analysis.gx, gy: analysis.gy, sd: analysis.sd,
    confidence: conf, weights,
    colorWeight: 1, gradientWeight: 0.55, structureWeight: 0.45, localityWeight: 0.12,
    localityRef: Math.hypot(W, H),
  });
  return { info, area, centers, holeArr, scorer, radius };
}

/* --- initialisation only ever proposes legal sources (§7, §8) ------------ */
{
  const scene = grassScene(W, H);
  const s = setup(scene, ellipseMask(W, H, 70, 55, 14, 12));
  const nnf = CAF.nnf.create(W, H);
  CAF.nnf.randomInit(nnf, s.holeArr, s.centers, CAF.makeRandom(99));
  for (let k = 0; k < s.holeArr.length; k++) {
    const p = s.holeArr[k];
    assert.ok(nnf.x[p] >= 0 && nnf.y[p] >= 0, 'every hole pixel gets a match');
    assert.equal(s.centers.valid[nnf.y[p] * W + nnf.x[p]], 1,
      'an initial source is always a legal patch centre');
    assert.equal(s.info.fill[nnf.y[p] * W + nnf.x[p]], 0,
      'an initial source is never inside the fill region');
  }
  // Pixels outside the hole must be left untouched.
  assert.equal(nnf.x[0], -1, 'known pixels carry no match');
}

/* --- iteration lowers total cost and never leaves an illegal match ------- */
{
  const scene = grassScene(W, H);
  const s = setup(scene, ellipseMask(W, H, 70, 55, 14, 12));
  const nnf = CAF.nnf.create(W, H);
  const random = CAF.makeRandom(1337);
  CAF.nnf.randomInit(nnf, s.holeArr, s.centers, random);

  const totalCost = () => {
    let sum = 0;
    for (let k = 0; k < s.holeArr.length; k++) {
      const d = nnf.d[s.holeArr[k]];
      sum += Number.isFinite(d) ? d : 1e6;
    }
    return sum;
  };

  CAF.patchmatch.run({ width: W, height: H, radius: s.radius }, {
    nnf, hole: s.holeArr, centers: s.centers, scorer: s.scorer,
    iterations: 1, searchRadius: 64, transforms: Uint8Array.from([0]),
    coherenceWeight: 0.6, coherenceRef: 6, random,
  });
  const afterOne = totalCost();

  CAF.patchmatch.run({ width: W, height: H, radius: s.radius }, {
    nnf, hole: s.holeArr, centers: s.centers, scorer: s.scorer,
    iterations: 4, searchRadius: 64, transforms: Uint8Array.from([0]),
    coherenceWeight: 0.6, coherenceRef: 6, random,
  });
  const afterFive = totalCost();

  assert.ok(afterFive <= afterOne,
    `more iterations must not make the field worse (${afterOne.toFixed(2)} -> ${afterFive.toFixed(2)})`);
  assert.ok(Number.isFinite(afterFive), 'costs stay finite — no NaN has leaked in');

  for (let k = 0; k < s.holeArr.length; k++) {
    const p = s.holeArr[k];
    assert.equal(s.centers.valid[nnf.y[p] * W + nnf.x[p]], 1,
      'iteration never lands on an illegal source');
    assert.ok(nnf.d[p] >= 0, 'costs are non-negative');
  }
}

/* --- random search terminates even with an absurd radius ---------------- */
{
  const scene = wallScene(W, H);
  const s = setup(scene, rectMask(W, H, 60, 45, 18, 14));
  const nnf = CAF.nnf.create(W, H);
  const random = CAF.makeRandom(5);
  CAF.nnf.randomInit(nnf, s.holeArr, s.centers, random);
  const out = CAF.patchmatch.run({ width: W, height: H, radius: s.radius }, {
    nnf, hole: s.holeArr, centers: s.centers, scorer: s.scorer,
    iterations: 2, searchRadius: 1 << 20, transforms: Uint8Array.from([0]),
    coherenceWeight: 0.6, random,
  });
  assert.ok(out.evaluated > 0, 'candidates were actually evaluated');
}

/* --- cancellation is honoured mid-run ----------------------------------- */
{
  const scene = grassScene(W, H);
  const s = setup(scene, ellipseMask(W, H, 70, 55, 14, 12));
  const nnf = CAF.nnf.create(W, H);
  const random = CAF.makeRandom(3);
  CAF.nnf.randomInit(nnf, s.holeArr, s.centers, random);
  let iterationsSeen = 0;
  CAF.patchmatch.run({ width: W, height: H, radius: s.radius }, {
    nnf, hole: s.holeArr, centers: s.centers, scorer: s.scorer,
    iterations: 20, searchRadius: 32, transforms: Uint8Array.from([0]),
    coherenceWeight: 0.6, random,
    onProgress: () => { iterationsSeen++; },
    shouldCancel: () => iterationsSeen >= 2,
  });
  assert.ok(iterationsSeen <= 3, `cancellation stops the loop promptly (saw ${iterationsSeen})`);
}

/* --- pyramid handoff scales the offset, not the absolute position -------
 * Scaling the source position instead collapses adjacent fine pixels onto one
 * source pixel, magnifying the source and halving grain at every level. */
{
  const cw = 20, ch = 16, fw = 40, fh = 32;
  const coarse = CAF.nnf.create(cw, ch);
  const fineMask = new Uint8Array(fw * fh);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) fineMask[y * fw + x] = 1;
  const coarseHole = [];
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) { coarseHole.push(y * cw + x); }
  // A uniform +6,+0 translation at the coarse level.
  for (const p of coarseHole) { coarse.x[p] = (p % cw) + 6; coarse.y[p] = (p / cw) | 0; coarse.t[p] = 0; }

  const allowed = new Uint8Array(fw * fh).fill(1);
  for (let i = 0; i < fw * fh; i++) if (fineMask[i]) allowed[i] = 0;
  const centers = CAF.samplingArea.buildValidCenters(allowed, fw, fh, 1);
  const fine = CAF.nnf.create(fw, fh);
  const fineHole = [];
  for (let i = 0; i < fw * fh; i++) if (fineMask[i]) fineHole.push(i);
  CAF.nnf.upsample(coarse, cw, ch, fine, fw, fh, Int32Array.from(fineHole), centers, CAF.makeRandom(1));

  let exact = 0, distinct = new Set();
  for (const p of fineHole) {
    if (fine.x[p] < 0) continue;
    distinct.add(fine.y[p] * fw + fine.x[p]);
    if (fine.x[p] - (p % fw) === 12 && fine.y[p] - ((p / fw) | 0) === 0) exact++;
  }
  assert.ok(exact > fineHole.length * 0.5,
    `the coarse +6 offset must become +12 at double resolution (${exact}/${fineHole.length})`);
  assert.ok(distinct.size > fineHole.length * 0.5,
    `adjacent fine pixels must map to distinct source pixels, not collapse (${distinct.size} distinct for ${fineHole.length} targets)`);
}

/* --- shift-labelling candidates are deduplicated without collisions ------
 * The dedup key used to be (dx + 4096) * 8192 + (dy + 4096), which collides as
 * soon as a shift can exceed 4096 px — and the sweep runs to +/-max(width,
 * height). A collision silently drops a candidate translation, so it only shows
 * up as slightly worse fills on large images. */
{
  const SPAN = 32768;
  const key = (dx, dy) => (dx + SPAN) * (SPAN * 2 + 1) + (dy + SPAN);
  const seen = new Set();
  let collisions = 0;
  // Sweep the range a 6000px-wide image actually produces.
  for (let dx = -6000; dx <= 6000; dx += 97) {
    for (let dy = -4000; dy <= 4000; dy += 89) {
      const k = key(dx, dy);
      if (seen.has(k)) collisions++;
      seen.add(k);
      assert.ok(Number.isSafeInteger(k), `key(${dx}, ${dy}) must stay an exact integer`);
    }
  }
  assert.equal(collisions, 0, 'no two distinct shifts may share a key');
  assert.equal(key(0, 4096) === key(1, -4096), false,
    'the specific pair that collided under the old encoding must not collide');

  // And the module in use must be the fixed one. Comments are stripped first:
  // the fix documents the old encoding, and matching that would defeat the test.
  const source = await (await import('node:fs/promises'))
    .readFile(new URL('./content-aware/shift-labeling.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\+ 4096\) \* 8192/, 'the colliding encoding must be gone from the code');
  assert.match(code, /const shiftKey = \(dx, dy\)/, 'candidate keys go through one shared encoder');
  assert.equal((code.match(/shiftKey\(/g) || []).length >= 4, true,
    'every candidate-dedup site uses it');
}

/* --- determinism (§8): same inputs and seed produce identical output ----- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 70, 55, 14, 12);
  const run = seed => CAF.fill(
    { data: new Uint8ClampedArray(scene.data), width: W, height: H },
    mask, null, { seed, quality: 'preview', maskExpansion: 0 }).pixels;

  const a = run(1337);
  const b = run(1337);
  assert.deepEqual(Array.from(a), Array.from(b), 'the same seed reproduces the result byte for byte');

  const c = run(2024);
  let differences = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) differences++;
  assert.ok(differences > 0, 'a different seed explores a different solution');
}

console.log('content-aware patchmatch tests passed');
