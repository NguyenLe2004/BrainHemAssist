from __future__ import annotations

import base64
import gzip
import json
import struct
import sys
import time
from dataclasses import replace
from pathlib import Path

import nibabel as nib
import numpy as np
from fastapi.testclient import TestClient

from app.config import Settings
from app.inference import mask_volume_ml
from app.main import create_app
from app.reviewer_auth import password_record
from app.series_selection import SeriesCandidate


def _nifti_bytes(compressed: bool = False) -> bytes:
    image = nib.Nifti1Image(np.zeros((8, 9, 3), dtype=np.uint8), np.eye(4))
    content = image.to_bytes()
    return gzip.compress(content) if compressed else content


def _settings(tmp_path: Path, command: str) -> Settings:
    data = tmp_path / "data"
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        data_dir=data,
        database_path=data / "jobs.sqlite3",
        inference_command=command,
        inference_timeout_seconds=10,
        max_upload_bytes=1024 * 1024,
        retention_hours=24,
        worker_poll_seconds=0.01,
        direct_upload_enabled=True,
    )


def _wait(client: TestClient, job_id: str, wanted: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        payload = client.get(f"/api/v1/jobs/{job_id}").json()
        if payload["status"] == wanted:
            return payload
        time.sleep(0.02)
    raise AssertionError(f"Job did not reach {wanted}: {payload}")


def test_health_and_missing_job(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path, ""))) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {
            "status": "ok",
            "inference_configured": False,
            "worker_alive": True,
            "pacs_configured": False,
            "dicom_enabled": False,
            "simulator_enabled": False,
            "inference_backend": "command",
            "triton_configured": False,
            "triton_ready": False,
            "triton_model": None,
        }
        assert client.get("/api/v1/jobs/not-there").status_code == 404


def test_local_support_is_docs_first_read_only_and_escalates(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path, ""), support_hourly_quota=5)
    with TestClient(create_app(settings)) as client:
        status_payload = client.get("/api/v1/support/status").json()
        assert status_payload["mode"] == "local-docs"
        assert status_payload["read_only"] is True
        assert status_payload["hourly_quota"] == 5

        documented = client.post("/api/v1/support/chat", json={
            "question": "Xóa thước đo thế nào?",
            "session_id": "support-test-session",
            "page": "/#clinical",
        })
        assert documented.status_code == 200
        assert documented.json()["resolved"] is True
        assert documented.json()["source"] == "docs"
        assert documented.json()["references"][0]["href"] == "/guide#measure"

        upload = client.post("/api/v1/support/chat", json={
            "question": "Làm sao để upload một file DICOM lên và xem kết quả mô hình?",
            "session_id": "upload-support-session",
            "page": "/#home",
        })
        assert upload.status_code == 200
        assert upload.json()["resolved"] is True
        assert upload.json()["references"][0]["href"] == "/guide#dicom-upload"
        assert "Tiếp nhận ca CT" in upload.json()["answer"]

        labeling = client.post("/api/v1/support/chat", json={
            "question": "làm sao để label 1 ca bệnh",
            "session_id": "label-support-session",
            "page": "/#labeling",
        })
        assert labeling.status_code == 200
        assert labeling.json()["resolved"] is True
        assert labeling.json()["references"][0]["href"] == "/guide#gold-label"
        assert "Expert Labeling" in labeling.json()["answer"]

        unresolved = client.post("/api/v1/support/chat", json={
            "question": "Tính năng lượng tử màu tím bí mật nằm ở đâu?",
            "session_id": "support-test-session",
            "page": "/guide",
        })
        assert unresolved.status_code == 200
        assert unresolved.json()["resolved"] is False
        assert unresolved.json()["escalated"] is True
        inbox = settings.data_dir / "support" / "unresolved.jsonl"
        assert inbox.is_file()
        assert "lượng tử" in inbox.read_text(encoding="utf-8")

        last_allowed = client.post("/api/v1/support/chat", json={
            "question": "Cách chạy AI?", "session_id": "support-test-session", "page": "/"
        })
        assert last_allowed.json()["quota_remaining"] == 0
        limited = client.post("/api/v1/support/chat", json={
            "question": "Cách chạy AI?", "session_id": "support-test-session", "page": "/"
        })
        assert limited.json()["source"] == "quota"
        assert limited.json()["quota_remaining"] == 0


