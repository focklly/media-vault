/**
 * Background Service Worker（MV3）
 *
 * 职责：
 * 1. 消息路由：一次性消息（扫描上报、打开页面）+ 端口长任务（导入/上传/删除/测试）。
 * 2. 媒体抓取：带 Cookie 请求原图/视频，生成缩略图，落库到 IndexedDB。
 * 3. 外部上传：调用 adapters 把本地文件推到图床/网盘/S3。
 * 4. 浏览器集成：右键菜单、角标、通知、安装引导。
 *
 * 重要约定：
 * - 所有耗时任务必须走端口（PORT_NAME），否则 MV3 的 SW 会在空闲 30 秒后被回收，
 *   视频下载/上传会中途中断。
 * - 抓取失败不丢记录：默认降级为「仅链接」条目，用户仍可在个人空间看到来源。
 */

import {
  MSG, TASK, PORT_NAME, PORT_MSG, KIND, LIMITS, STORAGE_KEY,
} from '../shared/constants.js';
import {
  uid, nowISO, hostOf, fileNameFromUrl, guessMime, dataUrlToBlob, formatBytes,
  mapLimit, extFromMime,
} from '../shared/utils.js';
import {
  putItem, getItem, updateItem, deleteItems, putBlob, getBlob, getAllItems, getStats,
} from '../shared/db.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS, maxImportBytes } from '../shared/settings.js';
import { resolveTargetAdapter, adapterLabel } from '../shared/routing.js';
import { uploadTo, testAdapter, adapterMetaList, ADAPTERS, getAdapter } from './adapters/index.js';

const LIBRARY_PAGE = 'src/library/library.html';
const SETTINGS_PAGE = 'src/settings/settings.html';
const ICON_128 = 'src/icons/icon-128.png';

/**
 * 抖音视频 CDN（douyinvod.com）按 Referer 做防盗链：没有 Referer 一律 403。
 * 扩展后台 fetch 属于非页面请求，浏览器不会自带 Referer，且 fetch 的 referrer 选项
 * 对跨源请求会被裁掉，所以只能用 declarativeNetRequest 在扩展发起的请求上加 Referer。
 */
const DOUYIN_REFERER_RULE_ID = 9101;
function ensureDouyinRefererRule() {
  const rule = {
    id: DOUYIN_REFERER_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: 'https://www.douyin.com/' },
        { header: 'origin', operation: 'remove' },
      ],
    },
    condition: {
      urlFilter: '||douyinvod.com',
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
      tabIds: [-1],
    },
  };
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DOUYIN_REFERER_RULE_ID], addRules: [rule] })
    .catch(() => {});
}
ensureDouyinRefererRule();

/** 组装路由/UI 共用的适配器描述（含启用态），纯数据、剥离函数 */
function adapterDescriptors(settings) {
  return ADAPTERS.map((a) => {
    const config = settings?.adapters?.[a.id] || {};
    return {
      id: a.id,
      label: a.label,
      supports: a.supports,
      enabled: config.enabled === true,
      webOnly: a.webOnly === true,
      ready: a.isConfigured ? a.isConfigured(config) === true : true,
    };
  });
}

/** 按媒体类型解析目标站点（byKind → 全局兜底 → 第一个支持该类型的已启用站点） */
function resolveTarget(settings, kind) {
  return resolveTargetAdapter(settings, kind, adapterDescriptors(settings));
}

