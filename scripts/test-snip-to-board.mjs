/**
 * Snip to board, the pure parts: the DIP-drag-to-pixel-crop geometry (shared
 * by main.js and the overlay), the file name, and the row placement.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { snipRowPosition, SNIP_ROW_GAP } from './snip-placement.mjs';

const require = createRequire(import.meta.url);
const { CLICK_SLOP, isClick, dragRect, captureScale, cropForDrag, sizeLabel } = require('./snip-geometry.js');
const { TITLE_MAX, snipTime, cleanSnipTitle, snipFileName } = require('./snip-name.js');

const crop = (bounds, imageSize, start, end) => {
  const out = cropForDrag({ bounds, imageSize, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] } });
  return out && [out.x, out.y, out.width, out.height, out.full];
};

/* ---------- geometry ---------- */

// The spec's own example: 600x400 DIP on a 150% display is 900x600 pixels.
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [100, 50], [700, 450]), [150, 75, 900, 600, false]);

// 100%: pixels are DIP.
assert.deepEqual(crop({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, [10, 20], [310, 220]), [10, 20, 300, 200, false]);

// 125%, this machine's main display (2752x1152 DIP, captured 3440x1440).
// Fractional pointer positions round per edge: 20.4 * 1.25 = 25.5 -> 26.
assert.deepEqual(crop({ width: 2752, height: 1152 }, { width: 3440, height: 1440 }, [10.4, 20.4], [410.4, 220.4]), [13, 26, 500, 250, false]);
assert.deepEqual(crop({ width: 2752, height: 1152 }, { width: 3440, height: 1440 }, [0, 0], [2752, 1152]), [0, 0, 3440, 1440, false]);

// 175%.
assert.deepEqual(crop({ width: 1600, height: 900 }, { width: 2800, height: 1575 }, [100, 100], [200, 200]), [175, 175, 175, 175, false]);

// A thumbnail that is not scaleFactor x: a 100% 1920x1080 display that came
// back 2560x1440. The scale comes from the image, not from the display.
assert.deepEqual(crop({ width: 1920, height: 1080 }, { width: 2560, height: 1440 }, [0, 0], [300, 300]), [0, 0, 400, 400, false]);
// ...and one slightly under: 1366x768 DIP captured at 1360x765.
assert.deepEqual(crop({ width: 1366, height: 768 }, { width: 1360, height: 765 }, [0, 0], [1366, 768]), [0, 0, 1360, 765, false]);
const odd = captureScale({ width: 1366, height: 768 }, { width: 1360, height: 765 });
assert.ok(odd.x < 1 && odd.y < 1 && odd.x !== odd.y, 'per-axis scale is measured, not assumed');

// Dragging up and to the left gives the same box as down and to the right.
assert.deepEqual(
  crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [700, 450], [100, 50]),
  crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [100, 50], [700, 450]),
);
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [700, 50], [100, 450]), [150, 75, 900, 600, false]);

// Clamped at the display's edges: a drag that runs off the right and bottom,
// and one that starts beyond the top-left.
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [900, 700], [1200, 1000]), [1350, 1050, 150, 150, false]);
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [-50, -50], [100, 100]), [0, 0, 150, 150, false]);
assert.deepEqual(dragRect({ x: -5, y: 900 }, { x: 1200, y: -3 }, 1000, 800), { x: 0, y: 0, width: 1000, height: 800 });

// A click (under CLICK_SLOP DIP either way) takes the whole capture.
assert.equal(CLICK_SLOP, 4);
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [10, 10], [12, 13]), [0, 0, 1500, 1200, true]);
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [500, 500], [500, 500]), [0, 0, 1500, 1200, true]);
assert.equal(isClick({ x: 0, y: 0 }, { x: 3.9, y: -3.9 }), true);
assert.equal(isClick({ x: 0, y: 0 }, { x: 4, y: 0 }), false, 'four DIP is a drag');
assert.equal(isClick({ x: 0, y: 0 }, { x: 0, y: -4 }), false);

// A drag thinner than a pixel still gives one pixel, inside the image, even
// at the far edge.
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [10, 10], [10.2, 200]), [15, 15, 1, 285, false]);
assert.deepEqual(crop({ width: 1000, height: 800 }, { width: 1500, height: 1200 }, [999.9, 0], [1000, 300]), [1499, 0, 1, 450, false]);

// Every result stays inside the image, for every scale this covers.
for (const [scale, iw, ih] of [[1, 1920, 1080], [1.25, 2400, 1350], [1.5, 2880, 1620], [1.75, 3360, 1890], [1.3333, 2560, 1440]]) {
  const bounds = { width: 1920, height: 1080 };
  for (const [sx, sy, ex, ey] of [[-100, -100, 2100, 1300], [1919, 1079, 1925, 1085], [0.3, 0.7, 960.5, 540.5], [1900, 50, 1920.4, 1080]]) {
    const [x, y, w, h] = crop(bounds, { width: iw, height: ih }, [sx, sy], [ex, ey]);
    assert.ok(x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= iw && y + h <= ih, `crop stays inside at ${scale}x: ${[x, y, w, h]}`);
  }
}

