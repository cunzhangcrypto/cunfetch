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
 * 导出：renderDashboard(root, baseUrl), renderVideoDoc(docs), escHtml, FAVICON_SVG
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

// 页面共享样式与脚本（看板 / 中视频文稿页共用，保证两页视觉与交互一致）
const BASE_CSS = `
  :root { --bg:#f5f6f8; --card:#fff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --accent:#6d28d9; --ok:#16a34a; --no:#dc2626; --soft:#f3eefc; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 16px 48px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
  h1 { font-size:22px; margin:0; display:flex; align-items:center; gap:10px; }
  .hk { display:flex; }
  .nav { display:flex; gap:14px; }
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
  button.act { background:none; cursor:pointer; font-family:inherit; }
  .empty { text-align:center; color:var(--muted); padding:40px 0; }
  .foot { margin-top:20px; color:var(--muted); font-size:12px; text-align:center; }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#222; color:#fff; padding:8px 16px; border-radius:8px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; z-index:9; }
  #toast.show { opacity:1; }
`;

const TOAST_JS = `
  const toast = document.getElementById('toast');
  function show(msg){ toast.textContent=msg; toast.classList.add('show'); clearTimeout(show._t); show._t=setTimeout(()=>toast.classList.remove('show'),1600); }
  // 复制反馈：按钮型显示「✓ 已复制」后复原；列表项型整行短暂高亮
  function flash(el){
    if(!el || !el.classList) return false;
    const btn = el.classList.contains('cp-btn') ? el : el.querySelector('.cp-btn');
    if(btn){
      if(btn._t) clearTimeout(btn._t);
      if(!btn._label) btn._label = btn.textContent;
      btn.classList.add('done'); btn.textContent='✓ 已复制';
      btn._t = setTimeout(()=>{ btn.classList.remove('done'); btn.textContent=btn._label; btn._t=null; },1400);
      return true;
    }
    if(el.classList.contains('cp-item')){
      if(el._t) clearTimeout(el._t);
      el.classList.add('done'); el._t = setTimeout(()=>el.classList.remove('done'),900);
      return true;
    }
    return false;
  }
  function doneMsg(text, el){ return flash(el) ? '已复制' : ('已复制：' + text); }
  function copy(text, el){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>show(doneMsg(text, el))).catch(()=>fallback(text, el));
    } else fallback(text, el);
  }
  function fallback(text, el){
    const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select();
    try{document.execCommand('copy'); show(doneMsg(text, el));}catch(e){ show('复制失败'); }
    document.body.removeChild(ta);
  }
  document.querySelectorAll('[data-copy]').forEach(b=>{
    b.addEventListener('click',()=>copy(b.getAttribute('data-copy'), b));
  });
`;

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
          comment: (entry.comment || "").trim(),
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
    if (r.comment) actions.push(`<button class="act copy-comment" data-copy="${escHtml(r.comment)}" title="点击复制评论">💬 评论</button>`);

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
<style>${BASE_CSS}</style>
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
    <div class="nav">
      <a class="base" href="/video-doc">中视频文稿</a>
      <a class="base" href="https://github.com/cunzhangcrypto/cunfetch" target="_blank" rel="noopener">GitHub</a>
    </div>
  </header>
  <div id="list">${body}</div>
  <div class="foot">© 2026 CunFetch</div>
