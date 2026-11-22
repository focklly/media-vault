# 交接文档（Handover）

> 交接对象：接手本项目的开发者 / 后续 AI 助手。
> 读完这份文档 + [ARCHITECTURE.md](ARCHITECTURE.md)，应能在 30 分钟内独立继续开发。

| 项 | 值 |
| --- | --- |
| 项目名 | 影图管家 MediaVault |
| 仓库 | <https://github.com/focklly/media-vault> |
| 当前版本 | v1.2.0 |
| 交接日期 | 2026-11-22 |
| 技术栈 | Manifest V3 + 原生 JS（无构建、无框架、无后端） |
| 目标浏览器 | Chrome / Edge 116+ |
| 许可 | MIT |

---

## 1. 交付物清单

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 扩展源码 | 仓库根目录 | 可直接「加载已解压的扩展程序」 |
| 可分发包 | `dist/media-vault-1.2.0.zip` | 由 `tools/pack.ps1` 生成，仅含 manifest + src |
| 图标 | `src/icons/icon-{16,32,48,128}.png` | 由 `tools/make-icons.mjs` 纯 Node 生成，可复现 |
| 测试页 | `tools/testbed.html` | 覆盖 img/srcset/懒加载/背景图/video/直链/meta 六类场景 |
| 工程脚本 | `tools/check.ps1`、`tools/pack.ps1` | 语法+manifest 校验、打包 |
| CI | `.github/workflows/validate.yml` | push / PR 自动校验 |
| 文档 | `README.md`、`docs/*` | 架构、开发指南、适配器手册、隐私、FAQ |

---

## 2. 完成度

| 模块 | 状态 | 备注 |
| --- | --- | --- |
| MV3 清单与权限 | ✅ 完成 | `manifest.json` 语法与图标校验通过 |
| 页面扫描（图片/视频/背景/懒加载/直链/meta） | ✅ 完成 | 代码语法校验通过；需浏览器人工验收 |
| 悬停「存入个人空间」按钮 | ✅ 完成 | 支持 Shift 直接上传；尺寸/视频开关可配 |
| 悬浮球 + 菜单 + 清单面板 | ✅ 完成 | 可拖动、位置记忆、计数角标 |
| 本地个人空间（IndexedDB） | ✅ 完成 | 元数据/Blob 分表、缩略图懒加载 |
| 图库页面（筛选/搜索/排序/预览/收藏/批量） | ✅ 完成 | 批量上传/删除/导出 |
| 弹窗（本页统计 + 快捷开关） | ✅ 完成 | 读 content 统计 + 本地库 |
| 设置页（元数据驱动表单） | ✅ 完成 | 自动保存、连接测试 |
| 适配器 ×16 | ✅ 完成 | 直传 13：imgdb.io / Unlockify / GitHub / S3(SigV4) / WebDAV / HTTP / Cloudinary / Wistia / Catbox / Pixeldrain / 0x0.st(实验性) / ImgBB / Imgur；网页上传 3：ImgPile / YourImageShare / Hippo |
| 存储路由（按类型默认站点） | ✅ 完成 | `src/shared/routing.js`：byKind → 全局兜底 → 第一个支持该类型的已启用站点 |
| 跨站转存与历史保留 | ✅ 完成 | `transfer` 端口任务（单条/批量）；旧 remote 进 `history[]`，失败不破坏原记录 |
| 标签（录入 / chips / 快捷筛选 / 搜索） | ✅ 完成 | 多选交集筛选；旧数据 `tags || []` 兜底；未建 DB 索引 |
| 图库站点角标 | ✅ 完成 | 缩略图顶部居中显示适配器名称，未上传显示「本地」 |
| 右键菜单 / 通知 / 角标 | ✅ 完成 | |
| 文档与交接 | ✅ 完成 | 本文件 |
| 自动化 E2E 冒烟 | ✅ 通过 | Edge 真机 + CDP 脚本 13/13 断言全绿；尚未接入 CI |
| 商店上架素材 | ❌ 未做 | 需要截图与隐私政策 URL |

> **如实说明**：源码已通过 `node --check` 语法校验，并在 Edge 真机上跑过一次 CDP E2E 冒烟（Service Worker 启动、4 个适配器 26 个字段渲染、content 注入、悬浮球计数、悬停按钮、点击入库、IndexedDB 写入、图库卡片与缩略图、弹窗读库，共 13 项断言全绿）。但拖拽手感、复杂站点兼容、S3/WebDAV 真实上传仍需按第 3 节人工验收一次；E2E 脚本尚未入库。

