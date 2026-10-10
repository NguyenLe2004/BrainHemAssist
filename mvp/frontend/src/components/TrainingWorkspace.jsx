import { trainingAvailable, TrainingUnavailable, isInferenceOnlyModel } from "../trainingAvailability";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listLearningCandidates, transitionLearningCandidate, addPeerReview, adjudicateCandidate,
  getMlopsCapabilities, listDatasetVersions, createDatasetVersion, downloadDatasetArtifact,
  listTrainingRuns, createTrainingRun, validateTrainingRun, downloadTrainingLog,
  listModels, approveModel, transitionModel, uploadShadowEvidence, getMlopsHardware, getCapabilities,
  getMlopsAutomation, updateMlopsAutomation,
} from "../api";
import { Icon } from "../icons";
import { useAppAuth } from "./AppAuth";
import StudioWorkflow from "./StudioWorkflow";
import {getStudioCatalog} from "../api";

const LABEL = {flagged:"Mới flag",triaged:"Đã phân loại",annotation:"Cần gán nhãn",peer_review:"Hội chẩn",adjudication:"Chờ phân xử",gold:"Gold",excluded:"Đã loại",queued:"Đang chờ",running:"Đang train",succeeded:"Đã train",validation_queued:"Chờ kiểm định",validating:"Đang kiểm định",validated:"Đã kiểm định",failed:"Lỗi",candidate:"Candidate",technical_validated:"Technical QA",clinical_validated:"Clinical QA",shadow:"Shadow",production:"Production",archived:"Archived",rejected:"Rejected",configured:"Đã cấu hình","not-configured":"Chưa cấu hình","no-production":"Chưa có model"};
const Json=({value})=><pre className="tw-json">{JSON.stringify(value||{},null,2)}</pre>;
const Status=({value})=><span className={`tw-status status-${value}`}>{LABEL[value]||value}</span>;

