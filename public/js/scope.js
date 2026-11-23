/* 分组 / 单个会话的独立设置弹窗 */
import { h, toast } from './util.js';
import {
  settings, allGroups, getGroup, getConversation, updateConversation, updateGroup,
  effectiveSettings, moveConversationToGroup, saveConversations,
} from './store.js';
import { cachedModels } from './api.js';
import { t } from './i18n.js';

let overlay = null;

const FIELDS = [
  { key: 'model', label: '模型', type: 'model' },
  { key: 'systemPrompt', label: '系统提示词', type: 'textarea', placeholder: '例如：你是一名严谨的逆向工程助手，回答尽量给出可验证的命令。' },
  { key: 'thinking', label: '深度思考', type: 'switch' },
  { key: 'effort', label: '思考强度', type: 'effort' },
  { key: 'search', label: '智能搜索', type: 'switch' },
  { key: 'readUrl', label: '阅读链接', type: 'switch' },
  { key: 'localTools', label: '本地工具', type: 'switch', hint: '余额、模型列表、当前时间、历史搜索、用量统计' },
  { key: 'safety', label: '内容安全审核', type: 'switch' },
  { key: 'jsonMode', label: 'JSON 输出', type: 'switch' },
  { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
  { key: 'maxTokens', label: '最大输出 tokens', type: 'number', min: 1, max: 393216, step: 1, placeholder: '留空用默认' },
];

export function openScopeSettings({ kind = 'conv', id, onChange } = {}) {
  if (overlay) return;
  const isGroup = kind === 'group';
  const target = isGroup ? getGroup(id) : getConversation(id);
  if (!target) { toast('对象不存在'); return; }

  const modal = h('div', { class: 'modal', style: { maxWidth: '600px' } });
  const head = h('div', { class: 'modal-head' }, [
    h('span', { text: isGroup ? '分组设置' : '会话设置' }),
    h('button', { class: 'icon-btn sm', type: 'button', onclick: () => close() }, [icon('i-x')]),
  ]);
  const body = h('div', { class: 'modal-body' });
  const foot = h('div', { class: 'modal-foot' }, [
    h('button', { class: 'btn primary', type: 'button', text: t('close'), onclick: () => close() }),
  ]);
  modal.append(head, body, foot);
  overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [modal]);
  document.body.append(overlay);

  function close() {
    overlay?.remove();
    overlay = null;
  }

  const custom = () => Boolean(target.settings && target.settings.custom);

  function setScope(patch) {
    if (!custom()) return;
    target.settings = { ...target.settings, ...patch, custom: true };
    if (isGroup) updateGroup(target.id, { settings: target.settings });
    else updateConversation(target.id, { settings: target.settings });
    onChange?.({ scope: true });
  }

  function enableCustom(on) {
    if (on) {
      const eff = isGroup
        ? { ...settings, ...(target.settings || {}) }
        : effectiveSettings(target);
      target.settings = { ...stripMeta(eff), custom: true };
    } else {
      target.settings = {};
    }
    if (isGroup) updateGroup(target.id, { settings: target.settings });
    else updateConversation(target.id, { settings: target.settings });
    onChange?.({ scope: true });
    renderBody();
  }

  function stripMeta(o) {
    const c = { ...o };
    delete c.hasKey;
    delete c.keyPreview;
    delete c.apiKey;
    delete c.custom;
    delete c.prices;
    delete c.reminder;
    delete c.baseUrl;
    return c;
  }

  function row(label, control, hint) {
    return h('div', { class: 'field', style: { marginBottom: '12px' } }, [
      h('label', { style: { marginBottom: '4px' }, text: label }),
      control,
      hint ? h('div', { class: 'help', text: hint }) : null,
    ]);
  }

  function renderBody() {
    body.replaceChildren();
    const enabled = custom();
    const eff = isGroup ? { ...settings, ...(target.settings || {}) } : effectiveSettings(target);

    // 顶部：独立设置开关
    const sw = h('button', { class: 'switch' + (enabled ? ' on' : ''), type: 'button' });
    sw.addEventListener('click', () => enableCustom(!enabled));
    body.append(h('div', { class: 'switch-row', style: { marginBottom: '14px' } }, [
      h('div', { class: 'txt' }, [
        h('b', { text: '使用独立设置' }),
        h('span', { text: enabled ? '本' + (isGroup ? '分组' : '会话') + '已覆盖全局设置' : '当前继承上一级设置，打开后可单独覆盖' }),
      ]),
      sw,
    ]));

    if (isGroup) {
      const name = h('input', { type: 'text' });
      name.value = target.name || '';
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) return;
        updateGroup(target.id, { name: v });
        onChange?.({ scope: true });
      });
      body.append(row('分组名称', name));
    } else {
      const sel = h('select', {}, [
        h('option', { value: '', text: '（不分组）' }),
        ...allGroups().map((g) => h('option', { value: g.id, text: g.name })),
      ]);
      sel.value = target.groupId || '';
      sel.addEventListener('change', () => {
        moveConversationToGroup(target.id, sel.value || null);
        onChange?.({ scope: true });
        renderBody();
      });
      body.append(row('所属分组', sel, '分组设置会作用到组内所有对话；本会话的独立设置优先级更高'));
    }

    for (const f of FIELDS) {
      let control;
      const cur = enabled ? target.settings[f.key] : eff[f.key];
      if (f.type === 'switch') {
        control = h('button', { class: 'switch' + (cur ? ' on' : ''), type: 'button', disabled: !enabled ? '' : null });
        control.style.opacity = enabled ? '1' : '.5';
        control.addEventListener('click', () => {
          if (!enabled) return;
          const next = !control.classList.contains('on');
          control.classList.toggle('on', next);
          setScope({ [f.key]: next });
        });
      } else if (f.type === 'model') {
        control = h('select', {}, cachedModels().map((m) => h('option', { value: m.id, text: m.name || m.id })));
        control.value = cur ?? settings.model;
        control.disabled = !enabled;
        control.addEventListener('change', () => setScope({ model: control.value }));
      } else if (f.type === 'effort') {
        control = h('div', { class: 'seg' });
        for (const lv of ['low', 'high', 'max']) {
          const b = h('button', { type: 'button', class: cur === lv ? 'on' : '', text: lv });
          b.disabled = !enabled;
          b.addEventListener('click', () => {
            if (!enabled) return;
            setScope({ effort: lv });
            renderBody();
          });
          control.append(b);
        }
      } else if (f.type === 'textarea') {
        control = h('textarea', { rows: '4', placeholder: f.placeholder || '' });
        control.value = cur ?? '';
        control.disabled = !enabled;
        control.addEventListener('change', () => setScope({ systemPrompt: control.value }));
      } else {
        control = h('input', { type: 'number', min: f.min, max: f.max, step: f.step, placeholder: f.placeholder || '' });
        control.value = cur ?? '';
        control.disabled = !enabled;
        control.addEventListener('change', () => {
          const raw = control.value.trim();
          setScope({ [f.key]: raw === '' ? null : Number(raw) });
        });
      }
      body.append(row(f.label, control, f.hint));
    }

    if (enabled) {
      const reset = h('button', { class: 'btn sm', type: 'button', text: '恢复为继承' });
      reset.addEventListener('click', () => enableCustom(false));
      body.append(h('div', { style: { marginTop: '8px' } }, [reset]));
    }
  }

  renderBody();
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}
