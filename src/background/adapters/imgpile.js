/**
 * 适配器：ImgPile（免费图床 / 图片+视频，需 API Key）
 *
 * 官方开发者文档：https://imgpile.com/developers
 *   1) 在 ImgPile 账号 「Settings → API」 创建 key；
 *   2) POST https://imgpile.com/uploads
 *      Header: Authorization: Bearer <IMGPILE_KEY>
 *      Body:   原始字节（--data-binary @photo.jpg，官方按内容识别类型）
 *      可选:   ?filename=<名字>（扩展名以你传的为准）
 *   3) 201 返回 JSON：
 *      { "data": { "slug","pageUrl","filename","ext","urls": { "original","thumb","sm","md","lg","xl" } } }
 *
 * 免费账号限制：静态图 ≤4MP 会被转 webp 且长边压到 2048；更大的图保留扩展名但仍压到 2048；
 * 动图/GIF 会转 MP4；单文件约 97MB；长期无人访问的文件会被回收。
 */

import { MB } from '../../shared/constants.js';

const API = 'https://imgpile.com/uploads';
const MAX_BYTES = 97 * MB;

export default {
  id: 'imgpile',
  label: 'ImgPile',
  badge: '免费图床·需 API Key',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '官方 Bearer API 直传，图片+视频，单文件约 97MB；免费图会转 WebP 并压到长边 2048px。',
  docs: 'docs/ADAPTERS.md#imgpile',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'imgpile 设置页创建的 key', required: true, help: 'ImgPile → Settings → API 创建；只填 key，不要带 “Bearer ”。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.apiKey);
  },

  async test(config) {
    if (!config?.apiKey) return { ok: false, message: '请先填写 ImgPile API Key' };
    try {
      const res = await post(config, pngBlob(), 'connect-test.png');
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Key 无效或被拒绝（HTTP ${res.status}），请在 ImgPile 设置页重新生成` };
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, message: `ImgPile 返回 ${res.status}：${short(json) || '检查 Key 与额度'}` };
      const url = pickUrl(json);
      if (!url) return { ok: false, message: '上传成功但返回里没有直链，检查是否为最新的开发者 API' };
      return { ok: true, message: `API 可用（已传 1px 测试图：${url}）` };
    } catch (_) {
      return { ok: false, message: '无法连接 imgpile.com，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const res = await post(config, blob, fileName);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 允许非 JSON */ }
    if (!res.ok) {
      throw new Error(`ImgPile 上传失败 ${res.status}：${short(json) || (text || '').slice(0, 120) || 'Key 无效或超出额度'}`);
    }
    const url = pickUrl(json);
    if (!url) throw new Error(`ImgPile 没有返回可用直链：${(text || '').slice(0, 140)}`);
    const data = json?.data || {};
    return {
      url,
      path: data.slug || data.filename || '',
      size: blob.size || 0,
      privateLink: false,
    };
  },
};

/** 按官方文档：原始字节 + Bearer 头，文件名放 query */
async function post(config, blob, fileName) {
  const qs = fileName ? `?filename=${encodeURIComponent(fileName)}` : '';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return fetch(`${API}${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: bytes,
  });
}

function pickUrl(json) {
  const urls = json?.data?.urls || json?.urls || {};
  return urls.original || urls.lg || urls.md || urls.sm || json?.data?.pageUrl || '';
}

function short(json) {
  if (!json) return '';
  return String(json.error?.message || json.message || json.error || '').slice(0, 120);
}

function pngBlob() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}
