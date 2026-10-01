# CunFetch Inbox — Cloudflare Worker（云端收件箱 + 看板）

云端 API：muse 上传视频素材到 R2；看板网页展示时间/内容/上传物/本地下载状态。

## 结构

```
worker/
├── wrangler.toml      # Worker 配置 + R2 binding (INBOX)
└── src/index.js       # 端点逻辑 + 看板 HTML
```

## 端点

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/health` | GET | 无 | 连通性探测 |
| `/api/upload` | POST | Bearer | multipart 上传：`file` + `slug` + `slot(early\|mid\|late)` + `date?(YYYYMMDD)` |
| `/api/feedback` | POST | Bearer | JSON：`slug/slot/date/downloaded/pull_at/local_size`，上报本地下载状态 |
| `/api/objects` | GET | Bearer | 返回各 slug 对象与状态（JSON） |
| `/` | GET | 无 | 看板页面（公开可访问，未授权也能看） |

**鉴权**：请求头 `Authorization: Bearer <WORKER_API_TOKEN>`。

## 部署（在你有 Cloudflare 账号的机器上执行）

```bash
cd worker

# 1. 安装 wrangler（已装可跳过）
npm i -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 创建 R2 桶（仅首次）
wrangler r2 bucket create cunfetch-inbox

# 4. 设置 API token（secret，不写入代码）
wrangler secret put WORKER_API_TOKEN
#    输入一个强随机串，muse 上传与本地 feedback 都要用它

# 5. 部署
wrangler deploy
```

部署完成后会打印 Worker 的公开 URL（如 `https://cunfetch-inbox.<subdomain>.workers.dev`）。

## 本地机器上的配置

把部署得到的 URL 与 token 填进本地 `config.yaml`：

```yaml
r2:
  worker_base_url: "https://cunfetch-inbox.xxx.workers.dev"
  worker_token: "<WORKER_API_TOKEN>"
```

## 本地拉取

```bash
python -m src.main --pull-r2 early    # 拉取指定档位（early|mid|late）
python -m src.main --pull-r2 all      # 拉取今日三档（开机补拉用）
python -m src.main --pull-r2          # auto：按当前时刻判定档位
```

落盘位置：`D:/CunContent/inbox/<yyyymmdd>_<slot>_<slug>/`

## 看板

直接浏览器打开 Worker 的公开 URL（`/`）即可查看实时看板。

---

## 给 AI（muse）的上传接口说明

把下面内容提供给制作内容的 AI（muse），让它按此调用上传接口。

### 上传内容（一篇 = 视频 + 封面 + 元数据 三个文件）

每次上传请带 **platforms.json、封面图、视频 mp4 三个文件**，一次性传给 `/api/upload`（multipart/form-data）：

```
POST {worker_url}/api/upload
Authorization: Bearer {WORKER_API_TOKEN}
Content-Type: multipart/form-data

字段：
  file    platforms.json        # 平台的标题字段与 tags（见下面结构），文件名结尾为 .json 即可
  file    封面图.png/.jpg/.webp  # 可选但推荐；按图片扩展名识别，存为 cover.<ext>
  file    视频文件.mp4           # 竖版短视频，文件名任意（建议 xxx_10s.mp4）
  slug    篇名唯一标识           # 如 muse-signup；用于文件夹/体现，仅可含字母数字-_
  slot    early|mid|late        # 发布档：早 09:05 / 中 12:10 / 晚 19:08
  date    (可选) YYYYMMDD        # 发布日期；缺省用服务器当天(Asia/Shanghai)
```

**也支持传 zip 压缩包**：把上面三（或更多）个文件打进一个 zip，`file` 直接传该 zip 即可。Worker 会自动解压并按内部文件名分流传入 R2（支持任意目录层级，取 basename）。

> 多文件扩展：worker 按类型自动分流（json→platforms.json、图片→cover.扩展名、其余→video.mp4）。以后要加第四种类型，在 worker 再添一个分支即可。zip 内条目同样适用该规则。

### platforms.json 结构（与看板/下载一致）

```json
{
  "title": "文章标题（可选）",
  "article_url": "https://...（可选）",
  "platforms": {
    "douyin":   { "title": "抖音标题",   "tags": ["标签1","标签2","标签3","标签4","标签5"] },
    "bilibili": { "title": "B站标题",     "tags": ["标签1","标签2","标签3","标签4","标签5"] },
    "shipinhao":{ "title": "视频号标题",  "tags": ["标签1","标签2","标签3","标签4","标签5"] }
  }
}
```

### curl 示例

```bash
curl -X POST "{worker_url}/api/upload" \
  -H "Authorization: Bearer {WORKER_API_TOKEN}" \
  -F "file=@platforms.json;type=application/json" \
  -F "file=@封面.png;type=image/png" \
  -F "file=@某标题_10s.mp4;type=video/mp4" \
  -F "slug=muse-signup" \
  -F "slot=late"
```

### 返回

```json
{ "ok": true, "slug": "muse-signup", "slot": "late", "date": "20261001",
  "files": [ { "key": "inbox/20261001/late/muse-signup/video.mp4", "etag": "..." },
             { "key": "inbox/20261001/late/muse-signup/cover.png", "etag": "..." },
             { "key": "inbox/20261001/late/muse-signup/platforms.json", "etag": "..." } ] }
```

### 说明

- 每次上传是「覆盖」：同 slug+slot+date 再次上传会用新文件替换旧的。改内容就重传同 slug。
- 上传后需本地定时任务拉到 `D:\CunContent`（见 C 节），看板「下载状态」才变绿。
- 频控：单篇一次请求即可，勿把两文件拆成两次请求。