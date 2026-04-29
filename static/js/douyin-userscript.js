// Douyin userscript — paste into your browser DevTools console while on a
// Douyin user profile page (https://www.douyin.com/user/MS4wLjABAAAA…).
// It walks the official "aweme/post" API page-by-page and downloads a
// `douyin-video-data-<timestamp>.json` file with title, createTime, and
// direct CDN URLs for every video. Upload that JSON into the Media Toolkit
// to bulk-download the videos.
(async () => {
  const sec = location.pathname.replace("/user/", "");
  if (!location.pathname.startsWith("/user/") || !sec) {
    alert("Open a Douyin user profile first (URL must contain /user/<id>).");
    return;
  }

  const HEADERS = {
    accept: "application/json, text/plain, */*",
    "accept-language": "vi",
    "user-agent": navigator.userAgent,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fetchPage = async (cursor) => {
    const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/post/");
    Object.entries({
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      sec_user_id: sec,
      max_cursor: cursor,
      count: "20",
      version_code: "170400",
      version_name: "17.4.0",
    }).forEach(([k, v]) => url.searchParams.append(k, v));
    const r = await fetch(url, {
      headers: { ...HEADERS, referrer: location.href },
      credentials: "include",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };

  const extract = (v) => {
    if (!v) return null;
    const md = {
      id: v.aweme_id || "",
      desc: v.desc || "",
      title: v.desc || "",
      createTime: v.create_time ? new Date(v.create_time * 1000).toISOString() : "",
      videoUrl: "",
      audioUrl: "",
      coverUrl: "",
    };
    const vid = v.video || {};
    let u = vid.play_addr?.url_list?.[0] || vid.download_addr?.url_list?.[0] || "";
    if (u && !u.startsWith("https")) u = u.replace("http", "https");
    md.videoUrl = u;
    md.audioUrl = v.music?.play_url?.url_list?.[0] || "";
    md.coverUrl = vid.cover?.url_list?.[0] || v.cover?.url_list?.[0] || "";
    return md.videoUrl ? md : null;
  };

  const all = [];
  let cursor = 0;
  let hasMore = true;
  let page = 0;
  const status = (msg) => console.log(`[Douyin] ${msg}`);

  while (hasMore) {
    page++;
    let data;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        data = await fetchPage(cursor);
        break;
      } catch (err) {
        status(`page ${page} attempt ${attempt} failed: ${err.message}`);
        if (attempt === 5) throw err;
        await sleep(2000);
      }
    }
    const list = (data.aweme_list || []).map(extract).filter(Boolean);
    all.push(...list);
    status(`page ${page}: +${list.length} (total ${all.length})`);
    hasMore = !!data.has_more;
    cursor = data.max_cursor;
    await sleep(1000);
  }

  // Sort newest-first to match what the UI displays.
  all.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `douyin-video-data-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  status(`done — ${all.length} videos saved to ${a.download}`);
  alert(`Done. Saved ${all.length} videos to ${a.download}.`);
})();
