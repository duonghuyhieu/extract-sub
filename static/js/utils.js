// Tiny shared helpers used across feature modules.

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export async function uploadFile(file, onProgress) {
  // Posts to /api/upload, returns { media_id, filename, original_name, size, kind }
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

export async function fetchCapabilities() {
  try {
    const r = await fetch("/api/capabilities");
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}
