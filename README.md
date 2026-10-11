# BrainHem Assist

A brain CT research workspace for viewing scans, annotating regions, and reviewing segmentation revisions. Developed as a graduation capstone project (đồ án tốt nghiệp), this repository includes the web application and one Baseline S ONNX model with a verified Python loader.

![BrainHem Assist CT workspace](docs/images/clinical-workspace.png)

*Actual BrainHem Assist browser capture with the real NiiVue CT_Electrodes sample. The sample demonstrates CT viewing, not hemorrhage detection; no model inference was run. [Image source and attribution](#screenshot-source).*

## What is included

| Component | Public snapshot |
| --- | --- |
| CT workspace | Multi-planar viewing, annotation tools, case library and revision review |
| Access control | Authenticated workspace with role-based permissions |
| Model Studio | Dataset and model management UI; training runtime is unavailable |
| Baseline S | Bundled ONNX weights and a checksum-verified CPU tensor loader |
| Integrations | Interfaces for caller-configured PACS, upload and inference services |
| Verification | API and model tests, frontend checks, dependency audits and source/history secret scans |

Only Baseline S is bundled. M/L are reserved slots whose loaders return `None`. The web application does not automatically apply the ONNX model to uploaded scans; a validated CT pipeline and inference connector are required.

## Start the web application

With Docker and the Docker Compose plugin installed, run from the repository root:

```bash
cp .env.example .env
# Set distinct, strong admin and user passwords in .env.
docker compose --env-file .env -f mvp/infra/compose.public.yaml up --build
```

Open **http://127.0.0.1:8000**. Compose binds to localhost and the container runs as a non-root user. Upload, PACS and inference services require local configuration. To import a scan or install from Python/Node source, follow the [setup guide](docs/SETUP.md). Set `BRAINHEM_DIRECT_UPLOAD_ENABLED=true` in `.env` to enable local imports; it is disabled by default.

## Explore the model

The [Baseline S model documentation](models/README.md) describes the artifact, architecture observed in its graph, input/output interface, Python example, and validation limits. Opening the [`models/`](models/) directory on GitHub displays that page automatically.

The loader accepts two prepared `float32` tensors; it does not provide CT preprocessing or spatial restoration. Fine-tuning is unavailable because no compatible training checkpoint or trainable implementation is included.

## Application views

![Annotation workspace with a real CT sample](docs/images/annotation-workspace.png)

*Annotation workspace with the same real CT sample. The initial mask is empty; no prediction or expert label is implied.*

## Repository guide

| Path | Purpose |
| --- | --- |
| [`mvp/frontend/`](mvp/frontend/) | React application and NiiVue-based imaging workspace |
| [`mvp/backend/`](mvp/backend/) | FastAPI API, access controls, case storage and integration adapters |
| [`models/`](models/) | Baseline S artifact and detailed model documentation |
| [`baseline/`](baseline/) | Verified ONNX loading and tensor inference interface |
| [`tests/`](tests/) | Model interface tests; API tests are in `mvp/backend/tests/` |
| [`scripts/`](scripts/) | Publication guard |

## Checks and development

[GitHub Actions](https://github.com/NguyenLe2004/BrainHemAssist/actions/workflows/security.yml) runs API/model tests, frontend build and logic checks, dependency audits, and source/history secret scans. See the [setup guide](docs/SETUP.md#development-checks) for local commands and [SECURITY.rst](SECURITY.rst) for deployment limits.

## Screenshot source

The screenshots show the public application with `CT_Electrodes.nii.gz`, a real CT sample distributed by [NiiVue](https://github.com/niivue/niivue-demo-images#licenses) from the Scientific Computing and Imaging Institute's [Seg3DData](https://github.com/CIBC-Internal/Seg3DData). The sample is distributed under MIT (Scientific Computing and Imaging Institute, University of Utah, 2015); see [the retained notice](LICENSES/Seg3DData.txt). Only UI screenshots are included, not the CT volume. They illustrate viewing and annotation, not a benchmark or a result produced by Baseline S.

## Research scope and rights

This is research software. Tensor smoke tests do not establish clinical accuracy or validate an end-to-end raw-CT workflow. No reproducible clinical benchmark is provided in this snapshot.

The owner intentionally publishes the ONNX graph and embedded weights, which anyone downloading the repository can inspect and extract. Original project code and the model have no project-wide open-source license grant. Model provenance and redistribution rights remain unverified; preserve [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD-PARTY-NOTICES.txt) and [`LICENSES/`](LICENSES/).

Credentials, private patient data, scan volumes, internal reports and agent Markdown remain excluded by the publication policy. See [SECURITY.rst](SECURITY.rst) for security scope and deployment limits.
