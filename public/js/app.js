/* DeepSeek Chatbox —— 主流程 */
import { $, $$, h, uid, uuid, escapeHtml, formatBytes, formatTime, copyText, toast, compressImage, readAsText, download, debounce, estimateTokens } from './util.js';
import {
  settings, ui, meta as storeMeta, saveSettings, saveUI, allConversations, getConversation,
  createConversation, updateConversation, deleteConversation, saveConversations, groupConversations,
  searchConversations, initStore, hasApiKey, uploadAttachment, attachmentUrl, flushNow,
  allGroups, getGroup, createGroup, updateGroup, deleteGroup, moveConversationToGroup,
  effectiveSettings, hasCustomScope, isPeakNow, isPeakAt,
  exportAllData,
} from './store.js';
import { setLang, applyStatic, t, getLang } from './i18n.js';
import { renderMarkdown, hydrateMermaid, toPlainText, resetMermaidTheme } from './markdown.js';
import {
  cachedModels, modelInfo, supportsVision, listModels, getBalance, uploadFile,
  synthesize, transcribe, buildPayload, streamChat, buildReminder, measureRequest,
  getToolDefinitions, callTool,
} from './api.js';
import { openSettings } from './settings.js';
import { openScopeSettings } from './scope.js';
import { appPrompt, appConfirm } from './dialog.js';
import { normalizeConv, visibleMessages, chainTail, messageVersions, appendBranch, selectVersion, cutAfter } from './branches.js';
import { WHALE_PATHS } from './brand.js';

const state = {
  currentId: null,
  streaming: false,
  stopped: false,      // 用户点了停止：工具轮/工具执行循环据此尽早退出
  followBottom: true,  // 是否跟随输出滚动：用户手动上翻时置 false
  controller: null,
  attachments: [],
  models: cachedModels(),
  audio: null,
  recording: null,
  searchQuery: '',
  menu: null,
  menuOnClose: null,
  menuAnchor: null,   // 当前菜单的锚点，用来判断「再点一次同一个按钮 = 收起」
  selection: null,   // Set<convId>：非 null 即处于多选态
};

/** 当前会话的生效设置（全局 ← 分组 ← 会话） */
function eff() {
  return effectiveSettings(currentConversation());
}

/** 修改一个生效设置：有自定义作用域就写当前会话，否则写全局 */
function setEffective(key, value) {
  const conv = currentConversation();
  if (conv && hasCustomScope(conv)) {
    const next = { ...effectiveSettings(conv), [key]: value, custom: true };
    conv.settings = next;
    updateConversation(conv.id, { settings: next });
  } else {
    saveSettings({ [key]: value });
  }
  updateComposerState();
  renderChat();
}

const els = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  chatList: $('#chatList'),
  chatView: $('#chatView'),
  viewInner: $('#viewInner'),
  prompt: $('#prompt'),
  promptMirror: $('#promptMirror'),
  spectrum: $('#spectrum'),
  searchPanel: $('#searchPanel'),
  shell: $('#inputShell'),
  tray: $('#attachTray'),
  send: $('#btnSend'),
  think: $('#btnThink'),
  search: $('#btnSearch'),
  effort: $('#btnEffort'),
  tools: $('#btnTools'),
  effortLabel: $('#effortLabel'),
  modelName: $('#modelName'),
  topbarTitle: $('#topbarTitle'),
  foot: $('#composerFoot'),
  fileInput: $('#fileInput'),
  mockBadge: $('#mockBadge'),
  streamBadge: $('#streamBadge'),
  keyHint: $('#keyHint'),
  balanceHint: $('#balanceHint'),
  searchWrap: $('#searchWrap'),
  chatSearchInput: $('#chatSearchInput'),
  scrim: $('#scrim'),
  mic: $('#btnMic'),
  selectHead: $('#selectHead'),
  selectCount: $('#selectCount'),
  bulkBar: $('#bulkBar'),
  bulkAll: $('#bulkAllBox'),
  bulkTotal: $('#bulkTotal'),
  bulkPin: $('#btnBulkPin'),
  bulkDelete: $('#btnBulkDelete'),
  bulkExportBtn: $('#btnBulkExport'),
  newChatBtn: $('#btnNewChat'),
};

/* ------------------------------ 主题 / 语言 ------------------------------ */
function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark());
  document.body.dataset.theme = dark ? 'dark' : 'light';
  $('#hljs-light').disabled = dark;
  $('#hljs-dark').disabled = !dark;
  $('#btnTheme').innerHTML = `<svg class="icon"><use href="#${dark ? 'i-sun' : 'i-moon'}"/></svg>`;
  resetMermaidTheme();
  // 重绘 Mermaid（主题变了要重新渲染）
  $$('.mermaid-wrap[data-rendered]').forEach((n) => {
    delete n.dataset.rendered;
  });
  hydrateMermaid(els.viewInner);
}
function applyLang() {
  setLang(settings.lang);
  applyStatic();
  els.prompt.placeholder = t('placeholder');
  els.chatSearchInput.placeholder = t('searchPlaceholder');
  $('#btnTheme').title = t('theme');
  renderSidebar();
  renderChat();
  updateComposerState();
}

/* ------------------------------ 侧栏 ------------------------------ */
function convTitle(c) {
  if (c.title && c.title.trim()) return c.title.trim();
  const first = (c.messages || []).find((m) => m.role === 'user' && m.content);
  if (first) return toPlainText(first.content).slice(0, 34) || '新对话';
  return '新对话';
}

function renderSidebar() {
  const list = state.searchQuery ? searchConversations(state.searchQuery) : allConversations();
  els.chatList.replaceChildren();
  syncTopbarTitle(currentConversation());
  syncSelectionUI(list);

  const groups = allGroups();
  const collapsed = new Set(ui.collapsedGroups || []);
  const inAnyGroup = new Set();

  for (const g of groups) {
    const items = list.filter((c) => c.groupId === g.id);
    items.forEach((c) => inAnyGroup.add(c.id));
    if (state.searchQuery && !items.length) continue;
    els.chatList.append(groupSection(g, items, collapsed.has(g.id)));
  }

  const rest = list.filter((c) => !inAnyGroup.has(c.id));
  if (!rest.length && !groups.length) {
    els.chatList.append(h('div', { class: 'sidebar-empty', text: state.searchQuery ? t('noMatch') : t('emptyChats') }));
    return;
  }

  const label = (k) => (k === '__pinned' ? t('pinned') : k === '__today' ? t('today') : k === '__week' ? t('week') : k === '__month' ? t('month') : k.replace('-', '年') + '月');
  for (const g of groupConversations(rest)) {
    const wrap = h('div', { class: 'chat-group' });
    const title = h('div', { class: 'chat-group-title' }, [
      h('span', { class: 'name', text: label(g.key) }),
    ]);
    // 官方分组行右侧有「多选」按钮（悬停显形），点了进入该组的批量选择
    if (g.items.length) {
      const bulk = h('button', { class: 'icon-btn sm group-bulk', type: 'button', title: t('multiSelect') }, [iconEl('i-multiselect')]);
      bulk.addEventListener('click', (e) => { e.stopPropagation(); enterSelection(null); });
      title.append(bulk);
    }
    wrap.append(title);
    for (const c of g.items) wrap.append(convRow(c));
    els.chatList.append(wrap);
  }
}

function groupSection(g, items, isCollapsed) {
  const wrap = h('div', { class: 'chat-group folder-group' });
  const head = h('div', { class: 'folder-head' + (isCollapsed ? ' collapsed' : '') });
  head.append(iconEl('i-chevron', 'chev'));
  head.append(iconEl('i-folder'));
  head.append(h('span', { class: 'name', text: g.name, title: g.name }));
  head.append(h('span', { class: 'count', text: String(items.length) }));

  // 与对话行一致：右侧「…」开关式菜单（hover 出现，点同一个再点一次收起）
  const mask = h('div', { class: 'row-mask folder-mask' });
  const more = h('button', { class: 'icon-btn', type: 'button', title: t('more'), 'aria-label': t('more') }, [iconEl('i-more')]);
  more.addEventListener('click', (e) => {
    e.stopPropagation();                                  // 别把点击冒泡成「折叠分组」
    if (state.menu && state.menuAnchor === more) { closeMenu(); return; }
    head.classList.add('menu-open');
    folderMenu(g, items, more, () => head.classList.remove('menu-open'));
  });
  mask.append(more);
  head.append(mask);
  head.addEventListener('click', () => {
    const set = new Set(ui.collapsedGroups || []);
    if (set.has(g.id)) set.delete(g.id);
    else set.add(g.id);
    saveUI({ collapsedGroups: [...set] });
    renderSidebar();
  });
  wrap.append(head);

  if (!isCollapsed) {
    if (!items.length) {
      wrap.append(h('div', { class: 'folder-empty', text: '空分组 · 把对话移进来或点 + 新建' }));
    } else {
      for (const c of items) wrap.append(convRow(c));
    }
  }
  return wrap;
}

