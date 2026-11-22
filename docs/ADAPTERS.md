# 存储适配器配置手册（Adapters）

> 十六个内置适配器都能在「设置 → 上传目标」里启用。全部配置只存本机，**不需要任何后端**。
> 每个适配器都有「测试」按钮；失败信息会给出中文原因。v1.2 起卡片为紧凑单行，配置项在「展开」里。

---

## 通用前提

1. **先在设置页启用开关**，否则不会出现在「默认上传目标」下拉里。
2. 「入库后自动上传」是可选项；不打开也能用，图库里可以手动/批量上传。
3. 扩展已声明 `http/https` 全站权限，跨域请求通常不需要额外配 CORS；但部分服务端会校验来源，遇到时按各节提示处理。
4. 单文件上限：GitHub 约 40MB，HTTP 图床按你配置的 `maxMB`（默认 10MB），S3/WebDAV 无硬限制（受服务商套餐约束）。
5. 新增站点沿用现有 `http/https` 通配权限，无需额外申请域名权限。
6. 默认开箱可用：**imgdb.io（图片）** 与 **Unlockify（视频）** 都不需要注册。

| 适配器 | 最适合 | 免费额度参考 | 外链可否公开 |
| --- | --- | --- | --- |
| imgdb.io | 图片 | 单图 ≤16MB，免注册，可设永久/密码 | 可以 |
| Unlockify | 视频 | 单文件 ≤1.9GB，免注册，出播放页/直链 | 可以 |
| GitHub 仓库 | 图片、小视频 | 仓库容量受 GitHub 政策约束，无流量费 | 公开仓库可以；私有仓库不行 |
| S3 兼容 | 视频、大文件 | Cloudflare R2 10GB 存储 + 出网免费 | 配了公开域名可以 |
| WebDAV | 归档、接网盘 | 取决于网盘（坚果云/Alist 挂载） | 多数需登录；Alist 可配直链 |
| HTTP 图床 | 接已有图床 | 取决于图床（SM.MS 等） | 一般可以 |
| Cloudinary | 图片 + 视频 | 免费额度按账号计（每月） | 可以 |
| Wistia | 视频 | 免费版有视频数量限制 | 播放页可公开 |
| Catbox | 图片、视频 | 单文件 ≤200MB，永久保留 | 可以（匿名直链） |
| Pixeldrain | 视频、大文件 | 单文件 ≤20GB，至少保留约两个月 | 可以（下载直链） |
| 0x0.st | 临时分享（实验性） | 单文件 ≤512MB | 扩展内不可用，见该节 |
| ImgBB | 图片 | 单图 ≤32MB | 可以 |
| Imgur | 图片、GIF、短视频 | 单文件约 ≤200MB，视频 ≤60s | 可以 |
| ImgPile / YourImageShare / Hippo | 手动网页上传 | 单文件 97MB / 200MB / 账号额度 | 可以 |

---

## imgdb.io 免费图床（默认启用）

**原理**：`POST https://imgdb.io/api/v1/upload`，multipart 字段名 `file`；成功返回 201 + JSON，`url` 形如 `https://imgdb.io/i/<id>.png`。免注册，单图 ≤16MB，支持 png/jpg/gif/webp/avif/bmp。

### 可配置项

| 字段 | 说明 |
| --- | --- |
| 保留时长（ttl） | 秒；`0` = 永久（推荐），留空按站点默认 72 小时 |
| 访问密码 | 可选；填了之后只有带密码的人能打开链接（走 `X-Upload-Password` 头） |
| 描述 | 可选；写入站点上传记录，便于检索 |

### 注意

- 站点官方文档：<https://imgdb.io/docs>、<https://imgdb.io/llms.txt>（`imgdb.readme.io` 上的旧版接口不要用）。
- 实机验证（2026-11）：上传 1px PNG 返回 `https://imgdb.io/i/ENgY4IM.png`，直链可直接打开。
- 公开图床意味着拿到链接的人都能看；私密内容请加密码，或改用 S3 / WebDAV。

