export const ROLE_LABELS={viewer:"Người xem ảnh",annotator:"Người gán nhãn",doctor:"Bác sĩ / người duyệt nhãn",model_admin:"Quản lý mô hình",admin:"Quản trị hệ thống",user:"Người dùng"};
export function can(account,permission){return Array.isArray(account?.permissions)&&account.permissions.includes(permission);}
export function navAllowed(account,item){if(item.id==="training"||item.href?.startsWith("/model-studio"))return can(account,"studio.read");if(item.id==="upload")return can(account,"case.ingest");if(item.id==="labeling")return can(account,"label.edit");return true;}
export function accountAuthorization(){try{const a=JSON.parse(localStorage.getItem("brainhem.app.session")||"null");return a?.token?`Bearer ${a.token}`:"";}catch{return "";}}
// NiiVue also loads CT/masks using fetch. Add credentials only for our API
// origin/path, preserve explicit auth and never put tokens into URLs.
export function installAuthenticatedFetch(apiBase=""){
 const native=window.fetch.bind(window);const origin=new URL(apiBase||window.location.origin,window.location.origin).origin;
 window.fetch=(input,init={})=>{const u=new URL(typeof input==="string"?input:input.url,window.location.href);if(u.origin!==origin||!u.pathname.startsWith("/api/v1/"))return native(input,init);
 const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init.headers).forEach((v,k)=>headers.set(k,v));const auth=accountAuthorization();if(auth&&!headers.has("Authorization"))headers.set("Authorization",auth);return native(input,{...init,headers});};
 document.addEventListener("click",event=>{const a=event.target.closest?.("a[href]");if(!a)return;const u=new URL(a.href,window.location.href);if(u.origin!==origin||!u.pathname.startsWith("/api/v1/")||!accountAuthorization())return;event.preventDefault();window.fetch(u.href).then(async r=>{if(!r.ok){let d={};try{d=await r.json();}catch{}throw Error(d.detail||"Không tải được tệp.");}const b=await r.blob();const link=document.createElement("a");link.href=URL.createObjectURL(b);const m=(r.headers.get("content-disposition")||"").match(/filename="?([^";]+)/);link.download=a.getAttribute("download")||m?.[1]||"brainhem-artifact";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),30000);}).catch(e=>window.alert(e.message));});
}
