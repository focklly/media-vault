# 贡献指南（Contributing）

感谢参与。本项目刻意保持**无构建、无框架、无后端**，请先读 [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)。

## 开始之前

1. Fork 仓库并 clone 到本地；
2. 用 Chrome「加载已解压的扩展程序」指向仓库根目录；
3. 跑一次 `pwsh tools/check.ps1`，确认基线干净；
4. 打开 `tools/testbed.html` 跑一遍核心交互。

## 提交规范

- 一个功能/修复 = 一个提交，信息用 Conventional Commits：
  - `feat(adapter): add imgur adapter`
  - `fix(content): hover button misplaced near viewport edge`
  - `docs(handover): update known limitations`
- 改动范围标记：`content` / `background` / `library` / `settings` / `popup` / `adapter` / `docs` / `tools`。
- 版本相关改动（protocol、DB schema、settings 字段）必须在描述里写 **BREAKING** 并同步文档。

## 代码要求

- 2 空格缩进、单引号、分号；不新增运行时依赖。
- 用户可见错误信息用中文，并且可行动（说明「做什么」而不是只报状态码）。
- 新增 DOM 类名用 `mv-` 前缀；页面内样式写进 Shadow DOM 的 CSS 常量。
- 新增存储适配器按 `docs/DEVELOPER_GUIDE.md` 模板写，并在 `adapters/index.js` 注册。
- 不提交 Token、密钥、个人图库数据、`dist/`、`*.zip`。

## 文档要求

改了以下任一项，必须同步更新对应文档：

| 改动 | 需要更新 |
| --- | --- |
| 消息类型 / 任务类型 | `docs/ARCHITECTURE.md` 协议表 |
| 数据表结构 | `docs/ARCHITECTURE.md` 数据模型 + 迁移说明 |
| 配置项 | `docs/ARCHITECTURE.md` 消费方 + README 必要时 |
| 新增适配器 | `docs/ADAPTERS.md` 对应章节 |
| 已知限制变化 | `docs/HANDOVER.md` 第 4 节 |
| 任何功能 | `CHANGELOG.md` 顶部版本段 |

## 提 PR

- 描述里写：解决什么问题、怎么验证（附截图/录屏更好）、影响范围；
- 涉及权限变更（`manifest.json`）必须单独说明理由；
- CI（`.github/workflows/validate.yml`）必须绿。

## 报告问题

请附：浏览器版本、复现页面（或测试页场景编号）、Service Worker 控制台报错、相关条目的 `item.remote.error`。
