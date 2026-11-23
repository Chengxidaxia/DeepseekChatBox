/* DeepSeek Chatbox —— 主流程 */
import { $, $$, h, uid, escapeHtml, formatBytes, formatTime, copyText, toast, compressImage, readAsText, download, debounce } from './util.js';
import {
  settings, ui, meta as storeMeta, saveSettings, saveUI, allConversations, getConversation,
  createConversation, updateConversation, deleteConversation, saveConversations, groupConversations,
  searchConversations, initStore, hasApiKey, uploadAttachment, attachmentUrl, flushNow,
  allGroups, getGroup, createGroup, updateGroup, deleteGroup, moveConversationToGroup,
  effectiveSettings, hasCustomScope, isPeakNow,
} from './store.js';
import { setLang, applyStatic, t, getLang } from './i18n.js';
import { renderMarkdown, hydrateMermaid, toPlainText, resetMermaidTheme } from './markdown.js';
import {
  cachedModels, modelInfo, supportsVision, listModels, getBalance, uploadFile,
  synthesize, transcribe, buildPayload, streamChat, buildReminder,
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
  controller: null,
  attachments: [],
  models: cachedModels(),
  audio: null,
  recording: null,
  searchQuery: '',
  menu: null,
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
    wrap.append(h('div', { class: 'chat-group-title', text: label(g.key) }));
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

  const tools = h('div', { class: 'folder-actions' });
  const mk = (iconId, title, fn) => {
    const b = h('button', { class: 'icon-btn sm', type: 'button', title, onclick: (e) => { e.stopPropagation(); fn(e); } }, [iconEl(iconId)]);
    return b;
  };
  tools.append(
    mk('i-plus', '在此分组新建对话', () => {
      newChat();
      const conv = ensureConversation();
      moveConversationToGroup(conv.id, g.id);
      renderSidebar();
    }),
    mk('i-settings', '分组设置', () => openScopeSettings({ kind: 'group', id: g.id, onChange: onScopeChange })),
    mk('i-edit', '重命名分组', async () => {
      const name = await appPrompt({ title: '重命名分组', value: g.name, okText: '保存' });
      if (name === null) return;
      updateGroup(g.id, { name: name.trim() || g.name });
      renderSidebar();
    }),
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
    }),
  );
  head.append(tools);
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

function convRow(c) {
  const row = h('div', { class: 'chat-item' + (c.id === state.currentId ? ' active' : ''), 'data-id': c.id });
  if (c.pinned) row.append(iconEl('i-pin', 'pin-mark'));
  if (hasCustomScope(c)) row.append(iconEl('i-settings', 'pin-mark'));
  row.append(h('span', { class: 'title', text: convTitle(c), title: convTitle(c) }));

  const actions = h('div', { class: 'row-actions' });
  const mk = (iconId, title, fn) => {
    const b = h('button', { class: 'icon-btn sm', type: 'button', title, onclick: (e) => { e.stopPropagation(); fn(e); } }, [iconEl(iconId)]);
    return b;
  };
  actions.append(
    mk('i-folder', '移动到分组', (e) => moveMenu(c, e.currentTarget)),
    mk('i-pin', c.pinned ? t('unpin') : t('pin'), () => { updateConversation(c.id, { pinned: !c.pinned }); renderSidebar(); }),
    mk('i-edit', t('rename'), () => renameConversation(c)),
    mk('i-trash', t('del'), () => removeConversation(c)),
  );
  row.append(actions);

  row.addEventListener('click', () => { if (state.searchQuery) { state.searchQuery = ''; els.searchWrap.classList.add('hidden'); els.chatSearchInput.value = ''; } openConversation(c.id); });
  return row;
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
    renderChat();
  }
  renderSidebar();
}

/* ------------------------------ 会话视图 ------------------------------ */
function openConversation(id) {
  if (state.streaming) stopStreaming();
  state.currentId = id;
  renderSidebar();
  renderChat();
  closeSidebarOnMobile();
}

