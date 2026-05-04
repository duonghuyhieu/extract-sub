// Polls /api/jobs and renders the dedicated Tasks panel.
//
// The panel is its own feature tab now (see `data-panel="tasks"`), so this
// module is also responsible for the small badge on the sidebar nav item
// — that's how the user knows something is running while they're on a
// different tab.
import { $, $$, escapeHtml } from "./utils.js";

const list         = $("#jobs-list");
const summary      = $("#jobs-summary");
const empty        = $("#jobs-empty");
const navBadge     = $("#nav-tasks-badge");
const filterRow    = $(".task-filters");
const bulkRow      = $(".task-bulk");
const toastStack   = $("#toast-stack");
const notifyBtn    = $("#tasks-notify-toggle");
const notifyLabel  = $("#tasks-notify-label");
const countEls  = {
  all:    $("[data-count='all']"),
  active: $("[data-count='active']"),
  done:   $("[data-count='done']"),
  error:  $("[data-count='error']"),
};

let pollTimer = null;
let currentFilter = "all";

// Tracks the previous status of every job we've seen so we can detect
// transitions (running/pending → done/error) and announce just those, not
// every poll tick. Survives across renders, never persists to disk.
const lastStatus = new Map();
// First poll after page load is "discovery" — we don't want to fire 12
// notifications because the user just opened the app and there were
// already some old finished jobs sitting in the registry.
let firstPoll = true;

const KIND_LABEL = {
  vision:           "OCR",
  stt:              "STT",
  download:         "DL",
  "douyin-fetch":   "FETCH",
  "logo-stamp":     "LOGO",
};

const TEXT_FORMATS = new Set(["srt", "vtt", "txt", "json"]);

function statusBucket(job) {
  // Treat pending + running as "active" — they're both "doing something".
  if (job.status === "running" || job.status === "pending") return "active";
  if (job.status === "done") return "done";
  if (job.status === "error") return "error";
  return "active";  // anything weird, surface it as active so it isn't lost
}

export async function pollJobs(immediate = false) {
  if (pollTimer) clearTimeout(pollTimer);
  try {
    const res = await fetch("/api/jobs");
    if (res.ok) {
      const { jobs } = await res.json();
      render(jobs);
      const active = jobs.some((j) => j.status === "pending" || j.status === "running");
      pollTimer = setTimeout(() => pollJobs(), active ? 800 : 4000);
      return;
    }
  } catch {}
  pollTimer = setTimeout(() => pollJobs(), 2000);
}