/* ------------------------------------------------------------------ *
 * 安装 / 启动
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();
  await saveSettings(settings); // 首次安装把默认值落盘，方便用户直接看设置页
  await buildContextMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL(`${SETTINGS_PAGE}?welcome=1`) });
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildContextMenus().catch(() => {});
});

async function buildContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'mv-save-media',
    title: '存入影图管家',
    contexts: ['image', 'video'],
  });
  chrome.contextMenus.create({
    id: 'mv-scan-page',
    title: '扫描本页可下载的图片 / 视频',
    contexts: ['page'],
  });
  chrome.contextMenus.create({ id: 'mv-sep', type: 'separator', contexts: ['page'] });
  chrome.contextMenus.create({
    id: 'mv-open-library',
    title: '打开个人空间',
    contexts: ['page', 'action'],
  });
  chrome.contextMenus.create({
    id: 'mv-open-settings',
    title: '设置',
    contexts: ['action'],
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mv-open-library') {
    openLibrary();
    return;
  }
  if (info.menuItemId === 'mv-open-settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === 'mv-scan-page') {
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: MSG.SCAN_NOW, payload: { silent: false } }).catch(() => {});
    }
    return;
  }
  if (info.menuItemId === 'mv-save-media' && info.srcUrl) {
    const settings = await getSettings();
    const kind = info.mediaType === 'video' ? KIND.VIDEO : KIND.IMAGE;
    try {
      const { item } = await importMedia(
        {
          url: info.srcUrl,
          kind,
          pageUrl: info.pageUrl || tab?.url || '',
          pageTitle: tab?.title || '',
          from: 'context-menu',
        },
        settings,
      );
      const targetLabel = item.remote?.adapterId
        ? adapterLabel(adapterDescriptors(settings), item.remote.adapterId)
        : '';
      notify('已存入个人空间', `${item.kind === 'video' ? '视频' : '图片'} · ${item.title}${targetLabel ? ` · 已上传到 ${targetLabel}` : ''}`);
      updateBadge(tab?.id, null);
    } catch (err) {
      notify('存入失败', String(err.message || err).slice(0, 120));
    }
  }
});

/* ------------------------------------------------------------------ *
 * 一次性消息
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  handleShortMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

async function handleShortMessage(msg, sender) {
  switch (msg.type) {
    case MSG.SCAN_RESULT: {
      const { images = 0, videos = 0 } = msg.payload || {};
      updateBadge(sender?.tab?.id, images + videos);
      return { ok: true };
    }
    case MSG.OPEN_LIBRARY:
      await openLibrary();
      return { ok: true };
    case MSG.OPEN_SETTINGS:
      chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'MV_GET_ADAPTER_META':
      return { ok: true, adapters: adapterMetaList() };
    case 'MV_GET_SETTINGS':
      return { ok: true, settings: await getSettings() };
    case 'MV_GET_STATS':
      return { ok: true, stats: await getStats() };
    case 'MV_NOTIFY': {
      notify(msg.payload?.title || '', msg.payload?.message || '');
      return { ok: true };
    }
    default:
      return { ok: false, error: `未知消息：${msg.type}` };
  }
}

/* ------------------------------------------------------------------ *
 * 端口长任务
 * ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.kind !== PORT_MSG.REQUEST) return; // ping 直接忽略，靠端口本身续命
    const progress = (payload) => safePost(port, { kind: PORT_MSG.PROGRESS, payload });
    try {
      const result = await runTask(msg.type, msg.payload || {}, progress);
      safePost(port, { kind: PORT_MSG.DONE, payload: result });
    } catch (err) {
      safePost(port, {
        kind: PORT_MSG.ERROR,
        payload: { message: String(err && err.message ? err.message : err) },
      });
    }
  });
});

function safePost(port, data) {
  try {
    port.postMessage(data);
  } catch (_) { /* 页面已关闭 */ }
}

async function runTask(type, payload, progress) {
  const settings = await getSettings();
  switch (type) {
    case TASK.IMPORT:
      return importBatch(payload, settings, progress);
    case TASK.UPLOAD:
      return uploadOne(payload.id, payload.adapterId, settings);
    case TASK.UPLOAD_BATCH:
      return uploadMany(payload.ids, payload.adapterId, settings, progress);
    case TASK.TRANSFER:
      return payload.id
        ? transferOne(await getItem(payload.id), payload.adapterId, settings).then((item) => ({ item }))
        : transferMany(payload.ids, payload.adapterId, settings, progress);
    case TASK.TEST_ADAPTER:
      return testAdapter(payload.adapterId, payload.config);
    case TASK.DELETE:
      return { removed: await deleteItems(payload.ids || []) };
    default:
      throw new Error(`未知任务：${type}`);
  }
}

