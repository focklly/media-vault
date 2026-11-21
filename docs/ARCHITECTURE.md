# 架构设计（Architecture）

> 面向二次开发者。读完应能回答三个问题：消息怎么走、数据存在哪、为什么这样设计。
> 代码实现见 `src/`，本文与代码同步维护；改动协议请同步本文表格。

---

## 1. 总体分层

```text
┌────────────────────────────── 浏览器页面（任意站点） ──────────────────────────────┐
│  src/content/content.js  （单文件 IIFE，Shadow DOM 隔离）                            │
│  ├── 扫描器      img / srcset / picture / 背景图 / video / 直链 / og meta            │
│  ├── 悬停按钮     pointerover → 定位 → 点击 → 端口任务 import                        │
│  ├── 悬浮球       拖动/位置记忆/菜单（扫描、全部存入、清单、打开图库、设置）             │
│  └── 清单面板     缩略预览 + 逐个存入                                                │
└───────────────┬───────────────────────────────┬───────────────────────────────────┘
                │ chrome.runtime.sendMessage    │ chrome.runtime.connect('mv-task')
                │ （短请求）                     │ （长任务，防 SW 回收）
┌───────────────▼───────────────────────────────▼───────────────────────────────────┐
│  src/background/service-worker.js （ES Module）                                     │
│  ├── 消息路由 / 端口路由                                                            │
│  ├── fetchMedia（带 Cookie 抓原文件，两次尝试）                                      │
│  ├── 缩略图（OffscreenCanvas，最长边 480）                                           │
│  ├── IndexedDB 落库（shared/db.js）                                                 │
│  ├── 上传调度（adapters/index.js → 具体适配器）                                      │
│  └── 右键菜单 / 角标 / 通知 / 安装引导                                               │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ import（同一套 shared 模块）
┌───────────────▼──────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ src/popup   本页统计+开关     │   │ src/library 个人空间  │   │ src/settings 设置   │
│ （读 IndexedDB / 问 content） │   │ （图库/预览/批量）    │   │ （元数据驱动表单）   │
└──────────────────────────────┘   └──────────────────────┘   └─────────────────────┘
```

**共享层** `src/shared/`：

| 文件 | 职责 | 是否依赖 chrome |
| --- | --- | --- |
| `constants.js` | 消息名、任务名、限制值、DB 名、存储键 | 否 |
| `utils.js` | uid、体积/时长格式化、文件名、base64、SHA-256/HMAC、并发 map | 否 |
| `db.js` | IndexedDB 封装（items / blobs）、统计、导出导入 | 否（用 indexedDB） |
| `settings.js` | 默认配置、深合并、读写 `chrome.storage.local` | 是 |
| `messaging.js` | `sendMessage` / `sendToTab` / 端口 `runTask` | 是 |

---

## 2. 消息协议

### 2.1 一次性消息（`chrome.runtime.sendMessage`）

| 类型 | 方向 | payload | 返回 |
| --- | --- | --- | --- |
| `MV_SCAN_RESULT` | content → bg | `{images, videos, total}` | `{ok:true}` |
| `MV_IMPORT_ONE` | content → bg | 单条媒体（预留，当前统一走端口） | `{ok, item}` |
| `MV_OPEN_LIBRARY` | 任意 → bg | — | `{ok:true}` |
| `MV_OPEN_SETTINGS` | 任意 → bg | — | `{ok:true}` |
| `MV_GET_ADAPTER_META` | 页面 → bg | — | `{ok, adapters[]}`（已剥离函数） |
| `MV_GET_SETTINGS` | 页面 → bg | — | `{ok, settings}` |
| `MV_GET_STATS` | 页面 → bg | — | `{ok, stats}` |
| `MV_NOTIFY` | 页面 → bg | `{title, message}` | `{ok:true}` |
| `MV_GET_TAB_STATS` | popup → content | — | `{ok, images, videos, total, scanning}` |
| `MV_SCAN_NOW` | popup/菜单 → content | `{silent?}` | `{ok, total}` |
| `MV_IMPORT_BATCH` | popup → content | — | `{ok}`（content 内部分批） |
| `MV_RELOAD_SETTINGS` | bg → content | — | `{ok}` |

> 注意：`MV_GET_TAB_STATS` 等由后台仍以 `chrome.tabs.sendMessage` 发给 content；页面里的 popup 直接调用 `sendToTab`。

### 2.2 端口长任务（`chrome.runtime.connect({name:'mv-task'})`）

消息格式：

```js
// client → SW
{ kind: 'request', type: 'import', payload: {...} }
{ kind: 'ping' }                       // 心跳，每 20s，防止 SW 空闲回收

// SW → client
{ kind: 'progress', payload: { done, total, message } }
{ kind: 'done',     payload: {...结果} }
{ kind: 'error',    payload: { message } }
```

