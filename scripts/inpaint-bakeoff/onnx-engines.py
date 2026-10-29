# Runs LaMa (Carve's fixed 512x512 export) and MI-GAN (official pipeline
# export) on the cases, CPU only.
#   python -I onnx-engines.py <casesDir> <outDir> <lama_fp32.onnx> <migan.onnx> [caseIdSubstring ...]
# LaMa: square crop around the hole (hole bbox + 196 px margin, grown to at
# least 512 px with real image context, reflect-padded only if the image is
# too small), scaled to 512 only when the crop is bigger, then only the masked
# pixels are pasted back with a hard edge so seams are not hidden.
# MI-GAN: the pipeline does its own crop, resize to 512 and blend.
import json, os, sys, time
import numpy as np
import onnxruntime as ort
from PIL import Image

cases_dir, out_dir, lama_path, migan_path = sys.argv[1:5]
only = sys.argv[5:]
MARGIN, SIDE = 196, 512

t = time.time(); lama = ort.InferenceSession(lama_path, providers=['CPUExecutionProvider']); lama_load = time.time() - t
t = time.time(); migan = ort.InferenceSession(migan_path, providers=['CPUExecutionProvider']); migan_load = time.time() - t
print(f'load lama {lama_load:.1f}s migan {migan_load:.1f}s', flush=True)

def grow(a0, a1, target, limit):
    a0 = max(0, a0 - (target - (a1 - a0)) // 2)
    a1 = min(limit, a0 + target)
    return max(0, a1 - target), a1

def run_lama(img, hole):
    H, W = hole.shape
    ys, xs = np.nonzero(hole)
    bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = max(SIDE, bx1 - bx0 + 2 * MARGIN, by1 - by0 + 2 * MARGIN)
    x0, x1 = grow(bx0, bx1, side, W)
    y0, y1 = grow(by0, by1, side, H)
    crop, cm = img[y0:y1, x0:x1], hole[y0:y1, x0:x1]
    ch, cw = cm.shape
    sq = max(ch, cw)
    ci = np.pad(crop, ((0, sq - ch), (0, sq - cw), (0, 0)), mode='reflect')
    mi = np.pad(cm, ((0, sq - ch), (0, sq - cw)), mode='constant')
    if sq != SIDE:
        ci = np.asarray(Image.fromarray(ci).resize((SIDE, SIDE), Image.BICUBIC))
        mi = np.asarray(Image.fromarray(mi.astype(np.uint8) * 255).resize((SIDE, SIDE), Image.BILINEAR)) > 0
    x = (ci.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    m = mi.astype(np.float32)[None, None]
    y = lama.run(None, {'image': x, 'mask': m})[0][0].transpose(1, 2, 0)
    if y.max() <= 1.5:
        y = y * 255.0
    pred = np.clip(y, 0, 255).astype(np.uint8)
    if sq != SIDE:
        pred = np.asarray(Image.fromarray(pred).resize((sq, sq), Image.BICUBIC))
    pred = pred[:ch, :cw]
    out = img.copy()
    out[y0:y1, x0:x1][cm] = pred[cm]
    return out, dict(crop=[int(cw), int(ch)], scaleTo512=round(SIDE / sq, 3))

def run_migan(img, hole):
    x = img.transpose(2, 0, 1)[None].copy()
    m = np.where(hole, 0, 255).astype(np.uint8)[None, None]
    return migan.run(None, {'image': x, 'mask': m})[0][0].transpose(1, 2, 0), {}

for cid in sorted(os.listdir(cases_dir)):
    cdir = os.path.join(cases_dir, cid)
    if not os.path.isfile(os.path.join(cdir, 'case.json')) or (only and not any(o in cid for o in only)):
        continue
    img = np.asarray(Image.open(os.path.join(cdir, 'image.png')).convert('RGB'))
    mask_file = 'mask-run.png' if os.path.isfile(os.path.join(cdir, 'mask-run.png')) else 'mask.png'
    hole = np.asarray(Image.open(os.path.join(cdir, mask_file)).convert('L')) > 127
    odir = os.path.join(out_dir, cid)
    os.makedirs(odir, exist_ok=True)
    for name, fn, load in (('lama', run_lama, lama_load), ('migan', run_migan, migan_load)):
        try:
            t = time.time()
            out, extra = fn(img, hole)
            ms = round((time.time() - t) * 1000)
            Image.fromarray(out).save(os.path.join(odir, f'{name}.png'))
            info = dict(engine=name, ms=ms, modelLoadMs=round(load * 1000), **extra)
        except Exception as e:
            info = dict(engine=name, error=str(e)[-400:])
        json.dump(info, open(os.path.join(odir, f'{name}.json'), 'w'), indent=2)
        print(cid, json.dumps(info), flush=True)
