# CunFetch

面向内容创作者的**自动内容采集与素材归档工具**，是 CunWork 体系中的一个执行模块。

从博客自动发现新文章 → 采集文章内容 → 整理文章图片（不足 5 张自动网络补充）→ 归档到本地素材库。

**核心设计：一次执行、执行完即退出。** 不常驻、不轮询、低资源。

## 运行方式

| 方式 | 命令 / 入口 | 说明 |
| --- | --- | --- |
| 执行所有 pending 任务（默认） | `python -m src.main` | 读取 Google Sheets 中 `pending` 任务逐个采集 |
| 手动立即执行 | 双击 `CunFetch.exe` 或 `python -m src.main --run` | 同上 |
| 检测新文章并写入任务队列 | `python -m src.main --detect` | 供 GitHub Actions 使用 |

## 整体流程

```text
博客新文章
   ↓
GitHub Actions（每天北京时间 09:00，即 UTC 01:00）
   ↓ 检测 RSS / Sitemap，写入新任务（URL 去重）
Google Sheets
   ↓
Windows 任务计划程序 CunFetch Daily（每天 09:05）
   ↓ 启动 CunFetch
文章解析 → 博客图片提取/过滤 → 不足 5 张网络补充
   ↓ 下载 → 本地归档 → 更新任务状态
CunFetch 自动退出
```

### 关于两个「9 点」

- **GitHub Actions**：`0 1 * * *`（UTC）= **北京时间 09:00**，负责检测博客并往 Google Sheets 写任务。
- **Windows 端 CunFetch**：建议计划在 **09:05** 启动，避免与检测任务撞车。仅负责采集。

> 注意：GitHub Actions 的 `on.schedule` 一律使用 **UTC**。北京时间为 09:00 时对应 UTC 01:00。

## 目录结构

```text
CunFetch/
├── .github/workflows/check-blog.yml   # 博客检测 + 写入任务（UTC 每天 01:00）
├── src/
│   ├── main.py                        # 入口（--run / --detect）
│   ├── config/settings.py             # 配置加载（config.yaml）
│   ├── interfaces/task_provider.py    # 任务队列抽象，与 Google Sheets 解耦
│   ├── sheets/client.py               # Google Sheets 任务队列实现
│   ├── blog/
│   │   ├── detector.py                # RSS / Sitemap 新文章检测
│   │   ├── parser.py                  # 正文解析 → Markdown
│   │   └── image_extractor.py         # 提取文章图片 URL
│   ├── images/
│   │   ├── validator.py               # 无效图片过滤
│   │   ├── downloader.py              # 下载（timeout + 重试）
│   │   └── searcher.py                # 网络图片补充搜索
│   ├── storage/local.py               # 本地归档（article.md/info.json/source.txt）
│   └── tasks/manager.py               # 单篇文章采集流程编排
├── requirements.txt
├── config.example.yaml
└── build.ps1                          # PyInstaller 打包 CunFetch.exe
```

## 安装

```bash
pip install -r requirements.txt
```

## 配置

把 `config.example.yaml` 复制为 `config.yaml` 并填写：

- `blog.rss` / `blog.sitemap`：博客地址
- `storage.root`：本地素材根目录（默认 `D:/CunContent`）
- `sheets.spreadsheet_id`：Google Sheets 的工作表 ID
- `sheets.credentials_path`：本机 Service Account JSON 路径
- `images.searcher.*`：网络图片搜索（可选，`none` 时跳过）

### Google Sheets

新建名为 **CunFetch Tasks** 的工作表，表头（第 1 行）依次为：

```text
task_id, title, url, published_at, status, blog_images, web_images,
total_images, local_path, created_at, updated_at, error
```

将 Service Account（或机器人账号）添加为工作表协作者（编辑权限）。
Service Account JSON **绝不能提交到 GitHub**。

### GitHub Actions 密钥

在仓库 Settings → Secrets 中添加：

- `CUNFETCH_SHEETS_CREDENTIALS`：Service Account JSON 的**字符串内容**

`check-blog.yml` 通过环境变量 `CUNFETCH_SHEETS_CREDENTIALS` 读取该凭证。

### Windows 任务计划程序

创建任务 **CunFetch Daily**：

- 触发器：每天 09:05（时区 Asia/Shanghai）
- 操作：启动 `dist\CunFetch.exe`（其同级目录需有 `config.yaml`）

任务计划程序只负责启动，具体逻辑由 CunFetch 自己完成。

## 图片采集规则

每篇文章目标 **5 张**图片：

- 优先使用博客文章自身图片；
- 博客图片不足 5 张时，按标题/正文关键词搜索网络图片补充；
- 过滤 Logo、favicon、头像、图标、tracking pixel、极小图、重复图等；
- 保持原始格式（WebP / JPG / PNG），不做格式转换；
- 每张图片都在 `source.txt` 中记录来源 URL。

## 本地产物

```text
D:/CunContent/
└── 2026-09-03_文章标题/
    ├── article.md
    ├── info.json
    ├── source.txt
    └── images/
        ├── 01.webp
        ├── 02.webp
        └── 03.jpg
```

## 日志

日志写入 `logs/YYYY-MM-DD.log`，记录启动、任务发现、图片提取/下载、本地保存、状态更新等。

## 打包

```bash
powershell -ExecutionPolicy Bypass -File build.ps1
```

产物为 `dist\CunFetch.exe`，无需安装 Python。

## 关注点

- **不常驻**：执行完自动退出。
- **幂等**：文章 URL 是唯一标识，已完成不重复下载。
- **所有网络请求设置 timeout**，下载失败自动重试。
- **核心逻辑与 Google Sheets 解耦**：通过 `TaskProvider` 抽象，未来可替换为 CunWorkProvider。
- **不自动上传任何图片到云存储**，素材仅保存在本地。