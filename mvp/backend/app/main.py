from __future__ import annotations

import time
import threading

import base64
import binascii
import asyncio
import json
import os
import platform
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import uuid
import zipfile
import struct
import zlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from importlib import metadata as package_metadata

import requests
import nibabel as nib
import numpy as np

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from .reviewer_auth import ReviewerAuth
from .account_store import AccountStore, AccountError
from .authorization import ROLE_PERMISSIONS, ROLE_LABELS, permissions, route_permission, require
from starlette.responses import JSONResponse
from starlette.routing import Match
from .annotation_store import AnnotationStore, RevisionConflictError
from .demo_preparation import prepare_demo49
from .config import Settings
from .request_limits import RequestBodyLimit
from .inference import CommandInferenceAdapter
from .models import (
    AnnotationCase,
    AnnotationCaseCreateRequest,
    AnnotationCaseList,
    AnnotationRevision,
    AnnotationRevisionList,
    AutomationSettingsUpdate,
    Capabilities,
    Health,
    InferenceTier,
    Job,
    JobList,
    JobStatus,
    ReviewRequest,
    TierCapability,
)
from .orthanc import OrthancClient, OrthancError, dicom_series_to_nifti, inspect_uploaded_dicom
from .store import JobStore
from .simulator import nifti_to_ct_series, send_c_store
from .validation import (
    InvalidMaskError,
    InvalidNifti,
    compute_canonical_nifti_digest,
    normalize_binary_annotation,
    validate_mask_against_source,
    validate_nifti_filename,
    validate_nifti_header,
)
from .worker import InferenceWorker
from .mlops_store import MLOpsStore, TrainingWorker, WorkflowError
from .studio import Studio, Recipe, TrainingPolicy, TRAINING_UNAVAILABLE_REASON
from .triton_deployer import TritonDeployer, TritonDeploymentError
from .support_assistant import SupportAssistant
from .feedback import FeedbackAuthError, FeedbackLimitError, FeedbackService
from .sam2_propagation import Sam2Propagator, Sam2Unavailable
from .models import (
    LearningCandidateCreate, LearningCandidateUpdate, PeerReviewCreate,
    AdjudicationRequest, DatasetVersionCreate, TrainingRunCreate,
    ApprovalCreate, ModelTransitionRequest, SupportChatRequest, SupportChatResponse,
    FeedbackRequest, FeedbackResponse, AppLoginRequest,
)


def _cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except (OSError, IndexError):
        pass
    return "Unknown CPU"


def _png_gray(image: np.ndarray) -> bytes:
    """Encode an 8-bit greyscale image without adding an imaging dependency."""
    pixels = np.ascontiguousarray(image, dtype=np.uint8)
    height, width = pixels.shape
    raw = b"".join(b"\x00" + pixels[row].tobytes() for row in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, level=6)) + chunk(b"IEND", b"")


def _annotation_case_thumbnail(source_path: Path) -> bytes:
    """Produce a small, private axial CT preview for the case library."""
    volume = np.asanyarray(nib.load(str(source_path)).dataobj)
    if volume.ndim < 3:
        raise InvalidNifti("CT source must be at least 3D")
    volume = volume[..., 0] if volume.ndim > 3 else volume
    z_index = volume.shape[2] // 2
    axial = np.asarray(volume[:, :, z_index], dtype=np.float32).T[:, ::-1]
    # Brain window when values are HU; percentile fallback also makes research
    # volumes with non-HU scaling useful in the worklist.
    finite = axial[np.isfinite(axial)]
    if not finite.size:
        raise InvalidNifti("CT source contains no finite voxels")
    lo, hi = (0.0, 80.0) if np.percentile(finite, 99) > 120 else tuple(np.percentile(finite, [1, 99]))
    if hi <= lo:
        hi = lo + 1.0
    pixels = np.clip((axial - lo) * (255.0 / (hi - lo)), 0, 255)
    max_side = 320
    step = max(1, int(np.ceil(max(pixels.shape) / max_side)))
    return _png_gray(pixels[::step, ::step])



