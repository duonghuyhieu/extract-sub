// Video downloader feature: scan a URL, pick videos, queue downloads.
import { $, escapeHtml } from "./utils.js";
import { pollJobs } from "./jobs.js";
import { pickFolder } from "./folder-picker.js";

// ---------- DOM ----------
const settingsCard   = $("#dl-settings-card");
const settingsHint   = $("#dl-settings-summary");
const pathInput      = $("#dl-path");
const pathReset      = $("#dl-path-reset");
const pathBrowse     = $("#dl-path-browse");
const formatSel      = $("#dl-format");
const concurrentEl   = $("#dl-concurrent");
const concurrentVal  = $("#dl-concurrent-val");
const templateInput  = $("#dl-template");
const settingsSave   = $("#dl-settings-save");

const urlInput       = $("#dl-url");
const scanBtn        = $("#dl-scan-btn");
const scanHint       = $("#dl-scan-hint");

const results        = $("#dl-results");
const resultsTitle   = $("#dl-results-title");
const resultsCount   = $("#dl-results-count");
const selectAll      = $("#dl-select-all");
const list           = $("#dl-list");
const downloadBtn    = $("#dl-download-btn");
const downloadLabel  = $("#dl-download-label");

let entries = [];                  // current scan results
let defaultDownloadPath = "";      // populated from server defaults

// ---------- Settings ----------
async function loadSettings() {
  try {
    const r = await fetch("/api/download/settings");
    if (!r.ok) return;
    const cfg = await r.json();

    pathInput.value     = cfg.download_path;
    templateInput.value = cfg.output_template;
    concurrentEl.value  = cfg.concurrent_downloads;
    concurrentVal.textContent = cfg.concurrent_downloads;

    formatSel.innerHTML = "";
    for (const preset of cfg.format_presets) {
      const o = document.createElement("option");
      o.value = preset;
      o.textContent = labelForPreset(preset);
      if (preset === cfg.format_preset) o.selected = true;
      formatSel.appendChild(o);
    }

    refreshSettingsSummary();
  } catch (err) {
    console.error("Failed to load downloader settings", err);
  }
}

function labelForPreset(p) {
  return ({
    "best":   "Best (video+audio merged · needs ffmpeg)",
    "1080p":  "1080p (merged · needs ffmpeg)",
    "720p":   "720p (single MP4)",
    "480p":   "480p (single MP4)",
    "360p":   "360p (single MP4)",
    "audio":  "Audio only (m4a)",
  })[p] || p;
}

function refreshSettingsSummary() {
  const path = pathInput.value || "(unset)";
  const fmt  = formatSel.value;
  settingsHint.textContent = `· ${fmt} → ${path}`;
}

// Re-fetch defaults once for the reset button.
(async () => {
  try {
    const r = await fetch("/api/download/settings");
    if (r.ok) defaultDownloadPath = (await r.json()).download_path;
  } catch {}
})();

pathInput.addEventListener("input", refreshSettingsSummary);
formatSel.addEventListener("change", refreshSettingsSummary);
concurrentEl.addEventListener("input", () => {
  concurrentVal.textContent = concurrentEl.value;
});
pathReset.addEventListener("click", async () => {
  // Hit the server with empty payload so it returns the actual default.
  const r = await fetch("/api/download/settings");
  if (r.ok) {
    const cfg = await r.json();
    pathInput.value = cfg.download_path;
    refreshSettingsSummary();
  }
});

pathBrowse.addEventListener("click", async () => {
  // Open the picker at the current input value if it's a real path,
  // otherwise let the picker land on the root view.
  const initial = pathInput.value && pathInput.value.trim() ? pathInput.value : null;
  const picked = await pickFolder(initial);
  if (picked) {
    pathInput.value = picked;
    refreshSettingsSummary();
  }
});

settingsSave.addEventListener("click", async () => {
  settingsSave.disabled = true;
  try {
    const r = await fetch("/api/download/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        download_path:        pathInput.value,
        format_preset:        formatSel.value,
        concurrent_downloads: parseInt(concurrentEl.value, 10),
        output_template:      templateInput.value,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    settingsCard.removeAttribute("open");
    refreshSettingsSummary();
  } catch (err) {
    alert("Failed to save: " + err.message);
  } finally {
    settingsSave.disabled = false;
  }
});

// ---------- Scan ----------
scanBtn.addEventListener("click", scan);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") scan();
});

