# 二次开发指南（Developer Guide）

> 目标：拿到仓库后 10 分钟内能跑起来，30 分钟内能加上自己的存储站点。
> 本项目**无需构建**，没有 `node_modules`，没有 `dist`。仓库根目录就是可加载的扩展。

---

## 1. 环境与加载

要求：Chrome / Edge 116+，Node 18+（仅用于图标生成、语法检查、打包，不影响扩展运行）。

```bash
git clone https://github.com/focklly/media-vault.git
cd media-vault
```

加载：

1. 打开 `chrome://extensions` → 打开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选择**仓库根目录**（含 `manifest.json`）；
3. 改代码后点扩展卡片右下角的刷新图标，再刷新目标网页（content 脚本只在页面加载时注入）。

调试入口：

| 对象 | 怎么开 |
| --- | --- |
| Service Worker | `chrome://extensions` → 本扩展 → 「Service Worker」链接 |
| 内容脚本 | 网页 DevTools Console，筛选 `mv`；页面右下角浮层出现即注入成功 |
| 弹窗 | 右键扩展图标 → 「检查弹出内容」 |
| 个人空间 / 设置 | 正常打开页面后 F12，就是普通网页调试 |

后台控制台可用两个调试钩子（`service-worker.js` 末尾）：

```js
await __MV_STATS__()      // 查看条目数/占用/上传数
__MV_DEFAULTS__           // 默认配置
```

---

## 2. 目录职责速查

```text
src/shared/constants.js   消息名、任务名、限制、默认键 → 改协议先改这里
src/shared/utils.js       纯函数（可单测），无 chrome 依赖
src/shared/db.js          IndexedDB：items / blobs
src/shared/settings.js    默认配置 + 深合并 + storage 读写
src/shared/messaging.js   sendMessage / sendToTab / 端口 runTask
src/background/service-worker.js   路由 + 抓取 + 落库 + 上传 + 浏览器集成
src/background/adapters/  存储适配器（一个文件一个站点）
src/content/content.js    页面内 UI 与扫描（单文件，不能 import）
src/popup|library|settings/  三个页面（ES Module）
```

---

## 3. 新增一个存储适配器（最常见需求）

### 3.1 写文件

新建 `src/background/adapters/example.js`：

```js
/**
 * 适配器：示例站点
 * 说明：PUT 一个文件到 https://api.example.com/upload，返回 JSON { url, key }
 */
import { joinPath, normalizePrefix, uniqueFileName } from '../../shared/utils.js';

export default {
  id: 'example',                 // 唯一 id，也是 settings.adapters 的键
  label: '示例站点',
  badge: '示例',
  supports: ['image', 'video'],  // 声明支持的媒体类型（UI 可据此过滤）
  maxBytes: Infinity,            // 单文件上限；有限制就写 5 * 1024 * 1024
  summary: '一句话说明这个站点的定位与限制。',
  docs: 'docs/ADAPTERS.md#示例站点',   // 设置页「配置步骤」链接

  // 设置页据此自动渲染表单，不用改 settings.html
  fields: [
    { key: 'apiUrl', label: '上传接口', type: 'text', placeholder: 'https://api.example.com/upload', required: true },
    { key: 'token', label: 'Token', type: 'password', required: true, help: '只存本机，注意不要泄露。' },
    { key: 'pathPrefix', label: '目录前缀', type: 'text', required: false },
  ],

  /** 判断配置是否完整：上传前会校验，缺项直接给出中文错误 */
  isConfigured(config) {
    return Boolean(config && config.apiUrl && config.token);
  },

  /** 连接测试：返回 { ok, message }，不要抛异常（框架会兜住，但信息更友好） */
  async test(config) {
    const res = await fetch(config.apiUrl.replace(/upload$/, 'ping'), {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (res.status === 401) return { ok: false, message: 'Token 无效' };
    if (!res.ok) return { ok: false, message: `服务返回 ${res.status}` };
    return { ok: true, message: '连接正常' };
  },

  /** 上传：必须返回 { url, path, size, privateLink } */
  async upload({ blob, fileName, config }) {
    const key = joinPath(
      normalizePrefix(config.pathPrefix || ''),
      new Date().getFullYear() + '/',
      uniqueFileName(fileName),
    );
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('key', key);

    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` }, // 不要手动设 Content-Type
      body: form,
    });
    if (!res.ok) throw new Error(`上传失败 ${res.status}：${(await res.text()).slice(0, 120)}`);

    const json = await res.json();
    return {
      url: json.url,          // 最终可访问链接
      path: key,              // 远端路径（便于排查）
      size: blob.size,
      privateLink: false,     // true 表示外链需要登录，图库会提示「私有」
    };
  },
};
```

### 3.2 注册

编辑 `src/background/adapters/index.js`：

```js
import example from './example.js';
export const ADAPTERS = [github, s3, webdav, httpAdapter, example];
```

**不需要改**：设置页、图库、上传流程、消息协议。表单会按 `fields` 自动生成。

### 3.3 验证

1. `chrome://extensions` 刷新扩展；
2. 设置 → 上传目标 → 找到新卡片 → 启用 → 填配置 → 「测试连接」；
3. 图库选一张图 → 卡片「上传」→ 看是否生成链接；
4. 失败时在 Service Worker 控制台看报错，`item.remote.error` 会存进库并显示在卡片上。

