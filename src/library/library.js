/**
 * 个人空间（图库）逻辑
 *
 * 数据流：
 *   IndexedDB（元数据）→ 列表渲染（不读 Blob）
 *   卡片进入视口时才读缩略图 Blob → objectURL → <img>
 *   预览 / 下载时读原图 Blob，用完 revoke，避免内存泄漏
 *
 * 所有写操作（上传、删除）都通过后台端口任务执行，页面只负责发起与展示进度。
 */

import { KIND, TASK } from '../shared/constants.js';
import {
  listItems, getStats, getBlob, getItem, updateItem, deleteItems,
  exportManifest, importManifest,
} from '../shared/db.js';
import { getSettings } from '../shared/settings.js';
import { runTask, sendMessage } from '../shared/messaging.js';
import { formatBytes, formatDuration, formatDate, hostOf } from '../shared/utils.js';
import { resolveTargetAdapter, adapterLabel, adapterSupports, unsupportedReason } from '../shared/routing.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  adapters: [],
  items: [],
  filtered: [],
  filter: 'all',
  sort: 'new',
  q: '',
  tagFilter: new Set(),  // 快捷筛选：多选标签
  selected: new Set(),
  urls: new Map(),      // itemId -> objectURL（缩略图）
  observer: null,
  progressEl: null,
};

const FILTER_LABEL = {
  all: '全部媒体',
  image: '图片',
  video: '视频',
  favorite: '收藏',
  uploaded: '已上传',
  pending: '待上传',
  link: '仅链接',
};

function toast(msg, isError = false, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  state.settings = await getSettings();
  const meta = await sendMessage('MV_GET_ADAPTER_META');
  state.adapters = meta.adapters || [];

  bindUI();
  await refresh();
  renderStorage();
}

function bindUI() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === btn));
    $('#filterLabel').textContent = FILTER_LABEL[state.filter] || '全部媒体';
    applyFilter();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = value;
      applyFilter();
    }, 180);
  });

  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFilter();
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await refresh();
    toast('已刷新');
  });

  $('#btnSelectAll').addEventListener('click', () => {
    const all = state.filtered.every((it) => state.selected.has(it.id));
    if (all) state.filtered.forEach((it) => state.selected.delete(it.id));
    else state.filtered.forEach((it) => state.selected.add(it.id));
    renderGrid();
    syncBulkBar();
  });

  $('#bulkUpload').addEventListener('click', () => uploadSelected());
  $('#bulkDelete').addEventListener('click', () => deleteSelected());
  $('#bulkDownload').addEventListener('click', () => downloadSelected());

  $('#btnExport').addEventListener('click', () => exportAll());
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const manifest = JSON.parse(await file.text());
      const added = await importManifest(manifest);
      await refresh();
      toast(`已导入 ${added} 条元数据记录（不含文件本体）`);
    } catch (err) {
      toast(`导入失败：${err.message || err}`, true);
    }
  });

  $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // 详情弹窗关闭
  $('#modal').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 设置变化（比如刚在设置页启用了新适配器）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['mv.settings']) {
      getSettings().then((s) => { state.settings = s; });
    }
  });
}

/* ------------------------------ 数据 ------------------------------ */

async function refresh() {
  state.items = await listItems({ sort: state.sort });
  // 清理已删除条目的选中态，避免出现「选中 2 项但只剩 1 张卡」的错位
  const ids = new Set(state.items.map((i) => i.id));
  [...state.selected].forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
  applyFilter();
  renderStorage();
}

