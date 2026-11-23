/* 通用工具 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, children = []) {
  const NS = 'http://www.w3.org/2000/svg';
  const svgTags = ['svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'use', 'defs', 'clipPath'];
  const node = svgTags.includes(tag) ? document.createElementNS(NS, tag) : document.createElement(tag);
  const isSvg = node.namespaceURI === NS;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') {
      if (isSvg) node.setAttribute('class', v);
      else node.className = v;
    }
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const uid = (p = 'm') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 标准 UUID v4（会话分享链接用）。手机 LAN 走 http 非安全上下文，randomUUID 可能不可用，故自带回退。 */
export function uuid() {
  let bytes;
  if (globalThis.crypto?.getRandomValues) {
    bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  } else {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}

/** 粗估 token 数（离线、无精确 tokenizer 时用）：
 *  中日韩字符按 1 token，其余按 3.2 字符 1 token —— 用于上下文用量与截断预算，误差 ±20% 量级。
 *  精确数字一律以服务端返回的 usage 为准（上下文用量面板会用最后一条 usage 做锚点校正）。
 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (!s) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfee0 && c <= 0xfefe) || (c >= 0xff00 && c <= 0xff60)) cjk++;
    else rest++;
  }
  return Math.ceil(cjk + rest / 3.2);
}
export function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastHost = null;
export function toast(msg, ms = 2200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: 'toast', text: msg });
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(file);
  });
}

/** 压缩图片，返回 { dataUrl, width, height, bytes } */
export async function compressImage(file, maxSide = 1568, quality = 0.85) {
  const dataUrl = await readAsDataURL(file);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1 && file.size < 400 * 1024) {
    return { dataUrl, width: img.width, height: img.height, bytes: file.size };
  }
  const w = Math.round(img.width * scale);
  const hgt = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, hgt);
  const out = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl: out, width: w, height: hgt, bytes: Math.round((out.length * 3) / 4) };
}

/** 简单的事件总线 */
export function bus() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    emit(evt, data) {
      map.get(evt)?.forEach((fn) => {
        try { fn(data); } catch (e) { console.error(e); }
      });
    },
  };
}