function newChat() {
  if (state.streaming) stopStreaming();
  state.currentId = null;
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

function ensureConversation() {
  if (state.currentId && getConversation(state.currentId)) return getConversation(state.currentId);
  const c = createConversation({ title: '' });
  state.currentId = c.id;
  return c;
}

function renderChat() {
  const conv = currentConversation();
  els.viewInner.replaceChildren();
  const list = conv ? visibleMessages(conv) : [];
  if (!conv || !list.length) {
    els.viewInner.append(welcomeView());
    return;
  }
  const versions = messageVersions(conv);
  for (const m of list) {
    const node = messageView(m, versions);
    if (node) els.viewInner.append(node);
  }
  requestAnimationFrame(() => scrollToBottom(true));
  hydrateMermaid(els.viewInner).then(() => requestAnimationFrame(() => scrollToBottom(true)));
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

    const acts = h('div', { class: 'msg-actions', style: { marginLeft: '8px', alignSelf: 'flex-end', marginBottom: '2px' } });
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

  if (m.reasoning) body.append(thinkingView(m));
  if (m.toolCalls?.length) body.append(functionToolCards(m));
  if (m.serverToolCalls?.length) body.append(toolCardsView(m.serverToolCalls));

  if (m.error) {
    body.append(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: m.error })]));
  }
  if (m.refusal) {
    body.append(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: m.refusal })]));
  }

  const content = h('div', { class: 'md' });
  content.innerHTML = renderMarkdown(m.content || '', { annotations: m.annotations || [] });
  if (m.streaming) content.classList.add('cursor');
  if (m.content || !m.error) body.append(content);

  if (m.finishReason === 'length') {
    body.append(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: t('finishLength') })]));
  }
  if (m.finishReason === 'content_filter' && !m.refusal) {
    body.append(h('div', { class: 'notice' }, [iconEl('i-warning'), h('div', { text: t('refusal') })]));
  }

  const acts = h('div', { class: 'msg-actions' + (m.streaming ? '' : '') });
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
  body.append(sw ? h('div', { class: 'msg-bar' }, [sw, acts]) : acts);

  if (m.usage) body.append(usageLine(m));
  wrap.append(body);
  return wrap;
}

function thinkingView(m) {
  const seconds = m.reasoningSeconds ? Math.max(1, Math.round(m.reasoningSeconds)) : null;
  const collapsed = !m.streaming;
  const box = h('div', { class: 'think' + (collapsed ? ' collapsed' : '') + (m.streaming && !m.content ? ' streaming' : '') });
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

/** 模型请求的本地工具调用：参数 + 结果 */
function functionToolCards(m) {
  const conv = currentConversation();
  const wrap = h('div', { class: 'tool-cards' });
  for (const tc of m.toolCalls) {
    const name = tc.function?.name || 'tool';
    const rec = (m.toolResults || []).find((r) => r.id === tc.id)
      || conv?.messages.find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
    const ok = rec ? (rec.ok ?? rec.toolOk ?? true) : null;
    const ms = rec ? (rec.ms ?? rec.toolMs) : null;
    const card = h('div', { class: 'tool-card' });
    // 联网工具显示具体在搜什么/读哪一篇，比只写工具名有用
    const meta = { web_search: ['联网搜索', 'i-globe'], fetch_url: ['读取网页', 'i-file'] }[name];
    let sub = '';
    try {
      const a = JSON.parse(tc.function?.arguments || '{}');
      sub = String(a.query || a.url || '');
    } catch {}
    card.append(h('div', { class: 'tool-card-head' }, [
      iconEl(meta ? meta[1] : 'i-wrench'),
      h('span', { text: meta ? meta[0] : '调用工具 · ' + name }),
      sub ? h('span', { class: 'kind tool-sub', title: sub, text: '· ' + sub }) : null,
      ok === null
        ? h('span', { class: 'kind', text: '· 执行中…' })
        : h('span', {
          class: 'kind',
          style: ok ? {} : { color: 'var(--state-error)' },
          text: '· ' + (ok ? '成功' : '失败') + (ms ? ` · ${ms}ms` : ''),
        }),
    ]));
    const bodyEl = h('div', { class: 'tool-card-body' });
    const argsText = prettyArgs(tc.function?.arguments);
    if (argsText && argsText !== '{}') bodyEl.append(h('pre', { class: 'tool-pre tool-args', text: argsText }));
    if (rec?.content) bodyEl.append(h('pre', { class: 'tool-pre tool-result', text: rec.content }));
    card.append(bodyEl);
    wrap.append(card);
  }
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

function attachGridView(atts) {
  const grid = h('div', { class: 'attach-grid' });
  for (const a of atts) {
    if (a.kind === 'image' && (a.dataUrl || a.previewUrl || a.attId)) {
      const src = a.previewUrl || a.dataUrl || attachmentUrl(a.attId);
      const img = h('img', { src, alt: a.name || '' });
      const thumb = h('div', { class: 'attach-thumb' }, [img]);
      thumb.addEventListener('click', () => openLightbox(img.src));
      grid.append(thumb);
    } else {
      grid.append(h('div', { class: 'attach-file' }, [
        iconEl('i-file'),
        h('span', { class: 'name', text: a.name || '文件' }),
        h('span', { class: 'size', text: formatBytes(a.size || 0) }),
      ]));
    }
  }
  return grid;
}

function usageLine(m) {
  const u = m.usage || {};
  const cost = estimateCost(m);
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
        ? '按高峰时段价格估算（周一至周五 9:00-12:00 / 14:00-18:00 北京时间；法定节假日除外）'
        : '按空闲时段价格估算',
    }));
  }
  return h('div', { class: 'msg-meta' }, nodes);
}

