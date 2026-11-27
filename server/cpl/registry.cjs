'use strict';
/**
 * CPL 注册表
 *
 * 承担三件事：
 *   1. 登记：工具 / hook 处理器 / 插件 API / UI 扩展点
 *   2. 排序：按 before / after 做拓扑排序（同层按 order 再按加载序）
 *   3. 仲裁：chatbox 内置 vs 插件 → 插件优先；插件之间 → 后加载者胜并告警
 */

const { parseId, tryParseId, matchVersion, sameTarget } = require('./ids.cjs');

const KIND = {
  TOOL: 'tool',
  HOOK: 'hook',
  API: 'api',
  UI: 'ui',
};

class Registry {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.tools = new Map();       // fullId -> entry
    this.hooks = new Map();       // hookId -> entry[]
    this.apis = new Map();        // fullId -> entry
    this.ui = new Map();          // slot:key -> entry
    this.shadowed = [];           // 被覆盖的记录（诊断用）
    this.conflicts = [];          // 插件间同名冲突
    this._loadSeq = 0;
    this._dirty = true;
    this._sortedHooks = new Map();
  }

  nextSeq() { return ++this._loadSeq; }

  /* ------------------------------- 工具 ------------------------------- */

  /**
   * @param {{ns:string, id:string, def:object, handler:Function, plugin:string, builtin?:boolean, order?:number}} e
   */
  registerTool(e) {
    const fullId = e.ns === 'cdcp' ? e.id : `${e.ns}:${e.id}`;
    const next = {
      fullId, ns: e.ns, id: e.id,
      def: e.def, handler: e.handler,
      plugin: e.plugin, builtin: Boolean(e.builtin),
      order: Number(e.order) || 0, seq: this.nextSeq(),
    };
    const prev = this.tools.get(fullId);
    if (prev) {
      // 内置被插件覆盖是允许的（插件优先）；插件覆盖插件记为冲突
      if (!prev.builtin && next.builtin) {
        this.shadowed.push({ kind: KIND.TOOL, fullId, winner: prev.plugin, loser: next.plugin });
        return { ok: false, reason: 'builtin 不能覆盖用户插件', shadowedBy: prev.plugin };
      }
      if (prev.builtin && !next.builtin) {
        this.shadowed.push({ kind: KIND.TOOL, fullId, winner: next.plugin, loser: prev.plugin, reason: '插件覆盖内置（插件优先）' });
      } else if (!prev.builtin && !next.builtin) {
        this.conflicts.push({ kind: KIND.TOOL, fullId, winner: next.plugin, loser: prev.plugin });
        this.log(`[cpl] 工具冲突 ${fullId}：${next.plugin} 覆盖 ${prev.plugin}`);
      } else {
        this.conflicts.push({ kind: KIND.TOOL, fullId, winner: next.plugin, loser: prev.plugin });
      }
    }
    this.tools.set(fullId, next);
    this._dirty = true;
    return { ok: true, fullId };
  }

  unregisterTool(ns, id) {
    const fullId = ns === 'cdcp' ? id : `${ns}:${id}`;
    const gone = this.tools.delete(fullId);
    if (gone) this._dirty = true;
    return gone;
  }

  /** 按插件卸载它的全部工具 */
  unregisterByPlugin(pluginNs) {
    let n = 0;
    for (const [k, v] of [...this.tools]) if (v.plugin === pluginNs) { this.tools.delete(k); n++; }
    for (const [k, list] of [...this.hooks]) {
      const kept = list.filter((h) => h.plugin !== pluginNs);
      if (kept.length !== list.length) { n += list.length - kept.length; this.hooks.set(k, kept); }
    }
    for (const [k, v] of [...this.apis]) if (v.plugin === pluginNs) { this.apis.delete(k); n++; }
    for (const [k, v] of [...this.ui]) if (v.plugin === pluginNs) { this.ui.delete(k); n++; }
    this._dirty = true;
    return n;
  }

  /** 工具定义（按 order 再按注册序） */
  toolDefinitions() {
    const list = [...this.tools.values()].sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    return list.map((t) => t.def).filter(Boolean);
  }

  toolNames() {
    return [...this.tools.values()].sort((a, b) => (a.order - b.order) || (a.seq - b.seq)).map((t) => t.id);
  }

  getTool(fullIdOrName) {
    if (this.tools.has(fullIdOrName)) return this.tools.get(fullIdOrName);
    for (const t of this.tools.values()) if (t.id === fullIdOrName) return t;
    return null;
  }

  /* -------------------------------- hook -------------------------------- */

  /**
   * 注册 hook 处理器
   * @param {{ns:string, id:string, hook:string|object, handler:Function, plugin:string, before?:string[], after?:string[], order?:number}} e
   */
  registerHook(e) {
    const hookId = typeof e.hook === 'string' ? e.hook : e.hook.id;
    if (!hookId) return { ok: false, reason: 'hook 缺少 id' };
    const entry = {
      fullId: `${e.ns}:${e.id}`,
      ns: e.ns,
      id: e.id,
      hook: hookId,
      handler: e.handler,
      plugin: e.plugin,
      before: (e.before || []).map((x) => this._resolveRef(x, e.ns)).filter(Boolean),
      after: (e.after || []).map((x) => this._resolveRef(x, e.ns)).filter(Boolean),
      order: Number(e.order) || 0,
      seq: this.nextSeq(),
    };
    const list = this.hooks.get(hookId) || [];
    const dup = list.find((h) => h.fullId === entry.fullId);
    if (dup) return { ok: false, reason: `同一插件同一 hook 重复注册：${entry.fullId}` };
    list.push(entry);
    this.hooks.set(hookId, list);
    this._dirty = true;
    return { ok: true, fullId: entry.fullId };
  }

  _resolveRef(raw, selfNs) {
    if (typeof raw !== 'string') return null;
    const p = tryParseId(raw, { selfNs });
    return p ? p.fullId : null;
  }

  /** hook 执行顺序：before/after 拓扑 + order + 注册序 */
  orderedHooks(hookId) {
    if (!this._dirty && this._sortedHooks.has(hookId)) return this._sortedHooks.get(hookId);
    const list = (this.hooks.get(hookId) || []).slice();
    const idx = new Map(list.map((h, i) => [h.fullId, i]));

    // 边：a -> b 表示 a 必须先于 b
    const edges = new Map(list.map((h) => [h.fullId, new Set()]));
    const indeg = new Map(list.map((h) => [h.fullId, 0]));
    const addEdge = (from, to) => {
      if (from === to || !edges.has(from) || !edges.has(to)) return;
      if (edges.get(from).has(to)) return;
      edges.get(from).add(to);
      indeg.set(to, indeg.get(to) + 1);
    };
    for (const h of list) {
      for (const ref of h.before) addEdge(h.fullId, ref);
      for (const ref of h.after) addEdge(ref, h.fullId);
    }

    // Kahn；同层按 order 再按注册序，保证稳定
    const ready = list.filter((h) => indeg.get(h.fullId) === 0);
    const out = [];
    const cmp = (a, b) => (a.order - b.order) || (a.seq - b.seq);
    while (ready.length) {
      ready.sort(cmp);
      const cur = ready.shift();
      out.push(cur);
      for (const to of edges.get(cur.fullId)) {
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0) ready.push(list.find((h) => h.fullId === to));
      }
    }

    if (out.length !== list.length) {
      const rest = list.filter((h) => !out.includes(h)).sort(cmp);
      this.log(`[cpl] hook ${hookId} 存在循环依赖，回退到 order 排序：${rest.map((h) => h.fullId).join(', ')}`);
      out.push(...rest);
    }
    this._sortedHooks.set(hookId, out);
    return out;
  }

  /* -------------------------------- API -------------------------------- */

  registerApi(e) {
    const fullId = e.ns === 'cdcp' ? e.id : `${e.ns}:${e.id}`;
    const prev = this.apis.get(fullId);
    if (prev && !prev.builtin && !e.builtin) {
      this.conflicts.push({ kind: KIND.API, fullId, winner: e.plugin, loser: prev.plugin });
    }
    this.apis.set(fullId, {
      fullId, ns: e.ns, id: e.id, fn: e.fn,
      plugin: e.plugin, builtin: Boolean(e.builtin),
      description: e.description || '', seq: this.nextSeq(),
    });
    return { ok: true, fullId };
  }

  getApi(ref, selfNs) {
    const p = tryParseId(ref, { selfNs });
    if (!p) return null;
    if (this.apis.has(p.fullId)) return this.apis.get(p.fullId);
    // 版本条件匹配
    for (const a of this.apis.values()) {
      if (a.ns === p.ns && a.id === p.id) return a;
    }
    return null;
  }

  /* --------------------------------- UI --------------------------------- */

  registerUi(e) {
    const key = `${e.slot}:${e.ns}:${e.id}`;
    this.ui.set(key, { ...e, key, seq: this.nextSeq() });
    return { ok: true, key };
  }

  uiFor(slot) {
    return [...this.ui.values()].filter((u) => !slot || u.slot === slot).sort((a, b) => a.seq - b.seq);
  }

  /* -------------------------------- 诊断 -------------------------------- */

  stats() {
    const byPlugin = {};
    for (const t of this.tools.values()) {
      byPlugin[t.plugin] = byPlugin[t.plugin] || { tools: 0, hooks: 0, apis: 0, ui: 0 };
      byPlugin[t.plugin].tools++;
    }
    for (const list of this.hooks.values()) {
      for (const h of list) {
        byPlugin[h.plugin] = byPlugin[h.plugin] || { tools: 0, hooks: 0, apis: 0, ui: 0 };
        byPlugin[h.plugin].hooks++;
      }
    }
    for (const a of this.apis.values()) {
      byPlugin[a.plugin] = byPlugin[a.plugin] || { tools: 0, hooks: 0, apis: 0, ui: 0 };
      byPlugin[a.plugin].apis++;
    }
    for (const u of this.ui.values()) {
      byPlugin[u.plugin] = byPlugin[u.plugin] || { tools: 0, hooks: 0, apis: 0, ui: 0 };
      byPlugin[u.plugin].ui++;
    }
    return {
      tools: this.tools.size,
      hooks: [...this.hooks.values()].reduce((n, l) => n + l.length, 0),
      hookPoints: this.hooks.size,
      apis: this.apis.size,
      ui: this.ui.size,
      byPlugin,
      shadowed: this.shadowed.slice(-50),
      conflicts: this.conflicts.slice(-50),
    };
  }

  clear() {
    this.tools.clear(); this.hooks.clear(); this.apis.clear(); this.ui.clear();
    this.shadowed.length = 0; this.conflicts.length = 0;
    this._sortedHooks.clear(); this._dirty = true;
  }
}

module.exports = { Registry, KIND };
