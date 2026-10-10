import { trainingAvailable, TrainingUnavailable, isInferenceOnlyModel } from "../../trainingAvailability";
import React, { useState } from "react";
import { Icon } from "../../icons";
import StatusBadge from "./StatusBadge";
import FineTuneDetailView from "./FineTuneDetailView";
import {
  saveStudioPolicy,
  launchStudioPolicy,
} from "../../api";

const TRIGGER_NAMES = {
  manual: "Thủ công",
  count: "Đủ nhãn mới",
  schedule: "Theo lịch",
  either: "Đủ nhãn hoặc đến lịch",
};

export default function FineTuneView({
  data,
  authorization,
  run,
  busy,
  openTab,
}) {
  const { training = {}, recipes = [], model_readiness = {}, fine_tune_options = [] } =
    data.studio || {};
  const runs = data.runs || [];

  const [selectedRunId, setSelectedRunId] = useState(null);

  // Policy Form State
  const [form, setForm] = useState(() => {
    const choice = sessionStorage.getItem("brainhem.studio-recipe");
    sessionStorage.removeItem("brainhem.studio-recipe");
    return {
      ...training.policy,
      recipe_id: choice || training.policy?.recipe_id || (recipes[0]?.id || ""),
      model_variant: training.policy?.model_variant || "",
    };
  });
  const [changed, setChanged] = useState(
    Boolean(form.recipe_id !== training.policy?.recipe_id)
  );

  const updateForm = (values) => {
    setForm((curr) => ({ ...curr, ...values }));
    setChanged(true);
  };

  const recipe = recipes.find((r) => r.id === form.recipe_id);
  const baseModel = data.models?.find((m) => m.id === form.base_model_id);
  const selectedOption = fine_tune_options.find((opt) => opt.model_id === form.base_model_id);
  const availableVariants = isInferenceOnlyModel(baseModel) ? [] : (selectedOption?.variants || []).filter(variant => variant === "S");

  // Active run & filter intentionally to relevant fine-tune runs
  const activeRun = runs.find(
    (r) => r.mode === "fine_tune" && ["queued", "running", "validation_queued", "validating"].includes(r.status)
  );
  const fineTuneRuns = runs.filter((r) => r.mode === "fine_tune");

  const blocker = model_readiness[form.base_model_id];

  const handleSavePolicy = async (e) => {
    e?.preventDefault();
    if (!trainingAvailable(data.caps) || blocker || isInferenceOnlyModel(baseModel)) return;
    run(async () => {
      await saveStudioPolicy(form, authorization);
      setChanged(false);
    });
  };

  const handleLaunch = () => {
    if (!trainingAvailable(data.caps) || blocker || isInferenceOnlyModel(baseModel)) return;
    run(async () => {
      await launchStudioPolicy(authorization);
    });
  };

  // Active run model resolution
  const activeBaseModel = activeRun ? data.models?.find((m) => m.id === (activeRun.base_model_id || activeRun.model_id)) : null;
  const activeModelName = activeBaseModel?.name || (activeRun?.base_model_id ? `Model ${activeRun.base_model_id.slice(0, 8)}` : "Model chưa xác định");
  const activeVariant = activeRun?.metrics?.model_variant || activeRun?.config?.model_variant || "Chưa xác định";

  if (!trainingAvailable(data.caps)) return <div className="sw-page">
    <header className="sw-heading"><h1>Fine-tune & đánh giá</h1><p>Baseline S chỉ được cung cấp để suy luận qua ONNX.</p></header>
    <TrainingUnavailable caps={data.caps}/>
    <section className="sw-card"><h2>Lịch sử Fine-tune</h2>{fineTuneRuns.length ? fineTuneRuns.map(item => <p key={item.id}>{item.name} · {item.status}</p>) : <p>Chưa có lần Fine-tune nào.</p>}</section>
  </div>;

  // If viewing run detail:
  if (selectedRunId) {
    const selected = runs.find((r) => r.id === selectedRunId);
    return (
      <FineTuneDetailView
        runItem={selected}
        caps={data.caps}
        models={data.models || []}
        datasets={data.datasets || []}
        authorization={authorization}
        runAction={run}
        busy={busy}
        onBack={() => setSelectedRunId(null)}
      />
    );
  }

  return (
    <div className="sw-page sw-fade-in">
      <header className="sw-heading">
        <div>
          <span className="sw-eyebrow">AI STUDIO / HUẤN LUYỆN</span>
          <h1>Fine-tune & đánh giá</h1>
          <p>Chọn dataset và model gốc, chạy fine-tune, rồi xem riêng kết quả đánh giá của từng lần chạy.</p>
        </div>
      </header>

      {/* Running Run Card (Screen 5) - Shown strictly if an active run exists */}
      {activeRun && (
        <article className="sw-card sw-running-card" style={{ borderColor: "var(--sw-accent-primary)", marginBottom: 20 }}>
          <header className="sw-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="studio-status-pill">
                <i /> Đang huấn luyện
              </span>
              <small style={{ color: "var(--sw-text-muted)" }}>
                Run đang chạy trên GPU. Quá trình sử dụng dataset version đã đóng băng.
              </small>
            </div>
            <StatusBadge status="fine_tuning" />
          </header>

          <div className="sw-running-body" style={{ display: "grid", gridTemplateColumns: "220px 1fr auto", gap: 20, alignItems: "center", margin: "14px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="studio-brand-icon">
                <Icon name="cube" size={20} />
              </div>
              <div>
                <h3 style={{ margin: 0 }}>{activeRun.name}</h3>
                <small style={{ color: "var(--sw-text-muted)" }}>
                  {activeModelName} · Biến thể {activeVariant}
                </small>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
                <span>
                  Tiến độ:{" "}
                  {activeRun.metrics?.live_progress?.epoch
                    ? `Epoch ${activeRun.metrics.live_progress.epoch} / ${activeRun.config?.epochs || activeRun.metrics.live_progress.total_epochs || "—"}`
                    : "Đang khởi tạo"}
                </span>
                <strong>
                  {typeof activeRun.metrics?.live_progress?.percent === "number"
                    ? `${activeRun.metrics.live_progress.percent}%`
                    : "—"}
                </strong>
              </div>
              <div className="sw-progress-bar-wrap">
                <div
                  className="sw-progress-bar-fill"
                  style={{ width: `${activeRun.metrics?.live_progress?.percent || 0}%` }}
                />
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 10, fontSize: 11, color: "var(--sw-text-muted)" }}>
                <span>
                  <Icon name="clock" size={12} /> Thời gian:{" "}
                  {activeRun.metrics?.live_progress?.elapsed_seconds
                    ? `${Math.round(activeRun.metrics.live_progress.elapsed_seconds / 60)} phút`
                    : "Chưa báo cáo"}
                </span>
                <span>
                  <Icon name="clock" size={12} /> Ước tính còn:{" "}
                  {activeRun.metrics?.live_progress?.remaining_seconds
                    ? `${Math.round(activeRun.metrics.live_progress.remaining_seconds / 60)} phút`
                    : "Chưa báo cáo"}
                </span>
                <span>
                  <Icon name="hardware" size={12} /> GPU:{" "}
                  {activeRun.metrics?.live_progress?.gpu_util !== undefined
                    ? `${activeRun.metrics.live_progress.gpu_util}%`
                    : "Chưa báo cáo"}
                </span>
                <span>
                  <Icon name="hardware" size={12} /> VRAM:{" "}
                  {activeRun.metrics?.live_progress?.vram_used !== undefined
                    ? `${activeRun.metrics.live_progress.vram_used} GB`
                    : "Chưa báo cáo"}
                </span>
              </div>
            </div>

            <div>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                onClick={() => setSelectedRunId(activeRun.id)}
              >
                Xem chi tiết →
              </button>
            </div>
          </div>
        </article>
      )}

      {/* NEW FINE-TUNE FORM / PLAN BUILDER (SCREEN 12) */}
      <form className="sw-training-grid" onSubmit={handleSavePolicy} style={{ marginBottom: 24 }}>
        <div className="sw-card sw-form">
          <h2><span className="sw-step">1</span> Dữ liệu & Model nền</h2>

          {/* 1. Dataset Selection */}
          <label>Tập dữ liệu<select
            required
            className="sw-select"
            value={form.recipe_id}
            onChange={(e) => updateForm({ recipe_id: e.target.value })}
          >
            <option value="">Chọn tập dữ liệu</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select></label>

          {recipe && (
            <div className="sw-splits" style={{ margin: "4px 0" }}>
              <div className="train"><i /><span>Huấn luyện</span><b>{recipe.preview?.splits?.train || 0}</b></div>
              <div className="validation"><i /><span>Validation</span><b>{recipe.preview?.splits?.validation || 0}</b></div>
              <div className="test"><i /><span>Test</span><b>{recipe.preview?.splits?.test || 0}</b></div>
            </div>
          )}

          {/* 2. Two-Stage Model then Variant Selection (Rules 3, 4, 5) */}
          <div className="sw-fields sw-model-pick">
            <label>Model<select
              required
              className="sw-select"
              value={form.base_model_id}
              onChange={(e) => {
                const chosen = fine_tune_options.find((opt) => opt.model_id === e.target.value);
                updateForm({
                  base_model_id: e.target.value,
                  model_variant: chosen?.variants?.[0] || "",
                  batch_size: form.batch_size || 4,
                });
              }}
            >
              <option value="">Chọn model</option>
              {fine_tune_options.filter(option => !isInferenceOnlyModel(data.models?.find(model => model.id === option.model_id))).map((option) => (
                <option key={option.model_id} value={option.model_id}>
                  {option.name}{option.is_baseline ? " · đang phục vụ" : ""}
                </option>
              ))}
            </select></label>

            <label>Biến thể<select
              required
              className="sw-select"
              disabled={!selectedOption}
              value={form.model_variant || ""}
              onChange={(e) => updateForm({ model_variant: e.target.value })}
            >
              <option value="">Chọn Baseline S</option>
              {availableVariants.map((variant) => (
                <option key={variant} value={variant}>
                  {variant}
                </option>
              ))}
            </select></label>
          </div>

          {/* S/M/L Variant Cards: Enabled only when exposed by selected model (Requirement 3) */}
          <div className="sw-variant-selection-cards" style={{ marginTop: 10 }}>
            <span className="sw-meta-label" style={{ display: "block", marginBottom: 8 }}>
              Biến thể đã được cung cấp:
            </span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {["S", "M", "L"].map((variantKey) => {
                const isEnabled = variantKey === "S" && availableVariants.includes(variantKey);
                const isSelected = form.model_variant === variantKey;
                const disabledReason = "Chưa có checkpoint fine-tune tương thích / runtime chưa được xác minh";
                return (
                  <div
                    key={variantKey}
                    className={`sw-variant-card ${isSelected ? "selected" : ""} ${!isEnabled ? "disabled" : ""}`}
                    onClick={() => {
                      if (isEnabled) updateForm({ model_variant: variantKey });
                    }}
                    style={{
                      border: isSelected
                        ? "1px solid var(--sw-accent-primary)"
                        : isEnabled
                        ? "1px solid var(--sw-border-default)"
                        : "1px dashed var(--sw-border-default)",
                      borderRadius: 8,
                      padding: 10,
                      opacity: isEnabled ? 1 : 0.65,
                      cursor: isEnabled ? "pointer" : "not-allowed",
                      background: isSelected
                        ? "rgba(56, 189, 248, 0.08)"
                        : isEnabled
                        ? "var(--sw-surface-2)"
                        : "var(--sw-surface-1)",
                    }}
                    title={isEnabled ? `Biến thể ${variantKey}` : disabledReason}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <strong>Biến thể {variantKey}</strong>
                      <StatusBadge
                        status={isEnabled ? "ready" : "unavailable"}
                        label={isEnabled ? "Khả dụng" : "Chưa khả dụng"}
                      />
                    </div>
                    <small style={{ color: "var(--sw-text-muted)", display: "block", lineHeight: "1.3" }}>
                      {isEnabled
                        ? (variantKey === "S"
                            ? "Extension huấn luyện tương thích đã được cung cấp riêng."
                            : `Biến thể ${variantKey} khả dụng cho huấn luyện.`)
                        : disabledReason}
                    </small>
                  </div>
                );
              })}
            </div>
          </div>

          {baseModel && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--sw-text-secondary)" }}>
              <span>{baseModel.name} · {form.model_variant ? `Biến thể ${form.model_variant}` : "Chưa chọn biến thể"}</span>
            </div>
          )}

          {blocker && (
            <div className="sw-notice" style={{ marginTop: 10 }}>
              <Icon name="info" size={16} />
              <span>{blocker}</span>
            </div>
          )}

          {/* Scope and Hyperparameters */}
          <div style={{ marginTop: 14 }}>
            <label>Phần model được cập nhật<select
              className="sw-select"
              value={form.finetune_scope || "adapter_head"}
              onChange={(e) => updateForm({ finetune_scope: e.target.value })}
            >
              <option value="adapter_head">Phạm vi do extension cung cấp</option>
              <option value="full">Toàn bộ model · dùng nhiều VRAM hơn</option>
            </select></label>
            <small style={{ color: "var(--sw-text-muted)", display: "block", marginTop: 4 }}>
              Chế độ nhẹ giữ nguyên trọng số backbone. Nhãn mới có trọng số lấy mẫu gấp 2.
            </small>
          </div>

          <h2><span className="sw-step">2</span> Khi nào bắt đầu?</h2>
          <div className="sw-trigger-options">
            {Object.entries(TRIGGER_NAMES).map(([id, title]) => (
              <label key={id} className={form.trigger === id ? "selected" : ""}>
                <input
                  type="radio"
                  name="trigger"
                  value={id}
                  checked={form.trigger === id}
                  onChange={() => updateForm({ trigger: id, enabled: id === "manual" ? false : form.enabled })}
                />
                <span>
                  <b>{title}</b>
                  <small>
                    {{
                      manual: "Bạn bấm Bắt đầu khi cần",
                      count: "Đếm study có nhãn mới đã duyệt",
                      schedule: "Kiểm tra định kỳ, cần có dữ liệu mới",
                      either: "Điều kiện nào đến trước sẽ chạy",
                    }[id]}
                  </small>
                </span>
              </label>
            ))}
          </div>

          <div className="sw-fields" style={{ marginTop: 12 }}>
            {["count", "either"].includes(form.trigger) && (
              <label>Số study có nhãn mới<input
                type="number"
                className="sw-input"
                min="1"
                max="100000"
                value={form.min_new_cases || 10}
                onChange={(e) => updateForm({ min_new_cases: Number(e.target.value) })}
              /></label>
            )}
            {["schedule", "either"].includes(form.trigger) && (
              <label>Chu kỳ (ngày)<input
                type="number"
                className="sw-input"
                min="1"
                max="365"
                value={form.interval_days || 7}
                onChange={(e) => updateForm({ interval_days: Number(e.target.value) })}
              /><small>Lần đầu tính từ lúc lưu kế hoạch.</small></label>
            )}
          </div>

          {form.trigger !== "manual" && (
            <label className="sw-source-choice" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => updateForm({ enabled: e.target.checked })}
              />
              <span>
                <b>Bật tự động theo điều kiện này</b>
                <small>Chạy ở máy chủ kể cả khi đóng trình duyệt.</small>
              </span>
            </label>
          )}

          <details style={{ marginTop: 14 }}>
            <summary>Thông số huấn luyện nâng cao</summary>
            <div className="sw-fields" style={{ marginTop: 10 }}>
              <label>Epoch<input
                type="number"
                className="sw-input"
                min="1"
                max="1000"
                value={form.epochs || 40}
                onChange={(e) => updateForm({ epochs: Number(e.target.value) })}
              /></label>
              <label>Learning rate<input
                type="number"
                className="sw-input"
                min="0.0000001"
                max="0.1"
                step="any"
                value={form.learning_rate || 0.0003}
                onChange={(e) => updateForm({ learning_rate: Number(e.target.value) })}
              /></label>
              <label>Batch size<input
                type="number"
                className="sw-input"
                min="1"
                step="1"
                max="128"
                value={form.batch_size || 4}
                onChange={(e) => updateForm({ batch_size: Number(e.target.value) })}
              /></label>
            </div>
            <small style={{ color: "var(--sw-text-muted)", display: "block", marginTop: 4 }}>
              Cấu hình huấn luyện do extension được cung cấp riêng quyết định.
            </small>
          </details>
        </div>

        {/* Plan Review Column */}
        <aside className="sw-card sw-plan">
          <span className="sw-eyebrow">3. KIỂM TRA KẾ HOẠCH</span>
          <h2>{TRIGGER_NAMES[form.trigger]}</h2>
          <dl className="sw-facts">
            <div>
              <dt>Model</dt>
              <dd>{baseModel ? baseModel.name : "Chưa chọn"}</dd>
            </div>
            <div>
              <dt>Biến thể</dt>
              <dd>{form.model_variant || "Chưa chọn"}</dd>
            </div>
            <div>
              <dt>Dataset</dt>
              <dd>{recipe?.name || "Chưa chọn"}</dd>
            </div>
            <div>
              <dt>Nhãn đã duyệt</dt>
              <dd>{recipe?.include_pool ? "Tự thêm vào mỗi lần chạy" : "Không bổ sung"}</dd>
            </div>
            <div>
              <dt>Chế độ học</dt>
              <dd>{form.finetune_scope === "full" ? "Toàn bộ model" : "Adapter + đầu segmentation"}</dd>
            </div>
            <div>
              <dt>Thông số</dt>
              <dd>{form.epochs} epoch · LR {form.learning_rate} · batch {form.batch_size}</dd>
            </div>
          </dl>

          <label className="sw-source-choice" style={{ margin: "10px 0" }}>
            <input
              type="checkbox"
              checked={form.auto_validate ?? true}
              onChange={(e) => updateForm({ auto_validate: e.target.checked })}
            />
            <span>
              <b>Tự đánh giá sau training</b>
              <small>Dùng benchmark tách riêng của phiên bản đó.</small>
            </span>
          </label>

          <button
            className="sw-btn sw-btn-primary"
            disabled={busy || !form.recipe_id || !form.base_model_id}
          >
            {busy ? "Đang xử lý…" : changed ? "Lưu thay đổi kế hoạch" : "Lưu kế hoạch"}
          </button>

          <button
            type="button"
            className="sw-btn"
            disabled={busy || changed || Boolean(training.blocker) || Boolean(activeRun)}
            onClick={handleLaunch}
          >
            Bắt đầu một lần ngay
          </button>

          {changed && <small style={{ color: "var(--sw-warning)" }}>Lưu kế hoạch trước khi bắt đầu.</small>}
          {blocker && <small style={{ color: "var(--sw-danger)" }}>{blocker}</small>}
        </aside>
      </form>

      {/* HISTORY RUNS TABLE (SCREEN 5) */}
      <section className="sw-card sw-run-history">
        <div className="sw-card-header">
          <div>
            <h2>Lịch sử Fine-tune & Evaluation</h2>
            <p>Mỗi hàng là một lần chạy. Metric evaluation chỉ dùng tập test/holdout của chính lần đó.</p>
          </div>
          <span className="sw-badge blue">{fineTuneRuns.length} lần chạy</span>
        </div>

        {fineTuneRuns.length ? (
          <div className="sw-table-wrap">
            <table className="sw-table">
              <thead>
                <tr>
                  <th>Lần fine-tune</th>
                  <th>Model & Biến thể</th>
                  <th>Dataset</th>
                  <th>Study eval</th>
                  <th>Macro Dice</th>
                  <th>IoU</th>
                  <th>HD95</th>
                  <th>Recall</th>
                  <th>Gate</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {fineTuneRuns.map((r) => {
                  const m = r.metrics || {};
                  const gate = m.validation_gate;
                  const isThisRunActive = ["queued", "running", "validation_queued", "validating"].includes(r.status);
                  const gateText = gate?.passed ? "Đạt" : gate ? "Không đạt" : isThisRunActive ? "Đang chạy" : "Chờ đánh giá";

                  const runBaseModel = data.models?.find((mod) => mod.id === (r.base_model_id || r.model_id));
                  const modelResolvedName = runBaseModel?.name || (r.base_model_id ? `Model ${r.base_model_id.slice(0, 8).toUpperCase()}` : "Chưa xác định");
                  const runVariant = m.model_variant || r.config?.model_variant || "Chưa xác định";

                  return (
                    <tr key={r.id} className={r.id === selectedRunId ? "selected" : ""}>
                      <td>
                        <strong>{r.name}</strong>
                        <small style={{ display: "block", color: "var(--sw-text-muted)" }}>
                          {r.created_at ? new Date(r.created_at).toLocaleString("vi-VN") : "—"}
                        </small>
                      </td>
                      <td>
                        <strong>{modelResolvedName}</strong>
                        <div style={{ marginTop: 2 }}>
                          <span className="sw-badge neutral" style={{ fontSize: 11 }}>
                            {runVariant === "Chưa xác định" ? "Biến thể chưa xác định" : `Biến thể ${runVariant}`}
                          </span>
                        </div>
                      </td>
                      <td>
                        {data.datasets?.find((d) => d.id === r.dataset_version_id)?.name ||
                          m.dataset_name ||
                          "—"}
                      </td>
                      <td>{m.holdout_cases ?? m.test_cases ?? "—"}</td>
                      <td>
                        <strong>
                          {typeof m.mean_dice === "number"
                            ? m.mean_dice.toLocaleString("vi-VN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                            : "—"}
                        </strong>
                      </td>
                      <td>
                        {typeof m.mean_iou === "number"
                          ? m.mean_iou.toLocaleString("vi-VN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                          : "—"}
                      </td>
                      <td>
                        {typeof m.mean_hd95_mm === "number"
                          ? `${m.mean_hd95_mm.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mm`
                          : "—"}
                      </td>
                      <td>
                        {typeof m.lesion_recall === "number"
                          ? m.lesion_recall.toLocaleString("vi-VN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                          : "—"}
                      </td>
                      <td>
                        <StatusBadge
                          status={gate?.passed ? "passed" : gate ? "failed" : isThisRunActive ? "running" : "pending"}
                          label={gateText}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="sw-btn sw-btn-sm"
                          onClick={() => setSelectedRunId(r.id)}
                        >
                          Xem đầy đủ
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sw-empty">Chưa có lần fine-tune nào.</p>
        )}
      </section>
    </div>
  );
}
