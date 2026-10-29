# Gridded previews (percent coordinates) for drawing lasso masks by eye.
#   python -I grid-preview.py <poolDir> <out.png> <idx> [idx ...]
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

pool, out, idxs = sys.argv[1], sys.argv[2], [int(a) for a in sys.argv[3:]]
items = json.load(open(os.path.join(pool, 'manifest.json'), encoding='utf-8'))
W = 760
font = ImageFont.truetype('arial.ttf', 14)
big = ImageFont.truetype('arialbd.ttf', 22)
tiles = []
for i in idxs:
    im = Image.open(os.path.join(pool, items[i]['file'])).convert('RGB')
    s = W / im.width
    im = im.resize((W, round(im.height * s)), Image.LANCZOS)
    d = ImageDraw.Draw(im, 'RGBA')
    for p in range(5, 100, 5):
        x, y = im.width * p / 100, im.height * p / 100
        a = 150 if p % 10 == 0 else 60
        d.line([(x, 0), (x, im.height)], fill=(0, 255, 255, a), width=1)
        d.line([(0, y), (im.width, y)], fill=(0, 255, 255, a), width=1)
        if p % 10 == 0:
            d.text((x + 2, 2), str(p), fill=(255, 255, 0, 255), font=font, stroke_width=2, stroke_fill=(0, 0, 0))
            d.text((2, y + 2), str(p), fill=(255, 255, 0, 255), font=font, stroke_width=2, stroke_fill=(0, 0, 0))
    d.text((W - 60, im.height - 32), f'#{i}', fill=(255, 80, 80, 255), font=big, stroke_width=3, stroke_fill=(0, 0, 0))
    tiles.append(im)
cols = 2
rows = (len(tiles) + 1) // 2
colh = [0] * rows
for k, t in enumerate(tiles):
    colh[k // 2] = max(colh[k // 2], t.height)
sheet = Image.new('RGB', (cols * W + 10, sum(colh) + 10 * rows), (30, 30, 30))
y = 0
for r in range(rows):
    for c in range(cols):
        k = r * 2 + c
        if k < len(tiles):
            sheet.paste(tiles[k], (c * (W + 10), y))
    y += colh[r] + 10
sheet.save(out)
