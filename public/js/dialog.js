/* 应用内对话框：替代原生 prompt / confirm / alert
 * 复用 .overlay + .modal 的既有视觉，Esc 取消、Enter 确认、点遮罩取消。
 */
import { h } from './util.js';

function icon(id, cls = 'icon') {
  return h('svg', { class: cls, 'aria-hidden': 'true' }, [h('use', { href: '#' + id })]);
}

let active = null; // 当前对话框的 close 函数

/**
 * @returns {Promise<string|null>} 取消返回 null
 */
export function appPrompt({
  title = '输入',
  message = '',
  value = '',
  placeholder = '',
  okText = '确定',
  cancelText = '取消',
  maxLength = 200,
  selectAll = true,
} = {}) {
  const input = h('input', { type: 'text', placeholder, maxlength: String(maxLength), spellcheck: 'false' });
  input.value = value;
  const field = h('div', { class: 'field', style: { marginBottom: '4px' } }, [input]);
  return openDialog({
    title,
    message,
    body: field,
    okText,
    cancelText,
    focusEl: input,
    selectAll,
    getValue: () => input.value,
  });
}

/** @returns {Promise<boolean>} */
export function appConfirm({
  title = '确认',
  message = '',
  okText = '确定',
  cancelText = '取消',
  danger = false,
} = {}) {
  return openDialog({ title, message, okText, cancelText, danger, getValue: () => true })
    .then((v) => v !== null);
}

/** @returns {Promise<void>} */
export function appAlert({ title = '提示', message = '', okText = '知道了' } = {}) {
  return openDialog({ title, message, okText, cancelText: null, alertOnly: true, getValue: () => true })
    .then(() => undefined);
}

function openDialog({
  title, message, body, okText, cancelText, danger = false,
  focusEl = null, selectAll = false, getValue, alertOnly = false,
}) {
  if (active) active(null); // 同时只留一个

  const overlay = h('div', { class: 'overlay dialog-overlay' });
  const modal = h('div', { class: 'modal dialog', role: 'dialog', 'aria-modal': 'true' });

  const head = h('div', { class: 'modal-head' }, [h('span', { text: title })]);
  const bodyEl = h('div', { class: 'modal-body' });
  if (message) bodyEl.append(h('div', { class: 'dlg-text', text: message }));
  if (body) bodyEl.append(body);

  const foot = h('div', { class: 'modal-foot' });
  const okBtn = h('button', {
    class: 'btn ' + (danger ? 'danger-solid' : 'primary'),
    type: 'button',
    text: okText,
  });
  if (cancelText) {
    foot.append(h('button', { class: 'btn', type: 'button', text: cancelText, onclick: () => close(null) }));
  }
  foot.append(okBtn);

  modal.append(head, bodyEl, foot);
  overlay.append(modal);
  document.body.append(overlay);

  function close(result) {
    if (!active) return;
    active = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    resolve(result);
  }

  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  active = close;

  function submit() {
    close(getValue ? getValue() : true);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Enter' && !e.isComposing) {
      // 输入框内 Enter 直接确认；其它地方 Enter 也确认
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  }

  okBtn.addEventListener('click', submit);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close(null);
  });
  document.addEventListener('keydown', onKey, true);

  // 焦点：有输入框就聚焦并全选，否则聚焦主按钮
  requestAnimationFrame(() => {
    if (focusEl) {
      focusEl.focus();
      if (selectAll) focusEl.select();
    } else {
      okBtn.focus();
    }
  });

  return promise;
}
