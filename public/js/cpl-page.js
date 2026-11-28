/* CPL 插件管理页（本地模式 / 云端模式通用）
 *
 * 布局照抄 Fabric 的 Mod Menu（ModsScreen / ModListEntry / DescriptionListWidget）：
 *   左栏：标题居中 → 搜索框（右侧过滤图标按钮）→ 排序按钮 → 计数 → 列表
 *   右栏：图标 + 名称 + 版本 + "By 作者" + 右上角配置图标按钮
 *          → 「主页」「日志」两个按钮 → 描述区
 *   底部：两个等宽按钮（Mod Menu 是 Open Mods Folder / Done）
 * 自创部分：启用开关、卸载按钮（Mod Menu 的启停由各模组自己的配置屏负责）。
 */
import { h, toast } from './util.js';
import { appConfirm } from './dialog.js';

const CLOUD_KEY = 'cpl.plugins.v1';

const STATUS_TEXT = { enabled: '已启用', disabled: '已禁用', error: '加载失败', installed: '已安装' };
const FILTERS = [
  { id: 'all', name: '全部', hint: '显示所有插件' },
  { id: 'enabled', name: '已启用', hint: '只看正在运行的插件' },
  { id: 'disabled', name: '已禁用', hint: '只看停用的插件' },
  { id: 'error', name: '有问题', hint: '加载失败或存在冲突' },
];
const SORTS = [
  { id: 'name', name: '名称' },
  { id: 'status', name: '状态' },
  { id: 'loaded', name: '加载顺序' },
];

