# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 `主版本.次版本.修订号`。
**每次改完功能请同步更新本文件并在 GitHub 推送。**

## [1.2.1] - 2026-11-22

### 新增

- **B 站视频真下载**：B 站用 MSE 播放，页面里只有 `blob:` 地址，旧版只能存链接。现在识别到 B 站视频后，后台调 `x/web-interface/view` 取 cid、`x/player/playurl`（qn=80、fnval=0、platform=html5）取单段 mp4 直链，带 `Referer: bilibili.com` 下载后照常入库。实机验证 `BV1K8sU65ELE` 存下 4.2MB `video/mp4`（`itm_mwre…`，status `ready`）；分段视频仍降级为链接记录。
- **ImgPile 直传**：按官方开发者文档实现 `POST https://imgpile.com/uploads` + `Authorization: Bearer <key>` + 原始字节 body（`?filename=` 指定文件名），取 `data.urls.original`；遵循免费账号 97MB / 超 4MP 转 WebP 的站点规则。
- **YourImageShare 可调参接口**：端点、Key、鉴权头三个字段全部可在设置里改，便于站点文档开放后直接接上。
- **个人空间右侧抽屉**：球菜单「打开个人空间」不再跳新标签，改为右侧滑入抽屉（默认 420px，可拖拽调宽 300–1200px，宽度存 `mv.libraryWidth`，Esc / 点外部收起）。
- 仅链接记录的流媒体条目，在能解析出真文件时会自动替换升级（不必手动删旧记录）。

### 修复

- **浮层叠层**：先开「媒体清单」、再点悬浮球时，旧清单不再盖住新菜单——打开菜单前先收起清单；点空白处依次收起菜单/清单/抽屉。
- **B 站存入失败**：不再直接报错退出，失败路径也会留下链接记录与封面并给出明确提示。
- 视频入库文件名改用页面标题（不再出现 `video-xxx.bin`）。

### 移除

- **0x0.st 适配器彻底删除**（文件、注册表、默认配置、文档全部移除）。实测浏览器 UA 418、脚本 UA 500，扩展内无法使用。

## [1.2.0] - 2026-11-23

### 新增

- **imgdb.io** 适配器：免注册免费图床，`POST /api/v1/upload` 直传，支持保留期（0 = 永久）、访问密码、描述，单图 ≤16MB；默认启用。已实机验证返回 `https://imgdb.io/i/xxx.png`。
- **Unlockify** 适配器：免注册视频直链，`POST /backend/api/web-upload` + 轮询 job 直到 `ready`，产出 `https://stream.unlockify.ink/video/<id>`，单文件 ≤1.9GB；默认启用。已实机验证上传 788KB 视频 → 20 秒转存完成。
- **Cloudinary** 适配器：用无签名上传预设直传图片/视频（cloud name + upload preset），≤100MB。
- **Wistia** 适配器：经典 `upload.wistia.com` 接口，API password 直传视频，返回播放页链接。
- **网页上传站点登记**：ImgPile、YourImageShare、Hippo Video 加入「上传目标」，标注为「网页上传·扩展不代传」，卡片提供「打开站点」按钮（这些站点没有可用的公开直传接口）。

### 变更

- 设置页「上传目标」改为紧凑单行卡片：名称 + 徽标 + 单行摘要 + 测试/展开/启用；配置区默认折叠，按需展开，卡片高度约为旧版三分之一。
- 设置页改为页内滚动：整页固定高度（header / 标签栏不动），只有内容区滚动，滚动条为自定义细条（`scrollbar-color` + `::-webkit-scrollbar`），不再出现浏览器原生滚动条。
- 上传目标按「可直接上传（API 直传）」与「网页上传站点」分两组展示。
- **0x0.st 降级为实验性并默认关闭**：实测站点拒绝浏览器 UA（418）、脚本 UA 返回 500，浏览器又不允许扩展改 UA，因此在扩展内不可用；测试结果会直接提示改用 imgdb.io。
- manifest 版本 1.2.0，描述更新为 imgdb.io / Unlockify 优先。

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
