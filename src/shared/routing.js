/**
 * 存储路由（纯函数，无 chrome 依赖，SW / content / popup / library 共用）
 *
 * 解析顺序（resolveTargetAdapter）：
 *   1. autoUpload.byKind[类型]：该类型单独指定的站点；
 *   2. autoUpload.adapterId：全局兜底站点；
 *   3. 第一个已启用且 supports 该类型的适配器。
 * 任一层命中的站点若不支持当前类型，继续向下兜底，而不是直接报错。
 */

/**
 * @param {object} settings getSettings() 的完整结果
 * @param {'image'|'video'} kind 媒体类型
 * @param {Array<{id:string,label:string,supports:string[],enabled:boolean}>} adapters
 *        适配器描述列表（含启用态），由调用方从 ADAPTERS / 后台元数据组装
 * @returns {{id:string,label:string,supports:string[]}|null} 命中的适配器；无可用站点返回 null
 */
export function resolveTargetAdapter(settings, kind, adapters) {
  const auto = settings?.autoUpload || {};
  const enabled = (adapters || []).filter((a) => a.enabled);
  const supports = (a) => (a.supports || []).includes(kind);

  const byKind = auto.byKind?.[kind];
  if (byKind && byKind !== 'none') {
    const hit = enabled.find((a) => a.id === byKind);
    if (hit && supports(hit)) return hit;
  }

  const global = auto.adapterId;
  if (global && global !== 'none') {
    const hit = enabled.find((a) => a.id === global);
    if (hit && supports(hit)) return hit;
  }

  return enabled.find(supports) || null;
}

/** 取适配器展示名；找不到时回退 id（调用方需自行处理空值场景） */
export function adapterLabel(adapters, adapterId) {
  const hit = (adapters || []).find((a) => a.id === adapterId);
  return hit?.label || adapterId || '';
}

/** 某适配器是否支持该类型；不支持时 UI 据此禁用选项并写明原因 */
export function adapterSupports(adapter, kind) {
  return (adapter?.supports || []).includes(kind);
}

/** 不支持该类型时的中文原因文案 */
export function unsupportedReason(kind) {
  return kind === 'video' ? '不支持视频' : '不支持图片';
}
