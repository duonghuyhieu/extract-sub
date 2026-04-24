// Local Subtitle Extractor — frontend

const $ = (id) => document.getElementById(id);

// Ask the server which acceleration backends are available — we can only
// enable the DirectML option if the user has `onnxruntime-directml` installed.
(async () => {
  try {
    const r = await fetch("/api/capabilities");
    if (!r.ok) return;
    const caps = await r.json();
    const opt = document.getElementById("device-directml");
    if (caps.directml && opt) {
      opt.disabled = false;
      opt.textContent = "GPU (DirectML) — AMD / Intel";
    }
  } catch {}
})();

// Current editor session — one video being configured at a time. When the
// user clicks Process, this snapshot becomes a Job in the queue below and
// the editor resets so another video can be dropped in.
const state = {
  filename: null,       // server-side filename (uuid + ext)
  originalName: null,   // as uploaded, for display
  region: null,         // {x, y, w, h} in normalized [0..1]
};

const dropZone = $("drop-zone");
const fileInput = $("file-input");
const editor = $("editor");
const jobsPanel = $("jobs-panel");
const jobsList = $("jobs-list");
const jobsSummary = $("jobs-summary");
const video = $("video");
const overlay = $("overlay");
const overlayCtx = overlay.getContext("2d");
const hint = $("region-hint");
const btnProcess = $("btn-process");
const btnCancel = $("btn-cancel");
const closeEditor = $("close-editor");
const playBtn = $("play-btn");
const seek = $("seek");
const seekTooltip = $("seek-tooltip");
const speedBtn = $("speed-btn");
const timeCurrent = $("time-current");
const timeTotal = $("time-total");
const sampleFpsEl = $("sample-fps");
const sampleFpsVal = $("sample-fps-val");

// ---------- Upload ----------
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  state.originalName = file.name;
  dropZone.classList.add("hidden");
  // Show an immediate preview while uploading — the server returns the path
  // afterwards, at which point we switch the video <src>.
  const localUrl = URL.createObjectURL(file);
  video.src = localUrl;
  editor.classList.remove("hidden");

  hint.textContent = "Uploading…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.filename = data.filename;
    hint.textContent = "Drag on the video to draw the subtitle region. Drag its corners/edges to resize.";
    // Default region: bottom band, centered, 80% wide
    setDefaultRegion();
  } catch (err) {
    alert("Upload failed: " + err.message);
    reset();
  }
}

// ---------- Canvas / region drawing ----------
function resizeOverlay() {
  const r = video.getBoundingClientRect();
  overlay.width = r.width * devicePixelRatio;
  overlay.height = r.height * devicePixelRatio;
  overlay.style.width = r.width + "px";
  overlay.style.height = r.height + "px";
  overlayCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawRegion();
}

video.addEventListener("loadedmetadata", () => {
  // Lock the wrapper's aspect ratio to the actual video frame so the overlay
  // canvas maps 1:1 to frame pixels — no letterbox-induced coord drift.
  const wrap = document.getElementById("video-wrap");
  if (video.videoWidth && video.videoHeight) {
    wrap.style.setProperty("--video-aspect", `${video.videoWidth} / ${video.videoHeight}`);
  }
  resizeOverlay();
  if (!state.region) setDefaultRegion();
});
window.addEventListener("resize", resizeOverlay);

function setDefaultRegion() {
  // bottom caption band
  state.region = { x: 0.10, y: 0.80, w: 0.80, h: 0.14 };
  drawRegion();
  updateProcessEnabled();
}

