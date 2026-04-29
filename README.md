# Local Media Toolkit

Bộ công cụ xử lý video / audio chạy **100% trên máy bạn**, không cần internet (sau lần cài đầu), không cần API key.

Hiện tại có 2 tính năng:

| Feature | Mục đích | Output |
|---|---|---|
| **Hardcoded Subtitle** (Vision OCR) | Trích phụ đề "cháy" trong video bằng OCR từng frame | `.srt` |
| **Speech to Text** | Tách lời thoại từ audio/video bằng Whisper | `.srt` / `.vtt` / `.txt` / `.json` |
| **Video Downloader** | Tải video từ YouTube channel / playlist / single video qua yt-dlp | `.mp4` / `.m4a` |

---

## 1. Cài 1 lần duy nhất

Yêu cầu: **Python 3.10** (đã cài sẵn trên máy).

Mở **PowerShell** (hoặc Terminal) trong thư mục `d:\WorkSpace\extract-sub` rồi chạy:

```powershell
python -m pip install --user uv
python -m uv sync
```

Lệnh thứ 2 sẽ tải dependencies (~500MB lần đầu, gồm cả faster-whisper). Models OCR/Whisper được tải về lazily lúc chạy lần đầu (~200MB OCR + 75MB–1.5GB Whisper tùy size).

---

## 2. Chạy

**Cách nhanh nhất:** double-click file **`run.bat`**.

Hoặc chạy tay:

```powershell
python -m uv run python app.py
```

Khi thấy dòng `Uvicorn running on http://127.0.0.1:8000` → mở link đó trong trình duyệt.

Tắt: quay lại terminal, bấm **Ctrl + C**.

---

## 3. Cách dùng

### Tab 1 — Hardcoded Subtitle (Vision OCR)

1. **Kéo thả video** vào drop zone (MP4, MKV, MOV, AVI, WEBM…).
2. **Chọn cấu hình**:
   - **Language**: `Chinese & English`, `English`, `Japanese`, `Korean`, `Latin`… (có ~16 ngôn ngữ).
   - **Engine**: `Accurate` (PP-OCRv5 server) hoặc `Fast` (mobile).
   - **Device**: `CPU` mặc định, hoặc `GPU (DirectML)` nếu đã cài (xem mục 5).
3. **Kéo khung vàng** quanh vùng phụ đề trên video. Dùng thanh thời gian để tìm frame có phụ đề dễ nhìn.
4. Bấm **Extract Subtitles** → đợi progress → bấm **Download** ở queue.

### Tab 2 — Speech to Text

1. **Kéo thả audio hoặc video** vào drop zone (MP3, WAV, M4A, FLAC, MP4… — bất cứ thứ gì ffmpeg đọc được).
2. **Chọn cấu hình**:
   - **Model**: `large-v3-turbo` (mặc định, nhanh + chuẩn) → `large-v3` (chuẩn nhất, chậm) → `medium / small / base / tiny` (nhỏ hơn, nhanh hơn).
   - **Language**: `Auto-detect` hoặc chọn cụ thể (Vietnamese, English, Chinese, Japanese, Korean… 20 ngôn ngữ phổ biến). Whisper hỗ trợ ~99 ngôn ngữ — nếu cần ngôn ngữ ngoài list, đổi `WHISPER_LANGUAGES` trong `features/speech_to_text/processor.py`.
   - **Task**: `Transcribe` (giữ nguyên ngôn ngữ gốc) hoặc `Translate to English` (dịch sang tiếng Anh — Whisper làm được trực tiếp).
   - **Device**: `Auto` mặc định (dùng CUDA nếu có, fallback CPU).
   - **Precision**: `Auto` (int8 trên CPU, float16 trên GPU).
   - **Output format**: `SRT` / `VTT` / `TXT` / `JSON`.
   - **Advanced**: VAD filter (lọc đoạn im lặng), word timestamps, beam size, initial prompt (gợi ý ngữ cảnh / tên riêng).
3. Bấm **Start Transcription** → đợi → **Download**.

### Tab 3 — Video Downloader

1. **Vào tab Video Downloader** ở sidebar.
2. (Lần đầu) bấm **Settings** để cấu hình:
   - **Save to**: thư mục lưu trên máy (mặc định `Downloads/MediaToolkit/`).
   - **Quality**: `720p` / `480p` / `360p` (single MP4, không cần ffmpeg) hoặc `1080p` / `Best` (cần ffmpeg để merge video+audio) hoặc `Audio only`.
   - **Concurrent downloads**: 1–6 (mặc định 2).
   - **Filename template**: yt-dlp template, mặc định `%(title)s.%(ext)s`.
   - Bấm **Save settings**.
