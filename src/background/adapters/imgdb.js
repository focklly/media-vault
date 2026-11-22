/**
 * 适配器：imgdb.io（免费图床，免注册，仅图片）
 *
 * 原理：POST https://imgdb.io/api/v1/upload，multipart 字段名 file；
 * 也可以直接 POST 原始字节并带正确的 Content-Type。成功返回 201 + JSON，
 * 关键字段 url（形如 https://imgdb.io/i/<id>.png），另有 id / kind / type。
 * 可选参数：
 * - ttl（秒，0 = 永久；不填默认 72 小时）
 * - once=1 下载一次即销毁
 * - password：本适配器改用 X-Upload-Password 请求头（文档推荐）
 * - description：本适配器改用 X-Upload-Description 请求头
 * 限制：单图 ≤16MB，支持 png/jpg/gif/webp/avif/bmp。
 * 文档：https://imgdb.io/docs、https://imgdb.io/llms.txt
 */

import { MB } from '../../shared/constants.js';

const API = 'https://imgdb.io/api/v1/upload';
const MAX_BYTES = 16 * MB;

export default {
  id: 'imgdb',
  label: 'imgdb.io',
  badge: '免费图床·免注册',
  supports: ['image'],
  maxBytes: MAX_BYTES,
  summary: '免注册直传的免费图床，返回 https://imgdb.io/i/xxx 直链，单图 ≤16MB。',
  docs: 'docs/ADAPTERS.md#imgdb',
  fields: [
    { key: 'ttl', label: '保留时长（秒，0 = 永久）', type: 'number', placeholder: '0', required: false, help: '站点默认 72 小时（259200 秒）；填 0 表示永久保存。' },
    { key: 'password', label: '访问密码（可选）', type: 'password', placeholder: '留空则公开可访问', required: false, help: '填写后只有带密码的人能打开链接，适合私密图。' },
    { key: 'description', label: '描述（可选）', type: 'text', placeholder: '给这批图加个备注', required: false, help: '会写进站点的上传记录，便于日后检索。' },
  ],

  // 免注册站点：没有必填凭证
  isConfigured() {
    return true;
  },

  async test() {
    try {
      // 不带上行数据探测：接口在时返回 400/405，站点故障时返回 5xx
      const res = await fetch(API, { method: 'GET' });
      if (res.status >= 500) return { ok: false, message: `imgdb.io 服务返回 ${res.status}，稍后再试` };
      return { ok: true, message: 'imgdb.io 接口可达，可直接上传图片' };
    } catch (_) {
      return { ok: false, message: '无法连接 imgdb.io，检查网络或代理后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const form = new FormData();
    form.append('file', blob, fileName);

    const ttl = Number(config?.ttl);
    if (Number.isFinite(ttl) && ttl >= 0 && config?.ttl !== '') form.append('ttl', String(Math.floor(ttl)));

    const headers = {};
    if (config?.password) headers['X-Upload-Password'] = String(config.password);
    if (config?.description) {
      // 非 ASCII 需要 percent-encode，站点按解码后的值入库
      headers['X-Upload-Description'] = encodeURIComponent(String(config.description)).replace(/%20/g, ' ');
    }

    const res = await fetch(API, { method: 'POST', headers, body: form });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`imgdb.io 上传失败 ${res.status}：${describe(text) || '接口拒绝本次上传'}`);
    }

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`imgdb.io 未返回 JSON：${text.slice(0, 160)}`);
    }
    const url = json?.url || json?.data?.url || json?.link;
    if (!url) throw new Error(`imgdb.io 响应里找不到图片链接：${text.slice(0, 160)}`);
    return { url, path: json?.id || '', size: blob.size || 0, privateLink: Boolean(config?.password) };
  },
};

function describe(text) {
  try {
    const json = JSON.parse(text);
    return json?.error?.message || json?.message || json?.detail || '';
  } catch (_) {
    return (text || '').slice(0, 160);
  }
}