## Unlockify 视频直链（默认启用）

**原理**：`POST https://stream.unlockify.ink/backend/api/web-upload`（multipart，字段 `file`，只收视频）→ 返回 `job_id`；再轮询 `GET /backend/api/web-upload/<job_id>`，直到 `status=ready`，返回 `video_url`（形如 `/video/<public_id>`）。

### 可配置项

| 字段 | 说明 |
| --- | --- |
| 同时返回播放页链接 | 开启后图库里存 `https://stream.unlockify.ink/video/xxx` 网页；关闭则优先存直链 |

### 注意

- 单文件 ≤1.9GB；站点会把文件转存到自己的 Telegram 频道，实测 788KB 视频约 20 秒完成。
- 浏览器端有「10 次网页上传」计数提示，属站点策略，不影响脚本调用。
- 该站点 TLS 连接偶尔抖动，适配器内置一次重试；仍失败会提示稍后再试。
- 上传只收视频；图片请走 imgdb.io。

## Cloudinary（需注册，图 + 视频）

**原理**：无签名上传预设直传，`POST https://api.cloudinary.com/v1_1/<cloud_name>/auto/upload`，字段 `file` + `upload_preset`（可选 `folder`），返回 `secure_url`。API Secret 不需要填，安全性更好。

### 步骤

1. 注册 Cloudinary → 控制台首页抄 **Cloud name**。
2. Settings → Upload → Upload presets → Add upload preset；**Signing Mode = Unsigned**，记下 preset 名称。
3. 把 Cloud name 和 preset 填进扩展；「测试」会用 1px 测试图真传一次（后台可删）。

## Wistia（需注册，视频托管）

**原理**：经典接口 `POST https://upload.wistia.com`，字段 `api_password` + `file`，返回 `media.hashed_id`，播放页 `https://home.wistia.com/medias/<id>`。

### 步骤

1. 注册 Wistia → Account → API Access → 取 **API password**（不是登录密码）。
2. 填进扩展，可选填项目 ID；「测试」只验证密码是否被接受。

## 网页上传站点（扩展不代传）

| 站点 | 单文件 | 说明 |
| --- | --- | --- |
| ImgPile | 约 97MB | 免注册，图+视频，给直链/BBCode；免费图会转 WebP 压到长边 2048px，长期无人访问会回收 |
| YourImageShare | ≤200MB | 免注册，格式覆盖 MP4/MKV/MOV/WEBM 等；站点有 key 型 REST API 但端点未公开 |
| Hippo Video | 账号额度 | 企业级，免费版 50 条/月；Import/Upload API 需账号 + 应用授权 |

这三张卡片只有「打开站点」按钮：点了会在新标签打开上传页，自己拖文件即可。它们不会出现在「默认上传目标」下拉里，也不会被自动上传选中。



---

## GitHub 仓库图床

**原理**：把文件提交到你自己的仓库，用 raw 链接访问。免费、有版本历史，适合图片和小体积视频。

### 步骤

1. **建素材仓库**：GitHub → New repository → 命名如 `media-assets` → 勾选 **Public**（私有仓库的 raw 链接需要 Token，不能当公开图床）→ 勾选 Add a README。
2. **建 Token**：
   - 推荐 Fine-grained token：Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token；
   - Repository access 选 `Only select repositories` → 选刚建的仓库；
   - Permissions → Repository permissions → **Contents: Read and write**；
   - 生成后复制 `github_pat_...`（只显示一次）。
   - 也可以用经典 token（勾 `repo` 作用域），前缀是 `ghp_`。
