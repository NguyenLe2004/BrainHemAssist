import React, { useState } from "react";
import { Icon } from "../../icons";
import MetricWithContext from "./MetricWithContext";
import StatusBadge from "./StatusBadge";
import { downloadTrainingLog, validateTrainingRun } from "../../api";

/**
 * Screen 6: Fine-tune Run Detail View
 * Shows strictly real evaluation metrics and quality gates from backend runItem.
 * Never invents mock metrics, fake curves, or hard-coded fallback values.
 */
export default function FineTuneDetailView({
  runItem,
  caps,
  models = [],
  datasets = [],
  authorization,
  runAction,
  busy,
  onBack,
}) {
  const [subTab, setSubTab] = useState("results");
  const [showTrace, setShowTrace] = useState(false);

  if (!runItem) {
    return (
      <div className="sw-page">
        <button type="button" className="sw-btn sw-btn-ghost sw-btn-sm" onClick={onBack}>
          ← Quay lại danh sách Fine-tune
        </button>
        <p className="sw-empty">Không tìm thấy thông tin lần chạy này.</p>
      </div>
    );
  }

  const m = runItem.metrics || {};
  const gate = m.validation_gate;
  const isRunActive = ["queued", "running", "validation_queued", "validating"].includes(runItem.status);
  const isFailed = runItem.status === "failed";
  const isQualityFailed = !isRunActive && (gate?.passed === false || (isFailed && gate));
  const isSystemError = !isRunActive && isFailed && !gate;
  const isQualityPassed = !isRunActive && gate?.passed === true;

  // Real Evaluation Metrics - strictly null if absent!
  const diceVal = typeof m.mean_dice === "number" ? m.mean_dice : typeof m.macro_dice === "number" ? m.macro_dice : null;
  const iouVal = typeof m.mean_iou === "number" ? m.mean_iou : typeof m.pooled_iou === "number" ? m.pooled_iou : null;
  const hd95Val = typeof m.mean_hd95_mm === "number" ? m.mean_hd95_mm : typeof m.hd95_mm === "number" ? m.hd95_mm : null;
  const recallVal = typeof m.lesion_recall === "number" ? m.lesion_recall : typeof m.recall === "number" ? m.recall : null;
  const cohortName = m.dataset_name || (datasets.find((d) => d.id === runItem.dataset_version_id)?.name ?? "Chưa có thông tin cohort");
  const studyCount = m.holdout_cases ?? m.test_cases ?? null;

  // Real model identity & variant resolution
  const baseModel = models.find((mod) => mod.id === (runItem.base_model_id || runItem.model_id));
  const modelDisplayName = baseModel?.name || (runItem.base_model_id ? `Model ${runItem.base_model_id.slice(0, 8)}` : "Model chưa xác định");
  const variantDisplayName = m.model_variant || runItem.config?.model_variant || "Chưa xác định";

  // Build real quality gates list from gate object if present
  const qualityGatesList = [];
  if (gate?.measured && gate?.required) {
    if ("dice" in gate.required) {
      const measured = gate.measured.dice;
      const required = gate.required.dice;
      qualityGatesList.push({
        id: "dice",
        label: "Macro Dice",
        operator: ">=",
        threshold: required,
        actual: measured,
        unit: "",
        passed: typeof measured === "number" && typeof required === "number" ? measured >= required : false,
      });
    }
    if ("recall" in gate.required) {
      const measured = gate.measured.recall;
      const required = gate.required.recall;
      qualityGatesList.push({
        id: "recall",
        label: "Recall",
        operator: ">=",
        threshold: required,
        actual: measured,
        unit: "",
        passed: typeof measured === "number" && typeof required === "number" ? measured >= required : false,
      });
    }
    if ("latency" in gate.required || "latency_ms" in gate.required) {
      const measured = gate.measured.latency ?? gate.measured.latency_ms;
      const required = gate.required.latency ?? gate.required.latency_ms;
      qualityGatesList.push({
        id: "latency",
        label: "P95 latency",
        operator: "<=",
        threshold: required,
        actual: measured,
        unit: "ms",
        passed: typeof measured === "number" && typeof required === "number" ? measured <= required : false,
      });
    }
  }

  const handleDownloadLog = () => {
    runAction(async () => {
      const blob = await downloadTrainingLog(runItem.id, authorization);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `training-${runItem.id}.log`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };

  const handleRevalidate = () => {
    runAction(async () => {
      await validateTrainingRun(runItem.id, authorization);
    });
  };

  // Real worst cases if supplied by API
  const worstCases = Array.isArray(m.worst_cases) ? m.worst_cases : [];

  return (
    <div className="sw-page sw-fade-in">
      {/* Header */}
      <header className="sw-detail-header">
        <button
          type="button"
          className="sw-btn sw-btn-ghost sw-btn-sm"
          onClick={onBack}
          style={{ paddingLeft: 0, marginBottom: 8 }}
        >
          ← Quay lại danh sách Fine-tune
        </button>

        <div className="sw-detail-title-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ margin: 0 }}>{runItem.name}</h1>
              {isQualityFailed && <span className="sw-badge red">! Quality gate không đạt</span>}
              {isSystemError && <span className="sw-badge red">✕ Lỗi hệ thống</span>}
              {isQualityPassed && <span className="sw-badge green">✓ Đạt Quality gate</span>}
              {isRunActive && <span className="sw-badge blue">● Đang chạy</span>}
            </div>
            <p style={{ marginTop: 6, color: "var(--sw-text-muted)" }}>
              Kết quả huấn luyện và kiểm định chất lượng chuyên môn lâm sàng.
            </p>
          </div>

          <div className="sw-actions">
            <button type="button" className="sw-btn" onClick={handleDownloadLog} disabled={busy}>
              <Icon name="download" size={14} /> Tải log
            </button>
            {["succeeded", "failed"].includes(runItem.status) && (
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                onClick={handleRevalidate}
                disabled={busy || !caps?.validation_configured}
              >
                Chạy đánh giá model
              </button>
            )}
          </div>
        </div>

        {/* Metadata Strip */}
        <div
          className="sw-meta-strip"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            margin: "16px 0",
            padding: "12px 16px",
            background: "var(--sw-surface-1)",
            borderRadius: 8,
            border: "1px solid var(--sw-border-default)",
          }}
        >
          <div>
            <span className="sw-meta-label" style={{ fontSize: 11, color: "var(--sw-text-muted)", display: "block" }}>Model</span>
            <span className="sw-meta-val" style={{ fontWeight: 600 }}>{modelDisplayName}</span>
            <small style={{ display: "block", color: "var(--sw-text-muted)" }}>Biến thể {variantDisplayName}</small>
          </div>
          <div>
            <span className="sw-meta-label" style={{ fontSize: 11, color: "var(--sw-text-muted)", display: "block" }}>Dataset</span>
            <span className="sw-meta-val">{cohortName}</span>
          </div>
          <div>
            <span className="sw-meta-label" style={{ fontSize: 11, color: "var(--sw-text-muted)", display: "block" }}>Bắt đầu lúc</span>
            <span className="sw-meta-val">
              {runItem.created_at ? new Date(runItem.created_at).toLocaleString("vi-VN") : "—"}
            </span>
          </div>
          <div>
            <span className="sw-meta-label" style={{ fontSize: 11, color: "var(--sw-text-muted)", display: "block" }}>Thời gian chạy</span>
            <span className="sw-meta-val">
              {runItem.duration_seconds ? `${Math.round(runItem.duration_seconds / 60)} phút` : "Chưa có dữ liệu"}
            </span>
          </div>
          <div>
            <span className="sw-meta-label" style={{ fontSize: 11, color: "var(--sw-text-muted)", display: "block" }}>Trạng thái</span>
            <StatusBadge status={runItem.status} />
          </div>
        </div>

        {/* Sub-tabs */}
        <nav className="sw-tabs">
          {[
            ["results", "Kết quả & Quality gates"],
            ["curves", "Training curves"],
            ["worst_cases", `Trường hợp biên (${worstCases.length})`],
            ["config", "Cấu hình"],
            ["artifacts", "Artifacts"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={subTab === key ? "active" : ""}
              onClick={() => setSubTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {/* SUBTAB: RESULTS */}
      {subTab === "results" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 16 }}>
          {isQualityFailed && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: 14,
                borderRadius: 8,
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "#EF4444",
              }}
            >
              <Icon name="alert" size={20} />
              <div>
                <strong style={{ fontSize: 14 }}>Quality gate không đạt</strong>
                <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                  Mô hình chưa đáp ứng đầy đủ các tiêu chí chất lượng tối thiểu yêu cầu cho chẩn đoán lâm sàng.
                </p>
              </div>
            </div>
          )}

          {isSystemError && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: 14,
                borderRadius: 8,
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "#EF4444",
              }}
            >
              <Icon name="alert" size={20} />
              <div>
                <strong style={{ fontSize: 14 }}>Lỗi hệ thống trong quá trình huấn luyện / đánh giá</strong>
                <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                  Lần chạy gặp sự cố kỹ thuật hạ tầng. Checkpoint được bảo toàn nếu đã lưu trước lỗi.
                </p>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button type="button" className="sw-btn sw-btn-sm" onClick={handleRevalidate}>Thử lại</button>
                  <button type="button" className="sw-btn sw-btn-sm" onClick={() => setShowTrace(!showTrace)}>
                    {showTrace ? "Đóng Technical trace" : "Mở Technical trace"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {isQualityPassed && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: 14,
                borderRadius: 8,
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                color: "#10B981",
              }}
            >
              <Icon name="checkCircle" size={20} />
              <div>
                <strong style={{ fontSize: 14 }}>Quality gate đã đạt</strong>
                <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                  Mô hình đạt mọi tiêu chí chất lượng và sẵn sàng chuyển sang bước duyệt chuyên môn lâm sàng.
                </p>
              </div>
            </div>
          )}

          {/* Metric Cards Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
            <MetricWithContext
              label="Macro Dice"
              value={diceVal}
              digits={3}
              cohortName={cohortName}
              studyCount={studyCount}
            />
            <MetricWithContext
              label="IoU"
              value={iouVal}
              digits={3}
              cohortName={iouVal !== null ? "Theo volume" : ""}
            />
            <MetricWithContext
              label="HD95"
              value={hd95Val}
              unit="mm"
              digits={1}
              lowerIsBetter
              cohortName={hd95Val !== null ? "Biên xuất huyết" : ""}
            />
            <MetricWithContext
              label="Recall"
              value={recallVal}
              digits={3}
              cohortName={recallVal !== null ? "Theo ca" : ""}
            />
          </div>

          {/* Quality Gates List */}
          <article className="sw-card">
            <span className="sw-eyebrow">QUALITY GATES</span>
            {qualityGatesList.length > 0 ? (
              <div className="sw-table-wrap" style={{ marginTop: 12 }}>
                <table className="sw-table">
                  <thead>
                    <tr>
                      <th>Tiêu chí</th>
                      <th>Ngưỡng yêu cầu</th>
                      <th>Giá trị đo được</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qualityGatesList.map((qg) => (
                      <tr key={qg.id}>
                        <td><strong>{qg.label}</strong></td>
                        <td>{qg.operator} {qg.threshold} {qg.unit}</td>
                        <td>
                          <strong>
                            {typeof qg.actual === "number"
                              ? qg.actual.toLocaleString("vi-VN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                              : "Chưa đo"} {qg.unit}
                          </strong>
                        </td>
                        <td>
                          <span className={`sw-badge ${qg.passed ? "green" : "red"}`}>
                            {qg.passed ? "✓ Đạt" : "✕ Không đạt"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sw-notice" style={{ marginTop: 12 }}>
                <Icon name="info" size={16} />
                <span>Chưa có cấu hình hoặc báo cáo quality gate cho lần chạy này.</span>
              </div>
            )}
          </article>
        </div>
      )}

      {/* SUBTAB: CURVES */}
      {subTab === "curves" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Biểu đồ huấn luyện (Training Curves)</h2>
          <p>Theo dõi hàm mất mát (loss) và pseudo Dice trên từng epoch.</p>
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--sw-border-default)",
              borderRadius: 8,
              margin: "16px 0",
              textAlign: "center",
              color: "var(--sw-text-muted)",
            }}
          >
            <Icon name="chart" size={32} />
            <p style={{ marginTop: 8 }}>
              {m.live_progress
                ? `Tiến độ ghi nhận: Epoch ${m.live_progress.epoch || "—"} / ${m.live_progress.total_epochs || "—"}`
                : "Chưa có chuỗi dữ liệu loss/dice curve chi tiết được ghi nhận cho run này."}
            </p>
          </div>
        </article>
      )}

      {/* SUBTAB: WORST CASES */}
      {subTab === "worst_cases" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Các trường hợp biên cần chú ý (Worst cases)</h2>
          <p>Danh sách các ca chụp có chỉ số phân đoạn thấp nhất.</p>
          {worstCases.length > 0 ? (
            <div className="sw-table-wrap" style={{ marginTop: 12 }}>
              <table className="sw-table">
                <thead>
                  <tr>
                    <th>Study ID</th>
                    <th>Dice</th>
                    <th>Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {worstCases.map((wc, i) => (
                    <tr key={wc.id || i}>
                      <td><strong>{wc.id}</strong></td>
                      <td>{wc.dice !== undefined ? wc.dice : "—"}</td>
                      <td>{wc.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sw-empty" style={{ marginTop: 12 }}>
              Chưa có báo cáo chi tiết về worst cases cho lần chạy này.
            </p>
          )}
        </article>
      )}

      {/* SUBTAB: CONFIG */}
      {subTab === "config" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Cấu hình huấn luyện</h2>
          <pre style={{ background: "var(--sw-surface-2)", padding: 14, borderRadius: 8, maxHeight: 400, overflow: "auto", fontFamily: "var(--sw-font-mono)", fontSize: 12 }}>
            {JSON.stringify(runItem.config || {}, null, 2)}
          </pre>
        </article>
      )}

      {/* SUBTAB: ARTIFACTS */}
      {subTab === "artifacts" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Artifacts & Checkpoints</h2>
          <dl className="sw-facts">
            <div>
              <dt>Thư mục đầu ra</dt>
              <dd className="sw-hash">{runItem.output_dir || "Chưa tạo"}</dd>
            </div>
            <div>
              <dt>Tệp log</dt>
              <dd className="sw-hash">{runItem.log_path || "Chưa có đường dẫn log"}</dd>
            </div>
          </dl>
        </article>
      )}

      {/* Technical Trace */}
      {showTrace && (
        <details className="sw-card" open style={{ marginTop: 16 }}>
          <summary>Technical Trace (Chỉ dành cho kỹ sư)</summary>
          <pre style={{ background: "var(--sw-surface-2)", padding: 14, borderRadius: 8, overflowX: "auto", fontFamily: "var(--sw-font-mono)", fontSize: 11 }}>
            {JSON.stringify({ run_id: runItem.id, metrics: m, config: runItem.config }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