---

## 3. 验收清单（约 15 分钟）

准备工作：`chrome://extensions` 加载仓库根目录 → 在扩展详情里打开「允许访问文件网址」（测本地测试页）→ 打开 `tools/testbed.html`。

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 打开任意正常网页 | 右下角出现渐变悬浮球，右上角数字为扫描到的媒体数 |
| 2 | 拖动悬浮球到左侧后刷新页面 | 球回到拖动后的位置（位置记忆） |
| 3 | 悬停测试页 800×600 图片 | 光标旁出现「存入个人空间 · 图片」 |
| 4 | 点击按钮 | 底部 toast「已存入个人空间 · …」；弹窗/图库条目 +1 |
| 5 | 悬停 24px 小图标 | **不出现**按钮 |
| 6 | 悬停 video | 出现按钮；入库后封面取自 poster |
| 7 | 悬浮球 → 查看媒体清单 | 面板列出图/视频/背景图/直链，点单个可入库 |
| 8 | 悬浮球 → 全部存入 | toast 显示 `正在存入 x/y`，结束后汇总成功/失败 |
| 9 | 扩展图标 → 弹窗 | 「图片/视频/可下载」数字与页面一致；三个开关可切换 |
| 10 | 图库页 | 卡片网格、缩略图、筛选计数、搜索、排序正常 |
| 11 | 点卡片 → 预览 | 图片/视频可播放；信息栏含来源页、体积、上传状态 |
| 12 | 设置 → 上传目标 → GitHub 填配置 → 测试连接 | 返回「连接正常：owner/repo（公开，可写）」 |
| 13 | 图库选中图片 → 上传 | 进度出现，完成后卡片显示「已上传」，复制链接可访问 |
| 14 | 设置 → 拾取规则改最小边长 | 刷新页面后悬停阈值生效 |
| 15 | 设置 → 数据 → 导出清单 | 下载 JSON，条目数与图库一致 |
| 16 | 设置 → 上传目标 | Catbox / Pixeldrain / 0x0.st / ImgBB / Imgur 五张卡片自动渲染；启用后出现在全局/图片/视频下拉，仅图片站点在视频下拉中禁用并注明原因 |
| 17 | 图库详情 → 已上传条目 | 按钮为「转存到该站点」；选择另一站点转存成功后，信息栏出现「转存历史」；转存失败时原链接保持不变 |
| 18 | 详情面板输入标签（逗号分隔）回车 | 卡片显示标签 chips（超过 3 个折叠为 +n）；点 chip 进入标签筛选；快捷筛选行可多选、可一键清除，搜索框同样匹配标签 |

失败时的排查顺序：Service Worker 控制台 → 页面 Console → 检查 host_permissions → 看 [FAQ](FAQ.md)。

---

## 4. 已知限制（务必同步给需求方）

1. **视频缩略图**：SW 无法解码视频，只有页面提供 `poster` 时才生成封面，否则图库显示占位图标。P0 待办：在 content 里 canvas 截帧。
2. **流媒体（m3u8/mpd）**：只保存播放地址，不做整片下载（需要 ffmpeg.wasm 或原生下载器）。
3. **防盗链图片**：两次抓取尝试后仍失败，则降级为「仅链接」条目（有记录、无本地副本、上传会提示无副本）。
4. **私有仓库 / 私有桶**：外链需要鉴权，图库标「私有」，分享会失败；需配 `publicBase`。
5. **GitHub 单文件 ≤ 40MB**：视频请用 S3/WebDAV。
6. **图库无虚拟滚动**：约 2000 条以上会明显变卡；数据分页/窗口化未实现。
7. **导出清单不含文件本体**：JSON 只有元数据，文件需 `downloads` 逐个导出或依赖外部站点。
8. **无云同步**：IndexedDB 属于单个浏览器 profile，多设备不互通。
9. **权限较宽**：`http/https` 全站，商店审核需写清用途；上架前可考虑改为 `activeTab` + 可选站点权限，但会牺牲「打开页面即扫描」体验。
10. **无 i18n**：目前仅简体中文。
11. **免费站点限速 / 清档**：Catbox 匿名文件不归属账号，无法在后台管理；Pixeldrain 按活跃度保留约两个月；0x0.st 保留期随体积约 30–365 天。重要素材请用 S3 / WebDAV 长期归档，不要只依赖免费图床。
12. **ImgBB API 门槛**：API Key 需在账号内申请，部分接口能力可能需要 Pro；Key 缺失或账号未开通 API 时返回 400/403，报错文案已提示这一点。
13. **0x0.st UA 要求 / Imgur 地区限制**：0x0.st 会校验 User-Agent，扩展固定发送 `MediaVault/<version>`，禁止伪装浏览器，UA 不可识别会被拒；Imgur 视频上传受账号与地区限制，失败时建议换 Catbox / Pixeldrain。
14. **UA 无法强制覆盖**：0x0.st 依赖可识别 UA，但扩展无法强制覆盖浏览器 UA（部分 Chrome 版本会静默忽略脚本设置的 `User-Agent` 头）；若被拒属站点策略，换 Catbox / Pixeldrain 即可。未做 UA 改写的 `declarativeNetRequest` 方案（不引入该权限与规则表）。

