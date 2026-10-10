import { trainingAvailable, TrainingUnavailable, isInferenceOnlyModel } from "../trainingAvailability";
import {useEffect, useRef, useState} from "react";
import {Icon} from "../icons";
import {createStudioRecipe, previewStudioRecipe, importStudioSource,
  saveStudioPolicy, prepareStudioDemo49, downloadTrainingLog, validateTrainingRun, releaseStudioRun} from "../api";
import {AutomationPolicy, RegistryActions, CurrentRunCard} from "./TrainingWorkspace";
import "./StudioWorkflow.css";
import {displayName} from "../caseLibrary";
import {useAppAuth} from "./AppAuth";

const number = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString("vi-VN", {maximumFractionDigits:digits, minimumFractionDigits:digits}) : "—";
const date = value => value ? new Date(value).toLocaleString("vi-VN", {day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}) : "Chưa đặt lịch";
const names = {reference:"Checkpoint gốc",production:"Đang sử dụng",candidate:"Ứng viên",technical_validated:"Chờ duyệt chuyên môn",clinical_validated:"Chờ phát hành",shadow:"Đang chạy thử",archived:"Lưu trữ",rejected:"Đã loại",queued:"Đang chờ",running:"Đang huấn luyện",succeeded:"Chờ đánh giá",validated:"Đã đánh giá",validation_queued:"Chờ đánh giá",validating:"Đang đánh giá",failed:"Lần chạy lỗi / không đạt"};
const activeStates = ["queued","running","validation_queued","validating"];
const triggerNames = {manual:"Thủ công",count:"Đủ nhãn mới",schedule:"Theo lịch",either:"Đủ nhãn hoặc đến lịch"};
const metric = (metrics, ...keys) => keys.map(key => metrics?.[key]).find(Number.isFinite);
const macroDice = metrics => metric(metrics, "mean_dice", "macro_dice");
const meanIou = metrics => metric(metrics, "mean_iou", "macro_iou", "pooled_iou", "iou");
const evaluationStudies = metrics => metric(metrics, "holdout_cases", "test_cases", "evaluation_cases");
const hd95 = metrics => metric(metrics, "mean_hd95_mm", "hd95_mm", "hd95");
const cohortOf = item => item?.cohort_summary||item?.preview?.cohorts||item?.cohorts||{};
const workflowDatasetName = item => {
  const cohort=cohortOf(item);
  if(cohort.reviewed_label_cases){
    return `${number(cohort.reviewed_label_cases)} ca đã label lại và duyệt`;
  }
  return displayName(item?.name)||"Dataset chưa đặt tên";
};
const modelName = (model,data) => {
  if (!model) return "Chưa xác định model";
  const serving=model.id===data?.studio?.serving?.fine_tune_model_id || model.id===data?.studio?.serving?.registered_model_id;
  return displayName(model.metrics?.display_name||model.name)||(serving?"Model Baseline-S":"Model thử nghiệm");
};
function Badge({children, tone="neutral"}) {return <span className={`sw-badge ${tone}`}>{children}</span>;}
function Heading({step,title,body,action}) {return <header className="sw-heading"><div><span className="sw-eyebrow">{step}</span><h1>{title}</h1><p>{body}</p></div>{action}</header>;}
function Stat({label,value,detail}) {return <div className="sw-stat"><span>{label}</span><strong>{value}</strong>{detail&&<small>{detail}</small>}</div>;}
function Empty({children}) {return <p className="sw-empty">{children}</p>;}
function Notice({children}) {return <div className="sw-notice"><Icon name="info" size={18}/><span>{children}</span></div>;}
function Split({splits={}}) {return <div className="sw-splits">{[["train","Huấn luyện"],["validation","Validation"],["test","Benchmark / test"]].map(([key,label])=><div key={key} className={key}><i/><span>{label}</span><b>{number(Array.isArray(splits[key])?splits[key].length:splits[key])}</b></div>)}</div>;}
function Metric({label,value,unit="",note}) {return <div className="sw-eval-metric"><span>{label}</span><strong>{value}</strong>{unit&&value!=="—"&&<em>{unit}</em>}{note&&<small>{note}</small>}</div>;}

function EvaluationMetrics({metrics={},compact=false,showStudies=true}) {
  const dice=macroDice(metrics), iou=meanIou(metrics), distance=hd95(metrics), studies=evaluationStudies(metrics);
  return <div className={`sw-evaluation-metrics ${compact?"compact":""} ${showStudies?"":"without-studies"}`}>
    {showStudies&&<Metric label="Study đánh giá" value={number(studies)} note="Theo volume"/>}
    <Metric label="Macro Dice" value={number(dice,3)} note="Trung bình theo study"/>
    <Metric label={Number.isFinite(metrics?.pooled_iou)?"Pooled IoU":"Macro IoU"} value={number(iou,3)} note={Number.isFinite(iou)?"Từ báo cáo đánh giá":"Chưa được đo"}/>
    <Metric label="HD95" value={number(distance,1)} unit="mm" note={Number.isFinite(distance)?"Khoảng cách biên":"Chưa được đo"}/>
    {!compact&&<Metric label="Recall" value={number(metric(metrics,"lesion_recall","recall"),3)} note="Theo báo cáo đánh giá"/>}
  </div>;
}

function Serving({data,compact=false}) {
  const serving=data.studio.serving||{};
  const model=data.models.find(m=>m.id===serving.registered_model_id);
  const live=data.studio.releases?.find(r=>r.status==="live"&&r.model_id===model?.id);
  const tier=data.inference.tiers?.[data.inference.default_tier];
  return <article className={`sw-card sw-serving ${compact?"compact":""}`}>
    <header><span className="sw-eyebrow">MODEL PHỤC VỤ PHÂN TÍCH AI</span><Badge tone={tier?.available?"green":"amber"}>{tier?.available?"Sẵn sàng nhận study":"Chưa sẵn sàng"}</Badge></header>
    <div className="sw-serving-title"><div><small>Đang dùng trong Clinical Reading</small><h2>Model {tier?.name||"—"}</h2><p>Phiên bản {serving.model_version||tier?.model_version||"chưa xác định"}</p></div></div>
    {compact&&<><small>{live?"Benchmark model quantized đang live":"Benchmark checkpoint tham chiếu"}</small><EvaluationMetrics metrics={live?.result?.metrics||model?.metrics} compact/></>}
  </article>;
}

