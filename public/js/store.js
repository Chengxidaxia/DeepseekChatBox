/* 状态层：全部数据由服务端落盘（data/ 目录），浏览器不保存任何内容。
 * 做法：启动时 GET /api/store 拉全量到内存；之后每次改动就地修改内存对象，
 *       再把变更 PATCH/PUT 回服务端（防抖合并，单机单用户足够）。
 */
export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: true,
  effort: 'high',
  search: false,
  readUrl: false,
  safety: false,
  jsonMode: false,
  temperature: 1,
  topP: null,
  maxTokens: null,
  stop: '',
  systemPrompt: '',
  userId: '',
  reminder: { enabled: true, location: '', language: '中文' },
  theme: 'system',
  lang: 'zh',
  mock: false,
  docLayout: 'text_recognition',
  ttsVoice: 'stella',
  autoTitle: true,
  stream: true,
  localTools: true,
  // 危险：直接在本机 cmd.exe 执行命令，默认关闭，需在设置里显式打开
  cmdEnabled: false,
  // 工具按需加载：每轮最多检索下发几个本地工具（省 token），默认 8
  toolTopK: 8,
  // local = 本机 web_search / fetch_url（可与其他本地工具共存）；official = DeepSeek 官方服务端工具
  searchMode: 'local',
  // 官方峰谷定价（元 / 百万 tokens，2026-11 版「模型 & 价格」页）
  // 空闲价为高峰价的一半：周一至周五 9:00-12:00、14:00-18:00（北京时间）为高峰，其余为空闲
  prices: {
    currency: 'CNY',
    flash: { hitIdle: 0.02, hitPeak: 0.04, missIdle: 1, missPeak: 2, outIdle: 4, outPeak: 8 },
    pro: { hitIdle: 0.15, hitPeak: 0.3, missIdle: 4.5, missPeak: 9, outIdle: 13.5, outPeak: 27 },
  },
  // 计价时段：auto 按北京时间自动判断；idle / peak 强制
  peakMode: 'auto',
  hasKey: false,
  keyPreview: '',
};

export const DEFAULT_UI = { sidebarCollapsed: false, activeId: null };

export const settings = { ...DEFAULT_SETTINGS };
export const ui = { ...DEFAULT_UI };

let convs = [];
let groups = [];
export const meta = { dataDir: '', loaded: false, storage: 'server' };

/** 把旧版单档价格（flashInMiss…）迁移成峰谷双档；没有旧数据则回落官方默认值 */
export function migratePrices(p) {
  const d = DEFAULT_SETTINGS.prices;
  const src = p && typeof p === 'object' ? p : {};
  const out = { currency: src.currency || d.currency };
  for (const model of ['flash', 'pro']) {
    const legacyHit = Number(src[model + 'InHit']);
    const legacyMiss = Number(src[model + 'InMiss']);
    const legacyOut = Number(src[model + 'Out']);
    const hasLegacy = legacyHit > 0 || legacyMiss > 0 || legacyOut > 0;
    if (src[model] && typeof src[model] === 'object') {
      out[model] = { ...d[model], ...src[model] };
    } else if (hasLegacy) {
      // 旧版只有一个价：当作高峰价，空闲价按官方「空闲为高峰一半」折算
      const half = (n) => Math.round((n / 2) * 10000) / 10000;
      out[model] = {
        hitIdle: half(legacyHit), hitPeak: legacyHit,
        missIdle: half(legacyMiss), missPeak: legacyMiss,
        outIdle: half(legacyOut), outPeak: legacyOut,
      };
    } else {
      out[model] = { ...d[model] };
    }
  }
  return out;
}

/** 北京时间是否处于高峰时段（周一至周五 9-12、14-18；法定节假日无法自动判断） */
export function isPeakNow(now = new Date()) {
  // 转成 UTC+8 的「当地」时间分量
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const day = bj.getDay(); // 0 = 周日
  if (day === 0 || day === 6) return false;
  const minutes = bj.getHours() * 60 + bj.getMinutes();
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

function applySettings(obj) {
  const next = Object.assign({}, DEFAULT_SETTINGS, obj || {});
  next.reminder = Object.assign({}, DEFAULT_SETTINGS.reminder, next.reminder || {});
  next.prices = migratePrices(next.prices);
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, next);
}

function applyUi(obj) {
  const next = Object.assign({}, DEFAULT_UI, obj || {});
  for (const k of Object.keys(ui)) delete ui[k];
  Object.assign(ui, next);
}

/* --------------------------- 服务端通信 --------------------------- */
const jsonHeaders = { 'content-type': 'application/json' };

