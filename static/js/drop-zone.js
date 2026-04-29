// Reusable drop-zone behaviour shared by every feature panel.
//
// Wires a .drop-zone element to its hidden <input type="file"> sibling, and
// fires `onFile(File)` when the user drops or picks a file.

export function bindDropZone(zone, fileInput, onFile) {
  zone.addEventListener("click", () => fileInput.click());
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) onFile(e.target.files[0]);
  });
}