3. **填配置**：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| Personal Access Token | `github_pat_xxx` | 粘贴，注意不要带空格 |
| 仓库所有者 | `focklly` | 用户名或组织 |
| 仓库名 | `media-assets` | 与代码仓库分开 |
| 分支 | `main` | 留空默认 main |
| 存储目录 | `media/` | 会自动按 `年/月/` 再分子目录 |
| 自定义访问前缀 | `https://cdn.jsdelivr.net/gh/focklly/media-assets@main/` | 可选；留空用 raw 链接 |

4. 点「测试连接」，应显示 `连接正常：owner/repo（公开，可写）`。

### 注意

- Contents API 单文件建议 ≤ 40MB；视频请用 S3/WebDAV。
- raw 链接对公开仓库有效：`https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`。
- jsDelivr 前缀能加速并隐藏原始仓库路径，但它是第三方 CDN，可能有缓存延迟与大小限制。
- 上传同名文件会自动加短哈希后缀，不会覆盖旧图。

---

## S3 兼容对象存储

**原理**：浏览器内用 AWS Signature V4 直接 PUT，不经过任何中转服务。支持 Cloudflare R2、MinIO、阿里云 OSS、七牛 Kodo、Backblaze B2 的 S3 接口。

### Cloudflare R2（推荐放视频）

1. Cloudflare 控制台 → R2 → **Create bucket**（如 `media`）。
2. 记下 **Account ID**（R2 首页右侧），Endpoint 形如：

   ```text
   https://<AccountID>.r2.cloudflarestorage.com
   ```

3. **Create API token**：R2 → Manage R2 API Tokens → Create token → 权限选 **Object Read & Write** → 限定到该桶 → 生成后保存 `Access Key ID` / `Secret Access Key`（Secret 只显示一次）。
4. （可选但推荐）**公开访问**：桶 Settings → Public access：
   - 开 `r2.dev` 子域，得到 `https://pub-xxxx.r2.dev`；或用自定义域名（需绑自己的域名）。
   - 把该地址填进「公开访问域名」，否则外链是私有端点，别人打不开。
5. 填配置：

| 字段 | 值 |
| --- | --- |
| Endpoint | `https://<AccountID>.r2.cloudflarestorage.com` |
| Region | `auto` |
| Bucket | `media` |
| Access Key ID / Secret | 上一步生成 |
| 存储目录 | `media/` |
| 公开访问域名 | `https://pub-xxxx.r2.dev`（有就填） |
| Path-Style 访问 | **开** |

6. 测试连接：会写入一个 `.mediavault-test.txt`，成功即签名与权限正确。

> 如果测试返回 `403 SignatureDoesNotMatch`：检查 Region 是否为 `auto`、Endpoint 是否带桶名（**不要带**）、Path-Style 是否为开。
> 如果 PUT 被浏览器拦截：给桶加 CORS 规则，`AllowedOrigins` 填 `chrome-extension://<你的扩展ID>` 或 `*`，`AllowedMethods` 含 `PUT`、`GET`、`HEAD`，`AllowedHeaders` 含 `*`。

### MinIO / 阿里云 OSS / 七牛

- MinIO：Endpoint 如 `http://127.0.0.1:9000`，Region 随服务端（常为 `us-east-1`），Path-Style **开**。
- 阿里云 OSS：Endpoint 形如 `https://oss-cn-hangzhou.aliyuncs.com`，Region 填 `oss-cn-hangzhou`，Path-Style **关**（虚拟主机风格），AccessKey 用 RAM 子账号并只授权该 Bucket。
- 七牛 Kodo：使用其 S3 兼容 Endpoint 与对应 Region，Path-Style **关**，公开域名填绑定的 CDN 域名。

> 这几家对签名细节更敏感；若报签名错误，优先核对 Region 字符串与 Path-Style 两个开关。

---

## WebDAV 网盘

**原理**：标准 WebDAV：`PROPFIND` 测试、`MKCOL` 建目录、`PUT` 上传。通用性最好，可接坚果云、Nextcloud、群晖、Alist。

### 坚果云

