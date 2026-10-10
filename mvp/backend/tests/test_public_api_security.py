"""Publication security regressions using isolated synthetic requests."""
import base64
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

PASSWORD = "Isolated-public-security-test!"


def settings(tmp_path, **overrides):
    base = Settings(
        data_dir=tmp_path / "data", database_path=tmp_path / "jobs.sqlite3",
        inference_command="", inference_timeout_seconds=10,
        max_upload_bytes=1024 * 1024, retention_hours=24,
        worker_poll_seconds=0.02, feedback_admin_password=PASSWORD,
        feedback_user_password=PASSWORD, support_hourly_quota=1,
        feedback_hourly_quota=1,
    )
    return replace(base, **overrides)


def login(client):
    result = client.post("/api/v1/auth/login", json={"username": "admin", "password": PASSWORD})
    assert result.status_code == 200
    client.cookies.clear()
    return {"Authorization": "Bearer " + result.json()["token"]}


def basic(password):
    value = base64.b64encode(("admin:" + password).encode()).decode()
    return {"Authorization": "Basic " + value}


def test_spoofed_proxy_header_cannot_reset_anonymous_feedback_quota(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        payload = {"role": "researcher", "category": "suggestion", "message": "Synthetic feedback"}
        first = client.post("/api/v1/feedback", json=payload, headers={"X-Forwarded-For": "192.0.2.1"})
        second = client.post("/api/v1/feedback", json=payload, headers={"X-Forwarded-For": "192.0.2.2"})
        assert first.status_code == 200
        assert second.status_code == 429


def test_spoofed_proxy_header_cannot_reset_authenticated_support_quota(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        headers = login(client)
        payload = {"question": "Xóa thước đo thế nào?", "session_id": "synthetic-session", "page": "/"}
        first = client.post("/api/v1/support/chat", json=payload,
                            headers={**headers, "X-Forwarded-For": "192.0.2.1"})
        second = client.post("/api/v1/support/chat", json=payload,
                             headers={**headers, "X-Forwarded-For": "192.0.2.2"})
        assert first.json()["source"] != "quota"
        assert second.json()["source"] == "quota"


def test_rbac_basic_credentials_do_not_trigger_password_hashing(tmp_path, monkeypatch):
    app = create_app(settings(tmp_path))
    def reject_hashing(*args):
        pytest.fail("Protected Basic must not invoke password authentication")
    monkeypatch.setattr(app.state.feedback_service, "authenticate", reject_hashing)
    with TestClient(app) as client:
        assert client.get("/api/v1/jobs", headers=basic(PASSWORD)).status_code == 401


def test_research_mode_basic_and_login_share_failed_authentication_limit(tmp_path):
    with TestClient(create_app(settings(tmp_path, rbac_enabled=False))) as client:
        for _ in range(5):
            assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401
        for _ in range(5):
            assert client.get("/api/v1/feedback/me", headers=basic("wrong")).status_code == 401
        assert client.get("/api/v1/feedback/me", headers=basic(PASSWORD)).status_code == 429
        assert client.post("/api/v1/auth/login", json={"username": "admin", "password": PASSWORD}).status_code == 429


@pytest.mark.parametrize("option", ["extension", "enhancement"])
def test_reserved_inference_extension_is_rejected_before_lookup(tmp_path, option):
    with TestClient(create_app(settings(tmp_path))) as client:
        result = client.post(f"/api/v1/annotations/cases/missing/inference?{option}=true", headers=login(client))
        assert result.status_code == 422


def test_automation_extension_is_rejected_without_runtime_changes(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        headers = login(client)
        before = client.get("/api/v1/mlops/automation", headers=headers).json()
        result = client.put("/api/v1/mlops/automation", headers=headers,
                            json={"auto_analyze_ct": False, "inference_tier": "fast", "extension_enabled": True})
        assert result.status_code == 422
        assert client.get("/api/v1/mlops/automation", headers=headers).json() == before


def test_public_training_remains_unavailable_with_a_configured_command(tmp_path):
    with TestClient(create_app(settings(tmp_path, training_command="echo should-not-run"))) as client:
        headers = login(client)
        capabilities = client.get("/api/v1/mlops/capabilities", headers=headers).json()
        assert capabilities["training_configured"] is True
        assert capabilities["training_available"] is False
        assert "ONNX" in capabilities["training_unavailable_reason"]
        catalog = client.get("/api/v1/studio", headers=headers).json()
        assert catalog["fine_tune_options"] == []
        assert catalog["training"]["due"] is False
        assert "ONNX" in catalog["training"]["blocker"]
        assert client.post("/api/v1/studio/launch", headers=headers).status_code == 503
        response = client.post("/api/v1/training/runs", headers=headers, json={
            "dataset_version_id": "missing", "mode": "fine_tune", "name": "Blocked", "created_by": "admin", "base_model_id": "baseline-s"})
        assert response.status_code == 503
        assert "ONNX" in response.json()["detail"]
