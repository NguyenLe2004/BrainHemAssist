import React, { useState } from "react";
import { Icon } from "../../icons";
import StatusBadge from "./StatusBadge";

/**
 * Screen 4: Dataset Detail View
 * Shows strictly real dataset metadata from API. If metadata is missing,
 * renders honest unavailable states ('Chưa có dữ liệu' / 'Chưa có báo cáo chi tiết').
 */
export default function DatasetDetailView({
  dataset,
  onBack,
  onFineTune,
  onClone,
  runs = [],
  models = [],
}) {
  const [subTab, setSubTab] = useState("overview");

  if (!dataset) {
    return (
      <div className="sw-page">
        <button type="button" className="sw-btn sw-btn-ghost sw-btn-sm" onClick={onBack}>
          ← Quay lại danh sách
        </button>
        <p className="sw-empty">Không tìm thấy thông tin dataset version.</p>
      </div>
    );
  }

  const manifest = dataset.manifest || {};
  const splits = manifest.splits || {};
  const trainCount = Array.isArray(splits.train)
    ? splits.train.length
    : typeof splits.train === "number"
    ? splits.train
    : 0;
  const valCount = Array.isArray(splits.validation)
    ? splits.validation.length
    : typeof splits.validation === "number"
    ? splits.validation
    : 0;
  const testCount = Array.isArray(splits.test)
    ? splits.test.length
    : typeof splits.test === "number"
    ? splits.test
    : 0;
  const totalCount = dataset.num_cases ?? (trainCount + valCount + testCount > 0 ? trainCount + valCount + testCount : null);

  const trainPct = totalCount ? Math.round((trainCount / totalCount) * 100) : 0;
  const valPct = totalCount ? Math.round((valCount / totalCount) * 100) : 0;
  const testPct = totalCount ? Math.max(0, 100 - trainPct - valPct) : 0;

  // Real lineage sources from manifest
  const sourcesList = Array.isArray(manifest.sources)
    ? manifest.sources
    : manifest.source_ids
    ? manifest.source_ids.map((id) => ({ id, name: id }))
    : [];

  // Real diff records if available in API
  const realDiffRecords = Array.isArray(dataset.diff)
    ? dataset.diff
    : Array.isArray(manifest.diff)
    ? manifest.diff
    : [];

  // Real leakage report if supplied by API
  const leakageReport = dataset.leakage_report || manifest.leakage_report || null;

  const datasetRuns = runs.filter((r) => r.dataset_version_id === dataset.id);
  const datasetModels = models.filter((m) => m.dataset_version_id === dataset.id);

  return (
    <div className="sw-page sw-fade-in">
      {/* Header */}
      <header className="sw-heading" style={{ alignItems: "flex-start" }}>
        <div>
          <button
            type="button"
            className="sw-btn sw-btn-ghost sw-btn-sm"
            onClick={onBack}
            style={{ paddingLeft: 0, marginBottom: 8 }}
          >
            ← Quay lại danh sách Dataset
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ margin: 0 }}>{dataset.name} · {dataset.version || "—"}</h1>
            <StatusBadge status="ready" label="Đã đóng băng" />
          </div>
          <p style={{ marginTop: 6, color: "var(--sw-text-muted)" }}>
            Phiên bản dataset bất biến, lưu trữ danh sách study và phân chia tập đã được cố định.
          </p>
          <div className="sw-detail-tags" style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12, color: "var(--sw-text-secondary)" }}>
            <span>
              <Icon name="database" size={14} />{" "}
              {totalCount !== null ? `${totalCount.toLocaleString("vi-VN")} studies` : "Chưa có dữ liệu số ca"}
            </span>
            <span>
              <Icon name="shield" size={14} /> Checksum:{" "}
              <code>{dataset.artifact_sha256 ? dataset.artifact_sha256.slice(0, 16) : "Chưa có SHA256"}</code>
            </span>
            <span>
              <Icon name="clock" size={14} /> Tạo lúc:{" "}
              {dataset.created_at ? new Date(dataset.created_at).toLocaleString("vi-VN") : "Chưa có thời gian"}
            </span>
          </div>
        </div>

        <div className="sw-actions">
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            onClick={() => onFineTune(dataset)}
          >
            Fine-tune bằng version này
          </button>
          <button
            type="button"
            className="sw-btn"
            onClick={() => onClone(dataset)}
            title="Tạo bản sao mới để chỉnh sửa (bảo toàn tính bất biến của version hiện tại)"
          >
            Clone thành version mới
          </button>
        </div>
      </header>

      {/* Sub-tabs */}
      <nav className="sw-tabs" style={{ marginTop: 16 }}>
        {[
          ["overview", "Tổng quan"],
          ["lineage", "Nguồn dữ liệu & Recipe"],
          ["diff", `Thay đổi (${realDiffRecords.length})`],
          ["leakage", "Báo cáo Leakage"],
          ["usage", `Sử dụng (${datasetRuns.length} runs)`],
          ["manifest", "Manifest JSON"],
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

      {/* SUBTAB: OVERVIEW */}
      {subTab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
            {/* Phân chia dữ liệu */}
            <article className="sw-card">
              <span className="sw-eyebrow">PHÂN CHIA DỮ LIỆU</span>
              <div style={{ display: "flex", alignItems: "center", gap: 24, margin: "16px 0" }}>
                <div
                  style={{
                    width: 90,
                    height: 90,
                    borderRadius: "50%",
                    background: "var(--sw-surface-2)",
                    border: "2px solid var(--sw-border-default)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <strong style={{ fontSize: 22 }}>
                    {totalCount !== null ? totalCount.toLocaleString("vi-VN") : "—"}
                  </strong>
                  <small style={{ color: "var(--sw-text-muted)", fontSize: 11 }}>studies</small>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>
                      <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--sw-accent-primary)", marginRight: 6 }} />
                      Train ({trainPct}%)
                    </span>
                    <strong>{trainCount.toLocaleString("vi-VN")} studies</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>
                      <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#A855F7", marginRight: 6 }} />
                      Validation ({valPct}%)
                    </span>
                    <strong>{valCount.toLocaleString("vi-VN")} studies</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>
                      <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--sw-accent-warning)", marginRight: 6 }} />
                      Benchmark / Test ({testPct}%)
                    </span>
                    <strong>{testCount.toLocaleString("vi-VN")} studies</strong>
                  </div>
                </div>
              </div>
              <small style={{ color: "var(--sw-text-muted)" }}>
                Tập test được cách ly và giữ cố định cho đánh giá chuẩn hóa.
              </small>
            </article>

            {/* Thông tin metadata thực */}
            <article className="sw-card">
              <span className="sw-eyebrow">METADATA PHIÊN BẢN</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--sw-border-default)" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Recipe nguồn:</span>
                  <span style={{ fontFamily: "var(--sw-font-mono)" }}>{manifest.recipe_id || "Chưa có dữ liệu"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--sw-border-default)" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Người tạo:</span>
                  <span>{dataset.created_by || "Chưa có dữ liệu"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--sw-border-default)" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Số nguồn tham chiếu:</span>
                  <span>{sourcesList.length > 0 ? `${sourcesList.length} nguồn` : "Chưa có dữ liệu"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                  <span style={{ color: "var(--sw-text-muted)" }}>Số lượt fine-tune đã dùng:</span>
                  <span style={{ fontWeight: 600 }}>{datasetRuns.length} runs</span>
                </div>
              </div>
            </article>
          </div>
        </div>
      )}

      {/* SUBTAB: LINEAGE */}
      {subTab === "lineage" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Nguồn dữ liệu & Recipe</h2>
          <p>Danh sách nguồn dữ liệu được sử dụng để đóng băng phiên bản dataset này.</p>
          {sourcesList.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              {sourcesList.map((s, idx) => (
                <div
                  key={s.id || idx}
                  style={{
                    padding: 12,
                    background: "var(--sw-surface-2)",
                    borderRadius: 8,
                    border: "1px solid var(--sw-border-default)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <strong>{s.name || s.id}</strong>
                  <span style={{ color: "var(--sw-text-muted)", fontSize: 12 }}>
                    {s.num_cases ? `${s.num_cases} studies` : "Nguồn cấu hình"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="sw-empty" style={{ marginTop: 14 }}>
              Chưa có dữ liệu nguồn chi tiết trong manifest của phiên bản này.
            </p>
          )}
        </article>
      )}

      {/* SUBTAB: DIFF */}
      {subTab === "diff" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Bản ghi thay đổi (Diff)</h2>
          <p>So sánh danh sách ca chụp và sửa đổi nhãn so với phiên bản tiền nhiệm.</p>
          {realDiffRecords.length > 0 ? (
            <div className="sw-table-wrap" style={{ marginTop: 14 }}>
              <table className="sw-table">
                <thead>
                  <tr>
                    <th>Study ID</th>
                    <th>Loại thay đổi</th>
                    <th>Chi tiết</th>
                    <th>Người thực hiện</th>
                  </tr>
                </thead>
                <tbody>
                  {realDiffRecords.map((d, i) => (
                    <tr key={d.id || i}>
                      <td style={{ fontFamily: "var(--sw-font-mono)" }}>{d.id || "—"}</td>
                      <td>{d.type || "—"}</td>
                      <td>{d.detail || d.note || "—"}</td>
                      <td>{d.actor || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sw-empty" style={{ marginTop: 14 }}>
              Chưa có dữ liệu thay đổi (diff) được ghi nhận cho phiên bản này.
            </p>
          )}
        </article>
      )}

      {/* SUBTAB: LEAKAGE REPORT */}
      {subTab === "leakage" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Báo cáo Data Leakage</h2>
          <p>Kiểm tra tính độc lập giữa bệnh nhân ở tập Train, Validation và Benchmark Test.</p>
          {leakageReport ? (
            <div style={{ marginTop: 14 }}>
              <pre
                style={{
                  background: "#030A12",
                  padding: 14,
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: "var(--sw-font-mono)",
                  color: "#38BDF8",
                }}
              >
                {JSON.stringify(leakageReport, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="sw-notice" style={{ marginTop: 14 }}>
              <Icon name="info" size={16} />
              <span>
                Chưa có báo cáo chi tiết về data leakage cho phiên bản này. Hệ thống chỉ ghi nhận kết quả kiểm tra rò rỉ khi báo cáo được xuất bởi pipeline kiểm định.
              </span>
            </div>
          )}
        </article>
      )}

      {/* SUBTAB: USAGE */}
      {subTab === "usage" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Lịch sử sử dụng</h2>
          <p>Các lần fine-tune và model candidate đã được huấn luyện bằng dataset này.</p>
          {datasetRuns.length > 0 ? (
            <div className="sw-table-wrap" style={{ marginTop: 14 }}>
              <table className="sw-table">
                <thead>
                  <tr>
                    <th>Tên run</th>
                    <th>Trạng thái</th>
                    <th>Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  {datasetRuns.map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td style={{ color: "var(--sw-text-muted)" }}>
                        {r.created_at ? new Date(r.created_at).toLocaleString("vi-VN") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sw-empty" style={{ marginTop: 14 }}>
              Chưa có lần fine-tune nào sử dụng phiên bản dataset này.
            </p>
          )}
        </article>
      )}

      {/* SUBTAB: MANIFEST */}
      {subTab === "manifest" && (
        <article className="sw-card" style={{ marginTop: 16 }}>
          <h2>Manifest JSON</h2>
          <pre
            style={{
              background: "#030A12",
              padding: 14,
              borderRadius: 8,
              fontSize: 12,
              fontFamily: "var(--sw-font-mono)",
              color: "#38BDF8",
              maxHeight: 400,
              overflowY: "auto",
              marginTop: 14,
            }}
          >
            {JSON.stringify(dataset, null, 2)}
          </pre>
        </article>
      )}
    </div>
  );
}
