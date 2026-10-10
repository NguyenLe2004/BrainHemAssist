from __future__ import annotations

import shlex
import os
import signal
import requests
import shutil
import subprocess
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
from contextlib import nullcontext
from .gpu_admission import gpu_slot, GPUResourceBusy


class InferenceError(RuntimeError):
    def __init__(self, message: str, code: str = "INFERENCE_FAILED", retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def mask_volume_ml(path: Path) -> float | None:
    """Return nonzero mask volume in mL, or None for a malformed artifact."""
    try:
        image = nib.load(path)
        voxel_volume_mm3 = abs(float(np.linalg.det(image.affine[:3, :3])))
        if not np.isfinite(voxel_volume_mm3) or voxel_volume_mm3 <= 0:
            return None
        nonzero_voxels = int(np.count_nonzero(np.asanyarray(image.dataobj)))
        return round(nonzero_voxels * voxel_volume_mm3 / 1000.0, 3)
    except Exception:
        return None


class CommandInferenceAdapter:
    """Run an inference command without invoking a shell.

    Available placeholders are ``{input}``, ``{output}``, ``{output_dir}``
    and ``{job_id}``.
    """

    def __init__(
        self,
        command: str = "",
        timeout_seconds: int = 900,
        settings: Any | None = None,
    ) -> None:
        self.command = command
        self.timeout_seconds = timeout_seconds
        self.settings = settings
        self.release_resolver = None

    @property
    def configured(self) -> bool:
        if self.settings:
            return bool(self.settings.inference_command)
        return bool(self.command)

    def is_tier_configured(self, tier: str) -> bool:
        norm = (tier or "fast").strip().lower()
        if self.settings:
            try:
                return bool(self.settings.get_tier_command(norm))
            except ValueError:
                return False
        return norm == "fast" and bool(self.command)

    def is_tier_available(self, tier: str) -> bool:
        """Return whether a configured command can at least be launched.

        This deliberately does not claim that a model is clinically ready; it
        only prevents a missing executable from being advertised as online.
        Remote/Triton readiness is checked by the API separately.
        """
        norm = (tier or "fast").strip().lower()
        if self.settings:
            try:
                command = self.settings.get_tier_command(norm)
            except ValueError:
                return False
        else:
            command = self.command if norm == "fast" else ""
        if not command:
            return False
        try:
            executable = shlex.split(command)[0]
        except (ValueError, IndexError):
            return False
        path = Path(executable)
        return path.is_file() if path.is_absolute() else shutil.which(executable) is not None

    def runtime_ready(self, tier: str) -> bool:
        if not self.is_tier_available(tier):
            return False
        probe = self.settings.inference_standard_probe_url if self.settings and tier == "standard" else ""
        if not probe:
            return True
        try:
            response = requests.get(probe, timeout=1, allow_redirects=False)
            return 200 <= response.status_code < 300
        except requests.RequestException:
            return False

    def run(
        self,
        job_id: str,
        input_path: Path,
        output_path: Path,
        tier: str = "fast",
        extension_enabled: bool = False,
        model_version: str = "",
    ) -> None:
        if extension_enabled:
            raise InferenceError("Optional inference mode is not available in this source release")
        norm_tier = (tier or "fast").strip().lower()
        cmd = ""
        if self.settings:
            try:
                cmd = self.settings.get_tier_command(norm_tier)
            except ValueError as exc:
                raise InferenceError(f"Unknown inference tier: {tier}") from exc
        elif norm_tier == "fast":
            cmd = self.command

        if not cmd:
            if norm_tier == "fast":
                raise InferenceError("BRAINHEM_INFERENCE_COMMAND is not configured")
            raise InferenceError(
                f"Inference tier '{tier}' is not configured on this server"
            )

        output_path.parent.mkdir(parents=True, exist_ok=True)
        variables = {
            "input": str(input_path),
            "output": str(output_path),
            "output_dir": str(output_path.parent),
            "job_id": job_id,
            "model_version": model_version,
        }
        try:
            arguments = [
                argument.format(**variables)
                for argument in shlex.split(cmd)
            ]
            arguments = [argument for argument in arguments if argument]
        except (KeyError, ValueError) as exc:
            raise InferenceError(f"Invalid inference command: {exc}") from exc
        try:
            slot = gpu_slot(self.settings.data_dir / "gpu-resource.lock") if self.settings else nullcontext(None)
            with slot as gpu_fd:
                process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, start_new_session=True, pass_fds=(gpu_fd,) if gpu_fd is not None else ())
                try:
                    stdout, stderr = process.communicate(timeout=self.timeout_seconds)
                except subprocess.TimeoutExpired as exc:
                    # A retry must not leave grandchildren using the GPU.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.communicate()
                    raise InferenceError("Inference timed out", "TIMEOUT", True) from exc
        except GPUResourceBusy as exc:
            raise InferenceError("GPU đang bận", "GPU_BUSY", True) from exc
        except OSError as exc:
            raise InferenceError("Could not start inference", "RUNTIME_UNAVAILABLE", True) from exc
        if process.returncode:
            detail = (stderr or stdout).strip()[-2000:]
            lower = detail.lower()
            oom = any(x in lower for x in ("out of memory", "cuda_error_out_of_memory"))
            transient = any(x in lower for x in ("connection refused", "connection reset", "temporarily unavailable", "503 service", "502 bad gateway"))
            code = "GPU_OOM" if oom else "RUNTIME_UNAVAILABLE" if transient else "INFERENCE_FAILED"
            raise InferenceError(f"Inference exited with code {process.returncode}: {detail}", code, oom or transient)
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise InferenceError(
                f"Inference did not create the expected output: {output_path.name}"
            )