/* ------------------------------------------------------------------ *
 * 导入流程
 * ------------------------------------------------------------------ */

async function importBatch(payload, settings, progress) {
  const raws = (payload.items || []).slice(0, LIMITS.maxBatch);
  if (!raws.length) return { imported: [], failed: [], duplicates: 0 };
  const existing = await getAllItems();
  const seen = new Set(existing.map((it) => it.sourceUrl));

  const imported = [];
  const failed = [];
  let duplicates = 0;
  let done = 0;
  const total = raws.length;

  await mapLimit(raws, LIMITS.concurrency, async (raw) => {
    try {
      if (!raw.url || !/^https?:|^data:|^blob:/.test(raw.url)) throw new Error('链接不可用');
      if (seen.has(raw.url)) {
        // 之前只存了「链接记录」的流媒体，现在能解析出真文件时，用新记录替换旧记录
        const dup = existing.find((it) => it.sourceUrl === raw.url);
        const canUpgrade = dup && dup.status === 'link-only' && dup.kind === KIND.VIDEO
          && (raw.bilibiliResolve || raw.dataUrl);
        if (canUpgrade) {
          existing.splice(existing.indexOf(dup), 1);
          await deleteItems([dup.id]);
          const importedOne = await importMedia(raw, settings);
          imported.push({ ...importedOne.item, targetLabel: importedOne.targetLabel });
        } else {
          duplicates += 1;
        }
      } else {
        seen.add(raw.url);
        const importedOne = await importMedia(raw, settings);
        imported.push({ ...importedOne.item, targetLabel: importedOne.targetLabel });
      }
    } catch (err) {
      failed.push({ url: raw.url, error: String(err.message || err) });
    } finally {
      done += 1;
      progress({ done, total, message: raw.url });
    }
  });

  if (payload.openLibraryAfter) openLibrary();
  return { imported, failed, duplicates };
}

/**
 * 单条媒体入库：抓取 -> 缩略图 -> IndexedDB -> 可选自动上传
 */