def test_feedback_user_submits_and_only_admin_lists_all(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path, ""), feedback_hourly_quota=2)
    user_auth = ("user", "user123")
    admin_auth = ("admin", "admin123")
    with TestClient(create_app(settings)) as client:
        status_payload = client.get("/api/v1/feedback/status").json()
        assert status_payload == {"mode": "internal", "hourly_quota": 2,
                                  "submission_authentication_required": False,
                                  "admin_authentication_required": True}
        assert client.get("/api/v1/feedback/me").status_code == 401
        assert client.get("/api/v1/feedback/me", auth=("user", "wrong")).status_code == 401
        assert client.get("/api/v1/feedback/me", auth=user_auth).json() == {"username": "user", "role": "user"}
        login = client.post("/api/v1/auth/login", json={"username": "user", "password": "user123"})
        assert login.status_code == 200
        assert login.json()["role"] == "user"
        bearer = {"Authorization": f"Bearer {login.json()['token']}"}
        assert client.get("/api/v1/auth/me", headers=bearer).json() == {"username": "user", "role": "user"}
        response = client.post("/api/v1/feedback", headers=bearer, json={
            "role": "Kỹ thuật viên CT",
            "category": "suggestion",
            "message": "Nên giữ lại bộ lọc ca gần nhất khi tải lại trang.",
            "contact": "user@example.com",
            "page": "/feedback",
        })
        assert response.status_code == 200
        assert response.json()["delivered"] is True
        assert response.json()["reference"].startswith("FB-")
        anonymous = client.post("/api/v1/feedback", json={
            "role": "Người dùng khác",
            "category": "usability",
            "message": "Tôi chưa biết cách quay lại Dashboard từ trang hướng dẫn.",
            "page": "/feedback",
        })
        assert anonymous.status_code == 200
        assert client.get("/api/v1/feedback/items", auth=user_auth).status_code == 403
        inbox = client.get("/api/v1/feedback/items", auth=admin_auth)
        assert inbox.status_code == 200
        assert inbox.json()["count"] == 2
        assert inbox.json()["items"][0]["account"] == "anonymous"
        assert inbox.json()["items"][1]["account"] == "user"
        assert client.post("/api/v1/auth/logout", headers=bearer).status_code == 204
        assert client.get("/api/v1/auth/me", headers=bearer).status_code == 401


def test_health_reports_triton_model_readiness(tmp_path: Path, monkeypatch) -> None:
    settings = replace(
        _settings(tmp_path, f"{sys.executable} {{input}} {{output}}"),
        triton_grpc_url="triton:8001",
        triton_http_url="http://triton:8000",
        triton_model_name="baseline_s",
        triton_model_version="1",
    )

    class _Ready:
        status_code = 200

    monkeypatch.setattr("app.main.requests.get", lambda *_args, **_kwargs: _Ready())
    with TestClient(create_app(settings)) as client:
        payload = client.get("/api/v1/health").json()
    assert payload["status"] == "ok"
    assert payload["inference_backend"] == "triton-grpc"
    assert payload["triton_configured"] is True
    assert payload["triton_ready"] is True
    assert payload["triton_model"] == "baseline_s:1"


