'use strict';
/**
 * CPL 注册表
 *
 * 承担三件事：
 *   1. 登记：工具 / hook 处理器 / 插件 API / UI 扩展点
 *   2. 排序：按 before / after 做拓扑排序（同层按 order 再按加载序）
 *   3. 仲裁：chatbox 内置 vs 插件 → 插件优先；插件之间 → 后加载者胜并告警
 */

const { parseId, tryParseId, matchVersion, sameTarget, isBareNs } = require('./ids.cjs');

const KIND = {
  TOOL: 'tool',
  HOOK: 'hook',
  API: 'api',
  UI: 'ui',
};

/* 命名空间与方法之间的分隔符。
 *
 * 口径（2026-11-28 定）：**除了下面这一处，其余一律用冒号** ——
 * 内部 ID、插件页、日志、文档、插件内调用写法全是 `ns:id`。
 * 只有发给模型的 `function.name` 必须换成双下划线：OpenAI / DeepSeek 的
 * function name 只接受 `[A-Za-z0-9_-]`，带冒号会让整个请求 400
 * （不是被忽略，是整条对话直接失败，之前已经踩过一次）。
 * 两个插件各注册一个 `foo` 时若都用裸名，模型侧会重名，后注册的永远调不到，
 * 所以插件工具在模型侧才需要这个前缀；命名空间安装时唯一，前缀天然不撞。 */
const TOOL_NAME_SEP = '__';

/** 模型侧的 function.name：内置保持裸名，插件加 `ns__` 前缀（唯一必须转义处） */
function toolDisplayName(ns, id) {
  return isBareNs(ns) ? id : `${ns}${TOOL_NAME_SEP}${id}`;
}

/** 给人和日志看的名字：模型侧的 `ns__id` 还原成 `ns:id` */
function prettyToolName(displayOrId, ns) {
  const s = String(displayOrId || '');
  if (ns && s.startsWith(`${ns}${TOOL_NAME_SEP}`)) return `${ns}:${s.slice(ns.length + TOOL_NAME_SEP.length)}`;
  const i = s.indexOf(TOOL_NAME_SEP);
  return i === -1 ? s : `${s.slice(0, i)}:${s.slice(i + TOOL_NAME_SEP.length)}`;
}

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
    const fullId = isBareNs(e.ns) ? e.id : `${e.ns}:${e.id}`;
    const display = toolDisplayName(e.ns, e.id);
    // def 里的 function.name 才是模型看到的名字，必须跟着改（不能只改内部 key）
    const def = e.def && e.def.function
      ? { ...e.def, function: { ...e.def.function, name: display } }
      : e.def;
    const next = {
      fullId, display, ns: e.ns, id: e.id,
      def, handler: e.handler,
      plugin: e.plugin, builtin: Boolean(e.builtin),
      // 插件唯一版本号：`ns@>=13520:foo` 这类引用要靠它判条件
      uniqueVersion: e.uniqueVersion === undefined || e.uniqueVersion === null ? null : String(e.uniqueVersion),
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
    const fullId = isBareNs(ns) ? id : `${ns}:${id}`;
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
    return [...this.tools.values()].sort((a, b) => (a.order - b.order) || (a.seq - b.seq)).map((t) => t.display || t.id);
  }

  /**
   * 解析工具引用，返回 { tool, reason }。
   * 支持的写法（按优先级）：
   *   ns:id            完整 ID
   *   ns@>=13520:id    完整 ID + 版本条件（也支持 > = < <= 与区间 [a,b] (a,b] 等）
   *   ns__id           模型侧 function.name（唯一必须转义的地方，兼容）
   *   id               裸名：只命中内置（cdcptools / cdcp），绝不落到别的插件
   * @param {string} ref
   * @param {{selfNs?:string}} opt selfNs 用于 `foo` 省略命名空间时的「先自己」
   */
  resolveTool(ref, opt = {}) {
    const k = String(ref || '');
    if (!k) return { tool: null, reason: '工具引用为空' };
    // 插件内裸名：先自己（优先级「自己 > 内置」）。
    // 必须排在最前面 —— 内置工具的 fullId 本身就是裸名，`tools.has(k)` 会先命中内置。
    if (opt.selfNs && !k.includes(':') && !k.includes('@')) {
      const own = this.tools.get(`${opt.selfNs}:${k}`);
      if (own) return { tool: own };
    }
    if (this.tools.has(k)) return { tool: this.tools.get(k) };
    for (const t of this.tools.values()) if ((t.display || t.id) === k) return { tool: t };
    // 再回退到内置；裸名永远不落到别的插件上
    for (const t of this.tools.values()) if (t.id === k && isBareNs(t.ns)) return { tool: t };

    // 走到这里说明带 `@` 版本条件（或命名空间写法但内部 key 不含版本）
    const p = tryParseId(k, { selfNs: opt.selfNs, defaultNs: opt.selfNs });
    if (!p) return { tool: null, reason: `无法解析的工具引用：${k}` };
    const cands = [...this.tools.values()].filter((t) => t.ns === p.ns && t.id === p.id);
    if (!cands.length) return { tool: null, reason: `未知工具：${k}` };
    if (!p.range) return { tool: cands[0] };
    const hit = cands.find((t) => matchVersion(p, t.uniqueVersion));
    if (hit) return { tool: hit };
    const have = [...new Set(cands.map((t) => t.uniqueVersion ?? '未标注'))].join(' / ');
    return { tool: null, reason: `版本条件不满足：${k}（当前 uniqueVersion ${have}）` };
  }

  getTool(ref, opt) {
    return this.resolveTool(ref, opt).tool;
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
    const fullId = isBareNs(e.ns) ? e.id : `${e.ns}:${e.id}`;
    const prev = this.apis.get(fullId);
    if (prev && !prev.builtin && !e.builtin) {
      this.conflicts.push({ kind: KIND.API, fullId, winner: e.plugin, loser: prev.plugin });
    }
    this.apis.set(fullId, {
      fullId, ns: e.ns, id: e.id, fn: e.fn,
      plugin: e.plugin, builtin: Boolean(e.builtin),
      uniqueVersion: e.uniqueVersion === undefined || e.uniqueVersion === null ? null : String(e.uniqueVersion),
      description: e.description || '', seq: this.nextSeq(),
    });
    return { ok: true, fullId };
  }

  getApi(ref, selfNs) {
    const raw = String(ref || '');
    if (!raw) return null;
    if (this.apis.has(raw)) return this.apis.get(raw);
    const p = tryParseId(raw, { selfNs });
    if (!p) return null;
    const cands = [...this.apis.values()].filter((a) => a.ns === p.ns && a.id === p.id);
    if (!cands.length) return null;
    if (!p.range) return cands[0];
    return cands.find((a) => matchVersion(p, a.uniqueVersion)) || null;
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

module.exports = { Registry, KIND, TOOL_NAME_SEP, toolDisplayName, prettyToolName };