function shortDate(value) { if(!value)return "—";const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString("vi-VN",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function candidateNoteParts(item) { return String(item?.note||"").split("·").map(value=>value.trim()).filter(Boolean); }
function candidateName(item) { const parts=candidateNoteParts(item);return item?.annotation?.name||(parts[0]==="Dataset"&&parts[1]?parts[1]:item.id.slice(0,8).toUpperCase()); }
function candidateSource(item) { const parts=candidateNoteParts(item);return parts[0]==="Dataset"?"Dataset":item.annotation_case_id?"Expert":"AI"; }
function learningSignal(item) { return item?.active_learning||{score:0,band:"low",confidence:null,explanations:["Chưa có đủ tín hiệu"]}; }
function uiName(value) { return String(value||"").replace(/active[ _-]?learning/gi,"Fine-tune").replace(/\s*[·•—-]?\s*automated\s+50-case\s+E2E/gi,"").replace(/\s*[·•—-]?\s*E2E\b/gi,"").trim(); }
function saveBlob(blob,name) { const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function EmptyState({icon="inbox",title,body,action}) {return <div className="mlops-empty"><span><Icon name={icon} size={23}/></span><strong>{title}</strong><p>{body}</p>{action}</div>}

export default function TrainingWorkspace({onNavigate,onOpenLabelCase}) {
  const {account,authorization}=useAppAuth();
  const actor=account?.username||"";
  const [tab,setTab]=useState(()=>{try{const requested=sessionStorage.getItem("brainhem.studio-open");sessionStorage.removeItem("brainhem.studio-open");return ["overview","fine_tune","learning","postprocess","datasets","runs","validation","registry","hardware"].includes(requested)?requested:"overview";}catch{return "overview";}}),[data,setData]=useState({learning:[],datasets:[],runs:[],models:[],caps:{},inference:{}});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[selected,setSelected]=useState(null);
  const refresh=useCallback(async()=>{try{const [learning,datasets,runs,models,caps,inference,studio,automation]=await Promise.all([listLearningCandidates(),listDatasetVersions(),listTrainingRuns(),listModels(),getMlopsCapabilities(),getCapabilities(),getStudioCatalog(),getMlopsAutomation()]);setData({learning:learning.items||[],datasets:datasets.items||[],runs:runs.items||[],models:models.items||[],caps,inference,studio,automation});}catch(e){setError(e.message);}},[]);
  useEffect(()=>{refresh();const timer=setInterval(refresh,5000);return()=>clearInterval(timer);},[refresh]);
  useEffect(()=>{const open=event=>setTab(event.detail);window.addEventListener("brainhem:studio-tab",open);return()=>window.removeEventListener("brainhem:studio-tab",open);},[]);
  useEffect(()=>{window.dispatchEvent(new CustomEvent("brainhem:studio-tab-state",{detail:tab}));},[tab]);
  async function act(work){setBusy(true);setError("");try{await work();await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
  const requireActor=()=>{if(!actor.trim()||!authorization){setError("Phiên BrainHem đã hết hạn. Hãy đăng nhập lại để thay đổi workflow.");return false;}return true;};
  useEffect(()=>{if(tab==="runs")setTab("fine_tune");},[tab]);
  return <div className="training-workspace mlops-workspace">
    <div className="mlops-control-strip"><span className={trainingAvailable(data.caps)&&data.caps.worker_alive?"online":"offline"}><i/>{trainingAvailable(data.caps)?data.caps.worker_alive?"Training extension đã kết nối":"Training extension ngoại tuyến":"Fine-tune chưa khả dụng · Baseline S chỉ có ONNX"}</span></div>
    {error&&<div className="mlops-error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
    <main className="mlops-content">{["overview","datasets","fine_tune","learning","runs","registry"].includes(tab)&&<StudioWorkflow tab={tab} data={data} openTab={setTab} actor={actor} authorization={authorization} busy={busy} run={act} requireActor={requireActor} onNavigate={onNavigate}/>} {tab==="postprocess"&&<RunsPanel fixedMode="postprocess_calibration" items={data.runs} datasets={data.datasets} models={data.models} caps={data.caps} actor={actor} authorization={authorization} busy={busy} run={act} requireActor={requireActor}/>} {tab==="validation"&&<ValidationPanel runs={data.runs} models={data.models} caps={data.caps} authorization={authorization} busy={busy} run={act} requireActor={requireActor}/>} {tab==="hardware"&&<HardwarePanel/>}</main>
  </div>;
}

function FineTunePanel({items,datasets,runs,models,caps,busy,actor,authorization,run,requireActor,openTab}) {
  const fineTuneRuns=runs.filter(item=>item.mode==="fine_tune"||/active[ -]?learning/i.test(`${item.name} ${item.metrics?.dataset_name||""}`));
  const current=fineTuneRuns.find(item=>["queued","running","validation_queued","validating"].includes(item.status))||fineTuneRuns[0]||null;
  const candidate=current?.model_id?models.find(model=>model.id===current.model_id):null;
  const metrics=candidate?.metrics||current?.metrics||{};
  const gate=metrics.validation_gate;
  const active=Boolean(current&&["queued","running","validation_queued","validating"].includes(current.status));
  const canValidate=Boolean(current&&["succeeded","failed"].includes(current.status));
  const gateState=gate?.passed===true?"pass":gate?"fail":active?"running":"pending";
  const gateCopy={pass:"Đạt gate — chờ phê duyệt",fail:"Không đạt — giữ model gốc",running:"Đang huấn luyện",pending:"Chưa kiểm định"}[gateState];
  return <section className="simple-studio-page fine-tune-simple-page">
    <SimplePageHead eyebrow="HUẤN LUYỆN CÓ KIỂM SOÁT" title="Fine-tune model" body="Chọn dataset đã chuẩn bị, train một model ứng viên, kiểm định rồi mới quyết định cập nhật." status={<span className={`tw-status gate-${gateState}`}>{gateCopy}</span>}/>
    <div className="fine-tune-flow" aria-label="Quy trình Fine-tune"><span className="active"><b>1</b>Fine-tune</span><i>→</i><span><b>2</b>Quality gate</span><i>→</i><span><b>3</b>Duyệt cập nhật</span></div>
    <TrainingRunLauncher mode="fine_tune" datasets={datasets} models={models} caps={caps} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor} rootModelsOnly/>
    <article className={`premium-card promotion-gate-card ${gateState}`}>
      <header><span className="setup-step">2</span><div><small>QUALITY GATE</small><h3>{gateCopy}</h3><p>Model đang dùng không bị thay đổi cho tới khi ứng viên đạt kiểm định và hoàn tất các bước duyệt.</p></div><span className={`gate-indicator ${gateState}`}><i/>{gateState==="pass"?"PASS":gateState==="fail"?"FAIL":"PENDING"}</span></header>
      <div className="gate-metrics"><div><span>Dice</span><strong>{metrics.mean_dice?.toFixed?.(3)??"—"}</strong><small>Yêu cầu ≥ {Number(metrics.quality_gate?.dice??.5).toFixed(2)}</small></div><div><span>Recall</span><strong>{metrics.lesion_recall?.toFixed?.(3)??"—"}</strong><small>Yêu cầu ≥ {Number(metrics.quality_gate?.recall??.8).toFixed(2)}</small></div><div><span>Model gốc</span><strong>{candidate?.parent_model_id?`Model ${candidate.parent_model_id.slice(0,8).toUpperCase()}`:"Giữ nguyên"}</strong><small>Đang phục vụ hiện tại</small></div><div><span>Ứng viên</span><strong>{candidate?`Model ${candidate.id.slice(0,8).toUpperCase()}`:"—"}</strong><small>Chưa được đưa vào sử dụng</small></div></div>
      <footer><div><b>Quy tắc cập nhật</b><small>Gate đạt → duyệt chuyên môn → duyệt phát hành → chạy Shadow → Production.</small></div>{canValidate&&<button className="mlops-primary" disabled={busy||!caps.validation_configured} onClick={()=>requireActor()&&run(()=>validateTrainingRun(current.id,authorization))}><Icon name="shield" size={14}/> {current.status==="failed"?"Chạy lại kiểm định":"Chạy kiểm định"}</button>}{gateState==="pass"&&<button className="mlops-primary" onClick={()=>openTab("registry")}><Icon name="chevron" size={14}/> Mở bước phê duyệt</button>}</footer>
    </article>
    {current&&<details className="premium-card studio-reveal fine-tune-result-details"><summary><span><Icon name="chart" size={16}/><b>Xem biểu đồ và metric lần chạy gần nhất</b><small>{current.name} · {LABEL[current.status]||current.status} · {shortDate(current.updated_at)}</small></span><Icon name="chevron" size={14}/></summary><CurrentRunCard run={current} caps={caps} eyebrow="CHI TIẾT LẦN CHẠY" title="Kết quả Fine-tune"/></details>}
    {fineTuneRuns.length>0&&<details className="premium-card studio-history"><summary>Lịch sử Fine-tune <span>{fineTuneRuns.length}</span></summary><div>{fineTuneRuns.map(item=>{const model=item.model_id?models.find(value=>value.id===item.model_id):null;const itemGate=(model?.metrics||item.metrics||{}).validation_gate;return <article key={item.id}><div><b>{uiName(item.name)}</b><small>{shortDate(item.updated_at)} · dataset {(item.metrics?.dataset_version)||"—"} · model gốc {item.base_model_id?.slice(0,8).toUpperCase()||"—"}</small></div><span className={`tw-status ${itemGate?.passed?"status-validated":itemGate?"status-failed":`status-${item.status}`}`}>{itemGate?.passed?"Gate đạt":itemGate?"Gate không đạt":LABEL[item.status]||item.status}</span></article>})}</div></details>}
  </section>;
}

function StudioOverview({data,openTab,actor,authorization}) {
  const currentRun=data.runs.find(x=>["running","queued","validation_queued","validating"].includes(x.status))||data.runs[0]||null;
  const latestDataset=data.datasets[0]||null;
  const production=data.models.find(x=>x.stage==="production")||null;
  const candidate=data.models.find(x=>x.stage!=="archived"&&x.stage!=="rejected")||null;
  const inferenceTier=data.inference?.tiers?.[data.inference?.default_tier]||null;
  const metrics=currentRun?.metrics||candidate?.metrics||{};
  const progress=metrics.live_progress;
  const splits=latestDataset?.manifest?.splits||{};
  const splitCount=key=>Array.isArray(splits[key])?splits[key].length:0;
  const active=Boolean(currentRun&&["running","queued","validation_queued","validating"].includes(currentRun.status));
  const runGate=currentRun?.metrics?.validation_gate||candidate?.metrics?.validation_gate;
  const latestRunResult=!currentRun?"Chưa có":runGate?.passed===true?"Đạt Quality gate":runGate?"Không đạt Quality gate":LABEL[currentRun.status]||currentRun.status;
  const events=useMemo(()=>[
    ...data.datasets.map(x=>({icon:"database",title:`Dataset ${x.version} đã đóng băng`,detail:`${x.num_cases} ca · ${uiName(x.name)}`,at:x.created_at})),
    ...data.runs.map(x=>({icon:"chart",title:`Run ${uiName(x.name)}`,detail:LABEL[x.status]||x.status,at:x.updated_at||x.created_at})),
    ...data.models.map(x=>({icon:"cube",title:`Model ${x.name}`,detail:LABEL[x.stage]||x.stage,at:x.updated_at||x.created_at})),
  ].sort((a,b)=>String(b.at||"").localeCompare(String(a.at||""))).slice(0,5),[data.datasets,data.runs,data.models]);
  return <section className="studio-overview">
    <div className="studio-overview-head"><div><span className="mlops-eyebrow">OPERATIONS OVERVIEW</span><h2>Trạng thái AI Studio</h2><p>Model, dữ liệu và training hiện tại trong một màn hình.</p></div><time>Cập nhật {shortDate(events[0]?.at)}</time></div>
    <AutomationPolicy inference={data.inference} authorization={authorization}/>
    <div className="studio-status-grid">
      <article className="studio-status-card model"><header><span><Icon name="cube" size={18}/></span><div><small>MODEL ĐANG PHỤC VỤ CA</small><b className={inferenceTier?.available?"online":"pending"}>{inferenceTier?.available?"Đang hoạt động":"Không khả dụng"}</b></div></header><h3>{inferenceTier?`Model ${inferenceTier.name}`:"Chưa có model đọc ca"}</h3><p>Đây là model đang được Clinical Reading gọi khi bác sĩ chạy phân tích AI.</p><dl><div><dt>Đang dùng</dt><dd>{inferenceTier?`Model ${inferenceTier.name}`:"—"}</dd></div><div><dt>Model Studio cập nhật</dt><dd>{production?"Đã phát hành":"Chưa có"}</dd></div><div><dt>Trạng thái</dt><dd>{inferenceTier?.available?"Sẵn sàng":"Ngoại tuyến"}</dd></div></dl></article>
      <article className={`studio-status-card run ${active?"is-live":""}`}><header><span><Icon name="chart" size={18}/></span><div><small>HUẤN LUYỆN</small><b className={active?"online":"idle"}>{active?"Đang chạy":"Không chạy"}</b></div></header><h3>{active?currentRun.name:"Không có tiến trình đang chạy"}</h3><p>{currentRun?`Lần gần nhất: ${uiName(currentRun.name)} · ${latestRunResult}`:"Chưa có lịch sử Fine-tune."}</p>{active&&<div className="studio-run-progress"><span><b>{progress?`Epoch ${progress.epoch}/${progress.total_epochs}`:"Đang khởi tạo"}</b><em>{progress?`${progress.percent}%`:"…"}</em></span><progress max="100" value={progress?.percent||0}/></div>}<dl><div><dt>Kết quả gần nhất</dt><dd className={runGate?.passed?"metric-pass":runGate?"metric-fail":""}>{latestRunResult}</dd></div><div><dt>Validation Dice</dt><dd>{metrics.best_validation_dice?.toFixed?.(3)??"—"}</dd></div><div><dt>Test Dice</dt><dd>{metrics.mean_dice?.toFixed?.(3)??"—"}</dd></div></dl></article>
      <article className="studio-status-card dataset"><header><span><Icon name="database" size={18}/></span><div><small>DỮ LIỆU HUẤN LUYỆN</small><b className={latestDataset?"online":"pending"}>{latestDataset?"Sẵn sàng":"Chưa có"}</b></div></header><h3>{latestDataset?`${uiName(latestDataset.name)} · ${latestDataset.version}`:"Chưa có dataset"}</h3><p>{latestDataset?`${latestDataset.num_cases} ca đã khóa. Dataset này chỉ được dùng khi bắt đầu một lần Fine-tune.`:"Mở Huấn luyện → Dataset để tạo tập từ Gold label."}</p><div className="studio-split-bar"><i style={{width:`${latestDataset?.num_cases?splitCount("train")/latestDataset.num_cases*100:0}%`}}/><i style={{width:`${latestDataset?.num_cases?splitCount("validation")/latestDataset.num_cases*100:0}%`}}/><i style={{width:`${latestDataset?.num_cases?splitCount("test")/latestDataset.num_cases*100:0}%`}}/></div><dl><div><dt>Train</dt><dd>{splitCount("train")}</dd></div><div><dt>Validation</dt><dd>{splitCount("validation")}</dd></div><div><dt>Test khóa</dt><dd>{splitCount("test")}</dd></div></dl></article>
    </div>
    {events.length>0&&<details className="premium-card studio-history studio-overview-history"><summary>Lịch sử cập nhật <span>{events.length}</span></summary><div>{events.map((event,index)=><article key={`${event.title}-${index}`}><span><Icon name={event.icon} size={14}/></span><div><b>{event.title}</b><small>{event.detail} · {shortDate(event.at)}</small></div></article>)}</div></details>}
  </section>;
}

export function AutomationPolicy({inference,authorization,compact=false}) {
  const {account}=useAppAuth();
  const isAdmin=account.role==="admin";
  const [policy,setPolicy]=useState(null),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const load=useCallback(()=>getMlopsAutomation().then(value=>{setPolicy(value);setDraft(value);}).catch(error=>setMessage(error.message)),[]);
  useEffect(()=>{load();},[load]);
  async function save(){if(!isAdmin||!draft||!authorization)return;setBusy(true);setMessage("");try{const next=await updateMlopsAutomation({auto_analyze_ct:Boolean(draft.auto_analyze_ct),inference_tier:draft.inference_tier},authorization);setPolicy(next);setDraft({...next});setMessage("Đã áp dụng cho các ca CT tiếp nhận tiếp theo.");}catch(error){setMessage(error.message);}finally{setBusy(false);}}
  async function toggleCompact(){if(!isAdmin||!draft||!authorization||busy)return;const enabled=!draft.auto_analyze_ct;setBusy(true);setMessage("");try{const next=await updateMlopsAutomation({auto_analyze_ct:enabled,inference_tier:draft.inference_tier},authorization);setPolicy(next);setDraft({...next});}catch(error){setMessage(error.message);}finally{setBusy(false);}}
  const tiers=Object.entries(inference?.tiers||{});
  if(!draft)return compact?<button type="button" className="sw-auto-toggle" disabled>Đang tải chế độ tự động…</button>:<article className="studio-automation-card"><span>Đang tải chính sách tiếp nhận CT…</span></article>;
  const changed=!policy||policy.auto_analyze_ct!==draft.auto_analyze_ct||policy.inference_tier!==draft.inference_tier;
  if(compact)return <div className="sw-auto-toggle-wrap"><button type="button" className={`sw-auto-toggle ${draft.auto_analyze_ct?"enabled":""}`} aria-pressed={Boolean(draft.auto_analyze_ct)} disabled={!isAdmin||busy} onClick={toggleCompact}><i/><span>Tự động chạy mọi ca CT</span><b>{busy?"Đang lưu…":draft.auto_analyze_ct?"Bật":"Tắt"}</b></button>{message&&<small role="alert">{message}</small>}</div>;
  return <article className={`studio-automation-card ${draft.auto_analyze_ct?"enabled":""}`}>
    <div className="automation-copy"><span><Icon name="spark" size={21}/></span><div><small>CT INGEST AUTOMATION</small><h3>Tự động chạy AI cho mọi ca CT mới</h3><p>Áp dụng chung cho CT Simulator, file NIfTI upload và study DICOM upload.</p></div></div>
    <label className="automation-switch"><input type="checkbox" checked={Boolean(draft.auto_analyze_ct)} disabled={!isAdmin||busy} onChange={event=>setDraft({...draft,auto_analyze_ct:event.target.checked})}/><i/><span>{draft.auto_analyze_ct?"Đang bật":"Đang tắt"}</span></label>
    <label className="automation-model"><span>Model tự động</span><select value={draft.inference_tier} disabled={!isAdmin||busy} onChange={event=>setDraft({...draft,inference_tier:event.target.value})}>{tiers.map(([key,tier])=><option key={key} value={key} disabled={key!=="fast"||!tier.available}>Model {tier.name}{tier.available?"":" · không khả dụng"}</option>)}</select><small>Cấu hình được cố định vào job ngay lúc ca được nhận.</small></label>
    {(changed||message)&&<div className="automation-actions">{message&&<span>{message}</span>}{changed&&<button type="button" disabled={!isAdmin||busy} onClick={save}>{busy?"Đang lưu…":"Lưu thay đổi"}</button>}</div>}
  </article>;
}

function HardwarePanel() {
  const [hardware,setHardware]=useState(null),[error,setError]=useState(""),[history,setHistory]=useState([]);
  const load=useCallback(async()=>{try{const next=await getMlopsHardware();setHardware(next);setHistory(current=>[...current,{cpu:Math.min(100,next.cpu.load_1m/Math.max(next.cpu.logical_cores,1)*100),gpu:next.gpus[0]?.utilization_percent||0,ram:next.memory.total_bytes?next.memory.used_bytes/next.memory.total_bytes*100:0,disk:next.storage.total_bytes?next.storage.used_bytes/next.storage.total_bytes*100:0}].slice(-24));setError("");}catch(e){setError(e.message);}},[]);
  useEffect(()=>{load();const timer=setInterval(load,5000);return()=>clearInterval(timer);},[load]);
  const bytes=(value)=>{if(!Number.isFinite(value)||value<=0)return "—";const units=["B","GB","TB"];let size=value,index=0;if(size>=1024**3){size/=1024**3;index=1}if(size>=1024&&index===1){size/=1024;index=2}return `${size.toFixed(index?1:0)} ${units[index]}`;};
  const percent=(used,total)=>total?Math.min(100,Math.round(used/total*100)):0;
  if(!hardware)return <section className="hardware-panel"><div className="hardware-loading"><Icon name="hardware" size={28}/><strong>{error||"Đang đọc thông tin máy…"}</strong><button onClick={load}>Thử lại</button></div></section>;
  const {cpu,memory,storage,gpus}=hardware;
  const ramUsed=percent(memory.used_bytes,memory.total_bytes),diskUsed=percent(storage.used_bytes,storage.total_bytes),cpuUsed=Math.min(100,Math.round(cpu.load_1m/Math.max(cpu.logical_cores,1)*100)),gpuUsed=Math.round(gpus[0]?.utilization_percent||0);
  return <section className="hardware-panel">
    <div className="hardware-head"><div><span className="mlops-eyebrow">COMPUTE &amp; RUNTIME</span><h2>Hardware của AI Studio</h2><p>Số liệu lấy trực tiếp từ máy chủ và tự cập nhật mỗi 5 giây.</p></div><div className="hardware-live"><i/> Live · {shortDate(hardware.captured_at)}<button onClick={load} title="Làm mới"><Icon name="reset" size={15}/></button></div></div>
    {error&&<div className="mlops-error"><Icon name="alert" size={16}/>{error}</div>}
    <div className="hardware-summary">
      <article><span><Icon name="chart" size={20}/></span><div><small>CPU</small><strong>{cpuUsed}%</strong><p>{cpu.logical_cores} logical cores · load {cpu.load_1m.toFixed(2)}</p><i className="hw-mini-bar"><b style={{width:`${cpuUsed}%`}}/></i></div></article>
      <article><span><Icon name="hardware" size={20}/></span><div><small>GPU</small><strong>{gpuUsed}%</strong><p>{gpus[0]?.name||"Không phát hiện GPU"}</p><i className="hw-mini-bar cyan"><b style={{width:`${gpuUsed}%`}}/></i></div></article>
      <article><span><Icon name="database" size={20}/></span><div><small>BỘ NHỚ</small><strong>{ramUsed}%</strong><p>{bytes(memory.used_bytes)} / {bytes(memory.total_bytes)}</p><i className="hw-mini-bar violet"><b style={{width:`${ramUsed}%`}}/></i></div></article>
      <article><span><Icon name="folder" size={20}/></span><div><small>Ổ ĐĨA</small><strong>{diskUsed}%</strong><p>{bytes(storage.used_bytes)} / {bytes(storage.total_bytes)}</p><i className="hw-mini-bar amber"><b style={{width:`${diskUsed}%`}}/></i></div></article>
    </div>
    <article className="premium-card hardware-chart-card"><div className="premium-card-head"><div><h3>Mức sử dụng</h3><p>CPU, GPU, bộ nhớ và ổ đĩa · cập nhật theo thời gian thực</p></div><div className="hardware-chart-legend"><span><i className="cpu"/>CPU {cpuUsed}%</span><span><i className="gpu"/>GPU {gpuUsed}%</span><span><i className="ram"/>RAM {ramUsed}%</span><span><i className="disk"/>Disk {diskUsed}%</span></div></div><div className="hardware-chart"><div className="chart-grid"/><svg viewBox="0 0 1000 180" preserveAspectRatio="none">{[["cpu","#2776db"],["gpu","#7654c6"],["ram","#1a9da0"],["disk","#b77d38"]].map(([key,color])=><polyline key={key} className={key} stroke={color} points={history.map((item,index)=>`${history.length>1?index/(history.length-1)*1000:0},${170-(item[key]||0)*1.55}`).join(" ")}/>)}</svg><span className="chart-end-label">{history.length?"Live":"Đang thu thập dữ liệu"}</span></div></article>
    <div className="hardware-main">
        <article className="premium-card hardware-gpu-card"><div className="premium-card-head"><div><h3>GPU &amp; VRAM</h3><p>Tải, nhiệt độ, điện năng và bộ nhớ tăng tốc</p></div><span className={gpus.length?"hw-ok":"hw-fail"}>{gpus.length?`${gpus.length} thiết bị`:"Không khả dụng"}</span></div>{gpus.length?gpus.map(gpu=>{const used=percent(gpu.memory_used_mb,gpu.memory_total_mb);return <div className="gpu-device" key={gpu.uuid}><header><div><span>GPU {gpu.index}</span><strong>{gpu.name}</strong><small>{gpu.uuid}</small></div><b>{gpu.utilization_percent??0}% <small>utilization</small></b></header><div className="gpu-gauges"><div><label><span>VRAM</span><b>{gpu.memory_used_mb} / {gpu.memory_total_mb} MB</b></label><progress max="100" value={used}/><small>{gpu.memory_free_mb} MB còn trống</small></div><dl><div><dt>Nhiệt độ</dt><dd>{gpu.temperature_c??"—"} °C</dd></div><div><dt>Điện năng</dt><dd>{gpu.power_w??"—"} / {gpu.power_limit_w??"—"} W</dd></div><div><dt>Driver</dt><dd>{gpu.driver_version}</dd></div></dl></div></div>}):<EmptyState icon="hardware" title="Không tìm thấy NVIDIA GPU" body="Kiểm tra driver NVIDIA và quyền truy cập nvidia-smi của service."/>}</article>
        <article className="premium-card hardware-resource-card"><div className="premium-card-head"><div><h3>Tài nguyên hệ thống</h3><p>RAM, swap, CPU load và vùng lưu dataset/checkpoint</p></div></div><div className="resource-bars"><div><label><span>RAM</span><b>{bytes(memory.used_bytes)} / {bytes(memory.total_bytes)}</b></label><progress max="100" value={ramUsed}/><small>{ramUsed}% đang dùng · {bytes(memory.available_bytes)} khả dụng</small></div><div><label><span>Storage</span><b>{bytes(storage.used_bytes)} / {bytes(storage.total_bytes)}</b></label><progress max="100" value={diskUsed}/><small>{diskUsed}% đang dùng · {bytes(storage.free_bytes)} còn trống</small></div></div><dl className="hardware-detail-grid"><div><dt>CPU model</dt><dd>{cpu.model}</dd></div><div><dt>Load average</dt><dd>{cpu.load_1m.toFixed(2)} · {cpu.load_5m.toFixed(2)} · {cpu.load_15m.toFixed(2)}</dd></div><div><dt>Swap</dt><dd>{bytes(memory.swap_used_bytes)} / {bytes(memory.swap_total_bytes)}</dd></div><div><dt>Data mount</dt><dd>{storage.mount}</dd></div></dl></article>
    </div>
  </section>;
}

function LearningPanel({items,datasets,runs,models,caps,busy,actor,authorization,selected,setSelected,run,requireActor,onNavigate,onOpenLabelCase,openTab}) {
  const [review,setReview]=useState({verdict:"uncertain",diagnosis:"",subtype:"",note:""});
  const [search,setSearch]=useState("");
  const active=items.find(x=>x.id===selected)||null;
  const gold=items.filter(x=>x.status==="gold").length;
  const pending=items.filter(x=>!["gold","excluded"].includes(x.status)).length;
  const visible=items.filter(x=>`${x.id} ${x.note||""} ${x.assessment||""} ${x.model_version||""} ${(x.reasons||[]).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const fineTuneRuns=runs.filter(x=>x.mode==="fine_tune"||/active[ -]?learning/i.test(`${x.name} ${x.metrics?.dataset_name||""}`));
  const current=fineTuneRuns.find(x=>["running","queued","validation_queued","validating"].includes(x.status))||fineTuneRuns[0]||null;
  const recent=useMemo(()=>[
    ...items.map(x=>({type:"case",text:`Ca ${candidateName(x)} · ${LABEL[x.status]||x.status}`,at:x.updated_at})),
    ...datasets.map(x=>({type:"dataset",text:`Dataset ${uiName(x.name)} ${x.version}`,at:x.created_at})),
    ...runs.map(x=>({type:"run",text:`Run ${uiName(x.name)} · ${LABEL[x.status]||x.status}`,at:x.updated_at||x.created_at})),
  ].sort((a,b)=>String(b.at||"").localeCompare(String(a.at||""))).slice(0,5),[items,datasets,runs]);
  return <section className="mlops-dashboard premium-learning">
    <div className="mlops-dashboard-layout">
      <div className="mlops-main-column">
        <article className="premium-card queue-panel">
          <div className="premium-card-head"><div><span className="mlops-eyebrow">FINE-TUNE</span><h2>Hàng chờ Fine-tune</h2><p>Ca model chưa chắc chắn, ca khó và ca cần bác sĩ kiểm tra trước vòng Fine-tune tiếp theo.</p></div><div className="queue-tools"><label><Icon name="search" size={16}/><input aria-label="Tìm ca trong hàng đợi" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tìm mã ca, lý do, model..."/></label><button title="Mở workspace gán nhãn" aria-label="Mở workspace gán nhãn" onClick={()=>onNavigate("labeling")}><Icon name="plus" size={16}/></button></div></div>
          <div className="premium-table-head"><span>Case</span><span>Nguồn</span><span>QC</span><span>Giá trị học</span><span>Cập nhật</span><span>Action</span></div>
          <div className="premium-table-body">{visible.length?visible.map(item=>{const signal=learningSignal(item);return <button className={`premium-table-row ${active?.id===item.id?"active":""}`} key={item.id} onClick={()=>setSelected(item.id)}><span><b>{candidateName(item)}</b><small>{item.id.slice(0,8).toUpperCase()} · {signal.explanations?.[0]||String(item.assessment||"").replaceAll("_"," ")}</small></span><span><b className="dataset-source-badge">{candidateSource(item)}</b></span><span><Status value={item.status}/></span><span><em className={`learning-score ${signal.band||"low"}`}>{signal.score||0}</em></span><span>{shortDate(item.updated_at)}</span><span className="table-actions"><em>Xem</em></span></button>}):<EmptyState title={search?"Không tìm thấy ca phù hợp":"Hàng đợi đang trống"} body={search?"Thử từ khóa khác hoặc xóa bộ lọc hiện tại.":"Ca được chọn từ Clinical Reading hoặc Expert Labeling sẽ xuất hiện ở đây."} action={!search&&<button className="mlops-secondary" onClick={()=>onNavigate("clinical")}>Mở thư viện CT</button>}/>}</div>
          <footer className="premium-table-footer"><span>Hiển thị {visible.length} / {items.length} ca</span><span>{gold} ca đã duyệt để lưu trữ hoặc xuất dữ liệu</span></footer>
        </article>
        <CurrentRunCard run={current} caps={caps} eyebrow="FINE-TUNE TRAINING" title="Biểu đồ Fine-tune"/>
        <DatasetSetup items={datasets} candidates={items} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor}/>
        <TrainingRunLauncher mode="fine_tune" datasets={datasets} models={models} caps={caps} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor}/>
      </div>
      <aside className="mlops-insight-column">
        <article className="premium-card overview-card"><div className="premium-card-head"><div><h3>Training Overview</h3><p>Trạng thái pipeline thực tế</p></div><span className={caps.worker_alive?"overview-online":"overview-offline"}><i/>{caps.worker_alive?"Extension đã kết nối":"Extension ngoại tuyến"}</span></div><div className="overview-metrics"><div><span>Ready cases</span><strong>{gold}</strong><small>Gold labels</small></div><div><span>Pending review</span><strong>{pending}</strong><small>Clinical QA</small></div><div><span>Runner</span><strong>{trainingAvailable(caps)?"Ready":"—"}</strong><small>{trainingAvailable(caps)?"Command configured":"Not configured"}</small></div><div><span>Best val Dice</span><strong>{current?.metrics?.best_validation_dice?.toFixed?.(3)??"—"}</strong><small>Checkpoint selection</small></div></div></article>
        <article className="premium-card activity-card"><div className="premium-card-head"><div><h3>Recent Activity</h3><p>Lịch sử Fine-tune</p></div></div>{recent.length?<div className="premium-timeline">{recent.map((x,i)=><div key={`${x.type}-${i}`}><span className={x.type}><Icon name={x.type==="run"?"chart":x.type==="dataset"?"database":"file"} size={15}/></span><p><b>{x.text}</b><small>{shortDate(x.at)}</small></p></div>)}</div>:<div className="activity-empty"><Icon name="clock" size={22}/><span>Chưa có hoạt động mới</span><small>Pipeline events sẽ được ghi lại tại đây.</small></div>}</article>
        <article className="premium-card readiness-card"><div><span>Dataset readiness</span><strong>{items.length?Math.round(gold/items.length*100):0}%</strong></div><div className="premium-progress"><i style={{width:`${items.length?Math.round(gold/items.length*100):0}%`}}/></div><p>{gold} trong {items.length} ca đã hoàn tất QC</p></article>
      </aside>
    </div>
    {active&&<CaseDrawer active={active} busy={busy} actor={actor} authorization={authorization} review={review} setReview={setReview} run={run} requireActor={requireActor} onClose={()=>setSelected(null)} onNavigate={onNavigate} onOpenLabelCase={onOpenLabelCase}/>}
  </section>;
}

function ActiveLearningCycle({items,datasets,runs,nextCase,onOpenLabelCase}) {
  const open=items.filter(x=>!["gold","excluded"].includes(x.status));
  const inLabel=items.filter(x=>["annotation","peer_review","adjudication"].includes(x.status)).length;
  const gold=items.filter(x=>x.status==="gold").length;
  const latest=datasets[0];
  const running=runs.filter(x=>["queued","running","validation_queued","validating"].includes(x.status)).length;
  return <article className="premium-card active-learning-cycle active-learning-explainer"><div className="active-cycle-head"><div><span className="mlops-eyebrow">FINE-TUNE</span><h2>Ưu tiên ca nào nên được bác sĩ gán nhãn trước?</h2><p>Model xếp các ca khó lên đầu. Bác sĩ sửa mask, kết quả được duyệt thành Gold label rồi mới đưa vào lần training sau.</p></div><button disabled={!nextCase} onClick={()=>nextCase&&onOpenLabelCase?.({id:nextCase.annotation_case_id,name:candidateName(nextCase)})}><Icon name="brush" size={15}/> Mở ca ưu tiên</button></div><div className="active-learning-simple-flow"><div><span><Icon name="spark" size={17}/></span><section><b>1. AI chọn ca khó</b><strong>{open.length} ca đang chờ</strong><small>Dựa trên độ không chắc chắn và đặc điểm tổn thương</small></section></div><i>→</i><div><span><Icon name="brush" size={17}/></span><section><b>2. Bác sĩ xác nhận</b><strong>{inLabel} ca đang sửa</strong><small>Sửa mask và hội chẩn khi cần</small></section></div><i>→</i><div><span><Icon name="shield" size={17}/></span><section><b>3. Đưa vào lần học sau</b><strong>{gold} Gold label</strong><small>{latest?`Dataset ${latest.version}`:"Chưa tạo dataset"} · {running?`${running} run đang xử lý`:"chưa có run đang chạy"}</small></section></div></div><footer><Icon name="info" size={14}/><span>Fine-tune chỉ dùng các Gold label đã được duyệt; model không tự cập nhật hoặc tự phát hành khi bác sĩ vừa lưu nhãn.</span></footer></article>;
}

function LegacyCurrentRunCard({run,caps}) {
  const metrics=run?.metrics||{};
  const progress=metrics.live_progress;
  const isPseudo=metrics.training_runner==="extension_runner"||progress?.metric_scope==="sampled_pseudo_dice";
  const completed=run&&["succeeded","validated","failed"].includes(run.status);
  const qualityMetrics=[["Dice",metrics.mean_dice??metrics.dice],["Recall",metrics.lesion_recall],["Precision",metrics.precision]];
  const gateDice=Number(metrics.quality_gate?.dice??.5),gateRecall=Number(metrics.quality_gate?.recall??.8);
  const gatePassed=Number(metrics.mean_dice??metrics.dice)>=gateDice&&Number(metrics.lesion_recall)>=gateRecall;
  const trainLoss=metrics.history?.train_loss||[],validationLoss=metrics.history?.validation_loss||[];
  const allLoss=[...trainLoss,...validationLoss].filter(Number.isFinite),lossMin=Math.min(...allLoss),lossMax=Math.max(...allLoss);
  const linePoints=values=>values.map((value,index)=>`${values.length>1?index/(values.length-1)*1000:0},${12+(lossMax-value)/Math.max(lossMax-lossMin,.000001)*126}`).join(" ");
  const hasHistory=trainLoss.length>1&&validationLoss.length===trainLoss.length;
  return <article className="premium-card current-run-card"><div className="premium-card-head"><div><span className="mlops-eyebrow">Training worker</span><h2>{completed?"Đợt training gần nhất":"Current Training Run"}</h2></div>{run?<Status value={run.status}/>:<span className="tw-status">Idle</span>}</div><div className="current-run-name"><div className="run-orb"><Icon name={run?.status==="validated"?"shield":"spark"} size={22}/></div><div><strong>{run?.name||"Chưa có training run"}</strong><small>{run?`${run.mode} · ${run.id.slice(0,8)} · ${shortDate(run.updated_at)}`:trainingAvailable(caps)?"Runner đã cấu hình, đang chờ run":"Chưa cấu hình training runner"}</small></div></div>{run&&<div className="run-provenance"><span><Icon name="cube" size={12}/>{run.config?.architecture||metrics.framework||"External runner"}</span><span><Icon name="spark" size={12}/>{metrics.device||"Compute chưa báo cáo"}</span><span><Icon name="database" size={12}/>{metrics.training_cases??"—"} train · {metrics.validation_cases??"—"} val · {metrics.holdout_cases??"—"} test</span><span><Icon name="chart" size={12}/>{metrics.parameter_count?`${(metrics.parameter_count/1e6).toFixed(2)}M params`:"Params —"}</span><span><Icon name="clock" size={12}/>{metrics.duration_seconds?`${metrics.duration_seconds}s · best epoch ${metrics.best_epoch}`:"Đang đo"}</span></div>}<div className="current-run-body"><div className="smooth-chart">{hasHistory?<><div className="chart-grid"/><div className="chart-title"><strong>Train loss &amp; validation loss</strong><small>{trainLoss.length} epochs · thấp hơn là tốt hơn</small></div><div className="chart-legend"><span><i className="train"/>Train loss</span><span><i className="val"/>Validation loss</span></div><svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-label="Biểu đồ train loss và validation loss"><polyline className="train-line" points={linePoints(trainLoss)}/><polyline className="val-line" points={linePoints(validationLoss)}/></svg><div className="loss-axis"><span>{lossMax.toFixed(3)}</span><span>{lossMin.toFixed(3)}</span></div></>:<><div className="chart-grid"/><div className="chart-no-data">{run?"Run này chưa lưu loss theo epoch":"Chưa có dữ liệu training"}</div></>}</div><div className="run-metrics"><div><span>Holdout cases</span><strong>{metrics.holdout_cases??"—"}</strong><small>Physically isolated</small></div><div><span>Dice</span><strong>{metrics.mean_dice?.toFixed?.(3)??metrics.dice?.toFixed?.(3)??"—"}</strong><small>Measured</small></div><div><span>Recall</span><strong>{metrics.lesion_recall?.toFixed?.(3)??"—"}</strong><small>Holdout</small></div><div><span>Precision</span><strong>{metrics.precision?.toFixed?.(3)??"—"}</strong><small>Holdout</small></div><div><span>Quality gate</span><strong className={gatePassed?"metric-pass":"metric-fail"}>{gatePassed?"Pass":"Fail"}</strong><small>Dice ≥ .70 · Recall ≥ .90</small></div><div><span>Threshold</span><strong>{metrics.operating_threshold?.toFixed?.(2)??"—"}</strong><small>Chọn trên validation</small></div></div></div></article>;
}

export function CurrentRunCard({run,caps,eyebrow="LIVE TRAINING WORKER",title=""}) {
  const metrics=run?.metrics||{};
  const progress=metrics.live_progress;
  const isPseudo=metrics.training_runner==="extension_runner"||progress?.metric_scope==="sampled_pseudo_dice";
  const active=Boolean(run&&["queued","running","validation_queued","validating"].includes(run.status));
  const completed=Boolean(run&&["succeeded","validated","failed"].includes(run.status));
  const trainLoss=metrics.history?.train_loss||[];
  const validationLoss=metrics.history?.validation_loss||[];
  const allLoss=[...trainLoss,...validationLoss].filter(Number.isFinite);
  const lossMin=allLoss.length?Math.min(...allLoss):0;
  const lossMax=allLoss.length?Math.max(...allLoss):1;
  const points=values=>values.map((value,index)=>`${values.length>1?index/(values.length-1)*1000:0},${12+(lossMax-value)/Math.max(lossMax-lossMin,.000001)*126}`).join(" ");
  const hasHistory=trainLoss.length>1&&validationLoss.length===trainLoss.length;
  const gateDice=Number(metrics.quality_gate?.dice??.5),gateRecall=Number(metrics.quality_gate?.recall??.8);
  const gatePassed=Number(metrics.mean_dice??metrics.dice)>=gateDice&&Number(metrics.lesion_recall)>=gateRecall;
  const sourceCounts=metrics.source_counts;
  return <article className={`premium-card current-run-card current-run-card-large ${active?"run-active":""}`}>
    <div className="premium-card-head">{run&&<a className="sw-link-button" href={`/model-studio?monitor=${encodeURIComponent(run.id)}`} target="_blank" rel="noopener noreferrer">Mở biểu đồ live ↗</a>}<div><span className="mlops-eyebrow">{eyebrow}</span><h2>{active?"Đang huấn luyện mô hình":title||(completed?"Đợt training gần nhất":"Chưa có training run")}</h2></div>{run?<Status value={run.status}/>:<span className="tw-status">Idle</span>}</div>
    {active&&<div className="live-training-banner"><div><i/><span><b>{run.status==="validating"?"ĐANG KIỂM ĐỊNH LOCKED TEST":"GPU TRAINING ĐANG CHẠY"}</b><small>{progress?.phase==="preprocessing"?`Tiền xử lý ${progress.processed_cases}/${progress.total_cases} study`:progress?.phase==="benchmark"?`Đánh giá ${progress.completed_cases}/${progress.total_cases} study`:progress?.epoch?`Epoch ${progress.epoch} / ${progress.total_epochs}`:"Đang nạp dataset và khởi tạo model…"}</small></span></div><strong>{progress?`${progress.percent}%`:"…"}</strong><progress max="100" value={progress?.percent||0}/></div>}
    <div className="current-run-name"><div className="run-orb"><Icon name={run?.status==="validated"?"shield":"spark"} size={28}/></div><div><strong>{run?.name||(trainingAvailable(caps)?"Training extension đã kết nối":"Training runtime chưa được cung cấp")}</strong><small>{run?`${run.mode} · ${run.id.slice(0,8)} · ${shortDate(run.updated_at)}`:trainingAvailable(caps)?"Đang chờ run mới":"Chưa cấu hình runner"}</small></div>{progress&&<div className="live-values"><span>Train loss <b>{progress.train_loss?.toFixed?.(4)??"—"}</b></span><span>Val loss <b>{progress.validation_loss?.toFixed?.(4)??"—"}</b></span><span>{isPseudo?"Pseudo Dice":"Val Dice"} <b>{progress.validation_dice?.toFixed?.(4)??"—"}</b></span></div>}</div>
    {run&&<><div className="run-provenance"><span><Icon name="cube" size={12}/>{metrics.architecture||metrics.framework||"MONAI runner"}</span><span><Icon name="spark" size={12}/>{metrics.device||"Compute đang khởi tạo"}</span><span><Icon name="database" size={12}/>{metrics.training_cases??"—"} train · {metrics.validation_cases??"—"} val · {metrics.holdout_cases??"—"} test</span><span><Icon name="chart" size={12}/>{metrics.parameter_count?`${(metrics.parameter_count/1e6).toFixed(2)}M params`:progress?`epoch ${progress.epoch}/${progress.total_epochs}`:"Params —"}</span>{metrics.leakage_audit&&<span className="audit-ok"><Icon name="shield" size={12}/>Zero split overlap</span>}</div>{sourceCounts&&<div className="dataset-source-line"><b>Dữ liệu:</b><span>Train {sourceCounts.train?.BHSD||0} BHSD + {sourceCounts.train?.PHYSIONET||0} PhysioNet</span><span>Validation {sourceCounts.validation?.BHSD||0} BHSD</span><span>Locked test {sourceCounts.test?.PHYSIONET||0} PhysioNet</span></div>}</>}
    <div className="current-run-body"><div className="smooth-chart">{hasHistory?<><div className="chart-grid"/><div className="chart-title"><strong>Train loss &amp; validation loss</strong><small>{trainLoss.length} / {progress?.total_epochs||metrics.epochs||trainLoss.length} epochs · tự cập nhật mỗi 5 giây</small></div><div className="chart-legend"><span><i className="train"/>Train loss</span><span><i className="val"/>Validation loss</span></div><svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-label="Biểu đồ train loss và validation loss"><polyline className="train-line" points={points(trainLoss)}/><polyline className="val-line" points={points(validationLoss)}/></svg><div className="loss-axis"><span>{lossMax.toFixed(3)}</span><span>{lossMin.toFixed(3)}</span></div></>:<><div className="chart-grid"/><div className="chart-no-data">{active?"Đang chờ epoch đầu tiên…":"Chưa có dữ liệu training"}</div></>}</div>
      <div className="run-metrics"><div><span>{isPseudo?"Best pseudo Dice":"Best val Dice"}</span><strong>{metrics.best_validation_dice?.toFixed?.(3)??progress?.best_validation_dice?.toFixed?.(3)??"—"}</strong><small>{isPseudo?"Lấy mẫu batch validation":"Checkpoint selection"}</small></div><div><span>Test Dice (macro)</span><strong>{metrics.mean_dice?.toFixed?.(3)??"—"}</strong><small>Locked holdout</small></div><div><span>Recall</span><strong>{metrics.lesion_recall?.toFixed?.(3)??"—"}</strong><small>Locked holdout</small></div><div><span>Precision</span><strong>{metrics.precision?.toFixed?.(3)??"—"}</strong><small>Locked holdout</small></div><div><span>Quality gate</span><strong className={metrics.validation_gate?.passed===true?"metric-pass":metrics.validation_gate?"metric-fail":""}>{metrics.validation_gate?(metrics.validation_gate.passed?"Pass":"Fail"):"Pending"}</strong><small>Dice ≥ {gateDice.toFixed(2)} · Recall ≥ {gateRecall.toFixed(2)}</small></div><div><span>Threshold</span><strong>{metrics.operating_threshold?.toFixed?.(2)??"—"}</strong><small>Chọn trên validation</small></div></div>
    </div>
  </article>;
}

function CaseDrawer({active,busy,actor,authorization,review,setReview,run,requireActor,onClose,onNavigate,onOpenLabelCase}) {return <aside className="mlops-case-drawer"><div className="mlops-drawer-head"><div><span className="mlops-eyebrow">Case provenance</span><h3>{active.id.slice(0,8).toUpperCase()}</h3></div><button onClick={onClose} aria-label="Đóng chi tiết"><Icon name="close" size={17}/></button></div><div className="mlops-drawer-body"><Status value={active.status}/><p>{active.note||"Không có ghi chú lâm sàng."}</p><dl className="mlops-dl"><div><dt>Annotation</dt><dd>{active.annotation_case_id||"—"}</dd></div><div><dt>Người chọn</dt><dd>{active.created_by||"—"}</dd></div></dl>{!["gold","excluded"].includes(active.status)&&<><div className="mlops-actions"><button disabled={!active.annotation_case_id} onClick={()=>active.annotation_case_id&&onOpenLabelCase?.({id:active.annotation_case_id,name:candidateName(active)})}><Icon name="brush" size={14}/> Mở editor đúng ca</button><button disabled={busy} onClick={()=>requireActor()&&run(()=>transitionLearningCandidate(active.id,{status:"annotation",assigned_to:actor,annotation_case_id:active.annotation_case_id,note:active.note||""},authorization))}>Chuyển gán nhãn</button>{(active.reviews?.length||0)>=(active.assessment==="difficult"?2:1)&&<button disabled={busy} onClick={()=>requireActor()&&run(()=>transitionLearningCandidate(active.id,{status:"adjudication",assigned_to:actor,note:active.note||""},authorization))}>Chuyển phân xử</button>}</div><details className="mlops-collapsible"><summary>Thêm kết quả hội chẩn</summary><form className="mlops-form" onSubmit={e=>{e.preventDefault();if(requireActor())run(()=>addPeerReview(active.id,{...review,reviewer:actor},authorization));}}><select value={review.verdict} onChange={e=>setReview({...review,verdict:e.target.value})}><option value="positive">Dương tính</option><option value="negative">Âm tính</option><option value="uncertain">Chưa chắc chắn</option><option value="artifact">Artifact</option></select><input placeholder="Chẩn đoán" value={review.diagnosis} onChange={e=>setReview({...review,diagnosis:e.target.value})}/><input placeholder="Subtype" value={review.subtype} onChange={e=>setReview({...review,subtype:e.target.value})}/><input placeholder="Ghi chú" value={review.note} onChange={e=>setReview({...review,note:e.target.value})}/><button disabled={busy}>Lưu hội chẩn</button></form></details><div className="mlops-actions"><button disabled={busy||!active.annotation?.latest_approved_revision||(active.reviews?.length||0)<(active.assessment==="difficult"?2:1)} title={!active.annotation?.latest_approved_revision?"Cần duyệt toàn bộ volume trong editor trước":""} onClick={()=>requireActor()&&run(()=>adjudicateCandidate(active.id,{decision:"gold",adjudicator:actor,annotation_case_id:active.annotation_case_id,revision_number:active.annotation.latest_approved_revision,note:"Gold label từ revision đã duyệt"},authorization))}>Đưa revision v{active.annotation?.latest_approved_revision||"—"} vào Gold</button><button className="danger" disabled={busy} onClick={()=>requireActor()&&run(()=>adjudicateCandidate(active.id,{decision:"excluded",adjudicator:actor,note:"Không phù hợp dataset"},authorization))}>Loại ca</button></div></>}<details className="mlops-collapsible"><summary>Hội chẩn ({active.reviews?.length||0})</summary>{active.reviews?.length?active.reviews.map(r=><div className="audit-entry" key={r.id}><b>{r.reviewer}</b> · {r.verdict}<small>{r.diagnosis} {r.subtype} · {r.note}</small></div>):<p className="mlops-muted">Chưa có hội chẩn.</p>}</details></div></aside>}

function SimpleMetric({label,value,detail}) {return <div className="simple-metric"><span>{label}</span><strong>{value??"—"}</strong>{detail&&<small>{detail}</small>}</div>}
function SimplePageHead({eyebrow,title,body,status}) {return <div className="simple-page-head"><div><span className="mlops-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{body}</p></div>{status}</div>}

const TRAINING_CONFIGS={
  fine_tune:JSON.stringify({epochs:18,learning_rate:.0001,quality_gate_dice:.5,quality_gate_recall:.8,active_learning:{replay_old_data:true,new_case_weight:2,sampling:"weighted"}},null,2),
  postprocess_calibration:JSON.stringify({quality_gate_dice:.5,quality_gate_recall:.95,postprocess:{thresholds:[.3,.35,.4,.45,.5,.55,.6,.65,.7],minimum_component_volumes_mm3:[0,10,25,50,100],minimum_lesion_recall:.95,maximum_mean_false_positive_volume_mm3:5000,closing_radius_mm:0,fill_holes:false,objective:"max_mean_dice_with_constraints"},locked_test_policy:"evaluate_once_after_freeze"},null,2),
};
const TRAINING_MODE_LABEL={fine_tune:"Fine-tune",postprocess_calibration:"Hiệu chỉnh Postprocess"};

function DatasetSetup({items,candidates,actor,authorization,busy,run,requireActor,standalone=false}) {
  const latest=items[0]||null;
  const goldItems=candidates.filter(item=>item.status==="gold");
  const previousIds=new Set((latest?.manifest?.cases||[]).map(item=>item.annotation_case_id).filter(Boolean));
  const newGold=goldItems.filter(item=>!previousIds.has(item.annotation_case_id)).length;
  const concepts={balanced:{label:"Cân bằng",detail:"Khuyên dùng · 70% train, 15% validation, 15% test",train:.7,validation:.15},data_first:{label:"Tận dụng dữ liệu",detail:"80% train, 10% validation, 10% test",train:.8,validation:.1},strict_test:{label:"Kiểm định chặt",detail:"70% train, 10% validation, 20% test",train:.7,validation:.1}};
  const [concept,setConcept]=useState("balanced");
  const [ratios,setRatios]=useState({train:.7,validation:.15});
  const chooseConcept=value=>{const selected=concepts[value];setConcept(value);setRatios({train:selected.train,validation:selected.validation});};
  const total=goldItems.length;
  const estimatedTrain=Math.floor(total*ratios.train);
  const estimatedValidation=Math.floor(total*ratios.validation);
  const estimatedTest=Math.max(0,total-estimatedTrain-estimatedValidation);
  const create=()=>{
    if(!requireActor())return;
    const now=new Date();
    const stamp=`${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}-${String(items.length+1).padStart(2,"0")}`;
    run(()=>createDatasetVersion({
      name:latest?.name||"BrainHem ICH",
      version:stamp,
      train_ratio:ratios.train,
      validation_ratio:ratios.validation,
      description:"Dataset Fine-tune: Gold label đã duyệt",
      created_by:actor,
    },authorization));
  };
  return <article className="premium-card dataset-setup-card">
    <header className="dataset-setup-head"><span className="setup-step">{standalone?<Icon name="database" size={15}/>:"1"}</span><div><small>CHUẨN BỊ DỮ LIỆU</small><h3>Tạo tập huấn luyện</h3><p>Hệ thống tự lấy toàn bộ Gold label đã duyệt, tách theo bệnh nhân và khóa một bản để kết quả có thể tái lập.</p></div>{latest&&<Status value={latest.status}/>}</header>
    <div className="dataset-concept-picker"><span>Cách chuẩn bị</span>{Object.entries(concepts).map(([key,item])=><button key={key} type="button" className={concept===key?"active":""} onClick={()=>chooseConcept(key)}><b>{item.label}</b><small>{item.detail}</small></button>)}</div>
    <div className="dataset-setup-summary">
      <div><span>Gold label</span><strong>{total}</strong><small>đã được bác sĩ duyệt</small></div><i>→</i>
      <div><span>Train dự kiến</span><strong>{estimatedTrain}</strong><small>model học</small></div>
      <div><span>Validation dự kiến</span><strong>{estimatedValidation}</strong><small>chọn checkpoint</small></div>
      <div><span>Test khóa dự kiến</span><strong>{estimatedTest}</strong><small>chỉ dùng khi kiểm định</small></div>
    </div>
    <div className="dataset-setup-actions"><div>{latest?<><b>Đang dùng: {uiName(latest.name)} · {latest.version}</b><small>{latest.num_cases} ca · {newGold?`${newGold} Gold label mới chưa có trong bản này`:`Đã chứa toàn bộ Gold label hiện tại`}</small></>:<><b>Chưa có tập huấn luyện</b><small>Có thể chuẩn bị dữ liệu; Fine-tune cần extension huấn luyện riêng.</small></>}</div><details><summary>Tùy chọn chia tập</summary><div className="dataset-ratio-options"><label>Train <select value={ratios.train} onChange={event=>setRatios({...ratios,train:Number(event.target.value)})}><option value={.7}>70%</option><option value={.75}>75%</option><option value={.8}>80%</option></select></label><label>Validation <select value={ratios.validation} onChange={event=>setRatios({...ratios,validation:Number(event.target.value)})}><option value={.1}>10%</option><option value={.15}>15%</option><option value={.2}>20%</option></select></label></div></details><button className="mlops-primary" disabled={busy||!total||(!newGold&&Boolean(latest))||ratios.train+ratios.validation>=1} onClick={create}><Icon name="database" size={15}/>{latest?newGold?` Thêm ${newGold} ca và tạo bản mới`:" Dataset đã cập nhật":" Tạo tập huấn luyện"}</button></div>
  </article>;
}

function DatasetPanel({items,candidates,actor,authorization,busy,run,requireActor}) {
  const latest=items[0]||null;
  const goldItems=candidates.filter(x=>x.status==="gold");
  const previousIds=new Set((latest?.manifest?.cases||[]).map(x=>x.annotation_case_id).filter(Boolean));
  const newGold=goldItems.filter(x=>!previousIds.has(x.annotation_case_id)).length;
  const splits=latest?.manifest?.splits||{};
  const count=key=>Array.isArray(splits[key])?splits[key].length:0;
  return <section className="mlops-dashboard simple-studio-page dataset-page">
    <SimplePageHead eyebrow="HUẤN LUYỆN / DATASET" title="Dataset huấn luyện" body="Tạo và quản lý các phiên bản dữ liệu đã khóa trước khi chạy Fine-tune." status={<span className="tw-status">{newGold} Gold label mới</span>}/>
    <DatasetSetup items={items} candidates={candidates} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor} standalone/>
    {latest?<article className="premium-card simple-focus-card"><div className="simple-focus-main"><span className="simple-focus-icon teal"><Icon name="database" size={22}/></span><div><small>ĐANG DÙNG</small><h3>{uiName(latest.name)}</h3><p>Phiên bản {latest.version} · {latest.num_cases} ca · tạo {shortDate(latest.created_at)}</p></div><Status value={latest.status}/></div><div className="simple-metric-grid"><SimpleMetric label="Train" value={count("train")}/><SimpleMetric label="Validation" value={count("validation")}/><SimpleMetric label="Test khóa" value={count("test")}/><SimpleMetric label="Gold label hiện có" value={goldItems.length}/></div><div className="simple-focus-actions"><button className="mlops-secondary" disabled={busy} onClick={()=>{if(requireActor())run(async()=>saveBlob(await downloadDatasetArtifact(latest.id,authorization),`${latest.name}-${latest.version}.zip`));}}><Icon name="download" size={14}/> Tải dataset</button><details><summary>Chi tiết kỹ thuật</summary><Json value={latest.manifest}/></details></div></article>:<EmptyState icon="database" title="Chưa có dataset" body="Duyệt nhãn thành Gold label rồi tạo phiên bản dataset đầu tiên."/>}
    {items.length>1&&<details className="premium-card studio-history"><summary>Các phiên bản trước <span>{items.length-1}</span></summary><div>{items.slice(1).map(item=><article key={item.id}><div><b>{uiName(item.name)} · {item.version}</b><small>{item.num_cases} ca · {shortDate(item.created_at)}</small></div><Status value={item.status}/></article>)}</div></details>}
  </section>;
}

function TrainingRunLauncher({mode,datasets,models,caps,actor,authorization,busy,run,requireActor,rootModelsOnly=false}) {
  const {account}=useAppAuth();
  const isAdmin=account.role==="admin";
  const [form,setForm]=useState({dataset_version_id:"",mode,name:"",base_model_id:"",config:TRAINING_CONFIGS[mode]});
  const [configError,setConfigError]=useState("");
  const trainableModels=models.filter(model=>!isInferenceOnlyModel(model));
  const selectableModels=rootModelsOnly?trainableModels.filter(model=>(!model.parent_model_id||model.stage==="production")&&!["rejected","archived"].includes(model.stage)):trainableModels;
  useEffect(()=>{setForm(current=>({...current,dataset_version_id:current.dataset_version_id||datasets[0]?.id||""}));},[datasets]);
  useEffect(()=>{if(!rootModelsOnly)return;setForm(current=>({...current,base_model_id:selectableModels.some(model=>model.id===current.base_model_id)?current.base_model_id:selectableModels[0]?.id||""}));},[models,rootModelsOnly]);
  async function submit(e){e.preventDefault();if(!trainingAvailable(caps)||!isAdmin||!requireActor())return;if(!form.base_model_id||isInferenceOnlyModel(models.find(model=>model.id===form.base_model_id))){setConfigError("Hãy chọn model nền.");return;}let config;try{config=JSON.parse(form.config);setConfigError("");}catch{setConfigError("Cấu hình nâng cao không hợp lệ.");return;}return run(()=>createTrainingRun({...form,created_by:actor,config},authorization));}
  const fineTune=mode==="fine_tune";
  if (!trainingAvailable(caps)) return <TrainingUnavailable caps={caps} heading={fineTune?"Fine-tune chưa khả dụng":"Training/Postprocess runtime chưa được cung cấp"}/>;
  return <details className="premium-card studio-reveal training-page-launcher" defaultOpen={fineTune}><summary><span>{fineTune?<b className="setup-step">1</b>:<Icon name="plus" size={16}/>}<b>{fineTune?"Chọn dataset, model và bắt đầu":"Tạo đợt hiệu chỉnh Postprocess"}</b><small>{fineTune?"Chọn một phiên bản đã khóa trong trang Dataset để tiến hành huấn luyện.":"Quét threshold × minimum component volume trên development-validation"}</small></span><Icon name="chevron" size={14}/></summary><form className="training-config simple-training-form" onSubmit={submit}><label>Tên lần chạy<input required placeholder={fineTune?"Ví dụ: Fine-tune tháng 9":"Ví dụ: ICH-postprocess-v2"} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Dataset huấn luyện<select required value={form.dataset_version_id} onChange={e=>setForm({...form,dataset_version_id:e.target.value})}><option value="">Chọn dataset đã khóa</option>{datasets.map(d=><option key={d.id} value={d.id}>{uiName(d.name)} · {d.version} · {d.num_cases} ca</option>)}</select></label><label className="wide">Model gốc<select disabled={!isAdmin} required value={form.base_model_id} onChange={e=>setForm({...form,base_model_id:e.target.value})}><option value="">Chọn model gốc</option>{selectableModels.map((model,index)=><option key={model.id} value={model.id}>{index===0&&rootModelsOnly?"Model gốc mặc định":"Model gốc"} · {model.id.slice(0,8).toUpperCase()}</option>)}</select><small>{fineTune&&!datasets.length?"Chưa có dataset. Mở Huấn luyện → Dataset để tạo tập đầu tiên.":rootModelsOnly?"Model Fine-tune chỉ xuất hiện tại đây sau khi qua gate, phê duyệt, Shadow và lên Production.":""}</small></label><div className={`training-workflow-note ${mode}`}><span><Icon name={fineTune?"spark":"settings"} size={18}/></span><div><b>{TRAINING_MODE_LABEL[mode]}</b>{fineTune?<p>Tạo model ứng viên từ model gốc. Model đang dùng sẽ không bị thay đổi.</p>:<p>Không dùng gradient và không xem locked test. Lưu probability mask, thử 45 cấu hình chung, chấm Dice · lesion recall · HD95 · FP volume; kích thước component luôn tính bằng mm³ theo spacing từng ca.</p>}</div></div><details><summary>Cấu hình nâng cao</summary><textarea aria-label="Training config JSON" value={form.config} onChange={e=>{setForm({...form,config:e.target.value});setConfigError("");}}/></details>{configError&&<small className="mlops-error-inline">{configError}</small>}<button className="mlops-primary" disabled={!isAdmin||busy||!trainingAvailable(caps)||!form.base_model_id||!form.dataset_version_id}><Icon name={fineTune?"spark":"settings"} size={15}/>{fineTune?" Bắt đầu Fine-tune":" Chạy hiệu chỉnh Postprocess"}</button></form></details>;
}

function RunsPanel({fixedMode="postprocess_calibration",items,datasets,models,caps,actor,authorization,busy,run,requireActor}) {
  const workflowItems=items.filter(item=>item.mode===fixedMode);
  const active=workflowItems.find(x=>["queued","running","validation_queued","validating"].includes(x.status));
  const current=active||workflowItems[0]||null;
  const metrics=current?.metrics||{};
  const progress=metrics.live_progress;
  const postprocess=fixedMode==="postprocess_calibration";
  const search=postprocess?metrics.postprocess_search:null;
  const gateRejected=search?.selection_status==="no_feasible_configuration";
  const referenceConfig=gateRejected?search.best_unconstrained:null;
  const maximumRecall=gateRejected&&search.configurations?.length
    ? Math.max(...search.configurations.map(item=>Number(item.lesion_recall)||0))
    : null;
  const currentStatus=gateRejected?<span className="tw-status status-failed">Không đạt gate</span>:<Status value={current?.status}/>;
  return <section className="mlops-dashboard simple-studio-page">
    <SimplePageHead eyebrow={postprocess?"POSTPROCESS CALIBRATION":"FINE-TUNE"} title={postprocess?"Tinh chỉnh Postprocess":"Fine-tune"} body={postprocess?"Giữ nguyên trọng số model và hiệu chỉnh operating threshold trên validation.":"Fine-tune model nền bằng tập Gold label đã được kiểm soát."} status={<Status value={trainingAvailable(caps)?"configured":"not-configured"}/>}/>
    {postprocess&&<article className="premium-card postprocess-protocol"><header><div><span className="mlops-eyebrow">DEVELOPMENT CALIBRATION</span><h3>Một cấu hình chung cho toàn bộ bệnh nhân</h3><p>Đây là giao diện cho extension hiệu chỉnh riêng; bản public không cung cấp runtime tạo prediction calibration.</p></div><span><Icon name="shield" size={17}/> Locked test chưa được quan sát</span></header><div className="postprocess-flow"><b>Probability mask</b><i>→</i><b>Threshold</b><i>→</i><b>3D connected components</b><i>→</i><b>Min volume mm³</b><i>→</i><b>Dice · Recall · HD95 · FP volume</b></div><div className="postprocess-grid-info"><div><small>THRESHOLD GRID</small><p>{[.3,.35,.4,.45,.5,.55,.6,.65,.7].map(value=><span key={value}>{value.toFixed(2)}</span>)}</p></div><div><small>MIN COMPONENT VOLUME</small><p>{[0,10,25,50,100].map(value=><span key={value}>{value} mm³</span>)}</p></div><div><small>SELECTION CONSTRAINTS</small><p><span>Lesion recall ≥ 95%</span><span>Mean FP ≤ 5000 mm³</span></p></div></div><footer>Closing = off · Fill holes = off · không chọn riêng theo ca · không chọn lại theo kết quả test</footer></article>}
    {current?<article className={`premium-card simple-focus-card ${active?"live":""} ${gateRejected?"quality-rejected":""}`}>
      <div className="simple-focus-main"><span className="simple-focus-icon violet"><Icon name="chart" size={22}/></span><div><small>{active?"ĐANG CHẠY":"RUN GẦN NHẤT"}</small><h3>{current.name}</h3><p>{TRAINING_MODE_LABEL[current.mode]||current.mode} · cập nhật {shortDate(current.updated_at)}</p></div>{currentStatus}</div>
      {active&&<div className="simple-live-progress"><span>{progress?.epoch?`Epoch ${progress.epoch}/${progress.total_epochs}`:postprocess?progress?.phase==="generating_calibration_predictions"?"Đang tạo probability masks":"Đang quét lưới cấu hình":"Đang khởi tạo"}<b>{progress?`${progress.percent}%`:"…"}</b></span><progress max="100" value={progress?.percent||0}/></div>}
      {gateRejected&&<div className="postprocess-gate-result" role="status"><Icon name="alert" size={18}/><div><b>Đã quét đủ {search.configurations?.length||0} cấu hình — không cấu hình nào đạt quality gate</b><p>Recall cao nhất {maximumRecall?.toFixed?.(3)??"—"}, yêu cầu ≥ {Number(search.constraints?.minimum_lesion_recall).toFixed(2)}. FP volume đạt giới hạn nhưng recall chưa đạt; locked test không được dùng để chọn lại.</p><small>Không tạo model mới · trọng số không đổi · locked test chưa được quan sát.</small></div></div>}
      <div className="simple-metric-grid">{postprocess?gateRejected?<>
        <SimpleMetric label="Threshold tham khảo" value={referenceConfig?.threshold?.toFixed?.(2)} detail="Dice cao nhất, chưa được khóa"/>
        <SimpleMetric label="Min component tham khảo" value={referenceConfig?.minimum_component_volume_mm3!=null?`${referenceConfig.minimum_component_volume_mm3} mm³`:"—"}/>
        <SimpleMetric label="Best validation Dice" value={referenceConfig?.mean_dice?.toFixed?.(3)}/>
        <SimpleMetric label="Recall cao nhất" value={maximumRecall?.toFixed?.(3)} detail={`Gate ≥ ${Number(search.constraints?.minimum_lesion_recall).toFixed(2)}`}/>
      </>:<><SimpleMetric label="Threshold khóa" value={metrics.operating_threshold?.toFixed?.(2)}/><SimpleMetric label="Min component" value={metrics.minimum_component_volume_mm3!=null?`${metrics.minimum_component_volume_mm3} mm³`:"—"}/><SimpleMetric label="Lesion recall (cal)" value={metrics.calibrated_validation_lesion_recall?.toFixed?.(3)}/><SimpleMetric label="HD95 (cal)" value={metrics.calibrated_validation_hd95_mm!=null?`${metrics.calibrated_validation_hd95_mm} mm`:"—"}/></>:<><SimpleMetric label="Best val Dice" value={metrics.best_validation_dice?.toFixed?.(3)}/><SimpleMetric label="Best epoch" value={metrics.best_epoch}/><SimpleMetric label="Thời gian" value={metrics.duration_seconds?`${Math.round(metrics.duration_seconds)} giây`:"—"}/><SimpleMetric label="Dataset" value={metrics.training_cases?`${metrics.training_cases} train`:"—"}/></>}</div>
      <div className="simple-focus-actions">{!gateRejected&&current.model_id&&["succeeded","failed"].includes(current.status)&&<button className="mlops-primary" disabled={busy||!caps.validation_configured} onClick={()=>requireActor()&&run(()=>validateTrainingRun(current.id,authorization))}><Icon name="shield" size={14}/>{current.status==="failed"?"Chạy lại kiểm định":"Chạy locked test một lần"}</button>}{search&&<a className="mlops-primary" href={current.monitor_url||`/model-studio?monitor=${current.id}`}><Icon name="chart" size={14}/> Xem báo cáo {search.configurations?.length||0} cấu hình</a>}<button className="mlops-secondary" disabled={busy} onClick={()=>{if(requireActor())run(async()=>saveBlob(await downloadTrainingLog(current.id,authorization),`${current.name}.log`));}}><Icon name="download" size={14}/> Tải log</button><details><summary>Metric kỹ thuật</summary><Json value={metrics}/></details></div>
    </article>:<EmptyState icon="chart" title={postprocess?"Chưa có đợt hiệu chỉnh":"Chưa có training run"} body="Huấn luyện và hiệu chỉnh cần extension được kết nối riêng."/>}
    <TrainingRunLauncher mode={fixedMode} datasets={datasets} models={models} caps={caps} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor}/>
    {workflowItems.length>1&&<details className="premium-card studio-history"><summary>Lịch sử {postprocess?"Postprocess":"Fine-tune"} <span>{workflowItems.length-1}</span></summary><div>{workflowItems.filter(x=>x.id!==current?.id).map(item=><article key={item.id}><div><b>{item.name}</b><small>{shortDate(item.updated_at)}</small></div><Status value={item.status}/>{item.error&&<small className="mlops-error-inline">{item.error}</small>}</article>)}</div></details>}
  </section>;
}

function ValidationPanel({runs,models,caps,authorization,busy,run,requireActor}) {
  const candidates=runs.filter(x=>x.model_id);
  const current=candidates[0]||null;
  const model=current?models.find(m=>m.id===current.model_id):null;
  const metrics=model?.metrics||current?.metrics||{};
  const awaiting=current&&["succeeded","failed"].includes(current.status);
  return <section className="mlops-dashboard simple-studio-page">
    <SimplePageHead eyebrow="ĐÁNH GIÁ ĐỘC LẬP" title="Kiểm định model" body="Kết quả trên tập dữ liệu khóa, không dùng trong training." status={<Status value={caps.validation_configured?"configured":"not-configured"}/>}/>
    {current?<article className="premium-card simple-focus-card"><div className="simple-focus-main"><span className="simple-focus-icon green"><Icon name="shield" size={22}/></span><div><small>KẾT QUẢ GẦN NHẤT</small><h3>{current.name}</h3><p>{current.status==="validated"?"Đã chạy xong trên tập kiểm định độc lập":"Đang chờ hoàn tất kiểm định"} · {shortDate(current.updated_at)}</p></div><Status value={current.status}/></div><div className="simple-metric-grid"><SimpleMetric label="Dice" value={metrics.mean_dice?.toFixed?.(3)}/><SimpleMetric label="Recall" value={metrics.lesion_recall?.toFixed?.(3)}/><SimpleMetric label="Precision" value={metrics.precision?.toFixed?.(3)}/><SimpleMetric label="Threshold" value={metrics.operating_threshold?.toFixed?.(2)}/></div><div className="simple-focus-actions">{awaiting&&<button className="mlops-primary" disabled={busy||!caps.validation_configured} onClick={()=>requireActor()&&run(()=>validateTrainingRun(current.id,authorization))}>{current.status==="failed"?"Chạy lại kiểm định":"Bắt đầu kiểm định"}</button>}<details><summary>Chi tiết kỹ thuật</summary><Json value={metrics}/></details></div></article>:<EmptyState icon="shield" title="Chưa có model để kiểm định" body="Model hoàn thành training sẽ xuất hiện tại đây."/>}
    {candidates.length>1&&<details className="premium-card studio-history"><summary>Lịch sử kiểm định <span>{candidates.length-1}</span></summary><div>{candidates.slice(1).map(item=><article key={item.id}><div><b>{item.name}</b><small>{shortDate(item.updated_at)}</small></div><Status value={item.status}/></article>)}</div></details>}
  </section>;
}

function RegistryActions({model,caps,actor,authorization,busy,run,requireActor}) {const {account}=useAppAuth();const isAdmin=account.role==="admin";return <div className="registry-primary-actions">{model.stage==="technical_validated"&&<button className="mlops-primary" disabled={busy} onClick={()=>requireActor()&&run(()=>approveModel(model.id,{gate:"clinical",decision:"approved",approver:actor,note:"Clinical validation approved"},authorization))}>Duyệt chuyên môn</button>}{model.stage==="clinical_validated"&&<>{!model.approvals?.some(a=>a.gate==="qa"&&a.decision==="approved")&&<button className="mlops-primary" disabled={busy} onClick={()=>requireActor()&&run(()=>approveModel(model.id,{gate:"qa",decision:"approved",approver:actor,note:"Release QA approved"},authorization))}>Duyệt phát hành</button>}<button className="mlops-secondary" disabled={!isAdmin||busy||!caps.deployment_configured||!model.approvals?.some(a=>a.gate==="qa"&&a.decision==="approved")} onClick={()=>requireActor()&&run(()=>transitionModel(model.id,{target_stage:"shadow",actor,note:"Start shadow evaluation"},authorization))}>Chạy thử Shadow</button></>}{model.stage==="shadow"&&<><ShadowEvidence model={model} authorization={authorization} busy={busy} run={run} requireActor={requireActor}/><button className="mlops-primary" disabled={!isAdmin||busy||!caps.deployment_configured||!model.shadow_evidence?.length} onClick={()=>requireActor()&&run(()=>transitionModel(model.id,{target_stage:"production",actor,note:"Promote after shadow evidence review"},authorization))}>Phát hành Production</button></>}</div>}

export { RegistryActions };

function RegistryPanel({items,caps,actor,authorization,busy,run,requireActor}) {
  const production=items.find(x=>x.stage==="production")||null;
  const candidate=items.find(x=>x.stage!=="production"&&!["archived","rejected"].includes(x.stage))||null;
  const focus=candidate||production;
  const history=items.filter(x=>x.id!==focus?.id&&x.id!==production?.id);
  const metrics=focus?.metrics||{};
  return <section className="mlops-dashboard simple-studio-page">
    <SimplePageHead eyebrow="PHÁT HÀNH MODEL" title="Model Registry" body="Chỉ hiển thị model đang dùng và model cần quyết định tiếp theo." status={<Status value={caps.deployment_configured?"configured":"not-configured"}/>}/>
    {production&&focus?.id!==production.id&&<div className="production-strip"><span><Icon name="checkCircle" size={16}/></span><div><b>Production hiện tại</b><strong>{production.name}</strong></div><Status value="production"/></div>}
    {focus?<article className="premium-card simple-focus-card"><div className="simple-focus-main"><span className="simple-focus-icon blue"><Icon name="cube" size={22}/></span><div><small>{candidate?"MODEL CẦN XỬ LÝ":"MODEL ĐANG PHÁT HÀNH"}</small><h3>{focus.name}</h3><p>Cập nhật {shortDate(focus.updated_at)}</p></div><Status value={focus.stage}/></div><div className="simple-metric-grid"><SimpleMetric label="Holdout Dice" value={metrics.mean_dice?.toFixed?.(3)}/><SimpleMetric label="Recall" value={metrics.lesion_recall?.toFixed?.(3)}/><SimpleMetric label="Best val Dice" value={metrics.best_validation_dice?.toFixed?.(3)}/><SimpleMetric label="Best epoch" value={metrics.best_epoch}/></div><div className="simple-focus-actions"><RegistryActions model={focus} caps={caps} actor={actor} authorization={authorization} busy={busy} run={run} requireActor={requireActor}/><details><summary>Thông tin truy vết</summary><Json value={{metrics:focus.metrics,approvals:focus.approvals,shadow_evidence:focus.shadow_evidence}}/></details></div></article>:<EmptyState icon="cube" title="Registry chưa có model" body="Model vượt qua kiểm định sẽ xuất hiện tại đây."/>}
    {history.length>0&&<details className="premium-card studio-history"><summary>Các model trước <span>{history.length}</span></summary><div>{history.map(model=><article key={model.id}><div><b>{model.name}</b><small>{shortDate(model.updated_at)}</small></div><Status value={model.stage}/></article>)}</div></details>}
  </section>;
}


function ShadowEvidence({model,authorization,busy,run,requireActor}){const [file,setFile]=useState(null);return <form className="shadow-evidence" onSubmit={e=>{e.preventDefault();if(file&&requireActor())run(()=>uploadShadowEvidence(model.id,file,"Prospective shadow report",authorization));}}><input type="file" accept="application/json,.json" required onChange={e=>setFile(e.target.files?.[0]||null)}/><button disabled={busy||!file}>Nạp shadow report</button></form>}
