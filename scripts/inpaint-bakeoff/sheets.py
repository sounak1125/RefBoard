# One comparison sheet per case (full frame row + zoomed hole row) and an
# overview of every case's zoomed hole.
#   python -I sheets.py <casesDir> <outDir> <sheetsDir>
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

cases_dir, out_dir, sheets_dir = sys.argv[1:4]
os.makedirs(sheets_dir, exist_ok=True)
ENGINES = [('old', 'Old engine'), ('lama', 'LaMa'), ('migan', 'MI-GAN'), ('photoshop', 'Photoshop')]
TW = 560
F = ImageFont.truetype('arialbd.ttf', 20)
FS = ImageFont.truetype('arial.ttf', 17)

def outline(img, mask, color=(255, 40, 40)):
    m = Image.fromarray((mask * 255).astype(np.uint8)).resize(img.size, Image.NEAREST)
    edge = np.asarray(m.filter(ImageFilter.MaxFilter(3))) != np.asarray(m.filter(ImageFilter.MinFilter(3)))
    a = np.asarray(img).copy()
    a[edge] = color
    return Image.fromarray(a)

def fit(im, box_w, box_h=None):
    s = box_w / im.width if box_h is None else min(box_w / im.width, box_h / im.height)
    size = (max(1, round(im.width * s)), max(1, round(im.height * s)))
    return im.resize(size, Image.NEAREST if s > 1 else Image.LANCZOS)

def label(tile, title, sub):
    d = ImageDraw.Draw(tile)
    d.rectangle([0, 0, tile.width, 46], fill=(0, 0, 0))
    d.text((8, 2), title, fill=(255, 255, 255), font=F)
    d.text((8, 25), sub, fill=(255, 220, 90), font=FS)
    return tile

def engine_sub(info, mae):
    if info is None:
        return 'pending'
    if info.get('error'):
        return 'ERROR ' + ('timed out' if info.get('timedOut') else info['error'][:40])
    parts = [f"{info['ms'] / 1000:.1f}s"]
    if info.get('status'):
        parts.append(f"engine says {info['status']}")
    if mae is not None:
        parts.append(f'error vs truth {mae:.1f}')
    return '  '.join(parts)

overview = []
for cid in sorted(os.listdir(cases_dir)):
    cdir = os.path.join(cases_dir, cid)
    if not os.path.isfile(os.path.join(cdir, 'case.json')):
        continue
    case = json.load(open(os.path.join(cdir, 'case.json'), encoding='utf-8'))
    orig = Image.open(os.path.join(cdir, 'image.png')).convert('RGB')
    mask = np.asarray(Image.open(os.path.join(cdir, 'mask.png')).convert('L')) > 127
    W, H = orig.size
    ys, xs = np.nonzero(mask)
    bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    pad = int(0.18 * max(bw, bh)) + 24
    zx0, zx1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
    zy0, zy1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
    zoom_box = (zx0, zy0, zx1, zy1)
    oa = np.asarray(orig).astype(np.int16)
    panels = [('Original' + (' (the answer)' if case.get('groundTruth') else ''), orig, f"{W}x{H}, hole {case['holeFraction'] * 100:.0f}%")]
    for key, name in ENGINES:
        p = os.path.join(out_dir, cid, f'{key}.png')
        j = os.path.join(out_dir, cid, f'{key}.json')
        info = json.load(open(j)) if os.path.isfile(j) else None
        im = Image.open(p).convert('RGB') if os.path.isfile(p) and not (info or {}).get('error') else None
        mae = None
        if im is not None and case.get('groundTruth'):
            mae = float(np.abs(np.asarray(im).astype(np.int16) - oa)[mask].mean())
        panels.append((name, im, engine_sub(info, mae)))
    full_h = round(TW * H / W)
    zw, zh = zx1 - zx0, zy1 - zy0
    zoom_h = min(round(TW * zh / zw), 700)
    tiles_full, tiles_zoom = [], []
    for k, (name, im, sub) in enumerate(panels):
        if im is None:
            t = Image.new('RGB', (TW, full_h), (60, 60, 60)); z = Image.new('RGB', (TW, zoom_h), (60, 60, 60))
        else:
            src = outline(im, mask) if k == 0 else im
            t = fit(src, TW)
            zc = src.crop(zoom_box) if k == 0 else im.crop(zoom_box)
            z = Image.new('RGB', (TW, zoom_h), (25, 25, 25))
            zf = fit(zc, TW, zoom_h)
            z.paste(zf, ((TW - zf.width) // 2, (zoom_h - zf.height) // 2))
        canvas_t = Image.new('RGB', (TW, full_h + 46), (25, 25, 25)); canvas_t.paste(t, (0, 46))
        tiles_full.append(label(canvas_t, name, sub))
        tiles_zoom.append(z)
    n = len(panels)
    head = 40
    sheet = Image.new('RGB', (n * (TW + 6), head + full_h + 46 + 6 + zoom_h), (12, 12, 12))
    d = ImageDraw.Draw(sheet)
    d.text((8, 8), f"{cid}  -  {case['note']}  [{case['kind']}]", fill=(255, 255, 255), font=F)
    for k in range(n):
        sheet.paste(tiles_full[k], (k * (TW + 6), head))
        sheet.paste(tiles_zoom[k], (k * (TW + 6), head + full_h + 46 + 6))
    sheet.save(os.path.join(sheets_dir, f'{cid}.png'))
    overview.append((cid, tiles_zoom, [p[2] for p in panels]))
    print('sheet', cid)

# Overview: zoomed hole only, 300 px per panel.
OW = 300
rows = []
for cid, zooms, subs in overview:
    zs = [z.resize((OW, max(1, round(OW * z.height / z.width))), Image.LANCZOS) for z in zooms]
    rh = max(z.height for z in zs)
    row = Image.new('RGB', (len(zs) * (OW + 4) + 4, rh + 26), (12, 12, 12))
    d = ImageDraw.Draw(row)
    d.text((4, 3), cid, fill=(255, 255, 255), font=FS)
    for k, z in enumerate(zs):
        row.paste(z, (4 + k * (OW + 4), 24))
    rows.append(row)
head = Image.new('RGB', (rows[0].width, 30), (12, 12, 12))
d = ImageDraw.Draw(head)
for k, name in enumerate(['Original'] + [e[1] for e in ENGINES]):
    d.text((4 + k * (OW + 4), 5), name, fill=(255, 220, 90), font=F)
total = Image.new('RGB', (rows[0].width, 30 + sum(r.height for r in rows)), (12, 12, 12))
total.paste(head, (0, 0))
y = 30
for r in rows:
    total.paste(r, (0, y)); y += r.height
total.save(os.path.join(sheets_dir, 'overview.png'))
print('overview', total.size)
