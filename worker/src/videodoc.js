/**
 * 中视频文稿（muse 上传的「名称.md」）解析 —— 格式 v1
 *
 * 约定（由文稿首部注释声明，顺序与字段名固定）：
 *   # <标题>
 *   ## meta          → 用 "- key: value" 列表（slug / date / srt / duration / blog_alias）
 *   ## youtube       → ### title_1（推荐） / title_2 / title_3 / description / chapters / tags
 *   ## bilibili      → 同上（title_* / description）
 *   ## shipinhao     → ### long_desc / short_titles（编号列表）/ comment
 *   ## blog          → ### title / alias
 *   ## cover         → ### main / sub
 *
 * 多行内容用 ``` 代码块包裹（围栏本身不保留）；单行字段直接写值。
 *
 * 解析结果：
 *   {
 *     title, slug, dateYmd,
 *     meta:     [{ key, value }],
 *     sections: [{ name, fields: [{ key, raw, value, multi, items? }] }],
 *   }
 */

const NUMBERED = /^\s*\d+\s*[.、)]\s*/;
const META_LINE = /^-\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const FIELD_NAME = /^([A-Za-z_][\w-]*)/;

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n").trim();
}

// 编号列表（如视频号 short_titles）→ 拆成单项，便于逐个复制
function splitNumbered(value) {
  const ls = value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!ls.length || !ls.every((l) => NUMBERED.test(l))) return null;
  return ls.map((l) => l.replace(NUMBERED, "").trim()).filter(Boolean);
}

function mkField(rawName) {
  const key = (FIELD_NAME.exec(rawName) || [null, rawName.trim()])[1];
  return { key, raw: rawName.trim(), value: "", multi: false };
}

export function ymdFrom(raw) {
  const d = String(raw || "").trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(d);
  if (m) return `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`;
  return /^\d{8}$/.test(d) ? d : "";
}

export function slugify(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseVideoDoc(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const doc = { title: "", slug: "", dateYmd: "", meta: [], sections: [] };
  let section = null;
  let field = null;
  let buf = [];
  let inFence = false;

  const flush = () => {
    if (!field) return;
    field.value = trimBlank(buf);
    field.multi = field.value.includes("\n");
    const items = field.multi ? splitNumbered(field.value) : null;
    if (items) field.items = items;
    buf = [];
    field = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line.trim())) {
      inFence = !inFence; // 围栏本身不入值
      continue;
    }
    if (!inFence) {
      if (/^###\s+/.test(line)) {
        flush();
        field = mkField(line.slice(4).trim());
        if (section) section.fields.push(field);
        continue;
      }
      if (/^##\s+/.test(line)) {
        flush();
        section = { name: line.slice(3).trim().toLowerCase(), fields: [] };
        doc.sections.push(section);
        continue;
      }
      if (/^#\s+/.test(line)) {
        flush();
        if (!doc.title) doc.title = line.slice(2).trim();
        continue;
      }
      if (section && section.name === "meta" && !field) {
        const m = META_LINE.exec(line);
        if (m) {
          doc.meta.push({ key: m[1], value: m[2].trim() });
          continue;
        }
      }
    }
    if (field) buf.push(line);
  }
  flush();

  const pick = (k) => (doc.meta.find((x) => x.key === k) || {}).value || "";
  doc.slug = pick("slug") || slugify(doc.title);
  doc.dateYmd = ymdFrom(pick("date"));
  return doc;
}