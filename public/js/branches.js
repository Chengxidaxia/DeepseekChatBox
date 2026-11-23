/* 消息分支：移植自官方 chat-demo 的 services/chat/branches.ts
 *
 * 数据结构（保持扁平，便于持久化与导入导出）：
 *   conv.rootMessageId        链的起点
 *   message.parentId          父消息 id（根为 null）
 *   message.selectedChildId   当前选中的子消息 id（链尾为空）
 *
 * conv.messages 始终保存**所有分支**；页面展示与请求上下文只走 selectedChildId 这条链，
 * 所以「重新生成 / 编辑重发」不再销毁旧版本，而是挂一个新分支。
 */

/** 把线性消息列表补成单分支（兼容没有分支字段的旧数据） */
export function normalizeConv(conv) {
  if (!conv) return conv;
  const msgs = conv.messages || [];
  if (conv.rootMessageId !== undefined) return conv;

  conv.rootMessageId = msgs[0]?.id ?? null;
  msgs.forEach((m, i) => {
    if (m.parentId === undefined) m.parentId = msgs[i - 1]?.id ?? null;
    if (m.selectedChildId === undefined) m.selectedChildId = msgs[i + 1]?.id;
  });
  return conv;
}

/** 当前选中的那条链（展示与请求都用它） */
export function visibleMessages(conv) {
  if (!conv) return [];
  normalizeConv(conv);
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const path = [];
  const seen = new Set();
  let id = conv.rootMessageId;
  while (id && !seen.has(id)) {
    seen.add(id);            // 防御：数据损坏时不至于死循环
    const m = byId.get(id);
    if (!m) break;
    path.push(m);
    id = m.selectedChildId ?? null;
  }
  return path;
}

/** 链尾（新消息挂在这里） */
export function chainTail(conv) {
  const path = visibleMessages(conv);
  return path.length ? path[path.length - 1] : null;
}

/** 每个节点在同父级下的兄弟列表：id → { ids, index } */
export function messageVersions(conv) {
  normalizeConv(conv);
  const groups = new Map();
  for (const m of conv.messages || []) {
    const key = m.parentId ?? '__root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m.id);
  }
  const out = new Map();
  for (const ids of groups.values()) {
    ids.forEach((id, i) => out.set(id, { ids, index: i }));
  }
  return out;
}

/** 追加新分支：把父节点的 selectedChildId 指向新消息，旧分支原样保留 */
export function appendBranch(conv, parentId, messages) {
  normalizeConv(conv);
  const first = messages[0];
  if (!first) return;

  if (parentId === null || parentId === undefined) {
    conv.rootMessageId = first.id;
  } else {
    const parent = conv.messages.find((m) => m.id === parentId);
    if (parent) parent.selectedChildId = first.id;
  }

  messages.forEach((m, i) => {
    m.parentId = messages[i - 1]?.id ?? parentId ?? null;
    m.selectedChildId = messages[i + 1]?.id;
    conv.messages.push(m);
  });
}

/** 切换到某个兄弟版本（只改 selectedChildId，不动消息本身） */
export function selectVersion(conv, messageId) {
  normalizeConv(conv);
  const m = conv.messages.find((x) => x.id === messageId);
  if (!m) return false;

  if (m.parentId === null || m.parentId === undefined) {
    conv.rootMessageId = messageId;
    return true;
  }
  const parent = conv.messages.find((x) => x.id === m.parentId);
  if (!parent) return false;
  parent.selectedChildId = messageId;
  return true;
}

/** 从某个节点开始截断链（续写用）：不删数据，只断链 */
export function cutAfter(conv, messageId) {
  normalizeConv(conv);
  const m = conv.messages.find((x) => x.id === messageId);
  if (!m) return false;
  m.selectedChildId = undefined;
  return true;
}