| type | payload | done 结果 |
| --- | --- | --- |
| `import` | `{items:[媒体描述], openLibraryAfter?}` | `{imported:[item], failed:[{url,error}], duplicates}` |
| `upload` | `{id, adapterId}` | `{item}`（item.remote 已写入） |
| `upload-batch` | `{ids, adapterId}` | `{results:[{id,ok,url?,error?}], ok, failed}` |
| `transfer` | `{id, adapterId}` 或 `{ids, adapterId}` | `{item}` 或 `{results:[{id,ok,url?,error?}], ok, failed}`；旧 remote 进入 `history[]` |
| `test-adapter` | `{adapterId, config}` | `{ok, message}` |
| `delete` | `{ids}` | `{removed}` |

**为什么长任务必须走端口**：MV3 的 service worker 空闲约 30 秒会被终止。端口连接期间 SW 保持存活，配合客户端 20 秒心跳，大视频下载/上传不会中断。这也是「不要在页面里直接 fetch 上传」的原因——页面关闭即中断，且跨域策略更复杂。

### 2.3 媒体描述（导入入参）

```js
{
  url: string,           // 媒体地址（可为 data:/blob:）
  kind: 'image'|'video',
  pageUrl, pageTitle,    // 来源页，用于降级记录与统计
  width, height,         // 已知分辨率
  alt,                   // 替代文本 / 标题来源
  duration,              // 视频时长（秒）
  poster,                // 视频封面
  stream: boolean,       // m3u8/mpd 等流媒体，只存地址
  dataUrl?: string,      // blob: 媒体在页面内转成的 dataURL
  source: string         // hover | img | video | background | meta | link | context-menu
}
```

---

## 3. 数据模型（IndexedDB）

数据库：`mediavault`，版本 `1`（`DB.VERSION`）。

### 3.1 `items`（keyPath: `id`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `itm_xxx` |
| `kind` | `image`/`video` | 媒体类型 |
| `title` | string | 展示标题（alt 或文件名） |
| `fileName` | string | 落盘/上传用文件名（已补扩展名） |
| `sourceUrl` | string | 原始链接（去重键） |
| `pageUrl` / `pageTitle` / `site` | string | 来源页信息 |
| `mime` | string | 真实 MIME |
| `width` / `height` / `size` / `duration` | number | 分辨率、字节数、时长 |
| `status` | `ready`/`link-only`/`pending` | `link-only` 表示只有记录没有本体 |
| `fav` | 0/1 | IndexedDB 不能索引布尔值，用数字 |
| `tags` | string[] | 标签；旧数据可能缺省，读取处兜底 `item.tags || []` |
| `note` | string | 降级原因等 |
| `files` | `{orig, thumb}` | Blob 存储键 |
| `remote` | object/null | `{adapterId,url,path,size,privateLink,uploadedAt,error,history}`；`history` 为旧站点记录 `{adapterId,url,at}[]`，旧数据可能缺省 |
| `createdAt` / `updatedAt` | ISO string | 时间 |

索引：`createdAt`、`kind`、`site`、`provider`、`status`、`fav`。

### 3.2 `blobs`（keyPath: `id`）

| 字段 | 说明 |
| --- | --- |
| `id` | `{itemId}:orig` 或 `{itemId}:thumb` |
| `itemId` | 归属条目（索引） |
| `blob` | 二进制 |
| `size` / `mime` | 冗余元信息，便于统计与排查 |

**为什么分表**：列表页只需要元数据；若把 Blob 塞进 item，每次 `getAll()` 会把整库媒体读进内存，几百 MB 就卡死。分表后列表渲染只读元数据，缩略图在卡片进入视口时才按 key 读取。

### 3.3 标签数据模型

- 标签存放在 `item.tags: string[]`，纯前端派生数据，不建索引；新增/改名/删除都直接写回该条目。
- 录入规则：中英文逗号或空白分隔，去重去空；大小写与空格按原文保留。
- 兼容旧数据：v1.0.0 及更早条目可能没有 `tags` 字段，所有读取处统一兜底 `item.tags || []`，不做破坏性迁移。
- 筛选：卡片 chips 与「标签快捷筛选」行均为多选 **OR（任一命中）** 语义——条目只要命中任一选中标签就保留，不要求全部命中；搜索框关键字同样匹配标签文本。当前未提供 AND（全部命中）模式，如需改为 AND 应先评估使用场景再调整 `applyFilter()` 的交集判断。
- 转存历史存放在 `item.remote.history: {adapterId,url,at}[]`，同样兜底 `item.remote?.history || []`；新记录成功写入后才追加，失败不写库。

---

## 4. 关键流程

### 4.1 悬停入库