1. 坚果云网页端 → 账户信息 → 安全选项 → **添加应用密码**（不要用登录密码）。
2. 配置：

| 字段 | 值 |
| --- | --- |
| WebDAV 地址 | `https://dav.jianguoyun.com/dav/` |
| 用户名 | 登录邮箱 |
| 密码 | 应用密码 |
| 存储目录 | `MediaVault/` |
| 公开直链前缀 | 留空（坚果云不提供公开直链） |

3. 测试连接应返回「认证成功」。上传后条目会标记「已上传·私有」，外链仅供自己登录后访问。

### Alist（把百度网盘 / 阿里云盘 / 夸克接进来）

1. 部署 Alist（Docker 或二进制），在 Alist 后台「存储」里挂载你的网盘（百度网盘需授权，阿里云盘用 refresh token 等）。
2. Alist 默认 WebDAV 地址：`http://<主机>:5244/dav`，账号密码为 Alist 登录账号。
3. 配置：

| 字段 | 值 |
| --- | --- |
| WebDAV 地址 | `http://127.0.0.1:5244/dav`（或公网域名，**必须带结尾斜杠**） |
| 用户名 / 密码 | Alist 账号 |
| 存储目录 | `MediaVault/` |
| 公开直链前缀 | 可选，如 `https://alist.example.com/d/MediaVault/`，用于生成可分享链接 |

4. 建议在 Alist 里给该目录设置「允许 WebDAV 写入」。
5. 测试连接走 `PROPFIND`；返回 `207`/`200` 即正常。

### Nextcloud / 群晖

- Nextcloud：`https://你的域名/remote.php/dav/files/<用户名>/`，密码用应用密码。
- 群晖：`http://NAS:5005/` 路径（在 WebDAV Server 套件里开启），账号密码同 DSM。

---

## 通用 HTTP 图床

**原理**：`multipart/form-data` POST 一个文件字段，从 JSON 响应里按点路径取 URL。任何返回 JSON 的图床都能接，**不需要改代码**。

### SM.MS

| 字段 | 值 |
| --- | --- |
| 上传接口 | `https://sm.ms/api/v2/upload` |
| 文件字段名 | `smfile` |
| 附加请求头 | `{"Authorization":"你的API Token"}`（按 SM.MS 官方文档确认是否带 Bearer 前缀） |
| 返回 URL 的路径 | `data.url` |
| 单文件上限 | `5`（免费账号通常 5MB） |

### 兰空图床（Lsky Pro）

| 字段 | 值 |
| --- | --- |
| 上传接口 | `https://你的图床域名/api/v1/upload` |
| 文件字段名 | `file` |
| 附加请求头 | `{"Authorization":"Bearer 你的Token"}` |
| 返回 URL 的路径 | `data.links.url` |

### 自建接口

只要接口接受 `multipart` 的 `file` 字段并返回 `{"url":"https://..."}`：

| 字段 | 值 |
| --- | --- |
| 上传接口 | `https://your.api/upload` |
| 文件字段名 | `file` |
| 返回 URL 的路径 | `url` |
| 链接补全前缀 | 返回相对路径时填，例如 `https://i.example.com/` |

> 如果接口直接返回纯文本 URL（不是 JSON），把「返回 URL 的路径」填成 `text`。

---

## Catbox 免费文件床

<a id="catbox"></a>

**原理**：`multipart/form-data` POST 到 Catbox 官方接口，返回纯文本直链。免注册即可上传，支持图片与视频，适合存不大的静态素材。

### 申请/配置步骤

- 无需注册，直接在设置页启用即可。
- 接口与字段：`POST https://catbox.moe/user/api.php`，表单字段 `reqtype=fileupload`、`fileToUpload`，可选 `userhash`。
- 配置字段：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| 用户哈希（userhash） | 可选 | 在 Catbox 账号页可获取；填写后上传归到自己账号管理，留空即匿名上传 |

