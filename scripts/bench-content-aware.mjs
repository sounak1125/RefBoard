/* Benchmark (§40).
 *
 * Times a fill at four resolutions against three mask sizes, split by stage.
 * Stage boundaries come from the engine's own progress reports, so the split
 * reflects what the pipeline actually does rather than a guess.
 *
 *   node scripts/bench-content-aware.mjs [--quick] [--quality=balanced]
 *
 * Not part of `npm test`: the large cases take minutes and allocate gigabytes.
 */
import { loadEngine, grassScene, ellipseMask, countMask } from './content-aware-harness.mjs';

const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const qualityArg = [...args].find(a => a.startsWith('--quality='));
const quality = qualityArg ? qualityArg.split('=')[1] : 'balanced';

const CAF = await loadEngine();

const RESOLUTIONS = quick
  ? [[960, 540], [1920, 1080]]
  : [[1920, 1080], [2560, 1440], [3840, 2160], [6000, 4000]];

// Mask sizes as a share of the frame's short edge, per §40's small/medium/large.
const MASKS = [
  ['small', 0.05],
  ['medium', 0.16],
  ['large', 0.34],
];

const mb = bytes => (bytes / (1024 * 1024)).toFixed(0);

function peakMemory() {
  const u = process.memoryUsage();
  return u.heapUsed + u.external;
}

console.log(`content-aware fill benchmark — quality: ${quality}${quick ? ' (quick)' : ''}`);
console.log('');
console.log('resolution   mask     hole px    prepare  pyramid   match   blend   score    total     rss   algorithm');
console.log('-'.repeat(112));

const rows = [];
for (const [W, H] of RESOLUTIONS) {
  const scene = grassScene(W, H);
  for (const [label, share] of MASKS) {
    const r = Math.round(Math.min(W, H) * share);
    const mask = ellipseMask(W, H, W >> 1, H >> 1, r, Math.round(r * 0.78));
    const holePx = countMask(mask);

    const input = { data: new Uint8ClampedArray(scene.data), width: W, height: H };
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      input.data[i * 4] = 220; input.data[i * 4 + 1] = 30; input.data[i * 4 + 2] = 120;
    }

    // Stage boundaries, taken from the engine's own progress stream.
    const marks = [];
    let lastStage = null;
    const onProgress = stage => {
      if (stage === lastStage) return;
      lastStage = stage;
      marks.push({ stage, at: performance.now() });
    };

    if (global.gc) global.gc();
    const before = peakMemory();
    const started = performance.now();
    let result;
    try {
      result = CAF.fill(input, mask, null, { quality, seed: 1337, maskExpansion: 0, onProgress });
    } catch (err) {
      console.log(`${(W + 'x' + H).padEnd(12)} ${label.padEnd(8)} ${String(holePx).padStart(9)}   FAILED: ${err.message}`);
      continue;
    }
    const total = performance.now() - started;
    const after = peakMemory();
    marks.push({ stage: 'end', at: performance.now() });

    /* Fold the per-level stages into one "match" bucket. The engine reports
     * "Complete" before it scores the result, so whatever falls after the last
     * mark is the quality report and the final composite — attributed here
     * rather than silently dropped, which is what made an earlier run of this
     * benchmark read as 80% matching when matching was under 40%. */
    const bucket = { prepare: 0, pyramid: 0, match: 0, blend: 0 };
    for (let i = 0; i < marks.length - 1; i++) {
      const span = marks[i + 1].at - marks[i].at;
      const name = marks[i].stage;
      if (name === 'Preparing image') bucket.prepare += span;
      else if (name === 'Building pyramid') bucket.pyramid += span;
      else if (name.startsWith('Level')) bucket.match += span;
      else if (name === 'Blending') bucket.blend += span;
    }
    const score = Math.max(0, total - (bucket.prepare + bucket.pyramid + bucket.match + bucket.blend));

    const ms = v => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`);
    console.log(
      `${(W + 'x' + H).padEnd(12)} ${label.padEnd(8)} ${String(holePx).padStart(9)}   `
      + `${ms(bucket.prepare).padStart(7)}  ${ms(bucket.pyramid).padStart(7)}  `
      + `${ms(bucket.match).padStart(6)}  ${ms(bucket.blend).padStart(6)}  `
      + `${ms(score).padStart(6)}  `
      + `${ms(total).padStart(7)}  ${(mb(after - before) + 'M').padStart(6)}   ${result.algorithmUsed}`);

    rows.push({ W, H, label, holePx, total, ...bucket, confidence: result.confidence, status: result.status });
  }
}

console.log('');
const slowest = rows.slice().sort((a, b) => b.total - a.total)[0];
if (slowest) {
  console.log(`slowest: ${slowest.W}x${slowest.H} ${slowest.label} mask — ${(slowest.total / 1000).toFixed(1)}s`
    + ` (${((slowest.match / slowest.total) * 100).toFixed(0)}% matching)`);
}
const lowConfidence = rows.filter(r => r.status !== 'OK');
if (lowConfidence.length) {
  console.log(`flagged: ${lowConfidence.map(r => `${r.W}x${r.H}/${r.label} (${r.status})`).join(', ')}`);
}
