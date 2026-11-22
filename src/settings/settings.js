/**
 * 设置页逻辑
 *
 * 设计：所有改动自动保存（300ms 防抖），不需要「保存」按钮。
 * 适配器表单完全由后台返回的 fields 元数据生成 —— 新增适配器不用改这个文件。
 */

import { APP, TASK, KIND } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';
import { getStats, exportManifest, importManifest, clearAll } from '../shared/db.js';
import { runTask, sendMessage } from '../shared/messaging.js';
import { formatBytes } from '../shared/utils.js';
import { adapterSupports, unsupportedReason } from '../shared/routing.js';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  settings: null,
  adapters: [],
  pending: {},
  saveTimer: null,
};

function toast(msg, isError = false, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function deepMerge(base, patch) {
  if (typeof base !== 'object' || base === null) return patch;
  if (typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && typeof v === 'object' && v !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/** 防抖保存 */
function update(patch) {
  state.pending = deepMerge(state.pending, patch);
  const stateEl = $('#saveState');
  stateEl.classList.remove('flash');
  stateEl.textContent = '保存中…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      state.settings = await saveSettings(state.pending);
      state.pending = {};
      stateEl.textContent = '已自动保存';
      stateEl.classList.add('flash');
      setTimeout(() => stateEl.classList.remove('flash'), 1200);
      renderDefaultSelect();
    } catch (err) {
      stateEl.textContent = '保存失败';
      toast(`保存失败：${err.message || err}`, true, 3600);
    }
  }, 300);
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  state.settings = await getSettings();
  const meta = await sendMessage('MV_GET_ADAPTER_META');
  state.adapters = meta.adapters || [];

  $('#aboutVersion').textContent = `v${APP.version}`;
  $('#aboutRepo').textContent = APP.repo.replace('https://github.com/', '');
  $('#aboutRepo').href = APP.repo;
  $('#aboutDocs').href = `${APP.repo}/tree/main/docs`;
  $('#repoLink').href = APP.repo;

  renderGeneral();
  renderAdapters();
  renderRules();
  await renderData();
  bindTabs();
  bindMisc();

  if (new URLSearchParams(location.search).get('welcome')) {
    $('#welcome').hidden = false;
  }
}

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
    if (btn.dataset.tab === 'data') renderData();
  });
}

function bindMisc() {
  $('#btnLibrary').addEventListener('click', () => sendMessage('MV_OPEN_LIBRARY'));
  $('#btnOpenLib').addEventListener('click', () => sendMessage('MV_OPEN_LIBRARY'));
  $('#welcomeClose').addEventListener('click', () => { $('#welcome').hidden = true; });
  $('#welcome').addEventListener('click', (e) => { if (e.target.id === 'welcomeClose') $('#welcome').hidden = true; });

  $('#btnExport').addEventListener('click', exportAll);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', importFile);
  $('#btnClear').addEventListener('click', clearAllData);
}

/* ------------------------------ 通用 ------------------------------ */

