import React, { useState, useEffect } from "react";
import { Icon } from "../../icons";
import StatusBadge from "./StatusBadge";
import DatasetWizard from "./DatasetWizard";
import DatasetDetailView from "./DatasetDetailView";
import {
  createStudioRecipe,
  previewStudioRecipe,
  freezeStudioRecipe,
  importStudioSource,
} from "../../api";

export default function DatasetsView({
  data,
  openTab,
  authorization,
  run,
  busy,
  onNavigate,
}) {
  const { sources = [], recipes = [], pool = { total: 0, approved: 0, pending: 0, benchmark_excluded: 0 } } =
    data.studio || {};
  const datasets = data.datasets || [];

  const [activeSub, setActiveSub] = useState("versions");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showWizard, setShowWizard] = useState(false);
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);

  // Source upload state
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadRole, setUploadRole] = useState("development");
  const [uploadFile, setUploadFile] = useState(null);

  // Recipe Builder state
  const [buildingRecipe, setBuildingRecipe] = useState(false);
  const [recipeForm, setRecipeForm] = useState({
    name: "",
    source_ids: [],
    include_pool: true,
    validation_percent: 20,
    max_cases_per_source: 0,
  });
  const [recipePreview, setRecipePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!buildingRecipe) return;
    let cancel = false;
    setPreviewLoading(true);
    previewStudioRecipe({ ...recipeForm, name: recipeForm.name || "Preview" })
      .then((res) => {
        if (!cancel) setRecipePreview(res);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancel) setPreviewLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [recipeForm, buildingRecipe]);

  const toggleRecipeSource = (id) => {
    setRecipeForm((curr) => ({
      ...curr,
      source_ids: curr.source_ids.includes(id)
        ? curr.source_ids.filter((x) => x !== id)
        : [...curr.source_ids, id],
    }));
  };

  const handleFineTuneVersion = (ds) => {
    sessionStorage.setItem("brainhem.studio-dataset-version", ds.id);
    openTab("fine_tune");
  };

  const handleCloneVersion = (ds) => {
    setRecipeForm({
      name: `${ds.name} (Bản sao)`,
      source_ids: sources.filter((s) => s.available && s.role !== "benchmark").map((s) => s.id),
      include_pool: true,
      validation_percent: 20,
      max_cases_per_source: 0,
    });
    setBuildingRecipe(true);
    setActiveSub("recipes");
  };

  // If user selected a dataset to view details:
  if (selectedDatasetId) {
    const selectedDs = datasets.find((d) => d.id === selectedDatasetId);
    return (
      <DatasetDetailView
        dataset={selectedDs}
        onBack={() => setSelectedDatasetId(null)}
        onFineTune={handleFineTuneVersion}
        onClone={handleCloneVersion}
        runs={data.runs || []}
        models={data.models || []}
      />
    );
  }

  // If wizard is open:
  if (showWizard) {
    return (
      <DatasetWizard
        data={data}
        authorization={authorization}
        run={run}
        busy={busy}
        onClose={() => setShowWizard(false)}
        onSuccess={(created) => {
          setShowWizard(false);
          if (created?.id) setSelectedDatasetId(created.id);
        }}
      />
    );
  }

  // Filter datasets
  const filteredDatasets = datasets.filter((d) => {
    const matchesSearch =
      (d.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (d.version || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (d.id || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || d.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="sw-page">
      <header className="sw-heading">
        <div>
          <span className="sw-eyebrow">AI STUDIO / DATASET</span>
          <h1>Dataset Versions</h1>
          <p>Các phiên bản dataset đã được đóng băng (frozen) để sử dụng cho Fine-tune và Evaluation.</p>
        </div>
        <div className="sw-actions">
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            onClick={() => setShowWizard(true)}
          >
            + Tạo Dataset Version
          </button>
          <button
            type="button"
            className="sw-btn"
            onClick={() => {
              setBuildingRecipe(true);
              setActiveSub("recipes");
            }}
          >
            + Tạo tập tùy chọn
          </button>
        </div>
      </header>

      {/* Sub-navigation tabs */}
      <nav className="sw-tabs" aria-label="Loại dữ liệu">
        {[
          ["versions", "Phiên bản dataset", datasets.length],
          ["recipes", "Tập tùy chọn (Recipes)", recipes.length],
          ["sources", "Thư viện nguồn", sources.length],
          ["pool", "Pool từ labeling", pool.approved],
        ].map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            className={activeSub === id ? "active" : ""}
            onClick={() => setActiveSub(id)}
          >
            {label}
            <span style={{ marginLeft: 6 }}>{count}</span>
          </button>
        ))}
      </nav>

      {/* SUB 1: DATASET VERSIONS (SCREEN 2) */}
      {activeSub === "versions" && (
        <div className="sw-datasets-list-section">
          {/* Filters Bar */}
          <div className="sw-toolbar" style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <div className="studio-search-wrap" style={{ width: 340 }}>
              <Icon name="search" size={14} />
              <input
                placeholder="Tìm theo tên dataset, mô tả, phiên bản..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <select
              className="sw-select"
              style={{ width: 200 }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">Tất cả trạng thái</option>
              <option value="frozen">Sẵn sàng (Đã đóng băng)</option>
              <option value="draft">Bản nháp</option>
              <option value="archived">Đã lưu trữ</option>
            </select>
          </div>

          {/* Table */}
          <div className="sw-table-wrap">
            <table className="sw-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Tên dataset</th>
                  <th>Số study</th>
                  <th>Split (Train/Val/Test)</th>
                  <th>Leakage</th>
                  <th>Số run</th>
                  <th>Trạng thái</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredDatasets.map((d) => {
                  const splits = d.manifest?.splits || {};
                  const train = Array.isArray(splits.train) ? splits.train.length : "—";
                  const val = Array.isArray(splits.validation) ? splits.validation.length : "—";
                  const test = Array.isArray(splits.test) ? splits.test.length : "—";
                  const runCount = (data.runs || []).filter((r) => r.dataset_version_id === d.id).length;

                  return (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.version || "—"}</strong>
                        <small>{d.created_at ? new Date(d.created_at).toLocaleDateString("vi-VN") : "—"}</small>
                      </td>
                      <td>
                        <strong>{d.name || "—"}</strong>
                        <small>{d.description || "—"}</small>
                      </td>
                      <td>
                        <strong>{d.num_cases || "—"}</strong>
                      </td>
                      <td>
                        <code>
                          {train} / {val} / {test}
                        </code>
                      </td>
                      <td>
                        {(() => {
                          const rep = d.leakage_report || d.manifest?.leakage_report;
                          const repPassed = rep && (rep.status === "passed" || rep.passed === true || rep.leakage_detected === false);
                          const isLeakageChecked = d.leakage_checked === true || d.manifest?.leakage_checked === true || Boolean(repPassed);
                          return isLeakageChecked ? (
                            <span className="sw-badge green">✓ Đã kiểm tra</span>
                          ) : (
                            <span className="sw-badge neutral" style={{ color: "var(--sw-text-muted)" }}>
                              Chưa có báo cáo chi tiết
                            </span>
                          );
                        })()}
                      </td>
                      <td>{runCount}</td>
                      <td>
                        <StatusBadge status={d.status || "Chưa xác định"} />
                      </td>
                      <td>
                        <div className="sw-actions">
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm sw-btn-primary"
                            onClick={() => handleFineTuneVersion(d)}
                          >
                            Fine-tune
                          </button>
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            onClick={() => setSelectedDatasetId(d.id)}
                          >
                            Xem chi tiết
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {filteredDatasets.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: 30 }}>
                      <p className="sw-empty">
                        Chưa có Dataset Version nào phù hợp. Tạo version đầu tiên từ dữ liệu nguồn và Gold labels đã được duyệt.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB 2: RECIPES */}
      {activeSub === "recipes" && (
        <div className="sw-recipes-section">
          {/* Recipe Builder Modal / Form */}
          {buildingRecipe && (
            <form
              className="sw-card sw-builder"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await createStudioRecipe(recipeForm, authorization);
                  setBuildingRecipe(false);
                });
              }}
            >
              <header className="sw-card-header">
                <div>
                  <span className="sw-eyebrow">TẠO TẬP TÙY CHỌN</span>
                  <h2>Chọn dữ liệu model sẽ học</h2>
                </div>
                <button
                  type="button"
                  className="sw-icon-btn"
                  onClick={() => setBuildingRecipe(false)}
                  aria-label="Đóng tạo tập"
                >
                  ×
                </button>
              </header>

              <div className="sw-builder-grid">
                <div className="sw-form">
                  <label>
                    Tên tập dữ liệu
                    <input
                      required
                      className="sw-input"
                      value={recipeForm.name}
                      onChange={(e) => setRecipeForm({ ...recipeForm, name: e.target.value })}
                      placeholder="Ví dụ: INSTANCE + BHSD + nhãn tháng 9"
                    />
                  </label>

                  <fieldset>
                    <legend>1. Chọn nguồn</legend>
                    {sources.map((s) => (
                      <label
                        className={`sw-source-choice ${!s.available ? "unavailable" : ""}`}
                        key={s.id}
                      >
                        <input
                          type="checkbox"
                          checked={recipeForm.source_ids.includes(s.id)}
                          disabled={!s.available}
                          onChange={() => toggleRecipeSource(s.id)}
                        />
                        <span>
                          <b>{s.name}</b>
                          <small>
                            {s.available
                              ? `${s.num_cases} study · ${s.role === "benchmark" ? "chỉ dùng đánh giá" : "dữ liệu huấn luyện"}`
                              : "Chưa có dữ liệu local · cần nhập nguồn"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <fieldset>
                    <legend>2. Bổ sung từ labeling</legend>
                    <label className="sw-source-choice">
                      <input
                        type="checkbox"
                        checked={recipeForm.include_pool}
                        onChange={(e) => setRecipeForm({ ...recipeForm, include_pool: e.target.checked })}
                      />
                      <span>
                        <b>Tự lấy nhãn mới đã duyệt</b>
                        <small>{pool.approved} study đủ điều kiện. Nhãn nháp và study thuộc benchmark được loại khỏi train.</small>
                      </span>
                    </label>
                  </fieldset>

                  <details>
                    <summary>Tùy chọn lấy mẫu & chia tập</summary>
                    <div className="sw-fields" style={{ marginTop: 10 }}>
                      <label>
                        Validation (%)
                        <input
                          type="number"
                          className="sw-input"
                          min="10"
                          max="40"
                          value={recipeForm.validation_percent}
                          onChange={(e) => setRecipeForm({ ...recipeForm, validation_percent: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        Giới hạn study mỗi nguồn
                        <input
                          type="number"
                          className="sw-input"
                          min="0"
                          value={recipeForm.max_cases_per_source}
                          onChange={(e) => setRecipeForm({ ...recipeForm, max_cases_per_source: Number(e.target.value) })}
                        />
                        <small>0 = toàn bộ · benchmark luôn giữ nguyên</small>
                      </label>
                    </div>
                  </details>
                </div>

                {/* Preview Box with .sw-preview */}
                <aside className="sw-preview">
                  <span className="sw-eyebrow">3. XEM TRƯỚC</span>
                  <h3>{previewLoading ? "Đang tính…" : `${recipePreview?.num_cases || 0} study được chọn`}</h3>
                  <div className="sw-splits">
                    <div className="train">
                      <i />
                      <span>Huấn luyện</span>
                      <b>{recipePreview?.splits?.train || 0}</b>
                    </div>
                    <div className="validation">
                      <i />
                      <span>Validation</span>
                      <b>{recipePreview?.splits?.validation || 0}</b>
                    </div>
                    <div className="test">
                      <i />
                      <span>Benchmark / test</span>
                      <b>{recipePreview?.splits?.test || 0}</b>
                    </div>
                  </div>
                  <p>Chia theo study/bệnh nhân trước khi tách lát. Cùng một tập tùy chọn sẽ giữ cách chia ở các lần chạy sau.</p>
                  {recipePreview?.excluded > 0 && (
                    <small>{recipePreview.excluded} bản trùng hoặc thuộc benchmark được loại.</small>
                  )}
                  <button
                    className="sw-btn sw-btn-primary"
                    disabled={busy || previewLoading || !recipePreview?.num_cases}
                  >
                    Lưu tập tùy chọn
                  </button>
                </aside>
              </div>
            </form>
          )}

          {/* Recipes List */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {recipes.map((recipe) => (
              <article className="sw-card sw-recipe" key={recipe.id}>
                <header className="sw-card-header">
                  <div>
                    <h2>{recipe.name}</h2>
                    <p>
                      {recipe.source_ids.map((id) => sources.find((s) => s.id === id)?.name || id).join(" + ")}
                      {recipe.include_pool ? " + nhãn đã duyệt" : ""}
                    </p>
                  </div>
                  <StatusBadge
                    status={recipe.preview?.ready ? "ready" : "draft"}
                    label={recipe.preview?.ready ? "Có thể tạo phiên bản" : "Thiếu dữ liệu"}
                  />
                </header>
                <div className="sw-splits">
                  <div className="train">
                    <i />
                    <span>Huấn luyện</span>
                    <b>{recipe.preview?.splits?.train || 0}</b>
                  </div>
                  <div className="validation">
                    <i />
                    <span>Validation</span>
                    <b>{recipe.preview?.splits?.validation || 0}</b>
                  </div>
                  <div className="test">
                    <i />
                    <span>Benchmark / test</span>
                    <b>{recipe.preview?.splits?.test || 0}</b>
                  </div>
                </div>
                <footer>
                  <span>
                    Pool {recipe.include_pool ? "tự cập nhật" : "không dùng"} · validation {recipe.validation_percent}% · chia theo bệnh nhân
                  </span>
                  <div className="sw-actions">
                    <button
                      type="button"
                      className="sw-btn"
                      disabled={busy || !recipe.preview?.ready}
                      onClick={() => run(() => freezeStudioRecipe(recipe.id, authorization))}
                    >
                      Tạo phiên bản cố định
                    </button>
                    <button
                      type="button"
                      className="sw-btn sw-btn-primary"
                      onClick={() => {
                        sessionStorage.setItem("brainhem.studio-recipe", recipe.id);
                        openTab("fine_tune");
                      }}
                    >
                      Dùng để huấn luyện
                    </button>
                  </div>
                </footer>
              </article>
            ))}

            {recipes.length === 0 && !buildingRecipe && (
              <p className="sw-empty">Chưa có tập tùy chọn. Hãy tạo tập đầu tiên từ nguồn và nhãn đã duyệt.</p>
            )}
          </div>
        </div>
      )}

      {/* SUB 3: SOURCES */}
      {activeSub === "sources" && (
        <div className="sw-sources-section">
          <div className="sw-section-head" style={{ marginBottom: 14 }}>
            <div>
              <h2>Thư viện dataset gốc</h2>
              <p>Chỉ số bên dưới là dữ liệu thực sự có trên máy, không phải quy mô toàn bộ bộ công bố.</p>
            </div>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={() => setUploading(!uploading)}
            >
              + Nhập dataset ZIP
            </button>
          </div>

          {/* Upload Form */}
          {uploading && (
            <form
              className="sw-card sw-form"
              style={{ marginBottom: 16 }}
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await importStudioSource(uploadFile, uploadName, uploadRole, authorization);
                  setUploading(false);
                });
              }}
            >
              <h2>Nhập dataset nguồn</h2>
              <p>
                Mỗi study một cặp NIfTI ảnh + mask nhị phân. ZIP gồm imagesTr/*_0000.nii.gz và labelsTr/*.nii.gz.
              </p>
              <div className="sw-fields">
                <label>
                  Tên nguồn
                  <input
                    required
                    className="sw-input"
                    value={uploadName}
                    onChange={(e) => setUploadName(e.target.value)}
                    placeholder="Ví dụ: INSTANCE 2022"
                  />
                </label>
                <label>
                  Vai trò
                  <select
                    className="sw-select"
                    value={uploadRole}
                    onChange={(e) => setUploadRole(e.target.value)}
                  >
                    <option value="development">Dùng để huấn luyện / validation</option>
                    <option value="benchmark">Benchmark riêng · không đưa vào train</option>
                  </select>
                </label>
              </div>
              <label>
                Dataset ZIP
                <input
                  type="file"
                  required
                  accept=".zip"
                  onChange={(e) => setUploadFile(e.target.files[0])}
                />
              </label>
              <div className="sw-actions">
                <button className="sw-btn sw-btn-primary" disabled={busy || !uploadFile}>
                  {busy ? "Đang nhập…" : "Nhập dataset"}
                </button>
                <button type="button" className="sw-btn" onClick={() => setUploading(false)}>
                  Hủy
                </button>
              </div>
            </form>
          )}

          {/* Sources Table */}
          <div className="sw-table-wrap">
            <table className="sw-table">
              <thead>
                <tr>
                  <th>Nguồn</th>
                  <th>Study local</th>
                  <th>Vai trò</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      <small>
                        {s.expected_cases ? `${s.expected_cases} study trong manifest tham chiếu` : "Nguồn đã nhập"}
                      </small>
                    </td>
                    <td>{s.num_cases}</td>
                    <td>{s.role === "benchmark" ? "Benchmark riêng" : "Huấn luyện / validation"}</td>
                    <td>
                      <StatusBadge
                        status={s.available ? (s.expected_cases && s.num_cases < s.expected_cases ? "configured_unverified" : "ready") : "unavailable"}
                        label={s.available ? (s.expected_cases && s.num_cases < s.expected_cases ? "Có một phần" : "Sẵn sàng") : "Cần nhập dữ liệu"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB 4: POOL */}
      {activeSub === "pool" && (
        <div className="sw-pool-section">
          <div className="sw-stat-row" style={{ marginBottom: 16 }}>
            <div className="sw-stat">
              <span>Tổng study labeling</span>
              <strong>{pool.total}</strong>
            </div>
            <div className="sw-stat">
              <span>Được đưa vào train</span>
              <strong style={{ color: "var(--sw-success)" }}>{pool.approved}</strong>
              <small>Revision hiện tại đã duyệt</small>
            </div>
            <div className="sw-stat">
              <span>Cần gán nhãn / rà soát</span>
              <strong>{pool.pending}</strong>
            </div>
            <div className="sw-stat">
              <span>Giữ riêng benchmark</span>
              <strong>{pool.benchmark_excluded}</strong>
              <small>Không đưa vào train</small>
            </div>
          </div>

          <article className="sw-card">
            <h2>Quy trình: Vẽ nhãn → Duyệt volume → Vào pool</h2>
            <p>
              Hệ thống lấy revision hiện tại sau khi bác sĩ đã duyệt toàn bộ volume. Nhãn sửa lại thành nháp sẽ chờ duyệt lại. Study trùng benchmark luôn được giữ riêng.
            </p>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              style={{ marginTop: 14 }}
              onClick={() => onNavigate?.("clinical")}
            >
              Mở dữ liệu & gán nhãn
            </button>
          </article>
        </div>
      )}
    </div>
  );
}
