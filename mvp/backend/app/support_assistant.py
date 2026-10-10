from __future__ import annotations

import json
import re
import subprocess
import threading
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

import requests


SYSTEM_PROMPT = """Bạn là Trợ lý sử dụng BrainHem dành cho người không chuyên kỹ thuật.

MỤC TIÊU
- Giúp người dùng hoàn thành thao tác thật trên giao diện BrainHem hiện tại.
- Luôn trả lời bằng tiếng Việt dễ hiểu, đi thẳng vào việc, dùng đúng tên nút/menu trên UI.
- Với câu hỏi "làm sao", đưa ra các bước đánh số theo đúng thứ tự và nói rõ kết quả cần thấy.

THỨ TỰ TÌM CÂU TRẢ LỜI
1. Đọc NGỮ CẢNH TÀI LIỆU được cung cấp trong câu hỏi.
2. Nếu tài liệu đã trả lời trực tiếp câu hỏi, trả lời ngay và KHÔNG gọi công cụ chỉ để kiểm tra lại.
3. Đọc TRÍCH ĐOẠN SOURCE LIÊN QUAN nếu backend cung cấp.
4. Chỉ khi cả hai phần trên thực sự thiếu chi tiết, bạn ĐƯỢC PHÉP dùng công cụ chỉ-đọc để xem source trong:
   mvp/frontend/src và mvp/backend/app. Tìm component, nhãn nút, route và hành vi thật.
5. Không suy đoán tên nút hoặc tính năng. Nếu source và tài liệu mâu thuẫn, ưu tiên UI/source hiện tại
   và nói ngắn gọn rằng hướng dẫn có thể cần cập nhật.

GIỚI HẠN BẮT BUỘC
- Chỉ đọc: không sửa/tạo/xóa file, không chạy lệnh shell, không gọi API làm thay đổi dữ liệu,
  không bấm giao diện thay người dùng và không thay đổi cấu hình.
- Không đọc file môi trường, token, khóa, mật khẩu, dữ liệu bệnh nhân hay thư mục ngoài hai vùng source trên.
- Không chẩn đoán, không kết luận lâm sàng và không diễn giải ảnh CT thay bác sĩ.
- Không tiết lộ source dài; chỉ dùng source để xác minh cách dùng.

CÁCH TRẢ LỜI
- Mở đầu bằng câu trả lời trực tiếp, sau đó là các bước ngắn.
- Chỉ dùng văn bản thuần và xuống dòng; không dùng ký hiệu Markdown như **, # hoặc bảng.
- Nêu điều kiện trước khi thao tác nếu có (đúng ca, quyền tài khoản, trạng thái đã lưu).
- Cuối cùng nêu một dấu hiệu xác nhận thao tác đã thành công.
- Dòng cuối bắt buộc là một trong hai marker, không thêm chữ vào dòng đó:
  [[RESOLVED]] nếu đã có hướng dẫn chắc chắn.
  [[UNRESOLVED]] nếu sau khi đọc tài liệu và source vẫn không đủ chắc chắn.
"""


