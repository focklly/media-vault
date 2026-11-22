/**
 * 设置读写层
 *
 * 存储位置：chrome.storage.local
 * - 不涉及账号体系，配置只在本机；
 * - 适配器的 Token / 密钥也存放在这里，属于本机明文存储，风险与替代方案见
 *   docs/HANDOVER.md「凭证管理」一节（浏览器扩展没有真正的安全存储）。
 */

import { STORAGE_KEY, DEFAULT_EXCLUDED_SITES, MB } from './constants.js';

export const DEFAULT_SETTINGS = {
  version: 2,
  /** 总开关：关闭后内容脚本不显示任何浮层 */
  enabled: true,
  ball: {
    enabled: true,
    /** 相对窗口右下角的偏移（px），首次安装时使用 */
    x: 24,
    y: 96,
    opacity: 0.92,
  },
  hover: {
    enabled: true,
    /** 悬停按钮：媒体最小边长，太小的图标不出现按钮 */
    minPx: 120,
    /** 视频是否显示（网页播放器会被按钮遮挡时可在设置里关掉） */
    videos: true,
    /** 按钮相对光标的偏移 */
    offsetX: 14,
    offsetY: 14,
  },
  scan: {
    /** 扫描时忽略小于该边长的图片 */
    minPx: 80,
    /** 单页最多收集条数 */
    maxItems: 600,
    includeBackground: true,
    includeMeta: true,
    includeLazy: true,
    includeLinks: true,
  },
  /** 入库后自动上传到哪个适配器；'none'/空串 表示未指定，按路由顺序兜底 */
  autoUpload: {
    enabled: true,
    adapterId: 'none',
    /** 按媒体类型单独指定站点；空串 = 跟随全局默认 adapterId */
    byKind: {
      image: '',
      video: '',
    },
  },
  /** 导入策略 */
  importRules: {
    /** 单文件上限（MB），超过只存链接 */
    maxMB: 512,
    /** 抓取不到时是否仍保存“仅链接”记录 */
    keepLinkOnFailure: true,
  },
  /** 不显示浮层的站点（精确匹配 hostname） */
  excludedSites: [...DEFAULT_EXCLUDED_SITES],
  /** 各适配器配置，结构与 src/background/adapters/*.js 的 fields 对应 */
  adapters: {
    /** 免注册、开箱能用：默认启用，但不自动上传（autoUpload.enabled 仍为 false） */
    imgdb: {
      enabled: true,
      ttl: 0,
      password: '',
      description: '',
    },
    unlockify: {
      enabled: true,
      openPage: false,
    },
    github: {
      enabled: false,
      token: '',
      owner: '',
      repo: '',
      branch: 'main',
      pathPrefix: 'media/',
      publicBase: '',
    },
    s3: {
      enabled: false,
      endpoint: '',
      region: 'auto',
      bucket: '',
      accessKey: '',
      secretKey: '',
      pathPrefix: 'media/',
      publicBase: '',
      forcePathStyle: true,
    },
    webdav: {
      enabled: false,
      baseUrl: '',
      username: '',
      password: '',
      pathPrefix: 'MediaVault/',
      publicBase: '',
    },
    http: {
      enabled: false,
      url: '',
      field: 'file',
      headersJson: '',
      fieldsJson: '',
      responsePath: 'data.url',
      publicBase: '',
      maxMB: 10,
    },
    catbox: {
      enabled: false,
      userhash: '',
    },
    pixeldrain: {
      enabled: false,
      apiKey: '',
    },
    imgpile: {
      enabled: false,
      apiKey: '',
    },
    yourimageshare: {
      enabled: false,
      endpoint: 'https://yourimageshare.com/api/upload',
      apiKey: '',
      authHeader: 'X-API-Key',
    },
    imgbb: {
      enabled: false,
      apiKey: '',
    },
    imgur: {
      enabled: false,
      clientId: '',
    },
    cloudinary: {
      enabled: false,
      cloudName: '',
      uploadPreset: '',
      folder: '',
    },
    wistia: {
      enabled: false,
      apiPassword: '',
      projectId: '',
    },
    /** 网页上传型：登记目标，扩展不代传 */
    hippovideo: { enabled: false },
  },
};

/** 深合并：默认值兜底，避免旧版本配置缺字段导致页面报错 */
function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEY.SETTINGS);
  const stored = raw[STORAGE_KEY.SETTINGS] || {};
  const merged = deepMerge(DEFAULT_SETTINGS, stored);
  // v2 迁移：v1 的默认是「只存本地」，用户希望点一下就直传默认图床/视频站，这里一次性打开自动上传
  if (Number(stored.version || 1) < 2) {
    merged.version = 2;
    merged.autoUpload = { ...merged.autoUpload, enabled: true };
    await chrome.storage.local.set({ [STORAGE_KEY.SETTINGS]: merged });
  }
  return merged;
}

/** patch 传入部分字段即可，写回时做深合并 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY.SETTINGS]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [STORAGE_KEY.SETTINGS]: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

/** 订阅设置变化，返回取消函数（页面卸载时调用） */
export function onSettingsChanged(callback) {
  const handler = (changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY.SETTINGS]) callback(changes[STORAGE_KEY.SETTINGS].newValue);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** 便捷：取某个适配器配置 */
export async function getAdapterConfig(adapterId) {
  const settings = await getSettings();
  return settings.adapters?.[adapterId] || {};
}

export function isSiteExcluded(settings, hostname) {
  if (!hostname) return false;
  return (settings.excludedSites || []).some((s) => s && (hostname === s || hostname.endsWith(`.${s}`)));
}

export function maxImportBytes(settings) {
  const mb = Number(settings?.importRules?.maxMB) || 512;
  return Math.max(1, mb) * MB;
}

