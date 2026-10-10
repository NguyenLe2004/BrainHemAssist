import { accountAuthorization } from "./permissions";
const configuredBase = import.meta.env.VITE_API_BASE_URL || "";
export const API_BASE = configuredBase.replace(/\/$/, "");
export const OHIF_URL = (import.meta.env.VITE_OHIF_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithRetry(url, options = {}, attempts = 3, timeoutMs = 12000) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const outerSignal = options.signal;
    const abortFromOuter = () => controller.abort(outerSignal.reason);
    if (outerSignal?.aborted) throw outerSignal.reason || new DOMException("Aborted", "AbortError");
    outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
    const timer = window.setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      timeoutMs,
    );
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (![502, 503, 504].includes(response.status) || attempt === attempts - 1) {
        return response;
      }
      lastError = new Error(`Gateway tạm thời lỗi (${response.status})`);
    } catch (error) {
      if (outerSignal?.aborted) throw error;
      lastError = error;
      if (attempt === attempts - 1) throw error;
    } finally {
      window.clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abortFromOuter);
    }
    await wait(500 * (2 ** attempt), outerSignal);
  }
  throw lastError || new Error("Không thể kết nối máy chủ");
}

export async function healthCheck(signal) {
  const response = await fetchWithRetry(apiUrl("/api/v1/health"), { signal }, 2, 6000);
  if (!response.ok) throw new Error("Không kết nối được API");
  return response.json();
}

export function sendSimulatorAcquisition(file, patientId, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const body = new FormData();
    body.append("file", file);
    body.append("patient_id", patientId);
    request.open("POST", apiUrl("/api/v1/simulator/acquisitions"));
    const sessionAuth=accountAuthorization(); if(sessionAuth) request.setRequestHeader("Authorization",sessionAuth);
    request.timeout = 600000;
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response);
      } else {
        reject(new Error(request.response?.detail || `Không gửi được acquisition (${request.status})`));
      }
    };
    request.onerror = () => reject(new Error("Mất kết nối tới CT simulator service"));
    request.ontimeout = () => reject(new Error("DICOM transfer quá thời gian"));
    request.send(body);
  });
}

export function uploadDicomCase(files, metadata = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    Array.from(files || []).forEach((file) => form.append("files", file, file.name));
    form.append("priority", metadata.priority || "routine");
    form.append("clinical_indication", metadata.clinicalIndication || "");
    if (metadata.caseName?.trim()) form.append("case_name", metadata.caseName.trim());
    const request = new XMLHttpRequest();
    request.open("POST", apiUrl("/api/v1/annotations/cases/dicom-upload"));
    const sessionAuth=accountAuthorization(); if(sessionAuth) request.setRequestHeader("Authorization",sessionAuth);
    request.timeout = 600000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText || "{}"); } catch { payload = {}; }
      if (request.status >= 200 && request.status < 300) resolve(payload);
      else reject(new Error(payload.detail || "Không thể tiếp nhận DICOM study"));
    };
    request.onerror = () => reject(new Error("Mất kết nối trong khi tải DICOM"));
    request.ontimeout = () => reject(new Error("Tải DICOM quá thời gian. Hãy kiểm tra kết nối và thử lại."));
    request.send(form);
  });
}

export async function getJob(jobId, signal) {
  const response = await fetchWithRetry(apiUrl(`/api/v1/jobs/${encodeURIComponent(jobId)}`), {
    signal,
  }, 3, 10000);
  if (!response.ok) {
    const error = new Error([404,410].includes(response.status) ? "Tác vụ không còn truy cập được; kết quả có thể đã được dọn. Bạn có thể tạo yêu cầu AI mới." : [401,403].includes(response.status) ? "Không có quyền đọc tác vụ. Hãy đăng nhập lại hoặc kiểm tra quyền truy cập." : "Không lấy được trạng thái ca");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function listJobs(limit = 50, offset = 0, signal) {
  const q = new URLSearchParams({ limit, offset });
  const response = await fetchWithRetry(apiUrl(`/api/v1/jobs?${q}`), { signal }, 3, 10000);
  if (!response.ok) throw new Error("Không tải được danh sách tác vụ");
  return response.json();
}

export async function listStudies(signal) {
  const response = await fetchWithRetry(apiUrl("/api/v1/studies?limit=50"), { signal }, 3, 10000);
  if (!response.ok) throw new Error("Không tải được PACS worklist");
  return response.json();
}

export async function analyzeStudy(studyId) {
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/dicom/studies/${encodeURIComponent(studyId)}/analyze`),
    { method: "POST", headers:authHeaders() },
    1,
    120000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Không thể phân tích study này");
  return payload;
}

export async function artifactFile(jobId, kind, filename) {
  const response = await fetchWithRetry(
    artifactUrl(jobId, kind),
    { cache: "no-store" },
    3,
    30000,
  );
  if (!response.ok) throw new Error(`Không tải được ${kind} (${response.status})`);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || "application/gzip" });
}

export async function reviewJob(jobId, decision, note = "", authorization = null, expectedReviewedAt = null) {
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/jobs/${encodeURIComponent(jobId)}/review`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ decision, note, expected_reviewed_at: expectedReviewedAt }),
    },
    1,
    15000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Không lưu được đánh giá");
  return payload;
}