### 3.4 字段类型支持

| type | 控件 | 存值 |
| --- | --- | --- |
| `text`（默认） | 单行输入 | string |
| `password` | 密码框 | string |
| `number` | 数字 | number |
| `textarea` | 多行（JSON 配置常用） | string |
| `boolean` | 开关 | boolean |

`required: true` 只影响 UI 上的 `*` 标记，真正的校验在 `isConfigured()`。

### 3.5 适配器实现三要点

| 要点 | 约定 | 原因 |
| --- | --- | --- |
| `supports` | 声明 `['image']` / `['image','video']`；存储路由按它兜底，设置页与图库下拉据此禁用不兼容选项并写明原因 | 图片站（如 ImgBB）不能接收视频，混传会被远端拒绝 |
| `maxBytes` | 单文件上限（字节），不限写 `Infinity`；`uploadTo()` 会在上传前统一校验并抛中文错误 | 各免费站点限制差异大（32MB～20GB），集中校验避免传一半失败 |
| 上传体 | 文件用 `FormData` + `Blob`，或直接把 `blob` 作为原始二进制 body；**严禁先把文件 base64 再塞 multipart**；不要手动设置 multipart 的 `Content-Type`（浏览器/ SW 会自动带 boundary） | base64 膨胀约 33%，大视频容易超限；手动设头会丢失 boundary 导致解析失败 |

> 上传返回值契约不变：`{ url, path, size, privateLink }`；`privateLink: true` 表示外链需登录，图库会标「私有」。

---

## 4. 修改扫描规则 / 悬停判定

### 扫描

- 入口：`content.js` → `scanPage()`，新增来源就在对应段落里调用 `addCandidate(map, {...})`。
- 过滤：`addCandidate` 里统一做 `absolute()`、去重、`scan.minPx` 过滤、`data:` 长度限制。
- 注意：`scanPage` 是幂等的、可被频繁调用（滚动会触发），**不要在里面做写库操作**。

### 悬停

- 入口：`hoverCandidatesFromEvent(e)`。
- 当前规则：`img` / `video` / 向上 3 层找背景图；尺寸低于 `hover.minPx` 不出现按钮。
- 想支持 iframe 内媒体：需要把 `manifest.json` 的 `all_frames` 改为 `true`，但 content 会跑在每个 frame，需自行处理悬浮球重复（建议只在 top 显示 UI，iframe 只上报媒体）。

### 新增消息

1. `constants.js` 的 `MSG` 增加类型；
2. `service-worker.js` 的 `handleShortMessage()` 增加分支；
3. 调用方 `sendMessage(type, payload)`；
4. 更新 `docs/ARCHITECTURE.md` 消息表。

### 新增后台长任务

1. `constants.js` 的 `TASK` 增加类型；
2. `service-worker.js` 的 `runTask()` 增加 case（返回可序列化结果，过程中用 `progress()` 上报）；
3. 页面/内容脚本用 `runTask(type, payload, onProgress)` 调用。

---

## 5. 改动数据表

```js
// src/shared/db.js
export const DB = { NAME:'mediavault', VERSION: 2, ... } // constants.js 里改
```

在 `openDB()` 的 `onupgradeneeded` 里按 `event.oldVersion` 写迁移：

```js
req.onupgradeneeded = (event) => {
  const db = req.result;
  if (event.oldVersion < 1) { /* v1 建表逻辑 */ }
  if (event.oldVersion < 2) {
    const items = req.transaction.objectStore(DB.ITEMS);
    items.createIndex('tag', 'tags', { multiEntry: true }); // 示例
  }
};
```