function applyFilter() {
  let list = state.items;
  switch (state.filter) {
    case 'image': list = list.filter((i) => i.kind === KIND.IMAGE); break;
    case 'video': list = list.filter((i) => i.kind === KIND.VIDEO); break;
    case 'favorite': list = list.filter((i) => i.fav === 1); break;
    case 'uploaded': list = list.filter((i) => i.remote && i.remote.url); break;
    case 'pending': list = list.filter((i) => !(i.remote && i.remote.url)); break;
    case 'link': list = list.filter((i) => i.status === 'link-only'); break;
    default: break;
  }
  if (state.q) {
    const key = state.q.trim().toLowerCase();
    list = list.filter((i) => [i.title, i.fileName, i.site, i.pageUrl, i.sourceUrl, i.note, ...(i.tags || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(key));
  }
  if (state.tagFilter.size) {
    list = list.filter((i) => (i.tags || []).some((t) => state.tagFilter.has(t)));
  }
  list = sortList(list, state.sort);
  state.filtered = list;

  $('#filterLabel').textContent = FILTER_LABEL[state.filter] || '全部媒体';
  $('#resultCount').textContent = `共 ${list.length} 个`;
  renderGrid();
  renderTagRow();
  syncBulkBar();
  renderSidebarCounts();
}

/** 标签快捷筛选行：按出现频次排序，可多选，可一键清除 */
function renderTagRow() {
  const row = $('#tagRow');
  if (!row) return;
  const freq = new Map();
  for (const item of state.items) {
    for (const t of new Set(item.tags || [])) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  row.innerHTML = '';
  if (!tags.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const label = document.createElement('span');
  label.className = 'tagrow-label';
  label.textContent = '标签';
  row.appendChild(label);

  for (const [tag, count] of tags) {
    const chip = document.createElement('button');
    chip.className = `chip${state.tagFilter.has(tag) ? ' active' : ''}`;
    chip.textContent = `${tag} · ${count}`;
    chip.addEventListener('click', () => {
      if (state.tagFilter.has(tag)) state.tagFilter.delete(tag);
      else state.tagFilter.add(tag);
      applyFilter();
    });
    row.appendChild(chip);
  }

  if (state.tagFilter.size) {
    const clear = document.createElement('button');
    clear.className = 'chip clear';
    clear.textContent = '清除筛选';
    clear.addEventListener('click', () => {
      state.tagFilter.clear();
      applyFilter();
    });
    row.appendChild(clear);
  }
}

function sortList(list, sort) {
  const copy = list.slice();
  const sorters = {
    new: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    old: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    name: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'),
  };
  return copy.sort(sorters[sort] || sorters.new);
}

function renderSidebarCounts() {
  const counts = {
    all: state.items.length,
    image: state.items.filter((i) => i.kind === KIND.IMAGE).length,
    video: state.items.filter((i) => i.kind === KIND.VIDEO).length,
    favorite: state.items.filter((i) => i.fav === 1).length,
    uploaded: state.items.filter((i) => i.remote && i.remote.url).length,
    pending: state.items.filter((i) => !(i.remote && i.remote.url)).length,
    link: state.items.filter((i) => i.status === 'link-only').length,
  };
  Object.entries(counts).forEach(([key, n]) => {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = String(n);
  });
}

async function renderStorage() {
  const stats = await getStats();
  $('#usedText').textContent = formatBytes(stats.bytes);
  $('#totalText').textContent = `${stats.total} 个条目`;
  const used = stats.bytes || 0;
  const quota = (await navigator.storage?.estimate?.().catch(() => null))?.quota || 0;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  $('#usageBar').style.width = `${quota ? Math.max(2, pct) : (used ? 100 : 0)}%`;
  $('#usagePct').textContent = quota ? `占配额 ${pct.toFixed(1)}%` : '已启用无限存储';
  $('#footerStats').textContent = `图片 ${stats.images} · 视频 ${stats.videos} · 仅链接 ${stats.links} · 已上传 ${stats.uploaded} · 本地 ${formatBytes(stats.bytes)}`;
}

/* ------------------------------ 渲染网格 ------------------------------ */

function renderGrid() {
  const grid = $('#grid');
  cleanupThumbs();
  grid.innerHTML = '';
  const list = state.filtered;

  $('#empty').hidden = list.length > 0;
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      state.observer.unobserve(el);
      loadThumb(el).catch(() => {});
    });
  }, { rootMargin: '200px 0px' });

  const frag = document.createDocumentFragment();
  for (const item of list) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;
    if (state.selected.has(item.id)) card.classList.add('selected');

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.files?.thumb) {
      thumb.dataset.thumbKey = item.files.thumb;
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = item.kind === KIND.VIDEO ? '▶' : '▣';
      thumb.appendChild(ph);
      state.observer.observe(thumb);
    } else if (item.kind === KIND.IMAGE && item.sourceUrl) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = item.sourceUrl;
      img.onerror = () => { img.replaceWith(placeholder(item.kind)); };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(placeholder(item.kind));
    }

    const tag = document.createElement('span');
    tag.className = `tag ${item.kind}`;
    tag.textContent = item.kind === KIND.VIDEO ? '视频' : '图片';
    thumb.appendChild(tag);

    if (item.kind === KIND.VIDEO && item.duration) {
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(item.duration);
      thumb.appendChild(dur);
    }
    if (item.remote?.url) {
      const cloud = document.createElement('span');
      cloud.className = 'cloud';
      cloud.textContent = item.remote.privateLink ? '已上传·私有' : '已上传';
      thumb.appendChild(cloud);
    }

    // 站点角标：显示适配器名称（不显示 adapterId）；未上传显示「本地」
    const site = document.createElement('span');
    site.className = 'site-badge';
    const siteLabel = item.remote?.url ? labelFor(item.remote.adapterId) : '本地';
    site.textContent = siteLabel;
    site.title = item.remote?.url ? `存入站点：${siteLabel}` : '仅存本地';
    thumb.appendChild(site);

    const check = document.createElement('button');
    check.className = 'check';
    check.title = '选择';
    check.textContent = '✓';
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected.has(item.id)) state.selected.delete(item.id);
      else state.selected.add(item.id);
      card.classList.toggle('selected', state.selected.has(item.id));
      syncBulkBar();
    });
    thumb.appendChild(check);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML = `
      <button class="act" data-act="preview">预览</button>
      <button class="act" data-act="upload">上传</button>
      <button class="act" data-act="copy">复制链接</button>
      <button class="act danger" data-act="del">删除</button>
    `;
    actions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'preview') openModal(item.id);
      if (act === 'upload') uploadOne(item.id);
      if (act === 'copy') copyLink(item);
      if (act === 'del') deleteOne(item);
    });
    thumb.appendChild(actions);
    thumb.addEventListener('click', () => openModal(item.id));

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = `
      <div class="card-name" title="${escapeAttr(item.title)}">${esc(item.title || item.fileName)}</div>
      <div class="card-sub"><span>${formatBytes(item.size || 0)}</span><span>·</span><span>${esc(item.site || '—')}</span></div>
      ${item.remote?.error ? `<div class="card-fail" title="${escapeAttr(item.remote.error)}">上传失败：${esc(item.remote.error)}</div>` : ''}
    `;
    const tags = item.tags || [];
    if (tags.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      tags.slice(0, 3).forEach((t) => chips.appendChild(makeChip(t)));
      if (tags.length > 3) {
        const more = document.createElement('span');
        more.className = 'chip more';
        more.textContent = `+${tags.length - 3}`;
        chips.appendChild(more);
      }
      meta.appendChild(chips);
    }
    card.append(thumb, meta);
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function placeholder(kind) {
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = kind === KIND.VIDEO ? '▶' : '▣';
  return ph;
}