/* 分组行「…」菜单：新建对话 / 分组设置 / 重命名 / 多选本组 / 删除 */
function folderMenu(g, items, anchor, onClose) {
  const mk = (iconId, text, fn, extra = '') => {
    const b = h('button', { class: 'menu-item' + extra, type: 'button' }, [iconEl(iconId), h('span', { text })]);
    b.addEventListener('click', () => { closeMenu(); fn(); });
    return b;
  };
  const menu = [
    mk('i-plus', '在此分组新建对话', () => {
      newChat();
      const conv = ensureConversation();
      moveConversationToGroup(conv.id, g.id);
      renderSidebar();
    }),
    mk('i-edit', '重命名分组', async () => {
      const name = await appPrompt({ title: '重命名分组', value: g.name, okText: '保存' });
      if (name === null) return;
      updateGroup(g.id, { name: name.trim() || g.name });
      renderSidebar();
    }),
    mk('i-settings', '分组设置', () => openScopeSettings({ kind: 'group', id: g.id, onChange: onScopeChange })),
    h('div', { class: 'menu-sep' }),
    mk('i-multiselect', t('multiSelect'), () => enterSelection(items.map((c) => c.id))),
    mk('i-trash', '删除分组', async () => {
      const ok = await appConfirm({
        title: '删除分组',
        message: `删除分组「${g.name}」？组内对话会退回未分组，不会被删除。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      deleteGroup(g.id);
      renderSidebar();
      renderChat();
    }, ' danger'),
  ];
  showMenu(anchor, menu, 'down');
  state.menuOnClose = onClose || null;
}

function convRow(c) {
  const selecting = !!state.selection;
  const checked = selecting && state.selection.has(c.id);
  const row = h('div', {
    class: 'chat-item' + (c.id === state.currentId ? ' active' : '') + (selecting ? ' selectable' : '') + (checked ? ' checked' : ''),
    'data-id': c.id,
  });

  if (selecting) row.append(h('span', { class: 'cbx' }, [iconEl('i-check')]));

  const title = h('span', { class: 'title', text: convTitle(c), title: convTitle(c) });
  if (hasCustomScope(c)) title.append(h('span', { class: 'scope-dot', title: '该对话使用自定义设置' }));
  row.append(title);

  if (!selecting) {
    const mask = h('div', { class: 'row-mask' });
    const more = h('button', { class: 'icon-btn', type: 'button', title: t('more'), 'aria-label': t('more') }, [iconEl('i-more')]);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      // 同一个「…」再点一次 = 收起（开关式），不要重开
      if (state.menu && state.menuAnchor === more) { closeMenu(); return; }
      row.classList.add('menu-open');
      rowMenu(c, more, () => row.classList.remove('menu-open'));
    });
    mask.append(more);
    row.append(mask);
  }

  row.addEventListener('click', () => {
    if (state.selection) { toggleSelection(c.id); return; }
    if (state.searchQuery) { state.searchQuery = ''; els.searchWrap.classList.add('hidden'); els.chatSearchInput.value = ''; }
    openConversation(c.id);
  });
  return row;
}

/* 行尾「…」菜单：对齐官方（重命名 / 置顶 / 多选 / 删除），额外的分组项放中间 */
function rowMenu(c, anchor, onClose) {
  const mk = (iconId, text, fn, extra = '') => {
    const b = h('button', { class: 'menu-item' + extra, type: 'button' }, [iconEl(iconId), h('span', { text })]);
    b.addEventListener('click', () => { closeMenu(); fn(); });
    return b;
  };
  const items = [
    mk('i-edit', t('rename'), () => { renameConversation(c); }),
    mk(c.pinned ? 'i-pin-off' : 'i-pin', c.pinned ? t('unpin') : t('pin'), () => {
      updateConversation(c.id, { pinned: !c.pinned });
      renderSidebar();
    }),
    mk('i-folder', t('moveGroup'), () => { setTimeout(() => moveMenu(c, anchor), 0); }),
    h('div', { class: 'menu-sep' }),
    mk('i-multiselect', t('multiSelect'), () => { enterSelection(c.id); }),
    mk('i-trash', t('del'), () => { removeConversation(c); }, ' danger'),
  ];
  showMenu(anchor, items, 'down');
  state.menuOnClose = onClose || null;
}

function moveMenu(conv, anchor) {
  const groups = allGroups();
  const items = [];
  if (groups.length) {
    for (const g of groups) {
      const b = h('button', { class: 'menu-item' + (conv.groupId === g.id ? ' selected' : ''), type: 'button' }, [
        iconEl('i-folder'),
        h('span', { text: g.name }),
        conv.groupId === g.id ? iconEl('i-check', 'check') : null,
      ]);
      b.addEventListener('click', () => {
        moveConversationToGroup(conv.id, g.id);
        closeMenu();
        renderSidebar();
        renderChat();
      });
      items.push(b);
    }
    items.push(h('div', { class: 'menu-sep' }));
  }
  const out = h('button', { class: 'menu-item', type: 'button' }, [iconEl('i-x'), h('span', { text: '移出分组' })]);
  out.addEventListener('click', () => {
    moveConversationToGroup(conv.id, null);
    closeMenu();
    renderSidebar();
  });
  items.push(out);

  const create = h('button', { class: 'menu-item', type: 'button' }, [iconEl('i-plus'), h('span', { text: '新建分组并移入' })]);
  create.addEventListener('click', async () => {
    const name = await appPrompt({ title: '新建分组', value: '新分组', placeholder: '分组名称', okText: '创建' });
    if (name === null || !name.trim()) return;
    const g = createGroup(name.trim());
    moveConversationToGroup(conv.id, g.id);
    closeMenu();
    renderSidebar();
  });
  items.push(create);

  showMenu(anchor, [h('div', { class: 'popover-title', text: '移动到分组' }), ...items], 'down');
}

function onScopeChange() {
  renderSidebar();
  renderChat();
  updateComposerState();
}

async function renameConversation(c) {
  const name = await appPrompt({ title: t('rename'), value: convTitle(c), okText: '保存' });
  if (name === null) return;
  updateConversation(c.id, { title: name.trim() || convTitle(c) });
  renderSidebar();
  if (c.id === state.currentId) renderChat();
}

async function removeConversation(c) {
  const ok = await appConfirm({
    title: t('del'),
    message: `${t('delConfirm')}\n「${convTitle(c)}」`,
    okText: t('del'),
    danger: true,
  });
  if (!ok) return;
  deleteConversation(c.id);
  if (state.currentId === c.id) {
    state.currentId = null;
    syncRoute();              // 当前会话被删，回根路径
    renderChat();
  }
  renderSidebar();
}

/* ------------------------------ 多选（批量） ------------------------------ */
function enterSelection(seed) {
  closeMenu();
  const ids = Array.isArray(seed) ? seed : (seed ? [seed] : []);
  state.selection = new Set(ids);
  renderSidebar();
}

function exitSelection() {
  state.selection = null;
  renderSidebar();
}

function toggleSelection(id) {
  const set = state.selection;
  if (!set) return;
  if (set.has(id)) set.delete(id); else set.add(id);
  renderSidebar();
}

/** 同步多选态 UI：头部文案、底栏、按钮可用性、勾选框 */
function syncSelectionUI(list) {
  const on = !!state.selection;
  els.app.classList.toggle('multi', on);
  els.bulkBar.classList.toggle('hidden', !on);
  els.selectHead.classList.toggle('hidden', !on);
  els.newChatBtn?.classList.toggle('hidden', on);
  if (!on) {
    els.selectCount.textContent = t('selectChats');
    return;
  }
  const n = state.selection.size;
  els.selectCount.textContent = n ? t('selectedCount', { n }) : t('selectChats');
  const total = (list || allConversations()).length;
  els.bulkTotal.textContent = t('totalChats', { n: total });
  els.bulkPin.disabled = !n;
  els.bulkDelete.disabled = !n;
  const allPinned = n > 0 && [...state.selection].every((id) => getConversation(id)?.pinned);
  els.bulkPin.querySelector('span').textContent = allPinned ? t('unpin') : t('pin');
  els.bulkPin.querySelector('use').setAttribute('href', allPinned ? '#i-pin-off' : '#i-pin');
  els.bulkAll.classList.toggle('on', n > 0 && n >= total);
  els.bulkAll.classList.toggle('partial', n > 0 && n < total);
  els.bulkExportBtn.disabled = !n;
}

function bulkPinSelected() {
  const set = state.selection;
  if (!set?.size) return;
  const allPinned = [...set].every((id) => getConversation(id)?.pinned);
  for (const id of set) updateConversation(id, { pinned: !allPinned });
  toast(allPinned ? t('unpin') : t('pin'));
  renderSidebar();
}

async function bulkDeleteSelected() {
  const set = state.selection;
  if (!set?.size) return;
  const n = set.size;
  const ok = await appConfirm({
    title: t('del'),
    message: `删除选中的 ${n} 个对话？此操作不可恢复。`,
    okText: t('del'),
    danger: true,
  });
  if (!ok) return;
  const ids = [...set];
  for (const id of ids) deleteConversation(id);
  if (ids.includes(state.currentId)) {
    state.currentId = null;
    syncRoute();
    renderChat();
  }
  state.selection = null;
  renderSidebar();
  toast(`已删除 ${n} 个对话`);
}

function bulkExportSelected() {
  const set = state.selection;
  if (!set?.size) return;
  const convs = [...set].map((id) => getConversation(id)).filter(Boolean);
  if (convs.length === 1) { exportConversation(convs[0].id); return; }
  const lines = [`# DeepSeek Chatbox 对话导出`, '', `> 导出时间：${new Date().toLocaleString()}　共 ${convs.length} 个对话`, ''];
  for (const c of convs) {
    lines.push(`---`, '', `# ${convTitle(c)}`, '');
    for (const m of c.messages) {
      if (m.role === 'user') {
        lines.push('## 你', '', m.content || '', '');
      } else {
        lines.push('## DeepSeek', '');
        if (m.reasoning) lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>', '');
        lines.push(m.content || '', '');
      }
    }
    lines.push('');
  }
  download(`deepseek-chatbox-${convs.length}chats-${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n'), 'text/markdown');
}

function bulkToggleAll() {
  const list = state.searchQuery ? searchConversations(state.searchQuery) : allConversations();
  const set = state.selection;
  if (!set) return;
  if (set.size >= list.length) set.clear();
  else for (const c of list) set.add(c.id);
  renderSidebar();
}

/* ------------------------------ 会话视图 ------------------------------ */
function openConversation(id) {
  if (state.streaming) stopStreaming();
  state.currentId = id;
  state.followBottom = true;   // 切会话总是落在最新一条
  syncRoute(true);          // 切会话记一条历史，支持浏览器后退
  renderSidebar();
  renderChat();
  closeSidebarOnMobile();
}

function newChat() {
  if (state.selection) exitSelection();
  if (state.streaming) stopStreaming();
  state.currentId = null;
  state.followBottom = true;
  syncRoute(true);          // 新对话回根路径，记一条历史
  state.attachments = [];
  renderTray();
  els.prompt.value = '';
  autoGrow();
  updateComposerState();
  renderSidebar();
  renderChat();
  els.prompt.focus();
  closeSidebarOnMobile();
}

function currentConversation() {
  return state.currentId ? getConversation(state.currentId) : null;
}

// 每个会话上一轮下发过的工具名（有序）。tools 保持不变 → 请求前缀能连续命中缓存。
const stickyToolsByConv = new Map();

// 工具定义缓存：上下文用量面板要按真实请求统计「工具定义」那段的 token，
// 面板是同步渲染的，所以启动时就先拉一份（失败不影响发送，发送时会再拉）。
let toolDefsCache = [];
function prefetchToolDefs() {
  getToolDefinitions()
    .then((d) => { toolDefsCache = d || []; updateCtxChip(true); })
    .catch(() => {});
}

const APP_TITLE = 'Deepseek ChatBox';
/** 顶栏左端显示当前会话标题（官方 chat 的做法）；欢迎页没有标题就留空 */
function syncTopbarTitle(conv) {
  if (!els.topbarTitle) return;
  const title = (conv && conv.title) || '';
  els.topbarTitle.textContent = title;
  els.topbarTitle.title = title;
  // 网页标签：<会话标题> - Deepseek ChatBox；欢迎页用纯应用名
  document.title = title ? `${title} - ${APP_TITLE}` : APP_TITLE;
}

/* ------------------------- 会话路由（官方风格 URL） ------------------------- */
// 官方 chat：https://chat.deepseek.com/a/chat/s/<uuid>
// 本地对应：http://127.0.0.1:17321/a/chat/s/<conv.uuid>
const CHAT_PATH = '/a/chat/s/';
let suppressPopRoute = false;   // popstate 恢复会话时抑制再次 push，避免历史栈打转

/** 当前会话对应的分享路径；欢迎页回根路径 */
function convPath(conv) {
  if (!conv) return '/';
  if (!conv.uuid) { conv.uuid = uuid(); saveConversations(); }  // 旧会话懒迁移
  return CHAT_PATH + encodeURIComponent(conv.uuid);
}

/** 更新地址栏。push=true 记一条历史（切会话）；false=replace（首次打开/纠正 URL） */
function syncRoute(push = false) {
  if (suppressPopRoute) return;
  const target = convPath(currentConversation());
  const here = location.pathname;
  if (here === target) return;
  try {
    // 保留 ?q= / ?demo= / ?fast= 这类一次性参数，不打断现有入口
    history[push ? 'pushState' : 'replaceState']({ dsConv: state.currentId || null }, '', target + location.search);
  } catch {}
}

/** 从地址栏解析出会话（按 uuid，兼容旧 id），找不到返回 null */
function convFromRoute() {
  const m = location.pathname.match(/^\/a\/chat\/s\/([^/]+)\/?$/);
  if (!m) return null;
  let key = m[1];
  try { key = decodeURIComponent(key); } catch {}
  return allConversations().find((c) => c.uuid === key || c.id === key) || null;
}

/** 浏览器前进/后退：按 URL 切会话，不写历史 */
function applyRouteFromHistory() {
  const conv = convFromRoute();
  const id = conv ? conv.id : null;
  if (id === state.currentId) return;
  suppressPopRoute = true;
  try {
    if (state.streaming) stopStreaming();
    state.currentId = id;
    state.followBottom = true;
    renderSidebar();
    renderChat();
    closeSidebarOnMobile();
  } finally {
    suppressPopRoute = false;
  }
}

function ensureConversation() {  if (state.currentId && getConversation(state.currentId)) return getConversation(state.currentId);
  const c = createConversation({ title: '' });
  state.currentId = c.id;
  return c;
}

function renderChat() {
  const conv = currentConversation();
  syncTopbarTitle(conv);
  els.viewInner.replaceChildren();
  const list = conv ? visibleMessages(conv) : [];
  updateCtxChip();
  if (!conv || !list.length) {
    els.viewInner.append(welcomeView());
    return;
  }
  const versions = messageVersions(conv);
  // 先规划：连续「纯工具」往返连同紧随其后的收尾正文合并成一条助手消息
  //（官方风格：工具调用、思考、正文在同一条回答里，用量也只显示一行）
  const items = [];
  for (const m of list) {
    if (m.role === 'tool') continue; // 结果已合并进对应的调用卡片
    if (isToolOnlyMessage(m)) {
      const last = items[items.length - 1];
      if (last && last.run && !last.answer) last.msgs.push(m);
      else items.push({ run: true, msgs: [m], answer: null });
    } else {
      const last = items[items.length - 1];
      if (last && last.run && !last.answer && m.role === 'assistant'
          && !(m.toolCalls || []).length && !(m.serverToolCalls || []).length) {
        // 同一轮问答的收尾正文，并进上面的工具气泡
        last.answer = m;
      } else {
        items.push({ run: false, m });
      }
    }
  }
  for (const it of items) {
    const node = it.run
      ? toolRunView(it.msgs, it.answer, versions)
      : messageView(it.m, versions);
    if (node) els.viewInner.append(node);
  }
  requestAnimationFrame(() => scrollToBottom());
  hydrateMermaid(els.viewInner).then(() => requestAnimationFrame(() => scrollToBottom()));
}

function welcomeView() {
  const wrap = h('div', { class: 'welcome' });
  const title = h('div', { class: 'welcome-title' }, [
    h('svg', { class: 'whale', viewBox: '0 0 27 23', html: WHALE_PATHS }),
    h('span', { text: state.currentId ? t('welcome') : t('welcomeBack') }),
  ]);
  wrap.append(title);

  if (!hasApiKey() && !settings.mock) {
    const go = h('button', { class: 'btn sm primary', type: 'button', text: t('openSettings') });
    go.addEventListener('click', () => openSettings({ onChange: onSettingsChange }));
    const banner = h('div', { class: 'notice info', style: { maxWidth: '600px', textAlign: 'left', marginBottom: '20px', alignItems: 'center' } }, [
      iconEl('i-warning'),
      h('div', { style: { flex: '1', minWidth: '0' }, text: t('needKeyBanner') }),
      go,
    ]);
    wrap.append(banner);
  }

  const samples = getLang() === 'zh'
    ? ['解释一下 Transformer 的注意力机制', '帮我写一个批量重命名的脚本', '总结这个链接的要点：https://api-docs.deepseek.com/zh-cn/', '把这段话改写成更正式的邮件']
    : ['Explain attention in Transformers', 'Write a batch rename script', 'Summarize https://api-docs.deepseek.com/', 'Rewrite this as a formal email'];
  const chips = h('div', { class: 'welcome-chips' }, samples.map((s) => {
    const b = h('button', { class: 'chip', type: 'button', text: s });
    b.addEventListener('click', () => { els.prompt.value = s; autoGrow(); updateComposerState(); els.prompt.focus(); });
    return b;
  }));
  wrap.append(chips);
  // 官方 chat-demo 在移动端欢迎页底部有一条内容声明（桌面端不显示）
  wrap.append(h('div', { class: 'welcome-caveat', text: t('contentCaveat') }));
  return wrap;
}

/* ------------------------------ 消息渲染 ------------------------------ */
function messageView(m, versions) {
  if (m.role === 'tool') return null; // 工具结果合并到调用卡片里显示
  if (m.role === 'user') {
    const wrap = h('div', { class: 'msg user', 'data-id': m.id });
    const bubble = h('div', { class: 'bubble' });
    if (m.attachments?.length) bubble.append(attachGridView(m.attachments));
    if (m.content) bubble.append(h('div', { text: m.content }));
    wrap.append(bubble);

    // 操作条放在气泡下方（官方就是气泡下面一行），不要挤在同一行
    const acts = h('div', { class: 'msg-actions' });
    acts.append(
      actBtn('i-copy', t('copy'), () => copyMessage(m)),
      actBtn('i-edit', t('edit'), () => startEdit(m)),
    );
    const convU = currentConversation();
    const swU = convU ? branchSwitcher(convU, m, versions) : null;
    if (swU) wrap.append(h('div', { class: 'user-bar' }, [swU, acts]));
    else wrap.append(acts);
    return wrap;
  }

  const wrap = h('div', { class: 'msg assistant', 'data-id': m.id });
  const body = h('div', { class: 'body' });
  body.append(...assistantBodyParts(m, versions));
  wrap.append(body);
  return wrap;
}

/** 助手消息正文（思考/工具/正文/操作条/用量），单条消息与合并气泡共用 */
function assistantBodyParts(m, versions, { withUsage = true } = {}) {
  const parts = [];

  if (m.reasoning) parts.push(thinkingView(m));
  if (m.toolCalls?.length) parts.push(toolGroupEl(collectToolCalls(m), `m:${m.id}`));
  if (m.serverToolCalls?.length) parts.push(toolCardsView(m.serverToolCalls));

  if (m.error) {
    parts.push(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: m.error })]));
  }
  if (m.refusal) {
    parts.push(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: m.refusal })]));
  }

  const content = h('div', { class: 'md' });
  content.innerHTML = renderMarkdown(m.content || '', { annotations: m.annotations || [] });
  if (m.streaming) content.classList.add('cursor');
  if (m.content || !m.error) parts.push(content);

  if (m.finishReason === 'length') {
    parts.push(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: t('finishLength') })]));
  }
  if (m.finishReason === 'content_filter' && !m.refusal) {
    parts.push(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: t('refusal') })]));
  }

  const acts = h('div', { class: 'msg-actions' });
  acts.append(actBtn('i-copy', t('copy'), () => copyMessage(m)));
  if (!m.streaming) {
    acts.append(actBtn('i-refresh', t('regenerate'), () => regenerate(m)));
    acts.append(actBtn('i-speaker', t('readAloud'), (btn) => readAloud(m, btn)));
    const isLast = (() => { const c = currentConversation(); return c ? chainTail(c)?.id === m.id : false; })();
    if (isLast && m.content && !m.toolCalls?.length) acts.append(actBtn('i-arrow-up', t('continue'), () => continueGeneration(m)));
  }
  // 分支切换器必须常显（否则用户不知道有多版本），和 hover 才出现的操作按钮并排
  const convNow = currentConversation();
  const sw = convNow ? branchSwitcher(convNow, m, versions) : null;
  parts.push(sw ? h('div', { class: 'msg-bar' }, [sw, acts]) : acts);

  if (withUsage && m.usage) parts.push(usageLine(m));
  return parts;
}

function thinkingView(m) {
  const seconds = m.reasoningSeconds ? Math.max(1, Math.round(m.reasoningSeconds)) : null;
  const collapsed = !m.streaming;
  const box = h('div', { class: 'think' + (collapsed ? ' collapsed' : '') + (m.streaming && !m.content ? ' streaming' : '') });
  box.dataset.thinkFor = m.id;
  const head = h('button', { class: 'think-head', type: 'button' }, [
    h('span', { class: 'label', text: m.streaming && !m.content ? t('thinking') : seconds ? `${t('thought')}（${seconds}s）` : t('thought') }),
    iconEl('i-chevron', 'chev'),
  ]);
  const bodyEl = h('div', { class: 'think-body', text: m.reasoning });
  head.addEventListener('click', () => box.classList.toggle('collapsed'));
  box.append(head, bodyEl);
  return box;
}

function prettyArgs(raw) {
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

/** 联网类工具显示具体在搜什么/读哪一篇，比只写工具名有用 */
const TOOL_META = { web_search: ['联网搜索', 'i-globe'], fetch_url: ['读取网页', 'i-file'] };

/* 展开状态：renderChat 会整体重绘，用 Set 记住用户点开过哪些组/行 */
const toolGroupOpen = new Set();
const toolRowOpen = new Set();

/* 一次提问最多允许「模型请求工具 → 本地执行 → 再请求」的轮数。
   用尽后不再静默中断，而是告诉模型收尾（禁用工具，只让它基于已有结果作答）。 */
const MAX_TOOL_ROUNDS = 10;
const TOOL_LIMIT_NOTE = (n) => `【系统提示】本次提问中，「请求工具 → 看结果 → 再请求」的往返轮次已经用满（上限 ${n} 轮，`
  + '每轮可以同时调用多个工具），工具通道现已关闭，不能再发起任何工具调用。'
  + '请立即基于上面已经拿到的工具结果直接回答用户；'
  + '如果信息确实不足，就说明已经尝试过什么、还缺什么，不要编造。';

/** 把一条消息里的本地工具调用整理成可渲染的描述（参数 + 结果 + 耗时） */
function collectToolCalls(m) {
  const conv = currentConversation();
  const out = [];
  for (const tc of m.toolCalls || []) {
    const name = tc.function?.name || 'tool';
    const rec = (m.toolResults || []).find((r) => r.id === tc.id)
      || conv?.messages.find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
    const meta = TOOL_META[name];
    let sub = '';
    try {
      const a = JSON.parse(tc.function?.arguments || '{}');
      sub = String(a.query || a.url || '');
    } catch {}
    out.push({
      key: tc.id ? `${m.id}:${tc.id}` : `${m.id}:${out.length}`,
      name,
      label: meta ? meta[0] : `${t('callTool')} · ${name}`,
      icon: meta ? meta[1] : 'i-wrench',
      sub,
      ok: rec ? (rec.ok ?? rec.toolOk ?? true) : null,
      ms: rec ? (rec.ms ?? rec.toolMs) : null,
      argsText: prettyArgs(tc.function?.arguments),
      resultText: rec?.content || '',
    });
  }
  return out;
}

function toolStatusSpan(c, withMs = true) {
  if (c.ok === null) return h('span', { class: 'kind', text: '· ' + t('toolRunning') });
  return h('span', {
    class: 'kind',
    style: c.ok ? {} : { color: 'var(--state-error)' },
    text: '· ' + (c.ok ? t('toolOk') : t('failed')) + (withMs && c.ms ? ` · ${c.ms}ms` : ''),
  });
}

/** 参数/结果块：复用 .tool-pre（自带 240px 上限 + 滚动） */
function toolDetailEls(c) {
  const els = [];
  const args = c.argsText && c.argsText !== '{}' ? c.argsText : '';
  if (args) els.push(h('pre', { class: 'tool-pre tool-args', text: args }));
  if (c.resultText) els.push(h('pre', { class: 'tool-pre tool-result', text: c.resultText }));
  else if (c.ok === null) els.push(h('pre', { class: 'tool-pre tool-result', text: t('toolRunning') }));
  return els;
}

/**
 * 工具调用分组：一次请求里的多个工具、以及连续多轮「只调工具不说话」的往返，
 * 全部折叠成一行（工具调用 ×N），点开才看到每次调用的参数与结果。
 */
function toolGroupEl(calls, groupKey) {
  if (!calls.length) return null;
  const key = groupKey || calls.map((c) => c.key).join('|');
  const open = toolGroupOpen.has(key);
  const box = h('div', { class: 'tool-group' + (open ? '' : ' collapsed') });

  const running = calls.some((c) => c.ok === null);
  const failed = calls.filter((c) => c.ok === false).length;
  const totalMs = calls.reduce((n, c) => n + (Number(c.ms) || 0), 0);
  const status = running
    ? h('span', { class: 'kind', text: '· ' + t('toolRunning') })
    : failed
      ? h('span', { class: 'kind', style: { color: 'var(--state-error)' }, text: `· ${t('toolSomeFailed', { n: failed })}` })
      : calls.length > 1
        ? h('span', { class: 'kind', text: '· ' + t('toolAllOk') + (totalMs ? ` · ${t('toolTotalMs', { ms: totalMs })}` : '') })
        : null;

  const headChildren = [];
  if (calls.length === 1) {
    const c = calls[0];
    headChildren.push(iconEl(c.icon), h('span', { text: c.label }));
    if (c.sub) headChildren.push(h('span', { class: 'kind tool-sub', title: c.sub, text: '· ' + c.sub }));
    headChildren.push(toolStatusSpan(c));
  } else {
    headChildren.push(iconEl('i-wrench'), h('span', { text: t('toolGroupCalls', { n: calls.length }) }));
    // 按工具名汇总，如「联网搜索 ×2」「读取网页 ×1」
    const tally = new Map();
    for (const c of calls) tally.set(c.label, (tally.get(c.label) || 0) + 1);
    for (const [label, n] of tally) {
      headChildren.push(h('span', { class: 'tool-chip', text: n > 1 ? `${label} ×${n}` : label }));
    }
    if (status) headChildren.push(status);
  }
  headChildren.push(iconEl('i-chevron', 'chev'));

  const head = h('button', { class: 'tool-group-head', type: 'button', title: t('toolGroupCalls', { n: calls.length }) }, headChildren);
  head.addEventListener('click', () => {
    const collapsedNow = box.classList.toggle('collapsed');
    if (collapsedNow) toolGroupOpen.delete(key);
    else toolGroupOpen.add(key);
  });

  const body = h('div', { class: 'tool-group-body' });
  if (calls.length === 1) {
    body.append(...toolDetailEls(calls[0]));
  } else {
    calls.forEach((c, i) => {
      const rowKey = `${key}#${i}`;
      const row = h('div', { class: 'tool-row' + (toolRowOpen.has(rowKey) ? '' : ' collapsed') });
      const rowHead = h('button', { class: 'tool-row-head', type: 'button' }, [
        iconEl(c.icon),
        h('span', { text: c.label }),
        c.sub ? h('span', { class: 'kind tool-sub', title: c.sub, text: '· ' + c.sub }) : null,
        toolStatusSpan(c),
        iconEl('i-chevron', 'chev'),
      ]);
      rowHead.addEventListener('click', () => {
        const collapsedNow = row.classList.toggle('collapsed');
        if (collapsedNow) toolRowOpen.delete(rowKey);
        else toolRowOpen.add(rowKey);
      });
      row.append(rowHead, h('div', { class: 'tool-row-body' }, toolDetailEls(c)));
      body.append(row);
    });
  }
  box.append(head, body);
  return box;
}

/** 纯工具轮（模型只发起工具调用、没输出正文）——连续出现时合并成一组 */
function isToolOnlyMessage(m) {
  return Boolean(m) && m.role === 'assistant'
    && !String(m.content || '').trim()
    && !m.error && !m.refusal
    && (m.toolCalls || []).length > 0
    && !(m.serverToolCalls || []).length;
}

/** 连续「纯工具」往返 + 收尾正文合并成一条助手消息：严格按发生顺序排列，用量只留一行 */
function toolRunView(msgs, answer, versions) {
  // data-id 用收尾正文的 id：流式渲染要靠它定位这一条气泡
  const tail = answer || msgs[msgs.length - 1];
  const wrap = h('div', { class: 'msg assistant' + (answer ? ' merged' : ' toolrun'), 'data-id': tail.id });
  const body = h('div', { class: 'body' });
  // 按发生顺序逐轮渲染：思考 → 该轮自己的工具调用组。
  // 不能跨轮把工具调用收集到一起，否则会变成「所有思考 → 所有工具 → 正文」，顺序全乱。
  for (const m of msgs) {
    if (m.reasoning) body.append(thinkingView(m));
    const calls = collectToolCalls(m);
    if (calls.length) body.append(toolGroupEl(calls, `m:${m.id}`));
  }

  if (answer) {
    // 收尾正文（含它自己的思考/工具/操作条）放进独立容器，流式思考插在它的 .md 前
    const host = h('div', { class: 'merged-answer' });
    host.append(...assistantBodyParts(answer, versions, { withUsage: false }));
    body.append(host);
  } else {
    // 还没出正文：只保留「重新生成」，指向这串工具往返的最后一轮
    const acts = h('div', { class: 'msg-actions' });
    if (!msgs.some((m) => m.streaming)) {
      acts.append(actBtn('i-refresh', t('regenerate'), () => regenerate(msgs[msgs.length - 1])));
    }
    body.append(acts);
  }

  // 整条回答（工具轮 + 收尾正文）只显示一行合并用量
  const withUsage = msgs.filter((m) => m.usage);
  if (answer?.usage) withUsage.push(answer);
  if (withUsage.length === 1) body.append(usageLine(withUsage[0]));
  else if (withUsage.length > 1) body.append(usageLineMerged(withUsage));

  wrap.append(body);
  return wrap;
}

function toolCardsView(calls) {
  const wrap = h('div', { class: 'tool-cards' });
  for (const step of calls) {
    for (const call of step.calls || []) {
      const card = h('div', { class: 'tool-card' });
      const kindLabel = {
        search: t('searched'), deep_search: t('searching'), read_link: t('readLink'),
        image_search: t('imageSearch'), deep_image_search: t('imageSearch'),
      }[call.kind] || t('searched');
      const q = call.action?.queries?.length ? call.action.queries.join(' · ')
        : call.action?.url || call.action?.pattern || '';
      const head = h('div', { class: 'tool-card-head' }, [
        iconEl(call.kind === 'read_link' ? 'i-file' : 'i-globe'),
        h('span', { text: kindLabel }),
        h('span', { class: 'kind', text: q ? '· ' + q : '' }),
        call.status === 'failed' ? h('span', { class: 'kind', style: { color: 'var(--state-error)' }, text: '· ' + t('failed') }) : null,
        (call.sources || []).length > 1
          ? h('button', {
            class: 'kind src-more',
            type: 'button',
            title: t('allSources'),
            onclick: (e) => {
              e.stopPropagation();
              openSearchPanel(q || kindLabel, call.sources);
            },
          }, [h('span', { text: `${t('allSources')} ${call.sources.length}` })])
          : null,
      ]);
      card.append(head);
      const body = h('div', { class: 'tool-card-body' });
      const sources = call.sources || (call.page ? [call.page] : []);
      sources.forEach((s, i) => {
        const a = h('a', { class: 'source', href: s.url, target: '_blank', rel: 'noreferrer noopener' }, [
          h('span', { class: 'idx', text: String(i + 1) }),
          h('span', { class: 'txt' }, [
            h('span', { class: 't', text: s.title || s.url }),
            s.snippet ? h('span', { class: 's', text: s.snippet }) : null,
            h('span', { class: 'u', text: (s.site_name ? s.site_name + ' · ' : '') + s.url }),
          ]),
        ]);
        body.append(a);
      });
      if (!sources.length && call.kind !== 'find_in_page') {
        body.append(h('div', { class: 'source' }, [h('span', { class: 's', text: call.status === 'failed' ? t('noResult') : t('noResult') })]));
      }
      card.append(body);
      wrap.append(card);
    }
  }
  return wrap;
}

/** 打开附件：图片进灯箱，纯文本弹窗看原文，其它交给浏览器（PDF 内联预览，其余下载） */
function openAttachment(a) {
  if (!a) return;
  if (a.kind === 'image') {
    const src = a.previewUrl || a.dataUrl || (a.attId ? attachmentUrl(a.attId) : '');
    if (src) openLightbox(src);
    else toast('这张图已不在本地');
    return;
  }
  if (typeof a.text === 'string' && a.text) { openTextViewer(a); return; }
  if (a.attId) { window.open(attachmentUrl(a.attId), '_blank', 'noopener'); return; }
  if (a.dataUrl) { window.open(a.dataUrl, '_blank', 'noopener'); return; }
  if (a._file) { const url = URL.createObjectURL(a._file); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000); return; }
  toast('文件已不在本地');
}

/** 纯文本附件预览（解析出来的 txt/md/csv 原文都在内存里，直接弹窗看，不依赖服务端） */
function openTextViewer(a) {
  const overlay = h('div', { class: 'file-preview' });
  const body = h('pre', { text: a.text });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const copyBtn = h('button', { class: 'btn sm ghost', type: 'button', text: t('copy') });
  copyBtn.addEventListener('click', async () => { const ok = await copyText(a.text); toast(ok ? t('copied') : '复制失败'); });
  const x = h('button', { class: 'icon-btn sm', type: 'button', title: '关闭' }, [iconEl('i-x')]);
  x.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.append(h('div', { class: 'panel' }, [
    h('div', { class: 'head' }, [
      iconEl('i-file'),
      h('span', { class: 'name', text: a.name || '文本' }),
      h('span', { class: 'size', text: formatBytes((a.size || a.text.length)) }),
      h('div', { class: 'spacer' }),
      copyBtn, x,
    ]),
    h('div', { class: 'body' }, [body]),
  ]));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

/** 消息里的附件栅格。editable=true 时每格右上角带「移除」，用于编辑消息时管理附件 */
function attachGridView(atts, { editable = false, onChange = null } = {}) {
  const grid = h('div', { class: 'attach-grid' });
  for (const a of atts) {
    let cell;
    if (a.kind === 'image' && (a.dataUrl || a.previewUrl || a.attId)) {
      const src = a.previewUrl || a.dataUrl || attachmentUrl(a.attId);
      const img = h('img', { src, alt: a.name || '' });
      cell = h('div', { class: 'attach-thumb', title: '点击查看大图' }, [img]);
      cell.addEventListener('click', () => openLightbox(img.src));
    } else {
      cell = h('div', { class: 'attach-file clickable', title: '点击查看文件' }, [
        iconEl('i-file'),
        h('span', { class: 'name', text: a.name || '文件' }),
        h('span', { class: 'size', text: formatBytes(a.size || 0) }),
      ]);
      cell.addEventListener('click', () => openAttachment(a));
    }
    if (editable) {
      cell.classList.add('editable');
      const rm = h('button', { class: 'attach-x', type: 'button', title: '移除' }, [iconEl('i-x')]);
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = atts.indexOf(a);
        if (i >= 0) atts.splice(i, 1);
        onChange?.(atts);
      });
      cell.append(rm);
    }
    grid.append(cell);
  }
  return grid;
}

function usageLine(m, costOv) {
  const u = m.usage || {};
  const cost = costOv === undefined ? estimateCost(m) : costOv;
  const parts = [];
  if (u.prompt_tokens) parts.push(`${t('tokensIn')} ${u.prompt_tokens}`);
  if (u.completion_tokens) parts.push(`${t('tokensOut')} ${u.completion_tokens}`);
  if (u.prompt_cache_hit_tokens) parts.push(`${t('cacheHit')} ${u.prompt_cache_hit_tokens}`);
  if (u.completion_tokens_details?.reasoning_tokens) parts.push(`${t('tokensThink')} ${u.completion_tokens_details.reasoning_tokens}`);
  if (u.server_tool_use) {
    const s = u.server_tool_use;
    const n = (s.tool_search || 0) + (s.tool_fetch || 0) + (s.tool_image_search || 0);
    if (n) parts.push(t('toolsUsed', { n }));
  }
  const nodes = [h('span', { text: m.model || '' })];
  for (const p of parts) {
    nodes.push(h('span', { class: 'dot' }));
    nodes.push(h('span', { text: p }));
  }
  if (cost) {
    nodes.push(h('span', { class: 'dot' }));
    nodes.push(h('span', {
      text: `${t('estimated')} ${cost.text}（${cost.peak ? t('peakRate') : t('idleRate')}）`,
      title: cost.peak
        ? '按消息发送时段的价格估算（高峰：周一至周五 9:00-12:00 / 14:00-18:00 北京时间；法定节假日除外），发送后不再变动'
        : '按消息发送时段的价格估算（空闲时段），发送后不再变动',
    }));
  }
  // 点整行打开用量面板（上下文用量 ↔ token 使用）
  const meta = h('div', { class: 'msg-meta clickable', title: t('usageDetail') }, nodes);
  meta.addEventListener('click', () => {
    if (String(window.getSelection?.() || '').length) return;   // 正在选文字就不弹
    openUsagePanel(meta);
  });
  return meta;
}

/**
 * 峰谷计价：按「当前时段」取价（auto 时按北京时间判断；也可在设置里强制空闲/高峰）
 * 返回 { text, peak } 或 null
 * 峰谷状态由 refreshPeakState() 预热（含节假日 API），这里只读缓存，保持同步渲染。
 */
let peakState = null; // { peak, at }
async function refreshPeakState() {
  const mode = settings.peakMode || 'auto';
  if (mode !== 'auto') { peakState = { peak: mode === 'peak', at: Date.now() }; return; }
  let peak;
  try {
    const { isPeakNowAsync } = await import('./store.js');
    peak = await isPeakNowAsync();
  } catch { peak = isPeakNow(); }
  peakState = { peak, at: Date.now() };
  renderChat(); // 峰谷状态变了，费用显示要重算
}

function pickPrice(modelId, atMs) {
  const p = settings.prices || {};
  const key = String(modelId || settings.model).includes('pro') ? 'pro' : 'flash';
  const bucket = p[key] || {};
  const mode = settings.peakMode || 'auto';
  // auto 模式按「消息发送时刻」判断峰谷；强制模式仍按用户在设置里选的档
  const peak = mode === 'peak'
    || (mode === 'auto' && (atMs ? isPeakAt(atMs) : (peakState?.peak ?? isPeakNow())));
  const at = (k) => Number(bucket[k + (peak ? 'Peak' : 'Idle')]) || 0;
  return { peak, inMiss: at('miss'), inHit: at('hit'), out: at('out') };
}

/** 按当前设置与指定时刻算一次费用（不读快照） */
function computeCost(m, atMs) {
  const pr = pickPrice(m.model, atMs);
  if (!pr.inMiss && !pr.inHit && !pr.out) return null;
  const u = m.usage || {};
  const miss = u.prompt_cache_miss_tokens ?? u.prompt_tokens ?? 0;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const cmp = u.completion_tokens ?? 0;
  const cost = (miss * pr.inMiss + hit * pr.inHit + cmp * pr.out) / 1e6;
  if (!isFinite(cost) || cost <= 0) return null;
  const cur = settings.prices?.currency === 'USD' ? '$' : '¥';
  return {
    text: cur + cost.toFixed(cost < 0.01 ? 4 : 2),
    peak: pr.peak,
    value: cost,
    at: atMs || Date.now(),
  };
}

/** 收到 usage 那一刻把费用定档：此后不再随当前时间/改价重算（历史价格不回溯）。
 *  存进消息里，跟会话一起落盘。
 */
function stampCost(m, force = false) {
  if (!m || !m.usage) return;
  if (m.cost && !force) return;
  const c = computeCost(m, m.createdAt || Date.now());
  m.cost = c ? { text: c.text, value: c.value, peak: c.peak, at: c.at } : null;
}

function estimateCost(m) {
  if (m.cost && m.cost.text) return m.cost;              // 发送时已定档，直接用
  const c = computeCost(m, m.createdAt);                 // 老消息按发送时刻回算
  return c ? { text: c.text, peak: c.peak, value: c.value } : null;
}

/* -------------------- 上下文用量面板（含两条滑条） -------------------- */

/** token 数显示：<1000 原样，1 万以内 1 位小数 K，再往上取整 K，百万级 M */
function fmtTok(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (v < 1048576) return Math.round(v / 1000) + 'K';
  return (v / 1048576).toFixed(2).replace(/\.?0+$/, '') + 'M';
}
/** 窗口大小显示：一律整数 K / M（128K、1M） */
function fmtWindow(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1048576) return (v / 1048576).toFixed(v % 1048576 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return Math.round(v / 1024) + 'K';       // 32K/64K 这类档位按 1024 进位，别显示成 33K
}
/** 一条消息的 token 粗估（正文 + 附件文本/文件名） */
function msgTokens(m) {
  let t = estimateTokens(typeof m.content === 'string' ? m.content : '');
  for (const a of m.attachments || []) t += estimateTokens(a.text || a.name || '');
  return t;
}

const CTX_STEPS_K = [32, 64, 128, 256, 512, 1024];
/**
 * 分段顺序 = 请求里的真实排布。
 * tools 分两段：常驻工具（联网搜索/读网页/find_tool，开关不变就永远这几个）排在系统提示之后，
 * 它们是稳定前缀，缓存一直能命中；后加载工具（检索命中、find_tool 找到的）排在最后，
 * 每轮都可能换，放队尾不打断前面的缓存。
 */
const CTX_SEGS = [
  ['sys', '系统提示', 'seg-sys'],
  ['toolsStable', '常驻工具', 'seg-tools-stable'],
  ['hist', '历史对话', 'seg-hist'],
  ['tool', '工具结果', 'seg-tool'],
  ['input', '本轮输入', 'seg-input'],
  ['toolsDynamic', '后加载工具', 'seg-tools-dynamic'],
];

/** 汇总当前会话的上下文占用与 token 统计。
 *  分段来自 measureRequest（与发送共用 buildPayload，按真实请求体顺序统计）；
 *  有最后一条 usage 时用它做精确锚点（prompt+completion），分段按比例缩放。 */
function convUsage() {
  const conv = currentConversation();
  const msgs = conv ? conv.messages : [];
  const e = eff();
  const modelMax = modelInfo(e.model).context_window || 1048576;
  const limit = Number(settings.contextLimit) || 0;
  const maxCtx = limit > 0 ? Math.min(limit, modelMax) : modelMax;

  let anchorIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const u = msgs[i].role === 'assistant' ? msgs[i].usage : null;
    if (u && u.prompt_tokens) { anchorIdx = i; break; }
  }

  // 真实请求构成：和发送走同一套 buildPayload（含 tools 定义、reasoning_content、latest_reminder）。
  // 历史必须用「当前选中的分支链」，不能拿 conv.messages —— 那里还躺着没被选中的旧版本回答。
  const chain = conv ? visibleMessages(conv) : [];
  const lastUserMsg = [...chain].reverse().find((m) => m.role === 'user');
  const usedTools = [];
  const foundTools = [];
  for (const m of chain) {
    for (const tc of m.toolCalls || []) if (tc?.function?.name) usedTools.push(tc.function.name);
    for (const rec of m.toolResults || []) {
      if (rec?.name !== 'find_tool') continue;
      const data = typeof rec.data === 'string' ? (() => { try { return JSON.parse(rec.data); } catch { return null; } })() : rec.data;
      if (Array.isArray(data?.names)) foundTools.push(...data.names);
    }
  }
  let seg;
  try {
    seg = measureRequest(chain, {
      settings: e,
      extraTools: toolDefsCache,
      toolQuery: [lastUserMsg?.content || '', ...(lastUserMsg?.attachments || []).map((a) => a.text || '')].join(' '),
      usedTools,
      stickyTools: conv ? (stickyToolsByConv.get(conv.id) || []) : [],
      foundTools,
    }).seg;
  } catch {
    // 测量失败（工具定义还没拉到等）就退回最粗的估算，面板不能因此打不开
    seg = { sys: estimateTokens(e.systemPrompt || '') + 160, toolsStable: 0, toolsDynamic: 0, hist: 0, tool: 0, input: 0 };
    msgs.forEach((m, i) => {
      const tk = msgTokens(m);
      if (m.role === 'tool') seg.tool += tk;
      else if (m.role === 'user') { if (i === msgs.length - 1) seg.input += tk; else seg.hist += tk; }
      else seg.hist += tk;
    });
  }

  let after = 0;
  if (anchorIdx >= 0) for (let i = anchorIdx + 1; i < msgs.length; i++) after += msgTokens(msgs[i]);
  const exact = anchorIdx >= 0;
  const estSum = seg.sys + seg.toolsStable + seg.toolsDynamic + seg.hist + seg.tool + seg.input;
  const used = exact
    ? (msgs[anchorIdx].usage.prompt_tokens || 0) + (msgs[anchorIdx].usage.completion_tokens || 0) + after
    : estSum;

  const scale = estSum > 0 ? used / estSum : 0;

  const tok = { prompt: 0, completion: 0, hit: 0, miss: 0, think: 0, cost: 0, answers: 0, calls: 0 };
  for (const m of msgs) {
    if (m.role === 'assistant' && m.usage) {
      const u = m.usage;
      tok.answers++;
      tok.prompt += u.prompt_tokens || 0;
      tok.completion += u.completion_tokens || 0;
      tok.hit += u.prompt_cache_hit_tokens || 0;
      tok.miss += u.prompt_cache_miss_tokens || 0;
      tok.think += u.completion_tokens_details?.reasoning_tokens || 0;
      const c = estimateCost(m);
      if (c) tok.cost += c.value || 0;
    }
    tok.calls += (m.toolCalls || []).length + (m.serverToolCalls || []).length;
  }
  tok.currency = settings.prices?.currency === 'USD' ? '$' : '¥';

  return {
    msgs, maxCtx, modelMax, limit, used, exact,
    segs: CTX_SEGS.map(([key, label, cls]) => ({ key, label, cls, tokens: Math.round(seg[key] * scale) })),
    tok,
  };
}

