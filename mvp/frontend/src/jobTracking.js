// Polls are serial; network loss never becomes an inference failure.
export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "retry_wait", "service_wait"]);
export function jobMessage(job) {
  const attempt = `${job.attempt_count || 0}/${job.max_attempts || 3}`;
  if (job.status === "service_wait") return "AI tạm chưa sẵn sàng. Yêu cầu được giữ lại; bạn vẫn có thể chỉnh nhãn.";
  if (job.status === "retry_wait") {
    const when = job.next_attempt_at ? new Date(job.next_attempt_at).toLocaleTimeString("vi-VN") : "ít phút nữa";
    return `Xử lý vừa gián đoạn (${attempt}). Hệ thống sẽ thử lại lúc ${when}.`;
  }
  if (job.status === "queued") return "Yêu cầu đã được tiếp nhận, đang chờ xử lý AI.";
  if (job.status === "running") return `Đang xử lý AI, lần ${attempt}. Bạn vẫn có thể chỉnh nhãn.`;
  if (job.status === "failed") return job.error || "AI chưa hoàn tất. Bạn có thể thử lại hoặc tiếp tục thủ công.";
  return "AI đã hoàn tất. Kết quả là lớp tham chiếu để kiểm tra và chỉnh nhãn.";
}
export function trackJob({ read, onJob, onConnection, onUnavailable, interval = 2000, maxDelay = 30000 }) {
  let stopped = false, timer, errors = 0;
  const controller = new AbortController();
  async function tick() {
    let delay = interval;
    try {
      const job = await read(controller.signal);
      if (stopped) return;
      errors = 0;
      onConnection(true);
      onJob(job);
      if (!ACTIVE_JOB_STATUSES.has(job.status)) return;
    } catch (error) {
      if (stopped) return;
      if ([401,403,404,410].includes(error.status)) {
        onConnection(true);
        onUnavailable?.(error);
        return;
      }
      errors += 1;
      onConnection(false);
      delay = Math.min(maxDelay, interval * (2 ** Math.min(errors, 5)));
    }
    if (!stopped) timer = setTimeout(tick, delay);
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); controller.abort(); };
}
const keyFor = (api, user, caseId) => `brainhem:job:v1:${api}:${user}:${caseId}`;
export function rememberJob(api, user, caseId, jobId, storage = globalThis.localStorage) {
  try { storage?.setItem(keyFor(api, user, caseId), JSON.stringify({jobId, at: Date.now()})); } catch { /* server lookup remains available */ }
}
export function recalledJob(api, user, caseId, storage = globalThis.localStorage) {
  try {
    const item = JSON.parse(storage?.getItem(keyFor(api, user, caseId)) || "null");
    if (item?.jobId && Date.now() - item.at < 7 * 86400000) return item.jobId;
    storage?.removeItem(keyFor(api, user, caseId));
  } catch { /* malformed or unavailable local storage */ }
  return null;
}
