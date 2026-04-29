// Vision-OCR feature: upload video, draw subtitle region, run extraction.
import { $, fmtTime, uploadFile } from "./utils.js";
import { bindDropZone } from "./drop-zone.js";
import { pollJobs } from "./jobs.js";

const dz       = document.querySelector('[data-dz="vision"]');
const fileIn   = document.querySelector('[data-fi="vision"]');
const editor   = document.querySelector('[data-editor="vision"]');
const filename = document.querySelector('[data-vision-filename]');
const closeBtn = document.querySelector('[data-vision-close]');
const cancelBtn= document.querySelector('[data-vision-cancel]');
const submit   = document.querySelector('[data-vision-submit]');
const wrap     = document.querySelector('[data-vision-wrap]');
const video    = document.querySelector('[data-vision-video]');
const overlay  = document.querySelector('[data-vision-overlay]');
const hint     = document.querySelector('[data-vision-hint]');
const playBtn  = document.querySelector('[data-vision-play]');
const seek     = document.querySelector('[data-vision-seek]');
const seekTip  = document.querySelector('[data-vision-seek-tip]');
const speedBtn = document.querySelector('[data-vision-speed]');
const tCur     = document.querySelector('[data-vision-time-current]');
const tTot     = document.querySelector('[data-vision-time-total]');
const fps      = $("#v-fps");
const fpsVal   = $("#v-fps-val");

const overlayCtx = overlay.getContext("2d");

const state = {
  filename:    null,
  originalName:null,
  region:      null,    // {x,y,w,h} normalized 0..1
};

// ---------- Upload ----------
bindDropZone(dz, fileIn, async (file) => {
  state.originalName = file.name;
  filename.textContent = file.name;

  // Local preview while we upload.
  const localUrl = URL.createObjectURL(file);
  video.src = localUrl;

  dz.classList.add("hidden");
  editor.classList.remove("hidden");
  hint.textContent = "Uploading…";

  try {
    const data = await uploadFile(file);
    state.filename = data.filename;
    hint.textContent = "Drag on the video to draw the subtitle region. Drag corners/edges to resize.";
    setDefaultRegion();
  } catch (err) {
    alert("Upload failed: " + err.message);
    reset();
  }
});

// ---------- Canvas / region ----------
function resizeOverlay() {
  const r = video.getBoundingClientRect();
  overlay.width  = r.width  * devicePixelRatio;
  overlay.height = r.height * devicePixelRatio;
  overlay.style.width  = r.width  + "px";
  overlay.style.height = r.height + "px";
  overlayCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawRegion();
}

video.addEventListener("loadedmetadata", () => {
  if (video.videoWidth && video.videoHeight) {
    wrap.style.setProperty("--video-aspect", `${video.videoWidth} / ${video.videoHeight}`);
  }
  resizeOverlay();
  if (!state.region) setDefaultRegion();
  tTot.textContent = fmtTime(video.duration);
  seek.value = 0;
  setSeekProgress(0);
});
window.addEventListener("resize", resizeOverlay);

