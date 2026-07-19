/**
 * Dev-only live performance overlay (FPS + heap + frame time + counts).
 *
 * Default OFF. Near-zero cost when disabled (no rAF / no DOM).
 * Packaged (production) builds refuse to enable — the overlay cannot appear
 * in a normal installed build even if a flag is set.
 *
 * Enable (development / unpackaged only):
 *   - URL query:  ?perf=1   or hash: #perf
 *   - Console:    window.__PERF_OVERLAY__ = true
 *   - Keyboard:   Ctrl+Shift+F12  (toggle)
 *
 * Disable:
 *   - Ctrl+Shift+F12 again
 *   - window.__PERF_OVERLAY__ = false
 */

const SAMPLE_FRAMES = 30;
const UI_HZ_MS = 500;

let packaged = false;
let enabled = false;
let rafId = 0;
let uiTimer = 0;
let el = null;
let lastTs = 0;
const deltas = [];
const drawMs = [];
let getCounts = () => ({ items: 0, view: 'board' });

export function isPerfOverlayEnabled() {
  return enabled;
}

/** Record a completed paint duration (ms). No-op when disabled. */
export function noteDrawMs(ms) {
  if (!enabled || !(ms >= 0)) return;
  drawMs.push(ms);
  if (drawMs.length > SAMPLE_FRAMES) drawMs.shift();
}

/**
 * @param {{ isPackaged?: boolean, getCounts?: () => object }} opts
 */
export function initPerfOverlay(opts = {}) {
  packaged = !!opts.isPackaged;
  if (typeof opts.getCounts === 'function') getCounts = opts.getCounts;

  const prior = window.__PERF_OVERLAY__;
  Object.defineProperty(window, '__PERF_OVERLAY__', {
    configurable: true,
    enumerable: false,
    get: () => enabled,
    set: (v) => { if (v) enable(); else disable(); },
  });

  window.addEventListener('keydown', onKeyDown, true);

  if (!packaged && (prior === true || shouldStartFromLocation())) enable();
}

export function setPerfOverlayPackaged(isPackaged) {
  packaged = !!isPackaged;
  if (packaged && enabled) disable();
}

function shouldStartFromLocation() {
  try {
    const q = new URLSearchParams(location.search || '');
    if (q.get('perf') === '1' || q.get('perf') === 'true') return true;
    const hash = (location.hash || '').replace(/^#/, '');
    if (hash === 'perf' || hash === 'perf=1') return true;
  } catch { /* ignore */ }
  return false;
}

function onKeyDown(e) {
  if (!(e.ctrlKey && e.shiftKey && (e.key === 'F12' || e.code === 'F12'))) return;
  e.preventDefault();
  e.stopPropagation();
  if (enabled) disable();
  else enable();
}

function enable() {
  if (packaged) {
    console.info('[perf-overlay] inert in packaged builds');
    return;
  }
  if (enabled) return;
  enabled = true;
  lastTs = 0;
  deltas.length = 0;
  drawMs.length = 0;
  ensureEl();
  rafId = requestAnimationFrame(sampleLoop);
  uiTimer = setInterval(updateUi, UI_HZ_MS);
  updateUi();
  console.info('[perf-overlay] on — Ctrl+Shift+F12 to toggle');
}

function disable() {
  if (!enabled) return;
  enabled = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = 0;
  lastTs = 0;
  deltas.length = 0;
  drawMs.length = 0;
  if (el) {
    el.remove();
    el = null;
  }
  console.info('[perf-overlay] off');
}

function sampleLoop(ts) {
  if (!enabled) return;
  if (lastTs > 0) {
    deltas.push(ts - lastTs);
    if (deltas.length > SAMPLE_FRAMES) deltas.shift();
  }
  lastTs = ts;
  rafId = requestAnimationFrame(sampleLoop);
}

function avg(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function worst(arr) {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
}

function ensureEl() {
  if (el) return;
  el = document.createElement('div');
  el.id = 'refboard-perf-overlay';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '99999',
    pointerEvents: 'none',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    lineHeight: '1.45',
    color: '#e8e8e8',
    background: 'rgba(0,0,0,.72)',
    padding: '8px 10px',
    borderRadius: '4px',
    whiteSpace: 'pre',
    userSelect: 'none',
  });
  document.documentElement.appendChild(el);
}

function updateUi() {
  if (!enabled || !el) return;
  const avgDelta = avg(deltas);
  const fps = avgDelta > 0 ? 1000 / avgDelta : 0;
  const ftAvg = avg(drawMs);
  const ftWorst = worst(drawMs);
  let heap = 'n/a';
  try {
    const mem = performance.memory;
    if (mem && typeof mem.usedJSHeapSize === 'number') {
      heap = (mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) + ' MB';
    }
  } catch { /* Chromium-only */ }

  let counts = { items: 0, view: 'board' };
  try { counts = getCounts() || counts; } catch { /* ignore */ }
  const view = counts.view || 'board';
  let countLine = `items ${counts.items ?? 0}`;
  if (view === 'animatics') {
    countLine += `  |  clips ${counts.clips ?? 0}  texts ${counts.texts ?? 0}  audio ${counts.audio ?? 0}`;
  }

  el.textContent =
    `RefBoard perf  [${view}]\n` +
    `FPS   ${fps.toFixed(1)}\n` +
    `frame ${ftAvg.toFixed(2)} ms avg  ${ftWorst.toFixed(2)} ms worst\n` +
    `heap  ${heap}\n` +
    countLine;
}
