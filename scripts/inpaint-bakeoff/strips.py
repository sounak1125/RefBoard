# Stacked zoom-only rows (hole region) for a set of cases and engines.
#   python -I strips.py <casesDir> <outDir> <out.png> <engines,comma> <panelW> <caseSubstr> [...]
# An engine may be written key@dir=Label to read <dir>/<case>/<key>.png instead.
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

cases_dir, out_dir, out_png, engines, pw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(','), int(sys.argv[5])
wanted = sys.argv[6:]
F = ImageFont.truetype('arialbd.ttf', 18)
rows = []
for cid in sorted(os.listdir(cases_dir)):
    if not any(w in cid for w in wanted):
        continue
    cdir = os.path.join(cases_dir, cid)
    orig = Image.open(os.path.join(cdir, 'image.png')).convert('RGB')
    m = np.asarray(Image.open(os.path.join(cdir, 'mask.png')).convert('L')) > 127
    ys, xs = np.nonzero(m)
    pad = int(0.18 * max(np.ptp(xs), np.ptp(ys))) + 24
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(orig.width, xs.max() + pad), min(orig.height, ys.max() + pad))
    mi = Image.fromarray(m.astype(np.uint8) * 255)
    edge = np.asarray(mi.filter(ImageFilter.MaxFilter(5))) != np.asarray(mi.filter(ImageFilter.MinFilter(5)))
    oa = np.asarray(orig).copy(); oa[edge] = (255, 40, 40)
    panels = [('original', Image.fromarray(oa))]
    for spec in engines:
        e, d, lab = spec, out_dir, spec
        if '=' in e:
            e, lab = e.split('=', 1)
        if '@' in e:
            e, d = e.split('@', 1)
        if lab == spec:
            lab = e
        p = os.path.join(d, cid, f'{e}.png')
        j = os.path.join(d, cid, f'{e}.json')
        info = json.load(open(j)) if os.path.isfile(j) else {}
        im = Image.open(p).convert('RGB') if os.path.isfile(p) and not info.get('error') else None
        tag = lab if im is not None else f'{lab}: missing'
        if im is not None and info.get('ms') is not None:
            tag += f"  {info['ms'] / 1000:.1f}s" + (f"  says {info['status']}" if info.get('status') else '')
        panels.append((tag, im))
    zh = round(pw * (box[3] - box[1]) / (box[2] - box[0]))
    row = Image.new('RGB', (len(panels) * (pw + 4), zh + 4), (15, 15, 15))
    d = ImageDraw.Draw(row)
    for k, (tag, im) in enumerate(panels):
        if im is not None:
            row.paste(im.crop(box).resize((pw, zh), Image.LANCZOS), (k * (pw + 4), 0))
        d.text((k * (pw + 4) + 6, 4), (cid + '  ' if k == 0 else '') + tag, fill=(255, 255, 0), font=F, stroke_width=3, stroke_fill=(0, 0, 0))
    rows.append(row)
H = sum(r.height for r in rows)
out = Image.new('RGB', (max(r.width for r in rows), H), (15, 15, 15))
y = 0
for r in rows:
    out.paste(r, (0, y)); y += r.height
out.save(out_png)
print(out.size)