function renderGeneral() {
  const s = state.settings;
  $('#swEnabled').checked = Boolean(s.enabled);
  $('#swBall').checked = Boolean(s.ball.enabled);
  $('#swHover').checked = Boolean(s.hover.enabled);
  $('#swHoverVideo').checked = Boolean(s.hover.videos);
  $('#swAuto').checked = Boolean(s.autoUpload.enabled);

  $('#swEnabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('#swBall').addEventListener('change', (e) => update({ ball: { enabled: e.target.checked } }));
  $('#swHover').addEventListener('change', (e) => update({ hover: { enabled: e.target.checked } }));
  $('#swHoverVideo').addEventListener('change', (e) => update({ hover: { videos: e.target.checked } }));
  $('#swAuto').addEventListener('change', (e) => update({ autoUpload: { enabled: e.target.checked } }));

  renderDefaultSelect();

  $('#selectDefault').addEventListener('change', (e) => {
    update({ autoUpload: { adapterId: e.target.value, enabled: e.target.value !== 'none' ? true : state.settings.autoUpload.enabled } });
    $('#swAuto').checked = e.target.value !== 'none' ? true : state.settings.autoUpload.enabled;
  });
  $('#selectDefaultImage').addEventListener('change', (e) => {
    update({ autoUpload: { byKind: { image: e.target.value } } });
  });
  $('#selectDefaultVideo').addEventListener('change', (e) => {
    update({ autoUpload: { byKind: { video: e.target.value } } });
  });
}

/** 填充「全局 / 图片 / 视频」三个默认站点下拉；不支持该类型的站点禁用并写明原因 */
function renderDefaultSelect() {
  const auto = state.settings?.autoUpload || {};
  fillKindSelect($('#selectDefault'), null, auto.adapterId || 'none');
  fillKindSelect($('#selectDefaultImage'), KIND.IMAGE, auto.byKind?.image || '');
  fillKindSelect($('#selectDefaultVideo'), KIND.VIDEO, auto.byKind?.video || '');

  const enabledCount = state.adapters.filter((a) => state.settings?.adapters?.[a.id]?.enabled).length;
  $('#defaultHelp').textContent = enabledCount
    ? `已启用 ${enabledCount} 个站点。入库后按「图片/视频默认 → 全局默认 → 第一个支持该类型的站点」路由，失败会在图库里标红。`
    : '还没有启用任何站点：先到「上传目标」里开启一个，否则所有媒体只存本地。';
}

function fillKindSelect(select, kind, current) {
  if (!select) return;
  select.innerHTML = '';

  const sentinel = document.createElement('option');
  if (kind) {
    sentinel.value = '';
    sentinel.textContent = '跟随全局默认';
  } else {
    sentinel.value = 'none';
    sentinel.textContent = '仅本地（不上传）';
  }
  select.appendChild(sentinel);

  for (const meta of state.adapters) {
    if (meta.webOnly) continue;
    const cfg = state.settings?.adapters?.[meta.id];
    if (!cfg?.enabled) continue;
    const opt = document.createElement('option');
    opt.value = meta.id;
    if (kind && !adapterSupports(meta, kind)) {
      opt.disabled = true;
      opt.textContent = `${meta.label}（${unsupportedReason(kind)}）`;
    } else {
      opt.textContent = meta.label;
    }
    select.appendChild(opt);
  }

  if (current && current !== 'none' && ![...select.options].some((o) => o.value === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}（未启用）`;
    select.appendChild(opt);
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : sentinel.value;
}

/* ------------------------------ 适配器 ------------------------------ */

function renderAdapters() {
  const host = $('#adapterList');
  host.innerHTML = '';

  const direct = state.adapters.filter((a) => !a.webOnly);
  const web = state.adapters.filter((a) => a.webOnly);

  host.appendChild(groupNode('可直接上传（API 直传）', `扩展把文件直接 POST 到这些站点的接口，点「测试」可以验证配置。已启用 ${direct.filter((a) => state.settings.adapters?.[a.id]?.enabled).length} / ${direct.length} 个`, direct));
  if (web.length) {
    host.appendChild(groupNode('网页上传站点（点开即用，扩展不代传）', '这些站点没有公开直传接口，登记在这里方便一键打开；文件仍需在站点页面里选择。', web));
  }
}

/** 分组标题 + 卡片容器 */
function groupNode(title, hint, metas) {
  const wrap = document.createElement('div');
  wrap.className = 'adapter-group';
  const head = document.createElement('div');
  head.className = 'adapter-group-head';
  head.innerHTML = `<b>${esc(title)}</b><span>${esc(hint)}</span>`;
  wrap.appendChild(head);
  const list = document.createElement('div');
  list.className = 'adapter-list';
  for (const meta of metas) list.appendChild(adapterCard(meta));
  wrap.appendChild(list);
  return wrap;
}

/** 单个紧凑卡片：标题行（名称/徽标/摘要）+ 右侧开关&按钮，配置区折叠 */
function adapterCard(meta) {
  const cfg = state.settings.adapters?.[meta.id] || {};
  const card = document.createElement('div');
  card.className = `adapter${cfg.enabled ? ' on' : ''}`;
  card.dataset.id = meta.id;

  const fields = meta.fields || [];
  const tools = [
    meta.webOnly
      ? '<button class="mini-btn" data-open>打开站点</button>'
      : '<button class="mini-btn" data-test>测试</button>',
    fields.length ? '<button class="mini-btn" data-fold>展开</button>' : '',
    `<label class="mini-switch" title="启用这个站点"><span>启用</span><input type="checkbox" data-enable ${cfg.enabled ? 'checked' : ''} /></label>`,
  ].join('');

  card.innerHTML = `
    <div class="adapter-row">
      <div class="adapter-main">
        <div class="adapter-title">
          <b>${esc(meta.label)}</b>
          <span class="adapter-badge">${esc(meta.badge || '')}</span>
          ${meta.maxBytes ? `<span class="adapter-limit">≤ ${formatBytes(meta.maxBytes)}</span>` : ''}
        </div>
        <p class="adapter-sum" title="${esc(meta.summary || '')}">${esc(meta.summary || '')}</p>
      </div>
      <div class="adapter-tools">${tools}</div>
    </div>
    <p class="test-line" data-result hidden></p>
    <div class="adapter-body" hidden>
      <div class="adapter-fields"></div>
      ${meta.note ? `<p class="adapter-note">${esc(meta.note)}</p>` : ''}
      <div class="adapter-foot">
        <a class="doc-link" href="${APP.repo}/blob/main/${meta.docs || 'docs/ADAPTERS.md'}" target="_blank" rel="noreferrer">配置步骤 →</a>
      </div>
    </div>
  `;

  const body = card.querySelector('.adapter-fields');
  for (const field of fields) body.appendChild(renderField(meta.id, field, cfg[field.key]));

  card.querySelector('[data-enable]').addEventListener('change', (e) => {
    card.classList.toggle('on', e.target.checked);
    update({ adapters: { [meta.id]: { enabled: e.target.checked } } });
  });

  const foldBtn = card.querySelector('[data-fold]');
  if (foldBtn) {
    foldBtn.addEventListener('click', () => {
      const hidden = card.querySelector('.adapter-body').hidden;
      card.querySelector('.adapter-body').hidden = !hidden;
      foldBtn.textContent = hidden ? '收起' : '展开';
      foldBtn.classList.toggle('active', hidden);
      card.classList.toggle('expanded', hidden);
    });
  }

  const openBtn = card.querySelector('[data-open]');
  if (openBtn && meta.openUrl) {
    openBtn.addEventListener('click', () => {
      window.open(meta.openUrl, '_blank', 'noopener');
      toast(`${meta.label} 已在新标签打开，拖入文件即可上传`);
    });
  }

  const testBtn = card.querySelector('[data-test]');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const result = card.querySelector('[data-result]');
      const config = collectConfig(card, meta);
      testBtn.disabled = true;
      const label = testBtn.textContent;
      testBtn.textContent = '测试中…';
      showResult(result, '', 'pending');
      try {
        const res = await runTask(TASK.TEST_ADAPTER, { adapterId: meta.id, config }, null, 90000);
        showResult(result, res.message || (res.ok ? '连接正常' : '连接失败'), res.ok ? 'ok' : 'err');
      } catch (err) {
        showResult(result, `测试失败：${err.message || err}`, 'err');
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = label;
      }
    });
  }

  return card;
}

function showResult(el, text, tone) {
  el.hidden = !text;
  el.textContent = text;
  el.className = `test-line ${tone || ''}`;
}

function renderField(adapterId, field, value) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const id = `f-${adapterId}-${field.key}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = `${field.label}${field.required ? ' *' : ''}`;
  wrap.appendChild(label);

  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3;
  } else if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'native-check';
    input.style.cssText = 'width:auto;height:16px;accent-color:#6366f1';
  } else {
    input = document.createElement('input');
    input.type = field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text');
    if (field.type === 'password') input.autocomplete = 'new-password';
  }
  input.id = id;
  input.dataset.key = field.key;
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.type === 'boolean') input.checked = value === true || value === undefined;
  else input.value = value === undefined || value === null ? '' : String(value);

  const handler = () => {
    let next;
    if (field.type === 'boolean') next = input.checked;
    else if (field.type === 'number') next = Number(input.value) || 0;
    else next = input.value;
    update({ adapters: { [adapterId]: { [field.key]: next } } });
  };
  input.addEventListener('change', handler);
  if (field.type !== 'boolean') input.addEventListener('blur', handler);

  wrap.appendChild(input);
  if (field.help) {
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = field.help;
    wrap.appendChild(help);
  }
  return wrap;
}