- 上传成功后返回纯文本直链，形如 `https://files.catbox.moe/<随机>.<扩展名>`。

### 免费额度与限制

- 单文件 ≤ 200MB，支持图片与视频。
- 文件永久保留；匿名上传的文件不归账号管理，删除与管理需自行留存链接。
- 具体政策以站点当前公告为准。

### 常见报错

| 状态码 / 现象 | 可能原因 | 处置建议 |
| --- | --- | --- |
| `413` / 上传中断 | 文件超过 200MB 上限 | 压缩或拆分；视频换 Pixeldrain / R2 |
| `403` / 被拒绝 | 内容违反站点政策，或来源被拦 | 核对内容类型；仍失败换站点 |
| `429` | 上传过于频繁触发限流 | 稍后重试，降低连续上传频率 |
| 返回纯文本但内容不是 URL | 站点维护页、拦截页或错误提示 | 稍后重试；核对上传域名；按返回文本判断 |

---

## Pixeldrain 免费网盘

<a id="pixeldrain"></a>

**原理**：以原始二进制 body `PUT` 到 Pixeldrain 文件接口，返回 JSON（含文件 id），再拼接下载直链。支持图片与视频，免费额度大，适合大文件与短视频。

### 申请/配置步骤

- 可匿名使用；注册账号后可在账号设置 / API 页面获取 API Key。
- 接口：`PUT https://pixeldrain.com/api/file/<文件名>`，body 为原始二进制；带 Key 时使用 Basic 认证。
- 配置字段：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| API Key | 可选 | 填写后上传归到自己账号；留空即匿名上传 |

- 上传成功返回 JSON（含 `id`），直链形如 `https://pixeldrain.com/api/file/<id>?download`。

### 免费额度与限制

- 单文件 ≤ 20GB，支持图片与视频。
- 文件至少保留约两个月，保留时长与账号活跃度相关。
- 有下载限速与流量政策；具体配额以站点当前公告为准。

### 常见报错

| 状态码 / 现象 | 可能原因 | 处置建议 |
| --- | --- | --- |
| `400` | 文件名非法（含特殊字符等），或空间 / 站点策略拒绝 | 改用简单文件名；核对账号空间与政策；仍失败换站点 |
| `401` / `403` | API Key 无效、已撤销或权限不足 | 核对 Key 与认证方式；重新生成 |
| `413` | 文件超过 20GB 上限 | 拆分或换对象存储 |
| `429` | 触发限流 | 稍后重试，降低并发 |
| 返回纯文本但不是 JSON / URL | 站点维护页、拦截页 | 稍后重试；按返回文本判断 |

---

## 0x0.st 临时文件床（实验性，默认关闭）

<a id="zeroxzero"></a>

**原理**：`multipart/form-data` POST 到 0x0.st，返回纯文本直链。定位是临时分享，不适合长期归档。

### 先说结论：扩展内不可用

实测（2026-11，同一台机器）：

| 请求 UA | 响应 |
| --- | --- |
| 浏览器 UA | **418**（站点按政策拒绝浏览器 UA） |
| `MediaVault/1.2.0` 或 `curl/8.x` | **500** |

而浏览器**不允许**脚本设置 `User-Agent`（属于 forbidden header），所以扩展发出的请求一定是浏览器 UA → 必然被拒。因此 v1.2 把 0x0.st 标为「实验性·默认关闭」，并在「测试」里直接说明原因、建议改用 **imgdb.io**（图片）或 **Pixeldrain / S3**（视频）。保留适配器只是给「有代理或自建转发」的用户留入口。

### 其余说明（仅供参考）

