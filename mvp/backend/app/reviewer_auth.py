"""Named reviewer credentials for approving research annotations.

Passwords are verified for each approval; no credentials or sessions are logged.
This protects approval attribution, not access to the whole research workspace.
"""
import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from pathlib import Path

from fastapi import HTTPException, Request


def password_record(password: str) -> dict:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000)
    return {"salt": salt, "digest": digest.hex()}


class ReviewerAuth:
    def __init__(self, path: str):
        self.path = path
        self.session_resolver = None
        self.failures = {}
        self.lock = threading.Lock()

    def set_session_resolver(self, resolver) -> None:
        """Accept the application Bearer session as the audited user identity."""
        self.session_resolver = resolver

    @property
    def configured(self):
        return bool(self.session_resolver or (self.path and Path(self.path).is_file()))

    def verify(self, request: Request) -> str:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer ") and self.session_resolver:
            try:
                account = self.session_resolver(header.split(" ", 1)[1])
                username = str(account.get("username", "")).strip()
                if not username:
                    raise ValueError()
                return username
            except Exception:
                raise HTTPException(401, "Phiên đăng nhập BrainHem không còn hợp lệ.") from None
        if not self.configured:
            raise HTTPException(503, "Chưa cấu hình tài khoản người dùng lâm sàng. Liên hệ quản trị viên để tiếp tục.")
        if not (self.path and Path(self.path).is_file()):
            raise HTTPException(401, "Hãy sử dụng phiên đăng nhập BrainHem để tiếp tục.")
        host = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with self.lock:
            self.failures = {k: [t for t in v if now - t < 60] for k, v in self.failures.items() if any(now - t < 60 for t in v)}
            attempts = self.failures.setdefault(host, [])
            if len(attempts) >= 10:
                raise HTTPException(429, "Thử đăng nhập quá nhiều lần. Vui lòng chờ một phút.")
            attempts.append(now)
        try:
            scheme, encoded = header.split(" ", 1)
            if scheme.lower() != "basic" or len(encoded) > 2048:
                raise ValueError()
            username, password = base64.b64decode(encoded, validate=True).decode().split(":", 1)
            users = json.loads(Path(self.path).read_text())
            record = users.get(username)
            salt = bytes.fromhex(record["salt"]) if record else bytes(16)
            digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600_000).hex()
            if not record or not hmac.compare_digest(digest, record["digest"]):
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError):
            raise HTTPException(401, "Tài khoản hoặc mật khẩu người duyệt không đúng.") from None
        with self.lock:
            # Remove only this attempt; concurrent failures must remain rate limited.
            if now in self.failures.get(host, []):
                self.failures[host].remove(now)
        return username
