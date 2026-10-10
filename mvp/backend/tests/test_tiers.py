from pathlib import Path
import base64
import shlex
import sys

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.inference import CommandInferenceAdapter, InferenceError
from app.main import create_app


def _settings(tmp_path, **overrides):
    return Settings(data_dir=tmp_path / "data", database_path=tmp_path / "db.sqlite3",
                    inference_command="", inference_timeout_seconds=5,
                    max_upload_bytes=1048576, retention_hours=24,
                    worker_poll_seconds=0.02, rbac_enabled=False, feedback_admin_password="test-only-password", **overrides)


def test_optional_commands_cannot_enable_reserved_model_slots(tmp_path):
    settings = _settings(tmp_path, inference_standard_command="echo reserved",
                         inference_high_command="echo reserved")
    for tier in ("standard", "high"):
        assert settings.get_tier_command(tier) == ""
        assert not settings.is_tier_available(tier)
    with TestClient(create_app(settings), headers={"Authorization": "Basic " + base64.b64encode(b"admin:test-only-password").decode()}) as client:
        result = client.get("/api/v1/capabilities").json()
        for tier in ("standard", "high"):
            assert result["tiers"][tier]["available"] is False
            assert result["tiers"][tier]["command_configured"] is False


@pytest.mark.parametrize("tier", ["standard", "high"])
def test_missing_model_slot_never_runs_the_baseline_command(tmp_path, tier):
    output = tmp_path / "result.txt"
    settings = _settings(tmp_path)
    adapter = CommandInferenceAdapter(command="echo unexpected", settings=settings)
    with pytest.raises(InferenceError, match="not configured"):
        adapter.run("job", tmp_path / "input.nii", output, tier=tier)
    assert not output.exists()


def test_command_adapter_preserves_paths_with_spaces(tmp_path):
    script = tmp_path / "capture.py"
    script.write_text("import pathlib,sys\npathlib.Path(sys.argv[2]).write_text(sys.argv[1])\n")
    source, output = tmp_path / "input scan.nii", tmp_path / "result file.txt"
    command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} '{{input}}' '{{output}}'"
    CommandInferenceAdapter(command=command).run("job", source, output)
    assert output.read_text() == str(source)


def test_reserved_extension_is_rejected_before_execution(tmp_path):
    adapter = CommandInferenceAdapter(command="echo unexpected")
    with pytest.raises(InferenceError, match="not available"):
        adapter.run("job", tmp_path / "input.nii", tmp_path / "output.nii", extension_enabled=True)
