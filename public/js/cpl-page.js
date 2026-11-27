/* CPL 插件管理页（本地模式 / 云端模式通用） */
import { h, toast } from './util.js';
import { t } from './i18n.js';
import { appConfirm } from './dialog.js';

const CLOUD_KEY = 'cpl.plugins.v1';

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

const STATUS_TEXT = { enabled: '已启用', disabled: '已禁用', error: '加载失败', installed: '已安装' };

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

export function pluginsTab({ onChanged } = {}) {
  const root = h('div', { class: 'cpl-page' });
  let data = { plugins: [], stats: {}, limits: {}, mode: 'local', version: '', allowScripts: true };
  let cloudPlugins = cloudLoad();
  const openDetail = new Set();
  let logCache = [];

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
      } else {
        const r = await api('/api/cpl/install', {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: buf,
        });
        toast(`已安装：${r.plugin.name}`);
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

  function pluginIcon(p) {
    if (p.builtin) return h('div', { class: 'cpl-icon builtin' }, [icon('i-wrench')]);
    const fallback = () => h('div', { class: 'cpl-icon builtin' }, [icon('i-puzzle')]);
    if (p.iconData) return h('img', { class: 'cpl-icon', src: p.iconData, alt: '' });
    const img = h('img', { class: 'cpl-icon', src: `/api/cpl/icon/${encodeURIComponent(p.id)}`, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }

  async function togglePlugin(p) {
    if (isCloud()) {
      const list = cloudPlugins.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled, status: !x.enabled ? 'enabled' : 'disabled' } : x));
      cloudPlugins = list;
      cloudSave(list);
      await load();
      onChanged?.();
      return;
    }
    await api(`/api/cpl/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
    await load();
    onChanged?.();
  }

  async function removePlugin(p) {
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
    await load();
    onChanged?.();
  }

  function pluginCard(p) {
    const counts = p.counts || {};
    const isOpen = openDetail.has(p.id);

    const sw = p.builtin ? null : (() => {
      const b = h('button', {
        class: 'cpl-switch' + (p.enabled ? ' on' : ''),
        type: 'button',
        title: p.enabled ? '点击禁用' : '点击启用',
      }, [h('span', { class: 'knob' })]);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await togglePlugin(p); }
        catch (e) { toast('操作失败：' + e.message); }
        finally { b.disabled = false; }
      });
      return b;
    })();

    const head = h('div', { class: 'cpl-card-head' }, [
      pluginIcon(p),
      h('div', { class: 'cpl-title' }, [
        h('div', { class: 'cpl-name' }, [
          h('b', { text: p.name }),
          h('code', { text: `${p.id}@${p.uniqueVersion}` }),
          badge(p.status),
          p.builtin ? h('span', { class: 'cpl-tag', text: '内置' }) : null,
          isCloud() && !p.builtin ? h('span', { class: 'cpl-tag', text: '浏览器侧' }) : null,
        ]),
        h('div', { class: 'cpl-desc', text: p.description || '（无描述）' }),
      ]),
      h('div', { class: 'cpl-actions' }, [
        sw,
        h('button', {
          class: 'cpl-btn ghost', type: 'button',
          onclick: () => { isOpen ? openDetail.delete(p.id) : openDetail.add(p.id); render(); },
        }, [h('span', { text: isOpen ? '收起' : '详情' })]),
        p.builtin ? null : h('button', {
          class: 'cpl-btn danger', type: 'button',
          onclick: async () => {
            try { await removePlugin(p); } catch (e) { toast('删除失败：' + e.message); }
          },
        }, [icon('i-trash')]),
      ]),
    ]);

    const meta = h('div', { class: 'cpl-meta' }, [
      h('span', { text: `工具 ${counts.tools || 0}` }),
      h('span', { text: `Hook ${counts.hooks || 0}` }),
      h('span', { text: `API ${counts.apis || 0}` }),
      h('span', { text: `UI ${counts.ui || 0}` }),
      p.permissions?.length ? h('span', { text: '权限：' + p.permissions.join(' / ') }) : null,
      p.requires?.length ? h('span', { text: '前置：' + p.requires.join(', ') }) : null,
    ]);

    const parts = [head, meta];
    if (p.error) parts.push(h('div', { class: 'cpl-error', text: '错误：' + p.error }));
    if (isOpen) parts.push(detailBlock(p));
    return h('div', { class: 'cpl-card' + (p.status === 'error' ? ' has-error' : '') }, parts);
  }

  function detailBlock(p) {
    const cfg = p.config && typeof p.config === 'object' ? p.config : null;
    const cfgRows = cfg ? Object.entries(cfg).map(([k, v]) => {
      const def = v && typeof v === 'object' && 'default' in v ? v.default : v;
      const title = (v && typeof v === 'object' && v.title) || k;
      const saved = p.cloudPkg?.meta?.config?.[k];
      const cur = saved !== undefined && typeof saved !== 'object' ? saved : def;
      const inp = h('input', { class: 'cpl-cfg-input' });
      inp.value = cur === undefined || cur === null ? '' : String(cur);
      inp.dataset.key = k;
      return h('div', { class: 'cpl-cfg-row' }, [h('label', { text: title }), inp]);
    }) : [];

    const saveBtn = cfgRows.length ? h('button', {
      class: 'cpl-btn', type: 'button',
      onclick: async () => {
        const patch = {};
        for (const row of cfgRows) {
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
      },
    }, [h('span', { text: '保存配置' })]) : null;

    const logs = isCloud() ? [] : logCache.filter((l) => l.plugin === p.id).slice(-20);

    return h('div', { class: 'cpl-detail' }, [
      p.homepage ? h('div', { class: 'cpl-line' }, [
        h('b', { text: '主页' }),
        h('a', { href: p.homepage, target: '_blank', rel: 'noopener noreferrer', text: p.homepage }),
      ]) : null,
      h('div', { class: 'cpl-line' }, [h('b', { text: '作者' }), h('span', { text: p.author || '未注明' })]),
      h('div', { class: 'cpl-line' }, [h('b', { text: '语义版本' }), h('span', { text: p.version || '未标注' })]),
      h('div', { class: 'cpl-line' }, [h('b', { text: '唯一版本号' }), h('span', { text: String(p.uniqueVersion) })]),
      cfgRows.length ? h('div', { class: 'cpl-cfg' }, [h('div', { class: 'cpl-sub', text: '插件配置' }), ...cfgRows, saveBtn]) : null,
      isCloud() ? h('div', { class: 'help', text: '云端模式下插件保存在本浏览器，随账号/设备隔离；换设备需重新安装。' }) : null,
      isCloud() ? null : h('div', { class: 'cpl-sub', text: `运行日志（最近 ${logs.length} 条）` }),
      isCloud() ? null : (logs.length
        ? h('pre', { class: 'cpl-logs', text: logs.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.level} ${l.text}`).join('\n') })
        : h('div', { class: 'help', text: '暂无日志' })),
    ]);
  }

  function headSection() {
    return h('div', { class: 'set-section' }, [
      h('div', { class: 'set-section-title', text: 'CPL 扩展加载器' }),
      h('div', { class: 'help' }, [
        h('span', { text: `版本 ${data.version || '—'} · ${isCloud() ? '云端模式（仅 json 插件，按用户隔离）' : '本地模式'} · 接口 ` }),
        h('b', { text: `${data.limits.hooks || 0} hook / ${data.limits.apis || 0} API` }),
        h('span', { text: `（json 插件可用 ${data.limits.jsonHooks || 0} / ${data.limits.jsonApis || 0}）` }),
      ]),
      h('div', { class: 'cpl-toolbar' }, [
        h('button', {
          class: 'cpl-btn primary', type: 'button',
          onclick: () => fileInput.click(),
        }, [icon('i-upload'), h('span', { text: '安装插件（zip）' })]),
        isCloud() ? null : h('button', {
          class: 'cpl-btn', type: 'button',
          onclick: async () => {
            try {
              const r = await api('/api/cpl/reload', { method: 'POST' });
              toast(`已重载 ${r.loaded} 个插件${r.problems?.length ? '，' + r.problems.length + ' 个问题' : ''}`);
              await load();
              onChanged?.();
            } catch (e) { toast('重载失败：' + e.message); }
          },
        }, [icon('i-refresh'), h('span', { text: '全部重载' })]),
        h('button', {
          class: 'cpl-btn ghost', type: 'button',
          onclick: () => { onChanged?.(); load(); },
        }, [h('span', { text: '刷新' })]),
        fileInput,
      ]),
      h('div', {
        class: 'help',
        text: isCloud()
          ? '云端专版只支持 json 插件（data.json + contents/*.json + assets/ + fav.png），不含 scripts 目录。插件保存在本浏览器并按账号隔离。'
          : '插件包结构：data.json + contents/*.json + scripts/*.js|py + assets/ + fav.png。安装后在服务端加载，卸载即完全移除。',
      }),
    ]);
  }

  function render() {
    const list = data.plugins || [];
    const user = list.filter((p) => !p.builtin);
    const builtin = list.filter((p) => p.builtin);
    const sections = [
      headSection(),
      h('div', { class: 'set-section' }, [
        h('div', { class: 'set-section-title', text: `已安装插件（${user.length}）` }),
        user.length ? h('div', { class: 'cpl-list' }, user.map(pluginCard))
          : h('div', { class: 'help', text: '还没有安装插件。点上方「安装插件」上传 zip。' }),
      ]),
    ];
    if (builtin.length) {
      sections.push(h('div', { class: 'set-section' }, [
        h('div', { class: 'set-section-title', text: `内置（${builtin.length}）` }),
        h('div', { class: 'cpl-list' }, builtin.map(pluginCard)),
      ]));
    }
    root.replaceChildren(...sections);
  }

  async function load() {
    try {
      const p = await api('/api/cpl/plugins');
      data = p;
      if (isCloud()) {
        data.plugins = cloudPlugins.map((x) => ({ ...x }));
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
    render();
  }

  load();
  return [root];
}
