# CunFetch

面向内容创作者的多发布流程工具。本仓库公开的是它的一个核心组件：**云端收件箱 + 看板**（基于 Cloudflare Workers + R2）。

AI 助手（如 muse）把做好的**短视频 + 封面 + 三平台标题/标签**上传到云端收件箱；你在网页看板上一眼看到当天各发布时段的素材、封面和标签，确认无误后一键复制、下载、发布。

## 仓库内容

```text
CunFetch/
├── worker/                          # 云端收件箱 + 看板（Cloudflare Workers + R2）
│   ├── wrangler.toml                # Worker 配置 + R2 bucket(binding: INBOX)
│   └── src/
│       ├── index.js                 # API 路由 + 下载 + 看板渲染
│       └── dashboard.js             # 看板单页 UI（唯一 UI 真源）
└── .github/workflows/
    ├── deploy-inbox-worker.yml      # 手动部署 Worker（workflow_dispatch）
    └── check-blog.yml               # 博客检测（已暂停定时，仅手动触发）
```

## 它在流程中的位置

```text
AI 助手(muse) 生产视频素材
   │  上传 (platforms.json + 封面 + mp4，可打包 zip)
   ▼
Cloudflare Worker 收件箱 (R2)
   │  按 日期/档位/slug 归档
   ▼
网页看板 (/)
   │  封面 + 三平台标题/标签 + 下载状态
   ▼
创作者 预览 → 复制 → 下载 → 发布
```

素材按 **发布档位** 归档：

| 档位 | slot | 时间（北京时间） |
| --- | --- | --- |
| 早 | `early` | 09:05 |
| 中 | `mid` | 12:10 |
| 晚 | `late` | 19:08 |

## 部署

参见 [`worker/README.md`](worker/README.md)：手动在 GitHub Actions `Deploy Inbox Worker` 触发，Cloudflare 无需本机操作。

## 协议

© 2026 CunFetch