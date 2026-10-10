import { trainingAvailable } from "../../trainingAvailability";
import React, { useState } from "react";
import StatusBadge from "./StatusBadge";

/**
 * Screen 23: System Health (Spec Section 23)
 * Monitors operational health of model runtimes (Biến thể S, M, L),
 * serving backend, and training worker connectivity.
 * Truthful to backend: renders actual serving backend and worker status without fabricated hardware telemetry.
 */
export default function SystemView({
  data,
  systemMetrics = {},
  authorization,
  run,
  busy,
}) {
  const [selectedWorker, setSelectedWorker] = useState(null);

  const serving = data?.studio?.serving || {};
  const caps = data?.caps || {};
  const models = data?.models || [];
  const fineTuneOptionsList = Array.isArray(data?.studio?.fine_tune_options)
    ? data.studio.fine_tune_options
    : [];
  // Resolve ONLY by serving.registered_model_id; absent => unknown
  const servingModel = serving.registered_model_id
    ? models.find((m) => m.id === serving.registered_model_id) || null
    : null;
  const workerAlive = Boolean(caps.worker_alive);
  const servingVariant = serving.model_variant || servingModel?.metrics?.model_variant || "Biến thể chưa xác định";

  // Match serving/fine-tunable model option
  const matchingOption = fineTuneOptionsList.find(
    (opt) => (serving.registered_model_id && opt.model_id === serving.registered_model_id) || opt.is_baseline
  );
  const supportedVariants = matchingOption?.variants || [];

  // Fine-tune capabilities: S/M/L cards where enabled is determined from matching option
  const fineTuneVariants = [
    {
      id: "S",
      name: "Baseline S",
      desc: "Model được cung cấp cho thử nghiệm nghiên cứu",
      supported: trainingAvailable(caps) && supportedVariants.includes("S"),
    },
    {
      id: "M",
      name: "M · extension",
      desc: "Chưa được cung cấp trong bản public",
      supported: false,
    },
    {
      id: "L",
      name: "L · extension",
      desc: "Chưa được cung cấp trong bản public",
      supported: false,
    },
  ].map((v) => {
    const isEnabled = trainingAvailable(caps) && workerAlive && v.supported;
    return {
      id: v.id,
      name: v.name,
      desc: v.desc,
      status: !trainingAvailable(caps) ? "Training chưa được cung cấp" : isEnabled ? "Extension đã kết nối" : (workerAlive ? "Chưa khả dụng" : "Worker ngoại tuyến"),
      active: isEnabled,
      reason: !v.supported
        ? "Bản public chỉ có ONNX; chưa cung cấp checkpoint, mã model huấn luyện hoặc runtime"
        : (workerAlive ? "* Cấu hình fine-tune qua worker cục bộ." : "Worker ngoại tuyến"),
    };
  });

  // Truthful system services list based strictly on backend capabilities (no invented strings)
  const availableServices = [
    {
      key: "inference_serving",
      role: "Inference Serving",
      description: "Phục vụ suy luận nghiên cứu",
      status: "Chưa xác minh telemetry runtime",
      backend: serving.backend || "—",
      loadedModel: servingModel?.name
        ? `${servingModel.name}${serving.model_version ? ` (${serving.model_version})` : ""}`
        : (serving.model_version || "—"),
      registeredId: serving.registered_model_id || "—",
      telemetry: "Chưa có telemetry",
      ready: false,
    },
    {
      key: "mlops_worker",
      role: "MLOps Training Worker",
      description: "Tiến trình worker huấn luyện",
      status: workerAlive ? "Sẵn sàng" : "Ngoại tuyến",
      backend: "—",
      loadedModel: "—",
      registeredId: "—",
      telemetry: "Chưa có telemetry",
      ready: workerAlive,
    },
  ];

  return (
    <div className="sw-page sw-fade-in">
      {/* Top Header */}
      <header className="sw-heading">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <span className="sw-eyebrow">AI STUDIO / HỆ THỐNG</span>
            <h1>Hệ thống & Dịch vụ Inference / Worker</h1>
            <p>
              Giám sát dịch vụ inference được kết nối riêng và khả năng huấn luyện đã được cung cấp.
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <span className="studio-status-pill">
              <i
                style={{ backgroundColor: workerAlive ? "#10B981" : "var(--sw-accent-danger)" }}
              />{" "}
              {workerAlive ? "Training worker trực tuyến" : "Training worker ngoại tuyến"}
            </span>
            <button
              type="button"
              className="sw-btn sw-btn-secondary sw-btn-sm"
              disabled
              title="Chưa hỗ trợ API làm mới telemetry"
            >
              Làm mới telemetry
            </button>
          </div>
        </div>
      </header>

      {/* Overview Backend & Worker Cards (Honest operational values) */}
      <div className="sw-stat-grid" style={{ marginBottom: "24px" }}>
        <div className="sw-stat-card">
          <div className="sw-stat-label">Backend Serving</div>
          <div className="sw-stat-value" style={{ fontSize: "16px", marginTop: "4px" }}>
            {serving.backend || "Chưa xác định"}
          </div>
          <div className="sw-stat-sub">Dịch vụ inference được kết nối riêng</div>
        </div>
        <div className="sw-stat-card">
          <div className="sw-stat-label">Model Đang Phục Vụ</div>
          <div className="sw-stat-value" style={{ fontSize: "16px", marginTop: "4px" }}>
            {servingModel?.name || "Chưa xác định"}
          </div>
          <div className="sw-stat-sub">
            Phiên bản: {serving.model_version || "—"} · {servingVariant}
          </div>
        </div>
        <div className="sw-stat-card">
          <div className="sw-stat-label">Tiến trình Training Worker</div>
          <div className="sw-stat-value" style={{ fontSize: "16px", marginTop: "4px", color: workerAlive ? "#10B981" : "var(--sw-accent-danger)" }}>
            {workerAlive ? "Đang hoạt động" : "Ngoại tuyến"}
          </div>
          <div className="sw-stat-sub">
            {workerAlive ? "Sẵn sàng nhận job Fine-tune" : "Không thể bắt đầu run mới"}
          </div>
        </div>
        <div className="sw-stat-card">
          <div className="sw-stat-label">Telemetry Phần Cứng Cụm</div>
          <div className="sw-stat-value" style={{ fontSize: "16px", marginTop: "4px", color: "var(--sw-text-muted)" }}>
            Chưa có dữ liệu
          </div>
          <div className="sw-stat-sub">Backend chưa tích hợp cluster agent</div>
        </div>
      </div>

      {/* Serving Runtime Status Panel */}
      <section className="sw-card" style={{ marginBottom: "24px" }}>
        <div className="sw-card-header">
          <div>
            <h2 className="sw-card-title">Runtime Phục vụ Lâm sàng (Inference Serving)</h2>
            <p className="sw-card-desc">
              Cấu hình runtime phục vụ suy luận hiện tại từ backend serving.
            </p>
          </div>
        </div>
        <div
          style={{
            background: "var(--sw-surface-2)",
            border: "1px solid var(--sw-border-default)",
            borderRadius: "8px",
            padding: "16px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "16px",
            fontSize: "13px",
          }}
        >
          <div>
            <span style={{ color: "var(--sw-text-muted)" }}>Backend:</span>
            <div style={{ fontWeight: "600", marginTop: "4px" }}>{serving.backend || "Chưa xác định"}</div>
          </div>
          <div>
            <span style={{ color: "var(--sw-text-muted)" }}>Model Đang Nạp:</span>
            <div style={{ fontWeight: "600", marginTop: "4px" }}>{servingModel?.name || "Chưa xác định"}</div>
          </div>
          <div>
            <span style={{ color: "var(--sw-text-muted)" }}>Phiên bản / Biến thể:</span>
            <div style={{ fontWeight: "600", marginTop: "4px" }}>
              {serving.model_version || "—"} ({servingVariant})
            </div>
          </div>
          <div>
            <span style={{ color: "var(--sw-text-muted)" }}>Trạng thái Runtime:</span>
            <div style={{ marginTop: "4px" }}>
              <StatusBadge status="Chưa xác minh telemetry runtime" />
            </div>
          </div>
        </div>
      </section>

      {/* Fine-tune Capabilities Section (Separated from Inference) */}
      <section className="sw-card" style={{ marginBottom: "24px" }}>
        <div className="sw-card-header">
          <div>
            <h2 className="sw-card-title">Khả năng Fine-tune theo Biến thể</h2>
            <p className="sw-card-desc">
              Các cấu hình biến thể được hỗ trợ bởi pipeline huấn luyện Fine-tune (từ fine_tune_options).
            </p>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "16px",
          }}
        >
          {fineTuneVariants.map((v) => (
            <div
              key={v.id}
              className={`sw-card sw-variant-card ${v.active ? "" : "disabled"}`}
              style={{
                background: v.active ? "var(--sw-surface-2)" : "rgba(11, 30, 44, 0.4)",
                border: v.active ? "1px solid var(--sw-border-default)" : "1px dashed var(--sw-border-default)",
                opacity: v.active ? 1 : 0.75,
                padding: "16px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                <div>
                  <div style={{ fontWeight: "600", fontSize: "14px", color: "var(--sw-text-primary)" }}>
                    {v.name}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--sw-text-muted)", marginTop: "4px" }}>
                    {v.desc}
                  </div>
                </div>
                <StatusBadge status={v.status} />
              </div>
              <div style={{ fontSize: "11px", color: "var(--sw-text-muted)", fontStyle: "italic", marginTop: "8px" }}>
                {v.reason}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Serving & Worker Services Status */}
      <section className="sw-card">
        <div className="sw-card-header">
          <div>
            <h2 className="sw-card-title">Dịch vụ Runtime & Worker</h2>
            <p className="sw-card-desc">
              Danh sách các dịch vụ runtime serving và worker thực thi trong hệ thống.
            </p>
          </div>
        </div>

        <div style={{ marginBottom: "16px", padding: "12px 14px", background: "rgba(56, 189, 248, 0.06)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: "6px", fontSize: "13px", color: "var(--sw-text-secondary)" }}>
          ℹ️ <strong>Thông báo trạng thái:</strong> Backend chưa tích hợp cluster telemetry agent để thu thập số liệu phần cứng chi tiết (CPU, GPU VRAM, nhiệt độ) của từng máy chủ vật lý. Dữ liệu hiển thị bên dưới dựa trên trạng thái kết nối thực tế từ API.
        </div>

        <div className="sw-table-wrapper">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Dịch vụ hệ thống</th>
                <th>Vai trò</th>
                <th>Backend thực thi</th>
                <th>Model / Nhiệm vụ</th>
                <th>Telemetry phần cứng</th>
                <th>Trạng thái</th>
                <th>Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {availableServices.map((w) => (
                <tr key={w.key}>
                  <td style={{ fontWeight: "600" }}>{w.role}</td>
                  <td style={{ fontSize: "12px", color: "var(--sw-text-secondary)" }}>{w.description}</td>
                  <td style={{ fontSize: "12px" }}>{w.backend}</td>
                  <td style={{ fontSize: "12px" }}>{w.loadedModel}</td>
                  <td style={{ color: "var(--sw-text-muted)", fontSize: "12px", fontStyle: "italic" }}>
                    {w.telemetry}
                  </td>
                  <td>
                    <StatusBadge status={w.status} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="sw-btn sw-btn-ghost sw-btn-xs"
                      onClick={() => setSelectedWorker(w)}
                    >
                      Xem cấu hình
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Diagnostics Drawer (Truthful, no fake probe numbers) */}
      {selectedWorker && (
        <div
          className="sw-modal-backdrop"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(3, 10, 18, 0.75)",
            backdropFilter: "blur(3px)",
            display: "flex",
            justifyContent: "flex-end",
            zIndex: 9999,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedWorker(null);
          }}
        >
          <div
            className="sw-drawer sw-fade-in"
            style={{
              width: "100%",
              maxWidth: "520px",
              height: "100%",
              background: "var(--sw-surface-1)",
              borderLeft: "1px solid var(--sw-border-default)",
              padding: "24px",
              overflowY: "auto",
              boxShadow: "var(--sw-shadow-lg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <div>
                <h3 style={{ margin: "0 0 4px 0", fontSize: "18px" }}>Cấu hình Dịch vụ</h3>
                <div style={{ fontSize: "13px", color: "var(--sw-text-muted)" }}>
                  {selectedWorker.role} — {selectedWorker.description}
                </div>
              </div>
              <button
                type="button"
                className="sw-btn sw-btn-ghost sw-btn-xs"
                onClick={() => setSelectedWorker(null)}
                style={{ fontSize: "18px" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px", fontSize: "13px" }}>
              <div
                style={{
                  background: "var(--sw-surface-2)",
                  borderRadius: "8px",
                  padding: "14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ fontWeight: "600", color: "var(--sw-text-secondary)", marginBottom: "4px" }}>
                  Thông tin phục vụ
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Trạng thái:</span>
                  <span style={{ fontWeight: "600", color: selectedWorker.ready ? "#10B981" : "var(--sw-accent-danger)" }}>
                    {selectedWorker.status}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Backend:</span>
                  <span style={{ fontWeight: "600" }}>{selectedWorker.backend}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Model / Target:</span>
                  <span style={{ fontWeight: "600" }}>{selectedWorker.loadedModel}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>ID đăng ký:</span>
                  <span style={{ fontFamily: "var(--sw-font-mono)", fontSize: "12px" }}>{selectedWorker.registeredId}</span>
                </div>
              </div>

              <div
                style={{
                  background: "var(--sw-surface-2)",
                  borderRadius: "8px",
                  padding: "14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ fontWeight: "600", color: "var(--sw-text-secondary)", marginBottom: "4px" }}>
                  Khả năng điều phối (Capabilities)
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Training Worker Alive:</span>
                  <span>{caps.worker_alive ? "true" : "false"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Training Configured:</span>
                  <span>{trainingAvailable(caps) ? "true" : "false"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Validation Configured:</span>
                  <span>{caps.validation_configured ? "true" : "false"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Deployment Configured:</span>
                  <span>{caps.deployment_configured ? "true" : "false (Chưa hỗ trợ release tự động)"}</span>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: "600", color: "var(--sw-text-secondary)", marginBottom: "8px" }}>
                  Chi tiết kỹ thuật API payload
                </div>
                <pre
                  style={{
                    background: "#030A12",
                    border: "1px solid var(--sw-border-default)",
                    borderRadius: "6px",
                    padding: "10px",
                    fontSize: "11px",
                    color: "#38BDF8",
                    margin: 0,
                    overflowX: "auto",
                  }}
                >
{JSON.stringify({
  serving_backend: serving.backend || null,
  serving_model_version: serving.model_version || null,
  registered_model_id: serving.registered_model_id || null,
  worker_alive: caps.worker_alive ?? null,
  deployment_configured: caps.deployment_configured ?? false,
}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
