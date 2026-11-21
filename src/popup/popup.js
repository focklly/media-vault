/**
 * 弹窗逻辑
 * - 读取当前标签页的扫描统计（content 脚本应答）
 * - 读取个人空间元数据（直接读 IndexedDB）
 * - 快捷开关直接写 settings，content 脚本通过 storage.onChanged 热更新
 */

import { APP, MSG, KIND } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';
import { listItems, getStats, getBlob } from '../shared/db.js';
import { sendMessage, sendToTab } from '../shared/messaging.js';
import { formatBytes } from '../shared/utils.js';
import { resolveTargetAdapter } from '../shared/routing.js';

const $ = (sel) => document.querySelector(sel);

let currentTab = null;
let settings = null;

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2000);
}

async function init() {
  $('#version').textContent = `v${APP.version}`;
  settings = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  $('#pageTitle').textContent = tab?.title ? tab.title : '当前页面';

  await renderSettings();
  await refreshPageStats();
  await refreshSpace();
  bindEvents();
}

async function renderSettings() {
  $('#toggleBall').checked = Boolean(settings.ball.enabled);
  $('#toggleHover').checked = Boolean(settings.hover.enabled);
  $('#toggleAuto').checked = Boolean(settings.autoUpload.enabled);

  const meta = await sendMessage('MV_GET_ADAPTER_META');
  const adapters = (meta.adapters || []).map((a) => ({
    ...a,
    enabled: settings.adapters?.[a.id]?.enabled === true,
  }));
  const img = resolveTargetAdapter(settings, KIND.IMAGE, adapters);
  const vid = resolveTargetAdapter(settings, KIND.VIDEO, adapters);
  let target;
  if (!img && !vid) target = '仅本地';
  else if (img && vid && img.id === vid.id) target = img.label;
  else target = `${img?.label || '无图片目标'} / ${vid?.label || '无视频目标'}`;
  $('#targetName').textContent = target;
}

async function refreshPageStats() {
  if (!currentTab || !currentTab.id) return;
  const res = await sendToTab(currentTab.id, MSG.GET_TAB_STATS);
  if (!res.ok) {
    $('#imgCount').textContent = '—';
    $('#vidCount').textContent = '—';
    $('#totalCount').textContent = '—';
    $('#pageHint').textContent = '当前页面不允许扩展运行（如 chrome:// 或商店页），换个普通网页试试。';
    toast('当前页面不支持扫描', true);
    return;
  }
  $('#imgCount').textContent = String(res.images || 0);
  $('#vidCount').textContent = String(res.videos || 0);
  $('#totalCount').textContent = String(res.total || 0);
  $('#pageHint').textContent = res.total
    ? '悬停到图片/视频上会出现「存入个人空间」按钮，Shift+单击可直接上传到默认站点。'
    : '还没扫描到媒体，点「重新扫描」或滚动页面触发懒加载。';
}

async function refreshSpace() {
  const stats = await getStats();
  $('#spaceStats').textContent = `${stats.total} 个 · ${formatBytes(stats.bytes)}`;
  $('#quota').textContent = `本地占用 ${formatBytes(stats.bytes)} · 已上传 ${stats.uploaded}`;

  const items = (await listItems({ sort: 'new' })).slice(0, 4);
  const box = $('#recent');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<div class="recent-empty">个人空间还是空的<br/>去网页上悬停图片，点一下「存入个人空间」</div>';
    return;
  }
  for (const item of items) {
    const cell = document.createElement('div');
    cell.className = 'recent-item';
    cell.title = item.title;
    const thumb = item.files?.thumb ? await getBlob(item.files.thumb) : null;
    if (thumb) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(thumb);
      img.onload = () => URL.revokeObjectURL(img.src);
      cell.appendChild(img);
    } else if (item.kind === KIND.VIDEO) {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'metadata';
      v.src = item.poster || item.sourceUrl;
      cell.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = item.sourceUrl;
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); };
      cell.appendChild(img);
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${item.kind === KIND.VIDEO ? '视频' : '图片'} · ${formatBytes(item.size || 0)}`;
    cell.appendChild(tag);
    box.appendChild(cell);
  }
}

function bindEvents() {
  $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('#btnLibrary').addEventListener('click', async () => {
    await sendMessage(MSG.OPEN_LIBRARY);
    window.close();
  });

  $('#btnScan').addEventListener('click', async () => {
    if (!currentTab?.id) return;
    $('#pageHint').textContent = '扫描中…';
    const res = await sendToTab(currentTab.id, MSG.SCAN_NOW, { silent: false });
    if (!res.ok) {
      toast(res.error || '扫描失败', true);
      return;
    }
    await refreshPageStats();
    toast(`扫描完成，共 ${res.total || 0} 个`);
  });

  $('#btnAll').addEventListener('click', async () => {
    if (!currentTab?.id) return;
    const btn = $('#btnAll');
    btn.disabled = true;
    btn.textContent = '正在存入…';
    const res = await sendToTab(currentTab.id, MSG.IMPORT_BATCH, {});
    btn.disabled = false;
    btn.textContent = '全部存入';
    if (!res.ok) toast(res.error || '批量存入失败', true);
    else toast('已开始批量存入，可打开图库查看');
    await refreshSpace();
  });

  const bindToggle = (selector, getter, wrapper) => {
    $(selector).addEventListener('change', async (e) => {
      const next = wrapper(e.target.checked);
      settings = await saveSettings(next);
      renderSettings();
      toast('已保存，页面会立即生效');
    });
  };

  bindToggle('#toggleBall', () => settings.ball.enabled, (checked) => ({ ball: { enabled: checked } }));
  bindToggle('#toggleHover', () => settings.hover.enabled, (checked) => ({ hover: { enabled: checked } }));
  bindToggle('#toggleAuto', () => settings.autoUpload.enabled, (checked) => ({ autoUpload: { enabled: checked } }));

  // 个人空间数据变化时同步（例如另一个标签页在导入）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['mv.settings']) {
      getSettings().then((s) => { settings = s; renderSettings(); });
    }
  });
}

init().catch((err) => toast(`初始化失败：${err.message || err}`, true));