KNOWLEDGE = [
    ("dicom-upload", "Tải DICOM hoặc NIfTI và xem kết quả AI", "Tại Dashboard hoặc Clinical, bấm Tiếp nhận ca CT. Thả thư mục DICOM, file DICOM, ZIP DICOM hoặc một file NIfTI .nii/.nii.gz vào vùng nhận dữ liệu. Kiểm tra mức ưu tiên và bật Tự phân tích AI sau khi nhận ca nếu muốn. Bấm Tiếp nhận và mở ca, chờ hệ thống dựng volume. Nếu chưa bật tự phân tích, bấm Phân tích AI trong ca vừa mở. Khi hoàn tất, bật AI overlay và kiểm tra kết quả trên ảnh gốc trước khi duyệt."),
    ("first-case", "Mở và đọc ca CT đầu tiên", "Tại Dashboard chọn Mở ca hiện có, hoặc mở Clinical từ thanh điều hướng. Tìm và chọn đúng ca, đọc ảnh gốc trước rồi bấm Phân tích AI. Khi hoàn tất bật AI overlay, kiểm tra mọi ổ 3D rồi chọn Duyệt kết quả hoặc Từ chối kèm ghi chú."),
    ("viewer-controls", "Zoom, kéo ảnh và đổi lát", "Đặt con trỏ lên vùng cần xem rồi cuộn để zoom quanh con trỏ. Kéo chuột để di chuyển ảnh. Giữ Ctrl và cuộn để đổi lát. Dùng W/L hoặc preset Brain để chỉnh cửa sổ ảnh."),
    ("measure", "Đo và xóa thước", "Chọn Thước, kéo từ điểm đầu tới điểm cuối. Chọn đoạn thước để kéo hai đầu. Nhấn Delete hoặc Backspace để xóa. Kết quả mm/cm phụ thuộc Pixel Spacing của DICOM."),
    ("ai-review", "Chạy và kiểm tra AI", "Bấm Phân tích AI và chờ hoàn tất. Bật/tắt lớp phủ, điều chỉnh độ trong suốt và kiểm tra tất cả component trên nhiều mặt phẳng. AI chỉ hỗ trợ; phải đối chiếu ảnh gốc trước khi duyệt."),
    ("auto-ai", "Tự động chạy AI cho ca CT", "Mở AI Studio > Tổng quan, đăng nhập tài khoản vận hành rồi tìm thẻ Tự động chạy AI cho mọi ca CT mới. Bật công tắc, chọn Model tự động và bấm Lưu chính sách. Chính sách áp dụng cho CT Simulator, NIfTI upload và study DICOM upload tiếp theo."),
    ("gold-label", "Tạo nhãn Gold (label) cho một ca", "Mở Expert Labeling và chọn đúng ca cần gán nhãn. Dùng Bút, Đường bao hoặc Tẩy trên ảnh chính; mở Duyệt vùng để kiểm tra từng ổ 3D trên axial, coronal và sagittal. Chờ trạng thái Đã lưu, chọn Hoàn tất rồi qua bước duyệt. Chỉ nhãn đã duyệt và QC mới được vào dataset huấn luyện."),
    ("active-learning", "Fine-tune", "Bản public chỉ kèm Baseline S ONNX cho inference. Fine-tune và lịch tự huấn luyện chưa khả dụng vì không cung cấp checkpoint PT/PTH, mã model huấn luyện và training runtime. Có thể tiếp tục gán nhãn và chuẩn bị dữ liệu."),
    ("training-chart", "Biểu đồ train và validation", "Train loss là sai số trên dữ liệu cập nhật trọng số. Validation loss đo dữ liệu không dùng cập nhật. Train loss giảm nhưng validation loss tăng thường là overfit. Luôn xem Dice, Recall và metric theo từng ca."),
    ("postprocess", "Tinh chỉnh postprocess", "Dùng prediction trên development-validation để tìm một threshold và minimum component volume theo mm³ chung. Không cập nhật trọng số, không chọn riêng từng ca và không tune bằng locked test."),
    ("quality-fail", "Quality gate Fail", "Xác định Dice hay Recall chưa đạt, xem theo từng ca, kiểm tra nhãn và split bệnh nhân. Không hạ gate sau khi thấy test. Lỗi mask xử lý ở dữ liệu/training; dương tính giả nhỏ có thể tune postprocess trên validation."),
    ("hardware", "Phần cứng Model Studio", "Vào Model Studio > Hệ thống để xem GPU/VRAM, CPU, RAM, ổ đĩa, nhiệt độ và worker. GPU thấp trong khi CPU cao có thể là nghẽn nạp dữ liệu; VRAM đầy cần giảm batch size."),
    ("ct-simulator", "Gửi ca từ CT Simulator", "Mở Settings > CT Simulator. Chọn ca CT mẫu hoặc file .nii/.nii.gz, nhập Patient ID ẩn danh bắt đầu bằng ANON-, rồi bấm Gửi acquisition từ máy CT. Chờ trạng thái Đã nhận đủ series; nếu đã bật tự động AI, ca sẽ được xếp hàng phân tích."),
    ("ai-slow", "Giao diện chậm sau AI", "Tắt lớp phủ AI hoặc panel không dùng, chờ tác vụ component nền hoàn tất và mở lại ca nếu cần. Không bấm Phân tích AI nhiều lần. Ghi mã ca, số lát, component, trình duyệt và thời điểm nếu lỗi lặp lại."),
    ("auto-ai-failed", "Ca CT không tự chạy AI", "Kiểm tra ca đã vào Dashboard. Trong AI Studio > Tổng quan, xác nhận chính sách tự động đã bật, Model tự động khả dụng và đã bấm Lưu chính sách. Kiểm tra worker Online, sau đó chạy thủ công một lần để phân biệt lỗi chính sách với inference."),
    ("feedback", "Gửi góp ý cho quản trị viên", "Mở trang Gửi phản hồi, không cần đăng nhập. Chọn vai trò, loại góp ý, mô tả vấn đề rồi bấm Gửi góp ý. Không nhập dữ liệu định danh bệnh nhân. Admin chọn Đăng nhập quản trị trên cùng trang để xem toàn bộ feedback nội bộ."),
]


