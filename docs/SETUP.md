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

Upload requires the opt-in setting above; the default is disabled. No demo scans are seeded. Use data whose terms permit your intended use and keep all scan files and runtime databases outside Git. The README images use the real, openly licensed [NiiVue CT_Electrodes sample](https://github.com/niivue/niivue-demo-images#licenses); the volume itself is not bundled.

Imported scans are viewable without an AI inference connector. Uploading does not run `baseline_s.onnx` automatically. The separate [model documentation](../models/README.md) explains the prepared-tensor API and the missing CT preprocessing boundary.

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

The default data directory is relative to the backend's working directory. Set `BRAINHEM_DATA_DIR` to a dedicated absolute directory if needed. Run the model example separately on a platform supported by the pinned ONNX Runtime.

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