def test_production_spa_serves_separate_application_routes(tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<!doctype html><title>BrainHem</title>")
    settings = replace(_settings(tmp_path, ""), frontend_dir=frontend)
    with TestClient(create_app(settings)) as client:
        workstation = client.get("/")
        simulator = client.get("/simulator")
        simulator_slash = client.get("/simulator/")
        guide = client.get("/guide")
        guide_slash = client.get("/guide/")
        feedback = client.get("/feedback")
    assert workstation.status_code == 200
    assert simulator.status_code == 200
    assert simulator_slash.status_code == 200
    assert guide.status_code == 200
    assert guide_slash.status_code == 200
    assert feedback.status_code == 200
    assert simulator.text == workstation.text == simulator_slash.text == guide.text == guide_slash.text == feedback.text


def test_upload_run_list_and_download(tmp_path: Path) -> None:
    helper = tmp_path / "fake_inference.py"
    helper.write_text(
        "import pathlib, shutil, sys\n"
        "pathlib.Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)\n"
        "shutil.copyfile(sys.argv[1], sys.argv[2])\n"
        "pathlib.Path(sys.argv[2]).with_name('inference-metadata.json').write_text('{\\\"backend\\\": \\\"test-fp16\\\", \\\"timings_seconds\\\": {\\\"total\\\": 1.25}}')\n"
    )
    command = f"{sys.executable} {helper} {{input}} {{output}}"
    password = "clinical-review-password"
    accounts = tmp_path / "reviewers.json"
    accounts.write_text(
        json.dumps({"test-radiologist": password_record(password)}), encoding="utf-8"
    )
    authorization = "Basic " + base64.b64encode(
        f"test-radiologist:{password}".encode()
    ).decode()
    uploaded_content = _nifti_bytes(True)
    settings = replace(
        _settings(tmp_path, command), reviewer_accounts_file=str(accounts)
    )
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/jobs",
            files={"file": ("scan.nii.gz", uploaded_content, "application/gzip")},
            data={"input_type": "nifti"},
        )
        assert response.status_code == 202
        job_id = response.json()["id"]
        completed = _wait(client, job_id, "succeeded")
        assert completed["has_result"] is True
        assert completed["input_type"] == "nifti"
        assert completed["progress"] == 100
        assert completed["stage"] == "completed"
        assert completed["result"]["inference"]["backend"] == "test-fp16"
        assert completed["result"]["inference"]["timings_seconds"]["total"] == 1.25
        assert completed["artifacts"]["mask"].endswith("/artifacts/mask")
        assert completed["artifacts"]["metadata"].endswith("/artifacts/metadata")

        listing = client.get("/api/v1/jobs?status=succeeded").json()
        assert listing["count"] == 1
        assert listing["items"][0]["id"] == job_id

        result = client.get(f"/api/v1/jobs/{job_id}/result")
        assert result.status_code == 200
        assert result.content == uploaded_content
        artifact = client.get(completed["artifacts"]["mask"])
        assert artifact.content == result.content
        metadata = client.get(completed["artifacts"]["metadata"])
        assert metadata.status_code == 200
        assert metadata.json()["backend"] == "test-fp16"
        assert metadata.headers["content-type"].startswith("application/json")

        head = client.head(completed["artifacts"]["mask"])
        assert head.status_code == 200
        assert head.content == b""
        assert head.headers["accept-ranges"] == "bytes"
        assert int(head.headers["content-length"]) == len(uploaded_content)
        assert "attachment" in head.headers["content-disposition"]
        assert head.headers["cache-control"] == "private, no-store"

        partial = client.get(
            completed["artifacts"]["mask"], headers={"Range": "bytes=0-15"}
        )
        assert partial.status_code == 206
        assert partial.content == uploaded_content[:16]
        assert partial.headers["content-range"] == (
            f"bytes 0-15/{len(uploaded_content)}"
        )

        cors = client.get(
            completed["artifacts"]["mask"],
            headers={"Origin": "http://localhost:5173", "Range": "bytes=0-7"},
        )
        assert cors.status_code == 206
        assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"
        exposed = cors.headers["access-control-expose-headers"].lower()
        assert "content-range" in exposed
        assert "accept-ranges" in exposed

        reviewed = client.post(
            f"/api/v1/jobs/{job_id}/review",
            headers={"Authorization": authorization},
            json={
                "decision": "accepted",
                "note": "reviewed",
                "expected_reviewed_at": None,
            },
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["review"]["decision"] == "accepted"
        assert reviewed.json()["review"]["reviewer"] == "test-radiologist"
        assert reviewed.json()["review"]["note"] == "reviewed"


def test_rejects_extension_and_invalid_header(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path, ""))) as client:
        wrong_extension = client.post(
            "/api/v1/jobs", files={"file": ("scan.txt", b"x", "text/plain")}
        )
        assert wrong_extension.status_code == 422
        invalid = client.post(
            "/api/v1/jobs",
            files={"file": ("scan.nii", b"not-nifti", "application/octet-stream")},
        )
        assert invalid.status_code == 422
        assert client.get("/api/v1/jobs").json()["count"] == 0


