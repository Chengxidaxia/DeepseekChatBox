'use strict';
/**
 * CPL 能力桥：把 117 个 API 真正实现出来
 *
 * 所有能力都通过 ctx 拿到宿主：store / registry / kv / 插件目录 / AI 通道。
 * 宿主没有的能力一律显式报错，不返回假成功。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tryParseId } = require('./ids.cjs');
const { HOOK_SPECS, API_SPECS } = require('./catalog.cjs');

const HOOK_INDEX = HOOK_SPECS.map(([id, desc]) => ({ id, desc }));
const API_INDEX = API_SPECS.map(([id, desc, params]) => ({ id, desc, params }));

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(ts, f = 'YYYY-MM-DD HH:mm:ss') {
  const d = ts instanceof Date ? ts : new Date(Number(ts) || Date.now());
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const map = {
    YYYY: d.getFullYear(), MM: p(d.getMonth() + 1), DD: p(d.getDate()),
    HH: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
    SSS: p(d.getMilliseconds(), 3),
  };
  return f.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (k) => map[k]);
}

function truncate(text, max, tail = '…') {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, Math.max(0, max - tail.length)) + tail;
}

/**
 * @param {{ cpl: object, plugin: object }} arg
 */
function createApiBridge({ cpl, plugin }) {
  const ns = plugin.meta.ns;
  const dataDir = path.join(cpl.pluginsDir, ns);
  const kvFile = path.join(dataDir, '_kv.json');
  const cfgFile = path.join(dataDir, '_config.json');

  const kvCache = cpl._kvCacheFor(ns, kvFile);
  const cfgCache = cpl._cfgCacheFor(ns, cfgFile, plugin.meta.config);

  const deny = (what) => { throw new Error(`权限不足：插件 ${ns} 未声明 ${what} 权限`); };
  const need = (perm) => {
    if (!plugin.meta.permissions.includes(perm)) deny(perm);
  };

  const safeRel = (rel) => {
    const p = path.resolve(dataDir, String(rel || '').replace(/\\/g, '/'));
    if (!p.startsWith(path.resolve(dataDir) + path.sep) && p !== path.resolve(dataDir)) {
      throw new Error(`路径越界（只允许插件自己的目录）：${rel}`);
    }
    return p;
  };

  const hostConv = () => cpl.host.getCurrentConv?.() || null;
  const hostConvs = () => cpl.host.getConversations?.() || [];

  const findConv = (id) => (id ? hostConvs().find((c) => c.id === id) : hostConv());

  const bridge = {
    /* ------------------------------ messages ------------------------------ */
    messages: {
      list(convId) {
        const c = findConv(convId);
        return c ? (c.messages || []).slice() : [];
      },
      get(convId, msgId) {
        if (msgId === undefined) { msgId = convId; convId = undefined; }
        const c = findConv(convId);
        return (c?.messages || []).find((m) => m.id === msgId) || null;
      },
      find(convId, predicate) {
        if (typeof predicate !== 'function') return [];
        const c = findConv(convId);
        return (c?.messages || []).filter(predicate);
      },
      append(convId, message) {
        if (message === undefined) { message = convId; convId = undefined; }
        const c = findConv(convId);
        if (!c) throw new Error('没有活动会话');
        const m = { id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, role: 'assistant', content: '', ...message };
        c.messages.push(m);
        cpl.host.touchConv?.(c);
        return m;
      },
      update(convId, msgId, patch) {
        if (patch === undefined) { patch = msgId; msgId = convId; convId = undefined; }
        const c = findConv(convId);
        const m = (c?.messages || []).find((x) => x.id === msgId);
        if (!m) return null;
        Object.assign(m, patch);
        cpl.host.touchConv?.(c);
        return m;
      },
      remove(convId, msgId) {
        if (msgId === undefined) { msgId = convId; convId = undefined; }
        const c = findConv(convId);
        if (!c) return false;
        const i = (c.messages || []).findIndex((x) => x.id === msgId);
        if (i === -1) return false;
        c.messages.splice(i, 1);
        cpl.host.touchConv?.(c);
        return true;
      },
      clear(convId) {
        const c = findConv(convId);
        if (!c) return false;
        c.messages = [];
        cpl.host.touchConv?.(c);
        return true;
      },
      count(convId) { return (findConv(convId)?.messages || []).length; },
    },

    /* -------------------------------- convs ------------------------------- */
    convs: {
      list() { return hostConvs().map((c) => ({ id: c.id, title: c.title, groupId: c.groupId, pinned: c.pinned, updatedAt: c.updatedAt })); },
      get(id) { return findConv(id) || null; },
      current() { return hostConv(); },
      create(title) { return cpl.host.createConv?.(title) || null; },
      delete(id) { return Boolean(cpl.host.deleteConv?.(id)); },
      rename(id, title) { return Boolean(cpl.host.renameConv?.(id, title)); },
      switch(id) { return Boolean(cpl.host.switchConv?.(id)); },
      pin(id, pinned) { return Boolean(cpl.host.pinConv?.(id, pinned)); },
      move(id, groupId) { return Boolean(cpl.host.moveConv?.(id, groupId)); },
      export(id) { return cpl.host.exportConv?.(id) ?? null; },
      import(payload) { return cpl.host.importConv?.(payload) ?? null; },
    },

    /* -------------------------------- groups ------------------------------ */
    groups: {
      list() { return cpl.host.getGroups?.() || []; },
      create(name) { return cpl.host.createGroup?.(name) || null; },
      rename(id, name) { return Boolean(cpl.host.renameGroup?.(id, name)); },
      delete(id) { return Boolean(cpl.host.deleteGroup?.(id)); },
      move(id, index) { return Boolean(cpl.host.moveGroup?.(id, index)); },
    },

    /* -------------------------------- tools ------------------------------- */
    tools: {
      register(tool) {
        need('tools');
        if (!tool || !tool.name) throw new Error('tools.register 需要 name');
        const r = cpl.registry.registerTool({
          ns, id: tool.name,
          def: {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description || '',
              parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false },
            },
          },
          handler: typeof tool.handler === 'function' ? tool.handler : (async () => ({ ok: false, text: '插件工具没有实现' })),
          plugin: ns,
          order: tool.order,
          builtin: Boolean(plugin.meta.builtin),
        });
        if (!r.ok) throw new Error(r.reason);
        return r.fullId;
      },
      unregister(name) { return cpl.registry.unregisterTool(ns, name); },
      list() { return cpl.registry.toolDefinitions(); },
      get(name) { const t = cpl.registry.getTool(name); return t ? t.def : null; },
      async call(name, args) { return cpl.callTool(name, args, { caller: ns }); },
      names() { return cpl.registry.toolNames(); },
    },

    /* -------------------------------- hooks ------------------------------- */
    hooks: {
      register(spec) { return cpl.registerHookFor(ns, spec); },
      unregister(hookId) { return cpl.unregisterHookFor(ns, hookId); },
      list(hookId) {
        if (hookId) return (cpl.registry.hooks.get(hookId) || []).map((h) => h.fullId);
        return [...cpl.registry.hooks.keys()];
      },
      async emit(hookId, ctx) { return cpl.emit(hookId, ctx || {}, { from: ns }); },
    },

    /* -------------------------------- events ------------------------------ */
    events: {
      on(name, fn) { cpl.on(`${ns}:${name}`, fn); return () => cpl.off(`${ns}:${name}`, fn); },
      once(name, fn) {
        const wrap = (...a) => { cpl.off(`${ns}:${name}`, wrap); fn(...a); };
        cpl.on(`${ns}:${name}`, wrap);
        return () => cpl.off(`${ns}:${name}`, wrap);
      },
      off(name, fn) { return cpl.off(`${ns}:${name}`, fn); },
      emit(name, payload) { return cpl.emitEvent(`${ns}:${name}`, payload); },
    },

    /* ---------------------------------- kv -------------------------------- */
    kv: {
      get(key, fallback = null) { const v = kvCache.get(String(key)); return v === undefined ? fallback : v; },
      set(key, value) { kvCache.set(String(key), value); return true; },
      delete(key) { return kvCache.delete(String(key)); },
      keys(prefix = '') { return [...kvCache.keys()].filter((k) => k.startsWith(prefix)); },
      clear() { kvCache.clear(); return true; },
      incr(key, delta = 1) {
        const n = Number(kvCache.get(String(key)) || 0) + Number(delta || 0);
        kvCache.set(String(key), n);
        return n;
      },
    },

    /* -------------------------------- config ------------------------------ */
    config: {
      get(key, fallback = null) { const v = cfgCache.get(String(key)); return v === undefined ? fallback : v; },
      set(key, value) { cfgCache.set(String(key), value); return true; },
      all() { return Object.fromEntries(cfgCache); },
      schema() { return plugin.meta.config || null; },
    },

    /* --------------------------------- net -------------------------------- */
    net: {
      async fetch(url, opts = {}) {
        need('net');
        const u = String(url || '');
        if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https');
        const r = await fetch(u, {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          body: opts.body,
          signal: AbortSignal.timeout(Math.min(60000, Math.max(1000, Number(opts.timeout) || 20000))),
          redirect: 'follow',
        });
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type') || '';
        const text = buf.toString('utf8');
        const maxChars = Math.min(200000, Math.max(200, Number(opts.maxChars) || 20000));
        return {
          ok: r.ok, status: r.status, statusText: r.statusText, url: r.url,
          headers: Object.fromEntries(r.headers.entries()),
          contentType: ct,
          text: text.slice(0, maxChars),
          truncated: text.length > maxChars,
          bytes: buf.length,
        };
      },
      async get(url, opts = {}) { const r = await bridge.net.fetch(url, { ...opts, method: 'GET' }); return r.text; },
      async post(url, body, opts = {}) {
        const r = await bridge.net.fetch(url, { ...opts, method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
        return r.text;
      },
      async head(url) {
        need('net');
        const r = await fetch(String(url), { method: 'HEAD', signal: AbortSignal.timeout(15000) });
        return { ok: r.ok, status: r.status, headers: Object.fromEntries(r.headers.entries()) };
      },
      async download(url, opts = {}) {
        need('net');
        const r = await fetch(String(url), { signal: AbortSignal.timeout(30000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const max = Number(opts.maxBytes) || 16 * 1024 * 1024;
        if (buf.length > max) throw new Error(`下载超过 ${fmtBytes(max)}`);
        return buf;
      },
    },

    /* ---------------------------------- fs -------------------------------- */
    fs: {
      read(relPath, encoding = 'utf8') {
        need('fs');
        const p = safeRel(relPath);
        const buf = fs.readFileSync(p);
        return encoding === 'buffer' ? buf : buf.toString(encoding === 'base64' ? 'base64' : 'utf8');
      },
      write(relPath, data) {
        need('fs');
        const p = safeRel(relPath);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.isBuffer(data) ? data : String(data));
        return true;
      },
      exists(relPath) { return fs.existsSync(safeRel(relPath)); },
      list(relDir = '.') {
        const p = safeRel(relDir);
        if (!fs.existsSync(p)) return [];
        return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
      },
      remove(relPath) {
        need('fs');
        const p = safeRel(relPath);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        return true;
      },
      mkdir(relDir) { need('fs'); fs.mkdirSync(safeRel(relDir), { recursive: true }); return true; },
    },

    /* ---------------------------------- ui -------------------------------- */
    ui: {
      toast(text, level = 'info') { return cpl.pushUi({ kind: 'toast', plugin: ns, text: String(text), level }); },
      notify(text, opts = {}) { return cpl.pushUi({ kind: 'notify', plugin: ns, text: String(text), ...opts }); },
      dialog(html, opts = {}) { return cpl.pushUi({ kind: 'dialog', plugin: ns, html: String(html), ...opts }); },
      confirm(text) { return cpl.pushUi({ kind: 'confirm', plugin: ns, text: String(text) }); },
      addComposerButton(spec) { return cpl.pushUi({ kind: 'composerButton', plugin: ns, ...spec }); },
      addSettingsSection(spec) { return cpl.pushUi({ kind: 'settingsSection', plugin: ns, ...spec }); },
      addMessageAction(spec) { return cpl.pushUi({ kind: 'messageAction', plugin: ns, ...spec }); },
      addSidebarItem(spec) { return cpl.pushUi({ kind: 'sidebarItem', plugin: ns, ...spec }); },
      addCommand(spec) { return cpl.pushUi({ kind: 'command', plugin: ns, ...spec }); },
      addSlashCommand(spec) { return cpl.pushUi({ kind: 'slashCommand', plugin: ns, ...spec }); },
      setThemeToken(name, value) { return cpl.pushUi({ kind: 'themeToken', plugin: ns, name: String(name), value: String(value) }); },
      openUrl(url) { return cpl.pushUi({ kind: 'openUrl', plugin: ns, url: String(url) }); },
    },

    /* ---------------------------------- log ------------------------------- */
    log: {
      debug: (...a) => cpl.pluginLog(ns, 'debug', a),
      info: (...a) => cpl.pluginLog(ns, 'info', a),
      warn: (...a) => cpl.pluginLog(ns, 'warn', a),
      error: (...a) => cpl.pluginLog(ns, 'error', a),
    },

    /* --------------------------------- util ------------------------------- */
    util: {
      uuid() { return crypto.randomUUID(); },
      hash(text, alg = 'sha256') {
        const a = String(alg).toLowerCase();
        const ok = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512'];
        if (!ok.includes(a)) throw new Error(`不支持的算法：${alg}`);
        return crypto.createHash(a).update(String(text)).digest('hex');
      },
      base64: {
        encode: (text) => Buffer.from(String(text), 'utf8').toString('base64'),
        decode: (text) => Buffer.from(String(text), 'base64').toString('utf8'),
      },
      json: {
        parse(text, fallback = null) { try { return JSON.parse(String(text)); } catch { return fallback; } },
        stringify(value, pretty = false) { return JSON.stringify(value, null, pretty ? 2 : 0); },
      },
      sleep(ms) { return new Promise((r) => setTimeout(r, Math.min(30000, Math.max(0, Number(ms) || 0)))); },
      clamp(v, min, max) { return Math.min(max, Math.max(min, Number(v))); },
      format(tpl, vars = {}) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); },
      slug(text) {
        return String(text).trim().toLowerCase()
          .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
          .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'item';
      },
      random(min = 0, max = 1) {
        if (arguments.length === 0) return Math.random();
        if (arguments.length === 1 && Array.isArray(min)) return min[Math.floor(Math.random() * min.length)];
        return Number(min) + Math.random() * (Number(max) - Number(min));
      },
      now() { return Date.now(); },
      date: {
        format: (ts, fmt) => fmtDate(ts, fmt),
        diff(a, b, unit = 'ms') {
          const d = Math.abs(new Date(b).getTime() - new Date(a).getTime());
          const div = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 1;
          return Math.floor(d / div);
        },
      },
      bytes: fmtBytes,
      truncate,
      deepMerge(a, b) {
        const out = Array.isArray(a) ? a.slice() : { ...(a || {}) };
        for (const [k, v] of Object.entries(b || {})) {
          out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
            ? bridge.util.deepMerge(out[k], v) : v;
        }
        return out;
      },
      template(tpl, vars) { return bridge.util.format(tpl, vars); },
    },

    /* ----------------------------------- ai ------------------------------- */
    ai: {
      async complete(prompt, opts = {}) { return cpl.host.aiComplete?.(String(prompt), opts) ?? (() => { throw new Error('宿主未提供 AI 通道'); })(); },
      async chat(messages, opts = {}) { return cpl.host.aiChat?.(messages, opts) ?? (() => { throw new Error('宿主未提供 AI 通道'); })(); },
      async summarize(text, opts = {}) {
        const prompt = `请把下面的内容压缩成简洁摘要，保留关键事实、数字与结论：\n\n${text}`;
        return bridge.ai.complete(prompt, opts);
      },
      async compressHistory(messages, opts = {}) { return cpl.host.aiCompress?.(messages, opts) ?? (() => { throw new Error('宿主未提供压缩通道'); })(); },
    },

    /* ---------------------------------- ctx ------------------------------- */
    ctx: {
      countTokens(text) { return cpl.host.countTokens?.(String(text)) ?? Math.ceil(String(text).length / 1.6); },
      truncate(text, maxTokens) {
        const t = String(text);
        const per = Math.max(1, cpl.host.countTokens?.('测') || 1);
        const maxChars = Math.floor(Number(maxTokens) * per);
        return t.length <= maxChars ? t : t.slice(0, maxChars);
      },
      systemPrompt() { return cpl.host.getSystemPrompt?.() || ''; },
      messages(convId) { return bridge.messages.list(convId); },
    },

    /* -------------------------------- plugin ------------------------------ */
    plugin: {
      info() { return { ...plugin.meta, status: plugin.status, stats: plugin.stats }; },
      self() { return ns; },
      version() { return plugin.meta.uniqueVersion; },
      dataDir() { return dataDir; },
      config() { return bridge.config.all(); },
    },

    /* ---------------------------------- cpl ------------------------------- */
    cpl: {
      version() { return cpl.version; },
      plugins() { return cpl.listPlugins().map((p) => ({ id: p.meta.ns, name: p.meta.name, version: p.meta.uniqueVersion, enabled: p.enabled })); },
      emit(hookId, ctx) { return cpl.emit(hookId, ctx || {}, { from: ns }); },
      hooks() { return HOOK_INDEX; },
      apis() { return API_INDEX; },
    },

    /* --------------------------------- store ------------------------------ */
    store: {
      settings() { return cpl.host.publicSettings?.() || {}; },
      patchSettings(patch) {
        need('store');
        return cpl.host.patchSettings?.(patch) || null;
      },
      apiKeyPreview() { return cpl.host.keyPreview?.() || ''; },
    },

    /* -------------------------------- platform ---------------------------- */
    platform: {
      info() {
        return {
          platform: process.platform, arch: process.arch,
          node: process.version, cpl: cpl.version,
          dataDir: cpl.dataDir, pluginsDir: cpl.pluginsDir,
          plugin: ns, uniqueVersion: plugin.meta.uniqueVersion,
        };
      },
      node() { return process.version; },
      isWindows() { return process.platform === 'win32'; },
    },
  };

  return bridge;
}

module.exports = { createApiBridge, HOOK_INDEX, API_INDEX, fmtBytes, fmtDate, truncate };
