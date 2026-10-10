from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.feedback import FeedbackAuthError, FeedbackService
from app.main import create_app


def test_unconfigured_feedback_credentials_cannot_authenticate(tmp_path):
    service = FeedbackService(tmp_path, 5, "user", "", "admin", "")
    for username, password in (("admin", ""), ("user", ""), ("", ""),
                               ("admin", "admin123"), ("user", "user123")):
        with pytest.raises(FeedbackAuthError):
            service.authenticate(username, password)


def test_default_install_has_no_demo_admin_or_user(tmp_path, monkeypatch):
    for name in ("BRAINHEM_FEEDBACK_USER_PASSWORD", "BRAINHEM_FEEDBACK_ADMIN_PASSWORD",
                 "BRAINHEM_SUPPORT_AGY_PATH"):
        monkeypatch.delenv(name, raising=False)
    settings = replace(Settings.from_env(), data_dir=tmp_path,
                       database_path=tmp_path / "jobs.sqlite3")
    assert settings.feedback_admin_password == ""
    assert settings.feedback_user_password == ""
    assert settings.support_agy_path == ""
    with TestClient(create_app(settings)) as client:
        for username, password in (("admin", "admin123"), ("user", "user123"),
                                   ("admin", "")):
            assert client.post("/api/v1/auth/login", json={
                "username": username, "password": password,
            }).status_code in (401, 422)
        assert client.get("/api/v1/jobs").status_code == 401
