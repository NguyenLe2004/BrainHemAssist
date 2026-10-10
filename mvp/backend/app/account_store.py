"""SQLite accounts, hashed expiring sessions and metadata-only audit events."""
import hashlib
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from .reviewer_auth import password_record
from .authorization import ROLE_PERMISSIONS, ROLE_LABELS, permissions
import hmac

class AccountError(ValueError): pass

class AccountStore:
    def __init__(self, path, ttl_seconds=28800):
        self.path=Path(path); self.ttl=int(ttl_seconds)
        if self.ttl < 60: raise ValueError("Session lifetime must be at least 60 seconds")
    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con=sqlite3.connect(self.path, timeout=30); con.row_factory=sqlite3.Row
        try:
            yield con; con.commit()
        except Exception:
            con.rollback(); raise
        finally: con.close()
    def initialize(self, bootstrap):
        with self.db() as c:
            c.executescript("""CREATE TABLE IF NOT EXISTS access_accounts (
                username TEXT PRIMARY KEY, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                salt TEXT NOT NULL, digest TEXT NOT NULL, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS access_sessions (
                digest TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS access_sessions_user ON access_sessions(username);
                CREATE TABLE IF NOT EXISTS access_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at REAL NOT NULL,
                actor TEXT NOT NULL, role TEXT NOT NULL, method TEXT NOT NULL,
                path TEXT NOT NULL, permission TEXT NOT NULL, status INTEGER NOT NULL);
            """)
            for username,password,role in bootstrap:
                if not username or not password: continue
                if c.execute("SELECT 1 FROM access_accounts WHERE username=?",(username,)).fetchone(): continue
                r=password_record(password)
                c.execute("INSERT INTO access_accounts VALUES (?,?,1,?,?,?)",(username,role,r["salt"],r["digest"],time.time()))
    @staticmethod
    def public(row):
        return {"username":row["username"], "role":row["role"], "active":bool(row["active"]), "role_label":ROLE_LABELS.get(row["role"],row["role"]), "permissions":permissions(row["role"])}
    def authenticate(self,username,password):
        with self.db() as c: row=c.execute("SELECT * FROM access_accounts WHERE username=?",(username,)).fetchone()
        salt=bytes.fromhex(row["salt"]) if row else bytes(16)
        digest=hashlib.pbkdf2_hmac("sha256",password.encode(),salt,600000).hex()
        if not row or not row["active"] or not hmac.compare_digest(digest,row["digest"]):
            raise AccountError("Tài khoản hoặc mật khẩu không đúng.")
        return self.public(row)
    def login(self,username,password):
        actor=self.authenticate(username,password); token=secrets.token_urlsafe(32)
        with self.db() as c:
            c.execute("DELETE FROM access_sessions WHERE expires_at<=?",(time.time(),))
            # Recheck active inside write transaction: disabled accounts never
            # yield usable sessions; resolver also rechecks every request.
            c.execute("INSERT INTO access_sessions VALUES (?,?,?)",(hashlib.sha256(token.encode()).hexdigest(),username,time.time()+self.ttl))
        return {**actor,"token":token,"expires_in":self.ttl}
    def session(self,token):
        with self.db() as c:
            row=c.execute("SELECT a.* FROM access_sessions s JOIN access_accounts a ON a.username=s.username WHERE s.digest=? AND s.expires_at>? AND a.active=1",(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone()
        if not row: raise AccountError("Phiên đăng nhập hết hạn hoặc đã bị thu hồi.")
        return self.public(row)
    def logout(self,token):
        with self.db() as c: c.execute("DELETE FROM access_sessions WHERE digest=?",(hashlib.sha256(token.encode()).hexdigest(),))
    def list_accounts(self):
        with self.db() as c: return [self.public(r) for r in c.execute("SELECT * FROM access_accounts ORDER BY username")]
    def create(self,username,password,role):
        if not all(isinstance(v,str) for v in (username,password,role)): raise AccountError("Thông tin tài khoản phải là chuỗi.")
        username=username.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.@-]{3,80}",username): raise AccountError("Tên tài khoản cần 3–80 ký tự chữ, số hoặc . _ @ -")
        if role not in ROLE_PERMISSIONS: raise AccountError("Vai trò không hợp lệ.")
        if len(password)<12 or len(password)>256: raise AccountError("Mật khẩu mới cần 12–256 ký tự.")
        r=password_record(password)
        try:
            with self.db() as c: c.execute("INSERT INTO access_accounts VALUES (?,?,1,?,?,?)",(username,role,r["salt"],r["digest"],time.time()))
        except sqlite3.IntegrityError: raise AccountError("Tên tài khoản đã tồn tại.") from None
        return next(r for r in self.list_accounts() if r["username"]==username)
    def update(self,username,actor,role=None,active=None,password=None):
        if role is not None and not isinstance(role,str): raise AccountError("Vai trò không hợp lệ.")
        if password is not None and not isinstance(password,str): raise AccountError("Mật khẩu phải là chuỗi.")
        if role is not None and role not in ROLE_PERMISSIONS: raise AccountError("Vai trò không hợp lệ.")
        if password is not None and not 12<=len(password)<=256: raise AccountError("Mật khẩu mới cần 12–256 ký tự.")
        with self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            row=c.execute("SELECT * FROM access_accounts WHERE username=?",(username,)).fetchone()
            if not row: raise KeyError(username)
            newrole=role if role is not None else row["role"]; newactive=int(active) if active is not None else row["active"]
            if username==actor and (not newactive or newrole!="admin"): raise AccountError("Không thể tự khóa hoặc hạ quyền tài khoản đang quản trị.")
            if row["role"]=="admin" and row["active"] and (newrole!="admin" or not newactive):
                n=c.execute("SELECT COUNT(*) FROM access_accounts WHERE role='admin' AND active=1").fetchone()[0]
                if n<=1: raise AccountError("Cần giữ ít nhất một quản trị viên hoạt động.")
            r=password_record(password) if password else {"salt":row["salt"],"digest":row["digest"]}
            c.execute("UPDATE access_accounts SET role=?,active=?,salt=?,digest=? WHERE username=?",(newrole,newactive,r["salt"],r["digest"],username))
            c.execute("DELETE FROM access_sessions WHERE username=?",(username,))
        return next(r for r in self.list_accounts() if r["username"]==username)
    def audit(self,actor,method,path,permission,status):
        with self.db() as c: c.execute("INSERT INTO access_audit(occurred_at,actor,role,method,path,permission,status) VALUES (?,?,?,?,?,?,?)",(time.time(),actor.get("username","anonymous"),actor.get("role","guest"),method,path[:250],permission or "denied",status))
    def audit_items(self,limit=100):
        with self.db() as c: return [dict(r) for r in c.execute("SELECT * FROM access_audit ORDER BY id DESC LIMIT ?",(min(max(limit,1),500),))]