**务必**先在旧版本数据上测试迁移（可以复制一份 IndexedDB 或导出清单后清空重建）。

---

## 6. 常见坑（都是踩过的）

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| 上传大视频到一半失败 | MV3 SW 空闲回收 | 必须走端口 `runTask`，且客户端 20s 心跳（已内置） |
| `FileReader is not defined` | SW 里没有 FileReader | 用 `blob.arrayBuffer()` + `utils.blobToBase64` |
| IndexedDB 事务莫名提交 | 事务里 `await` 了非请求 Promise，出现空档 | 先一次性读，再在写事务里同步写完（见 `db.deleteItems`） |
| content 里 `import` 报错 | content_scripts 不支持 module | 保持单文件 IIFE；共享逻辑手工同步 |
| `<img>` 抓取 403 | 防盗链 / 需要 Referer | 已做两次尝试（带 referrer、无 referrer）；仍失败则降级仅链接 |
| S3 PUT 403 SignatureDoesNotMatch | Region/PathStyle 配错 | R2 用 `auto` + PathStyle `true`；OSS/七牛用实际 region + `false` |
| 私有仓库图片外链打不开 | raw 链接需要 Token | 换公开仓库，或配置 `publicBase`（jsDelivr 等） |
| 悬浮球遮挡页面按钮 | z-index 最高、位置固定 | 可拖动；也可在设置里关闭悬浮球只留悬停按钮 |
| 扩展刷新后页面按钮失灵 | 旧 content 上下文失效 | 刷新网页；代码里已对 `chrome.runtime.lastError` 兜底 |
| 通知不弹 | `chrome.notifications` 版本间返回 Promise/id 不一致 | 已用 try/catch + 兼容判断 |
| 弹窗里读不到当前页统计 | `chrome://`、商店页禁止注入 | 属预期，弹窗会提示换普通网页 |

---

## 7. 编码规范

- 2 空格缩进、单引号、语句结尾分号；不引入框架与运行时依赖。
- 所有用户可见错误必须是**中文、可行动**的描述（例如「Token 无效或已过期」而不是 `401`）。
- 新增 DOM 类名一律 `mv-` 前缀；页面内样式只写在 Shadow DOM 的 `CSS` 常量里。
- `utils.js` 里的函数保持纯函数，方便直接 `node --check` / 单测。
- 注释写「为什么」，不写「是什么」；协议、表结构变更必须同步文档。
- 不要提交 Token、Secret、个人图库数据；`.gitignore` 已排除 `dist/`、`*.zip`。

---

## 8. 校验、打包、发布与 GitHub 同步

### 本地校验

```powershell
pwsh tools/check.ps1
# - 遍历 src/**/*.js 做语法检查（ESM 自动识别）
# - 校验 manifest.json 可解析、图标文件存在
```

### 打包（上架/分发用）

```powershell
pwsh tools/pack.ps1
# 产出 dist/media-vault-<version>.zip，仅含 manifest.json + src/
```

### 每次改完功能都要同步 GitHub（项目约定）

一个功能 = 一个提交，提交信息用 Conventional Commits：

```bash
git add -A
git commit -m "feat(adapter): add example storage adapter"
git push origin main
```

类型：`feat` / `fix` / `docs` / `refactor` / `chore` / `perf`。

发版三步：

1. 改版本号：`manifest.json` 的 `version` **和** `src/shared/constants.js` 的 `APP.version` 保持一致；
2. 在 `CHANGELOG.md` 顶部加 `## [x.y.z] - YYYY-MM-DD` 段落（Added/Changed/Fixed）；
3. `git tag vX.Y.Z && git push origin main --tags`。

推送后 GitHub Actions（`.github/workflows/validate.yml`）会自动跑语法检查与 manifest 校验；红了先修再继续。

> 当前仓库由 AI 助手通过 GitHub 连接器直接同步；人工接手时用上面的 `git push` 流程即可，两者产物一致。

---

## 9. 建议的下一步开发顺序

1. 上传失败重试与队列（`service-worker.js` 的 `uploadItemObject` 外包一层 retry）；
2. 视频封面截帧（content 在页面对 `<video>` 画 canvas → 传 dataURL，绕开 SW 无法解码视频的限制）；
3. 图库虚拟滚动（>2000 条时当前实现会卡）；
4. 标签与相册（`tags` 字段已预留，需加 UI 与索引）。

详见 [HANDOVER.md](HANDOVER.md#待办与优先级)。
