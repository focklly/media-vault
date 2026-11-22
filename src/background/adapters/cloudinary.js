/**
 * 适配器：Cloudinary（免费额度图床 / 视频托管）
 *
 * 原理：用「无签名上传预设（unsigned upload preset）」直传，不需要把 API Secret
 * 放进扩展。POST https://api.cloudinary.com/v1_1/<cloud_name>/auto/upload，
 * multipart 字段：file、upload_preset（可选 folder），返回 JSON.secure_url。
 * 限制：免费额度按账号计，大视频受套餐限制；需要用户在 Cloudinary 后台自建
 * unsigned preset（Settings → Upload → Upload presets，Signing Mode = Unsigned）。
 */

import { MB } from '../../shared/constants.js';

const MAX_BYTES = 100 * MB;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export default {
  id: 'cloudinary',
  label: 'Cloudinary',
  badge: '免费额度·图+视频',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '图片和视频都能放，用「无签名上传预设」直传；需注册并填 cloud name + preset。',
  docs: 'docs/ADAPTERS.md#cloudinary',
  fields: [
    { key: 'cloudName', label: 'Cloud name', type: 'text', placeholder: '例如 dxxxxxx', required: true, help: 'Cloudinary 控制台首页的 Cloud name，不是邮箱。' },
    { key: 'uploadPreset', label: 'Upload preset（无签名）', type: 'text', placeholder: '例如 mediavault_unsigned', required: true, help: 'Settings → Upload → Upload presets 新建，Signing Mode 选 Unsigned。' },
    { key: 'folder', label: '存放目录（可选）', type: 'text', placeholder: '例如 mediavault', required: false, help: '留空则进账号默认目录。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.cloudName && config.uploadPreset);
  },

  async test(config) {
    if (!config?.cloudName || !config?.uploadPreset) return { ok: false, message: '请先填写 Cloud name 和 Upload preset' };
    try {
      // 用 1×1 PNG 真传一次：能拿到 secure_url 才算预设可用（会在后台留一张测试图）
      const res = await fetch(endpoint(config.cloudName), {
        method: 'POST',
        body: formFor(config, pngBlob(), 'connect-test.png'),
      });
      const json = await parse(res);
      if (!res.ok) return { ok: false, message: `预设不可用：${errMsg(json) || `HTTP ${res.status}`}` };
      if (!json?.secure_url) return { ok: false, message: '返回里没有 secure_url，检查预设是否为 Unsigned' };
      return { ok: true, message: '预设可用（已用 1px 测试图验证，可在后台删除）' };
    } catch (_) {
      return { ok: false, message: '无法连接 api.cloudinary.com，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const res = await fetch(endpoint(config.cloudName), {
      method: 'POST',
      body: formFor(config, blob, fileName),
    });
    const json = await parse(res);
    if (!res.ok) {
      throw new Error(`Cloudinary 上传失败 ${res.status}：${errMsg(json) || '检查 cloud name 与 unsigned preset'}`);
    }
    const url = json?.secure_url || json?.url;
    if (!url) throw new Error('Cloudinary 响应里找不到 secure_url');
    return { url, path: json?.public_id || '', size: Number(json?.bytes) || blob.size || 0, privateLink: false };
  },
};

function endpoint(cloudName) {
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/auto/upload`;
}

function formFor(config, blob, fileName) {
  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('upload_preset', config.uploadPreset);
  if (config.folder) form.append('folder', config.folder);
  return form;
}

function pngBlob() {
  const bin = atob(TINY_PNG);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

async function parse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { error: { message: text.slice(0, 160) } }; }
}

function errMsg(json) {
  return json?.error?.message || json?.message || '';
}
