export function displayName(value) {
  return String(value || "").replace(/\s*[·•—-]?\s*automated\s+50-case\s+E2E/gi, "")
    .replace(/\s*[·•—-]?\s*E2E\b/gi, "").replace(/\s*[·•]\s*$/, "").trim();
}

const collator = new Intl.Collator("vi", { numeric:true, sensitivity:"base" });
export const hasAiResult = item => item?.ai_status === "succeeded" || item?.ai_status === "archived" && Boolean(item.ai_mask_url);
export const hasApprovedLabel = item => item?.latest_approved_revision != null || item?.status === "approved";
export function archivedAiResult(item) {
  if (item?.ai_status !== "archived" || !item.ai_mask_url) return null;
  return { id:null, archived:true, status:"succeeded", artifacts:{mask:item.ai_mask_url},
    model_version:item.ai_model_version, inference_tier:item.ai_tier,
    completed_at:item.ai_result_at, updated_at:item.ai_result_at };
}
const valueFor = (item, key) => {
  const hasLabel = Number(item.current_revision || 0) > 0;
  const values = {
    id: item.patient_id || displayName(item.name) || item.id,
    updated: item.updated_at ? Date.parse(item.updated_at) : null,
    name: item.patient_name || displayName(item.name),
    volume: hasLabel ? item.label_volume_ml : null,
    voxels: hasLabel ? item.label_voxel_count : null,
    components: hasLabel ? item.label_component_count : null,
    slices: hasLabel ? item.labeled_slice_count : null,
    reviewer: hasLabel ? item.annotated_by : null,
    status: item.status === "approved" ? 2 : hasLabel ? 1 : 0,
    ai: hasAiResult(item) ? 1 : 0,
  };
  return values[key];
};

export function sortCases(cases, key="updated", direction="desc") {
  return [...cases].sort((a,b) => {
    const x=valueFor(a,key), y=valueFor(b,key);
    const empty=v=>v == null || v === "" || (typeof v === "number" && !Number.isFinite(v));
    if(empty(x)!==empty(y))return empty(x)?1:-1;
    const result=empty(x)?0:typeof x === "number"&&typeof y === "number"?x-y:collator.compare(String(x),String(y));
    return (direction === "asc"?result:-result) || collator.compare(a.name||a.id,b.name||b.id) || collator.compare(a.id,b.id);
  });
}
