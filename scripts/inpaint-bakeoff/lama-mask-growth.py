# Does a wider mask fix LaMa's ghosting? Runs LaMa on one case with the drawn
# mask grown by each given amount and saves a strip of zoomed results.
#   python -I lama-mask-growth.py <caseDir> <lama.onnx> <out.png> <px> [px ...]
import sys
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFilter, ImageFont

case_dir, model, out_png = sys.argv[1:4]
amounts = [int(a) for a in sys.argv[4:]]
sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
img = np.asarray(Image.open(f'{case_dir}/image.png').convert('RGB'))
drawn = Image.open(f'{case_dir}/mask.png').convert('L')
MARGIN, SIDE = 196, 512

def grow(a0, a1, target, limit):
    a0 = max(0, a0 - (target - (a1 - a0)) // 2)
    a1 = min(limit, a0 + target)
    return max(0, a1 - target), a1

def lama(img, hole):
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
    y = sess.run(None, {'image': (ci.astype(np.float32) / 255.0).transpose(2, 0, 1)[None],
                        'mask': mi.astype(np.float32)[None, None]})[0][0].transpose(1, 2, 0)
    if y.max() <= 1.5:
        y = y * 255.0
    pred = np.clip(y, 0, 255).astype(np.uint8)
    if sq != SIDE:
        pred = np.asarray(Image.fromarray(pred).resize((sq, sq), Image.BICUBIC))
    out = img.copy()
    out[y0:y1, x0:x1][cm] = pred[:ch, :cw][cm]
    return out

m0 = np.asarray(drawn) > 127
ys, xs = np.nonzero(m0)
pad = int(0.18 * max(np.ptp(xs), np.ptp(ys))) + 24
box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(img.shape[1], xs.max() + pad), min(img.shape[0], ys.max() + pad))
font = ImageFont.truetype('arialbd.ttf', 22)
tiles = []
for px in amounts:
    hole = np.asarray(drawn.filter(ImageFilter.MaxFilter(2 * px + 1))) > 127 if px else m0
    t = Image.fromarray(lama(img, hole)).crop(box)
    t = t.resize((420, round(420 * t.height / t.width)), Image.LANCZOS)
    ImageDraw.Draw(t).text((8, 6), f'grown {px}px', fill=(255, 255, 0), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
    tiles.append(t)
strip = Image.new('RGB', (len(tiles) * 426, tiles[0].height), (20, 20, 20))
for k, t in enumerate(tiles):
    strip.paste(t, (k * 426, 0))
strip.save(out_png)
print('saved', out_png)
