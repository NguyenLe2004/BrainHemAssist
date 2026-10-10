import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  listAnnotationCases, getAnnotationCase, seedAnnotationFromJob, getAnnotationSourceUrl, getAnnotationThumbnailUrl, runCaseInference, getCapabilities, fetchWithRetry,
  analyzeStudy,
  artifactFile,
  artifactUrl,
  getJob,
  healthCheck,
  listStudies,
  reviewJob,
  createLearningCandidate,
  createAnnotationCase,
  sendSimulatorAcquisition,
} from "./api";
import { trackJob, jobMessage } from "./jobTracking";
import { prepareLabelingCase } from "./labelingHandoff";
import { draftKey, getDraft } from "./draftStore";
import { Icon } from "./icons";
import DicomIntakeDialog from "./components/DicomIntakeDialog";
import { useAppAuth } from "./components/AppAuth";
import { can, navAllowed, ROLE_LABELS } from "./permissions";
import AccountManagement from "./components/AccountManagement";
import ModelReviewPanel from "./components/ModelReviewPanel";


const ClinicalViewer = lazy(() => import("./components/ClinicalViewer"));
const RawAnnotationWorkspace = lazy(() => import("./components/AnnotationWorkspace"));
function AnnotationWorkspace(props){const {account}=useAppAuth();return can(account,"label.edit")?<RawAnnotationWorkspace {...props}/>:<div role="alert" style={{padding:32}}>Tài khoản chỉ có quyền xem ảnh. Hãy mở ca trong trình xem CT.</div>;}

const RawTrainingWorkspace = lazy(() => import("./components/TrainingWorkspace"));
function TrainingWorkspace(props){const {account}=useAppAuth();return can(account,"studio.read")?<RawTrainingWorkspace {...props}/>:<div role="alert" style={{padding:32}}>Tài khoản không có quyền quản lý mô hình.</div>;}


const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const AI_SIZE_META = {
  fast: { size: "Baseline S", title: "", time: "" },
  standard: { size: "M", title: "", time: "" },
  high: { size: "L", title: "", time: "" },
};

function userFacingJobError(value) {
  const message=String(value||"").trim();
  if(!message)return undefined;
  if(message.includes("512x512 source geometry"))return "Kích thước ảnh chưa tương thích với cấu hình AI đã chọn.";
  if(message.includes("Traceback")||message.includes("Inference exited with code"))return "Phân tích AI không hoàn tất. Hãy chạy lại hoặc chọn cấu hình khác.";
  return message.length>240?"Phân tích AI không hoàn tất. Vui lòng chạy lại tác vụ.":message;
}

function normalizedJob(payload) {
  const backendStatus = (payload.status || "queued").toLowerCase();
  return {
    id: payload.id || payload.job_id,
    status: backendStatus === "succeeded" ? "completed" : backendStatus,
    progress: Number(payload.progress ?? payload.progress_percent ?? 0),
    stage: jobMessage(payload),
    error: userFacingJobError(payload.error || payload.detail),
    result: payload.result || payload.results,
    artifacts: payload.artifacts || payload.result?.artifacts || [],
    studyId: payload.study_id || payload.result?.study_id,
    inputType: payload.input_type,
    review: payload.review || {},
    modelVersion: payload.model_version,
    inferenceTier: payload.inference_tier,
    createdAt: payload.created_at,
    completedAt: payload.completed_at,
  };
}

function ConnectionStatus({ state, compact = false }) {
  const labels = {
    online: "Web đã kết nối",
    checking: "Đang kiểm tra",
    offline: "API ngoại tuyến",
  };
  return (
    <span className={`connection ${state}`}>
      <i />
      {!compact && labels[state]}
    </span>
  );
}

function CaseRail({ job, busy, studies, pacsEnabled, pacsLoading, onReset, onStudy, onRefresh, researchCases=[], researchCase, onResearch, onImport, uploadEnabled, onCollapse }) {
  const [caseSearch, setCaseSearch] = useState("");
  const sortedResearchCases = useMemo(() => {
    const rank = { stat: 0, urgent: 1, routine: 2 };
    return researchCases
      .filter(item=>!/^AUDIT_/i.test(String(item.name||"")))
      .filter(item=>item.status === "approved" && hasAiResult(item))
      .sort((left, right) => {
      const priority = (rank[left.priority] ?? 3) - (rank[right.priority] ?? 3);
      if (priority) return priority;
      return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
    });
  }, [researchCases]);

  const aiBadge = (item) => {
    if (item.is_stable === false) return { className: "working", label: "DICOM · Đang tiếp nhận" };
    if (hasAiResult(item)) return { className: "ready", label: "AI · Đã có kết quả" };
    if (["queued", "running", "retry_wait", "service_wait"].includes(item.ai_status)) return { className: "working", label: "AI · Đang phân tích" };
    if (item.ai_status === "failed") return { className: "failed", label: "AI · Xử lý lỗi" };
    return { className: "none", label: "AI · Chưa phân tích" };
  };

  const filteredStudies = useMemo(() => {
    if (!caseSearch.trim()) return studies;
    const q = caseSearch.toLowerCase();
    return studies.filter(
      (s) =>
        (s.patient_name && s.patient_name.toLowerCase().includes(q)) ||
        (s.patient_id && s.patient_id.toLowerCase().includes(q)) ||
        (s.study_description && s.study_description.toLowerCase().includes(q))
    );
  }, [studies, caseSearch]);

  const visibleResearchCases = sortedResearchCases
    .filter(c=>`${c.name} ${c.id} ${c.patient_id || ""} ${c.patient_name || ""}`.toLowerCase().includes(caseSearch.toLowerCase()));

  if (!pacsEnabled) return <aside className="case-rail">
    <div className="rail-heading"><div><span className="section-kicker">Dữ liệu nghiên cứu</span><h2>Thư viện CT</h2></div><div className="rail-heading-actions"><span className="case-count">{sortedResearchCases.length}</span><button type="button" onClick={onCollapse} aria-label="Ẩn Thư viện CT" title="Ẩn Thư viện CT"><Icon name="chevron" size={14}/></button></div></div>
    {uploadEnabled && <div className="source-actions"><button className="import-study" type="button" onClick={onImport}><Icon name="upload" size={15}/> Tiếp nhận ca CT</button></div>}
    <p style={{padding:"0 14px",fontSize:12,color:"#9BB0CC"}}>Kho ảnh chưa được kết nối. Có thể đọc các ca nghiên cứu dưới đây.</p>
    <div className="rail-filter"><Icon name="search" size={16}/><input aria-label="Tìm ca nghiên cứu" placeholder="Tên hoặc mã ca…" value={caseSearch} onChange={e=>setCaseSearch(e.target.value)}/></div>
    <div className="case-list">{visibleResearchCases.map(c=>{const badge=aiBadge(c);return <button key={c.id} className={`case-item ${researchCase?.id===c.id?"active":""} ${c.priority === "stat" ? "has-priority" : ""}`} disabled={busy} onClick={()=>onResearch(c)}>{c.priority === "stat" && <span className="case-priority stat">STAT</span>}<span className="case-copy"><b>{displayName(c.patient_name || c.name)}</b><small>ID: {c.patient_id || c.id.slice(0,10)} · {c.geometry?.shape?.[2] || "—"} lát</small><em className={`ai-case-badge ${badge.className}`}><i/>{badge.label.replace("AI · ","")}</em></span><Icon name="chevron" size={14}/></button>;})}</div>
  </aside>;
  return (
    <aside className="case-rail">
      <div className="rail-heading">
        <div>
          <span className="section-kicker">Worklist</span>
          <h2>Ca đang làm việc</h2>
        </div>
        <div className="rail-heading-actions"><span className="case-count">{pacsEnabled ? filteredStudies.length : "0"}</span><button type="button" onClick={onCollapse} aria-label="Ẩn worklist" title="Ẩn worklist"><Icon name="chevron" size={14}/></button></div>
      </div>
      <div className="source-actions">
        {uploadEnabled && (
          <button className="import-study" type="button" onClick={onImport}>
            <Icon name="upload" size={15} /> Tiếp nhận CT
          </button>
        )}
        {pacsEnabled && (
          <button className="refresh-worklist" type="button" disabled={pacsLoading} onClick={onRefresh}>
            <Icon name="reset" size={15} /> Làm mới
          </button>
        )}
      </div>
      {pacsEnabled && studies.length > 0 && (
        <div className="rail-filter">
          <Icon name="search" size={16} />
          <input
            type="text"
            placeholder="Tìm theo mã hoặc tên ca…"
            value={caseSearch}
            onChange={(e) => setCaseSearch(e.target.value)}
            aria-label="Tìm kiếm study"
          />
        </div>
      )}

      <div className="case-list">
        {pacsEnabled && filteredStudies.length ? (
          filteredStudies.map((study) => {
            const badge = aiBadge(study);
            return (
            <button
              className={`case-item ${job?.studyId === study.orthanc_id ? "active" : ""}`}
              disabled={busy || study.is_stable === false}
              key={study.orthanc_id}
              onClick={() => onStudy(study)}
              type="button"
            >
              <span className="case-copy">
                <b>{study.patient_name || "ANONYMOUS"}</b>
                <small>{study.patient_id || "Không mã BN"} · {study.study_date || "Không ngày"}</small>
                <em className={`ai-case-badge ${badge.className}`}><i />{badge.label}</em>
              </span>
              <Icon name="chevron" size={16} />
            </button>
            );
          })
        ) : (
          <div className="rail-empty">
            <Icon name="inbox" size={27} />
            <p>{pacsEnabled ? (caseSearch ? "Không tìm thấy ca phù hợp" : "Danh sách chưa có ca") : "Kho ảnh chưa được kết nối"}</p>
            <span>
              {pacsLoading
                ? "Đang đồng bộ dữ liệu…"
                : pacsEnabled
                ? caseSearch
                  ? "Thử tìm kiếm với từ khóa khác."
                  : "Đang chờ ca CT mới."
                : "Có thể mở dữ liệu nghiên cứu để đọc ảnh và gán nhãn."}
            </span>
          </div>
        )}
        {sortedResearchCases.length > 0 && (
          <>
            <div className="case-group-label">Dữ liệu nghiên cứu</div>
            {sortedResearchCases.map((item) => {const badge=aiBadge(item);return (
              <button key={item.id} className={`case-item ${researchCase?.id === item.id ? "active" : ""}`} disabled={busy} onClick={() => onResearch(item)}>
                {item.priority === "stat" && <span className="case-priority stat">STAT</span>}
                <span className="case-copy"><b>{displayName(item.patient_name || item.name)}</b><small>{item.patient_id || "Không mã BN"} · {item.study_date || "Ngoài hệ thống"}</small><em className={`ai-case-badge ${badge.className}`}><i/>{badge.label}</em></span>
                <Icon name="chevron" size={16}/>
              </button>
            )})}
          </>
        )}
      </div>

      {job && !busy && (
        <button className="close-case" type="button" onClick={onReset}>
          <Icon name="reset" size={15} />
          Đóng ca hiện tại
        </button>
      )}
    </aside>
  );
}

