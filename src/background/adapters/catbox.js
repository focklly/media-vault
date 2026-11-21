/**
 * 适配器：Catbox（免费·免注册）
 *
 * 原理：multipart POST 到 https://catbox.moe/user/api.php，返回纯文本直链。
 * 限制：单文件 ≤200MB，永久保留；匿名上传的文件不归任何账号管理，
 *      无法在站点后台查看、删除或整理，填入 userhash 后才会挂到对应账号下。
 */

import { MB } from '../../shared/constants.js';
import { formatBytes } from '../../shared/utils.js';

const API = 'https://catbox.moe/user/api.php';
const MAX_BYTES = 200 * MB;

export default {
  id: 'catbox',
  label: 'Catbox',
  badge: '免费·免注册',
  supports: ['image', 'video'],
  maxBytes: MAX_BYTES,
  summary: '免注册永久图床，图片/视频都能传；匿名文件不归属账号，无法在站点后台管理。',
  docs: 'docs/ADAPTERS.md#catbox',
  fields: [
    { key: 'userhash', label: '用户哈希（可选）', type: 'text', placeholder: 'Catbox 账号的 userhash', required: false, help: '留空即为匿名上传；填入后文件挂到你的账号下，可在后台管理。' },
  ],

  // 免注册站点：没有必填凭证，配置永远视为完整
  isConfigured() {
    return true;
  },

  async test() {
    try {
      const res = await fetch('https://catbox.moe', { method: 'HEAD' });
      if (res.status >= 500) return { ok: false, message: `Catbox 服务返回 ${res.status}，稍后再试` };
      return { ok: true, message: '免注册站点，连通正常；文件将匿名上传（未填用户哈希时）' };
    } catch (_) {
      return { ok: false, message: '无法连接 Catbox，检查网络后重试' };
    }
  },

  async upload({ blob, fileName, config }) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', blob, fileName);
    if (config?.userhash) form.append('userhash', String(config.userhash).trim());

    const res = await fetch(API, { method: 'POST', body: form });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`Catbox 上传失败 ${res.status}：${text.slice(0, 160)}`);
    if (!/^https:\/\//.test(text)) {
      throw new Error(`Catbox 未返回有效链接：${text.slice(0, 160) || `文件可能超过 ${formatBytes(MAX_BYTES)} 上限`}`);
    }
    return { url: text, path: '', size: blob.size, privateLink: false };
  },
};