async function importMedia(raw, settings) {
  const kind = raw.kind === KIND.VIDEO ? KIND.VIDEO : KIND.IMAGE;
  const url = raw.url;
  const pageUrl = raw.pageUrl || raw.referer || '';
  const fileName = raw.fileName || fileNameFromUrl(url, kind, raw.mime);
  const id = uid('itm');

  const item = {
    id,
    kind,
    title: (raw.alt || fileName).slice(0, 160),
    fileName,
    sourceUrl: url,
    pageUrl,
    pageTitle: (raw.pageTitle || '').slice(0, 200),
    site: hostOf(pageUrl || url),
    mime: raw.mime || '',
    width: raw.width || 0,
    height: raw.height || 0,
    duration: raw.duration || 0,
    poster: raw.poster || '',
    size: 0,
    status: 'pending',
    fav: 0,
    tags: [],
    note: '',
    files: {},
    remote: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };

  // content 侧已经把 blob: 视频转成 dataUrl 的情况
  let blob = null;
  if (raw.dataUrl) {
    blob = dataUrlToBlob(raw.dataUrl);
    item.mime = blob.type || raw.mime || '';
  } else if (raw.bilibiliResolve) {
    // B 站等 MSE 站点：页面里只有 blob:，改走 playurl 拿真正的 mp4 直链
    const resolved = await resolveBilibiliVideo(pageUrl);
    if (!resolved) {
      item.status = 'link-only';
      item.note = '流媒体（MSE）站点：无法解析到可下载的视频地址，已保存播放页链接';
      await putItem(item);
      return { item, linkOnly: true };
    }
    const fetched = await fetchMedia(resolved.url, resolved.referer);
    if (!fetched.ok) {
      item.status = 'link-only';
      item.note = `已解析到视频地址但下载失败：${fetched.reason}`;
      await putItem(item);
      return { item, linkOnly: true };
    }
    blob = fetched.blob;
    item.mime = fetched.mime;
    item.size = blob.size;
    item.fileName = `${(raw.alt || raw.pageTitle || 'bilibili').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'bilibili'}.mp4`;
    const maxBytes = maxImportBytes(settings);
    if (blob.size > maxBytes) {
      throw new Error(`视频 ${formatBytes(blob.size)} 超过单文件上限 ${formatBytes(maxBytes)}`);
    }
  } else if (raw.douyinCandidates && raw.douyinCandidates.length) {
    // 抖音：探针抓到的是 m4s 分轨，其中一半是纯音频。先小范围取头部验轨，
    // 挑出真正带 vide 轨道的那个再整段下载。
    const picked = await resolveDouyinVideo(raw.douyinCandidates);
    const fetched = picked
      ? await fetchMedia(picked, 'https://www.douyin.com/')
      : { ok: false, reason: '候选地址里没有视频轨（只有音频或已过期）' };
    if (!fetched.ok) {
      item.status = 'link-only';
      item.sourceUrl = pageUrl || url;
      item.note = `抖音：已抓到直链但下载失败：${fetched.reason}`;
      await putItem(item);
      return { item, linkOnly: true };
    }
    const maxBytes = maxImportBytes(settings);
    if (fetched.blob.size > maxBytes) {
      throw new Error(`视频 ${formatBytes(fetched.blob.size)} 超过单文件上限 ${formatBytes(maxBytes)}`);
    }
    blob = fetched.blob;
    item.mime = fetched.mime;
    item.sourceUrl = picked;
  } else if (raw.stream) {
    // m3u8 / mpd 分片流，扩展无法整体下载，保存为“流媒体记录”
    item.status = 'link-only';
    item.note = '流媒体（m3u8/mpd），已保存播放地址；批量下载需配合专用工具';
    await putItem(item);
    return { item, linkOnly: true };
  } else {
    const maxBytes = maxImportBytes(settings);
    const fetched = await fetchMedia(url, pageUrl);
    if (!fetched.ok) throw new Error(fetched.reason);
    if (fetched.blob.size > maxBytes) {
      throw new Error(`文件 ${formatBytes(fetched.blob.size)} 超过单文件上限 ${formatBytes(maxBytes)}`);
    }
    blob = fetched.blob;
    item.mime = fetched.mime;
    item.size = blob.size;
  }

  item.fileName = ensureExt(item.fileName, item.mime, url);
  // 页面内 blob: 媒体没有有意义的文件名，用 类型-id.mime 兜底
  if (url.startsWith('blob:') || raw.blobTransfer) {
    item.fileName = `${kind}-${id.slice(-6)}.${item.mime ? extFromMime(item.mime) : 'bin'}`;
  }
  item.size = blob.size;
  const origKey = `${id}:orig`;
  await putBlob(origKey, id, blob);
  item.files.orig = origKey;

  const thumb = await makeThumb(blob, kind);
  if (thumb) {
    const thumbKey = `${id}:thumb`;
    await putBlob(thumbKey, id, thumb);
    item.files.thumb = thumbKey;
  } else if (kind === KIND.VIDEO && raw.poster) {
    // 视频封面：借用页面 poster 图，失败就留空由 UI 画占位
    try {
      const p = await fetchMedia(raw.poster, pageUrl);
      if (p.ok) {
        const posterBlob = await makeThumb(p.blob, KIND.IMAGE);
        if (posterBlob) {
          const key = `${id}:thumb`;
          await putBlob(key, id, posterBlob);
          item.files.thumb = key;
        }
      }
    } catch (_) { /* 忽略封面失败 */ }
  }

  item.status = 'ready';
  await putItem(item);

  // 自动上传（默认关闭）：按类型走共享路由，结果里带上目标站点名称供 toast/通知展示
  if (settings.autoUpload?.enabled) {
    const target = resolveTarget(settings, item.kind);
    if (target) {
      try {
        const result = await uploadItemObject(item, target.id, settings);
        return { item: result, targetLabel: target.label };
      } catch (err) {
        const next = await updateItem(item.id, {
          remote: { adapterId: target.id, error: String(err.message || err), uploadedAt: nowISO() },
        });
        return { item: next || item, uploadError: String(err.message || err), targetLabel: target.label };
      }
    }
  }
  return { item };
}

