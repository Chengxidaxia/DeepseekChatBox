/* Markdown 渲染：marked + highlight.js + KaTeX + Mermaid + 引用角标 */
import { escapeHtml } from './util.js';
import { t } from './i18n.js';

const hasMarked = typeof window.marked !== 'undefined';
const hasHljs = typeof window.hljs !== 'undefined';
const hasKatex = typeof window.katex !== 'undefined';

let mermaidReady = false;
let mermaidSeq = 0;

function initMermaid() {
  if (mermaidReady) return true;
  if (typeof window.mermaid === 'undefined') return false;
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: document.body.dataset.theme === 'dark' ? 'dark' : 'default',
      fontFamily: getComputedStyle(document.body).fontFamily,
      flowchart: { htmlLabels: true, curve: 'basis' },
    });
    mermaidReady = true;
    return true;
  } catch {
    return false;
  }
}

export function resetMermaidTheme() {
  mermaidReady = false;
  initMermaid();
}

if (hasMarked) {
  window.marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

  const renderer = {
    code({ text, lang, escaped }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      if (language === 'mermaid') {
        const id = 'mmd_' + (++mermaidSeq);
        return `<div class="mermaid-wrap" data-mermaid="${id}" data-code="${encodeURIComponent(text)}"></div>`;
      }
      let html = '';
      let cls = 'hljs';
      if (hasHljs) {
        try {
          if (language && window.hljs.getLanguage(language)) {
            html = window.hljs.highlight(text, { language, ignoreIllegals: true }).value;
            cls += ' language-' + language;
          } else if (language) {
            html = window.hljs.highlightAuto(text).value;
            cls += ' language-' + language;
          } else {
            html = escapeHtml(text);
          }
        } catch {
          html = escapeHtml(text);
        }
      } else {
        html = escapeHtml(text);
      }
      const label = language || 'text';
      return `<div class="code-block"><div class="code-head"><span class="lang">${escapeHtml(label)}</span>` +
        `<button class="act-btn copy" data-copy-code type="button">${t('copy')}</button></div>` +
        `<pre><code class="${cls}">${html}</code></pre></div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${t}>${text}</a>`;
    },
    table(token) {
      const header = token.header.map((c, i) => `<th${token.align[i] ? ` style="text-align:${token.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
      const rows = token.rows.map((row) => '<tr>' + row.map((c, i) => `<td${token.align[i] ? ` style="text-align:${token.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('') + '</tr>').join('');
      return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
    },
  };
  window.marked.use({ renderer });
}

/* ------------------------- 公式处理 ------------------------- */
function renderMath(tex, display) {
  if (!hasKatex) return escapeHtml(display ? '$$' + tex + '$$' : '$' + tex + '$');
  try {
    return window.katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: true,
    });
  } catch {
    return escapeHtml(display ? '$$' + tex + '$$' : '$' + tex + '$');
  }
}

const SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

function mathToSlots(seg, math) {
  let out = seg.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
    const i = math.length;
    math.push(renderMath(tex.trim(), true));
    return `\n\n\u0001MATH${i}\u0001\n\n`;
  });
  out = out.replace(/(^|[^$\\])\$([^\n$]+?)\$/g, (m, pre, tex) => {
    if (/^\s|\s$/.test(tex) && tex.length > 40) return m;
    const i = math.length;
    math.push(renderMath(tex.trim(), false));
    return `${pre}\u0001MATH${i}\u0001`;
  });
  return out;
}

/** 计算围栏代码块在字符串中的区间（用于跳过引用注入） */
function fenceRanges(src) {
  const ranges = [];
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let m;
  while ((m = re.exec(src))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** 在正文中按 Unicode 码点位置插入引用角标（跳过代码块） */
function injectCitations(md, annotations) {
  if (!annotations || !annotations.length) return md;
  const cps = Array.from(md);
  // 把 UTF-16 索引区间换算成码点索引区间
  const ranges = fenceRanges(md).map(([a, b]) => {
    const toCp = (idx) => Array.from(md.slice(0, idx)).length;
    return [toCp(a), toCp(b)];
  });
  const marks = [];
  annotations.forEach((a, i) => {
    const c = a.url_citation || a;
    if (!c || typeof c.end_index !== 'number') return;
    const end = Math.min(c.end_index, cps.length);
    if (ranges.some(([a2, b2]) => end >= a2 && end <= b2)) return;
    marks.push({ pos: end, url: c.url, title: c.title || c.url, n: i + 1 });
  });
  marks.sort((x, y) => y.pos - x.pos);
  for (const mk of marks) {
    const html = `<sup class="cite" data-url="${escapeHtml(mk.url)}" title="${escapeHtml(mk.title)}">${mk.n}</sup>`;
    cps.splice(mk.pos, 0, html);
  }
  return cps.join('');
}

export function renderMarkdown(md, { annotations = [] } = {}) {
  let src = String(md ?? '');
  if (!hasMarked) return `<p>${escapeHtml(src).replace(/\n/g, '<br>')}</p>`;

  const math = [];
  if (annotations && annotations.length) src = injectCitations(src, annotations);

  // 只对「非代码」片段处理公式，保证代码块与行内代码原样交给 marked
  const parts = src.split(SPLIT_RE);
  src = parts.map((p) => (/^(```|~~~|`)/.test(p) ? p : mathToSlots(p, math))).join('');

  let html = window.marked.parse(src);
  html = html.replace(/\u0001MATH(\d+)\u0001/g, (_, i) => math[Number(i)] ?? '');
  return html;
}

/** 渲染 Mermaid 图（插入 DOM 后调用） */
export async function hydrateMermaid(root) {
  const nodes = root.querySelectorAll('[data-mermaid]');
  if (!nodes.length) return;
  if (!initMermaid()) {
    nodes.forEach((n) => {
      n.innerHTML = `<div class="mermaid-err">Mermaid 资源未加载，无法渲染该图表</div>`;
    });
    return;
  }
  for (const node of nodes) {
    if (node.dataset.rendered) continue;
    const code = decodeURIComponent(node.dataset.code || '');
    try {
      const { svg } = await window.mermaid.render(node.dataset.mermaid + '_svg', code);
      node.innerHTML = svg;
      node.dataset.rendered = '1';
    } catch (e) {
      node.innerHTML = `<div class="mermaid-err">图表渲染失败：${escapeHtml(e.message || String(e))}</div>`;
      node.dataset.rendered = '1';
    }
  }
}

/** 提取纯文本（用于复制、朗读、标题兜底） */
export function toPlainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