def _normalize(value: str) -> str:
    value = unicodedata.normalize("NFD", value).lower().replace("đ", "d")
    return re.sub(r"[^a-z0-9]+", " ", "".join(c for c in value if unicodedata.category(c) != "Mn")).strip()


def _tokens(value: str) -> set[str]:
    stopwords = {"cach", "the", "nao", "lam", "gi", "tai", "sao", "vi", "o", "dau",
                 "cho", "toi", "ban", "nay", "do", "mot", "cac", "tinh", "nang", "duoc"}
    return {word for word in _normalize(value).split() if len(word) > 1 and word not in stopwords}


def _intent_doc_id(question: str) -> str | None:
    """Resolve only high-confidence UI intents; ambiguous questions still use retrieval."""
    text = _normalize(question)
    words = set(text.split())
    upload_action = bool(words & {"upload", "tai", "nhan", "nhap", "dua", "chon", "gui"})
    medical_file = bool(words & {"dicom", "nifti", "nii", "zip"}) or "thu muc dicom" in text
    if upload_action and medical_file:
        return "dicom-upload"
    if ("thuoc" in words or "do khoang" in text) and bool(words & {"xoa", "do", "keo", "sua", "thuoc"}):
        return "measure"
    if bool(words & {"zoom", "phong", "cuon"}) or "doi lat" in text:
        return "viewer-controls"
    if "quality gate" in text and bool(words & {"fail", "loi", "hong", "truot"}):
        return "quality-fail"
    if bool(words & {"label", "labeling", "annotate", "annotation", "nhan"}) and (
        bool(words & {"tao", "gan", "ve", "sua", "case", "ca", "benh"})
        or "expert labeling" in text
    ):
        return "gold-label"
    return None


