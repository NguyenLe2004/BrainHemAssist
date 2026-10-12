Security and public release scope
=================================

This release includes Baseline S in ONNX FP32 and mixed-precision INT8 formats.
M/L are extension slots whose loaders return ``None``; their implementations
and artifacts are not included. Keep patient data, credentials and private
source code out of the repository and public issues.

To report a vulnerability privately, use Report a vulnerability at
https://github.com/NguyenLe2004/BrainHemAssist/security/advisories once the
repository owner enables Private vulnerability reporting after making the
repository public. If the button is unavailable, open an issue at
https://github.com/NguyenLe2004/BrainHemAssist/issues only to request a private
contact channel. Do not post exploit details, tokens or patient data publicly.

Reviewed defaults and controls
------------------------------

* RBAC is enabled by default. No demo passwords are seeded without configuration.
* Empty credentials cannot authenticate. RBAC uses Bearer tokens or session
  cookies; protected APIs reject Basic authentication before password hashing.
* Login and Basic authentication in research mode with RBAC disabled share a
  failed-authentication limit based on the server-provided client address:
  at most 10 failures in 60 seconds. The legacy reviewer authentication
  mechanism retains its own limiter.
* Support and feedback quotas use the server-provided client address rather
  than reading the request's X-Forwarded-For header directly.
* Application sessions use random tokens whose digests are stored in the
  database. Sessions expire and are revoked when accounts or permissions change.
  Cookies use HttpOnly and SameSite strict; writes authenticated only by a
  cookie require a same-origin Origin header. Secure is enabled when the server
  receives an HTTPS request.
* The development server and Compose port binding use loopback. The Docker
  application runs as a non-root user, drops Linux capabilities and sets
  no-new-privileges.
* The total request body is limited before the multipart parser writes temporary
  files. The limit is the upload quota plus 1 MiB for metadata. Individual file
  sizes and the combined DICOM file size are also checked separately. Masks must
  match the source CT's dimensions and affine and satisfy voxel-count limits
  before voxel data is read or normalized.
* The Baseline S loader checks SHA-256 and file-size limits, then passes verified
  bytes to ONNX Runtime. Inputs must be finite float32 tensors with matching
  shapes within the loader's limits. CPU is the default execution provider.
* The publication script permits only the approved Baseline S artifacts with
  fixed checksums, README.md, models/README.md, docs/SETUP.md and approved UI
  images verified by checksum. Other models, data, agent files and internal
  Markdown remain blocked.
* Requests to enable model extension mode are rejected. Public-release policy
  and cache settings use only ``false``. The M/L slots contain no private
  inference algorithms.

Security and deployment limitations
-----------------------------------

Baseline S ONNX artifacts are inspectable: anyone downloading them can read the
graphs, operators, tensor dimensions and weights. Renaming files or nodes does
not prevent reconstruction of the baseline architecture. There is no guarantee
against model extraction or protection of publicly released weights. The
project owner has chosen to publish both formats with this access documented.

Checksums verify the packaged bytes; they do not establish medical effectiveness
or demonstrate that a model has not memorized training data. The project owner
publishes their code, models and architecture diagram. See LICENSE, NOTICE and
THIRD-PARTY-NOTICES.txt for licensing scope and third-party components.

Do not expose the development server directly to the Internet. Remote access
requires HTTPS, a reverse proxy and appropriate host/CORS settings. If client
addresses must be forwarded by a proxy, configure the server to trust only
identified proxies; do not allow clients to supply arbitrary addresses.
Limiters and quotas are per process, may reset on restart and are not distributed
limits. The frontend stores Bearer tokens in browser storage; XSS protection
and control over browser extensions must be maintained.

Inference, training and release commands, along with plugins, are operator
configuration with permission to execute code. Use trusted executables, runtimes
and artifacts. Optional integrations have their own data-loading behavior;
this review does not cover external services or models added later. Application
authentication does not replace PACS or DICOM network security.

The Baseline S loader provides a tensor interface; a complete CT pipeline has
not been validated by these checks. CI tests the API, tensor model and frontend
and scans dependencies, source and Git history. Results are available in GitHub
Actions. These checks do not validate GPU/TensorRT execution, external PACS,
Docker images or clinical effectiveness. Do not publish scans, logs, databases
or internal reports in Git.

Automated scans have a defined scope and reflect the time they run. Run them
again after changing dependencies or artifacts or adding documentation. This
release retains the team's copyright and does not grant an open-source license.
This security document does not certify that all model or dependency
distribution rights have been resolved.
