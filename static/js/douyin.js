// Douyin scraper: import a JSON dump produced by the in-browser userscript,
// pick which videos to download, and queue them through the shared job
// system.
import { $, $$, escapeHtml } from "./utils.js";
import { bindDropZone } from "./drop-zone.js";
import { pollJobs } from "./jobs.js";
import { pickFolder } from "./folder-picker.js";

// ---------- DOM ----------
const dropZone   = $("[data-dz='douyin']");
const fileInput  = $("[data-fi='douyin']");
const copyBtn    = $("#dy-copy-script");
const showBtn    = $("#dy-show-script");
const scriptBox  = $("#dy-script-box");
const copyStatus = $("#dy-copy-status");

// Auto-fetch (Playwright)
const autoUrl    = $("#dy-auto-url");
const autoBtn    = $("#dy-auto-btn");
const autoLabel  = $("#dy-auto-label");
const autoHint   = $("#dy-auto-hint");

// Settings (mirror of the YouTube downloader's controls — same backend).
const settingsCard    = $("#dy-settings-card");
const settingsSummary = $("#dy-settings-summary");
const pathInput       = $("#dy-path");
const pathBrowse      = $("#dy-path-browse");
const pathReset       = $("#dy-path-reset");
const concurrentEl    = $("#dy-concurrent");
const concurrentVal   = $("#dy-concurrent-val");
const settingsSave    = $("#dy-settings-save");

const results        = $("#dy-results");
const resultsTitle   = $("#dy-results-title");
const resultsCount   = $("#dy-results-count");
const list           = $("#dy-list");
const selectAll      = $("#dy-select-all");
const downloadVideo  = $("#dy-download-video");
const downloadAudio  = $("#dy-download-audio");
const dlVideoLabel   = $("#dy-download-video-label");
const dlAudioLabel   = $("#dy-download-audio-label");
const exportJsonBtn  = $("#dy-export-json");
const exportTxtBtn   = $("#dy-export-txt");
const howto          = $("#dy-howto");

let videos = [];        // imported list (newest-first, from the userscript)

// ---------- Copy userscript ----------
//
// `navigator.clipboard.writeText` quietly fails in plenty of real-world cases
// (no user gesture, blocked permission, http context, older browsers). When
// it does, we fall back to the legacy execCommand path; if even that fails,
// we just reveal the textarea below the buttons so the user can hand-select.

let _scriptCache = null;
async function loadScript() {
  if (_scriptCache) return _scriptCache;
  const r = await fetch("/js/douyin-userscript.js", { cache: "no-cache" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  _scriptCache = await r.text();
  return _scriptCache;
}

function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function revealScriptBox(text) {
  scriptBox.value = text;
  scriptBox.classList.remove("hidden");
  // Defer focus/select so the textarea has paint dimensions to work with.
  requestAnimationFrame(() => {
    scriptBox.focus();
    scriptBox.select();
  });
}

copyBtn.addEventListener("click", async () => {
  copyStatus.textContent = "Copying…";
  try {
    const text = await loadScript();
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch { /* fall through to execCommand */ }
    }
    if (!copied) copied = legacyCopy(text);

    if (copied) {
      copyStatus.textContent = `Copied (${(text.length / 1024).toFixed(1)} kB). Paste into the Douyin tab's DevTools console.`;
    } else {
      revealScriptBox(text);
      copyStatus.textContent = "Auto-copy blocked by the browser — the script is shown below, pre-selected. Press Ctrl+C to copy.";
    }
  } catch (err) {
    copyStatus.textContent = "Could not load script: " + err.message;
  }
});

showBtn.addEventListener("click", async () => {
  try {
    const text = await loadScript();
    if (scriptBox.classList.contains("hidden")) {
      revealScriptBox(text);
      copyStatus.textContent = "Select all (Ctrl+A) inside the box, then copy (Ctrl+C).";
    } else {
      scriptBox.classList.add("hidden");
      copyStatus.textContent = "";
    }
  } catch (err) {
    copyStatus.textContent = "Could not load script: " + err.message;
  }
});

// ---------- Import JSON ----------
bindDropZone(dropZone, fileInput, async (file) => {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("JSON root must be an array of videos.");
    importVideos(data, file.name);
  } catch (err) {
    alert("Could not read JSON: " + err.message);
  }
});