function Overview({data,openTab,authorization}) {
  const serving=data.studio.serving||{};
  const model=data.models.find(item=>item.id===serving.registered_model_id)||null;
  const tier=data.inference.tiers?.[data.inference.default_tier]||null;
  const training=data.studio.training||{};
  const policy=training.policy||{};
  const activeRun=data.runs.find(item=>item.mode==="fine_tune"&&["queued","running","validation_queued","validating"].includes(item.status));
  const triggerTitle=activeRun?"Đang huấn luyện":({manual:"Chạy thủ công",count:"Khi đủ nhãn mới",schedule:"Theo lịch",either:"Đủ nhãn hoặc đến lịch"}[policy.trigger]||"Chưa cấu hình");
  const nextAt=policy.next_at?date(policy.next_at):"Chưa đặt lịch";
  const triggerDetail=activeRun
    ? `${activeRun.name} · ${names[activeRun.status]||activeRun.status}`
    : policy.trigger==="manual"
      ? "Chỉ bắt đầu khi người dùng bấm chạy trong Fine-tune."
      : policy.trigger==="count"
        ? `${number(training.new_pool_cases||0)}/${number(policy.min_new_cases||0)} Gold label mới.`
        : policy.trigger==="schedule"
          ? `Lần kiểm tra tiếp theo: ${nextAt}.`
          : policy.trigger==="either"
            ? `${number(training.new_pool_cases||0)}/${number(policy.min_new_cases||0)} Gold label mới · lịch ${nextAt}.`
            : "Chưa có điều kiện khởi chạy.";
  const modelVersion=serving.model_version||tier?.model_version||"Chưa có model";
  const backend=String(serving.backend||"").toUpperCase().includes("INT8")?"INT8":serving.backend||"—";
  const uploadedAt=model?.updated_at||model?.created_at;
  const uploadSource=model?.imported?"Checkpoint import":model?.training_run_id?"Fine-tune run":"Model Registry";
  const sourceLabels={ct_simulator:"CT Simulator",dicom_upload:"DICOM",nifti_upload:"NIfTI"};
  const automationSources=Array.isArray(data.automation?.sources)?data.automation.sources.map(source=>sourceLabels[source]||source):[];
  const pool=data.studio.pool||{};
  const lastSnapshot=training.last_snapshot||null;
  return <div className="sw-page sw-compact-overview">
    <Heading step="AI STUDIO / TỔNG QUAN" title="Tổng quan" body="Trạng thái model, dữ liệu và các khả năng đã được cung cấp."/>

    <section className="sw-model-strip">
      <div className="sw-model-strip-main"><span className={`sw-service-dot ${tier?.available?"online":"offline"}`}/><div><small>MODEL ĐANG CHẠY</small><strong>{modelVersion}</strong></div></div>
      <div className="sw-model-strip-meta"><span>Backend <b>{backend}</b></span><span>Dịch vụ <b className={tier?.available?"ok":"bad"}>{tier?.available?"Đã kết nối":"Ngoại tuyến"}</b></span><span>Đưa lên <b>{uploadedAt?date(uploadedAt):"—"}</b></span><span>Nguồn <b>{uploadSource}</b></span></div>
      <AutomationPolicy inference={data.inference} authorization={authorization} compact/>
    </section>

    <section className="sw-overview-essentials">
      <article className="sw-card sw-auto-explainer">
        <header><div><span className="sw-eyebrow">PHÂN TÍCH CT TỰ ĐỘNG</span><h2>Hệ thống làm gì khi nhận ca mới?</h2></div><Icon name="spark" size={19}/></header>
        <div className="sw-auto-flow"><div><b>1</b><span><strong>Nhận ca CT</strong><small>Từ nguồn tiếp nhận đã cấu hình</small></span></div><i>→</i><div><b>2</b><span><strong>Chạy {modelVersion}</strong><small>Cần dịch vụ inference được kết nối riêng</small></span></div><i>→</i><div><b>3</b><span><strong>Trả kết quả</strong><small>Mask, thể tích và vùng nghi ngờ trong Dữ liệu</small></span></div></div>
        <footer className="sw-auto-sources"><span>Áp dụng cho</span>{automationSources.length?automationSources.map(source=><b key={source}>{source}</b>):<b>Ca CT mới</b>}<small>Chính sách chỉ áp dụng từ thời điểm bật.</small></footer>
      </article>

      <article className="sw-card sw-next-training">
        <header><div><span className="sw-eyebrow">FINE-TUNE TIẾP THEO</span><h2>{trainingAvailable(data.caps)?triggerTitle:"Fine-tune chưa khả dụng"}</h2></div><Badge tone={trainingAvailable(data.caps)&&activeRun?"blue":"neutral"}>{!trainingAvailable(data.caps)?"Chưa khả dụng":activeRun?"Đang chạy":policy.enabled?"Đã bật":"Chưa tự động"}</Badge></header>
        <p>{trainingAvailable(data.caps)?triggerDetail:"Baseline S chỉ có ONNX; checkpoint, mã model huấn luyện và runtime chưa được cung cấp."}</p>
        <dl><div><dt>Nhãn mới</dt><dd>{number(training.new_pool_cases||0)}/{number(policy.min_new_cases||0)} ca</dd></div><div><dt>Lần gần nhất</dt><dd>{lastSnapshot?`${number(lastSnapshot.reviewed_label_cases)} ca đã đóng băng`:"Chưa có snapshot"}</dd></div><div><dt>Worker</dt><dd className={trainingAvailable(data.caps)&&data.caps.worker_alive?"ok":"bad"}>{trainingAvailable(data.caps)?data.caps.worker_alive?"Đã kết nối":"Ngoại tuyến":"Chưa cung cấp training runtime"}</dd></div></dl>
        <button type="button" onClick={()=>openTab("fine_tune")}>Mở Fine-tune <Icon name="chevron" size={14}/></button>
      </article>
    </section>

    <section className="sw-overview-data-section">
      <header><div><span className="sw-eyebrow">DỮ LIỆU SẴN SÀNG</span><h2>Ca bệnh → Labeling → Fine-tune</h2></div><button type="button" onClick={()=>openTab("datasets")}>Xem dữ liệu Fine-tune <Icon name="chevron" size={14}/></button></header>
      <div className="sw-overview-data-grid">
        <article className="sw-card sw-source-overview">
          <header><div><h3>Workflow gán nhãn</h3><p>Nguồn dữ liệu đầu vào được lưu để truy vết. Trigger chỉ đếm nhãn đủ điều kiện.</p></div><strong>{number(pool.total||0)}<small> ca</small></strong></header>
          <div className="sw-source-overview-list"><div><span className="ready"><i/>Ca bệnh đã đưa qua model</span><b>{number(pool.total||0)} ca</b><small>đầu vào nghiên cứu</small></div><div><span className="ready"><i/>Đã label lại và duyệt</span><b>{number(pool.approved||0)} ca</b><small>được tính cho trigger</small></div><div><span className={pool.pending?"missing":"ready"}><i/>Chưa hoàn tất duyệt</span><b>{number(pool.pending||0)} ca</b><small>không được đưa vào train</small></div></div>
        </article>
        <article className="sw-card sw-pool-overview">
          <header><div><h3>Snapshot Fine-tune gần nhất</h3><p>Chỉ revision từ Labeling đã duyệt được tính là dữ liệu học.</p></div><Badge tone={lastSnapshot?"green":"amber"}>{lastSnapshot?"Đã trigger":"Chưa tạo"}</Badge></header>
          <div className="sw-pool-numbers"><div><strong>{number(lastSnapshot?.reviewed_label_cases||0)}</strong><span>Nhãn đã duyệt</span><small>đã label lại · đủ điều kiện học</small></div><div><strong>{number(lastSnapshot?.learning_from_labeling||0)}</strong><span>Đưa vào train</span><small>từ workflow Labeling</small></div><div><strong>{number(lastSnapshot?.reference_validation_cases||0)}</strong><span>Validation</span><small>cohort tham chiếu, không tính trigger</small></div><div><strong>{number(lastSnapshot?.locked_test_cases||0)}</strong><span>Test khóa</span><small>chỉ quality gate</small></div></div>
        </article>
      </div>
    </section>
  </div>;
}

