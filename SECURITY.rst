Security và phạm vi public
==========================

Bản source này kèm duy nhất models/baseline_s.onnx. M/L là vị trí mở rộng có
hàm load trả None; không kèm implementation hoặc artifact. Không đưa dữ liệu
bệnh nhân, credential hay source riêng vào repository hoặc issue công khai.
Khi phát hiện lỗi, dùng kênh riêng do chủ sở hữu repository cung cấp. Chưa có
email hoặc URL tiếp nhận security được chủ sở hữu xác nhận.

Mặc định và kiểm soát đã rà soát
------------------------------

* RBAC bật mặc định; không có mật khẩu demo được seed khi chưa cấu hình.
* Credential rỗng không xác thực được. RBAC sử dụng Bearer hoặc session cookie;
  Basic bị từ chối trước khi tính password hash trên API có bảo vệ.
* Login và Basic trong chế độ nghiên cứu tắt RBAC dùng chung giới hạn failed
  authentication theo địa chỉ client của server: tối đa 10 lần trong 60 giây.
  Cơ chế xác thực người duyệt cũ giữ limiter riêng.
* Quota support và feedback dùng địa chỉ client do server cung cấp, không đọc
  trực tiếp X-Forwarded-For từ request để xác định quota.
* Session ứng dụng dùng token ngẫu nhiên, digest lưu trong database, có hạn dùng
  và bị thu hồi khi tài khoản hoặc quyền thay đổi. Cookie HttpOnly, SameSite
  strict; cookie-only write yêu cầu Origin cùng miền. Secure bật khi server
  nhận request HTTPS.
* Dev server và Compose publish port tại loopback. Docker app chạy không phải
  root, bỏ Linux capabilities và đặt no-new-privileges.
* Baseline S loader kiểm SHA-256, giới hạn kích thước file và nạp bytes đã kiểm
  vào ONNX Runtime. Input phải là tensor float32 hữu hạn, cùng shape và nằm
  trong giới hạn của loader. Provider mặc định là CPU.
* Script publication cho phép đúng artifact Baseline S có checksum đã chốt và
  README.md; model khác, dữ liệu, file agent và Markdown nội bộ vẫn bị chặn.
* Chế độ mở rộng model bị từ chối khi bật; policy và cache của bản public chỉ
  dùng giá trị false. Không có thuật toán inference riêng trong vị trí M/L.

Giới hạn bảo mật và triển khai
-----------------------------

Baseline S ONNX là artifact có thể đọc: người tải được graph, toán tử, kích
thước tensor và trọng số. Đổi tên file hoặc node không ngăn suy ra cấu trúc
baseline. Không có cam kết chống trích xuất model hoặc bảo vệ trọng số đã public.
Chủ dự án đã chọn công khai artifact này; bản phát hành giữ nguyên ONNX và ghi
rõ việc người tải có thể đọc hoặc trích xuất cấu trúc và trọng số.
Checksum xác nhận byte được đóng gói; không chứng nhận hiệu quả y khoa, quyền
phân phối, nguồn training data hay việc model không ghi nhớ dữ liệu. Xem
NOTICE và THIRD-PARTY-NOTICES.txt về các quyền chưa xác minh.

Không expose dev server trực tiếp lên Internet. Truy cập từ xa cần HTTPS,
reverse proxy và host/CORS phù hợp. Nếu cần nhận địa chỉ client từ proxy, cấu
hình server chỉ tin proxy đã xác định; không cho client tùy ý đặt địa chỉ đó.
Limiter và quota theo process, có thể reset khi restart và không phải giới hạn
phân tán. Frontend lưu Bearer token trong browser storage; việc bảo vệ khỏi XSS
và kiểm soát extension trình duyệt vẫn cần được duy trì.

Đường lệnh inference/training/release và plugin là cấu hình có quyền thực thi
của người vận hành. Chỉ dùng executable, runtime và artifact đáng tin cậy.
Các integration tùy chọn có hành vi nạp dữ liệu riêng; rà soát này không bao
phủ dịch vụ hoặc model bên ngoài được bổ sung sau. Authentication ứng dụng
không thay thế bảo vệ PACS hoặc mạng DICOM.

Loader Baseline S cung cấp giao diện tensor, chưa xác nhận một pipeline xử lý
CT hoàn chỉnh hoặc preprocessing được kiểm định. Không kiểm nghiệm GPU,
TensorRT, PACS, triển khai Internet hoặc dữ liệu bệnh nhân trong đợt rà soát
này. Docker image chưa được build hoặc quét; CI GitHub chưa được chạy trong
đợt chuẩn bị. Kiểm thử tổng hợp không thay thế pentest hoặc xác nhận lâm sàng.

Quét tự động có phạm vi và thời điểm cụ thể. Cần chạy lại sau khi thay dependency,
đổi artifact hoặc bổ sung tài liệu. Bản này giữ quyền tác giả của nhóm, chưa
cấp license mở; tài liệu bảo mật không chứng nhận đã giải quyết mọi quyền
phân phối của model hoặc dependency.