async function loadThumb(el) {
  const key = el.dataset.thumbKey;
  if (!key) return;
  const blob = await getBlob(key);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.onload = () => URL.revokeObjectURL(url);
  el.querySelector('.ph')?.remove();
  el.prepend(img);
}

function cleanupThumbs() {
  state.urls.forEach((url) => URL.revokeObjectURL(url));
  state.urls.clear();
}

function syncBulkBar() {
  const bar = $('#bulkBar');
  bar.hidden = state.selected.size === 0;
  $('#selectedCount').textContent = `已选 ${state.selected.size} 项`;
}

/* ------------------------------ 弹窗预览 ------------------------------ */

async function openModal(id) {
  const item = await getItem(id);
  if (!item) {
    toast('条目不存在', true);
    return;
  }
  const modal = $('#modal');
  modal.hidden = false;
  $('#mTitle').textContent = item.title || item.fileName;

  const preview = $('#mPreview');
  preview.innerHTML = '';
  let objectUrl = null;
  try {
    const blob = item.files?.orig ? await getBlob(item.files.orig) : null;
    if (blob) {
      objectUrl = URL.createObjectURL(blob);
      if (item.kind === KIND.VIDEO) {
        const v = document.createElement('video');
        v.src = objectUrl;
        v.controls = true;
        v.autoplay = false;
        v.poster = '';
        v.preload = 'metadata';
        preview.appendChild(v);
      } else {
        const img = document.createElement('img');
        img.src = objectUrl;
        img.alt = item.title;
        preview.appendChild(img);
      }
    } else if (item.kind === KIND.VIDEO && item.sourceUrl) {
      const v = document.createElement('video');
      v.src = item.sourceUrl;
      v.controls = true;
      v.preload = 'metadata';
      if (item.poster) v.poster = item.poster;
      preview.appendChild(v);
    } else if (item.sourceUrl) {
      const img = document.createElement('img');
      img.src = item.sourceUrl;
      img.referrerPolicy = 'no-referrer';
      img.alt = item.title;
      img.onerror = () => {
        preview.innerHTML = '<div class="ph">源站已限制外链，本地副本不存在</div>';
      };
      preview.appendChild(img);
    } else {
      preview.innerHTML = '<div class="ph">无可用预览</div>';
    }
  } catch (_) {
    preview.innerHTML = '<div class="ph">预览加载失败</div>';
  }

  const history = item.remote?.history || [];
  const rows = [
    ['类型', `${item.kind === KIND.VIDEO ? '视频' : '图片'}${item.status === 'link-only' ? '（仅链接）' : ''}`],
    ['文件名', item.fileName || '—'],
    ['尺寸', item.width && item.height ? `${item.width} × ${item.height}` : '未知'],
    ['体积', formatBytes(item.size || 0)],
    ['时长', item.kind === KIND.VIDEO && item.duration ? formatDuration(item.duration) : '—'],
    ['来源站点', item.site || '—'],
    ['入库时间', formatDate(item.createdAt)],
    ['上传状态', item.remote?.url ? `已上传（${labelFor(item.remote.adapterId)}）` : (item.remote?.error ? `失败（${labelFor(item.remote.adapterId)}）` : '未上传')],
    ['远程链接', item.remote?.url || '—', item.remote?.url],
    ['来源页', item.pageUrl || '—', item.pageUrl],
    ['原始链接', item.sourceUrl || '—', item.sourceUrl],
    ['备注', item.note || '—'],
  ];
  if (history.length) {
    rows.push(['转存历史', history.map((h) => `${labelFor(h.adapterId)}${h.at ? ` · ${formatDate(h.at)}` : ''}`).join(' → ')]);
  }
  $('#mInfo').innerHTML = rows.map(([k, v, link]) => {
    const wide = k === '来源页' || k === '原始链接' || k === '备注' || k === '转存历史';
    const value = link
      ? `<b title="${escapeAttr(v)}"><a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">${esc(v)}</a></b>`
      : `<b title="${escapeAttr(v)}">${esc(v)}</b>`;
    return `<div class="info-row ${wide ? 'wide' : ''}"><span>${k}</span>${value}</div>`;
  }).join('');

  // 标签编辑：逗号/空格分隔，去重去空，失焦或回车写回
  const tagsRow = document.createElement('div');
  tagsRow.className = 'info-row wide tags-row';
  const tagLabel = document.createElement('span');
  tagLabel.textContent = '标签';
  const tagInput = document.createElement('input');
  tagInput.className = 'tag-input';
  tagInput.value = (item.tags || []).join(', ');
  tagInput.placeholder = '用逗号或空格分隔，例如：截图, 壁纸';
  const saveTags = async () => {
    const tags = parseTags(tagInput.value);
    await updateItem(item.id, { tags });
    item.tags = tags;
    await refresh();
  };
  tagInput.addEventListener('blur', saveTags);
  tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tagInput.blur(); });
  tagsRow.append(tagLabel, tagInput);
  $('#mInfo').appendChild(tagsRow);

  const actions = $('#mActions');
  actions.innerHTML = '';
  const adapterOptions = adapterOptionsFor(item.kind);
  const select = document.createElement('select');
  adapterOptions.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.disabled ? `${a.label}（${a.reason}）` : a.label;
    opt.disabled = a.disabled;
    select.appendChild(opt);
  });
  if (!adapterOptions.length) {
    const opt = document.createElement('option');
    opt.textContent = '尚未启用上传目标';
    opt.value = '';
    select.appendChild(opt);
    select.disabled = true;
  }
  const fallback = defaultAdapterId(item.kind);
  if (fallback && [...select.options].some((o) => o.value === fallback)) select.value = fallback;
  actions.appendChild(select);

  const btn = (label, cls, handler) => {
    const b = document.createElement('button');
    b.className = `m-btn ${cls || ''}`;
    b.textContent = label;
    b.addEventListener('click', handler);
    actions.appendChild(b);
    return b;
  };

  const alreadyRemote = Boolean(item.remote?.url);
  btn(alreadyRemote ? '转存到该站点' : '上传到该站点', 'primary', async () => {
    if (!select.value) {
      toast('请先到设置页启用并配置上传目标', true);
      return;
    }
    if (alreadyRemote) await transferOne(item.id, select.value);
    else await uploadOne(item.id, select.value);
  });
  btn(item.fav === 1 ? '取消收藏' : '收藏', '', async () => {
    await updateItem(item.id, { fav: item.fav === 1 ? 0 : 1 });
    await refresh();
    closeModal();
  });
  btn('复制链接', '', () => copyLink(item));
  if (item.pageUrl) btn('打开来源页', '', () => window.open(item.pageUrl, '_blank', 'noreferrer'));
  if (item.files?.orig) {
    btn('下载到本地', '', async () => {
      const blob = await getBlob(item.files.orig);
      if (!blob) return toast('本地副本不存在', true);
      triggerDownload(URL.createObjectURL(blob), item.fileName, true);
    });
  }
  btn('删除', 'danger', async () => {
    closeModal();
    await deleteOne(item);
  });

  modal._objectUrl = objectUrl;
}

