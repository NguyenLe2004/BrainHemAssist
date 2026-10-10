export const TRAINING_UNAVAILABLE_REASON = "Baseline S chỉ có artifact ONNX để suy luận. Bản public chưa cung cấp checkpoint PT/PTH, mã model có thể huấn luyện hoặc training runtime; Fine-tune và tự động huấn luyện chưa khả dụng.";

export function trainingAvailable(caps) {
  return caps?.training_available === true;
}

export function TrainingUnavailable({ caps = {}, heading = "Fine-tune chưa khả dụng" }) {
  return <section className="sw-card" role="status" data-testid="training-unavailable">
    <h2>{heading}</h2>
    <p>{caps.training_unavailable_reason || TRAINING_UNAVAILABLE_REASON}</p>
    <p>Giao diện quản lý dữ liệu và lịch sử vẫn có thể dùng. Huấn luyện cần checkpoint, mã model và extension được cung cấp, kiểm tra rồi kết nối riêng.</p>
    <div className="sw-actions"><button type="button" disabled>Bắt đầu Fine-tune</button><button type="button" disabled>Bật tự động huấn luyện</button></div>
  </section>;
}

export function isInferenceOnlyModel(model) {
  if (!model) return false;
  const names = [model.artifact_path, model.artifact_filename, model.filename, model.artifact_format, model.format, model.metrics?.artifact_format];
  return model.id === "baseline-s" || model.id === "baseline_s" || names.some(value => /(?:\.onnx$|^onnx$)/i.test(String(value || "")));
}
