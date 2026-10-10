import { matchingDraft } from "./draftStore.js";

export async function prepareLabelingCase(caseId, { getCase, getJob, seed, readDraft = async () => null }) {
  const current = await getCase(caseId);
  if (current.current_revision !== 0 || !current.ai_job_id) return current;

  const draft = await readDraft(current);
  const voxelCount = current.geometry?.shape?.reduce((total, size) => total * size, 1);
  if (matchingDraft(draft, current, voxelCount)) return current;

  const job = await getJob(current.ai_job_id);
  if (job.status !== "succeeded") return current;
  try {
    await seed(current.id, job.id, 0);
  } catch (error) {
    // Another session may have saved a label while this request was in flight.
    const latest = await getCase(current.id);
    if (latest.current_revision > 0) return latest;
    throw error;
  }
  return getCase(current.id);
}