function closeModal() {
  const modal = $('#modal');
  if (modal.hidden) return;
  modal.hidden = true;
  if (modal._objectUrl) {
    URL.revokeObjectURL(modal._objectUrl);
    modal._objectUrl = null;
  }
  $('#mPreview').innerHTML = '';
}

/* ------------------------------ 操作 ------------------------------ */

/** 带启用态的适配器描述，供共享路由与名称解析使用 */
function descriptors() {
  return state.adapters.map((a) => ({
    ...a,
    enabled: state.settings?.adapters?.[a.id]?.enabled === true,
  }));
}

/** 下拉选项：已启用站点；不支持该类型的禁用并写明原因 */
function adapterOptionsFor(kind) {
  return state.adapters
    .filter((a) => state.settings?.adapters?.[a.id]?.enabled)
    .map((a) => ({
      id: a.id,
      label: a.label,
      disabled: kind ? !adapterSupports(a, kind) : false,
      reason: kind && !adapterSupports(a, kind) ? unsupportedReason(kind) : '',
    }));
}

/** 按类型走共享路由解析默认站点 */
function defaultAdapterId(kind) {
  return resolveTargetAdapter(state.settings, kind, descriptors())?.id || '';
}

/** 适配器展示名；找不到时回退 id */
function labelFor(adapterId) {
  return adapterLabel(descriptors(), adapterId) || adapterId || '';
}

