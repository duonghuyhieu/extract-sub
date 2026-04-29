// Polls /api/jobs and renders the shared queue panel for every feature.
import { $, escapeHtml } from "./utils.js";

const panel   = $("#jobs-panel");
const list    = $("#jobs-list");
const summary = $("#jobs-summary");

let pollTimer = null;

const KIND_LABEL = {
  vision:   "OCR",
  stt:      "STT",
  download: "DL",
};

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
  if (!jobs || jobs.length === 0) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");

  const running = jobs.filter((j) => j.status === "running" || j.status === "pending").length;
  const done    = jobs.filter((j) => j.status === "done").length;
  const errored = jobs.filter((j) => j.status === "error").length;
  summary.textContent =
    `${jobs.length} total` +
    (running ? ` · ${running} running` : "") +
    (done    ? ` · ${done} done`       : "") +
    (errored ? ` · ${errored} error`   : "");

  // Diff existing nodes by id to avoid flicker.
  const keep = new Set(jobs.map((j) => j.id));
  for (const li of Array.from(list.children)) {
    if (!keep.has(li.dataset.jobId)) li.remove();
  }
  for (const job of jobs) {
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
