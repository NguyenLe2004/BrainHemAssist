"""Default-deny permissions for the shared research workspace.
Roles express application authority, not professional accreditation.
"""
import re
from fastapi import HTTPException

READ = {"case.read", "job.read", "label.read"}
ROLE_PERMISSIONS = {
    "viewer": READ,
    "annotator": READ | {"case.ingest", "inference.create", "label.edit", "learning.submit"},
    "doctor": READ | {"case.ingest", "inference.create", "label.edit", "label.approve", "learning.submit", "learning.review", "model.domain_review", "model.read"},
    "model_admin": READ | {"dataset.manage", "training.manage", "model.manage", "model.deploy", "runtime.manage", "studio.read", "model.read"},
    "admin": READ | {"case.ingest", "inference.create", "label.edit", "label.approve", "learning.submit", "learning.review", "model.domain_review", "dataset.manage", "training.manage", "model.manage", "model.deploy", "runtime.manage", "studio.read", "account.manage", "audit.read", "feedback.manage", "model.read"},
}
ROLE_LABELS = {"viewer":"Người xem ảnh", "annotator":"Người gán nhãn", "doctor":"Bác sĩ / người duyệt nhãn", "model_admin":"Quản lý mô hình", "admin":"Quản trị hệ thống"}

def permissions(role):
    return sorted(ROLE_PERMISSIONS.get(role, set()))

def require(request, permission):
    if not request.app.state.settings.rbac_enabled:
        return
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(401, "Hãy đăng nhập để tiếp tục.")
    if permission not in ROLE_PERMISSIONS.get(actor["role"], set()):
        raise HTTPException(403, "Tài khoản không có quyền thực hiện thao tác này.")
    request.state.permission = permission

# Path policies only describe business permissions; endpoints still validate
# object identity, current revision and lifecycle rules. Unknown API paths deny.
def route_permission(method, path):
    read = method in {"GET", "HEAD"}
    if path.startswith("/api/v1/admin/accounts"): return "account.manage"
    if path.startswith("/api/v1/admin/audit"): return "audit.read"
    if path == "/api/v1/feedback/items": return "feedback.manage"
    if path in {"/api/v1/auth/me", "/api/v1/auth/logout", "/api/v1/feedback/me", "/api/v1/reviewer/verify"}: return "authenticated"
    if path in {"/api/v1/capabilities", "/api/v1/inference/capabilities"}: return "authenticated"
    if path.startswith("/api/v1/mlops/automation"): return "case.read" if read else "runtime.manage"
    if path == "/api/v1/mlops/capabilities": return "studio.read"
    if path.startswith("/api/v1/mlops/"): return "studio.read" if read else "runtime.manage"
    if path.startswith("/api/v1/studio/") or path == "/api/v1/studio":
        if read: return "studio.read"
        if path.endswith("/release"): return "model.deploy"
        return "training.manage"
    if path.startswith("/api/v1/datasets"): return "dataset.manage"
    if path.startswith("/api/v1/training/"): return "training.manage"
    if path.startswith("/api/v1/models"):
        if read: return "model.read"
        if path.endswith("/approvals"): return "model.review" # gate checked by endpoint
        if path.endswith("/transition"): return "model.deploy"
        return "studio.read" if read else "model.manage"
    if path.startswith("/api/v1/learning/"):
        if read: return "label.read"
        if path.endswith(("/reviews", "/adjudicate", "/transition")): return "learning.review"
        return "learning.submit"
    if path.startswith("/api/v1/annotations/"):
        if "export" in path: return "dataset.manage"
        if read: return "label.read"
        if path.endswith(("/infer", "/inference")): return "inference.create"
        if path.endswith(("/seed", "/revisions", "/propagate", "/sam2-propagate")): return "label.edit"
        return "case.ingest"
    if path.startswith("/api/v1/jobs"):
        if read: return "job.read"
        if path.endswith("/review"): return "label.approve"
        return "inference.create"
    if path.startswith("/api/v1/dicom/studies/"): return "inference.create"
    if path == "/api/v1/support/chat": return "authenticated"
    if path.startswith("/api/v1/studies"): return "case.read" if read else "inference.create"
    if path.startswith("/api/v1/simulator/"): return "case.ingest"
    if path.startswith("/api/v1/inference/"): return "inference.create"
    return None
