// Runs the old in-repo exemplar engine (scripts/content-aware, read-only) on one case.
//   node old-engine.mjs <caseDir> <outDir> [quality]
// Writes <outDir>/old.png and <outDir>/old.json (time, peak RSS, engine verdict).
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(REPO, 'package.json'));
const sharp = require('sharp');
const { loadEngine } = await import(pathToFileURL(path.join(REPO, 'scripts', 'content-aware-harness.mjs')).href);

const [caseDir, outDir, quality = 'balanced'] = process.argv.slice(2);
await mkdir(outDir, { recursive: true });

const img = await sharp(path.join(caseDir, 'image.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const mask = await sharp(path.join(caseDir, 'mask.png')).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
const { width, height } = img.info;
const fillMask = new Uint8Array(width * height);
for (let i = 0; i < fillMask.length; i++) fillMask[i] = mask.data[i] > 127 ? 255 : 0;

const CAF = await loadEngine();
const t0 = performance.now();
let result, error = null;
try {
  result = CAF.fill({ width, height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) },
    fillMask, null, { quality });
} catch (err) {
  error = String(err && err.message || err);
}
const ms = Math.round(performance.now() - t0);
const peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
if (result) {
  await sharp(Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.length),
    { raw: { width, height, channels: 4 } }).removeAlpha().png().toFile(path.join(outDir, 'old.png'));
}
const info = {
  engine: 'old', quality, ms, peakRssMB, error,
  algorithm: result?.algorithmUsed, confidence: result?.confidence, status: result?.status,
  hardRejected: result?.hardRejected, lowConfidence: result?.lowConfidence,
};
await writeFile(path.join(outDir, 'old.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