function drawRegion() {
  const w = overlay.clientWidth;
  const h = overlay.clientHeight;
  overlayCtx.clearRect(0, 0, w, h);
  if (!state.region) return;

  const rx = state.region.x * w;
  const ry = state.region.y * h;
  const rw = state.region.w * w;
  const rh = state.region.h * h;

  // dim outside
  overlayCtx.fillStyle = "rgba(0,0,0,0.35)";
  overlayCtx.fillRect(0, 0, w, ry);
  overlayCtx.fillRect(0, ry + rh, w, h - (ry + rh));
  overlayCtx.fillRect(0, ry, rx, rh);
  overlayCtx.fillRect(rx + rw, ry, w - (rx + rw), rh);

  // rect
  overlayCtx.strokeStyle = "#f2c94c";
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(rx, ry, rw, rh);

  // handles
  const hs = 6;
  overlayCtx.fillStyle = "#f2c94c";
  for (const [px, py] of corners(rx, ry, rw, rh)) {
    overlayCtx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
  }
}

function corners(x, y, w, h) {
  return [
    [x, y], [x + w, y], [x, y + h], [x + w, y + h],
    [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2],
  ];
}

// Drag to draw / resize
let drag = null;

function pointerPos(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function hitHandle(nx, ny) {
  if (!state.region) return null;
  const r = state.region;
  const tol = 0.02; // normalized tolerance
  const tests = {
    nw: Math.hypot(nx - r.x, ny - r.y) < tol,
    ne: Math.hypot(nx - (r.x + r.w), ny - r.y) < tol,
    sw: Math.hypot(nx - r.x, ny - (r.y + r.h)) < tol,
    se: Math.hypot(nx - (r.x + r.w), ny - (r.y + r.h)) < tol,
    n: Math.abs(ny - r.y) < tol && nx > r.x && nx < r.x + r.w,
    s: Math.abs(ny - (r.y + r.h)) < tol && nx > r.x && nx < r.x + r.w,
    w: Math.abs(nx - r.x) < tol && ny > r.y && ny < r.y + r.h,
    e: Math.abs(nx - (r.x + r.w)) < tol && ny > r.y && ny < r.y + r.h,
    inside: nx > r.x && nx < r.x + r.w && ny > r.y && ny < r.y + r.h,
  };
  for (const k of ["nw","ne","sw","se","n","s","w","e","inside"]) {
    if (tests[k]) return k;
  }
  return null;
}

overlay.addEventListener("pointerdown", (e) => {
  overlay.setPointerCapture(e.pointerId);
  const p = pointerPos(e);
  const handle = hitHandle(p.x, p.y);
  if (handle === null) {
    // start new rect
    drag = { mode: "draw", startX: p.x, startY: p.y };
    state.region = { x: p.x, y: p.y, w: 0, h: 0 };
  } else if (handle === "inside") {
    drag = { mode: "move", startX: p.x, startY: p.y, orig: { ...state.region } };
  } else {
    drag = { mode: "resize", edge: handle, orig: { ...state.region } };
  }
});

overlay.addEventListener("pointermove", (e) => {
  if (!drag) {
    if (state.region) {
      const p = pointerPos(e);
      const h = hitHandle(p.x, p.y);
      overlay.style.cursor = cursorFor(h);
    }
    return;
  }
  const p = pointerPos(e);
  const r = state.region;
  if (drag.mode === "draw") {
    r.x = Math.min(drag.startX, p.x);
    r.y = Math.min(drag.startY, p.y);
    r.w = Math.abs(p.x - drag.startX);
    r.h = Math.abs(p.y - drag.startY);
  } else if (drag.mode === "move") {
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    r.x = clamp01(drag.orig.x + dx);
    r.y = clamp01(drag.orig.y + dy);
    r.x = Math.min(r.x, 1 - drag.orig.w);
    r.y = Math.min(r.y, 1 - drag.orig.h);
  } else if (drag.mode === "resize") {
    const o = drag.orig;
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (drag.edge.includes("n")) y1 = p.y;
    if (drag.edge.includes("s")) y2 = p.y;
    if (drag.edge.includes("w")) x1 = p.x;
    if (drag.edge.includes("e")) x2 = p.x;
    r.x = clamp01(Math.min(x1, x2));
    r.y = clamp01(Math.min(y1, y2));
    r.w = Math.min(1 - r.x, Math.abs(x2 - x1));
    r.h = Math.min(1 - r.y, Math.abs(y2 - y1));
  }
  drawRegion();
});

overlay.addEventListener("pointerup", () => {
  drag = null;
  updateProcessEnabled();
});

function cursorFor(handle) {
  return ({
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    inside: "move",
  })[handle] || "crosshair";
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function updateProcessEnabled() {
  btnProcess.disabled = !(state.filename && state.region && state.region.w > 0.02 && state.region.h > 0.02);
}

// ---------- Custom video controls (below the video) ----------
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

playBtn.addEventListener("click", () => {
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener("play", () => playBtn.classList.add("playing"));
video.addEventListener("pause", () => playBtn.classList.remove("playing"));
video.addEventListener("ended", () => playBtn.classList.remove("playing"));

const seekControls = seek.parentElement; // .video-controls — holds the CSS var
function setSeekProgress(valueThousandths) {
  const pct = Math.max(0, Math.min(100, valueThousandths / 10));
  seekControls.style.setProperty("--seek-progress", pct + "%");
}

video.addEventListener("loadedmetadata", () => {
  timeTotal.textContent = fmtTime(video.duration);
  seek.value = 0;
  setSeekProgress(0);
});
video.addEventListener("timeupdate", () => {
  if (seek._seeking) return;
  timeCurrent.textContent = fmtTime(video.currentTime);
  if (video.duration > 0) {
    const v = (video.currentTime / video.duration) * 1000;
    seek.value = v;
    setSeekProgress(v);
  }
});

seek.addEventListener("input", () => {
  seek._seeking = true;
  setSeekProgress(seek.value);
  if (video.duration > 0) {
    const t = (seek.value / 1000) * video.duration;
    timeCurrent.textContent = fmtTime(t);
  }
});
seek.addEventListener("change", () => {
  if (video.duration > 0) {
    video.currentTime = (seek.value / 1000) * video.duration;
  }
  seek._seeking = false;
});

// Hover tooltip on the seek bar — shows the time at the pointer position.
function updateSeekTooltip(e) {
  if (!video.duration || !isFinite(video.duration)) return;
  const rect = seek.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const t = (x / rect.width) * video.duration;
  seekTooltip.textContent = fmtTime(t);
  // Position the tooltip relative to .seek-wrap (seek's parent)
  seekTooltip.style.left = x + "px";
  seekTooltip.hidden = false;
}
seek.addEventListener("mouseenter", updateSeekTooltip);
seek.addEventListener("mousemove", updateSeekTooltip);
seek.addEventListener("mouseleave", () => { seekTooltip.hidden = true; });

// Playback speed — click cycles through.
const SPEEDS = [1, 1.5, 2, 3, 5];
let speedIdx = 0;
function fmtSpeed(s) {
  return (Number.isInteger(s) ? s : s.toFixed(1)) + "×";
}
speedBtn.addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  const s = SPEEDS[speedIdx];
  video.playbackRate = s;
  speedBtn.textContent = fmtSpeed(s);
  speedBtn.classList.toggle("fast", s !== 1);
});

// Spacebar toggles play/pause when the editor is visible.
document.addEventListener("keydown", (e) => {
  if (editor.classList.contains("hidden")) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (video.paused) video.play(); else video.pause();
  }
});

sampleFpsEl.addEventListener("input", () => {
  sampleFpsVal.textContent = sampleFpsEl.value + " fps";
});

// ---------- Submit ----------
btnProcess.addEventListener("click", async () => {
  if (!state.filename || !state.region) return;
  video.pause();

  const fd = new FormData();
  fd.append("filename", state.filename);
  fd.append("x", state.region.x);
  fd.append("y", state.region.y);
  fd.append("w", state.region.w);
  fd.append("h", state.region.h);
  fd.append("language", $("language").value);
  fd.append("model_variant", $("model-variant").value);
  fd.append("device", $("device").value);
  fd.append("sample_fps", sampleFpsEl.value);
  fd.append("display_name", state.originalName || state.filename);

  try {
    const res = await fetch("/api/extract", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    // Reset the editor so the user can immediately queue another video.
    // The job itself is tracked via /api/jobs polling below.
    closeEditorPanel();
    pollAllJobs(true);
  } catch (err) {
    alert("Failed to start: " + err.message);
    closeEditorPanel();
  }
});

btnCancel.addEventListener("click", closeEditorPanel);
closeEditor.addEventListener("click", closeEditorPanel);

// ---------- Queue / jobs polling ----------
let pollTimer = null;

async function pollAllJobs(immediate = false) {
  if (pollTimer) clearTimeout(pollTimer);
  try {
    const res = await fetch("/api/jobs");
    if (res.ok) {
      const { jobs } = await res.json();
      renderJobs(jobs);
      // Keep polling while any job is still active.
      const active = jobs.some((j) => j.status === "pending" || j.status === "running");
      pollTimer = setTimeout(() => pollAllJobs(), active ? 800 : 4000);
      return;
    }
  } catch {}
  pollTimer = setTimeout(() => pollAllJobs(), 2000);
}

function renderJobs(jobs) {
  if (!jobs || jobs.length === 0) {
    jobsPanel.classList.add("hidden");
    jobsList.innerHTML = "";
    return;
  }
  jobsPanel.classList.remove("hidden");

  const running = jobs.filter((j) => j.status === "running" || j.status === "pending").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const errored = jobs.filter((j) => j.status === "error").length;
  jobsSummary.textContent =
    `${jobs.length} total` +
    (running ? ` · ${running} running` : "") +
    (done ? ` · ${done} done` : "") +
    (errored ? ` · ${errored} error` : "");

  // Diff: reuse existing <li> nodes by id when possible to avoid flicker.
  const keep = new Set(jobs.map((j) => j.id));
  for (const li of Array.from(jobsList.children)) {
    if (!keep.has(li.dataset.jobId)) li.remove();
  }
  for (const job of jobs) {
    let li = jobsList.querySelector(`[data-job-id="${job.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.jobId = job.id;
      li.className = "job-card";
      jobsList.prepend(li);
    }
    updateJobCard(li, job);
  }
}

function updateJobCard(li, job) {
  li.classList.toggle("done", job.status === "done");
  li.classList.toggle("error", job.status === "error");

  const isDone = job.status === "done";
  const isErr  = job.status === "error";
  const pct = Math.max(0, Math.min(100, job.progress || 0));
  const status = isErr
    ? `Error: ${job.error || "unknown"}`
    : isDone
      ? `${job.segments} segments · done`
      : `${pct.toFixed(0)}% · ${job.message || job.status}`;

  li.innerHTML = `
    <div class="job-name" title="${escapeHtml(job.display_name)}">${escapeHtml(job.display_name)}</div>
    <div class="job-status">${escapeHtml(status)}</div>
    <div class="job-progress"><div class="fill" style="width:${isDone ? 100 : pct}%"></div></div>
    <div class="job-actions">
      ${isDone ? `<button class="btn-sm primary" data-act="download" data-id="${job.id}">Download</button>` : ""}
      <button class="btn-sm" data-act="delete" data-id="${job.id}" title="Remove from list">✕</button>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

jobsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === "download") {
    window.location.href = `/api/jobs/${id}/download`;
  } else if (act === "delete") {
    try { await fetch(`/api/jobs/${id}`, { method: "DELETE" }); } catch {}
    pollAllJobs(true);
  }
});

// Kick off polling on page load so jobs from a previous session (if the
// server's still alive) show up too.
pollAllJobs(true);

// ---------- Editor panel lifecycle ----------
function closeEditorPanel() {
  // Reset the editor to accept a new video, without touching the job queue.
  state.filename = null;
  state.originalName = null;
  state.region = null;
  video.pause();
  video.playbackRate = 1;
  speedIdx = 0;
  speedBtn.textContent = "1×";
  speedBtn.classList.remove("fast");
  seekTooltip.hidden = true;
  video.removeAttribute("src");
  video.load();
  editor.classList.add("hidden");
  dropZone.classList.remove("hidden");
  fileInput.value = "";
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}
