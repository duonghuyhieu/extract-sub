"""Playwright-driven Douyin profile scraper.

Spins up a Chromium window pointed at a creator's profile, waits for the
session to be ready (so the user can log in once), and runs the same JS
that the manual userscript does — but returns the result directly to the
job worker instead of triggering a browser download.

Why a separate browser profile? Two reasons:

1. Cookies persist across runs (you log in once, stay logged in).
2. We don't poke at the user's main Chrome profile, which is locked
   while their browser is open and would be a privacy footgun anyway.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit, urlunsplit

from core.config import BASE_DIR, OUTPUT_DIR


# Persistent Chromium user-data dir — one per machine, kept out of git.
PROFILE_DIR = BASE_DIR / ".douyin_browser_profile"


# Patched into the page before any Douyin script runs. Without this, the
# `aweme/post` endpoint short-circuits to one page and `has_more=false`
# the second it sees `navigator.webdriver=true`. The other tweaks make a
# fresh Chromium look like a returning visitor instead of a clean install.
_STEALTH_INIT = r"""
// Hide the automation flag.
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Chrome plugin/mime arrays are empty under Playwright; fake a couple
// so fingerprint heuristics don't flag a "headless" browser.
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
});
Object.defineProperty(navigator, 'languages', {
  get: () => ['vi-VN', 'vi', 'en-US', 'en'],
});

