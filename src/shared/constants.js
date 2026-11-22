/**
 * 全局常量：所有跨上下文（content / background / popup / library / settings）共用的
 * 消息名、任务名、限制值集中在这里，避免字符串散落各处。
 * 修改消息名时务必同步 docs/ARCHITECTURE.md 的消息协议表。
 */

export const APP = {
  name: '影图管家',
  nameEn: 'MediaVault',
  version: '1.2.0',
  repo: 'https://github.com/focklly/media-vault',
  docs: 'https://github.com/focklly/media-vault/tree/main/docs',
};

/** 媒体类型 */
export const KIND = {
  IMAGE: 'image',
  VIDEO: 'video',
};

/** chrome.runtime.sendMessage 用的一次性消息类型 */
export const MSG = {
  // content -> background
  SCAN_RESULT: 'MV_SCAN_RESULT',        // 页面上报扫描结果（用于角标与 popup 统计）
  IMPORT_ONE: 'MV_IMPORT_ONE',          // 悬停按钮单条入库
  OPEN_LIBRARY: 'MV_OPEN_LIBRARY',      // 打开个人空间
  OPEN_SETTINGS: 'MV_OPEN_SETTINGS',    // 打开设置
  // background -> content
  GET_TAB_STATS: 'MV_GET_TAB_STATS',    // popup 查询当前页统计
  SCAN_NOW: 'MV_SCAN_NOW',              // popup 触发重新扫描
  IMPORT_BATCH: 'MV_IMPORT_BATCH',      // popup 触发全部存入（content 内部分批）
  TOGGLE_BALL: 'MV_TOGGLE_BALL',        // 开关悬浮球
  SETTINGS_UPDATED: 'MV_SETTINGS_UPDATED',
  RELOAD_SETTINGS: 'MV_RELOAD_SETTINGS',
};

/** 长任务（端口通道）类型：耗时操作走端口，保证 service worker 不被回收 */
export const TASK = {
  IMPORT: 'import',               // 批量导入（抓取 + 入库 + 可选上传）
  UPLOAD: 'upload',               // 单条上传到外部适配器
  UPLOAD_BATCH: 'upload-batch',   // 批量上传
  TRANSFER: 'transfer',           // 跨站转存（把本地副本或旧远程链接搬到目标站点，保留历史）
  TEST_ADAPTER: 'test-adapter',   // 连接测试
  DELETE: 'delete',               // 批量删除
};

/** 长任务端口名 */
export const PORT_NAME = 'mv-task';

/** 端口消息类型 */
export const PORT_MSG = {
  REQUEST: 'request',
  PROGRESS: 'progress',
  DONE: 'done',
  ERROR: 'error',
};

export const MB = 1024 * 1024;

export const LIMITS = {
  /** 单文件抓取上限，超过则只保存链接记录 */
  maxImportBytes: 512 * MB,
  /** GitHub Contents API 单文件建议上限（超过容易 413/超时） */
  githubMaxBytes: 40 * MB,
  /** SM.MS 等免费图床通常 5MB */
  imageHostMaxBytes: 5 * MB,
  /** 单次批量导入条数上限 */
  maxBatch: 300,
  /** 缩略图最长边 */
  thumbMax: 480,
  /** 缩略图 JPEG 质量 */
  thumbQuality: 0.82,
  /** content 扫描上限，避免超大页面卡顿 */
  maxScanItems: 600,
  /** 并行导入并发数 */
  concurrency: 3,
};

/** 数据库与存储键 */
export const DB = {
  NAME: 'mediavault',
  VERSION: 1,
  ITEMS: 'items',
  BLOBS: 'blobs',
};

export const STORAGE_KEY = {
  SETTINGS: 'mv.settings',
  BALL_POS: 'mv.ballPos',
  STATS: 'mv.stats',
};

/** 默认忽略的站点（扩展商店页、邮箱等无意义页面） */
export const DEFAULT_EXCLUDED_SITES = [
  'chromewebstore.google.com',
  'chrome.google.com',
  'mail.google.com',
  'accounts.google.com',
];
