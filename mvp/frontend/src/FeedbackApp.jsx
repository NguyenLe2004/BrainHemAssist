import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { getFeedbackStatus, listFeedback, submitFeedback } from "./api";
import { useAppAuth } from "./components/AppAuth";
import "./FeedbackApp.css";
import "./FeedbackAdmin.css";

const ROLES = ["Bác sĩ Chẩn đoán hình ảnh", "Kỹ thuật viên CT", "Điều dưỡng / Nhân viên y tế", "Kỹ sư AI / IT", "Quản trị viên", "Người dùng khác"];
const CATEGORIES = [
  ["bug", "Báo lỗi", "Một chức năng hoạt động không đúng"],
  ["suggestion", "Đề xuất cải tiến", "Ý tưởng giúp BrainHem dễ dùng hơn"],
  ["usability", "Khó sử dụng", "Một thao tác hoặc nội dung chưa rõ"],
  ["other", "Góp ý khác", "Nhận xét chung về sản phẩm"],
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(([id, label]) => [id, label]));

function AdminInbox({ authorization }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState("loading");
  const [query, setQuery] = useState("");
  const refresh = () => { setState("loading"); listFeedback(authorization).then(result => { setItems(result.items); setState("ready"); }).catch(() => setState("error")); };
  useEffect(refresh, [authorization]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("vi");
    return term ? items.filter(item => [item.reference,item.role,item.category,item.message,item.contact].some(value => String(value || "").toLocaleLowerCase("vi").includes(term))) : items;
  }, [items, query]);
  return <main className="feedback-admin">
    <section className="feedback-admin-head"><div><span className="feedback-kicker">QUẢN TRỊ FEEDBACK</span><h1>Hộp thư phản hồi</h1><p>Toàn bộ góp ý được lưu nội bộ trên máy BrainHem.</p></div><article><Icon name="inbox" size={22}/><span><strong>{items.length}</strong><small>Tổng phản hồi</small></span></article></section>
    <section className="feedback-inbox-card">
      <header><label><Icon name="search" size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm theo mã, vai trò hoặc nội dung…"/></label><button onClick={refresh} type="button"><Icon name="reset" size={16}/> Làm mới</button></header>
      {state === "loading" ? <div className="feedback-empty">Đang tải feedback…</div> : state === "error" ? <div className="feedback-empty">Không tải được dữ liệu.</div> : !filtered.length ? <div className="feedback-empty"><Icon name="inbox" size={30}/><strong>Chưa có feedback</strong><span>Phản hồi mới sẽ xuất hiện tại đây.</span></div> : <div className="feedback-list">{filtered.map(item => <article key={`${item.reference}-${item.created_at}`}>
        <div className="feedback-item-top"><span className={`feedback-kind ${item.category || "other"}`}>{CATEGORY_LABELS[item.category] || item.category || "Phản hồi cũ"}</span><time>{item.created_at ? new Date(item.created_at).toLocaleString("vi-VN") : "Không rõ thời gian"}</time></div>
        <h2>{item.message || "Không có nội dung"}</h2>
        <div className="feedback-item-meta"><span><b>{item.reference || "Chưa có mã"}</b></span><span>Vai trò: <b>{item.role || "Không rõ"}</b></span><span>Tài khoản: <b>{item.account || "dữ liệu cũ"}</b></span>{item.contact && <span>Liên hệ: <b>{item.contact}</b></span>}</div>
      </article>)}</div>}
    </section>
  </main>;
}