function icon(id, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico ' + cls);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

async function api(path, opt) {
  const r = await fetch(path, opt);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error((j && (j.error || j.text)) || `HTTP ${r.status}`);
  return j;
}

/* 云端插件存在浏览器（按账号/设备天然隔离），结构对齐服务端返回的 publicPlugin */
function cloudLoad() {
  try {
    const list = JSON.parse(localStorage.getItem(CLOUD_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function cloudSave(list) {
  try { localStorage.setItem(CLOUD_KEY, JSON.stringify(list)); } catch {}
}
function cloudToPlugin(pkg, enabled = true) {
  const m = pkg.meta || {};
  const methods = pkg.methods || [];
  return {
    id: m.ns, name: m.name, version: m.version, uniqueVersion: m.uniqueVersion,
    description: m.description, author: m.author, homepage: m.homepage, license: m.license,
    keywords: m.keywords || [], permissions: m.permissions || [],
    requires: m.requires || [], loadAfter: m.loadAfter || [], loadBefore: m.loadBefore || [],
    conflicts: m.conflicts || [], config: m.config || null,
    builtin: false, enabled, status: enabled ? 'enabled' : 'disabled', error: null,
    loadedAt: Date.now(),
    stats: pkg.stats || { methods: methods.length },
    counts: {
      tools: 0,
      hooks: methods.reduce((n, x) => n + (x.actions || []).length, 0),
      apis: 0,
      ui: 0,
    },
    iconData: pkg.icon || null,
    cloudPkg: pkg,
  };
}

/** 是否为独立的插件管理页路由：/cpl、/cpl/（也兼容 #/cpl，云端静态托管下的保底入口） */
export function isCplRoute(pathname = location.pathname, hash = location.hash) {
  return /^\/cpl\/?$/.test(pathname) || /^#\/?cpl\/?$/.test(hash || '');
}

/** 独立页的返回地址：路径式路由回根，hash 式路由去掉 hash */
function cplBackHref() {
  if (/^\/cpl\/?$/.test(location.pathname)) return '/';
  return location.pathname + location.search;
}

/**
 * 独立页面 /cpl：整页插件管理，不进入聊天界面、不参与会话路由。
 * 调用方（boot）负责：已拉完 store / 已套主题与语言，然后 return。
 */
export function mountCplStandalone() {
  document.title = '插件 · Deepseek ChatBox';
  document.body.classList.add('cpl-standalone');
  const appEl = document.getElementById('app');
  if (appEl) appEl.hidden = true;

  const page = h('div', { class: 'cpl-mm' });
  document.body.append(page);
  page.append(pluginsTab({ back: cplBackHref() }));
}

/**
 * @param {{ onChanged?: Function, back?: string }} opt
 */
export function pluginsTab({ onChanged, back = '/' } = {}) {
  let data = { plugins: [], stats: {}, limits: {}, mode: 'local', version: '', allowScripts: true };
  let cloudPlugins = cloudLoad();
  let logCache = [];
  let filter = 'all';
  let sort = 'name';
  let query = '';
  let selectedId = null;

  const isCloud = () => data.mode === 'cloud';

  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) return toast('只接受 .zip 插件包');
    toast('正在安装 ' + f.name + ' …');
    try {
      const buf = await f.arrayBuffer();
      if (isCloud()) {
        const r = await api('/api/cpl/inspect', {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: buf,
        });
        const id = r.pkg.meta.ns;
        cloudPlugins = cloudPlugins.filter((p) => p.id !== id);
        cloudPlugins.push(cloudToPlugin(r.pkg, true));
        cloudSave(cloudPlugins);
        toast(`已安装：${r.pkg.meta.name}`);
        selectedId = id;
      } else {
        const r = await api('/api/cpl/install', {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: buf,
        });
        toast(`已安装：${r.plugin.name}`);
        selectedId = r.plugin.id;
      }
      await load();
      onChanged?.();
    } catch (e) {
      toast('安装失败：' + e.message);
    }
  });

  function badge(status) {
    const cls = status === 'enabled' ? 'ok' : status === 'error' ? 'bad' : 'off';
    return h('span', { class: 'cpl-badge ' + cls, text: STATUS_TEXT[status] || status });
  }

  /* 图标地址由服务端给出（iconUrl）：内置插件指向 assets，第三方插件指向 /api/cpl/icon/<ns>。
   * 前端不再维护 id→文件名 的映射，新增内置插件不用改这里。
   * 最后那行是兼容旧服务端（还没重启、不返回 iconUrl 的情况），否则图标会整排变成扳手。 */
  function iconSrc(p) {
    if (p.iconData) return p.iconData;
    if (p.iconUrl) return p.iconUrl;
    if (p.builtin) return `/assets/plugin-${encodeURIComponent(p.id)}.png`;
    return '';
  }

  /** 图标：32px（列表与详情同尺寸，与 Mod Menu 一致）；加载失败回落到工具图标 */
  function avatar(p, size = 32) {
    const src = iconSrc(p);
    if (!src) return h('div', { class: 'cpl-mm-avatar fallback', style: { width: size + 'px', height: size + 'px' } }, [icon('i-wrench')]);
    const img = h('img', { class: 'cpl-mm-avatar', src, alt: '', loading: 'lazy', style: { width: size + 'px', height: size + 'px' } });
    img.addEventListener('error', () => img.replaceWith(
      h('div', { class: 'cpl-mm-avatar fallback', style: { width: size + 'px', height: size + 'px' } }, [icon('i-wrench')]),
    ), { once: true });
    return img;
  }

  async function togglePlugin(p) {
    if (p.builtin) return toast('核心插件不能禁用');
    if (isCloud()) {
      cloudPlugins = cloudPlugins.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled, status: !x.enabled ? 'enabled' : 'disabled' } : x));
      cloudSave(cloudPlugins);
      await load();
      onChanged?.();
      return;
    }
    await api(`/api/cpl/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
    await load();
    onChanged?.();
  }

  async function removePlugin(p) {
    if (p.builtin) return toast('核心插件不能卸载');
    const ok = await appConfirm(`删除插件「${p.name}」？插件数据（KV / 配置）会一并删除。`);
    if (!ok) return;
    if (isCloud()) {
      cloudPlugins = cloudPlugins.filter((x) => x.id !== p.id);
      cloudSave(cloudPlugins);
      await load();
      onChanged?.();
      return;
    }
    await api(`/api/cpl/plugins/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (selectedId === p.id) selectedId = null;
    await load();
    onChanged?.();
  }

  async function saveConfig(p, rows) {
    const patch = {};
    for (const row of rows) {
      const inp = row.querySelector('input');
      patch[inp.dataset.key] = inp.value;
    }
    if (isCloud()) {
      cloudPlugins = cloudPlugins.map((x) => (x.id === p.id
        ? { ...x, cloudPkg: { ...x.cloudPkg, meta: { ...x.cloudPkg.meta, config: { ...(x.cloudPkg.meta.config || {}), ...patch } } } }
        : x));
      cloudSave(cloudPlugins);
      toast('配置已保存（浏览器侧）');
      await load();
      return;
    }
    try {
      await api(`/api/cpl/plugins/${encodeURIComponent(p.id)}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      toast('配置已保存');
      await load();
    } catch (e) { toast('保存失败：' + e.message); }
  }

  /* ------------------------------- 左栏 ------------------------------- */

  const elSearch = h('input', { class: 'cpl-mm-search', type: 'search', placeholder: '搜索插件（名称 / ID / 关键词）' });
  elSearch.addEventListener('input', () => { query = elSearch.value.trim().toLowerCase(); renderList(); });

  const elFilter = h('button', { class: 'cpl-mm-iconbtn', type: 'button' }, [icon('i-filter')]);
  elFilter.addEventListener('click', () => {
    const i = FILTERS.findIndex((f) => f.id === filter);
    const next = FILTERS[(i + 1) % FILTERS.length];
    filter = next.id;
    toast(`${next.name}：${next.hint}`);
    render();
  });

  const elSort = h('button', { class: 'cpl-mm-btn small', type: 'button' });
  elSort.addEventListener('click', () => {
    const i = SORTS.findIndex((s) => s.id === sort);
    sort = SORTS[(i + 1) % SORTS.length].id;
    render();
  });

  const elCount = h('div', { class: 'cpl-mm-count' });
  const elList = h('div', { class: 'cpl-mm-list' });

  function visiblePlugins() {
    const list = data.plugins || [];
    const q = query;
    let out = list.filter((p) => {
      if (filter === 'enabled' && !(p.enabled && p.status !== 'error')) return false;
      if (filter === 'disabled' && p.enabled) return false;
      if (filter === 'error' && p.status !== 'error' && !(p.conflicts || []).length) return false;
      if (!q) return true;
      const hay = [p.id, p.name, p.description, p.author, ...(p.keywords || [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
    const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh');
    if (sort === 'name') out = out.sort(byName);
    else if (sort === 'status') out = out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || byName(a, b));
    else out = out.sort((a, b) => (a.loadedAt || 0) - (b.loadedAt || 0));
    return out;
  }

  function listRow(p) {
    const active = p.id === selectedId;
    const ver = p.version ? `v${p.version}` : String(p.uniqueVersion ?? '');
    const row = h('button', {
      class: 'cpl-mm-row' + (active ? ' on' : '') + (p.status === 'error' ? ' bad' : ''),
      type: 'button',
      title: `${p.id} · ${STATUS_TEXT[p.status] || p.status}`,
    }, [
      avatar(p),
      h('div', { class: 'cpl-mm-rowtext' }, [
        h('div', { class: 'cpl-mm-rowtitle' }, [
          h('span', { class: 'cpl-mm-rowname', text: p.name || p.id }),
          p.status === 'error' ? h('span', { class: 'cpl-mm-dot bad', title: '加载失败' }) : null,
          !p.enabled && p.status !== 'error' ? h('span', { class: 'cpl-mm-dot off', title: '已禁用' }) : null,
        ].filter(Boolean)),
        h('div', { class: 'cpl-mm-rowsub', text: p.description || `${p.id}@${p.uniqueVersion} · ${ver}` }),
      ]),
    ]);
    row.addEventListener('click', () => { selectedId = p.id; render(); });
    return row;
  }

  function renderList() {
    const all = (data.plugins || []).length;
    const list = visiblePlugins();
    elCount.textContent = list.length === all
      ? `（${all} 个插件）`
      : `（${list.length} / ${all} 个插件）`;
    elSort.replaceChildren(icon('i-sort'), h('span', { text: '排序：' + (SORTS.find((s) => s.id === sort)?.name || '名称') }));
    elFilter.title = `筛选：${FILTERS.find((f) => f.id === filter)?.name}（点击切换）`;
    elFilter.classList.toggle('on', filter !== 'all');
    elList.replaceChildren(...(list.length ? list.map(listRow) : [
      h('div', { class: 'cpl-mm-empty', text: query ? '没有匹配的插件' : '还没有安装插件' }),
    ]));
  }

  /* ------------------------------- 右栏 ------------------------------- */

  const elRight = h('div', { class: 'cpl-mm-detail' });

  function current() {
    return (data.plugins || []).find((p) => p.id === selectedId) || null;
  }

  function kv(label, value) {
    return h('div', { class: 'cpl-mm-kv' }, [
      h('span', { class: 'k', text: label }),
      h('span', { class: 'v', text: value }),
    ]);
  }

  function configBlock(p) {
    const cfg = p.config && typeof p.config === 'object' ? p.config : null;
    if (!cfg) return null;
    const rows = Object.entries(cfg).map(([k, v]) => {
      const def = v && typeof v === 'object' && 'default' in v ? v.default : v;
      const title = (v && typeof v === 'object' && v.title) || k;
      const saved = p.cloudPkg?.meta?.config?.[k];
      const cur = saved !== undefined && typeof saved !== 'object' ? saved : def;
      const inp = h('input', { class: 'cpl-cfg-input' });
      inp.value = cur === undefined || cur === null ? '' : String(cur);
      inp.dataset.key = k;
      return h('div', { class: 'cpl-cfg-row' }, [h('label', { text: title }), inp]);
    });
    if (!rows.length) return null;
    return h('section', { class: 'cpl-mm-section', id: 'cpl-config' }, [
      h('div', { class: 'cpl-mm-h', text: '配置' }),
      ...rows,
      h('button', {
        class: 'cpl-mm-btn', type: 'button',
        onclick: () => saveConfig(p, rows),
      }, [h('span', { text: '保存配置' })]),
    ]);
  }

  function logBlock(p) {
    if (isCloud()) return null;
    const logs = logCache.filter((l) => l.plugin === p.id).slice(-30);
    return h('section', { class: 'cpl-mm-section', id: 'cpl-logs' }, [
      h('div', { class: 'cpl-mm-h', text: `日志（最近 ${logs.length} 条）` }),
      logs.length
        ? h('pre', { class: 'cpl-logs', text: logs.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.level} ${l.text}`).join('\n') })
        : h('div', { class: 'help', text: '暂无日志' }),
    ]);
  }

  function detailHead(p) {
    const configure = h('button', {
      class: 'cpl-mm-iconbtn',
      type: 'button',
      title: p.config ? '跳到配置' : '这个插件没有可配置项',
      disabled: !p.config,
    }, [icon('i-settings')]);
    configure.addEventListener('click', () => {
      document.getElementById('cpl-config')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return h('div', { class: 'cpl-mm-dhead' }, [
      avatar(p),
      h('div', { class: 'cpl-mm-dheadtext' }, [
        h('div', { class: 'cpl-mm-dname', text: p.name || p.id }),
        h('div', { class: 'cpl-mm-dver', text: [p.version ? `v${p.version}` : '', p.builtin ? '内置' : `By ${p.author || '未注明'}`].filter(Boolean).join('  ·  ') }),
      ]),
      configure,
    ]);
  }

  function detailActions(p) {
    const site = h('button', { class: 'cpl-mm-btn half', type: 'button', disabled: !p.homepage }, [h('span', { text: '主页' })]);
    site.addEventListener('click', () => { if (p.homepage) window.open(p.homepage, '_blank', 'noopener'); });

    const logs = h('button', { class: 'cpl-mm-btn half', type: 'button', disabled: isCloud() }, [h('span', { text: '日志' })]);
    logs.addEventListener('click', () => {
      document.getElementById('cpl-logs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return h('div', { class: 'cpl-mm-actions' }, [site, logs]);
  }

  function detailBody(p) {
    const counts = p.counts || {};
    const st = p.stats || {};
    /* 「实现方式」说清楚为什么内置插件的方法/脚本是 0：
     * 它们不是 data.json 方法也不是 js/py 脚本，而是服务端直接注册的内置模块。 */
    const impl = p.builtin
      ? '内置模块（服务端 js，不经过插件包）'
      : [
          st.methods ? `${st.methods} 个 JSON 方法` : '',
          st.scripts ? `${st.scripts} 个脚本` : '',
        ].filter(Boolean).join(' · ') || '声明式（无代码）';
    const metaRows = [
      kv('标识', `${p.id}@${p.uniqueVersion}`),
      kv('语义版本', p.version || '未标注'),
      kv('许可', p.license || '未注明'),
      kv('实现', impl),
      kv('接口', `工具 ${counts.tools || 0} · Hook ${counts.hooks || 0} · API ${counts.apis || 0} · UI ${counts.ui || 0}`),
      p.keywords?.length ? kv('关键词', p.keywords.join(' / ')) : null,
      p.requires?.length ? kv('前置', p.requires.join(', ')) : null,
      p.loadAfter?.length ? kv('加载于其后', p.loadAfter.join(', ')) : null,
      p.loadBefore?.length ? kv('加载于其前', p.loadBefore.join(', ')) : null,
      p.conflicts?.length ? kv('冲突', p.conflicts.join(', ')) : null,
      kv('权限', p.permissions?.length ? p.permissions.join(' / ') : '无（不调用扩展接口）'),
    ].filter(Boolean);

    return [
      h('p', { class: 'cpl-mm-desc', text: p.description || '（无描述）' }),
      p.error ? h('div', { class: 'cpl-error', text: '错误：' + p.error }) : null,
      h('section', { class: 'cpl-mm-section' }, [
        h('div', { class: 'cpl-mm-h', text: '信息' }),
        ...metaRows,
      ]),
      isCloud() ? h('div', { class: 'help', text: '云端模式下插件保存在本浏览器，随账号/设备隔离；换设备需重新安装。' }) : null,
      configBlock(p),
      logBlock(p),
    ].filter(Boolean);
  }

  function detailFoot(p) {
    const sw = h('button', {
      class: 'cpl-mm-btn' + (p.enabled ? ' on' : ''),
      type: 'button',
      disabled: Boolean(p.builtin),
      title: p.builtin ? '核心插件，常驻运行' : (p.enabled ? '点击禁用' : '点击启用'),
    }, [
      h('span', { class: 'cpl-switch' + (p.enabled ? ' on' : '') }, [h('span', { class: 'knob' })]),
      h('span', { text: p.builtin ? '常驻运行' : (p.enabled ? '已启用' : '已禁用') }),
    ]);
    sw.addEventListener('click', async () => {
      try { await togglePlugin(p); } catch (e) { toast('操作失败：' + e.message); }
    });

    const del = h('button', {
      class: 'cpl-mm-btn danger',
      type: 'button',
      disabled: Boolean(p.builtin),
      title: p.builtin ? '核心插件，不可卸载' : '卸载插件',
    }, [icon('i-trash'), h('span', { text: '卸载' })]);
    del.addEventListener('click', async () => {
      try { await removePlugin(p); } catch (e) { toast('删除失败：' + e.message); }
    });

    return h('div', { class: 'cpl-mm-dfoot' }, [sw, del]);
  }

  function detailEmpty() {
    return h('div', { class: 'cpl-mm-empty big' }, [
      h('div', { class: 'cpl-mm-empty-ico' }, [icon('i-puzzle')]),
      h('div', { class: 'cpl-mm-empty-title', text: '选一个插件' }),
      h('div', { class: 'cpl-mm-empty-sub', text: '左边的列表里点一下，这里会显示它的说明、接口计数和运行日志。' }),
    ]);
  }

  function renderDetail() {
    const p = current();
    if (!p) { elRight.replaceChildren(detailEmpty()); return; }
    elRight.replaceChildren(
      h('div', { class: 'cpl-mm-dscroll' }, [detailHead(p), detailActions(p), ...detailBody(p)]),
      detailFoot(p),
    );
  }

  /* ------------------------------- 骨架 ------------------------------- */

  const foot = h('div', { class: 'cpl-mm-foot' }, [
    h('button', { class: 'cpl-mm-footbtn', type: 'button', onclick: () => fileInput.click() }, [
      icon('i-upload'), h('span', { text: '安装插件' }),
    ]),
    isCloud() ? null : h('button', {
      class: 'cpl-mm-footbtn', type: 'button',
      onclick: async () => {
        try {
          const r = await api('/api/cpl/reload', { method: 'POST' });
          toast(`已重载 ${r.loaded} 个插件${r.problems?.length ? '，' + r.problems.length + ' 个问题' : ''}`);
          await load();
          onChanged?.();
        } catch (e) { toast('重载失败：' + e.message); }
      },
    }, [icon('i-refresh'), h('span', { text: '全部重载' })]),
    h('a', { class: 'cpl-mm-footbtn', href: back }, [h('span', { text: '返回对话' })]),
    fileInput,
  ].filter(Boolean));

  const left = h('div', { class: 'cpl-mm-left' }, [
    h('div', { class: 'cpl-mm-titlebar' }, [
      h('a', {
        class: 'cpl-mm-back',
        href: back,
        title: '返回对话',
        'aria-label': '返回对话',
      }, [h('span', { class: 'cpl-mm-back-arrow', text: '←' })]),
      h('div', { class: 'cpl-mm-title', text: '插件' }),
    ]),
    h('div', { class: 'cpl-mm-searchrow' }, [elSearch, elFilter]),
    h('div', { class: 'cpl-mm-sortrow' }, [elSort]),
    elCount,
    elList,
  ]);

  const shell = h('div', { class: 'cpl-mm-body' }, [left, elRight]);

  function render() {
    renderList();
    renderDetail();
  }

  async function load() {
    try {
      const p = await api('/api/cpl/plugins');
      data = p;
      if (isCloud()) {
        // 浏览器侧插件 + 服务端报告的核心插件条目（cdcp / cdcptools / cpl）
        const serverBuiltin = (data.plugins || []).filter((x) => x && x.builtin);
        data.plugins = [...cloudPlugins.map((x) => ({ ...x })), ...serverBuiltin];
        data.stats = {
          tools: 0,
          hooks: (data.plugins || []).reduce((n, x) => n + (x.counts?.hooks || 0), 0),
          apis: 0,
        };
        logCache = [];
      } else {
        logCache = (await api('/api/cpl/logs?limit=300').catch(() => ({ logs: [] }))).logs || [];
      }
    } catch (e) {
      data = { ...data, plugins: isCloud() ? cloudPlugins : [], error: e.message };
    }
    if (!selectedId || !(data.plugins || []).some((p) => p.id === selectedId)) {
      selectedId = (data.plugins || [])[0]?.id || null;
    }
    render();
  }

  load();
  return h('div', { class: 'cpl-page' }, [shell, foot]);
}