```text
用户悬停图片
  → content 命中 img/video/背景图，判断尺寸 >= hover.minPx
  → 光标旁出现 pill（图片/视频/流媒体三种文案）
  → 点击（Shift 表示强制上传）
  → runTask('import', {items:[描述]})
      → SW 去重（sourceUrl）
      → fetchMedia：① 带 Cookie + 原页 referrer ② 无 referrer
      → 体积校验（importRules.maxMB，默认 512MB）
      → putBlob(orig) → 缩略图（image）→ putItem
      → 若 autoUpload.enabled → uploadItemObject → 写 item.remote
  → content 收到 done，toast「已存入个人空间 · 文件名」
```

抓取失败时：仍会写入 `status:'link-only'` 的记录（`keepLinkOnFailure` 语义），个人空间可见、可复制原链，但预览会尝试直接加载源站。

### 4.2 批量入库

- 悬浮球「全部存入」/ 清单面板「全部存入」/ popup「全部存入」→ content 将清单按 40 条分批提交，逐批 `runTask('import')`。
- 后台在单批内用 `mapLimit(concurrency=3)` 抓取，`progress` 回传 `done/total`，content 用 toast 实时显示进度。
- 单次总量上限 `LIMITS.maxBatch = 300`（`import` 会 `slice` 截断）。

### 4.3 上传外部站点

```text
图库/弹窗 → runTask('upload'|'upload-batch')
  → SW getItem → getBlob(orig)
  → adapters.uploadTo(id, {blob,fileName,mime,kind,config})
      ├─ github：PUT contents API（base64，≤40MB）
      ├─ s3：AWS SigV4 直传（WebCrypto 计算签名）
      ├─ webdav：MKCOL 建目录 → PUT（Basic Auth）
      └─ http：multipart POST → 按 responsePath 取 URL
  → updateItem(remote)
  → 失败：remote.error 落库，图库卡片标红，可重试
```

`remote.url` 与 `remote.privateLink` 决定 UI 文案（「已上传」/「已上传·私有」）。

### 4.4 扫描管线与过滤

1. `img`：`currentSrc` → `srcset` 最大候选 → `data-src` 等懒加载属性，按 `naturalWidth/Height` 过滤小于 `scan.minPx` 的图。
2. `picture > source`：补抓未渲染的 srcset。
3. `video`：`currentSrc/src/source`，记录 `poster`、`duration`、`videoWidth`。
4. `a[href]`：匹配 mp4/webm/mov/m4v/mkv/m3u8/mpd/flv。
5. `meta`：og:image、og:video、twitter:image。
6. 背景图：遍历前 3000 个元素读 `backgroundImage`，每 180 个让出主线程，超过 `maxItems` 提前结束。
7. 统一 `absolute()` 补全相对地址、去重、按面积排序、截断到 `maxItems`。

触发时机：首次 `document_idle + 700ms`；滚动停止 1.2s 重扫（最多 20 次）；popup/菜单手动「重新扫描」。扫描结果通过 `MV_SCAN_RESULT` 更新当前标签页角标。

### 4.5 存储路由与默认站点

自动上传与手动批量上传前，先由共享函数 `src/shared/routing.js` 的 `resolveTargetAdapter(settings, kind, adapters)` 解析目标站点，解析顺序：

```text
autoUpload.byKind[类型]   该类型单独指定的站点（空串/ none = 未指定）
  → autoUpload.adapterId  全局兜底站点
  → 第一个已启用且 supports 该类型的适配器
```

- 任一层命中的站点若不支持当前类型，继续向下兜底，而不是直接报错。
- `adapters` 描述列表由调用方组装（SW 从 `ADAPTERS` + 设置启用态生成；页面从 `MV_GET_ADAPTER_META` 元数据 + 设置启用态生成），路由函数本身不依赖 chrome API，SW / content / popup / library 复用同一份逻辑。
- 设置页提供「全局默认 + 图片默认 + 视频默认」三个下拉；不支持该类型的已启用站点显示为不可选并注明原因（如「不支持视频」）。
- 解析结果的站点 label 会带进 toast / 通知文案；解析不到任何可用站点时，手动上传给出可读错误，自动上传则只存本地。

### 4.6 跨站转存流程

```text
图库详情弹窗 → 选择目标站点 → 「转存到该站点」→ runTask('transfer', {id, adapterId})
  → SW transferOne：
      ① 取文件：优先本地 Blob（files.orig）；无本地副本时下载 remote.url 或 sourceUrl
      ② uploadTo(目标适配器)：配置校验 → 体积校验 → 上传（成功前不写库）
      ③ 旧 remote 记录 push 进 remote.history[]（{adapterId,url,at}，上限 20 条）
      ④ 写入新 remote：{adapterId,url,path,size,privateLink,uploadedAt,error:null,history}
  → 失败：抛可读错误，原 item.remote 保持原样，不覆盖旧链接与历史
```