function UnifiedCaseLibrary({ cases, loading, onOpen, onEdit, onImport, uploadEnabled }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({key:"updated",direction:"desc"});
  const [labelFilter,setLabelFilter] = useState("all");
  const [aiFilter,setAiFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const visible = useMemo(() => sortCases(cases
    .filter(item => !/^AUDIT_/i.test(String(item.name || "")))
    .filter(item => `${item.name || ""} ${item.patient_name || ""} ${item.patient_id || ""} ${item.id || ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(item=>labelFilter==="all"||labelFilter==="approved"&&hasApprovedLabel(item)||labelFilter==="draft"&&item.status!=="approved"&&Number(item.current_revision)>0||labelFilter==="unlabeled"&&!Number(item.current_revision))
    .filter(item=>aiFilter==="all"||hasAiResult(item)===(aiFilter==="ready")),sort.key,sort.direction), [cases, query,sort,labelFilter,aiFilter]);
  const header=(key,title)=><th key={key} aria-sort={sort.key===key?(sort.direction==="asc"?"ascending":"descending"):"none"}><button type="button" onClick={()=>setSort(current=>({key,direction:current.key===key&&current.direction==="asc"?"desc":"asc"}))}>{title}<span aria-hidden="true">{sort.key===key?(sort.direction==="asc"?"↑":"↓"):"↕"}</span></button></th>;
  const counts = useMemo(() => ({
    total: cases.length,
    review: cases.filter(item => item.status !== "approved").length,
    approved: cases.filter(item => item.status === "approved" || item.latest_approved_revision != null).length,
    ai: cases.filter(hasAiResult).length,
  }), [cases]);
  const labelState = item => item.status === "approved" ? `Đã duyệt v${item.latest_approved_revision ?? item.current_revision}` : Number(item.current_revision || 0) > 0 ? `Nháp v${item.current_revision}${item.latest_approved_revision != null ? ` · đã duyệt v${item.latest_approved_revision}` : ""}` : "Chưa gán nhãn";
  const toggleSelected = (id, checked) => setSelectedIds(current => { const next = new Set(current); checked ? next.add(id) : next.delete(id); return next; });
  const toggleVisible = checked => setSelectedIds(current => { const next = new Set(current); visible.forEach(item => checked ? next.add(item.id) : next.delete(item.id)); return next; });
  const formatUpdated = value => { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(date); };
  return <main className="unified-case-library">
    <header className="case-library-head">
      <div><span className="section-kicker">BRAINHEM / RESEARCH</span><h1>Ca CT</h1></div>
      {uploadEnabled && <button className="case-library-import" type="button" onClick={onImport}><Icon name="upload" size={16}/> Tiếp nhận CT</button>}
    </header>
    <section className="case-library-stats" aria-label="Thống kê thư viện ca">
      <div><strong>{counts.total}</strong><span>Tổng ca CT</span></div><div><strong>{counts.review}</strong><span>Cần gán nhãn / rà soát</span></div><div><strong>{counts.approved}</strong><span>Gold labels</span></div><div><strong>{counts.ai}</strong><span>Đã có kết quả AI</span></div>
    </section>
    <div className="case-library-toolbar"><label><Icon name="search" size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm ca, mã bệnh nhân…" aria-label="Tìm study"/></label><select aria-label="Lọc trạng thái nhãn" value={labelFilter} onChange={e=>setLabelFilter(e.target.value)}><option value="all">Tất cả nhãn</option><option value="approved">Đã duyệt</option><option value="draft">Nháp</option><option value="unlabeled">Chưa gán nhãn</option></select><select aria-label="Lọc kết quả AI" value={aiFilter} onChange={e=>setAiFilter(e.target.value)}><option value="all">Tất cả kết quả AI</option><option value="ready">Đã có AI</option><option value="pending">Chưa có AI</option></select><span>{selectedIds.size ? `${selectedIds.size} đã chọn · ` : ""}{visible.length} ca</span></div>
    <div className="case-library-table-wrap"><table className="case-library-table"><thead><tr><th className="case-select"><input type="checkbox" aria-label="Chọn tất cả study đang hiển thị" checked={visible.length > 0 && visible.every(item => selectedIds.has(item.id))} onChange={event => toggleVisible(event.target.checked)}/></th>{header("id","ID")}{header("updated","Cập nhật")}<th>Ảnh</th>{header("name","Ca CT")}{header("volume","Thể tích (mL)")}{header("voxels","Voxel nhãn")}{header("components","Ổ 3D")}{header("slices","Lát nhãn")}{header("reviewer","Người gán")}{header("status","Gán nhãn")}{header("ai","AI")}<th className="case-table-actions">Thao tác</th></tr></thead><tbody>
      {visible.map(item => <tr key={item.id} className={selectedIds.has(item.id) ? "selected" : ""} onClick={() => onOpen(item)} tabIndex={0} onKeyDown={event => { if (event.key === "Enter") onOpen(item); }}>
        <td className="case-select" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Chọn ${displayName(item.patient_name || item.name)}`} checked={selectedIds.has(item.id)} onChange={event => toggleSelected(item.id, event.target.checked)}/></td>
        <td><strong className="case-table-id">{item.patient_id || displayName(item.name).match(/\d+\s*$/)?.[0] || item.id.slice(0,8)}</strong><small title={item.id}>{item.id.slice(0, 8)}</small></td><td><time>{formatUpdated(item.updated_at || item.study_date)}</time></td>
        <td><img className="case-table-thumbnail" src={getAnnotationThumbnailUrl(item.id)} alt="Lát axial CT xem trước" loading="lazy"/></td>
        <td><strong>{displayName(item.patient_name || item.name) || "Ca ẩn danh"}</strong><small>{item.patient_id || "—"} · {item.geometry?.shape?.[2] || "—"} lát</small><small>{item.study_description || "Non-contrast CT"}</small><small>{item.study_date || "—"} · {item.geometry?.zooms?.slice(0,3).map(value => Number(value).toFixed(1)).join("×") || "—"} mm</small></td>
        <td><strong className="case-table-metric">{Number(item.current_revision || 0) > 0 && item.label_volume_ml != null ? Number(item.label_volume_ml).toLocaleString("vi-VN", { maximumFractionDigits:2 }) : "—"}</strong></td>
        <td><strong className="case-table-metric">{Number(item.current_revision || 0) > 0 ? Number(item.label_voxel_count || 0).toLocaleString("vi-VN") : "—"}</strong></td>
        <td><strong className="case-table-metric">{Number(item.current_revision || 0) > 0 ? Number(item.label_component_count || 0).toLocaleString("vi-VN") : "—"}</strong></td>
        <td><strong className="case-table-metric">{Number(item.current_revision || 0) > 0 ? `${Number(item.labeled_slice_count || 0).toLocaleString("vi-VN")}/${item.geometry?.shape?.[2] || "—"}` : "—"}</strong></td>
        <td><span className="case-table-reviewer" title={item.annotated_by || ""}>{Number(item.current_revision || 0) > 0 ? item.annotated_by || "—" : "—"}</span></td>
        <td><span className={`case-library-state ${item.status === "approved" ? "approved" : "pending"}`}>{labelState(item)}</span></td><td>{hasAiResult(item) ? <span className="case-library-ai" title={item.ai_model_version || ""}>{item.ai_status === "archived" ? "Đã lưu" : "Sẵn sàng"}</span> : <span className="case-library-none">Chưa có</span>}</td>
        <td className="case-table-actions" onClick={event => event.stopPropagation()}><button className="case-table-label-button" type="button" disabled={!onEdit} onClick={() => onEdit?.(item)} title="Mở công cụ gán nhãn study"><Icon name="brush" size={15}/> Gán nhãn</button></td>
      </tr>)}
      {!visible.length && <tr><td colSpan="13" className="case-library-empty">{loading ? "Đang tải dữ liệu…" : "Không có study phù hợp."}</td></tr>}
    </tbody></table></div>
  </main>;
}

function Viewport({ file, job, progress, onLocationChange, onCaseStep, researchMode, researchCase, studyMeta, error, onRetry, onEdit, labelingBusy }) {
  const artifacts = Array.isArray(job?.artifacts)
    ? job.artifacts
    : Object.entries(job?.artifacts || {}).map(([kind, url]) => ({ kind, url }));
  const maskArtifact = artifacts.find((artifact) =>
    ["mask", "nifti_mask", "segmentation"].includes(
      String(artifact.kind || artifact.name || "").toLowerCase(),
    ),
  );
  const maskUrl =
    job?.status === "completed"
      ? artifactUrl(job.id, maskArtifact || "mask")
      : researchCase?.ai_mask_url || undefined;
  const probabilityArtifact = artifacts.find((artifact) =>
    ["probability", "probability_map", "confidence_map"].includes(
      String(artifact.kind || artifact.name || "").toLowerCase(),
    ),
  );
  const probabilityUrl = job?.status === "completed" && probabilityArtifact
    ? artifactUrl(job.id, probabilityArtifact)
    : undefined;
  const volumeMl =
    job?.result?.hemorrhage_volume_ml ?? job?.result?.volume_ml ?? researchCase?.ai_volume_ml;
  const processing = Boolean(job && !TERMINAL.has(job.status));

  if (researchMode && !file && error) return (
    <section className="viewer source-load-failure" role="alert" aria-live="assertive">
      <div>
        <Icon name="alert" size={40}/>
        <h2>Không mở được ảnh CT gốc</h2>
        <p>{error}</p>
        <strong>Không được xem hoặc xác nhận kết quả AI khi ảnh nguồn chưa tải thành công.</strong>
        <button type="button" onClick={onRetry}>Thử tải lại ảnh gốc</button>
      </div>
    </section>
  );
  if(researchMode && !file)return <section className="viewer" style={{display:"grid",placeItems:"center",textAlign:"center",padding:24}}><div><Icon name="scan" size={40}/><h2>Chọn ca CT để bắt đầu đọc</h2><p>Dùng thư viện nghiên cứu bên trái. Kho ảnh bệnh viện chưa kết nối.</p></div></section>;
  return (
    <section className="viewer">
      {error && file && <p className="inline-error" role="alert">{error}</p>}
      <div className="viewport-canvas">
        <Suspense fallback={<div className="viewer-module-loading">Đang khởi tạo CT viewer…</div>}>
          <ClinicalViewer
            file={file}
            sourceLabel={researchMode?"CT · Dữ liệu nghiên cứu · Radiological":"CT · Nguồn hệ thống · Radiological"}
            studyMeta={studyMeta}
            modelLabel={AI_SIZE_META[job?.inferenceTier || job?.inference_tier || researchCase?.ai_tier]?.size || "AI"}
            maskUrl={maskUrl}
            probabilityUrl={probabilityUrl}
            operatingThreshold={job?.result?.inference?.threshold ?? 0.5}
            volumeMl={volumeMl}
            processing={processing}
            processingLabel={job?.stage}
            processingProgress={progress}
            onLocationChange={onLocationChange}
            onCaseStep={onCaseStep}
            onEdit={onEdit}
            labelingBusy={labelingBusy}
          />
        </Suspense>
      </div>
    </section>
  );
}

function FindingsPanel({
  file,
  job,
  busy,
  progress,
  error,
  onReview, researchMode, researchCase, onPredict, aiAvailable,
  aiTier, onAiTier, aiTiers, aiTta, onAiTta,
  onEdit, reviewBusy, onClose,
}) {
  const {account,authorization}=useAppAuth();
  const [learningOpen,setLearningOpen]=useState(false);
  const [learningAssessment,setLearningAssessment]=useState("incorrect");
  const [learningReasons,setLearningReasons]=useState(new Set(["incorrect_segmentation"]));
  const [learningPriority,setLearningPriority]=useState("high");
  const [learningNote,setLearningNote]=useState("");
  const [learningState,setLearningState]=useState("");
  const [reviewDialog,setReviewDialog]=useState(null);
  const [reviewNote,setReviewNote]=useState("");
  const [reviewError,setReviewError]=useState("");
  const result = job?.result || {};
  const inference = result.inference || {};
  const timings = inference.timings_seconds || {};
  const volume = result.hemorrhage_volume_ml ?? result.volume_ml;
  const confidence = result.confidence ?? result.probability ?? result.ich_probability ?? inference.confidence;
  const artifacts = Array.isArray(job?.artifacts)
    ? job.artifacts
    : Object.entries(job?.artifacts || {}).map(([kind, url]) => ({ kind, url }));
  async function flagForLearning(event) {
    event.preventDefault();
    setLearningState("saving");
    try {
      await createLearningCandidate({ job_id:job.id, assessment:learningAssessment,
        reasons:[...learningReasons], priority:learningPriority, note:learningNote,
        created_by:account.username }, authorization);
      setLearningState("saved");
      window.setTimeout(()=>setLearningOpen(false),700);
    } catch (e) { setLearningState(e.message); }
  }

  useEffect(() => {
    if (!reviewDialog) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !reviewBusy) setReviewDialog(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [reviewDialog, reviewBusy]);

  async function confirmReview(event) {
    event.preventDefault();
    if (!reviewDialog || reviewBusy) return;
    setReviewError("");
    try {
      const saved = await onReview(reviewDialog, reviewNote.trim(), authorization);
      if (saved === false) return;
      setReviewDialog(null);
      setReviewNote("");
    } catch (reviewFailure) {
      setReviewError(reviewFailure.message);
    }
  }

  return (
    <aside className="findings-panel">
      <div className="findings-tabs">
        <div><strong>Kết quả AI</strong><span>Chỉ hỗ trợ đọc phim</span></div>
        <button type="button" onClick={onClose} aria-label="Đóng bảng kết quả AI" title="Đóng bảng kết quả AI"><Icon name="close" size={16}/></button>
      </div>

      <div className="panel-scroll">
        {researchCase?.source_type === "dicom_upload" && (
          <section className="review-section case-context-card compact-context">
            <div><strong>{researchCase.patient_name || "Không có tên bệnh nhân"}</strong><span className={`priority-chip ${researchCase.priority}`}>{researchCase.priority === "stat" ? "Cấp cứu" : researchCase.priority === "urgent" ? "Khẩn" : "Thường quy"}</span></div>
            <small>{researchCase.patient_id || "Không mã BN"} · {researchCase.study_description || "CT Head"}</small>
            <p title={researchCase.clinical_indication}>{researchCase.clinical_indication || "Không có thông tin chỉ định kèm theo."}</p>
          </section>
        )}
        <section className="review-section findings compact-findings">
          <div className="section-title">
            <div><span className="section-kicker">AI SEGMENTATION</span><h2>BrainHem</h2></div>
            <span className={job?.status === "completed" ? "complete-tag" : "research-badge"}>{job?.status === "completed" ? <><Icon name="check" size={13} /> Sẵn sàng</> : "Research"}</span>
          </div>
          {!job && researchCase?.ai_status === "archived" && researchCase.ai_mask_url ? (
            <div className="compact-empty-result">
              <p>Có mặt nạ AI đã lưu.</p>
              <small>{researchCase.ai_model_version || "AI"} · {new Date(researchCase.ai_result_at).toLocaleDateString("vi-VN")}</small>
              <p>Thể tích mask AI: {Number(researchCase.ai_volume_ml || 0).toLocaleString("vi-VN", {maximumFractionDigits: 2})} mL</p>
              <a href={researchCase.ai_mask_url}>Tải mặt nạ AI gốc</a>
            </div>
          ) : !job && !error ? (
            <div className="compact-empty-result">
              <p>Ca này chưa có kết quả AI.</p>
              {researchMode && <div className="ai-size-picker" role="group" aria-label="Chọn kích thước model">
                {Object.entries(AI_SIZE_META).map(([tier, meta]) => {
                  const available = tier === "fast" && Boolean(aiTiers?.[tier]?.command_configured);
                  return <button key={tier} type="button" className={aiTier===tier?"active":""} disabled={account.role!=="admin"||!available||busy} onClick={()=>onAiTier(tier)} title={`Cấu hình ${meta.size}`}><b>{meta.size}</b></button>;
                })}
              </div>}
              {researchMode && <button className="tw-btn tw-btn-primary" disabled={!researchCase || busy || !aiAvailable} onClick={onPredict}>Phân tích AI</button>}
              <small>{aiAvailable ? `${AI_SIZE_META[aiTier]?.size || "AI"} · AI đã cấu hình; yêu cầu có thể chờ dịch vụ` : "Dịch vụ AI chưa sẵn sàng"}</small>
            </div>
          ) : job?.status === "completed" ? (
            <>
              <div className="ai-clinical-summary">
                <div className="ai-primary-metric"><span>Thể tích mask nghi xuất huyết</span><strong>{volume != null ? Number(volume).toFixed(1) : "—"}<small>mL</small></strong><p>Tính từ vùng phân đoạn 3D đang hiển thị trên ảnh.</p></div>
                <div className="ai-score-row"><span>Điểm đầu ra model <small>chưa hiệu chuẩn lâm sàng</small></span><strong>{confidence != null ? Number(confidence).toFixed(2) : "—"}</strong></div>
                {confidence != null&&<div className="ai-score-track" aria-label={`Điểm đầu ra model ${Number(confidence).toFixed(2)}`}><i style={{width:`${Math.min(100,Math.max(0,Number(confidence)*100))}%`}}/></div>}
                <p className="ai-output-scope"><Icon name="alert" size={14}/> Model hiện chỉ cung cấp mask xuất huyết tổng thể; không có kết quả phân loại riêng SAH, SDH hoặc EDH cho ca này.</p>
              </div>
              <details className="technical-details">
                <summary>Thông tin kỹ thuật</summary>
                <dl className="job-details">
                  <div><dt>Cấu hình</dt><dd>{AI_SIZE_META[job.inferenceTier]?.size || AI_SIZE_META[aiTier]?.size || "AI"}</dd></div>
                  <div><dt>Thời gian</dt><dd>{Number.isFinite(Number(timings.total)) ? `${Number(timings.total).toFixed(2)} s` : "—"}</dd></div>
                  <div><dt>Mã tác vụ</dt><dd title={job.id}>{job.id}</dd></div>
                </dl>
              </details>
            </>
          ) : job ? (
            <div className="panel-progress">
              <div><span>{job.error || job.stage || "Đang xử lý tự động"}</span><b>{progress > 0 ? `${progress}%` : ""}</b></div>
              <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
            </div>
          ) : null}
          {error && <p className="inline-error">{error}</p>}
        </section>

        {job?.status === "completed" && (
          <section className="review-section clinical-decision">
            <div className="section-title"><h3>Xác nhận của bác sĩ</h3>{job.review?.decision && <span className={`review-state-chip ${job.review.decision}`}><i/>{job.review.decision === "accepted" ? "Đã duyệt" : "Cần xem lại"}</span>}</div>
            <div className="decision-actions clinical-action-row"><button className={`accept ${job.review?.decision === "accepted" ? "primary" : ""}`} disabled={!can(account,"label.approve") || reviewBusy} type="button" onClick={() => { setReviewNote(""); setReviewDialog("accepted"); }}><Icon name="check" size={14}/> Duyệt kết quả</button><button type="button" disabled={!can(account,"label.edit") || reviewBusy || !onEdit} title="Mở công cụ gán nhãn của chính ca này" onClick={onEdit}><Icon name="brush" size={14}/> Gán nhãn</button><button className={`reject ${job.review?.decision === "rejected" ? "selected" : ""}`} disabled={!can(account,"label.approve") || reviewBusy} type="button" onClick={() => { setReviewNote(""); setReviewDialog("rejected"); }}><Icon name="close" size={14}/> Từ chối</button></div>
            <button className="learning-flag-button" type="button" onClick={()=>{setLearningState("");setLearningOpen(true);}}><Icon name="tag" size={14}/> Đưa vào Learning Queue</button>
          </section>
        )}

        {job?.status === "completed" && (
          <section className="review-section compact-exports">
            <details className="technical-details">
              <summary>Tải kết quả ({artifacts.length})</summary>
              <div className="artifacts">{artifacts.length ? artifacts.map((artifact, index) => (
                <a href={artifactUrl(job.id, artifact)} key={`${artifact.kind || artifact.name}-${index}`} download>
                  <span><Icon name="file" size={17} />{artifact.label || artifact.name || artifact.kind || "Tải kết quả"}</span>
                  <Icon name="download" size={17} />
                </a>
              )) : <p className="no-artifacts">Backend chưa cung cấp artifact.</p>}</div>
            </details>
          </section>
        )}
      </div>

      <div className="review-warning">
        <Icon name="alert" size={17} />
        <p><b>AI hỗ trợ, không phải kết luận chẩn đoán.</b> Luôn đánh giá ảnh gốc và bối cảnh lâm sàng.</p>
      </div>
      {learningOpen&&<div className="modal-backdrop"><form className="modal-dialog learning-dialog" onSubmit={flagForLearning}>
        <h3>Flag for Learning</h3><p>Ghi nhận đánh giá và đóng băng provenance của kết quả AI hiện tại.</p>
        <label>Đánh giá<select value={learningAssessment} onChange={e=>setLearningAssessment(e.target.value)}><option value="incorrect">Không đúng</option><option value="partially_correct">Đúng một phần</option><option value="difficult">Ca khó/chưa chắc chắn</option><option value="correct">Đúng · lấy mẫu QA</option></select></label>
        <fieldset><legend>Lý do</legend>{[["false_negative","False negative"],["false_positive","False positive"],["incorrect_segmentation","Segmentation sai"],["wrong_subtype","Sai subtype"],["low_confidence","Độ tin cậy thấp"],["difficult_case","Ca khó"],["rare_case","Ca hiếm"],["artifact","Artifact"],["random_qa","Random QA"]].map(([id,label])=><label key={id}><input type="checkbox" checked={learningReasons.has(id)} onChange={e=>setLearningReasons(current=>{const next=new Set(current);e.target.checked?next.add(id):next.delete(id);return next;})}/>{label}</label>)}</fieldset>
        <label>Ưu tiên<select value={learningPriority} onChange={e=>setLearningPriority(e.target.value)}><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        <label>Ghi chú<textarea value={learningNote} onChange={e=>setLearningNote(e.target.value)}/></label>
        <p className="session-identity-note">Ghi nhận bởi tài khoản đang đăng nhập: <b>{account.username}</b></p>
        {learningState&&learningState!=="saving"&&learningState!=="saved"&&<p className="inline-error">{learningState}</p>}{learningState==="saved"&&<p>Đã tạo learning candidate.</p>}
        <div className="save-btn-group"><button type="button" onClick={()=>setLearningOpen(false)}>Hủy</button><button disabled={learningState==="saving"||(!learningReasons.size&&learningAssessment!=="correct")}>{learningState==="saving"?"Đang lưu…":"Đưa vào queue"}</button></div>
      </form></div>}
      {reviewDialog&&<div className="modal-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!reviewBusy)setReviewDialog(null);}}><form className="modal-dialog clinical-review-dialog" role="dialog" aria-modal="true" aria-labelledby="clinical-review-title" onSubmit={confirmReview}>
        <h3 id="clinical-review-title">{reviewDialog==="accepted"?"Xác nhận duyệt kết quả AI":"Xác nhận từ chối kết quả AI"}</h3>
        <p>{reviewDialog==="accepted"?"Xác nhận rằng bạn đã đối chiếu toàn bộ ảnh CT gốc trước khi duyệt.":"Ghi rõ lý do không chấp nhận kết quả để phục vụ audit và cải thiện model."}</p>
        <label htmlFor="clinical-review-note">Ghi chú {reviewDialog==="rejected"?"(bắt buộc)":"(khuyến nghị)"}</label>
        <textarea id="clinical-review-note" autoFocus required={reviewDialog==="rejected"} value={reviewNote} onChange={(event)=>setReviewNote(event.target.value)} placeholder={reviewDialog==="rejected"?"Ví dụ: bỏ sót vùng, khoanh sai hoặc không phù hợp chất lượng ảnh":"Nhận xét sau khi đối chiếu ảnh gốc"}/>
        <p className="session-identity-note">Người xác nhận: <b>{account.username}</b></p>
        {reviewError&&<p className="inline-error" role="alert">{reviewError}</p>}
        <div className="save-btn-group"><button type="button" disabled={reviewBusy} onClick={()=>setReviewDialog(null)}>Hủy</button><button type="submit" disabled={reviewBusy || (reviewDialog==="rejected"&&!reviewNote.trim())}>{reviewBusy?"Đang lưu…":reviewDialog==="accepted"?"Xác nhận duyệt":"Xác nhận từ chối"}</button></div>
      </form></div>}
    </aside>
  );
}

const APP_NAV = [
  { id:"home", label:"Dashboard", icon:"home" },
  { id:"clinical", label:"Dữ liệu", icon:"database" },
  { id:"ai-studio", label:"AI Studio", icon:"cube", external:true, href:"/model-studio" },
  { id:"settings", label:"Settings", icon:"settings" },
  { id:"docs", label:"Hướng dẫn", icon:"help", external:true, href:"/guide" },
  { id:"feedback", label:"Gửi phản hồi", icon:"inbox", external:true, href:"/feedback" },
];

function useSidebarCollapse() {
  const [collapsed,setCollapsed] = useState(() => {
    try { return localStorage.getItem("brainhem.sidebar-collapsed-v2") === "1"; } catch { return false; }
  });
  const toggle = () => setCollapsed(value => {
    const next = !value;
    try { localStorage.setItem("brainhem.sidebar-collapsed-v2", next ? "1" : "0"); } catch { /* optional preference */ }
    return next;
  });
  return [collapsed,toggle];
}

function PortalSidebar({ active, onNavigate }) {
  const {account}=useAppAuth();
  const [collapsed,toggleCollapsed] = useSidebarCollapse();
  const openPortalItem = (item) => item.external ? window.open(item.href, "_blank", "noopener,noreferrer") : onNavigate(item.id);
  return <aside className={`portal-sidebar brainhem-sidebar ${collapsed ? "collapsed" : ""}`}>
    <div className="sidebar-head">
      <button className="portal-brand" type="button" onClick={() => onNavigate("home")}>
        <span><Icon name="scan" size={29}/></span>
        <span><strong>BrainHem</strong><small>Research Workstation</small></span>
      </button>
      <button className="sidebar-collapse" type="button" onClick={toggleCollapsed} title={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"} aria-label={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"}><Icon name="chevron" size={15}/></button>
    </div>
    <nav aria-label="Điều hướng chính">
      {APP_NAV.filter(item=>navAllowed(account,item)).map((item) => <button key={item.id} type="button" data-label={item.label} className={active === item.id ? "active" : ""} onClick={() => openPortalItem(item)} aria-label={item.label}>
        <Icon name={item.icon} size={20}/><span>{item.label}</span>
      </button>)}
    </nav>
    <div className="workspace-rail-promo"><div className="promo-brain"><i/><i/><i/></div><strong>Research<br/>Workspace</strong><small>CT Annotation & Model Studio</small></div>
  </aside>;
}

function WorkspaceRail({ active, onNavigate }) {
  const {account}=useAppAuth();
  const [collapsed,toggleCollapsed] = useSidebarCollapse();
  const items = APP_NAV.filter(item=>navAllowed(account,item));
  const openItem = item => item.external ? window.open(item.href, "_blank", "noopener,noreferrer") : onNavigate(item.id);
  return <aside className={`workspace-rail brainhem-sidebar ${collapsed ? "collapsed" : ""}`}>
    <div className="sidebar-head">
      <button className="workspace-rail-brand" type="button" onClick={() => onNavigate("home")} title="BrainHem · Trang chủ"><span><Icon name="scan" size={27}/></span><div className="workspace-brand-copy"><strong>BrainHem</strong><small>Research Workstation</small></div></button>
      <button className="sidebar-collapse" type="button" onClick={toggleCollapsed} title={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"} aria-label={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"}><Icon name="chevron" size={15}/></button>
    </div>
    <nav aria-label="Module BrainHem">{items.map(item => <button type="button" key={item.id} data-label={item.label} className={active===item.id?"active":""} onClick={() => openItem(item)} aria-label={item.label}><Icon name={item.icon} size={20}/><span>{item.label}</span></button>)}</nav>
    <div className="workspace-rail-promo"><div className="promo-brain"><i/><i/><i/></div><strong>Research<br/>Workspace</strong><small>CT Annotation & Model Studio</small></div>
  </aside>;
}

function WorkspaceGlobalHeader({ active, caseName, connection, onNavigate }) {
  const { account, logout } = useAppAuth();
  const moduleTitle = active === "labeling" ? "Dữ liệu" : active === "training" ? "Model Studio" : "Dữ liệu";
  const moduleSubtitle = active === "labeling" ? "Đọc ảnh, gán nhãn và kiểm định ground truth" : active === "training" ? "Controlled learning to production" : "Đọc CT, kiểm tra AI và gán nhãn";
  return <header className={`workspace-global-header module-${active}`}>
    <div className="workspace-page-title"><button type="button" onClick={() => onNavigate("home")}>{moduleTitle}</button><span>{displayName(caseName) || moduleSubtitle}</span></div>
    <div className="workspace-header-actions"><ConnectionStatus state={connection}/><div className="workspace-profile"><span className="workspace-avatar">{account.role === "admin" ? "AD" : "US"}</span><div><strong>{account.username}</strong><small>{ROLE_LABELS[account.role] || account.role}</small></div></div><button className="app-session-logout" type="button" onClick={logout}>Đăng xuất</button></div>
  </header>;
}

function PortalTopbar({ connection, search, onSearch }) {
  const { account, logout } = useAppAuth();
  return <header className="portal-topbar">
    <label className="portal-search"><Icon name="search" size={18}/><input aria-label="Tìm kiếm bệnh nhân hoặc ca" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Tìm mã bệnh nhân, tên hoặc ca nghiên cứu…"/></label>
    <ConnectionStatus state={connection}/>
    <div className="portal-user"><span>{account.role === "admin" ? "AD" : "US"}</span><div><strong>{account.username}</strong><small>{ROLE_LABELS[account.role] || account.role}</small></div></div><button className="app-session-logout" type="button" onClick={logout}>Đăng xuất</button>
  </header>;
}

function HomeDashboard({ connection, cases, studies, directUploadEnabled, onNavigate, onOpenCase, onLabelCase }) {
  const {account}=useAppAuth();
  const [search, setSearch] = useState("");
  const allCases = useMemo(() => {
    const pacsStudyUids = new Set(studies.map(study => study.study_instance_uid).filter(Boolean));
    const pacsCases = studies.map((study) => ({
      id: study.orthanc_id, name: study.patient_name || "ANONYMOUS", patientId: study.patient_id || "Không mã BN",
      date: study.study_date || "—", aiStatus: study.ai_status, source: study,
    }));
    const researchCases = cases
      .filter(item => !item.study_instance_uid || !pacsStudyUids.has(item.study_instance_uid))
      .map((item) => ({
      id: item.id, name: item.patient_name || item.name || "Ca ẩn danh", patientId: item.patient_id || "Không mã BN",
      date: item.study_date || (item.updated_at ? new Date(item.updated_at).toLocaleDateString("vi-VN") : "—"), aiStatus: item.ai_status,
      priority: item.priority, source: item,
    }));
    return [...pacsCases, ...researchCases];
  }, [cases, studies]);
  const visibleCases = allCases.filter((item) => `${item.patientId} ${item.name}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 5);
  const analyzed = allCases.filter((item) => ["succeeded", "archived"].includes(item.aiStatus)).length;
  const processing = allCases.filter((item) => ["queued", "running", "retry_wait", "service_wait"].includes(item.aiStatus)).length;
  const pending = allCases.length - analyzed - processing;
  const labelCounts = {
    new: cases.filter(item => Number(item.current_revision || 0) === 0).length,
    draft: cases.filter(item => Number(item.current_revision || 0) > 0 && item.status !== "approved").length,
    review: cases.filter(item => item.status === "approved" || item.latest_approved_revision != null).length,
  };
  const labelQueue = cases
    .filter(item => item.status !== "approved")
    .sort((a,b) => String(b.updated_at||"").localeCompare(String(a.updated_at||"")))
    .slice(0,4);
  const today = new Intl.DateTimeFormat("vi-VN", { weekday:"long", year:"numeric", month:"long", day:"numeric" }).format(new Date());
  return <div className="portal-shell">
    <PortalSidebar active="home" onNavigate={onNavigate}/>
    <div className="portal-main">
      <PortalTopbar connection={connection} search={search} onSearch={setSearch}/>
      <main className="home-dashboard">
        <section className="home-welcome"><div><span className="home-eyebrow">BrainHem Clinical AI</span><h1>Chào mừng trở lại</h1><p>Phát hiện. Định lượng. Hỗ trợ quyết định chăm sóc não tốt hơn.</p></div><div className="home-welcome-art" aria-hidden="true"><i/><i/><i/><i/></div><time>{today}</time></section>
        <section className="home-stats">
          <article><span className="stat-icon blue"><Icon name="folder" size={25}/></span><div><strong>{allCases.length}</strong><p>Tổng số ca</p><small>Dữ liệu hiện có</small></div></article>
          <article><span className="stat-icon blue"><Icon name="file" size={25}/></span><div><strong>{analyzed}/{allCases.length}</strong><p>Có kết quả AI</p><small>Ca sẵn sàng xem kết quả</small></div></article>
          <article><span className="stat-icon amber"><Icon name="spark" size={25}/></span><div><strong>{processing}</strong><p>Đang xử lý</p><small>Trong hàng đợi AI</small></div></article>
          <article><span className="stat-icon violet"><Icon name="clock" size={25}/></span><div><strong>{pending}</strong><p>Chờ phân tích</p><small>Chưa có kết quả AI</small></div></article>
        </section>
        <section className="home-grid-primary">
          <article className="portal-card quick-start"><header><h2>Bắt đầu nhanh</h2><p>Tiếp nhận CT hoặc mở một ca hiện có để bắt đầu.</p></header><div>
            <button type="button" disabled={!can(account,"case.ingest")} onClick={() => onNavigate("upload")}><span><Icon name="upload" size={28}/></span><strong>Tiếp nhận ca CT</strong><small>DICOM files hoặc ZIP</small><em>{directUploadEnabled ? "Tải lên ngay" : "Mở khu vực tiếp nhận"}</em></button>
            <button type="button" onClick={() => onNavigate("clinical")}><span><Icon name="folder" size={28}/></span><strong>Mở ca hiện có</strong><small>Duyệt thư viện ca</small><em className="soft">Xem danh sách</em></button>
          </div></article>
          <article className="portal-card labeling-queue"><header><div><h2>{labelCounts.new + labelCounts.draft} ca cần gán nhãn</h2><p>{labelCounts.new} chưa bắt đầu · {labelCounts.draft} bản nháp · {labelCounts.review} đã duyệt</p></div><button type="button" onClick={() => onNavigate("clinical")}>Mở thư viện <Icon name="chevron" size={15}/></button></header><div className="label-queue-list">{labelQueue.map(item => {const state=Number(item.current_revision||0)===0?"Chưa đánh giá":item.status==="approved"?"Đã duyệt":`Bản nháp v${item.current_revision}`;return <button type="button" key={item.id} disabled={!can(account,"label.edit")} onClick={() => onLabelCase(item)}><span><Icon name="scan" size={17}/></span><div><strong>{displayName(item.patient_name||item.name)}</strong><small>{state}</small></div><em>{item.status==="approved"?"Xem":"Tiếp tục"}<Icon name="chevron" size={13}/></em></button>})}</div></article>
        </section>
        <section className="home-grid-secondary">
          <article className="portal-card recent-studies"><header><h2>Ca gần đây</h2><button type="button" onClick={() => onNavigate("clinical")}>Xem tất cả <Icon name="chevron" size={15}/></button></header>
            <div className="study-table"><div className="study-row table-head"><span>Mã bệnh nhân</span><span>Tên ca</span><span>Trạng thái</span><span>Kết quả AI</span><span>Thao tác</span></div>
            {visibleCases.length ? visibleCases.map((item) => <div className="study-row" key={item.id}><span>{item.patientId}</span><span>{item.name}</span><span><i className={`status-dot ${["queued","running","retry_wait","service_wait"].includes(item.aiStatus) ? "working" : ""}`}/>{["queued","running","retry_wait","service_wait"].includes(item.aiStatus) ? "Đang xử lý" : "Sẵn sàng"}</span><span className={`ai-result ${["succeeded", "archived"].includes(item.aiStatus) ? "ready" : ""}`}>{["succeeded", "archived"].includes(item.aiStatus) ? "Đã có kết quả" : "Chưa phân tích"}</span><button type="button" onClick={() => onOpenCase(item.source)}>Mở</button></div>) : <div className="study-empty">{search ? "Không tìm thấy ca phù hợp." : "Chưa có ca trong thư viện."}</div>}
            </div>
          </article>
          <article className="portal-card resources"><header><h2>Công cụ &amp; tài nguyên</h2></header><div>
            <button type="button" disabled={!can(account,"label.edit")} onClick={() => onNavigate("clinical")}><span><Icon name="brush" size={20}/></span><strong>Gán nhãn</strong><small>Mở ca từ thư viện CT</small></button>
            <button type="button" disabled={!can(account,"studio.read")} onClick={() => window.location.assign("/model-studio")}><span><Icon name="cube" size={20}/></span><strong>Model Studio</strong><small>Quản lý, đánh giá và kiểm định model</small></button>
            <button type="button" onClick={() => onNavigate("analysis")}><span><Icon name="chart" size={20}/></span><strong>Phân tích AI</strong><small>Xem kết quả trên CT</small></button>
            <button type="button" onClick={() => onNavigate("settings")}><span><Icon name="settings" size={20}/></span><strong>Cài đặt</strong><small>Cấu hình không gian làm việc</small></button>
          </div><p className="portal-tip"><Icon name="help" size={18}/><span><b>Mẹo</b>Dùng nhiều mặt phẳng axial, coronal và sagittal để đánh giá chính xác.</span></p></article>
        </section>
      </main>
    </div>
  </div>;
}

function CtSimulatorSettings({ caps, onNavigate }) {
  const [fixtures,setFixtures]=useState([]);
  const [fixtureId,setFixtureId]=useState("");
  const [localFile,setLocalFile]=useState(null);
  const [patientId,setPatientId]=useState(`ANON-CT-${String(Date.now()).slice(-6)}`);
  const [sending,setSending]=useState(false);
  const [progress,setProgress]=useState(0);
  const [result,setResult]=useState(null);
  const [error,setError]=useState("");
  useEffect(()=>{let alive=true;listAnnotationCases(30,0).then(data=>{if(!alive)return;const items=data.items||[];setFixtures(items);setFixtureId(current=>current||items[0]?.id||"");}).catch(()=>{});return()=>{alive=false;};},[]);
  const sourceReady=Boolean(localFile||fixtureId);
  const patientValid=/^ANON-[A-Z0-9-]{1,32}$/.test(patientId);
  async function send(){
    if(!sourceReady||!patientValid||sending)return;
    setSending(true);setProgress(2);setResult(null);setError("");
    try{
      let acquisition=localFile;
      if(!acquisition){
        const fixture=fixtures.find(item=>item.id===fixtureId);
        const response=await fetchWithRetry(getAnnotationSourceUrl(fixtureId),{cache:"force-cache"},3,30000);
        if(!response.ok)throw new Error("Không tải được ca mẫu CT");
        acquisition=new File([await response.blob()],`${fixture?.name||"ct-fixture"}.nii.gz`,{type:"application/gzip"});
        setProgress(8);
      }
      const payload=await sendSimulatorAcquisition(acquisition,patientId,value=>setProgress(Math.max(8,value)));
      setResult(payload);setProgress(100);
    }catch(reason){setError(reason.message||"Không gửi được acquisition");}finally{setSending(false);}
  }
  return <section className="ct-simulator-settings" aria-labelledby="ct-simulator-title">
    <header>
      <span><Icon name="scan" size={27}/></span>
      <div><p className="settings-kicker">DICOM modality simulator</p><h2 id="ct-simulator-title">Giả lập máy CT gửi ca sang BrainHem</h2><small>Tạo series CT DICOM thật từ ca mẫu rồi mô phỏng luồng C-STORE vào hệ thống.</small></div>
      <b className={caps?.simulator_enabled?"online":"offline"}>{caps?.simulator_enabled?"Sẵn sàng":"Chưa bật"}</b>
    </header>
    <div className="ct-transfer-flow" aria-label="Luồng truyền DICOM">
      <div className={sending||result?"active":""}><Icon name="scan" size={20}/><span><b>CT-SIM-01</b><small>Calling AE · CT_SIMULATOR</small></span></div><i>→</i>
      <div className={sending?"active":""}><Icon name="upload" size={20}/><span><b>DICOM C-STORE</b><small>{sending?`Đang truyền · ${progress}%`:"DIMSE acquisition"}</small></span></div><i>→</i>
      <div className={result?"active success":""}><Icon name="database" size={20}/><span><b>{caps?.dicom_enabled?"BRAINHEM_PACS":"Local DICOM Gateway"}</b><small>Called AE · BRAINHEM_PACS</small></span></div>
    </div>
    <div className="ct-simulator-form">
      <label><span>Nguồn acquisition</span><select disabled={sending||Boolean(localFile)} value={fixtureId} onChange={event=>{setFixtureId(event.target.value);setResult(null);}}><option value="">Chọn ca CT mẫu…</option>{fixtures.map(item=><option key={item.id} value={item.id}>{item.patient_id||item.name} · {item.geometry?.shape?.[2]||"—"} lát</option>)}</select><small>{localFile?`Đang dùng file: ${localFile.name}`:`${fixtures.length} ca có sẵn trong thư viện nghiên cứu`}</small></label>
      <label><span>Patient ID ẩn danh</span><input value={patientId} disabled={sending} maxLength={37} onChange={event=>{setPatientId(event.target.value.toUpperCase());setResult(null);}}/><small className={!patientValid?"invalid":""}>Bắt buộc bắt đầu bằng ANON-</small></label>
      <label className="ct-fixture-upload"><span>Hoặc dùng NIfTI khác</span><em>{localFile?"Đổi file":"Chọn .nii / .nii.gz"}<input type="file" accept=".nii,.nii.gz,application/gzip,application/octet-stream" disabled={sending} onChange={event=>{setLocalFile(event.target.files?.[0]||null);setResult(null);}}/></em>{localFile&&<button type="button" onClick={()=>setLocalFile(null)}>Dùng lại ca mẫu</button>}</label>
      <button className="ct-send-button" type="button" disabled={!caps?.simulator_enabled||!sourceReady||!patientValid||sending} onClick={send}><Icon name="upload" size={18}/>{sending?"Đang tạo và gửi DICOM…":"Gửi acquisition từ máy CT"}</button>
    </div>
    {(sending||result)&&<div className={`ct-transfer-progress ${result?"complete":""}`}><span style={{width:`${progress}%`}}/><b>{result?"Đã nhận đủ series":`Đang truyền ${progress}%`}</b></div>}
    {error&&<p className="ct-simulator-error" role="alert"><Icon name="alert" size={16}/>{error}</p>}
    {result&&<div className="ct-simulator-result"><Icon name="check" size={23}/><div><b>{result.instances_sent} ảnh DICOM đã được nhận</b><span>Accession {result.accession_number} · {result.rows}×{result.columns} · {result.transmission_mode==="dimse_c_store"?"DIMSE C-STORE":"Local gateway"}</span><small>{result.auto_inference?`AI Model ${String(result.auto_inference.tier).toUpperCase()} đã xếp hàng · Job ${result.auto_inference.job_id.slice(0,8)}`:`Patient ${result.patient_id} đã sẵn sàng trong thư viện Clinical.`}</small></div><button type="button" onClick={()=>onNavigate("clinical")}>Mở Clinical</button></div>}
  </section>;
}

function SettingsDashboard({ connection, onNavigate }) {
  const [search,setSearch]=useState("");
  const [caps,setCaps]=useState(null);
  const [loadError,setLoadError]=useState("");
  const [loading,setLoading]=useState(false);
  const refresh=async()=>{setLoading(true);setLoadError("");try{setCaps(await getCapabilities());}catch(e){setLoadError(e.message);}finally{setLoading(false);}};
  useEffect(()=>{refresh();},[]);
  const tiers=Object.values(caps?.tiers||{});
  const available=tiers.filter(item=>item.available).length;
  return <div className="portal-shell"><PortalSidebar active="settings" onNavigate={onNavigate}/><div className="portal-main"><PortalTopbar connection={connection} search={search} onSearch={setSearch}/><main className="settings-dashboard"><div className="settings-page-head"><span className="settings-kicker">BrainHem / System status</span><h1>Trạng thái hệ thống</h1><p>Thông tin thực tế từ backend. Thay đổi hạ tầng được thực hiện trong cấu hình triển khai.</p>{loadError&&<p className="inline-error" role="alert">{loadError}</p>}<button type="button" onClick={refresh} disabled={loading}>{loading?"Đang làm mới…":"Làm mới trạng thái"}</button></div><div className="settings-section-title"><div><h2>Dịch vụ đang sử dụng</h2><p>Trạng thái lấy trực tiếp từ API, không phải nội dung minh họa.</p></div><span>{tiers.length} model tiers</span></div><section>
    <article><span><Icon name="database" size={24}/></span><div><h2>Kết nối PACS</h2><p>DICOMweb / Orthanc · nhận study, series và instance.</p></div><b className={caps?.dicom_enabled?"online":"offline"}>{caps?.dicom_enabled?"Đã bật":"Chưa bật"}</b><small>Cấu hình bởi quản trị viên triển khai.</small></article>
    <article><span><Icon name="spark" size={24}/></span><div><h2>AI backend &amp; workers</h2><p>{available}/{tiers.length||0} tier sẵn sàng nhận tác vụ.</p></div><b className={available?"online":"offline"}>{available?"AI sẵn sàng":"Chưa sẵn sàng"}</b><button type="button" onClick={() => onNavigate("analysis")}>Mở phân tích</button></article>
    <article><span><Icon name="shield" size={24}/></span><div><h2>Phân quyền ứng dụng</h2><p>Xem ảnh, lưu nháp, duyệt nhãn và quản lý mô hình theo vai trò.</p></div><b className={caps?.reviewer_auth_configured?"online":"offline"}>{caps?.reviewer_auth_configured?"Đã cấu hình":"Chưa cấu hình"}</b><small>Quản trị cấp quyền tại mục Tài khoản.</small></article>
    <article><span><Icon name="upload" size={24}/></span><div><h2>Tiếp nhận trực tiếp</h2><p>Tải DICOM/NIfTI ngoài PACS vào thư viện nghiên cứu.</p></div><b className={caps?.direct_upload_enabled?"online":"offline"}>{caps?.direct_upload_enabled?"Đã bật":"Đã tắt"}</b><small>{caps?.direct_upload_enabled?"Có thể dùng tại Dashboard và Clinical.":"Ca mới phải đi qua PACS."}</small></article>
  </section><AccountManagement/><ModelReviewPanel/><CtSimulatorSettings caps={caps} onNavigate={onNavigate}/></main></div></div>;
}

function getTabFromHash(hash) {
  const h = (hash || "").toLowerCase().split("?")[0];
  if (h === "#home" || !h) return "home";
  if (h === "#clinical") return "clinical";
  if (h === "#analysis") return "clinical";
  if (h === "#training") return "home";
  if (h === "#settings") return "settings";
  if (h === "#labeling" || h === "#annotation") return "labeling";
  return "home";
}

export default function App() {
  const {account}=useAppAuth();
  const [workspaceTab, setWorkspaceTab] = useState(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    return getTabFromHash(hash);
  });
  const [labelingCaseId, setLabelingCaseId] = useState(() => {
    const query = typeof window !== "undefined" ? window.location.hash.split("?")[1] : "";
    return new URLSearchParams(query || "").get("case") || null;
  });
  const [workspaceCaseName, setWorkspaceCaseName] = useState("");
  const annotationLeaveRef = useRef(null);
  const registerAnnotationLeave = useCallback(handler => { annotationLeaveRef.current = handler; }, []);
  const currentTabRef = useRef(workspaceTab);

  useEffect(() => {
    currentTabRef.current = workspaceTab;
  }, [workspaceTab]);

  const [connection, setConnection] = useState("checking");
  const [file, setFile] = useState(null);
  const researchFileCacheRef = useRef(new Map());

  const switchTab = async (tab) => {
    if (tab === workspaceTab) return;
    if (workspaceTab === "labeling" && await annotationLeaveRef.current?.() === false) return;
    currentTabRef.current = tab;
    setWorkspaceTab(tab);
    if (typeof window !== "undefined") {
      window.location.hash = `#${tab}`;
    }
  };

  useEffect(() => {
    async function syncHash() {
      const targetTab = getTabFromHash(window.location.hash);
      if (targetTab === currentTabRef.current) return;
      if (currentTabRef.current === "labeling") {
        if (await annotationLeaveRef.current?.() === false) {
          window.location.hash = "#labeling";
          return;
        }
      }
      currentTabRef.current = targetTab;
      setWorkspaceTab(targetTab);
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [labelingBusy, setLabelingBusy] = useState(false);
  const labelingBusyRef = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const [worklistVisible, setWorklistVisible] = useState(() => {
    try { return localStorage.getItem("brainhem.clinical-worklist-visible") !== "0"; } catch { return true; }
  });
  const [panelOpen, setPanelOpen] = useState(false);
  const [viewportLocation, setViewportLocation] = useState(null);
  const [pacsEnabled, setPacsEnabled] = useState(false);
  const [pacsLoading, setPacsLoading] = useState(false);
  const [studies, setStudies] = useState([]);
  const [selectedStudy, setSelectedStudy] = useState(null);
  const [researchCases,setResearchCases]=useState([]);
  const [researchCase,setResearchCase]=useState(null);
  const [researchLoading,setResearchLoading]=useState(false);
  const [aiAvailable,setAiAvailable]=useState(false);
  const [aiTier,setAiTier]=useState("fast");
  const [aiTta,setAiTta]=useState(false);
  const [aiTiers,setAiTiers]=useState({});
  const [directUploadEnabled,setDirectUploadEnabled]=useState(false);
  const [intakeOpen,setIntakeOpen]=useState(false);
  useEffect(() => {
    try { localStorage.setItem("brainhem.clinical-worklist-visible", worklistVisible ? "1" : "0"); } catch { /* optional preference */ }
  }, [worklistVisible]);
  useEffect(()=>{
    if(!["home","clinical"].includes(workspaceTab))return;
    let alive=true, pending=false;
    listAnnotationCases(100,0).then(data=>{if(alive)setResearchCases(data.items||[]);}).catch(e=>{if(alive)setError(e.message);});
    const check=async()=>{if(pending)return;pending=true;try{const cap=await getCapabilities();if(alive){const availableTier=cap.tiers?.standard?.available?"standard":cap.tiers?.fast?.available?"fast":cap.tiers?.high?.available?"high":null;setAiTiers(cap.tiers||{});setAiAvailable(Boolean(availableTier));if(availableTier)setAiTier(current=>account.role!=="admin"?(cap.default_tier||"fast"):cap.tiers?.[current]?.available?current:availableTier);setDirectUploadEnabled(Boolean(cap.direct_upload_enabled));}}catch{if(alive){setAiTiers({});setAiAvailable(false);setDirectUploadEnabled(false);}}finally{pending=false;}};
    check();const timer=setInterval(check,15000);return()=>{alive=false;clearInterval(timer);};
  },[workspaceTab]);
  async function openResearchCase(item, autoAnalyze=false) {
    if(researchLoading)return;
    setResearchLoading(true);setError("");setFile(null);setJob(null);setSelectedStudy(null);setResearchCase(item);setPanelOpen(false);
    try {
      const cachedFile=researchFileCacheRef.current.get(item.id);
      const filePromise=cachedFile?Promise.resolve(cachedFile):(async()=>{
        const response=await fetchWithRetry(getAnnotationSourceUrl(item.id),{cache:"force-cache"},3,30000);
        if(!response.ok)throw Error("Không tải được CT nghiên cứu");
        const nextFile=new File([await response.blob()],item.name+".nii.gz");
        researchFileCacheRef.current.set(item.id,nextFile);
        return nextFile;
      })();
      const jobPromise=item.ai_job_id
        ? getJob(item.ai_job_id).then(normalizedJob)
        : autoAnalyze&&aiAvailable&&can(account,"inference.create")
          ? runCaseInference(item.id,aiTier,false).then(normalizedJob)
          : Promise.resolve(null);
      jobPromise.then((nextJob)=>{if(nextJob)setJob(nextJob);}).catch(()=>{});
      setFile(await filePromise);
      const nextJob=await jobPromise;
      if(nextJob)setJob(nextJob);
    }catch(e){setError(e.message);}finally{setResearchLoading(false);}
  }
  async function predictResearchCase() {
    if(!can(account,"inference.create") || !researchCase || busy)return;
    setResearchLoading(true);setError("");
    try{setJob(normalizedJob(await runCaseInference(researchCase.id,aiTier,false)));}catch(e){setError(e.message);}finally{setResearchLoading(false);}
  }

  const busy = researchLoading || Boolean(job && !TERMINAL.has(job.status));
  const displayProgress = useMemo(() => {
    if (!job) return 0;
    if (job.status === "completed") return 100;
    return Math.min(job.progress, 99);
  }, [job]);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const payload = await healthCheck(controller.signal);
        setConnection("online");
        setPacsEnabled(Boolean(payload.pacs_configured && payload.dicom_enabled));
      } catch (healthError) {
        if (healthError.name !== "AbortError") setConnection("offline");
      } finally {
        checking = false;
      }
    };
    check();
    const timer = window.setInterval(check, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  async function refreshStudies(signal) {
    if (!pacsEnabled && !signal) return;
    setPacsLoading(true);
    try {
      const payload = await listStudies(signal);
      setStudies(payload.items || []);
    } catch (studyError) {
      if (studyError.name !== "AbortError") setError(studyError.message);
    } finally {
      setPacsLoading(false);
    }
  }

  useEffect(() => {
    if (!pacsEnabled) return undefined;
    const controller = new AbortController();
    refreshStudies(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pacsEnabled]);

  useEffect(() => {
    if (!job?.id || TERMINAL.has(job.status)) return undefined;
    return trackJob({
      read: signal => getJob(job.id, signal),
      onJob: response => setJob(normalizedJob(response)),
      onConnection: connected => setConnection(connected ? "online" : "offline"),
      onUnavailable: reason => {setError(reason.message);setJob(null);},
      interval: 1800,
    });
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (job?.status === "completed" && pacsEnabled) refreshStudies();
    if (job?.status === "completed" && researchCase) setResearchCases(items=>items.map(c=>c.id===researchCase.id?{...c,ai_job_id:job.id,ai_status:"succeeded"}:c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, pacsEnabled]);

  useEffect(() => {
    if (job?.status !== "completed" || job.inputType !== "dicom" || file) return;
    artifactFile(job.id, "source", "pacs-source-ct.nii.gz")
      .then(setFile)
      .catch((loadError) => setError(loadError.message));
  }, [job?.id, job?.status, job?.inputType, file]);

  async function analyzePacsStudy(study) {
    if (busy) return;
    setError("");
    setFile(null);
    setSelectedStudy(study);
    setResearchCase(null);
    setPanelOpen(false);
    setJob({ status: "queued", progress: 0, stage: "Đang tải CT", studyId: study.orthanc_id, inputType: "dicom" });
    try {
      const response = await analyzeStudy(study.orthanc_id);
      setJob({ ...normalizedJob(response), studyId: study.orthanc_id });
    } catch (studyError) {
      setJob(null);
      setError(studyError.message);
    }
  }

  function stepClinicalCase(direction) {
    if (busy) return;
    const rank = { stat: 0, urgent: 1, routine: 2 };
    const candidates = pacsEnabled
      ? studies.filter((item) => item.is_stable !== false)
      : [...researchCases]
          .filter((item) => !/^AUDIT_/i.test(String(item.name || "")))
          .filter((item) => item.status === "approved" && hasAiResult(item))
          .sort((left, right) => {
            const priority = (rank[left.priority] ?? 3) - (rank[right.priority] ?? 3);
            return priority || String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
          });
    if (!candidates.length) return;
    const currentId = pacsEnabled ? selectedStudy?.orthanc_id : researchCase?.id;
    const currentIndex = candidates.findIndex((item) => (pacsEnabled ? item.orthanc_id : item.id) === currentId);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : candidates.length - 1)
      : (currentIndex + direction + candidates.length) % candidates.length;
    if (pacsEnabled) analyzePacsStudy(candidates[nextIndex]);
    else openResearchCase(candidates[nextIndex]);
  }

  function reset() {
    setFile(null);
    setJob(null);
    setError("");
    setSelectedStudy(null);
    setResearchCase(null);
  }

  async function acceptDicomImport(item, autoAnalyze) {
    setIntakeOpen(false);
    setResearchCases((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
    switchTab("clinical");
    await openResearchCase(item, autoAnalyze);
  }

  async function submitReview(decision, note = "", authorization = null) {
    if (!job?.id || reviewBusy) return;
    setReviewBusy(true);
    try {
      const response = await reviewJob(
        job.id,
        decision,
        note,
        authorization,
        job.review?.reviewed_at || null,
      );
      setJob(normalizedJob(response));
      return true;
    } catch (reviewError) {
      setError(reviewError.message);
      return false;
    } finally {
      setReviewBusy(false);
    }
  }

  async function editClinicalCase() {
    if (!can(account,"label.edit") || labelingBusyRef.current) return;
    if (researchCase) {
      await openLabelingCase(researchCase);
      return;
    }
    if (!can(account,"case.ingest")) return;
    labelingBusyRef.current = true;
    setLabelingBusy(true);
    setError("");
    try {
      // Reuse the displayed source; the API preserves existing revisions.
      const payload = job?.id && job.status === "completed"
        ? { jobId:job.id }
        : selectedStudy?.orthanc_id ? { studyId:selectedStudy.orthanc_id }
        : file ? { file } : null;
      if (!payload) throw new Error("Hãy mở một ca CT trước khi gán nhãn.");
      const item = await createAnnotationCase({ ...payload, name:selectedStudy?.patient_name || selectedStudy?.name || file?.name });
      setResearchCases(items => [item,...items.filter(existing => existing.id !== item.id)]);
      await prepareAndOpenLabelingCase(item);
    } catch (reason) {
      setError(`Không mở được công cụ gán nhãn: ${reason.message}`);
    } finally {
      labelingBusyRef.current = false;
      setLabelingBusy(false);
    }
  }

  function navigatePortal(target) {
    if (target === "upload") {
      if (directUploadEnabled) setIntakeOpen(true);
      else switchTab("clinical");
      return;
    }
    if (target === "analysis") {
      switchTab("clinical");
      return;
    }
    switchTab(target);
  }

  async function openHomeCase(item) {
    switchTab("clinical");
    if (item?.orthanc_id) await analyzePacsStudy(item);
    else await openResearchCase(item);
  }

  async function prepareAndOpenLabelingCase(item) {
    const ready = await prepareLabelingCase(item.id, {
      getCase: getAnnotationCase,
      getJob,
      seed: (caseId, jobId, revision) => seedAnnotationFromJob(caseId, jobId, revision, `Bearer ${account.token}`),
      readDraft: current => getDraft(draftKey(API_BASE, account.username, current.id)).catch(() => null),
    });
    setResearchCases(items => [ready, ...items.filter(existing => existing.id !== ready.id)]);
    setLabelingCaseId(ready.id);
    setWorkspaceCaseName(ready.patient_name || ready.name || "Study CT");
    switchTab("labeling");
    window.location.hash = `#labeling?case=${encodeURIComponent(ready.id)}`;
  }

  async function openLabelingCase(item) {
    if (!can(account,"label.edit") || labelingBusyRef.current) return;
    labelingBusyRef.current = true;
    setLabelingBusy(true);
    setError("");
    try {
      await prepareAndOpenLabelingCase(item);
    } catch (reason) {
      setError(`Không mở được công cụ gán nhãn: ${reason.message}`);
    } finally {
      labelingBusyRef.current = false;
      setLabelingBusy(false);
    }
  }

  function returnToCaseLibrary() {
    setLabelingCaseId(null);
    setWorkspaceCaseName("");
    reset();
    switchTab("clinical");
  }

  const clinicalResultVolume = job?.result?.hemorrhage_volume_ml ?? job?.result?.volume_ml;
  const clinicalResultScore = job?.result?.confidence ?? job?.result?.probability ?? job?.result?.ich_probability ?? job?.result?.inference?.confidence;

  if (workspaceTab === "home") return <div className="workstation app-shell portal-workstation">
    <HomeDashboard connection={connection} cases={researchCases} studies={studies} directUploadEnabled={directUploadEnabled} onNavigate={navigatePortal} onOpenCase={openHomeCase} onLabelCase={openLabelingCase}/>
    {intakeOpen && <DicomIntakeDialog aiAvailable={aiAvailable && can(account,"inference.create")} onClose={() => setIntakeOpen(false)} onComplete={acceptDicomImport}/>} 
  </div>;

  if (workspaceTab === "settings") return <div className="workstation app-shell portal-workstation"><SettingsDashboard connection={connection} onNavigate={navigatePortal}/></div>;

  return (
    <div className={`workstation app-shell workspace-workstation module-${workspaceTab}`}>
      {workspaceTab === "clinical" && <section className="clinical-small-screen-block" role="alert" aria-live="polite">
        <Icon name="alert" size={38}/>
        <h1>Cần màn hình workstation lớn hơn</h1>
        <p>Đọc CT và xác nhận AI không an toàn trên màn hình hẹp. Hãy mở BrainHem trên màn hình desktop rộng tối thiểu 768 px.</p>
      </section>}
      <WorkspaceRail active={workspaceTab === "labeling" ? "clinical" : workspaceTab} onNavigate={navigatePortal}/>
      <div className="app-main">
        <WorkspaceGlobalHeader active={workspaceTab} caseName={workspaceTab === "labeling" ? workspaceCaseName : researchCase?.patient_name || researchCase?.name || selectedStudy?.patient_name} connection={connection} onNavigate={navigatePortal}/>
        <div className="workspace-mobile-actions">
            {workspaceTab === "clinical" && (
              <button
                className="mobile-toggle rail-toggle"
                type="button"
                onClick={() => setRailOpen(!railOpen)}
                aria-label="Mở worklist"
              >
                <Icon name="menu" size={19} />
              </button>
            )}
            {workspaceTab === "clinical" && (
              <button className={`mobile-toggle findings-toggle ${file ? "has-study" : ""} ${panelOpen ? "active" : ""}`} type="button" onClick={() => setPanelOpen(!panelOpen)} aria-label={panelOpen ? "Ẩn kết quả AI" : "Mở kết quả AI"} title={panelOpen ? "Ẩn kết quả AI" : "Mở kết quả AI"}>
                <Icon name="panel" size={19} />
                <span>Kết quả AI</span>
              </button>
            )}
          </div>

        {workspaceTab === "labeling" ? (
          <div className="work-area labeling-mode">
            <Suspense fallback={<div className="viewer-module-loading">Đang tải không gian gán nhãn…</div>}>
              <AnnotationWorkspace
                onSwitchToWorkstation={returnToCaseLibrary}
                onRegisterBeforeLeave={registerAnnotationLeave}
                initialCaseId={labelingCaseId}
                onCaseChange={(item) => setWorkspaceCaseName(item?.patient_name || item?.name || "")}
              />
            </Suspense>
          </div>
        ) : workspaceTab === "training" ? (
          <div className="work-area training-mode">
            <Suspense fallback={<div className="viewer-module-loading">Đang tải Studio Train Model…</div>}>
              <TrainingWorkspace onNavigate={switchTab} onOpenLabelCase={openLabelingCase} />
            </Suspense>
          </div>
        ) : !researchCase && !selectedStudy && !file && !researchLoading ? (
          <UnifiedCaseLibrary
            cases={researchCases}
            loading={researchLoading}
            onOpen={openResearchCase}
            onEdit={can(account,"label.edit")?openLabelingCase:undefined}
            onImport={() => setIntakeOpen(true)}
            uploadEnabled={directUploadEnabled && can(account,"case.ingest")}
          />
        ) : (
          <div className={`work-area clinical-mode ${file ? "reading-focus" : ""} ${panelOpen ? "show-findings" : ""} ${worklistVisible ? "" : "worklist-collapsed"}`}>
            <div className={`mobile-scrim ${railOpen || panelOpen ? "show" : ""}`} onClick={() => { setRailOpen(false); setPanelOpen(false); }} />
            <div className={`rail-wrap ${railOpen ? "open" : ""}`}>
              <CaseRail
                job={job}
                busy={busy}
                onReset={reset}
                researchCases={researchCases} researchCase={researchCase} onResearch={openResearchCase}
                studies={studies}
                pacsEnabled={pacsEnabled}
                pacsLoading={pacsLoading}
                onStudy={analyzePacsStudy}
                onRefresh={() => refreshStudies()}
                uploadEnabled={directUploadEnabled && can(account,"case.ingest")}
                onImport={() => setIntakeOpen(true)}
                onCollapse={() => setWorklistVisible(false)}
              />
            </div>
            {!worklistVisible&&<button className="worklist-dock-toggle" type="button" onClick={()=>setWorklistVisible(true)} aria-label="Hiện Thư viện CT" title="Hiện Thư viện CT"><Icon name="menu" size={16}/><span>Thư viện CT</span></button>}
            <Viewport
              file={file}
              job={job}
              progress={displayProgress}
              researchMode={Boolean(researchCase) || !pacsEnabled}
              researchCase={researchCase}
              studyMeta={researchCase || selectedStudy}
              onLocationChange={setViewportLocation}
              onCaseStep={stepClinicalCase}
              onEdit={can(account,"label.edit")?editClinicalCase:undefined}
              labelingBusy={labelingBusy}
              error={error}
              onRetry={() => researchCase && openResearchCase(researchCase)}
            />
            {file && !panelOpen && <button className={`findings-dock-toggle ${job?.status==="completed"?"has-result":""}`} type="button" onClick={()=>setPanelOpen(true)} aria-expanded="false" aria-label="Mở bảng kết quả AI">
              <Icon name="panel" size={16}/><span>{job?.status==="completed"?"AI":"Kết quả AI"}</span>{job?.status==="completed"&&clinicalResultVolume!=null&&<strong>{Number(clinicalResultVolume).toFixed(1)} mL</strong>}{job?.status==="completed"&&clinicalResultScore!=null&&<small>{Number(clinicalResultScore).toFixed(2)}</small>}<i/>
            </button>}
            <div className={`panel-wrap ${panelOpen ? "open" : ""}`}>
              <FindingsPanel
                file={file}
                job={file ? job : null}
                busy={busy}
                progress={displayProgress}
                error={file ? error : ""}
                researchMode={Boolean(researchCase) || !pacsEnabled} researchCase={researchCase} onPredict={predictResearchCase} aiAvailable={aiAvailable && can(account,"inference.create")}
                aiTier={aiTier} onAiTier={setAiTier} aiTiers={aiTiers}
                aiTta={aiTta} onAiTta={setAiTta}
                onReview={submitReview}
                onEdit={can(account,"label.edit")?editClinicalCase:undefined}
                reviewBusy={reviewBusy}
                onClose={()=>setPanelOpen(false)}
              />
            </div>
          </div>
        )}

        <footer className="statusbar">
          <div>
            <ConnectionStatus state={connection} compact />
            <span>{API_BASE || "Same-origin API"}</span>
          </div>
          <div className="status-center">
            {viewportLocation ? (
              <>
                Crosshair&nbsp;
                <code>
                  X {viewportLocation.mm?.[0]?.toFixed?.(1) ?? "—"} ·
                  Y {viewportLocation.mm?.[1]?.toFixed?.(1) ?? "—"} ·
                  Z {viewportLocation.mm?.[2]?.toFixed?.(1) ?? "—"} mm
                </code>
              </>
            ) : job?.id ? (
              <>Tác vụ <code>{job.id}</code></>
            ) : (
              "Không gian nghiên cứu"
            )}
          </div>
          <div>
            <Icon name="shield" size={14} />
            <span>Dữ liệu nghiên cứu đã ẩn danh</span>
            <b>v0.1 MVP</b>
          </div>
        </footer>
        {intakeOpen && <DicomIntakeDialog aiAvailable={aiAvailable && can(account,"inference.create")} onClose={() => setIntakeOpen(false)} onComplete={acceptDicomImport} />}
      </div>
    </div>
  );
}
import { displayName, sortCases, hasAiResult, hasApprovedLabel } from "./caseLibrary";
