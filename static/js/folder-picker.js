// Native folder picker — calls the server which pops the OS dialog
// (Windows Explorer / macOS Finder / GTK) on the user's own desktop.
//
// Usage:
//   import { pickFolder } from "./folder-picker.js";
//   const path = await pickFolder("C:/Users/me");   // or null
//   if (path) { ...user picked... } else { ...cancelled... }

export async function pickFolder(initialPath = null) {
  try {
    const r = await fetch("/api/download/pick-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial: initialPath || "" }),
    });
    if (!r.ok) {
      alert("Folder picker failed: " + (await r.text()));
      return null;
    }
    const data = await r.json();
    return data.path || null;
  } catch (err) {
    alert("Folder picker failed: " + err.message);
    return null;
  }
}