// `navigator.permissions.query({name: 'notifications'})` returns prompt
// in real Chrome but denied under headless — match real Chrome.
const _origQuery = window.navigator.permissions && window.navigator.permissions.query;
if (_origQuery) {
  window.navigator.permissions.query = (p) => (
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _origQuery.call(window.navigator.permissions, p)
  );
}
"""


# JS executed inside the Douyin tab. Mirror of the userscript at
# static/js/douyin-userscript.js, except it *returns* the list to Python
# instead of triggering a file download.
_FETCH_JS = r"""
async () => {
  const sec = location.pathname.replace('/user/', '');
  if (!location.pathname.startsWith('/user/') || !sec) {
    throw new Error("Not on a /user/ profile page");
  }
  const HEADERS = {
    accept: "application/json, text/plain, */*",
    "accept-language": "vi",
    "user-agent": navigator.userAgent,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fetchPage = async (cursor) => {
    const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/post/");
    Object.entries({
      device_platform: "webapp", aid: "6383", channel: "channel_pc_web",
      sec_user_id: sec, max_cursor: cursor, count: "20",
      version_code: "170400", version_name: "17.4.0",
    }).forEach(([k, v]) => url.searchParams.append(k, v));
    const r = await fetch(url, {
      headers: { ...HEADERS, referrer: location.href },
      credentials: "include",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };

  const extract = (v) => {
    if (!v) return null;
    const md = {
      id: v.aweme_id || "",
      desc: v.desc || "",
      title: v.desc || "",
      createTime: v.create_time ? new Date(v.create_time * 1000).toISOString() : "",
      videoUrl: "", audioUrl: "", coverUrl: "",
    };
    const vid = v.video || {};
    let u = vid.play_addr?.url_list?.[0] || vid.download_addr?.url_list?.[0] || "";
    if (u && !u.startsWith("https")) u = u.replace("http", "https");
    md.videoUrl  = u;
    md.audioUrl  = v.music?.play_url?.url_list?.[0] || "";
    md.coverUrl  = vid.cover?.url_list?.[0] || v.cover?.url_list?.[0] || "";
    return md.videoUrl ? md : null;
  };

  const all = [];
  let cursor = 0, hasMore = true, page = 0;
  while (hasMore) {
    page++;
    let data;
    for (let i = 1; i <= 5; i++) {
      try { data = await fetchPage(cursor); break; }
      catch (e) { if (i === 5) throw e; await sleep(2000); }
    }
    const list = (data.aweme_list || []).map(extract).filter(Boolean);
    all.push(...list);
    hasMore = !!data.has_more;
    cursor = data.max_cursor;
    // Surface progress to Python via a custom event the host can read
    // through a console message (Playwright captures these).
    console.log(`[douyin-fetch] page=${page} got=${list.length} total=${all.length} hasMore=${hasMore}`);
    await sleep(1000);
  }
  all.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return all;
}
"""


def is_available() -> bool:
    """True iff Playwright is importable. Doesn't verify that the browser
    binaries are installed — that surfaces as a launch error later."""
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def _clean_user_url(url: str) -> str:
    """Drop the query string from a profile URL so that Douyin doesn't open
    a video overlay (`?vid=…`) on top of the profile, which sometimes
    interferes with the `[data-e2e=user-tab-count]` selector."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def auto_fetch(
    user_url: str,
    *,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    login_grace_s: int = 600,
    fetch_grace_s: int = 90,
) -> list[dict]:
    """Open Chromium pointed at ``user_url`` and let the user log in / pass
    any verification challenges first. We inject a "Bắt đầu cào" banner into
    the page; the fetch script only runs after the user clicks it. ``best``
    keeps the largest result across retries within ``fetch_grace_s`` so a
    flaky first call doesn't lose data.
    """
    from playwright.sync_api import sync_playwright

    def report(pct: float, msg: str) -> None:
        if progress_cb:
            progress_cb(pct, msg)

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    clean_url = _clean_user_url(user_url)

    report(2.0, "Launching Chromium…")
    with sync_playwright() as p:
        try:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE_DIR),
                headless=False,
                viewport={"width": 1280, "height": 800},
                # A real Chrome UA — Playwright's default contains "HeadlessChrome"
                # in some builds, which Douyin's fingerprint treats as a bot.
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                args=[
                    "--no-default-browser-check",
                    "--no-first-run",
                    # Drop the "Chrome is being controlled by automated test
                    # software" banner *and* the AutomationControlled blink
                    # feature, which is what scripts use to sniff Playwright.
                    "--disable-blink-features=AutomationControlled",
                ],
            )
        except Exception as e:
            raise RuntimeError(
                "Could not launch Chromium. Run "
                "`.venv/Scripts/python -m playwright install chromium` "
                f"(or `playwright install chromium`). Error: {e}"
            ) from e

        # Apply the stealth patches *before* the first navigation so they
        # take effect on document_start of the very first request.
        ctx.add_init_script(_STEALTH_INIT)

        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            # Capture the script's per-page progress lines for our own UI.
            def on_console(msg) -> None:
                txt = msg.text or ""
                if txt.startswith("[douyin-fetch]"):
                    # Extract counts from `[douyin-fetch] page=3 got=20 total=60 hasMore=true`
                    parts = dict(p.split("=", 1) for p in txt.split() if "=" in p)
                    total = parts.get("total", "?")
                    page_n = parts.get("page", "?")
                    report(min(85.0, 30.0 + int(parts.get("page", 1)) * 2.5),
                           f"Fetched {total} videos (page {page_n})…")
            page.on("console", on_console)

            # Go straight to the profile. The cookie warm-up that used to
            # live here was only needed when we ran the fetch immediately;
            # now that we wait for the user's "Bắt đầu cào" click, they
            # have plenty of time to load Douyin, log in, and let cookies
            # settle on their own — an extra hop to the homepage just
            # delays them.
            report(8.0, f"Opening {clean_url}")
            page.goto(clean_url, wait_until="domcontentloaded", timeout=60_000)

            # Wait for the user to confirm they're past any login / CAPTCHA /
            # security check. We keep re-injecting the banner because Douyin
            # is an SPA and the click handler / DOM nodes get blown away on
            # internal navigation.
            report(15.0,
                   "Hãy đăng nhập / qua xác thực, rồi bấm 'Bắt đầu cào' "
                   "trong cửa sổ Chromium.")
            _wait_for_user_ready(page, login_grace_s, report)

            # Now we're on the profile (or wherever the user said is fine).
            # Re-clean the URL in case they navigated; this only affects
            # the `expected` lookup, the JS reads `location` itself.
            page.wait_for_timeout(800)

            expected = _read_expected_count(page)
            if expected:
                report(40.0, f"Profile shows {expected} videos. Fetching…")
            else:
                report(40.0, "Could not read total count — fetching anyway.")

            deadline = time.monotonic() + fetch_grace_s
            attempt = 0
            best: list[dict] = []
            last_error: str | None = None

            while True:
                attempt += 1
                hint = "Running fetch script…" if attempt == 1 else (
                    f"Got {len(best)}{f'/{expected}' if expected else ''} so far — retrying…"
                )
                report(min(85.0, 45.0 + attempt * 4), hint)

                try:
                    result = page.evaluate(_FETCH_JS)
                except Exception as e:
                    last_error = str(e)
                    result = None

                if isinstance(result, list) and len(result) > len(best):
                    best = result
                    last_error = None

                # No expected count: trust the first non-empty result. The
                # user told us they're ready, so an empty result here means
                # "nothing posted" rather than "not yet authenticated".
                if not expected and best:
                    report(95.0, f"Done — {len(best)} videos")
                    return best

                if expected and len(best) >= expected:
                    report(95.0, f"Done — {len(best)} videos (expected {expected})")
                    return best

                if time.monotonic() > deadline:
                    if best:
                        report(95.0,
                               f"Returning best result: {len(best)} videos "
                               + (f"(expected {expected})" if expected else ""))
                        return best
                    if last_error:
                        raise RuntimeError(
                            f"Fetch failed after {fetch_grace_s}s: {last_error}"
                        )
                    raise RuntimeError(
                        f"Fetch returned 0 videos after {fetch_grace_s}s. "
                        "Make sure you're on a /user/<id> profile and the "
                        "video grid is visible, then try again."
                    )

                page.wait_for_timeout(4_000)
        finally:
            try:
                ctx.close()
            except Exception:
                pass


