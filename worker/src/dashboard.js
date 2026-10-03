/**
 * CunFetch 看板 UI —— 唯一真源（worker 与本地预览共用同一份）。
 *
 * 数据结构契约：
 *   root = {
 *     "<yyyymmdd>": {
 *       "<early|mid|late>": {
 *         "<slug>": {
 *           kind: "video" | "article",  // 缺省 video
 *           files: { "<相对路径>": { size, etag } },
 *           title: string,
 *           platforms: {...}|null,      // 视频=platforms.json.platforms；图文=各平台 article.json 的 title/tags
 *           coverPath: string|null,     // 图文封面相对路径（视频用 files 里的 cover.*）
 *           status: { downloaded, pull_at, local_size } | null
 *         }
 *       }
 *     }
 *   }
 *   baseUrl: 用于拼接 /media 下载地址。
 *
 * 导出：renderDashboard(root, baseUrl), escHtml, FAVICON_SVG
 */
export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const FAVICON_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cfg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#cfg)"/>
  <path d="M64 30 L64 76" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
  <path d="M44 58 L64 78 L84 58" stroke="#ffffff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M40 30 L88 30 L88 92 Q88 96 84 96 L44 96 Q40 96 40 92 Z" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

export function renderDashboard(root, baseUrl) {
  const SLOT_LABEL = { early: "早 09:05", mid: "中 12:10", late: "晚 19:08" };
  const PLATFORM_LABEL = {
    douyin: "抖音", bilibili: "B站", shipinhao: "视频号",
    wechat: "公众号", xiaohongshu: "小红书", toutiao: "头条", baijiahao: "百家号", zhihu: "知乎",
  };
  const VIDEO_PLATFORMS = ["douyin", "bilibili", "shipinhao"];
  const ARTICLE_PLATFORMS = ["wechat", "xiaohongshu", "toutiao", "baijiahao", "zhihu"];
  const rows = [];
  const dates = Object.keys(root || {}).sort().reverse();
  for (const date of dates) {
    for (const slot of ["early", "mid", "late"]) {
      if (!root[date][slot]) continue;
      for (const slug of Object.keys(root[date][slot])) {
        const entry = root[date][slot][slug];
        const kind = entry.kind === "article" ? "article" : "video";
        const fnames = Object.keys(entry.files || {});
        const hasVideo = fnames.includes("video.mp4");
        const hasPlatforms = fnames.includes("platforms.json");
        const coverName = fnames.find((f) => f.startsWith("cover.")) || null;
        const st = entry.status || {};
        const title = (entry.title || "").trim() || slug;
        rows.push({
          date, slot, slug, kind, coverName, coverPath: entry.coverPath || null,
          hasVideo, hasPlatforms,
          platforms: entry.platforms || null,
          downloaded: Boolean(st.downloaded), pull_at: st.pull_at || null,
        });
      }
    }
  }

  const cards = rows.map((r) => {
    const kindPrefix = r.kind === "article" ? "articles" : "inbox";
    const media = (f) => `${baseUrl}/media/${kindPrefix}/${r.date}/${r.slot}/${r.slug}/${f}`;
    const coverRel = r.kind === "article" ? r.coverPath : r.coverName;
    const coverUrl = coverRel ? media(coverRel) : "";
    const videoUrl = r.hasVideo ? media("video.mp4") : "";
    const dl = r.downloaded ? '<span class="chip ok">已下载 ✓</span>' : '<span class="chip no">未下载</span>';
    const kindChip = r.kind === "article" ? '<span class="kindc">图文</span>' : '<span class="kindc">视频</span>';
    const cover = coverUrl
      ? `<a class="cover" href="${coverUrl}" download title="点击下载封面"><img src="${coverUrl}" alt="封面" loading="lazy"></a>`
      : '<div class="cover empty-cover"></div>';

    let platformsHtml = "";
    const names = r.kind === "article" ? ARTICLE_PLATFORMS : VIDEO_PLATFORMS;
    for (const pname of names) {
      const p = (r.platforms && r.platforms[pname]) || null;
      if (!p) continue;
      const tags = Array.isArray(p.tags) ? p.tags : [];
      const allTags = tags.join("、");
      const bodyText = (p.body || "").replace(/\s+/g, " ").trim();
      platformsHtml += `
        <div class="pf">
          <span class="pf-name">${PLATFORM_LABEL[pname] || pname}</span>
          <button class="title" data-copy="${escHtml(p.title || "")}">${escHtml(p.title || "")}</button>
          <div class="tagrow">
            ${tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join("")}
            ${tags.length ? `<button class="copy-tags" data-copy="${escHtml(allTags)}" title="一键复制全部标签">⧉ 复制</button>` : ""}
          </div>
          ${bodyText ? `<div class="copyline" data-copy="${escHtml(p.body || "")}" title="点击复制正文"><span class="cl-label">正文</span><span class="cl-text">${escHtml(bodyText)}</span><span class="cl-copy">⧉ 复制</span></div>` : ""}
        </div>`;
    }
    if (!platformsHtml) platformsHtml = '<div class="pf muted">（无平台标题/标签）</div>';

    const actions = [];
    if (r.hasVideo) actions.push(`<a class="act" href="${videoUrl}" download="video.mp4">⬇ 下载视频</a>`);
    if (coverRel) actions.push(`<a class="act" href="${coverUrl}" download>⬇ 下载封面</a>`);

    return `
      <div class="item">
        ${cover}
        <div class="body">
          <div class="meta">
            <span class="date">${r.date}</span>
            <span class="slotchip">${SLOT_LABEL[r.slot] || r.slot}</span>
            ${kindChip}
            <span class="slug">${escHtml(r.slug)}</span>
            ${dl}
            <span class="pull">${r.pull_at ? ("下载于 " + r.pull_at.replace("T", " ").slice(0, 19)) : "-"}</span>
          </div>
          <div class="title-lg">${escHtml(r.title)}</div>
          ${platformsHtml}
          ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
        </div>
      </div>`;
  });

  const body = rows.length ? cards.join("") : '<div class="empty">暂无内容</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>CunFetch</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --accent:#6d28d9; --ok:#16a34a; --no:#dc2626; --soft:#f3eefc; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 16px 48px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
  h1 { font-size:22px; margin:0; display:flex; align-items:center; gap:10px; }
  .hk { display:flex; }
  .base { color:var(--accent); font-size:13px; text-decoration:none; font-weight:600; }
  .base:hover { text-decoration:underline; }
  .item { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; gap:16px; margin-bottom:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  .cover { flex:0 0 92px; width:92px; height:124px; overflow:hidden; border-radius:10px; border:1px solid var(--border); background:#eee; }
  .cover img { width:100%; height:100%; object-fit:cover; display:block; }
  .empty-cover { background:#f0edf8; }
  .body { flex:1; min-width:0; }
  .meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; font-size:12px; color:var(--muted); }
  .slotchip { background:var(--soft); color:var(--accent); padding:2px 8px; border-radius:999px; font-weight:600; }
  .chip { padding:2px 8px; border-radius:999px; }
  .chip.ok { color:var(--ok); background:#e9f9ee; }
  .chip.no { color:var(--no); background:#fdecec; }
  .kindc { background:#eef2ff; color:#4338ca; padding:2px 8px; border-radius:999px; font-weight:600; }
  .slug { opacity:.8; }
  .pull { margin-left:auto; }
  .title-lg { font-size:15px; font-weight:700; margin-bottom:8px; }
  .pf { margin:6px 0; padding:8px 10px; background:#fafafa; border-radius:10px; }
  .pf-name { display:inline-block; font-size:12px; color:var(--accent); font-weight:600; margin-right:10px; min-width:40px; }
  .title { font-size:14px; font-weight:600; background:none; border:none; padding:0; cursor:pointer; text-align:left; }
  .title:hover { color:var(--accent); }
  .title:after { content:" ⧉"; color:var(--muted); font-size:11px; opacity:.7; }
  .tagrow { margin-top:6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .tag { font-size:12px; background:#fff; border:1px solid var(--border); color:#444; border-radius:999px; padding:2px 10px; }
  .copy-tags { font-size:12px; background:var(--soft); color:var(--accent); border:none; border-radius:999px; padding:3px 10px; cursor:pointer; }
  .copy-tags:hover { background:#e5d8fb; }
  .copyline { margin-top:6px; display:flex; gap:8px; align-items:center; cursor:pointer; font-size:12px; color:#555; background:#fff; border:1px dashed var(--border); border-radius:8px; padding:4px 8px; }
  .copyline:hover { border-color:var(--accent); color:var(--accent); }
  .cl-label { flex:0 0 auto; color:var(--accent); font-weight:600; }
  .cl-text { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cl-copy { flex:0 0 auto; font-size:11px; opacity:.7; }
  .muted { color:var(--muted); font-style:italic; }
  .actions { display:flex; gap:10px; margin-top:12px; }
  .act { font-size:13px; color:var(--accent); text-decoration:none; border:1px solid var(--accent); border-radius:8px; padding:6px 12px; }
  .act:hover { background:var(--soft); }
  .empty { text-align:center; color:var(--muted); padding:40px 0; }
  .foot { margin-top:20px; color:var(--muted); font-size:12px; text-align:center; }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#222; color:#fff; padding:8px 16px; border-radius:8px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; z-index:9; }
  #toast.show { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="hk">
      <svg width="26" height="26" viewBox="0 0 128 128" fill="none" aria-hidden="true">
        <rect width="128" height="128" rx="28" fill="url(#clg)"/>
        <path d="M64 30 L64 76" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
        <path d="M44 58 L64 78 L84 58" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M40 30 L88 30 L88 92 Q88 96 84 96 L44 96 Q40 96 40 92 Z" fill="#fff" fill-opacity="0.16" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
        <defs><linearGradient id="clg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#a855f7"/>
        </linearGradient></defs>
      </svg>
    </span>CunFetch</h1>
    <a class="base" href="https://github.com/cunzhangcrypto/cunfetch" target="_blank" rel="noopener">GitHub</a>
  </header>
  <div id="list">${body}</div>
  <div class="foot">© 2026 CunFetch</div>
</div>
<div id="toast"></div>
<script>
  const toast = document.getElementById('toast');
  function show(msg){ toast.textContent=msg; toast.classList.add('show'); clearTimeout(show._t); show._t=setTimeout(()=>toast.classList.remove('show'),1600); }
  function copy(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>show('已复制：' + text)).catch(()=>fallback(text));
    } else fallback(text);
  }
  function fallback(text){
    const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy'); show('已复制：' + text);}catch(e){ show('复制失败'); }
    document.body.removeChild(ta);
  }
  document.querySelectorAll('[data-copy]').forEach(b=>{
    b.addEventListener('click',()=>copy(b.getAttribute('data-copy')));
  });
</script>
</body>
</html>`;
}