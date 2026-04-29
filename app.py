"""FastAPI app — composes feature routers + shared core endpoints.

Adding a new feature is now: create features/<name>/{router.py, processor.py},
then `app.include_router(features.<name>.router)` below. Job plumbing,
upload, capabilities, etc. live in `core/` and are reused.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from core import jobs, media
from core.config import STATIC_DIR
from features import douyin, downloader, speech_to_text, vision_ocr

app = FastAPI(title="Local Media Toolkit")


@app.middleware("http")
async def no_cache_for_static(request: Request, call_next):
    """Stop the browser from caching the HTML/JS/CSS — this is a local dev
    app, the payload is tiny, and stale cached assets after a code change
    are a recurring source of confusion ("I refreshed but nothing changed").
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css", ".mjs")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Order matters only for matching specificity, not behaviour — every router
# uses a unique prefix.
app.include_router(media.router)
app.include_router(jobs.router)
app.include_router(vision_ocr.router)
app.include_router(speech_to_text.router)
app.include_router(downloader.router)
app.include_router(douyin.router)

# Static frontend last so /api/* never gets shadowed.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