_BANNER_JS = r"""
() => {
  // Re-inject only if the banner is missing (SPA navigation drops it).
  if (document.getElementById('__dy_helper_banner')) return false;
  if (!document.body) return false;

  const b = document.createElement('div');
  b.id = '__dy_helper_banner';
  b.style.cssText = [
    'position:fixed','top:14px','left:50%','transform:translateX(-50%)',
    'z-index:2147483647','background:#fe2c55','color:#fff',
    'padding:12px 18px','border-radius:10px',
    'box-shadow:0 6px 24px rgba(0,0,0,.35)',
    'font:600 13.5px system-ui,-apple-system,Segoe UI,Roboto',
    'display:flex','gap:14px','align-items:center','max-width:90vw'
  ].join(';');
  b.innerHTML = `
    <span id="__dy_msg" style="font-weight:500;">
      ① Đăng nhập / qua xác thực · ② Khi thấy danh sách video, bấm:
    </span>
    <button id="__dy_start" style="
      background:#fff;color:#fe2c55;border:0;padding:8px 18px;
      border-radius:6px;font:700 13px system-ui;cursor:pointer;
      box-shadow:0 2px 6px rgba(0,0,0,.15);">
      Bắt đầu cào
    </button>
    <button id="__dy_close" style="
      background:transparent;border:0;color:#ffd;font:700 16px system-ui;
      cursor:pointer;padding:0 4px;line-height:1;">×</button>
  `;
  document.body.appendChild(b);

  const start = b.querySelector('#__dy_start');
  const close = b.querySelector('#__dy_close');
  const msg   = b.querySelector('#__dy_msg');

  start.onclick = () => {
    // Set flag the Python side polls for. window-scoped so it resets
    // automatically on hard navigation.
    window.__dyUserReady = true;
    msg.textContent = 'OK — đang cào video, đừng đóng cửa sổ này…';
    start.remove();
    close.remove();
  };
  close.onclick = () => b.remove();
  return true;
}
"""


def _wait_for_user_ready(page, timeout_s: int, report) -> None:
    """Poll the page until ``window.__dyUserReady`` is true, re-injecting the
    helper banner whenever the SPA wipes the DOM. Raises RuntimeError on
    timeout."""
    deadline = time.monotonic() + timeout_s
    last_progress_msg = ""
    poll_idx = 0

    while True:
        # Make sure the banner is on screen (and the click flag is reachable
        # from this page context — it lives on `window`, so navigation
        # nukes it; that's fine, the user can click again).
        try:
            page.evaluate(_BANNER_JS)
        except Exception:
            # If the page is mid-navigation, evaluate can throw. Skip and
            # retry next tick.
            pass

        try:
            ready = page.evaluate("() => !!window.__dyUserReady")
        except Exception:
            ready = False

        if ready:
            return

        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Timed out after {timeout_s}s waiting for the 'Bắt đầu cào' "
                "click. Reopen Auto fetch when you're ready."
            )

        # Light progress wiggle so the UI feels alive while we're idle.
        poll_idx += 1
        new_msg = ("Đang đợi bạn xác thực và bấm 'Bắt đầu cào'…"
                   if poll_idx % 4 != 0 else
                   f"Vẫn đợi — {int(deadline - time.monotonic())}s còn lại.")
        if new_msg != last_progress_msg:
            report(15.0 + (poll_idx % 8), new_msg)
            last_progress_msg = new_msg

        page.wait_for_timeout(800)


def _read_expected_count(page) -> Optional[int]:
    """Pull the '作品 N' badge from the profile so we know when fetching is
    actually complete. Returns None if the badge isn't there yet (page still
    loading, login wall, hidden by translations, etc.) — caller should fall
    back to a best-effort heuristic in that case."""
    js = """
        () => {
          // The userscript pins itself next to this badge; it's the most
          // stable selector Douyin exposes.
          const a = document.querySelector('[data-e2e="user-tab-count"]');
          if (a) return a.textContent || '';
          // Fallbacks for slightly older / translated profile layouts.
          const counters = Array.from(document.querySelectorAll(
            '[class*="count"], [class*="Count"], [data-e2e*="count"]'
          ));
          for (const el of counters) {
            const t = (el.textContent || '').trim();
            if (/^\\d{1,5}$/.test(t)) return t;
          }
          return '';
        }
    """
    # Try a few times — the badge usually appears within 1-2s of nav.
    for _ in range(10):
        try:
            text = page.evaluate(js)
        except Exception:
            text = ""
        if text:
            m = re.search(r"\d+", text)
            if m:
                try:
                    return int(m.group())
                except ValueError:
                    pass
        page.wait_for_timeout(500)
    return None


def write_result_file(job_id: str, videos: list[dict]) -> Path:
    """Persist a fetch result so the standard job preview endpoint can serve
    it back to the frontend."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"douyin-fetch-{job_id}.json"
    path.write_text(json.dumps(videos, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
