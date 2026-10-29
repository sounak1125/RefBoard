# Writes mask-run.png per case: the drawn mask grown by the old engine's own
# default expansion, clamp(round(longEdge * 0.002), 2, 5) px, so every engine
# fills the same pixels the old engine does.
#   python -I expand-masks.py <casesDir> [fixedPx]
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

cases_dir = sys.argv[1]
fixed = int(sys.argv[2]) if len(sys.argv) > 2 else None
for cid in sorted(os.listdir(cases_dir)):
    cdir = os.path.join(cases_dir, cid)
    if not os.path.isfile(os.path.join(cdir, 'case.json')):
        continue
    m = Image.open(os.path.join(cdir, 'mask.png')).convert('L')
    e = fixed if fixed is not None else min(5, max(2, round(max(m.size) * 0.002)))
    # Disc-shaped growth: threshold a blurred mask at the distance we want.
    grown = m.filter(ImageFilter.MaxFilter(2 * e + 1))
    grown.save(os.path.join(cdir, 'mask-run.png'))
    case = json.load(open(os.path.join(cdir, 'case.json'), encoding='utf-8'))
    case['runExpansionPx'] = e
    json.dump(case, open(os.path.join(cdir, 'case.json'), 'w', encoding='utf-8'), indent=2)
    print(cid, 'expanded', e, 'px')