function setDefaultRegion() {
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

  overlayCtx.fillStyle = "rgba(0,0,0,0.35)";
  overlayCtx.fillRect(0, 0, w, ry);
  overlayCtx.fillRect(0, ry + rh, w, h - (ry + rh));
  overlayCtx.fillRect(0, ry, rx, rh);
  overlayCtx.fillRect(rx + rw, ry, w - (rx + rw), rh);

  overlayCtx.strokeStyle = "#f2c94c";
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(rx, ry, rw, rh);

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

let drag = null;
function pointerPos(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function hitHandle(nx, ny) {
  if (!state.region) return null;
  const r = state.region;
  const tol = 0.02;
  const tests = {
    nw: Math.hypot(nx - r.x, ny - r.y) < tol,
    ne: Math.hypot(nx - (r.x + r.w), ny - r.y) < tol,
    sw: Math.hypot(nx - r.x, ny - (r.y + r.h)) < tol,
    se: Math.hypot(nx - (r.x + r.w), ny - (r.y + r.h)) < tol,
    n:  Math.abs(ny - r.y) < tol           && nx > r.x && nx < r.x + r.w,
    s:  Math.abs(ny - (r.y + r.h)) < tol   && nx > r.x && nx < r.x + r.w,
    w:  Math.abs(nx - r.x) < tol           && ny > r.y && ny < r.y + r.h,
    e:  Math.abs(nx - (r.x + r.w)) < tol   && ny > r.y && ny < r.y + r.h,
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
    n:  "ns-resize", s: "ns-resize",
    e:  "ew-resize", w: "ew-resize",
    inside: "move",
  })[handle] || "crosshair";
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function updateProcessEnabled() {
  submit.disabled = !(state.filename && state.region && state.region.w > 0.02 && state.region.h > 0.02);
}

// ---------- Video controls ----------
playBtn.addEventListener("click", () => {
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener("play",   () => playBtn.classList.add("playing"));
video.addEventListener("pause",  () => playBtn.classList.remove("playing"));
video.addEventListener("ended",  () => playBtn.classList.remove("playing"));

const seekControls = seek.parentElement.parentElement; // .video-controls owns the CSS var
function setSeekProgress(thousandths) {
  const pct = Math.max(0, Math.min(100, thousandths / 10));
  seekControls.style.setProperty("--seek-progress", pct + "%");
}
video.addEventListener("timeupdate", () => {
  if (seek._seeking) return;
  tCur.textContent = fmtTime(video.currentTime);
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
    tCur.textContent = fmtTime((seek.value / 1000) * video.duration);
  }
});
seek.addEventListener("change", () => {
  if (video.duration > 0) {
    video.currentTime = (seek.value / 1000) * video.duration;
  }
  seek._seeking = false;
});
function updateSeekTip(e) {
  if (!video.duration || !isFinite(video.duration)) return;
  const rect = seek.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const t = (x / rect.width) * video.duration;
  seekTip.textContent = fmtTime(t);
  seekTip.style.left = x + "px";
  seekTip.hidden = false;
}
seek.addEventListener("mouseenter", updateSeekTip);
seek.addEventListener("mousemove",  updateSeekTip);
seek.addEventListener("mouseleave", () => { seekTip.hidden = true; });

const SPEEDS = [1, 1.5, 2, 3, 5];
let speedIdx = 0;
const fmtSpeed = (s) => (Number.isInteger(s) ? s : s.toFixed(1)) + "×";
speedBtn.addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  const s = SPEEDS[speedIdx];
  video.playbackRate = s;
  speedBtn.textContent = fmtSpeed(s);
  speedBtn.classList.toggle("fast", s !== 1);
});

// Spacebar play/pause when the panel is visible and not typing.
document.addEventListener("keydown", (e) => {
  if (editor.classList.contains("hidden")) return;
  if (!editor.offsetParent) return; // panel hidden by parent
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (video.paused) video.play(); else video.pause();
  }
});

fps.addEventListener("input", () => {
  fpsVal.textContent = fps.value + " fps";
});

// ---------- Submit ----------
submit.addEventListener("click", async () => {
  if (!state.filename || !state.region) return;
  video.pause();

  const fd = new FormData();
  fd.append("filename", state.filename);
  fd.append("x", state.region.x);
  fd.append("y", state.region.y);
  fd.append("w", state.region.w);
  fd.append("h", state.region.h);
  fd.append("language",      $("#v-language").value);
  fd.append("model_variant", $("#v-model").value);
  fd.append("device",        $("#v-device").value);
  fd.append("sample_fps",    fps.value);
  fd.append("display_name",  state.originalName || state.filename);

  try {
    const res = await fetch("/api/vision/extract", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    reset();
    pollJobs(true);
  } catch (err) {
    alert("Failed to start: " + err.message);
    reset();
  }
});

cancelBtn.addEventListener("click", reset);
closeBtn.addEventListener("click", reset);

function reset() {
  state.filename = null;
  state.originalName = null;
  state.region = null;
  filename.textContent = "";
  video.pause();
  video.playbackRate = 1;
  speedIdx = 0;
  speedBtn.textContent = "1×";
  speedBtn.classList.remove("fast");
  seekTip.hidden = true;
  video.removeAttribute("src");
  video.load();
  editor.classList.add("hidden");
  dz.classList.remove("hidden");
  fileIn.value = "";
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}
