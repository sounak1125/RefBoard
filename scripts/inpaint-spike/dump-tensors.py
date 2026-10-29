# Dumps LaMa's exact 512x512 input and the Python CPU output for a few cases,
# so the Electron spike can time the same work and check it gets the same answer.
#   python -I dump-tensors.py <casesDir> <lama.onnx> <outDir> [growFraction] <caseId> [...]
# Preprocessing matches scripts/inpaint-bakeoff/onnx-engines.py, with the drawn
# mask grown by growFraction of the image's long side (0.011 won the bake-off).
import json, os, sys, time
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

cases_dir, model, out_dir = sys.argv[1:4]
try:
    grow_frac = float(sys.argv[4]); ids = sys.argv[5:]
except ValueError:
    grow_frac = 0.011; ids = sys.argv[4:]
MARGIN, SIDE = 196, 512
os.makedirs(out_dir, exist_ok=True)
sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])

def grow(a0, a1, target, limit):
    a0 = max(0, a0 - (target - (a1 - a0)) // 2)
    a1 = min(limit, a0 + target)
    return max(0, a1 - target), a1

for cid in ids:
    cdir = os.path.join(cases_dir, cid)
    img = np.asarray(Image.open(os.path.join(cdir, 'image.png')).convert('RGB'))
    drawn = Image.open(os.path.join(cdir, 'mask.png')).convert('L')
    px = round(grow_frac * max(drawn.size))
    hole = np.asarray(drawn.filter(ImageFilter.MaxFilter(2 * px + 1))) > 127
    H, W = hole.shape
    ys, xs = np.nonzero(hole)
    side = max(SIDE, xs.max() + 1 - xs.min() + 2 * MARGIN, ys.max() + 1 - ys.min() + 2 * MARGIN)
    x0, x1 = grow(xs.min(), xs.max() + 1, side, W)
    y0, y1 = grow(ys.min(), ys.max() + 1, side, H)
    crop, cm = img[y0:y1, x0:x1], hole[y0:y1, x0:x1]
    ch, cw = cm.shape
    sq = max(ch, cw)
    ci = np.pad(crop, ((0, sq - ch), (0, sq - cw), (0, 0)), mode='reflect')
    mi = np.pad(cm, ((0, sq - ch), (0, sq - cw)), mode='constant')
    if sq != SIDE:
        ci = np.asarray(Image.fromarray(ci).resize((SIDE, SIDE), Image.BICUBIC))
        mi = np.asarray(Image.fromarray(mi.astype(np.uint8) * 255).resize((SIDE, SIDE), Image.BILINEAR)) > 0
    x = np.ascontiguousarray((ci.astype(np.float32) / 255.0).transpose(2, 0, 1)[None])
    m = np.ascontiguousarray(mi.astype(np.float32)[None, None])
    sess.run(None, {'image': x, 'mask': m})  # warm-up
    t = time.time()
    y = sess.run(None, {'image': x, 'mask': m})[0]
    ms = round((time.time() - t) * 1000)
    x.tofile(os.path.join(out_dir, f'{cid}.image.f32'))
    m.tofile(os.path.join(out_dir, f'{cid}.mask.f32'))
    y.astype(np.float32).tofile(os.path.join(out_dir, f'{cid}.ref.f32'))
    meta = dict(case=cid, growPx=px, crop=[int(x0), int(y0), int(cw), int(ch)], side=int(sq),
                pythonCpuMs=ms, outMin=float(y.min()), outMax=float(y.max()), ortVersion=ort.__version__)
    json.dump(meta, open(os.path.join(out_dir, f'{cid}.json'), 'w'), indent=2)
    print(json.dumps(meta))
