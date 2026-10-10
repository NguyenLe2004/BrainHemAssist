from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path


class FeedbackAuthError(RuntimeError):
    pass


class FeedbackLimitError(RuntimeError):
    pass


class FeedbackService:
    def __init__(
        self,
        data_dir: Path,
        hourly_quota: int,
        user_username: str,
        user_password: str,
        admin_username: str,
        admin_password: str,
    ) -> None:
        self.hourly_quota = hourly_quota
        self.user_username = user_username
        self.user_password = user_password
        self.admin_username = admin_username
        self.admin_password = admin_password
        self.store_path = data_dir / "feedback" / "submissions.jsonl"
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._sessions: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def authenticate(self, username: str, password: str) -> dict[str, str]:
        if not username or not password:
            raise FeedbackAuthError("Tài khoản hoặc mật khẩu không đúng.")
        if self.admin_password and hmac.compare_digest(username, self.admin_username) and hmac.compare_digest(password, self.admin_password):
            return {"username": username, "role": "admin"}
        if self.user_password and hmac.compare_digest(username, self.user_username) and hmac.compare_digest(password, self.user_password):
            return {"username": username, "role": "user"}
        raise FeedbackAuthError("Tài khoản hoặc mật khẩu không đúng.")

    def login(self, username: str, password: str) -> dict[str, str]:
        actor = self.authenticate(username, password)
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = {**actor, "created_at": time.time()}
        return {**actor, "token": token}

    def session(self, token: str) -> dict[str, str]:
        with self._lock:
            value = self._sessions.get(token)
        if not value:
            raise FeedbackAuthError("Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.")
        return {"username": str(value["username"]), "role": str(value["role"])}

    def logout(self, token: str) -> None:
        with self._lock:
            self._sessions.pop(token, None)

    def status(self) -> dict[str, object]:
        return {"mode": "internal", "hourly_quota": self.hourly_quota,
                "submission_authentication_required": False, "admin_authentication_required": True}

    def submit(self, payload: dict[str, str], actor: dict[str, str] | None, client_key: str) -> dict[str, object]:
        remaining = self._consume_quota(client_key)
        actor = actor or {"username": "anonymous", "role": "guest"}
        reference = f"FB-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:8].upper()}"
        if payload.get("website", "").strip():
            return {"delivered": True, "reference": reference, "message": "Đã ghi nhận góp ý.", "quota_remaining": remaining}
        record = {
            "reference": reference,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "account": actor["username"],
            "account_role": actor["role"],
            "role": payload["role"].strip(),
            "category": payload["category"].strip(),
            "message": payload["message"].strip(),
            "contact": payload.get("contact", "").strip(),
            "page": payload.get("page", "").strip(),
            "status": "new",
        }
        self._append_record(record)
        return {
            "delivered": True,
            "reference": reference,
            "message": "Góp ý đã được lưu và chuyển vào hộp thư quản trị.",
            "quota_remaining": remaining,
        }

    def list_all(self, actor: dict[str, str]) -> list[dict[str, str]]:
        if actor["role"] != "admin":
            raise FeedbackAuthError("Chỉ tài khoản admin được xem toàn bộ feedback.")
        if not self.store_path.is_file():
            return []
        records: list[dict[str, str]] = []
        with self.store_path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    records.append(item)
        return list(reversed(records))

    def _consume_quota(self, client_key: str) -> int:
        now = time.monotonic()
        with self._lock:
            attempts = self._attempts[client_key]
            while attempts and now - attempts[0] >= 3600:
                attempts.popleft()
            if len(attempts) >= self.hourly_quota:
                raise FeedbackLimitError("Bạn đã gửi quá nhiều góp ý. Vui lòng thử lại sau 1 giờ.")
            attempts.append(now)
            return self.hourly_quota - len(attempts)

    def _append_record(self, record: dict[str, str]) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            with self.store_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
