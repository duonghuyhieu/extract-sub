// Speech-to-text feature: upload audio/video, configure Whisper, transcribe.
import { $, uploadFile } from "./utils.js";
import { bindDropZone } from "./drop-zone.js";
import { pollJobs } from "./jobs.js";

const dz       = document.querySelector('[data-dz="stt"]');
const fileIn   = document.querySelector('[data-fi="stt"]');
const editor   = document.querySelector('[data-editor="stt"]');
const filename = document.querySelector('[data-stt-filename]');
const closeBtn = document.querySelector('[data-stt-close]');
const cancelBtn= document.querySelector('[data-stt-cancel]');
const submit   = document.querySelector('[data-stt-submit]');

const modelSel  = $("#s-model");
const langSel   = $("#s-lang");
const taskSel   = $("#s-task");
const devSel    = $("#s-device");
const compSel   = $("#s-compute");
const fmtSel    = $("#s-format");
const vad       = $("#s-vad");
const words     = $("#s-words");
const beam      = $("#s-beam");
const beamVal   = $("#s-beam-val");
const promptIn  = $("#s-prompt");

const state = {
  filename: null,
  originalName: null,
};

// ---------- Populate options from server ----------
(async () => {
  try {
    const r = await fetch("/api/stt/options");
    if (!r.ok) return;
    const opts = await r.json();

    for (const m of opts.models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m + (m === "large-v3-turbo" ? "  (recommended)" : "");
      if (m === "large-v3-turbo") o.selected = true;
      modelSel.appendChild(o);
    }
    for (const l of opts.languages) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.label;
      if (l.code === "auto") o.selected = true;
      langSel.appendChild(o);
    }
    for (const f of opts.formats) {
      const o = document.createElement("option");
      o.value = f;
      o.textContent = f.toUpperCase();
      if (f === "srt") o.selected = true;
      fmtSel.appendChild(o);
    }
  } catch (err) {
    console.error("Failed to load STT options", err);
  }
})();

beam.addEventListener("input", () => { beamVal.textContent = beam.value; });

// ---------- Upload ----------
bindDropZone(dz, fileIn, async (file) => {
  state.originalName = file.name;
  filename.textContent = file.name;

  dz.classList.add("hidden");
  editor.classList.remove("hidden");

  try {
    const data = await uploadFile(file);
    state.filename = data.filename;
  } catch (err) {
    alert("Upload failed: " + err.message);
    reset();
  }
});

// ---------- Submit ----------
submit.addEventListener("click", async () => {
  if (!state.filename) {
    alert("Please upload a file first.");
    return;
  }
  const fd = new FormData();
  fd.append("filename",        state.filename);
  fd.append("model",           modelSel.value);
  fd.append("language",        langSel.value);
  fd.append("task",            taskSel.value);
  fd.append("device",          devSel.value);
  fd.append("compute_type",    compSel.value);
  fd.append("output_format",   fmtSel.value);
  fd.append("vad_filter",      vad.checked  ? "true" : "false");
  fd.append("word_timestamps", words.checked ? "true" : "false");
  fd.append("beam_size",       beam.value);
  fd.append("initial_prompt",  promptIn.value || "");
  fd.append("display_name",    state.originalName || state.filename);

  submit.disabled = true;
  try {
    const res = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    reset();
    pollJobs(true);
  } catch (err) {
    alert("Failed to start: " + err.message);
  } finally {
    submit.disabled = false;
  }
});

cancelBtn.addEventListener("click", reset);
closeBtn.addEventListener("click", reset);

function reset() {
  state.filename = null;
  state.originalName = null;
  filename.textContent = "";
  editor.classList.add("hidden");
  dz.classList.remove("hidden");
  fileIn.value = "";
}
