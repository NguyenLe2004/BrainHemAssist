import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { useAppAuth } from "./components/AppAuth";
import "./Docs.css";
const homeImage = null;
const clinicalImage = null;
const clinicalReviewImage = null;
const labelingImage = null;
const studioOverviewImage = null;
const studioFineTuneImage = null;
const studioHardwareImage = null;
const simulatorImage = null;
const verifiedTargets = {};
import {demoTriggerGuide,currentFineTuneVisual} from "./demoTriggerGuide";

const CATEGORIES = [
  { id: "start", label: "Bắt đầu", icon: "spark" },
  { id: "clinical", label: "Đọc CT", icon: "scan" },
  { id: "ai", label: "Phân tích AI", icon: "cube" },
  { id: "labeling", label: "Gán nhãn", icon: "tag" },
  { id: "studio", label: "Model Studio", icon: "chart" },
  { id: "simulator", label: "CT Simulator", icon: "upload" },
  { id: "troubleshoot", label: "Xử lý sự cố", icon: "alert" },
  { id: "glossary", label: "Thuật ngữ", icon: "help" },
];

const ARTICLES = [
  demoTriggerGuide,
  {
    id: "dicom-upload", category: "start", time: "3 phút", title: "Tải DICOM hoặc NIfTI và xem kết quả AI",
    summary: "Tiếp nhận một ca ngoài hệ thống, dựng volume và mở kết quả phân tích.",
    keywords: "upload tải lên tiếp nhận dicom nifti nii zip thư mục kết quả ai",
    steps: [
      ["Mở tiếp nhận", "Tại Dashboard hoặc Clinical, bấm Tiếp nhận ca CT."],
      ["Chọn dữ liệu", "Thả thư mục DICOM, file DICOM, ZIP DICOM hoặc một file NIfTI .nii/.nii.gz vào vùng nhận dữ liệu."],
      ["Chọn chạy AI", "Bật Tự phân tích AI sau khi nhận ca nếu muốn hệ thống tự chạy; nếu để tắt, bạn có thể chạy thủ công sau."],
      ["Tiếp nhận và mở", "Bấm Tiếp nhận và mở ca, chờ hệ thống tải dữ liệu và dựng volume CT."],
      ["Xem kết quả", "Nếu chưa chạy tự động, bấm Phân tích AI. Khi hoàn tất, bật AI overlay và đối chiếu với ảnh gốc trước khi duyệt."],
    ],
    note: "Có thể chọn cả một thư mục DICOM. Không trộn file của nhiều study trong cùng một lần tiếp nhận.",
    links: [{ label: "Mở Dashboard", href: "/#home" }, { label: "Mở Clinical", href: "/#clinical" }],
  },
  {
    id: "first-case", category: "start", time: "5 phút", title: "Bắt đầu với ca CT đầu tiên",
    summary: "Đi từ danh sách ca đến đọc ảnh, chạy AI và hoàn tất đánh giá an toàn.",
    keywords: "mở ca bệnh nhân dashboard bắt đầu upload đọc ảnh kết quả",
    steps: [
      ["Mở danh sách ca", "Tại Dashboard chọn Mở ca hiện có, hoặc mở Clinical từ thanh điều hướng. Tìm theo tên hoặc mã ca rồi chọn đúng ca cần đọc."],
      ["Đọc ảnh gốc", "Duyệt toàn bộ lát cắt, điều chỉnh cửa sổ ảnh nếu cần. Không bật AI ngay nếu bạn muốn có nhận định độc lập trước."],
      ["Chạy Phân tích AI", "Chọn Phân tích AI và chờ trạng thái hoàn tất. Kết quả gồm vùng gợi ý, thể tích mask và điểm đầu ra model chưa hiệu chuẩn lâm sàng; đây không phải kết luận chẩn đoán."],
      ["Đối chiếu và kết luận", "So sánh từng vùng AI với ảnh gốc, chuyển qua các ổ 3D nếu có nhiều vùng, sau đó Duyệt kết quả hoặc Từ chối kèm ghi chú."],
    ],
    note: "Luôn kiểm tra ảnh gốc và bối cảnh lâm sàng. Không dùng riêng lớp phủ AI để đưa ra kết luận.",
    links: [{ label: "Mở Dashboard", href: "/#home" }, { label: "Mở Clinical", href: "/#clinical" }],
  },
  {
    id: "navigation", category: "start", time: "3 phút", title: "Hiểu các khu vực trong hệ thống",
    summary: "Biết nơi cần đến mà không phải nhớ thuật ngữ kỹ thuật.",
    keywords: "dashboard clinical expert labeling ai studio settings điều hướng menu",
    sections: [
      ["Dashboard", "Xem ca gần đây, trạng thái xử lý và mở nhanh công việc thường dùng."],
      ["Clinical", "Đọc ảnh CT, đo khoảng cách, chạy AI và duyệt kết quả."],
      ["Expert Labeling", "Tạo hoặc sửa nhãn chuẩn bởi chuyên gia, phục vụ đánh giá và huấn luyện."],
      ["AI Studio", "Quản lý dữ liệu, nhãn và lịch sử model. Huấn luyện, hiệu chỉnh và phát hành cần extension riêng; bản public chỉ có ONNX cho suy luận."],
      ["Settings", "Xem trạng thái dịch vụ và mở CT Simulator. Chính sách tự động chạy AI nằm tại AI Studio → Tổng quan."],
    ],
  },
  {
    id: "viewer-controls", category: "clinical", time: "4 phút", title: "Điều khiển ảnh CT: kéo, zoom và đổi lát",
    summary: "Các thao tác chuột quan trọng trong màn hình đọc ảnh.",
    keywords: "zoom con trỏ scroll wheel chuột kéo pan lát cắt window level w l reset",
    steps: [
      ["Phóng to/thu nhỏ", "Đặt con trỏ tại vùng muốn quan sát rồi cuộn chuột. Ảnh sẽ zoom quanh vị trí con trỏ để vùng đó không bị trôi khỏi tầm nhìn."],
      ["Di chuyển ảnh", "Tắt công cụ Thước, sau đó giữ chuột trái và kéo ảnh."],
      ["Đổi lát cắt", "Giữ Ctrl và cuộn chuột. Số lát hiện tại được hiển thị trên viewport."],
      ["Chỉnh cửa sổ ảnh", "Dùng danh sách W/L, chọn preset Brain hoặc mở Tùy chỉnh để thay đổi độ sáng và tương phản."],
    ],
    tip: "Nếu cuộn làm đổi lát thay vì zoom, hãy kiểm tra phím Ctrl có đang bị giữ hay không.",
  },
  {
    id: "measure", category: "clinical", time: "2 phút", title: "Đo khoảng cách và xóa thước",
    summary: "Đo một cấu trúc theo mm hoặc cm và chỉnh lại hai đầu thước.",
    keywords: "thước đo cm mm delete xóa kéo hai đầu điểm đo nhỏ",
    steps: [
      ["Tạo phép đo", "Chọn Thước trên thanh công cụ, sau đó kéo từ điểm bắt đầu đến điểm kết thúc trên ảnh."],
      ["Chỉnh phép đo", "Chọn đoạn thước rồi kéo một trong hai điểm tròn ở hai đầu. Kết quả được cập nhật ngay theo pixel spacing của ảnh."],
      ["Xóa phép đo", "Bấm vào đoạn thước cần xóa để nó chuyển sang trạng thái được chọn, sau đó nhấn Delete hoặc Backspace."],
      ["Thoát công cụ", "Bấm lại Thước để tắt chế độ đo, sau đó tiếp tục kéo và quan sát ảnh."],
    ],
    note: "Số đo chỉ đáng tin khi DICOM có Pixel Spacing hợp lệ. Hãy đối chiếu thông tin series nếu kết quả bất thường.",
  },
  {
    id: "feedback", category: "troubleshoot", time: "2 phút", title: "Gửi góp ý tới người quản trị",
    summary: "Báo lỗi hoặc đề xuất cải tiến trực tiếp từ BrainHem mà không cần tài khoản riêng.",
    keywords: "feedback phản hồi góp ý báo lỗi đề xuất email quản trị liên hệ",
    steps: [
      ["Mở trang Feedback", "Chọn Gửi phản hồi trên thanh điều hướng. Người gửi không cần đăng nhập; admin chọn Đăng nhập quản trị trên cùng trang để mở hộp thư."],
      ["Chọn vai trò", "Chọn vai trò gần nhất với công việc của bạn để người quản trị hiểu đúng bối cảnh sử dụng."],
      ["Mô tả vấn đề", "Nêu thao tác đã làm, kết quả thực tế và kết quả mong muốn. Không ghi tên, mã bệnh nhân hoặc thông tin y tế định danh."],
      ["Gửi và giữ mã", "Bấm Gửi góp ý. Khi nội dung được lưu vào hộp thư quản trị, giữ lại mã FB hiển thị trên màn hình nếu cần trao đổi tiếp."],
    ],
    note: "Thông tin liên hệ không bắt buộc. Nếu muốn nhận phản hồi, bạn có thể để lại email hoặc số điện thoại.",
    links: [{ label: "Mở trang Feedback", href: "/feedback" }],
  },
  {
    id: "ai-review", category: "ai", time: "6 phút", title: "Chạy và kiểm tra kết quả AI đúng cách",
    summary: "Quy trình từ bấm phân tích đến duyệt hoặc đưa ca vào Fine-tune.",
    keywords: "phân tích ai component mask overlay confidence duyệt từ chối fine tune lag",
    steps: [
      ["Bắt đầu", "Bấm Phân tích AI. Không đóng ca trong lúc trạng thái đang xếp hàng hoặc đang chạy."],
      ["Xem lớp phủ", "Khi hoàn tất, bật AI overlay và điều chỉnh ngưỡng hoặc độ trong suốt nếu cần. Chuyển giữa các ổ 3D để kiểm tra tất cả vùng nghi ngờ."],
      ["Đối chiếu", "Tắt/bật lớp phủ nhiều lần và xem trên các mặt phẳng để phát hiện bỏ sót hoặc dương tính giả."],
      ["Ghi nhận", "Chọn Duyệt nếu phù hợp. Chọn Từ chối và ghi rõ bỏ sót, khoanh sai hoặc sai subtype nếu không phù hợp."],
      ["Đưa vào Fine-tune", "Với ca sai, khó hoặc hiếm, chọn Đưa vào Learning Queue, ghi lý do và mức ưu tiên. Ca chỉ được dùng huấn luyện sau khi có nhãn Gold và QC."],
    ],
    note: "AI là công cụ hỗ trợ. Trạng thái Duyệt xác nhận bạn đã đối chiếu ảnh gốc, không có nghĩa mô hình thay thế bác sĩ.",
  },
  {
    id: "auto-ai", category: "ai", time: "3 phút", title: "Tự động chạy AI cho ca từ máy CT",
    summary: "Bật một lần để hệ thống tự phân tích các ca DICOM mới nhận.",
    keywords: "tự động auto run ai mọi case upload ct simulator setting dicom",
    steps: [
      ["Mở chính sách", "Mở AI Studio ở cửa sổ riêng, chọn Tổng quan và tìm thẻ Tự động chạy AI cho mọi ca CT mới."],
      ["Đăng nhập vận hành", "Phiên BrainHem hiện tại được dùng để lưu chính sách; không cần đăng nhập lại trong Model Studio."],
      ["Chọn cách chạy", "Bật công tắc và chọn Baseline S khi dịch vụ sẵn sàng. M/L là extension chưa được cung cấp."],
      ["Lưu chính sách", "Bấm Lưu chính sách. Thiết lập áp dụng cho CT Simulator, file NIfTI upload và study DICOM upload tiếp theo."],
      ["Kiểm tra", "Gửi một ca thử. Dashboard phải lần lượt hiển thị Đã nhận, Đang chạy và Hoàn tất. Nếu không, xem bài Ca không tự chạy AI."],
    ],
  },
  {
    id: "gold-label", category: "labeling", time: "8 phút", title: "Tạo nhãn Gold cho một ca",
    summary: "Tạo nhãn đã duyệt để lưu trữ hoặc xuất dữ liệu; Fine-tune cần extension huấn luyện riêng.",
    keywords: "expert labeling label annotate annotation gán nhãn ca bệnh gold qc mask brush polygon fine tune",
    steps: [
      ["Mở hàng chờ", "Vào Expert Labeling và chọn ca được gắn cờ. Đọc lý do chọn mẫu và kiểm tra đúng series."],
      ["Tạo nhãn", "Dùng Bút, Đường bao hoặc Tẩy trên ảnh chính; thay đổi được ghi nhận theo tài khoản BrainHem hiện tại. Vòng tròn tại con trỏ cho biết cỡ Bút/Tẩy."],
      ["Kiểm tra theo vùng", "Mở Duyệt vùng, lần lượt kiểm tra từng ổ 3D trên axial, coronal và sagittal. Dùng Thêm ổ, Tách ổ hoặc Gộp khi cấu trúc component chưa đúng."],
      ["Lưu bản nháp", "Bản vẽ được tự lưu thành revision. Chỉ rời ca khi thanh trạng thái hiển thị Đã lưu; nếu báo Lưu thất bại, dùng Thử lưu lại."],
      ["Hoàn tất và duyệt", "Sau khi mọi vùng đã được kiểm tra, chọn Hoàn tất…, xác nhận toàn bộ thể tích và thực hiện bước duyệt theo quyền được cấp. Nhãn đã duyệt mới đủ điều kiện làm Gold label."],
    ],
    note: "Không sửa nhãn chỉ để làm metric đẹp hơn trên test set. Mọi thay đổi phải dựa trên ảnh và quy trình chuyên môn.",
  },
  {
    id: "active-learning", category: "studio", time: "2 phút", title: "Fine-tune chưa khả dụng trong bản public",
    summary: "Baseline S chỉ có ONNX để suy luận; không kèm checkpoint PT/PTH, mã model có thể huấn luyện hoặc training runtime.",
    keywords: "fine tune train checkpoint pt pth onnx extension",
    steps: [
      ["Xem phạm vi", "ONNX và loader chỉ phục vụ suy luận. Nút bắt đầu Fine-tune và tự động huấn luyện được vô hiệu hóa."],
      ["Chuẩn bị dữ liệu", "Bạn vẫn có thể quản lý dữ liệu và nhãn đã duyệt. Tạo dataset không bổ sung khả năng huấn luyện cho ONNX."],
      ["Bổ sung extension", "Muốn huấn luyện, cần checkpoint có thể huấn luyện, mã model và runtime được cung cấp, kiểm tra rồi kết nối riêng."],
    ],
    note: "Chỉ có file PT/PTH hoặc cấu hình command chưa đủ để xác nhận có thể Fine-tune. Backend phải xác minh toàn bộ integration trước khi cấp capability.",
    links: [{ label: "Mở Model Studio", href: "/model-studio" }, { label: "Kết nối extension", href: "/guide#extension-training" }],
  },
  {
    id: "training-chart", category: "studio", time: "4 phút", title: "Đọc biểu đồ train/validation",
    summary: "Tham khảo cách đọc lịch sử từ extension huấn luyện được cung cấp riêng; bản public chưa tạo run huấn luyện.",
    keywords: "chart biểu đồ train val loss overfit fail quality gate dice recall",
    sections: [
      ["Train loss", "Sai số trên dữ liệu dùng cập nhật trọng số. Thường giảm dần, nhưng thấp không đồng nghĩa model tổng quát tốt."],
      ["Validation loss", "Sai số trên dữ liệu model không dùng để cập nhật trọng số. Nếu tăng trong khi train loss tiếp tục giảm, model có thể đang overfit."],
      ["Dice", "Mức độ chồng khớp giữa mask dự đoán và nhãn chuẩn. Gần 1 tốt hơn; ca tổn thương rất nhỏ có thể làm Dice dao động mạnh."],
      ["Lesion Recall", "Tỷ lệ tổn thương thật được phát hiện. Recall cao giúp giảm bỏ sót nhưng có thể làm tăng dương tính giả."],
      ["Quality gate Fail", "Run không đạt ít nhất một điều kiện đã đặt, ví dụ Dice < 0.50 hoặc Recall < 0.80. Xem từng metric và dữ liệu lỗi trước khi train lại."],
    ],
    tip: "Một đường biểu đồ đẹp chưa đủ. Luôn xem số ca, cách chia bệnh nhân và kết quả theo từng ca.",
  },
  {
    id: "postprocess", category: "studio", time: "2 phút", title: "Postprocess cần extension riêng",
    summary: "Bản public chưa cung cấp runtime tạo prediction calibration hoặc hiệu chỉnh Postprocess.",
    keywords: "postprocess extension validation checkpoint runtime",
    steps: [
      ["Kiểm tra khả năng", "Đọc trạng thái chưa khả dụng trong AI Studio. Baseline S ONNX không kèm quy trình hiệu chỉnh."],
      ["Cung cấp integration", "Muốn hiệu chỉnh, người vận hành cần cung cấp và xác minh preprocessing, runtime, postprocessing, dữ liệu và protocol đánh giá."],
      ["Lưu kết quả", "Giao diện có thể hiển thị lịch sử do integration riêng tạo; số liệu chưa có không được xem là kết quả đã kiểm định."],
    ],
  },
  {
    id: "model-release", category: "studio", time: "6 phút", title: "Đánh giá và phát hành mô hình",
    summary: "Đưa đúng model vào Clinical mà vẫn giữ được lịch sử và khả năng quay lại.",
    keywords: "model registry validation release deploy production chọn mô hình rollback",
    steps: [
      ["Kiểm tra bằng chứng", "Xem dataset, checkpoint nguồn, metric validation/test, cấu hình postprocess và người thực hiện."],
      ["Qua quality gate", "Chỉ tiếp tục nếu model đạt ngưỡng đã định trước. Không hạ gate sau khi nhìn kết quả chỉ để model được pass."],
      ["Duyệt chuyên môn", "Tại Model Registry, model Technical QA cần được Duyệt chuyên môn bởi người có quyền."],
      ["Duyệt phát hành", "Sau Clinical QA, chọn Duyệt phát hành rồi Chạy thử Shadow. Nạp shadow report hợp lệ để lưu bằng chứng vận hành."],
      ["Phát hành", "Chỉ khi đủ phê duyệt và bằng chứng Shadow mới chọn Phát hành Production. Model cũ vẫn phục vụ cho tới thời điểm này."],
      ["Theo dõi", "Giám sát lỗi, ca bị từ chối và drift. Nếu có vấn đề, ngừng phát hành hoặc quay lại phiên bản ổn định trước."],
    ],
  },
  {
    id: "hardware", category: "studio", time: "3 phút", title: "Theo dõi tài nguyên phần cứng",
    summary: "Biết CPU, GPU, RAM, ổ đĩa và mạng có đang giới hạn training hay không.",
    keywords: "hardware hệ thống cpu gpu ram vram disk ổ đĩa nhiệt độ network online",
    sections: [
      ["GPU và VRAM", "Training segmentation chủ yếu phụ thuộc GPU. VRAM gần đầy có thể gây out-of-memory; giảm batch size trước khi đổi dữ liệu."],
      ["CPU và RAM", "Dùng để đọc, giải nén và tiền xử lý dữ liệu. CPU cao nhưng GPU thấp thường cho thấy pipeline nạp dữ liệu đang nghẽn."],
      ["Ổ đĩa", "Cần đủ chỗ cho DICOM/NIfTI, probability mask và checkpoint. Không khởi chạy run lớn khi dung lượng trống quá thấp."],
      ["Nhiệt độ và trạng thái", "Nhiệt độ cao kéo dài có thể làm giảm xung. Worker phải Online trước khi bắt đầu run."],
    ],
  },
  {
    id: "ct-simulator", category: "simulator", time: "5 phút", title: "Gửi một ca từ CT Simulator",
    summary: "Mô phỏng máy CT gửi DICOM vào hệ thống và theo dõi trạng thái nhận.",
    keywords: "ct simulator gửi dicom upload máy ct ae title pacs setting",
    steps: [
      ["Mở Simulator", "Vào Settings → CT Simulator hoặc mở trang simulator từ liên kết cấu hình."],
      ["Chọn nguồn", "Chọn một ca CT mẫu trong Nguồn acquisition, hoặc chọn file .nii/.nii.gz của bạn."],
      ["Đặt mã ẩn danh", "Nhập Patient ID ẩn danh bắt đầu bằng ANON-. Không nhập mã bệnh nhân thật vào trình giả lập."],
      ["Gửi acquisition", "Bấm Gửi acquisition từ máy CT và giữ trang mở đến khi trạng thái hiển thị Đã nhận đủ series."],
      ["Theo dõi", "Mở Dashboard để xác nhận ca mới. Nếu bật tự động AI, trạng thái sẽ chuyển tiếp sang hàng đợi phân tích."],
    ],
    note: "Chỉ dùng dữ liệu đã được phép xử lý. Simulator không loại bỏ thông tin định danh thay cho quy trình de-identification.",
    links: [{ label: "Mở CT Simulator", href: "/simulator" }, { label: "Mở Settings", href: "/#settings" }],
  },
  {
    id: "ai-slow", category: "troubleshoot", time: "4 phút", title: "Sau khi chạy AI, giao diện chậm hoặc giật",
    summary: "Các bước khôi phục nhanh và thông tin cần ghi lại nếu lỗi lặp lại.",
    keywords: "ai lag chậm giật treo component switch performance browser gpu overlay",
    steps: [
      ["Giảm lớp hiển thị", "Tắt lớp phủ AI, 3D hoặc panel không dùng. Kiểm tra thao tác ảnh đã mượt trở lại chưa."],
      ["Đợi tác vụ nền", "Nếu đang có trạng thái phân tích component, hãy chờ hoàn tất rồi mới chuyển liên tục giữa các vùng."],
      ["Mở lại ca", "Quay về Dashboard rồi mở lại đúng ca. Kết quả AI đã lưu sẽ được tải lại, không cần chạy phân tích lần nữa."],
      ["Ghi thông tin lỗi", "Nếu vẫn chậm, ghi mã ca, số lát, số component, trình duyệt, thời điểm và thao tác gây chậm để quản trị viên kiểm tra."],
    ],
    tip: "Không bấm Phân tích AI nhiều lần. Việc này không làm tác vụ đầu tiên nhanh hơn và có thể tạo thêm hàng đợi.",
  },
  {
    id: "auto-ai-failed", category: "troubleshoot", time: "5 phút", title: "Ca từ CT không tự chạy AI",
    summary: "Kiểm tra lần lượt nguồn nhận, chính sách tự động và model đang hoạt động.",
    keywords: "không tự chạy ai ct upload queued failed model active simulator lỗi",
    steps: [
      ["Xác nhận ca đã được nhận", "Nếu ca không có trên Dashboard, kiểm tra lại trạng thái gửi DICOM và kết nối Simulator."],
      ["Kiểm tra chính sách", "Trong AI Studio → Tổng quan, xác nhận Tự động chạy AI cho mọi ca CT mới đang bật và đã được lưu."],
      ["Kiểm tra model", "Trong cùng thẻ chính sách, kiểm tra Model tự động đang khả dụng. Model được cố định vào job tại thời điểm ca được nhận."],
      ["Kiểm tra worker", "Vào Model Studio → Hệ thống, xác nhận worker Online và GPU/ổ đĩa không quá tải."],
      ["Chạy thủ công", "Mở ca và bấm Phân tích AI để phân biệt lỗi chính sách tự động với lỗi inference. Lưu thông báo lỗi nếu tác vụ thất bại."],
    ],
  },
  {
    id: "quality-fail", category: "troubleshoot", time: "5 phút", title: "Quality gate vẫn Fail: cần làm gì?",
    summary: "Tìm nguyên nhân thay vì hạ ngưỡng hoặc train lại một cách mù quáng.",
    keywords: "quality gate fail dice recall 0.5 0.8 validation test train ít data",
    steps: [
      ["Đọc điều kiện fail", "Xác định Dice, Recall hay cả hai thấp hơn ngưỡng. Xem metric theo từng ca, không chỉ số trung bình."],
      ["Kiểm tra dữ liệu", "Tìm nhãn sai, ca quá ít, mất cân bằng kích thước tổn thương, spacing khác thường hoặc chia trùng bệnh nhân."],
      ["Kiểm tra biểu đồ", "Nếu train tốt nhưng validation xấu, ưu tiên xử lý overfitting và tính đại diện của dữ liệu. Nếu cả hai đều xấu, xem cấu hình/model nền."],
      ["Sửa đúng tầng", "Lỗi mask cần dữ liệu/nhãn hoặc training; dương tính giả nhỏ có thể xử lý bằng postprocess trên validation."],
      ["Giữ test sạch", "Không thêm ca locked test vào train và không hạ gate sau khi xem test. Tạo một run mới có ghi lại thay đổi."],
    ],
    note: "Fail là cơ chế bảo vệ. Không phát hành model chỉ vì giao diện cần hiện Pass.",
  },
  {
    id: "glossary", category: "glossary", time: "5 phút", title: "Từ điển thuật ngữ ngắn gọn",
    summary: "Các từ thường gặp trong Clinical và Model Studio, giải thích bằng ngôn ngữ thông dụng.",
    keywords: "từ điển dicom series mask component checkpoint epoch loss dice recall hd95 oof gold qc",
    sections: [
      ["DICOM / Study / Series", "DICOM là định dạng ảnh y khoa. Một study là một lần chụp; bên trong có thể có nhiều series."],
      ["Mask", "Vùng được tô để biểu diễn vị trí tổn thương trên ảnh."],
      ["Component", "Một vùng mask liền nhau trong không gian 3D. Một ca có thể có nhiều component."],
      ["Gold label", "Nhãn chuẩn đã được chuyên gia kiểm định và đủ điều kiện dùng làm tham chiếu."],
      ["Checkpoint", "Tệp lưu trọng số model tại một thời điểm huấn luyện."],
      ["Epoch", "Một lượt model học qua toàn bộ tập train."],
      ["Loss", "Sai số dùng để tối ưu model; nhỏ hơn thường tốt hơn nhưng phải xem cùng validation."],
      ["Dice", "Độ chồng khớp giữa dự đoán và nhãn, từ 0 đến 1."],
      ["Recall", "Tỷ lệ tổn thương thật được phát hiện; recall thấp nghĩa là bỏ sót nhiều."],
      ["HD95", "Khoảng cách biên ở phân vị 95%; nhỏ hơn thường tốt hơn và ít bị điểm ngoại lai chi phối hơn Hausdorff tối đa."],
      ["OOF", "Prediction ngoài fold: mỗi bệnh nhân được dự đoán bởi model không học trên bệnh nhân đó."],
      ["Locked test", "Tập chỉ mở để đánh giá cuối cùng sau khi model và postprocess đã khóa."],
    ],
  },
];