</div>
<div id="toast"></div>
<script>${TOAST_JS}</script>
</body>
</html>`;
}

// ---------------- 中视频文稿页（/video-doc） ----------------

const DOC_SECTION_LABEL = {
  youtube: "YouTube", bilibili: "B站", shipinhao: "视频号", blog: "博客", cover: "封面",
};

// 平台符号（简单符号，不用大 Logo，避免喧宾夺主）
const DOC_SECTION_ICON = {
  youtube: "▶", bilibili: "B", shipinhao: "视", blog: "文", cover: "图",
};

const DOC_FIELD_LABEL = {
  title_1: "标题 1（推荐）", title_2: "标题 2", title_3: "标题 3",
  description: "简介", chapters: "章节", tags: "标签",
  long_desc: "长文案", short_titles: "短标题", comment: "评论",
  title: "标题", alias: "别名", main: "主文案", sub: "副文案",
};

const DOC_META_LABEL = {
  slug: "slug", date: "日期", srt: "字幕", duration: "时长", blog_alias: "博客别名",
};

const DOC_CSS = `
  /* ---- 中视频文稿页（仅本页生效，不改看板）---- */
  .doc-wrap { max-width:1080px; }
  .doc + .doc { margin-top:14px; padding-top:26px; border-top:1px solid var(--border); }
  .doc-toggle { cursor:pointer; }
  .doc-toggle:focus-visible { outline:2px solid var(--accent); outline-offset:6px; border-radius:8px; }
  .doc-title { font-size:26px; line-height:1.36; font-weight:750; letter-spacing:.2px; color:#14171f; margin:0; }
  .caret { display:inline-block; margin-left:10px; font-size:15px; color:#a2a7b1; vertical-align:middle; transition:transform .16s, color .16s; }
  .doc-toggle:hover .caret { color:var(--accent); }
  .doc.open .caret { transform:rotate(-180deg); }
  .doc-body { display:none; padding-top:14px; }
  .doc.open .doc-body { display:block; }
  .doc-body .doc-badges { margin-bottom:18px; }
  .doc-badges { display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-flex; align-items:baseline; gap:6px; font-size:13px; color:#414855; background:#fff; border:1px solid var(--border); border-radius:8px; padding:5px 11px; }
  .badge b { font-size:11px; font-weight:600; color:#a2a7b1; }
  .badge.copy { cursor:pointer; transition:border-color .15s, color .15s, background .15s; }
  .badge.copy:hover { border-color:#d9c9f8; color:var(--accent); background:var(--soft); }
  .badge.done { border-color:var(--accent); color:var(--accent); background:var(--soft); }
  .badge.plain { color:#9aa0ab; }

  .pcard { background:#fff; border:1px solid var(--border); border-radius:12px; padding:8px 22px 20px; margin-bottom:18px; }
  .phead { display:flex; align-items:center; gap:10px; padding:12px 0 4px; }
  .pico { width:26px; height:26px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; border-radius:8px; background:var(--soft); color:var(--accent); font-size:12px; font-weight:700; }
  .pname { font-size:15.5px; font-weight:700; color:#14171f; margin:0; letter-spacing:.2px; }
  .pcount { margin-left:auto; font-size:12px; color:#a2a7b1; }

  .fld { margin-top:17px; }
  .fhead { display:flex; align-items:center; gap:8px; margin-bottom:7px; }
  .flabel { font-size:12px; font-weight:600; color:#8d93a0; letter-spacing:.04em; }
  .cp-btn { margin-left:auto; flex:0 0 auto; font-family:inherit; font-size:12px; line-height:1; color:#a2a7b1; background:none; border:1px solid transparent; border-radius:7px; padding:5px 9px; cursor:pointer; transition:color .15s, background .15s, border-color .15s; }
  .cp-btn:hover { color:var(--accent); background:var(--soft); border-color:#e7dcfb; }
  .cp-btn.done { color:#fff; background:var(--accent); border-color:var(--accent); }
  .ftext { font-size:15px; line-height:1.72; color:#22262f; word-break:break-word; }
  .ftext.pre { white-space:pre-wrap; }

  .taglist { display:flex; flex-wrap:wrap; gap:7px; }
  .tg { font-size:13px; color:#4b5563; background:#f6f7f9; border:1px solid #edeff2; border-radius:7px; padding:4px 10px; cursor:pointer; transition:color .15s, background .15s, border-color .15s; }
  .tg:hover { color:var(--accent); background:var(--soft); border-color:#e2d4f9; }
  .tg.done { color:var(--accent); background:var(--soft); border-color:var(--accent); }

  .tl { display:flex; flex-direction:column; gap:1px; }
  .tl-row { display:flex; gap:12px; align-items:baseline; padding:6px 8px; border-radius:8px; cursor:pointer; }
  .tl-row:hover { background:#faf8fe; }
  .tl-row.done { background:var(--soft); }
  .tl-time { flex:0 0 auto; min-width:42px; font-size:13px; font-weight:600; color:var(--accent); font-variant-numeric:tabular-nums; }
  .tl-text { flex:1; min-width:0; font-size:14px; line-height:1.6; color:#3b4150; }

  .numlist { display:flex; flex-direction:column; gap:3px; }
  .num-row { display:flex; gap:10px; align-items:center; padding:6px 8px; border-radius:8px; cursor:pointer; }
  .num-row:hover { background:#faf8fe; }
  .num-row.done { background:var(--soft); }
  .num-idx { flex:0 0 auto; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:var(--accent); background:var(--soft); border-radius:6px; }
  .num-text { flex:1; min-width:0; font-size:14.5px; line-height:1.6; color:#3b4150; }

  .doc-empty { text-align:center; color:var(--muted); padding:64px 0; }
  .hk svg { width:26px; height:26px; }

  @media (hover:none) { .cp-btn { color:var(--accent); background:var(--soft); } }
  @media (max-width:640px) {
    .doc-title { font-size:20px; }
    .pcard { padding:6px 15px 16px; border-radius:10px; }
    .ftext { font-size:14.5px; }
    .tl-time { min-width:38px; }
    header { flex-wrap:wrap; gap:10px; }
  }
`;

// 中视频文稿页交互：点击主标题展开/收起下方内容（默认收起）
const DOC_JS = `
  document.querySelectorAll('.doc-toggle').forEach(t=>{
    const art = t.closest('.doc');
    if(!art) return;
    const toggle = ()=>{
      const open = art.classList.toggle('open');
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    t.addEventListener('click', toggle);
    t.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(); }
    });
  });
`;

// 平台字段裁剪：youtube 的章节/标签与简介内容重复，页面不再单独展示
const DOC_SKIP = { youtube: new Set(["chapters", "tags"]) };

// 元信息胶囊（点击即复制该项）
function docBadge(label, value) {
  return `<span class="badge copy cp-item" data-copy="${escHtml(value)}" title="点击复制"><b>${escHtml(label)}</b>${escHtml(value)}</span>`;
}

// 字段块：字段名一行（右侧低调复制按钮）+ 内容
function docFld(label, value, innerHtml) {
  return `
    <div class="fld">
      <div class="fhead">
        <span class="flabel">${escHtml(label)}</span>
        <button class="cp-btn" data-copy="${escHtml(String(value ?? ""))}" title="复制「${escHtml(label)}」">复制</button>
      </div>
      ${innerHtml}
    </div>`;
}

// 按字段类型渲染内容：标签→Badge、章节→时间轴、编号项→序号列表、其余→正文
function docFieldBody(f) {
  const value = String(f.value ?? "");
  const key = f.key || "";
  if (key === "tags") {
    const tags = value.split(/[\s、,，]+/).map((s) => s.trim()).filter(Boolean);
    if (!tags.length) return '<div class="ftext muted">—</div>';
    return `<div class="taglist">${tags.map((t) => `<span class="tg cp-item" data-copy="${escHtml(t)}" title="点击复制">${escHtml(t)}</span>`).join("")}</div>`;
  }
  if (key === "chapters") {
    const rows = value.split("\n").map((s) => s.trim()).filter(Boolean).map((l) => {
      const m = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/.exec(l);
      return `<div class="tl-row cp-item" data-copy="${escHtml(l)}" title="点击复制"><span class="tl-time">${escHtml(m ? m[1] : "·")}</span><span class="tl-text">${escHtml(m ? m[2] : l)}</span></div>`;
    }).join("");
    return `<div class="tl">${rows}</div>`;
  }
  if (f.items && f.items.length) {
    const rows = f.items.map((it, i) => `<div class="num-row cp-item" data-copy="${escHtml(it)}" title="点击复制"><span class="num-idx">${i + 1}</span><span class="num-text">${escHtml(it)}</span></div>`).join("");
    return `<div class="numlist">${rows}</div>`;
  }
  const multi = value.includes("\n");
  return `<div class="ftext${multi ? " pre" : ""}">${escHtml(value)}</div>`;
}

function docDisplayTitle(d) {
  const get = (sec, key) => {
    const s = (d.sections || []).find((x) => x.name === sec);
    const f = s && (s.fields || []).find((x) => x.key === key);
    return f ? f.value : "";
  };
  return get("blog", "title") || get("youtube", "title_1") || d.title || d.slug || "";
}

export function renderVideoDoc(docs) {
  const cards = (docs || []).map((d) => {
    const meta = d.meta || [];
    const seen = new Set(meta.map((m) => m.key));
    const badges = meta.map((m) => docBadge(DOC_META_LABEL[m.key] || m.key, m.value));
    if (!seen.has("slug") && d.slug) badges.push(docBadge("slug", d.slug));
    if (!seen.has("date") && d.dateYmd) badges.push(docBadge("日期", d.dateYmd));
    const up = String(d.uploaded_at || "").replace("T", " ").slice(0, 19);
    if (up) badges.push(`<span class="badge plain">上传于 ${escHtml(up)}</span>`);

    const secHtml = (d.sections || [])
      .filter((s) => s.name !== "meta" && (s.fields || []).length)
      .map((s) => {
        const skip = DOC_SKIP[s.name];
        const fields = (s.fields || []).filter((f) => !(skip && skip.has(f.key)));
        if (!fields.length) return "";
        const body = fields.map((f) => {
          const label = DOC_FIELD_LABEL[f.key] || f.raw || f.key;
          return docFld(label, f.value ?? "", docFieldBody(f));
        }).join("");
        return `
        <section class="pcard">
          <div class="phead">
            <span class="pico">${escHtml(DOC_SECTION_ICON[s.name] || "•")}</span>
            <h2 class="pname">${escHtml(DOC_SECTION_LABEL[s.name] || s.name)}</h2>
            <span class="pcount">${fields.length} 项内容</span>
          </div>
          ${body}
        </section>`;
      }).join("");

    return `
      <article class="doc">
        <div class="doc-hero doc-toggle" role="button" tabindex="0" aria-expanded="false" title="点击展开 / 收起">
          <h2 class="doc-title">${escHtml(docDisplayTitle(d))}<span class="caret">▾</span></h2>
        </div>
        <div class="doc-body">
          ${badges.length ? `<div class="doc-badges">${badges.join("")}</div>` : ""}
          ${secHtml}
        </div>
      </article>`;
  }).join("");

  const body = cards || '<div class="doc-empty">暂无中视频文稿</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>中视频文稿 · CunFetch</title>
<style>${BASE_CSS}${DOC_CSS}</style>
</head>
<body>
<div class="wrap doc-wrap">
  <header>
    <h1><span class="hk">${FAVICON_SVG}</span>中视频文稿</h1>
    <div class="nav">
      <a class="base" href="/">素材看板</a>
      <a class="base" href="https://github.com/cunzhangcrypto/cunfetch" target="_blank" rel="noopener">GitHub</a>
    </div>
  </header>
  <div id="list">${body}</div>
  <div class="foot">© 2026 CunFetch</div>
</div>
<div id="toast"></div>
<script>${TOAST_JS}${DOC_JS}</script>
</body>
</html>`;
}