3. **Paste URL** YouTube vào ô — channel `https://www.youtube.com/@channelName`, playlist `…/playlist?list=…`, hay video đơn `…/watch?v=…`.
4. Bấm **Scan** → app gọi yt-dlp scan toàn bộ video trong URL (kênh lớn ~10–30s).
5. **Tích chọn** video muốn tải (mặc định check tất cả) → bấm **Download N videos**.
6. Mỗi video sẽ thành 1 job riêng trong **Queue**, hiện progress %, tốc độ MB/s, ETA. Khi xong status hiện đường dẫn file đã lưu.

### Queue chung

Mọi job từ cả 3 tính năng đều xuất hiện ở panel **Queue** dưới cùng, có badge phân biệt (OCR / STT / DL). Vision và STT có nút **Download** để tải file output về browser; Download job chỉ hiện đường dẫn file đã lưu trên máy (file đã ở đó rồi). Bấm **✕** để xoá khỏi queue.

---

## 4. Tinh chỉnh chất lượng

### Vision OCR
- **Phụ đề chưa chuẩn?** Tăng **Sample rate** lên `3–4 fps` — lấy nhiều frame hơn (chậm hơn).
- **Vẫn sai?** Đổi Engine sang **Accurate**.
- **Chậm quá?** Giảm Sample rate xuống `1.5 fps`, hoặc bật GPU (mục 5).
- Thu nhỏ khung vàng chỉ bao đúng dòng phụ đề, đừng để thừa nền — text rác sẽ ít hơn.

### Speech to Text
- **Sai từ chuyên ngành / tên riêng?** Điền **Initial prompt** ở Advanced ("The speakers discuss AI safety. Names: Alice, Bob.") — Whisper sẽ ưu tiên các từ đó.
- **Có nhiều đoạn im lặng?** Bật **VAD filter** (mặc định đã bật).
- **Nhanh hơn?** Đổi sang `medium` hoặc `small`. `large-v3-turbo` đã nhanh hơn `large-v3` ~4 lần với chất lượng gần tương đương.
- **Cần per-word timing?** Bật **Word timestamps** + chọn output **JSON**.

### Video Downloader
- **Muốn 1080p / 4K?** Cài **ffmpeg** vào PATH (xem mục 5.3 dưới), rồi đổi Quality sang `1080p` hoặc `Best`. Không có ffmpeg thì max ~720p (single stream).
- **Tải nhiều video bị giới hạn rate?** Giảm **Concurrent downloads** xuống 1–2.
- **Channel quá lớn (>500 video)?** Quá trình scan sẽ lâu — đợi hoặc paste URL playlist nhỏ hơn.
- **File trùng tên bị ghi đè?** Đổi `output_template` sang `%(uploader)s/%(title)s [%(id)s].%(ext)s` để có folder per-uploader + ID duy nhất.
- **Lỗi `Sign in to confirm you're not a bot`?** YouTube đang chặn — chờ vài phút rồi thử lại, hoặc giảm Concurrent xuống 1.

---

## 5. Bật GPU (tuỳ chọn)

### AMD / Intel GPU trên Windows (cho Vision OCR)

```powershell
python -m uv sync --extra gpu-directml
```

Restart app → dropdown **Device** trong tab Vision sẽ unlock **"GPU (DirectML)"** → OCR nhanh gấp 5–10 lần.

### NVIDIA GPU (cho Speech to Text)

```powershell
python -m uv sync --extra gpu-cuda
```

Restart app → dropdown **Device** trong tab STT sẽ unlock **"GPU (CUDA)"** → Whisper chạy nhanh ~5–10x trên GPU. Yêu cầu NVIDIA driver mới + CUDA runtime hệ thống. Lưu ý: với clip < 5 phút, CPU int8 thường đã đủ nhanh.

### ffmpeg (cho Video Downloader chất lượng cao)

YouTube ở 1080p+ chỉ stream **video** và **audio** thành 2 file riêng — yt-dlp cần **ffmpeg** để merge lại. Nếu không có ffmpeg, app vẫn dùng được nhưng giới hạn ở 720p (single stream).

