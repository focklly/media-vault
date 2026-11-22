/**
 * 适配器：YourImageShare（免费图床 / 图片+视频，key 型 API）
 *
 * 现状（2026-11 实测）：站点有 key 型 JSON REST API，文档入口 https://yourimageshare.com/api
 * 需要登录后才可见（未登录返回 401），端点与鉴权字段未公开。因此这里做成「可调参的
 * key 型接口」：默认按主流约定 POST 到 /api/upload，文件走 multipart 的 file 字段，
 * key 同时放在请求头和表单里；返回里自动找第一个可用的直链。
 *
 * 如果站点文档给出的路径/头名不同，直接在设置里改「上传端点」和「鉴权头名称」即可，
 * 不需要改代码。免费限制：单文件 ≤200MB，支持图片与 MP4/MKV/MOV/WEBM 等视频格式。
 */

import { MB } from '../../shared/constants.js';

const MAX_BYTES = 200 * MB;

export default {
  id: 'yourimageshare',
  label: 'YourImageShare',
  badge: '免费·key API',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '免注册即可网页上传；key 型 API 的端点未公开，这里做成可调参直传，填 Key 后默认打 /api/upload。',
  docs: 'docs/ADAPTERS.md#yourimageshare',
  fields: [
    { key: 'endpoint', label: '上传端点', type: 'text', placeholder: 'https://yourimageshare.com/api/upload', required: true, help: '按站点文档填；默认 /api/upload，文档（需登录）给出别的路径时改这里。' },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '站点 API 页面里的 key', required: true, help: 'yourimageshare.com/api 登录后可生成。' },
    { key: 'authHeader', label: '鉴权头名称', type: 'text', placeholder: 'X-API-Key', required: false, help: '默认 X-API-Key；若站点用 Authorization，填 Authorization（值会自动加 Bearer 前缀）。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.apiKey);
  },

  async test(config) {
    if (!config?.apiKey) return { ok: false, message: '请先填写 API Key' };
    try {
      const res = await post(config, pngBlob(), 'connect-test.png');
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Key 被拒绝（HTTP ${res.status}）；确认端点与鉴权头（当前：${headerName(config)}）` };
      }
      const url = findUrl(text);
      if (!res.ok) return { ok: false, message: `返回 ${res.status}：${text.slice(0, 120)}` };
      if (!url) return { ok: false, message: '接口有响应但没找到直链，请在设置里核对端点与字段名' };
      return { ok: true, message: `API 可用（已传 1px 测试图：${url}）` };
    } catch (_) {
      return { ok: false, message: '无法连接 yourimageshare.com，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const res = await post(config, blob, fileName);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`YourImageShare 上传失败 ${res.status}：${text.slice(0, 140) || '检查 Key / 端点 / 鉴权头'}`);
    }
    const url = findUrl(text);
    if (!url) throw new Error(`YourImageShare 没有返回可用直链：${text.slice(0, 140)}`);
    return { url, path: '', size: blob.size || 0, privateLink: false };
  },
};

function headerName(config) {
  return (config?.authHeader || 'X-API-Key').trim();
}

async function post(config, blob, fileName) {
  const endpoint = (config?.endpoint || 'https://yourimageshare.com/api/upload').trim();
  const name = headerName(config);
  const value = name.toLowerCase() === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey;

  const form = new FormData();
  form.append('file', blob, fileName);
  // 一些 key 型接口只从表单读 key，一并带上不影响按头鉴权的实现
  form.append('key', config.apiKey);
  form.append('api_key', config.apiKey);

  return fetch(endpoint, {
    method: 'POST',
    headers: { [name]: value },
    body: form,
  });
}

/** 从 JSON / 纯文本里找第一个直链 */
function findUrl(text) {
  if (!text) return '';
  const trimmed = text.trim();
  if (/^https:\/\/\S+$/.test(trimmed)) return trimmed;

  let json = null;
  try { json = JSON.parse(trimmed); } catch (_) { return ''; }
  const hit = deepFind(json, 0);
  return hit || '';
}

function deepFind(node, depth) {
  if (!node || depth > 6) return '';
  if (typeof node === 'string') {
    return /^https:\/\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp|avif|mp4|webm|mov|mkv)(?:\?\S*)?$/i.test(node) ? node : '';
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = deepFind(v, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  if (typeof node === 'object') {
    // 常见字段名优先
    for (const key of ['url', 'direct_url', 'directUrl', 'link', 'file_url', 'fileUrl', 'download_url']) {
      const v = node[key];
      if (typeof v === 'string' && /^https:\/\//.test(v)) return v;
    }
    for (const v of Object.values(node)) {
      const hit = deepFind(v, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

function pngBlob() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}
