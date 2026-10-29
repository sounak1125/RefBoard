# Mean absolute change vs the original, inside and outside the mask, per engine.
#   python -I diff-check.py <casesDir> <outDir>
import os, sys
import numpy as np
from PIL import Image

cases_dir, out_dir = sys.argv[1:3]
print(f"{'case':22} " + ' '.join(f'{e:>18}' for e in ('old', 'lama', 'migan', 'photoshop')))
for cid in sorted(os.listdir(cases_dir)):
    cdir = os.path.join(cases_dir, cid)
    if not os.path.isfile(os.path.join(cdir, 'case.json')):
        continue
    o = np.asarray(Image.open(os.path.join(cdir, 'image.png')).convert('RGB')).astype(np.int16)
    m = np.asarray(Image.open(os.path.join(cdir, 'mask.png')).convert('L')) > 127
    cells = []
    for e in ('old', 'lama', 'migan', 'photoshop'):
        p = os.path.join(out_dir, cid, f'{e}.png')
        if not os.path.isfile(p):
            cells.append('-'); continue
        r = np.asarray(Image.open(p).convert('RGB')).astype(np.int16)
        if r.shape != o.shape:
            cells.append(f'shape {r.shape[1]}x{r.shape[0]}'); continue
        d = np.abs(r - o).mean(axis=2)
        cells.append(f'in {d[m].mean():5.1f} out {d[~m].mean():4.2f}')
    print(f'{cid:22} ' + ' '.join(f'{c:>18}' for c in cells))
