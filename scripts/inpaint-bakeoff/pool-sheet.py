# Numbered thumbnail sheet(s) of the pool so cases can be picked by eye.
#   python -I pool-sheet.py <poolDir> <outPrefix>
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

pool, prefix = sys.argv[1], sys.argv[2]
items = json.load(open(os.path.join(pool, 'manifest.json'), encoding='utf-8'))
T, COLS, PER = 220, 6, 30
font = ImageFont.truetype('arial.ttf', 18)
for page in range(0, len(items), PER):
    chunk = items[page:page + PER]
    rows = (len(chunk) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * T, rows * T), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for k, it in enumerate(chunk):
        im = Image.open(os.path.join(pool, it['file'])).convert('RGB')
        im.thumbnail((T - 6, T - 6))
        x, y = (k % COLS) * T + 3, (k // COLS) * T + 3
        sheet.paste(im, (x, y))
        label = f"{page + k} {it['w']}x{it['h']}"
        d.rectangle([x, y, x + 150, y + 22], fill=(0, 0, 0))
        d.text((x + 3, y + 1), label, fill=(255, 255, 0), font=font)
    sheet.save(f'{prefix}-{page // PER}.png')
print('pages', (len(items) + PER - 1) // PER)
