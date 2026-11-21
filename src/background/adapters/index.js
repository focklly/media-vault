/**
 * 适配器注册表
 *
 * 二次开发新增存储只需两步：
 * 1. 新建 src/background/adapters/xxx.js，按本目录已有文件的结构 export default 一个对象；
 * 2. 在下面的数组里 import + push 一行。
 * 设置页会根据 fields 自动渲染表单，不需要改 UI 代码。
 * 完整模板见 docs/DEVELOPER_GUIDE.md「新增一个存储适配器」。
 */

import github from './github.js';
import s3 from './s3.js';
import webdav from './webdav.js';
import httpAdapter from './http.js';
import catbox from './catbox.js';
import pixeldrain from './pixeldrain.js';
import zeroxzero from './zeroxzero.js';
import imgbb from './imgbb.js';
import imgur from './imgur.js';

export const ADAPTERS = [github, s3, webdav, httpAdapter, catbox, pixeldrain, zeroxzero, imgbb, imgur];

/** 供设置页渲染：剥离函数，只传可序列化的元数据 */
export function adapterMetaList() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    badge: a.badge,
    summary: a.summary,
    docs: a.docs,
    supports: a.supports,
    maxBytes: a.maxBytes === Infinity ? null : a.maxBytes,
    fields: a.fields,
  }));
}

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * 统一上传入口：校验配置、体积上限，产出一致的结果结构
 * @returns {Promise<{url:string, path:string, size:number, privateLink:boolean, adapterId:string}>}
 */
export async function uploadTo(adapterId, ctx) {
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error(`未知的存储适配器：${adapterId}`);
  if (!adapter.isConfigured(ctx.config || {})) throw new Error(`「${adapter.label}」还没配置完整`);
  if (adapter.maxBytes !== Infinity && ctx.blob.size > adapter.maxBytes) {
    throw new Error(`文件超过「${adapter.label}」单文件上限，请改用 S3 / WebDAV 存大视频`);
  }
  const result = await adapter.upload(ctx);
  return { ...result, adapterId: adapter.id };
}

/** 连接测试入口 */
export async function testAdapter(adapterId, config) {
  const adapter = getAdapter(adapterId);
  if (!adapter) return { ok: false, message: `未知的存储适配器：${adapterId}` };
  if (!adapter.isConfigured(config || {})) return { ok: false, message: '配置不完整，请先填写必填项' };
  try {
    return await adapter.test(config);
  } catch (err) {
    return { ok: false, message: `测试失败：${err.message || err}` };
  }
}