function ensureExt(name, mime, url) {
  if (/\.\w{2,5}$/.test(name)) return name;
  const ext = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const guessed = ext || ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/webm': 'webm' }[mime] || 'bin');
  return `${name}.${guessed}`;
}

/**
 * 抓取原始媒体
 * 先按正常请求（带 Cookie，模拟来自原页面），失败再尝试不带 Referer，
 * 再失败则抛出可读原因，由上层降级为仅链接记录。
 */
/* B 站：页面用 MSE 播放，但官方 playurl 接口能给出可下载的 mp4 直链（无登录一般 720P） */
async function resolveBilibiliVideo(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (!m) return null;
    const bvid = m[1];
    const pIndex = Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
    const headers = { Accept: 'application/json' };
    const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'include', referrer: pageUrl, headers,
    }).then((r) => r.json());
    if (!view || view.code !== 0) return null;
    const pages = view.data.pages || [];
    const cid = (pages[pIndex - 1] || {}).cid || view.data.cid;
    if (!cid) return null;
    const q = `bvid=${bvid}&cid=${cid}&qn=80&fnval=0&fnver=0&fourk=1&platform=html5&high_quality=1`;
    const play = await fetch(`https://api.bilibili.com/x/player/playurl?${q}`, {
      credentials: 'include', referrer: pageUrl, headers,
    }).then((r) => r.json());
    if (!play || play.code !== 0 || !play.data) return null;
    const durl = play.data.durl || [];
    if (durl.length !== 1) return null; // 分段视频不合并，避免损坏文件
    if (!durl[0] || !durl[0].url) return null;
    return { url: durl[0].url, referer: 'https://www.bilibili.com/' };
  } catch (err) {
    return null;
  }
}

/** 抖音 m4s：只取前 64KB 看有没有 vide 轨道（纯音频轨只有 soun） */
async function hasVideoTrack(url) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-65535', Accept: '*/*' },
      credentials: 'include',
      referrer: 'https://www.douyin.com/',
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let text = '';
    for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return text.includes('vide');
  } catch (_) {
    return false;
  }
}

async function resolveDouyinVideo(candidates) {
  for (const u of candidates.slice(0, 8)) {
    if (await hasVideoTrack(u)) return u;
  }
  return '';
}

async function fetchMedia(url, pageUrl) {  if (url.startsWith('data:')) {
    const blob = dataUrlToBlob(url);
    return { ok: true, blob, mime: blob.type };
  }
  if (!/^https?:/.test(url)) return { ok: false, reason: '不支持的链接协议' };

  const attempts = [
    { credentials: 'include', referrer: pageUrl || undefined, referrerPolicy: 'no-referrer-when-downgrade' },
    { credentials: 'include', referrerPolicy: 'no-referrer' },
  ];

  let lastStatus = 0;
  for (const init of attempts) {
    try {
      const res = await fetch(url, { ...init, headers: { Accept: 'image/*,video/*,*/*' } });
      lastStatus = res.status;
      if (!res.ok) continue;
      const blob = await res.blob();
      const mime = guessMime(url, res.headers.get('content-type') || blob.type);
      if (blob.size === 0) continue;
      if (mime.includes('text/html') || mime.includes('application/json')) {
        return { ok: false, reason: '目标返回的是网页/JSON，可能需要登录或触发了防盗链' };
      }
      return { ok: true, blob, mime };
    } catch (err) {
      lastStatus = 0;
    }
  }
  return {
    ok: false,
    reason: lastStatus
      ? `下载失败 HTTP ${lastStatus}（可能是防盗链、需要登录或跨域限制，可右键图片另存后再导入）`
      : '下载失败：网络错误或被目标站点拦截',
  };
}