/**
 * 通用滑条：滑点左边填色 + 滑点可跟手拖动，点击/键盘切换时带滑行动画。
 * （原生 range 的拇指没法做过渡，所以拇指自己画，原生的只留透明热区）
 * 返回 { el, value(), set(v), refresh(), setDisabled(b) }
 */
function makeSlider({ max, value = 0, dots = false, ariaLabel = '', onInput, onChange }) {
  const wrap = h('div', { class: 'ds-range' });
  const fill = h('div', { class: 'ds-range-fill' });
  const thumb = h('div', { class: 'ds-range-thumb' });
  const input = h('input', {
    class: 'ds-range-input', type: 'range', min: '0', max: String(max), step: '1', value: String(value),
  });
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  wrap.append(fill, thumb);
  const dotEls = [];
  if (dots) {
    const box = h('div', { class: 'ds-range-dots' });
    for (let i = 0; i <= max; i++) { const d = h('i', { class: 'ds-range-dot' }); dotEls.push(d); box.append(d); }
    wrap.append(box);
  }
  wrap.append(input);

  const val = () => Number(input.value) || 0;
  const gutter = 17;                       // 滑点半径：滑点中心只在 [17, w-17] 之间跑
  function metrics() {
    const w = wrap.clientWidth || 296;
    return { w, span: Math.max(1, w - gutter * 2) };
  }
  function xOf(v, m = metrics()) { return gutter + m.span * (max ? v / max : 0); }
  function paintX(x, animate) {
    wrap.classList.toggle('anim', animate !== false);
    // 填充从底条左端（left:2）画到滑点中心 x；只有滑点真正在最左顶点时才收成 0。
    // 注意必须看滑点实际位置 x，不能看档位值 val()：拖动中滑点已离开顶点但档位还没跳，
    // 用 val() 会把填充误清零，出现「拖到一半颜色突然消失」。
    // 底条两端各缩进 2px 后，端点圆角圆心正好落在滑点中心，最左/最右档都不会露边。
    fill.style.width = x <= gutter ? '0px' : Math.max(0, x - 2) + 'px';
    thumb.style.left = x + 'px';
  }
  function paint(animate) {
    const m = metrics();
    paintX(xOf(val(), m), animate);
    dotEls.forEach((d, i) => { d.style.left = xOf(i, m) + 'px'; });
  }
  function setValue(v, { animate = true, silent = false } = {}) {
    const next = Math.min(max, Math.max(0, Math.round(v)));
    const changed = next !== val();
    input.value = String(next);
    paint(animate);
    if (changed && !silent) onInput?.(next);
    return next;
  }

  /* 拖拽自己算：原生 range 的拇指没法做过渡，而且按「档位」跳，跟不住鼠标 */
  let dragging = false;
  function pointerToX(clientX) {
    const r = wrap.getBoundingClientRect();
    const m = { w: r.width, span: Math.max(1, r.width - gutter * 2) };
    const x = Math.min(r.width - gutter, Math.max(gutter, clientX - r.left));
    return { x, m, v: Math.round(((x - gutter) / m.span) * max) };
  }
  function follow(clientX) {
    const { x, v } = pointerToX(clientX);
    paintX(x, false);                       // 跟手：不加过渡
    if (v !== val()) { input.value = String(v); onInput?.(v); }
  }
  function release() {
    if (!dragging) return;
    dragging = false;
    const v = val();
    paint(true);                            // 松手：从当前位置滑到该档位
    onChange?.(v);
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (input.disabled || e.button > 0) return;
    e.preventDefault();                     // 关掉原生拖拽，改由自己算（否则按档位跳）
    dragging = true;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* 老浏览器忽略 */ }
    input.focus({ preventScroll: true });
    follow(e.clientX);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    follow(e.clientX);
  });
  wrap.addEventListener('pointerup', () => { release(); });
  wrap.addEventListener('pointercancel', () => { release(); });

  // 键盘（方向键 / Home / End）走原生 input 事件，这里带过渡重排
  input.addEventListener('input', () => { if (!dragging) setValue(val(), { animate: true, silent: false }); });
  input.addEventListener('change', () => { if (!dragging) { paint(true); onChange?.(val()); } });

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => paint(false)).observe(wrap);
  requestAnimationFrame(() => paint(false));

  return {
    el: wrap,
    value: val,
    set(v, animate = true) { setValue(v, { animate, silent: true }); },
    refresh: (animate = false) => paint(animate),
    setDisabled(b) {
      input.disabled = Boolean(b);
      wrap.classList.toggle('is-disabled', Boolean(b));
    },
  };
}

