/**
 * IndexedDB 访问层（个人空间）
 *
 * 设计要点
 * - 元数据（items）与二进制（blobs）分表：列表页只读元数据，滚动筛选不会把几 GB 的
 *   Blob 读进内存；预览时才按 key 取 Blob。
 * - 任何上下文（service worker / library / popup / settings）都可以直接打开同一个库，
 *   IndexedDB 以扩展 origin 为作用域，天然共享。
 * - 写操作尽量在 service worker 里做，页面只做读与展示，减少多上下文写入冲突。
 */

import { DB } from './constants.js';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB.NAME, DB.VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB.ITEMS)) {
        const items = db.createObjectStore(DB.ITEMS, { keyPath: 'id' });
        items.createIndex('createdAt', 'createdAt');
        items.createIndex('kind', 'kind');
        items.createIndex('site', 'site');
        items.createIndex('provider', 'provider');
        items.createIndex('status', 'status');
        items.createIndex('fav', 'fav');
      }
      if (!db.objectStoreNames.contains(DB.BLOBS)) {
        const blobs = db.createObjectStore(DB.BLOBS, { keyPath: 'id' });
        blobs.createIndex('itemId', 'itemId');
      }
      // 预留：后续版本可在此处升级 v2（例如新增 tags 索引），只需递增 DB.VERSION
      void event;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用，请关闭个人空间页面后重试'));
  });
  return dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('事务被中止'));
  });
}

/* ---------------- items ---------------- */

export async function putItem(item) {
  const t = await tx([DB.ITEMS], 'readwrite');
  t.objectStore(DB.ITEMS).put(item);
  await txDone(t);
  return item;
}

export async function getItem(id) {
  const t = await tx([DB.ITEMS]);
  return wrap(t.objectStore(DB.ITEMS).get(id));
}

export async function getAllItems() {
  const t = await tx([DB.ITEMS]);
  return wrap(t.objectStore(DB.ITEMS).getAll());
}

export async function updateItem(id, patch) {
  const t = await tx([DB.ITEMS], 'readwrite');
  const store = t.objectStore(DB.ITEMS);
  const item = await wrap(store.get(id));
  if (!item) {
    await txDone(t);
    return null;
  }
  const next = { ...item, ...patch, updatedAt: new Date().toISOString() };
  store.put(next);
  await txDone(t);
  return next;
}

/**
 * 列表查询（元数据，不含 Blob）
 * @param {object} query
 * @param {'image'|'video'|'all'} query.kind
 * @param {'all'|'uploaded'|'pending'|'link'} query.status
 * @param {string} query.q 关键字（标题/文件名/站点/来源页）
 * @param {boolean} query.favoriteOnly
 * @param {'new'|'old'|'size'|'name'} query.sort
 */