export function artifactUrl(jobId, artifact) {
  if (artifact?.url) {
    if (/^https?:\/\//i.test(artifact.url)) return artifact.url;
    return apiUrl(artifact.url);
  }
  const kind = artifact?.kind || artifact;
  return apiUrl(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(kind)}`,
  );
}

export async function getCapabilities(signal) {
  const response = await fetchWithRetry(apiUrl("/api/v1/capabilities"), { signal }, 2, 6000);
  if (!response.ok) throw new Error("Không lấy được thông tin hệ thống");
  return response.json();
}

export async function listAnnotationCases(limit = 50, offset = 0, status = "", signal) {
  const q = new URLSearchParams({ limit, offset });
  if (status) q.append("status", status);
  const response = await fetchWithRetry(apiUrl(`/api/v1/annotations/cases?${q}`), { signal }, 3, 10000);
  if (!response.ok) throw new Error("Không tải được danh sách ca gán nhãn");
  return response.json();
}

export async function createAnnotationCase({ file, studyId, jobId, name }) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  if (studyId) formData.append("study_id", studyId);
  if (jobId) formData.append("job_id", jobId);
  if (name) formData.append("name", name);

  const response = await fetchWithRetry(
    apiUrl("/api/v1/annotations/cases"),
    {
      method: "POST",
      body: formData,
    },
    1,
    120000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Không tạo được ca gán nhãn");
  return { ...payload, reused: response.headers.get("X-Annotation-Reused") === "true" };
}

export async function getAnnotationCase(caseId, signal) {
  const response = await fetchWithRetry(apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}`), { signal }, 3, 10000);
  if (!response.ok) throw new Error("Không tìm thấy ca gán nhãn");
  return response.json();
}

export function getAnnotationSourceUrl(caseId) {
  return apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/source`);
}

export function getAnnotationThumbnailUrl(caseId) {
  return apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/thumbnail`);
}

export async function listAnnotationRevisions(caseId, signal) {
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/revisions`),
    { signal },
    3,
    10000,
  );
  if (!response.ok) throw new Error("Không tải được lịch sử chỉnh sửa");
  return response.json();
}

export function getAnnotationMaskUrl(caseId, revNum) {
  return apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/revisions/${encodeURIComponent(revNum)}/mask`);
}

export async function saveAnnotationRevision(caseId, {
  maskBlob,
  operationId = null,
  filename = "mask.nii.gz",
  expectedRevision,
  status = "draft",
  reviewer = "demo-radiologist",
  notes = "",
  reviewedEntireVolume = false,
  clearProvenance = false,
  baseRevision = null,
  seedJobId = null,
  seedTier = null,
  reviewerAuthorization = null,
}) {
  const formData = new FormData();
  if (operationId) formData.append("operation_id", operationId);
  if (maskBlob) {
    formData.append("file", maskBlob, filename || "mask.nii.gz");
  }
  formData.append("expected_revision", String(expectedRevision));
  formData.append("status", status);
  formData.append("reviewer", reviewer);
  formData.append("notes", notes);
  formData.append("reviewed_entire_volume", reviewedEntireVolume ? "true" : "false");
  formData.append("clear_provenance", clearProvenance ? "true" : "false");
  if (baseRevision !== undefined && baseRevision !== null) {
    formData.append("base_revision", String(baseRevision));
  }
  if (seedJobId) formData.append("seed_job_id", seedJobId);
  if (seedTier) formData.append("seed_tier", seedTier);

  const revisionUrl = apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/revisions`);
  const requestOptions = {
    method: "POST",
    headers: reviewerAuthorization ? { Authorization: reviewerAuthorization } : {},
    body: formData,
  };
  let response = await fetchWithRetry(revisionUrl, requestOptions, 1, 60000);
  // Saving is guarded by expected_revision, so one retry cannot create two
  // revisions. If the first response failed after committing, the retry safely
  // returns 409 and the editor offers its existing conflict recovery flow.
  if (response.status >= 500) {
    await wait(450);
    response = await fetchWithRetry(revisionUrl, requestOptions, 1, 60000);
  }
  const responseText = await response.text();
  let payload = {};
  try { payload = responseText ? JSON.parse(responseText) : {}; } catch { payload = {}; }
  if (response.status === 409) {
    throw new Error(payload.detail || "Xung đột phiên bản: Ca đã được chỉnh sửa bởi phiên làm việc khác");
  }
  if (!response.ok) {
    throw new Error(payload.detail || (responseText && responseText !== "Internal Server Error" ? responseText : `Lưu bản vẽ thất bại (${response.status})`));
  }
  return payload;
}

export async function getSavedOperation(caseId, operationId, authorization) {
  const response = await fetchWithRetry(apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/operations/${encodeURIComponent(operationId)}`),
    {headers: authorization ? {Authorization:authorization} : {}}, 2, 10000);
  if (response.status===404) return null;
  if (!response.ok) throw new Error("Chưa xác minh được thao tác lưu trước đó");
  return response.json();
}