/** 上下文用量面板：上面用量条，底下「总上下文上限」与「思考强度」两条滑条 */
function openUsagePanel(anchor) {
  if (state.menu && state.menuAnchor === anchor) { closeMenu(); return; }
  const data = convUsage();

  const pct = data.maxCtx ? Math.min(100, (data.used / data.maxCtx) * 100) : 0;
  const pctEl = h('b', { class: 'usage-pct', text: pct.toFixed(pct >= 10 ? 0 : 1) + '%' });
  const usedEl = h('span', { class: 'usage-used', text: `已使用 ${fmtTok(data.used)} / ${fmtWindow(data.maxCtx)}` });
  const barEl = h('div', { class: 'usage-bar' });
  const legendEl = h('div', { class: 'usage-legend' });
  const ctxLabel = h('div', { class: 'usage-slider-label' });
  const effortLabel = h('div', { class: 'usage-slider-label' });
  const hintEl = h('div', { class: 'usage-hint' });

  // 上限滑条：最后一档 = 模型默认（存 0）
  const stepsK = CTX_STEPS_K.slice();
  const modelK = Math.max(1, Math.round(data.modelMax / 1024));
  if (!stepsK.includes(modelK)) stepsK.push(modelK);
  stepsK.sort((a, b) => a - b);
  const curK = Math.round((data.limit > 0 ? data.limit : data.modelMax) / 1024);

  const EFFORTS = ['low', 'high', 'max'];
  const effNames = { low: t('effortLow'), high: t('effortHigh'), max: t('effortMax') };
  const effIdx = Math.max(0, EFFORTS.indexOf(eff().effort || 'high'));

  const ctxS = makeSlider({
    max: stepsK.length - 1,
    value: Math.max(0, stepsK.indexOf(curK)),
    ariaLabel: '总上下文上限',
    onInput: (v) => {
      const k = stepsK[v] || modelK;
      ctxLabel.textContent = `${fmtWindow(k * 1024)} 上下文 · ${k >= modelK ? '默认' : '自定义'}`;
    },
    onChange: (v) => {
      const k = stepsK[v] || modelK;
      saveSettings({ contextLimit: k >= modelK ? 0 : k * 1024 });
      paint();
      updateCtxChip(true);
    },
  });
  const effortS = makeSlider({
    max: 2,
    value: effIdx,
    dots: true,
    ariaLabel: t('reasoningEffort'),
    onInput: (v) => { effortLabel.textContent = `${t('reasoningEffort')} · ${effNames[EFFORTS[v] || 'high']}`; },
    onChange: (v) => {
      const lv = EFFORTS[v] || 'high';
      setEffective('effort', lv);
      effortLabel.textContent = `${t('reasoningEffort')} · ${effNames[lv]}`;
    },
  });

  function paint() {
    const d = convUsage();
    const p = d.maxCtx ? Math.min(100, (d.used / d.maxCtx) * 100) : 0;
    pctEl.textContent = p.toFixed(p >= 10 ? 0 : 1) + '%';
    usedEl.textContent = `已使用 ${fmtTok(d.used)} / ${fmtWindow(d.maxCtx)}`;
    // 只有真正占了 token 的段才画进条里：0 宽的段不画，免得留下 2px 的空隙
    barEl.replaceChildren(...d.segs.filter((s) => s.tokens > 0).map((s) => {
      const w = d.maxCtx ? Math.max(0, (s.tokens / d.maxCtx) * 100) : 0;
      const el = h('i', { class: 'usage-seg ' + s.cls });
      el.style.width = Math.max(w, 0.6) + '%';
      el.title = `${s.label} 约 ${fmtTok(s.tokens)} tokens`;
      return el;
    }));
    legendEl.replaceChildren(...d.segs.map((s) => {
      const share = d.used ? Math.round((s.tokens / d.used) * 100) : 0;
      return h('div', { class: 'usage-legend-row' }, [
        h('i', { class: 'usage-dot ' + s.cls }),
        h('span', { class: 'lbl', text: s.label }),
        h('span', { class: 'val', text: fmtTok(s.tokens) }),
        h('span', { class: 'pct', text: share + '%' }),
      ]);
    }));
    const k = stepsK[ctxS.value()] || modelK;
    ctxLabel.textContent = `${fmtWindow(k * 1024)} 上下文 · ${k >= modelK ? '默认' : '自定义'}`;
    hintEl.textContent = d.limit
      ? '超出上限的旧对话会在发送时按整轮截断'
      : '默认使用模型完整窗口，不做截断';
    effortLabel.textContent = `${t('reasoningEffort')} · ${effNames[EFFORTS[effortS.value()] || 'high']}`;
  }

  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', title: '关闭', 'aria-label': '关闭' }, [iconEl('i-x')]);
  closeBtn.addEventListener('click', () => closeMenu());

  const panel = h('div', { class: 'usage-panel' }, [
    h('div', { class: 'usage-head' }, [h('span', { class: 'usage-title', text: '上下文用量' }), closeBtn]),
    h('div', { class: 'usage-top' }, [pctEl, usedEl]),
    barEl,
    legendEl,
    h('div', { class: 'usage-sep' }),
    ctxLabel,
    ctxS.el,
    hintEl,
    effortLabel,
    effortS.el,
    h('div', { class: 'usage-foot', text: `本会话 输入 ${fmtTok(data.tok.prompt)} · 输出 ${fmtTok(data.tok.completion)} · 预估 ${data.tok.currency}${data.tok.cost.toFixed(data.tok.cost < 0.01 ? 4 : 2)}` }),
  ]);
  paint();                       // 先填内容再定位：否则面板会长高、把底边顶出视口
  showMenu(anchor, [panel], 'up');
  if (!eff().thinking) {
    effortS.setDisabled(true);
    effortLabel.textContent = `${t('reasoningEffort')} · 深度思考已关闭`;
  }
  // 面板插进 DOM 后宽度才确定，这里重排一次填充与滑点位置
  ctxS.refresh(false); effortS.refresh(false);
}

