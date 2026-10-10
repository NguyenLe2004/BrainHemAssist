from __future__ import annotations

import base64
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import nibabel as nib
import numpy as np
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.reviewer_auth import password_record


def _settings(tmp_path: Path, command: str = "/bin/false {input} {output}") -> Settings:
    data = tmp_path / "data"
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        data_dir=data,
        database_path=data / "jobs.sqlite3",
        inference_command=command,
        inference_timeout_seconds=10,
        max_upload_bytes=10 * 1024 * 1024,
        retention_hours=24,
        worker_poll_seconds=10,
        direct_upload_enabled=True,
    )


def _authorization(username: str, password: str) -> str:
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {encoded}"


def _reviewer_settings(tmp_path: Path) -> tuple[Settings, dict[str, str]]:
    credentials = {"reader-a": "reader-a-password", "reader-b": "reader-b-password"}
    accounts = tmp_path / "reviewers.json"
    accounts.write_text(
        json.dumps({name: password_record(password) for name, password in credentials.items()}),
        encoding="utf-8",
    )
    return replace(_settings(tmp_path), reviewer_accounts_file=str(accounts)), credentials


def _volume(path: Path, *, mask: bool = False) -> Path:
    data = np.zeros((12, 10, 5), dtype=np.uint8 if mask else np.int16)
    if mask:
        data[3:7, 3:7, 1:4] = 1
    nib.save(nib.Nifti1Image(data, np.diag([0.8, 0.8, 3.0, 1.0])), path)
    return path


def _completed_job(client: TestClient, tmp_path: Path) -> str:
    source = _volume(tmp_path / "source.nii.gz")
    mask = _volume(tmp_path / "mask.nii.gz", mask=True)
    job_id = "completed-review-job"
    job_dir = client.app.state.settings.data_dir / "jobs" / job_id
    job_dir.mkdir(parents=True)
    stored_source = job_dir / "input.nii.gz"
    stored_mask = job_dir / "mask.nii.gz"
    stored_source.write_bytes(source.read_bytes())
    stored_mask.write_bytes(mask.read_bytes())
    client.app.state.store.create(
        job_id,
        "source.nii.gz",
        "nifti",
        stored_source.stat().st_size,
        stored_source,
        stored_mask,
        model_version="model-v1",
    )
    client.app.state.store.finish(job_id, True, volume_ml=0.1)
    return job_id


def test_clinical_review_requires_auth_and_uses_authenticated_identity(tmp_path: Path) -> None:
    settings, credentials = _reviewer_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        job_id = _completed_job(client, tmp_path)
        body = {
            "decision": "accepted",
            "reviewer": "spoofed-doctor",
            "note": "reviewed",
            "expected_reviewed_at": None,
        }

        assert client.post(f"/api/v1/jobs/{job_id}/review", json=body).status_code == 401

        response = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json=body,
            headers={"Authorization": _authorization("reader-a", credentials["reader-a"])},
        )
        assert response.status_code == 200, response.text
        assert response.json()["review"]["reviewer"] == "reader-a"


def test_clinical_review_rejects_stale_overwrite(tmp_path: Path) -> None:
    settings, credentials = _reviewer_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        job_id = _completed_job(client, tmp_path)
        first = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={
                "decision": "accepted",
                "note": "first review",
                "expected_reviewed_at": None,
            },
            headers={"Authorization": _authorization("reader-a", credentials["reader-a"])},
        )
        assert first.status_code == 200, first.text
        review_token = first.json()["review"]["reviewed_at"]

        stale = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={
                "decision": "rejected",
                "note": "stale overwrite",
                "expected_reviewed_at": None,
            },
            headers={"Authorization": _authorization("reader-b", credentials["reader-b"])},
        )
        assert stale.status_code == 409
        persisted = client.get(f"/api/v1/jobs/{job_id}").json()["review"]
        assert persisted["decision"] == "accepted"
        assert persisted["reviewer"] == "reader-a"

        fresh = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={
                "decision": "rejected",
                "note": "intentional second review",
                "expected_reviewed_at": review_token,
            },
            headers={"Authorization": _authorization("reader-b", credentials["reader-b"])},
        )
        assert fresh.status_code == 200, fresh.text
        assert fresh.json()["review"]["reviewer"] == "reader-b"
        assert fresh.json()["review"]["decision"] == "rejected"


def test_case_inference_creation_is_idempotent_under_concurrency(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    source = _volume(tmp_path / "concurrent-source.nii.gz")
    with TestClient(create_app(settings)) as client:
        client.app.state.worker.stop()
        case, created = client.app.state.annotation_store.create_case(
            "concurrent-case", "Concurrent case", source
        )
        assert created is True
        barrier = threading.Barrier(12)

        def submit(_: int) -> tuple[int, str]:
            barrier.wait(timeout=5)
            response = client.post(f"/api/v1/annotations/cases/{case.id}/inference")
            return response.status_code, response.json()["id"]

        with ThreadPoolExecutor(max_workers=12) as executor:
            responses = list(executor.map(submit, range(12)))

        assert {status_code for status_code, _ in responses} <= {200, 202}
        assert len({job_id for _, job_id in responses}) == 1
        assert client.get("/api/v1/jobs").json()["count"] == 1


def test_health_is_degraded_when_configured_command_cannot_start(tmp_path: Path) -> None:
    settings = _settings(tmp_path, "/definitely/missing/brainhem-infer {input} {output}")
    with TestClient(create_app(settings)) as client:
        health = client.get("/api/v1/health")
        capabilities = client.get("/api/v1/capabilities")

    assert health.status_code == 200
    assert health.json()["inference_configured"] is True
    assert health.json()["status"] == "degraded"
    assert capabilities.status_code == 200
    assert capabilities.json()["tiers"]["fast"]["available"] is False
