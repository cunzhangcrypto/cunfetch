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
import { renderDashboard, FAVICON_SVG } from "./dashboard.js";

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