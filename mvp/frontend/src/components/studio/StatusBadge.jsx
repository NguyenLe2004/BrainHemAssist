import React from "react";

const STATUS_CONFIG = {
  serving: { label: "● Đang phục vụ", tone: "green" },
  verified: { label: "✓ Đã xác minh", tone: "blue" },
  configured_unverified: { label: "○ Đã cấu hình, chưa xác minh", tone: "amber" },
  unavailable: { label: "✕ Không khả dụng", tone: "red" },
  ready: { label: "✓ Sẵn sàng", tone: "green" },
  draft: { label: "Bản nháp", tone: "neutral" },
  validating: { label: "Đang kiểm tra", tone: "blue" },
  patient_id_required: { label: "! Cần bổ sung Patient ID", tone: "amber" },
  leakage_risk: { label: "! Có nguy cơ leakage", tone: "red" },
  archived: { label: "Đã lưu trữ", tone: "neutral" },
  queued: { label: "Đang chờ", tone: "neutral" },
  fine_tuning: { label: "Đang Fine-tune", tone: "blue" },
  running: { label: "Đang chạy", tone: "blue" },
  awaiting_evaluation: { label: "Chờ đánh giá", tone: "amber" },
  evaluating: { label: "Đang đánh giá", tone: "blue" },
  quality_passed: { label: "✓ Đạt Quality gate", tone: "green" },
  quality_failed: { label: "! Không đạt Quality gate", tone: "red" },
  system_error: { label: "✕ Lỗi hệ thống", tone: "red" },
  candidate: { label: "Ứng viên", tone: "purple" },
  clinical_review: { label: "Chờ duyệt chuyên môn", tone: "amber" },
  release_review: { label: "Chờ duyệt phát hành", tone: "purple" },
  trial: { label: "Đang chạy thử", tone: "blue" },
  release_ready: { label: "Đủ điều kiện phát hành", tone: "green" },
  rejected: { label: "Đã loại", tone: "red" },
  // Compatibility with backend models & stages
  production: { label: "● Đang phục vụ", tone: "green" },
  technical_validated: { label: "Chờ duyệt chuyên môn", tone: "amber" },
  clinical_validated: { label: "Chờ duyệt phát hành", tone: "purple" },
  shadow: { label: "Đang chạy thử", tone: "blue" },
  succeeded: { label: "Fine-tune hoàn tất · chờ đánh giá", tone: "amber" },
  failed: { label: "Lỗi", tone: "red" },
  frozen: { label: "✓ Đã khóa (Ready)", tone: "green" },
};

export default function StatusBadge({ status, label, tone, className = "" }) {
  const config = STATUS_CONFIG[status] || {
    label: label || status || "—",
    tone: tone || "neutral",
  };
  const displayLabel = label || config.label;
  const displayTone = tone || config.tone;

  return (
    <span className={`sw-badge ${displayTone} ${className}`}>
      {displayLabel}
    </span>
  );
}
