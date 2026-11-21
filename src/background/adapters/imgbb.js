/**
 * 适配器：ImgBB（免费图床，仅图片）
 *
 * 原理：POST https://api.imgbb.com/1/upload?key=<API Key>，multipart 字段 image，
 * 返回 JSON，取 data.url（必要时回退 data.display_url）。
 * 限制：仅图片，单图 ≤32MB。API Key 需在 ImgBB 账号内申请；账号未开通 API 时
 *      接口会返回 400/403，部分能力可能需要 Pro 套餐。
 */

import { MB } from '../../shared/constants.js';

const API = 'https://api.imgbb.com/1/upload';
const MAX_BYTES = 32 * MB;

export default {
  id: 'imgbb',
  label: 'ImgBB',
  badge: '免费图床',
  supports: ['image'],
  maxBytes: MAX_BYTES,
  summary: '免费图片托管，仅支持图片；需要在账号里申请 API Key，部分接口能力可能需要 Pro。',
  docs: 'docs/ADAPTERS.md#imgbb',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'ImgBB API Key', required: true, help: '在 ImgBB 账号的 API 页面生成；不要填账号密码。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.apiKey);
  },

  async test(config) {
    if (!config?.apiKey) return { ok: false, message: '请先填写 API Key' };
    try {
      // 不带图片请求：Key 有效会返回缺图参数的 400，Key 无效/未开通 API 返回 401/403
      const res = await fetch(`${API}?key=${encodeURIComponent(config.apiKey)}`);
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'API Key 无效，或账号尚未开通 API（部分能力可能需要 Pro）' };
      }
      if (!res.ok && res.status !== 400) return { ok: false, message: `ImgBB 返回 ${res.status}` };
      return { ok: true, message: 'API Key 已识别，可上传图片' };
    } catch (_) {
      return { ok: false, message: '无法连接 ImgBB，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const form = new FormData();
    form.append('image', blob, fileName);

    const res = await fetch(`${API}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ImgBB 上传失败 ${res.status}：${describe(text) || 'API Key 无效，或账号未开通 API（可能需要 Pro）'}`);
    }

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`ImgBB 未返回 JSON：${text.slice(0, 160)}`);
    }
    const url = json?.data?.url || json?.data?.display_url;
    if (!url) throw new Error(`ImgBB 响应里找不到图片链接：${text.slice(0, 160)}`);
    return { url, path: '', size: blob.size, privateLink: false };
  },
};

function describe(text) {
  try {
    const json = JSON.parse(text);
    return json?.error?.message || '';
  } catch (_) {
    return text.slice(0, 160);
  }
}