function makeChip(tag) {
  const chip = document.createElement('button');
  chip.className = `chip${state.tagFilter.has(tag) ? ' active' : ''}`;
  chip.textContent = tag;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.tagFilter.has(tag)) state.tagFilter.delete(tag);
    else state.tagFilter.add(tag);
    applyFilter();
  });
  return chip;
}

async function uploadOne(id, adapterId) {
  const item = await getItem(id);
  const target = adapterId || defaultAdapterId(item?.kind);
  if (!target) {
    toast('还没有启用上传目标，先到设置页配置站点', true, 3600);
    return;
  }
  showProgress('正在上传…', 0, 1);
  try {
    const res = await runTask(TASK.UPLOAD, { id, adapterId: target }, (p) => {
      showProgress('正在上传…', p.done || 0, p.total || 1, p.message);
    });
    toast(res.item?.remote?.url ? `已上传到 ${labelFor(res.item.remote.adapterId)}，链接已保存` : '上传完成');
    await refresh();
  } catch (err) {
    toast(`上传失败：${err.message || err}`, true, 4000);
    await refresh();
  } finally {
    hideProgress();
  }
}

async function transferOne(id, adapterId) {
  if (!adapterId) {
    toast('请先选择目标站点', true);
    return;
  }
  showProgress('正在转存…', 0, 1);
  try {
    const res = await runTask(TASK.TRANSFER, { id, adapterId }, (p) => {
      showProgress('正在转存…', p.done || 0, p.total || 1, p.message);
    });
    toast(res.item?.remote?.url ? `已转存到 ${labelFor(res.item.remote.adapterId)}，历史记录已保留` : '转存完成');
    await refresh();
  } catch (err) {
    toast(`转存失败：${err.message || err}`, true, 4000);
    await refresh();
  } finally {
    hideProgress();
  }
}