---

## 5. 待办与优先级

### P0（下次迭代必须做）

| 任务 | 验收标准 | 落点 |
| --- | --- | --- |
| 视频封面截帧 | 入库视频能在图库显示真实首帧；跨域失败时退回占位 | content 画 canvas → dataURL 随导入传参 |
| 上传失败自动重试 | 网络抖动/5xx 时重试 2 次（指数退避），最终失败才标红 | `service-worker.js uploadItemObject` |
| 浏览器 E2E 冒烟 | 至少覆盖：加载扩展→测试页扫描→入库→图库渲染→删除 | 可引入 Playwright + 持久化上下文 |

### P1

| 任务 | 验收标准 |
| --- | --- |
| 标签索引 / 相册 | 标签录入、chips 与快捷筛选已在 v1.1.0 完成；待办：tags 多Entry 索引、相册分组与标签重命名 |
| 重复检测 | 同 URL 已去重；同内容不同 URL 用 SHA-256 前 16 位判重 |
| S3 分片上传 | >100MB 文件可传（Multipart Upload） |
| HLS 下载 | 可选下载 m3u8 全部分片并合并（ffmpeg.wasm，体积较大） |
| 图库虚拟滚动 | 5000 条仍可流畅滚动 |

### P2

| 任务 |
| --- |
| Firefox 适配（MV3 差异：`browser.*`、`scripting`、权限声明） |
| 商店发布（截图、隐私政策 URL、权限说明文案） |
| i18n（en / zh_CN） |
| 可选站点权限，降低审核阻力 |

---

## 6. 关键决策与「不要踩回去」的坑

