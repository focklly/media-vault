/**
 * 适配器：Unlockify 视频直链（免费、免注册）
 *
 * 接口（已实机验证）：
 *   1) POST https://stream.unlockify.ink/backend/api/web-upload
 *      multipart/form-data，字段名 file（仅视频，非视频返回 400
 *      {"detail":"Only video files can be uploaded."}）
 *      → 200 {"ok":true,"job_id":"<uuid>","status":"uploaded"}
 *   2) GET  https://stream.unlockify.ink/backend/api/web-upload/<job_id>
 *      → {"ok":true,"job":{"status":"processing|ready|failed","video_url":"/video/<public_id>"}}
 *      status=ready 时 video_url 是相对路径，拼上站点根即可播放。
 *
 * 限制：单文件 ≤1.9GB；站点把文件转存到自己的 Telegram 频道再出播放页/直链，
 * 处理需要几秒到几十秒，所以这里带轮询。免注册、无每日配额（浏览器端有计数提示）。
 */

import { MB } from '../../shared/constants.js';

const BASE = 'https://stream.unlockify.ink';
const API = `${BASE}/backend/api/web-upload`;
const HEALTH = `${BASE}/backend/health/live`;
const MAX_BYTES = Math.round(1.9 * 1024 * MB);
/** 等待转码就绪的上限，避免 service worker 长时间挂起 */
const POLL_TIMEOUT_MS = 75 * 1000;
const POLL_INTERVAL_MS = 2500;

export default {
  id: 'unlockify',
  label: 'Unlockify 视频',
  badge: '免费视频·免注册',
  supports: ['video'],
  maxBytes: MAX_BYTES,
  summary: '把视频变成公开播放页 + 直链，免注册，单文件 ≤1.9GB；上传后需等站点转存几秒。',
  docs: 'docs/ADAPTERS.md#unlockify',
  fields: [
    { key: 'openPage', label: '同时返回播放页链接', type: 'boolean', required: false, help: '开启后，图库里的视频链接会是 https://stream.unlockify.ink/video/xxx 网页，而不是直链。' },
  ],

  // 免注册站点：没有必填凭证
  isConfigured() {
    return true;
  },

  async test() {
    try {
      const res = await fetch(HEALTH);
      if (!res.ok) return { ok: false, message: `Unlockify 后端返回 ${res.status}，稍后再试` };
      return { ok: true, message: '视频上传接口可达，可直接上传视频' };
    } catch (_) {
      return { ok: false, message: '无法连接 stream.unlockify.ink，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, kind, config }) {
    if (kind && kind !== 'video') throw new Error('Unlockify 只接收视频文件');

    const form = new FormData();
    form.append('file', blob, fileName);

    const res = await fetchRetry(API, { method: 'POST', body: form });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Unlockify 上传失败 ${res.status}：${describe(text) || '接口拒绝本次上传'}`);
    }

    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`Unlockify 未返回 JSON：${text.slice(0, 160)}`);
    }
    const jobId = json?.job_id || json?.job?.job_id;
    if (!jobId) throw new Error(`Unlockify 没有返回 job_id：${text.slice(0, 160)}`);

    const job = await waitForJob(jobId);
    if (!job.video_url) throw new Error(`视频处理完成但没有拿到链接：${JSON.stringify(job).slice(0, 160)}`);

    const pageUrl = absolute(job.video_url);
    const downloadUrl = job.download_url ? absolute(job.download_url) : '';
    // 默认给直链（图库缩略图/下载更直接），勾选 openPage 时给播放页
    const usePage = config?.openPage === true;
    const url = usePage ? pageUrl : (downloadUrl || pageUrl);
    return { url, path: job.public_id || jobId, size: blob.size || 0, privateLink: false };
  },
};

/** 轮询 job 直到 ready / failed / 超时 */
async function waitForJob(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetchRetry(`${API}/${encodeURIComponent(jobId)}`);
    if (res.ok) {
      const json = await res.json().catch(() => null);
      last = json?.job || null;
      if (last?.status === 'ready') return last;
      if (last?.status === 'failed') throw new Error(`Unlockify 处理失败：${last.error || '站点未给出原因'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const tail = last ? `（最后一次状态：${last.status}）` : '';
  throw new Error(`视频已上传，但等待转存超时${tail}；请稍后到 stream.unlockify.ink 查看，或改用 S3 / Pixeldrain`);
}

/**
 * 该站点的 TLS 连接偶尔会超时（实测每秒级抖动），上传与轮询都做一次重试：
 * 仅在「连不上」时重试，HTTP 4xx/5xx 直接返回，避免重复创建转码任务。
 */
async function fetchRetry(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return fetch(url, options);
  }
}

function isNetworkError(err) {
  const msg = String((err && err.message) || err);
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|timeout/i.test(msg);
}

function absolute(path) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  return `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

function describe(text) {
  try {
    const json = JSON.parse(text);
    return json?.detail || json?.message || '';
  } catch (_) {
    return (text || '').slice(0, 160);
  }
}