class SupportAssistant:
    """Docs-first local assistant. It never executes commands or mutates application data."""

    def __init__(self, data_dir: Path, source_root: Path, hourly_quota: int = 20,
                 local_url: str = "", local_model: str = "", agy_path: str = "",
                 agy_model: str = "gemini-3.8-flash-low") -> None:
        self.data_dir = data_dir / "support"
        self.source_root = source_root.resolve()
        self.hourly_quota = hourly_quota
        self.local_url = local_url
        self.local_model = local_model
        self.agy_path = agy_path
        self.agy_model = agy_model
        self._usage: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def status(self) -> dict:
        inbox = self.data_dir / "unresolved.jsonl"
        count = 0
        if inbox.is_file():
            with inbox.open(encoding="utf-8") as handle:
                count = sum(1 for line in handle if line.strip())
        agy_ready = bool(self.agy_path and self.agy_model and Path(self.agy_path).is_file())
        mode = "agy" if agy_ready else "local-llm" if self.local_url and self.local_model else "local-docs"
        model = self.agy_model if agy_ready else self.local_model or "BrainHem Docs Retrieval"
        return {"mode": mode, "model": model, "read_only": True,
                "hourly_quota": self.hourly_quota, "unresolved_count": count}

    def _consume(self, key: str) -> int:
        now = time.time()
        with self._lock:
            recent = [stamp for stamp in self._usage[key] if now - stamp < 3600]
            if len(recent) >= self.hourly_quota:
                self._usage[key] = recent
                return -1
            recent.append(now)
            self._usage[key] = recent
            return self.hourly_quota - len(recent)

    def _rank_docs(self, question: str) -> list[tuple[int, tuple[str, str, str]]]:
        query = _tokens(question)
        intent = _intent_doc_id(question)
        ranked = []
        for item in KNOWLEDGE:
            title_tokens, body_tokens = _tokens(item[1]), _tokens(item[2])
            score = len(query & body_tokens) + 3 * len(query & title_tokens)
            if intent == item[0]:
                score += 100
            if _normalize(question) in _normalize(f"{item[1]} {item[2]}"):
                score += 6
            ranked.append((score, item))
        return sorted(ranked, key=lambda row: row[0], reverse=True)

    def _source_matches(self, question: str) -> list[dict[str, str]]:
        words = sorted(_tokens(question), key=len, reverse=True)[:6]
        if not words:
            return []
        matches = []
        for base in [self.source_root / "mvp/frontend/src", self.source_root / "mvp/backend/app"]:
            if not base.is_dir():
                continue
            for path in base.rglob("*"):
                if path.is_symlink() or path.suffix not in {".jsx", ".js", ".py"}:
                    continue
                try:
                    resolved = path.resolve()
                    resolved.relative_to(base.resolve())
                    if resolved.stat().st_size > 400_000:
                        continue
                    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                        normalized = _normalize(line)
                        if sum(word in normalized for word in words) >= min(2, len(words)):
                            matches.append({"path": str(path.relative_to(self.source_root)), "line": str(line_number), "text": line.strip()[:240]})
                            if len(matches) == 4:
                                return matches
                except (OSError, UnicodeError, ValueError):
                    continue
        return matches

    def _ask_local_model(self, question: str, context: str) -> str | None:
        if not self.local_url or not self.local_model:
            return None
        try:
            response = requests.post(f"{self.local_url}/api/chat",
                json={"model": self.local_model, "stream": False,
                      "options": {"temperature": 0.1, "num_predict": 380},
                      "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                                   {"role": "user", "content": f"NGỮ CẢNH READ-ONLY:\n{context}\n\nCÂU HỎI: {question}"}]},
                timeout=45)
            response.raise_for_status()
            answer = response.json().get("message", {}).get("content", "").strip()
            return answer[:3000] or None
        except (requests.RequestException, ValueError):
            return None

    def _ask_agy(self, question: str, context: str) -> tuple[str, bool] | None:
        if not self.agy_path or not self.agy_model or not Path(self.agy_path).is_file():
            return None
        prompt = (
            f"{SYSTEM_PROMPT}\n\n"
            "NGỮ CẢNH ĐÃ ĐƯỢC BACKEND TRUY XUẤT (gồm tài liệu và có thể có trích đoạn source):\n"
            f"{context}\n\n"
            f"TRANG HIỆN TẠI: do backend cung cấp riêng trong câu hỏi nếu có.\n"
            f"CÂU HỎI: {question}\n\n"
            "Hãy trả lời theo quy tắc trên. Nếu tài liệu trong ngữ cảnh trả lời trực tiếp thì trả lời ngay, "
            "không gọi công cụ. Chỉ khi ngữ cảnh thật sự thiếu mới đọc source bằng công cụ chỉ-đọc "
            "trong đúng hai thư mục được phép trước khi kết luận [[UNRESOLVED]]."
        )
        command = [self.agy_path, "--sandbox", "--disable-slash-commands", "--model", self.agy_model,
                   "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "35s"]
        request = json.dumps({"event": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": prompt}
        ]}}, ensure_ascii=False) + "\n"
        try:
            completed = subprocess.run(command, cwd=self.source_root, input=request, capture_output=True, text=True,
                                       timeout=40, check=False)
            if completed.returncode != 0:
                return None
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            results = [event["result"] for event in events if event.get("event") == "result" and isinstance(event.get("result"), dict)]
            if not results or results[-1].get("status") != "SUCCESS":
                return None
            answer = str(results[-1].get("response", "")).strip()
            if not answer:
                return None
            resolved = "[[UNRESOLVED]]" not in answer
            answer = answer.replace("[[RESOLVED]]", "").replace("[[UNRESOLVED]]", "").strip()
            return (answer[:3000], resolved)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None

    def _ask_model(self, question: str, context: str) -> tuple[str, bool] | None:
        agy_answer = self._ask_agy(question, context)
        if agy_answer:
            return agy_answer
        local_answer = self._ask_local_model(question, context)
        return (local_answer, True) if local_answer else None

    def _escalate(self, question: str, page: str, session_id: str) -> None:
        record = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "question": question, "page": page, "session": session_id[-12:], "status": "new"}
        with self._lock:
            with (self.data_dir / "unresolved.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def answer(self, question: str, session_id: str, page: str, client_key: str) -> dict:
        # The server-side client bucket prevents bypassing the quota by rotating session IDs.
        remaining = self._consume(client_key)
        if remaining < 0:
            return {"answer": "Bạn đã dùng hết quota hỗ trợ trong giờ này. Hãy thử lại sau; giới hạn này giúp bot local không chiếm tài nguyên đọc ảnh và training.",
                    "resolved": False, "source": "quota", "references": [], "quota_remaining": 0, "escalated": False}
        ranked = self._rank_docs(question)
        best_score, best = ranked[0]
        intent = _intent_doc_id(question)
        if intent:
            related = [item for _, item in ranked if item[0] == intent]
        else:
            related = [item for score, item in ranked[:3] if score > 0]
        context = "\n".join(f"[{item[0]}] {item[1]}: {item[2]}" for item in related)
        if not context:
            context = "Không có bài tài liệu nào khớp rõ; hãy kiểm tra source chỉ-đọc."
        source_matches = self._source_matches(question)
        if source_matches:
            excerpts = "\n".join(
                f"{match['path']}:{match['line']} {match['text']}" for match in source_matches
            )
            context += f"\n\nTRÍCH ĐOẠN SOURCE LIÊN QUAN (chỉ đọc):\n{excerpts}"

        # When AGY is configured every question goes through the agent. Retrieval only
        # supplies likely documentation; it no longer gates whether the agent may answer.
        generated = self._ask_model(f"{question}\nTrang người dùng đang đứng: {page}", context)
        if generated:
            answer, resolved = generated
            if resolved:
                return {"answer": answer, "resolved": True,
                        "source": "agy" if self.agy_path else "local-llm",
                        "references": [{"title": item[1], "href": f"/guide#{item[0]}"} for item in related],
                        "quota_remaining": remaining, "escalated": False}
            self._escalate(question, page, session_id)
            return {"answer": answer or "Mình chưa tìm thấy hướng dẫn đủ chắc chắn sau khi đọc tài liệu và source.",
                    "resolved": False, "source": "agy", "references": [],
                    "quota_remaining": remaining, "escalated": True}

        # Safe fallback for installations that intentionally run without an agent.
        confident_intent = _intent_doc_id(question) == best[0]
        if confident_intent or best_score >= 8:
            return {"answer": f"Bạn làm theo các bước này:\n\n{best[2]}", "resolved": True,
                    "source": "docs", "references": [{"title": best[1], "href": f"/guide#{best[0]}"}],
                    "quota_remaining": remaining, "escalated": False}
        self._escalate(question, page, session_id)
        return {"answer": "Mình chưa tìm thấy câu trả lời đủ chắc chắn trong tài liệu hoặc phần source được phép đọc. Mình đã ghi câu hỏi này vào hộp thư quản trị để bạn được bổ sung hướng dẫn sau.",
                "resolved": False, "source": "unresolved", "references": [],
                "quota_remaining": remaining, "escalated": True}