完整 ADR 见 [架构文档的「设计决策记录」](ARCHITECTURE.md#7-设计决策记录adr)。接手时优先记住四条：

1. **耗时任务必须走端口**：直接 `sendMessage` 里做 30 秒以上的事，SW 会被杀，任务静默失败。
2. **content 不能改 ES Module**：MV3 content_scripts 不支持；改成 module 会导致整页注入失败。
3. **SW 里没有 FileReader / 不能解码视频**：base64 用 `arrayBuffer`；封面只能从页面侧来。
4. **IndexedDB 事务里不要 await 非请求 Promise**：会出现空档自动提交，表现为「只写入了一部分」。

---

## 7. 凭证与账号管理

| 凭证 | 用途 | 存放 | 撤销方式 |
| --- | --- | --- | --- |
| GitHub PAT（用户自备） | 提交素材到素材仓库 | `chrome.storage.local` 的 `mv.settings.adapters.github.token` | GitHub → Settings → Developer settings 撤销 |
| R2 API Token | S3 直传 | 同上 `adapters.s3.accessKey/secretKey` | Cloudflare R2 → Manage API Tokens 删除 |
| WebDAV 应用密码 | 网盘写入 | 同上 `adapters.webdav.password` | 网盘后台删除应用密码 |
| HTTP 图床 Token | multipart 上传 | 同上 `adapters.http.headersJson` | 图床后台重置 |
| GitHub 仓库写权限 | 本项目代码同步 | 由 AI 的 GitHub 连接器持有，不在仓库内 | 在 GitHub 授权页撤销连接器 |

**风险提示**：扩展没有安全存储，以上均为本机明文。不要在公共电脑保存；换人接手时第一件事是重置上述凭证。仓库内**不得**提交任何 Token（`.gitignore` 已排除 `dist/`，但没有密钥过滤器，靠人工自律）。

---

## 8. GitHub 同步约定

- 仓库：`focklly/media-vault`，主分支 `main`，公开。
- 约定：**每完成一个功能就提交并推送一次**，不攒大批量提交。
- 提交信息：Conventional Commits（`feat/fix/docs/refactor/chore/perf` + 范围），例：`feat(library): add bulk download`。
- 发版：同步改 `manifest.json version` 与 `constants.js APP.version` → 更新 `CHANGELOG.md` → `git tag vX.Y.Z` → push tags。
- CI：push / PR 自动执行 `tools/check.ps1`（语法 + manifest + 图标）。红了先修复。
- 当前同步方式：AI 助手通过 GitHub 连接器逐文件提交；人工开发用标准 `git push`，产物一致。
- v1.0.0 的首个增量（42 个文件，含二进制 PNG 图标）通过一次性导入流程落到 `main`；本地仓库另有 1 个 `feat: initial MediaVault v1.0.0` 提交，内容与远端一致。若本地 `git push` 报 `non-fast-forward`，先 `git fetch origin`，再 `git reset --soft origin/main` 重新提交即可（不要强推）。
- 本机若出现 `Failed to connect to github.com port 443`：说明 git 直连被重置（`curl https://github.com` 仍 200 是正常的），改用 GitHub 网页上传/连接器推送，或配置代理后再 `git push`。

---

## 9. 故障排查手册（按现象）

| 现象 | 优先检查 | 处理 |
| --- | --- | --- |
| 页面没有任何浮层 | 扩展是否启用；`settings.enabled`；站点是否在排除列表；页面是否 `chrome://` | 设置页开总开关；从排除列表移除；换普通网页 |
| 悬浮球在但扫描为 0 | 页面是否图片全是小图/纯 canvas；懒加载未触发 | 滚动页面后重新扫描；调低扫描最小边长 |
| 点击按钮无反应 | 扩展是否刚被刷新（旧 content 失效）；SW 控制台报错 | 刷新网页；重新加载扩展 |
| 抓取失败/仅链接 | 防盗链、登录墙、CORS | 右键另存后手动导入是已知兜底；或换同源页面 |
| 图库空白 | IndexedDB 是否被清除；SW 是否写入成功 | DevTools → Application → IndexedDB → `mediavault` 查看 items |
| 上传 401/403 | 凭证、权限范围 | 重新生成 Token；核对 Contents 权限 |
| 上传成功但链接 404 | `publicBase` 配错或桶未公开 | 用测试连接返回的 path 手工拼接验证 |
| 大文件上传中断 | 是否走了端口任务；SW 是否被手动停止 | 不要手动点「终止」；看 progress 是否持续推进 |
| 内存占用高 | 图库缩略图 objectURL 泄漏 | 确认 `img.onload` 后 revoke；预览关闭时 revoke |

---

## 10. 接手 30 分钟路线

1. 读本文件第 2、3、4 节（10 分钟）。
2. 加载扩展、跑完验收清单 1–11 项（10 分钟）。
3. 读 [ARCHITECTURE.md](ARCHITECTURE.md) 第 2、3、4 节 + [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) 第 3 节（10 分钟）。
4. 从 P0 里挑「视频封面截帧」开工，改完按第 8 节流程推 GitHub。

---

## 11. 变更记录

| 日期 | 版本 | 内容 |
| --- | --- | --- |
| 2026-11-22 | v1.0.0 | 首个可交付版本：扫描/悬停/悬浮球/本地图库/四个适配器/完整文档 |
| 2026-11-22 | v1.1.0 | 新增 5 个免费适配器（Catbox/Pixeldrain/0x0.st/ImgBB/Imgur）；按媒体类型路由默认站点；跨站转存并保留历史；标签录入/chips/多选快捷筛选/搜索匹配；图库缩略图站点角标 |
| 2026-11-23 | v1.2.0 | 新增 imgdb.io（默认启用，实机验证 201/直链）与 Unlockify 视频直链（默认启用，实机 20s 转存）；新增 Cloudinary / Wistia 直传；ImgPile / YourImageShare / Hippo 登记为网页上传入口；0x0.st 降级为实验性默认关闭（站点拒绝浏览器 UA）；设置页改紧凑卡片 + 页内滚动 |