export async function seedAnnotationFromJob(caseId, jobId, expectedRevision, reviewerAuthorization = null) {
  const formData = new FormData();
  formData.append("job_id", jobId);
  if (expectedRevision !== undefined && expectedRevision !== null) {
    formData.append("expected_revision", String(expectedRevision));
  }
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/seed`),
    {
      method: "POST",
      headers: reviewerAuthorization ? { Authorization: reviewerAuthorization } : {},
      body: formData,
    },
    1,
    30000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Không nhập được kết quả AI");
  return payload;
}

export async function runCaseInference(caseId, tier = "fast") {
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/inference?tier=${encodeURIComponent(tier)}`),
    { method: "POST", headers:authHeaders() },
    1,
    60000,
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Không thể chạy phân tích AI cho ca này");
  return payload;
}

export async function propagateWithSam2(caseId, maskBlob, reviewerAuthorization = null) {
  const body = new FormData();
  body.append("file", maskBlob, "sam2-seeds.nii.gz");
  const response = await fetchWithRetry(
    apiUrl(`/api/v1/annotations/cases/${encodeURIComponent(caseId)}/sam2-propagate`),
    {
      method: "POST",
      headers: reviewerAuthorization ? { Authorization: reviewerAuthorization } : {},
      body,
    },
    1,
    120000,
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "MedSAM2 không thể lan truyền mask");
  }
  let metadata = {};
  try { metadata = JSON.parse(atob(response.headers.get("X-SAM2-Metadata") || "")); } catch { metadata = {}; }
  return { blob: await response.blob(), metadata };
}

export function exportDatasetUrl() {
  return apiUrl("/api/v1/annotations/export");
}

export async function verifyReviewer(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const authorization = `Basic ${btoa(String.fromCharCode(...bytes))}`;
  const response = await fetch(apiUrl("/api/v1/reviewer/verify"), {
    method: "POST", headers: { Authorization: authorization },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "Không thể xác thực người duyệt");
  return { reviewer: payload.reviewer, authorization };
}

async function jsonRequest(path, options = {}) {
  const response = await fetchWithRetry(apiUrl(path), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }, 1, 120000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `Yêu cầu thất bại (${response.status})`);
  return payload;
}

