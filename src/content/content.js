/* ============================================================================
 * 影图管家 · 内容脚本（单文件、无 import）
 *
 * 为什么不用 ES Module？
 * Chrome MV3 的 content_scripts 不支持 type:"module"，也无法直接 import 扩展内的
 * ES 模块。为了保持「免构建、改完刷新即生效」的开发体验，本文件写成自包含 IIFE，
 * 只通过 chrome.runtime 与后台通信。共享逻辑（如 runTask）在此有一份精简实现，
 * 修改协议时请同步 src/shared/messaging.js 与 docs/ARCHITECTURE.md。
 *
 * 结构：
 *  1. 常量与工具
 *  2. 样式（Shadow DOM 隔离）
 *  3. 扫描器（图片/视频/背景图/懒加载/meta）
 *  4. 悬停按钮
 *  5. 悬浮球 + 菜单 + 清单面板
 *  6. 导入任务与提示
 *  7. 初始化与消息处理
 * ========================================================================== */
(function () {
  'use strict';

  // 每个 frame 只跑一次；只在顶层文档运行（iframe 里的播放器交给页面自身处理）
  if (window.top !== window) return;
  if (window.__MV_CONTENT_LOADED__) return;
  window.__MV_CONTENT_LOADED__ = true;

  /* ------------------------------ 1. 常量与工具 ------------------------------ */

  const KIND = { IMAGE: 'image', VIDEO: 'video' };
  const MSG = {
    SCAN_RESULT: 'MV_SCAN_RESULT',
    GET_TAB_STATS: 'MV_GET_TAB_STATS',
    SCAN_NOW: 'MV_SCAN_NOW',
    IMPORT_BATCH: 'MV_IMPORT_BATCH',
    OPEN_LIBRARY: 'MV_OPEN_LIBRARY',
    OPEN_SETTINGS: 'MV_OPEN_SETTINGS',
    RELOAD_SETTINGS: 'MV_RELOAD_SETTINGS',
  };
  const TASK = { IMPORT: 'import' };
  const PORT_NAME = 'mv-task';
  const PORT_MSG = { REQUEST: 'request', PROGRESS: 'progress', DONE: 'done', ERROR: 'error' };
  const STORAGE_SETTINGS_KEY = 'mv.settings';
  const MAX_BLOB_BYTES = 64 * 1024 * 1024;
  const MAX_INLINE_DATAURL = 8 * 1024 * 1024;
  const Z = 2147483647;

  const DEFAULTS = {
    enabled: true,
    ball: { enabled: true, x: 24, y: 96, opacity: 0.92 },
    hover: { enabled: true, minPx: 120, videos: true, offsetX: 14, offsetY: 14 },
    scan: { minPx: 80, maxItems: 600, includeBackground: true, includeMeta: true, includeLazy: true, includeLinks: true },
    autoUpload: { enabled: false, adapterId: 'none' },
  };

  const state = {
    settings: DEFAULTS,
    inventory: [],
    scanning: false,
    scanTimer: null,
    scrollTimer: null,
    scrollScans: 0,
    hover: null,
    hoverHideTimer: null,
    shadow: null,
    els: {},
    busy: false,
    lastScanAt: 0,
  };

  function mergeSettings(raw) {
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    for (const key of Object.keys(DEFAULTS)) {
      const v = raw[key];
      if (v === undefined || v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v) && typeof s[key] === 'object') {
        Object.assign(s[key], v);
      } else {
        s[key] = v;
      }
    }
    if (raw.excludedSites) s.excludedSites = raw.excludedSites;
    return s;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_SETTINGS_KEY, (res) => {
          state.settings = mergeSettings(res && res[STORAGE_SETTINGS_KEY]);
          resolve(state.settings);
        });
      } catch (_) {
        resolve(state.settings);
      }
    });
  }

  function isExcluded() {
    const list = state.settings.excludedSites || [];
    const host = location.hostname;
    return list.some((s) => s && (host === s || host.endsWith('.' + s)));
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: true });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /** 端口长任务（与 src/shared/messaging.js 的 runTask 等价） */
  function runTask(type, payload, onProgress) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: PORT_NAME });
      } catch (err) {
        reject(new Error('后台连接失败，可能扩展已更新，请刷新页面'));
        return;
      }
      let settled = false;
      const heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'ping' }); } catch (_) { /* noop */ }
      }, 20000);
      const timer = setTimeout(() => finish(new Error('任务超时')), 15 * 60 * 1000);

      function finish(err, result) {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(timer);
        try { port.disconnect(); } catch (_) { /* noop */ }
        err ? reject(err) : resolve(result);
      }

      port.onMessage.addListener((msg) => {
        if (!msg || !msg.kind) return;
        if (msg.kind === PORT_MSG.PROGRESS && onProgress) onProgress(msg.payload || {});
        else if (msg.kind === PORT_MSG.DONE) finish(null, msg.payload);
        else if (msg.kind === PORT_MSG.ERROR) finish(new Error((msg.payload || {}).message || '导入失败'));
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(new Error('后台连接中断'));
      });
      port.postMessage({ kind: PORT_MSG.REQUEST, type, payload });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  function formatCount(n) {
    return n > 99 ? '99+' : String(n);
  }

  /* ------------------------------ 2. 样式与骨架 ------------------------------ */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.mv-layer { position: fixed; inset: 0; pointer-events: none; z-index: ${Z};
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #e8eefc; -webkit-font-smoothing: antialiased; }

.mv-ball { position: fixed; width: 48px; height: 48px; border-radius: 50%; pointer-events: auto;
  background: radial-gradient(120% 120% at 30% 20%, #8b9dff 0%, #6366f1 45%, #3f3fd6 100%);
  box-shadow: 0 8px 24px rgba(63,63,214,.36), inset 0 1px 0 rgba(255,255,255,.35);
  cursor: grab; display: flex; align-items: center; justify-content: center;
  transition: transform .18s cubic-bezier(.2,.8,.2,1), box-shadow .18s; user-select: none;
  touch-action: none; }
.mv-ball:hover { transform: scale(1.06); box-shadow: 0 10px 28px rgba(63,63,214,.44), inset 0 1px 0 rgba(255,255,255,.4); }
.mv-ball.mv-dragging { cursor: grabbing; transform: scale(1.02); }
.mv-ball svg { width: 24px; height: 24px; fill: #fff; filter: drop-shadow(0 1px 1px rgba(0,0,0,.18)); }
.mv-ball-count { position: absolute; top: -5px; right: -5px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 10px; background: #101a33; color: #fff; font-size: 10.5px; font-weight: 700;
  line-height: 19px; text-align: center; border: 2px solid rgba(255,255,255,.92); display: none; }
.mv-ball-count.show { display: block; }
.mv-ball-pulse { position: absolute; inset: -6px; border-radius: 50%; border: 2px solid rgba(99,102,241,.5);
  animation: mv-pulse 1.8s ease-out infinite; pointer-events: none; display: none; }
.mv-ball.mv-working .mv-ball-pulse { display: block; }
@keyframes mv-pulse { 0% { transform: scale(.9); opacity: .8; } 100% { transform: scale(1.5); opacity: 0; } }

.mv-menu { position: fixed; width: 236px; pointer-events: auto; padding: 8px;
  background: rgba(16,22,38,.94); backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid rgba(120,140,200,.28); border-radius: 14px;
  box-shadow: 0 18px 44px rgba(4,8,20,.44); animation: mv-pop .16s ease-out; }
@keyframes mv-pop { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }
.mv-menu-head { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 8px;
  color: #9fb0d0; font-size: 11.5px; border-bottom: 1px solid rgba(120,140,200,.16); margin-bottom: 6px; }
.mv-menu-head strong { color: #f2f6ff; font-size: 13px; font-weight: 600; }
.mv-menu-head .mv-menu-count { margin-left: auto; color: #8ea0c4; }
.mv-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 9px;
  border: 0; border-radius: 9px; background: transparent; color: #dfe8fb; font: inherit;
  text-align: left; cursor: pointer; transition: background .12s; }
.mv-menu-item:hover { background: rgba(99,102,241,.18); }
.mv-menu-item:disabled { opacity: .45; cursor: not-allowed; }
.mv-menu-item svg { width: 16px; height: 16px; fill: none; stroke: #93a6ff; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round; flex: none; }
.mv-menu-item .mv-mi-main { flex: 1; }
.mv-menu-item .mv-mi-sub { display: block; color: #8b9cbf; font-size: 11px; margin-top: 1px; }
.mv-menu-sep { height: 1px; margin: 6px 4px; background: rgba(120,140,200,.16); }

.mv-pill { position: fixed; pointer-events: auto; display: flex; align-items: center; gap: 7px;
  padding: 8px 13px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18);
  background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; font: inherit; font-weight: 600;
  box-shadow: 0 10px 26px rgba(49,46,129,.42); cursor: pointer; white-space: nowrap;
  animation: mv-pop .14s ease-out; z-index: 3; }
.mv-pill:hover { background: linear-gradient(135deg, #7c7ff5, #5b52ec); }
.mv-pill.mv-loading { opacity: .7; cursor: progress; }
.mv-pill svg { width: 15px; height: 15px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mv-pill-badge { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: rgba(255,255,255,.22); font-weight: 700; }

.mv-toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 8px); pointer-events: none;
  max-width: min(72vw, 520px); padding: 10px 16px; border-radius: 11px;
  background: rgba(11,16,30,.94); color: #f3f6ff; font-size: 12.5px; line-height: 1.45;
  border: 1px solid rgba(120,140,200,.26); box-shadow: 0 14px 34px rgba(3,7,18,.4);
  opacity: 0; transition: opacity .18s, transform .18s; }
.mv-toast.show { opacity: 1; transform: translate(-50%, 0); }
.mv-toast.err { border-color: rgba(248,113,113,.5); color: #ffd9d9; }

.mv-panel { position: fixed; width: 372px; max-height: min(76vh, 640px); pointer-events: auto;
  display: flex; flex-direction: column; background: rgba(14,20,36,.96);
  backdrop-filter: blur(16px) saturate(150%); border: 1px solid rgba(120,140,200,.26);
  border-radius: 16px; box-shadow: 0 24px 60px rgba(3,7,18,.5); overflow: hidden;
  animation: mv-pop .18s ease-out; }
.mv-panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid rgba(120,140,200,.16); }
.mv-panel-head b { font-size: 13px; font-weight: 600; }
.mv-panel-head span { color: #93a3c4; font-size: 11.5px; }
.mv-icon-btn { margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: 0;
  background: transparent; color: #93a3c4; cursor: pointer; font-size: 16px; line-height: 1; }
.mv-icon-btn:hover { background: rgba(120,140,200,.16); color: #fff; }
.mv-panel-body { overflow: auto; padding: 8px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.mv-cell { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden;
  background: #1b2437; border: 1px solid rgba(120,140,200,.18); cursor: pointer; }
.mv-cell img, .mv-cell video { width: 100%; height: 100%; object-fit: cover; display: block; background: #111827; }
.mv-cell .mv-cell-tag { position: absolute; top: 5px; left: 5px; padding: 2px 6px; border-radius: 6px;
  background: rgba(8,12,24,.78); color: #cbd8f0; font-size: 10px; font-weight: 600; }
.mv-cell .mv-cell-dim { position: absolute; bottom: 5px; left: 5px; padding: 2px 6px; border-radius: 6px;
  background: rgba(8,12,24,.72); color: #93a3c4; font-size: 10px; }
.mv-cell:hover { border-color: rgba(99,102,241,.7); }
.mv-cell.mv-cell-ok::after { content: "✓"; position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(16,185,129,.28); color: #fff; font-size: 26px; font-weight: 700; }
.mv-panel-foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(120,140,200,.16); }
.mv-btn { flex: 1; height: 32px; border-radius: 9px; border: 1px solid rgba(120,140,200,.28);
  background: rgba(120,140,200,.1); color: #dfe8fb; font: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer; }
.mv-btn:hover { background: rgba(120,140,200,.2); }
.mv-btn.mv-primary { border-color: transparent; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; }
.mv-panel-empty { padding: 30px 14px; text-align: center; color: #8b9cbf; font-size: 12px; line-height: 1.7; }
.mv-panel-note { padding: 0 14px 10px; color: #7f90b3; font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .mv-ball, .mv-pill, .mv-menu, .mv-panel { animation: none; transition: none; } }
`;

  const ICONS = {
    logo: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H17a3 3 0 0 1 3 3v9.5a2.5 2.5 0 0 1-2.5 2.5h-2.2l2 2.6a1 1 0 0 1-1.6 1.2l-2.6-3.4H8.3l-2.6 3.4a1 1 0 0 1-1.6-1.2l2-2.6H6.5A2.5 2.5 0 0 1 4 15.5V5.5Z"/><circle cx="9" cy="9.5" r="1.3" fill="#3f3fd6"/><path d="M7 14l2.8-3 2.2 2.4 2-2 3 3.6H7Z" fill="#3f3fd6"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
    scan: '<svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="2.6"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M4.2 7.5l1.7 1M18.1 15.5l1.7 1M4.2 16.5l1.7-1M18.1 8.5l1.7-1"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 21 12c-.6.9-1.4 1.8-2.3 2.6M6.2 6.6C4.4 8 3.2 9.8 3 12c1.6 2.9 4.9 5 9 5 1.2 0 2.3-.2 3.3-.7"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>',
  };

  function buildShell() {
    const host = document.createElement('div');
    host.id = 'mv-mediavault-host';
    host.style.cssText = `all:initial;position:fixed;inset:0;z-index:${Z};pointer-events:none;`;
    (document.body || document.documentElement).appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const layer = document.createElement('div');
    layer.className = 'mv-layer';
    shadow.append(style, layer);

    // 悬浮球
    const ball = document.createElement('div');
    ball.className = 'mv-ball';
    ball.title = '影图管家 · 单击打开菜单，可拖动';
    ball.innerHTML = `<div class="mv-ball-pulse"></div>${ICONS.logo}<span class="mv-ball-count"></span>`;
    layer.appendChild(ball);

    // 悬停按钮
    const pill = document.createElement('button');
    pill.className = 'mv-pill';
    pill.style.display = 'none';
    pill.innerHTML = `${ICONS.download}<span class="mv-pill-text">存入个人空间</span><span class="mv-pill-badge"></span>`;
    layer.appendChild(pill);

    // 菜单
    const menu = document.createElement('div');
    menu.className = 'mv-menu';
    menu.style.display = 'none';
    layer.appendChild(menu);

    // 清单面板
    const panel = document.createElement('div');
    panel.className = 'mv-panel';
    panel.style.display = 'none';
    layer.appendChild(panel);

    // 提示
    const toast = document.createElement('div');
    toast.className = 'mv-toast';
    layer.appendChild(toast);

    state.shadow = shadow;
    state.els = { host, layer, ball, pill, menu, panel, toast };
    applyBallPosition();
  }

  /* ------------------------------ 3. 扫描器 ------------------------------ */

  function pickLargestFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '';
    let bestScore = -1;
    for (const part of srcset.split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const desc = bits[1] || '1x';
      const score = desc.endsWith('w') ? parseFloat(desc) : parseFloat(desc) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = bits[0];
      }
    }
    return best;
  }

  function lazyAttr(img) {
    if (!state.settings.scan.includeLazy) return '';
    const attrs = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url', 'data-echo'];
    for (const a of attrs) {
      const v = img.getAttribute(a);
      if (v && !v.startsWith('data:image/gif') && !v.startsWith('data:image/svg')) return v;
    }
    const lazySet = img.getAttribute('data-srcset');
    if (lazySet) return pickLargestFromSrcset(lazySet);
    return '';
  }

  function absolute(url, base) {
    if (!url) return '';
    if (/^(data:|blob:|http:|https:)/.test(url)) return url;
    try {
      return new URL(url, base || location.href).href;
    } catch (_) {
      return '';
    }
  }

  function imgUrl(img) {
    const fromSet = pickLargestFromSrcset(img.getAttribute('srcset'));
    return img.currentSrc || absolute(fromSet || img.getAttribute('src'), location.href) || absolute(lazyAttr(img), location.href);
  }

  function videoSource(video) {
    const direct = video.currentSrc || video.src;
    if (direct) return direct;
    const source = video.querySelector('source');
    if (source) return absolute(source.src || pickLargestFromSrcset(source.getAttribute('srcset')), location.href);
    return '';
  }

  function isStreamUrl(url) {
    return /\.(m3u8|mpd)(\?|#|$)/i.test(url);
  }

  function cssBackgroundUrl(node) {
    try {
      const bg = getComputedStyle(node).backgroundImage;
      if (!bg || bg === 'none') return '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !m[1]) return '';
      if (m[1].startsWith('data:') && m[1].length > MAX_INLINE_DATAURL) return '';
      return absolute(m[1], location.href);
    } catch (_) {
      return '';
    }
  }

  function addCandidate(map, raw) {
    if (!raw || !raw.url) return;
    const url = absolute(raw.url, location.href);
    if (!url) return;
    if (url.startsWith('blob:')) return; // blob 无法跨上下文复用，交给悬停时的实时抓取
    if (url.startsWith('data:') && url.length > MAX_INLINE_DATAURL) return;
    if (map.has(url)) return;

    const minPx = Math.max(16, Number(state.settings.scan.minPx) || 80);
    const w = raw.width || 0;
    const h = raw.height || 0;
    if (w && h && Math.min(w, h) < minPx) return;

    map.set(url, {
      url,
      kind: raw.kind || KIND.IMAGE,
      width: w,
      height: h,
      alt: (raw.alt || '').slice(0, 120),
      source: raw.source || '',
      stream: Boolean(raw.stream || (raw.kind === KIND.VIDEO && isStreamUrl(url))),
      poster: raw.poster || '',
      duration: raw.duration || 0,
      fromMeta: Boolean(raw.fromMeta),
    });
  }

  async function scanPage(options = {}) {
    if (state.scanning) return state.inventory;
    state.scanning = true;
    const t0 = performance.now();
    const settings = state.settings.scan || DEFAULTS.scan;
    const map = new Map();

    try {
      // 图片
      document.querySelectorAll('img').forEach((img) => {
        addCandidate(map, {
          url: imgUrl(img),
          kind: KIND.IMAGE,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          alt: img.alt,
          source: 'img',
        });
      });

      // <picture> 里未渲染的 source
      document.querySelectorAll('picture source').forEach((src) => {
        addCandidate(map, {
          url: pickLargestFromSrcset(src.getAttribute('srcset')),
          kind: KIND.IMAGE,
          width: 0,
          height: 0,
          source: 'picture',
        });
      });

      // 视频
      document.querySelectorAll('video').forEach((v) => {
        const url = videoSource(v);
        addCandidate(map, {
          url,
          kind: KIND.VIDEO,
          width: v.videoWidth || v.clientWidth,
          height: v.videoHeight || v.clientHeight,
          duration: v.duration || 0,
          poster: v.poster ? absolute(v.poster, location.href) : '',
          source: 'video',
          stream: isStreamUrl(url),
        });
      });

      // 直链视频（很多站点用 <a> 指向 mp4）
      if (settings.includeLinks) {
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (/\.(mp4|webm|mov|m4v|mkv|m3u8|mpd|flv)(\?|#|$)/i.test(href)) {
            addCandidate(map, {
              url: absolute(href, location.href),
              kind: KIND.VIDEO,
              width: 0,
              height: 0,
              source: 'link',
              stream: isStreamUrl(href),
            });
          }
        });
      }

      // meta 里的分享图/视频
      if (settings.includeMeta) {
        const metas = document.querySelectorAll('meta[property], meta[name]');
        metas.forEach((m) => {
          const key = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
          const content = absolute(m.getAttribute('content') || '', location.href);
          if (!content) return;
          if (/^(og:image|og:image:url|twitter:image|twitter:image:src)$/.test(key)) {
            addCandidate(map, { url: content, kind: KIND.IMAGE, source: 'meta', fromMeta: true });
          } else if (/^(og:video|og:video:url|og:video:secure_url)$/.test(key)) {
            addCandidate(map, {
              url: content,
              kind: KIND.VIDEO,
              source: 'meta',
              fromMeta: true,
              stream: isStreamUrl(content),
            });
          }
        });
      }

      // 背景图：分批读取 computedStyle，避免一次性阻塞主线程
      if (settings.includeBackground) {
        const nodes = Array.from(document.querySelectorAll('*')).slice(0, 3000);
        const chunkSize = 180;
        for (let i = 0; i < nodes.length; i += chunkSize) {
          const chunk = nodes.slice(i, i + chunkSize);
          for (const node of chunk) {
            if (!(node instanceof HTMLElement)) continue;
            const url = cssBackgroundUrl(node);
            if (!url) continue;
            const rect = node.getBoundingClientRect();
            addCandidate(map, {
              url,
              kind: KIND.IMAGE,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              source: 'background',
            });
          }
          // 让出主线程，保证页面滚动不卡
          await new Promise((r) => setTimeout(r, 0));
          if (map.size > settings.maxItems) break;
        }
      }

      const list = Array.from(map.values())
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))
        .slice(0, Math.max(1, Number(settings.maxItems) || 600));

      state.inventory = list;
      state.lastScanAt = Date.now();
      updateQuickCounts();

      const images = list.filter((i) => i.kind === KIND.IMAGE).length;
      const videos = list.length - images;
      send(MSG.SCAN_RESULT, { images, videos, total: list.length });
      if (!options.silent) {
        toast(`扫描完成：图片 ${images} · 视频 ${videos}（用时 ${Math.round(performance.now() - t0)}ms）`);
      }
      return list;
    } finally {
      state.scanning = false;
    }
  }

  function scheduleScan(delay = 700) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      scanPage({ silent: true }).catch(() => {});
    }, delay);
  }

  /* ------------------------------ 4. 悬停按钮 ------------------------------ */

  function hoverCandidatesFromEvent(e) {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    if (target.closest('.mv-layer')) return null;

    const { minPx, videos } = state.settings.hover;

    if (target.tagName === 'VIDEO') {
      if (!videos) return null;
      const r = target.getBoundingClientRect();
      if (Math.min(r.width, r.height) < Math.min(minPx, 120)) return null;
      const url = videoSource(target);
      if (!url) return null;
      return {
        el: target,
        url,
        kind: KIND.VIDEO,
        width: target.videoWidth || Math.round(r.width),
        height: target.videoHeight || Math.round(r.height),
        duration: target.duration || 0,
        poster: target.poster ? absolute(target.poster, location.href) : '',
        stream: /blob:/.test(url) ? false : isStreamUrl(url),
        blobUrl: url.startsWith('blob:'),
      };
    }

    if (target.tagName === 'IMG') {
      const r = target.getBoundingClientRect();
      if (Math.min(r.width, r.height) < minPx) return null;
      const url = imgUrl(target);
      if (!url) return null;
      return {
        el: target,
        url,
        kind: KIND.IMAGE,
        width: target.naturalWidth || Math.round(r.width),
        height: target.naturalHeight || Math.round(r.height),
        alt: target.alt || '',
        blobUrl: url.startsWith('blob:'),
      };
    }

    // 背景图：向上找 3 层
    let node = target;
    for (let i = 0; i < 3 && node && node !== document.body; i += 1) {
      const url = cssBackgroundUrl(node);
      if (url) {
        const r = node.getBoundingClientRect();
        if (Math.min(r.width, r.height) >= minPx) {
          return {
            el: node,
            url,
            kind: KIND.IMAGE,
            width: Math.round(r.width),
            height: Math.round(r.height),
            alt: '',
            blobUrl: false,
            background: true,
          };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function onPointerOver(e) {
    if (!state.settings.enabled || !state.settings.hover.enabled) return;
    if (e.pointerType === 'touch') return;
    clearTimeout(state.hoverHideTimer);
    const media = hoverCandidatesFromEvent(e);
    if (!media) {
      hidePill(180);
      return;
    }
    state.hover = media;
    const { pill } = state.els;
    const text = pill.querySelector('.mv-pill-text');
    const badge = pill.querySelector('.mv-pill-badge');
    if (media.stream) {
      text.textContent = '保存播放地址';
      badge.textContent = '流';
    } else if (media.kind === KIND.VIDEO) {
      text.textContent = '存入个人空间';
      badge.textContent = '视频';
    } else {
      text.textContent = '存入个人空间';
      badge.textContent = '图片';
    }
    pill.style.display = 'flex';
    // 先显示再测量，避免 offsetWidth 为 0 导致靠右定位错位
    positionPill(e.clientX, e.clientY);
    pill.classList.remove('mv-loading');  }

  function positionPill(mx, my) {
    const { pill } = state.els;
    const { offsetX, offsetY } = state.settings.hover;
    const pad = 8;
    const w = pill.offsetWidth || 150;
    const h = pill.offsetHeight || 34;
    let left = mx + offsetX;
    let top = my + offsetY;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, mx - w - offsetX);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, my - h - offsetY);
    pill.style.left = `${Math.round(left)}px`;
    pill.style.top = `${Math.round(top)}px`;
  }

  function hidePill(delay = 0) {
    clearTimeout(state.hoverHideTimer);
    const doHide = () => {
      state.els.pill.style.display = 'none';
      state.hover = null;
    };
    if (delay) state.hoverHideTimer = setTimeout(doHide, delay);
    else doHide();
  }

  function bindHover() {
    const { pill } = state.els;
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', (e) => {
      if (!state.hover) return;
      if (e.relatedTarget && state.els.pill.contains(e.relatedTarget)) return;
      hidePill(220);
    }, true);
    pill.addEventListener('mouseenter', () => clearTimeout(state.hoverHideTimer));
    pill.addEventListener('mouseleave', () => hidePill(200));
    pill.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const media = state.hover;
      if (!media || state.busy) return;
      const forceUpload = ev.shiftKey;
      await saveOne(media, { forceUpload });
    });
    window.addEventListener('scroll', () => hidePill(0), { passive: true });
    window.addEventListener('resize', () => hidePill(0), { passive: true });
  }

  /* ------------------------------ 5. 悬浮球 / 菜单 / 清单 ------------------------------ */

  function applyBallPosition() {
    const { ball } = state.els;
    if (!ball) return;
    const { x, y } = state.settings.ball;
    const w = 48;
    const h = 48;
    const left = Math.max(6, window.innerWidth - w - Math.max(6, x));
    const top = Math.max(6, window.innerHeight - h - Math.max(6, y));
    ball.style.left = `${Math.round(left)}px`;
    ball.style.top = `${Math.round(top)}px`;
    ball.style.opacity = String(state.settings.ball.opacity || 0.92);
  }

  function persistBallPosition(left, top) {
    const x = Math.max(6, window.innerWidth - 48 - left);
    const y = Math.max(6, window.innerHeight - 48 - top);
    state.settings.ball.x = Math.round(x);
    state.settings.ball.y = Math.round(y);
    try {
      chrome.storage.local.get(STORAGE_SETTINGS_KEY, (res) => {
        const raw = res[STORAGE_SETTINGS_KEY] || {};
        raw.ball = { ...(raw.ball || {}), x: state.settings.ball.x, y: state.settings.ball.y };
        chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: raw });
      });
    } catch (_) { /* 忽略 */ }
  }

  function bindBall() {
    const { ball, menu } = state.els;
    let drag = null;

    ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = ball.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, startX: e.clientX, startY: e.clientY };
      ball.classList.add('mv-dragging');
      ball.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) drag.moved = true;
      const left = Math.min(Math.max(6, e.clientX - drag.dx), window.innerWidth - 48 - 6);
      const top = Math.min(Math.max(6, e.clientY - drag.dy), window.innerHeight - 48 - 6);
      ball.style.left = `${Math.round(left)}px`;
      ball.style.top = `${Math.round(top)}px`;
    });

    ball.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      ball.classList.remove('mv-dragging');
      try { ball.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      if (wasDrag) {
        const r = ball.getBoundingClientRect();
        persistBallPosition(r.left, r.top);
      } else {
        toggleMenu();
      }
    });

    // 菜单点击外部关闭
    document.addEventListener('pointerdown', (e) => {
      if (!menu.classList.contains('mv-open')) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(menu) || path.includes(ball)) return;
      closeMenu();
    }, true);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenu();
        hidePanel();
        hidePill();
      }
    }, true);
  }

  function buildMenu() {
    const { menu } = state.els;
    const counts = quickCounts();
    menu.innerHTML = `
      <div class="mv-menu-head">
        <strong>影图管家</strong>
        <span>本页</span>
        <span class="mv-menu-count">图 ${counts.images} · 视 ${counts.videos}</span>
      </div>
      <button class="mv-menu-item" data-act="scan">
        ${ICONS.scan}<span class="mv-mi-main">重新扫描本页<span class="mv-mi-sub">收集图片 / 视频 / 背景图 / 视频直链</span></span>
      </button>
      <button class="mv-menu-item" data-act="all">
        ${ICONS.download}<span class="mv-mi-main">全部存入个人空间<span class="mv-mi-sub">当前清单 ${counts.total} 个媒体</span></span>
      </button>
      <button class="mv-menu-item" data-act="panel">
        ${ICONS.grid}<span class="mv-mi-main">查看媒体清单<span class="mv-mi-sub">可单独存入手动挑选</span></span>
      </button>
      <div class="mv-menu-sep"></div>
      <button class="mv-menu-item" data-act="library">
        ${ICONS.grid}<span class="mv-mi-main">打开个人空间</span>
      </button>
      <button class="mv-menu-item" data-act="settings">
        ${ICONS.gear}<span class="mv-mi-main">设置上传目标与规则</span>
      </button>
      <button class="mv-menu-item" data-act="hide">
        ${ICONS.eyeoff}<span class="mv-mi-main">隐藏悬浮球<span class="mv-mi-sub">可在扩展图标里重新打开</span></span>
      </button>
    `;
  }

  /** 菜单事件只绑定一次（每次打开菜单只重建 HTML，不重复挂监听） */
  function bindMenu() {
    const { menu } = state.els;
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      closeMenu();
      if (act === 'scan') {
        state.inventory = [];
        await scanPage({ silent: false });
      } else if (act === 'all') {
        await importAll();
      } else if (act === 'panel') {
        openPanel();
      } else if (act === 'library') {
        send(MSG.OPEN_LIBRARY);
      } else if (act === 'settings') {
        send(MSG.OPEN_SETTINGS);
      } else if (act === 'hide') {
        await hideBallPermanently();
      }
    });
  }

  function toggleMenu() {
    const { menu } = state.els;
    if (menu.classList.contains('mv-open')) {
      closeMenu();
      return;
    }
    buildMenu();
    const { ball } = state.els;
    const r = ball.getBoundingClientRect();
    menu.style.display = 'block';
    menu.classList.add('mv-open');
    const mw = 236;
    const mh = menu.offsetHeight || 340;
    let left = r.left - mw - 10;
    if (left < 8) left = r.right + 10;
    left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
    let top = r.top + 48 + 8 - mh;
    top = Math.min(Math.max(8, r.top - mh - 8), window.innerHeight - mh - 8);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(8, top))}px`;
    // 扫描一次，保证计数新鲜
    if (!state.inventory.length) scheduleScan(50);
  }

  function closeMenu() {
    const { menu } = state.els;
    menu.classList.remove('mv-open');
    menu.style.display = 'none';
  }

  function quickCounts() {
    const images = state.inventory.filter((i) => i.kind === KIND.IMAGE).length;
    const videos = state.inventory.length - images;
    return { images, videos, total: state.inventory.length };
  }

  function updateQuickCounts() {
    const { ball } = state.els;
    const badge = ball.querySelector('.mv-ball-count');
    const counts = quickCounts();
    if (counts.total > 0) {
      badge.textContent = formatCount(counts.total);
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }

  function setWorking(on) {
    state.busy = on;
    state.els.ball.classList.toggle('mv-working', on);
  }

  function openPanel() {
    const { panel, ball } = state.els;
    if (!state.inventory.length) {
      toast('还没扫描到媒体，正在扫描…');
      scheduleScan(20);
    }
    renderPanel();
    panel.style.display = 'flex';
    const r = ball.getBoundingClientRect();
    const pw = 372;
    let left = r.left - pw - 10;
    if (left < 8) left = Math.min(window.innerWidth - pw - 8, r.right + 10);
    panel.style.left = `${Math.round(Math.max(8, left))}px`;
    panel.style.top = `${Math.round(Math.max(8, window.innerHeight - Math.min(window.innerHeight * 0.76, 640) - 24))}px`;
  }

  function hidePanel() {
    state.els.panel.style.display = 'none';
  }

  function renderPanel() {
    const { panel } = state.els;
    const counts = quickCounts();
    const shown = state.inventory.slice(0, 60);
    panel.innerHTML = `
      <div class="mv-panel-head">
        <b>本页媒体</b>
        <span>图片 ${counts.images} · 视频 ${counts.videos}</span>
        <button class="mv-icon-btn" data-act="close" title="关闭">×</button>
      </div>
      <div class="mv-panel-body" data-body></div>
      ${state.inventory.length > shown.length ? `<div class="mv-panel-note">仅展示前 ${shown.length} 个，共 ${state.inventory.length} 个；点「全部存入」可一次处理。</div>` : ''}
      <div class="mv-panel-foot">
        <button class="mv-btn" data-act="rescan">重新扫描</button>
        <button class="mv-btn mv-primary" data-act="all">全部存入 (${counts.total})</button>
      </div>
    `;
    const body = panel.querySelector('[data-body]');
    if (!shown.length) {
      body.innerHTML = `<div class="mv-panel-empty" style="grid-column:1/-1">没有发现可下载的媒体<br/>试试滚动页面触发懒加载后重新扫描</div>`;
    }
    shown.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = 'mv-cell';
      cell.title = item.url;
      if (item.kind === KIND.VIDEO) {
        const v = document.createElement('video');
        v.src = item.url;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'metadata';
        if (item.poster) v.poster = item.poster;
        v.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
        v.addEventListener('mouseleave', () => { v.pause(); });
        cell.appendChild(v);
        const tag = document.createElement('span');
        tag.className = 'mv-cell-tag';
        tag.textContent = item.stream ? '流媒体' : '视频';
        cell.appendChild(tag);
      } else {
        const img = document.createElement('img');
        img.src = item.url;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { img.style.opacity = 0.15; });
        cell.appendChild(img);
      }
      if (item.width && item.height) {
        const dim = document.createElement('span');
        dim.className = 'mv-cell-dim';
        dim.textContent = `${item.width}×${item.height}`;
        cell.appendChild(dim);
      }
      cell.addEventListener('click', async () => {
        if (state.busy) return;
        await saveOne(item, {});
        cell.classList.add('mv-cell-ok');
      });
      body.appendChild(cell);
    });

    panel.querySelector('[data-act="close"]').addEventListener('click', hidePanel);
    panel.querySelector('[data-act="rescan"]').addEventListener('click', async () => {
      state.inventory = [];
      await scanPage({ silent: false });
      renderPanel();
    });
    panel.querySelector('[data-act="all"]').addEventListener('click', async () => {
      await importAll();
      hidePanel();
    });
  }

  /* ------------------------------ 6. 导入 ------------------------------ */

  function toast(msg, isError = false, duration = 2200) {
    const { toast: el } = state.els;
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', isError);
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), duration);
  }

  function buildPayload(media, extra = {}) {
    return {
      url: media.url,
      kind: media.kind,
      pageUrl: location.href,
      pageTitle: document.title,
      width: media.width || 0,
      height: media.height || 0,
      alt: media.alt || '',
      duration: media.duration || 0,
      poster: media.poster || '',
      stream: Boolean(media.stream),
      source: media.source || 'hover',
      ...extra,
    };
  }

  /**
   * 抓取 blob: URL（页面内 MediaSource / createObjectURL 的视频）
   * 这类地址离开页面就失效，必须在页面上下文里转成 dataUrl 再交给后台。
   */
  async function materializeBlobUrl(media) {
    const res = await fetch(media.url);
    if (!res.ok) throw new Error(`读取页面内媒体失败 ${res.status}`);
    const blob = await res.blob();
    if (blob.size > MAX_BLOB_BYTES) throw new Error('页面内媒体过大，无法转存（超过 64MB）');
    return blobToDataUrl(blob);
  }

  async function saveOne(media, opts = {}) {
    if (!state.settings.enabled) return;
    const { pill } = state.els;
    setWorking(true);
    pill.classList.add('mv-loading');
    try {
      const payload = buildPayload(media);
      if (media.blobUrl) {
        payload.dataUrl = await materializeBlobUrl(media);
        payload.blobTransfer = true;
      }
      if (opts.forceUpload) payload.forceUpload = true;
      const result = await runTask(TASK.IMPORT, {
        items: [payload],
        openLibraryAfter: false,
      });
      const item = result.imported && result.imported[0];
      if (item) {
        if (item.remote && item.remote.url) {
          toast(`已存入并上传 · ${item.title}`);
        } else {
          toast(opts.forceUpload ? `已存入本地（上传未完成，请到个人空间查看）` : `已存入个人空间 · ${item.title}`);
        }
        bumpBallCount(1);
      } else {
        toast('已存在相同链接，跳过', false, 1800);
      }
    } catch (err) {
      toast(`存入失败：${err.message || err}`, true, 3200);
    } finally {
      setWorking(false);
      pill.classList.remove('mv-loading');
      hidePill(0);
    }
  }

  async function importAll() {
    if (state.busy) return;
    if (!state.inventory.length) {
      await scanPage({ silent: true });
    }
    const items = state.inventory.map((i) => buildPayload(i));
    if (!items.length) {
      toast('没有可存入的媒体');
      return;
    }
    setWorking(true);
    const total = items.length;
    try {
      // 分批提交，避免单次消息过大；每批 40 条
      let imported = 0;
      let failed = 0;
      for (let i = 0; i < items.length; i += 40) {
        const chunk = items.slice(i, i + 40);
        const res = await runTask(
          TASK.IMPORT,
          { items: chunk, openLibraryAfter: false },
          (p) => {
            const done = imported + (p.done || 0);
            toast(`正在存入 ${Math.min(done, total)}/${total}…`, false, 60000);
          },
        );
        imported += (res.imported || []).length;
        failed += (res.failed || []).length;
      }
      toast(`完成：成功 ${imported} 个${failed ? `，失败 ${failed} 个` : ''}`, failed > 0, 3200);
      bumpBallCount(imported);
    } catch (err) {
      toast(`批量存入失败：${err.message || err}`, true, 3200);
    } finally {
      setWorking(false);
    }
  }

  function bumpBallCount(n) {
    const { ball } = state.els;
    const badge = ball.querySelector('.mv-ball-count');
    const cur = parseInt(badge.textContent, 10) || 0;
    badge.textContent = formatCount(cur + n);
    badge.classList.add('show');
  }

  async function hideBallPermanently() {
    const { ball } = state.els;
    ball.style.display = 'none';
    try {
      chrome.storage.local.get(STORAGE_SETTINGS_KEY, (res) => {
        const raw = res[STORAGE_SETTINGS_KEY] || {};
        raw.ball = { ...(raw.ball || {}), enabled: false };
        chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: raw });
      });
    } catch (_) { /* noop */ }
    toast('悬浮球已隐藏，可在扩展图标的弹窗里重新开启');
  }

  /* ------------------------------ 7. 初始化 ------------------------------ */

  function applySettings() {
    const { ball, pill } = state.els;
    const enabled = state.settings.enabled && !isExcluded();
    if (!enabled) {
      if (state.els.host) state.els.host.style.display = 'none';
      return;
    }
    state.els.host.style.display = '';
    ball.style.display = state.settings.ball.enabled ? 'flex' : 'none';
    if (!state.settings.hover.enabled) pill.style.display = 'none';
    applyBallPosition();
  }

  async function init() {
    await loadSettings();
    if (!state.settings.enabled || isExcluded()) return;

    buildShell();
    bindHover();
    bindBall();
    buildMenu();
    bindMenu();
    applySettings();

    // 首屏扫描 + 滚动触发懒加载重扫
    scheduleScan(700);
    window.addEventListener('scroll', () => {
      if (state.scrollScans > 20) return;
      clearTimeout(state.scrollTimer);
      state.scrollTimer = setTimeout(() => {
        state.scrollScans += 1;
        scanPage({ silent: true }).catch(() => {});
      }, 1200);
    }, { passive: true });

    // 设置变化热更新
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_SETTINGS_KEY]) return;
        state.settings = mergeSettings(changes[STORAGE_SETTINGS_KEY].newValue);
        applySettings();
      });
    } catch (_) { /* 扩展重载后上下文失效 */ }

    // 来自 popup / 后台 / 右键菜单的消息
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.type) return false;
        if (msg.type === MSG.GET_TAB_STATS) {
          const counts = quickCounts();
          sendResponse({ ok: true, ...counts, scanning: state.scanning });
          return true;
        }
        if (msg.type === MSG.SCAN_NOW) {
          scanPage({ silent: Boolean(msg.payload && msg.payload.silent) }).then((list) => {
            sendResponse({ ok: true, total: list.length });
          }).catch((err) => sendResponse({ ok: false, error: String(err) }));
          return true;
        }
        if (msg.type === MSG.IMPORT_BATCH) {
          importAll().then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
          return true;
        }
        if (msg.type === MSG.RELOAD_SETTINGS) {
          loadSettings().then(() => {
            applySettings();
            sendResponse({ ok: true });
          });
          return true;
        }
        return false;
      });
    } catch (_) { /* noop */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
