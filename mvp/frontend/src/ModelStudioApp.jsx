import { useEffect, useState } from "react";
import TrainingWorkspace from "./components/TrainingWorkspace";
import { Icon } from "./icons";
import { useAppAuth } from "./components/AppAuth";

function leaveStudio(target = "home") {
  window.location.assign(target === "home" ? "/#home" : `/#${target}`);
}

export default function ModelStudioApp() {
  const { account, logout } = useAppAuth();
  const [section, setSection] = useState("overview");
  const [trainingOpen, setTrainingOpen] = useState(true);
  const openSection = (next) => {
    if (["runs", "learning"].includes(next)) next = "fine_tune";
    setSection(next);
    if (["fine_tune", "learning", "postprocess", "datasets", "runs"].includes(next)) setTrainingOpen(true);
    window.dispatchEvent(new CustomEvent("brainhem:studio-tab", { detail: next }));
  };
  useEffect(() => {
    const syncSection = (event) => setSection(["runs", "learning"].includes(event.detail) ? "fine_tune" : event.detail);
    window.addEventListener("brainhem:studio-tab-state", syncSection);
    return () => window.removeEventListener("brainhem:studio-tab-state", syncSection);
  }, []);
  return (
    <div className="model-studio-web">
      <aside className="model-studio-side">
        <button className="model-studio-brand" type="button" onClick={() => leaveStudio()}>
          <span><Icon name="cube" size={23} /></span>
          <strong>AI Studio</strong>
          <small>Dữ liệu → Model</small>
        </button>
        <div className="model-studio-side-copy">
          <span>QUẢN LÝ MODEL</span>
          <p>Quản lý dữ liệu và kết quả. Baseline S chỉ có ONNX; Fine-tune chưa khả dụng.</p>
        </div>
        <nav aria-label="Điều hướng Model Studio">
          <button className={section === "overview" ? "active" : ""} type="button" onClick={() => openSection("overview")}><Icon name="home" size={17} /> Tổng quan</button>
          <div className={`model-studio-nav-group ${trainingOpen ? "open" : ""}`}>
            <button className={["fine_tune","learning","postprocess","datasets","runs"].includes(section) ? "active" : ""} type="button" aria-expanded={trainingOpen} onClick={() => setTrainingOpen(value => !value)}><Icon name="chart" size={17} /><span>Huấn luyện</span><Icon name="chevron" size={13} /></button>
            {trainingOpen && <div className="model-studio-subnav">
              <button className={section === "datasets" ? "active" : ""} type="button" onClick={() => openSection("datasets")}><i /> Dữ liệu Fine-tune</button>
              <button className={["fine_tune","learning","runs"].includes(section) ? "active" : ""} type="button" onClick={() => openSection("fine_tune")}><i /> Fine-tune & đánh giá</button>
              <button className={section === "postprocess" ? "active" : ""} type="button" onClick={() => openSection("postprocess")}><i /> Tinh chỉnh Postprocess</button>
            </div>}
          </div>
          <button className={["validation","registry"].includes(section) ? "active" : ""} type="button" onClick={() => openSection("registry")}><Icon name="cube" size={17} /> Model</button>
          <button className={section === "hardware" ? "active" : ""} type="button" onClick={() => openSection("hardware")}><Icon name="hardware" size={17} /> Hệ thống</button>
          <button type="button" onClick={() => window.open("/guide#studio", "_blank", "noopener,noreferrer")}><Icon name="help" size={17} /> Hướng dẫn sử dụng</button>
          <button type="button" onClick={() => window.open("/feedback", "_blank", "noopener,noreferrer")}><Icon name="inbox" size={17} /> Gửi phản hồi</button>
        </nav>
        <button className="model-studio-back" type="button" onClick={() => leaveStudio()}><Icon name="chevron" size={15} /> Về BrainHem Clinical</button>
      </aside>
      <main className="model-studio-main" id="model-studio-content">
        <div className="model-studio-topbar">
          <div><span className="model-studio-kicker">BrainHem / AI Studio</span><strong>Dữ liệu · Huấn luyện · Model</strong></div>
          <div className="model-studio-session"><span className="model-studio-status"><i /> {account.username} · {account.role}</span><button type="button" onClick={logout}>Đăng xuất</button></div>
        </div>
        <div className="studio-mobile-nav"><label>AI Studio<select aria-label="Điều hướng AI Studio" value={section} onChange={e=>openSection(e.target.value)}>{[["overview","Tổng quan"],["datasets","Dữ liệu Fine-tune"],["fine_tune","Huấn luyện"],["registry","Model"],["postprocess","Postprocess"],["hardware","Hệ thống"]].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><button onClick={()=>leaveStudio("clinical")}>Về dữ liệu</button></div>
        <TrainingWorkspace onNavigate={(target) => leaveStudio(target === "labeling" ? "labeling" : "clinical")} onOpenLabelCase={(item) => window.location.assign(`/#labeling?case=${encodeURIComponent(item.id)}`)} />
      </main>
    </div>
  );
}
