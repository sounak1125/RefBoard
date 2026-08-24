import fs from 'node:fs';
import {
  IMAGE_DYNAMIC_TIERS,
  IMAGE_FLOOR_TIER,
  IMAGE_FULL_TIER,
  IMAGE_NAV_PREWARM_DELAY_MS,
  IMAGE_PROXY_TIER,
  selectImageRenderDemand,
  selectScreenImageTier,
  shouldPromoteReadyImageTier,
  updateImagePrewarmState,
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

// An image bigger than the whole budget cannot share it. Admitting it because it
// happened to be nearest spent the entire budget on one image and dropped every
// other visible image to its 256px proxy in the same frame.
const oversized = selectImageRenderDemand([
  { key: 'near', pixels: 20_000_000, distance: 0 },
  { key: 'far', pixels: 1, distance: 1 },
], 8_000_000);
assert(oversized.selected.size === 1 && oversized.selected.has('far'),
  'an over-budget image never starves the images that do fit');
assert(oversized.usedPixels === 1, 'the deferred oversized image is not charged to the budget');

// It still sharpens when nothing else wants the budget, so zooming into one huge
// image on a sparse board behaves as before.
const oversizedAlone = selectImageRenderDemand([
  { key: 'near', pixels: 20_000_000, distance: 0 },
], 8_000_000);
assert(oversizedAlone.selected.size === 1 && oversizedAlone.selected.has('near'),
  'a lone oversized image may still sharpen');

// The nearest of several over-budget images is the one that gets the fallback.
const oversizedChoice = selectImageRenderDemand([
  { key: 'far-huge', pixels: 20_000_000, distance: 500 },
  { key: 'near-huge', pixels: 20_000_000, distance: 5 },
], 8_000_000);
assert(oversizedChoice.selected.size === 1 && oversizedChoice.selected.has('near-huge'),
  'the nearest over-budget image wins the last-resort slot');

// The floor tier is what a refused image falls back to instead of the proxy.
// Callers rank it with a large negative bias, so it must be admitted before any
// competitive demand however close that demand is to the pointer.
const FLOOR_PRIORITY = 3e15;
const floorPixels = IMAGE_FLOOR_TIER * IMAGE_FLOOR_TIER;
const floored = selectImageRenderDemand([
  ...Array.from({ length: 40 }, (_, i) => ({
    key: `floor-${i}`, pixels: floorPixels, distance: i * 1000 - FLOOR_PRIORITY,
  })),
  ...Array.from({ length: 40 }, (_, i) => ({
    key: `sharp-${i}`, pixels: 1_000_000, distance: i * 1000 - 2e15,
  })),
], 60_000_000);
for (let i = 0; i < 40; i++) {
  assert(floored.selected.has(`floor-${i}`), `every visible image keeps its floor tier (${i})`);
}
assert([...floored.selected].some(key => key.startsWith('sharp-')),
  'the floor does not consume the whole budget');

const duplicates = selectImageRenderDemand([
  { key: 'same', pixels: 10, distance: 20 },
  { key: 'same', pixels: 10, distance: 2 },
  { key: 'other', pixels: 10, distance: 3 },
], 10);
assert(duplicates.selected.size === 1 && duplicates.selected.has('same'), 'duplicate image demand is charged once at nearest distance');

// Demand distances are squared screen pixels and are recomputed every frame from
// a live view. Zoom is anchored at the pointer, not the viewport centre, so the
// ranking around the budget boundary churns continuously while the wheel turns.
// Each eviction from the admitted set is a visible drop to a blurrier surface,
// so admissions must survive reordering that does not change much.
// 425k squared px is an image roughly 650 screen px from the viewport centre.
// Neighbours sit 20k apart; the per-frame wobble swings up to 33k between any
// adjacent pair, so the 8th and 9th images genuinely trade places mid-sweep.
const sweepFrame = frame => Array.from({ length: 40 }, (_, i) => ({
  key: `sweep-${i}`,
  pixels: 1_000_000,
  distance: 285_000 + i * 20_000 + Math.sin((i + frame) * 1.7) * 22_000,
}));
const countAdmissions = (before, after) =>
  before ? [...after].filter(key => !before.has(key)).length : 0;
let stickyPrevious = null;
let plainPrevious = null;
let stickyChurn = 0;
let plainChurn = 0;
for (let frame = 0; frame < 60; frame++) {
  const frameCandidates = sweepFrame(frame);
  const sticky = selectImageRenderDemand(frameCandidates, 8_000_000, { previous: stickyPrevious }).selected;
  const plain = selectImageRenderDemand(frameCandidates, 8_000_000).selected;
  stickyChurn += countAdmissions(stickyPrevious, sticky);
  plainChurn += countAdmissions(plainPrevious, plain);
  stickyPrevious = sticky;
  plainPrevious = plain;
}
assert(plainChurn > 0, 'the zoom-sweep fixture must actually reorder demand across frames');
assert(stickyChurn === 0, 'incumbent admissions survive frame-to-frame reordering');

const displaced = selectImageRenderDemand([
  { key: 'incumbent', pixels: 8_000_000, distance: 1_000_000 },
  { key: 'challenger', pixels: 8_000_000, distance: 10_000 },
], 8_000_000, { previous: new Set(['incumbent']) });
assert(displaced.selected.has('challenger') && !displaced.selected.has('incumbent'),
  'incumbency is a bias, not a lock: a much nearer image still takes the slot');

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
  if (previousTier) {
    assert(frozen === previousTier, `navigation must freeze a displayed tier at zoom ${zoom}`);
  } else {
    assert(frozen === selectScreenImageTier({ requiredPixels, sourcePixels: 4000 }),
      `an item with no displayed tier picks its real surface immediately at zoom ${zoom}`);
  }
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

// An image revealed mid-gesture has no displayed tier to protect. Pinning it to
// the proxy only delayed its first real surface until the wheel settled, which
// on a large board is a visible band of blur behind the pointer.
assert(selectScreenImageTier({
  requiredPixels: 1800, sourcePixels: 4000, previousTier: null, navigating: true,
}) === 2048, 'an item revealed mid-gesture requests its real tier instead of waiting for settle');
assert(selectScreenImageTier({
  requiredPixels: 1800, sourcePixels: 4000, previousTier: 512, navigating: true,
}) === 512, 'a tier that is already displayed still never changes mid-gesture');

assert(shouldPromoteReadyImageTier({
  currentTier: IMAGE_PROXY_TIER,
  desiredTier: 1024,
  sourcePixels: 4000,
  ready: true,
}), 'a decoded sharper tier may replace the proxy during navigation');
assert(!shouldPromoteReadyImageTier({
  currentTier: IMAGE_PROXY_TIER,
  desiredTier: 1024,
  sourcePixels: 4000,
  ready: false,
}), 'an unfinished tier never replaces the currently drawable surface');
assert(!shouldPromoteReadyImageTier({
  currentTier: 1024,
  desiredTier: IMAGE_PROXY_TIER,
  sourcePixels: 4000,
  ready: true,
}), 'navigation never downgrades to a blurrier ready tier');
assert(!shouldPromoteReadyImageTier({
  currentTier: IMAGE_FULL_TIER,
  desiredTier: 2048,
  sourcePixels: 4000,
  ready: true,
}), 'navigation never replaces a full surface with a lower tier');

const fit500 = Array.from({ length: 500 }, (_, i) => selectScreenImageTier({
  requiredPixels: 120,
  sourcePixels: 4000,
  previousTier: i % 2 ? 1024 : 512,
}));
assert(fit500.every(tier => tier === IMAGE_PROXY_TIER), '500 fit-to-board images settle to proxies instead of retaining large textures');
const worstProxyMiB = 500 * IMAGE_PROXY_TIER * IMAGE_PROXY_TIER * 4 / 1048576;
assert(worstProxyMiB === 125, '500 square stable proxies have a deterministic 125 MiB worst case');

let prewarm = updateImagePrewarmState({ nextTier: 1024, now: 10 });
assert(prewarm.tier === 1024 && !prewarm.ready, 'a new predictive tier waits before decoding');
prewarm = updateImagePrewarmState({
  previousTier: prewarm.tier,
  previousSince: prewarm.since,
  nextTier: 1024,
  now: 10 + IMAGE_NAV_PREWARM_DELAY_MS - 1,
});
assert(!prewarm.ready, 'predictive decode does not start before the quiet window');
prewarm = updateImagePrewarmState({
  previousTier: prewarm.tier,
  previousSince: prewarm.since,
  nextTier: 1024,
  now: 10 + IMAGE_NAV_PREWARM_DELAY_MS,
});
assert(prewarm.ready, 'a stable rapid-zoom target is prewarmed after the quiet window');
const redirected = updateImagePrewarmState({
  previousTier: prewarm.tier,
  previousSince: prewarm.since,
  nextTier: 2048,
  now: 100,
});
assert(!redirected.ready && redirected.since === 100, 'changing zoom direction resets obsolete prewarm work');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert(html.includes('const IMAGE_STABLE_PROXY_MAX_DIM = IMAGE_PROXY_TIER;'), 'stable proxy size cap is present');
assert(html.includes('await ensureStableImageProxy(im, blob);'), 'image intake builds the stable proxy before completing');
assert(html.includes('await ensureStableImageProxy(image, blob);'), 'session restore builds stable proxies while opening');
assert(html.includes('if (!surface && im.proxy)'), 'renderer falls back to a stable proxy');
const fullFallback = html.indexOf('if (!surface && im.bitmap)');
const proxyFallback = html.indexOf('if (!surface && im.proxy)');
assert(fullFallback >= 0 && proxyFallback > fullFallback, 'full-resolution export/render paths remain ahead of proxy fallback');
assert(!html.includes('highQualityDemandAllowed'),
  'pixel budgets gate decoding only: a resident surface is never passed over for the 256px proxy');
assert(html.includes('if (!im.bitmap && allowedImageFullDemand.has(imageFullDemandKey(it.imgId)))'),
  'full-resolution decodes stay budget-admitted even though drawing them does not');
assert(html.includes('im.historyRestoring'), 'history restoration may temporarily prefer its restored full bitmap');
assert(html.includes('im?.pixelUpdateInProgress'), 'drawing publication temporarily blocks stale derived surfaces');
assert(html.includes('if (opts.noLod) requestImageDecode(im, it);'), 'noLod export paths always drive a full-resolution decode');
assert(html.includes('{ previous: allowedImageDemand }'), 'admissions carry across frames');
assert(html.includes('[...floorCandidates, ...lodCandidates, ...fullCandidates]'),
  'full bitmaps and LOD tiers are rationed from one pool, so a small original is priced as the cheap surface it is');
assert(html.includes("if (key.startsWith('full:')) allowedImageFullDemand.add(key);"),
  'the combined admission set still splits per pool for its callers');
assert(html.includes('const IMAGE_DECODE_MIN_POOL_PIXELS = 8_000_000;'),
  'the old fixed budget survives only as a per-pool floor');
assert(html.includes('function imageMemoryBudgetPixels()'), 'the decoded-image budget follows a setting');
assert(html.includes("imageMemoryMB: 'auto',"), 'decoded-image memory is a user setting');
assert(html.includes("set('imageMemoryMB', normalizeImageMemory(e.target.value))"),
  'the decoded-image memory setting is wired to the settings pane');
assert(html.includes('const WHEEL_FOCUS_PRIORITY_MS = 1200;'),
  'pointer focus outranks other demand for a gesture, not for seconds afterwards');

// Floor tier: the fallback below an admitted surface must never be the proxy.
assert(html.includes('const floorTier = target === IMAGE_PROXY_TIER ? null : imageFloorTierFor(im);'),
  'every visible image above proxy size declares floor demand');
assert(html.includes('distance: distance - IMAGE_FLOOR_DEMAND_PRIORITY,'),
  'floor demand outranks pointer focus and selection');
assert(html.includes('const IMAGE_FLOOR_DEMAND_PRIORITY = 3e15;'),
  'floor priority stays above the 2e15 wheel-focus bonus');
assert(html.includes('requestFloor();'), 'a missing target surface warms the floor instead of settling for the proxy');
assert(html.includes('imageFloorDemand.has(key)'), 'floor jobs survive while their image is visible');
assert(html.includes('if (imageLodSurfaceProtected(im.id, bucket)) continue;'),
  'eviction honours the floor and the multi-frame grace window');
assert(html.includes('const IMAGE_LOD_PROTECT_FRAMES = 3;'),
  'a surface that misses one frame is not reclaimed before the next');
assert(html.includes('beginImageLodFrame();'), 'each frame rotates the protection window instead of clearing it');

// Sharpening order must follow the viewport, not enqueue order.
assert(html.includes('function imageLodJobRank(job)'), 'queued LOD work is ranked by live importance');
assert(html.includes('function dropWorstQueuedImageLodJob()'),
  'queue overflow drops the least important request, not the oldest');
assert(html.includes('const job = extractQueuedImageLodJob(false);'),
  'the pump starts the most important queued job');
assert(!html.includes('imageLodQueue.shift()'), 'strict FIFO LOD scheduling must not return');
assert(html.includes('updateImageRenderDemandPlan(drawVisibleItems);'), 'each frame has a bounded high-quality demand plan');
assert(html.includes('previousTier: imageDisplayTargets.get(it.id)'), 'screen-sized targets retain hysteresis state per item');
assert(html.includes('const navigating = isNavigatingView();'), 'quality changes pause during navigation');
assert(html.includes('imagePrewarmTargets.get(it.id) === job.bucket'), 'predictive LOD jobs survive only while still desired');
assert(html.includes("imagePrewarmTargets.get(it.id) === IMAGE_FULL_TIER"), 'predictive full decodes remain visibility gated');
assert(html.includes('shouldPromoteReadyImageTier({'), 'ready sharper surfaces can become visible during navigation');
assert(html.includes('wheelFocusImageId = imageItemAt(cx, cy)?.id || null;'), 'wheel demand follows the image under the pointer');
assert(html.includes('const wheelFocused = it?.id === wheelFocusImageId'), 'wheel-focused images outrank viewport-centre demand');
assert(html.includes('wheelFocusPriorityUntil = 0;'), 'a new pointer interaction releases stale wheel-focus priority');
assert(html.includes('applyRenderSmoothing(ctx);'), 'board smoothing stays at the configured quality during navigation');
assert(!html.includes("navigatingFrame\n    ? 'low'"), 'wheel frames never force a blurry low-quality smoothing mode');
assert(!html.includes('imageSurfaceTransitions'), 'resolution swaps stay instant; the flickering focus-blur transition must not return');
assert(!html.includes('blurPx'), 'board image draws never animate through a canvas blur filter');
assert(html.includes('protectImageSurface(surface, it);'), 'the drawn surface is still protected from same-frame eviction');
assert(html.includes('if (!visibleImageIds.has(itemId)) imagePrewarmTargets.delete(itemId);'), 'offscreen prewarm targets are released');
assert(html.includes('if (!liveImageIds.has(itemId)) map.delete(itemId);'), 'deleted images cannot retain render state');
assert(html.includes('activeImageLodDemand.add'), 'the currently drawn surface is protected during atomic replacement');
assert(html.includes('evictImageLods(im, bucket);'), 'one admitted oversized LOD is protected from immediate self-eviction');
assert(html.includes('try { im.proxy?.close?.(); }'), 'stable proxies close when a board is released');
assert(packageJson.build.files.includes('scripts/image-render-demand.mjs'), 'packaged builds include the demand policy module');

console.log('image render stability tests passed');
