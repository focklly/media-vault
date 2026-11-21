/**
 * 适配器：GitHub 仓库（当图床 / 小体积视频仓）
 *
 * 原理：调用 GitHub Contents API PUT /repos/{owner}/{repo}/contents/{path}
 * 优点：零成本、自带 CDN（raw.githubusercontent.com）、有版本历史
 * 限制：单文件建议 ≤ 40MB（Contents API 限制，超过易失败）；私有仓库的外链需要
 *      Token 才能访问，因此分享场景请用公开仓库或配置 publicBase（如 jsDelivr）。
 */

import { blobToBase64, encodePath, joinPath, normalizePrefix, uniqueFileName } from '../../shared/utils.js';
import { LIMITS, MB } from '../../shared/constants.js';

const API = 'https://api.github.com';

export default {
  id: 'github',
  label: 'GitHub 仓库',
  badge: '免费',
  supports: ['image', 'video'],
  maxBytes: LIMITS.githubMaxBytes,
  summary: '把文件提交到自己的 GitHub 仓库，借助 raw 链接当图床；零成本，适合图片与短视频。',
  docs: 'docs/ADAPTERS.md#github-仓库图床',
  fields: [
    { key: 'token', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_xxx 或 github_pat_xxx', required: true, help: 'Fine-grained token，勾选 Contents: Read and write（经典 token 勾 repo）。' },
    { key: 'owner', label: '仓库所有者', type: 'text', placeholder: 'focklly', required: true, help: '用户名或组织名。' },
    { key: 'repo', label: '仓库名', type: 'text', placeholder: 'media-vault-assets', required: true, help: '建议单独建一个素材仓库，不要和代码仓库混用。' },
    { key: 'branch', label: '分支', type: 'text', placeholder: 'main', required: false, help: '留空默认 main。' },
    { key: 'pathPrefix', label: '存储目录', type: 'text', placeholder: 'media/', required: false, help: '仓库内前缀，自动按 年/月 分子目录。' },
    { key: 'publicBase', label: '自定义访问前缀', type: 'text', placeholder: 'https://cdn.jsdelivr.net/gh/owner/repo@main/', required: false, help: '留空则用 raw.githubusercontent.com 链接。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.token && config.owner && config.repo);
  },

  async test(config) {
    const res = await fetch(`${API}/repos/${config.owner}/${config.repo}`, {
      headers: authHeaders(config.token),
    });
    if (res.status === 401) return { ok: false, message: 'Token 无效或已过期' };
    if (res.status === 404) return { ok: false, message: '仓库不存在，或 Token 没有该仓库权限' };
    if (!res.ok) return { ok: false, message: `GitHub 返回 ${res.status}` };
    const data = await res.json();
    const canWrite = Boolean(data.permissions && data.permissions.push);
    return {
      ok: true,
      message: canWrite
        ? `连接正常：${data.full_name}（${data.private ? '私有' : '公开'}，可写）`
        : `连接正常：${data.full_name}，但当前 Token 可能没有写入权限`,
    };
  },

  async upload({ blob, fileName, config }) {
    const branch = config.branch || 'main';
    const prefix = normalizePrefix(config.pathPrefix || 'media/');
    const path = joinPath(prefix, dateDir(), uniqueFileName(fileName));
    const body = {
      message: `chore(media): add ${fileName}`,
      content: await blobToBase64(blob),
      branch,
    };

    let res = await putContent(config, path, body);
    if (res.status === 422 || res.status === 409) {
      // 分支不存在 / 文件已存在（极少数撞名）：换名重试一次
      const retryPath = joinPath(prefix, dateDir(), uniqueFileName(fileName, 'retry'));
      res = await putContent(config, retryPath, { ...body, content: body.content });
      if (!res.ok) throw new Error(await describe(res));
      return buildResult(config, retryPath, branch, blob.size);
    }
    if (!res.ok) throw new Error(await describe(res));
    return buildResult(config, path, branch, blob.size);
  },
};

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function putContent(config, path, body) {
  return fetch(`${API}/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: { ...authHeaders(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dateDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/`;
}

function buildResult(config, path, branch, size) {
  const base = config.publicBase
    ? config.publicBase.replace(/\/+$/, '') + '/'
    : `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${branch}/`;
  return {
    url: base + encodePath(path),
    path,
    size,
    /** 私有仓库的链接需要 Token，标记出来，UI 会提示“外链不可公开访问” */
    privateLink: false,
  };
}

async function describe(res) {
  let detail = '';
  try {
    const json = await res.json();
    detail = json.message || '';
    if (json.errors) detail += ` ${JSON.stringify(json.errors)}`;
  } catch (_) { /* 响应不是 JSON */ }
  if (res.status === 403) {
    return `GitHub 403：Token 权限不足或触发限流。${detail}`;
  }
  if (res.status === 413) {
    return `文件过大（约 ${(LIMITS.githubMaxBytes / MB).toFixed(0)}MB 上限），建议改用 S3/WebDAV 存视频。`;
  }
  return `GitHub 上传失败 ${res.status}${detail ? `：${detail}` : ''}`;
}
