/**
 * 适配器：0x0.st（实验性，默认关闭）
 *
 * 实测结论（2026-11）：从扩展 / 脚本发请求时，
 *   - 伪装浏览器 UA → 418（站点明确拒绝浏览器 UA）
 *   - 其它 UA（扩展标识、curl）→ 500
 * 也就是说：浏览器不允许脚本改写 User-Agent（forbidden header），而站点又拒绝
 * 浏览器 UA，所以这个站点在浏览器扩展里无法稳定使用。保留适配器只是给「有代理
 * 或自建转发」的用户留个入口，默认关闭，并用 imgdb.io / Catbox 替代。
 */

import { APP, MB } from '../../shared/constants.js';

const API = 'https://0x0.st';
const MAX_BYTES = 512 * MB;

export default {
  id: 'zeroxzero',
  label: '0x0.st',
  badge: '实验性·默认关闭',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '临时托管（30–365 天）。站点拒绝浏览器 UA，扩展内实测 500/418，建议改用 imgdb.io 或 Catbox。',
  docs: 'docs/ADAPTERS.md#zeroxzero',
  fields: [
    { key: 'expires', label: '保留期小时（可选，默认按体积）', type: 'number', placeholder: '例如 720', required: false, help: '留空由站点按文件体积决定；该站点在扩展内通常不可用。' },
  ],

  // 免注册站点：没有必填凭证
  isConfigured() {
    return true;
  },

  async test() {
    try {
      const res = await fetch(API, { headers: { 'User-Agent': userAgent() } });
      if (res.status === 418) {
        return { ok: false, message: '0x0.st 拒绝浏览器 UA（418）：扩展无法改写 UA，此站点在扩展内不可用，请改用 imgdb.io' };
      }
      if (res.status >= 500) {
        return { ok: false, message: `0x0.st 返回 ${res.status}（站点对脚本请求的限制），扩展内不可用，请改用 imgdb.io` };
      }
      return { ok: true, message: '站点可达（能否上传仍取决于 UA 策略，建议先传一张小图验证）' };
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
      if (res.status === 418) {
        throw new Error('0x0.st 拒绝浏览器 UA（418），扩展内不可用；请改用 imgdb.io / Catbox / Pixeldrain');
      }
      throw new Error(`0x0.st 上传失败 ${res.status}：${text.slice(0, 120) || '站点限制'}；建议改用 imgdb.io`);
    }
    if (!/^https:\/\//.test(text)) {
      throw new Error(`0x0.st 未返回有效链接：${text.slice(0, 160) || '站点未接受本次上传'}；建议改用 imgdb.io`);
    }
    return { url: text, path: '', size: blob.size, privateLink: false };
  },
};

/** 站点要求可识别 UA；这里固定为扩展标识，不伪装成浏览器 */
function userAgent() {
  return `${APP.nameEn}/${APP.version}`;
}
