Publishing this snapshot
========================

The owner will publish this source themselves. No GitHub push was performed
while preparing the snapshot. Use this clean directory, not the
original workspace or old Git history. Ignoring files does not remove material
already committed to Git.

Before generating local build output, from the snapshot root::

    python3 scripts/check_public_tree.py --strict
    python3 scripts/generate_checksums.py --check
    sha256sum -c SHA256SUMS
    git init -b main
    git add .
    git diff --cached --stat
    git status --short

Review the staged files, including README.md and models/baseline_s.onnx.
Then commit and push to your own fresh repository::

    git commit -m "Initial public source snapshot"
    git remote add origin https://github.com/YOUR_ACCOUNT/brainhem-assist.git
    git push -u origin main

Only Baseline S is bundled. M/L loader functions return None and application
model slots are unavailable. No private model implementation, checkpoint,
training dataset, internal model report, or agent instruction file is included.
README.md is the sole Markdown exception. Original SVG illustrations contain
no patient data. Graph topology and weights in the ONNX remain inspectable.
The owner has explicitly chosen to include this ONNX publicly; anyone downloading
the repository can inspect and extract its graph and learned weights. This does
not change the retained third-party notices or resolve artifact provenance.

On macOS, verify the manifest using ``shasum -a 256 -c SHA256SUMS``. Set a public
Git author name and an email you are willing to disclose before committing.

Source installation
-------------------

Use Python 3.11 and Node.js 22 or newer. From the repository root::

    python3 -m venv .venv
    . .venv/bin/activate
    pip install -r mvp/backend/requirements.txt
    cp .env.example .env

Set the local passwords in .env, then export the required environment variables
in your shell (the backend does not automatically load this file). Build the UI::

    cd mvp/frontend
    npm ci
    npm run build
    cd ../..

Set BRAINHEM_FRONTEND_DIR to the absolute path of mvp/frontend/dist and run::

    cd mvp/backend
    uvicorn app.main:app --host 127.0.0.1 --port 8000

The application starts without a raw-CT inference runner. See README.md for
the separate ONNX tensor API. PACS, uploads, training, external support, GPU,
and inference integrations require caller configuration and validation.

Fine-tuning is disabled in this public snapshot: no compatible training
checkpoint, trainable model implementation or runtime is included. Setting a
training command alone does not enable it. Dataset preparation remains usable.

Rights and verification
-----------------------

The owner retains copyright; no project-wide open-source license is granted.
Preserve third-party notices. Model provenance and redistribution rights remain
unverified; public visibility and this preparation do not constitute clearance.

CI is configured for source policy, checksums, source/history secrets,
runtime/test dependency audits, Python security,
backend tests, model smoke tests, frontend build and frontend logic tests.
The GitHub workflow has not run during preparation. Docker image builds,
live PACS integrations and clinical end-to-end validation were not performed.

Regenerate SHA256SUMS whenever you edit files::

    python3 scripts/generate_checksums.py

The generator checks publication policy before hashing and excludes Git metadata
and local build output. It never includes SHA256SUMS in its own manifest.
The ``--check`` option verifies both content hashes and coverage of all public
files, including newly added files, without rewriting the manifest.
If you add further documents or
models, update the explicit allowlists and review every newly included file.
