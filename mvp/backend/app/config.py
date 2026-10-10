from __future__ import annotations

import os
import shutil

os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")

from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 1:
        raise ValueError(f"{name} must be greater than zero")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_path: Path
    inference_command: str
    inference_timeout_seconds: int
    max_upload_bytes: int
    retention_hours: int
    worker_poll_seconds: float
    inference_max_attempts: int = 3
    inference_retry_base_seconds: float = 5.0
    inference_wait_seconds: float = 10.0
    inference_deadline_seconds: int = 3600
    orthanc_url: str = ""
    orthanc_username: str = ""
    orthanc_password: str = ""
    dicom_enabled: bool = False
    simulator_enabled: bool = False
    direct_upload_enabled: bool = False
    model_version: str = "baseline-s"
    allow_force_reprocess: bool = False
    inference_backend_label: str = ""
    inference_standard_command: str = ""
    inference_high_command: str = ""
    model_standard_version: str = "baseline-m"
    model_high_version: str = "baseline-l"
    rbac_enabled: bool = True
    auth_session_seconds: int = 28800
    reviewer_accounts_file: str = ""
    training_command: str = ""
    validation_command: str = ""
    deployment_command: str = ""
    studio_release_command: str = ""
    training_timeout_seconds: int = 86400
    inference_standard_probe_url: str = ""
    triton_grpc_url: str = ""
    triton_http_url: str = ""
    triton_model_name: str = "baseline_s"
    triton_model_version: str = "1"
    triton_model_repository: str = ""
    triton_deploy_timeout_seconds: int = 300
    pacs_dicom_host: str = "127.0.0.1"
    pacs_dicom_port: int = 4242
    simulator_calling_aet: str = "CT_SIMULATOR"
    pacs_called_aet: str = "BRAINHEM_PACS"
    frontend_dir: Path | None = None
    support_hourly_quota: int = 20
    support_local_url: str = ""
    support_local_model: str = ""
    support_agy_path: str = ""
    support_agy_model: str = "gemini-3.8-flash-low"
    feedback_hourly_quota: int = 5
    feedback_user_username: str = "user"
    feedback_user_password: str = ""
    feedback_admin_username: str = "admin"
    feedback_admin_password: str = ""
    sam2_checkpoint: str = ""
    sam2_source_dir: str = ""
    cors_origins: tuple[str, ...] = (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = Path(os.getenv("BRAINHEM_DATA_DIR", "./data")).resolve()
        database_path = Path(
            os.getenv("BRAINHEM_DATABASE_PATH", str(data_dir / "jobs.sqlite3"))
        ).resolve()
        return cls(
            data_dir=data_dir,
            database_path=database_path,
            inference_command=os.getenv("BRAINHEM_INFERENCE_COMMAND", "").strip(),
            inference_timeout_seconds=_env_int(
                "BRAINHEM_INFERENCE_TIMEOUT_SECONDS", 900
            ),
            max_upload_bytes=_env_int(
                "BRAINHEM_MAX_UPLOAD_BYTES", 512 * 1024 * 1024
            ),
            retention_hours=_env_int("BRAINHEM_RETENTION_HOURS", 72),
            worker_poll_seconds=float(os.getenv("BRAINHEM_WORKER_POLL_SECONDS", "0.5")),
            inference_max_attempts=_env_int("BRAINHEM_INFERENCE_MAX_ATTEMPTS", 3),
            inference_retry_base_seconds=float(os.getenv("BRAINHEM_INFERENCE_RETRY_BASE_SECONDS", "5")),
            inference_wait_seconds=float(os.getenv("BRAINHEM_INFERENCE_WAIT_SECONDS", "10")),
            inference_deadline_seconds=_env_int("BRAINHEM_INFERENCE_DEADLINE_SECONDS", 3600),
            orthanc_url=os.getenv("BRAINHEM_ORTHANC_URL", "").rstrip("/"),
            orthanc_username=os.getenv("BRAINHEM_ORTHANC_USERNAME", ""),
            orthanc_password=os.getenv("BRAINHEM_ORTHANC_PASSWORD", ""),
            dicom_enabled=os.getenv("BRAINHEM_DICOM_ENABLED", "false").strip().lower()
            in {"1", "true", "yes", "on"},
            simulator_enabled=os.getenv(
                "BRAINHEM_SIMULATOR_ENABLED", "false"
            ).strip().lower()
            in {"1", "true", "yes", "on"},
            direct_upload_enabled=os.getenv(
                "BRAINHEM_DIRECT_UPLOAD_ENABLED", "false"
            ).strip().lower()
            in {"1", "true", "yes", "on"},
            model_version=os.getenv(
                "BRAINHEM_MODEL_VERSION", "baseline-s"
            ).strip(),
            allow_force_reprocess=os.getenv(
                "BRAINHEM_ALLOW_FORCE_REPROCESS", "false"
            ).strip().lower()
            in {"1", "true", "yes", "on"},
            inference_backend_label=os.getenv(
                "BRAINHEM_INFERENCE_BACKEND_LABEL", ""
            ).strip(),
            inference_standard_command=os.getenv(
                "BRAINHEM_INFERENCE_STANDARD_COMMAND", ""
            ).strip(),
            inference_high_command=os.getenv(
                "BRAINHEM_INFERENCE_HIGH_COMMAND", ""
            ).strip(),
            model_standard_version=os.getenv(
                "BRAINHEM_MODEL_STANDARD_VERSION", "baseline-m"
            ).strip(),
            model_high_version=os.getenv(
                "BRAINHEM_MODEL_HIGH_VERSION", "baseline-l"
            ).strip(),
            rbac_enabled=os.getenv("BRAINHEM_RBAC_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
            auth_session_seconds=_env_int("BRAINHEM_AUTH_SESSION_SECONDS", 28800),
            reviewer_accounts_file=os.getenv("BRAINHEM_REVIEWER_ACCOUNTS_FILE", ""),
            training_command=os.getenv("BRAINHEM_TRAINING_COMMAND", "").strip(),
            validation_command=os.getenv("BRAINHEM_VALIDATION_COMMAND", "").strip(),
            deployment_command=os.getenv("BRAINHEM_DEPLOYMENT_COMMAND", "").strip(),
            studio_release_command=os.getenv("BRAINHEM_STUDIO_RELEASE_COMMAND", "").strip(),
            training_timeout_seconds=_env_int("BRAINHEM_TRAINING_TIMEOUT_SECONDS", 86400),
            inference_standard_probe_url=os.getenv("BRAINHEM_STANDARD_PROBE_URL", ""),
            triton_grpc_url=os.getenv("BRAINHEM_TRITON_GRPC_URL", "").strip(),
            triton_http_url=os.getenv("BRAINHEM_TRITON_HTTP_URL", "").rstrip("/"),
            triton_model_name=os.getenv(
                "BRAINHEM_TRITON_MODEL_NAME", "baseline_s"
            ).strip(),
            triton_model_version=os.getenv(
                "BRAINHEM_TRITON_MODEL_VERSION", "1"
            ).strip(),
            triton_model_repository=os.getenv("BRAINHEM_TRITON_MODEL_REPOSITORY", "").strip(),
            triton_deploy_timeout_seconds=_env_int("BRAINHEM_TRITON_DEPLOY_TIMEOUT_SECONDS", 300),
            pacs_dicom_host=os.getenv("BRAINHEM_PACS_DICOM_HOST", "127.0.0.1"),
            pacs_dicom_port=_env_int("BRAINHEM_PACS_DICOM_PORT", 4242),
            simulator_calling_aet=os.getenv(
                "BRAINHEM_SIMULATOR_CALLING_AET", "CT_SIMULATOR"
            ),
            pacs_called_aet=os.getenv("BRAINHEM_PACS_CALLED_AET", "BRAINHEM_PACS"),
            frontend_dir=(
                Path(value).resolve()
                if (value := os.getenv("BRAINHEM_FRONTEND_DIR", "").strip())
                else None
            ),
            support_hourly_quota=_env_int("BRAINHEM_SUPPORT_HOURLY_QUOTA", 20),
            support_local_url=os.getenv("BRAINHEM_SUPPORT_LOCAL_URL", "").rstrip("/"),
            support_local_model=os.getenv("BRAINHEM_SUPPORT_LOCAL_MODEL", "").strip(),
            support_agy_path=os.getenv("BRAINHEM_SUPPORT_AGY_PATH", "").strip(),
            support_agy_model=os.getenv("BRAINHEM_SUPPORT_AGY_MODEL", "gemini-3.8-flash-low").strip(),
            feedback_hourly_quota=_env_int("BRAINHEM_FEEDBACK_HOURLY_QUOTA", 5),
            feedback_user_username=os.getenv("BRAINHEM_FEEDBACK_USER", "user").strip(),
            feedback_user_password=os.getenv("BRAINHEM_FEEDBACK_USER_PASSWORD", ""),
            feedback_admin_username=os.getenv("BRAINHEM_FEEDBACK_ADMIN", "admin").strip(),
            feedback_admin_password=os.getenv("BRAINHEM_FEEDBACK_ADMIN_PASSWORD", ""),
            sam2_checkpoint=os.getenv("BRAINHEM_SAM2_CHECKPOINT", "").strip(),
            sam2_source_dir=os.getenv("BRAINHEM_SAM2_SOURCE_DIR", "").strip(),
            cors_origins=tuple(
                origin.strip()
                for origin in os.getenv(
                    "BRAINHEM_CORS_ORIGINS",
                    "http://localhost:5173,http://127.0.0.1:5173",
                ).split(",")
                if origin.strip()
            ),
        )

    def get_tier_command(self, tier: str) -> str:
        tier_normalized = tier.strip().lower()
        if tier_normalized == "fast":
            return self.inference_command
        if tier_normalized == "standard":
            return ""
        if tier_normalized == "high":
            return ""
        raise ValueError(f"Unknown inference tier: {tier}")

    def get_tier_model_version(self, tier: str) -> str:
        tier_normalized = tier.strip().lower()
        if tier_normalized == "fast":
            return self.model_version
        if tier_normalized == "standard":
            return self.model_standard_version
        if tier_normalized == "high":
            return self.model_high_version
        raise ValueError(f"Unknown inference tier: {tier}")

    def is_tier_available(self, tier: str) -> bool:
        cmd = self.get_tier_command(tier)
        return bool(cmd)
