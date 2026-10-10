from pathlib import Path

import pytest

from app.config import Settings
from app.triton_deployer import TritonDeployer, TritonDeploymentError


def _settings(tmp_path: Path) -> Settings:
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        data_dir=tmp_path,
        database_path=tmp_path / "jobs.sqlite3",
        inference_command="",
        inference_timeout_seconds=30,
        max_upload_bytes=1024,
        retention_hours=24,
        worker_poll_seconds=0.1,
        triton_http_url="http://triton:8000",
        triton_model_repository=str(tmp_path / "models"),
        triton_model_name="baseline_s",
    )


def _repository(tmp_path: Path) -> tuple[Path, Path]:
    model_dir = tmp_path / "models" / "baseline_s"
    (model_dir / "1").mkdir(parents=True)
    (model_dir / "1" / "model.onnx").write_bytes(b"old")
    (model_dir / "config.pbtxt").write_text(
        'name: "baseline_s"\nversion_policy: { latest: { num_versions: 2 } }\n'
    )
    candidate = tmp_path / "candidate.onnx"
    candidate.write_bytes(b"new")
    return model_dir, candidate


def test_stage_publishes_version_only_after_triton_is_ready(tmp_path: Path, monkeypatch) -> None:
    model_dir, candidate = _repository(tmp_path)
    deployer = TritonDeployer(_settings(tmp_path))
    calls: list[object] = []
    monkeypatch.setattr(deployer, "_validate", lambda artifact: calls.append(artifact))
    monkeypatch.setattr(deployer, "_request_load", lambda: calls.append("load"))
    monkeypatch.setattr(deployer, "_wait_ready", lambda version: calls.append(("ready", version)))

    result = deployer.stage(str(candidate), "model-2", "sha-2", "1")

    assert result["model_version"] == "2"
    assert result["ready"] is True
    assert (model_dir / "2" / "model.onnx").read_bytes() == b"new"
    assert "versions: [ 1, 2 ]" in (model_dir / "config.pbtxt").read_text()
    assert calls[-2:] == ["load", ("ready", 2)]


def test_stage_rolls_back_unready_version(tmp_path: Path, monkeypatch) -> None:
    model_dir, candidate = _repository(tmp_path)
    deployer = TritonDeployer(_settings(tmp_path))
    loads = 0

    def load() -> None:
        nonlocal loads
        loads += 1

    monkeypatch.setattr(deployer, "_validate", lambda artifact: None)
    monkeypatch.setattr(deployer, "_request_load", load)
    monkeypatch.setattr(
        deployer,
        "_wait_ready",
        lambda version: (_ for _ in ()).throw(TritonDeploymentError("not ready")),
    )

    with pytest.raises(TritonDeploymentError, match="not ready"):
        deployer.stage(str(candidate), "model-2", "sha-2", "1")

    assert not (model_dir / "2").exists()
    assert (model_dir / "1" / "model.onnx").read_bytes() == b"old"
    assert (model_dir / "config.pbtxt").read_text() == (
        'name: "baseline_s"\nversion_policy: { latest: { num_versions: 2 } }\n'
    )
    assert list((tmp_path / "models" / ".failed" / "baseline_s").glob("2-*"))
    assert loads == 2
