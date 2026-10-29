# Timing / verdict table across engines, plus ground-truth error where known.
#   python -I summary.py <casesDir> <outDir>
import json, os, sys
import numpy as np
from PIL import Image

cases_dir, out_dir = sys.argv[1:3]
E = ['old', 'lama', 'migan', 'photoshop']
rows, times = [], {e: [] for e in E}
for cid in sorted(os.listdir(cases_dir)):
    cdir = os.path.join(cases_dir, cid)
    if not os.path.isfile(os.path.join(cdir, 'case.json')):
        continue
    case = json.load(open(os.path.join(cdir, 'case.json'), encoding='utf-8'))
    cells = [cid, f"{case['holeFraction'] * 100:.0f}%"]
    gt = None
    if case.get('groundTruth'):
        gt = np.asarray(Image.open(os.path.join(cdir, 'image.png')).convert('RGB')).astype(np.int16)
        m = np.asarray(Image.open(os.path.join(cdir, 'mask.png')).convert('L')) > 127
    for e in E:
        j = os.path.join(out_dir, cid, f'{e}.json')
        if not os.path.isfile(j):
            cells.append('-'); continue
        info = json.load(open(j))
        if info.get('error'):
            cells.append('error'); continue
        times[e].append(info['ms'])
        c = f"{info['ms'] / 1000:.1f}s"
        if info.get('status') and info['status'] != 'OK':
            c += f" {info['status']}"
        if gt is not None:
            r = np.asarray(Image.open(os.path.join(out_dir, cid, f'{e}.png')).convert('RGB')).astype(np.int16)
            c += f" err {np.abs(r - gt)[m].mean():.1f}"
        cells.append(c)
    rows.append(cells)
print('| case | hole | ' + ' | '.join(E) + ' |')
print('|' + '---|' * (len(E) + 2))
for r in rows:
    print('| ' + ' | '.join(r) + ' |')
print()
for e in E:
    t = np.array(times[e]) / 1000
    if len(t):
        print(f'{e:10} n={len(t):2}  median {np.median(t):6.1f}s  max {t.max():6.1f}s  total {t.sum():7.1f}s')
