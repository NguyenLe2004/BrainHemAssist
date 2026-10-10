Publication review — 2026-10-10
===============================

Scope and changes
-----------------

This review updates the clean public snapshot after the owner's request to fix
publication issues. The owner has explicitly chosen to include Baseline S ONNX
publicly, with a note that its graph and learned weights can be inspected and
extracted. The approved artifact bytes were not changed. No GitHub push was
performed, and no ZIP was created during this remediation.

Removed .DS_Store and added Git/Docker ignore entries. Upgraded the vulnerable
pytest pin from 8.3.5 to 9.1.1. CI now audits test requirements, verifies
SHA256SUMS and scans the full fetched Git history as well as the current source.
The manifest generator checks publication policy before hashing source and
excludes Git metadata, local build output and the manifest itself.

Verification
------------

* Backend: 162 tests passed with pytest 9.1.1 on Python 3.11.15 after the
  upgrade (581.73 seconds). Two Starlette/TestClient deprecation warnings
  remain; there were no test failures.
* Frontend source and lockfile are unchanged. npm ci, production build and all
  four logic test scripts passed during the 2026-10-08 verification. A fresh
  npm audit on 2026-10-10 reports zero known advisories.
* pip-audit on fully resolved transitive requirements for Linux x86_64 and
  Python 3.11: zero known advisories and no skipped packages across 34 backend,
  40 test and 5 model package/version entries. Current version snapshots are
  recorded in LICENSES/*-resolved-dependencies.json. Test requirements are now
  included in the CI audit rather than only being installed.
* Bandit app + baseline: 0 high, 8 medium, 18 low findings, with no parse errors.
  CI blocks high findings. The medium findings remain visible to the scanner.
* Strict publication policy passed. Gitleaks v8.30.1 found no secrets in the
  remediated source. Final checksum and staging checks are recorded below.
* Checksum generator checks on a disposable copy: verification passed;
  regeneration produced identical manifest bytes; a modified source file was
  rejected by shasum; an unlisted public file failed the coverage check;
  a private .env file prevented manifest generation.
* Baseline S SHA-256 remains
  92bc39b59ba8edd9f59241baa0b6ebe707690d92257cccc32c5933dbdc282ee5.
  The 2026-10-08 independent ONNX checker passed: standard operators, embedded
  tensors, no custom functions, external tensor files, metadata or training_info.
  That inspection covered 12,986 string fields without finding private account
  paths or credential patterns. The artifact has not changed since inspection.

The earlier preparation report recorded four CPU model-loader tests and private
conversion comparisons. These were not repeated in this remediation. ONNX
Runtime 1.30.0 has no macOS Intel wheel, so the pinned model runtime cannot be
installed on this review machine. Use a supported platform and the Linux CI
workflow for the pinned-runtime model tests. The prior tensor conversion checks
are not evidence of clinical accuracy or complete raw-CT validation.

Final source handover
--------------------

SHA256SUMS was generated after the source and review notes were finalized. The
manifest covers every public file except itself, including the approved ONNX.
The final delivery is checked with strict publication policy, Gitleaks,
shasum and staging in a disposable fresh repository. The Downloads source
folder receives no Git metadata, commit or remote configuration from this work.

Reviewed static findings
------------------------

Eight B608 warnings occur in annotation_store.py (386, 389), store.py
(254, 345, 348, 522), and studio.py (79, 85). Independent inspection found
fixed SQL clauses, generated question-mark placeholders or one of three
allowlisted table names. Values are passed separately as database parameters.
No suppression was added; future edits must preserve these boundaries.

Low findings include operator-configured subprocess hooks, optional imports,
local bind defaults and routine cleanup paths. Executable hooks require
trusted local operator configuration.

Publication policy
------------------

README.md is the sole Markdown exception; models/baseline_s.onnx is the sole
model artifact exception. Internal agent files, other model artifacts, patient
images, environment secrets, databases and old Git history are excluded.
Original SVG illustrations contain no clinical screenshots. M/L loaders remain
empty and their services unavailable. Fine-tuning remains unavailable in the
shipped application. Dataset/annotation preparation remains available.

Limitations
-----------

The GitHub workflow has not run remotely during remediation. No Docker image
build/scan, GPU/TensorRT test, live PACS integration or Internet deployment was
performed. The tensor loader is not a validated raw-CT preprocessing or spatial
restoration pipeline. Version ranges can resolve differently in future
installations; repeat audits when installing or changing dependencies.

The owner's decision to disclose Baseline S does not change third-party terms
or resolve the provenance and distribution questions already recorded in
LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt. Those notices are retained. The
review reports the scope of checks, not a guarantee against every vulnerability
or model-data disclosure.
