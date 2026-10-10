import { useEffect, useMemo, useRef, useState } from "react";
import { askSupportBot, getSupportStatus } from "../api";
import { Icon } from "../icons";
import "./SupportBot.css";

const STARTERS = ["Cách chạy AI cho một ca?", "Xóa thước đo thế nào?", "Vì sao Quality gate Fail?"];

function sessionId() {
  try {
    const existing = sessionStorage.getItem("brainhem.support.session");
    if (existing) return existing;
    const value = crypto.randomUUID();
    sessionStorage.setItem("brainhem.support.session", value);
    return value;
  } catch {
    return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export default function SupportBot() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([{ role: "bot", text: "Chào bạn, mình giúp tìm cách sử dụng BrainHem. Mình đọc tài liệu trước và không có quyền thay đổi dữ liệu hay chạy lệnh." }]);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const sid = useMemo(sessionId, []);

  useEffect(() => { getSupportStatus().then(setStatus).catch(() => {}); }, []);
  useEffect(() => { if (open) getSupportStatus().then(setStatus).catch(() => {}); }, [open]);
  useEffect(() => { if (open) window.setTimeout(() => inputRef.current?.focus(), 80); }, [open]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  async function submit(value = question) {
    const clean = value.trim();
    if (!clean || busy) return;
    setMessages(current => [...current, { role: "user", text: clean }]);
    setQuestion("");
    setBusy(true);
    try {
      const result = await askSupportBot(clean, sid);
      setMessages(current => [...current, { role: "bot", ...result, text: result.answer }]);
      setStatus(current => current ? { ...current, quota_remaining: result.quota_remaining,
        unresolved_count: (current.unresolved_count || 0) + (result.escalated ? 1 : 0) } : current);
    } catch (error) {
      setMessages(current => [...current, { role: "bot", text: `Bot local chưa kết nối được: ${error.message}`, resolved: false }]);
    } finally { setBusy(false); }
  }

  return <div className={`support-bot ${open ? "open" : ""}`}>
    {open && <section className="support-panel" role="dialog" aria-label="Trợ lý BrainHem">
      <header>
        <span className="support-avatar"><Icon name="spark" size={21}/><i/></span>
        <div><strong>Trợ lý BrainHem</strong><small>{status?.mode === "agy" ? `AGY · ${status.model}` : status?.mode === "local-llm" ? status.model : "Local · Docs-first"} · Chỉ đọc</small></div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Đóng trợ lý"><Icon name="close" size={18}/></button>
      </header>
      <div className="support-policy"><Icon name="shield" size={15}/><span>Không chẩn đoán · Không sửa dữ liệu · {status?.hourly_quota || 20} câu/giờ</span></div>
      <div className="support-thread">
        {messages.map((message, index) => <div className={`support-message ${message.role}`} key={`${message.role}-${index}`}>
          <p>{message.text}</p>
          {message.references?.length > 0 && <div className="support-references">{message.references.map(reference => <a href={reference.href} target="_blank" rel="noreferrer" key={reference.href}><Icon name="file" size={14}/>{reference.title}</a>)}</div>}
          {message.escalated && <small><Icon name="inbox" size={13}/>Đã chuyển vào hộp thư quản trị</small>}
        </div>)}
        {messages.length === 1 && <div className="support-starters">{STARTERS.map(item => <button type="button" key={item} onClick={() => submit(item)}>{item}</button>)}</div>}
        {busy && <div className="support-thinking"><i/><i/><i/><span>{status?.mode==="agy"?"AGY đang đọc hướng dẫn…":"Đang tìm trong tài liệu…"}</span></div>}
        <div ref={endRef}/>
      </div>
      <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <textarea ref={inputRef} rows="2" maxLength="600" value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Mô tả việc bạn đang vướng…"/>
        <button type="submit" disabled={busy || question.trim().length < 2} aria-label="Gửi câu hỏi"><Icon name="chevron" size={18}/></button>
      </form>
      <footer><span>{status?.quota_remaining ?? status?.hourly_quota ?? 20} lượt còn lại{status?.unresolved_count ? ` · ${status.unresolved_count} câu chờ quản trị` : ""}</span><a href="/guide">Mở toàn bộ hướng dẫn</a></footer>
    </section>}
    <button className="support-launcher" type="button" onClick={() => setOpen(value => !value)} aria-label={open ? "Đóng trợ lý" : "Mở trợ lý BrainHem"}>
      {open ? <Icon name="close" size={22}/> : <><Icon name="spark" size={23}/><span>Hỏi trợ lý</span></>}
    </button>
  </div>;
}
