/**
 * 适配器：Imgur（免费图床）
 *
 * 原理：POST https://api.imgur.com/3/image，Header `Authorization: Client-ID <Client ID>`，
 * multipart 字段 image，返回 JSON data.link。
 * 限制：支持图片 / GIF / mp4（≤200MB、视频时长 ≤60s）；视频上传受账号与地区限制，
 *      失败时请换用 Catbox / Pixeldrain 等其他站点。
 */

import { MB } from '../../shared/constants.js';

const API = 'https://api.imgur.com/3/image';
const MAX_BYTES = 200 * MB;

export default {
  id: 'imgur',
  label: 'Imgur',
  badge: '免费图床',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '免费图床，支持图片/GIF/短视频；视频上传受账号与地区限制，失败可换其他站点。',
  docs: 'docs/ADAPTERS.md#imgur',
  fields: [
    { key: 'clientId', label: 'Client ID', type: 'text', placeholder: 'Imgur 应用 Client ID', required: true, help: '在 Imgur 后台注册 OAuth 应用获取；不是账号密码。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.clientId);
  },

  async test(config) {
    if (!config?.clientId) return { ok: false, message: '请先填写 Client ID' };
    try {
      const res = await fetch(`https://api.imgur.com/3/application/${encodeURIComponent(config.clientId)}`, {
        headers: { Authorization: `Client-ID ${config.clientId}` },
      });
      if (res.status === 404 || res.status === 403) {
        return { ok: false, message: 'Client ID 无效，或应用未通过审核' };
      }
      if (!res.ok) return { ok: false, message: `Imgur 返回 ${res.status}` };
      return { ok: true, message: 'Client ID 已识别，可上传图片/GIF/短视频' };
    } catch (_) {
      return { ok: false, message: '无法连接 Imgur，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const form = new FormData();
    form.append('image', blob, fileName);

    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Client-ID ${config.clientId}` },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Imgur 上传失败 ${res.status}：${describe(text) || 'Client ID 无效；视频上传可能受账号/地区限制'}`);
    }

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`Imgur 未返回 JSON：${text.slice(0, 160)}`);
    }
    const url = json?.data?.link;
    if (!url) throw new Error(`Imgur 响应里找不到链接：${text.slice(0, 160)}`);
    return { url, path: '', size: blob.size, privateLink: false };
  },
};

function describe(text) {
  try {
    const json = JSON.parse(text);
    return json?.data?.error?.message || json?.error?.message || '';
  } catch (_) {
    return text.slice(0, 160);
  }
}