async function uploadSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  // 批量不指定固定站点：后台逐条按媒体类型走共享路由
  showProgress('批量上传中…', 0, ids.length);
  try {
    const res = await runTask(TASK.UPLOAD_BATCH, { ids, adapterId: '' }, (p) => {
      showProgress('批量上传中…', p.done || 0, p.total || ids.length, p.message);
    });
    toast(`上传完成 ${res.ok} 个${res.failed ? `，失败 ${res.failed} 个` : ''}`, res.failed > 0, 3600);
    state.selected.clear();
    await refresh();
  } catch (err) {
    toast(`批量上传失败：${err.message || err}`, true, 4000);
  } finally {
    hideProgress();
  }
}

async function deleteOne(item) {
  if (!confirm(`确定删除「${item.title || item.fileName}」？本地副本会一并清除，且不可恢复。`)) return;
  try {
    await runTask(TASK.DELETE, { ids: [item.id] });
    state.selected.delete(item.id);
    toast('已删除');
    await refresh();
  } catch (err) {
    toast(`删除失败：${err.message || err}`, true);
  }
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 项？本地副本会一并清除。`)) return;
  try {
    await runTask(TASK.DELETE, { ids });
    ids.forEach((id) => state.selected.delete(id));
    toast(`已删除 ${ids.length} 项`);
    await refresh();
  } catch (err) {
    toast(`删除失败：${err.message || err}`, true);
  }
}

async function copyLink(item) {
  const link = item.remote?.url || item.sourceUrl;
  if (!link) {
    toast('没有可复制的链接', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast(item.remote?.url ? '远程链接已复制' : '原始链接已复制（该条目尚未上传）');
  } catch (_) {
    toast('复制失败，请手动复制', true);
  }
}

async function downloadSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  toast(`开始导出 ${ids.length} 个文件…`);
  for (const id of ids.slice(0, 20)) {
    const item = await getItem(id);
    if (!item?.files?.orig) continue;
    const blob = await getBlob(item.files.orig);
    if (!blob) continue;
    triggerDownload(URL.createObjectURL(blob), item.fileName, true);
    await new Promise((r) => setTimeout(r, 350));
  }
}

function triggerDownload(url, filename, revoke = false) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportAll() {
  try {
    const manifest = await exportManifest();
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    triggerDownload(URL.createObjectURL(blob), `mediavault-manifest-${Date.now()}.json`, true);
    toast(`已导出 ${manifest.count} 条元数据（不含文件本体）`);
  } catch (err) {
    toast(`导出失败：${err.message || err}`, true);
  }
}

/* ------------------------------ 进度 ------------------------------ */

function showProgress(title, done, total, detail = '') {
  if (!state.progressEl) {
    const el = document.createElement('div');
    el.className = 'progress';
    el.innerHTML = '<b></b><div class="bar"><i></i></div><small></small>';
    document.body.appendChild(el);
    state.progressEl = el;
  }
  const el = state.progressEl;
  el.style.display = 'block';
  el.querySelector('b').textContent = title;
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  el.querySelector('i').style.width = `${pct}%`;
  const small = el.querySelector('small');
  small.textContent = detail || (total ? `${done}/${total}` : '');
}

function hideProgress() {
  if (state.progressEl) state.progressEl.style.display = 'none';
}

/* ------------------------------ 小工具 ------------------------------ */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 标签解析：中英文逗号/空白分隔，去重去空 */
function parseTags(text) {
  return [...new Set(String(text).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];
}
function escapeAttr(str) {
  return esc(str).replace(/`/g, '&#96;');
}

init().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message || err}`, true, 5000);
});