function collectConfig(card, meta) {
  const config = { ...(state.settings.adapters?.[meta.id] || {}) };
  card.querySelectorAll('[data-key]').forEach((input) => {
    const key = input.dataset.key;
    const field = (meta.fields || []).find((f) => f.key === key);
    if (!field) return;
    if (field.type === 'boolean') config[key] = input.checked;
    else if (field.type === 'number') config[key] = Number(input.value) || 0;
    else config[key] = input.value;
  });
  return config;
}

/* ------------------------------ 拾取规则 ------------------------------ */

function renderRules() {
  const s = state.settings;
  const bind = (selector, getter, patcher, cast = (v) => v) => {
    const el = $(selector);
    const val = getter();
    if (el.type === 'checkbox') el.checked = Boolean(val);
    else el.value = String(val);
    const handler = () => {
      const raw = el.type === 'checkbox' ? el.checked : el.value;
      patcher(cast(raw));
    };
    el.addEventListener('change', handler);
    if (el.type !== 'checkbox' && el.tagName === 'TEXTAREA') el.addEventListener('blur', handler);
  };

  bind('#inMinPx', () => s.scan.minPx, (v) => update({ scan: { minPx: v } }), Number);
  bind('#inMaxItems', () => s.scan.maxItems, (v) => update({ scan: { maxItems: v } }), Number);
  bind('#swBg', () => s.scan.includeBackground, (v) => update({ scan: { includeBackground: v } }));
  bind('#swMeta', () => s.scan.includeMeta, (v) => update({ scan: { includeMeta: v } }));
  bind('#swLazy', () => s.scan.includeLazy, (v) => update({ scan: { includeLazy: v } }));
  bind('#swLinks', () => s.scan.includeLinks, (v) => update({ scan: { includeLinks: v } }));

  bind('#inHoverPx', () => s.hover.minPx, (v) => update({ hover: { minPx: v } }), Number);
  bind('#inMaxMB', () => s.importRules.maxMB, (v) => update({ importRules: { maxMB: Math.max(1, v) } }), Number);

  const txt = $('#txtExcluded');
  txt.value = (s.excludedSites || []).join('\n');
  txt.addEventListener('blur', () => {
    const list = txt.value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    update({ excludedSites: list });
  });
}