function render(jobs) {
  jobs = jobs || [];

  // Detect status transitions BEFORE updating UI so the badge changes and
  // the notification fire together.
  detectCompletions(jobs);

  // Counts for the filter pills + the sidebar badge.
  const counts = { all: jobs.length, active: 0, done: 0, error: 0 };
  for (const j of jobs) counts[statusBucket(j)]++;

  for (const [k, el] of Object.entries(countEls)) {
    if (el) el.textContent = counts[k];
  }
  if (navBadge) {
    if (counts.active > 0) {
      navBadge.textContent = counts.active;
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }

  // Top-of-panel summary text.
  summary.textContent = jobs.length
    ? `${jobs.length} total` +
      (counts.active ? ` · ${counts.active} running` : "") +
      (counts.done   ? ` · ${counts.done} done`     : "") +
      (counts.error  ? ` · ${counts.error} error`   : "")
    : "";

  // Apply the current filter.
  const filtered = currentFilter === "all"
    ? jobs
    : jobs.filter((j) => statusBucket(j) === currentFilter);

  // Empty-state messaging — distinct copy for "nothing exists" vs
  // "filter hides everything" so the user doesn't think they broke it.
  if (jobs.length === 0) {
    empty.textContent = "No tasks yet — start one from the other tabs and it'll show up here.";
    empty.classList.remove("hidden");
  } else if (filtered.length === 0) {
    empty.textContent = `No ${currentFilter} tasks. Try a different filter.`;
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  // Diff existing nodes by id to avoid flicker.
  const keep = new Set(filtered.map((j) => j.id));
  for (const li of Array.from(list.children)) {
    if (!keep.has(li.dataset.jobId)) li.remove();
  }
  for (const job of filtered) {
    let li = list.querySelector(`[data-job-id="${job.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.jobId = job.id;
      li.className = "job-card";
      list.prepend(li);
    }
    updateCard(li, job);
  }
}

function updateCard(li, job) {
  li.classList.toggle("done",  job.status === "done");
  li.classList.toggle("error", job.status === "error");

  const isDone     = job.status === "done";
  const isErr      = job.status === "error";
  const isDownload = job.kind === "download";
  const pct        = Math.max(0, Math.min(100, job.progress || 0));

  // For download jobs, the file is already on the user's disk at a path
  // chosen in settings — no point letting them re-download it via the
  // browser. The status text already includes the saved path.
  const status = isErr
    ? `Error: ${job.error || "unknown"}`
    : isDone
      ? (isDownload
          ? (job.message || "Saved.")
          : `${job.segments} segments · ${job.output_format || "srt"} · done`)
      : `${pct.toFixed(0)}% · ${job.message || job.status}`;

  const kindLabel = KIND_LABEL[job.kind] || job.kind || "JOB";

  // Text-format outputs (srt/vtt/txt/json) get an Edit button so the user
  // can fix OCR / STT mistakes before downloading. Binary outputs (download
  // jobs save mp4/mp3 directly) skip both Edit and Download.
  const editable = isDone && !isDownload && TEXT_FORMATS.has(job.output_format);

  li.innerHTML = `
    <span class="kind-badge kind-${escapeHtml(job.kind || "job")}">${escapeHtml(kindLabel)}</span>
    <div class="job-name" title="${escapeHtml(job.display_name)}">${escapeHtml(job.display_name)}</div>
    <div class="job-actions">
      ${editable ? `<button class="btn-sm" data-act="edit" data-id="${job.id}" title="Edit before download">Edit</button>` : ""}
      ${isDone && !isDownload ? `<button class="btn-sm primary" data-act="download" data-id="${job.id}">Download</button>` : ""}
      ${isErr && job.retry_endpoint ? `<button class="btn-sm" data-act="retry" data-id="${job.id}">Retry</button>` : ""}
      <button class="btn-sm" data-act="delete" data-id="${job.id}" title="Remove from list">✕</button>
    </div>
    <div class="job-status" title="${escapeHtml(status)}">${escapeHtml(status)}</div>
    <div class="job-progress"><div class="fill" style="width:${isDone ? 100 : pct}%"></div></div>
  `;
}


// ---------- Filter pills ----------
filterRow?.addEventListener("click", (e) => {
  const btn = e.target.closest(".task-filter");
  if (!btn) return;
  for (const b of $$(".task-filter", filterRow)) b.classList.toggle("active", b === btn);
  currentFilter = btn.dataset.filter;
  pollJobs(true);
});

// ---------- Bulk actions ----------
//
// "Clear done" / "Clear errors" / "Clear all" — each issues one DELETE per
// matching job. The /api/jobs/<id> endpoint already exists and best-effort-
// removes the artefact file. We don't touch running jobs from the bulk
// menu; "Clear all" still leaves them in place since deleting a running
// job can leak threads.

bulkRow?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-bulk]");
  if (!btn) return;
  const which = btn.dataset.bulk;

  let res;
  try {
    res = await fetch("/api/jobs");
    if (!res.ok) return;
  } catch { return; }
  const { jobs } = await res.json();

  const targets = jobs.filter((j) => {
    const s = statusBucket(j);
    if (which === "done")   return s === "done";
    if (which === "error")  return s === "error";
    if (which === "all")    return s !== "active";   // never nuke running ones
    return false;
  });

  if (!targets.length) return;
  // Confirm only for "Clear all" — done/error are obviously safe.
  if (which === "all" && !confirm(`Remove ${targets.length} finished tasks from the list?`)) {
    return;
  }

  btn.disabled = true;
  try {
    await Promise.all(targets.map((j) =>
      fetch(`/api/jobs/${j.id}`, { method: "DELETE" }).catch(() => {})
    ));
  } finally {
    btn.disabled = false;
    pollJobs(true);
  }
});

// ---------- Per-row actions (download / edit / delete) ----------
list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === "download") {
    window.location.href = `/api/jobs/${id}/download`;
  } else if (act === "edit") {
    openEditor(id);
  } else if (act === "retry") {
    btn.disabled = true;
    try {
      const r = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
      if (!r.ok) {
        const msg = await r.text();
        alert(`Retry failed: ${msg}`);
      }
    } catch (err) {
      alert(`Retry failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
    pollJobs(true);
  } else if (act === "delete") {
    try { await fetch(`/api/jobs/${id}`, { method: "DELETE" }); } catch {}
    pollJobs(true);
  }
});

// =====================================================================
// Edit-before-download modal — for srt/vtt/txt/json artefacts.
// =====================================================================

async function openEditor(jobId) {
  // Fetch the current text first; if there's nothing to edit (binary, no
  // file yet), don't bother opening the modal.
  let text = "";
  let format = "txt";
  let displayName = "";
  try {
    const [pr, jr] = await Promise.all([
      fetch(`/api/jobs/${jobId}/preview`),
      fetch(`/api/jobs/${jobId}`),
    ]);
    if (!pr.ok) throw new Error(`preview HTTP ${pr.status}`);
    const data = await pr.json();
    if (data.binary) {
      showToast({ title: "Cannot edit", body: "This artefact is binary.", kind: "error" });
      return;
    }
    text = data.text || "";
    format = data.format || "txt";
    if (jr.ok) {
      const job = await jr.json();
      displayName = job.display_name || "";
    }
  } catch (err) {
    showToast({ title: "Couldn't load file", body: String(err), kind: "error" });
    return;
  }

  renderEditor({ jobId, text, format, displayName });
}

function renderEditor({ jobId, text, format, displayName }) {
  // Tear down any previous editor instance before opening a new one.
  document.getElementById("__editor_backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "__editor_backdrop";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal editor-modal">
      <div class="modal-head">
        <div>
          <h3>Edit before download</h3>
          <p title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</p>
        </div>
        <button class="icon-btn" data-editor-close title="Close (Esc)">✕</button>
      </div>
      <div class="editor-body">
        <textarea class="editor-textarea" spellcheck="false"></textarea>
      </div>
      <div class="modal-foot">
        <span class="muted micro" data-editor-status></span>
        <div class="editor-actions">
          <button class="secondary" data-editor-close>Cancel</button>
          <button class="secondary" data-editor-copy title="Copy current text to clipboard (Ctrl+Shift+C)">Copy</button>
          <button class="secondary" data-editor-save>Save</button>
          <button class="primary"   data-editor-savedl>Save &amp; Download</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const ta     = backdrop.querySelector(".editor-textarea");
  const status = backdrop.querySelector("[data-editor-status]");
  ta.value = text;

  // Focus the textarea once the open animation has settled.
  requestAnimationFrame(() => {
    ta.focus();
    // Park the cursor at the start so big files don't auto-scroll the user
    // to the bottom.
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  });

  const close = () => backdrop.remove();
  const onKey = (e) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    // Ctrl/Cmd+S = Save (without downloading).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      doSave(false);
    }
    // Ctrl/Cmd+Shift+C = Copy entire buffer (textarea's native Ctrl+C only
    // copies the selection, which is rarely what the user wants here).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      doCopy();
    }
  };
  document.addEventListener("keydown", onKey);
  // Click on backdrop (outside the modal box) closes; clicks inside don't
  // bubble because of the matches() check.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  for (const btn of backdrop.querySelectorAll("[data-editor-close]")) {
    btn.addEventListener("click", close);
  }

  async function doSave(thenDownload) {
    const saveBtn = backdrop.querySelector("[data-editor-save]");
    const dlBtn   = backdrop.querySelector("[data-editor-savedl]");
    saveBtn.disabled = dlBtn.disabled = true;
    status.textContent = "Saving…";
    try {
      const r = await fetch(`/api/jobs/${jobId}/preview`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ta.value }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      status.textContent = `Saved · ${data.bytes} bytes`;
      if (thenDownload) {
        // Tiny delay so the user sees the saved confirmation before the
        // browser kicks off the download dialog.
        setTimeout(() => {
          window.location.href = `/api/jobs/${jobId}/download`;
          close();
          document.removeEventListener("keydown", onKey);
        }, 200);
      } else {
        // Re-poll so the queue card reflects the new segment count.
        pollJobs(true);
      }
    } catch (err) {
      status.textContent = "Save failed: " + (err.message || err);
    } finally {
      saveBtn.disabled = dlBtn.disabled = false;
    }
  }

  async function doCopy() {
    const value = ta.value;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(value); copied = true; }
      catch { /* fall through to legacy path */ }
    }
    if (!copied) {
      // Legacy fallback for browsers / contexts that block clipboard API.
      const prev = [ta.selectionStart, ta.selectionEnd];
      ta.focus(); ta.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      ta.setSelectionRange(prev[0], prev[1]);
    }
    status.textContent = copied
      ? `Copied · ${value.length} chars to clipboard`
      : "Copy blocked by the browser — select text and press Ctrl+C manually.";
  }

  backdrop.querySelector("[data-editor-copy]").addEventListener("click",   doCopy);
  backdrop.querySelector("[data-editor-save]").addEventListener("click",   () => doSave(false));
  backdrop.querySelector("[data-editor-savedl]").addEventListener("click", () => doSave(true));
}