const QUICK_TASKS = [
  ["Kết nối extension", "extension-training", "chart"],
  ["Mở và đọc ca đầu tiên", "first-case", "scan"],
  ["Đo một khoảng cách", "measure", "measure"],
  ["Chạy và duyệt AI", "ai-review", "cube"],
  ["Fine-tune model", "active-learning", "chart"],
  ["Xử lý Quality gate Fail", "quality-fail", "alert"],
  ["Gửi ca từ máy CT", "ct-simulator", "upload"],
];

const mark = (group, key, number, label) => {
  const target = verifiedTargets[group]?.[key];
  return target ? [target.x, target.y, number, label] : null;
};
const marks = (...items) => items.filter(Boolean);

const VISUALS = {
  "dicom-upload": { src: homeImage, caption: "Từ Dashboard, chọn Tiếp nhận ca CT để tải DICOM, ZIP hoặc NIfTI.", markers: marks(mark("home","intake",1,"Tiếp nhận ca CT")) },
  "first-case": { src: homeImage, caption: "Có thể mở danh sách ca từ tác vụ nhanh hoặc vào Clinical trên thanh điều hướng.", markers: marks(mark("home","open",1,"Mở ca hiện có"),mark("home","clinical",2,"Mở Clinical")) },
  navigation: { src: homeImage, caption: "Năm khu vực chính dùng chung một thanh điều hướng; AI Studio mở thành workspace riêng.", markers: marks(mark("home","dashboard",1,"Dashboard"),mark("home","clinical",2,"Clinical"),mark("home","labeling",3,"Expert Labeling"),mark("home","studio",4,"AI Studio"),mark("home","settings",5,"Settings")) },
  "viewer-controls": { src: clinicalImage, caption: "Các điều khiển cần dùng thường xuyên nằm trên thanh trên cùng; số lát và hướng dẫn chuột nằm dưới ảnh chính.", markers: marks(mark("clinical","ruler",1,"Thước đo"),mark("clinical","references",2,"Ẩn/hiện ảnh phụ"),mark("clinical","wl",3,"Preset W/L"),mark("clinical","slice",4,"Vị trí lát hiện tại")) },
  measure: { src: clinicalImage, caption: "Bấm Thước để bắt đầu đo và bấm lại chính nút này để trở về thao tác ảnh.", markers: marks(mark("clinical","ruler",1,"Bật/tắt Thước")) },
  "ai-review": { src: clinicalReviewImage, caption: "Kiểm tra lớp phủ và từng ổ 3D trước khi ghi nhận quyết định hoặc đưa ca vào hàng chờ cải thiện.", markers: marks(mark("review","overlay",1,"Bật/tắt AI overlay"),mark("review","components",2,"Danh sách ổ 3D"),mark("review","edit",3,"Duyệt, chỉnh sửa hoặc từ chối"),mark("review","queue",4,"Đưa ca khó vào Learning Queue")) },
  "auto-ai": { src: studioOverviewImage, caption: "Chính sách tự động nằm tại AI Studio → Tổng quan và chỉ áp dụng sau khi bấm Lưu chính sách.", markers: marks(mark("overview","toggle",1,"Bật/tắt tự động"),mark("overview","modelSelect",2,"Chọn Baseline S"),mark("overview","save",3,"Lưu chính sách")) },
  "gold-label": { src: labelingImage, caption: "Ca đã mở trong Expert Labeling. Công cụ chỉnh nhãn dùng ngay phiên BrainHem hiện tại; kiểm tra trạng thái lưu và từng vùng trước khi hoàn tất.", markers: marks(mark("labeling","brush",1,"Bút"),mark("labeling","contour",2,"Đường bao"),mark("labeling","eraser",3,"Tẩy"),mark("labeling","save",4,"Trạng thái tự lưu"),mark("labeling","review",5,"Duyệt từng vùng"),mark("labeling","finish",6,"Hoàn tất ca")) },
  "active-learning": currentFineTuneVisual,
  hardware: { src: studioHardwareImage, caption: "AI Studio → Hệ thống hiển thị số liệu máy chủ thực và tự cập nhật theo thời gian." },
  "ct-simulator": { src: simulatorImage, caption: "CT Simulator nằm trong Settings; bốn trường thao tác chính nằm ở hàng cuối màn hình.", markers: marks(mark("simulator","source",1,"Chọn ca mẫu"),mark("simulator","patient",2,"Nhập mã ANON-"),mark("simulator","file",3,"Hoặc chọn NIfTI"),mark("simulator","send",4,"Gửi acquisition")) },
  "auto-ai-failed": { src: studioOverviewImage, caption: "Khi ca không tự chạy, kiểm tra công tắc, Baseline S và trạng thái đã lưu ngay tại thẻ này.", markers: marks(mark("overview","toggle",1,"Chính sách đang bật?"),mark("overview","modelSelect",2,"Model có khả dụng?"),mark("overview","save",3,"Đã lưu chính sách?")) },
  "quality-fail": { src: studioFineTuneImage, caption: "Gate FAIL giữ nguyên model đang phục vụ; xem Dice và Recall tại khối Quality gate trước khi tạo run mới.", markers: marks(mark("fineTune","gate",1,"Đọc nguyên nhân không đạt")) },
};

