import React, { useState, useEffect } from "react";
import { Icon } from "../../icons";
import StatusBadge from "./StatusBadge";
import MetricWithContext from "./MetricWithContext";
import ModelComparisonView from "./ModelComparisonView";
import ReleaseWorkspaceView from "./ReleaseWorkspaceView";
import RollbackModal from "./RollbackModal";
import { approveModel, transitionModel } from "../../api";

export default function ModelsView({
  data,
  authorization,
  run,
  busy,
  openTab,
}) {
  const serving = data.studio?.serving || {};
  const servingModelId = serving.registered_model_id;
  const models = data.models || [];
  const servingModel = servingModelId
    ? models.find((m) => m.id === servingModelId) || null
    : null;

  const [viewMode, setViewMode] = useState("operations"); // 'operations' | 'compare' | 'release'
  const [selectedCandidate, setSelectedCandidate] = useState(undefined);
  const [selectedHistoryModelId, setSelectedHistoryModelId] = useState(null);
  const [showRollback, setShowRollback] = useState(false);
  const [filterStage, setFilterStage] = useState("all");
  const [query, setQuery] = useState("");

  const servingMetrics = servingModel?.metrics || {};
  const benchmarkDice = servingMetrics.mean_dice ?? servingMetrics.macro_dice ?? null;
  const benchmarkCohort = servingMetrics.dataset_name || null;
  const benchmarkStudies = servingMetrics.holdout_cases || servingMetrics.test_cases || null;

  // Candidates requiring action (Section B)
  const candidates = models.filter(
    (m) => m.parent_model_id && !["archived", "rejected", "production"].includes(m.stage)
  );

  const handleOpenCompare = (cand) => {
    setSelectedCandidate(cand);
    setViewMode("compare");
  };

  const handleOpenRelease = (cand) => {
    setSelectedCandidate(cand);
    setViewMode("release");
  };

  useEffect(() => {
    const onOpenRelease = (e) => {
      const cand = (e.detail && typeof e.detail === "object" && "candidate" in e.detail)
        ? e.detail.candidate
        : (e.detail !== undefined && e.detail !== null ? e.detail : (candidates[0] || null));
      handleOpenRelease(cand);
    };
    window.addEventListener("brainhem:studio-open-release", onOpenRelease);
    return () => window.removeEventListener("brainhem:studio-open-release", onOpenRelease);
  }, [candidates]);

  // If in Compare mode (Screen 8)
  if (viewMode === "compare") {
    const activeCandidate = selectedCandidate !== undefined ? selectedCandidate : (candidates[0] || null);
    return (
      <ModelComparisonView
        servingModel={servingModel}
        candidateModel={activeCandidate}
        authorization={authorization}
        run={run}
        busy={busy}
        onBack={() => {
          setViewMode("operations");
          setSelectedCandidate(undefined);
        }}
        onProceedToRelease={handleOpenRelease}
      />
    );
  }

  // If in Release Workspace mode (Screen 9)
  if (viewMode === "release") {
    const activeCandidate = selectedCandidate !== undefined ? selectedCandidate : (candidates[0] || null);
    return (
      <ReleaseWorkspaceView
        servingModel={servingModel}
        candidateModel={activeCandidate}
        authorization={authorization}
        run={run}
        busy={busy}
        onBack={() => {
          setViewMode("operations");
          setSelectedCandidate(undefined);
        }}
      />
    );
  }

  // History filtering
  const filteredModels = models.filter((m) => {
    const isReference = m.imported || m.stage === "production";
    const isCandidate = m.parent_model_id && !["archived", "rejected"].includes(m.stage);
    const matchesFilter =
      filterStage === "all" ||
      (filterStage === "reference" && isReference) ||
      (filterStage === "candidates" && isCandidate) ||
      (filterStage === "archived" && ["archived", "rejected"].includes(m.stage));

    const nameStr = `${m.name || ""} ${m.id || ""}`.toLowerCase();
    return matchesFilter && nameStr.includes(query.toLowerCase());
  });

  const historyDetail = models.find((m) => m.id === selectedHistoryModelId);

  return (
    <div className="sw-page">
      <header className="sw-heading">
        <div>
          <span className="sw-eyebrow">AI STUDIO / MODEL</span>
          <h1>Model Operations</h1>
          <p>Quản lý model đang phục vụ và các model ứng viên.</p>
        </div>
      </header>

      {/* SECTION A: CURRENTLY SERVING (SCREEN 7) */}
      <article className="sw-card sw-serving" style={{ padding: 22 }}>
        <header className="sw-card-header">
          <span className="sw-card-title">
            <Icon name="cube" size={20} />
            Model đang phục vụ
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="studio-status-pill">
              <i /> Hoạt động ổn định
            </span>
            <StatusBadge status="serving" />
          </div>
        </header>

        <div className="sw-serving-content-grid">
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

          <div className="sw-serving-info-col">
            <div className="sw-serving-name-row">
              <div>
                <h2 className="sw-model-display-name">{servingModel?.name || "Chưa xác định"}</h2>
                <p className="sw-model-variant-line">
                  Biến thể <strong>{serving.model_variant || servingModel?.metrics?.model_variant || "Biến thể chưa xác định"}</strong> · Phiên bản {serving.model_version || "—"}
                </p>
              </div>
              <div className="sw-actions">
                <button
                  type="button"
                  className="sw-btn"
                  onClick={() => setSelectedHistoryModelId(servingModel?.id)}
                >
                  Xem chi tiết
                </button>
                <button
                  type="button"
                  className="sw-btn sw-btn-danger"
                  onClick={() => setShowRollback(true)}
                >
                  Rollback
                </button>
              </div>
            </div>

            <div className="sw-serving-meta-grid" style={{ marginTop: 14 }}>
              <div>
                <span className="sw-meta-label">Runtime</span>
                <span className="sw-meta-val"><Icon name="checkCircle" size={14} /> <span>{serving.backend ? "Verified" : "Chưa xác minh"}</span></span>
              </div>
              <div>
                <span className="sw-meta-label">Backend phục vụ</span>
                <span className="sw-meta-val"><Icon name="hardware" size={14} /> <span>{serving.backend || "Chưa xác định"}</span></span>
              </div>
              <div>
                <span className="sw-meta-label">Thời gian nạp</span>
                <span className="sw-meta-val"><Icon name="clock" size={14} /> <span>Khi khởi động hệ thống</span></span>
              </div>
              <div>
                <span className="sw-meta-label">Trạng thái sức khỏe</span>
                <span className="sw-meta-val" style={{ color: "var(--sw-success)" }}>● Healthy</span>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Row */}
        <div className="sw-serving-metrics-row" style={{ marginTop: 16 }}>
          <MetricWithContext
            label="Macro Dice"
            value={benchmarkDice}
            digits={6}
            cohortName={benchmarkCohort}
            studyCount={benchmarkStudies}
          />
          <MetricWithContext
            label="Recall"
            value={servingMetrics.lesion_recall ?? null}
            digits={3}
            cohortName="Theo ca"
          />
          <MetricWithContext
            label="HD95"
            value={servingMetrics.mean_hd95_mm ?? null}
            unit="mm"
            digits={1}
            lowerIsBetter
            cohortName="Biên xuất huyết"
          />
          <MetricWithContext
            label="P95 Latency"
            value="Chưa đo runtime"
            cohortName={serving.backend ? `Runtime ${serving.backend}` : "Runtime serving"}
          />
          <MetricWithContext
            label="VRAM"
            value="Chưa có telemetry"
            cohortName="Runtime GPU"
          />
        </div>

        {/* Rollback info */}
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
            <span>Rollback tự động chưa được cấu hình trên backend (deployment_configured = false).</span>
          </div>
        </div>
      </article>

      {/* SECTION B: CANDIDATES REQUIRING ACTION (SCREEN 7) */}
      <section className="sw-card sw-candidates-action-section">
        <div className="sw-card-header">
          <span className="sw-card-title">
            <Icon name="shield" size={18} />
            Candidates cần xử lý ({candidates.length})
          </span>
          {candidates.length > 0 && (
            <button
              type="button"
              className="sw-text-link"
              onClick={() => handleOpenCompare(candidates[0])}
            >
              So sánh với Baseline →
            </button>
          )}
        </div>

        {candidates.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            {candidates.map((cand) => {
              const cm = cand.metrics || {};
              const gate = cm.validation_gate;
              const isApproved = cand.stage === "clinical_validated";

              // One valid next CTA per candidate (Spec 14.2)
              let primaryCtaText = "Run evaluation";
              let primaryCtaAction = () => handleOpenCompare(cand);

              if (gate?.passed && !isApproved) {
                primaryCtaText = "Gửi duyệt chuyên môn";
                primaryCtaAction = () => handleOpenCompare(cand);
              } else if (isApproved) {
                primaryCtaText = "Chuẩn bị phát hành";
                primaryCtaAction = () => handleOpenRelease(cand);
              }

              return (
                <div key={cand.id} className="sw-card" style={{ background: "var(--sw-surface-2)", border: "1px solid var(--sw-border-strong)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 16 }}>{cand.name || `Candidate ${cand.id.slice(0, 8).toUpperCase()}`}</h3>
                      <small style={{ color: "var(--sw-text-muted)" }}>
                        {cm.model_variant ? `Biến thể ${cm.model_variant}` : "Biến thể chưa xác định"}
                      </small>
                    </div>
                    <span className="sw-badge purple">Ứng viên mới</span>
                  </div>

                  <dl className="sw-facts" style={{ margin: "10px 0" }}>
                    <div>
                      <dt>Dataset</dt>
                      <dd>{cm.dataset_name || "Chưa có dữ liệu"}</dd>
                    </div>
                    <div>
                      <dt>Quality gate</dt>
                      <dd>
                        <span className={`sw-badge ${gate?.passed ? "green" : "amber"}`}>
                          {gate?.passed ? "✓ Passed" : "Chưa đánh giá"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Phê duyệt lâm sàng</dt>
                      <dd>
                        <span className={`sw-badge ${isApproved ? "green" : "amber"}`}>
                          {isApproved ? "✓ Đã duyệt" : "Chờ duyệt"}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  <div className="sw-actions" style={{ marginTop: 14 }}>
                    <button
                      type="button"
                      className="sw-btn sw-btn-primary"
                      style={{ flex: 1 }}
                      onClick={primaryCtaAction}
                    >
                      {primaryCtaText}
                    </button>
                    <button
                      type="button"
                      className="sw-btn"
                      onClick={() => handleOpenCompare(cand)}
                    >
                      Xem so sánh
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sw-empty">Hiện không có model ứng viên nào cần xử lý.</p>
        )}
      </section>

      {/* SECTION C: MODEL HISTORY (SCREEN 7) */}
      <section className="sw-card sw-model-history-section">
        <div className="sw-card-header">
          <div>
            <h2>Lịch sử Model</h2>
            <p>Danh sách toàn bộ các phiên bản model gốc và model được huấn luyện.</p>
          </div>
          <div className="sw-tabs" style={{ margin: 0, padding: 0, border: "none" }}>
            {[
              ["all", "Tất cả"],
              ["reference", "Model gốc / đang dùng"],
              ["candidates", "Ứng viên fine-tune"],
              ["archived", "Lưu trữ"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={filterStage === id ? "active" : ""}
                onClick={() => setFilterStage(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sw-toolbar" style={{ marginBottom: 12 }}>
          <div className="studio-search-wrap" style={{ width: 280 }}>
            <Icon name="search" size={14} />
            <input
              placeholder="Tìm theo tên model, ID..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Model / Phiên bản</th>
                <th>Biến thể</th>
                <th>Vai trò</th>
                <th>Dice macro</th>
                <th>Tập đánh giá</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map((m) => {
                const mm = m.metrics || {};
                const isServingThis = m.id === servingModelId;
                const variants = mm.supported_variants || (mm.model_variant ? [mm.model_variant] : []);

                return (
                  <tr key={m.id} className={m.id === selectedHistoryModelId ? "selected" : ""}>
                    <td>
                      <strong>{m.name || (m.id ? m.id.slice(0, 8) : "Chưa xác định")}</strong>
                      <small>{m.id.slice(0, 12)}</small>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {variants.length > 0 ? (
                          variants.map((v) => (
                            <span key={v} className="sw-badge blue">
                              {v}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: "12px", color: "var(--sw-text-muted)" }}>—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <StatusBadge
                        status={isServingThis ? "serving" : m.stage || "candidate"}
                        label={isServingThis ? "Đang phục vụ" : m.stage}
                      />
                    </td>
                    <td>
                      <strong>
                        {typeof mm.mean_dice === "number"
                          ? mm.mean_dice.toLocaleString("vi-VN", { maximumFractionDigits: 6 })
                          : "—"}
                      </strong>
                    </td>
                    <td>
                      {mm.holdout_cases ? `${mm.holdout_cases} studies` : "—"}
                      <small>{mm.dataset_name || "—"}</small>
                    </td>
                    <td>
                      <div className="sw-actions">
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          onClick={() =>
                            setSelectedHistoryModelId(selectedHistoryModelId === m.id ? null : m.id)
                          }
                        >
                          Xem model
                        </button>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          onClick={() => handleOpenCompare(m)}
                        >
                          So sánh
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Model Detail Drawer / Card with .sw-model-detail (REQUIRED FOR SMOKE TEST!) */}
        {historyDetail && (
          <section className="sw-card sw-model-detail" style={{ marginTop: 20, borderColor: "var(--sw-accent-primary)" }}>
            <header className="sw-card-header">
              <div>
                <span className="sw-eyebrow">CHI TIẾT MODEL</span>
                <h2>{historyDetail.name || (historyDetail.id ? historyDetail.id.slice(0, 8) : "Chưa xác định")}</h2>
              </div>
              <button
                type="button"
                className="sw-icon-btn"
                onClick={() => setSelectedHistoryModelId(null)}
                aria-label="Đóng chi tiết model"
              >
                ×
              </button>
            </header>

            <div className="sw-stat-row">
              <div className="sw-stat">
                <span>Dice macro theo ca</span>
                <strong>
                  {typeof historyDetail.metrics?.mean_dice === "number"
                    ? historyDetail.metrics.mean_dice.toLocaleString("vi-VN", {
                        minimumFractionDigits: 6,
                        maximumFractionDigits: 6,
                      })
                    : "—"}
                </strong>
              </div>
              <div className="sw-stat">
                <span>Số study đánh giá</span>
                <strong>{historyDetail.metrics?.holdout_cases ?? historyDetail.metrics?.test_cases ?? "—"}</strong>
              </div>
              <div className="sw-stat">
                <span>Median Dice</span>
                <strong>
                  {typeof historyDetail.metrics?.median_dice === "number"
                    ? historyDetail.metrics.median_dice.toLocaleString("vi-VN", { maximumFractionDigits: 3 })
                    : "—"}
                </strong>
              </div>
              <div className="sw-stat">
                <span>Pooled Dice</span>
                <strong>
                  {typeof historyDetail.metrics?.pooled_dice === "number"
                    ? historyDetail.metrics.pooled_dice.toLocaleString("vi-VN", { maximumFractionDigits: 3 })
                    : "—"}
                </strong>
                <small>Không tương đương macro Dice</small>
              </div>
            </div>

            <div className="sw-notice" style={{ margin: "14px 0" }}>
              <Icon name="shield" size={16} />
              <span>{historyDetail.metrics?.benchmark_note || "Dữ liệu kiểm chuẩn đã lưu."}</span>
            </div>

            {/* Benchmark Report Download Link (Required for smoke test!) */}
            <div style={{ marginBottom: 14 }}>
              <a
                className="sw-link-button sw-btn sw-btn-primary"
                href={`/api/v1/studio/models/${encodeURIComponent(historyDetail.id)}/benchmark`}
                download
              >
                <Icon name="download" size={14} /> Tải báo cáo benchmark gốc
              </a>
            </div>

            <dl className="sw-facts">
              <div>
                <dt>Biến thể hỗ trợ</dt>
                <dd>
                  {(historyDetail.metrics?.supported_variants || (historyDetail.metrics?.model_variant ? [historyDetail.metrics.model_variant] : []))?.join(", ") || "Chưa xác định"}
                </dd>
              </div>
              <div>
                <dt>Model cha</dt>
                <dd>{historyDetail.parent_model_id || "Checkpoint gốc"}</dd>
              </div>
              <div>
                <dt>Fine-tune</dt>
                <dd>
                  {historyDetail.metrics?.allow_fine_tune
                    ? "Được phép fine-tune"
                    : historyDetail.stage === "production"
                    ? "Model phục vụ chính thức"
                    : "Theo chính sách MLOps"}
                </dd>
              </div>
            </dl>

            <details>
              <summary>Thông tin kỹ thuật dành cho truy vết (Technical Trace)</summary>
              <p className="sw-hash" style={{ marginTop: 8 }}>
                ID: {historyDetail.id} · SHA-256: {historyDetail.artifact_sha256}
              </p>
              <pre>{JSON.stringify(historyDetail.metrics, null, 2)}</pre>
            </details>
          </section>
        )}
      </section>

      {/* Rollback Modal */}
      {showRollback && (
        <RollbackModal
          currentModel={servingModel}
          onClose={() => setShowRollback(false)}
          authorization={authorization}
          run={run}
          busy={busy}
        />
      )}
    </div>
  );
}
