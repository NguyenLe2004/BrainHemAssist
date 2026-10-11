# Baseline S model

[← BrainHem Assist](../README.md)

Baseline S is the only model artifact included in this repository. It is an inference ONNX graph with embedded weights, exposed through the [`baseline`](../baseline/) Python package. Model slots M and L have no artifacts or implementations; their loaders return `None`.

## Artifact and interface

| Property | Value |
| --- | --- |
| File | [`baseline_s.onnx`](baseline_s.onnx) |
| Size | 8,233,816 bytes (approximately 7.85 MiB) |
| SHA-256 | `92bc39b59ba8edd9f59241baa0b6ebe707690d92257cccc32c5933dbdc282ee5` |
| ONNX format | IR 8, standard-domain opset 17 |
| Inputs | `image` and `enhanced`, finite `float32` arrays of shape `[D, 1, 512, 512]` |
| Sequence length | Dynamic in the graph; loader permits `1 <= D <= 128` |
| Output | `logits`, `float32`; documented runtime contract `[D, 2, 512, 512]` |
| Stored tensors | 134 float32 initializers, containing 1,975,748 scalar elements |
| Default runtime | CPU, two intra-op threads and one inter-op thread |

Both inputs must have identical shapes. `D` represents an ordered sequence of prepared slices: sequence/context handling must be preserved and validated by the caller. It should not be treated as an arbitrary batch of unrelated scans.

All output dimensions are symbolic in the ONNX annotation. The packaged CPU smoke test verifies the runtime shape for `D=1`; it does not establish behavior across the full permitted sequence range. The initializer count describes the exported tensors, not a verified count of original trainable parameters.

## Architecture observed in the graph

Direct inspection shows a dual-input encoder–decoder combining convolutional and tokenized blocks, multi-scale attention fusion, recurrent sequence context, and an upsampling decoder with a two-channel logit head.

The two inputs have separate early encoder paths. Convolutional channel stages include 16, 32, 128, 160 and 256 channels, with shared higher projection initializers and five fusion stages. Channel/spatial gating and tokenized matrix operations occur in the encoder. Two GRU operations appear inside sequence-dependent loop control flow. A final convolution produces two channels.

This is a graph-derived overview, not an authenticated reconstruction of the original training implementation. The recursive graph contains 2,530 nodes (2,242 at the top level), uses standard ONNX operators, and contains no external tensor files, custom functions, metadata properties or training information.

There is no final Softmax. Outputs are logits, not calibrated probabilities. The public interface does not establish output-class labels or a segmentation threshold.

## Run a tensor smoke test

From the repository root, use Python 3.11 and a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-model.txt
```

ONNX Runtime 1.30.0, pinned in this snapshot, has no macOS Intel wheel. Use a supported Linux, Windows or Apple Silicon environment for the model example. The web backend can be installed separately.

```python
import numpy as np
from baseline import load_model

model = load_model("s")
# Synthetic tensors verify the interface only.
image = np.zeros((1, 1, 512, 512), dtype=np.float32)
enhanced = np.zeros_like(image)
logits = model.predict(image, enhanced)
assert logits.shape == (1, 2, 512, 512)
assert np.isfinite(logits).all()
assert load_model("m") is None
assert load_model("l") is None
```

The [loader](../baseline/model_loader.py) verifies the exact approved SHA-256, rejects symlink artifacts and files larger than 32 MiB, validates providers and model input/output names, and loads the verified bytes into ONNX Runtime. `predict` rejects mismatched shapes, unsupported dtypes and non-finite input values.

## Integrating with CT data

The loader starts at prepared tensors. A complete CT application must supply and validate:

1. Orientation, slice ordering and any sequence/window context handling.
2. Intensity windowing and normalization, resizing to 512 × 512, and the transformation producing `enhanced`.
3. Output-class interpretation and segmentation postprocessing.
4. Restoration to the scan's original dimensions, orientation and physical geometry.

The original preprocessing recipe and class semantics are not documented in this public snapshot. Guessing them does not produce a validated CT pipeline. The web application's inference connector is separate from this tensor loader and is disabled by default; uploading a scan does not automatically invoke the artifact.

Fine-tuning is unavailable. No compatible PT/PTH checkpoint, trainable implementation or training runtime is included. Configuring a command alone does not enable training.

## Evidence and limitations

| Check | What it establishes |
| --- | --- |
| SHA-256 verification | Identity of the packaged artifact bytes |
| Independent ONNX checker and recursive graph inspection | Valid graph structure and the artifact properties above |
| [Model tests](../tests/test_model_loader.py) | CPU output shape, dtype and finiteness for one all-zero slice; input rejection and loader behavior |
| [Security review](../SECURITY-REVIEW.rst) | Recorded verification scope, dates and platform limitations |

The prior private conversion comparisons have no bundled reference checkpoint or reproducible inputs. They are not a public accuracy benchmark. This repository provides no verified clinical dataset/split, Dice/IoU result, latency benchmark, training configuration or clinical evaluation. GPU execution and the entire permitted `D` range have not been established by the packaged smoke test.

## Provenance and publication

The owner intentionally includes the readable graph and embedded weights. Complete model provenance and redistribution rights remain unverified, and no new open-source license grant is made for the artifact. Known upstream comparison evidence and notices are recorded in [THIRD-PARTY-NOTICES.txt](../THIRD-PARTY-NOTICES.txt), [NOTICE](../NOTICE) and the [provenance inventory](../LICENSES/model-provenance-inventory.json). Source resemblance does not by itself authenticate the original import or training history.
