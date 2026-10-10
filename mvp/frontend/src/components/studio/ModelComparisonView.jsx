import React, { useState } from "react";
import { Icon } from "../../icons";
import { approveModel } from "../../api";

export default function ModelComparisonView({
  servingModel,
  candidateModel,
  authorization,
  run,
  busy,
  onBack,
  onProceedToRelease,
}) {
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalDecision, setApprovalDecision] = useState("approved");
  const [approvedSuccess, setApprovedSuccess] = useState(false);

  if (!candidateModel) {
    return (
      <div className="sw-page sw-fade-in">
        <header className="sw-detail-header">
          <button type="button" className="sw-text-link" onClick={onBack}>
            ← Quay lại Model Operations
          </button>
          <div className="sw-detail-title-row">
            <div>
              <h1 style={{ margin: 0 }}>Baseline vs Candidate</h1>
              <p style={{ marginTop: 4, color: "var(--sw-text-muted)" }}>
                So sánh hiệu năng giữa mô hình đang phục vụ và mô hình ứng viên.
              </p>
            </div>
          </div>
        </header>
        <div className="sw-card" style={{ padding: "32px", textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "12px", color: "var(--sw-accent-amber)" }}>
            <Icon name="alert" size={36} />
          </div>
          <h3 style={{ margin: "0 0 8px 0" }}>Chưa có Candidate Model</h3>
          <p style={{ color: "var(--sw-text-muted)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Hệ thống hiện tại chưa có mô hình ứng viên fine-tune nào hoàn tất để đối chiếu với model phục vụ ({servingModel?.name || "Chưa xác định"}).
          </p>
          <button type="button" className="sw-btn sw-btn-secondary" onClick={onBack}>
            Quay lại danh sách models
          </button>
        </div>
      </div>
    );
  }

  const sm = servingModel?.metrics || {};
  const cm = candidateModel?.metrics || {};

  // Check validity: strictly real cohort and study count
  const servingCohort = sm.dataset_name || null;
  const candidateCohort = cm.dataset_name || null;
  const servingStudies = sm.holdout_cases ?? sm.test_cases ?? null;
  const candidateStudies = cm.holdout_cases ?? cm.test_cases ?? null;

  const isSameCohort =
    Boolean(servingCohort && candidateCohort && servingCohort === candidateCohort) &&
    servingStudies !== null &&
    candidateStudies !== null &&
    servingStudies === candidateStudies;

  // Real comparison metrics (no fabricated constants)
  const sDice = typeof sm.mean_dice === "number" ? sm.mean_dice : null;
  const cDice = typeof cm.mean_dice === "number" ? cm.mean_dice : null;
  const diceDelta = isSameCohort && sDice !== null && cDice !== null ? cDice - sDice : null;

  const sIou = typeof (sm.pooled_iou ?? sm.mean_iou) === "number" ? (sm.pooled_iou ?? sm.mean_iou) : null;
  const cIou = typeof (cm.pooled_iou ?? cm.mean_iou) === "number" ? (cm.pooled_iou ?? cm.mean_iou) : null;
  const iouDelta = isSameCohort && sIou !== null && cIou !== null ? cIou - sIou : null;

  const sHd95 = typeof sm.mean_hd95_mm === "number" ? sm.mean_hd95_mm : null;
  const cHd95 = typeof cm.mean_hd95_mm === "number" ? cm.mean_hd95_mm : null;
  const hd95Delta = isSameCohort && sHd95 !== null && cHd95 !== null ? cHd95 - sHd95 : null;

  const sRecall = typeof sm.lesion_recall === "number" ? sm.lesion_recall : null;
  const cRecall = typeof cm.lesion_recall === "number" ? cm.lesion_recall : null;
  const recallDelta = isSameCohort && sRecall !== null && cRecall !== null ? cRecall - sRecall : null;

  const sPrecision = typeof sm.precision === "number" ? sm.precision : null;
  const cPrecision = typeof cm.precision === "number" ? cm.precision : null;
  const precisionDelta = isSameCohort && sPrecision !== null && cPrecision !== null ? cPrecision - sPrecision : null;

  const metricsTable = [
    { label: "Macro Dice", unit: "", serving: sDice, candidate: cDice, delta: diceDelta, lowerIsBetter: false },
    { label: "IoU", unit: "", serving: sIou, candidate: cIou, delta: iouDelta, lowerIsBetter: false },
    { label: "HD95", unit: "mm", serving: sHd95, candidate: cHd95, delta: hd95Delta, lowerIsBetter: true },
    { label: "Recall", unit: "", serving: sRecall, candidate: cRecall, delta: recallDelta, lowerIsBetter: false },
    { label: "Precision", unit: "", serving: sPrecision, candidate: cPrecision, delta: precisionDelta, lowerIsBetter: false },
  ];

  const handleApprove = async () => {
    if (!approvalNote.trim()) return;
    run(async () => {
      await approveModel(candidateModel.id, {
        gate: "clinical",
        decision: approvalDecision,
        note: approvalNote,
      }, authorization);
      setApprovedSuccess(true);
    });
  };

  return (
    <div className="sw-page">
      {/* Header */}
      <header className="sw-detail-header">
        <button type="button" className="sw-text-link" onClick={onBack}>
          ← Quay lại Model Operations
        </button>
        <div className="sw-detail-title-row">
          <div>
            <h1 style={{ margin: 0 }}>Baseline vs Candidate</h1>
            <p style={{ marginTop: 4, color: "var(--sw-text-muted)" }}>
              So sánh hiệu năng giữa mô hình đang phục vụ và mô hình ứng viên trên cùng bộ dữ liệu đánh giá.
            </p>
          </div>
        </div>
      </header>

      {/* MANDATORY COMPARISON VALIDITY BANNER (Rule 10 & Spec 15.1) */}
      {isSameCohort ? (
        <div className="sw-status-banner success">
          <Icon name="checkCircle" size={24} />
          <div>
            <strong>Direct comparison is valid</strong>
            <p>Cùng bộ dữ liệu đánh giá ({servingCohort} · {servingStudies} studies), cùng quy trình tiền xử lý và tiêu chí đánh giá.</p>
          </div>
        </div>
      ) : (
        <div className="sw-status-banner error">
          <Icon name="alert" size={24} />
          <div>
            <strong>! Không thể so sánh trực tiếp</strong>
            <p>
              Serving đang dùng tập <strong>{servingCohort || "Chưa xác định"} ({servingStudies ? `${servingStudies} studies` : "Chưa có số lượng"})</strong> trong khi Candidate đang dùng tập <strong>{candidateCohort || "Chưa xác định"} ({candidateStudies ? `${candidateStudies} studies` : "Chưa có số lượng"})</strong>.
              Không thể tính toán mức độ cải thiện (Delta) hoặc phê duyệt phát hành khi hai mô hình được đo trên hai tập dữ liệu khác nhau.
            </p>
            <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
              <button
                type="button"
                className="sw-btn sw-btn-sm sw-btn-primary"
                onClick={() => alert(`Sẽ cấu hình chạy evaluation cho ${candidateModel?.name || "candidate"} trên ${servingCohort || "tập chuẩn"}.`)}
              >
                Chạy evaluation trên {servingCohort || "tập đối chiếu"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Evaluation Context Header */}
      <article className="sw-card sw-eval-context-card">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <div>
            <span className="sw-meta-label">Bộ dữ liệu đối chiếu</span>
            <strong style={{ fontSize: 14, display: "block", marginTop: 4 }}>{servingCohort || "Chưa xác định"}</strong>
            <small style={{ color: "var(--sw-text-muted)" }}>{servingStudies ? `${servingStudies} studies` : "Chưa có số lượng"}</small>
          </div>
          <div>
            <span className="sw-meta-label">Ngưỡng phát hiện (Threshold)</span>
            <strong style={{ fontSize: 14, display: "block", marginTop: 4 }}>0.50</strong>
            <small style={{ color: "var(--sw-text-muted)" }}>Probability mask threshold</small>
          </div>
          <div>
            <span className="sw-meta-label">Chính sách hậu xử lý</span>
            <strong style={{ fontSize: 14, display: "block", marginTop: 4 }}>Connected Components</strong>
            <small style={{ color: "var(--sw-text-muted)" }}>Min volume: 50 mm³</small>
          </div>
          <div>
            <span className="sw-meta-label">Chuẩn đo Dice</span>
            <strong style={{ fontSize: 14, display: "block", marginTop: 4 }}>nnU-Net Macro per-case</strong>
            <small style={{ color: "var(--sw-text-muted)" }}>Geometry khôi phục gốc</small>
          </div>
        </div>
      </article>

      {/* Comparison Table */}
      <article className="sw-card">
        <div className="sw-card-header">
          <span className="sw-card-title">
            <Icon name="chart" size={18} />
            Kết quả so sánh chi tiết
          </span>
          {!isSameCohort && (
            <span className="sw-badge amber">Khác biệt cohort · Khóa phê duyệt</span>
          )}
        </div>

        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Chỉ số (Metric)</th>
                <th>Serving ({servingModel?.name || "Chưa xác định"})</th>
                <th>Candidate ({candidateModel?.name || (candidateModel?.id ? candidateModel.id.slice(0, 8) : "Chưa chọn")})</th>
                <th>Delta (Độ lệch)</th>
              </tr>
            </thead>
            <tbody>
              {metricsTable.map((row) => {
                let deltaCell = <span style={{ color: "var(--sw-text-muted)" }}>—</span>;
                if (row.delta !== null && typeof row.delta === "number") {
                  const isPos = row.delta > 0;
                  const isGood = row.lowerIsBetter ? !isPos : isPos;
                  const sign = isPos ? "+" : "";
                  deltaCell = (
                    <span
                      style={{
                        fontWeight: 700,
                        color: isGood ? "var(--sw-success)" : "var(--sw-danger)",
                      }}
                    >
                      {isPos ? "▲" : "▼"} {sign}{row.delta.toFixed(3)} {row.unit}
                    </span>
                  );
                }

                return (
                  <tr key={row.label}>
                    <td>
                      <strong>{row.label}</strong>
                      {row.unit && <small style={{ display: "inline", marginLeft: 4 }}>({row.unit})</small>}
                      {row.lowerIsBetter && (
                        <small style={{ display: "block", color: "var(--sw-text-muted)" }}>
                          (Càng thấp càng tốt)
                        </small>
                      )}
                    </td>
                    <td>
                      <strong>
                        {typeof row.serving === "number" ? `${row.serving.toFixed(3)} ${row.unit}`.trim() : (row.serving ?? "—")}
                      </strong>
                    </td>
                    <td>
                      <strong>
                        {typeof row.candidate === "number" ? `${row.candidate.toFixed(3)} ${row.unit}`.trim() : (row.candidate ?? "—")}
                      </strong>
                    </td>
                    <td>{deltaCell}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>

      {/* Model Lifecycle Checklist (Spec 17) */}
      <article className="sw-card">
        <span className="sw-eyebrow">TIẾN TRÌNH VÒNG ĐỜI MODEL (MODEL LIFECYCLE CHECKLIST)</span>
        <div className="sw-lifecycle-checklist" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginTop: 14 }}>
          <div className="sw-checklist-item completed">
            <span className="sw-step-circle">✓</span>
            <div><strong>Huấn luyện</strong><small>Hoàn tất</small></div>
          </div>
          <div className={`sw-checklist-item ${candidateModel?.metrics?.validation_gate?.passed ? "completed" : "pending"}`}>
            <span className="sw-step-circle">{candidateModel?.metrics?.validation_gate?.passed ? "✓" : "2"}</span>
            <div><strong>Quality Gate</strong><small>{candidateModel?.metrics?.validation_gate?.passed ? "Đã đạt" : "Chưa đạt"}</small></div>
          </div>
          <div className={`sw-checklist-item ${approvedSuccess || candidateModel?.stage === "clinical_validated" ? "completed" : "pending"}`}>
            <span className="sw-step-circle">{approvedSuccess || candidateModel?.stage === "clinical_validated" ? "✓" : "3"}</span>
            <div><strong>Duyệt chuyên môn</strong><small>{approvedSuccess || candidateModel?.stage === "clinical_validated" ? "Đã duyệt" : "Chờ phê duyệt"}</small></div>
          </div>
          <div className="sw-checklist-item pending">
            <span className="sw-step-circle">4</span>
            <div><strong>Duyệt phát hành</strong><small>QA Approval</small></div>
          </div>
          <div className="sw-checklist-item pending">
            <span className="sw-step-circle">5</span>
            <div><strong>Chạy thử</strong><small>Trial (Canary)</small></div>
          </div>
          <div className="sw-checklist-item pending">
            <span className="sw-step-circle">6</span>
            <div><strong>Phục vụ</strong><small>Production</small></div>
          </div>
        </div>
      </article>

      {/* Clinical Review & Approval Form (Spec 18) */}
      <article className="sw-card sw-clinical-approval-card">
        <span className="sw-eyebrow">PHÊ DUYỆT CHUYÊN MÔN LÂM SÀNG</span>
        <h2>Quyết định phê duyệt chuyên môn</h2>
        <p>Bác sĩ chẩn đoán hình ảnh rà soát các trường hợp biên và ghi nhận nhận xét lâm sàng bắt buộc.</p>

        {approvedSuccess ? (
          <div className="sw-status-banner success" style={{ marginTop: 14 }}>
            <Icon name="checkCircle" size={20} />
            <div>
              <strong>Đã ghi nhận phê duyệt chuyên môn</strong>
              <p>Mô hình đã sẵn sàng cho bước duyệt phát hành và chạy thử nghiệm (Trial).</p>
            </div>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              style={{ marginLeft: "auto" }}
              onClick={() => onProceedToRelease(candidateModel)}
            >
              Tiến hành bước Phát hành (Release) →
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleApprove();
            }}
            style={{ marginTop: 14 }}
          >
            <div className="sw-fields">
              <label>
                Quyết định
                <select
                  className="sw-select"
                  value={approvalDecision}
                  onChange={(e) => setApprovalDecision(e.target.value)}
                >
                  <option value="approved">Phê duyệt (Đạt yêu cầu lâm sàng)</option>
                  <option value="rejected">Từ chối (Cần huấn luyện hoặc gán nhãn lại)</option>
                </select>
              </label>
              <label>
                Người phê duyệt
                <input className="sw-input" disabled value="Người dùng (Phiên hiện tại)" />
              </label>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
              Nhận xét lâm sàng / Lý do phê duyệt (Bắt buộc)
              <textarea
                required
                className="sw-textarea"
                rows={3}
                placeholder="Ghi nhận đánh giá về ranh giới xuất huyết, các ca âm tính giả và độ tin cậy..."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
              />
            </label>

            {!isSameCohort && (
              <div className="sw-blocker-banner" style={{ marginTop: 12 }}>
                <Icon name="alert" size={18} />
                <span>
                  Không thể phê duyệt model này cho tới khi được kiểm chuẩn trên cùng bộ dữ liệu đối chiếu ({servingCohort || "tập chuẩn của serving"}).
                </span>
              </div>
            )}

            <div className="sw-actions" style={{ marginTop: 16 }}>
              <button
                type="submit"
                className="sw-btn sw-btn-primary"
                disabled={busy || !isSameCohort || !approvalNote.trim()}
              >
                {busy ? "Đang lưu..." : "Xác nhận quyết định chuyên môn"}
              </button>
            </div>
          </form>
        )}
      </article>
    </div>
  );
}