function SourceUpload({authorization,run,busy,onClose}) {
  const [name,setName]=useState(""); const [role,setRole]=useState("development");const [file,setFile]=useState(null);
  return <form className="sw-card sw-form" onSubmit={e=>{e.preventDefault();run(async()=>{await importStudioSource(file,name,role,authorization);onClose();});}}>
    <h2>Nhập cohort tham chiếu</h2><p>ZIP NIfTI gồm imagesTr và labelsTr. Cohort tham chiếu không được cộng vào trigger nhãn.</p>
    <div className="sw-fields"><label>Tên cohort<input required value={name} onChange={e=>setName(e.target.value)} placeholder="Ví dụ: Cohort validation nội bộ"/></label><label>Vai trò<select value={role} onChange={e=>setRole(e.target.value)}><option value="development">Validation / phát triển</option><option value="benchmark">Test khóa · quality gate</option></select></label></div>
    <label>Dataset ZIP<input type="file" required accept=".zip" onChange={e=>setFile(e.target.files[0])}/></label>
    <div className="sw-actions"><button className="sw-primary" disabled={busy||!file}>{busy?"Đang kiểm tra & nhập…":"Nhập dataset"}</button><button type="button" onClick={onClose} disabled={busy}>Hủy</button></div>
  </form>;
}

function RecipeBuilder({sources,pool,systemEvaluationIds=[],currentCohorts={},authorization,run,busy,onClose}) {
  const userSources=sources.filter(source=>source.managed_by!=="system");
  const [form,setForm]=useState({name:"",source_ids:systemEvaluationIds,include_pool:true,validation_percent:20,max_cases_per_source:0});
  const [preview,setPreview]=useState(null),[error,setError]=useState(""),[loading,setLoading]=useState(false);
  const request=useRef(0);
  useEffect(()=>{const version=++request.current;setPreview(null);setError("");setLoading(true);const timer=setTimeout(()=>{
    previewStudioRecipe({...form,name:form.name||"Preview"}).then(result=>{if(version===request.current)setPreview(result);}).catch(e=>{if(version===request.current)setError(e.message);}).finally(()=>{if(version===request.current)setLoading(false);});
  },250);return()=>{clearTimeout(timer);request.current++;};},[form]);
  const toggle=id=>setForm(current=>({...current,source_ids:current.source_ids.includes(id)?current.source_ids.filter(x=>x!==id):[...current.source_ids,id]}));
  return <form className="sw-card sw-builder" onSubmit={e=>{e.preventDefault();run(async()=>{await createStudioRecipe(form,authorization);onClose();});}}>
    <header><div><span className="sw-eyebrow">TẠO NHÓM DỮ LIỆU FINE-TUNE</span><h2>Gom các ca đã label và khóa tập đánh giá</h2></div><button type="button" onClick={onClose} aria-label="Đóng tạo dataset">×</button></header>
    <div className="sw-builder-grid"><div className="sw-form"><label>Tên nhóm dữ liệu<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Ví dụ: Nhãn đã duyệt tháng 9"/></label><fieldset><legend>1. Tập đánh giá cố định</legend><div className="sw-source-choice"><span><b>Validation {number(currentCohorts.reference_validation_cases||0)} ca · Test khóa {number(currentCohorts.locked_test_cases||0)} ca</b><small>Hệ thống quản lý nội bộ · không tính trigger · không đưa trực tiếp vào train</small></span></div>{userSources.map(s=><label className={`sw-source-choice ${!s.available?"unavailable":""}`} key={s.id}><input type="checkbox" checked={form.source_ids.includes(s.id)} disabled={!s.available} onChange={()=>toggle(s.id)}/><span><b>{displayName(s.name)}</b><small>{s.available?`${s.num_cases} study · ${s.role==="benchmark"?"test khóa":"tham chiếu phát triển"} · không tính trigger`:"Chưa có dữ liệu local"}</small></span></label>)}</fieldset>
    <fieldset><legend>2. Dữ liệu model sẽ học</legend><label className="sw-source-choice"><input type="checkbox" checked={form.include_pool} onChange={e=>setForm({...form,include_pool:e.target.checked})}/><span><b>Lấy revision đã duyệt từ Labeling</b><small>{pool.approved} ca đủ điều kiện. Nhãn nháp không được đưa vào train.</small></span></label></fieldset>
    <details><summary>Tùy chọn lấy mẫu & chia tập</summary><div className="sw-fields"><label>Validation (%)<input type="number" min="10" max="40" value={form.validation_percent} onChange={e=>setForm({...form,validation_percent:Number(e.target.value)})}/></label><label>Giới hạn study mỗi nguồn<input type="number" min="0" value={form.max_cases_per_source} onChange={e=>setForm({...form,max_cases_per_source:Number(e.target.value)})}/><small>0 = toàn bộ · benchmark luôn giữ nguyên</small></label></div></details></div>
    <aside className="sw-preview"><span className="sw-eyebrow">3. XEM TRƯỚC</span><h3>{loading?"Đang tính…":`${preview?.cohorts?.reviewed_label_cases||0} ca đã duyệt`}</h3><Split splits={preview?.splits}/><small>Train từ Labeling: {number(preview?.cohorts?.learning_from_labeling||0)} · nguồn import trực tiếp: {number(preview?.cohorts?.learning_from_import||0)}</small>{preview?.cohorts?.learning_from_import>0&&<Notice>Có ca import trực tiếp đang rơi vào train. Chỉ giữ nếu đây là chủ đích.</Notice>}{preview?.excluded>0&&<small>{preview.excluded} bản trùng được loại theo patient/digest.</small>}{error&&<p role="alert" className="sw-error">{error}</p>}{preview&&!preview.ready&&<Notice>Chưa đủ train, validation và test khóa.</Notice>}<button className="sw-primary" disabled={busy||loading||!preview?.num_cases}>Tạo snapshot</button></aside></div>
  </form>;
}

