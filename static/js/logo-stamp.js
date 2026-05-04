// Logo-stamp feature: pick folder → list videos → pick position → stamp.
import { $ } from "./utils.js";
import { pickFolder } from "./folder-picker.js";
import { pollJobs } from "./jobs.js";

// ---------- DOM ----------
const folderInput  = $("#ls-folder");
const browseBtn    = $("#ls-folder-browse");
const resultsCard  = $("#ls-results");
const resultTitle  = $("#ls-results-title");
const resultCount  = $("#ls-results-count");
const selectAllCb  = $("#ls-select-all");
const stampBtn     = $("#ls-stamp-btn");
const stampLabel   = $("#ls-stamp-label");
const videoList    = $("#ls-list");
const posGrid      = $("#ls-position-grid");
const posLabel     = $("#ls-pos-label");
const scaleInput   = $("#ls-scale");
const scaleVal     = $("#ls-scale-val");

const POS_NAMES = {
  "top-left":     "Trên trái",
  "top-right":    "Trên phải",
  "center":       "Giữa",
  "bottom-left":  "Dưới trái",
  "bottom-right": "Dưới phải",
};

let currentFolder = "";
let currentPosition = "bottom-right";
let videos = []; // [{name, path}]

// ---------- Folder browse ----------
browseBtn.addEventListener("click", async () => {
  const picked = await pickFolder(currentFolder || null);
  if (!picked) return;
  currentFolder = picked;
  folderInput.value = picked;
  await loadVideos();
});

async function loadVideos() {
  resultTitle.textContent = "Đang tải…";
  resultCount.textContent = "";
  videoList.innerHTML = "";
  resultsCard.classList.remove("hidden");
  stampBtn.disabled = true;

  try {
    const r = await fetch("/api/logo-stamp/list-videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: currentFolder }),
    });
    if (!r.ok) {
      const msg = await r.text();
      resultTitle.textContent = "Lỗi";
      resultCount.textContent = msg;
      return;
    }
    const data = await r.json();
    videos = data.videos || [];
    renderList();
  } catch (err) {
    resultTitle.textContent = "Lỗi kết nối";
    resultCount.textContent = err.message;
  }
}

function renderList() {
  resultTitle.textContent = "Video";
  resultCount.textContent = `${videos.length} file`;
  videoList.innerHTML = "";

  if (videos.length === 0) {
    videoList.innerHTML = "<li class='dl-item' style='grid-template-columns:1fr;padding:14px;color:var(--muted)'>Không tìm thấy video nào trong thư mục này.</li>";
    stampBtn.disabled = true;
    return;
  }

  for (const v of videos) {
    const li = document.createElement("li");
    li.className = "dl-item";
    li.dataset.path = v.path;
    li.innerHTML = `
      <input type="checkbox" class="ls-check" checked />
      <div class="dl-info">
        <div class="dl-info-title">${escHtml(v.name)}</div>
        <div class="dl-info-meta muted">${escHtml(v.path)}</div>
      </div>
    `;
    videoList.appendChild(li);
  }

  updateStampBtn();
  attachCheckListeners();
}

function selectedPaths() {
  return Array.from(videoList.querySelectorAll(".ls-check:checked"))
    .map(cb => cb.closest("[data-path]")?.dataset.path)
    .filter(Boolean);
}

function updateStampBtn() {
  const n = selectedPaths().length;
  stampBtn.disabled = n === 0;
  stampLabel.textContent = n > 1 ? `Chèn logo (${n} video)` : "Chèn logo";
}

function attachCheckListeners() {
  for (const cb of videoList.querySelectorAll(".ls-check")) {
    cb.addEventListener("change", () => {
      updateSelectAll();
      updateStampBtn();
    });
  }
}

function updateSelectAll() {
  const all = videoList.querySelectorAll(".ls-check");
  const checked = videoList.querySelectorAll(".ls-check:checked");
  selectAllCb.checked = all.length > 0 && checked.length === all.length;
  selectAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
}

selectAllCb.addEventListener("change", () => {
  for (const cb of videoList.querySelectorAll(".ls-check")) {
    cb.checked = selectAllCb.checked;
  }
  updateStampBtn();
});

// ---------- Position grid ----------
posGrid?.addEventListener("click", (e) => {
  const btn = e.target.closest(".ls-pos-btn");
  if (!btn) return;
  for (const b of posGrid.querySelectorAll(".ls-pos-btn")) {
    b.classList.remove("ls-pos-active");
  }
  btn.classList.add("ls-pos-active");
  currentPosition = btn.dataset.pos;
  posLabel.textContent = `Vị trí: ${POS_NAMES[currentPosition] || currentPosition}`;
});

// ---------- Scale slider ----------
scaleInput?.addEventListener("input", () => {
  scaleVal.textContent = `${scaleInput.value}%`;
});

// ---------- Stamp ----------
stampBtn.addEventListener("click", async () => {
  const paths = selectedPaths();
  if (!paths.length) return;

  const scale = parseFloat(scaleInput.value) / 100;

  stampBtn.disabled = true;
  stampLabel.textContent = "Đang gửi…";

  try {
    const r = await fetch("/api/logo-stamp/stamp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, position: currentPosition, logo_scale: scale }),
    });
    if (!r.ok) {
      const msg = await r.text();
      alert(`Lỗi: ${msg}`);
      return;
    }
    const data = await r.json();
    pollJobs(true);
    // Switch to Tasks tab so user can track progress
    document.querySelector("[data-feature='tasks']")?.click();
  } catch (err) {
    alert(`Lỗi: ${err.message}`);
  } finally {
    stampBtn.disabled = false;
    updateStampBtn();
  }
});

// ---------- Simple escapeHtml (no dep on utils version) ----------
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