/** 图片缩略图（最长边 480，JPEG）；视频不在此处理，用 poster 或 UI 占位 */
async function makeThumb(blob, kind = KIND.IMAGE) {
  if (kind !== KIND.IMAGE) return null;
  if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, LIMITS.thumbMax / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: LIMITS.thumbQuality });
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 上传流程
 * ------------------------------------------------------------------ */

async function uploadOne(id, adapterId, settings, progress) {
  const item = await getItem(id);
  if (!item) throw new Error('条目不存在或已被删除');
  const targetId = adapterId || resolveTarget(settings, item.kind)?.id;
  if (!targetId) throw new Error('没有可用的上传目标，请先在设置页启用并配置站点');
  const next = await uploadItemObject(item, targetId, settings, progress);
  return { item: next };
}

async function uploadMany(ids = [], adapterId, settings, progress) {
  const results = [];
  let done = 0;
  await mapLimit(ids, 2, async (id) => {
    try {
      const item = await getItem(id);
      if (!item) throw new Error('条目不存在');
      // 未显式指定站点时，逐条按类型走共享路由；都不满足则给出可读错误
      const targetId = adapterId || resolveTarget(settings, item.kind)?.id;
      if (!targetId) throw new Error('没有可用的上传目标，请先在设置页启用并配置站点');
      const next = await uploadItemObject(item, targetId, settings, (p) => {
        progress({ done, total: ids.length, message: p.message || `正在上传 ${Math.min(done + 1, ids.length)}/${ids.length}` });
      });
      results.push({ id, ok: true, url: next.remote?.url });
    } catch (err) {
      results.push({ id, ok: false, error: String(err.message || err) });
    } finally {
      done += 1;
      progress({ done, total: ids.length, message: `已处理 ${done}/${ids.length}` });
    }
  });
  const okCount = results.filter((r) => r.ok).length;
  return { results, ok: okCount, failed: results.length - okCount };
}