def test_rejects_unsupported_input_type(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path, ""))) as client:
        response = client.post(
            "/api/v1/jobs",
            data={"input_type": "dicom"},
            files={"file": ("scan.nii", _nifti_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 422


def test_worker_records_inference_failure(tmp_path: Path) -> None:
    command = f"{sys.executable} -c 'import sys; sys.exit(7)'"
    with TestClient(create_app(_settings(tmp_path, command))) as client:
        response = client.post(
            "/api/v1/jobs",
            files={"file": ("scan.nii", _nifti_bytes(), "application/octet-stream")},
        )
        failed = _wait(client, response.json()["id"], "failed")
        assert failed["error_code"] == "INFERENCE_FAILED"
        assert client.get(
            f"/api/v1/jobs/{failed['id']}/result"
        ).status_code == 409


def test_upload_limit_cleans_partial_file(tmp_path: Path) -> None:
    settings = _settings(tmp_path, "")
    settings = Settings(
        **{**settings.__dict__, "max_upload_bytes": 100}
    )
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/jobs",
            files={"file": ("scan.nii", _nifti_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 413
        assert not any((settings.data_dir / "jobs").iterdir())


def test_mask_volume_ml(tmp_path: Path) -> None:
    mask = np.zeros((4, 5, 6), dtype=np.uint8)
    mask.flat[:8] = 1
    path = tmp_path / "mask.nii.gz"
    nib.save(nib.Nifti1Image(mask, np.diag([0.5, 0.5, 5.0, 1.0])), path)
    assert mask_volume_ml(path) == 0.01


def test_pacs_study_reuses_persisted_result_for_same_model(
    tmp_path: Path, monkeypatch
) -> None:
    helper = tmp_path / "fake_inference.py"
    helper.write_text(
        "import pathlib, shutil, sys\n"
        "pathlib.Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)\n"
        "shutil.copyfile(sys.argv[1], sys.argv[2])\n"
    )
    settings = replace(
        _settings(tmp_path, f"{sys.executable} {helper} {{input}} {{output}}"),
        dicom_enabled=True,
        orthanc_url="http://orthanc.test",
        direct_upload_enabled=False,
        model_version="test-model-v1",
    )
    app = create_app(settings)
    calls = {"select": 0}

    def fake_convert(_source, _uid, output):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(_nifti_bytes(True))

    monkeypatch.setattr("app.main.dicom_series_to_nifti", fake_convert)
    app.state.orthanc.get_study_summary = lambda _study_id: {
        "study_instance_uid": "1.2.826.0.1.3680043.10.999.1",
        "is_stable": True,
    }

    def fake_select(_study_id):
        calls["select"] += 1
        return SeriesCandidate(
            orthanc_id="series-1",
                series_instance_uid="1.2.3.4",
                description="AXIAL BRAIN",
                protocol_name="HEAD NCCT",
                modality="CT",
                image_count=30,
                slice_thickness_mm=5.0,
                convolution_kernel="STANDARD",
                image_type="ORIGINAL\\PRIMARY\\AXIAL",
                score=100,
        )

    app.state.orthanc.select_series = fake_select
    app.state.orthanc.download_series = lambda _series, target: target.mkdir(
        parents=True, exist_ok=False
    )

    with TestClient(app) as client:
        first = client.post("/api/v1/dicom/studies/orthanc-study-1/analyze")
        assert first.status_code == 202
        completed = _wait(client, first.json()["id"], "succeeded")
        second = client.post("/api/v1/dicom/studies/orthanc-study-1/analyze")
        assert second.status_code == 200
        assert second.json()["id"] == completed["id"]
        assert second.json()["study_id"] == "1.2.826.0.1.3680043.10.999.1"
        assert second.json()["model_version"] == "test-model-v1"
        assert client.get("/api/v1/jobs").json()["count"] == 1
        assert calls["select"] == 1
        assert client.post(
            "/api/v1/dicom/studies/orthanc-study-1/analyze?force=true"
        ).status_code == 401


def test_pacs_worklist_shows_latest_result_from_high_tier(tmp_path: Path) -> None:
    settings = replace(
        _settings(tmp_path, ""),
        dicom_enabled=True,
        orthanc_url="http://orthanc.test",
        model_version="fast-v1",
        model_high_version="high-v3",
    )
    app = create_app(settings)
    study_uid = "1.2.826.0.1.3680043.10.999.7"
    app.state.orthanc.list_studies = lambda _limit: [{
        "orthanc_id": "orthanc-study-7",
        "study_instance_uid": study_uid,
    }]
    source = tmp_path / "source.nii.gz"
    output = tmp_path / "mask.nii.gz"
    source.write_bytes(_nifti_bytes(True))
    output.write_bytes(_nifti_bytes(True))

    with TestClient(app) as client:
        app.state.store.create(
            "high-job",
            "DICOM study orthanc-study-7",
            "dicom",
            source.stat().st_size,
            source,
            output,
            study_id=study_uid,
            model_version="high-v3",
            inference_tier="high",
        )
        with app.state.store._connect() as connection:
            connection.execute(
                "UPDATE jobs SET status='succeeded' WHERE id='high-job'"
            )
        item = client.get("/api/v1/studies").json()["items"][0]
        assert item["ai_status"] == "succeeded"
        assert item["ai_job_id"] == "high-job"
        assert item["ai_model_version"] == "high-v3"