- `transfer` 端口任务支持单条（`{id}`）与批量（`{ids}`），批量并发与上传一致（并发 2，逐条回 progress）。
- 仅链接条目也可转存：从外部直链下载后再上传；源链接不可达时给出抓取失败原因。
- 普通重传（`upload`）成功时同样保留已有 `history[]`；失败时保留旧 remote 字段，只追加 `error` 标记。

---

## 5. 存储与配额

- 媒体本体：IndexedDB（`unlimitedStorage` 权限避免被小配额挤掉）。
- 设置：`chrome.storage.local`，键 `mv.settings`，深合并默认值，旧版本缺字段不会崩。
- 悬浮球位置：同一键内的 `ball.x/ball.y`（相对右下角的偏移）。
- 占用展示：`navigator.storage.estimate()` + 元数据累计 `size`，设置页/图库都会显示。

---

## 6. 安全与隐私边界

| 边界 | 现状 |
| --- | --- |
| 页面 JS 能否读到扩展数据 | 不能。content 运行在 isolated world；UI 在 Shadow DOM 内，页面只能看到宿主节点 |
| 密钥存放 | `chrome.storage.local` 明文，仅本机。浏览器扩展没有安全存储，公共电脑请勿保存 Token |
| 网络请求去向 | 仅 ①你正在浏览的页面（抓媒体）②你配置的适配器端点 ③GitHub API。无遥测、无远程脚本 |
| 上传内容 | 仅在你触发（点击/自动上传开关）后发生 |
| 权限范围 | `http/https` 全站（扫描与抓取需要）；`file://` 未默认开启，需用户在扩展详情手动允许 |

> 已知取舍：content 也能读 `chrome.storage.local`，因此严格来说内容脚本上下文可见 Token。攻击面限于扩展自身代码；若未来引入第三方脚本或远程配置，必须改为「SW 持有密钥、content 只能发任务」。

---

## 7. 设计决策记录（ADR）

| 编号 | 决策 | 原因 | 代价 |
| --- | --- | --- | --- |
| ADR-001 | **免构建**（无 npm/打包） | 目标用户是「会用 AI 的技术小白」，改完刷新即可生效；仓库根目录可直接加载 | content 不能用 ES Module（见 ADR-002）；无法用 TS/SCSS |
| ADR-002 | content 写成单文件 IIFE | MV3 `content_scripts` 不支持 `type:module`，动态 import 受 CSP 限制 | 与 shared 有少量逻辑重复（`runTask`、常量），需人工同步 |
| ADR-003 | **本地优先**：先存 IndexedDB，再可选上传 | 外部站可能挂、可能改 API；本地副本保证不丢数据 | 占用本机空间 |
| ADR-004 | 元数据与 Blob 分表 | 列表性能；避免整库读入内存 | 删除需同时清理两个 store；导出清单不含文件本体 |
| ADR-005 | 长任务走端口 + 心跳 | MV3 SW 30 秒回收，端口连接期间保活 | 页面关闭会中断任务（换取实现简单） |
| ADR-006 | 适配器 **元数据驱动 UI** | 新增存储只写一个 js + 注册一行，设置页自动渲染表单 | 字段表达能力有限（只有 text/password/number/textarea/boolean） |
| ADR-007 | 抓取失败**降级为仅链接** | 防盗链/登录墙很常见，直接报错会让用户白点 | 图库里存在无法预览的条目，需要文案区分 |
| ADR-008 | 密钥明文存 `storage.local` | 无后端、无 OAuth 服务器，最简单可靠 | 本机泄露风险；文档明示并要求可撤销 Token |
| ADR-009 | Shadow DOM 承载页面 UI | 与宿主页面样式完全隔离，避免 `!important` 大战 | 调试稍麻烦；跨 shadow 的事件重定向需注意 |
| ADR-010 | GitHub 用 Contents API 而非 git 协议 | 纯 HTTP、无需本地 git、可在 SW 内完成 | 单文件 ≤40MB，视频不合适 |

---

## 8. 扩展点一览

| 想做什么 | 改哪里 |
| --- | --- |
| 新增存储站点 | `src/background/adapters/xxx.js` + `adapters/index.js` 注册 |
| 新增扫描来源 | `content.js` 的 `scanPage()`，新增 `addCandidate` |
| 调整悬停判定 | `content.js` 的 `hoverCandidatesFromEvent()` |
| 新增页面消息 | `constants.js` 的 `MSG` + `service-worker.js` 路由 + 调用方 |
| 新增后台长任务 | `constants.js` 的 `TASK` + `runTask()` switch + 调用方 `runTask` |
| 改数据表结构 | `db.js` 的 `onupgradeneeded` 与 `DB.VERSION`（务必写迁移分支） |
| 改配置项 | `settings.js` 的 `DEFAULT_SETTINGS` + 设置页控件 + 消费方 |

详细操作步骤与代码模板见 [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)。
