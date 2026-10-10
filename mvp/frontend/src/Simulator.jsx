import { useEffect, useMemo, useState } from "react";
import { healthCheck, sendSimulatorAcquisition } from "./api";
import { Icon } from "./icons";
import { useAppAuth } from "./components/AppAuth";
import "./simulator.css";

function bytes(value = 0) {
  if (!value) return "—";
  const unit = value > 1024 ** 2 ? "MB" : "KB";
  const divisor = unit === "MB" ? 1024 ** 2 : 1024;
  return `${(value / divisor).toFixed(1)} ${unit}`;
}

export default function Simulator() {
  const { account, logout } = useAppAuth();
  const [health, setHealth] = useState(null);
  const [file, setFile] = useState(null);
  const [patientId, setPatientId] = useState(`ANON-SIM-${String(Date.now()).slice(-6)}`);
  const [state, setState] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const ready = useMemo(
    () => Boolean(file && /^ANON-[A-Z0-9-]{1,32}$/.test(patientId) && state !== "sending"),
    [file, patientId, state],
  );

  useEffect(() => {
    healthCheck()
      .then(setHealth)
      .catch((reason) => setError(reason.message));
  }, []);

  async function send() {
    if (!ready) return;
    setState("sending");
    setProgress(0);
    setResult(null);
    setError("");
    try {
      const payload = await sendSimulatorAcquisition(file, patientId, setProgress);
      setResult(payload);
      setProgress(100);
      setState("stored");
    } catch (reason) {
      setState("failed");
      setError(reason.message);
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
    setError("");
    setProgress(0);
    setState("idle");
    setPatientId(`ANON-SIM-${String(Date.now()).slice(-6)}`);
  }

  return (
    <main className="modality-console">
      <header className="modality-header">
        <div className="modality-brand">
          <span><Icon name="scan" size={22} /></span>
          <div><b>BrainHem CT</b><small>Modality Simulator · Research</small></div>
        </div>
        <div className="modality-system-state">
          <i className={health?.simulator_enabled ? "online" : "offline"} />
          <span>{health?.simulator_enabled ? "DICOM services ready" : "Simulator unavailable"}</span>
        </div>
        <div className="simulator-account"><span>{account.username} · {account.role}</span><button type="button" onClick={logout}>Đăng xuất</button><a href="/" className="workstation-link">Radiology workstation <Icon name="chevron" size={15} /></a></div>
      </header>

      <section className="modality-layout">
        <aside className="exam-panel">
          <p className="console-kicker">Scheduled exam</p>
          <h1>CT Head Without Contrast</h1>
          <dl>
            <div><dt>Modality</dt><dd>CT</dd></div>
            <div><dt>Protocol</dt><dd>HEAD_NCCT_5MM</dd></div>
            <div><dt>Position</dt><dd>HFS</dd></div>
            <div><dt>Calling AE</dt><dd>CT_SIMULATOR</dd></div>
            <div><dt>Called AE</dt><dd>BRAINHEM_PACS</dd></div>
          </dl>
          <label className="patient-id-field">
            <span>Anonymized Patient ID</span>
            <input
              value={patientId}
              disabled={state === "sending"}
              onChange={(event) => setPatientId(event.target.value.toUpperCase())}
              maxLength={37}
            />
            <small>Demo bắt buộc dùng mã bắt đầu bằng ANON-</small>
          </label>
        </aside>

        <section className="acquisition-console">
          <div className="gantry-visual" aria-label="CT gantry simulator">
            <div className="gantry-ring"><div className="gantry-bore"><Icon name="scan" size={46} /></div></div>
            <div className="patient-table"><i /></div>
            <span className="laser-line" />
          </div>

          <div className="acquisition-strip">
            <div><span>Series</span><b>1 · Head NCCT Brain</b></div>
            <div><span>Kernel</span><b>STANDARD</b></div>
            <div><span>Recon</span><b>AXIAL · HU</b></div>
            <div><span>Destination</span><b>BRAINHEM_PACS</b></div>
          </div>

          <section className="source-fixture">
            <div>
              <p className="console-kicker">Research acquisition source</p>
              <h2>{file ? file.name : "Chưa nạp acquisition fixture"}</h2>
              <span>
                {file
                  ? `${bytes(file.size)} · NIfTI sẽ được simulator chuyển thành CT DICOM instances`
                  : "Chỉ kỹ thuật viên/demo operator thao tác tại console này; bác sĩ không upload file."}
              </span>
            </div>
            <label className="load-fixture">
              <Icon name="file" size={17} />
              {file ? "Đổi fixture" : "Nạp fixture ẩn danh"}
              <input
                type="file"
                accept=".nii,.nii.gz,application/gzip,application/octet-stream"
                disabled={state === "sending"}
                onChange={(event) => {
                  setFile(event.target.files?.[0] || null);
                  setResult(null);
                  setError("");
                  setState("idle");
                }}
              />
            </label>
          </section>

          {(state === "sending" || state === "stored") && (
            <div className={`transfer-progress ${state}`}>
              <div><span>{state === "stored" ? "C-STORE complete" : "Đang tạo và gửi DICOM C-STORE…"}</span><b>{progress}%</b></div>
              <div><i style={{ width: `${progress}%` }} /></div>
            </div>
          )}
          {error && <p className="simulator-error"><Icon name="alert" size={16} /> {error}</p>}
          {result && (
            <div className="store-result">
              <Icon name="check" size={21} />
              <div>
                <b>{result.instances_sent} DICOM instances đã được PACS nhận</b>
                <span>Accession {result.accession_number} · Study UID {result.study_instance_uid}</span>
                <small>{result.auto_inference ? `AI ${String(result.auto_inference.tier).toUpperCase()} đã tự xếp hàng · Job ${result.auto_inference.job_id.slice(0, 8)}` : `Chuyển sang workstation, làm mới worklist và chọn study của ${result.patient_id}.`}</small>
              </div>
            </div>
          )}

          <footer className="console-actions">
            <button type="button" className="secondary-action" onClick={reset} disabled={state === "sending"}>New exam</button>
            <button type="button" className="send-action" onClick={send} disabled={!ready || !health?.simulator_enabled}>
              <Icon name="upload" size={18} /> Send acquisition to PACS
            </button>
          </footer>
        </section>
      </section>
    </main>
  );
}