async function scan() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }

  scanBtn.disabled = true;
  const oldHint = scanHint.textContent;
  scanHint.textContent = "Scanning… (channels with hundreds of videos can take 10–30s)";
  results.classList.add("hidden");

  try {
    const r = await fetch("/api/download/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    entries = data.entries || [];
    renderResults(data);
    scanHint.textContent = oldHint;
  } catch (err) {
    scanHint.textContent = "Scan failed: " + err.message;
  } finally {
    scanBtn.disabled = false;
  }
}

function renderResults(data) {
  resultsTitle.textContent = data.title || "(untitled)";
  resultsCount.textContent = `· ${entries.length} ${data.kind === "video" ? "video" : "videos"}`
    + (data.uploader ? ` · ${data.uploader}` : "");
  selectAll.checked = true;

  list.innerHTML = "";
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "dl-item";
    li.dataset.url = e.url;

    const dur = e.duration ? fmtDuration(e.duration) : "";
    const date = e.upload_date ? formatDate(e.upload_date) : "";
    const views = e.view_count ? fmtViews(e.view_count) : "";
    const meta = [e.uploader, date, dur, views].filter(Boolean);

    const thumbHtml = e.thumbnail
      ? `<img class="dl-thumb" loading="lazy" src="${escapeHtml(e.thumbnail)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'dl-thumb placeholder-thumb',textContent:'no thumb'}))" />`
      : `<div class="dl-thumb placeholder-thumb">no thumb</div>`;

    li.innerHTML = `
      <input type="checkbox" checked />
      ${thumbHtml}
      <div class="dl-info">
        <div class="dl-info-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
        <div class="dl-info-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}</div>
      </div>
    `;
    li.addEventListener("click", (ev) => {
      // Clicking anywhere on the row toggles the checkbox (except on the
      // checkbox itself, where the native click handles it).
      if (ev.target.tagName !== "INPUT") {
        const cb = li.querySelector("input[type=checkbox]");
        cb.checked = !cb.checked;
        updateSelection();
      }
    });
    li.querySelector("input[type=checkbox]").addEventListener("change", updateSelection);
    list.appendChild(li);
  }
  results.classList.remove("hidden");
  updateSelection();
}

selectAll.addEventListener("change", () => {
  for (const cb of list.querySelectorAll("input[type=checkbox]")) {
    cb.checked = selectAll.checked;
  }
  updateSelection();
});

function updateSelection() {
  const checked = list.querySelectorAll("input[type=checkbox]:checked").length;
  downloadBtn.disabled = checked === 0;
  downloadLabel.textContent = checked === 0
    ? "Download"
    : `Download ${checked} ${checked === 1 ? "video" : "videos"}`;
  // sync select-all checkbox state
  if (checked === 0) {
    selectAll.checked = false; selectAll.indeterminate = false;
  } else if (checked === entries.length) {
    selectAll.checked = true; selectAll.indeterminate = false;
  } else {
    selectAll.checked = false; selectAll.indeterminate = true;
  }
}

// ---------- Download selected ----------
downloadBtn.addEventListener("click", async () => {
  const items = [];
  list.querySelectorAll(".dl-item").forEach((li) => {
    const cb = li.querySelector("input[type=checkbox]");
    if (cb && cb.checked) {
      const e = entries.find((x) => x.url === li.dataset.url);
      if (e) items.push({ url: e.url, title: e.title });
    }
  });
  if (!items.length) return;

  downloadBtn.disabled = true;
  try {
    const r = await fetch("/api/download/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        download_path: pathInput.value,
        format_preset: formatSel.value,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    pollJobs(true);
  } catch (err) {
    alert("Failed to queue downloads: " + err.message);
  } finally {
    downloadBtn.disabled = false;
  }
});

// ---------- Helpers ----------
function fmtDuration(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${m}:${String(s).padStart(2,"0")}`;
}
function formatDate(yyyymmdd) {
  if (!/^\d{8}$/.test(String(yyyymmdd))) return String(yyyymmdd);
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}
function fmtViews(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B views";
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1) + "M views";
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + "K views";
  return n + " views";
}

// Bootstrap
loadSettings();
