export const demoTriggerGuide = {
  id: "extension-training",
  category: "studio",
  time: "2 phút",
  title: "Kết nối extension huấn luyện",
  summary: "Baseline S chỉ có ONNX cho suy luận. Bản public không kèm checkpoint PT/PTH, mã model huấn luyện hoặc training runtime.",
  keywords: "extension huấn luyện fine tune dữ liệu",
  steps: [
    ["Cung cấp dữ liệu", "Đăng ký dữ liệu bạn có quyền sử dụng và kiểm tra nhãn trước khi tạo snapshot."],
    ["Kết nối dịch vụ", "Người vận hành bổ sung checkpoint có thể huấn luyện, mã model và runtime, rồi kiểm tra integration trước khi kết nối."],
    ["Theo dõi trạng thái", "Mở Model Studio để xem khả năng được cung cấp và trạng thái lượt chạy."],
  ],
  note: "Fine-tune, tự động huấn luyện và tự phát hành chưa khả dụng trong bản public.",
  links: [{ label: "Mở AI Studio", href: "/model-studio" }],
};

export const currentFineTuneVisual = {
  src: null,
  caption: "Huấn luyện cần extension được cung cấp riêng.",
  targets: [],
};
