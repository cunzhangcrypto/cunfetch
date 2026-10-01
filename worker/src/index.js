/**
 * CunFetch Inbox — Cloudflare Worker
 *
 * 云端收件箱 API + R2 存储 + 看板页面。
 * - POST /api/upload     muse 上传视频 / platforms.json
 * - POST /api/feedback   本地下载完成后上报状态
 * - GET  /api/objects    汇总各 slug 对象与下载状态
 * - GET  /api/health     免鉴权连通性探测
 * - GET  /              看板 HTML（明亮主题单页）
 *
 * 鉴权：Authorization: Bearer <WORKER_API_TOKEN>（env secret）
 * R2 binding：INBOX（wrangler.toml [[r2_buckets]]）
 *
 * 对象键规则：
 *   inbox/<yyyymmdd>/<slot>/<slug>/video.mp4
 *   inbox/<yyyymmdd>/<slot>/<slug>/platforms.json
 *   inbox/<yyyymmdd>/<slot>/<slug>/status.json   ← 本地上报后由本 Worker 写入
 * slot ∈ early | mid | late
 */

const SLOTS = new Set(["early", "mid", "late"]);
const PREFIX = "inbox";

// 文件名/内容类型 → 目标对象文件名，便于扩展
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

import JSZip from "jszip";

function classifyFile(name, type, bytes, outParts) {
  // json → platforms.json；图片 → cover.<ext>；zip 由调用方先行解压；其余 → video.mp4
  if (/\bjson\b/i.test(type || "") || /\.json$/i.test(name || "")) {
    outParts.push({ filename: "platforms.json", bytes });
  } else if (/^image\//i.test(type || "") || IMAGE_RE.test(name || "")) {
    const ext = (/(\.[a-z0-9]+)$/i.exec(name || "") || [null, ".png"])[1].toLowerCase();
    outParts.push({ filename: `cover${ext}`, bytes });
  } else {
    outParts.push({ filename: "video.mp4", bytes }); // 一篇只收一个视频，后者覆盖
  }
}

const FAVICON_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#fg)"/>
  <path d="M64 30 L64 76" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
  <path d="M44 58 L64 78 L84 58" stroke="#ffffff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M40 30 L88 30 L88 92 Q88 96 84 96 L44 96 Q40 96 40 92 Z" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

// 常数时间比较，防时序侧信道
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const expected = env.WORKER_API_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(token, expected);
}

function sanitizeSlug(raw) {
  const slug = String(raw || "")
    .toLowerCase()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim()
    .replace(/^\.+/, "");
  return slug ? slug.slice(0, 80).replace(/[_\s]+$/, "") : "";
}

function todayCN() {
  const now = new Date();
  // Asia/Shanghai 固定 UTC+8
  const u = now.getTime() + 8 * 3600 * 1000;
  const d = new Date(u);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseDate(raw) {
  if (typeof raw === "string" && /^\d{8}$/.test(raw)) return raw;
  return todayCN();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readUploadMultipart(request) {
  // 用 FormData 解析 multipart：可一次带多个 file（platforms.json + video.mp4）
  // 其他字段：slug / slot / date
  const form = await request.formData();
  const files = form.getAll("file");
  if (!files || files.length === 0) throw new Error("缺少 file 字段（至少一个）");
  const slugRaw = form.get("slug");
  const slotRaw = form.get("slot");
  const dateRaw = form.get("date");
  if (!slugRaw) throw new Error("缺少 slug 字段");
  const slug = sanitizeSlug(slugRaw);
  if (!slug) throw new Error("slug 清洗后为空");
  if (!SLOTS.has(slotRaw)) throw new Error("slot 必须为 early|mid|late");
  const date = parseDate(dateRaw);

  // 分流三类（若某 file 是 zip 压缩包则先解压再分流）：
  //   json → platforms.json；图片 → cover.<ext>；其余 → video.mp4
  const parts = [];
  for (const f of files) {
    if (!(f instanceof File)) continue;
    const name = f.name || "";
    const type = f.type || "";
    const bytes = new Uint8Array(await f.arrayBuffer());

    if (/\.zip$/i.test(name) || /zip/i.test(type)) {
      // zip 压缩包：解压后按内部文件名逐条分流（支持任意层级目录，取 basename）
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files);
      for (const entry of entries) {
        if (entry.dir) continue;
        const inner = entry.name.replace(/\\/g, "/").split("/").pop();
        if (!inner) continue;
        const innerBytes = new Uint8Array(await entry.async("arraybuffer"));
        classifyFile(inner, "", innerBytes, parts);
      }
    } else {
      classifyFile(name, type, bytes, parts);
    }
  }
  if (parts.length === 0) throw new Error("没有可上传的文件");
  return { slug, slot: slotRaw, date, parts };
}

async function handleUpload(request, env) {
  let parsed;
  try {
    parsed = await readUploadMultipart(request);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
  const { slug, slot, date, parts } = parsed;
  const written = [];
  for (const p of parts) {
    const key = `${PREFIX}/${date}/${slot}/${slug}/${p.filename}`;
    const put = await env.INBOX.put(key, p.bytes, {
      httpMetadata: { contentType: p.filename.endsWith(".json") ? "application/json" : "video/mp4" },
    });
    written.push({ key, etag: put.httpEtag || put.etag });
  }
  return json({ ok: true, slug, slot, date, files: written });
}

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "body 不是合法 JSON" }, 400);
  }
  const slug = sanitizeSlug(body.slug);
  const slot = body.slot;
  const date = parseDate(body.date);
  if (!slug || !SLOTS.has(slot)) {
    return json({ ok: false, error: "缺少有效 slug/slot" }, 400);
  }
  const statusKey = `${PREFIX}/${date}/${slot}/${slug}/status.json`;
  const existing = await env.INBOX.get(statusKey);
  let record = {};
  if (existing) {
    try {
      record = JSON.parse(await existing.text());
    } catch (e) {
      /* ignore */
    }
  }
  const updated = {
    ...record,
    downloaded: Boolean(body.downloaded),
    pull_at: body.pull_at || new Date().toISOString(),
    local_size: typeof body.local_size === "number" ? body.local_size : record.local_size ?? null,
    attempts: (record.attempts || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  await env.INBOX.put(statusKey, JSON.stringify(updated), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ ok: true, key: statusKey, status: updated });
}

