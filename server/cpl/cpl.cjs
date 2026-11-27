'use strict';
/**
 * CPL —— ChatBox Plugin Loader
 *
 * 职责：
 *   - 插件安装 / 卸载 / 启用 / 禁用 / 热重载（zip 或目录）
 *   - 依赖解析与加载拓扑排序（requires / loadAfter / loadBefore / conflicts）
 *   - json 方法 → hook 注册；js → vm 沙箱；py → 子进程
 *   - hook 分发（按 before/after 拓扑，可 patch 上下文）
 *   - 事件总线、KV、配置、UI 声明、日志环形缓冲
 *   - 云端模式：按用户隔离 + 只允许 json
 *
 * 安全边界（不夸大）：
 *   vm 能挡住"手滑写坏全局"，挡不住"故意逃逸"。插件是本地可信代码。
 *   真正的隔离靠：启用开关 + 权限声明 + 云端只允许 json。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { Registry } = require('./registry.cjs');
const { parsePackage } = require('./package.cjs');
const { readZip, toFileMap } = require('./zip.cjs');
const { createApiBridge } = require('./api.cjs');
const { HOOK_MAP, API_MAP, HOOK_SPECS, API_SPECS, JSON_HOOKS, JSON_APIS } = require('./catalog.cjs');
const { parseId, tryParseId, tryParseRef, matchVersion } = require('./ids.cjs');

const CPL_VERSION = globalThis.__DS_CB_VERSION__
  || (() => { try { return require('../../package.json').version; } catch { return '0.0.0'; } })();
const DEFAULT_HOOK_TIMEOUT = 5000;
const DEFAULT_SCRIPT_TIMEOUT = 10000;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN = 60000;
const LOG_LIMIT = 500;
const UI_LIMIT = 200;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function rrmdir(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

function readJsonFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(p, v) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** args 里的 "{{a.b}}" 从 ctx 取值 */
function resolveArgs(args, ctx) {
  const one = (v) => {
    if (typeof v === 'string') {
      const m = v.match(/^\{\{\s*([\w.$]+)\s*\}\}$/);
      if (m) return m[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
      return v.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, p) => {
        const val = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
        return val === undefined || val === null ? '' : String(val);
      });
    }
    if (Array.isArray(v)) return v.map(one);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, vv] of Object.entries(v)) o[k] = one(vv);
      return o;
    }
    return v;
  };
  return Array.isArray(args) ? args.map(one) : one(args);
}

/**
 * @param {{
 *   dataDir: string,
 *   host?: object,
 *   log?: Function,
 *   version?: string,
 *   mode?: 'local'|'cloud',
 *   allowScripts?: boolean,
 *   scopeKey?: string,
 * }} opts
 */
