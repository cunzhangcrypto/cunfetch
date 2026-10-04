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
 *   inbox/<yyyymmdd>/<slot>/<slug>/status.json           ← 本地上报后由本 Worker 写入
 *   articles/<yyyymmdd>/<slot>/<slug>/<平台>/article.json | cover.<ext> ...  ← 自媒体图文
 * slot ∈ early | mid | late
 */

const SLOTS = new Set(["early", "mid", "late"]);
const PREFIX = "inbox";
const ARTICLE_PREFIX = "articles"; // 自媒体图文（worker 端解压后按 平台/文件 存）
// 图文各平台子目录名（中英文都认），用于剥离 zip 外层包裹目录
const PLATFORM_DIRS = new Set([
  "wechat", "微信公众号", "微信",
  "xiaohongshu", "小红书",
  "toutiao", "今日头条", "头条",
  "baijiahao", "百家号",
  "zhihu", "知乎",
]);

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

// 按扩展名推断 content-type（存 R2 / 下载时用）
function contentTypeFor(name) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

// 若压缩包所有条目同处一个顶层目录、且该目录不是平台名，则返回该目录（应剥离）
function stripCommonWrapper(names) {
  const tops = new Set();
  for (const raw of names) {
    const s = String(raw || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!s) continue;
    tops.add(s.split("/")[0]);
  }
  if (tops.size === 1) {
    const top = [...tops][0];
    if (!PLATFORM_DIRS.has(top) && !PLATFORM_DIRS.has(top.toLowerCase())) return top;
  }
  return null;
}

async function readUploadMultipart(request) {
  // 用 FormData 解析 multipart。通用字段：slot / date / type(默认 video)。
  //   video   ：可一次带多个 file（platforms.json + 封面 + video.mp4），另需 slug
  //   article ：带一个图文 zip（内含各平台子目录），标题取自 zip 文件名，slug 可省（由标题派生）
  const form = await request.formData();
  const files = form.getAll("file");
  if (!files || files.length === 0) throw new Error("缺少 file 字段（至少一个）");
  const slotRaw = form.get("slot");
  if (!SLOTS.has(slotRaw)) throw new Error("slot 必须为 early|mid|late");
  const date = parseDate(form.get("date"));
  const type = String(form.get("type") || "video").toLowerCase();

  if (type === "article") {
    const zipFile = files.find((f) => f instanceof File && /\.zip$/i.test(f.name || ""))
      || files.find((f) => f instanceof File);
    if (!zipFile) throw new Error("图文上传需提供 zip 文件");
    const title = (zipFile.name || "").replace(/\.[^.]+$/, "").trim();
    if (!title) throw new Error("无法从 zip 文件名取得标题");
    const slug = sanitizeSlug(form.get("slug") || title);
    if (!slug) throw new Error("slug 清洗后为空");
    const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    return {
      type: "article", slug, slot: slotRaw, date, title,
      zipName: zipFile.name || "bundle.zip", zipBytes,
    };
  }

  const slugRaw = form.get("slug");
  if (!slugRaw) throw new Error("缺少 slug 字段");
  const slug = sanitizeSlug(slugRaw);
  if (!slug) throw new Error("slug 清洗后为空");

  // 分流三类（若某 file 是 zip 压缩包则先解压再分流）：
  //   json → platforms.json；图片 → cover.<ext>；其余 → video.mp4
  const parts = [];
  for (const f of files) {
    if (!(f instanceof File)) continue;
    const name = f.name || "";
    const ftype = f.type || "";
    const bytes = new Uint8Array(await f.arrayBuffer());

    if (/\.zip$/i.test(name) || /zip/i.test(ftype)) {
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
      classifyFile(name, ftype, bytes, parts);
    }
  }
  if (parts.length === 0) throw new Error("没有可上传的文件");
  return { type: "video", slug, slot: slotRaw, date, parts };
}

