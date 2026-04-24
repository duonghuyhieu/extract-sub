# Hướng dẫn chạy Subtitle Extractor

Công cụ trích phụ đề cứng (hardcoded) từ video thành file `.srt`. Chạy **100% trên máy bạn**, không cần internet (sau lần cài đầu), không cần API key.

---

## 1. Cài 1 lần duy nhất

Yêu cầu: **Python 3.10** (đã cài sẵn trên máy).

Mở **PowerShell** (hoặc Terminal) trong thư mục `d:\WorkSpace\extract-sub` rồi chạy:

```powershell
python -m pip install --user uv
```

Xong. (Lần đầu app chạy sẽ tự tải model OCR ~200MB — chỉ tải 1 lần.)

---

## 2. Chạy mỗi khi muốn dùng

**Cách nhanh nhất:** double-click file **`run.bat`**.

Hoặc chạy tay:

```powershell
python -m uv run python app.py
```

Khi thấy dòng `Uvicorn running on http://127.0.0.1:8000` → mở link đó trong trình duyệt.

Muốn tắt: quay lại cửa sổ terminal, bấm **Ctrl + C**.

---

## 3. Cách dùng (4 bước)

1. **Kéo thả video** (MP4, MKV, MOV, AVI, WEBM…) vào trang web — hoặc bấm vào ô để chọn file.
2. **Chọn cấu hình**:
   - **Language**: `Chinese & English` cho phụ đề Trung/Anh, hoặc `English only`.
   - **Engine**: `Accurate` (chất lượng cao, mặc định) hoặc `Fast`.
   - **Device**: `CPU` (mặc định) hoặc `GPU` nếu đã bật (xem mục 5).
3. **Kéo khung vàng** quanh vùng phụ đề trên video:
   - Dùng thanh thời gian phía dưới để tìm frame có phụ đề dễ nhìn.
   - Kéo cạnh/góc của khung vàng để resize.
   - Kéo ở giữa để di chuyển khung.
4. Bấm **Process Video** → đợi progress bar → bấm **Download .srt**.

> Lần đầu tiên bấm Process sẽ hơi lâu (~1 phút) vì tải model OCR. Lần sau chạy bình thường.

---

## 4. Tinh chỉnh chất lượng

- **Phụ đề chưa chuẩn?** Tăng **Sample rate** lên `3–4 fps` — lấy nhiều frame hơn → trung bình tốt hơn (chậm hơn).
- **Vẫn sai?** Đổi Engine sang **Accurate** nếu đang để Fast.
- **Chậm quá?** Giảm Sample rate xuống `1.5 fps`, hoặc bật GPU (mục 5).

---

## 5. Bật GPU (tuỳ chọn — cho máy có AMD / Intel GPU)

Nếu có GPU rời (AMD Radeon hoặc Intel Arc), chạy **1 lần**:

```powershell
python -m uv sync --extra gpu-directml
```

Restart app. Dropdown **Device** sẽ unlock option **"GPU (DirectML)"** → tốc độ OCR nhanh gấp **5-10 lần**. NVIDIA không dùng DirectML — dùng cách khác (liên hệ nếu cần).

---

## 6. File output ở đâu?

Sau khi bấm Download → file `.srt` được lưu vào thư mục **Downloads** mặc định của trình duyệt. Trên server nó nằm ở `outputs/<job_id>.srt`.

Video bạn upload nằm ở `uploads/`. Xoá 2 thư mục này bất cứ lúc nào để dọn dẹp — app sẽ tự tạo lại.

---

## Gặp lỗi?

| Lỗi | Cách xử lý |
|---|---|
| `python: command not found` | Cài Python 3.10 từ <https://python.org> |
| `Address already in use` (port 8000) | Tắt app cũ đang chạy, hoặc đổi cổng trong `app.py` cuối file |
| Model tải lỗi | Đảm bảo có internet lần đầu chạy. Model được cache ở `.venv/Lib/site-packages/rapidocr/models/` |
| OCR trả text rác | Thu nhỏ khung vàng chỉ bao đúng dòng phụ đề, đừng để thừa nền nhiễu |
| UI không cập nhật sau khi chỉnh code | Hard refresh trình duyệt: **Ctrl + Shift + R** |

---

## Cấu trúc project

```
extract-sub/
├── run.bat              ← Double-click để chạy (Windows)
├── app.py               Server FastAPI
├── processor.py         Pipeline OCR (OpenCV + RapidOCR PP-OCRv5)
├── pyproject.toml       Quản lý dependencies (dùng uv)
├── static/              Giao diện web
│   ├── index.html
│   ├── app.js
│   └── style.css
├── uploads/             Video đã upload
└── outputs/             File .srt đã extract
```
