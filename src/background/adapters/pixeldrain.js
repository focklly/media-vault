/**
 * 适配器：Pixeldrain（免费·大文件）
 *
 * 原理：PUT 原始二进制到 https://pixeldrain.com/api/file/<文件名>，成功后返回 JSON（含 id），
 * 直链为 https://pixeldrain.com/api/file/<id>?download。
 * 限制：免费单文件可达 20GB；文件至少保留约两个月，长期不活跃可能被清理。
 * 填 API Key 后文件归属账号，匿名上传同样可用。
 */

import { MB } from '../../shared/constants.js';
import { textToBase64 } from '../../shared/utils.js';

const API = 'https://pixeldrain.com/api/file';
const MAX_BYTES = 20 * 1024 * MB;

export default {
  id: 'pixeldrain',
  label: 'Pixeldrain',
  badge: '免费·大文件',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '免费大文件托管，单文件可达 20GB，适合存视频；文件按活跃度保留约两个月。',
  docs: 'docs/ADAPTERS.md#pixeldrain',
  fields: [
    { key: 'apiKey', label: 'API Key（可选）', type: 'text', placeholder: 'Pixeldrain API Key', required: false, help: '留空匿名上传；填入后文件归属你的账号，便于管理。' },
  ],

  // 匿名可用，没有必填凭证
  isConfigured() {
    return true;
  },

  async test(config) {
    try {
      const headers = config?.apiKey ? authHeaders(config.apiKey) : {};
      const res = await fetch('https://pixeldrain.com/api/user', { headers });
      // 匿名访问 / 未登录返回 401 属正常，只要站点可达即视为配置格式正确
      if (res.status === 401) return { ok: true, message: '站点可达；当前为匿名上传（未填 API Key）' };
      if (!res.ok) return { ok: false, message: `Pixeldrain 返回 ${res.status}` };
      return { ok: true, message: '连接正常，API Key 已识别' };
    } catch (_) {
      return { ok: false, message: '无法连接 Pixeldrain，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, mime, config }) {
    const url = `${API}/${encodeURIComponent(fileName)}`;
    const headers = { 'Content-Type': mime || blob.type || 'application/octet-stream' };
    if (config?.apiKey) Object.assign(headers, authHeaders(config.apiKey));

    const res = await fetch(url, { method: 'PUT', headers, body: blob });
    const text = await res.text();
    if (!res.ok) throw new Error(`Pixeldrain 上传失败 ${res.status}：${text.slice(0, 160)}`);

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`Pixeldrain 未返回 JSON：${text.slice(0, 160)}`);
    }
    const id = json.id;
    if (!id) throw new Error(`Pixeldrain 响应里找不到文件 id：${text.slice(0, 160)}`);
    return {
      url: `${API}/${id}?download`,
      path: id,
      size: blob.size,
      privateLink: false,
    };
  },
};

function authHeaders(apiKey) {
  // Pixeldrain 的 Basic 认证：用户名留空，密码为 API Key
  return { Authorization: `Basic ${textToBase64(`:${apiKey}`)}` };
}
