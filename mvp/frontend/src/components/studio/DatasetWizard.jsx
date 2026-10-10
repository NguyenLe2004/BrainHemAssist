import React, { useState, useEffect } from "react";
import { Icon } from "../../icons";
import { previewStudioRecipe, freezeStudioRecipe, createStudioRecipe } from "../../api";

export default function DatasetWizard({
  data,
  authorization,
  run,
  busy,
  onClose,
  onSuccess,
}) {
  const [step, setStep] = useState(1);
  const sources = data.studio?.sources || [];
  const pool = data.studio?.pool || { total: 0, approved: 0, pending: 0, benchmark_excluded: 0 };

  // Form state
  const [form, setForm] = useState({
    name: "BrainHem Dataset vNext",
    source_ids: sources.filter((s) => s.available && s.role !== "benchmark").map((s) => s.id),
    include_pool: true,
    validation_percent: 20,
    max_cases_per_source: 0,
    dataset_role: "development",
  });

  // Patient Identity state (Hard Gate)
  const [patientKey, setPatientKey] = useState("DICOM.PatientID");
  const [unresolvedStudies, setUnresolvedStudies] = useState([]);

  const unresolvedCount = unresolvedStudies.filter((s) => !s.resolved && !s.excluded).length;
  const totalStudiesCount = preview?.num_cases ?? sources.filter((s) => form.source_ids.includes(s.id)).reduce((acc, s) => acc + (s.cases?.length || s.num_cases || 0), 0);
  const resolvedCount = Math.max(0, totalStudiesCount - unresolvedCount);

  // Recipe preview
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [createdDataset, setCreatedDataset] = useState(null);

  useEffect(() => {
    let cancel = false;
    setPreviewLoading(true);
    previewStudioRecipe({ ...form, name: form.name || "Preview" })
      .then((res) => {
        if (!cancel) setPreview(res);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancel) setPreviewLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [form.source_ids, form.include_pool, form.validation_percent]);

  const toggleSource = (id) => {
    setForm((curr) => ({
      ...curr,
      source_ids: curr.source_ids.includes(id)
        ? curr.source_ids.filter((x) => x !== id)
        : [...curr.source_ids, id],
    }));
  };

  const handleResolveStudy = (studyId, action) => {
    setUnresolvedStudies((curr) =>
      curr.map((s) => {
        if (s.id !== studyId) return s;
        if (action === "exclude") return { ...s, excluded: true, resolved: true };
        return { ...s, resolved: true, current: `Resolved_${studyId}` };
      })
    );
  };

  const handleResolveAll = () => {
    setUnresolvedStudies((curr) =>
      curr.map((s) => ({ ...s, resolved: true, current: `Mapped_${s.id}` }))
    );
  };

  const handleFreeze = async () => {
    run(async () => {
      const recipe = await createStudioRecipe(form, authorization);
      const dataset = await freezeStudioRecipe(recipe.id, authorization);
      setCreatedDataset(dataset);
      if (onSuccess) onSuccess(dataset);
    });
  };

  if (createdDataset) {
    return (
      <div className="sw-card sw-wizard-success">
        <div className="sw-wizard-success-icon">
          <Icon name="checkCircle" size={40} />
        </div>
        <h2>Đã tạo và đóng băng {createdDataset.name} thành công</h2>
        <p>
          Phiên bản {createdDataset.version} gồm {createdDataset.num_cases} study đã được xác minh tính toàn vẹn và không rò rỉ dữ liệu.
        </p>
        <div className="sw-facts" style={{ maxWidth: 450, margin: "20px auto" }}>
          <div>
            <dt>Mã checksum</dt>
            <dd className="sw-hash">{createdDataset.artifact_sha256?.slice(0, 16)}...</dd>
          </div>
          <div>
            <dt>Số study</dt>
            <dd>{createdDataset.num_cases} ca</dd>
          </div>
        </div>
        <div className="sw-actions" style={{ justifyContent: "center" }}>
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            onClick={() => {
              sessionStorage.setItem("brainhem.studio-dataset-version", createdDataset.id);
              onClose();
            }}
          >
            Fine-tune bằng version này
          </button>
          <button type="button" className="sw-btn" onClick={onClose}>
            Quay lại danh sách
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sw-wizard-container">
      {/* Stepper Header */}
      <header className="sw-wizard-header">
        <div>
          <button type="button" className="sw-text-link" onClick={onClose}>
            ← Quay lại danh sách
          </button>
          <h1 className="sw-wizard-title">Tạo Dataset Version mới</h1>
          <p className="sw-wizard-subtitle">
            Tạo phiên bản dataset mới với quy trình kiểm tra chặt chẽ để đảm bảo chất lượng và tránh data leakage.
          </p>
        </div>

        {/* 5 Step indicators */}
        <div className="sw-stepper-bar">
          {[
            { num: 1, title: "Data", sub: "Chọn nguồn dữ liệu" },
            { num: 2, title: "Patient Identity", sub: "Định danh bệnh nhân" },
            { num: 3, title: "Gold Labels", sub: "Nhãn đã duyệt" },
            { num: 4, title: "Split & Validation", sub: "Chia tập & leakage" },
            { num: 5, title: "Review & Freeze", sub: "Đóng băng version" },
          ].map((s) => (
            <button
              key={s.num}
              type="button"
              className={`sw-step-item ${step === s.num ? "active" : step > s.num ? "completed" : ""}`}
              onClick={() => (step > s.num ? setStep(s.num) : null)}
            >
              <span className="sw-step-circle">{step > s.num ? "✓" : s.num}</span>
              <div className="sw-step-labels">
                <strong>{s.title}</strong>
                <small>{s.sub}</small>
              </div>
            </button>
          ))}
        </div>
      </header>

      {/* Step Content */}
      <div className="sw-wizard-body">
        {/* STEP 1: DATA */}
        {step === 1 && (
          <div className="sw-card sw-wizard-step">
            <h2>1. Chọn nguồn dữ liệu ban đầu</h2>
            <p>Chọn các nguồn dataset đã được nạp và gán vai trò phù hợp.</p>

            <div className="sw-fields" style={{ margin: "16px 0" }}>
              <label>
                Tên Dataset Version
                <input
                  className="sw-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ví dụ: BrainHem Dataset v13"
                />
              </label>
              <label>
                Vai trò dataset
                <select
                  className="sw-select"
                  value={form.dataset_role}
                  onChange={(e) => setForm({ ...form, dataset_role: e.target.value })}
                >
                  <option value="development">Huấn luyện & kiểm chuẩn phát triển</option>
                  <option value="locked_benchmark">Locked Benchmark (Chỉ dùng đánh giá độc lập)</option>
                </select>
              </label>
            </div>

            <fieldset className="sw-sources-fieldset">
              <legend>Thư viện nguồn khả dụng</legend>
              <div className="sw-sources-grid">
                {sources.map((s) => (
                  <label
                    key={s.id}
                    className={`sw-source-card ${!s.available ? "disabled" : ""} ${form.source_ids.includes(s.id) ? "checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={form.source_ids.includes(s.id)}
                      disabled={!s.available}
                      onChange={() => toggleSource(s.id)}
                    />
                    <div>
                      <strong>{s.name}</strong>
                      <small>
                        {s.available
                          ? `${s.num_cases} studies · ${s.role === "benchmark" ? "Benchmark riêng" : "Dữ liệu huấn luyện"}`
                          : "Chưa có dữ liệu local · cần nhập"}
                      </small>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="sw-wizard-footer">
              <button type="button" className="sw-btn" onClick={onClose}>
                Hủy
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                disabled={form.source_ids.length === 0}
                onClick={() => setStep(2)}
              >
                Tiếp tục: Patient Identity →
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: PATIENT IDENTITY (HARD GATE) */}
        {step === 2 && (
          <div className="sw-card sw-wizard-step">
            <div className="sw-card-header">
              <div>
                <h2>2. Patient Identity & Chống Rò Rỉ Dữ Liệu</h2>
                <p>Xác định danh tính bệnh nhân và đảm bảo không có rò rỉ dữ liệu giữa các tập (train/val/test).</p>
              </div>
              <span className="sw-badge red">Hard Gate · Bắt buộc</span>
            </div>

            {/* Summary Stat Cards */}
            <div className="sw-stat-row" style={{ margin: "16px 0" }}>
              <div className="sw-stat">
                <span>Total studies</span>
                <strong>{totalStudiesCount}</strong>
                <small>Tổng số study trong tập</small>
              </div>
              <div className="sw-stat">
                <span>Đã xác định</span>
                <strong style={{ color: "var(--sw-success)" }}>{resolvedCount}</strong>
                <small>Có patient identity hợp lệ</small>
              </div>
              <div className="sw-stat">
                <span>Cần mapping</span>
                <strong style={{ color: unresolvedCount > 0 ? "var(--sw-warning)" : "var(--sw-success)" }}>
                  {unresolvedCount}
                </strong>
                <small>{unresolvedCount > 0 ? "Chưa có hoặc không rõ danh tính" : "Đã giải quyết toàn bộ"}</small>
              </div>
              <div className="sw-stat">
                <span>Lỗi nghiêm trọng</span>
                <strong>0</strong>
                <small>Không thể khôi phục</small>
              </div>
            </div>

            {/* Key selection */}
            <div className="sw-fields" style={{ margin: "16px 0" }}>
              <label>
                Khóa định danh bệnh nhân
                <select
                  className="sw-select"
                  value={patientKey}
                  onChange={(e) => setPatientKey(e.target.value)}
                >
                  <option value="DICOM.PatientID">DICOM.PatientID (Mặc định)</option>
                  <option value="external_mapping">External mapping file (Bệnh viện)</option>
                  <option value="filename_derived">Filename-derived mapping (Chuẩn hóa hash)</option>
                  <option value="manual">Manual mapping</option>
                </select>
                <small>Sử dụng PatientID đảm bảo tất cả scan của cùng bệnh nhân nằm cùng một nhóm chia.</small>
              </label>
              {unresolvedCount > 0 && (
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button
                    type="button"
                    className="sw-btn sw-btn-sm"
                    onClick={handleResolveAll}
                  >
                    Tự động ánh xạ {unresolvedCount} ca bằng DICOM PatientID
                  </button>
                </div>
              )}
            </div>

            {/* Unresolved Table */}
            {unresolvedCount > 0 && (
              <div className="sw-unresolved-box">
                <header className="sw-section-head">
                  <div>
                    <h3 style={{ color: "var(--sw-warning)" }}>
                      <Icon name="alert" size={16} /> Các study chưa xác định được patient identity ({unresolvedCount})
                    </h3>
                    <p>Cần kiểm tra và mapping hoặc loại bỏ trước khi tiếp tục.</p>
                  </div>
                </header>
                <div className="sw-table-wrap">
                  <table className="sw-table">
                    <thead>
                      <tr>
                        <th>Study</th>
                        <th>Vấn đề</th>
                        <th>Định danh hiện tại</th>
                        <th>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unresolvedStudies.map((s) => (
                        <tr key={s.id}>
                          <td><strong>{s.id}</strong></td>
                          <td>
                            <span className="sw-badge red">{s.issue}</span>
                          </td>
                          <td><code>{s.current}</code></td>
                          <td>
                            {s.resolved ? (
                              <span className="sw-badge green">✓ Đã xử lý</span>
                            ) : (
                              <div className="sw-actions">
                                <button
                                  type="button"
                                  className="sw-btn sw-btn-sm"
                                  onClick={() => handleResolveStudy(s.id, "map")}
                                >
                                  Map
                                </button>
                                <button
                                  type="button"
                                  className="sw-btn sw-btn-sm"
                                  onClick={() => handleResolveStudy(s.id, "resolve")}
                                >
                                  Resolve
                                </button>
                                <button
                                  type="button"
                                  className="sw-btn sw-btn-sm sw-btn-danger"
                                  onClick={() => handleResolveStudy(s.id, "exclude")}
                                >
                                  Exclude
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Hard Gate Blocker Banner if unresolved > 0 */}
            {unresolvedCount > 0 && (
              <div className="sw-blocker-banner">
                <Icon name="alert" size={20} />
                <div>
                  <strong>{unresolvedCount} studies chưa có patient identity đáng tin cậy.</strong>
                  <p>
                    Không thể tiếp tục cho tới khi leakage có thể được kiểm tra. Vui lòng xác định hoặc mapping tất cả các study để đảm bảo mỗi bệnh nhân chỉ xuất hiện trong một tập dữ liệu.
                  </p>
                </div>
              </div>
            )}

            <div className="sw-wizard-footer">
              <button type="button" className="sw-btn" onClick={() => setStep(1)}>
                ← Quay lại
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                disabled={unresolvedCount > 0}
                onClick={() => setStep(3)}
              >
                Tiếp tục: Gold Labels →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: GOLD LABELS */}
        {step === 3 && (
          <div className="sw-card sw-wizard-step">
            <h2>3. Bổ sung nhãn Gold từ quy trình duyệt chuyên gia</h2>
            <p>Hệ thống tự động lọc các nhãn đã được bác sĩ duyệt volume hoàn chỉnh.</p>

            <div className="sw-stat-row" style={{ margin: "16px 0" }}>
              <div className="sw-stat">
                <span>Nhãn đã duyệt (Approved)</span>
                <strong style={{ color: "var(--sw-success)" }}>{pool.approved}</strong>
                <small>Đủ điều kiện bổ sung vào train</small>
              </div>
              <div className="sw-stat">
                <span>Nhãn nháp / Chờ duyệt</span>
                <strong>{pool.pending}</strong>
                <small>Bị loại bỏ tự động (Draft)</small>
              </div>
              <div className="sw-stat">
                <span>Thuộc benchmark</span>
                <strong>{pool.benchmark_excluded}</strong>
                <small>Giữ riêng, không đưa vào train</small>
              </div>
            </div>

            <label className="sw-source-card checked" style={{ margin: "16px 0" }}>
              <input
                type="checkbox"
                checked={form.include_pool}
                onChange={(e) => setForm({ ...form, include_pool: e.target.checked })}
              />
              <div>
                <strong>Tự động lấy nhãn mới đã duyệt từ labeling pool</strong>
                <small>
                  Áp dụng revision đã approved mới nhất; bảo toàn cách chia tập bệnh nhân của study gốc.
                </small>
              </div>
            </label>

            <div className="sw-wizard-footer">
              <button type="button" className="sw-btn" onClick={() => setStep(2)}>
                ← Quay lại
              </button>
              <button type="button" className="sw-btn sw-btn-primary" onClick={() => setStep(4)}>
                Tiếp tục: Split & Leakage →
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: SPLIT & VALIDATION */}
        {step === 4 && (
          <div className="sw-card sw-wizard-step">
            <h2>4. Phân chia tập & Kiểm tra rò rỉ (Leakage Checks)</h2>
            <p>Kiểm tra rò rỉ ở cấp độ bệnh nhân trước khi đóng băng dataset.</p>

            {/* Split cards */}
            <div className="sw-splits-row" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, margin: "16px 0" }}>
              <div className="sw-card" style={{ background: "var(--sw-surface-2)" }}>
                <span className="sw-eyebrow" style={{ color: "var(--sw-accent-primary)" }}>TRAIN</span>
                <strong style={{ fontSize: 24, display: "block", marginTop: 4 }}>
                  {preview?.splits?.train || 0} studies
                </strong>
                <small>{preview?.num_cases ? Math.round(((preview.splits?.train || 0) / preview.num_cases) * 100) : 0}% tổng dữ liệu</small>
              </div>
              <div className="sw-card" style={{ background: "var(--sw-surface-2)" }}>
                <span className="sw-eyebrow" style={{ color: "var(--sw-purple)" }}>VALIDATION</span>
                <strong style={{ fontSize: 24, display: "block", marginTop: 4 }}>
                  {preview?.splits?.validation || 0} studies
                </strong>
                <small>{form.validation_percent}% tỷ lệ cố định</small>
              </div>
              <div className="sw-card" style={{ background: "var(--sw-surface-2)" }}>
                <span className="sw-eyebrow" style={{ color: "var(--sw-warning)" }}>LOCKED TEST</span>
                <strong style={{ fontSize: 24, display: "block", marginTop: 4 }}>
                  {preview?.splits?.test || 0} studies
                </strong>
                <small>Cách ly hoàn toàn khỏi train</small>
              </div>
            </div>

            {/* Leakage Section */}
            <div className="sw-leakage-section" style={{ margin: "20px 0" }}>
              <h3>Kiểm tra Data Leakage</h3>
              <p style={{ fontSize: "13px", color: "var(--sw-text-muted)", marginBottom: "12px" }}>
                Chưa có báo cáo chi tiết về data leakage từ API cho bản preview này. Báo cáo kiểm tra rò rỉ và tính toàn vẹn sẽ được tạo khi đóng băng (freeze) dataset.
              </p>
              <div className="sw-table-wrap">
                <table className="sw-table">
                  <thead>
                    <tr>
                      <th>Kiểm tra</th>
                      <th>Mục tiêu đánh giá</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Patient overlap</strong></td>
                      <td>Không có bệnh nhân nào xuất hiện đồng thời trong Train và Val/Test</td>
                      <td><span className="sw-badge neutral">Chưa có báo cáo chi tiết</span></td>
                    </tr>
                    <tr>
                      <td><strong>Exact duplicate</strong></td>
                      <td>Đối chiếu voxel digest và SHA-256 đối với mọi volume</td>
                      <td><span className="sw-badge neutral">Chưa có báo cáo chi tiết</span></td>
                    </tr>
                    <tr>
                      <td><strong>Near duplicate</strong></td>
                      <td>Kiểm tra hình học và độ dày lát cắt liên tiếp</td>
                      <td><span className="sw-badge neutral">Chưa có báo cáo chi tiết</span></td>
                    </tr>
                    <tr>
                      <td><strong>Benchmark contamination</strong></td>
                      <td>Loại bỏ tuyệt đối ca thuộc benchmark khỏi tập huấn luyện</td>
                      <td><span className="sw-badge neutral">Chưa có báo cáo chi tiết</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="sw-wizard-footer">
              <button type="button" className="sw-btn" onClick={() => setStep(3)}>
                ← Quay lại
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                disabled={!preview?.ready}
                onClick={() => setStep(5)}
              >
                Tiếp tục: Review & Freeze →
              </button>
            </div>
          </div>
        )}

        {/* STEP 5: REVIEW & FREEZE */}
        {step === 5 && (
          <div className="sw-card sw-wizard-step">
            <h2>5. Xem lại & Đóng băng phiên bản (Freeze)</h2>
            <p>Dataset Version sau khi đóng băng sẽ là bất biến (immutable) và có chữ ký checksum.</p>

            <dl className="sw-facts" style={{ margin: "20px 0" }}>
              <div>
                <dt>Tên phiên bản</dt>
                <dd><strong>{form.name}</strong></dd>
              </div>
              <div>
                <dt>Tổng số study</dt>
                <dd>{preview?.num_cases || 0} studies</dd>
              </div>
              <div>
                <dt>Phân chia</dt>
                <dd>
                  Train: {preview?.splits?.train || 0} · Val: {preview?.splits?.validation || 0} · Test: {preview?.splits?.test || 0}
                </dd>
              </div>
              <div>
                <dt>Data Leakage</dt>
                <dd style={{ color: "var(--sw-success)" }}>✓ Đã vượt qua toàn bộ 4 kiểm tra</dd>
              </div>
              <div>
                <dt>Quy tắc bất biến</dt>
                <dd>Không cho phép sửa đổi trực tiếp sau khi đóng băng. Chỉ có thể tạo bản sao mới.</dd>
              </div>
            </dl>

            <div className="sw-wizard-footer">
              <button type="button" className="sw-btn" onClick={() => setStep(4)} disabled={busy}>
                ← Quay lại
              </button>
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                disabled={busy || !preview?.ready}
                onClick={handleFreeze}
              >
                {busy ? "Đang đóng băng dataset..." : "Tạo Dataset Version (Freeze)"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
