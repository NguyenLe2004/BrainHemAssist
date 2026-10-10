import React from "react";
import StatusBadge from "./StatusBadge";

/**
 * Screen 22: Rollback Modal (Spec Section 22)
 * Truthful read-only blocked modal:
 * Automated rollback is not configured on backend (deployment_configured = false).
 * Displays current serving model, reports rollback target as unavailable,
 * and keeps the rollback CTA unconditionally disabled with clear explanation.
 */
export default function RollbackModal({
  currentModel,
  onClose,
}) {
  const curName = currentModel?.name || "Chưa xác định";
  const curVer = currentModel?.version || currentModel?.metrics?.model_version || "—";
  const targetName = "Chưa xác định điểm khôi phục";
  const targetVer = "—";

  return (
    <div
      className="sw-modal-backdrop"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(3, 10, 18, 0.8)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sw-modal-content sw-card"
        style={{
          width: "100%",
          maxWidth: "560px",
          background: "var(--sw-surface-1)",
          border: "1px solid var(--sw-border-default)",
          borderRadius: "12px",
          boxShadow: "var(--sw-shadow-lg)",
          padding: "24px",
          color: "var(--sw-text-primary)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "16px",
          }}
        >
          <div>
            <h3
              style={{
                margin: "0 0 4px 0",
                fontSize: "18px",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                color: "var(--sw-accent-warning)",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Rollback Serving Model
            </h3>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--sw-text-muted)" }}>
              Trạng thái khôi phục môi trường phục vụ lâm sàng về checkpoint trước đó.
            </p>
          </div>
          <button
            type="button"
            className="sw-btn sw-btn-ghost sw-btn-xs"
            onClick={onClose}
            style={{ fontSize: "18px", lineHeight: "1" }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div>
          {/* Version Transition Box */}
          <div
            style={{
              background: "var(--sw-surface-2)",
              border: "1px solid var(--sw-border-default)",
              borderRadius: "8px",
              padding: "14px",
              marginBottom: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              fontSize: "13px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--sw-text-muted)" }}>Phiên bản hiện tại:</span>
              <span style={{ fontWeight: "600", color: "var(--sw-text-primary)" }}>
                {curName} · {curVer}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--sw-text-muted)" }}>Hoàn nguyên về:</span>
              <span style={{ fontWeight: "600", color: "var(--sw-text-muted)" }}>
                {targetName}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--sw-text-muted)" }}>Trạng thái điểm khôi phục:</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--sw-accent-warning)" }}>
                <span className="sw-pulse-dot" style={{ backgroundColor: "var(--sw-accent-warning)" }} /> Chưa xác định điểm khôi phục
              </span>
            </div>
          </div>

          {/* Operational Notice / Blocker explanation */}
          <div
            style={{
              background: "rgba(245, 158, 11, 0.08)",
              border: "1px solid rgba(245, 158, 11, 0.25)",
              borderRadius: "8px",
              padding: "14px",
              marginBottom: "20px",
              fontSize: "12px",
              lineHeight: "1.5",
              color: "#FBBF24",
            }}
          >
            <div style={{ fontWeight: "600", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
              ⚠️ Tính năng rollback tự động chưa được cấu hình:
            </div>
            <p style={{ margin: "0 0 6px 0" }}>
              Backend hiện chưa cấu hình pipeline điều phối rollback tự động (<code>deployment_configured = false</code>) và chưa ghi nhận snapshot checkpoint trước đó.
            </p>
            <p style={{ margin: 0 }}>
              Để thực hiện hoàn nguyên khẩn cấp, quản trị viên hạ tầng cần nạp lại checkpoint thủ công trên runtime serving cục bộ.
            </p>
          </div>

          {/* Actions: Confirm disabled, Close enabled */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            <button
              type="button"
              className="sw-btn sw-btn-ghost"
              onClick={onClose}
            >
              Đóng
            </button>
            <button
              type="button"
              className="sw-btn sw-btn-danger"
              style={{ minWidth: "160px", opacity: 0.5, cursor: "not-allowed" }}
              disabled={true}
              title="Backend chưa cấu hình pipeline rollback tự động (deployment_configured = false)"
            >
              🔒 Rollback (Bị khóa)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