async def _save_upload(upload: UploadFile, target: Path, maximum: int) -> int:
    size = 0
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Upload exceeds the {maximum}-byte limit",
                    )
                output.write(chunk)
    except Exception:
        if target.is_file():
            target.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    if size == 0:
        if target.is_file():
            target.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Uploaded file is empty")
    return size


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    jobs_dir = settings.data_dir / "jobs"
    annotations_dir = settings.data_dir / "annotations"
    store = JobStore(settings.database_path, jobs_dir, settings.inference_max_attempts, settings.inference_deadline_seconds)
    annotation_store = AnnotationStore(settings.database_path, annotations_dir)
    mlops_store = MLOpsStore(settings.database_path, settings.data_dir / "mlops")
    adapter = CommandInferenceAdapter(
        command=settings.inference_command,
        timeout_seconds=settings.inference_timeout_seconds,
        settings=settings,
    )
    worker = InferenceWorker(store, adapter, settings)
    training_worker = TrainingWorker(mlops_store, settings)
    studio = Studio(mlops_store, settings)
    adapter.release_resolver = studio.releases.resolve
    training_worker.scheduler = studio.tick
    triton_deployer = TritonDeployer(settings)
    reviewer_auth = ReviewerAuth(settings.reviewer_accounts_file)
    support_assistant = SupportAssistant(
        settings.data_dir,
        Path(__file__).resolve().parents[3],
        settings.support_hourly_quota,
        settings.support_local_url,
        settings.support_local_model,
        settings.support_agy_path,
        settings.support_agy_model,
    )
    feedback_service = FeedbackService(
        settings.data_dir, settings.feedback_hourly_quota,
        settings.feedback_user_username, settings.feedback_user_password,
        settings.feedback_admin_username, settings.feedback_admin_password,
    )
    accounts = AccountStore(settings.data_dir / "access.sqlite3", settings.auth_session_seconds)
    accounts.initialize([(settings.feedback_admin_username, settings.feedback_admin_password, "admin"),
                         (settings.feedback_user_username, settings.feedback_user_password, "doctor")])
    if settings.rbac_enabled:
        feedback_service.authenticate = accounts.authenticate
        feedback_service.login = accounts.login
        feedback_service.session = accounts.session
        feedback_service.logout = accounts.logout
    reviewer_auth.set_session_resolver(feedback_service.session)
    sam2_propagator = Sam2Propagator(settings.sam2_checkpoint, settings.sam2_source_dir)
    orthanc = OrthancClient(
        settings.orthanc_url,
        settings.orthanc_username,
        settings.orthanc_password,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        store.initialize(settings.model_version)
        annotation_store.initialize()
        mlops_store.initialize()
        studio.initialize()
        worker.start()
        training_worker.start()
        yield
        training_worker.stop()
        worker.stop()

    app = FastAPI(
        title="Brain Hemorrhage MVP API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.annotation_store = annotation_store
    app.state.mlops_store = mlops_store
    app.state.worker = worker
    app.state.training_worker = training_worker
    app.state.studio = studio
    app.state.triton_deployer = triton_deployer
    app.state.orthanc = orthanc
    app.state.support_assistant = support_assistant
    app.state.feedback_service = feedback_service
    app.state.sam2_propagator = sam2_propagator

    @app.get("/api/v1/support/status", tags=["support"])
    def support_status():
        return support_assistant.status()

    @app.post("/api/v1/support/chat", response_model=SupportChatResponse, tags=["support"])
    def support_chat(request: Request, payload: SupportChatRequest):
        client_key = request.client.host if request.client else "local"
        return support_assistant.answer(payload.question.strip(), payload.session_id, payload.page, client_key)

    @app.get("/api/v1/feedback/status", tags=["feedback"])
    def feedback_status():
        return feedback_service.status()

    password_attempts: dict[str, list[float]] = {}
    password_attempts_lock = threading.Lock()

    def reserve_password_attempt(request: Request) -> tuple[str, float]:
        # Trust only the client address supplied by the deployment server.
        # Login and legacy Basic share a bucket so switching routes cannot
        # bypass the bound on expensive password verification.
        host = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with password_attempts_lock:
            for key in list(password_attempts):
                recent = [stamp for stamp in password_attempts[key] if now - stamp < 60]
                if recent:
                    password_attempts[key] = recent
                else:
                    del password_attempts[key]
            attempts = password_attempts.setdefault(host, [])
            if len(attempts) >= 10:
                raise HTTPException(429, "Thử đăng nhập quá nhiều lần. Vui lòng chờ một phút.")
            attempts.append(now)
        return host, now

    def clear_password_attempt(attempt: tuple[str, float]) -> None:
        host, stamp = attempt
        with password_attempts_lock:
            attempts = password_attempts.get(host, [])
            if stamp in attempts:
                attempts.remove(stamp)

    def feedback_actor(request: Request) -> dict[str, str]:
        authorization = request.headers.get("authorization", "")
        if settings.rbac_enabled and not authorization and request.cookies.get("brainhem_session"):
            authorization = "Bearer " + request.cookies["brainhem_session"]
        try:
            scheme, token = authorization.split(" ", 1)
            if scheme.lower() == "bearer":
                return feedback_service.session(token)
            if scheme.lower() != "basic" or settings.rbac_enabled:
                raise ValueError
            attempt = reserve_password_attempt(request)
            if len(token) > 2048:
                raise ValueError
            username, password = base64.b64decode(token, validate=True).decode("utf-8").split(":", 1)
            actor = feedback_service.authenticate(username, password)
            clear_password_attempt(attempt)
            return actor
        except (ValueError, UnicodeDecodeError, binascii.Error, FeedbackAuthError, AccountError) as exc:
            detail = str(exc) if isinstance(exc, (FeedbackAuthError, AccountError)) else "Vui lòng đăng nhập để sử dụng Feedback."
            # The web application owns the sign-in UX. Advertising a Basic
            # challenge here makes browsers open their native username/password
            # dialog whenever an expired Bearer session is checked.
            raise HTTPException(status_code=401, detail=detail) from exc

    def optional_feedback_actor(request: Request) -> dict[str, str] | None:
        if not request.headers.get("authorization", "").strip():
            return None
        return feedback_actor(request)

    app.state.accounts = accounts

    @app.middleware("http")
    async def enforce_permissions(request: Request, call_next):
        path=request.url.path; method=request.method
        public = path in {"/health", "/api/v1/health", "/api/v1/auth/login", "/api/v1/support/status", "/api/v1/feedback/status"} or (method=="POST" and path=="/api/v1/feedback")
        if not settings.rbac_enabled or method=="OPTIONS" or public or not path.startswith("/api/"):
            return await call_next(request)
        # Cookie credentials support protected thumbnails and file navigation.
        # Mutating browser requests use Bearer; cookie-only writes require a
        # same-origin Origin to prevent cross-site request forgery.
        if not request.headers.get("authorization") and request.cookies.get("brainhem_session") and method not in {"GET","HEAD"}:
            if request.headers.get("origin") != str(request.base_url).rstrip("/"):
                return JSONResponse({"detail":"Yêu cầu cần xác thực hoặc nguồn cùng miền."},status_code=403)
        exists=any(getattr(route,"matches",lambda scope:(None,None))(request.scope)[0]==Match.FULL for route in app.routes)
        permission=route_permission(method,path) if exists else None
        actor={}
        try:
            actor=feedback_actor(request); request.state.actor=actor; request.state.permission=permission
            allowed=set(actor.get("permissions", permissions(actor["role"])))
            if permission=="model.review":
                if not ({"model.manage", "model.domain_review"} & allowed): raise HTTPException(403,"Tài khoản không có quyền kiểm tra mô hình.")
            elif permission!="authenticated" and (permission is None or permission not in allowed):
                raise HTTPException(403,"Tài khoản không có quyền thực hiện thao tác này.")
            response=await call_next(request)
        except HTTPException as exc:
            response=JSONResponse({"detail":exc.detail}, status_code=exc.status_code)
        # Audit writes and all authorization failures; no request body, token,
        # password, patient name or raw medical data is recorded.
        if method not in {"GET","HEAD"} or response.status_code in {401,403}:
            accounts.audit(actor,method,path,getattr(request.state,"permission",permission),response.status_code)
        response.headers["Cache-Control"]="private, no-store"
        return response

    @app.get("/api/v1/admin/accounts")
    def list_accounts():
        return {"items":accounts.list_accounts(),"roles":[{"id":r,"label":ROLE_LABELS[r],"permissions":permissions(r)} for r in ROLE_PERMISSIONS]}

    @app.post("/api/v1/admin/accounts", status_code=201)
    def create_account(payload: dict):
        if set(payload)-{"username","password","role"}: raise HTTPException(422,"Trường tạo tài khoản không hợp lệ.")
        try: return accounts.create(payload.get("username",""),payload.get("password",""),payload.get("role",""))
        except AccountError as exc: raise HTTPException(422,str(exc)) from exc

    @app.patch("/api/v1/admin/accounts/{username}")
    def update_account(request: Request, username: str, payload: dict):
        if set(payload)-{"role","active","password"}: raise HTTPException(422,"Trường cập nhật không hợp lệ.")
        if "active" in payload and not isinstance(payload["active"],bool): raise HTTPException(422,"active phải là boolean.")
        try: return accounts.update(username,request.state.actor["username"],**payload)
        except KeyError as exc: raise HTTPException(404,"Không tìm thấy tài khoản.") from exc
        except (AccountError,TypeError) as exc: raise HTTPException(422,str(exc)) from exc

    @app.get("/api/v1/admin/audit")
    def access_audit(limit: int=100):
        return {"items":accounts.audit_items(limit)}
    def require_model_manager(request: Request) -> str:
        actor = feedback_actor(request)
        if actor.get("role") not in ({"admin", "model_admin"} if settings.rbac_enabled else {"admin"}):
            raise HTTPException(status_code=403, detail="Chỉ quản trị viên được thay đổi model và cấu hình triển khai.")
        return actor["username"]

    def authorize_model_choice(request: Request, tier: str) -> None:
        # Reading and running the configured model remain available. Choosing
        # a different tier requires a server-verified role, including cache hits.
        if tier != automation_settings()["inference_tier"]:
            require_model_manager(request)

    @app.post("/api/v1/auth/login", tags=["auth"])
    def app_login(request: Request, payload: AppLoginRequest, response: Response):
        attempt = reserve_password_attempt(request)
        try:
            result=feedback_service.login(payload.username.strip(), payload.password)
            clear_password_attempt(attempt)
            if settings.rbac_enabled:
                response.set_cookie("brainhem_session",result["token"],max_age=settings.auth_session_seconds,httponly=True,secure=request.url.scheme=="https",samesite="strict",path="/api/")
            return result
        except (FeedbackAuthError, AccountError) as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    @app.get("/api/v1/auth/me", tags=["auth"])
    def app_account(request: Request):
        return feedback_actor(request)

    @app.post("/api/v1/auth/logout", status_code=204, tags=["auth"])
    def app_logout(request: Request):
        authorization = request.headers.get("authorization", "")
        if not authorization and settings.rbac_enabled and request.cookies.get("brainhem_session"):
            authorization = "Bearer " + request.cookies["brainhem_session"]
        if authorization.lower().startswith("bearer "):
            feedback_service.logout(authorization.split(" ", 1)[1])
        result=Response(status_code=204)
        result.delete_cookie("brainhem_session",path="/api/")
        return result

    @app.get("/api/v1/feedback/me", tags=["feedback"])
    def feedback_me(request: Request):
        return feedback_actor(request)

    @app.get("/api/v1/feedback/items", tags=["feedback"])
    def list_feedback(request: Request):
        actor = feedback_actor(request)
        try:
            items = feedback_service.list_all(actor)
        except (FeedbackAuthError, AccountError) as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {"items": items, "count": len(items)}

    @app.post("/api/v1/feedback", response_model=FeedbackResponse, tags=["feedback"])
    def submit_feedback(request: Request, payload: FeedbackRequest):
        actor = optional_feedback_actor(request)
        client_key = request.client.host if request.client else "local"
        try:
            return feedback_service.submit(payload.model_dump(), actor, client_key)
        except FeedbackLimitError as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc

    # Bound the whole incoming body before FastAPI parses multipart uploads.
    # File limits remain enforced separately; allow 1 MiB for form metadata.
    app.add_middleware(RequestBodyLimit, maximum=settings.max_upload_bytes + 1024 * 1024)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST", "PUT", "PATCH", "HEAD", "OPTIONS"],
            allow_headers=["Content-Type", "Range", "Authorization"],
            expose_headers=[
                "Accept-Ranges",
                "Content-Disposition",
                "Content-Length",
                "Content-Range",
                "ETag",
                "Last-Modified",
                "X-Annotation-Reused",
            ],
        )

    @app.get("/health", response_model=Health, tags=["system"])
    def health(request: Request) -> Health:
        current_worker: InferenceWorker = request.app.state.worker
        triton_ready = False
        if settings.triton_http_url:
            try:
                response = requests.get(
                    f"{settings.triton_http_url}/v2/models/{settings.triton_model_name}/ready",
                    timeout=1.0,
                )
                triton_ready = response.status_code == 200
            except requests.RequestException:
                triton_ready = False
        return Health(
            status=(
                "ok"
                if current_worker.alive
                and current_worker.last_error is None
                and (
                    not current_worker.adapter.configured
                    or current_worker.adapter.is_tier_available("fast")
                )
                and (not settings.triton_grpc_url or triton_ready)
                else "degraded"
            ),
            inference_configured=current_worker.adapter.configured,
            worker_alive=current_worker.alive,
            pacs_configured=request.app.state.orthanc.configured,
            dicom_enabled=settings.dicom_enabled,
            simulator_enabled=settings.simulator_enabled,
            inference_backend=(
                settings.inference_backend_label
                or ("triton-grpc" if settings.triton_grpc_url else "command")
            ),
            triton_configured=bool(settings.triton_grpc_url),
            triton_ready=triton_ready,
            triton_model=(
                f"{settings.triton_model_name}:{resolved_model_version('fast')}"
                if settings.triton_grpc_url
                else None
            ),
        )

    app.add_api_route(
        "/api/v1/health",
        health,
        methods=["GET"],
        response_model=Health,
        tags=["system"],
    )

    def standard_service_status() -> str:
        return "unavailable"

    def resolved_model_version(tier: str) -> str:
        if tier == "fast" and settings.triton_grpc_url:
            return mlops_store.get_runtime_setting("production_triton_version") or settings.triton_model_version
        if tier == "fast" and studio.releases.configured:
            live = studio.releases.live()
            if live:
                return live["tag"]
        return settings.get_tier_model_version(tier)

    def latest_resolved_study_job(identities: list[str]) -> Job | None:
        """Return the newest job produced by any currently configured tier."""
        candidates: list[Job] = []
        for tier in ("fast", "standard", "high"):
            for extension_enabled in (False,):
                job = store.find_latest_by_study(
                    identities,
                    resolved_model_version(tier),
                    tier=tier,
                    extension_enabled=extension_enabled,
                )
                if job:
                    candidates.append(job)
        return max(candidates, key=lambda value: value.updated_at) if candidates else None

    def automation_settings() -> dict:
        enabled = (mlops_store.get_runtime_setting("auto_analyze_ct") or "false").lower() == "true"
        stored_tier = mlops_store.get_runtime_setting("auto_analyze_tier") or "fast"
        tier = stored_tier if stored_tier in {item.value for item in InferenceTier} else "fast"
        extension_enabled = False
        return {
            "auto_analyze_ct": enabled,
            "inference_tier": tier,
            "extension_enabled": extension_enabled,
            "model_version": resolved_model_version(tier),
            "model_available": settings.is_tier_available(tier),
            "sources": ["ct_simulator", "dicom_upload", "nifti_upload"],
        }

    def maybe_auto_analyze_case(case: AnnotationCase) -> Job | None:
        policy = automation_settings()
        tier = policy["inference_tier"]
        if not policy["auto_analyze_ct"] or not settings.is_tier_available(tier):
            return None
        source_path = annotation_store.get_source_path(case.id)
        if not source_path or not source_path.is_file():
            return None
        job_id = str(uuid.uuid4())
        job_dir = jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        job_input = job_dir / "input.nii.gz"
        shutil.copy2(source_path, job_input)
        job_output = job_dir / "mask.nii.gz"
        identity = f"series:{case.series_instance_uid}" if case.series_instance_uid else f"case:{case.id}"
        job, created = store.create_or_get_active(
            job_id,
            f"Auto CT ingestion · {case.name}",
            "dicom",
            job_input.stat().st_size,
            job_input,
            job_output,
            study_id=identity,
            model_version=resolved_model_version(tier),
            inference_tier=tier,
            extension_enabled=bool(policy["extension_enabled"]),
        )
        if created:
            worker.notify()
        else:
            shutil.rmtree(job_dir, ignore_errors=True)
        return job

    @app.get("/api/v1/mlops/automation", tags=["mlops"])
    def get_automation_settings() -> dict:
        return automation_settings()

    @app.put("/api/v1/mlops/automation", tags=["mlops"])
    def update_automation_settings(request: Request, payload: AutomationSettingsUpdate) -> dict:
        reviewer = require_model_manager(request)
        if payload.extension_enabled:
            raise HTTPException(422, "Model extension is unavailable in this public release.")
        if payload.auto_analyze_ct and not settings.is_tier_available(payload.inference_tier.value):
            raise HTTPException(
                status_code=422,
                detail=f"Model tier '{payload.inference_tier.value}' is unavailable",
            )
        mlops_store.set_runtime_setting("auto_analyze_ct", str(payload.auto_analyze_ct).lower())
        mlops_store.set_runtime_setting("auto_analyze_tier", payload.inference_tier.value)
        mlops_store.set_runtime_setting("auto_analyze_extension", "false")
        return {**automation_settings(), "updated_by": reviewer}

    @app.post("/api/v1/reviewer/verify")
    def verify_reviewer(request: Request):
        return {"reviewer": reviewer_auth.verify(request)}

    @app.get("/api/v1/capabilities", response_model=Capabilities, tags=["system"])
    @app.get("/api/v1/inference/capabilities", response_model=Capabilities, tags=["system"])
    def get_capabilities() -> Capabilities:
        standard_status = standard_service_status()
        fast_available = worker.adapter.is_tier_available("fast")
        if settings.triton_grpc_url:
            try:
                ready_response = requests.get(
                    f"{settings.triton_http_url}/v2/models/{settings.triton_model_name}/ready",
                    timeout=1.0,
                )
                fast_available = fast_available and ready_response.status_code == 200
            except requests.RequestException:
                fast_available = False
        return Capabilities(
            direct_upload_enabled=settings.direct_upload_enabled,
            dicom_enabled=settings.dicom_enabled,
            simulator_enabled=settings.simulator_enabled,
            default_tier=automation_settings()["inference_tier"],
            checked_at=datetime.now(timezone.utc),
            reviewer_auth_configured=reviewer_auth.configured,
            medsam2_available=sam2_propagator.ready,
            tiers={
                "fast": TierCapability(
                    tier="fast",
                    name="Baseline S",
                    description="Baseline S",
                    available=fast_available,
                    model_version=resolved_model_version("fast"),
                    command_configured=worker.adapter.is_tier_configured("fast"),
                    service_status="connected" if fast_available else "offline",
                ),
                "standard": TierCapability(
                    tier="standard",
                    name="M",
                    description="Reserved model slot",
                    available=False,
                    service_status=standard_status,
                    model_version=settings.model_standard_version,
                    command_configured=False,
                ),
                "high": TierCapability(
                    tier="high",
                    name="L",
                    description="Reserved model slot",
                    available=False,
                    model_version=settings.model_high_version,
                    command_configured=False,
                ),
            },
        )


    @app.post(
        "/api/v1/simulator/acquisitions",
        status_code=status.HTTP_201_CREATED,
        tags=["simulator"],
    )
    async def simulate_acquisition(
        request: Request,
        file: UploadFile = File(...),
        patient_id: str = Form("ANON-SIM-001"),
    ) -> dict:
        if not settings.simulator_enabled:
            raise HTTPException(status_code=404, detail="CT simulator is disabled")
        has_pacs_receiver = bool(
            settings.dicom_enabled and request.app.state.orthanc.configured
        )
        if not has_pacs_receiver and not settings.direct_upload_enabled:
            raise HTTPException(
                status_code=503,
                detail="PACS is unavailable and the local DICOM gateway is disabled",
            )
        patient_id = patient_id.strip().upper()
        if not re.fullmatch(r"ANON-[A-Z0-9-]{1,32}", patient_id):
            raise HTTPException(
                status_code=422,
                detail="Simulator patient ID must be anonymized and start with ANON-",
            )
        try:
            filename = validate_nifti_filename(file.filename)
        except InvalidNifti as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        acquisition_id = str(uuid.uuid4())
        suffix = ".nii.gz" if filename.lower().endswith(".nii.gz") else ".nii"
        acquisition_dir = settings.data_dir / "simulator" / acquisition_id
        input_path = acquisition_dir / f"source{suffix}"
        dicom_dir = acquisition_dir / "dicom"
        try:
            size = await _save_upload(file, input_path, settings.max_upload_bytes)
            validate_nifti_header(input_path)
            generated = nifti_to_ct_series(
                input_path,
                dicom_dir,
                patient_id=patient_id,
                patient_name="ANONYMOUS^SIMULATOR",
            )
            annotation_case_id = None
            case_reused = False
            auto_job = None
            if has_pacs_receiver:
                send_c_store(
                    dicom_dir,
                    host=settings.pacs_dicom_host,
                    port=settings.pacs_dicom_port,
                    calling_aet=settings.simulator_calling_aet,
                    called_aet=settings.pacs_called_aet,
                )
            if not has_pacs_receiver or automation_settings()["auto_analyze_ct"]:
                # Development/review deployments often have no Orthanc process.
                # Still exercise modality conversion and register the acquisition
                # through the same local gateway used by the clinical worklist.
                simulated_case, was_created = annotation_store.create_case(
                    case_id=acquisition_id,
                    name=f"{patient_id} · CT Head Without Contrast",
                    source_file_path=input_path,
                    study_instance_uid=generated["study_instance_uid"],
                    series_instance_uid=generated["series_instance_uid"],
                    source_type="ct_simulator",
                    patient_id=patient_id,
                    patient_name="ANONYMOUS SIMULATOR",
                    study_date=datetime.now(timezone.utc).strftime("%Y%m%d"),
                    study_description="CT Head Without Contrast",
                    accession_number=generated["accession_number"],
                    priority="routine",
                    clinical_indication="Acquisition generated by CT modality simulator",
                    deduplicate=False,
                )
                annotation_case_id = simulated_case.id
                case_reused = not was_created
                auto_job = maybe_auto_analyze_case(simulated_case)
        except InvalidNifti as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            raise HTTPException(status_code=502, detail=f"DICOM C-STORE failed: {exc}") from exc
        finally:
            shutil.rmtree(acquisition_dir, ignore_errors=True)
        return {
            "status": "stored",
            "acquisition_id": acquisition_id,
            "source_filename": filename,
            "source_size_bytes": size,
            "patient_id": patient_id,
            "patient_name": "ANONYMOUS^SIMULATOR",
            "study_instance_uid": generated["study_instance_uid"],
            "series_instance_uid": generated["series_instance_uid"],
            "accession_number": generated["accession_number"],
            "instances_sent": generated["slices"],
            "rows": generated["rows"],
            "columns": generated["columns"],
            "calling_aet": settings.simulator_calling_aet,
            "called_aet": settings.pacs_called_aet,
            "destination": (
                f"{settings.pacs_dicom_host}:{settings.pacs_dicom_port}"
                if has_pacs_receiver
                else "local://brainhem-dicom-gateway"
            ),
            "transmission_mode": "dimse_c_store" if has_pacs_receiver else "local_dicom_gateway",
            "annotation_case_id": annotation_case_id,
            "case_reused": case_reused,
            "auto_inference": (
                {
                    "job_id": auto_job.id,
                    "status": auto_job.status.value,
                    "tier": auto_job.inference_tier,
                    "model_version": auto_job.model_version,
                }
                if auto_job
                else None
            ),
        }

    @app.post(
        "/api/v1/jobs",
        response_model=Job,
        status_code=status.HTTP_202_ACCEPTED,
        tags=["inference"],
    )
    async def create_job(
        request: Request,
        file: UploadFile = File(...),
        input_type: str = Form("nifti"),
        tier: InferenceTier | None = Form(None),
    ) -> Job:
        tier = tier or InferenceTier(automation_settings()["inference_tier"])
        authorize_model_choice(request, tier.value)
        if not settings.direct_upload_enabled:
            raise HTTPException(
                status_code=404,
                detail="Direct upload is disabled; studies must enter through PACS",
            )
        if input_type.lower() not in {"nifti", "nii"}:
            raise HTTPException(
                status_code=422,
                detail="input_type must be 'nifti' for this MVP endpoint",
            )
        try:
            filename = validate_nifti_filename(file.filename)
        except InvalidNifti as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        job_id = str(uuid.uuid4())
        suffix = ".nii.gz" if filename.lower().endswith(".nii.gz") else ".nii"
        job_dir = jobs_dir / job_id
        input_path = job_dir / f"input{suffix}"
        output_path = job_dir / "mask.nii.gz"
        try:
            size = await _save_upload(file, input_path, settings.max_upload_bytes)
            validate_nifti_header(input_path)
        except InvalidNifti as exc:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        resolved_version = resolved_model_version(tier.value)
        job = store.create(
            job_id,
            filename,
            input_type.lower(),
            size,
            input_path,
            output_path,
            model_version=resolved_version,
            inference_tier=tier.value,
        )
        request.app.state.worker.notify()
        return job


    @app.get("/api/v1/jobs", response_model=JobList, tags=["inference"])
    def list_jobs(
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0),
        job_status: JobStatus | None = Query(None, alias="status"),
    ) -> JobList:
        items, count = store.list(limit, offset, job_status)
        return JobList(items=items, count=count, limit=limit, offset=offset)

    @app.get("/api/v1/jobs/{job_id}", response_model=Job, tags=["inference"])
    def get_job(job_id: str) -> Job:
        job = store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @app.post("/api/v1/jobs/{job_id}/review", response_model=Job, tags=["review"])
    def review_job(request: Request, job_id: str, payload: ReviewRequest) -> Job:
        decision = payload.decision.strip().lower()
        if decision not in {"accepted", "rejected"}:
            raise HTTPException(status_code=422, detail="decision must be accepted or rejected")
        reviewer = reviewer_auth.verify(request)
        job = store.review(
            job_id,
            decision,
            reviewer[:120],
            payload.note.strip()[:2000],
            payload.expected_reviewed_at,
        )
        if not job:
            current = store.get(job_id)
            if not current:
                raise HTTPException(status_code=404, detail="Job not found")
            if current.status != JobStatus.succeeded:
                raise HTTPException(status_code=409, detail="Only a completed job can be reviewed")
            raise HTTPException(
                status_code=409,
                detail="Kết quả đã được người khác đánh giá. Hãy tải lại trước khi thay đổi quyết định.",
            )
        return job

    @app.get("/api/v1/jobs/{job_id}/result", tags=["inference"])
    def get_result(job_id: str) -> FileResponse:
        return _result_response(job_id)

    @app.get(
        "/api/v1/jobs/{job_id}/artifacts/{kind}",
        tags=["inference"],
    )
    def get_artifact(job_id: str, kind: str) -> FileResponse:
        if kind not in {"mask", "source", "dicom-seg", "metadata", "probability"}:
            raise HTTPException(status_code=404, detail="Artifact not found")
        if kind == "mask":
            return _result_response(job_id)
        job = store.get(job_id)
        paths = store.get_paths(job_id)
        if not job or not paths:
            raise HTTPException(status_code=404, detail="Artifact not found")
        if kind == "source":
            candidate = paths[0]
        elif kind == "metadata":
            candidate = paths[1].parent / "inference-metadata.json"
        elif kind == "probability":
            candidate = paths[1].parent / "probability.nii.gz"
        else:
            candidate = paths[1].parent / "segmentation.dcm"
        if not candidate.is_file():
            raise HTTPException(status_code=410, detail="Artifact is unavailable")
        return FileResponse(
            candidate,
            media_type=(
                "application/dicom" if kind == "dicom-seg"
                else "application/json" if kind == "metadata"
                else "application/gzip"
            ),
            filename=(
                "brainhem-segmentation.dcm" if kind == "dicom-seg"
                else "inference-metadata.json" if kind == "metadata"
                else "brainhem-probability.nii.gz" if kind == "probability"
                else "source-ct.nii.gz"
            ),
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.head(
        "/api/v1/jobs/{job_id}/artifacts/{kind}",
        include_in_schema=False,
    )
    def head_artifact(job_id: str, kind: str) -> FileResponse:
        return get_artifact(job_id, kind)

    def _result_response(job_id: str) -> FileResponse:
        job = store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.status != JobStatus.succeeded:
            raise HTTPException(status_code=409, detail="Result is not ready")
        paths = store.get_paths(job_id)
        if not paths or not paths[1].is_file():
            raise HTTPException(status_code=410, detail="Result file is unavailable")
        return FileResponse(
            paths[1],
            media_type="application/gzip",
            filename=f"{job_id}_mask.nii.gz",
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/v1/studies", tags=["dicom"])
    def list_studies(request: Request, limit: int = Query(50, ge=1, le=100)) -> dict:
        if not settings.dicom_enabled or not request.app.state.orthanc.configured:
            raise HTTPException(status_code=503, detail="PACS integration is disabled")
        try:
            items = request.app.state.orthanc.list_studies(limit)
            for item in items:
                cached = latest_resolved_study_job(
                    [item.get("study_instance_uid", ""), item.get("orthanc_id", "")]
                )
                item.update(
                    {
                        "ai_status": cached.status.value if cached else "not_analyzed",
                        "ai_job_id": cached.id if cached else None,
                        "ai_review_decision": cached.review.get("decision") if cached else None,
                        "ai_model_version": cached.model_version if cached else None,
                    }
                )
        except OrthancError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"items": items, "count": len(items)}

    @app.post(
        "/api/v1/dicom/studies/{study_id}/analyze",
        response_model=Job,
        status_code=status.HTTP_202_ACCEPTED,
        tags=["dicom"],
    )
    def analyze_dicom_study(
        request: Request,
        response: Response,
        study_id: str,
        force: bool = Query(False, description="Explicit administrator-only reprocessing"),
        tier: InferenceTier | None = Query(None),
    ) -> Job:
        tier = tier or InferenceTier(automation_settings()["inference_tier"])
        authorize_model_choice(request, tier.value)
        if force:
            require_model_manager(request)
        if not settings.dicom_enabled or not request.app.state.orthanc.configured:
            raise HTTPException(status_code=503, detail="PACS integration is disabled")
        if force and not settings.allow_force_reprocess:
            raise HTTPException(status_code=403, detail="Forced reprocessing is disabled")
        try:
            study = request.app.state.orthanc.get_study_summary(study_id)
        except OrthancError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        study_uid = study.get("study_instance_uid", "")
        if not study_uid:
            raise HTTPException(status_code=422, detail="StudyInstanceUID is missing")
        resolved_version = resolved_model_version(tier.value)
        if not force:
            cached = store.find_latest_by_study(
                [study_uid, study_id], resolved_version, tier=tier.value
            )
            if cached:
                if cached.study_id != study_uid:
                    cached = store.bind_study_identity(
                        cached.id, study_uid, resolved_version
                    ) or cached
                if cached.status == JobStatus.succeeded:
                    response.status_code = status.HTTP_200_OK
                return cached
        job_id = str(uuid.uuid4())
        job_dir = jobs_dir / job_id
        dicom_dir = job_dir / "source-dicom"
        input_path = job_dir / "input.nii.gz"
        output_path = job_dir / "mask.nii.gz"
        try:
            candidate = request.app.state.orthanc.select_series(study_id)
            request.app.state.orthanc.download_series(candidate.orthanc_id, dicom_dir)
            dicom_series_to_nifti(
                dicom_dir, candidate.series_instance_uid, input_path
            )
            validate_nifti_header(input_path)
            (job_dir / "dicom-source.json").write_text(
                json.dumps(
                    {
                        "orthanc_study_id": study_id,
                        "study_instance_uid": study_uid,
                        "orthanc_series_id": candidate.orthanc_id,
                        "series_instance_uid": candidate.series_instance_uid,
                        "series_description": candidate.description,
                        "selection_score": candidate.score,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        except (OrthancError, ValueError, InvalidNifti) as exc:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        create_args = (
            job_id,
            f"DICOM study {study_id}",
            "dicom",
            input_path.stat().st_size,
            input_path,
            output_path,
        )
        if force:
            job = store.create(
                *create_args,
                study_id=study_uid,
                model_version=resolved_version,
                inference_tier=tier.value,
            )
            created = True
        else:
            job, created = store.create_or_get_active(
                *create_args,
                study_id=study_uid,
                model_version=resolved_version,
                inference_tier=tier.value,
            )
        if not created:
            shutil.rmtree(job_dir, ignore_errors=True)
            if job.status == JobStatus.succeeded:
                response.status_code = status.HTTP_200_OK
        else:
            request.app.state.worker.notify()
        return job

    # -------------------------------------------------------------------------
    # Annotation Branch Endpoints
    # -------------------------------------------------------------------------

    def attach_case_inference(case: AnnotationCase) -> AnnotationCase:
        # Match a specific CT/series, never a whole study containing several series.
        identities = [f"case:{case.id}"]
        if case.series_instance_uid:
            identities.append(f"series:{case.series_instance_uid}")
        if case.source_digest:
            identities.append(f"digest:{case.source_digest}")
        candidates = []
        for tier in ("standard", "fast", "high"):
            for extension_enabled in (False,):
                job = store.find_latest_by_study(
                    identities,
                    resolved_model_version(tier),
                    tier=tier,
                    extension_enabled=extension_enabled,
                )
                if job:
                    candidates.append(job)
        if case.source_job_id:
            job = store.get(case.source_job_id)
            if job:
                candidates.append(job)
        if candidates:
            job = max(candidates, key=lambda value: value.updated_at)
            case.ai_status, case.ai_job_id, case.ai_tier = job.status.value, job.id, job.inference_tier
            case.ai_model_version = job.model_version
        else:
            # Jobs expire independently of annotation revisions. An original AI
            # seed remains usable even after its transient job row is removed.
            seed = annotation_store.retained_ai_seed(case.id)
            if seed:
                case.ai_status = "archived"
                case.ai_tier = seed.seed_tier
                case.ai_model_version = seed.seed_model_version
                case.ai_seed_job_id = seed.seed_job_id
                case.ai_mask_url = seed.mask_url
                case.ai_volume_ml = seed.volume_ml
                case.ai_result_at = seed.created_at
        return case

    @app.post(
        "/api/v1/annotations/cases/dicom-upload",
        response_model=AnnotationCase,
        status_code=status.HTTP_201_CREATED,
        tags=["dicom", "annotations"],
    )
    async def upload_dicom_case(
        request: Request,
        response: Response,
        files: list[UploadFile] = File(...),
        case_name: str | None = Form(None),
        priority: str = Form("routine"),
        clinical_indication: str = Form(""),
    ) -> AnnotationCase:
        """Ingest one exported DICOM study without requiring a hospital PACS."""
        if not settings.direct_upload_enabled:
            raise HTTPException(status_code=403, detail="Direct upload is disabled")
        priority = priority.strip().lower()
        if priority not in {"routine", "urgent", "stat"}:
            raise HTTPException(status_code=422, detail="priority must be routine, urgent, or stat")
        if not files:
            raise HTTPException(status_code=422, detail="No DICOM files were supplied")

        case_id = str(uuid.uuid4())
        temp_dir = settings.data_dir / "tmp" / f"dicom-upload-{case_id}"
        upload_dir = temp_dir / "dicom"
        input_path = temp_dir / "input.nii.gz"
        total_size = 0
        try:
            original_names = [str(upload.filename or "") for upload in files]
            if len(files) == 1 and original_names[0].lower().endswith((".nii", ".nii.gz")):
                filename = validate_nifti_filename(original_names[0])
                suffix = ".nii.gz" if filename.lower().endswith(".nii.gz") else ".nii"
                nifti_input = temp_dir / f"uploaded{suffix}"
                await _save_upload(files[0], nifti_input, settings.max_upload_bytes)
                validate_nifti_header(nifti_input)
                display_name = (case_name or "").strip() or Path(filename).name.removesuffix(".gz").removesuffix(".nii")
                case, was_created = annotation_store.create_case(
                    case_id=case_id,
                    name=display_name[:180],
                    source_file_path=nifti_input,
                    source_type="nifti_upload",
                    priority=priority,
                    clinical_indication=clinical_indication.strip()[:1000],
                )
                response.headers["X-Annotation-Reused"] = "false" if was_created else "true"
                maybe_auto_analyze_case(case)
                return attach_case_inference(case)

            upload_dir.mkdir(parents=True, exist_ok=False)
            is_zip = len(files) == 1 and original_names[0].lower().endswith(".zip")
            if is_zip:
                archive_path = temp_dir / "study.zip"
                await _save_upload(files[0], archive_path, settings.max_upload_bytes)
                try:
                    with zipfile.ZipFile(archive_path) as archive:
                        members = [member for member in archive.infolist() if not member.is_dir()]
                        expanded_size = sum(member.file_size for member in members)
                        if expanded_size > settings.max_upload_bytes:
                            raise HTTPException(
                                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                                detail="Nội dung ZIP vượt quá giới hạn tải lên",
                            )
                        for member in members:
                            relative = Path(member.filename)
                            if relative.is_absolute() or ".." in relative.parts:
                                raise HTTPException(status_code=422, detail="ZIP chứa đường dẫn không an toàn")
                            destination = upload_dir / relative
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            with archive.open(member) as source, destination.open("wb") as output:
                                shutil.copyfileobj(source, output)
                except zipfile.BadZipFile as exc:
                    raise HTTPException(status_code=422, detail="File ZIP không hợp lệ") from exc
            for index, upload in enumerate([] if is_zip else files):
                remaining = settings.max_upload_bytes - total_size
                if remaining <= 0:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Upload exceeds the {settings.max_upload_bytes}-byte limit",
                    )
                total_size += await _save_upload(
                    upload, upload_dir / f"instance-{index:06d}.dcm", remaining
                )

            candidate, metadata = inspect_uploaded_dicom(upload_dir)
            dicom_series_to_nifti(upload_dir, candidate.series_instance_uid, input_path)
            validate_nifti_header(input_path)
            display_name = (case_name or "").strip()
            if not display_name:
                patient = metadata["patient_name"].replace("^", " ").strip()
                description = metadata["study_description"] or candidate.description or "CT Head"
                display_name = f"{patient or metadata['patient_id'] or 'DICOM'} · {description}"
            case, was_created = annotation_store.create_case(
                case_id=case_id,
                name=display_name[:180],
                source_file_path=input_path,
                study_instance_uid=metadata["study_instance_uid"],
                series_instance_uid=metadata["series_instance_uid"],
                source_type="dicom_upload",
                patient_id=metadata["patient_id"] or None,
                patient_name=metadata["patient_name"].replace("^", " ") or None,
                study_date=metadata["study_date"] or None,
                study_description=metadata["study_description"] or candidate.description or None,
                accession_number=metadata["accession_number"] or None,
                priority=priority,
                clinical_indication=clinical_indication.strip()[:1000],
            )
            response.headers["X-Annotation-Reused"] = "false" if was_created else "true"
            maybe_auto_analyze_case(case)
            return attach_case_inference(case)
        except HTTPException:
            raise
        except (OrthancError, ValueError, InvalidNifti) as exc:
            message = str(exc)
            if "Không tìm thấy ảnh DICOM" in message:
                message += ". Hãy chọn một file .nii/.nii.gz, một ZIP DICOM, hoặc toàn bộ thư mục ảnh của đúng một Study."
            raise HTTPException(status_code=422, detail=message) from exc
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @app.get(
        "/api/v1/annotations/cases",
        response_model=AnnotationCaseList,
        tags=["annotations"],
    )
    def list_annotation_cases(
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0),
        status_filter: str | None = Query(None, alias="status"),
    ) -> AnnotationCaseList:

        items, count = annotation_store.list_cases(limit, offset, status_filter)
        items = [attach_case_inference(item) for item in items]
        return AnnotationCaseList(items=items, count=count, limit=limit, offset=offset)

    @app.post(
        "/api/v1/annotations/cases",
        response_model=AnnotationCase,
        status_code=status.HTTP_201_CREATED,
        tags=["annotations"],
    )
    async def create_annotation_case(
        request: Request,
        response: Response,
        name: str | None = Form(None),
        study_id: str | None = Form(None),
        job_id: str | None = Form(None),
        file: UploadFile | None = File(None),
    ) -> AnnotationCase:
        case_id = str(uuid.uuid4())
        study_uid = None
        series_uid = None
        source_job_id = None
        temp_input = None

        if file:
            if not settings.direct_upload_enabled:
                raise HTTPException(
                    status_code=403,
                    detail="Local NIfTI upload is disabled on this server",
                )
            try:
                filename = validate_nifti_filename(file.filename)
            except InvalidNifti as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            temp_dir = settings.data_dir / "tmp" / case_id
            temp_dir.mkdir(parents=True, exist_ok=True)
            temp_input = temp_dir / filename
            await _save_upload(file, temp_input, settings.max_upload_bytes)
            case_name = name.strip() if name else filename
        elif job_id:
            job = store.get(job_id)
            if not job:
                raise HTTPException(status_code=404, detail="Job not found")
            paths = store.get_paths(job_id)
            if not paths or not paths[0].is_file():
                raise HTTPException(status_code=410, detail="Job source artifact is unavailable")
            temp_input = paths[0]
            source_job_id = job.id
            study_uid = job.study_id
            job_dicom_meta = paths[0].parent / "dicom-source.json"
            if job_dicom_meta.is_file():
                try:
                    d_meta = json.loads(job_dicom_meta.read_text(encoding="utf-8"))
                    study_uid = d_meta.get("study_instance_uid") or study_uid
                    series_uid = d_meta.get("series_instance_uid") or series_uid
                except Exception:
                    pass
            case_name = name.strip() if name else f"Ca từ Job {job.id[:8]}"
        elif study_id:
            if not settings.dicom_enabled or not request.app.state.orthanc.configured:
                raise HTTPException(status_code=503, detail="PACS integration is disabled")
            try:
                study = request.app.state.orthanc.get_study_summary(study_id)
                candidate = request.app.state.orthanc.select_series(study_id)
            except OrthancError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            study_uid = study.get("study_instance_uid", "")
            series_uid = candidate.series_instance_uid
            temp_dir = settings.data_dir / "tmp" / case_id
            dicom_dir = temp_dir / "dicom"
            temp_input = temp_dir / "input.nii.gz"
            try:
                request.app.state.orthanc.download_series(candidate.orthanc_id, dicom_dir)
                dicom_series_to_nifti(dicom_dir, series_uid, temp_input)
            except Exception as exc:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise HTTPException(status_code=422, detail=f"Failed to convert DICOM series: {exc}") from exc
            patient_name = study.get("patient_name") or "ANONYMOUS"
            case_name = name.strip() if name else f"PACS {patient_name} ({study_id[:8]})"
        else:
            raise HTTPException(
                status_code=422,
                detail="Must provide study_id, job_id, or upload a NIfTI file",
            )

        try:
            case, was_created = annotation_store.create_case(
                case_id=case_id,
                name=case_name,
                source_file_path=temp_input,
                study_instance_uid=study_uid,
                series_instance_uid=series_uid,
                source_job_id=source_job_id,
            )
            # Only auto-seed brand-new revision-zero case. Opening existing case must not append/overwrite doctor draft!
            if was_created and case.current_revision == 0 and job_id and job and job.status == JobStatus.succeeded and len(paths) > 1 and paths[1].is_file():
                try:
                    annotation_store.save_revision(
                        case_id=case.id,
                        mask_file_path=paths[1],
                        status="draft",
                        expected_revision=0,
                        reviewer=f"AI-Seed ({job.inference_tier})",
                        notes=f"Tự động nạp kết quả từ tác vụ {job.id}",
                        seed_job_id=job.id,
                        seed_tier=job.inference_tier,
                        seed_model_version=job.model_version,
                    )
                    updated_case = annotation_store.get_case(case.id)
                    if updated_case:
                        case = updated_case
                except Exception:
                    pass
        except InvalidNifti as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        finally:
            if file or study_id:
                shutil.rmtree(settings.data_dir / "tmp" / case_id, ignore_errors=True)

        response.headers["X-Annotation-Reused"] = "false" if was_created else "true"
        return case

    @app.get(
        "/api/v1/annotations/cases/{case_id}",
        response_model=AnnotationCase,
        tags=["annotations"],
    )
    def get_annotation_case(case_id: str) -> AnnotationCase:
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")
        return attach_case_inference(case)

    @app.get(
        "/api/v1/annotations/cases/{case_id}/thumbnail",
        tags=["annotations"],
    )
    def get_annotation_case_thumbnail(case_id: str) -> Response:
        """A lightweight axial preview for the unified case library."""
        path = annotation_store.get_source_path(case_id)
        if not path or not path.is_file():
            raise HTTPException(status_code=404, detail="Source artifact not found")
        try:
            content = _annotation_case_thumbnail(path)
        except (InvalidNifti, OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=f"Cannot render CT preview: {exc}") from exc
        return Response(
            content=content,
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"},
        )

    @app.get(
        "/api/v1/annotations/cases/{case_id}/source",
        tags=["annotations"],
    )
    def get_annotation_source(case_id: str) -> FileResponse:
        path = annotation_store.get_source_path(case_id)
        if not path or not path.is_file():
            raise HTTPException(status_code=404, detail="Source artifact not found")
        return FileResponse(
            path,
            media_type="application/gzip",
            filename=f"{case_id}_source.nii.gz",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get(
        "/api/v1/annotations/cases/{case_id}/revisions",
        response_model=AnnotationRevisionList,
        tags=["annotations"],
    )
    def list_annotation_revisions(case_id: str) -> AnnotationRevisionList:
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")
        items = annotation_store.list_revisions(case_id)
        return AnnotationRevisionList(items=items, count=len(items))

    @app.get(
        "/api/v1/annotations/cases/{case_id}/revisions/{rev_num}/mask",
        tags=["annotations"],
    )
    def get_annotation_revision_mask(case_id: str, rev_num: int) -> FileResponse:
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")
        path = annotation_store.get_revision_mask_path(case_id, rev_num)
        if not path or not path.is_file():
            raise HTTPException(status_code=404, detail="Revision mask artifact not found")
        return FileResponse(
            path,
            media_type="application/gzip",
            filename=f"{case_id}_rev{rev_num}_mask.nii.gz",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.get("/api/v1/annotations/cases/{case_id}/operations/{operation_id}", response_model=AnnotationRevision, tags=["annotations"])
    def saved_operation(request: Request, case_id: str, operation_id: str):
        reviewer = reviewer_auth.verify(request)
        revision = annotation_store.operation_revision(case_id, reviewer, operation_id)
        if not revision:
            raise HTTPException(status_code=404, detail="Save operation not found")
        return revision

    @app.post(
        "/api/v1/annotations/cases/{case_id}/revisions",
        response_model=AnnotationRevision,
        status_code=status.HTTP_201_CREATED,
        tags=["annotations"],
    )
    async def save_annotation_revision(
        request: Request,
        case_id: str,
        file: UploadFile = File(...),
        status: str = Form("draft"),
        expected_revision: int = Form(...),
        reviewer: str = Form("demo-radiologist"),
        notes: str = Form(""),
        reviewed_entire_volume: bool = Form(False),
        clear_provenance: bool = Form(False),
        base_revision: int | None = Form(None),
        seed_job_id: str | None = Form(None),
        seed_tier: str | None = Form(None),
        operation_id: str | None = Form(None),
    ) -> AnnotationRevision:
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")

        try:
            filename = validate_nifti_filename(file.filename)
        except InvalidNifti as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        norm_status = status.strip().lower()
        if norm_status not in ("draft", "approved"):
            raise HTTPException(status_code=422, detail="Status must be 'draft' or 'approved'")

        # Draft labels are clinical training data too: attribution must never
        # come from an untrusted form field.
        require(request, "label.approve" if norm_status == "approved" else "label.edit")
        reviewer = reviewer_auth.verify(request)

        # Validate seed_job_id server-side if supplied
        verified_seed_model_version = None
        verified_seed_tier = None
        if seed_job_id:
            s_job = store.get(seed_job_id)
            if not s_job:
                raise HTTPException(status_code=422, detail=f"Referenced seed job '{seed_job_id}' not found")
            if s_job.status != JobStatus.succeeded:
                raise HTTPException(status_code=422, detail=f"Referenced seed job '{seed_job_id}' did not succeed")
            s_paths = store.get_paths(seed_job_id)
            if not s_paths or not s_paths[0].is_file():
                raise HTTPException(status_code=422, detail=f"Seed job '{seed_job_id}' source CT unavailable")
            src_p = annotation_store.get_source_path(case_id)
            if src_p and src_p.is_file():
                if compute_canonical_nifti_digest(src_p) != compute_canonical_nifti_digest(s_paths[0]):
                    raise HTTPException(status_code=422, detail="Seed job CT does not match case CT")
            verified_seed_tier = s_job.inference_tier
            verified_seed_model_version = s_job.model_version

        temp_dir = settings.data_dir / "tmp" / f"rev-{uuid.uuid4()}"
        temp_dir.mkdir(parents=True, exist_ok=True)
        suffix = ".nii.gz" if filename.lower().endswith(".nii.gz") else ".nii"
        temp_mask = temp_dir / f"mask_upload{suffix}"
        try:
            await _save_upload(file, temp_mask, settings.max_upload_bytes)
            # This is a single-class editor. Canonicalize every finite positive
            # drawing value to foreground before validation so neither NiiVue's
            # temporary labels nor a stale browser bundle can leak into storage.
            source_path = annotation_store.get_source_path(case_id)
            if not source_path or not source_path.is_file():
                raise HTTPException(status_code=404, detail="Case source CT file not found")
            normalize_binary_annotation(temp_mask, source_path)
            revision = annotation_store.save_revision(
                case_id=case_id,
                operation_id=operation_id,
                mask_file_path=temp_mask,
                status=norm_status,
                expected_revision=expected_revision,
                reviewer=reviewer,
                notes=notes,
                reviewed_entire_volume=reviewed_entire_volume,
                clear_provenance=clear_provenance,
                base_revision=base_revision,
                seed_job_id=seed_job_id,
                seed_tier=verified_seed_tier,
                seed_model_version=verified_seed_model_version,
            )
            return revision
        except RevisionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (InvalidMaskError, InvalidNifti, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @app.post(
        "/api/v1/annotations/cases/{case_id}/seed",
        response_model=AnnotationRevision,
        status_code=status.HTTP_201_CREATED,
        tags=["annotations"],
    )
    def seed_annotation_from_job(
        request: Request,
        case_id: str,
        job_id: str = Form(...),
        expected_revision: int = Form(...),
        reviewer: str = Form("AI-Seed"),
    ) -> AnnotationRevision:
        authenticated_reviewer = reviewer_auth.verify(request)
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")
        job = store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.status != JobStatus.succeeded:
            raise HTTPException(status_code=409, detail=f"Cannot seed from job with status '{job.status.value}'")

        paths = store.get_paths(job_id)
        if not paths or not paths[1].is_file():
            raise HTTPException(status_code=410, detail="Job mask artifact unavailable")

        if job.study_id:
            if job.study_id.startswith("case:"):
                if job.study_id != f"case:{case.id}":
                    raise HTTPException(
                        status_code=422,
                        detail="Job belongs to a different annotation case",
                    )
            elif job.study_id.startswith("series:"):
                job_series_uid = job.study_id.removeprefix("series:")
                if case.series_instance_uid and case.series_instance_uid != job_series_uid:
                    raise HTTPException(
                        status_code=422,
                        detail="Job belongs to a different series than this case",
                    )
            else:
                job_dicom_meta = paths[0].parent / "dicom-source.json"
                if job_dicom_meta.is_file():
                    try:
                        d_meta = json.loads(job_dicom_meta.read_text(encoding="utf-8"))
                        j_study_uid = d_meta.get("study_instance_uid")
                        j_series_uid = d_meta.get("series_instance_uid")
                        if case.study_instance_uid and j_study_uid and case.study_instance_uid != j_study_uid:
                            raise HTTPException(
                                status_code=422,
                                detail="Job does not belong to the same study as this case",
                            )
                        if case.series_instance_uid and j_series_uid and case.series_instance_uid != j_series_uid:
                            raise HTTPException(
                                status_code=422,
                                detail="Job belongs to a different series than this case",
                            )
                    except json.JSONDecodeError:
                        pass
                elif case.study_instance_uid and case.study_instance_uid != job.study_id:
                    raise HTTPException(
                        status_code=422,
                        detail="Job does not belong to the same study or source as this case",
                    )

        source_path = annotation_store.get_source_path(case_id)
        if not source_path or not source_path.is_file():
            raise HTTPException(status_code=404, detail="Case source CT file not found")

        job_input_path = paths[0]
        if not job_input_path.is_file():
            raise HTTPException(status_code=410, detail="Job input CT artifact unavailable")

        case_digest = compute_canonical_nifti_digest(source_path)
        job_digest = compute_canonical_nifti_digest(job_input_path)
        if case_digest != job_digest:
            raise HTTPException(
                status_code=422,
                detail="Job source CT voxels/affine do not match this annotation case",
            )

        try:
            revision = annotation_store.save_revision(
                case_id=case_id,
                mask_file_path=paths[1],
                status="draft",
                expected_revision=expected_revision,
                reviewer=f"{authenticated_reviewer} · AI seed",
                notes=f"Seeded from AI job {job.id} (tier: {job.inference_tier})",
                seed_job_id=job.id,
                seed_tier=job.inference_tier,
                seed_model_version=job.model_version,
            )
            return revision
        except RevisionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (InvalidMaskError, InvalidNifti, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post(
        "/api/v1/annotations/cases/{case_id}/inference",
        response_model=Job,
        status_code=status.HTTP_202_ACCEPTED,
        tags=["annotations"],
    )
    def run_case_inference(
        request: Request,
        response: Response,
        case_id: str,
        tier: InferenceTier | None = Query(None, description="Inference tier; defaults to configured model"),
        extension: bool = Query(False, description="Reserved model extension; only false is supported"),
    ) -> Job:
        if extension or request.query_params.get("enhancement", "false").lower() in {"true", "1", "yes", "on"}:
            raise HTTPException(422, "Model extension is unavailable in this public release.")
        tier = tier or InferenceTier(automation_settings()["inference_tier"])
        authorize_model_choice(request, tier.value)
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")

        # A missing configuration cannot recover by waiting. A configured
        # runtime that is temporarily offline is handled by the worker queue.
        if not settings.get_tier_command(tier.value):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Inference tier '{tier.value}' is unavailable on this server.",
            )

        resolved_version = resolved_model_version(tier.value)

        # Check if case was created from an original linked job for this exact tier
        if case.source_job_id:
            src_job = store.get(case.source_job_id)
            if (
                src_job
                and src_job.status == JobStatus.succeeded
                and src_job.inference_tier == tier.value
                and src_job.model_version == resolved_version
                and src_job.extension_enabled == extension
            ):
                response.status_code = status.HTTP_200_OK
                return src_job

        # Cache lookup using series UID, case ID, or source digest (never study UID alone)
        identities = []
        if case.series_instance_uid:
            identities.append(f"series:{case.series_instance_uid}")
        identities.append(f"case:{case.id}")
        if case.source_digest:
            identities.append(f"digest:{case.source_digest}")

        cached = store.find_latest_by_study(
            identities, resolved_version, tier=tier.value, extension_enabled=extension
        )
        if cached:
            if cached.status == JobStatus.succeeded:
                response.status_code = status.HTTP_200_OK
            return cached

        # Configured but temporarily offline runtimes are retained by the worker
        # in service_wait. Permanently unconfigured tiers are rejected above.

        source_path = annotation_store.get_source_path(case_id)
        if not source_path or not source_path.is_file():
            raise HTTPException(status_code=404, detail="Case source CT file not found")

        job_id = str(uuid.uuid4())
        job_dir = jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        job_input = job_dir / "input.nii.gz"
        shutil.copy2(source_path, job_input)
        job_output = job_dir / "mask.nii.gz"
        if case.study_instance_uid or case.series_instance_uid:
            (job_dir / "dicom-source.json").write_text(
                json.dumps(
                    {
                        "study_instance_uid": case.study_instance_uid,
                        "series_instance_uid": case.series_instance_uid,
                        "case_id": case.id,
                    },
                    ensure_ascii=False,
                    indent=2,
                ) + "\n",
                encoding="utf-8",
            )

        study_id = f"series:{case.series_instance_uid}" if case.series_instance_uid else f"case:{case.id}"
        job, created = store.create_or_get_active(
            job_id,
            f"Annotation case {case.name}",
            "nifti",
            job_input.stat().st_size,
            job_input,
            job_output,
            study_id=study_id,
            model_version=resolved_version,
            inference_tier=tier.value,
            extension_enabled=extension,
        )
        if not created:
            shutil.rmtree(job_dir, ignore_errors=True)
            if job.status == JobStatus.succeeded:
                response.status_code = status.HTTP_200_OK
        else:
            request.app.state.worker.notify()
        return job

    @app.post(
        "/api/v1/annotations/cases/{case_id}/sam2-propagate",
        tags=["annotations"],
    )
    async def propagate_annotation_with_sam2(
        request: Request,
        case_id: str,
        file: UploadFile = File(...),
    ) -> Response:
        """Return a disposable MedSAM2 preview; this endpoint never saves a revision."""
        reviewer_auth.verify(request)
        case = annotation_store.get_case(case_id)
        if not case:
            raise HTTPException(status_code=404, detail="Annotation case not found")
        source_path = annotation_store.get_source_path(case_id)
        if not source_path or not source_path.is_file():
            raise HTTPException(status_code=404, detail="Case source CT file not found")
        propagator = request.app.state.sam2_propagator
        if not propagator.available:
            raise HTTPException(status_code=503, detail="MedSAM2 CT/RECIST is not configured")

        temp_dir = settings.data_dir / "tmp" / f"sam2-{uuid.uuid4()}"
        temp_dir.mkdir(parents=True, exist_ok=True)
        seed_path = temp_dir / "seed.nii.gz"
        output_path = temp_dir / "preview.nii.gz"
        try:
            await _save_upload(file, seed_path, settings.max_upload_bytes)
            normalize_binary_annotation(seed_path, source_path)
            validate_mask_against_source(source_path, seed_path)
            metadata = await asyncio.to_thread(
                propagator.predict, source_path, seed_path, output_path
            )
            return Response(
                content=output_path.read_bytes(),
                media_type="application/gzip",
                headers={
                    "Content-Disposition": f'attachment; filename="{case_id}_sam2_preview.nii.gz"',
                    "Cache-Control": "private, no-store",
                    "X-SAM2-Metadata": base64.b64encode(
                        json.dumps(metadata, separators=(",", ":")).encode("utf-8")
                    ).decode("ascii"),
                },
            )
        except Sam2Unavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (InvalidMaskError, InvalidNifti, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @app.get(
        "/api/v1/annotations/export",
        tags=["annotations"],
    )
    def export_annotations() -> FileResponse:
        export_dir = settings.data_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        snapshot_id = uuid.uuid4().hex[:12]
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        export_zip = export_dir / f"brainhem_reviewed_dataset_{timestamp}_{snapshot_id}.zip"
        try:
            result = annotation_store.export_dataset(export_zip)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if result["num_cases"] == 0:
            raise HTTPException(
                status_code=404,
                detail="No approved annotation cases found to export",
            )
        return FileResponse(
            export_zip,
            media_type="application/zip",
            filename="brainhem_reviewed_dataset.zip",
            headers={"Cache-Control": "private, no-store"},
        )

    # Controlled clinical-learning and MLOps lifecycle. These endpoints never
    # synthesize metrics or progress: external runners must produce signed-off
    # artifacts using the documented JSON contracts.
    def public_record(item: dict, *private_keys: str) -> dict:
        return {key: value for key, value in item.items() if key not in (*private_keys, "benchmark_path")}
    @app.get("/api/v1/learning/candidates", tags=["learning"])
    def list_learning_candidates(candidate_status: str | None = Query(None, alias="status")):
        return {"items": mlops_store.list_candidates(candidate_status)}

    @app.get("/api/v1/learning/candidates/{candidate_id}", tags=["learning"])
    def get_learning_candidate(candidate_id: str):
        item = mlops_store.get_candidate(candidate_id)
        if not item:
            raise HTTPException(status_code=404, detail="Learning candidate not found")
        return item

    @app.post("/api/v1/learning/candidates", status_code=201, tags=["learning"])
    def create_learning_candidate(request: Request, payload: LearningCandidateCreate):
        authenticated_actor = reviewer_auth.verify(request)
        job = store.get(payload.job_id)
        if not job or job.status != JobStatus.succeeded:
            raise HTTPException(status_code=409, detail="A completed inference job is required")
        paths = store.get_paths(job.id)
        if not paths or not paths[0].is_file():
            raise HTTPException(status_code=410, detail="Inference source CT is unavailable")
        case_id = str(uuid.uuid4())
        try:
            case, created = annotation_store.create_case(
                case_id=case_id,
                name=f"Learning · {job.original_filename}",
                source_file_path=paths[0],
                study_instance_uid=job.study_id if job.input_type == "dicom" else None,
                source_job_id=job.id,
                source_type="learning",
            )
            if created and paths[1].is_file():
                annotation_store.save_revision(
                    case.id, paths[1], "draft", 0, f"AI-Seed ({job.inference_tier})",
                    notes=f"Learning candidate from job {job.id}", seed_job_id=job.id,
                    seed_tier=job.inference_tier, seed_model_version=job.model_version,
                )
            return mlops_store.create_candidate(
                job=job, assessment=payload.assessment, reasons=payload.reasons,
                priority=payload.priority, note=payload.note, created_by=authenticated_actor,
                annotation_case_id=case.id,
            )
        except (WorkflowError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/v1/learning/candidates/{candidate_id}/transition", tags=["learning"])
    def transition_learning_candidate(request: Request, candidate_id: str, payload: LearningCandidateUpdate):
        authenticated_actor = reviewer_auth.verify(request)
        try:
            return mlops_store.update_candidate(candidate_id, payload.status, authenticated_actor,
                                                payload.annotation_case_id, payload.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Learning candidate not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/learning/candidates/{candidate_id}/reviews", status_code=201, tags=["learning"])
    def add_peer_review(request: Request, candidate_id: str, payload: PeerReviewCreate):
        authenticated_actor = reviewer_auth.verify(request)
        try:
            return mlops_store.add_review(candidate_id, authenticated_actor, payload.verdict,
                                          payload.diagnosis, payload.subtype, payload.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Learning candidate not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/learning/candidates/{candidate_id}/adjudicate", tags=["learning"])
    def adjudicate_candidate(request: Request, candidate_id: str, payload: AdjudicationRequest):
        authenticated_actor = reviewer_auth.verify(request)
        try:
            return mlops_store.adjudicate(candidate_id, payload.decision, authenticated_actor,
                                          payload.annotation_case_id, payload.revision_number, payload.note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Learning candidate not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/v1/mlops/capabilities", tags=["mlops"])
    def mlops_capabilities():
        return {"training_available": False,
                "training_unavailable_reason": TRAINING_UNAVAILABLE_REASON,
                "training_configured": bool(settings.training_command),
                "validation_configured": bool(settings.validation_command),
                "deployment_configured": bool(settings.deployment_command or triton_deployer.configured),
                "triton_deployment_configured": triton_deployer.configured,
                "local_auto_deploy_configured": studio.releases.configured,
                "local_auto_deploy_scope": "local_research",
                "worker_alive": training_worker.alive}

    @app.post("/api/v1/studio/runs/{run_id}/release", status_code=202, tags=["mlops"])
    def release_studio_run(request: Request, run_id: str):
        actor = require_model_manager(request)
        try:
            release = studio.releases.queue(run_id, actor)
            training_worker.notify()
            return public_record(release, "output_dir")
        except WorkflowError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/v1/mlops/hardware", tags=["mlops"])
    def mlops_hardware():
        """Live, read-only compute inventory for Model Studio operators."""
        memory = {}
        try:
            values = {}
            for line in Path("/proc/meminfo").read_text().splitlines():
                key, raw = line.split(":", 1)
                values[key] = int(raw.strip().split()[0]) * 1024
            total = values.get("MemTotal", 0)
            available = values.get("MemAvailable", 0)
            swap_total = values.get("SwapTotal", 0)
            swap_free = values.get("SwapFree", 0)
            memory = {"total_bytes": total, "used_bytes": max(0, total - available),
                      "available_bytes": available, "swap_total_bytes": swap_total,
                      "swap_used_bytes": max(0, swap_total - swap_free)}
        except (OSError, ValueError):
            memory = {"total_bytes": 0, "used_bytes": 0, "available_bytes": 0,
                      "swap_total_bytes": 0, "swap_used_bytes": 0}

        disk = shutil.disk_usage(settings.data_dir)
        gpus = []
        query = ("index,name,uuid,driver_version,memory.total,memory.used,memory.free,"
                 "utilization.gpu,temperature.gpu,power.draw,power.limit")
        try:
            result = subprocess.run(
                ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=4, check=True,
            )
            for row in result.stdout.splitlines():
                fields = [field.strip() for field in row.split(",")]
                if len(fields) == 11:
                    def number(value, integer=False):
                        try:
                            return int(float(value)) if integer else float(value)
                        except ValueError:
                            return None
                    gpus.append({"index": number(fields[0], True), "name": fields[1], "uuid": fields[2],
                                 "driver_version": fields[3], "memory_total_mb": number(fields[4], True),
                                 "memory_used_mb": number(fields[5], True), "memory_free_mb": number(fields[6], True),
                                 "utilization_percent": number(fields[7]), "temperature_c": number(fields[8]),
                                 "power_w": number(fields[9]), "power_limit_w": number(fields[10])})
        except (FileNotFoundError, subprocess.SubprocessError):
            pass

        torch_info = {"version": None, "cuda_version": None, "cuda_available": False,
                      "cudnn_version": None}
        try:
            import torch
            torch_info = {"version": torch.__version__, "cuda_version": torch.version.cuda,
                          "cuda_available": torch.cuda.is_available(),
                          "cudnn_version": torch.backends.cudnn.version()}
        except ImportError:
            pass
        try:
            monai_version = package_metadata.version("monai")
        except package_metadata.PackageNotFoundError:
            monai_version = None

        load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
        return {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "host": {"hostname": platform.node(), "os": platform.system(),
                     "os_release": platform.release(), "architecture": platform.machine(),
                     "python": platform.python_version()},
            "cpu": {"model": _cpu_model(), "logical_cores": os.cpu_count() or 0,
                    "load_1m": load[0], "load_5m": load[1], "load_15m": load[2]},
            "memory": memory,
            "storage": {"mount": str(settings.data_dir), "total_bytes": disk.total,
                        "used_bytes": disk.used, "free_bytes": disk.free},
            "gpus": gpus,
            "software": {"python": sys.version.split()[0], "pytorch": torch_info,
                         "monai": monai_version},
            "runtime": {"training_available": False,
                        "training_unavailable_reason": TRAINING_UNAVAILABLE_REASON,
                        "worker_alive": training_worker.alive,
                        "training_configured": bool(settings.training_command),
                        "validation_configured": bool(settings.validation_command)},
        }

    @app.get("/api/v1/studio", tags=["mlops"])
    def studio_catalog():
        catalog = studio.catalog()
        catalog["fine_tune_options"] = []
        catalog["training"].update(blocker=TRAINING_UNAVAILABLE_REASON, reason=TRAINING_UNAVAILABLE_REASON, due=False)
        return catalog

    @app.post("/api/v1/studio/sources", status_code=201, tags=["mlops"])
    def import_studio_source(request: Request, file: UploadFile = File(...), name: str = Form(...), role: str = Form("development")):
        reviewer_auth.verify(request)
        temp = studio.root / f"upload-{uuid.uuid4()}.zip"
        try:
            total = 0
            with temp.open("wb") as output:
                while chunk := file.file.read(1024 * 1024):
                    total += len(chunk)
                    if total > settings.max_upload_bytes:
                        raise HTTPException(413, "Dataset quá lớn; nhập dữ liệu local bằng script đăng ký nguồn")
                    output.write(chunk)
            item = studio.import_zip(temp, name, role)
            return {k: v for k, v in item.items() if k != "cases"}
        except (WorkflowError, zipfile.BadZipFile) as exc:
            raise HTTPException(409, str(exc)) from exc
        finally:
            temp.unlink(missing_ok=True)

    @app.post("/api/v1/studio/recipes/preview", tags=["mlops"])
    def preview_studio_recipe(payload: Recipe):
        try:
            return studio.preview(payload.model_dump())
        except WorkflowError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/studio/recipes", status_code=201, tags=["mlops"])
    def create_studio_recipe(request: Request, payload: Recipe):
        actor = reviewer_auth.verify(request)
        try:
            return studio.save_recipe(payload.model_dump(), actor)
        except WorkflowError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/studio/recipes/{recipe_id}/freeze", status_code=201, tags=["mlops"])
    def freeze_studio_recipe(request: Request, recipe_id: str):
        actor = reviewer_auth.verify(request)
        try:
            return public_record(studio.freeze(recipe_id, actor), "artifact_path", "evaluation_path")
        except WorkflowError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.put("/api/v1/studio/policy", tags=["mlops"])
    def save_studio_policy(request: Request, payload: TrainingPolicy):
        actor = require_model_manager(request)
        if payload.enabled:
            raise HTTPException(503, TRAINING_UNAVAILABLE_REASON)
        try:
            item = studio.save_policy(payload.model_dump(), actor)
            training_worker.notify()
            return item
        except WorkflowError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/studio/demo/prepare-49", tags=["mlops"])
    def prepare_studio_demo(request: Request):
        actor = feedback_actor(request)
        if actor.get("role") != "admin":
            raise HTTPException(403, "Chỉ admin được chuẩn bị dữ liệu demo.")
        try:
            return prepare_demo49(studio, annotation_store, actor["username"])
        except (WorkflowError, ValueError, FileNotFoundError, RevisionConflictError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/studio/launch", status_code=202, tags=["mlops"])
    def launch_studio_policy(request: Request):
        require_model_manager(request)
        raise HTTPException(503, TRAINING_UNAVAILABLE_REASON)

    @app.get("/api/v1/studio/models/{model_id}/benchmark", tags=["mlops"])
    def download_studio_benchmark(model_id: str):
        model = mlops_store.get_model(model_id)
        path = Path(model.get("benchmark_path", "")) if model else None
        if not path or not path.is_file():
            raise HTTPException(404, "Chưa có báo cáo benchmark")
        return FileResponse(path, media_type="application/json", filename="benchmark.json")

    @app.get("/api/v1/datasets", tags=["datasets"])
    def list_dataset_versions():
        return {"items": [public_record(item, "artifact_path", "evaluation_path") for item in mlops_store.list_datasets()]}

    @app.post("/api/v1/datasets", status_code=201, tags=["datasets"])
    def create_dataset_version(request: Request, payload: DatasetVersionCreate):
        authenticated_actor = reviewer_auth.verify(request)
        try:
            item = mlops_store.create_dataset(payload.name, payload.version, authenticated_actor,
                                              payload.train_ratio, payload.validation_ratio, payload.description)
            return public_record(item, "artifact_path", "evaluation_path")
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Dataset name and version already exist") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/v1/datasets/{dataset_id}/artifact", tags=["datasets"])
    def download_dataset_version(request: Request, dataset_id: str):
        reviewer_auth.verify(request)
        item = mlops_store.get_dataset(dataset_id)
        if not item or not Path(item["artifact_path"]).is_file():
            raise HTTPException(status_code=404, detail="Dataset artifact not found")
        return FileResponse(item["artifact_path"], media_type="application/zip",
                            filename=f"{item['name']}-{item['version']}.zip",
                            headers={"Cache-Control": "private, no-store"})

    @app.get("/api/v1/training/runs", tags=["training"])
    def list_training_runs():
        return {"items": [public_record(item, "output_dir", "log_path") for item in mlops_store.list_runs()]}

    @app.post("/api/v1/training/runs", status_code=202, tags=["training"])
    def create_training_run(request: Request, payload: TrainingRunCreate):
        authenticated_actor = require_model_manager(request)
        if payload.mode != "postprocess_calibration":
            raise HTTPException(503, TRAINING_UNAVAILABLE_REASON)
        if not settings.training_command:
            raise HTTPException(status_code=503, detail="BRAINHEM_TRAINING_COMMAND is not configured")
        if payload.base_model_id:
            base = mlops_store.get_model(payload.base_model_id)
            if payload.mode == "fine_tune":
                blocker = studio.training_blocker(payload.base_model_id, payload.config.get("model_variant"))
                if blocker:
                    raise HTTPException(409, blocker)
            if base and base.get("imported"):
                if payload.mode not in {"fine_tune", "postprocess_calibration"}:
                    raise HTTPException(409, "Imported model integration only supports the configured training modes")
        try:
            run = mlops_store.create_run(payload.dataset_version_id, payload.mode, payload.name,
                                         authenticated_actor, payload.base_model_id, payload.config)
            training_worker.notify()
            return public_record(run, "output_dir", "log_path")
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/v1/training/runs/{run_id}/log", tags=["training"])
    def get_training_log(request: Request, run_id: str):
        reviewer_auth.verify(request)
        run = mlops_store.get_run(run_id)
        if not run or not Path(run["log_path"]).is_file():
            raise HTTPException(status_code=404, detail="Training log not found")
        return FileResponse(run["log_path"], media_type="text/plain",
                            headers={"Cache-Control": "private, no-store"})

    @app.post("/api/v1/training/runs/{run_id}/validate", status_code=202, tags=["training"])
    def validate_training_run(request: Request, run_id: str):
        reviewer_auth.verify(request)
        if not settings.validation_command:
            raise HTTPException(status_code=503, detail="BRAINHEM_VALIDATION_COMMAND is not configured")
        try:
            run = mlops_store.queue_validation(run_id)
            training_worker.notify()
            return public_record(run, "output_dir", "log_path")
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Training run not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/v1/models", tags=["models"])
    def list_model_versions():
        return {"items": [public_record(item, "artifact_path") for item in mlops_store.list_models()]}

    @app.post("/api/v1/models/{model_id}/approvals", status_code=201, tags=["models"])
    def approve_model(request: Request, model_id: str, payload: ApprovalCreate):
        require(request, "model.domain_review" if payload.gate == "clinical" else "model.manage")
        authenticated_actor = reviewer_auth.verify(request)
        try:
            item = mlops_store.approve_model(model_id, payload.gate, payload.decision,
                                             authenticated_actor, payload.note)
            return public_record(item, "artifact_path")
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Model not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/models/{model_id}/transition", tags=["models"])
    def transition_model(request: Request, model_id: str, payload: ModelTransitionRequest):
        authenticated_actor = require_model_manager(request)
        model = mlops_store.get_model(model_id)
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        try:
            mlops_store.validate_transition(model_id, payload.target_stage)
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if payload.target_stage in {"shadow", "production"}:
            if payload.target_stage == "shadow" and triton_deployer.configured:
                try:
                    deployed = triton_deployer.stage(
                        model["artifact_path"], model_id, model["artifact_sha256"],
                        resolved_model_version("fast"),
                    )
                    mlops_store.record_deployment(model_id, deployed["backend"], deployed["model_name"],
                                                  deployed["model_version"], model["artifact_sha256"])
                except TritonDeploymentError as exc:
                    raise HTTPException(status_code=502, detail=str(exc)) from exc
            elif payload.target_stage == "production" and triton_deployer.configured:
                pass  # Promotion atomically switches the persisted runtime version below.
            elif not settings.deployment_command:
                raise HTTPException(status_code=503, detail="BRAINHEM_DEPLOYMENT_COMMAND is not configured")
            elif settings.deployment_command:
                command = shlex.split(settings.deployment_command.format(
                    model=model["artifact_path"], model_id=model_id, stage=payload.target_stage
                ))
                completed = subprocess.run(command, capture_output=True, text=True, timeout=600, check=False)
                if completed.returncode:
                    raise HTTPException(status_code=502, detail=(completed.stderr or completed.stdout)[-2000:])
        try:
            item = mlops_store.transition_model(model_id, payload.target_stage, authenticated_actor, payload.note)
            return public_record(item, "artifact_path")
        except WorkflowError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/models/{model_id}/shadow-evidence", status_code=201, tags=["models"])
    async def upload_shadow_evidence(request: Request, model_id: str, file: UploadFile = File(...), note: str = Form("")):
        authenticated_actor = reviewer_auth.verify(request)
        temp_dir = settings.data_dir / "tmp" / f"shadow-{uuid.uuid4()}"
        temp_path = temp_dir / "report.json"
        try:
            await _save_upload(file, temp_path, min(settings.max_upload_bytes, 10 * 1024 * 1024))
            return mlops_store.add_shadow_evidence(model_id, temp_path, authenticated_actor, note)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Model not found") from exc
        except WorkflowError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


    if settings.frontend_dir and settings.frontend_dir.is_dir():
        @app.get("/model-studio", include_in_schema=False)
        @app.get("/model-studio/", include_in_schema=False)
        @app.get("/simulator", include_in_schema=False)
        @app.get("/simulator/", include_in_schema=False)
        @app.get("/guide", include_in_schema=False)
        @app.get("/guide/", include_in_schema=False)
        @app.get("/feedback", include_in_schema=False)
        @app.get("/feedback/", include_in_schema=False)
        def spa_frontend() -> FileResponse:
            return FileResponse(
                settings.frontend_dir / "index.html",
                media_type="text/html",
                headers={"Cache-Control": "no-cache"},
            )

        app.mount(
            "/",
            StaticFiles(directory=settings.frontend_dir, html=True),
            name="clinician-portal",
        )

    return app


app = create_app()
