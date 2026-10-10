import { useMemo, useRef, useState } from "react";
import { uploadDicomCase } from "../api";
import { Icon } from "../icons";
import "./DicomIntakeDialog.css";

function formatBytes(value) {
  if (!value) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function DicomIntakeDialog({ aiAvailable, onClose, onComplete }) {
  const folderInput = useRef(null);
  const filesInput = useRef(null);
  const [files, setFiles] = useState([]);
  const [priority, setPriority] = useState("routine");
  const [clinicalIndication, setClinicalIndication] = useState("");
  const [autoAnalyze, setAutoAnalyze] = useState(Boolean(aiAvailable));
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  function choose(nextFiles) {
    const chosen = Array.from(nextFiles || []).filter((file) => file.size > 0);
    setFiles(chosen);
    setError("");
  }

  async function submit() {
    if (!files.length || state === "uploading") return;
    setState("uploading");
    setProgress(0);
    setError("");
    try {
      const created = await uploadDicomCase(
        files,
        { priority, clinicalIndication },
        setProgress,
      );
      setProgress(100);
      setState("complete");
      await onComplete(created, autoAnalyze && aiAvailable);
    } catch (reason) {
      setState("idle");
      setError(reason.message);
    }
  }

  return (
    <div className="dicom-intake-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && state !== "uploading" && onClose()}>
      <section className="dicom-intake" role="dialog" aria-modal="true" aria-labelledby="dicom-intake-title">
        <header>
          <div className="intake-title-icon"><Icon name="upload" size={20} /></div>
          <div><span>CA NGOÀI HỆ THỐNG</span><h2 id="dicom-intake-title">Tiếp nhận CT não</h2></div>
          <button type="button" aria-label="Đóng" onClick={onClose} disabled={state === "uploading"}>×</button>
        </header>

        <div className="intake-flow" aria-label="Quy trình tiếp nhận">
          <div className="active"><i>1</i><span><b>Nhận dữ liệu CT</b><small>DICOM hoặc NIfTI</small></span></div>
          <em />
          <div><i>2</i><span><b>Dựng volume</b><small>Tự chọn series não</small></span></div>
          <em />
          <div><i>3</i><span><b>Mở để đọc</b><small>AI chạy nền nếu có</small></span></div>
        </div>

        <div
          className={`dicom-dropzone ${dragging ? "dragging" : ""} ${files.length ? "has-files" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}
        >
          <Icon name={files.length ? "check" : "inbox"} size={28} />
          {files.length ? (
            <><b>Đã chọn {files.length} file</b><span>{formatBytes(totalBytes)} · hệ thống sẽ kiểm tra Study và tự chọn series</span></>
          ) : (
            <><b>Thả ca CT vào đây</b><span>Nhận thư mục DICOM, ZIP DICOM hoặc một file NIfTI .nii/.nii.gz</span></>
          )}
          <div className="dicom-picker-actions">
            <button type="button" onClick={() => folderInput.current?.click()}><Icon name="file" size={15} /> Chọn thư mục</button>
            <button type="button" onClick={() => filesInput.current?.click()}>Chọn file / ZIP</button>
          </div>
          <input ref={folderInput} type="file" multiple webkitdirectory="" onChange={(event) => choose(event.target.files)} />
          <input ref={filesInput} type="file" multiple accept=".dcm,.dicom,.nii,.nii.gz,.zip,application/dicom,application/gzip,application/zip,application/octet-stream" onChange={(event) => choose(event.target.files)} />
        </div>

        <div className="intake-fields">
          <fieldset>
            <legend>Mức ưu tiên</legend>
            <div className="priority-options">
              {[['routine', 'Thường quy'], ['urgent', 'Khẩn'], ['stat', 'Cấp cứu']].map(([value, label]) => (
                <button key={value} type="button" className={priority === value ? "active" : ""} onClick={() => setPriority(value)}>{label}</button>
              ))}
            </div>
          </fieldset>
          <label>
            <span>Chỉ định lâm sàng <small>không bắt buộc</small></span>
            <textarea value={clinicalIndication} onChange={(event) => setClinicalIndication(event.target.value)} maxLength={1000} placeholder="Ví dụ: đau đầu đột ngột, yếu nửa người trái; loại trừ xuất huyết nội sọ…" />
          </label>
          <label className={`auto-ai ${!aiAvailable ? "disabled" : ""}`}>
            <input type="checkbox" checked={autoAnalyze && aiAvailable} disabled={!aiAvailable} onChange={(event) => setAutoAnalyze(event.target.checked)} />
            <span><b>Tự phân tích AI sau khi nhận ca</b><small>{aiAvailable ? "Ca vẫn mở ngay; kết quả xuất hiện khi xử lý xong." : "Dịch vụ AI hiện chưa kết nối; vẫn có thể mở và đọc CT."}</small></span>
          </label>
        </div>

        {state === "uploading" && <div className="intake-progress"><div><span>{progress < 100 ? "Đang gửi DICOM…" : "Đang dựng volume CT…"}</span><b>{progress}%</b></div><i><span style={{ width: `${progress}%` }} /></i></div>}
        {error && <p className="intake-error"><Icon name="alert" size={15} /> {error}</p>}

        <footer>
          <p><Icon name="shield" size={14} /> Dữ liệu được xử lý trong máy chủ BrainHem đang kết nối.</p>
          <div><button type="button" className="intake-cancel" onClick={onClose} disabled={state === "uploading"}>Hủy</button><button type="button" className="intake-submit" onClick={submit} disabled={!files.length || state === "uploading"}>{state === "uploading" ? "Đang tiếp nhận…" : "Tiếp nhận và mở ca"}<Icon name="chevron" size={15} /></button></div>
        </footer>
      </section>
    </div>
  );
}