- 无需注册；接口 `POST https://0x0.st`，表单字段 `file`，可选 `expires`（小时）。
- 单文件 ≤512MB，保留期约 30–365 天。
- 保留期随文件体积约 30–365 天，过期后由站点清理。
- 站点要求客户端使用可识别的 User-Agent；本扩展使用 `MediaVault/<版本号>`，不会伪装成浏览器；UA 不被识别时可能被拒绝。浏览器对脚本设置的 User-Agent 头并不保证放行，若被站点拒绝属站点策略，本扩展不通过改写浏览器 UA 来绕过。
- 上传内容公开可访问，站点可依政策删除违规文件；具体规则以站点当前公告为准。

### 常见报错

| 状态码 / 现象 | 可能原因 | 处置建议 |
| --- | --- | --- |
| `403` | UA 不可识别，或 IP / 账号被站点封禁 | 先确认不是文件超限；若返回文本提示 User-Agent 不被允许，说明浏览器未放行自定义 UA，直接改用 Catbox 或 Pixeldrain（两者不校验 UA） |
| `413` | 文件超过 512MB 上限 | 压缩 / 拆分，或换 Pixeldrain |
| `429` | 触发限流 | 稍后重试 |
| 返回纯文本但内容不是 URL | 维护页、拦截页或站点错误说明 | 按返回文本判断；稍后重试 |

---

## ImgBB 免费图床

<a id="imgbb"></a>

**原理**：`multipart/form-data` 带 API Key POST 到 ImgBB 接口，返回 JSON 中的图片直链。仅支持图片。

### 申请/配置步骤

- 需要注册 ImgBB 账号。
- API Key 在账号设置（ImgBB 后台 API 页面）获取。
- 接口：`POST https://api.imgbb.com/1/upload?key=<API_KEY>`，表单字段 `image`。
- 配置字段：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| API Key | 必填 | 粘贴账号设置里的 Key |

- 上传成功返回 JSON，取 `data.url` / `data.display_url`。
- 注意：官方把 API 访问列在 Pro 权益里，可能需要先在账号内开通 API；是否需要付费套餐以站点当前公告为准。

### 免费额度与限制

- 仅支持图片，单图 ≤ 32MB。
- API 访问权益、可上传数量等以站点当前公告为准。

### 常见报错

| 状态码 / 现象 | 可能原因 | 处置建议 |
| --- | --- | --- |
| `401` / `403` | API Key 无效，或账号未开通 API / 套餐不含 API | 核对 Key；在账号设置确认 API 已开通；权益以站点公告为准 |
| `413` | 图片超过 32MB 上限 | 压缩图片后重试 |
| `429` | 触发限流 | 稍后重试 |
| 返回 HTML / 纯文本但不含 `data.url` | 维护页、拦截页或鉴权页 | 核对 Key 与接口地址；稍后重试 |

---

## Imgur 免费图床

<a id="imgur"></a>

**原理**：带 `Client-ID` 请求头 POST 到 Imgur 接口，返回 JSON 中的图片直链。支持图片、GIF 与 mp4。

### 申请/配置步骤