/**
 * 峰谷计价：按「当前时段」取价（auto 时按北京时间判断；也可在设置里强制空闲/高峰）
 * 返回 { text, peak } 或 null
 */
function pickPrice(modelId) {
  const p = settings.prices || {};
  const key = String(modelId || settings.model).includes('pro') ? 'pro' : 'flash';
  const bucket = p[key] || {};
  const mode = settings.peakMode || 'auto';
  const peak = mode === 'peak' || (mode === 'auto' && isPeakNow());
  const at = (k) => Number(bucket[k + (peak ? 'Peak' : 'Idle')]) || 0;
  return { peak, inMiss: at('miss'), inHit: at('hit'), out: at('out') };
}

function estimateCost(m) {
  const pr = pickPrice(m.model);
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
  };
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
  els.effortLabel.textContent = e.effort || 'high';
  els.modelName.textContent = modelInfo(e.model).name || e.model;
  els.mockBadge.classList.toggle('hidden', !settings.mock);
  els.streamBadge.classList.toggle('hidden', !state.streaming);
  els.keyHint.textContent = hasApiKey() ? '' : (settings.mock ? '演示' : t('noKeyBalance'));
}

async function sendMessage({ continueMode = false, prefix = '' } = {}) {
  if (state.streaming) { stopStreaming(); return; }
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
    try { extraTools = await getToolDefinitions(); }
    catch (e) { toast('本地工具加载失败：' + e.message); }
  }

  state.streaming = true;
  state.controller = new AbortController();
  updateComposerState();

  let cur = assistant;
  let curHistory = history;
  let first = true;
  let rounds = 0;

  try {
    while (rounds++ < 5) {
      // 工具按需加载：用最近的用户问题检索工具；把历史里已调用过的工具带上，避免多轮断链
      const lastUser = [...curHistory].reverse().find((m) => m.role === 'user');
      const toolQuery = [lastUser?.content || '', ...(lastUser?.attachments || []).map((a) => a.text || '')].join(' ');
      const usedTools = [];
      for (const m of curHistory) {
        for (const tc of m.toolCalls || []) if (tc?.function?.name) usedTools.push(tc.function.name);
      }
      const { payload } = buildPayload(curHistory, {
        settings: es,
        stream: settings.stream,
        wantTitle: first && firstTurn,
        continuePrefix: first && continueMode ? prefix : '',
        extraTools,
        toolQuery,
        usedTools,
      });
      if (first && continueMode) payload.__beta = true;
      window.__lastPayload = payload;
      window.__lastToolHits = { query: toolQuery.slice(0, 120), used: usedTools };

      const toolCalls = await streamRound({ assistant: cur, payload });
      if (!toolCalls.length) break;

      // ---- 执行模型请求的工具（服务端） ----
      cur.toolResults = cur.toolResults || [];
      // 先画一次「执行中…」卡片：联网搜索要跑 0.5~2s，用户能马上看到在搜什么
      renderChat();
      for (const tc of toolCalls) {
        const name = tc.function?.name || 'unknown';
        const args = tc.function?.arguments || '{}';
        const t0 = Date.now();
        let out;
        try { out = await callTool(name, args); }
        catch (e) { out = { ok: false, text: '工具调用失败：' + e.message }; }
        const content = out.text || JSON.stringify(out);
        const record = { id: tc.id, name, args, content, ok: out.ok !== false, ms: out.elapsedMs ?? (Date.now() - t0) };
        cur.toolResults.push(record);
        appendBranch(conv, chainTail(conv)?.id ?? null, [{
          id: uid('t'), role: 'tool', tool_call_id: tc.id, name,
          content, toolOk: record.ok, toolMs: record.ms, createdAt: Date.now(),
        }]);
        renderChat();
      }
      saveConversations();

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
  } catch (err) {
    if (err.name === 'AbortError') {
      cur.aborted = true;
      if (!cur.content && !cur.reasoning) cur.error = t('aborted');
    } else {
      cur.error = err.message || String(err);
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    if (cur) cur.streaming = false;
    if (es.jsonMode && cur?.content && !cur.error) {
      try { JSON.parse(cur.content); } catch { cur.error = t('jsonBad'); }
    }
    saveConversations();
    updateComposerState();
    renderChat();
    renderSidebar();
    scrollToBottom(true);
  }
}

/** 跑一轮流式；返回本轮模型请求的工具调用（function calling） */
async function streamRound({ assistant, payload }) {
  assistant.streaming = true;
  const el = $(`.msg[data-id="${assistant.id}"]`);
  const refs = { el, content: el?.querySelector('.md'), body: el?.querySelector('.body') };
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
            if (refs.el && !refs.el.querySelector('.think')) {
              const body = refs.el.querySelector('.body');
              body.insertBefore(thinkingView(assistant), body.firstChild);
              refs.content = refs.el.querySelector('.md');
            }
            const thinkEl = refs.el?.querySelector('.think');
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
  const body = refs.el.querySelector('.body');
  let node = body.querySelector('.tool-cards');
  if (!node) {
    node = h('div', { class: 'tool-cards' });
    const md = body.querySelector('.md');
    body.insertBefore(node, md);
  }
  node.replaceWith(toolCardsView(assistant.serverToolCalls));
  scrollToBottom();
}

function stopStreaming() {
  state.controller?.abort();
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
    const userMsg = { ...m, id: uid('u'), content: text, createdAt: Date.now() };
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

function scrollToBottom(force = false) {
  const view = els.chatView;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 160;
  if (force || nearBottom) view.scrollTop = view.scrollHeight;
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
  if (state.menuOff) {
    document.removeEventListener('mousedown', state.menuOff);
    state.menuOff = null;
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
  setTimeout(() => {
    // 换菜单时旧监听已由 closeMenu 清掉，这里保证同一时刻只有一个
    const off = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) closeMenu();
    };
    state.menuOff = off;
    document.addEventListener('mousedown', off);
  }, 0);
  return pop;
}

function modelMenu() {
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

function effortMenu() {
  const levels = [['low', t('effortLow')], ['high', t('effortHigh')], ['max', t('effortMax')]];
  const curEffort = eff().effort;
  const items = levels.map(([lv, label]) => {
    const b = h('button', { class: 'menu-item' + (curEffort === lv ? ' selected' : ''), type: 'button' }, [
      h('div', {}, [h('div', { text: label }), h('span', { class: 'desc', text: lv })]),
      curEffort === lv ? iconEl('i-check', 'check') : null,
    ]);
    b.addEventListener('click', () => { setEffective('effort', lv); closeMenu(); });
    return b;
  });
  showMenu(els.effort, [h('div', { class: 'popover-title', text: t('reasoningEffort') }), ...items], 'up');
}

/* ------------------------------ 数据 ------------------------------ */
async function updateBalance() {
  if (!hasApiKey() && !settings.mock) { toast(t('needKey')); return; }
  els.balanceHint.textContent = t('balanceLoading');
  try {
    const b = await getBalance();
    const info = (b.balance_infos || [])[0];
    els.balanceHint.textContent = info ? `${info.currency} ${info.total_balance}` : (b.is_available ? '可用' : '不可用');
  } catch (e) {
    els.balanceHint.textContent = t('balanceFail');
    toast(e.message);
  }
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

function exportAll() {
  download(`deepseek-chatbox-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ app: 'deepseek-chatbox', version: 1, exportedAt: Date.now(), conversations: allConversations() }, null, 2));
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
  $('#btnNewChatTop2').addEventListener('click', newChat);
  $('#btnNewChatTop').addEventListener('click', newChat);
  $('#btnSearchChats').addEventListener('click', () => {
    els.searchWrap.classList.toggle('hidden');
    if (!els.searchWrap.classList.contains('hidden')) els.chatSearchInput.focus();
  });
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
  $('#btnMenu').addEventListener('click', () => {
    els.app.classList.toggle('sidebar-collapsed');
    saveUI({ sidebarCollapsed: els.app.classList.contains('sidebar-collapsed') });
  });

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
  if (params.get('lang')) saveSettings({ lang: params.get('lang') });
  setLang(settings.lang);
  applyStatic();
  applyTheme();
  const narrow = window.innerWidth <= 900;
  els.app.classList.toggle('sidebar-collapsed', narrow ? true : Boolean(ui.sidebarCollapsed));
  wire();
  renderSidebar();
  renderChat();
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