function Datasets({data,openTab,authorization,run,busy,onNavigate}) {
  const {sources,recipes,pool}=data.studio;
  const [sub,setSub]=useState("custom"),[building,setBuilding]=useState(false),[uploading,setUploading]=useState(false);
  const snapshotFor=recipe=>data.datasets.find(dataset=>dataset.manifest?.recipe_id===recipe.id);
  const userSources=sources.filter(source=>source.managed_by!=="system");
  const systemEvaluationIds=data.studio.training.recipe?.source_ids||[];
  const currentCohorts=data.studio.training.current_cohorts||{};
  return <div className="sw-page"><Heading step="AI STUDIO / HUẤN LUYỆN / DATASET" title="Dữ liệu Fine-tune" body="Theo dõi các ca đã đi qua Labeling, đủ điều kiện trigger và được đóng băng cho từng lần train." action={sub==="custom"?<button className="sw-primary" onClick={()=>setBuilding(true)}>+ Tạo nhóm dữ liệu</button>:<button className="sw-primary" onClick={()=>setUploading(value=>!value)}>+ Nhập tập tham chiếu</button>}/>
    <div className="sw-dataset-explainer"><div><b>Ca bệnh đầu vào</b><span>Nguồn dữ liệu đầu vào được ghi để truy vết</span></div><i>→</i><div><b>AI → Labeling → duyệt</b><span>Chỉ revision đã label và duyệt được tính cho fine-tune</span></div></div>
    <nav className="sw-tabs" aria-label="Loại dữ liệu">{[["custom","Nhóm dữ liệu từ Labeling",recipes.length],["sources","Nguồn tự nhập",userSources.length]].map(([id,label,count])=><button key={id} className={sub===id?"active":""} onClick={()=>setSub(id)}>{label}<span>{count}</span></button>)}</nav>
    {building&&sub==="custom"&&<RecipeBuilder {...{sources,pool,systemEvaluationIds,currentCohorts,authorization,run,busy}} onClose={()=>setBuilding(false)}/>} 
    {sub==="custom"&&<div className="sw-table-wrap"><table><thead><tr><th>Nhóm dữ liệu</th><th>Hình thành từ</th><th>Nhãn đã duyệt</th><th>Đưa vào train</th><th>Validation tham chiếu</th><th>Test khóa</th><th>Trigger</th><th/></tr></thead><tbody>{recipes.map(recipe=>{const cohort=recipe.preview.cohorts||{};const snapshot=snapshotFor(recipe);return <tr key={recipe.id}><td><b>{displayName(recipe.name)}</b><small>{workflowDatasetName(recipe)}</small><small>Tạo {date(recipe.created_at)}</small></td><td><b>Workflow Labeling</b><small>Revision đã label lại và duyệt</small></td><td>{number(cohort.reviewed_label_cases||0)}</td><td>{number(cohort.learning_from_labeling||0)}<small>{cohort.learning_from_import?`+ ${number(cohort.learning_from_import)} ca import trực tiếp`:"Không lấy dữ liệu ngoài nhóm đã chọn"}</small></td><td>{number(cohort.reference_validation_cases||0)}</td><td>{number(cohort.locked_test_cases||0)}</td><td><Badge tone={snapshot?"green":recipe.preview.ready?"blue":"amber"}>{snapshot?"Đã có snapshot":recipe.preview.ready?"Đủ điều kiện":"Chưa đủ"}</Badge>{snapshot&&<small>{date(snapshot.created_at)}</small>}</td><td><button className="sw-primary" disabled={!recipe.preview.ready} onClick={()=>{sessionStorage.setItem("brainhem.studio-recipe",recipe.id);openTab("fine_tune");}}>Mở kế hoạch</button></td></tr>})}</tbody></table>{!recipes.length&&<Empty>Chưa có nhóm dữ liệu từ Labeling.</Empty>}</div>}
    {sub==="sources"&&<><div className="sw-section-head"><div><h2>Nguồn do người dùng nhập</h2><p>Tập validation/test cố định được hệ thống quản lý nội bộ và không hiển thị như dataset huấn luyện.</p></div><button onClick={()=>setUploading(!uploading)}>+ Nhập tập tham chiếu</button></div>{uploading&&<SourceUpload {...{authorization,run,busy}} onClose={()=>setUploading(false)}/>}<div className="sw-dataset-explainer"><div><b>Tập kiểm định hệ thống</b><span>{number(currentCohorts.reference_validation_cases||0)} validation · {number(currentCohorts.locked_test_cases||0)} test khóa</span></div><i>·</i><div><b>Không tính trigger</b><span>Không đưa trực tiếp vào train</span></div></div>{userSources.length?<div className="sw-table-wrap"><table><thead><tr><th>Cohort tham chiếu</th><th>Study local</th><th>Mục đích</th><th>Tính vào trigger</th><th>Trạng thái</th></tr></thead><tbody>{userSources.map(s=><tr key={s.id}><td><b>{displayName(s.name)}</b><small>Provenance / đánh giá kỹ thuật</small></td><td>{number(s.num_cases)}</td><td>{s.role==="benchmark"?"Test khóa":"Validation / đối chiếu"}</td><td><Badge tone="neutral">Không</Badge></td><td><Badge tone={s.available?"green":"amber"}>{s.available?s.expected_cases&&s.num_cases<s.expected_cases?"Có một phần":"Sẵn sàng":"Cần nhập dữ liệu"}</Badge></td></tr>)}</tbody></table></div>:<Empty>Chưa có nguồn tham chiếu nào do người dùng nhập.</Empty>}</>}
  </div>;
}

