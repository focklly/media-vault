/**
 * 适配器：WebDAV 网盘（坚果云 / Nextcloud / Alist / 群晖）
 *
 * 这是「接网盘」最通用的通道：一把 WebDAV 地址就能把文件写进网盘目录。
 * 想把百度网盘、阿里云盘、夸克网盘接进来，用 Alist 把它们挂载后开启 WebDAV 即可，
 * 具体步骤见 docs/ADAPTERS.md#webdav-网盘。
 *
 * 限制：多数 WebDAV 服务不返回可公开分享的直链，所以 remoteUrl 默认标记为“需登录访问”，
 *      个人空间里仍以本地副本预览，外链分享请配置 publicBase（如 Alist 的直链域名）。
 */

import { encodePath, joinPath, normalizePrefix, textToBase64, uniqueFileName } from '../../shared/utils.js';

export default {
  id: 'webdav',
  label: 'WebDAV 网盘',
  badge: '接网盘',
  supports: ['image', 'video'],
  maxBytes: Infinity,
  summary: '坚果云、Nextcloud、群晖、Alist（可桥接百度网盘/阿里云盘/夸克）；不限格式，适合做长期归档。',
  docs: 'docs/ADAPTERS.md#webdav-网盘',
  fields: [
    { key: 'baseUrl', label: 'WebDAV 地址', type: 'text', placeholder: 'https://dav.jianguoyun.com/dav/', required: true, help: '必须带结尾斜杠；Alist 一般是 http://127.0.0.1:5244/dav。' },
    { key: 'username', label: '用户名', type: 'text', required: true, help: '坚果云用登录邮箱，密码处填“应用密码”。' },
    { key: 'password', label: '密码 / 应用密码', type: 'password', required: true },
    { key: 'pathPrefix', label: '存储目录', type: 'text', placeholder: 'MediaVault/', required: false, help: '会自动创建缺失的目录。' },
    { key: 'publicBase', label: '公开直链前缀', type: 'text', placeholder: 'https://alist.example.com/d/media/', required: false, help: '留空则只保存“需登录”的内部链接。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.baseUrl && config.username && config.password);
  },

  async test(config) {
    if (!String(config.baseUrl).endsWith('/')) {
      return { ok: false, message: 'WebDAV 地址必须以 / 结尾，例如 https://dav.jianguoyun.com/dav/' };
    }
    const headers = authHeaders(config);
    const res = await fetch(config.baseUrl, { method: 'PROPFIND', headers: { ...headers, Depth: '0' } });
    if (res.status === 401) return { ok: false, message: '认证失败：用户名或应用密码不正确' };
    if (res.status === 403) return { ok: false, message: '403：该账号无权限访问此目录' };
    if (res.status === 404) return { ok: false, message: '404：WebDAV 地址不存在，检查结尾斜杠与路径' };
    if (!res.ok && res.status !== 207) return { ok: false, message: `服务返回 ${res.status}` };
    return { ok: true, message: '认证成功，WebDAV 可用' };
  },

  async upload({ blob, fileName, config }) {
    const prefix = normalizePrefix(config.pathPrefix || 'MediaVault/');
    const key = joinPath(prefix, dateDir(), uniqueFileName(fileName));
    await ensureCollections(config, prefix);

    const url = new URL(encodePath(key), config.baseUrl).toString();
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(config), 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (![200, 201, 204].includes(res.status)) {
      throw new Error(`WebDAV 上传失败 ${res.status}：${(await safeText(res)) || '检查目录权限'}`);
    }

    const publicBase = (config.publicBase || '').replace(/\/+$/, '');
    return {
      url: publicBase ? `${publicBase}/${encodePath(key)}` : url,
      path: key,
      size: blob.size,
      privateLink: !publicBase,
    };
  },
};

function authHeaders(config) {
  return { Authorization: `Basic ${textToBase64(`${config.username}:${config.password}`)}` };
}

async function ensureCollections(config, prefix) {
  const segments = prefix.split('/').filter(Boolean);
  const headers = authHeaders(config);
  let cursor = '';
  for (const seg of segments) {
    cursor = cursor ? `${cursor}/${seg}` : seg;
    const url = new URL(encodePath(`${cursor}/`), config.baseUrl).toString();
    const res = await fetch(url, { method: 'MKCOL', headers });
    // 201 新建成功；405 已存在；301/302 部分服务重定向；其余状态忽略，交给 PUT 报错
    if (![201, 405, 301, 302, 200].includes(res.status)) {
      if (res.status === 401) throw new Error('WebDAV 认证失败');
    }
  }
}

function dateDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/`;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch (_) {
    return '';
  }
}
