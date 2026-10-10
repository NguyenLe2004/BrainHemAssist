import React, { useState } from "react";
import StatusBadge from "./StatusBadge";

/**
 * Screen 9 / Screen 10: Release Workspace (Spec Section 20 & 21)
 * Preflight checks, Change summary, Release blocker explanation.
 * Truthful to backend: Release CTA remains disabled because automated release orchestration
 * is not configured on the backend (deployment_configured = false).
 */
export default function ReleaseWorkspaceView({
  servingModel,
  candidateModel,
  authorization,
  run,
  busy,
  onBack,
}) {
  const [releaseReason, setReleaseReason] = useState("");
  const [expandedCheck, setExpandedCheck] = useState("orchestration");

  if (!candidateModel) {
    return (
      <div className="sw-release-workspace sw-fade-in">
        <div className="sw-page-header-row">
          <div>
            <button
              type="button"
              className="sw-btn sw-btn-ghost sw-btn-sm"
              onClick={onBack}
              style={{ marginBottom: "8px", paddingLeft: 0 }}
            >
              ← Quay lại Model Operations
            </button>
            <h1 className="sw-title" style={{ fontSize: "24px", margin: "0 0 6px 0" }}>
              Release Workspace: Chưa có Candidate
            </h1>
            <p className="sw-subtitle" style={{ margin: 0 }}>
              Không tìm thấy mô hình candidate để phát hành.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <span className="sw-status-pill sw-status-warning">
              <span className="sw-pulse-dot" style={{ backgroundColor: "var(--sw-accent-warning)" }} /> Release bị khóa
            </span>
          </div>
        </div>
        <div className="sw-card" style={{ marginTop: "24px", padding: "32px", textAlign: "center" }}>
          <h3 style={{ margin: "0 0 8px 0" }}>Không có Candidate Model khả dụng</h3>
          <p style={{ color: "var(--sw-text-muted)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Hệ thống hiện tại chưa có mô hình fine-tune ứng viên nào đạt điều kiện để chuyển giao phát hành.
          </p>
          <button type="button" className="sw-btn sw-btn-secondary" onClick={onBack}>
            Quay lại danh sách models
          </button>
        </div>
      </div>
    );
  }

  // Real Model names and versions (no fake fallbacks)
  const curName = servingModel?.name || "Chưa xác định";
  const curVer = servingModel?.version || servingModel?.metrics?.model_version || "—";
  const curVariant = servingModel?.variant || servingModel?.metrics?.model_variant || "Biến thể chưa xác định";

  const candName = candidateModel?.name || (candidateModel?.id ? `Candidate ${candidateModel.id.slice(0, 8)}` : "Chưa chọn candidate");
  const candVer = candidateModel?.version || candidateModel?.id?.slice(0, 8) || "—";
  const candVariant = candidateModel?.variant || candidateModel?.metrics?.model_variant || "Biến thể chưa xác định";

  // Cohort comparison for preflight
  const sm = servingModel?.metrics || {};
  const cm = candidateModel?.metrics || {};
  const servingCohort = sm.dataset_name || "Chưa xác định";
  const servingStudies = sm.holdout_cases ?? sm.test_cases ?? null;
  const candidateCohort = cm.dataset_name || "Chưa xác định";
  const candidateStudies = cm.holdout_cases ?? cm.test_cases ?? null;
  const isSameCohort =
    Boolean(sm.dataset_name && cm.dataset_name && sm.dataset_name === cm.dataset_name) &&
    servingStudies !== null &&
    candidateStudies !== null &&
    servingStudies === candidateStudies;

  // Real approvals inspection: never infer from stage
  const approvalsList = Array.isArray(candidateModel?.approvals) ? candidateModel.approvals : [];
  const clinicalApproval = approvalsList.find(
    (app) => (app.gate === "clinical" || app.role === "clinical" || app.type === "clinical") && app.decision === "approved"
  );
  const technicalApproval = approvalsList.find(
    (app) => (app.gate === "technical" || app.role === "technical" || app.gate === "qa" || app.type === "technical") && app.decision === "approved"
  );
  const isArtifactVerified = Boolean(
    candidateModel && (candidateModel.artifact_verified === true || candidateModel.metrics?.artifact_verified === true || candidateModel.checksum_verified === true)
  );

  // 7 Truthful Preflight checks (unknown or blocked when lacking backend evidence)
  const checks = [
    {
      id: "artifact",
      name: "Serving artifact verified",
      desc: "Kiểm tra tính toàn vẹn của model artifact và checkpoint đăng ký.",
      status: isArtifactVerified ? "passed" : "blocked",
      details: isArtifactVerified
        ? `Đã xác minh checksum của model artifact (${candidateModel.id}).`
        : candidateModel?.id
        ? `Chưa có bằng chứng: Artifact ${candidateModel.id} chưa có chứng nhận xác minh checksum độc lập.`
        : "Không tìm thấy artifact của candidate.",
    },
    {
      id: "runtime",
      name: "Runtime compatibility",
      desc: "Kiểm tra tính tương thích với môi trường runtime serving.",
      status: "blocked",
      details: "Chưa có bằng chứng: Backend chưa tích hợp kiểm tra tương thích runtime tự động cho candidate này.",
    },
    {
      id: "cohort",
      name: "Benchmark uses same cohort",
      desc: "Xác nhận đánh giá trên cùng cohort như phiên bản đang phục vụ.",
      status: isSameCohort ? "passed" : "blocked",
      details: isSameCohort
        ? `Đồng nhất cohort đối chiếu: ${servingCohort} (${servingStudies} studies).`
        : (!candidateModel || servingCohort === "Chưa xác định" || candidateCohort === "Chưa xác định")
        ? "Chưa có bằng chứng: Thiếu thông tin đối chiếu cohort giữa serving và candidate."
        : `Cohort không khớp: Serving (${servingCohort}, ${servingStudies ?? "—"} ca) vs Candidate (${candidateCohort}, ${candidateStudies ?? "—"} ca). Bắt buộc phải đánh giá trên cùng tập dữ liệu.`,
    },
    {
      id: "clinical",
      name: "Clinical approval",
      desc: "Phê duyệt chuyên môn lâm sàng từ hội đồng y khoa.",
      status: clinicalApproval ? "passed" : "blocked",
      details: clinicalApproval
        ? `Đã có phê duyệt lâm sàng trong hồ sơ (bởi ${clinicalApproval.author || "Bác sĩ chuyên môn"}).`
        : "Chưa có bằng chứng: Không tìm thấy phê duyệt lâm sàng (gate clinical) trong danh sách approvals của candidate này.",
    },
    {
      id: "qa",
      name: "QA approval",
      desc: "Kiểm định kỹ thuật và kiểm thử hồi quy an toàn.",
      status: technicalApproval ? "passed" : "blocked",
      details: technicalApproval
        ? `Đã có phê duyệt kỹ thuật trong hồ sơ (bởi ${technicalApproval.author || "Kỹ sư QA"}).`
        : "Chưa có bằng chứng: Không tìm thấy phê duyệt kỹ thuật (gate technical) trong danh sách approvals của candidate này.",
    },
    {
      id: "orchestration",
      name: "Automated release orchestration",
      desc: "Hỗ trợ điều phối phát hành tự động qua API cụm worker.",
      status: "blocked",
      details: "Backend chưa cấu hình pipeline điều phối release tự động (deployment_configured = false). Cần thực hiện release thủ công bởi quản trị viên hạ tầng.",
    },
    {
      id: "rollback",
      name: "Rollback target available",
      desc: "Phiên bản rollback khả dụng và đã kiểm tra an toàn.",
      status: "blocked",
      details: "Chưa có bằng chứng: Backend chưa cấu hình điểm khôi phục tự động (deployment_configured = false).",
    },
  ];

  const allPassed = checks.every((c) => c.status === "passed");
  const passedCount = checks.filter((c) => c.status === "passed").length;

  const toggleCheck = (id) => {
    setExpandedCheck(expandedCheck === id ? null : id);
  };

  return (
    <div className="sw-release-workspace sw-fade-in">
      {/* Top Breadcrumb & Status */}
      <div className="sw-page-header-row">
        <div>
          <button
            type="button"
            className="sw-btn sw-btn-ghost sw-btn-sm"
            onClick={onBack}
            style={{ marginBottom: "8px", paddingLeft: 0 }}
          >
            ← Quay lại Model Operations
          </button>
          <h1 className="sw-title" style={{ fontSize: "24px", margin: "0 0 6px 0" }}>
            Release Workspace: {candName}
          </h1>
          <p className="sw-subtitle" style={{ margin: 0 }}>
            Kiểm tra các điều kiện tiên quyết và trạng thái sẵn sàng phát hành.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="sw-status-pill sw-status-warning">
            <span className="sw-pulse-dot" style={{ backgroundColor: "var(--sw-accent-warning)" }} /> Release tự động bị khóa
          </span>
        </div>
      </div>

      {/* Release Grid */}
      <div className="sw-release-grid" style={{ marginTop: "20px" }}>
        {/* Left Column: 7 Preflight checks */}
        <div className="sw-release-col-main">
          <section className="sw-card">
            <div className="sw-card-header" style={{ alignItems: "center" }}>
              <div>
                <h2 className="sw-card-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  Preflight checks ({passedCount}/7 đạt)
                </h2>
                <p className="sw-card-desc">Kiểm tra các điều kiện tiên quyết trước khi phát hành model.</p>
              </div>
              <span className={`sw-badge ${allPassed ? "sw-badge-success" : "sw-badge-warning"}`}>
                {allPassed ? "Tất cả kiểm tra đã đạt" : "Có điều kiện chưa đạt"}
              </span>
            </div>

            <div className="sw-preflight-list">
              {checks.map((c) => {
                const isExp = expandedCheck === c.id;
                const isPass = c.status === "passed";
                return (
                  <div
                    key={c.id}
                    className={`sw-preflight-item ${isPass ? "pass" : "fail"} ${
                      isExp ? "expanded" : ""
                    }`}
                    style={{
                      background: "var(--sw-surface-2)",
                      border: "1px solid var(--sw-border-default)",
                      borderRadius: "8px",
                      padding: "14px 16px",
                      marginBottom: "10px",
                      cursor: "pointer",
                    }}
                    onClick={() => toggleCheck(c.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "22px",
                            height: "22px",
                            borderRadius: "50%",
                            background: isPass ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                            color: isPass ? "#10B981" : "#EF4444",
                            fontWeight: "bold",
                            fontSize: "13px",
                            flexShrink: 0,
                          }}
                        >
                          {isPass ? "✓" : "✕"}
                        </span>
                        <div>
                          <div style={{ fontWeight: "600", fontSize: "14px", color: "var(--sw-text-primary)" }}>
                            {c.name}
                          </div>
                          <div style={{ fontSize: "12px", color: "var(--sw-text-muted)", marginTop: "2px" }}>
                            {c.desc}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <StatusBadge status={isPass ? "Đạt" : "Chưa đạt"} />
                        <span style={{ color: "var(--sw-text-muted)", fontSize: "14px" }}>
                          {isExp ? "▲" : "▼"}
                        </span>
                      </div>
                    </div>

                    {isExp && (
                      <div
                        style={{
                          marginTop: "12px",
                          paddingTop: "12px",
                          borderTop: "1px dashed var(--sw-border-default)",
                          fontSize: "12px",
                          color: "var(--sw-text-secondary)",
                        }}
                      >
                        <div style={{ fontFamily: "var(--sw-font-mono)", color: isPass ? "var(--sw-text-muted)" : "var(--sw-accent-danger)" }}>
                          {c.details}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* Right Column: Change Summary & Release Reason */}
        <div className="sw-release-col-side" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Tóm tắt thay đổi */}
          <section className="sw-card">
            <div className="sw-card-header">
              <div>
                <h3 className="sw-card-title">Tóm tắt đối chiếu</h3>
                <p className="sw-card-desc">Thông tin phiên bản model serving và candidate.</p>
              </div>
            </div>

            <div className="sw-change-summary-rows" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: "var(--sw-surface-2)",
                  borderRadius: "6px",
                }}
              >
                <span style={{ fontSize: "13px", color: "var(--sw-text-muted)" }}>Đang phục vụ</span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: "600", fontSize: "13px" }}>
                    {curName} · {curVer}
                  </span>
                  <span className="sw-badge sw-badge-neutral" style={{ fontSize: "11px" }}>
                    Production
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: "rgba(56, 189, 248, 0.05)",
                  border: "1px solid rgba(56, 189, 248, 0.2)",
                  borderRadius: "6px",
                }}
              >
                <span style={{ fontSize: "13px", color: "var(--sw-text-muted)" }}>Ứng viên candidate</span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: "600", fontSize: "13px", color: "var(--sw-accent-primary)" }}>
                    {candName}
                  </span>
                  <span className="sw-badge sw-badge-neutral" style={{ fontSize: "11px" }}>
                    {candidateModel?.stage || "candidate"}
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: "var(--sw-surface-2)",
                  borderRadius: "6px",
                }}
              >
                <span style={{ fontSize: "13px", color: "var(--sw-text-muted)" }}>Rollback target</span>
                <span style={{ fontWeight: "600", fontSize: "13px", color: "var(--sw-text-muted)" }}>
                  Chưa xác định điểm khôi phục
                </span>
              </div>
            </div>
          </section>

          {/* Lý do release & Disabled CTA */}
          <section className="sw-card">
            <div className="sw-card-header">
              <div>
                <h3 className="sw-card-title">Ghi chú phát hành</h3>
                <p className="sw-card-desc">Ghi nhận lý do và phạm vi thay đổi cho nhật ký kiểm toán.</p>
              </div>
            </div>

            <textarea
              className="sw-input sw-textarea"
              rows={3}
              placeholder="Nhập lý do hoặc biên bản ghi nhận trước khi chuyển giao..."
              value={releaseReason}
              onChange={(e) => setReleaseReason(e.target.value)}
              maxLength={1000}
              style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
            />

            <div style={{ marginTop: "16px" }}>
              {/* Release CTA stays disabled with truthful explanation */}
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                style={{ width: "100%", justifyContent: "center", padding: "12px", opacity: 0.6, cursor: "not-allowed" }}
                disabled={true}
                title="Tính năng release tự động bị khóa"
              >
                🔒 Release Model (Khóa)
              </button>

              <div
                style={{
                  fontSize: "12px",
                  color: "var(--sw-accent-warning)",
                  textAlign: "center",
                  marginTop: "10px",
                  lineHeight: "1.4",
                  padding: "8px",
                  background: "rgba(245, 158, 11, 0.08)",
                  borderRadius: "6px",
                  border: "1px solid rgba(245, 158, 11, 0.2)",
                }}
              >
                ⚠️ <strong>Nút phát hành bị khóa:</strong> Backend chưa hỗ trợ điều phối phát hành tự động qua UI (<code>deployment_configured = false</code>) và candidate chưa thỏa mãn đầy đủ các điều kiện preflight (cohort đồng nhất & phê duyệt lâm sàng).
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
