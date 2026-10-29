# Writes cases/<id>/image.png + mask.png (white = fill) from cases.json, and a
# review sheet with each mask tinted red over its image.
#   python -I build-cases.py <poolDir> <casesDir> <cases.json>
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

pool, cases_dir, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]
items = json.load(open(os.path.join(pool, 'manifest.json'), encoding='utf-8'))
spec = json.load(open(spec_path, encoding='utf-8'))
font = ImageFont.truetype('arialbd.ttf', 20)
TW = 480
tiles = []
for c in spec:
    src = items[c['pool']]
    im = Image.open(os.path.join(pool, src['file'])).convert('RGB')
    W, H = im.size
    mask = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(mask)
    for s in c['shapes']:
        if 'poly' in s:
            d.polygon([(x * W / 100, y * H / 100) for x, y in s['poly']], fill=255)
        else:
            cx, cy, rx, ry = s['ellipse']
            d.ellipse([(cx - rx) * W / 100, (cy - ry) * H / 100, (cx + rx) * W / 100, (cy + ry) * H / 100], fill=255)
    out = os.path.join(cases_dir, c['id'])
    os.makedirs(out, exist_ok=True)
    im.save(os.path.join(out, 'image.png'))
    mask.save(os.path.join(out, 'mask.png'))
    area = sum(1 for v in mask.getdata() if v) / (W * H)
    meta = dict(c, w=W, h=H, holeFraction=round(area, 4), source=src)
    json.dump(meta, open(os.path.join(out, 'case.json'), 'w', encoding='utf-8'), indent=2)
    # review tile
    s = TW / W
    t = im.resize((TW, round(H * s)), Image.LANCZOS)
    m = mask.resize(t.size, Image.NEAREST)
    red = Image.new('RGB', t.size, (255, 0, 60))
    t = Image.composite(Image.blend(t, red, 0.45), t, m)
    td = ImageDraw.Draw(t)
    td.text((6, 4), f"{c['id']}  {round(area * 100)}%", fill=(255, 255, 0), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
    tiles.append(t)
    print(c['id'], W, H, f'hole {area:.1%}')
COLS = 4
rowh = []
for r in range(0, len(tiles), COLS):
    rowh.append(max(t.height for t in tiles[r:r + COLS]))
sheet = Image.new('RGB', (COLS * (TW + 8), sum(rowh) + 8 * len(rowh)), (25, 25, 25))
y = 0
for ri, r in enumerate(range(0, len(tiles), COLS)):
    for k, t in enumerate(tiles[r:r + COLS]):
        sheet.paste(t, (k * (TW + 8), y))
    y += rowh[ri] + 8
sheet.save(os.path.join(cases_dir, 'masks-review.png'))
