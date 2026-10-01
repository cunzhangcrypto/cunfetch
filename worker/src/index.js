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

  // 读每个 slug 的 status.json
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
      }
    }
  }
  return root;
}

function renderDashboard(root, baseUrl) {
  // 扁平化为行，按 date/slot 排序
  const rows = [];
  const dates = Object.keys(root).sort().reverse();
  for (const date of dates) {
    for (const slot of ["early", "mid", "late"]) {
      if (!root[date][slot]) continue;
      for (const slug of Object.keys(root[date][slot])) {
        const entry = root[date][slot][slug];
        const files = Object.entries(entry.files);
        const hasVideo = files.some(([f]) => f === "video.mp4");
        const hasPlatforms = files.some(([f]) => f === "platforms.json");
        const st = entry.status || {};
        rows.push({ date, slot, slug, hasVideo, hasPlatforms, downloaded: Boolean(st.downloaded), pull_at: st.pull_at || null, local_size: st.local_size || null });
      }
    }
  }
  const slotLabel = { early: "早 09:05", mid: "中 12:10", late: "晚 19:08" };
  const rowsHtml = rows
    .map(
      (r) => `
      <tr>
        <td>${r.date}</td>
        <td>${slotLabel[r.slot] || r.slot}</td>
        <td>${r.slug}</td>
        <td>${r.hasVideo ? "✓" : "-"}</td>
        <td>${r.hasPlatforms ? "✓" : "-"}</td>
        <td>${r.downloaded ? '<span class="ok">已下载 ✓</span>' : '<span class="no">未下载</span>'}</td>
        <td>${r.pull_at ? r.pull_at.replace("T", " ").slice(0, 19) : "-"}</td>
        <td>${r.local_size ? (r.local_size / 1048576).toFixed(1) + " MB" : "-"}</td>
      </tr>`
    )
    .join("");
  const body = rows
    ? rowsHtml
    : `<tr><td colspan="8" class="empty">暂无内容</td></tr>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>CunFetch</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --accent:#6d28d9; --ok:#16a34a; --no:#dc2626; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:32px 20px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
  h1 { font-size:22px; margin:0; display:flex; align-items:center; gap:10px; }
  .hk { color:var(--accent); }
  .base { color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--border); }
  th { background:#fafafa; color:var(--muted); font-weight:600; font-size:12px; }
  tr:last-child td { border-bottom:none; }
  .ok { color:var(--ok); font-weight:600; }
  .no { color:var(--no); }
  .empty { text-align:center; color:var(--muted); padding:32px; }
  .foot { margin-top:20px; color:var(--muted); font-size:12px; }
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
  <div class="card">
    <table>
      <thead><tr><th>日期</th><th>档位</th><th>内容 slug</th><th>视频</th><th>标题/标签</th><th>下载状态</th><th>下载时间</th><th>大小</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <div class="foot">© 2026 CunFetch</div>
</div>
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