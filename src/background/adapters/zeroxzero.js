/**
 * 适配器：0x0.st（免费·临时）
 *
 * 原理：multipart POST 到 https://0x0.st，返回纯文本直链。
 * 限制：单文件 ≤512MB；保留期随文件体积约 30–365 天，属于临时托管，不适合长期归档。
 * 注意：该站会校验 User-Agent，必须带可识别的扩展标识；伪装成浏览器 UA 会被拒绝。
 * 浏览器并不保证放行脚本设置的 User-Agent（部分版本会静默忽略），因此这里是「尽力
 * 而为 + 明确提示」：被 UA 策略拒绝时给出可诊断报错，引导换 Catbox / Pixeldrain，
 * 不引入 declarativeNetRequest 做 UA 改写。
 */

import { APP, MB } from '../../shared/constants.js';

const API = 'https://0x0.st';
const MAX_BYTES = 512 * MB;

export default {
  id: 'zeroxzero',
  label: '0x0.st',
  badge: '免费·临时',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '临时文件托管，上传快、无需注册；保留期随体积约 30–365 天，重要文件请另存长期站点。',
  docs: 'docs/ADAPTERS.md#zeroxzero',
  fields: [
    { key: 'expires', label: '保留期小时（可选，默认按体积）', type: 'number', placeholder: '例如 720', required: false, help: '部分套餐支持指定保留时长；留空由站点按文件体积决定。' },
  ],

  // 免注册站点：没有必填凭证
  isConfigured() {
    return true;
  },

  async test() {
    try {
      const res = await fetch(API, { headers: { 'User-Agent': userAgent() } });
      if (res.status >= 500) return { ok: false, message: `0x0.st 服务返回 ${res.status}，稍后再试` };
      return { ok: true, message: '站点可达；上传将使用扩展自带 UA，不要伪装浏览器' };
    } catch (_) {
      return { ok: false, message: '无法连接 0x0.st，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const form = new FormData();
    form.append('file', blob, fileName);
    const hours = Number(config?.expires);
    if (Number.isFinite(hours) && hours > 0) form.append('expires', String(Math.floor(hours)));

    const res = await fetch(API, {
      method: 'POST',
      headers: { 'User-Agent': userAgent() },
      body: form,
    });
    const text = (await res.text()).trim();
    if (!res.ok) {
      if (res.status === 403 && looksLikeUaBlock(text)) {
        throw new Error('0x0.st 拒绝了当前 UA：浏览器可能未放行自定义 User-Agent，请改用 Catbox / Pixeldrain');
      }
      throw new Error(`0x0.st 上传失败 ${res.status}：${text.slice(0, 160)}`);
    }
    if (!/^https:\/\//.test(text)) {
      throw new Error(`0x0.st 未返回有效链接：${text.slice(0, 160) || '站点未接受本次上传'}；若属于 UA 被拒或站点拦截，请改用 Catbox / Pixeldrain`);
    }
    return { url: text, path: '', size: blob.size, privateLink: false };
  },
};

/** 站点要求可识别 UA；这里固定为扩展标识，不伪装成浏览器 */
function userAgent() {
  return `${APP.nameEn}/${APP.version}`;
}

/** 响应文本是否像 UA 被拒（403 诊断用） */
function looksLikeUaBlock(text) {
  return /user agent|not allowed|blocked|forbidden|denied/i.test(text || '');
}
