'use strict';
/* One snip overlay per display. main.js captures the screens first and hands
   this page its display's frozen frame; the page draws it, reports ready (the
   window is shown only then, so there is no blank flash), and sends back the
   press and release points in display DIP. main.js does the crop itself, from
   the lossless capture, with the same geometry module. */

const api = window.SnipAPI;
const geometry = window.SnipGeometry;
const canvas = document.getElementById('frame');
const sel = document.getElementById('sel');
const sizeEl = document.getElementById('size');
const hint = document.getElementById('hint');
const hintTarget = document.getElementById('hintTarget');

let info = null;
let start = null;
let pointerId = null;
let done = false;

function point(e) {
  return { x: e.clientX, y: e.clientY };
}

/* The capture is BGRA. A VideoFrame takes it as is and draws on the GPU; the
   ImageData path swaps the channels on the CPU and is only a fallback. */
function drawFrame(frame) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const bytes = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
  if (typeof VideoFrame === 'function') {
    try {
      const vf = new VideoFrame(bytes, {
        format: 'BGRA', codedWidth: frame.width, codedHeight: frame.height, timestamp: 0,
      });
      ctx.drawImage(vf, 0, 0);
      vf.close();
      return;
    } catch { /* fall through to the CPU path */ }
  }
  const rgba = new Uint8ClampedArray(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    rgba[i] = bytes[i + 2];
    rgba[i + 1] = bytes[i + 1];
    rgba[i + 2] = bytes[i];
    rgba[i + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
}

function showSelection(end) {
  const rect = geometry.dragRect(start, end, info.bounds.width, info.bounds.height);
  sel.style.left = `${rect.x}px`;
  sel.style.top = `${rect.y}px`;
  sel.style.width = `${rect.width}px`;
  sel.style.height = `${rect.height}px`;
  const crop = geometry.cropForDrag({ start, end, bounds: info.bounds, imageSize: info.frame });
  sizeEl.textContent = geometry.sizeLabel(crop);
  // Under the box's bottom-right corner, or inside it when that is off-screen.
  const labelW = sizeEl.offsetWidth || 80;
  const labelH = sizeEl.offsetHeight || 22;
  const left = Math.max(4, Math.min(rect.x + rect.width - labelW, info.bounds.width - labelW - 4));
  let top = rect.y + rect.height + 6;
  if (top + labelH > info.bounds.height - 4) top = Math.max(4, rect.y + rect.height - labelH - 6);
  sizeEl.style.left = `${left}px`;
  sizeEl.style.top = `${top}px`;
}

function cancel() {
  if (done) return;
  done = true;
  api.cancel();
}

window.addEventListener('pointerdown', e => {
  if (done || !info || e.button !== 0) return;
  start = point(e);
  pointerId = e.pointerId;
  try { document.body.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
});

window.addEventListener('pointermove', e => {
  if (done || !start || e.pointerId !== pointerId) return;
  const end = point(e);
  if (!document.body.classList.contains('selecting') && geometry.isClick(start, end)) return;
  document.body.classList.add('selecting');
  showSelection(end);
});

window.addEventListener('pointerup', e => {
  if (done || !start || e.pointerId !== pointerId) return;
  done = true;
  const end = point(e);
  api.finish({ start, end });
});

window.addEventListener('pointercancel', () => {
  start = null;
  pointerId = null;
  document.body.classList.remove('selecting');
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
});

window.addEventListener('contextmenu', e => e.preventDefault());

(async () => {
  try {
    info = await api.init();
  } catch {
    info = null;
  }
  if (!info?.frame) {
    cancel();
    return;
  }
  drawFrame(info.frame);
  info.frame = { width: info.frame.width, height: info.frame.height };
  if (info.hint) {
    hintTarget.textContent = info.hint.target ? `→ ${info.hint.target}` : '';
    hint.classList.add('show');
  }
  // Two frames: the canvas has to reach the screen before the window shows.
  // A hidden window may not run animation frames at all, hence the timer.
  await new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 50);
  });
  api.ready();
})();