/** 输入框下方那颗「上下文 xx / yy」小胶囊，点开就是用量面板 */
let ctxChipAt = 0;
function mountCtxChip() {
  if (els.ctxChip || !els.foot) return;
  const txt = h('span', { class: 'txt' });
  const chev = iconEl('i-chevron', 'icon');
  const btn = h('button', {
    class: 'ctx-chip hidden', type: 'button',
    title: '查看上下文用量（可调上下文上限与思考强度）',
    'aria-haspopup': 'dialog',
  }, [txt, chev]);
  btn.addEventListener('click', () => openUsagePanel(btn));
  els.foot.append(btn);
  els.ctxChip = btn;
  els.ctxChipText = txt;
  updateCtxChip(true);
}
function updateCtxChip(force = false) {
  if (!els.ctxChip) return;
  const now = Date.now();
  if (!force && now - ctxChipAt < 500) return;   // 流式渲染很频繁，半秒最多算一次
  ctxChipAt = now;
  const d = convUsage();
  const on = d.used > 0 && d.msgs.length > 0;
  els.ctxChip.classList.toggle('hidden', !on);
  if (!on) return;
  const pct = d.maxCtx ? Math.min(100, (d.used / d.maxCtx) * 100) : 0;
  (els.ctxChipText || els.ctxChip).textContent = `上下文 ${fmtTok(d.used)} / ${fmtWindow(d.maxCtx)} · ${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}


/** 合并多轮「纯工具」往返的用量，输出一行统计（token 求和、费用相加） */
function usageLineMerged(msgs) {
  let prompt = 0; let completion = 0; let hit = 0; let think = 0;
  let cost = 0; let peak = false;
  for (const m of msgs) {
    const u = m.usage || {};
    prompt += u.prompt_tokens || 0;
    completion += u.completion_tokens || 0;
    hit += u.prompt_cache_hit_tokens || 0;
    think += u.completion_tokens_details?.reasoning_tokens || 0;
    const c = estimateCost(m);
    if (c) { cost += c.value || 0; peak = peak || c.peak; }
  }
  const cur = settings.prices?.currency === 'USD' ? '$' : '¥';
  const costOv = cost > 0 ? { text: cur + cost.toFixed(cost < 0.01 ? 4 : 2), peak } : null;
  return usageLine({
    model: msgs[msgs.length - 1].model || '',
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      prompt_cache_hit_tokens: hit,
      completion_tokens_details: { reasoning_tokens: think },
    },
  }, costOv);
}

/** 分支切换器（官方 BranchSwitcher：28 高，两侧箭头 + 1/2 计数） */
function branchSwitcher(conv, m, versions) {
  const v = versions?.get(m.id);
  if (!v || v.ids.length <= 1) return null;

  const go = (id) => {
    if (!id) return;
    selectVersion(conv, id);
    saveConversations();
    renderChat();
    renderSidebar();
  };
  const mk = (iconCls, title, disabled, onClick) => {
    const b = h('button', { class: 'branch-arrow ' + iconCls, type: 'button', title, 'aria-label': title }, [iconEl('i-chevron')]);
    if (disabled) b.disabled = true;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  return h('div', { class: 'branch-switcher', title: t('messageVersions') }, [
    mk('prev', t('previousVersion'), v.index <= 0, () => go(v.ids[v.index - 1])),
    h('span', { class: 'count', text: `${v.index + 1} / ${v.ids.length}` }),
    mk('next', t('nextVersion'), v.index >= v.ids.length - 1, () => go(v.ids[v.index + 1])),
  ]);
}

function actBtn(iconId, label, fn) {
  const b = h('button', { class: 'act-btn', type: 'button' }, [iconEl(iconId), h('span', { text: label })]);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await fn(b); } catch (err) { toast(err.message || String(err)); }
  });
  return b;
}

function iconEl(id, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', ('icon ' + cls).trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

/* ------------------------------ 发送流程 ------------------------------ */
function updateComposerState() {
  const hasText = els.prompt.value.trim().length > 0 || state.attachments.some((a) => a.ready !== false);
  els.send.disabled = !state.streaming && !hasText;
  els.send.classList.toggle('stop', state.streaming);
  els.send.innerHTML = `<svg class="icon"><use href="#${state.streaming ? 'i-stop' : 'i-arrow-up'}"/></svg>`;
  els.send.title = state.streaming ? t('stop') : t('send');
  const e = eff();
  els.think.classList.toggle('on', Boolean(e.thinking));
  els.think.setAttribute('aria-pressed', String(Boolean(e.thinking)));
  els.search.classList.toggle('on', Boolean(e.search));
  els.search.setAttribute('aria-pressed', String(Boolean(e.search)));
  els.tools.classList.toggle('on', Boolean(e.localTools));
  els.tools.setAttribute('aria-pressed', String(Boolean(e.localTools)));
  // 联网搜索 / 阅读链接 与本地工具在 API 侧互斥：只有「官方」联网模式才禁用本地工具
  const officialWeb = (e.searchMode === 'official') && (Boolean(e.search) || Boolean(e.readUrl));
  els.tools.classList.toggle('disabled', officialWeb);
  els.tools.disabled = officialWeb;
  els.tools.title = officialWeb
    ? '官方联网工具与本地工具不能同时使用（接口限制），可在设置 → 生成里切换为「本地联网」'
    : '本地工具：余额 / 模型 / 时间 / 历史搜索 / 用量 / 联网搜索';
  els.effort.classList.toggle('hidden', !e.thinking);
  const effortName = { low: t('effortLow'), high: t('effortHigh'), max: t('effortMax') }[e.effort || 'high'];
  els.effortLabel.textContent = effortName || (e.effort || 'high');
  els.modelName.textContent = modelInfo(e.model).name || e.model;
  els.mockBadge.classList.toggle('hidden', !settings.mock);
  els.streamBadge.classList.toggle('hidden', !state.streaming);
  els.keyHint.textContent = hasApiKey() ? '' : (settings.mock ? '演示' : t('noKeyBalance'));
}

async function sendMessage({ continueMode = false, prefix = '' } = {}) {
  // 停止请求还没走完（工具执行无法中断）时再点一次，不能顺手当成「发送新消息」
  if (state.streaming || state.stopped) {
    if (state.streaming) stopStreaming();
    return;
  }
  const text = els.prompt.value.trim();
  if (!text && !state.attachments.length && !continueMode) return;
  if (!hasApiKey() && !settings.mock) {
    toast(t('needKey'));
    openSettings({ onChange: onSettingsChange });
    return;
  }

  const broken = state.attachments.filter((a) => a.error);
  if (broken.length) {
    toast(`${broken[0].name}：${broken[0].error}`);
    return;
  }
  const pending = state.attachments.filter((a) => a.ready === false);
  if (pending.length) {
    toast(t('uploading'));
    return;
  }

  const conv = ensureConversation();
  normalizeConv(conv);
  const chain = visibleMessages(conv);
  const history = chain.slice();

  if (!continueMode) {
    const userMsg = {
      id: uid('u'),
      role: 'user',
      content: text,
      attachments: state.attachments.map((a) => ({ ...a })),
      createdAt: Date.now(),
    };
    appendBranch(conv, chain.at(-1)?.id ?? null, [userMsg]);
    state.attachments = [];
    renderTray();
    els.prompt.value = '';
    autoGrow();
  }

  const assistant = {
    id: uid('a'),
    role: 'assistant',
    content: '',
    reasoning: '',
    annotations: [],
    serverToolCalls: [],
    model: settings.model,
    createdAt: Date.now(),
    streaming: true,
  };
  appendBranch(conv, chainTail(conv)?.id ?? null, [assistant]);
  conv.updatedAt = Date.now();
  if (!conv.title) conv.title = toPlainText(text).slice(0, 28) || '新对话';

  state.currentId = conv.id;
  syncRoute();              // 首次发言建会话后，地址栏补上 /a/chat/s/<uuid>（replace，不占历史）
  renderSidebar();
  renderChat();
  scrollToBottom(true);
  await runStream({ conv, assistant, history: visibleMessages(conv).slice(0, -1), continueMode, prefix });
}

async function runStream({ conv, assistant, history, continueMode, prefix }) {
  const es = effectiveSettings(conv);
  const firstTurn = conv.messages.filter((m) => m.role === 'user').length === 1 && !conv.titleFinal && settings.autoTitle;

  let extraTools = [];
  // 本地联网模式：搜索/读链接本身也要靠本地 function 实现，所以这几个开关任一开启都得拿定义
  if (es.localTools || es.search || es.readUrl) {
    try { extraTools = await getToolDefinitions(); toolDefsCache = extraTools; }
    catch (e) { toast('本地工具加载失败：' + e.message); }
  }

  state.stopped = false;
  state.streaming = true;
  state.controller = new AbortController();
  updateComposerState();
  window.__toolLimitHit = false;

  let cur = assistant;
  let curHistory = history;
  let first = true;
  let rounds = 0;
  let limitHit = false; // 工具轮次用尽时置位，收尾要让模型基于已有结果作答

  try {
    while (rounds++ < MAX_TOOL_ROUNDS) {
      if (state.stopped) break;
      // 工具按需加载：用最近的用户问题检索工具；把历史里已调用过的工具带上，避免多轮断链
      const lastUser = [...curHistory].reverse().find((m) => m.role === 'user');
      const toolQuery = [lastUser?.content || '', ...(lastUser?.attachments || []).map((a) => a.text || '')].join(' ');
      const usedTools = [];
      const foundTools = [];
      for (const m of curHistory) {
        for (const tc of m.toolCalls || []) if (tc?.function?.name) usedTools.push(tc.function.name);
        // find_tool 的结果里带 data.names，下一轮把这些工具追加进 tools
        for (const rec of m.toolResults || []) {
          if (rec?.name === 'find_tool') {
            const data = typeof rec.data === 'string' ? (() => { try { return JSON.parse(rec.data); } catch { return null; } })() : rec.data;
            if (Array.isArray(data?.names)) foundTools.push(...data.names);
            // 兼容：从文本里提取「名字：xxx, yyy」
            const m2 = /名字：([^\n]+)/.exec(rec.content || '');
            if (m2) for (const n of m2[1].split(',').map((x) => x.trim())) if (/^[a-z_]+$/.test(n)) foundTools.push(n);
          }
        }
      }
      const stickyTools = stickyToolsByConv.get(conv.id) || [];
      const built = buildPayload(curHistory, {
        settings: es,
        stream: settings.stream,
        wantTitle: first && firstTurn,
        continuePrefix: first && continueMode ? prefix : '',
        extraTools,
        toolQuery,
        usedTools,
        stickyTools,
        foundTools,
      });
      const payload = built.payload;
      // 记下本轮实际下发的顺序，下一轮原样打头，缓存前缀才连得上
      if (built.toolNames?.length) stickyToolsByConv.set(conv.id, built.toolNames);
      else stickyToolsByConv.delete(conv.id);
      if (first && continueMode) payload.__beta = true;
      window.__lastPayload = payload;
      window.__lastToolHits = { query: toolQuery.slice(0, 120), used: usedTools };

      const toolCalls = await streamRound({ assistant: cur, payload });
      if (!toolCalls.length) break;
      // 这是最后一轮了，但模型还想调工具：执行完就告诉它收尾
      if (rounds >= MAX_TOOL_ROUNDS) limitHit = true;

      // ---- 执行模型请求的工具（服务端） ----
      cur.toolResults = cur.toolResults || [];
      // 先画一次「执行中…」卡片：联网搜索要跑 0.5~2s，用户能马上看到在搜什么
      renderChat();
      for (const tc of toolCalls) {
        if (state.stopped) break;   // 用户已点停止：剩下的工具不再执行
        const name = tc.function?.name || 'unknown';
        const args = tc.function?.arguments || '{}';
        const t0 = Date.now();
        let out;
        try {
          // 子智能体要与主智能体共用同一套系统提示：把本轮 system 消息透传给服务端
          let callArgs = args;
          if (name === 'sub_agent') {
            try {
              const parsed = typeof args === 'string' ? JSON.parse(args) : { ...(args || {}) };
              const sys = window.__lastPayload?.messages?.[0]?.role === 'system'
                ? window.__lastPayload.messages[0].content : '';
              if (sys && !parsed.system) { parsed.system = sys; callArgs = JSON.stringify(parsed); }
            } catch {}
          }
          out = await callTool(name, callArgs, { signal: state.controller?.signal });
        }
        catch (e) {
          if (state.stopped) break;   // 停止时工具请求被 abort，不算工具失败
          out = { ok: false, text: '工具调用失败：' + e.message };
        }
        if (state.stopped) break;
        const content = out.text || JSON.stringify(out);
        const record = { id: tc.id, name, args, content, ok: out.ok !== false, ms: out.elapsedMs ?? (Date.now() - t0), data: out.data };
        cur.toolResults.push(record);
        appendBranch(conv, chainTail(conv)?.id ?? null, [{
          id: uid('t'), role: 'tool', tool_call_id: tc.id, name,
          content, toolOk: record.ok, toolMs: record.ms, createdAt: Date.now(),
        }]);
        renderChat();
      }
      saveConversations();
      if (state.stopped) break;

      // ---- 开新一轮回答 ----
      first = false;
      cur = {
        id: uid('a'), role: 'assistant', content: '', reasoning: '', annotations: [],
        serverToolCalls: [], toolCalls: [], model: es.model, createdAt: Date.now(), streaming: true,
      };
      appendBranch(conv, chainTail(conv)?.id ?? null, [cur]);
      curHistory = visibleMessages(conv).slice(0, -1);
      state.streaming = true;
      state.controller = new AbortController();
      updateComposerState();
      renderChat();
    }

    // ---- 工具轮次用尽：不再静默中断，明确告诉模型「不能再调工具，直接回答」 ----
    if (limitHit && !state.stopped) {
      const { payload } = buildPayload(curHistory, {
        settings: es,
        stream: settings.stream,
        extraTools,           // 仅用于让 buildPayload 知道有哪些工具，下面会把 tools 删掉
        toolQuery: '',
      });
      // 关掉工具：模型即便想继续调也无从发起，这一轮只能出正文
      delete payload.tools;
      delete payload.tool_choice;
      const note = TOOL_LIMIT_NOTE(MAX_TOOL_ROUNDS);
      if (payload.messages?.[0]?.role === 'system') {
        payload.messages[0] = {
          ...payload.messages[0],
          content: `${payload.messages[0].content}\n\n${note}`,
        };
      } else {
        payload.messages.unshift({ role: 'system', content: note });
      }
      window.__lastPayload = payload;
      window.__toolLimitHit = true;
      toast(t('toolLimitHit', { n: MAX_TOOL_ROUNDS }));
      await streamRound({ assistant: cur, payload });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      cur.aborted = true;
      if (!cur.content && !cur.reasoning) cur.error = t('aborted');
    } else {
      cur.error = err.message || String(err);
    }
  } finally {
    // 停止时可能是在工具执行/工具轮之间退出的（没走到 AbortError），这里统一补标记
    if (state.stopped && cur) {
      cur.aborted = true;
      if (!cur.content && !cur.reasoning && !cur.error) cur.error = t('aborted');
    }
    state.streaming = false;
    state.controller = null;
    state.stopped = false;
    if (cur) cur.streaming = false;
    if (es.jsonMode && cur?.content && !cur.error) {
      try { JSON.parse(cur.content); } catch { cur.error = t('jsonBad'); }
    }
    saveConversations();
    updateComposerState();
    renderChat();
    renderSidebar();
    scrollToBottom();         // 用户上翻看历史时不要被拉回底部
    autoBalance();            // 回答完余额可能变了，顺手刷一次（60 秒内不重复）
  }
}

/** 跑一轮流式；返回本轮模型请求的工具调用（function calling） */
async function streamRound({ assistant, payload }) {
  assistant.streaming = true;
  const el = $(`.msg[data-id="${assistant.id}"]`);
  // 工具轮+收尾正文合并后，正文在 .merged-answer 里；思考必须插在它的 .md 前，
  // 否则会命中前面工具轮自己的思考块
  const answerHost = el?.querySelector('.merged-answer') || null;
  const refs = {
    el,
    answerHost,
    content: (answerHost || el)?.querySelector('.md'),
    body: el?.querySelector('.body'),
  };
  let reasoningStart = 0;
  let lastPaint = 0;
  const toolAcc = new Map();

  const paint = (force = false) => {
    const now = performance.now();
    if (!force && now - lastPaint < 70) return;
    if (!refs.content) return;
    lastPaint = now;
    refs.content.innerHTML = renderMarkdown(assistant.content, { annotations: assistant.annotations });
    refs.content.classList.toggle('cursor', assistant.streaming);
    const thinkBody = refs.el?.querySelector('.think-body');
    if (thinkBody) thinkBody.textContent = assistant.reasoning;
    scrollToBottom();
  };

  try {
    await streamChat(payload, {
      signal: state.controller?.signal,
      onEvent: (ev) => {
        switch (ev.type) {
          case 'reasoning':
            if (!reasoningStart) reasoningStart = performance.now();
            assistant.reasoning += ev.text;
            const thinkSel = `.think[data-think-for="${assistant.id}"]`;
            if (refs.el && !refs.el.querySelector(thinkSel)) {
              const host = refs.answerHost || refs.el.querySelector('.body');
              const md = host.querySelector('.md');
              host.insertBefore(thinkingView(assistant), md || host.firstChild);
              refs.content = host.querySelector('.md') || refs.content;
            }
            const thinkEl = refs.el?.querySelector(thinkSel);
            if (thinkEl) thinkEl.classList.add('streaming');
            paint();
            break;
          case 'content':
            assistant.content += ev.text;
            paint();
            break;
          case 'tool_call_delta': {
            for (const d of ev.calls || []) {
              const idx = d.index ?? 0;
              const cur = toolAcc.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (d.id) cur.id = d.id;
              if (d.function?.name && !cur.function.name) cur.function.name = d.function.name;
              if (d.function?.arguments) cur.function.arguments += d.function.arguments;
              toolAcc.set(idx, cur);
            }
            break;
          }
          case 'tool_event': {
            const e2 = ev.event || {};
            if (e2.type === 'call_started' || e2.type === 'call_completed') {
              const step = Number(e2.step || 0);
              let target = assistant.serverToolCalls.find((x) => x.index === step);
              if (!target) {
                target = { index: step, reasoning_content: '', calls: [] };
                assistant.serverToolCalls.push(target);
              }
              const call = { ...e2.call, index: target.calls.length };
              if (e2.type === 'call_completed') {
                const exist = target.calls.findIndex((c) => c.id === call.id);
                if (exist >= 0) target.calls[exist] = call;
                else target.calls.push(call);
              } else {
                target.calls.push(call);
              }
              renderToolCardsLive(refs, assistant);
            }
            break;
          }
          case 'server_tool_calls':
            assistant.serverToolCalls = ev.calls || [];
            renderToolCardsLive(refs, assistant);
            break;
          case 'annotations':
            assistant.annotations = ev.annotations || [];
            paint(true);
            break;
          case 'title':
            if (ev.title) {
              const c = currentConversation();
              if (c) { c.title = ev.title; c.titleFinal = true; renderSidebar(); }
            }
            break;
          case 'refusal':
            assistant.refusal = ev.message || t('refusal');
            break;
          case 'usage':
            assistant.usage = ev.usage;
            stampCost(assistant, true);   // 发送时刻定档，之后不再漂
            updateCtxChip(true);
            break;
          case 'finish':
            assistant.finishReason = ev.reason;
            break;
          default:
            break;
        }
      },
    });
  } finally {
    assistant.streaming = false;
    if (reasoningStart) assistant.reasoningSeconds = (performance.now() - reasoningStart) / 1000;
  }

  const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.function?.name);
  if (calls.length) assistant.toolCalls = calls;
  return calls;
}

function renderToolCardsLive(refs, assistant) {
  if (!refs.el) return;
  const host = refs.answerHost || refs.el.querySelector('.body');
  let node = host.querySelector('.tool-cards');
  if (!node) {
    node = h('div', { class: 'tool-cards' });
    const md = host.querySelector('.md');
    host.insertBefore(node, md || host.firstChild);
  }
  node.replaceWith(toolCardsView(assistant.serverToolCalls));
  scrollToBottom();
}

function stopStreaming() {
  if (!state.streaming && !state.stopped) return;
  // abort 只对「正在读流」有效；工具执行阶段是普通 HTTP 请求（可能几秒到几十秒），
  // 所以还要立一个 stopped 标志，让工具轮/工具循环尽早退出，不能只 abort 了事。
  state.stopped = true;
  state.controller?.abort();
  // 立刻把按钮切回「发送」并收掉光标：否则工具执行期间点停止毫无反馈，看着像点不动
  state.streaming = false;
  updateComposerState();
  document.querySelectorAll('.msg .md.cursor').forEach((n) => n.classList.remove('cursor'));
  document.querySelectorAll('.think.streaming').forEach((n) => n.classList.remove('streaming'));
}


/** 截断历史时去掉悬空的工具调用/结果，避免 API 收到孤立的 tool 消息 */
function trimToolArtifacts(conv) {
  const orphan = (m) => m && (m.role === 'tool' || ((m.toolCalls || []).length && !m.content));
  while (conv.messages.length && orphan(conv.messages[conv.messages.length - 1])) conv.messages.pop();
}

function regenerate(m) {
  const conv = currentConversation();
  if (!conv) return;
  normalizeConv(conv);
  // 保留旧回答，在同一父节点下挂一个新分支；旧版本可用切换器回看
  const assistant = {
    id: uid('a'), role: 'assistant', content: '', reasoning: '', annotations: [],
    serverToolCalls: [], model: settings.model, createdAt: Date.now(), streaming: true,
  };
  appendBranch(conv, m.parentId ?? null, [assistant]);
  state.streaming = true;
  state.controller = new AbortController();
  updateComposerState();
  renderChat();
  const history = visibleMessages(conv).slice(0, -1);
  runStream({ conv, assistant, history });
}

function continueGeneration(m) {
  if (state.streaming) return;
  const conv = currentConversation();
  if (!conv) return;
  if (settings.search || settings.readUrl) {
    toast('联网工具开启时无法续写，请先关闭「智能搜索」');
    return;
  }
  // 用这条 assistant 作为前缀走 beta 接口：只把它的子链断开，不删任何消息
  normalizeConv(conv);
  cutAfter(conv, m.id);
  m.streaming = true;
  state.streaming = true;
  state.controller = new AbortController();
  updateComposerState();
  renderChat();
  runStream({ conv, assistant: m, history: visibleMessages(conv).slice(0, -1), continueMode: true, prefix: m.content });
}

function startEdit(m) {
  const conv = currentConversation();
  if (!conv) return;
  const wrap = $(`.msg[data-id="${m.id}"]`);
  if (!wrap) return;
  const box = h('div', { class: 'edit-box' });
  const ta = h('textarea', {});
  ta.value = m.content;
  const actions = h('div', { class: 'edit-actions' });
  const cancel = h('button', { class: 'btn sm ghost', type: 'button', text: t('cancel') });
  const save = h('button', { class: 'btn sm primary', type: 'button', text: t('save') + ' & ' + t('regenerate') });
  actions.append(cancel, save);
  // 编辑时也要能管理附件：显示缩略图/文件卡，点开可看，右上角 ✕ 移除（保存时按剩下的走）
  const editAtts = (m.attachments || []).map((a) => ({ ...a }));
  const attsBox = h('div', { class: 'edit-atts' });
  const paintAtts = () => {
    attsBox.replaceChildren();
    if (!editAtts.length) return;
    attsBox.append(attachGridView(editAtts, { editable: true, onChange: paintAtts }));
  };
  paintAtts();
  if (editAtts.length) box.append(attsBox);
  box.append(ta, actions);
  wrap.replaceChildren(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.style.height = Math.min(320, ta.scrollHeight + 8) + 'px';

  cancel.addEventListener('click', () => renderChat());
  save.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    normalizeConv(conv);
    // 编辑后作为同一父节点下的新分支，原提问与原回答都保留
    const userMsg = { ...m, id: uid('u'), content: text, attachments: editAtts.slice(), createdAt: Date.now() };
    const assistant = {
      id: uid('a'), role: 'assistant', content: '', reasoning: '', annotations: [],
      serverToolCalls: [], model: settings.model, createdAt: Date.now(), streaming: true,
    };
    appendBranch(conv, m.parentId ?? null, [userMsg, assistant]);
    saveConversations();
    state.streaming = true;
    state.controller = new AbortController();
    updateComposerState();
    renderChat();
    runStream({ conv, assistant, history: visibleMessages(conv).slice(0, -1) });
  });
}

async function copyMessage(m) {
  const ok = await copyText(toPlainText(m.content || ''));
  toast(ok ? t('copied') : '复制失败');
}

async function readAloud(m, btn) {
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
    $$('.act-btn.on').forEach((b) => b.classList.remove('on'));
    return;
  }
  btn.classList.add('on');
  try {
    const text = toPlainText(m.content || '');
    if (!text) throw new Error('没有可朗读的内容');
    const blob = await synthesize(text.slice(0, 10000), settings.ttsVoice);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.audio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      state.audio = null;
      btn.classList.remove('on');
    };
    await audio.play();
  } catch (e) {
    btn.classList.remove('on');
    throw e;
  }
}

/**
 * 滚动到底。
 * force=true：无条件到底（发送新消息、切会话）。
 * force=false：只有用户还在底部附近时才跟随输出 —— 用户手动上翻看历史时，
 *              模型继续输出（含工具卡片重绘）都不许把视图拽下去。
 */
function scrollToBottom(force = false) {
  const view = els.chatView;
  if (!view) return;
  if (force) state.followBottom = true;
  else if (!state.followBottom) return;
  view.scrollTop = view.scrollHeight;
}

/** 距底 ≤24px 视为「在底部」，超过 120px 才算「离开底部」（滞回，避免抖动） */
const STICK_ENTER = 24;
const STICK_LEAVE = 120;
function wireStickToBottom() {
  els.chatView.addEventListener('scroll', () => {
    const view = els.chatView;
    const dist = view.scrollHeight - view.scrollTop - view.clientHeight;
    if (dist <= STICK_ENTER) state.followBottom = true;
    else if (dist > STICK_LEAVE) state.followBottom = false;
  }, { passive: true });
}

/* ------------------------------ 输入框 ------------------------------ */
/** 官方同款：由隐藏的 mirror 撑高度，textarea 只负责滚动，不做 height 计算 */
function autoGrow() {
  if (els.promptMirror) {
    // 末尾补一个换行，空行也能占一行高度
    els.promptMirror.textContent = els.prompt.value + '\n';
  }
  // 内容变短时把滚动位置拉回顶部，避免停在中间
  if (els.prompt.scrollTop > 0) els.prompt.scrollTop = els.prompt.scrollHeight < els.prompt.clientHeight ? 0 : els.prompt.scrollTop;
}

function renderTray() {
  if (!state.attachments.length) {
    els.tray.classList.add('hidden');
    els.tray.replaceChildren();
    return;
  }
  els.tray.classList.remove('hidden');
  els.tray.replaceChildren(...state.attachments.map((a) => {
    const card = h('div', { class: 'attach-card' + (a.error ? ' failed' : '') + (a.ready === false ? ' busy' : '') });

    // 缩略图：图片用预览，其它显示文件瓦片
    if (a.kind === 'image' && (a.previewUrl || a.dataUrl || a.attId)) {
      card.append(h('img', { src: a.previewUrl || a.dataUrl || attachmentUrl(a.attId), alt: '' }));
    } else {
      const ext = (a.name || '').split('.').pop()?.slice(0, 5) || 'FILE';
      card.append(h('div', { class: 'file-tile' }, [
        iconEl(a.kind === 'image' ? 'i-image' : 'i-file'),
        h('span', { class: 'ext', text: ext }),
      ]));
    }

    // 上传中：蒙层 + 转圈
    if (a.ready === false) {
      card.append(h('div', { class: 'mask', title: t('uploading') }, [h('div', { class: 'spinner' })]));
    } else if (a.error) {
      // 失败：有原始文件可重试（蒙层深、中间重试图标），否则只显示原因（蒙层浅、贴底）
      const canRetry = Boolean(a._file);
      const mask = h('div', { class: 'mask ' + (canRetry ? 'retry' : 'static'), title: (a.errorDetail || a.error) + (canRetry ? '（点击重试）' : '') }, [
        canRetry ? iconEl('i-refresh') : null,
        h('span', { class: 'reason', text: a.error }),
      ]);
      if (canRetry) {
        mask.addEventListener('click', (e) => {
          e.stopPropagation();
          const file = a._file;
          state.attachments = state.attachments.filter((z) => z !== a);
          renderTray();
          handleFiles([file]);
        });
      }
      card.append(mask);
    }

    // 半透明卡片也能点开看：图片进灯箱，文件另开一页（上传中/失败时点不进）
    if (a.ready !== false && !a.error) {
      const src = a.kind === 'image' ? (a.previewUrl || a.dataUrl || (a.attId ? attachmentUrl(a.attId) : '')) : '';
      if (a.kind === 'image' && src) {
        card.classList.add('clickable');
        card.title = '点击查看大图';
        card.addEventListener('click', () => openLightbox(src));
      } else if (a.kind !== 'image') {
        card.classList.add('clickable');
        card.title = '点击查看文件';
        card.addEventListener('click', () => openAttachment(a));
      }
    }

    const x = h('button', { class: 'x', type: 'button', title: '移除' }, [iconEl('i-x')]);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      state.attachments = state.attachments.filter((z) => z !== a);
      renderTray();
      updateComposerState();
    });
    card.append(x);
    return card;
  }));
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|ini|conf|toml|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|cs|php|rb|swift|kt|lua|sh|bat|ps1|sql)$/i;
const DOC_EXT = /\.(pdf|docx?|pptx?)$/i;

async function handleFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= 10) { toast('最多 10 个附件'); break; }
    if (file.size > 100 * 1024 * 1024) { toast(t('docTooBig')); continue; }
    const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(file.type);
    if (isImage) {
      if (!supportsVision(eff().model)) { toast(t('visionUnsupported')); continue; }
      const att = { kind: 'image', name: file.name || 'image.png', size: file.size, ready: false };
      Object.defineProperty(att, '_file', { value: file, enumerable: false, configurable: true });
      state.attachments.push(att);
      renderTray();
      try {
        const c = await compressImage(file);
        att.size = c.bytes;
        // 1) 先落到服务端 data/attachments（历史与展示都读它，不进浏览器）
        try {
          const local = await uploadAttachment(dataUrlToBlob(c.dataUrl), att.name);
          att.attId = local.id;
          att.previewUrl = attachmentUrl(local.id);
        } catch {
          att.previewUrl = c.dataUrl; // 附件服务异常时退化为内联显示
        }
        // 2) 再传到 DeepSeek Files API，供模型引用（省请求体）
        if (hasApiKey() && !settings.mock) {
          try {
            const up = await uploadFile(dataUrlToFile(c.dataUrl, att.name), 'user_data');
            att.fileId = up.id;
          } catch {
            att.dataUrl = c.dataUrl; // Files API 不可用：请求时内联 base64（存在服务端 JSON 里）
          }
        } else {
          att.dataUrl = c.dataUrl;
        }
        att.ready = true;
      } catch (e) {
        att.error = t('uploadFailShort');
        att.errorDetail = e.message || t('uploadFail');
      }
      renderTray();
      updateComposerState();
      continue;
    }

    if (DOC_EXT.test(file.name)) {
      const att = { kind: 'doc', name: file.name, size: file.size, ready: false };
      Object.defineProperty(att, '_file', { value: file, enumerable: false, configurable: true });
      state.attachments.push(att);
      renderTray();
      try {
        if (hasApiKey() && !settings.mock) {
          const up = await uploadFile(file, settings.docLayout);
          att.fileId = up.id;
        } else {
          throw new Error('未配置 Key 或演示模式下无法解析文档');
        }
        att.ready = true;
      } catch (e) {
        att.error = /Key|演示/.test(e.message) ? t('needKeyShort') : t('uploadFailShort');
        att.errorDetail = e.message;
        att.ready = true;
      }
      renderTray();
      updateComposerState();
      continue;
    }

    if (TEXT_EXT.test(file.name) || file.type.startsWith('text/')) {
      const att = { kind: 'text', name: file.name, size: file.size, ready: true };
      state.attachments.push(att);
      renderTray();
      try {
        const text = await readAsText(file);
        att.text = text.slice(0, 400000);
        att.truncated = text.length > 400000;
      } catch {
        att.error = '读取失败';
      }
      updateComposerState();
      continue;
    }

    toast('不支持的文件类型：' + file.name);
  }
  updateComposerState();
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function dataUrlToFile(dataUrl, name) {
  const [meta, b64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(meta)?.[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

function openLightbox(src) {
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() }, [h('img', { src, alt: '' })]);
  document.body.append(box);
}

/* ------------------------------ 录音频谱 ------------------------------ */
/* 参数与官方 Spectrum.tsx 一致：2px 柱 / 3px 间距 / 静止 5px / 最高 36px / 最多 60 根
   人声 100–4000Hz 按对数分段，倍频程倾斜补偿，低于底噪不起跳 */
const SP = {
  barW: 2, gap: 3, min: 5, max: 36, maxBars: 60,
  freqLow: 100, freqHigh: 4000, dbFloor: -80, dbCeil: -25, tilt: 4,
};

function buildSpectrumRanges(n, binWidth, binCount) {
  const ranges = [];
  const ratio = SP.freqHigh / SP.freqLow;
  for (let i = 0; i < n; i += 1) {
    const low = SP.freqLow * ratio ** (i / n);
    const high = SP.freqLow * ratio ** ((i + 1) / n);
    const from = Math.min(binCount - 1, Math.floor(low / binWidth));
    const to = Math.min(binCount, Math.max(from + 1, Math.ceil(high / binWidth)));
    ranges.push({ from, to, center: Math.sqrt(low * high) / binWidth });
  }
  return ranges;
}

function stopSpectrum() {
  cancelAnimationFrame(state.spectrumRaf);
  state.spectrumRaf = 0;
  els.shell.querySelector('.input-main')?.classList.remove('recording');
  if (els.spectrum) {
    els.spectrum.classList.add('hidden');
    els.spectrum.replaceChildren();
  }
}

function startSpectrum() {
  const host = els.spectrum;
  if (!host) return;
  host.classList.remove('hidden');
  els.shell.querySelector('.input-main')?.classList.add('recording');

  // 按容器宽度算柱数
  const fit = Math.floor((host.clientWidth + SP.gap) / (SP.barW + SP.gap));
  const count = Math.max(1, Math.min(SP.maxBars, fit));
  host.replaceChildren(...Array.from({ length: count }, () => h('span', { class: 'bar' })));
  const bars = Array.from(host.children);

  const levels = new Float32Array(count);
  const targets = new Float32Array(count);
  const tilts = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    tilts[i] = SP.tilt * Math.log2(SP.freqHigh / SP.freqLow) * (i / count);
  }
  let data = new Float32Array(0);
  let ranges = [];
  let rangeKey = '';

  const draw = () => {
    state.spectrumRaf = requestAnimationFrame(draw);
    const analyser = state.analyser;
    if (analyser) {
      if (data.length !== analyser.frequencyBinCount) data = new Float32Array(analyser.frequencyBinCount);
      const key = `${analyser.context.sampleRate}:${analyser.fftSize}`;
      if (key !== rangeKey) {
        rangeKey = key;
        ranges = buildSpectrumRanges(count, analyser.context.sampleRate / analyser.fftSize, data.length);
      }
      analyser.getFloatFrequencyData(data);
    }
    for (let i = 0; i < count; i += 1) {
      let target = 0;
      if (analyser && ranges[i]) {
        const { from, to, center } = ranges[i];
        let peak = -Infinity;
        if (to - from <= 1) {
          // 频段窄于一个 bin：相邻 bin 线性插值，否则低频几根柱子同步跳
          const base = Math.min(data.length - 2, Math.floor(center));
          const weight = center - base;
          peak = data[base] * (1 - weight) + data[base + 1] * weight;
        } else {
          for (let bin = from; bin < to; bin += 1) peak = Math.max(peak, data[bin]);
        }
        const db = peak + tilts[i];
        target = Math.min(1, Math.max(0, (db - SP.dbFloor) / (SP.dbCeil - SP.dbFloor)));
      }
      targets[i] = target;
    }
    for (let i = 0; i < count; i += 1) {
      // 和相邻频段加权平均，填平谐波空隙
      const prev = targets[Math.max(0, i - 1)];
      const next = targets[Math.min(count - 1, i + 1)];
      const target = (prev + targets[i] * 2 + next) / 4;
      // 起得快、落得慢
      levels[i] += (target - levels[i]) * (target > levels[i] ? 0.8 : 0.35);
      const height = SP.min + (SP.max - SP.min) * levels[i];
      bars[i].style.transform = `scaleY(${height / SP.min})`;
    }
  };
  state.spectrumRaf = requestAnimationFrame(draw);
}

/* ------------------------------ 语音输入 ------------------------------ */
async function toggleRecording() {
  if (state.recording) {
    state.recording.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { toast('当前浏览器不支持录音'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);

    // 边录边分析（不接 destination，不会外放自己的声音）
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const srcNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      srcNode.connect(analyser);
      state.audioCtx = ctx;
      state.analyser = analyser;
      startSpectrum();
    } catch {
      // 拿不到 analyser 就只录音，不显示频谱
    }
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t2) => t2.stop());
      stopSpectrum();
      state.analyser = null;
      try { await state.audioCtx?.close(); } catch {}
      state.audioCtx = null;
      state.recording = null;
      els.mic.classList.remove('on');
      els.mic.style.color = '';
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/ogg' });
      if (!hasApiKey() && !settings.mock) { toast(t('needKey')); return; }
      toast('识别中…');
      try {
        const r = await transcribe(blob, mime ? 'speech.ogg' : 'speech.webm');
        if (r.text) {
          els.prompt.value = (els.prompt.value + ' ' + r.text).trim();
          autoGrow();
          updateComposerState();
        } else toast('没有识别到内容');
      } catch (e) {
        toast('识别失败：' + e.message);
      }
    };
    rec.start();
    state.recording = rec;
    els.mic.classList.add('on');
    els.mic.style.color = 'var(--state-error)';
    toast('录音中，再次点击结束');
  } catch (e) {
    toast('无法访问麦克风：' + e.message);
  }
}

/* ----------------------------- 搜索面板 ----------------------------- */
function siteLetter(url) {
  try { return (new URL(url).hostname.replace(/^www\./, '')[0] || '?').toUpperCase(); } catch { return '?'; }
}

function closeSearchPanel() {
  state.searchPanel = null;
  els.searchPanel?.classList.add('hidden');
  els.searchPanel?.replaceChildren();
}

function openSearchPanel(title, sources) {
  if (!sources?.length) return;
  state.searchPanel = { title, sources };
  const panel = els.searchPanel;
  panel.replaceChildren(
    h('div', { class: 'search-panel-head' }, [
      h('div', { class: 'search-panel-title', text: title || t('searchResult') }),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('close'), onclick: closeSearchPanel }, [iconEl('i-x')]),
    ]),
    h('div', { class: 'search-panel-body' }, sources.map((s) => h('a', {
      class: 'search-panel-item',
      href: s.url,
      target: '_blank',
      rel: 'noreferrer noopener',
    }, [
      h('div', { class: 'meta' }, [
        h('span', { class: 'site-logo', text: siteLetter(s.url) }),
        h('span', { class: 'site-name', text: s.site_name || (() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return s.url; } })() }),
      ]),
      h('div', { class: 'sp-title', text: s.title || s.url }),
      s.snippet ? h('div', { class: 'sp-snippet', text: s.snippet }) : null,
    ]))),
  );
  panel.classList.remove('hidden');
}

/* --------------------------- 引用悬停卡片 --------------------------- */
/* 官方 HoverCard：进入 300ms 后显示、离开 100ms 后关闭、间距 6px；卡片自身可移入 */
const CITE_ENTER = 300;
const CITE_LEAVE = 100;
let citeTimer = 0;
let citeCard = null;
let citeAnchor = null;

function siteOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ''), letter: (u.hostname.replace(/^www\./, '')[0] || '?') };
  } catch {
    return { host: url.slice(0, 30), letter: '?' };
  }
}

function closeCiteCard() {
  clearTimeout(citeTimer);
  citeCard?.remove();
  citeCard = null;
  citeAnchor = null;
}

function showCiteCard(sup) {
  closeCiteCard();
  const url = sup.dataset.url;
  if (!url) return;
  const title = sup.getAttribute('title') || url;
  const site = siteOf(url);

  const card = h('div', { class: 'cite-card', role: 'tooltip' }, [
    h('div', { class: 'site' }, [
      h('span', { class: 'site-logo', text: site.letter }),
      h('span', { class: 'site-name', text: site.host }),
    ]),
    h('div', { class: 'card-title', text: title }),
    h('div', { class: 'card-url', text: url }),
  ]);

  // 先隐藏挂上量尺寸，再定位（与菜单同一套做法，避免闪烁）
  card.style.visibility = 'hidden';
  document.body.append(card);
  const r = sup.getBoundingClientRect();
  const w = card.offsetWidth;
  const hh = card.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  card.style.left = left + 'px';
  card.style.top = top + 'px';
  card.style.visibility = '';

  card.addEventListener('mouseenter', () => clearTimeout(citeTimer));
  card.addEventListener('mouseleave', () => {
    citeTimer = setTimeout(closeCiteCard, CITE_LEAVE);
  });
  card.addEventListener('click', () => { window.open(url, '_blank', 'noopener'); closeCiteCard(); });

  citeCard = card;
  citeAnchor = sup;
}

function wireCiteCards(root) {
  root.addEventListener('mouseover', (e) => {
    const sup = e.target.closest?.('.cite');
    if (!sup || sup === citeAnchor) return;
    clearTimeout(citeTimer);
    citeTimer = setTimeout(() => showCiteCard(sup), CITE_ENTER);
  });
  root.addEventListener('mouseout', (e) => {
    const sup = e.target.closest?.('.cite');
    if (!sup) return;
    citeTimer = setTimeout(closeCiteCard, CITE_LEAVE);
  });
  // 页面滚动或点别处就收起，避免卡片悬空
  window.addEventListener('scroll', closeCiteCard, true);
}

/* ------------------------------ 弹层 ------------------------------ */
function closeMenu() {
  state.menu?.remove();
  state.menu = null;
  state.menuAnchor = null;
  if (state.menuOff) {
    document.removeEventListener('mousedown', state.menuOff);
    state.menuOff = null;
  }
  if (state.menuOnClose) {
    const fn = state.menuOnClose;
    state.menuOnClose = null;
    try { fn(); } catch { /* 清理回调失败不影响主流程 */ }
  }
}
function showMenu(anchor, content, placement = 'down') {
  closeMenu();
  const pop = h('div', { class: 'popover ' + placement });
  pop.append(...content);
  // 先隐藏挂上去量尺寸，再定位，避免闪烁与 0 尺寸
  pop.style.visibility = 'hidden';
  document.body.append(pop);

  const w = pop.offsetWidth;
  const hgt = pop.offsetHeight;

  let rect = anchor.getBoundingClientRect();
  // 锚点在 hover 才显示（rect 全 0）时，退回整行/容器，别让菜单飘到左上角
  if (!rect.width && !rect.height) {
    const alt = anchor.closest('.chat-item, .chat-group, .input-bar, .top-bar, .sidebar-foot');
    rect = (alt || anchor.parentElement || anchor).getBoundingClientRect();
  }

  let left = rect.left;
  if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
  left = Math.max(12, left);

  let top = placement === 'down' ? rect.bottom + 8 : rect.top - hgt - 8;
  if (top < 8) top = rect.bottom + 8;                          // 上方放不下 → 翻到下方
  if (top + hgt > window.innerHeight - 12) {                   // 下方也放不下 → 贴底
    top = Math.max(8, Math.min(top, window.innerHeight - hgt - 12));
  }

  pop.style.left = left + window.scrollX + 'px';
  pop.style.top = top + window.scrollY + 'px';
  pop.style.bottom = 'auto';
  pop.style.right = 'auto';
  pop.style.visibility = '';

  state.menu = pop;
  state.menuAnchor = anchor;
  setTimeout(() => {
    // 换菜单时旧监听已由 closeMenu 清掉，这里保证同一时刻只有一个
    const off = (e) => {
      // 点锚点本身（含它的子元素，比如 svg/use）不算「点外面」，
      // 交给按钮的 click 做开关判定，否则 mousedown 先收起、click 又重开，看起来就是「点不掉」
      if (!pop.contains(e.target) && !(anchor.contains && anchor.contains(e.target))) closeMenu();
    };
    state.menuOff = off;
    document.addEventListener('mousedown', off);
  }, 0);
  return pop;
}

function modelMenu() {
  // 同一个按钮再点一次 = 收起（开关式）
  if (state.menu && state.menuAnchor === $('#btnModel')) { closeMenu(); return; }
  const items = state.models.map((m) => {
    const curModel = eff().model;
    const item = h('button', { class: 'menu-item' + (m.id === curModel ? ' selected' : ''), type: 'button' }, [
      h('div', {}, [
        h('div', { text: m.name || m.id }),
        h('span', { class: 'desc', text: `${m.id} · 上下文 ${Math.round((m.context_window || 0) / 1024)}K · ${(m.input_modalities || []).join('/')}` }),
      ]),
      m.id === curModel ? iconEl('i-check', 'check') : null,
    ]);
    item.addEventListener('click', () => {
      setEffective('model', m.id);
      if (!supportsVision(m.id) && state.attachments.some((a) => a.kind === 'image')) {
        toast(t('visionUnsupported'));
      }
      closeMenu();
    });
    return item;
  });
  const refresh = h('button', { class: 'menu-item', type: 'button', text: '刷新模型列表' });
  refresh.addEventListener('click', async () => {
    try {
      state.models = await listModels();
      saveSettings({ models: state.models.map((m) => m.id) });
      toast('已更新模型列表');
      closeMenu();
      updateComposerState();
    } catch (e) { toast(e.message); }
  });
  showMenu($('#btnModel'), [...items, h('div', { class: 'menu-sep' }), refresh]);
}

/** 思考强度面板：档位列表 + 滑条（对齐「上下文用量」那种面板样式）。
 *  同一个按钮再点一次 = 收起（开关式），不会出现「点不掉」。 */
const EFFORT_LEVELS = ['low', 'high', 'max'];
function effortMenu() {
  if (state.menu && state.menuAnchor === els.effort) { closeMenu(); return; }
  const names = { low: t('effortLow'), high: t('effortHigh'), max: t('effortMax') };
  const cur = eff().effort || 'high';
  let idx = Math.max(0, EFFORT_LEVELS.indexOf(cur));

  const bigVal = h('b', { class: 'effort-big', text: names[EFFORT_LEVELS[idx]] });
  const lvTag = h('span', { class: 'effort-tag', text: EFFORT_LEVELS[idx] });
  const footVal = h('b', { text: names[EFFORT_LEVELS[idx]] });

  const paint = () => {
    const lv = EFFORT_LEVELS[idx];
    bigVal.textContent = names[lv];
    lvTag.textContent = lv;
    footVal.textContent = names[lv];
  };

  const slider = makeSlider({
    max: EFFORT_LEVELS.length - 1,
    value: idx,
    dots: true,
    ariaLabel: t('reasoningEffort'),
    onInput: (v) => { idx = v; paint(); },
    onChange: (v) => { idx = v; paint(); setEffective('effort', EFFORT_LEVELS[idx]); },
  });

  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', title: '关闭', 'aria-label': '关闭' }, [iconEl('i-x')]);
  closeBtn.addEventListener('click', () => closeMenu());

  const panel = h('div', { class: 'effort-panel' }, [
    h('div', { class: 'effort-head' }, [h('span', { class: 'effort-title', text: t('reasoningEffort') }), closeBtn]),
    h('div', { class: 'effort-row' }, [bigVal, lvTag]),
    h('div', { class: 'effort-desc', text: '档位越高，思考越久、费用越高' }),
    h('div', { class: 'effort-sep' }),
    h('div', { class: 'effort-foot' }, [h('span', { text: t('reasoningEffort') + ' · ' }), footVal]),
    slider.el,
  ]);
  showMenu(els.effort, [panel], 'up');
  slider.refresh(false);
}


/* ------------------------------ 数据 ------------------------------ */
let balanceAt = 0;
let balanceBusy = false;
/** 查余额。silent=true 用于自动查询：不弹 toast、失败就保持原样，避免打断 */
async function updateBalance({ silent = false } = {}) {
  if (!hasApiKey() && !settings.mock) { if (!silent) toast(t('needKey')); return; }
  if (balanceBusy) return;
  balanceBusy = true;
  const before = els.balanceHint.textContent;
  if (!silent || !before || before === '—') els.balanceHint.textContent = t('balanceLoading');
  try {
    const b = await getBalance();
    const info = (b.balance_infos || [])[0];
    els.balanceHint.textContent = info ? `${info.currency} ${info.total_balance}` : (b.is_available ? '可用' : '不可用');
    balanceAt = Date.now();
  } catch (e) {
    if (silent) els.balanceHint.textContent = before || '—';
    else { els.balanceHint.textContent = t('balanceFail'); toast(e.message); }
  } finally {
    balanceBusy = false;
  }
}

/** 自动查询：打开页面一次；之后每完成一轮回答再刷一次（60 秒内不重复） */
function autoBalance(force = false) {
  if (!force && Date.now() - balanceAt < 60000) return;
  void updateBalance({ silent: true });
}

function updateBalanceHintFromUsage() {
  // 只在已知余额时做提示，不额外请求
}

function exportConversation(id) {
  const c = getConversation(id);
  if (!c) return;
  const lines = [`# ${convTitle(c)}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
  for (const m of c.messages) {
    if (m.role === 'user') {
      lines.push('## 你', '', m.content || '', '');
      if (m.attachments?.length) lines.push(`_附件：${m.attachments.map((a) => a.name).join('、')}_`, '');
    } else {
      lines.push('## DeepSeek', '');
      if (m.reasoning) lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>', '');
      lines.push(m.content || '', '');
    }
  }
  download(`${convTitle(c).replace(/[\\/:*?"<>|]/g, '_')}.md`, lines.join('\n'), 'text/markdown');
}