async function uploadItemObject(item, adapterId, settings, progress) {
  const blob = item.files?.orig ? await getBlob(item.files.orig) : null;
  if (!blob) throw new Error('本地没有文件副本（该条目为仅链接记录），无法上传');
  const config = settings.adapters?.[adapterId];
  if (!config) throw new Error(`没有找到「${adapterId}」的配置`);
  const report = (msg) => { try { progress?.({ done: 0, total: 1, message: typeof msg === 'string' ? msg : msg?.message || '' }); } catch (_) { /* 页面已关闭 */ } };
  const startedAt = Date.now();

  try {
    report(`正在上传 ${formatBytes(blob.size)}…`);
    // fetch 拿不到上传字节进度，用「已用时间」让进度条一直在动，避免看起来没反应
    const ticker = setInterval(() => {
      report(`正在上传 ${formatBytes(blob.size)}… 已用 ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 1500);
    let result;
    try {
      result = await uploadTo(adapterId, {
        blob,
        fileName: item.fileName,
        mime: item.mime || blob.type,
        kind: item.kind,
        config,
        item,
        progress: report,
      });
    } finally {
      clearInterval(ticker);
    }
    const next = await updateItem(item.id, {
      remote: {
        adapterId,
        url: result.url,
        path: result.path,
        size: result.size,
        privateLink: result.privateLink,
        uploadedAt: nowISO(),
        error: null,
        // 保留之前站点的历史记录（正常重传也不清空）
        history: item.remote?.history || [],
      },
    });
    return next || item;
  } catch (err) {
    // 失败时保留旧 remote 的链接与历史，只追加错误标记，避免原记录被覆盖
    const prev = item.remote || {};
    await updateItem(item.id, {
      remote: { ...prev, adapterId, error: String(err.message || err), uploadedAt: nowISO() },
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 跨站转存
 * ------------------------------------------------------------------ */

/**
 * 把条目搬到目标站点：优先用本地副本，没有本地副本时下载旧远程链接/来源链接。
 * 成功后旧记录进入 remote.history[]；上传阶段失败不写库，原 remote 保持原样。
 */
async function transferOne(item, adapterId, settings) {
  if (!item) throw new Error('条目不存在或已被删除');
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error(`未知的存储适配器：${adapterId}`);
  const config = settings.adapters?.[adapterId];
  if (!adapter.isConfigured(config || {})) throw new Error(`「${adapter.label}」还没配置完整`);

  let blob = item.files?.orig ? await getBlob(item.files.orig) : null;
  let fileName = item.fileName;
  let mime = item.mime || '';
  if (!blob) {
    const url = item.remote?.url || item.sourceUrl;
    if (!url) throw new Error('本地没有副本，也没有可下载的远程链接，无法转存');
    const fetched = await fetchMedia(url, item.pageUrl);
    if (!fetched.ok) throw new Error(fetched.reason);
    blob = fetched.blob;
    mime = fetched.mime;
    fileName = fileNameFromUrl(url, item.kind, mime);
  }

  // 上传成功前不触碰 IndexedDB，失败时原 remote 记录原样保留
  const result = await uploadTo(adapterId, {
    blob,
    fileName,
    mime: mime || blob.type,
    kind: item.kind,
    config,
    item,
  });

  const history = [...(item.remote?.history || [])];
  const prev = item.remote;
  if (prev?.url) {
    history.push({ adapterId: prev.adapterId, url: prev.url, at: prev.uploadedAt || nowISO() });
    if (history.length > 20) history.splice(0, history.length - 20);
  }

  const next = await updateItem(item.id, {
    remote: {
      adapterId,
      url: result.url,
      path: result.path,
      size: result.size,
      privateLink: result.privateLink,
      uploadedAt: nowISO(),
      error: null,
      history,
    },
  });
  return next || item;
}

async function transferMany(ids = [], adapterId, settings, progress) {
  const results = [];
  let done = 0;
  await mapLimit(ids, 2, async (id) => {
    try {
      const item = await getItem(id);
      const next = await transferOne(item, adapterId, settings);
      results.push({ id, ok: true, url: next.remote?.url });
    } catch (err) {
      results.push({ id, ok: false, error: String(err.message || err) });
    } finally {
      done += 1;
      progress({ done, total: ids.length, message: `已处理 ${done}/${ids.length}` });
    }
  });
  const okCount = results.filter((r) => r.ok).length;
  return { results, ok: okCount, failed: results.length - okCount };
}

/* ------------------------------------------------------------------ *
 * 浏览器入口 / 角标
 * ------------------------------------------------------------------ */

async function openLibrary() {
  const url = chrome.runtime.getURL(LIBRARY_PAGE);
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => t.url && t.url.startsWith(url));
  if (hit) {
    await chrome.tabs.update(hit.id, { active: true });
    await chrome.windows.update(hit.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

function updateBadge(tabId, count) {
  if (tabId === undefined || tabId === null) return;
  const text = count && count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' }).catch(() => {});
}

function notify(title, message) {
  if (!title) return;
  try {
    const maybePromise = chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON_128),
      title: `影图管家 · ${title}`,
      message: (message || '').slice(0, 180),
      priority: 0,
    });
    // notifications API 在不同版本上有时返回 Promise、有时返回 id，两种都兼容
    if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
  } catch (_) { /* 用户关闭通知权限时静默失败 */ }
}

/** 页面刷新时清掉旧角标，避免数字残留 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') updateBadge(tabId, 0);
});

/* 供调试：控制台里 __MV_STATS__ 查看占用情况 */
globalThis.__MV_STATS__ = () => getStats();
globalThis.__MV_DEFAULTS__ = DEFAULT_SETTINGS;
globalThis.__MV_STORAGE_KEY__ = STORAGE_KEY;
