/**
 * 通用工具函数（无副作用、可在任意上下文复用）。
 * 注意：本文件不依赖 chrome API，方便单元测试与二次开发。
 */

/** 生成短 ID，带类型前缀便于日志排查 */
export function uid(prefix = 'itm') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0].toString(36)}${rand[1].toString(36)}`;
}

export function nowISO() {
  return new Date().toISOString();
}

/** 人类可读体积 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 秒 -> mm:ss / h:mm:ss */
export function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** URL -> 扩展名（无扩展名时按 mime 兜底） */
export function extFromUrl(url, mime = '') {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch (_) { /* 忽略非法 URL */ }
  return extFromMime(mime);
}

export function extFromMime(mime = '') {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'application/vnd.apple.mpegurl': 'm3u8',
    'application/x-mpegurl': 'm3u8',
  };
  return map[(mime || '').split(';')[0].trim().toLowerCase()] || 'bin';
}

export function isVideoUrl(url = '') {
  return /\.(mp4|webm|ogv|mov|m4v|mkv|m3u8|mpd|flv)(\?|#|$)/i.test(url);
}

export function isImageUrl(url = '') {
  return /\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i.test(url) || /^data:image\//.test(url);
}

/** 取文件名（去掉查询串、解码、非法字符替换） */
export function fileNameFromUrl(url, fallbackKind = 'file', mime = '') {
  let name = '';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch (_) {
    name = String(url).split('?')[0].split('/').pop() || '';
  }
  name = sanitizeName(name);
  if (!name || !/\./.test(name)) {
    name = `${fallbackKind}-${Date.now().toString(36)}.${extFromUrl(url, mime)}`;
  }
  return name;
}

/** 去掉文件系统/对象存储不欢迎的字符 */
export function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

/** 生成唯一文件名：原名 + 短哈希，避免同名覆盖 */
export function uniqueFileName(name, seed = '') {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const hash = shortHash(`${name}${seed}${Date.now()}`);
  return `${base.slice(0, 80)}-${hash}${ext}`;
}

/** 32 位十六进制以内的短哈希（FNV-1a，够用且同步） */
export function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

/** 按日期分目录，避免单目录过多文件 */
export function datePath(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/`;
}

export function joinPath(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '');
}

/** 逐段 encodeURIComponent，保留路径分隔符 */
export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function normalizePrefix(prefix = '') {
  const p = String(prefix).trim().replace(/^\/+/, '');
  return p && !p.endsWith('/') ? `${p}/` : p;
}

/**
 * Blob -> base64
 * 注意：service worker 里没有 FileReader，必须走 arrayBuffer，保证两处通用。
 */
export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  return bufferToBase64(buf);
}

/** ArrayBuffer/TypedArray -> base64（分块拼接，避免大文件爆栈） */
export function bufferToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 字符串（含中文）-> base64，用于 WebDAV Basic 认证头 */
export function textToBase64(text) {
  return bufferToBase64(new TextEncoder().encode(text));
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const isBase64 = /;base64/.test(head);
  if (!isBase64) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function arrayBufferToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return arrayBufferToHex(await crypto.subtle.digest('SHA-256', buf));
}

export async function hmac(key, data) {
  const rawKey = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/** 并发受限的 map，保持返回顺序 */
export async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/** 从响应头或 URL 猜 mime */
export function guessMime(url, contentType = '') {
  const ct = (contentType || '').split(';')[0].trim();
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  const ext = extFromUrl(url);
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m3u8: 'application/vnd.apple.mpegurl' };
  return map[ext] || 'application/octet-stream';
}

/** 取对象上的点路径，用于解析图床 JSON 响应，如 data.url */
export function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}