/* ------------------------------ 数据 ------------------------------ */

async function renderData() {
  const stats = await getStats();
  const grid = $('#statGrid');
  const cells = [
    ['条目总数', stats.total],
    ['图片', stats.images],
    ['视频', stats.videos],
    ['仅链接记录', stats.links],
    ['已上传', stats.uploaded],
    ['本地占用', formatBytes(stats.bytes)],
    ['收藏', stats.favorites],
    ['来源站点', Object.keys(stats.bySite).length],
  ];
  grid.innerHTML = cells.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}

async function exportAll() {
  try {
    const manifest = await exportManifest();
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mediavault-manifest-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`已导出 ${manifest.count} 条元数据`);
  } catch (err) {
    toast(`导出失败：${err.message || err}`, true);
  }
}

async function importFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const manifest = JSON.parse(await file.text());
    const added = await importManifest(manifest);
    await renderData();
    toast(`已导入 ${added} 条元数据（文件本体不包含在内）`);
  } catch (err) {
    toast(`导入失败：${err.message || err}`, true);
  }
}

async function clearAllData() {
  if (!confirm('确定清空全部本地数据？条目与本地副本都会删除，已上传到外部站点的文件不受影响，操作不可恢复。')) return;
  try {
    await clearAll();
    await renderData();
    toast('已清空本地个人空间');
  } catch (err) {
    toast(`清空失败：${err.message || err}`, true);
  }
}

/* ------------------------------ 小工具 ------------------------------ */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message || err}`, true, 5000);
});
