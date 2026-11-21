/**
 * 适配器：通用 HTTP 图床（SM.MS / 兰空 / 自建接口）
 *
 * 用 multipart/form-data POST 一个文件字段，然后从 JSON 响应里按点路径取 URL。
 * 例：
 *   SM.MS      url=https://sm.ms/api/v2/upload   field=smfile  headers={"Authorization":"..."}  responsePath=data.url
 *   兰空图床    url=https://your.host/api/v1/upload field=file  headers={"Authorization":"Bearer xxx"} responsePath=data.links.url
 *   自建接口    url=https://your.api/upload       field=file   responsePath=url
 *
 * 该适配器是“外接任意图床”的兜底方案，不需要改代码即可接新图床。
 */

import { MB } from '../../shared/constants.js';
import { formatBytes, getByPath } from '../../shared/utils.js';

export default {
  id: 'http',
  label: '通用 HTTP 图床',
  badge: '最灵活',
  supports: ['image', 'video'],
  /** 实际上限由配置里的 maxMB 决定，这里只做提示 */
  maxBytes: Infinity,
  summary: '标准 multipart 上传，任何返回 JSON 的图床都能接；填 URL、字段名和返回路径即可。',
  docs: 'docs/ADAPTERS.md#通用-http-图床',
  fields: [
    { key: 'url', label: '上传接口', type: 'text', placeholder: 'https://sm.ms/api/v2/upload', required: true },
    { key: 'field', label: '文件字段名', type: 'text', placeholder: 'file / smfile / image', required: true },
    { key: 'headersJson', label: '附加请求头 (JSON)', type: 'textarea', placeholder: '{"Authorization":"Bearer xxx"}', required: false },
    { key: 'fieldsJson', label: '附加表单字段 (JSON)', type: 'textarea', placeholder: '{"album":"default"}', required: false },
    { key: 'responsePath', label: '返回 URL 的路径', type: 'text', placeholder: 'data.url', required: true, help: '按 JSON 点路径取值；若接口直接返回纯文本 URL，填 text。' },
    { key: 'publicBase', label: '链接补全前缀', type: 'text', placeholder: 'https://i.example.com/', required: false, help: '当接口只返回相对路径时使用。' },
    { key: 'maxMB', label: '单文件上限 (MB)', type: 'number', placeholder: '10', required: false },
  ],

  isConfigured(config) {
    return Boolean(config && config.url && config.field);
  },

  async test(config) {
    if (!/^https?:\/\//.test(config.url || '')) return { ok: false, message: '接口地址需以 http(s):// 开头' };
    try {
      JSON.parse(config.headersJson || '{}');
      JSON.parse(config.fieldsJson || '{}');
    } catch (_) {
      return { ok: false, message: '附加请求头或表单字段不是合法 JSON' };
    }
    return { ok: true, message: '配置格式正确；连通性将在首次上传时验证（避免用空文件污染图床）' };
  },

  async upload({ blob, fileName, config }) {
    const limit = (Number(config.maxMB) || 10) * MB;
    if (blob.size > limit) {
      throw new Error(`文件 ${formatBytes(blob.size)} 超过该图床配置上限 ${formatBytes(limit)}`);
    }

    const form = new FormData();
    form.append(config.field, blob, fileName);

    let fields = {};
    try { fields = JSON.parse(config.fieldsJson || '{}'); } catch (_) { fields = {}; }
    Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));

    let headers = {};
    try { headers = JSON.parse(config.headersJson || '{}'); } catch (_) { headers = {}; }

    const res = await fetch(config.url, { method: 'POST', headers, body: form });
    const text = await res.text();
    if (!res.ok) throw new Error(`图床上传失败 ${res.status}：${text.slice(0, 160)}`);

    let url = '';
    if (config.responsePath === 'text') {
      url = text.trim();
    } else {
      let json;
      try { json = JSON.parse(text); } catch (_) {
        throw new Error('接口未返回 JSON，可把“返回 URL 的路径”设为 text');
      }
      url = getByPath(json, config.responsePath || 'data.url');
    }
    if (!url || typeof url !== 'string') {
      throw new Error(`响应里找不到 ${config.responsePath}，原始响应：${text.slice(0, 160)}`);
    }
    if (!/^https?:\/\//.test(url)) {
      const base = (config.publicBase || '').replace(/\/+$/, '');
      if (!base) throw new Error(`接口返回相对路径 ${url}，请配置“链接补全前缀”`);
      url = `${base}/${url.replace(/^\/+/, '')}`;
    }
    return { url, path: '', size: blob.size, privateLink: false };
  },
};
