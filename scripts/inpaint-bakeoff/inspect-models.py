# Prints each model's inputs/outputs and the providers onnxruntime offers.
#   python -I inspect-models.py <model.onnx> [...]
import sys, time
import onnxruntime as ort

print('onnxruntime', ort.__version__, ort.get_available_providers())
for path in sys.argv[1:]:
    t = time.time()
    s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    print(f'\n{path}  (load {time.time() - t:.1f}s)')
    for i in s.get_inputs():
        print('  in ', i.name, i.type, i.shape)
    for o in s.get_outputs():
        print('  out', o.name, o.type, o.shape)
