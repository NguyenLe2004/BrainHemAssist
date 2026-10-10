from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from .config import Settings


class TritonDeploymentError(RuntimeError):
    pass


class TritonDeployer:
    """Atomically stage versioned ONNX artifacts into a Triton repository."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.repository = Path(settings.triton_model_repository).resolve() if settings.triton_model_repository else None
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.repository and self.settings.triton_http_url and self.settings.triton_model_name)

    def _validate(self, artifact: Path) -> None:
        if artifact.suffix.lower() != ".onnx" or not artifact.is_file() or artifact.stat().st_size == 0:
            raise TritonDeploymentError("Triton deployment requires a non-empty .onnx candidate artifact")
        try:
            import onnx
            model = onnx.load(str(artifact), load_external_data=False)
            onnx.checker.check_model(model)
            names = {item.name for item in model.graph.input}
            outputs = {item.name for item in model.graph.output}
            if not names or not outputs:
                raise TritonDeploymentError(f"ONNX IO mismatch: inputs={names}, outputs={outputs}")
        except TritonDeploymentError:
            raise
        except Exception as exc:
            raise TritonDeploymentError(f"ONNX validation failed: {exc}") from exc

    def _request_load(self) -> None:
        url = f"{self.settings.triton_http_url}/v2/repository/models/{self.settings.triton_model_name}/load"
        try:
            response = requests.post(url, json={}, timeout=15)
        except requests.RequestException as exc:
            raise TritonDeploymentError(f"Cannot call Triton repository API: {exc}") from exc
        if response.status_code not in {200, 204}:
            raise TritonDeploymentError(f"Triton load failed ({response.status_code}): {response.text[-1000:]}")

    def _wait_ready(self, version: int) -> None:
        url = f"{self.settings.triton_http_url}/v2/models/{self.settings.triton_model_name}/versions/{version}/ready"
        deadline = time.monotonic() + self.settings.triton_deploy_timeout_seconds
        last = ""
        while time.monotonic() < deadline:
            try:
                response = requests.get(url, timeout=5)
                if response.status_code == 200:
                    return
                last = f"HTTP {response.status_code}: {response.text[-500:]}"
            except requests.RequestException as exc:
                last = str(exc)
            time.sleep(2)
        raise TritonDeploymentError(f"Triton version {version} did not become ready: {last}")

    @staticmethod
    def _specific_version_config(config_text: str, versions: list[int]) -> str:
        replacement = "version_policy: { specific: { versions: [ " + ", ".join(map(str, versions)) + " ] } }"
        updated, count = re.subn(r"version_policy\s*:\s*\{[^\n]*\}", replacement, config_text, count=1)
        if count != 1:
            raise TritonDeploymentError("Triton config must contain a one-line version_policy")
        return updated

    @staticmethod
    def _write_config_atomic(config: Path, content: str) -> None:
        temporary = config.with_name(f".{config.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8")
            os.replace(temporary, config)
        finally:
            temporary.unlink(missing_ok=True)

    def stage(
        self,
        artifact_path: str,
        model_id: str,
        artifact_sha256: str,
        production_version: str,
    ) -> dict[str, Any]:
        if not self.configured or self.repository is None:
            raise TritonDeploymentError("Triton model repository deployment is not configured")
        artifact = Path(artifact_path).resolve()
        self._validate(artifact)
        model_dir = self.repository / self.settings.triton_model_name
        config = model_dir / "config.pbtxt"
        if not config.is_file():
            raise TritonDeploymentError(f"Triton config is missing: {config}")
        try:
            active_version = int(production_version)
        except (TypeError, ValueError) as exc:
            raise TritonDeploymentError("The current production Triton version must be numeric") from exc
        if not (model_dir / str(active_version) / "model.onnx").is_file():
            raise TritonDeploymentError(f"Production Triton version {active_version} is missing")
        with self._lock:
            versions = [int(item.name) for item in model_dir.iterdir() if item.is_dir() and item.name.isdigit()]
            version = max(versions, default=0) + 1
            staging = self.repository / f".staging-{self.settings.triton_model_name}-{uuid.uuid4().hex}"
            target = model_dir / str(version)
            original_config = config.read_text(encoding="utf-8")
            staging.mkdir(parents=False, exist_ok=False)
            try:
                shutil.copy2(artifact, staging / "model.onnx")
                metadata = {"triton_version": version, "model_id": model_id, "artifact_sha256": artifact_sha256,
                            "staged_at": datetime.now(timezone.utc).isoformat(), "state": "shadow"}
                (staging / "version_info.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
                os.replace(staging, target)
                next_config = self._specific_version_config(
                    original_config, sorted({active_version, version})
                )
                self._write_config_atomic(config, next_config)
                try:
                    self._request_load()
                    self._wait_ready(version)
                except Exception:
                    self._write_config_atomic(config, original_config)
                    failed = self.repository / ".failed" / self.settings.triton_model_name / f"{version}-{uuid.uuid4().hex[:8]}"
                    failed.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        os.replace(target, failed)
                    try:
                        self._request_load()
                    except Exception:
                        pass
                    raise
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        return {"backend": "triton", "model_name": self.settings.triton_model_name,
                "model_version": str(version), "repository_path": str(target), "ready": True}
