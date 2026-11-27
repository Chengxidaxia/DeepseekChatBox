'use strict';
/**
 * 插件包解析与校验
 *
 * 目录结构：
 *   data.json      清单
 *   assets/        素材
 *   contents/      方法定义（*.json）
 *   scripts/       代码（*.js / *.py）
 *   fav.png        图标
 */

const { tryParseId, tryParseRef, RESERVED_NS } = require('./ids.cjs');
const { HOOK_MAP, API_MAP } = require('./catalog.cjs');

const MANIFEST = 'data.json';
const NS_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

const PERMISSIONS = new Set([
  'net', 'fs', 'ui', 'tools', 'kv', 'config', 'ai', 'store', 'log', 'events', 'hooks',
]);

function fail(msg) {
  const e = new Error(msg);
  e.name = 'PluginPackageError';
  throw e;
}

function readJson(buf, label) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); }
  catch (e) { fail(`${label} 不是合法 JSON：${e.message}`); }
}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeUll(v, label) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) fail(`${label} 必须是非负整数`);
    if (!Number.isSafeInteger(v)) fail(`${label} 超出安全整数范围，请用字符串表示`);
    return String(v);
  }
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) fail(`${label} 必须是纯数字（unsigned long long）`);
  return s;
}

/**
 * @param {Map<string, Buffer>} fileMap  相对路径 -> 内容
 * @param {{ source?: string }} opt
 */
