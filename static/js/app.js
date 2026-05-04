// Bootstrap: capabilities → device dropdowns, navigation, jobs polling.
// Feature modules self-register via their imports.
import { fetchCapabilities, $$ } from "./utils.js";
import { pollJobs } from "./jobs.js";
import "./vision.js";
import "./stt.js";
import "./downloader.js";
import "./douyin.js";
import "./logo-stamp.js";

// ---------- Capabilities ----------
(async () => {
  const caps = await fetchCapabilities();
  // Each <option data-cap="directml"> / data-cap="cuda" is enabled iff that
  // backend reports as available. Lets us avoid checking from each feature.
  for (const opt of $$("[data-cap]")) {
    const cap = opt.dataset.cap;
    if (caps[cap]) {
      opt.disabled = false;
      opt.textContent = opt.textContent.replace(/—.*$/, "").trim() + " — available";
    }
  }
})();

// ---------- Sidebar navigation ----------
const navItems = $$(".nav-item");
const panels   = $$(".feature-panel");

function showFeature(name) {
  for (const p of panels) {
    p.classList.toggle("hidden", p.dataset.panel !== name);
  }
  for (const n of navItems) {
    n.classList.toggle("active", n.dataset.feature === name);
  }
}

for (const item of navItems) {
  item.addEventListener("click", () => {
    if (item.disabled || item.classList.contains("disabled")) return;
    showFeature(item.dataset.feature);
  });
}

// ---------- Jobs polling kicks off immediately ----------
pollJobs(true);