function normalize(value = "") {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function articleText(article) {
  return [article.title, article.summary, article.keywords, article.preparation,
    ...(article.steps || []).flatMap(([title,copy,detail])=>[title,copy,...(detail?.actions||[]),detail?.expected]),
    ...(article.sections || []).flat(), article.note, article.tip].filter(Boolean).join(" ");
}

function GuideVisual({ visual }) {
  if (!visual?.src) return null;
  return <figure className="docs-visual">
    <div className="docs-visual-frame"><img src={visual.src} alt={visual.caption} loading="lazy" decoding="async"/>{(visual.markers||[]).map(([x,y,number,label])=><span className="docs-marker" style={{left:`${x}%`,top:`${y}%`}} key={`${number}-${label}`} aria-label={`${number}. ${label}`}>{number}</span>)}{(visual.targets||[]).map(target=><span className="docs-target" key={target.number} style={{left:`${target.x}%`,top:`${target.y}%`,width:`${target.width}%`,height:`${target.height}%`}} aria-label={`${target.number}. ${target.label}`}><b>{target.number}</b></span>)}</div>
    <figcaption><Icon name="scan" size={18}/><div><strong>Nhìn nhanh trên giao diện</strong><span>{visual.caption}</span></div></figcaption>
    {!!visual.markers?.length&&<div className="docs-legend">{visual.markers.map(([, ,number,label])=><span key={`${number}-${label}`}><b>{number}</b>{label}</span>)}</div>}
    {!!visual.targets?.length&&<div className="docs-legend">{visual.targets.map(target=><span key={target.number}><b>{target.number}</b>{target.label}</span>)}</div>}
    {!!visual.targets?.length&&<a className="docs-image-link" href={visual.src} target="_blank" rel="noopener noreferrer">Mở ảnh lớn <Icon name="external" size={14}/></a>}
  </figure>;
}

function Article({ article }) {
  return <article className="docs-article" id={article.id}>
    <header>
      <div><span>{CATEGORIES.find(item => item.id === article.category)?.label}</span><h1>{article.title}</h1><p>{article.summary}</p></div>
      <small><Icon name="clock" size={15}/>{article.time} đọc</small>
    </header>
    {article.verified&&<p className="docs-verification"><Icon name="checkCircle" size={17}/>{article.verified}</p>}
    {article.preparation&&<aside className="docs-callout tip"><Icon name="layout" size={21}/><div><strong>Chuẩn bị hai cửa sổ</strong><p>{article.preparation}</p></div></aside>}
    <GuideVisual visual={VISUALS[article.id]}/>
    {article.steps && <><nav className="docs-on-page" aria-label="Các bước trong bài"><strong>Các bước</strong>{article.steps.map(([title], index) => <a href={`#${article.id}-step-${index + 1}`} key={title}><b>{index + 1}</b>{title}</a>)}</nav><ol className="docs-steps">{article.steps.map(([title, copy,detail], index) => <li id={`${article.id}-step-${index + 1}`} key={title}><b>{index + 1}</b><div><small>BƯỚC {index + 1}{detail?.role?` · CỬA SỔ ${detail.role}`:""}</small><h2>{title}</h2><p>{copy}</p>{detail?.actions&&<ol className="docs-step-actions">{detail.actions.map(action=><li key={action}>{action}</li>)}</ol>}{detail?.expected&&<p className="docs-step-expected"><strong>Phải thấy: </strong>{detail.expected}</p>}{detail?.speech&&<blockquote className="docs-step-speech"><small>LỜI NÓI GỢI Ý</small><p>{detail.speech}</p></blockquote>}{detail?.visuals?.map(visual=><GuideVisual key={visual.caption} visual={visual}/>)}{index === article.steps.length - 1 && !detail && <em><Icon name="checkCircle" size={16}/>Hoàn tất bước này trước khi chuyển sang công việc tiếp theo.</em>}</div></li>)}</ol></>}
    {article.issues&&<section className="docs-demo-issues"><h2>Nếu chưa thấy đúng trạng thái</h2>{article.issues.map(([title,copy])=><details key={title}><summary>{title}</summary><p>{copy}</p></details>)}</section>}
    {article.sections && <div className="docs-definition-list">{article.sections.map(([title, copy]) => <section key={title}><h2>{title}</h2><p>{copy}</p></section>)}</div>}
    {article.note && <aside className="docs-callout warning"><Icon name="shield" size={21}/><div><strong>{article.noteTitle||"Lưu ý an toàn"}</strong><p>{article.note}</p></div></aside>}
    {article.tip && <aside className="docs-callout tip"><Icon name="spark" size={21}/><div><strong>Mẹo nhanh</strong><p>{article.tip}</p></div></aside>}
    {article.links && <div className="docs-actions">{article.links.map(link => <a href={link.href} key={link.href}>{link.label}<Icon name="external" size={15}/></a>)}</div>}
  </article>;
}

export default function DocsApp() {
  const { account, logout } = useAppAuth();
  const initialHash = window.location.hash.replace("#", "");
  const initialArticle = ARTICLES.find(item => item.id === initialHash);
  const initialCategory = CATEGORIES.some(item => item.id === initialHash) ? initialHash : initialArticle?.category || "all";
  const [category, setCategory] = useState(initialCategory);
  const [activeId, setActiveId] = useState(initialArticle?.id || "welcome");
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const currentCategory = CATEGORIES.find(item => item.id === category);
  const normalizedQuery = normalize(query.trim());
  const visible = useMemo(() => ARTICLES.filter(article => {
    const inCategory = category === "all" || article.category === category;
    return inCategory && (!normalizedQuery || normalize(articleText(article)).includes(normalizedQuery));
  }), [category, normalizedQuery]);

  const openArticle = (id) => {
    const article = ARTICLES.find(item => item.id === id);
    if (!article) return;
    setCategory(article.category);
    setQuery("");
    setActiveId(id);
    window.history.replaceState(null, "", `#${id}`);
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  useEffect(() => {
    const shortcut = (event) => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        event.preventDefault(); searchRef.current?.focus();
      }
      if (event.key === "Escape" && query) { setQuery(""); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [query]);

  useEffect(() => {
    const followHash = () => {
      const id = window.location.hash.replace("#", "");
      const article = ARTICLES.find(item => item.id === id);
      if (!article) return;
      setCategory(article.category);
      setQuery("");
      setActiveId(article.id);
      window.requestAnimationFrame(() => document.getElementById(article.id)?.scrollIntoView({ block: "start" }));
    };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  return <div className="docs-app">
    <aside className="docs-sidebar">
      <a className="docs-brand" href="/#home"><span><Icon name="scan" size={25}/></span><div><strong>BrainHem Docs</strong><small>Hướng dẫn sử dụng</small></div></a>
      <nav aria-label="Chủ đề hướng dẫn">
        <button className={category === "all" ? "active" : ""} onClick={() => { setCategory("all"); setQuery(""); setActiveId("welcome"); }}><Icon name="layout" size={17}/>Tất cả hướng dẫn</button>
        {CATEGORIES.map(item => <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => { setCategory(item.id); setQuery(""); setActiveId("welcome"); window.history.replaceState(null, "", `#${item.id}`); }}><Icon name={item.icon} size={17}/>{item.label}</button>)}
      </nav>
      <div className="docs-sidebar-help"><Icon name="shield" size={18}/><p><strong>Cần hỗ trợ?</strong><span>Ghi lại mã ca, thời điểm và ảnh chụp màn hình khi báo lỗi.</span></p></div>
      <a className="docs-back" href="/#home"><Icon name="chevron" size={14}/>Về ứng dụng</a>
    </aside>

    <main className="docs-main">
      <header className="docs-topbar">
        <label><Icon name="search" size={19}/><input ref={searchRef} value={query} onChange={event => { setQuery(event.target.value); if (event.target.value) setCategory("all"); }} placeholder="Tìm cách làm hoặc lỗi gặp phải…" aria-label="Tìm trong hướng dẫn"/>{query && <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><Icon name="close" size={15}/></button>}<kbd>/</kbd></label>
        <div><span>{account.username} · {account.role}</span><button type="button" onClick={logout}>Đăng xuất</button><a href="/#clinical">Clinical</a><a href="/model-studio">Model Studio</a><a href="/feedback">Gửi phản hồi</a></div>
      </header>

      <div className="docs-layout">
        <div className="docs-content">
          {!query && activeId === "welcome" && category === "all" && <section className="docs-welcome">
            <span className="docs-eyebrow">TRUNG TÂM HƯỚNG DẪN</span>
            <h1>Bạn muốn làm gì?</h1>
            <p>Chọn một công việc bên dưới hoặc mô tả vấn đề trong ô tìm kiếm. Hướng dẫn được viết theo từng bước, không yêu cầu kiến thức kỹ thuật.</p>
            <div className="docs-quick-grid">{QUICK_TASKS.map(([label, id, icon]) => <button type="button" key={id} onClick={() => openArticle(id)}><span><Icon name={icon} size={21}/></span><strong>{label}</strong><Icon name="chevron" size={15}/></button>)}</div>
            <div className="docs-start-path"><div><b>1</b><span><strong>Nhận ca</strong><small>Dashboard / CT</small></span></div><i>→</i><div><b>2</b><span><strong>Đọc ảnh</strong><small>Clinical</small></span></div><i>→</i><div><b>3</b><span><strong>Kiểm tra AI</strong><small>Đối chiếu ảnh gốc</small></span></div><i>→</i><div><b>4</b><span><strong>Phản hồi</strong><small>Duyệt / Fine-tune</small></span></div></div>
          </section>}

          {query && <section className="docs-results-head"><span className="docs-eyebrow">KẾT QUẢ TÌM KIẾM</span><h1>{visible.length ? `${visible.length} hướng dẫn phù hợp` : "Chưa tìm thấy hướng dẫn"}</h1><p>{visible.length ? <>Kết quả cho “<strong>{query}</strong>”. Chọn bài phù hợp để xem đầy đủ.</> : <>Thử từ ngắn hơn như “AI”, “thước”, “training”, “Dice” hoặc “CT”.</>}</p></section>}

          {!query && activeId === "welcome" && category !== "all" && <section className="docs-results-head"><span className="docs-eyebrow">CHỦ ĐỀ</span><h1>{currentCategory?.label}</h1><p>{visible.length} hướng dẫn từng bước dành cho khu vực này.</p></section>}

          {(query || category !== "all" || activeId !== "welcome") && (activeId !== "welcome" && !query
            ? <Article article={ARTICLES.find(item => item.id === activeId) || visible[0]}/>
            : <div className="docs-result-list">{visible.map(article => <button key={article.id} onClick={() => openArticle(article.id)}><span><Icon name={CATEGORIES.find(item => item.id === article.category)?.icon || "file"} size={19}/></span><div><small>{CATEGORIES.find(item => item.id === article.category)?.label} · {article.time}</small><h2>{article.title}</h2><p>{article.summary}</p></div><Icon name="chevron" size={17}/></button>)}</div>)}
        </div>

        <aside className="docs-toc">
          <strong>Trong chủ đề này</strong>
          {(category === "all" ? ARTICLES : ARTICLES.filter(item => item.category === category)).map(article => <button className={activeId === article.id ? "active" : ""} key={article.id} onClick={() => openArticle(article.id)}>{article.title}</button>)}
          <div><Icon name="help" size={18}/><p><b>Tìm nhanh</b><span>Nhấn phím <kbd>/</kbd> để mở tìm kiếm, <kbd>Esc</kbd> để xóa.</span></p></div>
        </aside>
      </div>
    </main>
  </div>;
}
