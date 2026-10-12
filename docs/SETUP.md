# Running BrainHem Assist

[← Project overview](../README.md)

The web application runs independently of the bundled ONNX tensor loader. A new installation has no scans, inference service or training runtime configured.

## Docker

Requirements: Docker with the Compose plugin. From the repository root:

```bash
cp .env.example .env
```

Edit `.env` and set distinct, strong `BRAINHEM_FEEDBACK_ADMIN_PASSWORD` and `BRAINHEM_FEEDBACK_USER_PASSWORD` values. To import local scans through the web UI, also set:

```dotenv
BRAINHEM_DIRECT_UPLOAD_ENABLED=true
```

Start the application:

```bash
docker compose --env-file .env -f mvp/infra/compose.public.yaml up --build -d
```

Open **http://127.0.0.1:8000** and sign in with the account name/password configured in `.env`. The admin account can import scans and access Model Studio. The port is bound to localhost; application data is stored in the `brainhem-data` Docker volume.

### Import and annotate a scan

1. Sign in as admin and use **Tiếp nhận ca CT / Tải lên** on the dashboard.
2. Select your own de-identified NIfTI (`.nii`, `.nii.gz`) or DICOM input. A DICOM study can be supplied as files or a ZIP; avoid mixing studies/series.
3. Open the case under **Dữ liệu** to view slices and use **Gán nhãn** for annotation and review.

Upload requires the opt-in setting above; the default is disabled. No demo scans are seeded. Use data whose terms permit your intended use and keep all scan files and runtime databases outside Git. The application capture uses the real, openly licensed [NiiVue CT_Electrodes sample](https://github.com/niivue/niivue-demo-images#licenses); the volume itself is not bundled.

Imported scans are viewable without an AI inference connector. Uploading does not run Baseline S automatically. Read the [model documentation](../models/README.md) for its architecture and benchmark results; connecting that pipeline to the web application requires an inference adapter.

The application pages are `/` (CT workspace), `/model-studio` (model/dataset management) and `/guide` (usage guide). The detailed model documentation is the `models/` page on GitHub.

### Stop or inspect the application

```bash
docker compose --env-file .env -f mvp/infra/compose.public.yaml logs --tail=100 app
docker compose --env-file .env -f mvp/infra/compose.public.yaml down
```

`down` keeps the data volume. Back up application data separately; do not commit backups or logs.

## Python and Node installation

Requirements: Python 3.11 and Node.js 22. From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r mvp/backend/requirements.txt
cp .env.example .env
cd mvp/frontend
npm ci
npm run build
cd ../..
```

Set local passwords and the upload setting in `.env` as described above. The backend does not load `.env` automatically. Load your locally authored, shell-compatible file and start the server:

```bash
set -a
. ./.env
set +a
export BRAINHEM_FRONTEND_DIR="$PWD/mvp/frontend/dist"
cd mvp/backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The default data directory is relative to the backend's working directory. Set `BRAINHEM_DATA_DIR` to a dedicated absolute directory if needed.

## ONNX inference

From the repository root, use Python 3.11 on a platform supported by ONNX Runtime 1.30.0 (Linux, Windows or Apple Silicon; this version has no macOS Intel wheel):

```bash
pip install -r requirements-model.txt
```

After preparing paired tensors using the [CT pipeline below](#ct-preparation-and-inference-pipeline):

```python
from baseline import load_model

model = load_model("s")                     # FP32 reference
logits = model.predict(image, enhanced)      # prepared float32 CT/CLAHE tensors
compact = load_model("s", precision="int8") # mixed precision, same interface
```

The tensor loader does not read raw scans or restore scan geometry. Keep preprocessing, slice order and spatial restoration consistent with the model. FP32 is the default; the mixed-precision model requires validation on your own data before substitution.

### CT preparation and inference pipeline

The original research pipeline prepares a scan before passing tensors to the model:

1. Preserve slice ordering and through-plane geometry, and crop the nonzero image region while recording its original coordinates.
2. Clip CT intensities to **12–89 HU**. Normalize using mean **47.800434** and standard deviation **18.999517**, then resample the in-plane spacing to **0.488281 mm**.
3. Reconstruct windowed HU from the normalized tensor and map it to `[0,1]` for Kornia CLAHE (clip limit **2.0**, grid **8 × 8**). Preserve saturated zero/one endpoints, then map the enhanced image back to the same fixed CT normalization range; do not normalize each slice independently.
4. Run **512 × 512** spatial tiles with 50% overlap, blend predictions with Gaussian weights, and combine four XY mirror augmentations.
5. Restore the logits to the original image geometry **before** selecting the mask by class `argmax`.

Through-plane spacing is preserved; the sequence module supplies cross-slice context. Spatial restoration is necessary before interpreting a mask in the scan's original coordinates or measuring physical volume.

These settings document the original pipeline. The public [`baseline`](../baseline/) package accepts prepared tensors; it does not bundle that complete CT preprocessing, tiling, augmentation or geometry-restoration pipeline. The web application's external inference connector is a separate integration and is disabled by default.

### Published tensor interface

| Tensor | Type and shape | Role |
| --- | --- | --- |
| `image` | Finite `float32`, `[D, 1, 512, 512]` | Prepared CT slice sequence |
| `enhanced` | Finite `float32`, `[D, 1, 512, 512]` | Aligned CLAHE representation |
| `logits` | `float32`, `[D, 2, 512, 512]` | Class 0: background; class 1: hemorrhage |

Both inputs must have identical shapes. The loader accepts **1–128 ordered slices** per call. That interface limit is not an assurance that every sequence length or integration has been clinically validated. Install and use the tensor API separately from the web application; see the [ONNX installation above](#onnx-inference).

### Connect an external inference command

Provide your own script implementing the complete CT pipeline, then set `BRAINHEM_INFERENCE_COMMAND` in `.env`. For example, with operator-provided paths:

```dotenv
BRAINHEM_INFERENCE_COMMAND="/opt/ct-runtime/bin/python /opt/ct-pipeline/predict.py --input {input} --output {output}"
```

The application splits the command into arguments and launches it without a shell. `{input}` is the imported CT NIfTI path and `{output}` is the required output path; `{output_dir}` and `{job_id}` are also available. The command must finish successfully and write a binary NIfTI mask (0: background, 1: hemorrhage) at `{output}`, preserving the input's shape, affine and slice ordering after restoring scan geometry. The operator must validate the output and pipeline; the bundled tensor loader alone does not implement this command.

For Docker, the runtime, script, dependencies and model files must be installed or mounted inside the application container at the configured paths, with access to the application's input and output files. Host paths alone are insufficient. The public Compose file does not supply this external pipeline; inference stays unconfigured until the operator provides it.

## Development checks

```bash
pip install -r mvp/backend/requirements-dev.txt
(cd mvp/backend && python -m pytest -q)
python -m pytest -q tests/test_publication_policy.py
(cd mvp/frontend && npm run build)
```

For the model tests, also install `requirements-model.txt`, then run `python -m pytest -q tests/test_model_loader.py` on a supported platform. CI runs all tests, frontend logic checks, dependency audits and source/history secret scans.

## Optional services

PACS, external inference and optional annotation adapters require separate services and deliberate operator configuration; they are not started by this Compose file. M/L and fine-tuning are unavailable. See [`Settings`](../mvp/backend/app/config.py) for the supported configuration surface and [SECURITY.rst](../SECURITY.rst) before deploying beyond localhost.