// =====================================================================
// Notifications — fire when a task transitions from active → done/error.
// =====================================================================

function detectCompletions(jobs) {
  const seen = new Set();
  for (const j of jobs) {
    seen.add(j.id);
    const prev = lastStatus.get(j.id);
    const next = j.status;
    lastStatus.set(j.id, next);

    // Only the very first poll is allowed to skip notifications — that's
    // the discovery pass after a page reload, where finished jobs from a
    // previous session are still in the registry.
    if (firstPoll) continue;

    const wasActive  = prev === "running" || prev === "pending";
    const nowFinal   = next === "done" || next === "error";
    if (wasActive && nowFinal) {
      announce(j);
    }
  }

  // Drop tracking entries for jobs that the user cleared from the list,
  // so re-creating a job with the same ID later still announces correctly.
  for (const id of Array.from(lastStatus.keys())) {
    if (!seen.has(id)) lastStatus.delete(id);
  }
  firstPoll = false;
}

function announce(job) {
  const ok = job.status === "done";
  const title = ok ? "Task finished" : "Task failed";
  const body  = (job.display_name || job.kind || "Job") +
                (ok ? "" : ` — ${job.error || "unknown error"}`);

  showToast({ title, body, kind: ok ? "ok" : "error" });
  showDesktop({ title, body, ok });
  playChime(ok);
}