function importVideos(data, sourceName = "") {
  // Trust the userscript's shape but coerce in case someone hand-edits it.
  videos = data
    .map((v) => ({
      id:         v.id || "",
      title:      v.title || v.desc || "(untitled)",
      desc:       v.desc || "",
      createTime: v.createTime || "",
      videoUrl:   v.videoUrl || "",
      audioUrl:   v.audioUrl || "",
      coverUrl:   v.coverUrl || v.dynamicCoverUrl || "",
    }))
    .filter((v) => v.videoUrl || v.audioUrl);

  if (!videos.length) {
    alert("No usable videos in this file.");
    return;
  }
  renderTable(sourceName);
  // Hide the howto once the user has the data — it just clutters the view.
  if (howto) howto.removeAttribute("open");
}

// ---------- Render ----------
function renderTable(sourceName) {
  resultsTitle.textContent = sourceName ? `Videos · ${sourceName}` : "Videos";
  resultsCount.textContent = `· ${videos.length} ${videos.length === 1 ? "video" : "videos"}`;
  list.innerHTML = "";

  videos.forEach((v, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = v.id || String(i);
    const date = v.createTime ? new Date(v.createTime).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }) : "";

    const cover = v.coverUrl
      ? `<img class="dy-cover" loading="lazy" src="${escapeHtml(v.coverUrl)}" alt=""
            onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'dy-cover placeholder-thumb',textContent:'no cover'}))" />`
      : `<div class="dy-cover placeholder-thumb">no cover</div>`;

    const links = [];
    if (v.videoUrl) links.push(`<a href="${escapeHtml(v.videoUrl)}" target="_blank" rel="noopener">Video</a>`);
    if (v.audioUrl) links.push(`<a href="${escapeHtml(v.audioUrl)}" target="_blank" rel="noopener">Audio</a>`);

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" checked /></td>
      <td class="col-num muted">${i + 1}</td>
      <td class="col-cover">${cover}</td>
      <td class="col-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</td>
      <td class="col-date muted">${escapeHtml(date)}</td>
      <td class="col-links">${links.join(' <span class="muted">·</span> ')}</td>
    `;
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return;          // let link clicks through
      if (ev.target.tagName !== "INPUT") {
        const cb = tr.querySelector("input[type=checkbox]");
        cb.checked = !cb.checked;
        updateSelection();
      }
    });
    tr.querySelector("input[type=checkbox]").addEventListener("change", updateSelection);
    list.appendChild(tr);
  });

  selectAll.checked = true;
  selectAll.indeterminate = false;
  results.classList.remove("hidden");
  updateSelection();
}

selectAll.addEventListener("change", () => {
  for (const cb of list.querySelectorAll("input[type=checkbox]")) {
    cb.checked = selectAll.checked;
  }
  updateSelection();
});

function selectedVideos() {
  const out = [];
  list.querySelectorAll("tr").forEach((tr, i) => {
    const cb = tr.querySelector("input[type=checkbox]");
    if (cb && cb.checked) out.push(videos[i]);
  });
  return out;
}

function updateSelection() {
  const total = videos.length;
  const checked = selectedVideos().length;

  const withVideo = selectedVideos().filter((v) => v.videoUrl).length;
  const withAudio = selectedVideos().filter((v) => v.audioUrl).length;

  downloadVideo.disabled = withVideo === 0;
  downloadAudio.disabled = withAudio === 0;
  dlVideoLabel.textContent = withVideo === 0
    ? "Download videos"
    : `Download ${withVideo} ${withVideo === 1 ? "video" : "videos"}`;
  dlAudioLabel.textContent = withAudio === 0
    ? "Download audios"
    : `Download ${withAudio} ${withAudio === 1 ? "audio" : "audios"}`;

  if (checked === 0)        { selectAll.checked = false; selectAll.indeterminate = false; }
  else if (checked === total) { selectAll.checked = true;  selectAll.indeterminate = false; }
  else                       { selectAll.checked = false; selectAll.indeterminate = true; }
}

// ---------- Download ----------
async function startDownload(kind) {
  const downloadPath = (pathInput.value || "").trim();

  const items = selectedVideos().filter((v) => (kind === "video" ? v.videoUrl : v.audioUrl));
  if (!items.length) return;

  const btn = kind === "video" ? downloadVideo : downloadAudio;
  btn.disabled = true;
  try {
    const r = await fetch("/api/douyin/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, kind, download_path: downloadPath }),
    });
    if (!r.ok) throw new Error(await r.text());
    pollJobs(true);
  } catch (err) {
    alert("Failed to queue downloads: " + err.message);
  } finally {
    updateSelection();
  }
}

downloadVideo.addEventListener("click", () => startDownload("video"));
downloadAudio.addEventListener("click", () => startDownload("audio"));

// ---------- Re-export ----------
function saveBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

exportJsonBtn.addEventListener("click", () => {
  const sel = selectedVideos();
  if (!sel.length) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  saveBlob(`douyin-video-data-${ts}.json`,
           new Blob([JSON.stringify(sel, null, 2)], { type: "application/json" }));
});

exportTxtBtn.addEventListener("click", () => {
  const sel = selectedVideos();
  if (!sel.length) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lines = sel.map((v) => v.videoUrl).filter(Boolean).join("\n");
  saveBlob(`douyin-video-links-${ts}.txt`,
           new Blob([lines], { type: "text/plain" }));
});

// ---------- Settings (shared with the YouTube downloader) ----------
//
// Backed by /api/download/settings, same as the yt-dlp panel — there's only
// one settings file on disk, so editing here updates the YouTube panel too
// (and vice versa) once each panel reloads it.

function refreshSettingsSummary() {
  const path = (pathInput.value || "").trim() || "(unset)";
  settingsSummary.textContent = `· ${path}`;
}

async function loadSettings() {
  try {
    const r = await fetch("/api/download/settings");
    if (!r.ok) return;
    const cfg = await r.json();
    pathInput.value      = cfg.download_path || "";
    concurrentEl.value   = cfg.concurrent_downloads || 2;
    concurrentVal.textContent = concurrentEl.value;
    refreshSettingsSummary();
  } catch (err) {
    console.error("Failed to load Douyin settings", err);
  }
}

pathInput.addEventListener("input", refreshSettingsSummary);
concurrentEl.addEventListener("input", () => {
  concurrentVal.textContent = concurrentEl.value;
});

pathReset.addEventListener("click", async () => {
  // Re-fetch so we get whatever default the server reports today.
  try {
    const r = await fetch("/api/download/settings");
    if (r.ok) {
      const cfg = await r.json();
      pathInput.value = cfg.download_path || "";
      refreshSettingsSummary();
    }
  } catch {}
});

pathBrowse.addEventListener("click", async () => {
  const initial = (pathInput.value || "").trim() || null;
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
        concurrent_downloads: parseInt(concurrentEl.value, 10),
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

loadSettings();

// ---------- Auto-fetch (Playwright) ----------
//
// Posts the user URL to /api/douyin/auto-fetch which spawns a browser
// session in the background. We poll the standard job endpoint until it
// settles, then read the JSON via /api/jobs/<id>/preview and import it.

async function checkAutoFetchSupport() {
  try {
    const r = await fetch("/api/douyin/capabilities");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const caps = await r.json();
    if (caps.playwright) {
      autoBtn.disabled = false;
      autoHint.textContent =
        "Click Auto fetch — a Chromium window will open. Log in once " +
        "(cookies persist), then it'll scrape every video automatically.";
    } else {
      autoBtn.disabled = true;
      autoHint.innerHTML =
        "Playwright not installed. Install it once with " +
        "<code>pip install playwright</code> then " +
        "<code>playwright install chromium</code>, restart the app, and the button will light up.";
    }
  } catch (err) {
    autoHint.textContent = "Could not detect Playwright: " + err.message;
  }
}
checkAutoFetchSupport();

function pollJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const job = await r.json();
        onProgress?.(job);
        if (job.status === "done")  return resolve(job);
        if (job.status === "error") return reject(new Error(job.error || "Job failed"));
        setTimeout(tick, 800);
      } catch (err) {
        reject(err);
      }
    };
    tick();
  });
}

autoBtn.addEventListener("click", async () => {
  const url = (autoUrl.value || "").trim();
  if (!url) { autoUrl.focus(); return; }

  autoBtn.disabled = true;
  const oldLabel = autoLabel.textContent;
  autoLabel.textContent = "Launching…";
  autoHint.textContent = "Starting Chromium…";

  try {
    const r = await fetch("/api/douyin/auto-fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_url: url }),
    });
    if (!r.ok) throw new Error(await r.text());
    const { job_id } = await r.json();
    pollJobs(true);  // refresh queue panel so user sees progress there too

    const done = await pollJob(job_id, (job) => {
      if (job.message) autoHint.textContent = job.message;
      const pct = Math.round(job.progress || 0);
      autoLabel.textContent = pct ? `Fetching… ${pct}%` : "Fetching…";
    });

    // Job done — fetch the JSON the worker wrote and import it.
    autoHint.textContent = "Importing result…";
    const pr = await fetch(`/api/jobs/${done.id}/preview`);
    if (!pr.ok) throw new Error("HTTP " + pr.status);
    const { text } = await pr.json();
    const data = JSON.parse(text || "[]");
    importVideos(data, "Auto-fetched");
    autoHint.textContent = `Imported ${data.length} videos.`;
  } catch (err) {
    autoHint.textContent = "Auto-fetch failed: " + err.message;
  } finally {
    autoBtn.disabled = false;
    autoLabel.textContent = oldLabel;
  }
});
