/**
 * 页面主世界探针（MAIN world，document_start）
 *
 * 抖音 / B 站这类站点用 MSE 播放，页面里只有 blob: 地址，DOM 里拿不到真链接。
 * 这个脚本在页面自己的 JS 环境里跑，只做一件事：把 fetch / XHR / createObjectURL
 * 收到的媒体地址记下来，等扩展的隔离世界来问（window.postMessage 单次问答）。
 *
 * 只记录，不改请求、不注入 UI、不读业务数据。
 */
(() => {
  const MAX = 40;
  const list = [];
  const isMediaUrl = (url) => {
    if (typeof url !== 'string' || url.length < 12) return false;
    if (!/^https?:\/\//.test(url)) return false;
    if (!/\.(mp4|m4s|webm|mov|flv)(\?|$)/i.test(url) && !/mime_type=video/i.test(url)) return false;
    // 排除纯音频轨
    if (/mime_type=audio|media_type=audio/i.test(url)) return false;
    return true;
  };
  const remember = (url) => {
    if (!isMediaUrl(url)) return;
    if (list.includes(url)) return;
    list.push(url);
    if (list.length > MAX) list.shift();
    // 隔离世界读不到 window 变量，改用 DOM 属性做单向桥（DOM 是两个世界共享的）
    try {
      document.documentElement.setAttribute('data-mv-media', JSON.stringify(list.slice(-8)));
    } catch (_) { /* 忽略 */ }
  };

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function patchedFetch(input, init) {
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          remember(url);
        } catch (_) { /* 忽略 */ }
        return origFetch.call(this, input, init);
      };
    }
  } catch (_) { /* 页面可能冻结了 fetch */ }

  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && XHR.prototype.open) {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function patchedOpen(method, url) {
        try { remember(url); } catch (_) { /* 忽略 */ }
        return origOpen.apply(this, arguments);
      };
    }
  } catch (_) { /* 忽略 */ }

  try {
    const origCreate = URL.createObjectURL;
    if (typeof origCreate === 'function') {
      URL.createObjectURL = function patchedCreate(obj) {
        const url = origCreate.call(this, obj);
        try {
          if (obj && (obj.type || '').startsWith('video/')) remember(`__blob:${obj.type}:${obj.size}:${url}`);
        } catch (_) { /* 忽略 */ }
        return url;
      };
    }
  } catch (_) { /* 忽略 */ }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.__mvMediaProbe !== true) return;
    try {
      window.postMessage({ __mvMediaList: list.slice() }, '*');
    } catch (_) { /* 忽略 */ }
  });
})();