async function collectBucket(env) {
  // 遍历 inbox/ 前缀，按 date/slot/slug 汇总
  const root = {};
  let cursor;
  do {
    const listRes = cursor ? await env.INBOX.list({ prefix: PREFIX + "/", cursor }) : await env.INBOX.list({ prefix: PREFIX + "/" });
    for (const obj of listRes.objects) {
      const parts = obj.key.split("/");
      // inbox/<date>/<slot>/<slug>/<file>
      if (parts.length < 5) continue;
      const [, date, slot, slug, file] = parts;
      if (!root[date]) root[date] = {};
      if (!root[date][slot]) root[date][slot] = {};
      if (!root[date][slot][slug]) root[date][slot][slug] = { files: {}, status: null };
      const entry = root[date][slot][slug];
      entry.files[file] = { size: obj.size, etag: obj.etag, uploaded_at: obj.uploaded };
    }
    cursor = listRes.truncated ? listRes.cursor : undefined;
  } while (cursor);

  // 读每个 slug 的 status.json 与 platforms.json（取 title + 三平台标题/标签供看板显示）
  for (const date of Object.keys(root)) {
    for (const slot of Object.keys(root[date])) {
      for (const slug of Object.keys(root[date][slot])) {
        const entry = root[date][slot][slug];
        const status = await env.INBOX.get(`${PREFIX}/${date}/${slot}/${slug}/status.json`);
        if (status) {
          try {
            entry.status = JSON.parse(await status.text());
          } catch (e) {
            entry.status = { downloaded: false };
          }
        }
        // 从 platforms.json 读 title + platforms（三平台标题/标签）
        entry.title = "";
        entry.platforms = null;
        try {
          const pj = await env.INBOX.get(`${PREFIX}/${date}/${slot}/${slug}/platforms.json`);
          if (pj) {
            const parsed = JSON.parse(await pj.text());
            entry.title = (parsed && parsed.title) || "";
            entry.platforms = (parsed && parsed.platforms) || null;
          }
        } catch (e) {
          entry.title = "";
        }
      }
    }
  }
  return root;
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderDashboard(root, baseUrl) {
  // 扁平化为行，按 date/slot 排序
  const rows = [];
  const dates = Object.keys(root).sort().reverse();
  const SLOT_LABEL = { early: "早 09:05", mid: "中 12:10", late: "晚 19:08" };
  const PLATFORM_LABEL = { douyin: "抖音", bilibili: "B站", shipinhao: "视频号" };
  for (const date of dates) {
    for (const slot of ["early", "mid", "late"]) {
      if (!root[date][slot]) continue;
      for (const slug of Object.keys(root[date][slot])) {
        const entry = root[date][slot][slug];
        const files = Object.entries(entry.files);
        const fnames = files.map(([f]) => f);
        const hasVideo = fnames.includes("video.mp4");
        const hasPlatforms = fnames.includes("platforms.json");
        // cover.<ext>
        const coverName = fnames.find((f) => f.startsWith("cover.")) || null;
        const st = entry.status || {};
        const title = (entry.title || "").trim() || slug;
        rows.push({
          date, slot, slug, title,
          coverName, hasVideo, hasPlatforms,
          platforms: entry.platforms || null,
          downloaded: Boolean(st.downloaded), pull_at: st.pull_at || null,
          local_size: st.local_size || null,
          baseUrl,
        });
      }
    }
  }

  const cards = rows.map((r) => {
    const coverUrl = r.coverName ? `${r.baseUrl}/media/${r.date}/${r.slot}/${r.slug}/${r.coverName}` : "";
    const videoUrl = r.hasVideo ? `${r.baseUrl}/media/${r.date}/${r.slot}/${r.slug}/video.mp4` : "";
    const dl = r.downloaded
      ? '<span class="chip ok">已下载 ✓</span>'
      : '<span class="chip no">未下载</span>';
    const cover = coverUrl
      ? `<a class="cover" href="${coverUrl}" download title="点击下载封面"><img src="${coverUrl}" alt="封面" loading="lazy"></a>`
      : '<div class="cover empty-cover"></div>';

    const pfNames = ["douyin", "bilibili", "shipinhao"];
    let platformsHtml = "";
    for (const pname of pfNames) {
      const p = (r.platforms && r.platforms[pname]) || null;
      if (!p) continue;
      const tags = Array.isArray(p.tags) ? p.tags : [];
      const allTags = tags.join("、");
      const titleBtn = `<button class="title" data-copy="${escHtml(p.title || "")}">${escHtml(p.title || "")}</button>`;
      const tagsHtml = tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join("");
      platformsHtml += `
        <div class="pf">
          <span class="pf-name">${PLATFORM_LABEL[pname] || pname}</span>
          ${titleBtn}
          <div class="tagrow">
            ${tagsHtml}
            <button class="copy-tags" data-copy="${escHtml(allTags)}" title="一键复制全部标签">⧉ 复制</button>
          </div>
        </div>`;
    }
    if (!platformsHtml) platformsHtml = '<div class="pf muted">（无平台标题/标签）</div>';

    const actions = [];
    if (r.hasVideo) actions.push(`<a class="act" href="${videoUrl}" download="video.mp4">⬇ 下载视频</a>`);
    if (r.coverName) actions.push(`<a class="act" href="${coverUrl}" download>⬇ 下载封面</a>`);

    return `
      <div class="item">
        ${cover}
        <div class="body">
          <div class="meta">
            <span class="date">${r.date}</span>
            <span class="slotchip">${SLOT_LABEL[r.slot] || r.slot}</span>
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
  .base { color:var(--muted); font-size:13px; }
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
        <rect width="128" height="128" rx="28" fill="url(#lg)"/>
        <path d="M64 30 L64 76" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
        <path d="M44 58 L64 78 L84 58" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M40 30 L88 30 L88 92 Q88 96 84 96 L44 96 Q40 96 40 92 Z" fill="#fff" fill-opacity="0.16" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
        <defs><linearGradient id="lg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#a855f7"/>
        </linearGradient></defs>
      </svg>
    </span>CunFetch</h1>
    <span class="base">${baseUrl}</span>
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
  document.querySelectorAll('button[data-copy]').forEach(b=>{
    b.addEventListener('click',()=>copy(b.getAttribute('data-copy')));
  });
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = `${url.protocol}//${url.host}`;

    if (path === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    if (path === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      });
    }

    // 文件下载：/media/<date>/<slot>/<slug>/<file>
    if (path.startsWith("/media/")) {
      const rest = decodeURIComponent(path.slice("/media/".length));
      const key = `${PREFIX}/${rest}`;
      const obj = await env.INBOX.get(key);
      if (!obj) return json({ ok: false, error: "文件不存在: " + key }, 404);
      const isJson = key.endsWith(".json");
      const contentType = isJson ? "application/json" : (key.endsWith(".mp4") ? "video/mp4" : "image/png");
      const fname = key.split("/").pop();
      return new Response(obj.body, {
        headers: {
          "content-type": contentType,
          "content-disposition": `attachment; filename="${fname}"`,
          "content-length": String(obj.size || ""),
        },
      });
    }

    if (path === "/api/objects" || path === "/") {
      if (path === "/api/objects" && !authorized(request, env)) {
        return json({ ok: false, error: "未授权" }, 401);
      }
      const root = await collectBucket(env);
      if (path === "/api/objects") return json({ ok: true, items: root });
      return new Response(renderDashboard(root, origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/upload" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, error: "未授权" }, 401);
      return handleUpload(request, env);
    }

    if (path === "/api/feedback" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, error: "未授权" }, 401);
      return handleFeedback(request, env);
    }

    return json({ ok: false, error: "未找到路由: " + path }, 404);
  },
};