function ReleasePanel({data,authorization,run,busy}) {
  const {account}=useAppAuth();
  const isAdmin=account.role==="admin";
  const releases=data.studio.releases||[];
  const enabled=Boolean(data.studio.training.policy.auto_deploy);
  const eligible=data.runs.filter(r=>r.status==="validated"&&r.metrics?.validation_gate?.passed&&!releases.some(item=>item.run_id===r.id));
  const labels={queued:"Chờ deploy",building:"Đang deploy",live:"Đang live",superseded:"Đã thay thế",failed:"Deploy lỗi — giữ model cũ",cancelled:"Đã hủy — giữ model cũ"};
  const phases={exporting:"Export ONNX",quantizing:"Chuẩn bị artifact",quantized_validation:"Đánh giá model quantized",ready:"Sẵn sàng chuyển live"};
  return <section className="sw-card" data-testid="auto-release-panel"><header className="sw-section-head"><div><h2>Deploy sau quality gate</h2><p>Đủ ca → Train → Gate → Extension phát hành → Tag → Baseline S.</p></div><Badge tone={enabled?"green":"neutral"}>{enabled?"Tự deploy bật":"Tự deploy tắt"}</Badge></header><p>Auto-live dành cho hệ thống local nghiên cứu. Không thay thế phê duyệt lâm sàng. Lỗi build/gate không đổi model đang phục vụ; M/L chưa được cung cấp trong bản public.</p>{releases.slice(0,5).map(item=><article key={item.id} style={{padding:"12px 0",borderTop:"1px solid var(--sw-border)",overflowWrap:"anywhere"}}><Badge tone={item.status==="live"?"green":item.status==="failed"?"amber":"blue"}>{labels[item.status]||item.status}</Badge><p><b>{item.tag}</b></p>{item.progress&&item.status==="building"&&<small>{phases[item.progress.phase]||item.progress.phase}{item.progress.total_cases?` · ${item.progress.completed_cases}/${item.progress.total_cases} ca`:""}</small>}{item.result&&<small>Gate quantized đạt · Dice {number(item.result.metrics.mean_dice,4)} · Recall {number(item.result.metrics.lesion_recall,4)}</small>}{item.error&&<p role="status">{item.error}</p>}</article>)}{enabled&&eligible.map(item=><div className="sw-actions" key={item.id}><span>{item.name} · đã đạt gate</span><button type="button" disabled={!data.studio.auto_deploy?.configured||!isAdmin||busy||releases.some(r=>["queued","building"].includes(r.status))} onClick={()=>run(()=>releaseStudioRun(item.id,authorization))}>Deploy model đã đạt gate</button></div>)}{!releases.length&&<small>{enabled?"Các lượt mới sẽ tự deploy sau khi đạt gate. Lượt đã hoàn tất có thể deploy bằng nút bên trên.":"Bật tùy chọn trong Chỉnh sửa kế hoạch để tự deploy các lượt tiếp theo."}</small>}</section>;
}