// Bad input is not a crash.
assert.equal(cropForDrag({ bounds: { width: 100, height: 100 }, imageSize: { width: 0, height: 0 }, start: { x: 0, y: 0 }, end: { x: 50, y: 50 } }), null);
assert.deepEqual(crop({ width: 100, height: 100 }, { width: 100, height: 100 }, [NaN, 0], [50, 50]).slice(0, 4), [0, 0, 50, 50]);

assert.equal(sizeLabel({ width: 900, height: 600 }), '900 × 600');
assert.equal(sizeLabel(null), '');

/* ---------- name ---------- */

const at = new Date(2026, 9, 31, 14, 3);
assert.equal(snipFileName('waterfall.mp4 - VLC media player', at), 'Snip – waterfall.mp4 - VLC media player – 14.03.png');
assert.equal(snipFileName('', at), 'Snip – 14.03.png');
assert.equal(snipFileName(null, at), 'Snip – 14.03.png');
assert.equal(snipTime(new Date(2026, 0, 1, 9, 5)), '09.05');

// Characters Windows refuses in a name, and control characters, become spaces.
assert.equal(cleanSnipTitle('C:\\clips\\a<b>|"c"?*.mp4'), 'C clips a b c .mp4');
assert.equal(cleanSnipTitle('line one\nline\ttwo\u0000'), 'line one line two');
assert.equal(snipFileName('???', at), 'Snip – 14.03.png', 'a title of nothing but illegal characters falls back');
// Windows drops trailing dots and spaces.
assert.equal(cleanSnipTitle('Untitled...  '), 'Untitled');

// Long titles are capped, by code point, with an ellipsis.
const long = cleanSnipTitle('x'.repeat(300));
assert.equal([...long].length, TITLE_MAX);
assert.ok(long.endsWith('…'));
const emoji = cleanSnipTitle('🎬'.repeat(100));
assert.equal([...emoji].length, TITLE_MAX);
assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), 'no half surrogate pair at the cut');
assert.ok(snipFileName('y'.repeat(500), at).length < 120, 'the whole name stays short');

/* ---------- row placement ---------- */

assert.equal(snipRowPosition(null, { w: 100, h: 50 }), null, 'no previous snip: addImages keeps its centre');
assert.deepEqual(snipRowPosition({ x: 10, y: 20, w: 300, h: 200 }, { w: 100, h: 50 }), { x: 10 + 300 + SNIP_ROW_GAP, y: 20 });
assert.deepEqual(snipRowPosition({ x: -40, y: -5, w: 80, h: 40 }, { w: 500, h: 400 }, 8), { x: 48, y: -5 }, 'top-aligned whatever the heights');
assert.equal(snipRowPosition({ x: NaN, y: 0, w: 1, h: 1 }, { w: 1, h: 1 }), null);

/* ---------- wiring ---------- */

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(main, /globalShortcut\.register\(accelerator, onSnipShortcut\)/, 'the shortcut is registered');
assert.match(main, /loadSnipShortcut\(\);\s*applySnipShortcut\(\);/, 'from the stored setting at startup');
assert.match(main, /app\.on\('will-quit'[\s\S]{0,80}globalShortcut\.unregisterAll\(\)/, 'and released on quit');
assert.match(main, /is in use by another app, so Snip is off/, 'a taken shortcut is reported, not retried');
assert.match(main, /win\.on\('focus', \(\) => \{ lastBoardWindow = win; \}\)/, 'the last-used board window is tracked');
assert.match(main, /snipGeometry\.cropForDrag/, 'main crops with the shared geometry');
assert.match(main, /process\.env\.REFBOARD_SNIP_TEST === '1'/, 'the test hook is gated');
assert.doesNotMatch(main, /source:\s*session\.name|sourceUrl:\s*snip/, 'the window title is a name, never a source link');
assert.match(html, /id="helpSnipKeys"><kbd>Ctrl<\/kbd><kbd>Alt<\/kbd><kbd>S<\/kbd><\/span><span class="d" id="helpSnipDesc">Snip/,'the shortcut is in the ? panel');
assert.match(html, /addImages\(\[file\], null\)/, 'a snip goes through addImages like paste and drop');
assert.match(html, /if \(onLanding\) await openNewBoard\(\)/, 'on Home a snip starts a new board');

console.log('snip to board ok — geometry at 100/125/150/175% and odd thumbnails, names, row placement');
