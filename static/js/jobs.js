// Polls /api/jobs and renders the dedicated Tasks panel.
//
// The panel is its own feature tab now (see `data-panel="tasks"`), so this
// module is also responsible for the small badge on the sidebar nav item
// — that's how the user knows something is running while they're on a
// different tab.
import { $, $$, escapeHtml } from "./utils.js";

const list      = $("#jobs-list");
const summary   = $("#jobs-summary");
const empty     = $("#jobs-empty");
const navBadge  = $("#nav-tasks-badge");
const filterRow = $(".task-filters");
const bulkRow   = $(".task-bulk");
const countEls  = {
  all:    $("[data-count='all']"),
  active: $("[data-count='active']"),
  done:   $("[data-count='done']"),
  error:  $("[data-count='error']"),
};

let pollTimer = null;
let currentFilter = "all";

const KIND_LABEL = {
  vision:           "OCR",
  stt:              "STT",
  download:         "DL",
  "douyin-fetch":   "FETCH",
};

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

  li.innerHTML = `
    <span class="kind-badge kind-${escapeHtml(job.kind || "job")}">${escapeHtml(kindLabel)}</span>
    <div class="job-name" title="${escapeHtml(job.display_name)}">${escapeHtml(job.display_name)}</div>
    <div class="job-actions">
      ${isDone && !isDownload ? `<button class="btn-sm primary" data-act="download" data-id="${job.id}">Download</button>` : ""}
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

// ---------- Per-row actions (download / delete one) ----------
list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === "download") {
    window.location.href = `/api/jobs/${id}/download`;
  } else if (act === "delete") {
    try { await fetch(`/api/jobs/${id}`, { method: "DELETE" }); } catch {}
    pollJobs(true);
  }
});