function FeedbackForm({ authorization }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ role: "", category: "suggestion", message: "", contact: "", website: "" });
  const [state, setState] = useState("idle");
  const [notice, setNotice] = useState("");
  useEffect(() => { getFeedbackStatus().then(setStatus).catch(() => setStatus({ hourly_quota: 5 })); }, []);
  const update = field => event => setForm(current => ({ ...current, [field]:event.target.value }));
  const send = async event => {
    event.preventDefault(); setState("sending"); setNotice("");
    try { const result = await submitFeedback({ ...form, page:window.location.pathname }, authorization); setState("sent"); setNotice(`${result.message} Mã: ${result.reference}`); setForm(current => ({...current,message:"",contact:"",website:""})); }
    catch (error) { setState("error"); setNotice(error.message || "Không gửi được góp ý."); }
  };
  return <main className="feedback-main">
    <section className="feedback-intro"><span className="feedback-kicker">PHẢN HỒI SẢN PHẨM</span><h1>Giúp BrainHem tốt hơn<br/>từ trải nghiệm thực tế.</h1><p>Mỗi góp ý được lưu trực tiếp vào hộp thư nội bộ để quản trị viên xem lại. Bạn chỉ cần chọn vai trò và mô tả điều mình gặp phải.</p><div className="feedback-promise"><div><Icon name="inbox" size={21}/><p><strong>Đến đúng người phụ trách</strong><span>Chỉ tài khoản quản trị mới xem được toàn bộ nội dung.</span></p></div><div><Icon name="shield" size={21}/><p><strong>Không gửi dữ liệu bệnh nhân</strong><span>Không nhập tên, mã ca, ảnh CT hoặc thông tin định danh.</span></p></div><div><Icon name="checkCircle" size={21}/><p><strong>Có mã theo dõi</strong><span>Sau khi gửi, bạn nhận một mã feedback riêng.</span></p></div></div></section>
    <section className="feedback-card" aria-labelledby="feedback-title"><div className="feedback-card-head"><div><small>BIỂU MẪU GÓP Ý</small><h2 id="feedback-title">Bạn muốn chia sẻ điều gì?</h2></div><span className="ready"><i/>Lưu nội bộ</span></div><form onSubmit={send}>
      <label>Vai trò của bạn <b>*</b><select required value={form.role} onChange={update("role")}><option value="" disabled>Chọn vai trò phù hợp nhất</option>{ROLES.map(role => <option key={role}>{role}</option>)}</select></label>
      <fieldset><legend>Loại góp ý</legend><div className="feedback-category-grid">{CATEGORIES.map(([value,title,copy]) => <label className={form.category===value?"selected":""} key={value}><input type="radio" name="category" value={value} checked={form.category===value} onChange={update("category")}/><span><Icon name={value==="bug"?"alert":value==="suggestion"?"spark":value==="usability"?"help":"inbox"} size={18}/></span><p><strong>{title}</strong><small>{copy}</small></p></label>)}</div></fieldset>
      <label>Nội dung góp ý <b>*</b><textarea required maxLength="5000" rows="7" value={form.message} onChange={update("message")} placeholder="Bạn đã làm gì? Điều gì xảy ra? Bạn mong muốn hệ thống hoạt động như thế nào?"/></label>
      <label>Thông tin liên hệ <em>không bắt buộc</em><input maxLength="160" value={form.contact} onChange={update("contact")} placeholder="Email hoặc số điện thoại nếu bạn muốn được phản hồi"/></label><label className="feedback-trap" aria-hidden="true">Website<input tabIndex="-1" autoComplete="off" value={form.website} onChange={update("website")}/></label>
      <div className="feedback-safety"><Icon name="shield" size={17}/><span>Không đính kèm dữ liệu y tế. Tối đa {status?.hourly_quota||5} góp ý mỗi giờ.</span></div>{notice&&<p className={`feedback-notice ${state}`} role="status">{notice}</p>}<button className="feedback-submit" disabled={state==="sending"||!form.role||!form.message.trim()}>{state==="sending"?"Đang lưu…":<><Icon name="inbox" size={18}/> Gửi góp ý</>}</button>
    </form></section>
  </main>;
}

function AdminLoginDialog({ onClose, onLogin, onLogout }) {
  const [credentials, setCredentials] = useState({username:"",password:""});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const account = await onLogin(credentials.username, credentials.password);
      if (account.role !== "admin") { await onLogout(); throw new Error("Tài khoản này không có quyền quản trị feedback."); }
      onClose();
    } catch (reason) { setError(reason.message || "Không đăng nhập được."); }
    finally { setBusy(false); }
  };
  return <div className="feedback-admin-login-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className="feedback-admin-login" role="dialog" aria-modal="true" aria-labelledby="admin-login-title"><button className="feedback-admin-login-close" type="button" onClick={onClose} aria-label="Đóng"><Icon name="close" size={17}/></button><span><Icon name="shield" size={23}/></span><small>KHU VỰC QUẢN TRỊ</small><h2 id="admin-login-title">Đăng nhập để xem feedback</h2><p>Chỉ tài khoản có role admin được mở hộp thư phản hồi.</p><form onSubmit={submit}><label>Tài khoản quản trị<input required autoFocus autoComplete="username" value={credentials.username} onChange={event=>setCredentials({...credentials,username:event.target.value})}/></label><label>Mật khẩu<input required type="password" autoComplete="current-password" value={credentials.password} onChange={event=>setCredentials({...credentials,password:event.target.value})}/></label>{error&&<p className="feedback-notice error" role="alert">{error}</p>}<button className="feedback-submit" disabled={busy}>{busy?"Đang đăng nhập…":"Đăng nhập quản trị"}</button></form></section></div>;
}

export default function FeedbackApp() {
  const { account, authorization, logout, signIn } = useAppAuth();
  const [adminLoginOpen,setAdminLoginOpen] = useState(false);
  return <div className="feedback-page"><header className="feedback-topbar"><a href="/" className="feedback-brand"><span><Icon name="scan" size={24}/></span><div><strong>BrainHem</strong><small>Clinical AI Platform</small></div></a><nav>{account?<><span className="feedback-account"><Icon name="user" size={15}/><b>{account.username}</b> · {account.role}</span><button type="button" onClick={logout}>Đăng xuất</button></>:<button className="feedback-admin-entry" type="button" onClick={()=>setAdminLoginOpen(true)}><Icon name="shield" size={15}/> Đăng nhập quản trị</button>}<a href="/guide"><Icon name="help" size={17}/> Hướng dẫn</a><a href="/"><Icon name="chevron" size={15}/> Về ứng dụng</a></nav></header>{account?.role==="admin"?<AdminInbox authorization={authorization}/>:<FeedbackForm authorization={authorization}/>} {adminLoginOpen&&<AdminLoginDialog onClose={()=>setAdminLoginOpen(false)} onLogin={signIn} onLogout={logout}/>}</div>;
}
