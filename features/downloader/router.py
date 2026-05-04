"""HTTP endpoints for the downloader feature."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, HTTPException

from core.jobs import Job, ProgressCb, create_job, run_in_thread

from . import settings as dl_settings
from .processor import download as do_download
from .processor import scan as do_scan
from .processor import set_concurrency


router = APIRouter(prefix="/api/download", tags=["downloader"])


# ---------- Native folder picker ----------
#
# Pops the OS' real folder dialog (Windows Explorer / macOS Finder / GTK)
# via Tkinter on the machine running the server. Because this app is
# always served at 127.0.0.1, the server's display is the user's display
# — the dialog comes up on the same screen as the browser.

_picker_lock = threading.Lock()  # serialise dialogs — Tk doesn't like concurrent roots


@router.post("/pick-folder")
def pick_folder(payload: dict = Body(default={})):
    """Open the native folder-picker dialog. Blocks until the user picks or
    cancels. Returns ``{"path": "<abs path>"}`` on selection or
    ``{"path": null}`` on cancel.

    Note: only useful when the browser and server are on the same machine
    (the default for this app). If the server is ever moved to another box,
    the dialog will appear on the *server's* display and the user won't see
    it — fall back to typing the path manually in that case.
    """
    initial = (payload.get("initial") or "").strip()

    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        raise HTTPException(
            500,
            "Native folder picker unavailable (tkinter missing). "
            "Type the path manually in the input field instead.",
        )

    initial_dir = initial if initial and Path(initial).is_dir() else str(Path.home())

    with _picker_lock:
        root = tk.Tk()
        try:
            root.withdraw()                       # hide the empty Tk window
            root.attributes("-topmost", True)     # keep dialog above the browser
            try:
                root.update()                     # let attributes take effect
            except Exception:
                pass
            picked = filedialog.askdirectory(
                parent=root,
                initialdir=initial_dir,
                mustexist=False,
                title="Choose download folder",
            )
        finally:
            try:
                root.destroy()
            except Exception:
                pass

    return {"path": picked or None}


# ---------- Settings ----------

@router.get("/settings")
def get_settings():
    cur = dl_settings.load()
    return {
        **cur,
        "format_presets": list(dl_settings.FORMAT_PRESETS.keys()),
    }


@router.post("/settings")
def update_settings(payload: dict = Body(...)):
    try:
        cur = dl_settings.save(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    set_concurrency(cur["concurrent_downloads"])
    return cur


# ---------- Scan ----------

@router.post("/scan")
def scan_url(payload: dict = Body(...)):
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "url is required")
    try:
        result = do_scan(url)
    except Exception as e:  # noqa: BLE001 — surface yt-dlp errors verbatim
        raise HTTPException(400, f"Scan failed: {e}")
    return result


# ---------- Start downloads ----------

@router.post("/start")
def start_downloads(payload: dict = Body(...)):
    """Spawn one job per URL. Concurrency is throttled inside the worker."""
    items = payload.get("items") or []
    if not items:
        raise HTTPException(400, "items must be a non-empty list")

    cur = dl_settings.load()
    set_concurrency(cur["concurrent_downloads"])

    output_dir = Path(payload.get("download_path") or cur["download_path"]).expanduser()
    preset     = payload.get("format_preset") or cur["format_preset"]
    format_spec = dl_settings.resolve_format(preset)
    merge_fmt  = cur.get("merge_output_format", "mp4")
    out_tmpl   = cur.get("output_template", "%(title)s.%(ext)s")

    job_ids: list[str] = []
    for item in items:
        url   = item.get("url")
        title = item.get("title") or url
        if not url:
            continue

        job = create_job(kind="download", display_name=title)
        job.output_format = "video"
        job.retry_endpoint = "/api/download/start"
        job.retry_payload = {"items": [item], "download_path": str(output_dir), "format_preset": preset}

        def make_worker(url: str, title: str):
            def worker(job: Job, progress: ProgressCb) -> None:
                progress(0.0, "Queued…")
                final = do_download(
                    url=url,
                    output_dir=output_dir,
                    format_spec=format_spec,
                    output_template=out_tmpl,
                    merge_output_format=merge_fmt,
                    progress_cb=progress,
                )
                job.output_path = final
                job.message = f"Saved → {final}"
            return worker

        run_in_thread(job, make_worker(url, title))
        job_ids.append(job.id)

    return {"job_ids": job_ids, "count": len(job_ids), "output_dir": str(output_dir)}