export async function listItems(query = {}) {
  const all = await getAllItems();
  const {
    kind = 'all',
    status = 'all',
    q = '',
    favoriteOnly = false,
    site = '',
    adapter = '',
    sort = 'new',
  } = query;

  let list = all;
  if (kind !== 'all') list = list.filter((it) => it.kind === kind);
  if (site) list = list.filter((it) => it.site === site);
  if (adapter) list = list.filter((it) => (it.remote && it.remote.adapterId) === adapter);
  if (favoriteOnly) list = list.filter((it) => it.fav === 1);
  if (status === 'uploaded') list = list.filter((it) => it.remote && it.remote.url);
  if (status === 'pending') list = list.filter((it) => !it.remote || !it.remote.url);
  if (status === 'link') list = list.filter((it) => it.status === 'link-only');
  if (q) {
    const key = q.trim().toLowerCase();
    list = list.filter((it) => [it.title, it.fileName, it.site, it.pageUrl, it.sourceUrl, ...(it.tags || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(key));
  }

  const sorters = {
    new: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    old: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    name: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'),
  };
  list.sort(sorters[sort] || sorters.new);
  return list;
}

/**
 * 删除条目及其所有 Blob，返回删除条数
 * 注意：IndexedDB 事务里不要「读一条 await 一下再写」——事务会在空档期自动提交。
 * 所以先一次性读出所有目标条目，再在一个写事务里同步删完。
 */
export async function deleteItems(ids = []) {
  const idSet = new Set(ids);
  const all = await getAllItems();
  const targets = all.filter((it) => idSet.has(it.id));
  if (!targets.length) return 0;

  const t = await tx([DB.ITEMS, DB.BLOBS], 'readwrite');
  const itemsStore = t.objectStore(DB.ITEMS);
  const blobsStore = t.objectStore(DB.BLOBS);
  for (const item of targets) {
    const keys = Object.values(item.files || {}).filter(Boolean);
    fallbackKeys(item.id).forEach((k) => blobsStore.delete(k));
    keys.forEach((k) => blobsStore.delete(k));
    itemsStore.delete(item.id);
  }
  await txDone(t);
  return targets.length;
}

function fallbackKeys(id) {
  return [`${id}:orig`, `${id}:thumb`];
}

export async function clearAll() {
  const t = await tx([DB.ITEMS, DB.BLOBS], 'readwrite');
  t.objectStore(DB.ITEMS).clear();
  t.objectStore(DB.BLOBS).clear();
  await txDone(t);
}

/* ---------------- blobs ---------------- */

export async function putBlob(id, itemId, blob) {
  const t = await tx([DB.BLOBS], 'readwrite');
  t.objectStore(DB.BLOBS).put({ id, itemId, blob, size: blob.size, mime: blob.type });
  await txDone(t);
  return id;
}

export async function getBlob(id) {
  if (!id) return null;
  const t = await tx([DB.BLOBS]);
  const rec = await wrap(t.objectStore(DB.BLOBS).get(id));
  return rec ? rec.blob : null;
}

export async function hasBlob(id) {
  const t = await tx([DB.BLOBS]);
  return wrap(t.objectStore(DB.BLOBS).getKey(id)).then((k) => Boolean(k));
}

/** 统计：条目数、占用体积、各类型分布 */
export async function getStats() {
  const items = await getAllItems();
  const stats = {
    total: items.length,
    images: 0,
    videos: 0,
    links: 0,
    uploaded: 0,
    favorites: 0,
    bytes: 0,
    remoteBytes: 0,
    bySite: {},
    oldest: null,
    newest: null,
  };
  for (const it of items) {
    if (it.kind === 'video') stats.videos += 1;
    else stats.images += 1;
    if (it.status === 'link-only') stats.links += 1;
    if (it.remote && it.remote.url) {
      stats.uploaded += 1;
      stats.remoteBytes += it.remote.size || it.size || 0;
    }
    if (it.fav === 1) stats.favorites += 1;
    stats.bytes += it.size || 0;
    if (it.site) stats.bySite[it.site] = (stats.bySite[it.site] || 0) + 1;
    if (it.createdAt) {
      if (!stats.newest || it.createdAt > stats.newest) stats.newest = it.createdAt;
      if (!stats.oldest || it.createdAt < stats.oldest) stats.oldest = it.createdAt;
    }
  }
  return stats;
}

/** 导出清单（仅元数据，不含二进制，可作为迁移/审计依据） */
export async function exportManifest() {
  const items = await getAllItems();
  return {
    app: 'MediaVault',
    exportedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

/** 导入清单：仅合并元数据，不还原文件本体（v1 明确限制，见文档） */
export async function importManifest(manifest) {
  const incoming = Array.isArray(manifest) ? manifest : (manifest.items || []);
  const existing = new Set((await getAllItems()).map((it) => it.id));
  const fresh = incoming.filter((raw) => raw && raw.id && !existing.has(raw.id));

  const t = await tx([DB.ITEMS], 'readwrite');
  const store = t.objectStore(DB.ITEMS);
  for (const raw of fresh) {
    // 只导入元数据，本机没有对应文件，统一降级为“仅链接”记录，避免展示空白卡片
    store.put({ ...raw, status: 'link-only', files: {}, updatedAt: new Date().toISOString() });
  }
  await txDone(t);
  return fresh.length;
}