function Training({data,authorization,run,busy,openTab}) {
  const {account}=useAppAuth();
  const isAdmin=account.role==="admin";
  const {training,recipes,model_readiness}=data.studio;
  const [form,setForm]=useState(()=>{const choice=sessionStorage.getItem("brainhem.studio-recipe");sessionStorage.removeItem("brainhem.studio-recipe");return {...training.policy,recipe_id:choice||training.policy.recipe_id};});
  const [changed,setChanged]=useState(Boolean(form.recipe_id!==training.policy.recipe_id));
  const [editing,setEditing]=useState(false);
  const [selectedRun,setSelectedRun]=useState(null);
  const [demoVisible,setDemoVisible]=useState(false);
  const [preparingDemo,setPreparingDemo]=useState(false);
  const demoRequest=useRef(false);
  useEffect(()=>{
    if(!isAdmin)return;
    const toggle=event=>{
      if(event.key==="Escape"){setDemoVisible(false);return;}
      if(event.altKey&&event.shiftKey&&event.code==="KeyD"&&!event.repeat){event.preventDefault();setDemoVisible(value=>!value);}
    };
    window.addEventListener("keydown",toggle);
    return ()=>window.removeEventListener("keydown",toggle);
  },[isAdmin]);
  async function prepareDemo(){
    if(!isAdmin||demoRequest.current)return;
    demoRequest.current=true;setDemoVisible(false);setPreparingDemo(true);
    try{await run(async()=>{const result=await prepareStudioDemo49(authorization);setForm(result.policy);setChanged(false);setEditing(false);});}
    finally{demoRequest.current=false;setPreparingDemo(false);}
  }
  useEffect(()=>{if(selectedRun)document.querySelector(".sw-run-detail")?.scrollIntoView({behavior:"smooth",block:"start"});},[selectedRun]);
  const update=values=>{setForm({...form,...values});setChanged(true);};
  const recipe=recipes.find(r=>r.id===form.recipe_id);
  const base=data.models.find(m=>m.id===form.base_model_id);
  const extension=base?.metrics?.training_runner==="extension_runner";
  const recent=data.runs.filter(r=>r.mode==="fine_tune");
  const blocker=model_readiness[form.base_model_id];
  const fineTuneOptions=(data.studio.fine_tune_options||[]).filter(option=>!isInferenceOnlyModel(data.models.find(model=>model.id===option.model_id)));
  const baselineNames=new Set(fineTuneOptions.map(option=>String(option.name||"").toUpperCase()));
  async function save(e) {e.preventDefault();if(!isAdmin||!trainingAvailable(data.caps)||blocker||isInferenceOnlyModel(base))return;run(async()=>{await saveStudioPolicy(form,authorization);setChanged(false);setEditing(false);});}
  if (!trainingAvailable(data.caps)) return <div className="sw-page">
    <Heading step="AI STUDIO / HUẤN LUYỆN" title="Fine-tune & đánh giá" body="Baseline S được cung cấp dưới dạng ONNX cho suy luận."/>
    <TrainingUnavailable caps={data.caps}/>
    <section className="sw-card"><h2>Lịch sử Fine-tune</h2>{recent.length ? recent.map(item => <p key={item.id}>{displayName(item.name)} · {names[item.status] || item.status}</p>) : <Empty>Chưa có lần Fine-tune nào.</Empty>}</section>
  </div>;
  return <div className="sw-page"><Heading step="AI STUDIO / HUẤN LUYỆN" title="Fine-tune & đánh giá" body="Lập kế hoạch với extension huấn luyện đã được kết nối."/>
    {training.policy.last_error&&<Notice>Lần tự động trước gặp lỗi và đã tạm tắt: {training.policy.last_error}</Notice>}
    <section className="sw-card sw-plan-bar"><div><span className="sw-eyebrow">KẾ HOẠCH FINE-TUNE</span><strong>{["count","either"].includes(form.trigger)?`Đủ ${form.min_new_cases} nhãn đã duyệt mới`:triggerNames[form.trigger]}</strong></div><dl><div><dt>Model</dt><dd>{base?modelName(base,data):"Chưa chọn"}</dd></div><div><dt>Dữ liệu học</dt><dd>{recipe?workflowDatasetName(recipe):"Chưa chọn"}</dd></div><div><dt>Huấn luyện</dt><dd>{form.epochs} epoch · LR {form.learning_rate} · batch {form.batch_size}</dd></div></dl><div className="sw-plan-bar-actions"><Badge tone={data.caps.worker_alive?"green":"amber"}>{data.caps.worker_alive?"Worker online":"Worker offline"}</Badge><button type="button" disabled={!isAdmin} title={!isAdmin?"Chỉ quản trị viên":""} onClick={()=>setEditing(value=>!value)}>{editing?"Đóng":"Chỉnh sửa"}</button></div></section>
    <section className="sw-card" data-testid="training-trigger-status" aria-live="polite">
      <div className="sw-section-head"><div><span className="sw-eyebrow">THEO DÕI TRIGGER</span><h2>{number(training.new_pool_cases||0)} / {number(training.policy.min_new_cases||0)} nhãn mới đã duyệt</h2></div><Badge tone={training.policy.enabled?"green":"neutral"}>{training.policy.enabled?"Tự động đang bật":"Tự động đang tắt"}</Badge></div>
      <p>{training.reason}</p>
      <small>Nhóm đang theo dõi: {displayName(training.recipe?.name)||"Chưa chọn"}. Nhãn đang nháp và các ca validation/test tham chiếu không được tính vào ngưỡng.</small>
      {training.last_snapshot&&<p>Snapshot của lượt gần nhất{training.last_snapshot.recipe_id && training.last_snapshot.recipe_id!==training.policy.recipe_id ? " (kế hoạch trước)" : ""}: <b>{number(training.last_snapshot.reviewed_label_cases)} ca có nhãn đã duyệt</b> · {number(training.last_snapshot.total_packaged_cases)} ca tổng cộng.</p>}
      <p><small>Snapshot dữ liệu được tạo tự động khi bắt đầu huấn luyện. Sau khi tạo lượt chạy, bộ đếm nhãn chưa dùng được cập nhật cho lượt tiếp theo.</small></p>
      <button type="button" className="sw-text-button" onClick={()=>openTab("datasets")}>Xem nhóm dữ liệu và snapshot →</button>
    </section>
    {editing&&<form className="sw-training-grid" onSubmit={save}><div className="sw-card sw-form"><h2><span className="sw-step">2</span> Dataset & model</h2><label>Nhóm dữ liệu nhãn đã duyệt<select required value={form.recipe_id} onChange={e=>update({recipe_id:e.target.value})}><option value="">Chọn nhóm dữ liệu</option>{recipes.map(r=><option key={r.id} value={r.id}>{displayName(r.name)} · {workflowDatasetName(r)}</option>)}</select></label>{recipe&&<><Split splits={recipe.preview.splits}/><small>Trigger chỉ đếm {number(recipe.preview.cohorts?.reviewed_label_cases||0)} revision từ Labeling; validation/test tham chiếu không được cộng.</small></>}<button className="sw-text-button" type="button" onClick={()=>openTab("datasets")}>Quản lý dữ liệu Fine-tune →</button><label>Model<select required value={form.base_model_id} onChange={e=>{const option=fineTuneOptions.find(item=>item.model_id===e.target.value);const chosen=data.models.find(m=>m.id===e.target.value);update({base_model_id:e.target.value,model_variant:option?.model_variant||option?.variants?.[0]||"",batch_size:4});}}><option value="">Chọn model</option>{fineTuneOptions.map(option=>{const model=data.models.find(item=>item.id===option.model_id);return <option key={option.model_id} value={option.model_id}>{model?modelName(model,data):option.name}{option.is_baseline?" · đang phục vụ":""}</option>;})}{!baselineNames.has("MODEL BASELINE-M")&&<option disabled>M · extension chưa được cung cấp</option>}{!baselineNames.has("MODEL BASELINE-L")&&<option disabled>L · extension chưa được cung cấp</option>}</select></label>{blocker&&<Notice>{blocker}</Notice>}
    {extension&&<div className="sw-runner-ready"><Badge tone="green">Extension đã cấu hình</Badge><label>Phạm vi cập nhật<select value={form.finetune_scope||"adapter_head"} onChange={e=>update({finetune_scope:e.target.value})}><option value="adapter_head">Phạm vi do extension cung cấp</option><option value="full">Toàn bộ model</option></select></label></div>}
    <h2><span className="sw-step">1</span> Điều kiện chạy</h2><div className="sw-trigger-options">{Object.entries(triggerNames).map(([id,title])=><label key={id} className={form.trigger===id?"selected":""}><input type="radio" name="trigger" value={id} checked={form.trigger===id} onChange={()=>update({trigger:id,enabled:id!=="manual"})}/><span><b>{title}</b></span></label>)}</div><div className="sw-fields">{["count","either"].includes(form.trigger)&&<label>Số Gold label mới<input type="number" min="1" max="100000" value={form.min_new_cases} onChange={e=>update({min_new_cases:Number(e.target.value)})}/></label>}{["schedule","either"].includes(form.trigger)&&<label>Chu kỳ (ngày)<input type="number" min="1" max="365" value={form.interval_days} onChange={e=>update({interval_days:Number(e.target.value)})}/></label>}</div>{form.trigger!=="manual"&&<label className="sw-source-choice"><input type="checkbox" checked={form.enabled} onChange={e=>update({enabled:e.target.checked})}/><span><b>Tự động chạy</b></span></label>}
    <details><summary>Thông số huấn luyện</summary><div className="sw-fields"><label>Epoch<input type="number" min="1" max="1000" value={form.epochs} onChange={e=>update({epochs:Number(e.target.value)})}/></label><label>Learning rate<input type="number" min="0.0000001" max="0.1" step="any" value={form.learning_rate} onChange={e=>update({learning_rate:Number(e.target.value)})}/></label><label>Batch size<input type="number" min="1" step="1" max="128" value={form.batch_size} onChange={e=>update({batch_size:Number(e.target.value)})}/></label></div></details>
    </div><aside className="sw-card sw-plan"><span className="sw-eyebrow">XÁC NHẬN THAY ĐỔI</span><dl className="sw-facts"><div><dt>Phạm vi học</dt><dd>{extension?(form.finetune_scope==="full"?"Toàn bộ model":"Phạm vi do extension cung cấp"):"Chưa hỗ trợ"}</dd></div><div><dt>Đánh giá</dt><dd>{form.auto_validate?"Sau training":"Không tự động"}</dd></div><div><dt>Deploy</dt><dd>{form.auto_deploy?"Tự phát hành qua extension khi đạt gate":"Không tự deploy"}</dd></div></dl><label className="sw-source-choice"><input type="checkbox" checked={form.auto_validate} disabled={Boolean(form.auto_deploy)} onChange={e=>update({auto_validate:e.target.checked})}/><span><b>Đánh giá sau training</b></span></label><label className="sw-source-choice"><input aria-label="Tự deploy sau quality gate" type="checkbox" checked={Boolean(form.auto_deploy)} disabled={!data.studio.auto_deploy?.configured||!extension||form.model_variant!=="S"} onChange={e=>update({auto_deploy:e.target.checked,...(e.target.checked?{auto_validate:true}:{})})}/><span><b>Tự deploy sau quality gate</b><small>Cần extension phát hành riêng và đánh giá trước khi kích hoạt.</small></span></label>{form.auto_deploy&&<label className="sw-source-choice"><input type="checkbox" checked={form.follow_deployed_model??true} onChange={e=>update({follow_deployed_model:e.target.checked})}/><span><b>Dùng model mới cho lần fine-tune tiếp theo</b><small>Tắt để tiếp tục dùng model gốc bạn chọn.</small></span></label>}{!data.studio.auto_deploy?.configured&&<small>Backend chưa cấu hình auto-live local.</small>}<button className="sw-primary" disabled={!trainingAvailable(data.caps)||Boolean(blocker)||busy||!form.recipe_id||!form.base_model_id||!form.model_variant}>{busy?"Đang xử lý…":"Lưu kế hoạch"}</button>{changed&&<small>Có thay đổi chưa lưu.</small>}{blocker&&<small>{blocker}</small>}</aside></form>}
    {recent.find(item=>activeStates.includes(item.status))&&(()=>{const active=recent.find(item=>activeStates.includes(item.status));const progress=active.metrics?.live_progress;return <section className="sw-card" data-testid="automatic-run-status"><div className="sw-section-head"><div><span className="sw-eyebrow">LƯỢT ĐANG XỬ LÝ</span><h2>{active.name}</h2></div><Badge tone="blue">{names[active.status]||active.status}</Badge></div><p>{active.config?.studio_trigger==="count"?"Tự kích hoạt khi đủ nhãn mới":"Lượt huấn luyện đang xử lý"} · {active.config?.epochs} epoch · batch {active.config?.batch_size}</p><p>{progress?.phase==="preprocessing"?`Chuẩn bị dữ liệu: ${progress.processed_cases||0}/${progress.total_cases||0} ca`:progress?.epoch?`Epoch ${progress.epoch}/${progress.total_epochs||active.config?.epochs}`:"Đã nhận lượt chạy; đang khởi tạo."}</p><small>Mã lượt chạy: {active.id}<br/>Snapshot: {active.dataset_version_id}</small><div className="sw-actions"><button className="sw-primary" onClick={()=>setSelectedRun(active.id)}>Xem đầy đủ lượt đang chạy</button></div></section>;})()}
    <ReleasePanel data={data} authorization={authorization} run={run} busy={busy}/>
    <section className="sw-card sw-run-history"><div className="sw-section-head"><h2>Lịch sử Fine-tune</h2><Badge tone="blue">{recent.length} lần chạy</Badge></div>{recent.length?<div className="sw-table-wrap"><table><thead><tr><th>Lần fine-tune</th><th>Model</th><th>Dữ liệu học</th><th>Study eval</th><th>Macro Dice</th><th>IoU</th><th>HD95</th><th>Recall</th><th>Gate</th><th/></tr></thead><tbody>{recent.map(r=>{const m=r.metrics||{};const gate=m.validation_gate;const baseModel=data.models.find(item=>item.id===r.base_model_id);const dataset=data.datasets.find(d=>d.id===r.dataset_version_id);return <tr key={r.id} className={r.id===selectedRun?"selected":""}><td><b>{displayName(r.name)}</b><small>{date(r.created_at)}</small></td><td><b>{baseModel?modelName(baseModel,data):`Model-${m.model_variant||"S"}`}</b><small>Gốc {r.base_model_id?.slice(0,8).toUpperCase()||"—"}</small></td><td>{dataset?workflowDatasetName(dataset):displayName(m.dataset_name)||"—"}</td><td>{number(evaluationStudies(m))}</td><td><b>{number(macroDice(m),3)}</b></td><td>{number(meanIou(m),3)}</td><td>{Number.isFinite(hd95(m))?`${number(hd95(m),1)} mm`:"—"}</td><td>{number(metric(m,"lesion_recall","recall"),3)}</td><td><Badge tone={gate?.passed?"green":gate?"amber":activeStates.includes(r.status)?"blue":"neutral"}>{gate?.passed?"Đạt":gate?"Không đạt":names[r.status]||r.status}</Badge></td><td><button onClick={()=>setSelectedRun(selectedRun===r.id?null:r.id)}>{selectedRun===r.id?"Đóng":"Xem đầy đủ"}</button></td></tr>})}</tbody></table></div>:<Empty>Chưa có lần Fine-tune nào.</Empty>}{selectedRun&&<div className="sw-run-detail">{(()=>{const selected=data.runs.find(r=>r.id===selectedRun);const dataset=selected&&data.datasets.find(d=>d.id===selected.dataset_version_id);return selected?<><div className="sw-selected-evaluation"><div><span className="sw-eyebrow">KẾT QUẢ LẦN CHẠY</span><h2>{selected.name}</h2><p>{dataset?workflowDatasetName(dataset):displayName(selected.metrics?.dataset_name)||"Chưa có tập đánh giá"}</p></div><EvaluationMetrics metrics={selected.metrics}/></div><CurrentRunCard run={selected} caps={data.caps} title="Biểu đồ và thông số huấn luyện"/><div className="sw-actions"><button disabled={busy} onClick={()=>run(async()=>{const blob=await downloadTrainingLog(selectedRun,authorization);const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="training.log";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})}>Tải log</button>{["succeeded","failed"].includes(selected.status)&&<button disabled={busy||!data.caps.validation_configured} onClick={()=>run(()=>validateTrainingRun(selectedRun,authorization))}>Chạy đánh giá model</button>}</div></>:null;})()}</div>}</section>
  </div>;
}

