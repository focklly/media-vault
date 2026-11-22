/**
 * 适配器：Wistia（视频托管，需注册）
 *
 * 原理：经典上传接口 POST https://upload.wistia.com（multipart）：
 *   api_password = 账号的 API password（不是登录密码）
 *   file         = 视频文件
 *   name         = 可选标题；project_id = 可选项目
 * 返回 JSON：media.hashed_id，播放页 https://home.wistia.com/medias/<hashed_id>。
 * 限制：上传耗时与文件大小相关，免费版有视频数量/时长限制；需要在账号
 *      Account → API 里拿 API password（部分新版账号改用 API token + Bearer）。
 */

import { MB } from '../../shared/constants.js';

const API = 'https://upload.wistia.com';
const MAX_BYTES = 1024 * MB;

export default {
  id: 'wistia',
  label: 'Wistia',
  badge: '视频托管·需账号',
  supports: ['video'],
  maxBytes: MAX_BYTES,
  summary: '专业视频托管，上传后给播放页 + 内嵌代码；需要在 Wistia 账号里取 API password。',
  docs: 'docs/ADAPTERS.md#wistia',
  fields: [
    { key: 'apiPassword', label: 'API password', type: 'password', placeholder: 'Wistia 账号里的 API password', required: true, help: 'Account → API Access 里生成；不是登录密码，也不要填 API token。' },
    { key: 'projectId', label: '项目 ID（可选）', type: 'text', placeholder: '留空进默认项目', required: false, help: '放到指定项目里便于团队管理。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.apiPassword);
  },

  async test(config) {
    if (!config?.apiPassword) return { ok: false, message: '请先填写 API password' };
    try {
      // 只带密码不带文件：密码有效时返回 400（缺文件），无效时 401/403
      const form = new FormData();
      form.append('api_password', config.apiPassword);
      const res = await fetch(API, { method: 'POST', body: form });
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'API password 无效，或账号不支持该上传接口' };
      if (res.status === 400) return { ok: true, message: 'API password 已被接受（上传时再带文件）' };
      return { ok: false, message: `Wistia 返回 ${res.status}，稍后再试` };
    } catch (_) {
      return { ok: false, message: '无法连接 upload.wistia.com，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, item, config }) {
    const form = new FormData();
    form.append('api_password', config.apiPassword);
    form.append('file', blob, fileName);
    form.append('name', item?.title || fileName);
    if (config.projectId) form.append('project_id', String(config.projectId));

    const res = await fetch(API, { method: 'POST', body: form });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Wistia 上传失败 ${res.status}：${describe(text) || 'API password 无效或账号额度不足'}`);
    }
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`Wistia 未返回 JSON：${text.slice(0, 160)}`);
    }
    const id = json?.media?.hashed_id || json?.hashed_id;
    if (!id) throw new Error(`Wistia 响应里找不到 hashed_id：${text.slice(0, 160)}`);
    return {
      url: `https://home.wistia.com/medias/${id}`,
      path: id,
      size: blob.size || 0,
      privateLink: false,
    };
  },
};

function describe(text) {
  try {
    const json = JSON.parse(text);
    return json?.error || json?.message || '';
  } catch (_) {
    return (text || '').slice(0, 160);
  }
}
