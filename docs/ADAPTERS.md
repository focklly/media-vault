# 存储适配器配置手册（Adapters）

> 四个内置适配器都能在「设置 → 上传目标」里启用。全部配置只存本机，**不需要任何后端**。
> 每个适配器都有「测试连接」按钮；失败信息会给出中文原因。

---

## 通用前提

1. **先在设置页启用开关**，否则不会出现在「默认上传目标」下拉里。
2. 「入库后自动上传」是可选项；不打开也能用，图库里可以手动/批量上传。
3. 扩展已声明 `http/https` 全站权限，跨域请求通常不需要额外配 CORS；但部分服务端会校验来源，遇到时按各节提示处理。
4. 单文件上限：GitHub 约 40MB，HTTP 图床按你配置的 `maxMB`（默认 10MB），S3/WebDAV 无硬限制（受服务商套餐约束）。

| 适配器 | 最适合 | 免费额度参考 | 外链可否公开 |
| --- | --- | --- | --- |
| GitHub 仓库 | 图片、小视频 | 仓库容量受 GitHub 政策约束，无流量费 | 公开仓库可以；私有仓库不行 |
| S3 兼容 | 视频、大文件 | Cloudflare R2 10GB 存储 + 出网免费 | 配了公开域名可以 |
| WebDAV | 归档、接网盘 | 取决于网盘（坚果云/Alist 挂载） | 多数需登录；Alist 可配直链 |
| HTTP 图床 | 接已有图床 | 取决于图床（SM.MS 等） | 一般可以 |

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

---

## 用哪个？一句话结论

- **只想免费存图**：GitHub 公开素材仓库。
- **主要存视频**：Cloudflare R2（10GB 免费 + 出网不计费）。
- **想接百度/阿里/夸克网盘**：Alist + WebDAV。
- **已有图床/自建服务**：通用 HTTP 图床，填三个字段就能用。
