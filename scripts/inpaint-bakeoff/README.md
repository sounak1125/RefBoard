# Inpaint bake-off

Compares content-aware fill engines on real images from your own boards, so the
engine is chosen by looking at results, not at metrics. The 2026-10-28 run used
it to pick LaMa for RefBoard's next content-aware fill. Nothing here ships or is
wired into the app.

## Privacy

Cases are cut from your own `.refboard` files and live in `inpaint-lab/` at the
repo root, which is gitignored. This repository is public: never commit
anything from `inpaint-lab/`.

## Setup

- Node: the repo's own `npm install` (`sharp`, and the old engine in
  `scripts/content-aware/`).
- Python 3 with `onnxruntime`, `numpy` and `pillow`.
- Models, in `inpaint-lab/models/`:
  - `lama-carve/lama_fp32.onnx`: [Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX),
    208 MB, Apache-2.0, fixed 512x512 input.
  - `migan/migan_pipeline_v2.onnx`: [andraniksargsyan/migan](https://huggingface.co/andraniksargsyan/migan),
    28 MB, MIT.
- The Photoshop column needs Photoshop installed; `photoshop-fill.ps1` drives
  Edit > Fill > Content-Aware through COM and only opens the test files.

## Run

From the repo root:

```powershell
# 1. A spread of images from your recent boards (read-only), and numbered sheets to pick from
node scripts/inpaint-bakeoff/extract-pool.js inpaint-lab/cases/pool 5
python -I scripts/inpaint-bakeoff/pool-sheet.py inpaint-lab/cases/pool inpaint-lab/cases/pool-sheet

# 2. Percent grids for drawing lassos, then inpaint-lab/cases.json (pool index, note, shapes)
python -I scripts/inpaint-bakeoff/grid-preview.py inpaint-lab/cases/pool inpaint-lab/cases/grid.png 3 10 17 33
python -I scripts/inpaint-bakeoff/build-cases.py inpaint-lab/cases/pool inpaint-lab/cases inpaint-lab/cases.json

# 3. Masks: the old engine's own 5 px growth, and LaMa's 1.1% growth in a parallel folder
python -I scripts/inpaint-bakeoff/expand-masks.py inpaint-lab/cases
python -I scripts/inpaint-bakeoff/grow-cases.py inpaint-lab/cases inpaint-lab/cases-grow 0.011

# 4. Engines (run the old one alone: it slows ONNX Runtime CPU timings about 5x)
node scripts/inpaint-bakeoff/run-old-engine.mjs inpaint-lab/cases inpaint-lab/out 20
python -I scripts/inpaint-bakeoff/onnx-engines.py inpaint-lab/cases-grow inpaint-lab/out-grow inpaint-lab/models/lama-carve/lama_fp32.onnx inpaint-lab/models/migan/migan_pipeline_v2.onnx
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/inpaint-bakeoff/photoshop-fill.ps1 -CasesDir inpaint-lab/cases-grow -OutDir inpaint-lab/out-grow

# 5. Check every engine changed what it should, then look
python -I scripts/inpaint-bakeoff/diff-check.py inpaint-lab/cases-grow inpaint-lab/out-grow
python -I scripts/inpaint-bakeoff/summary.py inpaint-lab/cases-grow inpaint-lab/out-grow
python -I scripts/inpaint-bakeoff/strips.py inpaint-lab/cases inpaint-lab/out inpaint-lab/results/strip.png "old,lama@inpaint-lab/out-grow=LaMa,photoshop@inpaint-lab/out-grow=Photoshop" 400 c01 c02
```

`sheets.py` builds one full sheet per case; `lama-mask-growth.py` compares LaMa
at several mask growths on one case; `inspect-models.py` prints a model's inputs
and outputs.

## What the 2026-10-28 run found

16 cases from local boards: sky, studio backdrops, a 45% hole, brick, a large
title, interior lines, busy foliage, a product lineup, a person at the frame
edge, tiles with a thin pole, a dark interior, a lamp-lit night scene, and two
ground-truth patches (door frame, grass) where the original is the answer.
LaMa and Photoshop ran on masks grown 1.1% of the long side; the old engine used
its own 5 px growth.

| Engine | Time per fill | Best or tied (of 16) | How it fails |
|---|---|---|---|
| LaMa | ~1.1 s CPU, plus 7-10 s model load once | 12 | Soft inside very large holes (512 input) |
| Photoshop 2026 | 0.4-1.5 s | 6 (2 wins, 4 ties) | Clones visible chunks from elsewhere in the picture |
| MI-GAN | 0.3-2 s | 0 | Invents objects nearly every time |
| Old engine | 11-307 s (median 35 s) | 0 | Mosaics, pasted copies of nearby subjects |

- Ground truth, mean error inside the hole (0-255), 5 px / grown masks: door
  frame LaMa 5.3 / 6.1, Photoshop 6.3 / 41.5, MI-GAN 19.0 / 19.2, old engine
  19.1; grass LaMa 22.9 / 23.4, MI-GAN 28.1 / 33.9, Photoshop 31.1 / 35.0, old
  engine 33.1.
- No engine handled the 45% hole or the bottle wedged between two others.
- The old engine's own verdict is not a quality signal: it rejected 9 of its 16
  fills and rated visibly broken ones `OK`.

## Gotchas

- LaMa regrows the object from any pixels the lasso misses. Growing the mask
  about 1.1% of the image's long side removed the ghosts; Photoshop got worse
  with the same growth.
- The August LaMa export (`big-lama-refboard-v1`, dynamic shapes) fails at every
  input size in onnxruntime 1.26. Use Carve's fixed-512 export.
- Photoshop: after `channel.duplicate(doc)` the alpha channel is the only active
  channel, so `photoshop-fill.ps1` resets `activeChannels` before filling.
  Without that the fill lands in the mask and the picture is untouched while
  every case reports "ok"; `diff-check.py` catches it.
- Look at the sheets. Mean error ranked Photoshop's sharp, plausible grass
  below LaMa's softer fill.
