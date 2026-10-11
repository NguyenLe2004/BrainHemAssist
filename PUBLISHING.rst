Publishing this snapshot
========================

This snapshot is maintained in the owner's personal BrainHemAssist repository.
For a new publication, use a clean export rather than the original workspace
or old private Git history. Ignoring files does not remove material
already committed to Git.

On a clean export before generating local build output::

    python3 scripts/check_public_tree.py --strict
    python3 scripts/generate_checksums.py --check
    sha256sum -c SHA256SUMS

For updates in the existing publication repository, regenerate checksums,
review the staged files and push::

    python3 scripts/generate_checksums.py
    git add .
    git diff --cached --stat
    git status --short
    git commit -m "Improve project and model documentation"
    git push

For a new repository, initialize the clean export with ``git init -b main``
and configure your own origin before staging, committing and pushing. Never
reuse private history. Review both documentation pages, the approved model,
and the screenshot assets before publication.

Only Baseline S is bundled. M/L loader functions return None and application
model slots are unavailable. No private model implementation, checkpoint,
training dataset, internal model report, or agent instruction file is included.
README.md and models/README.md are the only Markdown exceptions. Reviewed
application screenshots use a synthetic phantom and contain no patient data. Graph topology and weights in the ONNX remain inspectable.
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

The application starts without a raw-CT inference runner. See models/README.md for
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
The initial GitHub workflow completed successfully on 2026-10-10. Docker image builds,
live PACS integrations and clinical end-to-end validation were not performed.

Regenerate SHA256SUMS whenever you edit files::

    python3 scripts/generate_checksums.py

The generator checks publication policy before hashing and excludes Git metadata
and local build output. It never includes SHA256SUMS in its own manifest.
The ``--check`` option verifies both content hashes and coverage of all public
files, including newly added files, without rewriting the manifest.
If you add further documents or
models, update the explicit allowlists and review every newly included file.
