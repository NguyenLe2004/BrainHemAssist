from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .models import Job, JobStatus


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, database_path: Path, jobs_dir: Path, max_attempts: int = 3, deadline_seconds: int = 3600) -> None:
        self.database_path = database_path
        self.jobs_dir = jobs_dir
        self.max_attempts = max_attempts
        self.deadline_seconds = deadline_seconds

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self, default_model_version: str = "") -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    input_type TEXT NOT NULL DEFAULT 'nifti',
                    original_filename TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    input_path TEXT NOT NULL,
                    output_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    error TEXT,
                    volume_ml REAL,
                    inference_metadata TEXT,
                    review_decision TEXT,
                    reviewer TEXT,
                    review_note TEXT,
                    reviewed_at TEXT,
                    study_id TEXT,
                    model_version TEXT
                )
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(jobs)").fetchall()
            }
            if "volume_ml" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN volume_ml REAL")
            if "inference_metadata" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN inference_metadata TEXT")
            if "input_type" not in columns:
                connection.execute(
                    "ALTER TABLE jobs ADD COLUMN input_type TEXT NOT NULL DEFAULT 'nifti'"
                )
            for definition in (
                "review_decision TEXT",
                "reviewer TEXT",
                "review_note TEXT",
                "reviewed_at TEXT",
                "study_id TEXT",
                "model_version TEXT",
                "attempt_count INTEGER NOT NULL DEFAULT 0",
                "max_attempts INTEGER NOT NULL DEFAULT 3",
                "next_attempt_at TEXT",
                "error_code TEXT",
                "attempt_id TEXT",
                "lease_until TEXT",
                "owner TEXT",
                "deadline_at TEXT",
                "inference_tier TEXT NOT NULL DEFAULT 'fast'",
                "extension_enabled INTEGER NOT NULL DEFAULT 0",
            ):
                name = definition.split()[0]
                if name not in columns:
                    connection.execute(f"ALTER TABLE jobs ADD COLUMN {definition}")
            self._backfill_dicom_identity(connection, default_model_version)
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_jobs_study_model_created "
                "ON jobs(study_id, model_version, created_at DESC)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_jobs_study_tier_created "
                "ON jobs(study_id, inference_tier, model_version, created_at DESC)"
            )
            # Legacy interrupted jobs have no lease. Live leases survive a
            # second API process starting; expired leases are recovered by claim.
            connection.execute(
                "UPDATE jobs SET status='queued', error_code='INTERRUPTED', "
                "error='Worker restarted before inference completed', updated_at=? "
                "WHERE status='running' AND lease_until IS NULL", (_now(),)
            )


    def create(
        self,
        job_id: str,
        original_filename: str,
        input_type: str,
        size_bytes: int,
        input_path: Path,
        output_path: Path,
        study_id: str | None = None,
        model_version: str | None = None,
        inference_tier: str = "fast",
        extension_enabled: bool = False,
    ) -> Job:
        timestamp = _now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (
                    id, status, input_type, original_filename, size_bytes,
                    input_path, output_path, created_at, updated_at,
                    study_id, model_version, inference_tier, extension_enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    JobStatus.queued.value,
                    input_type,
                    original_filename,
                    size_bytes,
                    str(input_path),
                    str(output_path),
                    timestamp,
                    timestamp,
                    study_id,
                    model_version,
                    inference_tier,
                    int(extension_enabled),
                ),
            )
        self.configure_job(job_id)
        return self.get(job_id)  # type: ignore[return-value]

    def create_or_get_active(
        self,
        job_id: str,
        original_filename: str,
        input_type: str,
        size_bytes: int,
        input_path: Path,
        output_path: Path,
        study_id: str,
        model_version: str,
        inference_tier: str = "fast",
        extension_enabled: bool = False,
    ) -> tuple[Job, bool]:
        """Atomically reuse or create one active inference for an identity.

        The caller may prepare files before entering this transaction.  The
        boolean tells it whether those files became the canonical job so a
        losing concurrent request can remove its temporary directory.
        """
        timestamp = _now()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM jobs
                WHERE study_id = ? AND model_version = ?
                  AND (inference_tier = ? OR (inference_tier IS NULL AND ? = 'fast'))
                  AND COALESCE(extension_enabled, 0) = ?
                  AND status IN (?, ?, ?, 'retry_wait', 'service_wait')
                ORDER BY created_at DESC LIMIT 1
                """,
                (
                    study_id,
                    model_version,
                    inference_tier,
                    inference_tier,
                    int(extension_enabled),
                    JobStatus.queued.value,
                    JobStatus.running.value,
                    JobStatus.succeeded.value,
                ),
            ).fetchone()
            if row and row["status"] == JobStatus.succeeded.value and not Path(row["output_path"]).is_file():
                connection.execute(
                    "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                    (JobStatus.failed.value, "Persisted result file is unavailable", timestamp, row["id"]),
                )
                row = None
            if row:
                connection.commit()
                return self._to_job(row), False
            connection.execute(
                """
                INSERT INTO jobs (
                    id, status, input_type, original_filename, size_bytes,
                    input_path, output_path, created_at, updated_at,
                    study_id, model_version, inference_tier, extension_enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    JobStatus.queued.value,
                    input_type,
                    original_filename,
                    size_bytes,
                    str(input_path),
                    str(output_path),
                    timestamp,
                    timestamp,
                    study_id,
                    model_version,
                    inference_tier,
                    int(extension_enabled),
                ),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        self.configure_job(job_id)
        return self.get(job_id), True  # type: ignore[return-value]

    def find_latest_by_study(
        self,
        study_ids: list[str] | tuple[str, ...],
        model_version: str,
        tier: str = "fast",
        extension_enabled: bool = False,
    ) -> Job | None:
        identities = [value for value in dict.fromkeys(study_ids) if value]
        if not identities:
            return None
        placeholders = ",".join("?" for _ in identities)
        with self._connect() as connection:
            row = connection.execute(
                f"""
                SELECT * FROM jobs
                WHERE study_id IN ({placeholders})
                  AND model_version = ?
                  AND (inference_tier = ? OR (inference_tier IS NULL AND ? = 'fast'))
                  AND COALESCE(extension_enabled, 0) = ?
                  AND status IN (?, ?, ?, 'retry_wait', 'service_wait')
                ORDER BY created_at DESC LIMIT 1
                """,
                [
                    *identities,
                    model_version,
                    tier,
                    tier,
                    int(extension_enabled),
                    JobStatus.queued.value,
                    JobStatus.running.value,
                    JobStatus.succeeded.value,
                ],
            ).fetchone()
            if row and row["status"] == JobStatus.succeeded.value:
                if not Path(row["output_path"]).is_file():
                    connection.execute(
                        "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                        (
                            JobStatus.failed.value,
                            "Persisted result file is unavailable",
                            _now(),
                            row["id"],
                        ),
                    )
                    return None
        return self._to_job(row) if row else None


    def bind_study_identity(
        self, job_id: str, study_id: str, model_version: str
    ) -> Job | None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE jobs SET study_id = ?, model_version = ?, updated_at = ? WHERE id = ?",
                (study_id, model_version, _now(), job_id),
            )
        return self.get(job_id)

    def _backfill_dicom_identity(
        self, connection: sqlite3.Connection, default_model_version: str
    ) -> None:
        rows = connection.execute(
            "SELECT id, output_path FROM jobs WHERE input_type = 'dicom' "
            "AND (study_id IS NULL OR study_id = '')"
        ).fetchall()
        for row in rows:
            source_path = Path(row["output_path"]).parent / "dicom-source.json"
            try:
                payload = json.loads(source_path.read_text(encoding="utf-8"))
                study_id = str(payload.get("study_instance_uid") or payload.get("orthanc_study_id") or "")
            except (OSError, TypeError, json.JSONDecodeError):
                study_id = ""
            if study_id:
                connection.execute(
                    "UPDATE jobs SET study_id = ?, model_version = COALESCE(NULLIF(model_version, ''), ?) WHERE id = ?",
                    (study_id, default_model_version, row["id"]),
                )

    def get(self, job_id: str) -> Job | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return self._to_job(row) if row else None

    def get_paths(self, job_id: str) -> tuple[Path, Path] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT input_path, output_path FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if not row:
            return None
        return Path(row["input_path"]), Path(row["output_path"])

    def list(
        self, limit: int, offset: int, status: JobStatus | None
    ) -> tuple[list[Job], int]:
        where = ""
        parameters: list[Any] = []
        if status:
            where = " WHERE status = ?"
            parameters.append(status.value)
        with self._connect() as connection:
            count = connection.execute(
                f"SELECT COUNT(*) FROM jobs{where}", parameters
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT * FROM jobs{where}
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                [*parameters, limit, offset],
            ).fetchall()
        return [self._to_job(row) for row in rows], count

    def configure_job(self, job_id: str) -> None:
        deadline = (datetime.now(timezone.utc) + timedelta(seconds=self.deadline_seconds)).isoformat()
        with self._connect() as db:
            db.execute("UPDATE jobs SET max_attempts=?, deadline_at=? WHERE id=? AND deadline_at IS NULL",
                       (self.max_attempts, deadline, job_id))

    def claim_next(self, owner: str = "worker", lease_seconds: float = 60):
        now = _now()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE jobs SET status=CASE WHEN attempt_count < max_attempts THEN 'retry_wait' ELSE 'failed' END, "
                       "error_code='INTERRUPTED', error=CASE WHEN attempt_count < max_attempts THEN 'Tác vụ bị gián đoạn; hệ thống đang phục hồi.' ELSE 'AI đã dừng sau gián đoạn và hết số lần thử. Bạn có thể tiếp tục thủ công.' END, "
                       "next_attempt_at=?, completed_at=CASE WHEN attempt_count >= max_attempts THEN ? ELSE NULL END, "
                       "owner=NULL, lease_until=NULL, attempt_id=NULL, updated_at=? "
                       "WHERE status='running' AND lease_until < ?", (now, now, now, now))
            db.execute("UPDATE jobs SET status='failed', error_code='WAIT_TIMEOUT', "
                       "error='Đã hết thời gian chờ xử lý AI. Bạn có thể thử lại hoặc tiếp tục thủ công.', "
                       "completed_at=?, updated_at=? WHERE status IN ('queued','retry_wait','service_wait') "
                       "AND deadline_at IS NOT NULL AND deadline_at < ?", (now, now, now))
            row = db.execute("SELECT * FROM jobs WHERE status IN ('queued','retry_wait','service_wait') "
                             "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) "
                             "ORDER BY created_at LIMIT 1", (now,)).fetchone()
            if not row:
                return None
            attempt_id = uuid.uuid4().hex
            lease = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat()
            db.execute("UPDATE jobs SET status='running', owner=?, attempt_id=?, lease_until=?, "
                       "attempt_count=attempt_count+1, started_at=?, updated_at=?, next_attempt_at=NULL "
                       "WHERE id=?", (owner, attempt_id, lease, now, now, row['id']))
        return (row['id'], Path(row['input_path']), Path(row['output_path']),
                row['inference_tier'] or 'fast', bool(row['extension_enabled']), row['model_version'] or '', attempt_id)

    def heartbeat(self, job_id: str, attempt_id: str, lease_seconds: float = 60) -> bool:
        lease = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat()
        with self._connect() as db:
            return db.execute("UPDATE jobs SET lease_until=?, updated_at=? "
                              "WHERE id=? AND attempt_id=? AND status='running'",
                              (lease, _now(), job_id, attempt_id)).rowcount == 1

    def defer(self, job_id: str, attempt_id: str, code: str, message: str,
              delay: float, waiting: bool = False, retryable: bool = True) -> bool:
        now = _now()
        retry_at = (datetime.now(timezone.utc) + timedelta(seconds=max(0, delay))).isoformat()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=? AND attempt_id=? AND status='running'",
                             (job_id, attempt_id)).fetchone()
            if not row:
                return False
            count = max(0, row['attempt_count'] - int(waiting))
            expired = row['deadline_at'] is not None and row['deadline_at'] <= now
            status = ('service_wait' if waiting else 'retry_wait') if retryable and count < row['max_attempts'] and not expired else 'failed'
            if status == 'failed' and retryable:
                if expired:
                    code = 'WAIT_TIMEOUT'
                    message = 'Đã hết thời gian chờ xử lý AI. Bạn có thể thử lại hoặc tiếp tục thủ công.'
                else:
                    message = f'AI đã dừng sau {count} lần thực thi. Bạn có thể thử lại hoặc tiếp tục thủ công.'
            db.execute("UPDATE jobs SET status=?, attempt_count=?, error_code=?, error=?, next_attempt_at=?, "
                       "completed_at=?, owner=NULL, lease_until=NULL, attempt_id=NULL, updated_at=? WHERE id=?",
                       (status, count, code, message, retry_at if status != 'failed' else None,
                        now if status == 'failed' else None, now, job_id))
        return True

    def publish(self, job_id: str, attempt_id: str, staged_path: Path,
                volume_ml: float, inference_metadata: dict | None = None) -> bool:
        # Filesystem and SQL remain separate. Never advertise success until
        # validated files have been published; a crash leaves recoverable work.
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=? AND attempt_id=? AND status='running'",
                             (job_id, attempt_id)).fetchone()
            if not row:
                return False
            target = Path(row['output_path'])
            for name in ('inference-metadata.json', 'probability.nii.gz', 'segmentation.dcm'):
                src = staged_path.parent / name
                if src.is_file():
                    os.replace(src, target.parent / name)
                else:
                    (target.parent / name).unlink(missing_ok=True)
            os.replace(staged_path, target)
            now = _now()
            db.execute("UPDATE jobs SET status='succeeded', completed_at=?, updated_at=?, error=NULL, "
                       "error_code=NULL, next_attempt_at=NULL, lease_until=NULL, owner=NULL, volume_ml=?, inference_metadata=? "
                       "WHERE id=?", (now, now, volume_ml, json.dumps(inference_metadata) if inference_metadata else None, job_id))
        return True

    def finish(
        self,
        job_id: str,
        success: bool,
        error: str | None = None,
        volume_ml: float | None = None,
        inference_metadata: dict[str, Any] | None = None,
    ) -> None:
        timestamp = _now()
        status = JobStatus.succeeded if success else JobStatus.failed
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE jobs SET status = ?, updated_at = ?, completed_at = ?,
                    error = ?, volume_ml = ?, inference_metadata = ? WHERE id = ?
                """,
                (
                    status.value,
                    timestamp,
                    timestamp,
                    error,
                    volume_ml,
                    json.dumps(inference_metadata) if inference_metadata else None,
                    job_id,
                ),
            )

    def review(
        self,
        job_id: str,
        decision: str,
        reviewer: str,
        note: str,
        expected_reviewed_at: str | None,
    ) -> Job | None:
        timestamp = _now()
        with self._connect() as connection:
            updated = connection.execute(
                """
                UPDATE jobs SET review_decision = ?, reviewer = ?, review_note = ?,
                    reviewed_at = ?, updated_at = ?
                WHERE id = ? AND status = ?
                  AND ((reviewed_at IS NULL AND ? IS NULL) OR reviewed_at = ?)
                """,
                (
                    decision,
                    reviewer,
                    note,
                    timestamp,
                    timestamp,
                    job_id,
                    JobStatus.succeeded.value,
                    expected_reviewed_at,
                    expected_reviewed_at,
                ),
            ).rowcount
        return self.get(job_id) if updated else None

    def cleanup_expired(self, retention_hours: int) -> int:
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=retention_hours)
        ).isoformat()
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id FROM jobs
                WHERE status IN (?, ?) AND completed_at < ?
                """,
                (
                    JobStatus.succeeded.value,
                    JobStatus.failed.value,
                    cutoff,
                ),
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                connection.execute(
                    f"DELETE FROM jobs WHERE id IN ({placeholders})", ids
                )
        for job_id in ids:
            shutil.rmtree(self.jobs_dir / job_id, ignore_errors=True)
        return len(ids)

    @staticmethod
    def _to_job(row: sqlite3.Row) -> Job:
        output_path = Path(row["output_path"])
        status = JobStatus(row["status"])
        result_ready = status == JobStatus.succeeded and output_path.is_file()
        progress = {
            JobStatus.queued: 0,
            JobStatus.running: 0,
            JobStatus.retry_wait: 0,
            JobStatus.service_wait: 0,
            JobStatus.succeeded: 100,
            JobStatus.failed: 100,
        }[status]
        stage = {
            JobStatus.queued: "queued",
            JobStatus.running: "inference",
            JobStatus.retry_wait: "retry_wait",
            JobStatus.service_wait: "service_wait",
            JobStatus.succeeded: "completed",
            JobStatus.failed: "failed",
        }[status]
        artifacts: dict[str, str] = {}
        if result_ready:
            artifacts["mask"] = f"/api/v1/jobs/{row['id']}/artifacts/mask"
            artifacts["source"] = f"/api/v1/jobs/{row['id']}/artifacts/source"
            if (output_path.parent / "inference-metadata.json").is_file():
                artifacts["metadata"] = f"/api/v1/jobs/{row['id']}/artifacts/metadata"
            if (output_path.parent / "probability.nii.gz").is_file():
                artifacts["probability"] = f"/api/v1/jobs/{row['id']}/artifacts/probability"
            if (output_path.parent / "segmentation.dcm").is_file():
                artifacts["dicom-seg"] = f"/api/v1/jobs/{row['id']}/artifacts/dicom-seg"
        result: dict[str, Any] = {}
        if row["volume_ml"] is not None:
            result["hemorrhage_volume_ml"] = row["volume_ml"]
        if row["inference_metadata"]:
            try:
                metadata = json.loads(row["inference_metadata"])
                if isinstance(metadata, dict):
                    result["inference"] = metadata
            except (TypeError, json.JSONDecodeError):
                pass
        tier = "fast"
        try:
            tier = row["inference_tier"] or "fast"
        except (IndexError, KeyError):
            tier = "fast"
        return Job(
            id=row["id"],
            status=status,
            input_type=row["input_type"],
            inference_tier=tier,
            extension_enabled=bool(row["extension_enabled"]),
            study_id=row["study_id"],
            model_version=row["model_version"],
            original_filename=row["original_filename"],

            size_bytes=row["size_bytes"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            error=row["error"],
            attempt_count=row["attempt_count"],
            max_attempts=row["max_attempts"],
            next_attempt_at=row["next_attempt_at"],
            error_code=row["error_code"],
            progress=progress,
            stage=stage,
            has_result=result_ready,
            result=result,
            artifacts=artifacts,
            review=(
                {
                    "decision": row["review_decision"],
                    "reviewer": row["reviewer"],
                    "note": row["review_note"] or "",
                    "reviewed_at": row["reviewed_at"],
                }
                if row["review_decision"]
                else {}
            ),
        )