// ---------- In-app toast ----------

function showToast({ title, body, kind = "ok", timeoutMs = 6000 }) {
  if (!toastStack) return;
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.innerHTML = `
    <div class="toast-icon" aria-hidden="true">${kind === "ok" ? "✓" : "!"}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-text" title="${escapeHtml(body)}">${escapeHtml(body)}</div>
    </div>
    <button class="toast-close" aria-label="Dismiss">×</button>
  `;
  t.querySelector(".toast-close").onclick = () => dismiss(t);
  toastStack.appendChild(t);

  // Animate in next frame so the transition takes effect.
  requestAnimationFrame(() => t.classList.add("show"));

  const tid = setTimeout(() => dismiss(t), timeoutMs);
  t.dataset.tid = String(tid);
}

function dismiss(t) {
  if (!t.isConnected) return;
  clearTimeout(Number(t.dataset.tid || 0));
  t.classList.remove("show");
  setTimeout(() => t.remove(), 220);
}

// ---------- Desktop (Web Notification API) ----------
//
// Permission must be requested from a user gesture (click), so we don't
// auto-prompt on page load. The toggle button below handles enrolment.
// If the user already granted permission in a previous session, we just
// fire silently.

function notificationsAllowed() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function showDesktop({ title, body, ok }) {
  if (!notificationsAllowed()) return;
  // Browsers will skip showing a notification if the page already has
  // focus; the toast covers that case.
  try {
    const n = new Notification(title, {
      body,
      icon: "/favicon.ico",   // browsers silently ignore if missing
      tag: ok ? "mt-task-done" : "mt-task-error",
      silent: false,
    });
    // Clicking the toast brings the app tab back to the front.
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore — some platforms throw in odd states */ }
}

function refreshNotifyButton() {
  if (!notifyBtn || typeof Notification === "undefined") {
    if (notifyBtn) notifyBtn.style.display = "none";
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted") {
    notifyLabel.textContent = "Đã bật thông báo";
    notifyBtn.disabled = true;
    notifyBtn.title = "Desktop notifications are on. Disable in your browser site settings if you change your mind.";
  } else if (perm === "denied") {
    notifyLabel.textContent = "Thông báo bị chặn";
    notifyBtn.disabled = true;
    notifyBtn.title = "The browser blocked notifications for this site. Re-enable in Site Settings → Notifications.";
  } else {
    notifyLabel.textContent = "Bật thông báo";
    notifyBtn.disabled = false;
    notifyBtn.title = "Show a desktop notification when a task completes.";
  }
}

notifyBtn?.addEventListener("click", async () => {
  if (typeof Notification === "undefined") {
    showToast({
      title: "Not supported",
      body: "This browser doesn't support desktop notifications. In-app toasts will still appear.",
      kind: "error",
    });
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    refreshNotifyButton();
    if (perm === "granted") {
      showToast({ title: "Notifications enabled", body: "Bạn sẽ thấy thông báo khi task xong.", kind: "ok" });
    }
  } catch (err) {
    showToast({ title: "Permission request failed", body: String(err), kind: "error" });
  }
});

refreshNotifyButton();

// ---------- Optional chime ----------
//
// One short beep — quick to write, no asset to ship. Falls back to silence
// if the page hasn't had user interaction yet (browsers block AudioContext
// without a gesture).

let _audioCtx = null;
function playChime(ok) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const t  = _audioCtx.currentTime;
    const o  = _audioCtx.createOscillator();
    const g  = _audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(ok ? 880 : 320, t);
    o.frequency.exponentialRampToValueAtTime(ok ? 1320 : 220, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(_audioCtx.destination);
    o.start(t);
    o.stop(t + 0.34);
  } catch { /* silent fallback */ }
}
