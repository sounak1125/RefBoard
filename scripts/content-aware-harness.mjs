/* Shared test harness for the content-aware fill engine.
 *
 * Loads the engine's modules into a vm context exactly as the worker's
 * importScripts() would, so the tests exercise the shipped sources rather than a
 * copy. The load order is parsed out of fill-worker.js so the two cannot drift.
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const DIR = new URL('./content-aware/', import.meta.url);

export async function moduleOrder() {
  const worker = await readFile(new URL('fill-worker.js', DIR), 'utf8');
  const call = worker.match(/importScripts\(([\s\S]*?)\);/);
  if (!call) throw new Error('fill-worker.js no longer calls importScripts');
  const names = [...call[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  if (!names.length) throw new Error('no modules listed in importScripts');
  return names;
}

export async function loadEngine() {
  const names = await moduleOrder();
  const sandbox = {
    console,
    Math,
    Date,
    Number,
    Set,
    Map,
    Error,
    Infinity,
    NaN,
    JSON,
    String,
    Array,
    Object,
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of names) {
    const source = await readFile(new URL(name, DIR), 'utf8');
    try {
      vm.runInContext(source, sandbox, { filename: `content-aware/${name}` });
    } catch (err) {
      throw new Error(`loading ${name}: ${err.message}`);
    }
  }
  if (!sandbox.CAF || typeof sandbox.CAF.fill !== 'function') {
    throw new Error('engine did not expose CAF.fill');
  }
  return sandbox.CAF;
}

/* ------------------------------------------------------------------ *
 * Synthetic scenes.
 *
 * Everything is generated procedurally from a seeded PRNG so the tests need no
 * image fixtures and reproduce byte for byte on any machine.
 * ------------------------------------------------------------------ */

export function makeRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blankImage(width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { data, width, height };
}

/* Value noise, smoothed, in 0..1. Used for grass, clouds and wall texture. */
export function valueNoise(width, height, cell, seed) {
  const rnd = makeRandom(seed);
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const out = new Float32Array(width * height);
  const smooth = t => t * t * (3 - 2 * t);
  for (let y = 0; y < height; y++) {
    const gy = y / cell;
    const y0 = gy | 0;
    const fy = smooth(gy - y0);
    for (let x = 0; x < width; x++) {
      const gx = x / cell;
      const x0 = gx | 0;
      const fx = smooth(gx - x0);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * width + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

export function fractalNoise(width, height, octaves, baseCell, seed) {
  const out = new Float32Array(width * height);
  let amp = 1, total = 0, cell = baseCell;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(width, height, Math.max(2, cell), seed + o * 977);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
    cell = Math.max(2, cell >> 1);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export function setPixel(img, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const p = (y * img.width + x) * 4;
  img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = a;
}

export function getPixel(img, x, y) {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
}

export function rectMask(width, height, x0, y0, w, h) {
  const mask = new Uint8Array(width * height);
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= width) continue;
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function ellipseMask(width, height, cx, cy, rx, ry) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/* A thin diagonal scratch, for the Telea classification path. */
export function scratchMask(width, height, x0, y0, x1, y1, thickness) {
  const mask = new Uint8Array(width * height);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  const r = Math.max(0, (thickness - 1) / 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy > r * r + 0.25) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/* --- scenes ------------------------------------------------------- */

export function skyScene(width, height, seed = 11) {
  const img = blankImage(width, height);
  const clouds = fractalNoise(width, height, 4, 48, seed);
  for (let y = 0; y < height; y++) {
    const t = y / height;
    for (let x = 0; x < width; x++) {
      const c = Math.max(0, clouds[y * width + x] - 0.45) * 2.4;
      const r = 96 + t * 78 + c * 130;
      const g = 140 + t * 66 + c * 110;
      const b = 205 + t * 34 + c * 48;
      setPixel(img, x, y, r, g, b);
    }
  }
  return img;
}

export function grassScene(width, height, seed = 23) {
  const img = blankImage(width, height);
  const coarse = fractalNoise(width, height, 3, 40, seed);
  const rnd = makeRandom(seed + 5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = coarse[y * width + x];
      // Per-pixel jitter gives the high-frequency grain a blur would destroy.
      const blade = rnd() * 0.34;
      const g = 92 + base * 84 + blade * 70;
      setPixel(img, x, y, 34 + base * 40 + blade * 34, g, 30 + base * 30 + blade * 22);
    }
  }
  return img;
}

export function wallScene(width, height, seed = 31) {
  const img = blankImage(width, height);
  const grain = fractalNoise(width, height, 3, 18, seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = grain[y * width + x];
      const v = 176 + n * 26;
      // A gentle vignette, so a fill from the wrong side shows as a tone shift.
      const fall = 1 - 0.13 * (x / width);
      setPixel(img, x, y, v * fall, (v - 8) * fall, (v - 22) * fall);
    }
  }
  return img;
}

export function horizonScene(width, height, seed = 47) {
  const img = blankImage(width, height);
  const horizon = Math.round(height * 0.42);
  const sky = fractalNoise(width, height, 3, 56, seed);
  const ground = fractalNoise(width, height, 4, 22, seed + 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (y < horizon) {
        const c = Math.max(0, sky[i] - 0.5) * 2;
        setPixel(img, x, y, 118 + c * 110, 158 + c * 88, 208 + c * 40);
      } else {
        const n = ground[i];
        setPixel(img, x, y, 96 + n * 54, 74 + n * 44, 48 + n * 34);
      }
    }
  }
  img.horizon = horizon;
  return img;
}

export function architectureScene(width, height, seed = 59) {
  const img = blankImage(width, height);
  const grain = fractalNoise(width, height, 2, 14, seed);
  const columnEvery = Math.round(width / 7);
  const floorEvery = Math.round(height / 5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = grain[y * width + x];
      let v = 168 + n * 20;
      // Regular mortar lines: straight structure the fill has to continue.
      if (x % columnEvery < 3) v -= 62;
      if (y % floorEvery < 3) v -= 48;
      setPixel(img, x, y, v, v * 0.96, v * 0.9);
    }
  }
  img.columnEvery = columnEvery;
  img.floorEvery = floorEvery;
  return img;
}

/* --- measurement -------------------------------------------------- */

export function luma(data, p) {
  return data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
}

/* Mean absolute luma gradient over a mask — how much texture is present. A
 * blurred fill collapses this number, which is the whole point of measuring it. */
export function textureEnergy(data, width, height, mask) {
  let sum = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask && !mask[i]) continue;
      const p = i * 4;
      sum += Math.abs(luma(data, p) - luma(data, p + 4))
        + Math.abs(luma(data, p) - luma(data, p + width * 4));
      n += 2;
    }
  }
  return n ? sum / n : 0;
}

export function meanColor(data, width, height, mask) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask && !mask[i]) continue;
    r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/* Root mean squared error over a mask, against a reference image. */
export function rmse(a, b, width, height, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask && !mask[i]) continue;
    for (let c = 0; c < 3; c++) {
      const d = a[i * 4 + c] - b[i * 4 + c];
      sum += d * d;
    }
    n += 3;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/* FNV-1a over every pixel the mask does not cover. §38's Test 8 compares this
 * before and after a fill. */
export function hashOutside(data, width, height, mask) {
  let h = 0x811c9dc5;
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) continue;
    for (let c = 0; c < 4; c++) {
      h ^= data[i * 4 + c];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

export function countMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}
