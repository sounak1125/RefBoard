import fs from 'node:fs';
import {
  IMAGE_DYNAMIC_TIERS,
  IMAGE_FULL_TIER,
  IMAGE_PROXY_TIER,
  selectImageRenderDemand,
  selectScreenImageTier,
} from './image-render-demand.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const candidates = Array.from({ length: 500 }, (_, i) => ({
  key: `image-${i}`,
  pixels: 1_000_000,
  distance: i,
}));
const first = selectImageRenderDemand(candidates, 8_000_000);
const second = selectImageRenderDemand(candidates, 8_000_000);
assert(first.selected.size === 8, 'large boards must keep high-quality demand within budget');
assert([...first.selected].join(',') === [...second.selected].join(','), 'a fixed view must produce a stable demand set');
assert(first.selected.has('image-0') && first.selected.has('image-7'), 'closest images receive high-quality surfaces');
assert(!first.selected.has('image-8'), 'distant images remain on stable proxies');
for (const count of [200, 500]) {
  const a = selectImageRenderDemand(candidates.slice(0, count), 8_000_000);
  const b = selectImageRenderDemand(candidates.slice(0, count), 8_000_000);
  assert(a.usedPixels <= 8_000_000, `${count}-image demand remains inside the LOD budget`);
  assert([...a.selected].join(',') === [...b.selected].join(','), `${count}-image demand is deterministic`);
}

const oversized = selectImageRenderDemand([
  { key: 'near', pixels: 20_000_000, distance: 0 },
  { key: 'far', pixels: 1, distance: 1 },
], 8_000_000);
assert(oversized.selected.size === 1 && oversized.selected.has('near'), 'one oversized nearest image may sharpen');

const duplicates = selectImageRenderDemand([
  { key: 'same', pixels: 10, distance: 20 },
  { key: 'same', pixels: 10, distance: 2 },
  { key: 'other', pixels: 10, distance: 3 },
], 10);
assert(duplicates.selected.size === 1 && duplicates.selected.has('same'), 'duplicate image demand is charged once at nearest distance');

// Exhaust the supported 0.4% -> 10000% zoom range in 2% multiplicative steps.
const tierRank = tier => tier === IMAGE_FULL_TIER
  ? IMAGE_DYNAMIC_TIERS.length + 1
  : [IMAGE_PROXY_TIER, ...IMAGE_DYNAMIC_TIERS].indexOf(tier);
const zoomSamples = [];
for (let zoom = 0.004; zoom < 100; zoom *= 1.02) zoomSamples.push(zoom);
zoomSamples.push(100);
let previousTier = null;
for (const zoom of zoomSamples) {
  const requiredPixels = 1000 * zoom * 2; // 1000 board px on a 2x display.
  const frozen = selectScreenImageTier({
    requiredPixels,
    sourcePixels: 4000,
    previousTier,
    navigating: true,
  });
  assert(frozen === (previousTier || IMAGE_PROXY_TIER), `navigation must freeze quality at zoom ${zoom}`);
  const settled = selectScreenImageTier({ requiredPixels, sourcePixels: 4000, previousTier });
  assert(previousTier == null || tierRank(settled) >= tierRank(previousTier), `zoom-in quality must not regress at ${zoom}`);
  if (settled !== IMAGE_FULL_TIER) {
    assert(requiredPixels <= settled * 1.1 || settled === IMAGE_PROXY_TIER,
      `settled texture must stay within the 10% crispness tolerance at ${zoom}`);
  }
  previousTier = settled;
}
assert(previousTier === IMAGE_FULL_TIER, 'extreme zoom ends at full resolution');

for (const zoom of [...zoomSamples].reverse()) {
  const settled = selectScreenImageTier({
    requiredPixels: 1000 * zoom * 2,
    sourcePixels: 4000,
    previousTier,
  });
  assert(tierRank(settled) <= tierRank(previousTier), `zoom-out quality must not increase at ${zoom}`);
  previousTier = settled;
}
assert(previousTier === IMAGE_PROXY_TIER, 'fit/far zoom returns to the permanent proxy');

assert(selectScreenImageTier({ requiredPixels: 500, sourcePixels: 4000, previousTier: 512 }) === 512,
  'a 512px surface remains stable below its upgrade boundary');
assert(selectScreenImageTier({ requiredPixels: 540, sourcePixels: 4000, previousTier: 512 }) === 512,
  'small threshold oscillations do not chatter');
assert(selectScreenImageTier({ requiredPixels: 570, sourcePixels: 4000, previousTier: 512 }) === 1024,
  'quality upgrades after crossing hysteresis');
assert(selectScreenImageTier({ requiredPixels: 300, sourcePixels: 400, previousTier: 256 }) === IMAGE_FULL_TIER,
  'small originals use full resolution instead of a pointless oversized LOD');

const fit500 = Array.from({ length: 500 }, (_, i) => selectScreenImageTier({
  requiredPixels: 120,
  sourcePixels: 4000,
  previousTier: i % 2 ? 1024 : 512,
}));
assert(fit500.every(tier => tier === IMAGE_PROXY_TIER), '500 fit-to-board images settle to proxies instead of retaining large textures');
const worstProxyMiB = 500 * IMAGE_PROXY_TIER * IMAGE_PROXY_TIER * 4 / 1048576;
assert(worstProxyMiB === 125, '500 square stable proxies have a deterministic 125 MiB worst case');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert(html.includes('const IMAGE_STABLE_PROXY_MAX_DIM = IMAGE_PROXY_TIER;'), 'stable proxy size cap is present');
assert(html.includes('await ensureStableImageProxy(im, blob);'), 'image intake builds the stable proxy before completing');
assert(html.includes('await ensureStableImageProxy(image, blob);'), 'session restore builds stable proxies while opening');
assert(html.includes('if (!bitmap && im.proxy)'), 'renderer falls back to a stable proxy');
const fullFallback = html.indexOf('if (!bitmap && highQualityDemandAllowed)');
const proxyFallback = html.indexOf('if (!bitmap && im.proxy)');
assert(fullFallback >= 0 && proxyFallback > fullFallback, 'full-resolution export/render paths remain ahead of proxy fallback');
assert(html.includes('const highQualityDemandAllowed = opts.noLod'), 'noLod export paths always retain full-resolution demand');
assert(html.includes('updateImageRenderDemandPlan(drawVisibleItems);'), 'each frame has a bounded high-quality demand plan');
assert(html.includes('previousTier: imageDisplayTargets.get(it.id)'), 'screen-sized targets retain hysteresis state per item');
assert(html.includes('const navigating = isNavigatingView();'), 'quality changes pause during navigation');
assert(html.includes('return imageTargetForItem(it) === job.bucket'), 'obsolete zoom-tier jobs are cancelled');
assert(html.includes('&& imageTargetForItem(it) === IMAGE_FULL_TIER'), 'obsolete full-resolution display jobs are cancelled');
assert(html.includes('activeImageLodDemand.add'), 'the currently drawn surface is protected during atomic replacement');
assert(html.includes('evictImageLods(im, bucket);'), 'one admitted oversized LOD is protected from immediate self-eviction');
assert(html.includes('try { im.proxy?.close?.(); }'), 'stable proxies close when a board is released');
assert(packageJson.build.files.includes('scripts/image-render-demand.mjs'), 'packaged builds include the demand policy module');

console.log('image render stability tests passed');
