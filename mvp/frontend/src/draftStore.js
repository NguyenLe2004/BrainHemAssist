const DB = "brainhem-working-drafts-v1";
const TTL = 7 * 86400000;
export const draftKey = (api, user, caseId) => `${api}:${user}:${caseId}`;
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", {keyPath:"key"});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    let value;
    tx.oncomplete = () => {db.close(); resolve(value);};
    tx.onerror = tx.onabort = () => {db.close(); reject(tx.error || new Error("Không lưu được nháp trên thiết bị"));};
    action(tx.objectStore("drafts"), result => {value=result;});
  });
}
export function putDraft(draft) {
  if (draft.mask.byteLength > 128 * 1024 * 1024) return Promise.reject(new Error("Nháp vượt giới hạn lưu cục bộ 128 MiB"));
  return transaction("readwrite", (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {const item=cursor.result;if(item){if(Date.now()-item.value.at>TTL)item.delete();item.continue();}};
    store.put({...draft, at:Date.now()});
  });
}
export async function getDraft(key) {
  const result = await transaction("readonly", (store, done) => {store.get(key).onsuccess=e=>done(e.target.result);});
  if (result && Date.now()-result.at>TTL) {await removeDraft(key);return null;}
  return result || null;
}
export function removeDraft(key, throughVersion = Infinity) {
  return transaction("readwrite", store => {
    store.get(key).onsuccess=e=>{if(e.target.result && e.target.result.version<=throughVersion)store.delete(key);};
  });
}
export function matchingDraft(draft, caseItem, expectedLength) {
  return draft?.caseId===caseItem.id && draft.sourceDigest===caseItem.source_digest &&
    draft.geometry===JSON.stringify(caseItem.geometry) && draft.mask?.length===expectedLength;
}
