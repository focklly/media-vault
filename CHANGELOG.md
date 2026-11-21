# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 `主版本.次版本.修订号`。
**每次改完功能请同步更新本文件并在 GitHub 推送。**

## [1.1.0] - 2026-11-22

### 新增

- 5 个免费站点适配器：
  - Catbox（图片 + 视频，单文件 ≤200MB，免注册，用户哈希可选）
  - Pixeldrain（图片 + 视频，单文件 ≤20GB，API Key 可选）
  - 0x0.st（图片 + 视频，单文件 ≤512MB，临时分享，保留期约 30–365 天）
  - ImgBB（仅图片，单图 ≤32MB，API Key 必填；API 访问可能需 Pro）
  - Imgur（图片 / GIF / mp4，单文件约 ≤200MB、视频 ≤60s，Client-ID 必填）
- 多站点调度：同时启用多个上传目标；可分别为图片、视频设置默认站点，另设全局兜底站点。
- 跨站转存：条目在站点间互相转存（TASK.TRANSFER），保留转存历史（remote.history）。
- 标签：图片 / 视频标签增删改查、按标签搜索、标签快捷筛选；图库缩略图显示站点角标。

### 变更

- 设置页与图库适配多站点调度、转存操作入口与标签筛选界面。
- 文档补充五个免费站点的配置步骤、额度限制与排错说明。

### 兼容

- 兼容旧数据：无 `tags` / `history` 字段时自动兜底，不做破坏性迁移；旧版本配置与清单 JSON 可直接升级读取。

## [1.0.0] - 2026-11-22

### Added

- 页面自动扫描：`<img>`、`srcset`、`<picture> source`、CSS 背景图、懒加载属性（data-src 等）、`<video>/<source>`、视频直链（mp4/webm/m3u8…）、`og:image` / `og:video` / `twitter:image`。
- 悬停拾取：光标旁「存入个人空间」按钮，支持图片/视频/流媒体文案区分，`Shift+单击` 直接上传到默认站点。
- 悬浮球：可拖动、位置记忆、媒体计数角标、菜单（重新扫描/全部存入/媒体清单/打开图库/设置/隐藏）。
- 媒体清单面板：缩略预览、逐个存入、全部存入、流媒体标记。
- 本地个人空间：IndexedDB 元数据与 Blob 分表、图片缩略图（OffscreenCanvas 480px）、视频 poster 封面。
- 图库页面：网格布局、类型/状态筛选、全文搜索、四档排序、预览弹窗、收藏、批量上传/删除/导出、清单 JSON 导入导出、占用统计。
- 工具栏弹窗：本页图片/视频/可下载统计、重新扫描、全部存入、快捷开关。
- 设置页：通用开关、上传目标（元数据驱动表单 + 连接测试 + 自动保存）、拾取规则、排除站点、数据管理、关于。
- 存储适配器：
  - GitHub 仓库（Contents API，base64，≤40MB，raw / jsDelivr 链接）
  - S3 兼容（AWS SigV4 WebCrypto 直传，R2/MinIO/OSS/七牛/B2，Path-Style 可配）
  - WebDAV（PROPFIND 测试、MKCOL 建目录、PUT 上传，坚果云/Alist/Nextcloud/群晖）
  - 通用 HTTP 图床（multipart、可配请求头/表单字段/响应 JSON 路径，SM.MS/兰空/自建）
- 浏览器集成：右键图片/视频入库、右键扫描本页、标签页角标、完成通知、安装引导。
- 工程化：免构建 ES Module 后台、Shadow DOM 隔离、端口长任务 + 心跳保活、统一消息协议。
- 工具与 CI：`tools/make-icons.mjs`（纯 Node 生成图标）、`tools/testbed.html`、`tools/check.ps1`、`tools/pack.ps1`、GitHub Actions 校验。
- 文档：README、架构设计、二次开发指南、适配器配置手册、交接文档、隐私说明、FAQ。

### Known limitations

- 视频封面仅依赖页面 poster；未做 canvas 截帧。
- m3u8/mpd 只保存地址，不做整片下载。
- 图库未做虚拟滚动，>2000 条会卡。
- 导出清单不含文件本体；无云同步；仅简体中文。