function createCpl(opts = {}) {
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error('createCpl 需要 dataDir');
  const host = opts.host || {};
  const baseLog = opts.log || console.log;
  const mode = opts.mode || 'local';
  const allowScripts = opts.allowScripts !== false;
  const scopeKey = String(opts.scopeKey || '');
  const version = opts.version || CPL_VERSION;

  const cplDir = path.join(dataDir, 'cpl');
  const pluginsDir = path.join(cplDir, 'plugins');
  const builtinDir = path.join(cplDir, 'builtin-state');
  ensureDir(pluginsDir);
  ensureDir(builtinDir);

  const registry = new Registry({ log: (...a) => baseLog('[cpl]', ...a) });
  const plugins = new Map();          // ns -> runtime
  const builtins = new Map();         // ns -> { modulePath, meta }
  const events = new Map();           // name -> fn[]
  const uiExt = [];                   // 声明式 UI 扩展
  const logs = [];                    // 环形日志
  const breakers = new Map();         // fullId -> { count, until }
  const kvCache = new Map();          // ns -> Map
  const cfgCache = new Map();         // ns -> Map

  const emitHooksEnabled = new Set(); // 已注册 emit 的 hookId 缓存（性能）

  function logLine(level, plugin, args) {
    const text = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    const rec = { at: Date.now(), level, plugin, text: text.slice(0, 4000) };
    logs.push(rec);
    if (logs.length > LOG_LIMIT) logs.shift();
    if (level === 'error' || level === 'warn') baseLog(`[cpl:${plugin}] ${text}`);
    return rec;
  }

  /* ---------------------------- KV / 配置缓存 ---------------------------- */

  function _kvCacheFor(ns, file) {
    if (kvCache.has(ns)) return kvCache.get(ns);
    const m = new Map(Object.entries(readJsonFile(file, {})));
    kvCache.set(ns, m);
    // 延迟落盘，合并高频写
    let timer = null;
    const flush = () => {
      timer = null;
      try { writeJsonFile(file, Object.fromEntries(m)); }
      catch (e) { logLine('error', ns, ['KV 写盘失败：' + e.message]); }
    };
    const orig = m.set.bind(m);
    const origDel = m.delete.bind(m);
    m.set = (k, v) => { const r = orig(k, v); if (!timer) timer = setTimeout(flush, 300); return r; };
    m.delete = (k) => { const r = origDel(k); if (!timer) timer = setTimeout(flush, 300); return r; };
    m.flushNow = () => { if (timer) { clearTimeout(timer); flush(); } };
    return m;
  }

  function _cfgCacheFor(ns, file, schema) {
    if (cfgCache.has(ns)) return cfgCache.get(ns);
    const defaults = {};
    if (schema && typeof schema === 'object') {
      for (const [k, v] of Object.entries(schema)) {
        defaults[k] = v && typeof v === 'object' && 'default' in v ? v.default : v;
      }
    }
    const m = new Map(Object.entries({ ...defaults, ...readJsonFile(file, {}) }));
    cfgCache.set(ns, m);
    let timer = null;
    const flush = () => {
      timer = null;
      try { writeJsonFile(file, Object.fromEntries(m)); }
      catch (e) { logLine('error', ns, ['配置写盘失败：' + e.message]); }
    };
    const orig = m.set.bind(m);
    m.set = (k, v) => { const r = orig(k, v); if (!timer) timer = setTimeout(flush, 300); return r; };
    return m;
  }

  /* ------------------------------- 事件总线 ------------------------------- */

  function on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    const list = events.get(name) || [];
    list.push(fn);
    events.set(name, list);
    return () => off(name, fn);
  }
  function off(name, fn) {
    const list = events.get(name) || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
    return i !== -1;
  }
  function emitEvent(name, payload) {
    const list = (events.get(name) || []).slice();
    for (const fn of list) { try { fn(payload); } catch (e) { logLine('error', name, [e.message]); } }
    // 插件自定义事件也允许 cpl:ns:name 形式被 hook 消费
    return list.length;
  }

  /* -------------------------------- hook -------------------------------- */

  function breakerOk(fullId) {
    const b = breakers.get(fullId);
    if (!b) return true;
    if (b.until && Date.now() < b.until) return false;
    if (b.until && Date.now() >= b.until) { breakers.delete(fullId); return true; }
    return true;
  }
  function breakerFail(fullId, err) {
    const b = breakers.get(fullId) || { count: 0, until: 0 };
    b.count++;
    if (b.count >= BREAKER_THRESHOLD) {
      b.until = Date.now() + BREAKER_COOLDOWN;
      b.count = 0;
      logLine('warn', fullId, [`连续失败 ${BREAKER_THRESHOLD} 次，熔断 60s：${err.message}`]);
    }
    breakers.set(fullId, b);
  }

  /**
   * 触发一个 hook。处理器按 before/after 拓扑顺序执行；
   * 可改写型 hook 的返回值会合并进 ctx（返回 {patch:{...}} 或直接返回对象）。
   */
  async function emit(hookId, ctx = {}, meta = {}) {
    const spec = HOOK_MAP.get(hookId);
    const list = registry.orderedHooks(hookId);
    if (!list.length) return ctx;
    let cur = ctx;
    for (const h of list) {
      if (!breakerOk(h.fullId)) continue;
      try {
        const res = await withTimeout(h.handler(cur), h.timeout || DEFAULT_HOOK_TIMEOUT, `${h.fullId}@${hookId}`);
        if (res && typeof res === 'object') {
          const patch = res.patch && typeof res.patch === 'object' ? res.patch : (spec?.patch ? res : null);
          if (patch) cur = { ...cur, ...patch };
        }
      } catch (e) {
        breakerFail(h.fullId, e);
        logLine('error', h.plugin, [`hook ${hookId} (${h.fullId}) 失败：${e.message}`]);
      }
    }
    return cur;
  }

  function registerHookFor(ns, spec) {
    if (!spec || !spec.hook) throw new Error('hooks.register 需要 hook');
    return registry.registerHook({
      ns, id: spec.id || spec.hook,
      hook: spec.hook,
      handler: spec.handler,
      plugin: ns,
      before: spec.before, after: spec.after, order: spec.order,
    });
  }

  function unregisterHookFor(ns, hookId) {
    const list = registry.hooks.get(hookId) || [];
    const kept = list.filter((h) => h.ns !== ns);
    registry.hooks.set(hookId, kept);
    registry._dirty = true;
    return list.length - kept.length;
  }

  /* ------------------------------ 工具调用 ------------------------------ */

  async function callTool(name, args, meta = {}) {
    const depth = Number(meta.depth) || 0;
    if (depth > 8) return { ok: false, text: '工具调用嵌套过深（>8 层），已中止' };
    const entry = registry.getTool(name);
    if (!entry) return { ok: false, text: `未知工具：${name}` };
    const inner = { ...meta, depth: depth + 1 };
    const before = await emit('tool.before_call', { name, args: args || {}, tool: entry, caller: meta.caller }, inner);
    let useArgs = before.args ?? args;
    const started = Date.now();
    let out;
    try {
      out = await withTimeout(entry.handler(useArgs || {}, meta), entry.timeout || 120000, `tool:${name}`);
      if (!out || typeof out !== 'object') out = { ok: true, text: String(out ?? '') };
    } catch (e) {
      out = { ok: false, text: `工具 ${name} 执行失败：${e.message}` };
      await emit('tool.error', { name, args: useArgs, error: e }, inner);
    }
    out.elapsedMs = Date.now() - started;
    const after = await emit('tool.after_call', { name, args: useArgs, result: out, tool: entry }, inner);
    return after.result || out;
  }

  /* --------------------------- 插件加载：json --------------------------- */

  function bindJsonMethods(rt) {
    const { meta, methods } = rt;
    for (const m of methods) {
      for (const [i, act] of m.actions.entries()) {
        const handler = async (ctx) => {
          const args = resolveArgs(act.args, ctx || {});
          // 约定事件：json 插件改写上下文的出口
          if (act.event === 'ctx.set' || act.event === 'context.set') {
            const v = Array.isArray(args) ? args[0] : args;
            return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
          }
          if (act.eventKind === 'api') {
            const fn = resolveApiPath(rt.api, act.event);
            if (typeof fn !== 'function') {
              logLine('warn', meta.ns, [`event 不是可调用的 API：${act.event}`]);
              return null;
            }
            const out = await fn(...(Array.isArray(args) ? args : [args]));
            return { result: out };
          }
          if (act.eventKind === 'hook') {
            return await emit(act.event, { ...ctx, args, from: meta.ns });
          }
          emitEvent(`${meta.ns}:${act.event}`, args);
          return null;
        };
        const r = registry.registerHook({
          ns: meta.ns,
          id: `${m.id}#${i}`,
          hook: act.type,
          handler,
          plugin: meta.ns,
          before: m.before, after: m.after,
          order: Number(m.order) || 0,
        });
        if (!r.ok) logLine('warn', meta.ns, [`方法 ${m.id} 注册失败：${r.reason}`]);
      }
    }
  }

  function resolveApiPath(bridge, dotted) {
    return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), bridge);
  }

  /* ---------------------------- 插件加载：js ---------------------------- */

  function makeSandbox(rt) {
    const { meta } = rt;
    const cdcp = rt.api;
    const sandbox = {
      cdcp,
      console: {
        log: (...a) => logLine('info', meta.ns, a),
        warn: (...a) => logLine('warn', meta.ns, a),
        error: (...a) => logLine('error', meta.ns, a),
        info: (...a) => logLine('info', meta.ns, a),
        debug: (...a) => logLine('debug', meta.ns, a),
      },
      module: { exports: {} },
      exports: {},
      require: (mod) => {
        const allowed = ['crypto', 'path', 'url', 'querystring', 'buffer', 'util', 'zlib'];
        if (allowed.includes(mod)) return require(mod);
        throw new Error(`插件沙箱不提供 require('${mod}')，请用 cdcp 能力`);
      },
      setTimeout, clearTimeout, setInterval, clearInterval,
      Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
      process: { platform: process.platform, arch: process.arch, version: process.version, env: {} },
      __plugin: { ns: meta.ns, version: meta.uniqueVersion },
    };
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox, { name: `cpl:${meta.ns}` });
  }

  async function runJsScripts(rt) {
    const { scripts, meta } = rt;
    const ctx = makeSandbox(rt);
    for (const s of scripts) {
      const wrapped = `(function(){ "use strict";\n${s.code}\n})()`;
      let script;
      try {
        script = new vm.Script(wrapped, { filename: `${meta.ns}/${s.path}` });
      } catch (e) {
        throw new Error(`${s.path} 语法错误：${e.message}`);
      }
      let ret;
      try {
        ret = script.runInContext(ctx, { timeout: DEFAULT_SCRIPT_TIMEOUT });
      } catch (e) {
        throw new Error(`${s.path} 执行失败：${e.message}`);
      }
      // module.exports = function(cdcp) 形式：立即调用
      const exp = ctx.module.exports;
      if (typeof exp === 'function') {
        try { await withTimeout(exp(rt.api, rt.hostFacade), DEFAULT_SCRIPT_TIMEOUT, `${s.path} 初始化`); }
        catch (e) { throw new Error(`${s.path} 初始化失败：${e.message}`); }
      } else if (typeof ret === 'function') {
        try { await withTimeout(ret(rt.api, rt.hostFacade), DEFAULT_SCRIPT_TIMEOUT, `${s.path} 初始化`); }
        catch (e) { throw new Error(`${s.path} 初始化失败：${e.message}`); }
      }
      // 每个脚本独立 module 作用域
      ctx.module.exports = {};
      ctx.exports = ctx.module.exports;
    }
  }

  /* ---------------------------- 插件加载：py ---------------------------- */

  async function runPyScripts(rt) {
    const { scripts, meta } = rt;
    const py = scripts.filter((s) => s.lang === 'py');
    if (!py.length) return;
    const pyBin = findPython();
    if (!pyBin) throw new Error('找不到 python，无法加载 py 插件');

    for (const s of py) {
      const scriptPath = path.join(rt.dir, s.path);
      const payload = JSON.stringify({
        plugin: { id: meta.ns, name: meta.name, uniqueVersion: meta.uniqueVersion },
        phase: 'init',
        hooks: HOOK_SPECS.map((h) => h[0]),
        apis: API_SPECS.map((a) => a[0]),
      });
      const out = await runPythonOnce(pyBin, scriptPath, payload, rt.dir);
      if (out.error) throw new Error(`${s.path} 执行失败：${out.error}`);
      if (Array.isArray(out.hooks)) {
        for (const spec of out.hooks) {
          if (!spec || !spec.hook) continue;
          registry.registerHook({
            ns: meta.ns,
            id: spec.id || spec.hook,
            hook: spec.hook,
            plugin: meta.ns,
            before: spec.before, after: spec.after,
            handler: async (ctx) => {
              const res = await runPythonOnce(pyBin, scriptPath, JSON.stringify({
                plugin: { id: meta.ns, uniqueVersion: meta.uniqueVersion },
                phase: 'hook', hook: spec.hook, ctx: safeCtx(ctx),
              }), rt.dir);
              if (res.error) throw new Error(res.error);
              return res.patch || null;
            },
          });
        }
      }
      // init 阶段声明要注册的工具
      if (Array.isArray(out.tools)) {
        for (const t of out.tools) {
          if (!t || !t.name) continue;
          registry.registerTool({
            ns: meta.ns, id: t.name,
            def: { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {}, additionalProperties: false } } },
            handler: async (args) => {
              const res = await runPythonOnce(pyBin, scriptPath, JSON.stringify({
                plugin: { id: meta.ns, uniqueVersion: meta.uniqueVersion },
                phase: 'tool', name: t.name, args,
              }), rt.dir);
              return res.error ? { ok: false, text: res.error } : (res.result || { ok: true, text: '' });
            },
            plugin: meta.ns,
          });
        }
      }
    }
  }

  function safeCtx(ctx) {
    try { return JSON.parse(JSON.stringify(ctx, (k, v) => (typeof v === 'function' ? undefined : v))); }
    catch { return {}; }
  }

  let pyPathCache = null;
  function findPython() {
    if (pyPathCache !== null) return pyPathCache;
    const cands = process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python'];
    for (const c of cands) {
      try {
        const r = require('child_process').spawnSync(c, ['--version'], { timeout: 3000, windowsHide: true });
        if (r.status === 0) { pyPathCache = c; return c; }
      } catch {}
    }
    pyPathCache = null;
    return null;
  }

  function runPythonOnce(bin, scriptPath, payload, cwd) {
    return new Promise((resolve) => {
      const child = spawn(bin, [scriptPath], { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ error: 'py 脚本超时' }); }, DEFAULT_SCRIPT_TIMEOUT);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out.trim()) return resolve({ error: (err || `退出码 ${code}`).slice(0, 1000) });
        const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
        try { resolve(JSON.parse(line)); }
        catch { resolve({ error: `py 输出不是 JSON：${line.slice(0, 200)}` }); }
      });
      try { child.stdin.write(payload); child.stdin.end(); } catch {}
    });
  }

  /* ------------------------------ 依赖排序 ------------------------------ */

  function resolveOrder(list) {
    const byNs = new Map(list.map((p) => [p.meta.ns, p]));
    const edges = new Map(list.map((p) => [p.meta.ns, new Set()]));
    const indeg = new Map(list.map((p) => [p.meta.ns, 0]));
    const problems = [];

    const addEdge = (from, to, why) => {
      if (from === to || !edges.has(from) || !edges.has(to)) return;
      if (edges.get(from).has(to)) return;
      edges.get(from).add(to);
      indeg.set(to, indeg.get(to) + 1);
    };

    for (const p of list) {
      const me = p.meta.ns;
      for (const ref of p.meta.requires) {
        const r = tryParseRef(ref);
        if (!r) { problems.push(`${me}: requires 无法解析 ${ref}`); continue; }
        const dep = byNs.get(r.ns);
        if (!dep) { problems.push(`${me}: 缺少前置插件 ${r.ns}`); p.missing = p.missing || []; p.missing.push(r.ns); continue; }
        if (!matchVersion(r, dep.meta.uniqueVersion)) {
          problems.push(`${me}: 前置 ${r.ns} 版本不满足 ${r.range?.text}`);
          p.missing = p.missing || []; p.missing.push(`${r.ns}@${r.range?.text}`);
          continue;
        }
        addEdge(r.ns, me, 'requires');
      }
      for (const ref of p.meta.loadAfter) {
        const r = tryParseRef(ref);
        if (r && byNs.has(r.ns)) addEdge(r.ns, me, 'loadAfter');
      }
      for (const ref of p.meta.loadBefore) {
        const r = tryParseRef(ref);
        if (r && byNs.has(r.ns)) addEdge(me, r.ns, 'loadBefore');
      }
    }

    // conflicts 检查
    for (const p of list) {
      for (const ref of p.meta.conflicts) {
        const r = tryParseRef(ref);
        if (r && byNs.has(r.ns)) problems.push(`${p.meta.ns}: 与 ${r.ns} 声明冲突`);
      }
    }

    const ready = list.filter((p) => indeg.get(p.meta.ns) === 0)
      .sort((a, b) => (a.meta.uniqueVersion - b.meta.uniqueVersion) || a.meta.ns.localeCompare(b.meta.ns));
    const out = [];
    while (ready.length) {
      const cur = ready.shift();
      out.push(cur);
      for (const to of edges.get(cur.meta.ns)) {
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0) {
          const node = list.find((p) => p.meta.ns === to);
          if (node) { ready.push(node); ready.sort((a, b) => a.meta.ns.localeCompare(b.meta.ns)); }
        }
      }
    }
    if (out.length !== list.length) {
      const cyc = list.filter((p) => !out.includes(p)).map((p) => p.meta.ns);
      problems.push(`循环依赖：${cyc.join(' → ')}`);
      out.push(...list.filter((p) => !out.includes(p)));
    }
    return { order: out, problems };
  }

  /* ------------------------------ 插件生命周期 ------------------------------ */

  async function loadPlugin(rt) {
    const { meta } = rt;
    await emit('cpl.before_load', { plugin: meta });
    rt.api = createApiBridge({ cpl: api, plugin: rt });
    rt.hostFacade = { log: rt.api.log, util: rt.api.util };

    if (rt.methods.length) bindJsonMethods(rt);
    if (rt.scripts.length) {
      if (!allowScripts) throw new Error('当前模式不允许运行 js/py 插件（云端仅支持 json 插件）');
      const js = rt.scripts.filter((s) => s.lang === 'js');
      const py = rt.scripts.filter((s) => s.lang === 'py');
      if (js.length) await runJsScripts(rt);
      if (py.length) await runPyScripts(rt);
    }

    rt.status = 'enabled';
    rt.enabled = true;
    rt.error = null;
    rt.loadedAt = Date.now();
    await emit('cpl.after_load', { plugin: meta });
    logLine('info', meta.ns, [`已加载 v${meta.uniqueVersion}（${rt.methods.length} 方法 / ${rt.scripts.length} 脚本）`]);
  }

  function unloadPlugin(rt) {
    const { meta } = rt;
    registry.unregisterByPlugin(meta.ns);
    for (let i = uiExt.length - 1; i >= 0; i--) if (uiExt[i].plugin === meta.ns) uiExt.splice(i, 1);
    rt.status = rt.enabled ? 'disabled' : 'installed';
    rt.enabled = false;
  }

  async function reloadAll() {
    // 清空用户插件注册（保留 builtin）
    for (const [k, t] of [...registry.tools]) if (!t.builtin) registry.tools.delete(k);
    for (const [k, list] of [...registry.hooks]) {
      registry.hooks.set(k, list.filter((h) => registry.tools.get(h.fullId)?.builtin || builtins.has(h.ns)));
    }
    for (const [k, a] of [...registry.apis]) if (!a.builtin) registry.apis.delete(k);
    for (const [k, u] of [...registry.ui]) if (!builtins.has(u.plugin)) registry.ui.delete(k);
    registry._dirty = true;

    const list = [...plugins.values()].filter((p) => p.meta.enabledByDefault !== false || p.enabled);
    const { order, problems } = resolveOrder(list);
    for (const p of problems) logLine('warn', 'resolve', [p]);

    for (const rt of order) {
      if (rt.meta.enabledByDefault === false && !rt.enabled) { rt.status = 'disabled'; continue; }
      try {
        await loadPlugin(rt);
      } catch (e) {
        rt.status = 'error';
        rt.error = e.message;
        logLine('error', rt.meta.ns, [e.message]);
      }
    }
    return { loaded: order.length, problems };
  }

  /* -------------------------------- 安装 -------------------------------- */

  function pluginDirOf(ns) { return path.join(pluginsDir, ns); }

  function readInstalled(ns) {
    const dir = pluginDirOf(ns);
    const stateFile = path.join(dir, '_cpl-state.json');
    return readJsonFile(stateFile, null);
  }

  async function install(buffer, opt = {}) {
    if (mode === 'cloud' && !opt.allowScripts) {
      // 先解析再判断，给出明确原因
    }
    const entries = readZip(buffer);
    const fileMap = toFileMap(entries);
    const pkg = parsePackage(fileMap, { source: 'zip' });

    if (!allowScripts && pkg.scripts.length) {
      throw new Error(`云端专版只支持 json 插件：该包含有 ${pkg.scripts.length} 个 js/py 脚本`);
    }
    if (!allowScripts && opt.force !== true) {
      // json 插件仍可安装
    }

    const ns = pkg.meta.ns;
    const dir = pluginDirOf(ns);
    const prev = plugins.get(ns);

    // 升级：先卸载旧版注册
    if (prev) unloadPlugin(prev);

    rrmdir(dir);
    ensureDir(dir);
    for (const [rel, buf] of fileMap) {
      const target = path.join(dir, rel);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error(`非法路径：${rel}`);
      ensureDir(path.dirname(resolved));
      fs.writeFileSync(resolved, buf);
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const state = {
      ns,
      installedAt: Date.now(),
      updatedAt: prev ? Date.now() : null,
      hash,
      bytes: buffer.length,
      uniqueVersion: pkg.meta.uniqueVersion,
      enabled: opt.enabled !== false,
      prevVersion: prev ? prev.meta.uniqueVersion : null,
    };
    writeJsonFile(path.join(dir, '_cpl-state.json'), state);

    const rt = buildRuntime(pkg, dir, state);
    plugins.set(ns, rt);

    if (state.enabled) {
      try { await loadPlugin(rt); }
      catch (e) { rt.status = 'error'; rt.error = e.message; logLine('error', ns, [e.message]); }
    } else rt.status = 'disabled';

    await emit(prev ? 'cpl.upgrade' : 'cpl.install', { plugin: rt.meta, prevVersion: state.prevVersion });
    return publicPlugin(rt);
  }

  function buildRuntime(pkg, dir, state) {
    return {
      meta: pkg.meta,
      methods: pkg.methods,
      scripts: allowScripts ? pkg.scripts : [],
      assets: pkg.assets,
      icon: pkg.icon,
      fileMap: pkg.fileMap,
      dir,
      state: state || {},
      enabled: state ? state.enabled !== false : true,
      status: 'installed',
      error: null,
      loadedAt: 0,
      stats: pkg.stats,
      api: null,
    };
  }

  function uninstall(ns) {
    const rt = plugins.get(ns);
    if (rt) { unloadPlugin(rt); plugins.delete(ns); }
    rrmdir(pluginDirOf(ns));
    kvCache.delete(ns);
    cfgCache.delete(ns);
    return true;
  }

  async function setEnabled(ns, on) {
    const rt = plugins.get(ns);
    if (!rt) throw new Error(`插件不存在：${ns}`);
    await emit(on ? 'cpl.before_enable' : 'cpl.before_disable', { plugin: rt.meta });
    const st = readInstalled(ns) || {};
    st.enabled = Boolean(on);
    writeJsonFile(path.join(pluginDirOf(ns), '_cpl-state.json'), st);
    rt.state = st;
    if (on) {
      try { await loadPlugin(rt); }
      catch (e) { rt.status = 'error'; rt.error = e.message; throw e; }
      await emit('cpl.after_enable', { plugin: rt.meta });
    } else {
      unloadPlugin(rt);
      await emit('cpl.after_disable', { plugin: rt.meta });
    }
    return publicPlugin(rt);
  }

  function loadInstalled() {
    if (!fs.existsSync(pluginsDir)) return [];
    const list = [];
    for (const ns of fs.readdirSync(pluginsDir)) {
      const dir = pluginDirOf(ns);
      if (!fs.statSync(dir).isDirectory()) continue;
      const state = readInstalled(ns);
      if (!state) continue;
      try {
        const fileMap = new Map();
        const walk = (d, base) => {
          for (const d2 of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, d2.name);
            if (d2.isDirectory()) walk(full, base);
            else fileMap.set(path.relative(base, full).replace(/\\/g, '/'), fs.readFileSync(full));
          }
        };
        walk(dir, dir);
        fileMap.delete('_cpl-state.json');
        if (fileMap.has('_kv.json')) fileMap.delete('_kv.json');
        if (fileMap.has('_config.json')) fileMap.delete('_config.json');
        const pkg = parsePackage(fileMap, { source: 'zip' });
        const rt = buildRuntime(pkg, dir, state);
        plugins.set(ns, rt);
        list.push(rt);
      } catch (e) {
        logLine('error', ns, ['读取已装插件失败：' + e.message]);
      }
    }
    return list;
  }

  /* ------------------------------ 内置插件 ------------------------------ */

  function makeBuiltinRuntime(spec) {
    const ns = spec.ns;
    const meta = {
      ns, name: spec.name || ns, uniqueVersion: String(spec.uniqueVersion || '1'),
      version: spec.version || '', description: spec.description || '',
      author: 'builtin', builtin: true,
      permissions: ['tools', 'hooks', 'kv', 'config', 'ui', 'log', 'events', 'net', 'ai', 'store', 'fs'],
      requires: [], loadAfter: [], loadBefore: [], conflicts: [], keywords: [],
      ...(spec.meta || {}),
    };
    const rt = {
      meta, methods: [], scripts: [], assets: new Map(), icon: null, fileMap: new Map(),
      dir: path.join(builtinDir, ns), enabled: true, status: 'enabled', error: null,
      loadedAt: Date.now(), stats: { methods: 0, scripts: 1, assets: 0, hooks: 0, langs: ['js'], builtin: true },
      api: null, builtin: spec.module, context: spec.context,
    };
    ensureDir(rt.dir);
    return rt;
  }

  /** 同步版：createTools() 在构造期就要把内置工具注册好，不能等 await */
  function registerBuiltinSync(spec) {
    const rt = makeBuiltinRuntime(spec);
    plugins.set(rt.meta.ns, rt);
    builtins.set(rt.meta.ns, spec);
    rt.api = createApiBridge({ cpl: api, plugin: rt });
    rt.hostFacade = { log: rt.api.log, util: rt.api.util, context: spec.context };
    try {
      const r = spec.module(rt.api, rt.hostFacade);
      if (r && typeof r.then === 'function') {
        r.catch((e) => { rt.status = 'error'; rt.error = e.message; logLine('error', rt.meta.ns, [e.message]); });
      }
    } catch (e) {
      rt.status = 'error';
      rt.error = e.message;
      logLine('error', rt.meta.ns, ['内置插件注册失败：' + e.message]);
    }
    return rt;
  }

  /**
   * 注册一个「虚拟插件」：用于云端无状态场景 —— 插件定义由前端每次带来，
   * 服务端不落盘、不跨请求保留。只接受 json 方法（scripts 会被忽略）。
   */
  function registerVirtualPlugin(pkg) {
    if (!pkg || !pkg.meta || !pkg.meta.ns) throw new Error('虚拟插件缺少 meta.ns');
    const meta = {
      permissions: ['kv', 'config', 'ui', 'log', 'events', 'hooks', 'store'],
      requires: [], loadAfter: [], loadBefore: [], conflicts: [], keywords: [],
      enabledByDefault: true,
      ...pkg.meta,
      builtin: false,
    };
    const rt = {
      meta,
      methods: Array.isArray(pkg.methods) ? pkg.methods : [],
      scripts: [],
      assets: new Map(),
      icon: null,
      fileMap: new Map(),
      dir: path.join(builtinDir, 'virtual-' + crypto.randomBytes(4).toString('hex')),
      enabled: true,
      status: 'enabled',
      error: null,
      loadedAt: Date.now(),
      stats: pkg.stats || { methods: (pkg.methods || []).length, scripts: 0, assets: 0, hooks: 0, langs: ['json'] },
      api: null,
    };
    ensureDir(rt.dir);
    plugins.set(meta.ns, rt);
    rt.api = createApiBridge({ cpl: api, plugin: rt });
    rt.hostFacade = { log: rt.api.log, util: rt.api.util };
    if (rt.methods.length) bindJsonMethods(rt);
    return rt;
  }

  /**
   * 注册一个内置插件。内置插件不受「只允许 json」限制，也不需要 zip。
   * @param {{ns:string, id:string, name:string, uniqueVersion:string|number, module:Function, meta?:object, context?:object}} spec
   */
  async function registerBuiltin(spec) {
    const rt = makeBuiltinRuntime(spec);
    plugins.set(rt.meta.ns, rt);
    builtins.set(rt.meta.ns, spec);
    rt.api = createApiBridge({ cpl: api, plugin: rt });
    rt.hostFacade = { log: rt.api.log, util: rt.api.util, context: spec.context };
    try {
      await spec.module(rt.api, rt.hostFacade);
      rt.status = 'enabled';
      logLine('info', rt.meta.ns, [`内置插件已注册：${registry.tools.size} 个工具`]);
    } catch (e) {
      rt.status = 'error';
      rt.error = e.message;
      logLine('error', rt.meta.ns, ['内置插件注册失败：' + e.message]);
    }
    return rt;
  }

  /* -------------------------------- 查询 -------------------------------- */

  function publicPlugin(rt) {
    return {
      id: rt.meta.ns,
      name: rt.meta.name,
      version: rt.meta.version,
      uniqueVersion: rt.meta.uniqueVersion,
      description: rt.meta.description,
      author: rt.meta.author,
      homepage: rt.meta.homepage,
      license: rt.meta.license,
      keywords: rt.meta.keywords,
      permissions: rt.meta.permissions,
      requires: rt.meta.requires,
      loadAfter: rt.meta.loadAfter,
      loadBefore: rt.meta.loadBefore,
      conflicts: rt.meta.conflicts,
      config: rt.meta.config,
      builtin: Boolean(rt.meta.builtin),
      enabled: rt.enabled,
      status: rt.status,
      error: rt.error,
      loadedAt: rt.loadedAt,
      stats: rt.stats,
      counts: registry.stats().byPlugin[rt.meta.ns] || { tools: 0, hooks: 0, apis: 0, ui: 0 },
    };
  }

  function listPlugins() {
    return [...plugins.values()]
      .map(publicPlugin)
      .sort((a, b) => (Number(b.builtin) - Number(a.builtin)) || a.id.localeCompare(b.id));
  }

  function getPlugin(ns) {
    const rt = plugins.get(ns);
    return rt ? publicPlugin(rt) : null;
  }

  function pushUi(ext) {
    uiExt.push({ ...ext, at: Date.now() });
    if (uiExt.length > UI_LIMIT) uiExt.shift();
    return ext;
  }

  function uiSnapshot() {
    return uiExt.slice();
  }

  function pluginLog(ns, level, args) { return logLine(level, ns, args); }

  function logsFor(ns, limit = 100) {
    const list = ns ? logs.filter((l) => l.plugin === ns) : logs;
    return list.slice(-limit);
  }

  function catalog() {
    return {
      hooks: HOOK_SPECS.map(([id, desc, patch, arg]) => ({ id, desc, patch, arg })),
      apis: API_SPECS.map(([id, desc, params]) => ({ id, desc, params })),
      jsonHooks: [...JSON_HOOKS],
      jsonApis: [...JSON_APIS],
      jsonLimits: { hooks: JSON_HOOKS.size, apis: JSON_APIS.size },
      fullLimits: { hooks: HOOK_SPECS.length, apis: API_SPECS.length },
    };
  }

  const api = {
    version,
    mode,
    scopeKey,
    dataDir,
    cplDir,
    pluginsDir,
    registry,
    host,
    allowScripts,
    // 生命周期
    loadInstalled, reloadAll, install, uninstall, setEnabled, registerBuiltin, registerBuiltinSync, registerVirtualPlugin,
    // 分发
    emit, emitEvent, on, off, registerHookFor, unregisterHookFor, callTool,
    // 查询
    listPlugins, getPlugin, uiSnapshot, pushUi, pluginLog, logsFor, catalog,
    // 内部缓存访问（api.cjs 用）
    _kvCacheFor, _cfgCacheFor,
    get logs() { return logs.slice(); },
    get plugins() { return plugins; },
  };

  /* 加载器自身也作为「内置插件」出现在插件列表里：
   * 只读展示（不可禁用 / 不可卸载），命名空间 cpl 是保留的。 */
  const SELF_SPEC = {
    ns: 'cpl',
    name: 'CPL 加载器',
    uniqueVersion: 1,
    version,
    description: '扩展加载器本体：ID 体系（namespace@版本条件:方法名）、注册表与冲突仲裁、hook 分发、js / py 沙箱、插件生命周期。',
    meta: { core: true },
    module: () => {},
  };

  // 启动时把已装插件读进内存（真正加载由 loadInstalled + reloadAll 决定）
  api.boot = async () => {
    loadInstalled();
    if (!plugins.has(SELF_SPEC.ns)) {
      try { registerBuiltinSync(SELF_SPEC); }
      catch (e) { logLine('warn', SELF_SPEC.ns, ['加载器自身条目注册失败：' + e.message]); }
    }
    return reloadAll();
  };

  return api;
}

module.exports = { createCpl, CPL_VERSION, withTimeout, resolveArgs };