async function handleUpload(request, env) {
  let parsed;
  try {
    parsed = await readUploadMultipart(request);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }

  if (parsed.type === "article") {
    // 图文：解压 zip → 按 <平台>/<文件> 存入 R2（看板可读各平台标题/标签/封面），并写 meta.json
    const { slug, slot, date, title, zipName, zipBytes } = parsed;
    const base = `${ARTICLE_PREFIX}/${date}/${slot}/${slug}`;
    let zip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch (e) {
      return json({ ok: false, error: "zip 解析失败: " + e.message }, 400);
    }
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    const wrapper = stripCommonWrapper(entries.map((e) => e.name));
    const written = [];
    for (const entry of entries) {
      let rel = entry.name.replace(/\\/g, "/");
      if (wrapper) {
        if (rel === wrapper || rel === wrapper + "/") continue;
        if (rel.startsWith(wrapper + "/")) rel = rel.slice(wrapper.length + 1);
      }
      rel = rel.replace(/^\/+|\/+$/g, "");
      if (!rel || rel.includes("..")) continue;
      const bytes = new Uint8Array(await entry.async("arraybuffer"));
      const key = `${base}/${rel}`;
      const put = await env.INBOX.put(key, bytes, { httpMetadata: { contentType: contentTypeFor(rel) } });
      written.push({ key, etag: put.httpEtag || put.etag });
    }
    if (written.length === 0) return json({ ok: false, error: "zip 内没有可用文件" }, 400);
    const meta = { title, original: zipName, slug, slot, date, uploaded_at: new Date().toISOString() };
    const mp = await env.INBOX.put(`${base}/meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    });
    written.push({ key: `${base}/meta.json`, etag: mp.httpEtag || mp.etag });
    return json({ ok: true, type: "article", title, slug, slot, date, files: written });
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
  return json({ ok: true, type: "video", slug, slot, date, files: written });
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
  const kind = body.kind === "article" ? "article" : "video";
  const prefix = kind === "article" ? ARTICLE_PREFIX : PREFIX;
  const statusKey = `${prefix}/${date}/${slot}/${slug}/status.json`;
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

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const res = cursor
      ? await env.INBOX.list({ prefix, cursor })
      : await env.INBOX.list({ prefix });
    out.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

function normalizeTags(t) {
  if (Array.isArray(t)) return t.map((s) => String(s).trim()).filter(Boolean);
  if (typeof t === "string") return t.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// 取评论：优先 platforms.shipinhao.comment，其次任一平台的 comment，最后顶层 comment
function pickComment(parsed, plats) {
  const fromPlat = (p) => (p && typeof p.comment === "string" ? p.comment.trim() : "");
  if (plats) {
    const sh = fromPlat(plats.shipinhao);
    if (sh) return sh;
    for (const k of Object.keys(plats)) {
      const c = fromPlat(plats[k]);
      if (c) return c;
    }
  }
  return parsed && typeof parsed.comment === "string" ? parsed.comment.trim() : "";
}

async function collectBucket(env) {
  // 汇总两条线：inbox/（视频）与 articles/（自媒体图文），统一到 root[date][slot][slug]
  const root = {};
  const ensure = (date, slot, slug, kind) => {
    if (!root[date]) root[date] = {};
    if (!root[date][slot]) root[date][slot] = {};
    if (!root[date][slot][slug]) root[date][slot][slug] = { kind, files: {}, status: null };
    return root[date][slot][slug];
  };

  // 视频线：inbox/<date>/<slot>/<slug>/<file>
  for (const obj of await listAll(env, PREFIX + "/")) {
    const parts = obj.key.split("/");
    if (parts.length < 5) continue;
    const [, date, slot, slug, file] = parts;
    ensure(date, slot, slug, "video").files[file] =
      { size: obj.size, etag: obj.etag, uploaded_at: obj.uploaded };
  }

  // 图文线：articles/<date>/<slot>/<slug>/<平台>/<file>
  for (const obj of await listAll(env, ARTICLE_PREFIX + "/")) {
    const parts = obj.key.split("/");
    if (parts.length < 6) continue;
    const [, date, slot, slug] = parts;
    const rel = parts.slice(4).join("/");
    ensure(date, slot, slug, "article").files[rel] =
      { size: obj.size, etag: obj.etag, uploaded_at: obj.uploaded };
  }

  // 补 title / platforms / cover / status
  for (const date of Object.keys(root)) {
    for (const slot of Object.keys(root[date])) {
      for (const slug of Object.keys(root[date][slot])) {
        const entry = root[date][slot][slug];
        const base = `${entry.kind === "article" ? ARTICLE_PREFIX : PREFIX}/${date}/${slot}/${slug}`;
        entry.title = "";
        entry.platforms = null;
        entry.coverPath = null;
        entry.comment = "";

        // 本地下载状态（status.json 由 feedback 写入）
        try {
          const st = await env.INBOX.get(`${base}/status.json`);
          if (st) entry.status = JSON.parse(await st.text());
        } catch (e) { /* ignore */ }

        if (entry.kind === "article") {
          // 各平台 article.json → {平台: {title, tags}}；封面取首个平台的 cover.*
          const dirs = [...new Set(Object.keys(entry.files).map((r) => r.split("/")[0]))];
          const platforms = {};
          for (const dir of dirs) {
            const jrel = entry.files[`${dir}/article.json`]
              ? `${dir}/article.json`
              : Object.keys(entry.files).find((r) => r.startsWith(dir + "/") && r.endsWith(".json"));
            if (jrel) {
              try {
                const j = JSON.parse(await (await env.INBOX.get(`${base}/${jrel}`)).text());
                platforms[dir] = {
                  title: j.title || "",
                  tags: normalizeTags(j.tags != null ? j.tags : j.keywords),
                  body: String(j.body != null ? j.body : (j.content != null ? j.content : (j.markdown != null ? j.markdown : ""))),
                };
              } catch (e) { /* ignore */ }
            }
            if (!entry.coverPath) {
              const c = Object.keys(entry.files).find(
                (r) => r.startsWith(dir + "/") && /\.(png|jpe?g|webp|gif)$/i.test(r) && !/inline/i.test(r));
              if (c) entry.coverPath = c;
            }
          }
          entry.platforms = Object.keys(platforms).length ? platforms : null;
          try {
            const mj = await env.INBOX.get(`${base}/meta.json`);
            if (mj) entry.title = (JSON.parse(await mj.text()).title) || "";
          } catch (e) { /* ignore */ }
        } else {
          // 视频线：platforms.json → title + 三平台标题/标签
          try {
            const pj = await env.INBOX.get(`${base}/platforms.json`);
            if (pj) {
              const parsed = JSON.parse(await pj.text());
              entry.title = (parsed && parsed.title) || "";
              const plats = (parsed && parsed.platforms) || null;
              entry.platforms = plats;
              // 评论：muse 通常挂在 platforms.shipinhao.comment，兜底扫各平台，再兜底顶层 comment
              entry.comment = pickComment(parsed, plats);
            }
          } catch (e) { entry.title = ""; }
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

    // 文件下载：/media/<完整对象键>（inbox/... 或 articles/...）
    if (path.startsWith("/media/")) {
      const key = decodeURIComponent(path.slice("/media/".length));
      const obj = await env.INBOX.get(key);
      if (!obj) return json({ ok: false, error: "文件不存在: " + key }, 404);
      const fname = key.split("/").pop();
      return new Response(obj.body, {
        headers: {
          "content-type": contentTypeFor(key),
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