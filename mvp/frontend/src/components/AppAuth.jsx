import { createContext, useContext, useEffect, useState } from "react";
import { getAppAccount, loginApp, logoutApp } from "../api";
import { Icon } from "../icons";
import "./AppAuth.css";

const AuthContext = createContext(null);
const SESSION_KEY = "brainhem.app.session";

export function useAppAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAppAuth must be used inside AppAuthGate");
  return value;
}

export default function AppAuthGate({ children, allowAnonymous = false }) {
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [credentials, setCredentials] = useState({ username:"", password:"" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch {}
    if (!saved?.token) { setChecking(false); return; }
    getAppAccount(saved.token).then(current => setAccount({...current,token:saved.token})).catch(() => {
      try { localStorage.removeItem(SESSION_KEY); } catch {}
    }).finally(() => setChecking(false));
  }, []);

  const signIn = async (username, password) => {
    const result = await loginApp(username.trim(), password);
    const next = { ...result };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next)); setAccount(next);
    return next;
  };
  const login = async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await signIn(credentials.username, credentials.password); setCredentials({username:"",password:""});
    } catch (reason) { setError(reason.message || "Không đăng nhập được."); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    if (account?.token) logoutApp(account.token).catch(() => {});
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    setAccount(null);
  };

  if (checking) return <div className="app-auth-loading"><Icon name="scan" size={30}/><span>Đang kiểm tra phiên đăng nhập…</span></div>;
  const context = {account,authorization:account ? `Bearer ${account.token}` : "",logout,signIn};
  if (!account && allowAnonymous) return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
  if (!account) return <div className="app-login-page"><section className="app-login-brand"><span><Icon name="scan" size={30}/></span><div><strong>BrainHem</strong><small>Research Workstation</small></div></section><main><section className="app-login-copy"><span>BRAINHEM RESEARCH</span><h1>CT Annotation<br/>& Model Studio</h1><p>Đọc CT, gán nhãn và quản lý mô hình.</p></section><section className="app-login-card"><small>WORKSPACE</small><h2>Đăng nhập</h2><form onSubmit={login}><label>Tài khoản<input required autoFocus autoComplete="username" value={credentials.username} onChange={event=>setCredentials({...credentials,username:event.target.value})} placeholder="Tài khoản"/></label><label>Mật khẩu<input required type="password" autoComplete="current-password" value={credentials.password} onChange={event=>setCredentials({...credentials,password:event.target.value})} placeholder="Mật khẩu"/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy}>{busy?"Đang đăng nhập…":"Đăng nhập"}</button></form></section></main></div>;
  const restricted = window.location.pathname.startsWith("/model-studio") && !account.permissions?.includes("studio.read") || window.location.pathname.startsWith("/simulator") && !account.permissions?.includes("case.ingest");
  return <AuthContext.Provider value={context}>{restricted ? <main style={{padding:48,color:"#e7edf8"}}><h1>Không có quyền truy cập</h1><p>Chức năng này dành cho vai trò được cấp quyền.</p><a href="/#home">Về không gian xem ảnh</a></main> : children}</AuthContext.Provider>;
}