const authHeaders = authorization => {
  let token=authorization;
  if(!token){try{const session=JSON.parse(localStorage.getItem("brainhem.app.session")||"null");token=session?.token ? `Bearer ${session.token}` : sessionStorage.getItem("brainhem.mlops.authorization");}catch{/* disabled storage */}}
  return token ? { Authorization: token } : {};
};
export const createLearningCandidate = (payload, authorization) => jsonRequest("/api/v1/learning/candidates", { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const listLearningCandidates = status => jsonRequest(`/api/v1/learning/candidates${status ? `?status=${encodeURIComponent(status)}` : ""}`);
export const transitionLearningCandidate = (id, payload, authorization) => jsonRequest(`/api/v1/learning/candidates/${encodeURIComponent(id)}/transition`, { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const addPeerReview = (id, payload, authorization) => jsonRequest(`/api/v1/learning/candidates/${encodeURIComponent(id)}/reviews`, { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const adjudicateCandidate = (id, payload, authorization) => jsonRequest(`/api/v1/learning/candidates/${encodeURIComponent(id)}/adjudicate`, { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const getMlopsCapabilities = () => jsonRequest("/api/v1/mlops/capabilities");
export const getStudioCatalog = () => jsonRequest("/api/v1/studio");
export const previewStudioRecipe = payload => jsonRequest("/api/v1/studio/recipes/preview", {method:"POST", body:JSON.stringify(payload)});
export const createStudioRecipe = (payload, authorization) => jsonRequest("/api/v1/studio/recipes", {method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload)});
export const freezeStudioRecipe = (id, authorization) => jsonRequest(`/api/v1/studio/recipes/${encodeURIComponent(id)}/freeze`, {method:"POST", headers:authHeaders(authorization)}, 120000);
export const saveStudioPolicy = (payload, authorization) => jsonRequest("/api/v1/studio/policy", {method:"PUT", headers:authHeaders(authorization), body:JSON.stringify(payload)});
export const prepareStudioDemo49 = authorization => jsonRequest("/api/v1/studio/demo/prepare-49", {method:"POST", headers:authHeaders(authorization)});
export const launchStudioPolicy = authorization => jsonRequest("/api/v1/studio/launch", {method:"POST", headers:authHeaders(authorization)}, 120000);
export const releaseStudioRun = (id, authorization) => jsonRequest(`/api/v1/studio/runs/${encodeURIComponent(id)}/release`, {method:"POST", headers:authHeaders(authorization)});
export async function importStudioSource(file, name, role, authorization) {
  const body = new FormData(); body.append("file",file); body.append("name",name); body.append("role",role);
  const response = await fetchWithRetry(apiUrl("/api/v1/studio/sources"), {method:"POST", headers:authHeaders(authorization), body}, 1, 120000);
  const data = await response.json(); if(!response.ok) throw new Error(data.detail || "Không nhập được dataset"); return data;
}
export const getMlopsHardware = () => jsonRequest("/api/v1/mlops/hardware");
export const getMlopsAutomation = () => jsonRequest("/api/v1/mlops/automation");
export const updateMlopsAutomation = (payload, authorization) => jsonRequest("/api/v1/mlops/automation", { method:"PUT", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const listDatasetVersions = () => jsonRequest("/api/v1/datasets");
export const createDatasetVersion = (payload, authorization) => jsonRequest("/api/v1/datasets", { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export async function downloadDatasetArtifact(id, authorization) {
  const response=await fetchWithRetry(apiUrl(`/api/v1/datasets/${encodeURIComponent(id)}/artifact`),{headers:authHeaders(authorization)},1,120000);
  if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.detail||"Không tải được dataset artifact");}
  return response.blob();
}
export const listTrainingRuns = () => jsonRequest("/api/v1/training/runs");
export const createTrainingRun = (payload, authorization) => jsonRequest("/api/v1/training/runs", { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const validateTrainingRun = (id, authorization) => jsonRequest(`/api/v1/training/runs/${encodeURIComponent(id)}/validate`, { method:"POST", headers:authHeaders(authorization) });
export async function downloadTrainingLog(id, authorization) {
  const response=await fetchWithRetry(apiUrl(`/api/v1/training/runs/${encodeURIComponent(id)}/log`),{headers:authHeaders(authorization)},1,60000);
  if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.detail||"Không tải được training log");}
  return response.blob();
}
export const listModels = () => jsonRequest("/api/v1/models");
export const approveModel = (id, payload, authorization) => jsonRequest(`/api/v1/models/${encodeURIComponent(id)}/approvals`, { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export const transitionModel = (id, payload, authorization) => jsonRequest(`/api/v1/models/${encodeURIComponent(id)}/transition`, { method:"POST", headers:authHeaders(authorization), body:JSON.stringify(payload) });
export async function uploadShadowEvidence(id, file, note = "", authorization = null) {
  const body=new FormData();body.append("file",file,file.name);body.append("note",note);
  const response=await fetchWithRetry(apiUrl(`/api/v1/models/${encodeURIComponent(id)}/shadow-evidence`),{method:"POST",headers:authHeaders(authorization),body},1,60000);
  const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.detail||"Không lưu được shadow evidence");return payload;
}

export const getSupportStatus = () => jsonRequest("/api/v1/support/status");
export const askSupportBot = (question, sessionId, page = window.location.pathname + window.location.hash) =>
  jsonRequest("/api/v1/support/chat", {
    method: "POST",
    body: JSON.stringify({ question, session_id: sessionId, page }),
  });

export const getFeedbackStatus = () => jsonRequest("/api/v1/feedback/status");
export const feedbackAuthorization = (username, password) => `Basic ${btoa(`${username}:${password}`)}`;
export const loginApp = (username, password) => jsonRequest("/api/v1/auth/login", { method:"POST", body:JSON.stringify({ username, password }) });
export const getAppAccount = token => jsonRequest("/api/v1/auth/me", { headers:{ Authorization:`Bearer ${token}` } });
export const logoutApp = token => jsonRequest("/api/v1/auth/logout", { method:"POST", headers:{ Authorization:`Bearer ${token}` } });
export const getFeedbackAccount = authorization => jsonRequest("/api/v1/feedback/me", { headers: { Authorization: authorization } });
export const listFeedback = authorization => jsonRequest("/api/v1/feedback/items", { headers: { Authorization: authorization } });
export const submitFeedback = (payload, authorization) => jsonRequest("/api/v1/feedback", {
  method: "POST",
  headers: authorization ? { Authorization: authorization } : {},
  body: JSON.stringify(payload),
});