function Models({data,openTab,...props}) {
  const [filter,setFilter]=useState("reference"),[selected,setSelected]=useState(null),[query,setQuery]=useState("");
  useEffect(()=>{if(selected)document.querySelector('.sw-model-detail')?.scrollIntoView({behavior:"smooth",block:"start"});},[selected]);
  const servingId=data.studio.serving?.registered_model_id;
  const releaseFor=model=>(data.studio.releases||[]).find(r=>r.model_id===model.id&&r.result);
  const filtered=data.models.filter(m=>filter==="all"||filter==="reference"&&(m.imported||m.stage==="production"||m.id===servingId)||filter==="candidates"&&m.parent_model_id&&!['archived','rejected'].includes(m.stage)).filter(m=>`${modelName(m,data)} ${m.id} ${releaseFor(m)?.tag||""}`.toLowerCase().includes(query.toLowerCase()));
  const detail=data.models.find(m=>m.id===selected);
  return <div className="sw-page"><Heading step="AI STUDIO / MODEL" title="Model & kết quả đánh giá" body="Biết chính xác phiên bản nào đang được sử dụng, model nào đang thử nghiệm và kết quả đến từ đâu."/>
    <Serving data={data} compact/>
    <div className="sw-model-toolbar"><nav className="sw-tabs" aria-label="Nhóm model">{[["all","Tất cả"],["reference","Model gốc / đang dùng"],["candidates","Ứng viên fine-tune"]].map(([id,label])=><button key={id} className={filter===id?"active":""} onClick={()=>setFilter(id)}>{label}</button>)}</nav><input aria-label="Tìm model" placeholder="Tìm model hoặc mã phiên bản…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="sw-table-wrap"><table><thead><tr><th>Model / phiên bản</th><th>Vai trò</th><th>Dice macro</th><th>Tập đánh giá</th><th>Bước tiếp theo</th><th/></tr></thead><tbody>{filtered.map(m=>{const release=releaseFor(m);const metrics=release?.result?.metrics||m.metrics;return <tr key={m.id} className={m.id===selected?"selected":""}><td><b>{modelName(m,data)}</b><small style={{overflowWrap:"anywhere"}}>{release?.tag||m.id.slice(0,12)}</small></td><td><Badge tone={m.id===servingId?"green":"neutral"}>{m.id===servingId?"Đang phục vụ":names[m.stage]||m.stage}</Badge></td><td><b>{number(metrics?.mean_dice,3)}</b><small>{release?"Model quantized":m.imported?"Checkpoint tham chiếu":"Kết quả run đã lưu"}</small></td><td>{metrics?.holdout_cases?`${metrics.holdout_cases} study`:"Chưa đánh giá"}<small>{displayName(m.metrics?.dataset_name)||"Xem chi tiết run"}</small></td><td>{m.id===servingId?"Có thể fine-tune":m.imported?"Xem benchmark":m.metrics?.validation_gate?.passed===false?"Chưa đạt · cần cải thiện":names[m.stage]||"Xem kết quả"}</td><td><button onClick={()=>setSelected(selected===m.id?null:m.id)}>Xem model</button></td></tr>;})}</tbody></table>{!filtered.length&&<Empty>Không có model trong nhóm này.</Empty>}</div>
    {detail&&<section className="sw-card sw-model-detail"><header><div><span className="sw-eyebrow">CHI TIẾT MODEL</span><h2>{modelName(detail,data)}</h2></div><button onClick={()=>setSelected(null)} aria-label="Đóng chi tiết model">×</button></header><div className="sw-stat-row"><Stat label="Dice macro theo ca" value={number(detail.metrics?.mean_dice,6)}/><Stat label="Số study đánh giá" value={number(detail.metrics?.holdout_cases)}/><Stat label="Median Dice" value={number(detail.metrics?.median_dice,3)}/><Stat label="Pooled Dice" value={number(detail.metrics?.pooled_dice,3)} detail="Không tương đương macro Dice"/></div>{detail.imported?<><Notice>{detail.metrics.benchmark_note}</Notice><a className="sw-link-button" href={`/api/v1/studio/models/${encodeURIComponent(detail.id)}/benchmark`} download>Tải báo cáo benchmark gốc</a></>:<RegistryActions model={detail} caps={data.caps} {...props}/>} 
    <dl className="sw-facts"><div><dt>Model cha</dt><dd>{detail.parent_model_id?modelName(data.models.find(m=>m.id===detail.parent_model_id),data):"Checkpoint gốc"}</dd></div><div><dt>Fine-tune</dt><dd>{data.studio.fine_tune_options?.some(option=>option.model_id===detail.id)?"Được phép":data.studio.model_readiness[detail.id]||"Không áp dụng"}</dd></div></dl><details><summary>Thông tin kỹ thuật dành cho truy vết</summary><p className="sw-hash">ID: {detail.id} · SHA-256: {detail.artifact_sha256}</p><pre>{JSON.stringify(detail.metrics,null,2)}</pre></details></section>}
    <Notice>So sánh model chỉ có ý nghĩa khi cùng cohort, cách tính Dice và cấu hình inference. Chỉ so sánh khi các điều kiện đánh giá tương đồng.</Notice>
  </div>;
}

export default function StudioWorkflow({tab,data,...props}) {
  if(!data.studio) return <div className="sw-page"><Empty>Đang tải trạng thái AI Studio…</Empty></div>;
  return tab==="overview"?<Overview data={data} {...props}/>:tab==="datasets"?<Datasets data={data} {...props}/>:tab==="registry"?<Models data={data} {...props}/>:<Training key={data.studio.training.policy.updated_at||"new"} data={data} {...props}/>;
}
