"""Model choice and deployment authority are checked before side effects."""
import dataclasses

from fastapi.testclient import TestClient

from app.main import create_app
from test_annotation import _make_settings


def _login(client, username):
    result = client.post("/api/v1/auth/login", json={"username": username, "password": username + "123"})
    assert result.status_code == 200
    return {"Authorization": "Bearer " + result.json()["token"]}


def test_non_admin_cannot_change_models_or_deploy(tmp_path):
    settings = dataclasses.replace(_make_settings(tmp_path), training_command="false")
    with TestClient(create_app(settings)) as client:
        user = _login(client, "user")
        admin = _login(client, "admin")
        operations = [
            ("put", "/api/v1/mlops/automation", {"auto_analyze_ct": False, "inference_tier": "fast"}),
            ("put", "/api/v1/studio/policy", {}),
            ("post", "/api/v1/studio/launch", None),
            ("post", "/api/v1/studio/runs/absent/release", None),
            ("post", "/api/v1/training/runs", {"name": "unauthorized", "dataset_version_id": "absent", "mode": "fine_tune", "created_by": "admin"}),
            ("post", "/api/v1/models/absent/transition", {"target_stage": "production", "actor": "admin"}),
            ("post", "/api/v1/annotations/cases/absent/inference?tier=high", None),
            ("post", "/api/v1/dicom/studies/absent/analyze?tier=standard", None),
        ]
        for method, url, payload in operations:
            assert client.request(method, url, json=payload).status_code == 401, url
            assert client.request(method, url, json=payload, headers=user).status_code == 403, url
        assert client.get("/api/v1/jobs", headers=user).status_code == 200
        assert client.get("/api/v1/annotations/cases", headers=user).status_code == 200
        assert client.get("/api/v1/models", headers=user).status_code == 200
        # Admin role comes from authentication, not a body/header assertion.
        assert client.post("/api/v1/models/absent/transition", json={"target_stage": "production", "actor": "user"}, headers=admin).status_code == 404
        assert client.put("/api/v1/mlops/automation", json={"auto_analyze_ct": False, "inference_tier": "high"}, headers=admin).status_code == 200
        assert client.get("/api/v1/capabilities").json()["default_tier"] == "high"
        # Non-admin may run the selected tier, but cannot choose another one.
        assert client.post("/api/v1/annotations/cases/absent/inference?tier=high", headers=user).status_code == 404
        assert client.post("/api/v1/annotations/cases/absent/inference?tier=fast", headers=user).status_code == 403
        assert client.get("/api/v1/jobs").json()["count"] == 0
        assert client.get("/api/v1/training/runs").json()["items"] == []
        client.post("/api/v1/auth/logout", headers=admin)
        assert client.put("/api/v1/studio/policy", json={}, headers=admin).status_code == 401