- 需要注册账号；在 [api.imgur.com](https://api.imgur.com/) 注册应用（Register an application）后获得 **Client-ID**。
- 接口：`POST https://api.imgur.com/3/image`，请求头 `Authorization: Client-ID <id>`，表单字段 `image`。
- 配置字段：

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| Client-ID | 必填 | 粘贴注册应用后得到的 Client-ID |

- 上传成功返回 JSON，取 `data.link`。

### 免费额度与限制

- 支持图片 / GIF / mp4，单文件约 ≤ 200MB，视频 ≤ 60s。
- 视频能力在部分账号 / 地区受限；匿名 Client-ID 有配额与限流。
- 具体额度与开放范围以站点当前公告为准。

### 常见报错

| 状态码 / 现象 | 可能原因 | 处置建议 |
| --- | --- | --- |
| `401` / `403` | Client-ID 无效、应用状态异常或被封禁 | 核对 ID 与应用状态；重新确认应用配置 |
| `413` / 上传被拒 | 超过体积（约 200MB）或视频时长（≤60s）限制 | 压缩 / 缩短视频；换 Catbox 或 Pixeldrain |
| `429` | 匿名 Client-ID 配额耗尽或限流 | 降低上传频率，稍后重试 |
| 返回 JSON 含 `data.error`，或非 JSON 纯文本 | 接口错误、维护页 / 拦截页 | 按错误文本处置；稍后重试 |

---

## 排错对照表

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 测试连接 401 | Token/密码错误或过期 | 重新生成；GitHub 检查 Contents 权限 |
| 测试连接 404 | 仓库名/桶名/WebDAV 路径写错 | 核对大小写与结尾斜杠 |
| `403 SignatureDoesNotMatch` | S3 Region 或 Path-Style 配错 | R2 用 `auto`+开；OSS 用实际 region+关 |
| `413` / 上传中断 | 文件超过站点上限 | 视频换 R2/WebDAV；图片调低体积 |
| 上传成功但链接打不开 | 私有桶/私有仓库/未配公开域名 | 配 `publicBase` 或改公开 |
| 图床上传失败 `data.url` 找不到 | 响应结构与预期不同 | 用浏览器抓一次真实响应，改 `responsePath` |
| WebDAV PUT 409 | 父目录不存在 | 适配器会自动 MKCOL；若仍失败，手动在图库/网盘里建好 `MediaVault/` |
| CORS 报错 | 服务端限制来源 | 扩展通常可绕过；仍失败则给桶/服务加 `chrome-extension://<ID>` 白名单 |
| Catbox 返回纯文本但非 URL | 站点维护页 / 拦截页，或来源被拦 | 稍后重试；核对上传域名；内容违规时换站点 |
| Pixeldrain 上传 `400` | 文件名非法，或空间 / 策略拒绝 | 改文件名（去掉特殊字符）；核对账号空间与政策；仍失败换站点 |
| 0x0.st 返回 `418` / `500` | 站点拒绝浏览器 UA（418）或拒绝脚本 UA（500），扩展无法改 UA | 扩展内不可用；改用 imgdb.io（图片）/ Pixeldrain（视频） |
| imgdb.io 返回 `413` | 单图超过 16MB | 压到 16MB 以内，或改用 S3 |
| Unlockify 等待转存超时 | 站点转存队列拥堵 | 稍后重试；大文件换 S3 / Pixeldrain |
| Cloudinary `400`（preset 相关） | 预设不是 Unsigned，或名称写错 | 后台把 Signing Mode 改为 Unsigned，重新核对 preset 名 |
| ImgBB `401` / `403` | API Key 无效，或账号未开通 API / 套餐不含 API | 核对 Key；在账号设置确认 API 已开通；权益以站点公告为准 |
| Imgur `429` / `403` | 匿名 Client-ID 配额耗尽、限流或被封 | 降低上传频率；核对 Client-ID；视频受限则换 Catbox / Pixeldrain |

---

## 用哪个？一句话结论

- **开箱就用、不想注册**：图片 → **imgdb.io**；视频 → **Unlockify**（两个都默认启用）。
- **只想免费存图片**：imgdb.io、Catbox、Imgur；ImgBB 需申请 Key（可能要 Pro）。
- **存短视频**：Unlockify（≤1.9GB）、Catbox（≤200MB）、Pixeldrain；大流量长期存用 Cloudflare R2。
- **存大文件**：Pixeldrain（≤20GB）或 S3 / WebDAV。
- **要播放页 + 内嵌代码**：Wistia（需账号）、Unlockify（免费）。
- **要 CDN 变换（裁剪/压缩）**：Cloudinary（需账号，免费额度）。
- **长期归档 / 要可控权限**：S3（R2）或 WebDAV。
- **想接百度/阿里/夸克网盘**：Alist + WebDAV。
- **已有图床/自建服务**：通用 HTTP 图床，填三个字段就能用。
- **0x0.st**：扩展内不可用（站点拒绝浏览器 UA），别再纠结它。