async function req(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    throw new Error(msg || ('HTTP ' + r.status));
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function hasApiKey() {
  return Boolean(settings.hasKey);
}

/** 启动时调用：拉全量状态，必要时从旧版 localStorage 迁移一次 */
export async function initStore() {
  let legacy = null;
  try {
    const lc = localStorage.getItem('dsbox.convs.v1');
    const ls = localStorage.getItem('dsbox.settings.v1');
    const lu = localStorage.getItem('dsbox.ui.v1');
    if (lc || ls || lu) {
      legacy = {
        conversations: lc ? JSON.parse(lc) : [],
        settings: ls ? JSON.parse(ls) : null,
        ui: lu ? JSON.parse(lu) : null,
      };
    }
  } catch {}

  const snap = await req('/api/store');
  applySettings(snap.settings);
  applyUi(snap.ui);
  convs = Array.isArray(snap.conversations) ? snap.conversations : [];
  groups = Array.isArray(snap.groups) ? snap.groups : [];
  meta.dataDir = snap.dataDir || '';
  meta.storage = snap.storage || 'server';
  meta.loaded = true;

  if (legacy && (legacy.conversations?.length || legacy.settings?.apiKey || legacy.settings?.model)) {
    try {
      const hasServerData = convs.length > 0 || settings.hasKey;
      if (!hasServerData) {
        await req('/api/import', {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ mode: 'replace', data: { conversations: legacy.conversations || [], settings: legacy.settings || {}, ui: legacy.ui || {} } }),
        });
        const again = await req('/api/store');
        applySettings(again.settings);
        applyUi(again.ui);
        convs = again.conversations || [];
        groups = again.groups || [];
      }
    } catch (e) {
      console.warn('迁移旧数据失败：', e.message);
    }
  }

  // 不管迁移成功与否，浏览器里不再保留任何业务数据
  for (const k of ['dsbox.convs.v1', 'dsbox.settings.v1', 'dsbox.ui.v1', 'dsbox.welcomed']) {
    try { localStorage.removeItem(k); } catch {}
  }
  return snap;
}

/* --------------------------- 设置 / UI --------------------------- */
let pendingSettings = {};
let settingsTimer = null;
function flushSettings() {
  const patch = pendingSettings;
  pendingSettings = {};
  settingsTimer = null;
  if (!Object.keys(patch).length) return;
  req('/api/settings', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) })
    .then((pub) => { if (pub) applySettings(pub); })
    .catch((e) => console.warn('保存设置失败：', e.message));
}

export function saveSettings(patch) {
  if (patch) {
    Object.assign(settings, patch);
    if ('apiKey' in patch) {
      settings.hasKey = Boolean(patch.apiKey);
      settings.keyPreview = patch.apiKey ? mask(patch.apiKey) : '';
    }
    pendingSettings = { ...pendingSettings, ...patch };
  }
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 250);
}

let pendingUi = {};
let uiTimer = null;
export function saveUI(patch) {
  if (patch) {
    Object.assign(ui, patch);
    pendingUi = { ...pendingUi, ...patch };
  }
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const body = pendingUi;
    pendingUi = {};
    req('/api/ui', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body) }).catch(() => {});
  }, 250);
}

function mask(k) {
  if (!k) return '';
  return k.length <= 10 ? '****' : k.slice(0, 5) + '…' + k.slice(-4);
}

/** 立即把未提交的变更写回（关页面前用） */
export function flushNow() {
  if (Object.keys(pendingSettings).length) flushSettings();
  if (Object.keys(pendingUi).length) {
    const body = pendingUi;
    pendingUi = {};
    try {
      fetch('/api/ui', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body), keepalive: true });
    } catch {}
  }
  if (convTimer) {
    clearTimeout(convTimer);
    convTimer = null;
    try {
      fetch('/api/conversations', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ mode: 'replace', conversations: convs }),
        keepalive: true,
      });
    } catch {}
  }
}

/* ------------------------------ 对话 ------------------------------ */
export function allConversations() {
  return convs;
}

let convTimer = null;
let convInFlight = false;
let convDirty = false;

function flushConversations() {
  if (convInFlight) { convDirty = true; return; }
  convInFlight = true;
  convDirty = false;
  req('/api/conversations', {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ mode: 'replace', conversations: convs }),
  })
    .catch((e) => console.warn('保存对话失败：', e.message))
    .finally(() => {
      convInFlight = false;
      if (convDirty) flushConversations();
    });
}

export function saveConversations() {
  clearTimeout(convTimer);
  convTimer = setTimeout(flushConversations, 300);
}

export function saveConversationsNow() {
  clearTimeout(convTimer);
  convTimer = null;
  flushConversations();
}

export function getConversation(id) {
  return convs.find((c) => c.id === id) || null;
}

export function createConversation(partial = {}) {
  const now = Date.now();
  const conv = {
    id: 'c_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    title: '',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messages: [],
    ...partial,
  };
  convs.unshift(conv);
  saveConversations();
  return conv;
}

export function updateConversation(id, patch) {
  const c = getConversation(id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: Date.now() });
  saveConversations();
  return c;
}

export function deleteConversation(id) {
  const i = convs.findIndex((c) => c.id === id);
  if (i >= 0) {
    convs.splice(i, 1);
    saveConversations();
    return true;
  }
  return false;
}