async function exportAll() {
  try {
    const snap = await exportAllData();
    download(`deepseek-chatbox-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(snap, null, 2));
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function onSettingsChange(patch = {}) {
  if (patch.theme) applyTheme();
  if (patch.lang) { applyLang(); }
  if (patch.data) { state.currentId = getConversation(state.currentId) ? state.currentId : null; renderSidebar(); renderChat(); }
  if (patch.model || patch.mock) {
    updateComposerState();
    if (patch.mock) refreshModels();
  }
  if (patch.apiKey) updateComposerState();
  if (patch.prices || patch.peakMode) renderChat();  // 费用按峰谷估算，改完得重算
  if (patch.peakMode && typeof refreshPeakState === 'function') void refreshPeakState();
  renderSidebar();
  updateComposerState();
}

async function refreshModels() {
  if (!hasApiKey() && !settings.mock) {
    state.models = cachedModels();
    updateComposerState();
    return;
  }
  try {
    state.models = await listModels();
    updateComposerState();
  } catch {
    state.models = cachedModels();
  }
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 900) {
    els.app.classList.add('sidebar-collapsed');
    saveUI({ sidebarCollapsed: true });
  }
}

/** 侧栏展开/收起：侧栏头的收起按钮与顶栏胶囊的展开按钮共用 */
function toggleSidebar() {
  els.app.classList.toggle('sidebar-collapsed');
  saveUI({ sidebarCollapsed: els.app.classList.contains('sidebar-collapsed') });
}

/** 搜索：先保证侧栏可见，再展开搜索框并聚焦（收起态直接点顶栏搜索也能用） */
function toggleSearchPanel() {
  const willShow = els.searchWrap.classList.contains('hidden');
  if (willShow && els.app.classList.contains('sidebar-collapsed')) {
    els.app.classList.remove('sidebar-collapsed');
    saveUI({ sidebarCollapsed: false });
  }
  els.searchWrap.classList.toggle('hidden', !willShow);
  if (willShow) els.chatSearchInput.focus();
}

/** 手机地址栏/软键盘会改变视觉视口，用 --app-height 跟随，避免输入框被挡住 */
function wireViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  const sync = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const h = Math.round(vv.height);
      if (window.innerWidth <= 900 && h > 200) {
        document.documentElement.style.setProperty('--app-height', h + 'px');
      } else {
        document.documentElement.style.removeProperty('--app-height');
      }
      if (document.activeElement === els.prompt) scrollToBottom();
    });
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', () => setTimeout(sync, 250));
  sync();
}

/** 手机手势：左缘右滑打开侧栏，侧栏上左滑关闭 */
function wireSwipe() {
  let sx = 0, sy = 0, tracking = false, moved = false;
  const isOpen = () => !els.app.classList.contains('sidebar-collapsed');
  const drawerW = () => Math.min(window.innerWidth * 0.86, 340);

  els.app.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || window.innerWidth > 900) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    tracking = true;
    moved = false;
  }, { passive: true });

  els.app.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const dx = Math.abs(e.touches[0].clientX - sx);
    const dy = Math.abs(e.touches[0].clientY - sy);
    if (dx > 14 && dx > dy) moved = true; // 横向意图，避免与纵向滚动打架
  }, { passive: true });

  els.app.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    if (!moved) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    if (dy > 70 || Math.abs(dx) < 50) return;
    if (dx > 0 && sx < 40 && !isOpen()) {
      els.app.classList.remove('sidebar-collapsed');
      saveUI({ sidebarCollapsed: false });
    } else if (dx < 0 && isOpen() && sx < drawerW()) {
      closeSidebarOnMobile();
    }
  }, { passive: true });
}

function wire() {
  wireStickToBottom();
  els.prompt.addEventListener('input', () => { autoGrow(); updateComposerState(); });
  els.prompt.addEventListener('focus', () => els.shell.classList.add('focused'));
  els.prompt.addEventListener('blur', () => els.shell.classList.remove('focused'));
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!els.send.disabled) sendMessage();
      else if (state.streaming) stopStreaming();
    }
  });
  els.prompt.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); handleFiles(files); }
  });

  els.shell.addEventListener('click', (e) => {
    if (e.target === els.shell || e.target.classList.contains('input-main')) els.prompt.focus();
  });
  els.shell.addEventListener('dragover', (e) => { e.preventDefault(); els.shell.classList.add('dragover'); });
  els.shell.addEventListener('dragleave', () => els.shell.classList.remove('dragover'));
  els.shell.addEventListener('drop', (e) => {
    e.preventDefault();
    els.shell.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  els.send.addEventListener('click', () => {
    if (state.streaming) stopStreaming();
    else sendMessage();
  });

  els.think.addEventListener('click', () => {
    setEffective('thinking', !eff().thinking);
  });
  els.search.addEventListener('click', () => {
    const on = !eff().search;
    setEffective('search', on);
    if (on) {
      setEffective('readUrl', true);
      // 官方联网工具只支持 flash；本地联网不挑模型
      if (eff().searchMode === 'official' && eff().model !== 'deepseek-flash') {
        setEffective('model', 'deepseek-flash');
        toast('官方联网工具需使用 deepseek-flash，已自动切换');
      }
    }
  });
  els.tools.addEventListener('click', () => {
    setEffective('localTools', !eff().localTools);
  });
  els.effort.addEventListener('click', effortMenu);
  $('#btnModel').addEventListener('click', modelMenu);

  $('#btnNewChat').addEventListener('click', newChat);
  $('#btnNewChatTop').addEventListener('click', newChat);
  // 多选：退出 / 取消 / 全选 / 批量置顶 / 批量删除 / 批量导出
  $('#btnSelectExit').addEventListener('click', exitSelection);
  $('#btnSelectCancel').addEventListener('click', exitSelection);
  $('#bulkAllLabel').addEventListener('click', (e) => { e.preventDefault(); bulkToggleAll(); });
  $('#btnBulkPin').addEventListener('click', bulkPinSelected);
  $('#btnBulkDelete').addEventListener('click', () => { void bulkDeleteSelected(); });
  $('#btnBulkExport').addEventListener('click', bulkExportSelected);
  $('#btnSearchChats').addEventListener('click', toggleSearchPanel);
  $('#btnSearchChats2').addEventListener('click', toggleSearchPanel);
  els.chatSearchInput.addEventListener('input', debounce(() => {
    state.searchQuery = els.chatSearchInput.value;
    renderSidebar();
  }, 120));

  $('#btnSettings').addEventListener('click', () => openSettings({ onChange: onSettingsChange }));
  $('#btnNewGroup').addEventListener('click', async () => {
    const name = await appPrompt({ title: '新建分组', value: '新分组', placeholder: '分组名称', okText: '创建' });
    if (name === null || !name.trim()) return;
    const g = createGroup(name.trim());
    saveUI({ collapsedGroups: (ui.collapsedGroups || []).filter((x) => x !== g.id) });
    renderSidebar();
    toast('已创建分组「' + g.name + '」，可用对话行上的文件夹图标把对话移入');
  });
  $('#btnConvSettings').addEventListener('click', () => {
    const conv = currentConversation();
    if (!conv) {
      toast('先开始一个对话，或到「设置」里改全局默认');
      openSettings({ onChange: onSettingsChange });
      return;
    }
    openScopeSettings({ kind: 'conv', id: conv.id, onChange: onScopeChange });
  });
  $('#btnBalance').addEventListener('click', updateBalance);
  $('#btnExportAll').addEventListener('click', exportAll);
  $('#btnTheme').addEventListener('click', () => {
    const dark = document.body.dataset.theme === 'dark';
    saveSettings({ theme: dark ? 'light' : 'dark' });
    applyTheme();
  });
  $('#btnMenu').addEventListener('click', toggleSidebar);
  $('#btnMenuOpen').addEventListener('click', toggleSidebar);

  wireViewport();
  wireSwipe();
  wireCiteCards(els.viewInner);
  els.scrim.addEventListener('click', () => {
    els.app.classList.add('sidebar-collapsed');
    saveUI({ sidebarCollapsed: true });
  });
  // disabled 的按钮不派发 click，这里在容器上接管，告诉用户为什么点不动
  document.querySelector('.input-bar .left').addEventListener('click', (ev) => {
    const t2 = ev.target.closest('.toggle.disabled');
    if (t2) toast('官方联网模式下本地工具不可用（接口限制），可在设置里改成「本地联网」');
  }, true);

  $('#btnAttach').addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.length) handleFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  els.mic.addEventListener('click', toggleRecording);

  // 消息区事件委托：代码复制 / 引用跳转 / 图片
  els.viewInner.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-code]');
    if (copyBtn) {
      const block = copyBtn.closest('.code-block');
      const code = block?.querySelector('code')?.innerText || '';
      copyText(code).then((ok) => {
        copyBtn.textContent = ok ? t('copied') : '失败';
        setTimeout(() => (copyBtn.textContent = t('copy')), 1400);
      });
      return;
    }
    const cite = e.target.closest('.cite');
    if (cite) {
      const url = cite.dataset.url;
      if (url) window.open(url, '_blank', 'noopener');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      newChat();
    }
    if (e.key === 'Escape') {
      closeMenu();
      if (state.selection) { exitSelection(); return; }
      if (state.streaming) stopStreaming();
    }
  });

  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme();
  });

  window.addEventListener('resize', debounce(() => {
    if (window.innerWidth <= 900) els.app.classList.add('sidebar-collapsed');
  }, 150));

  window.addEventListener('beforeunload', (e) => {
    flushNow();
    if (state.streaming) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('popstate', applyRouteFromHistory);   // 前进/后退切会话
}

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  const params = new URLSearchParams(location.search);

  // 1) 先把服务端状态拉下来（设置、UI、全部对话都在 data/ 里）
  try {
    await initStore();
  } catch (e) {
    els.viewInner.replaceChildren(h('div', { class: 'welcome' }, [
      h('div', { class: 'welcome-title', text: '无法连接本地服务' }),
      h('div', { class: 'welcome-sub', text: '请确认启动窗口还开着，或重启程序。' }),
      h('div', { class: 'notice', style: { maxWidth: '560px' } }, [iconEl('i-warning'), h('div', { text: e.message })]),
    ]));
    els.prompt.disabled = true;
    els.send.disabled = true;
    return;
  }

  if (params.get('demo') === '1' && !settings.mock) {
    settings.mock = true; // 仅本次会话生效，不写入服务端设置
    state.models = cachedModels();
  }
  if (params.get('theme')) saveSettings({ theme: params.get('theme') });

  // 峰谷自动模式：后台查一次节假日 API（带缓存），不阻塞首屏
  void refreshPeakState();
  setInterval(() => { void refreshPeakState(); }, 30 * 60 * 1000); // 半小时刷新，跨时段自动更新
  if (params.get('lang')) saveSettings({ lang: params.get('lang') });
  setLang(settings.lang);
  applyStatic();
  applyTheme();
  const narrow = window.innerWidth <= 900;
  els.app.classList.toggle('sidebar-collapsed', narrow ? true : Boolean(ui.sidebarCollapsed));
  wire();

  // 官方风格深链：/a/chat/s/<uuid> 打开对应会话；无效 uuid 回欢迎页并纠正地址栏
  const routed = convFromRoute();
  if (routed) state.currentId = routed.id;
  else if (location.pathname.startsWith(CHAT_PATH)) {
    state.currentId = null;
    syncRoute();            // 链接失效 → 纠正为根路径
  }

  mountCtxChip();
  prefetchToolDefs();   // 用量面板要按真实请求统计 tools 段
  renderSidebar();
  renderChat();
  syncRoute();              // 首屏规范地址栏：欢迎页=根路径；有会话=/a/chat/s/<uuid>
  autoGrow();
  updateComposerState();

  // 环境变量兜底提示（服务端有 Key 时也算已配置，下面统一刷新一次）
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    if (j.hasKey && !hasApiKey()) {
      settings.hasKey = true;
      els.keyHint.textContent = 'ENV';
    }
  } catch {}

  refreshModels();
  autoBalance(true);          // 打开页面自动查一次余额（静默，没配 Key 就直接跳过）

  const q = params.get('q');
  if (q) {
    els.prompt.value = q;
    autoGrow();
    updateComposerState();
    setTimeout(() => sendMessage(), 400);
  }

  // 便于检查渲染的静态样例（?seed=1）
  if (params.get('seed') === '1') seedSample();
}

function seedSample() {
  const conv = createConversation({ title: '界面渲染检查' });
  conv.messages.push({
    id: uid('u'), role: 'user', createdAt: Date.now() - 60000,
    content: '请演示一下 Markdown 渲染：表格、代码、公式、Mermaid，并模拟一次联网搜索。',
    attachments: [{ kind: 'doc', name: '示例报告.pdf', size: 1048576 }],
  });
  conv.messages.push({
    id: uid('a'), role: 'assistant', createdAt: Date.now() - 50000,
    model: 'deepseek-flash',
    reasoning: '用户希望验证渲染能力。我需要依次输出思考块、搜索来源卡片、带角标的正文、表格、代码块、独立公式与 Mermaid 流程图，并控制篇幅。先规划结构：能力清单表格 → 代码 → 公式 → 流程图 → 引用说明。',
    reasoningSeconds: 6.4,
    content: [
      '下面是一次完整的渲染演示，覆盖 **Markdown**、`行内代码`、表格、代码高亮、公式与图表。',
      '',
      '## 能力清单',
      '',
      '| 能力 | 状态 | 说明 |',
      '| --- | :---: | --- |',
      '| 流式输出 | ✅ | SSE 增量渲染，含 `reasoning_content` |',
      '| 联网搜索 | ✅ | 服务端工具 `deepseek_web_search` |',
      '| 引用角标 | ✅ | 按 Unicode 码点定位，可点击跳转 |',
      '| 公式 | ✅ | 行内 $E = mc^2$ 与独立公式 |',
      '',
      '$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,\\mathrm{d}x = \\sqrt{\\pi}$$',
      '',
      '```python',
      'from dataclasses import dataclass',
      '',
      '@dataclass',
      'class Message:',
      '    role: str',
      '    content: str',
      '',
      '    def render(self) -> str:',
      '        return f"{self.role}: {self.content}"',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[用户输入] --> B{思考模式}',
      '  B -- 开 --> C[深度思考搜索]',
      '  B -- 关 --> D[直接回答]',
      '  C --> E[带引用作答]',
      '  D --> E',
      '```',
      '',
      '> 引用块：以上内容全部由本地渲染器生成，不依赖任何在线 CDN。',
      '',
      '- 支持有序列表',
      '- 支持 **加粗**、*斜体*、~~删除线~~',
    ].join('\n'),
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://api-docs.deepseek.com/zh-cn/', title: 'DeepSeek API 文档', start_index: 6, end_index: 14 } }],
    serverToolCalls: [{
      index: 0, reasoning_content: '', calls: [{
        index: 0, id: 'srvtoolu_demo', type: 'deepseek_web_search', kind: 'search',
        action: { type: 'search', queries: ['DeepSeek 聊天补全 参数', 'deepseek_web_search 用法'] },
        status: 'completed',
        sources: [
          { url: 'https://api-docs.deepseek.com/zh-cn/api/create-chat-completion', title: 'Chat Completions API', snippet: 'messages、thinking、tools、response_format 等参数的完整定义。', site_name: 'DeepSeek' },
          { url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools', title: '联网工具', snippet: 'deepseek_web_search 与 deepseek_read_url 两个服务端工具。', site_name: 'DeepSeek' },
        ],
      }],
    }],
    usage: {
      prompt_tokens: 2048, completion_tokens: 812, total_tokens: 2860,
      prompt_cache_hit_tokens: 1536, prompt_cache_miss_tokens: 512,
      completion_tokens_details: { reasoning_tokens: 168 },
      server_tool_use: { tool_search: 2, tool_fetch: 0, tool_image_search: 0 },
    },
    finishReason: 'stop',
  });
  state.currentId = conv.id;
  saveConversations();
  renderSidebar();
  renderChat();
}

boot();
