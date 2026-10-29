# Copies the cases into a new folder whose mask-run.png is the drawn mask grown
# by a fraction of the image's long side.
#   python -I grow-cases.py <casesDir> <newDir> <fraction>
import json, os, shutil, sys
from PIL import Image, ImageFilter

src, dst, frac = sys.argv[1], sys.argv[2], float(sys.argv[3])
for cid in sorted(os.listdir(src)):
    s = os.path.join(src, cid)
    if not os.path.isfile(os.path.join(s, 'case.json')):
        continue
    d = os.path.join(dst, cid)
    os.makedirs(d, exist_ok=True)
    for f in ('image.png', 'mask.png'):
        shutil.copyfile(os.path.join(s, f), os.path.join(d, f))
    m = Image.open(os.path.join(s, 'mask.png')).convert('L')
    px = round(frac * max(m.size))
    m.filter(ImageFilter.MaxFilter(2 * px + 1)).save(os.path.join(d, 'mask-run.png'))
    case = json.load(open(os.path.join(s, 'case.json'), encoding='utf-8'))
    case['runExpansionPx'] = px
    json.dump(case, open(os.path.join(d, 'case.json'), 'w', encoding='utf-8'), indent=2)
    print(cid, 'grown', px, 'px')