export function clearAllConversations() {
  convs = [];
  saveConversations();
}

/** 导入：本地合并/替换后整体覆盖到服务端 */
export async function importConversations(list, mode = 'merge') {
  const incoming = (Array.isArray(list) ? list : []).filter((c) => c && Array.isArray(c.messages)).map((c) => ({
    id: c.id || 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: c.title || '',
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
    pinned: Boolean(c.pinned),
    messages: c.messages.map((m) => ({
      id: m.id || 'm_' + Math.random().toString(36).slice(2, 8),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : '',
      reasoning: m.reasoning || '',
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      annotations: Array.isArray(m.annotations) ? m.annotations : [],
      serverToolCalls: Array.isArray(m.serverToolCalls) ? m.serverToolCalls : [],
      usage: m.usage || null,
      model: m.model || '',
      createdAt: m.createdAt || Date.now(),
    })),
  }));
  if (mode === 'replace') convs = incoming;
  else {
    const ids = new Set(convs.map((c) => c.id));
    for (const c of incoming) if (!ids.has(c.id)) convs.push(c);
  }
  convs.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  await req('/api/conversations', {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ mode: 'replace', conversations: convs }),
  }).catch(() => {});
  return incoming.length;
}

export async function clearAllOnServer() {
  convs = [];
  await req('/api/conversations', { method: 'DELETE' }).catch(() => {});
}

/** 按「置顶 / 今天 / 7 天内 / 30 天内 / 月份」分组 */
export function groupConversations(list) {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = dayStart - 6 * 864e5;
  const month = dayStart - 29 * 864e5;
  const groups = new Map();
  const put = (key, item) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  };
  const sorted = [...list].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  for (const c of sorted) {
    if (c.pinned) { put('__pinned', c); continue; }
    const t = c.updatedAt || c.createdAt;
    if (t >= dayStart) put('__today', c);
    else if (t >= week) put('__week', c);
    else if (t >= month) put('__month', c);
    else {
      const d = new Date(t);
      put(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, c);
    }
  }
  const order = ['__pinned', '__today', '__week', '__month'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return b.localeCompare(a);
  });
  return keys.map((k) => ({ key: k, items: groups.get(k) }));
}

export function searchConversations(query) {
  const q = query.trim().toLowerCase();
  if (!q) return allConversations();
  return allConversations().filter((c) => {
    if ((c.title || '').toLowerCase().includes(q)) return true;
    return (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
  });
}

/* ---------------------------- 附件（服务端落盘） ---------------------------- */
export async function uploadAttachment(blob, filename) {
  const r = await fetch('/api/attachments', {
    method: 'POST',
    headers: {
      'content-type': blob.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(filename || 'file'),
    },
    body: blob,
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error; } catch {}
    throw new Error(msg || ('HTTP ' + r.status));
  }
  return JSON.parse(text);
}

export function attachmentUrl(id) {
  return '/api/attachments/' + encodeURIComponent(id);
}

/* ------------------------------ 分组 ------------------------------ */
export function allGroups() {
  return groups;
}

export function getGroup(id) {
  return groups.find((g) => g.id === id) || null;
}

let groupsTimer = null;
export function saveGroups() {
  clearTimeout(groupsTimer);
  groupsTimer = setTimeout(() => {
    req('/api/groups', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ groups }) })
      .catch((e) => console.warn('保存分组失败：', e.message));
  }, 250);
}

export function createGroup(name, settingsPatch = {}) {
  const g = {
    id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: name || '新分组',
    createdAt: Date.now(),
    settings: settingsPatch.settings || {},
  };
  groups.push(g);
  saveGroups();
  return g;
}

export function updateGroup(id, patch) {
  const g = getGroup(id);
  if (!g) return null;
  Object.assign(g, patch);
  saveGroups();
  return g;
}

export function deleteGroup(id) {
  const i = groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  groups.splice(i, 1);
  for (const c of convs) if (c.groupId === id) c.groupId = null;
  saveGroups();
  saveConversations();
  return true;
}

export function moveConversationToGroup(convId, groupId) {
  const c = getConversation(convId);
  if (!c) return;
  c.groupId = groupId || null;
  c.updatedAt = Date.now();
  saveConversations();
}

/** 生效设置：全局 ← 分组 ← 会话，逐层覆盖 */
export function effectiveSettings(conv) {
  const g = conv && conv.groupId ? getGroup(conv.groupId) : null;
  return {
    ...settings,
    ...(g && g.settings ? g.settings : {}),
    ...(conv && conv.settings ? conv.settings : {}),
  };
}

/** 当前会话是否有自定义设置（含所属分组） */
export function hasCustomScope(conv) {
  if (!conv) return false;
  const g = conv.groupId ? getGroup(conv.groupId) : null;
  return Boolean(conv.settings?.custom || g?.settings?.custom);
}
