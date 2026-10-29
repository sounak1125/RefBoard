# LaMa runtime spike

Can the bake-off winner (Carve's 512x512 LaMa export, see
`scripts/inpaint-bakeoff/`) run inside RefBoard fast enough, and on what? This
runs the exact input tensors from the bake-off through ONNX Runtime inside
Electron and reports model load time, time per fill, peak memory, and the
largest difference from the Python output on a 0-255 scale. It does not touch
the app, its settings or any board.

## Run

From the repo root, with the lab set up as in `scripts/inpaint-bakeoff/README.md`:

```powershell
python -I scripts/inpaint-spike/dump-tensors.py inpaint-lab/cases inpaint-lab/models/lama-carve/lama_fp32.onnx inpaint-lab/spike c01-moon c08-doorframe-gt c13-knight
npx electron scripts/inpaint-spike/lama-runtime-spike.cjs
```

Options: `--only=node,web-webgpu` (variant prefixes), `--runs=5`,
`--opt=all|extended|basic|disabled` (ONNX Runtime graph optimisation, most of
the load time). Results go to `inpaint-lab/spike/results-<time>.json`.

| Variant | What it runs |
|---|---|
| `node-cpu` | `onnxruntime-node` in the main process, CPU |
| `node-dml` | `onnxruntime-node` in the main process, DirectML (GPU) |
| `web-webgpu` | `onnxruntime-web` WebGPU in a renderer worker, cross-origin isolated page |
| `web-webgpu-file` | the same from a plain `file://` page, loaded the way `index.html` is |
| `web-wasm-threads` | `onnxruntime-web` WASM on the CPU, multi-threaded (needs isolation) |
| `web-wasm-1thread` | `onnxruntime-web` WASM in a page without isolation |

## Results

2026-10-29, i7-13700K (16 cores), RTX 4070, Electron 44.9.3 (Chrome 152),
onnxruntime 1.31.1, three cases, 5 timed fills each (2 for WASM). "Max diff" is
the largest difference from the Python CPU output on a 0-255 scale.

| Variant | Model load | First fill | Each fill after | Max diff | Peak memory |
|---|---|---|---|---|---|
| `web-webgpu` | 10.6 s | 1.4 s | 0.20 s | 0.02 | renderer 1.1 GB, GPU 363 MB |
| `web-webgpu-file` | 10.6 s | 1.5 s | 0.20 s | 0.02 | renderer 1.0 GB, GPU 353 MB |
| `node-cpu` | 11.2 s | 1.1 s | 1.1 s | 0 | main process 1.0 GB |
| `web-wasm-threads` (4) | 7.0 s | 5.0 s | 5.1 s | 0.002 | renderer 1.0 GB |
| `web-wasm-1thread` | 6.1 s | 11.9 s | 11.9 s | 0.002 | renderer 1.0 GB |
| `node-dml` | fails | | | | |

- WebGPU used `ort-wasm-simd-threaded.asyncify.wasm` (27 MB) and ran from a
  plain `file://` page with no cross-origin isolation, the way `index.html`
  loads, so the app needs no loading changes for it.
- DirectML rejects a MatMul inside LaMa's Fourier units
  (`.../convg2g/fu/rttn/MatMul_5`, `80070057` invalid parameter) on every case.
- WASM threads need cross-origin isolation, which `index.html` does not have,
  so a WASM fallback in the app today is the single-threaded 12 s figure.
- Load time is the 208 MB model, not graph optimisation: `--opt=basic` gave
  9.3 s on the CPU and 10.5 s on WebGPU, `--opt=disabled` 10.9 s and 13.0 s
  (and slower WebGPU fills, 0.22 s).
- After the WebGPU variants, Chromium logs `GPU state invalid after
  WaitForGetOffsetInRange` as the app quits. Results were unaffected; watch for
  it when the real tool opens and closes the model repeatedly.

## What it means for the build

- Run LaMa with `onnxruntime-web` on WebGPU in a renderer worker: 0.2 s a fill.
- Load the model in the background when the fill tool is first opened, keep it
  for the session, and release it when the tool has been idle; it holds about
  1 GB in the renderer and 350 MB in the GPU process while loaded.
- A machine without WebGPU needs a fallback: `onnxruntime-node` on the CPU in a
  utility process (about 1.1 s here, 65 MB of Windows DLLs in the installer) or
  single-threaded WASM (12 s, nothing extra to ship).
- Still open: shipping the 208 MB model (bundled or downloaded on first use),
  and softness inside very large holes from the 512 input.
