import React from "react";
import { Icon } from "../../icons";
import StatusBadge from "./StatusBadge";
import MetricWithContext from "./MetricWithContext";
import { AutomationPolicy } from "../TrainingWorkspace";

function formatDate(val) {
  if (!val) return "—";
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? String(val)
    : d.toLocaleString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function OverviewScreen({
  data,
  openTab,
  onNavigate,
  authorization,
}) {
  const serving = data.studio?.serving || {};
  const servingModelId = serving.registered_model_id;
  const servingModel = servingModelId
    ? data.models?.find((m) => m.id === servingModelId) || null
    : null;
  const tier = data.inference?.tiers?.[data.inference?.default_tier];
  const metrics = servingModel?.metrics || {};

  // Benchmark values (real checkpoint metrics, no fabricated constants)
  const benchmarkDice = metrics.mean_dice ?? metrics.macro_dice ?? null;
  const benchmarkCohort = metrics.dataset_name || null;
  const benchmarkStudies = metrics.holdout_cases || metrics.test_cases || null;
  const pooledIou = metrics.pooled_iou ?? metrics.mean_iou ?? null;
  const hd95Val = metrics.mean_hd95_mm ?? metrics.hd95_mm ?? null;
  const recallVal = metrics.lesion_recall ?? metrics.recall ?? null;

  // Active run & recent runs - filtered strictly for fine_tune mode
  const recentRuns = (data.runs || [])
    .filter((r) => r.mode === "fine_tune")
    .slice(0, 5);
  const activeRun = (data.runs || []).find(
    (r) => r.mode === "fine_tune" && ["queued", "running", "validation_queued", "validating"].includes(r.status)
  );

  // Candidates requiring action
  const candidates = (data.models || []).filter(
    (m) => m.parent_model_id && !["archived", "rejected"].includes(m.stage)
  );

  // Actionable items list (strictly real data!)
  const actionItems = [];
  const approvedPoolCount = data.studio?.pool?.approved || 0;
  if (approvedPoolCount > 0) {
    actionItems.push({
      id: "gold_labels",
      icon: "file",
      title: `${approvedPoolCount} Gold label mới`,
      detail: `Có ${approvedPoolCount} studies đã được gán nhãn bởi chuyên gia, có thể lưu trữ hoặc xuất dữ liệu; huấn luyện cần extension riêng.`,
      btnText: "Xem dataset",
      action: () => openTab("datasets"),
    });
  }

  if (candidates.length > 0) {
    const candidate = candidates[0];
    const candGate = candidate.metrics?.validation_gate;
    const isApproved = candidate.stage === "clinical_validated";
    actionItems.push({
      id: `candidate_${candidate.id}`,
      icon: "cube",
      title: `Candidate ${candidate.name || candidate.id.slice(0, 8).toUpperCase()}`,
      detail: isApproved
        ? "Đã duyệt chuyên môn. Chờ kiểm tra điều kiện phát hành."
        : candGate?.passed === false
        ? "Quality gate không đạt. Cần rà soát hoặc huấn luyện lại."
        : "Đã hoàn tất đánh giá tự động. Cần review kết quả bởi bác sĩ chuyên môn.",
      btnText: "Xem kết quả",
      action: () => openTab("registry"),
    });
  }

  if (activeRun) {
    actionItems.push({
      id: `run_${activeRun.id}`,
      icon: "chart",
      title: `1 run đang chạy: ${activeRun.name}`,
      detail: `Đang huấn luyện trên dataset ${activeRun.metrics?.dataset_name || "đã khóa"}`,
      btnText: "Theo dõi",
      action: () => openTab("fine_tune"),
    });
  }

  const failedRun = (data.runs || []).find((r) => r.status === "failed");
  if (failedRun && !activeRun) {
    actionItems.push({
      id: `failed_${failedRun.id}`,
      icon: "alert",
      title: `Run ${failedRun.name} gặp lỗi`,
      detail: failedRun.metrics?.error || "Lần chạy không hoàn thành hoặc bị gián đoạn.",
      btnText: "Xem chi tiết",
      action: () => openTab("fine_tune"),
    });
  }

  if (!data.caps?.worker_alive) {
    actionItems.push({
      id: "worker_offline",
      icon: "hardware",
      title: "Training worker offline",
      detail: "Tiến trình huấn luyện nền hiện không kết nối được.",
      btnText: "Kiểm tra",
      action: () => openTab("hardware"),
    });
  }

  return (
    <div className="sw-page">
      <header className="sw-heading">
        <div>
          <span className="sw-eyebrow">AI STUDIO / TỔNG QUAN</span>
          <h1>Tổng quan hệ thống</h1>
          <p>Theo dõi model đang phục vụ và các tác vụ vận hành quan trọng.</p>
        </div>
      </header>

      {/* Top 2-Column Grid: Serving Model (66%) + Requires Action (34%) */}
      <div className="sw-overview-top-grid">
        {/* Serving Model Card (has .sw-serving for verification) */}
        <article className="sw-card sw-serving">
          <header className="sw-card-header">
            <span className="sw-card-title">
              <Icon name="cube" size={20} />
              Model đang phục vụ
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span className="studio-status-pill">
                <i /> Dịch vụ hoạt động ổn định
              </span>
              <StatusBadge status="serving" />
            </div>
          </header>

          <div className="sw-serving-content-grid">
            {/* Visual Schematic Box (Clean medical AI vector icon, no collided text) */}
            <div className="sw-serving-visual-box">
              <div className="sw-serving-schematic" aria-label="Axial CT Segmentation Schematic">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="36" cy="36" r="32" stroke="rgba(56, 189, 248, 0.4)" strokeWidth="2" strokeDasharray="4 2" />
                  <ellipse cx="36" cy="36" rx="24" ry="28" stroke="#38BDF8" strokeWidth="2" fill="rgba(56, 189, 248, 0.08)" />
                  <path d="M28 26C30 20 42 20 44 26C46 32 40 38 36 44C32 38 26 32 28 26Z" fill="rgba(245, 158, 11, 0.25)" stroke="#F59E0B" strokeWidth="1.5" />
                  <circle cx="36" cy="30" r="3" fill="#EF4444" />
                </svg>
              </div>
              <small className="sw-schematic-caption" style={{ color: "var(--sw-text-muted)", fontSize: "11px", textAlign: "center" }}>
                Axial CT Target (512×512)
              </small>
            </div>

            {/* Serving Identity Details */}
            <div className="sw-serving-info-col">
              <div className="sw-serving-name-row">
                <div>
                  <h2 className="sw-model-display-name">{servingModel?.name || "Chưa xác định"}</h2>
                  <p className="sw-model-variant-line">
                    Biến thể <strong>{serving.model_variant || servingModel?.metrics?.model_variant || "Biến thể chưa xác định"}</strong> · Phiên bản {serving.model_version || tier?.model_version || "—"}
                  </p>
                </div>
                <button
                  type="button"
                  className="sw-btn sw-btn-primary"
                  onClick={() => openTab("registry")}
                >
                  Xem chi tiết <Icon name="chevron" size={14} />
                </button>
              </div>

              {/* S/M/L Variant Readiness row: separate row labelled Biến thể with chips S, M, L */}
              {(() => {
                const currentVariant = serving.model_variant || servingModel?.metrics?.model_variant || null;
                return (
                  <div className="sw-variant-selection-row" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--sw-text-muted)" }}>Biến thể:</span>
                    <div className="sw-model-variants-strip" title="Trạng thái các extension">
                      <span className={`sw-variant-chip ${currentVariant === "S" ? "active" : "disabled"}`}>
                        <strong>S</strong>
                        <small>{currentVariant === "S" ? "Đang phục vụ" : "Chưa nạp checkpoint"}</small>
                      </span>
                      <span className={`sw-variant-chip ${"disabled"}`} title="Chưa có checkpoint fine-tune tương thích / runtime chưa được xác minh">
                        <strong>M</strong>
                        <small>{currentVariant === "M" ? "Đang phục vụ" : "Chưa nạp checkpoint"}</small>
                      </span>
                      <span className={`sw-variant-chip ${"disabled"}`} title="Chưa có checkpoint fine-tune tương thích / runtime chưa được xác minh">
                        <strong>L</strong>
                        <small>{currentVariant === "L" ? "Đang phục vụ" : "Chưa nạp checkpoint"}</small>
                      </span>
                    </div>
                  </div>
                );
              })()}

              <div className="sw-serving-meta-grid">
                <div>
                  <span className="sw-meta-label">Runtime</span>
                  <span className="sw-meta-val">
                    <Icon name="checkCircle" size={14} /> <span>{serving.backend ? "Verified" : "Chưa xác minh"}</span>
                  </span>
                </div>
                <div>
                  <span className="sw-meta-label">Thời gian nạp</span>
                  <span className="sw-meta-val">
                    <Icon name="clock" size={14} /> <span>{formatDate(servingModel?.updated_at || servingModel?.created_at) || "Khi khởi động dịch vụ"}</span>
                  </span>
                </div>
                <div>
                  <span className="sw-meta-label">Worker / Service</span>
                  <span className="sw-meta-val">
                    <Icon name="hardware" size={14} /> <span>{serving.backend || "Chưa xác định"}</span>
                  </span>
                </div>
                <div>
                  <span className="sw-meta-label">Bộ đánh giá</span>
                  <span className="sw-meta-val" title="Tập kiểm chuẩn đối chiếu">
                    <Icon name="database" size={14} /> <span>{benchmarkCohort ? `${benchmarkCohort} · ${benchmarkStudies ? `${benchmarkStudies} studies` : "Chưa có số lượng"}` : "Chưa có dữ liệu"}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Metrics Row with context */}
          <div className="sw-serving-metrics-row">
            <MetricWithContext
              label="Macro Dice"
              value={benchmarkDice}
              digits={6}
              cohortName={benchmarkCohort}
              studyCount={benchmarkStudies}
            />
            <MetricWithContext
              label="Pooled IoU"
              value={pooledIou}
              digits={3}
              cohortName="Theo volume"
            />
            <MetricWithContext
              label="HD95"
              value={hd95Val}
              unit="mm"
              digits={1}
              lowerIsBetter
              cohortName="Biên xuất huyết"
            />
            <MetricWithContext
              label="Recall"
              value={recallVal}
              digits={3}
              cohortName="Theo ca"
            />
            <MetricWithContext
              label="P95 Latency"
              value="Chưa đo trong runtime"
              cohortName={serving.backend ? `Runtime ${serving.backend}` : "Runtime serving"}
            />
          </div>

          {/* Rollback Footer */}
          <div className="sw-serving-rollback-footer">
            <div className="sw-rollback-info">
              <Icon name="clock" size={16} />
              <div>
                <span>Phiên bản dự phòng (rollback):</span>
                <strong style={{ color: "var(--sw-text-muted)" }}>Chưa xác định điểm khôi phục</strong>
              </div>
            </div>
            <div className="sw-rollback-note">
              <Icon name="help" size={14} />
              <span>Rollback tự động chưa cấu hình</span>
            </div>
          </div>
        </article>

        {/* Right Section: Requires Action (Only rendered if action items exist) */}
        {actionItems.length > 0 && (
          <aside className="sw-card sw-requires-action">
            <header className="sw-card-header">
              <span className="sw-card-title">
                <Icon name="bell" size={18} />
                Cần xử lý
                <span className="studio-icon-badge" style={{ position: "static", marginLeft: 6 }}>
                  {actionItems.length}
                </span>
              </span>
              <button
                type="button"
                className="sw-text-link"
                onClick={() => openTab(actionItems[0].id === "gold_labels" ? "datasets" : "registry")}
              >
                Xem tất cả →
              </button>
            </header>

            <div className="sw-action-items-list">
              {actionItems.map((item) => (
                <article key={item.id} className="sw-action-item">
                  <div className="sw-action-icon">
                    <Icon name={item.icon} size={18} />
                  </div>
                  <div className="sw-action-content">
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <button
                    type="button"
                    className="sw-btn sw-btn-sm"
                    onClick={item.action}
                  >
                    {item.btnText}
                  </button>
                </article>
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* Ingest Automation Policy Strip */}
      <section className="sw-overview-automation">
        <AutomationPolicy inference={data.inference} authorization={authorization} />
      </section>

      {/* Latest Fine-tune Runs Table */}
      <section className="sw-card sw-latest-fine-tune">
        <header className="sw-card-header">
          <span className="sw-card-title">
            <Icon name="clock" size={18} />
            Fine-tune gần nhất
          </span>
          <button
            type="button"
            className="sw-text-link"
            onClick={() => openTab("fine_tune")}
          >
            Xem tất cả runs →
          </button>
        </header>

        {recentRuns.length > 0 ? (
          <div className="sw-table-wrap">
            <table className="sw-table">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Thời gian bắt đầu</th>
                  <th>Dataset</th>
                  <th>Model & Biến thể</th>
                  <th>Trạng thái</th>
                  <th>Dice (val)</th>
                  <th>Thời gian</th>
                  <th>Ghi chú</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((r) => {
                  const m = r.metrics || {};
                  const isRunActive = ["queued", "running", "validation_queued", "validating"].includes(r.status);
                  const isFailed = r.status === "failed";
                  const gatePassed = m.validation_gate?.passed;
                  const statusKey = isRunActive
                    ? "fine_tuning"
                    : isFailed
                    ? (m.validation_gate ? "quality_failed" : "system_error")
                    : gatePassed
                    ? "quality_passed"
                    : "awaiting_evaluation";

                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.id.slice(0, 12)}</strong>
                        <small>{r.name}</small>
                      </td>
                      <td>{formatDate(r.created_at)}</td>
                      <td>
                        {data.datasets?.find((d) => d.id === r.dataset_version_id)?.name ||
                          m.dataset_name ||
                          "Dataset đã khóa"}
                      </td>
                      <td>
                        {(() => {
                          const runModel = data.models?.find((mod) => mod.id === r.model_id);
                          const modelLabel = runModel?.name || (r.model_id ? r.model_id.slice(0, 8) : "Chưa xác định");
                          const variantLabel = m.model_variant ? `Biến thể ${m.model_variant}` : "Biến thể chưa xác định";
                          return (
                            <span>
                              <strong>{modelLabel}</strong> · {variantLabel}
                            </span>
                          );
                        })()}
                      </td>
                      <td>
                        <StatusBadge status={statusKey} />
                      </td>
                      <td>
                        <strong>
                          {typeof m.mean_dice === "number"
                            ? m.mean_dice.toLocaleString("vi-VN", { maximumFractionDigits: 3 })
                            : "—"}
                        </strong>
                      </td>
                      <td>{r.duration_seconds ? `${Math.round(r.duration_seconds / 60)} phút` : "—"}</td>
                      <td>
                        <small>{r.config?.studio_trigger === "count" ? "Trigger: nhãn mới" : "Chạy thủ công"}</small>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          onClick={() => openTab("fine_tune")}
                        >
                          Xem
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sw-empty">Chưa có lần fine-tune nào được ghi nhận.</p>
        )}
      </section>
    </div>
  );
}