function parsePackage(fileMap, opt = {}) {
  const source = opt.source || 'zip';
  if (!fileMap || fileMap.size === 0) fail('插件包是空的');
  if (fileMap.size > MAX_FILES) fail(`文件数超限（${fileMap.size} > ${MAX_FILES}）`);

  let total = 0;
  for (const [k, v] of fileMap) {
    total += v.length;
    if (k.toLowerCase().endsWith('.png') || k.toLowerCase().endsWith('.jpg')) {
      if (v.length > 4 * 1024 * 1024) fail(`图片过大：${k}`);
    }
  }
  if (total > MAX_TOTAL_BYTES) fail(`插件包解压后超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);

  const manifestBuf = fileMap.get(MANIFEST);
  if (!manifestBuf) fail('缺少 data.json');

  const raw = readJson(manifestBuf, 'data.json');
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('data.json 顶层必须是对象');

  /* ------------------------------ 清单校验 ------------------------------ */
  const ns = String(raw.id || raw.namespace || '').trim();
  if (!ns) fail('data.json 缺少 id（插件命名空间）');
  if (!NS_RE.test(ns)) fail(`插件 id 含非法字符：${ns}（只允许字母数字 _ . -，且不能以数字开头）`);
  if (RESERVED_NS.has(ns)) fail(`插件 id 不能使用保留命名空间：${ns}`);

  if (raw.uniqueVersion === undefined && raw.unique_version === undefined) {
    fail('data.json 缺少 uniqueVersion（唯一版本号，无符号整数）');
  }
  const uniqueVersion = normalizeUll(raw.uniqueVersion ?? raw.unique_version, 'uniqueVersion');

  const name = String(raw.name || ns).trim().slice(0, 60);
  const meta = {
    ns,
    uniqueVersion,
    version: String(raw.version || '').trim(),
    name,
    description: String(raw.description || '').slice(0, 800),
    author: String(raw.author || '').slice(0, 120),
    homepage: String(raw.homepage || '').trim(),
    license: String(raw.license || '').trim(),
    icon: String(raw.icon || 'fav.png'),
    keywords: asArray(raw.keywords).map((x) => String(x).slice(0, 30)).slice(0, 20),
    requires: asArray(raw.requires).map(String),
    loadAfter: asArray(raw.loadAfter || raw.load_after).map(String),
    loadBefore: asArray(raw.loadBefore || raw.load_before).map(String),
    conflicts: asArray(raw.conflicts).map(String),
    permissions: asArray(raw.permissions).map(String),
    minCplVersion: String(raw.minCplVersion || raw.min_cpl_version || '').trim(),
    enabledByDefault: raw.enabledByDefault !== false,
    config: raw.config && typeof raw.config === 'object' ? raw.config : null,
    source,
  };

  for (const p of meta.permissions) if (!PERMISSIONS.has(p)) fail(`未知权限：${p}（可用：${[...PERMISSIONS].join(', ')}）`);
  for (const ref of [...meta.requires, ...meta.loadAfter, ...meta.loadBefore, ...meta.conflicts]) {
    if (!tryParseRef(ref, { selfNs: ns })) fail(`依赖/顺序字段里的 ID 无法解析：${ref}`);
  }

  /* ------------------------------ 方法定义 ------------------------------ */
  const methods = [];
  const assets = new Map();
  const scripts = [];

  for (const [path, buf] of fileMap) {
    const lower = path.toLowerCase();

    if (lower.startsWith('assets/')) {
      assets.set(path.slice('assets/'.length), { path, data: buf });
      continue;
    }

    if (lower.startsWith('contents/') && lower.endsWith('.json')) {
      const doc = readJson(buf, path);
      const list = Array.isArray(doc) ? doc : [doc];
      for (const item of list) methods.push(normalizeMethod(item, path, ns));
      continue;
    }

    if (lower.startsWith('scripts/') && (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs'))) {
      if (buf.length > MAX_SCRIPT_BYTES) fail(`脚本过大（>2MB）：${path}`);
      scripts.push({ lang: 'js', path, code: buf.toString('utf8') });
      continue;
    }

    if (lower.startsWith('scripts/') && lower.endsWith('.py')) {
      if (buf.length > MAX_SCRIPT_BYTES) fail(`脚本过大（>2MB）：${path}`);
      scripts.push({ lang: 'py', path, code: buf.toString('utf8') });
      continue;
    }
  }

  // 方法 id 冲突
  const seen = new Set();
  for (const m of methods) {
    if (seen.has(m.id)) fail(`方法 id 重复：${m.id}`);
    seen.add(m.id);
  }

  const iconBuf = fileMap.get(meta.icon) || fileMap.get('fav.png') || null;

  return {
    meta,
    methods,
    scripts,
    assets,
    icon: iconBuf,
    fileMap,
    stats: {
      files: fileMap.size,
      bytes: total,
      methods: methods.length,
      scripts: scripts.length,
      assets: assets.size,
      langs: [...new Set([...methods.map(() => 'json'), ...scripts.map((s) => s.lang)])],
      hooks: methods.reduce((n, m) => n + m.actions.length, 0),
    },
  };
}

/**
 * 规范化一个方法定义
 * { id, name, actions:[{type,event,args}], before:[], after:[] }
 */
function normalizeMethod(item, path, ns) {
  if (!item || typeof item !== 'object') fail(`${path} 里的方法定义必须是对象`);
  const id = String(item.id || item.name || '').trim();
  if (!id) fail(`${path} 里有方法缺少 id`);
  if (!NS_RE.test(id)) fail(`${path} 方法 id 含非法字符：${id}`);

  const actions = asArray(item.actions).map((a, i) => {
    if (!a || typeof a !== 'object') fail(`${path}#${id} 的 actions[${i}] 必须是对象`);
    const type = String(a.type || a.when || '').trim();
    const event = String(a.event || a.do || '').trim();
    if (!type) fail(`${path}#${id} 的 actions[${i}] 缺少 type（触发条件）`);
    if (!event) fail(`${path}#${id} 的 actions[${i}] 缺少 event（要触发的事件）`);

    const typeParsed = tryParseId(type, { selfNs: ns });
    if (!typeParsed) fail(`${path}#${id} 的 type 无法解析：${type}`);
    if (!HOOK_MAP.has(typeParsed.id) && !HOOK_MAP.has(type)) {
      // 允许自定义 hook 名，但给出提示性错误，避免拼错静默失效
      fail(`${path}#${id} 的 type 不是已知 hook：${type}（可用 cpl.hooks() 查全部）`);
    }

    return {
      type: typeParsed.id,
      typeNs: typeParsed.ns,
      event,
      eventKind: API_MAP.has(event) ? 'api' : (HOOK_MAP.has(event) ? 'hook' : 'event'),
      args: Array.isArray(a.args) ? a.args : (a.args === undefined ? [] : [a.args]),
      when: a.when && typeof a.when === 'object' ? a.when : null,
    };
  });

  return {
    id,
    name: String(item.name || id).slice(0, 80),
    description: String(item.description || '').slice(0, 400),
    actions,
    before: asArray(item.before).map(String),
    after: asArray(item.after).map(String),
    origin: 'json',
    file: path,
  };
}

module.exports = { parsePackage, PERMISSIONS, MANIFEST };
