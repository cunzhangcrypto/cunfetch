# CunFetch Inbox — Cloudflare Worker（云端收件箱 + 看板）

云端 API：muse 上传视频素材到 R2；看板网页展示时间/内容/上传物/本地下载状态。

## 结构

```
worker/
├── wrangler.toml      # Worker 配置 + R2 binding (INBOX) + Cron 定时清理
└── src/
    ├── index.js       # 端点逻辑 + R2 读写
    ├── dashboard.js   # 看板 + 中视频文稿页 UI（唯一 UI 真源）
    └── videodoc.js    # 中视频文稿 md 解析（格式 v1）
```

## 端点

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/health` | GET | 无 | 连通性探测 |
| `/api/upload` | POST | Bearer | multipart 上传：`file` + `slug`(视频必填) + `slot(early\|mid\|late)` + `date?(YYYYMMDD)` + `type?(video\|article\|doc)`；直接传 `.md` 会自动走文稿线 |
| `/api/feedback` | POST | Bearer | JSON：`slug/slot/date/kind/downloaded/pull_at/local_size`，上报本地下载状态 |
| `/api/objects` | GET | Bearer | 返回各 slug 对象与状态（JSON） |
| `/api/cleanup` | POST | Bearer | 清理超过 7 天的素材；加 `?dry=1` 只统计不删除 |
| `/` | GET | 无 | 看板页面（公开可访问，未授权也能看） |
| `/video-doc` | GET | 无 | 中视频文稿页：各平台标题/简介/标签/封面文案，逐项可点击复制 |

**鉴权**：请求头 `Authorization: Bearer <WORKER_API_TOKEN>`。

## 定时清理（保留 7 天）

R2 只做临时中转，`wrangler.toml` 里配了 Cron 触发器：

```toml
[triggers]
crons = ["0 20 * * *"]   # UTC 20:00 = 北京时间 04:00，每天一次
```

每天触发一次 Worker 的 `scheduled()`，删除**上传时间超过 7 天**的对象，`inbox/`（视频）、`articles/`（图文）、`docs/`（中视频文稿）三条线全覆盖。

想立即核验效果，可手动调接口：

```bash
curl -X POST "{worker_url}/api/cleanup?dry=1" -H "Authorization: Bearer {WORKER_API_TOKEN}"  # 只统计，返回将被删除的 key
curl -X POST "{worker_url}/api/cleanup" -H "Authorization: Bearer {WORKER_API_TOKEN}"         # 真删
```

> 调整保留天数改 `src/index.js` 顶部的 `RETENTION_DAYS`；定时表达式改 `wrangler.toml` 的 `crons`，改完重新部署生效。

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

直接浏览器打开 Worker 的公开 URL（`/`）即可查看实时看板；中视频文稿在 `/video-doc`（看板右上角也有入口）。

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
  type    (可选) video|article    # 缺省 video（视频线）；article=自媒体图文，见下节
```

**也支持传 zip 压缩包**：把上面三（或更多）个文件打进一个 zip，`file` 直接传该 zip 即可。Worker 会自动解压并按内部文件名分流传入 R2（支持任意目录层级，取 basename）。

> 多文件扩展：worker 按类型自动分流（json→platforms.json、图片→cover.扩展名、其余→video.mp4）。以后要加第四种类型，在 worker 再添一个分支即可。zip 内条目同样适用该规则。

### 图文上传（自媒体 5 平台，`type=article`）

除视频外，还支持上传**一篇自媒体图文**（微信公众号 / 小红书 / 头条 / 百家号 / 知乎）。做法同样是传一个 **zip**，但表单加 `type=article`：

```
POST {worker_url}/api/upload
Authorization: Bearer {WORKER_API_TOKEN}
Content-Type: multipart/form-data

字段：
  file    <文章名>.zip            # 必带；zip 内为各平台子目录（见下结构）
  type    article                 # 固定填 article，走图文线
  slot    late                    # 图文固定随晚间档（local 在晚档拉取）
  date    (可选) YYYYMMDD          # 缺省服务器当天(Asia/Shanghai)
```

- **标题取自 zip 文件名**（去掉 `.zip`）。如上传 `示例_一篇文章为什么要改五遍.zip` → 本地目录 `D:\CunContent\自媒体\<日期>_示例_一篇文章为什么要改五遍\`。
- zip 内**直接放各平台子目录**（或连同外层文件夹一起打包，worker 会自动剥离外层）：
  ```
  wechat/       article.json + cover.png (+ inline-1.png)
  xiaohongshu/  article.json + cover.png
  toutiao/      article.json + cover.png
  baijiahao/    article.json + cover.png
  zhihu/        article.json + cover.png
  ```
- worker 上传时**解压并按 `<平台>/<文件>` 存入收件箱**，看板上可直接看到 5 个平台的标题/标签与封面。
- 本地在**晚间档（late）定时任务**里拉取并镜像到 `D:\CunContent\自媒体\<日期>_<标题>\`，供 CunWrite 扫描直发。图文与视频两条线互不影响。

### 中视频文稿上传（`名称.md`，无需其他字段）

中视频（YouTube / B站 / 视频号）的标题、简介、标签、封面文案等，写成一个 `名称.md` 直接上传即可，worker 会自动解析并在 `/video-doc` 展示：

```
POST {worker_url}/api/upload
Authorization: Bearer {WORKER_API_TOKEN}
Content-Type: multipart/form-data

字段：
  file    名称.md            # 必带，如 20261007muse-video-pk-flow.md
  type    (可选) doc         # 传 .md 会自动识别为文稿；也可显式写 doc
  date    (可选) YYYYMMDD     # 缺省读文稿 meta 段的 date，再缺省用服务器当天(Asia/Shanghai)
  slug    (可选)             # 缺省读文稿 meta 段的 slug
```

文稿格式 v2（首部注释已声明，**顺序与字段名不要增删改**）：

```
# <标题>
## meta        - slug / date / srt / duration / blog_alias
## youtube     ### title_1（推荐） / title_2 / title_3 / description / chapters / tags
## bilibili    ### title_1（推荐） / title_2 / title_3 / description
## shipinhao   ### long_desc / short_titles（1. 2. 3. 编号列表）/ comment
## cover       ### cover_prompt（封面生成提示词模板）
```

- 多行内容用三个反引号包成代码块（围栏本身不入值）；单行字段直接写值。
- 不含博客内容（博客直发网站，不写 `## blog` 段）；旧文稿若带 blog 段仍会照常展示。
- youtube 的 `chapters` / `tags` 与 `description` 内容重复，页面不再单独展示（文稿里保留无妨）。
- `cover_prompt` 在页面上作为**一项整体展示、一键复制全文**（v1 的 `main` / `sub` 仍兼容展示）。
- worker 存 `docs/<yyyymmdd>/<slug>/<原名>.md`（原文可回溯）+ `doc.json`（解析结果，页面直接读它）。
- 页面上**每一项都能单独点击复制**：标题、简介、封面提示词……视频号的短标题会拆成一条条分别复制。

```bash
curl -X POST "{worker_url}/api/upload" \
  -H "Authorization: Bearer {WORKER_API_TOKEN}" \
  -F "file=@20261007muse-video-pk-flow.md;type=text/markdown"
```

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