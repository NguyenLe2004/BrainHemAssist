from __future__ import annotations

import json
import logging
import threading
import time
import uuid
import sqlite3
import random

from .config import Settings
from .inference import CommandInferenceAdapter, InferenceError
from .store import JobStore
from .validation import validate_mask_against_source, InvalidMaskError, InvalidNifti

log = logging.getLogger(__name__)

_MESSAGES = {
    "GPU_BUSY": "GPU đang bận. Yêu cầu được giữ trong hàng chờ; bạn vẫn có thể chỉnh nhãn.",
    "GPU_OOM": "GPU hiện không đủ bộ nhớ. Hệ thống sẽ thử lại; bạn vẫn có thể chỉnh nhãn thủ công.",
    "TIMEOUT": "Xử lý AI quá thời gian cho phép. Hệ thống đang thử lại có giới hạn.",
    "RUNTIME_UNAVAILABLE": "Kết nối xử lý AI bị gián đoạn. Hệ thống đang thử lại có giới hạn.",
    "OUTPUT_INVALID": "Kết quả AI không hợp lệ nên chưa được công bố. Bạn có thể tiếp tục thủ công.",
    "INFERENCE_FAILED": "AI chưa thể hoàn tất xử lý. Bạn có thể thử lại hoặc tiếp tục thủ công.",
}

class InferenceWorker:
    def __init__(self, store: JobStore, adapter: CommandInferenceAdapter, settings: Settings) -> None:
        self.store, self.adapter, self.settings = store, adapter, settings
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self.owner = uuid.uuid4().hex
        self.last_error: str | None = None
        # Longer than a single inference timeout: DB hiccups cannot let another
        # worker start a competing attempt while the subprocess is still alive.
        self.lease_seconds = settings.inference_timeout_seconds + 60

    @property
    def alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.alive:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="inference-worker", daemon=True)
        self._thread.start()

    def notify(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _heartbeat(self, job_id, attempt_id, done) -> None:
        while not done.wait(10):
            try:
                if not self.store.heartbeat(job_id, attempt_id, self.lease_seconds):
                    return
            except sqlite3.Error:
                log.exception("inference lease heartbeat failed job=%s", job_id)

    def _process(self, claimed) -> None:
        job_id, input_path, output_path, tier, extension, model, attempt_id = claimed
        if not self.adapter.is_tier_configured(tier):
            self.store.defer(job_id, attempt_id, "CONFIGURATION_MISSING",
                             f"Inference tier '{tier}' is not configured on this server", 0, retryable=False)
            return
        if not self.adapter.runtime_ready(tier):
            self.store.defer(job_id, attempt_id, "SERVICE_UNAVAILABLE",
                             "AI tạm chưa sẵn sàng. Yêu cầu được giữ lại; bạn vẫn có thể xem và chỉnh nhãn.",
                             self.settings.inference_wait_seconds, waiting=True)
            return
        attempt_output = output_path.parent / "attempts" / attempt_id / output_path.name
        attempt_output.parent.mkdir(parents=True, exist_ok=True)
        done = threading.Event()
        heartbeat = threading.Thread(target=self._heartbeat, args=(job_id, attempt_id, done), daemon=True)
        heartbeat.start()
        try:
            try:
                self.adapter.run(job_id, input_path, attempt_output, tier=tier,
                                 extension_enabled=extension, model_version=model)
                validation = validate_mask_against_source(input_path, attempt_output)
            except (InvalidMaskError, InvalidNifti) as exc:
                log.warning("invalid AI output job=%s attempt=%s: %s", job_id, attempt_id, exc)
                self.store.defer(job_id, attempt_id, "OUTPUT_INVALID", _MESSAGES["OUTPUT_INVALID"], 0, retryable=False)
                return
            except InferenceError as exc:
                log.warning("inference failed job=%s attempt=%s code=%s: %s", job_id, attempt_id, exc.code, exc)
                job = self.store.get(job_id)
                delay = self.settings.inference_retry_base_seconds * (3 ** max(0, (job.attempt_count if job else 1) - 1))
                delay *= random.uniform(.9, 1.1)
                self.store.defer(job_id, attempt_id, exc.code, _MESSAGES.get(exc.code, _MESSAGES["INFERENCE_FAILED"]),
                                 self.settings.inference_wait_seconds if exc.code == "GPU_BUSY" else delay,
                                 waiting=exc.code == "GPU_BUSY", retryable=exc.retryable)
                return
            metadata = None
            path = attempt_output.parent / "inference-metadata.json"
            if path.is_file():
                try:
                    candidate = json.loads(path.read_text())
                    if isinstance(candidate, dict):
                        metadata = candidate
                except (OSError, json.JSONDecodeError):
                    log.warning("invalid optional metadata job=%s", job_id)
            self.store.publish(job_id, attempt_id, attempt_output, validation["volume_ml"], metadata)
        finally:
            done.set()
            heartbeat.join(timeout=2)

    def _run(self) -> None:
        last_cleanup = time.monotonic()
        while not self._stop.is_set():
            try:
                claimed = self.store.claim_next(self.owner, self.lease_seconds)
                if claimed:
                    try:
                        self._process(claimed)
                    except (sqlite3.Error, OSError):
                        # Keep lease protected. Recovery after expiry cannot
                        # publish an unvalidated output or kill the loop.
                        self.last_error = "STORAGE_UNAVAILABLE"
                        log.exception("inference persistence failed job=%s", claimed[0])
                    except Exception:
                        log.exception("unexpected inference failure job=%s", claimed[0])
                        self.store.defer(claimed[0], claimed[-1], "INFERENCE_FAILED",
                                         _MESSAGES["INFERENCE_FAILED"], 0, retryable=False)
                    continue
                if time.monotonic() - last_cleanup >= 3600:
                    self.store.cleanup_expired(self.settings.retention_hours)
                    last_cleanup = time.monotonic()
                self.last_error = None
            except Exception:
                self.last_error = "WORKER_UNAVAILABLE"
                log.exception("inference dispatcher failed")
            self._wake.wait(max(.05, self.settings.worker_poll_seconds))
            self._wake.clear()