Cài ffmpeg trên Windows:
1. Tải static build từ <https://www.gyan.dev/ffmpeg/builds/> (chọn `ffmpeg-release-essentials.zip`).
2. Giải nén ra ví dụ `C:\ffmpeg\`.
3. Thêm `C:\ffmpeg\bin` vào **System PATH** (Settings → System → About → Advanced system settings → Environment Variables → Path → Edit → New).
4. Mở terminal mới, gõ `ffmpeg -version` để kiểm tra. Restart app — chọn quality `1080p` / `Best` sẽ work.

(Hoặc dùng winget: `winget install Gyan.FFmpeg`.)

---

## 6. File output ở đâu?

Sau khi bấm Download → file được lưu vào thư mục **Downloads** mặc định của trình duyệt. Trên server các file output nằm ở `outputs/<job_id>.<ext>`.

Media bạn upload nằm ở `uploads/`. Xoá 2 thư mục bất cứ lúc nào để dọn dẹp — app sẽ tự tạo lại.

---

## 7. Cấu trúc project

```
extract-sub/
├── run.bat              ← Double-click để chạy (Windows)
├── app.py               FastAPI app — compose feature routers
├── core/                Shared infra (jobs queue, upload, capabilities)
│   ├── config.py        Đường dẫn, danh sách định dạng hợp lệ
│   ├── jobs.py          Job dataclass + /api/jobs endpoints
│   └── media.py         /api/upload, /api/media, /api/capabilities
├── features/            Mỗi feature 1 module độc lập
│   ├── vision_ocr/
│   │   ├── processor.py OCR pipeline (OpenCV + RapidOCR PP-OCRv5)
│   │   └── router.py    /api/vision/extract
│   ├── speech_to_text/
│   │   ├── processor.py Whisper pipeline (faster-whisper)
│   │   └── router.py    /api/stt/transcribe, /api/stt/options
│   └── downloader/
│       ├── processor.py yt-dlp scan + download wrappers
│       ├── settings.py  Persisted user settings (downloader_settings.json)
│       └── router.py    /api/download/{settings,scan,start,pick-folder}
├── static/              Frontend
│   ├── index.html       Sidebar + workspace layout
│   ├── style.css
│   └── js/
│       ├── app.js       Bootstrap + nav + capabilities
│       ├── jobs.js      Queue panel + polling
│       ├── drop-zone.js Helper dropzone wiring
│       ├── utils.js     fmtTime, escapeHtml, uploadFile…
│       ├── vision.js    Vision-OCR feature controller
│       ├── stt.js       Speech-to-text feature controller
│       └── downloader.js Video downloader feature controller
├── pyproject.toml       Dependencies (uv)
├── uploads/             Media đã upload
└── outputs/             File output đã extract/transcribe
```

### Thêm feature mới

1. Tạo `features/<tên>/processor.py` (logic xử lý) + `router.py` (FastAPI endpoints, prefix `/api/<tên>`).
2. Tạo job qua `core.jobs.create_job(kind="<tên>")` rồi `run_in_thread(job, worker)`.
3. Trong `app.py` thêm `app.include_router(features.<tên>.router)`.
4. Thêm tab + panel mới trong `static/index.html`, file JS controller riêng trong `static/js/`.
5. Job sẽ tự động xuất hiện trong queue chung — không cần code thêm.

---

## Gặp lỗi?

| Lỗi | Cách xử lý |
|---|---|
| `python: command not found` | Cài Python 3.10 từ <https://python.org> |
| `ModuleNotFoundError: faster_whisper` / `yt_dlp` | Chạy `python -m uv sync` lại |
| Downloader báo `ffmpeg not found` | Cài ffmpeg (mục 5.3) hoặc đổi quality sang 720p/480p |
| `Address already in use` (port 8000) | Tắt app cũ đang chạy, hoặc đổi port trong `app.py` cuối file |
| Whisper model tải lỗi | Đảm bảo có internet lần đầu chạy. Model cache ở `%USERPROFILE%\.cache\huggingface\` |
| OCR text rác | Thu nhỏ khung vàng chỉ bao đúng dòng phụ đề |
| STT chậm khi clip dài | Đổi sang model nhỏ hơn (`small` / `medium`), hoặc bật GPU |
| UI không cập nhật sau khi sửa code | Hard refresh: **Ctrl + Shift + R** |
