/* DeepSeek Chatbox — 内置简易工具（服务端执行，密钥不出本机）
 * 供模型 function calling 使用；客户端只拿定义与结果。
 *
 * 联网部分（web_search / fetch_url）由本机直接发起请求，不依赖 DeepSeek 官方
 * 的 deepseek_web_search 服务端工具 —— 官方工具与本机 function 在接口上互斥，
 * 自己实现后就能和余额、时间等本地工具同时给模型用。
 */
'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 4 * 1024 * 1024;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '•', times: '×', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥',
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (isFinite(n) && n > 0 && n <= 0x10ffff) {
        try { return String.fromCodePoint(n); } catch { return m; }
      }
      return m;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 按 content-type / meta 标签判断编码；gb2312 用 gbk 解码（超集） */
function sniffCharset(buf, contentType) {
  let m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /charset=["']?([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decodeBuf(buf, charset) {
  const alias = { gb2312: 'gbk', gb18030: 'gb18030', 'x-gbk': 'gbk', utf8: 'utf-8', big5: 'big5' };
  const cs = alias[String(charset || '').toLowerCase()] || charset || 'utf-8';
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/** 按标签配对删掉 class/id 命中导航、分享、评论等噪声的容器整块。
 *  做法：单次线性扫标签，用栈配对，最后按区间拼接 —— 比正则非贪婪稳，
 *  也不会因为某个容器标签没闭合就把后半页一起吞掉（未闭合的区间直接放弃）。
 */
function dropNoiseBlocks(html) {
  const NOISE = /(?:nav|menu|crumb|sidebar|side-bar|footer|copyright|qrcode|share|related|comment|advert|banner|toolbar|top-?bar|topbar|recommend|hot-?city|breadcrumb|site-?map)/i;
  const TAG = /<\/?(div|section|ul|ol|nav|aside|footer)\b[^>]*>/gi;
  const LIMIT = html.length * 0.4;
  const ranges = [];
  let stack = null;
  let start = 0;
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const whole = m[0];
    const closing = whole[1] === '/';
    const name = m[1].toLowerCase();
    if (stack) {
      if (closing) {
        const i = stack.lastIndexOf(name);
        if (i >= 0) stack.length = i;
        if (!stack.length) {
          if (TAG.lastIndex - start <= LIMIT) ranges.push([start, TAG.lastIndex]);
          stack = null;
        }
      } else if (!/\/>$/.test(whole)) {
        stack.push(name);
      }
      continue;
    }
    if (closing) continue;
    const cm = /(?:class|id)\s*=\s*["']([^"']*)["']/i.exec(whole);
    if (!cm || !NOISE.test(cm[1])) continue;
    start = m.index;
    if (/\/>$/.test(whole)) {
      ranges.push([start, TAG.lastIndex]);
    } else {
      stack = [name];
    }
  }
  if (!ranges.length) return html;
  let out = '';
  let cur = 0;
  for (const [s, e] of ranges) {
    if (s < cur) continue;
    out += html.slice(cur, s);
    cur = e;
  }
  out += html.slice(cur);
  return out;
}

/** 粗略的正文定位：把所有块级容器的「纯文本量 − 链接文本量×2」当得分，取得分最高的那块。
 *  门户/天气站这类导航巨多的页面，靠 class 关键词删不干净，用文本密度选更靠谱。
 */
function pickMainHtml(html) {
  const TAG = /<\/?(div|section|article|main|td|ul|nav|aside|footer|header|a)\b[^>]*>/gi;
  const frames = [];
  const cands = [];
  let last = 0;
  let linkDepth = 0;
  let m;
  while ((m = TAG.exec(html))) {
    const text = html.slice(last, m.index);
    if (frames.length && text) {
      const n = decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().length;
      if (n) {
        const top = frames[frames.length - 1];
        top.text += n;
        if (linkDepth > 0) top.link += n;
      }
    }
    last = TAG.lastIndex;
    const closing = m[0][1] === '/';
    const name = m[1].toLowerCase();
    if (name === 'a') {
      if (closing) linkDepth = Math.max(0, linkDepth - 1);
      else if (!/\/>$/.test(m[0])) linkDepth += 1;
      continue;
    }
    if (closing) {
      let i = frames.length - 1;
      while (i >= 0 && frames[i].name !== name) i--;
      if (i < 0) continue;
      while (frames.length - 1 > i) {
        const f = frames.pop();
        f.end = last;
        if (f.text >= 200) cands.push(f);
        if (frames.length) { frames[frames.length - 1].text += f.text; frames[frames.length - 1].link += f.link; }
      }
      const f = frames.pop();
      f.end = last;
      if (f.text >= 200) cands.push(f);
      if (frames.length) { frames[frames.length - 1].text += f.text; frames[frames.length - 1].link += f.link; }
    } else if (!/\/>$/.test(m[0])) {
      frames.push({ name, start: m.index, end: last, text: 0, link: 0 });
    }
  }
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    const score = c.text - c.link * 2;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore < 200) return html;
  // 最佳块文本太少（门户首页这种全是链接的页面），退回全文更好用
  const total = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().length;
  if (best.text < 400 || best.text < total * 0.3) return html;
  return html.slice(best.start, best.end);
}

/** HTML → 纯文本：剥标签、保段落、压空白 */
function htmlToText(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  // 正文优先：<article> / <main> 存在时只取它；否则按文本密度挑主容器
  let scope = html;
  const art = html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<main\b[\s\S]*?<\/main>/i);
  if (art && art[0].length > 800) {
    scope = art[0];
  } else {
    const picked = pickMainHtml(html);
    if (picked.length > 500 && picked.length < html.length * 0.95) scope = picked;
  }
  // 超大页面跳过去噪，避免扫描过慢
  if (scope.length < 2 * 1024 * 1024) scope = dropNoiseBlocks(scope);

  let s = scope
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|form|select|textarea|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|aside|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt|figure|figcaption|header)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s).replace(/\r/g, '');
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim()).join('\n');
  // 去掉与页面标题重复的首行（正文里常重复一遍 title）
  if (title) s = s.split('\n').filter((line) => line.trim() !== title).join('\n');
  // 导航行：用 | 或 · 串起一长串短词的，基本是菜单
  s = s.split('\n').filter((line) => {
    const parts = line.split(/[|｜·]/).map((x) => x.trim()).filter(Boolean);
    return !(parts.length >= 5 && parts.every((p) => p.length <= 10));
  }).join('\n');
  // 连续 8 行以上、且多数是 <li> 列表项的极短行（导航栏、页脚链接）整块丢掉。
  // 只认带「- 」前缀的列表项，避免把天气/行情这类本来就是短行的正文误删。
  {
    const isShort = (line) => {
      const t = line.replace(/^-\s*/, '').trim();
      return t === '' || (t.length <= 12 && !/[。，、；：！？,.!?;:]/.test(t) && !/\d{2,}/.test(t));
    };
    const dashy = (run) => run.filter((l) => /^-\s/.test(l.trim())).length / run.length >= 0.6;
    const keep = (run) => { if (run.length < 8 || !dashy(run)) kept.push(...run); };
    const lines = s.split('\n');
    const kept = [];
    let run = [];
    for (const line of lines) {
      if (!line.trim()) { keep(run); run = []; kept.push(''); continue; }
      if (isShort(line)) { run.push(line); continue; }
      keep(run);
      run = [];
      kept.push(line);
    }
    keep(run);
    s = kept.join('\n');
  }
  s = s.replace(/^(?:-\s*)?$/gm, '').replace(/\n{3,}/g, '\n\n');
  return { title, text: s.trim() };
}

/** 带超时与体积上限的抓取，返回 { buf, contentType, truncated, finalUrl } */
async function fetchBuffer(url, { timeout = 20000, maxBytes = MAX_HTML_BYTES, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5',
        ...headers,
      },
    });
    const contentType = r.headers.get('content-type') || '';
    let buf = Buffer.alloc(0);
    let truncated = false;
    if (r.body) {
      const reader = r.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          const keep = value.length - (total - maxBytes);
          if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
          truncated = true;
          try { await reader.cancel(); } catch {}
          break;
        }
        chunks.push(Buffer.from(value));
      }
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(await r.arrayBuffer());
    }
    return { ok: r.ok, status: r.status, buf, contentType, truncated, finalUrl: r.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDoc(url, opts) {
  const res = await fetchBuffer(url, opts);
  const charset = sniffCharset(res.buf, res.contentType);
  return { ...res, charset, text: decodeBuf(res.buf, charset) };
}

/** 放行公网 http(s) 与 127.0.0.1，其余本机/保留地址仍拦住。
 *  127.0.0.1 是用户明确要放开的那一个；127 段的其他地址、localhost、::1、
 *  0.0.0.0、169.254（云元数据）与 fe80 都继续禁止。
 */
function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('URL 格式不正确'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https 链接');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = (/^127\./.test(host) && host !== '127.0.0.1')
    || host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || /^169\.254\./.test(host)
    || /^fe80:/i.test(host);
  if (blocked) throw new Error('出于安全考虑，只允许抓取公网地址或 127.0.0.1');
  return u.toString();
}

function xmlValue(xml, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(xml);
  if (!m) return '';
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return stripTags(raw);
}

/** RSS 的 pubDate 转成 YYYY-MM-DD，省 token 也好判断新旧。
 *  Bing 中文站返回的是「周日, 23 11月 2026 00:53:00 GMT」，new Date() 解不了，得手拆。
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function shortDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  // 中文格式：周日, 22 11月 2026 21:32:00 GMT
  const zh = /(\d{1,2})\s+(\d{1,2})\s*月\s*(\d{4})/.exec(str);
  if (zh) return `${zh[3]}-${zh[2].padStart(2, '0')}-${zh[1].padStart(2, '0')}`;
  const m = /,\s*(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/.exec(str);
  if (m) {
    const day = Number(m[1]);
    const mon = /^\d+$/.test(m[2]) ? Number(m[2]) : (MONTHS[m[2].slice(0, 3).toLowerCase()] || 0);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${m[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return str.slice(0, 20);
}

/* ------------------------------ 搜索引擎 ------------------------------ */

async function searchBingRss(query, count) {
  const url = 'https://cn.bing.com/search?format=rss&setlang=zh-CN&cc=CN&count=' + count + '&q=' + encodeURIComponent(query);
  const doc = await fetchDoc(url, { timeout: 12000, maxBytes: 1024 * 1024 });
  const items = [...doc.text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((it) => ({
    title: xmlValue(it, 'title'),
    url: xmlValue(it, 'link'),
    snippet: xmlValue(it, 'description').slice(0, 320),
    date: shortDate(xmlValue(it, 'pubDate')),
    engine: 'bing',
  })).filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

async function searchBingHtml(query, count) {
  const url = 'https://cn.bing.com/search?count=' + count + '&q=' + encodeURIComponent(query);
  const doc = await fetchDoc(url, { timeout: 12000, maxBytes: 2 * 1024 * 1024 });
  const out = [];
  for (const m of doc.text.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const cap = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({
      title: stripTags(a[2]),
      url: decodeEntities(a[1]),
      snippet: cap ? stripTags(cap[1]).slice(0, 320) : '',
      engine: 'bing',
    });
  }
  return out.filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

async function search360(query, count) {
  const url = 'https://www.so.com/s?q=' + encodeURIComponent(query) + '&pn=1';
  const doc = await fetchDoc(url, { timeout: 12000, maxBytes: 2 * 1024 * 1024 });
  const out = [];
  for (const m of doc.text.matchAll(/<li class="res-list[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const a = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const desc = /<p class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) || /<div class="res-comm-con[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({
      title: stripTags(a[2]),
      url: decodeEntities(a[1]),
      snippet: desc ? stripTags(desc[1]).slice(0, 320) : '',
      engine: '360',
    });
  }
  return out.filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

/** 安全算术表达式求值：只允许数字、运算符、括号与白名单函数，绝不走 eval/Function。
 *  用递归下降解析，任何不认识的字符/标识符直接报错。
 */
function evalArithmetic(raw) {
  const src = String(raw || '').trim();
  if (!src) throw new Error('表达式为空');
  if (src.length > 500) throw new Error('表达式过长（最多 500 字符）');
  const FN = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    min: Math.min, max: Math.max, pow: Math.pow, log: Math.log, log10: Math.log10,
    log2: Math.log2, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, sign: Math.sign,
  };
  const CONST = { PI: Math.PI, E: Math.E, pi: Math.PI, e: Math.E };
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|\.\d+|[()+\-*/%^,]|\*\*)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error('无法解析的字符：「' + src.slice(i, i + 12) + '」');
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  re.lastIndex = 0;
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = take(); const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  function term() { let v = power(); while (peek() === '*' || peek() === '/' || peek() === '%' || peek() === '**') { const op = take(); const r = power(); v = op === '*' ? v * r : op === '**' ? Math.pow(v, r) : op === '/' ? v / r : v % r; } return v; }
  function power() { const base = unary(); if (peek() === '^') { take(); return Math.pow(base, power()); } return base; }
  function unary() { if (peek() === '-') { take(); return -unary(); } if (peek() === '+') { take(); return unary(); } return atom(); }
  function atom() {
    const t = take();
    if (t === undefined) throw new Error('表达式不完整');
    if (t === '(') { const v = expr(); if (take() !== ')') throw new Error('括号不匹配'); return v; }
    const fn = FN[t];
    if (fn) {
      if (take() !== '(') throw new Error('函数 ' + t + ' 后需要括号');
      const args = [];
      if (peek() !== ')') { args.push(expr()); while (peek() === ',') { take(); args.push(expr()); } }
      if (take() !== ')') throw new Error('函数 ' + t + ' 括号不匹配');
      return fn(...args);
    }
    if (t in CONST) return CONST[t];
    if (/^\d+\.?\d*$|^\.\d+$/.test(t)) return Number(t);
    throw new Error('不认识的符号：「' + t + '」');
  }
  const value = expr();
  if (pos !== tokens.length) throw new Error('表达式尾部有多余内容');
  if (!Number.isFinite(value)) throw new Error('计算结果不是有限数字');
  return value;
}

/** cmd.exe 在中文 Windows 输出 GBK，UTF-8 环境又可能吐 UTF-8：按替换字符多少自动选 */
/* ---------------------------------------------------------------------------
 * QR 编码（byte 模式，版本 1-10）+ PNG 编码：自研实现，零第三方依赖。
 * 表数据取自 ISO/IEC 18004 附录；实现已与 qrcode-generator(MIT) 逐模块比对通过。
 * ------------------------------------------------------------------------- */
const QR_RS_BLOCK = [
  [1,26,19], [1,26,16], [1,26,13], [1,26,9],   // v1 L/M/Q/H
  [1,44,34], [1,44,28], [1,44,22], [1,44,16],   // v2 L/M/Q/H
  [1,70,55], [1,70,44], [2,35,17], [2,35,13],   // v3 L/M/Q/H
  [1,100,80], [2,50,32], [2,50,24], [4,25,9],   // v4 L/M/Q/H
  [1,134,108], [2,67,43], [2,33,15,2,34,16], [2,33,11,2,34,12],   // v5 L/M/Q/H
  [2,86,68], [4,43,27], [4,43,19], [4,43,15],   // v6 L/M/Q/H
  [2,98,78], [4,49,31], [2,32,14,4,33,15], [4,39,13,1,40,14],   // v7 L/M/Q/H
  [2,121,97], [2,60,38,2,61,39], [4,40,18,2,41,19], [4,40,14,2,41,15],   // v8 L/M/Q/H
  [2,146,116], [3,58,36,2,59,37], [4,36,16,4,37,17], [4,36,12,4,37,13],   // v9 L/M/Q/H
  [2,86,68,2,87,69], [4,69,43,1,70,44], [6,43,19,2,44,20], [6,43,15,2,44,16],   // v10 L/M/Q/H
  [4,101,81], [1,80,50,4,81,51], [4,50,22,4,51,23], [3,36,12,8,37,13],   // v11 L/M/Q/H
  [2,116,92,2,117,93], [6,58,36,2,59,37], [4,46,20,6,47,21], [7,42,14,4,43,15],   // v12 L/M/Q/H
  [4,133,107], [8,59,37,1,60,38], [8,44,20,4,45,21], [12,33,11,4,34,12],   // v13 L/M/Q/H
  [3,145,115,1,146,116], [4,64,40,5,65,41], [11,36,16,5,37,17], [11,36,12,5,37,13],   // v14 L/M/Q/H
  [5,109,87,1,110,88], [5,65,41,5,66,42], [5,54,24,7,55,25], [11,36,12,7,37,13],   // v15 L/M/Q/H
  [5,122,98,1,123,99], [7,73,45,3,74,46], [15,43,19,2,44,20], [3,45,15,13,46,16],   // v16 L/M/Q/H
  [1,135,107,5,136,108], [10,74,46,1,75,47], [1,50,22,15,51,23], [2,42,14,17,43,15],   // v17 L/M/Q/H
  [5,150,120,1,151,121], [9,69,43,4,70,44], [17,50,22,1,51,23], [2,42,14,19,43,15],   // v18 L/M/Q/H
  [3,141,113,4,142,114], [3,70,44,11,71,45], [17,47,21,4,48,22], [9,39,13,16,40,14],   // v19 L/M/Q/H
  [3,135,107,5,136,108], [3,67,41,13,68,42], [15,54,24,5,55,25], [15,43,15,10,44,16],   // v20 L/M/Q/H
  [4,144,116,4,145,117], [17,68,42], [17,50,22,6,51,23], [19,46,16,6,47,17],   // v21 L/M/Q/H
  [2,139,111,7,140,112], [17,74,46], [7,54,24,16,55,25], [34,37,13],   // v22 L/M/Q/H
  [4,151,121,5,152,122], [4,75,47,14,76,48], [11,54,24,14,55,25], [16,45,15,14,46,16],   // v23 L/M/Q/H
  [6,147,117,4,148,118], [6,73,45,14,74,46], [11,54,24,16,55,25], [30,46,16,2,47,17],   // v24 L/M/Q/H
  [8,132,106,4,133,107], [8,75,47,13,76,48], [7,54,24,22,55,25], [22,45,15,13,46,16],   // v25 L/M/Q/H
  [10,142,114,2,143,115], [19,74,46,4,75,47], [28,50,22,6,51,23], [33,46,16,4,47,17],   // v26 L/M/Q/H
  [8,152,122,4,153,123], [22,73,45,3,74,46], [8,53,23,26,54,24], [12,45,15,28,46,16],   // v27 L/M/Q/H
  [3,147,117,10,148,118], [3,73,45,23,74,46], [4,54,24,31,55,25], [11,45,15,31,46,16],   // v28 L/M/Q/H
  [7,146,116,7,147,117], [21,73,45,7,74,46], [1,53,23,37,54,24], [19,45,15,26,46,16],   // v29 L/M/Q/H
  [5,145,115,10,146,116], [19,75,47,10,76,48], [15,54,24,25,55,25], [23,45,15,25,46,16],   // v30 L/M/Q/H
  [13,145,115,3,146,116], [2,74,46,29,75,47], [42,54,24,1,55,25], [23,45,15,28,46,16],   // v31 L/M/Q/H
  [17,145,115], [10,74,46,23,75,47], [10,54,24,35,55,25], [19,45,15,35,46,16],   // v32 L/M/Q/H
  [17,145,115,1,146,116], [14,74,46,21,75,47], [29,54,24,19,55,25], [11,45,15,46,46,16],   // v33 L/M/Q/H
  [13,145,115,6,146,116], [14,74,46,23,75,47], [44,54,24,7,55,25], [59,46,16,1,47,17],   // v34 L/M/Q/H
  [12,151,121,7,152,122], [12,75,47,26,76,48], [39,54,24,14,55,25], [22,45,15,41,46,16],   // v35 L/M/Q/H
  [6,151,121,14,152,122], [6,75,47,34,76,48], [46,54,24,10,55,25], [2,45,15,64,46,16],   // v36 L/M/Q/H
  [17,152,122,4,153,123], [29,74,46,14,75,47], [49,54,24,10,55,25], [24,45,15,46,46,16],   // v37 L/M/Q/H
  [4,152,122,18,153,123], [13,74,46,32,75,47], [48,54,24,14,55,25], [42,45,15,32,46,16],   // v38 L/M/Q/H
  [20,147,117,4,148,118], [40,75,47,7,76,48], [43,54,24,22,55,25], [10,45,15,67,46,16],   // v39 L/M/Q/H
  [19,148,118,6,149,119], [18,75,47,31,76,48], [34,54,24,34,55,25], [20,45,15,61,46,16],   // v40 L/M/Q/H
];
const QR_ALIGN = [
  [],
  [6,18],
  [6,22],
  [6,26],
  [6,30],
  [6,34],
  [6,22,38],
  [6,24,42],   // v1-v8
  [6,26,46],
  [6,28,50],
  [6,30,54],
  [6,32,58],
  [6,34,62],
  [6,26,46,66],
  [6,26,48,70],
  [6,26,50,74],   // v9-v16
  [6,30,54,78],
  [6,30,56,82],
  [6,30,58,86],
  [6,34,62,90],
  [6,28,50,72,94],
  [6,26,50,74,98],
  [6,30,54,78,102],
  [6,28,54,80,106],   // v17-v24
  [6,32,58,84,110],
  [6,30,58,86,114],
  [6,34,62,90,118],
  [6,26,50,74,98,122],
  [6,30,54,78,102,126],
  [6,26,52,78,104,130],
  [6,30,56,82,108,134],
  [6,34,60,86,112,138],   // v25-v32
  [6,30,58,86,114,142],
  [6,34,62,90,118,146],
  [6,30,54,78,102,126,150],
  [6,24,50,76,102,128,154],
  [6,28,54,80,106,132,158],
  [6,32,58,84,110,136,162],
  [6,26,54,82,110,138,166],
  [6,30,58,86,114,142,170],   // v33-v40
];

const QR_EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const QR_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const QR_EXP = new Array(512);
const QR_LOG = new Array(256);
(function qrInitGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();
const qrMul = (a, b) => (a === 0 || b === 0 ? 0 : QR_EXP[QR_LOG[a] + QR_LOG[b]]);

function qrBlocks(version, level) {
  const raw = QR_RS_BLOCK[(version - 1) * 4 + QR_EC_INDEX[level]];
  const out = [];
  for (let i = 0; i < raw.length; i += 3) {
    for (let k = 0; k < raw[i]; k++) out.push({ total: raw[i + 1], data: raw[i + 2], ec: raw[i + 1] - raw[i + 2] });
  }
  return out;
}

function qrGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= qrMul(poly[j], QR_EXP[i]); }
    poly = next;
  }
  return poly;
}

function qrReedSolomon(data, ecLen) {
  const gen = qrGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= qrMul(gen[i + 1], factor);
  }
  return res;
}

function qrCodewords(bytes, version, level) {
  const blocks = qrBlocks(version, level);
  const totalData = blocks.reduce((s, b) => s + b.data, 0);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = totalData * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    words.push(v);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; words.length < totalData; i++) words.push(PAD[i % 2]);

  const dataBlocks = [];
  const ecBlocks = [];
  let p = 0;
  for (const b of blocks) { const d = words.slice(p, p + b.data); p += b.data; dataBlocks.push(d); ecBlocks.push(qrReedSolomon(d, b.ec)); }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data));
  for (let i = 0; i < maxData; i++) for (const d of dataBlocks) if (i < d.length) out.push(d[i]);
  const maxEc = Math.max(...blocks.map((b) => b.ec));
  for (let i = 0; i < maxEc; i++) for (const e of ecBlocks) if (i < e.length) out.push(e[i]);
  return out;
}

const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

const QR_G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const QR_G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const QR_G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const qrBitLen = (d) => { let n = 0; while (d !== 0) { n++; d >>>= 1; } return n; };
function qrBchInfo(data) {
  let d = data << 10;
  while (qrBitLen(d) - qrBitLen(QR_G15) >= 0) d ^= QR_G15 << (qrBitLen(d) - qrBitLen(QR_G15));
  return ((data << 10) | d) ^ QR_G15_MASK;
}
function qrBchVersion(data) {
  let d = data << 12;
  while (qrBitLen(d) - qrBitLen(QR_G18) >= 0) d ^= QR_G18 << (qrBitLen(d) - qrBitLen(QR_G18));
  return (data << 12) | d;
}

function qrBuildMatrix(version, codewords, level, mask, writeMeta) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, dark);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

  const pos = QR_ALIGN[version - 1];
  const inFinder = (r, c) => (r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8);
  for (const r0 of pos) {
    for (const c0 of pos) {
      if (inFinder(r0, c0)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) set(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }
  }

  // 格式信息占位（候选阶段留白，与常见实现的掩码评分保持一致）
  const bits = writeMeta ? qrBchInfo((QR_EC_BITS[level] << 3) | mask) : 0;
  for (let i = 0; i < 15; i++) {
    const bit = writeMeta && ((bits >> i) & 1) === 1;
    const r = i < 6 ? i : (i < 8 ? i + 1 : size - 15 + i);
    set(r, 8, bit);
    const c = i < 8 ? size - i - 1 : (i < 9 ? 15 - i : 14 - i);
    set(8, c, bit);
  }
  set(size - 8, 8, writeMeta);

  if (version >= 7) {
    const vbits = writeMeta ? qrBchVersion(version) : 0;
    for (let i = 0; i < 18; i++) {
      const bit = writeMeta && ((vbits >> i) & 1) === 1;
      set(Math.floor(i / 3), (i % 3) + size - 11, bit);
      set((i % 3) + size - 11, Math.floor(i / 3), bit);
    }
  }

  const totalBits = codewords.length * 8;
  let idx = 0, dir = -1, row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (m[row][cc] === null) {
          let bit = 0;
          if (idx < totalBits) { bit = (codewords[idx >> 3] >> (7 - (idx & 7))) & 1; idx++; }
          m[row][cc] = bit === 1;
        }
      }
      row += dir;
      if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
    }
  }

  const maskFn = QR_MASKS[mask];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && maskFn(r, c)) m[r][c] = !m[r][c];
  return { matrix: m, size };
}

function qrLostPoint(matrix, size) {
  const dark = (r, c) => matrix[r][c] === true;
  let lost = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let same = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          if (dark(r, c) === dark(rr, cc)) same++;
        }
      }
      if (same > 5) lost += 3 + same - 5;
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const n = Number(dark(r, c)) + Number(dark(r + 1, c)) + Number(dark(r, c + 1)) + Number(dark(r + 1, c + 1));
      if (n === 0 || n === 4) lost += 3;
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size - 6; c++) {
      if (dark(r, c) && !dark(r, c + 1) && dark(r, c + 2) && dark(r, c + 3) && dark(r, c + 4) && !dark(r, c + 5) && dark(r, c + 6)) lost += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size - 6; r++) {
      if (dark(r, c) && !dark(r + 1, c) && dark(r + 2, c) && dark(r + 3, c) && dark(r + 4, c) && !dark(r + 5, c) && dark(r + 6, c)) lost += 40;
    }
  }
  let darkCount = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (dark(r, c)) darkCount++;
  lost += (Math.abs((100 * darkCount) / size / size - 50) / 5) * 10;
  return lost;
}

/** 某个版本/纠错级能装下的最大字节数（byte 模式：4 位模式 + 8/16 位长度 + 8 位/字节） */
function qrCapacity(version, level) {
  const totalData = qrBlocks(version, level).reduce((s, b) => s + b.data, 0);
  return Math.floor((totalData * 8 - 4 - (version <= 9 ? 8 : 16)) / 8);
}
const QR_MAX_VERSION = 40;
const QR_INPUT_MAX = 16384;   // 工具接受的内容上限（超出会拆成多张二维码，单张最多 2953 字节）

/** 生成二维码模块矩阵：byte 模式，自动选版本（1-40）与最优掩码 */
function qrMatrix(text, level = 'M') {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (version = 1; version <= QR_MAX_VERSION; version++) {
    const totalData = qrBlocks(version, level).reduce((s, b) => s + b.data, 0);
    if (4 + (version <= 9 ? 8 : 16) + bytes.length * 8 <= totalData * 8) break;
  }
  if (version > QR_MAX_VERSION) {
    throw new Error(`内容过长：单张二维码上限 ${qrCapacity(QR_MAX_VERSION, level)} 字节（版本 40 / ${level} 级纠错）`);
  }
  const cw = qrCodewords(bytes, version, level);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const probe = qrBuildMatrix(version, cw, level, mask, false);
    const score = qrLostPoint(probe.matrix, probe.size);
    if (!best || score < best.score) best = { score, mask };
  }
  const final = qrBuildMatrix(version, cw, level, best.mask, true);
  return { version, mask: best.mask, size: final.size, matrix: final.matrix };
}

const QR_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function qrCrc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = QR_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(qrCrc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 矩阵 → 8bit 灰度 PNG（黑 0 / 白 255，默认四周留 4 模块静区） */
function qrPng(matrix, scale = 8, border = 4) {
  const n = matrix.length;
  const dim = (n + border * 2) * scale;
  const raw = Buffer.alloc((dim + 1) * dim, 255);
  for (let y = 0; y < dim; y++) raw[y * (dim + 1)] = 0; // filter: none
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c] !== true) continue;
      const px0 = (c + border) * scale;
      const py0 = (r + border) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const off = (py0 + dy) * (dim + 1) + 1 + px0;
        raw.fill(0, off, off + scale);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 矩阵 → 终端字符画（每个模块 2 字符宽，含 2 模块静区） */
function qrAscii(matrix, border = 2) {
  const n = matrix.length;
  const lines = [];
  const pad = '  '.repeat(border);
  const blank = `${pad}${'  '.repeat(n)}${pad}`;
  for (let i = 0; i < border; i++) lines.push(blank);
  for (let r = 0; r < n; r++) {
    let line = pad;
    for (let c = 0; c < n; c++) line += matrix[r][c] ? '██' : '  ';
    lines.push(line + pad);
  }
  for (let i = 0; i < border; i++) lines.push(blank);
  return lines.join('\n');
}

function decodeCmdOutput(buf) {
  if (!buf.length) return '';
  let utf8 = '', gbk = '';
  try { utf8 = new TextDecoder('utf-8').decode(buf); } catch {}
  try { gbk = new TextDecoder('gbk').decode(buf); } catch {}
  const bad = (s) => (s.match(/\uFFFD/g) || []).length;
  return bad(utf8) > bad(gbk) ? gbk : utf8;
}

/** 本机命令执行：直接 spawn cmd.exe，不走沙箱；有超时与输出上限，防止卡死/撑爆。 */
function runCommand({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, text: '启动 cmd.exe 失败：' + e.message });
      return;
    }
    const MAX = 60000; // 字节上限，解码后约 2 万字符
    const outChunks = [], errChunks = [];
    let outBytes = 0, errBytes = 0, truncated = false;
    const eat = (chunk, which) => {
      const bucket = which === 'out' ? outChunks : errChunks;
      const used = which === 'out' ? outBytes : errBytes;
      if (used + chunk.length > MAX) {
        bucket.push(chunk.subarray(0, Math.max(0, MAX - used)));
        if (which === 'out') outBytes = MAX; else errBytes = MAX;
        truncated = true;
      } else {
        bucket.push(chunk);
        if (which === 'out') outBytes += chunk.length; else errBytes += chunk.length;
      }
    };
    child.stdout.on('data', (b) => eat(b, 'out'));
    child.stderr.on('data', (b) => eat(b, 'err'));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    const done = (code, signal) => {
      clearTimeout(timer);
      const out = decodeCmdOutput(Buffer.concat(outChunks));
      const err = decodeCmdOutput(Buffer.concat(errChunks));
      const head = `退出码：${code === null ? '—' : code}${signal ? '（信号 ' + signal + '）' : ''}${timedOut ? ' · 已超时终止' : ''}${truncated ? ' · 输出已截断' : ''}`;
      const body = [
        out ? '--- stdout ---\n' + out.trimEnd() : '',
        err ? '--- stderr ---\n' + err.trimEnd() : '',
      ].filter(Boolean).join('\n\n');
      resolve({
        ok: !timedOut && code === 0,
        text: head + (body ? '\n\n' + body : '\n\n（无输出）'),
        data: { code, signal, timedOut, truncated, stdout: out, stderr: err },
      });
    };
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '命令执行出错：' + e.message }); });
    child.on('close', done);
  });
}

/** 工具检索关键词（与 public/js/tool-search.js 的 TOOL_KEYS 对齐） */
const FIND_TOOL_KEYS = {
  get_balance: ['余额', '充值', '欠费', '账户余额', '还有多少钱'],
  list_models: ['模型列表', '有哪些模型', '可用模型', '模型版本'],
  current_time: ['几点', '现在时间', '今天几号', '星期几', '时区'],
  peak_status: ['峰谷', '峰时', '谷时', '错峰', '高峰时段', '空闲时段', '计价时段', 'deepseek价格'],
  search_history: ['历史对话', '之前聊过', '以前问过', '找对话'],
  usage_stats: ['用量统计', '消耗token', '总共用了', '累计token'],
  web_search: ['搜索', '联网', '新闻', '最新消息', '查一下', '天气', '实时'],
  fetch_url: ['打开网址', '抓取网页', '读网页', '这个链接', '读取网页'],
  calculator: ['计算', '算一下', '帮我算', '等于多少', '表达式', '算账', '运算'],
  hash_text: ['哈希', 'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha3', 'sha3-256', 'sha3-512', '摘要', '校验值', '指纹'],
  base64_codec: ['base64', '编码', '解码'],
  url_codec: ['url编码', 'url解码', '转义', '百分号'],
  json_format: ['json格式', '格式化json', '美化json', '解析json'],
  text_stats: ['字数', '多少字', '字符数', '行数', '统计文本'],
  uuid_gen: ['uuid', '唯一id', 'guid', '随机id'],
  random_pick: ['随机', '抽签', '抽取', '抽奖', '掷骰子'],
  dns_lookup: ['dns', '解析域名', '域名解析', '查ip'],
  port_check: ['端口', '端口通不通', '能否连接', '服务在线'],
  http_request: ['调接口', '发请求', 'http请求', 'get请求', 'post请求', '状态码'],
  local_ip: ['本机ip', '我的ip', '网卡地址', '局域网ip'],
  base_convert: ['进制转换', '二进制', '十六进制', '八进制', '十进制转'],
  percentage: ['百分比', '打几折', '折扣', '增长率', '占比'],
  date_diff: ['相差多少天', '倒计时', '日期差', '过去多久'],
  unit_convert: ['单位换算', '公里换', '英里', '公斤', '摄氏度', '温度换算'],
  regex_test: ['正则', 'regex', '正则表达式', '匹配提取'],
  diff_text: ['对比差异', '文本对比', '比较区别', '改了什么', 'diff'],
  csv_json: ['csv', '表格转', 'csv转json', '表格数据'],
  slugify: ['slug', '生成别名', '友好url', '标题转链接'],
  password_gen: ['生成密码', '随机密码', '强密码', 'password'],
  id_validator: ['验证身份证', '校验身份证', '手机号合法', '邮箱合法'],
  timestamp_convert: ['时间戳', 'timestamp', 'unix时间', '毫秒转', '秒转日期'],
  json_minify: ['压缩json', 'json压缩', 'json一行'],
  token_count: ['多少token', 'token数', '分词', '计费token', 'token消耗'],
  qr_text: ['二维码', 'qr', '扫码', '生成二维码', '二维码图片'],
  stat_calc: ['统计', '平均值', '均值', '中位数', '标准差', '方差', '分位数', '异常值', '算一下平均'],
  hex_view: ['十六进制', 'hex', 'hexdump', '字节查看', '二进制查看', 'xxd', '转hex'],
  color_convert: ['颜色转换', '色值', 'hex颜色', 'rgb转', 'hsl', '对比度', '配色', '颜色代码'],
  text_kit: ['去重', '排序', '清洗文本', '清理空行', '加前缀', '拆列', '命名风格', '驼峰', '下划线命名', 'case转换'],
  aes_crypto: ['aes', '加解密', '对称加密', 'encrypt', 'decrypt', 'cbc', 'gcm', '加密参数', '解密密文'],
  cmd_run: ['执行命令', 'cmd', '运行命令', '本机命令'],
  sub_agent: ['子智能体', '子代理', '子任务', '委派', 'subagent', 'sub_agent', 'ollama', '本地模型', '大模型', '多智能体'],
  eval: ['浏览器执行', '控制台', '执行脚本', 'javascript', 'js脚本', 'eval', '调试'],
};

/** 检索用的英文停用词（工具描述里高频、不携带语义，留着会稀释得分） */
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'in', 'on', 'at',
  'by', 'from', 'is', 'are', 'be', 'as', 'it', 'this', 'that', 'use', 'used', 'using', 'tool', 'tools',
  'return', 'returns', 'string', 'number', 'boolean', 'object', 'array', 'default', 'optional',
  'whether', 'when', 'if', 'not', 'no', 'yes', 'you', 'your', 'can', 'will', 'need', 'needs',
  'value', 'values', 'param', 'params', 'text', 'input', 'output', 'result', 'results']);

function addTok(map, tok, w) {
  if (!tok) return;
  map.set(tok, Math.min(14, (map.get(tok) || 0) + w));
}

/** 文本 → 检索 token：英文按词（下划线拆开），中文按整串 + 2/3-gram */
function tokenizeInto(map, text, weight) {
  const s = String(text || '').toLowerCase();
  if (!s) return;
  for (const part of s.split(/[^\p{L}\p{N}_]+/u)) {
    if (!part) continue;
    if (/[\u4e00-\u9fff]/.test(part)) {
      const han = part.replace(/[^\u4e00-\u9fff]/g, '');
      if (han.length === 1) addTok(map, han, weight);
      if (han.length >= 2) addTok(map, han, weight * 1.6);        // 整串辨识度最高
      for (let i = 0; i < han.length - 1; i++) addTok(map, han.slice(i, i + 2), weight);
      if (han.length >= 3) for (let i = 0; i < han.length - 2; i++) addTok(map, han.slice(i, i + 3), weight * 0.8);
      // 中英混写（aes加密、qr码）：同一片段里的英文也要能命中
      for (const w of part.split(/[^\p{L}\p{N}_]+/u)) {
        if (!w || /[\u4e00-\u9fff]/.test(w) || EN_STOP.has(w) || w.length < 2) continue;
        addTok(map, w, weight);
      }
    } else {
      for (const w of part.split('_')) {
        if (!w || EN_STOP.has(w) || w.length < 2) continue;
        addTok(map, w, weight);
      }
      if (part.includes('_') && part.length >= 3) addTok(map, part, weight * 2.5);  // 完整工具名
    }
  }
}

/** 每个工具建一次索引：名字、描述、参数名/枚举、人工别名（关键词表只作加权，不再是唯一来源） */
const TOOL_INDEX = new Map();   // name -> { map, size, keys }

function toolIndex(def) {
  const name = def?.function?.name || '';
  const cached = TOOL_INDEX.get(name);
  if (cached) return cached;
  const f = def?.function || {};
  const map = new Map();
  tokenizeInto(map, name, 3);                                  // 工具名权重最高
  tokenizeInto(map, f.description || '', 1.2);                  // 描述次之
  for (const [k, v] of Object.entries(f.parameters?.properties || {})) {
    tokenizeInto(map, k, 1.5);                                  // 参数名：target/local/cloud/config
    tokenizeInto(map, v?.description || '', 1);
    if (Array.isArray(v?.enum)) for (const e of v.enum) tokenizeInto(map, e, 1.2);
  }
  const keys = FIND_TOOL_KEYS[name] || [];
  for (const k of keys) tokenizeInto(map, k, 2.5);              // 人工别名加权
  const idx = { map, size: map.size, keys };
  TOOL_INDEX.set(name, idx);
  return idx;
}

/**
 * 工具检索：name + 描述 + 参数 + 人工别名 建索引后按 token 命中打分。
 * 比原来只看手写关键词表可靠 —— 没登记词表的新工具（sub_agent / eval）也能被搜到。
 */
function searchToolDefs(defs, query, topK = 5) {
  const raw = String(query || '').toLowerCase().trim();
  if (!raw) return [];
  const qmap = new Map();
  tokenizeInto(qmap, raw, 1);
  const qTokens = [...qmap.keys()];
  const qName = raw.replace(/[^\p{L}\p{N}_]+/gu, '');
  const scored = [];
  for (const def of defs || []) {
    const name = def?.function?.name || '';
    if (name === 'find_tool') continue;
    const idx = toolIndex(def);
    let score = 0;
    for (const qt of qTokens) {
      let w = idx.map.get(qt) || 0;
      if (!w && qt.length >= 3) {
        // 前缀/包含兜底：agent ↔ agents、json ↔ json5、encrypt ↔ encryption
        for (const [t, tw] of idx.map) {
          if (t.length >= 3 && (t.startsWith(qt) || qt.startsWith(t))) { w = tw * 0.45; break; }
        }
      }
      if (w) score += w;
    }
    if (!score) continue;
    // 名字直接命中：模型常直接拿工具名搜，这种必须排最前
    const nameHit = Boolean(qName) && (qName === name || qName.includes(name) || name.includes(qName));
    // 长描述不该占便宜：按索引规模轻度归一
    score = score / Math.sqrt(idx.size / 12 + 1);
    if (nameHit) score += 50;
    if (idx.keys.some((k) => raw.includes(String(k).toLowerCase()))) score += 8;
    scored.push({ name, score: Math.round(score * 10) / 10, def });
  }
  scored.sort((a, b) => b.score - a.score);
  // 相对阈值：只留下和最佳命中同一量级的，避免"沾一个词"的低分噪声（local_ip / token_count）凑数
  const best = scored[0]?.score || 0;
  return scored.filter((h, i) => i === 0 || h.score >= best * 0.15).slice(0, topK);
}

/* --------------------------- 子智能体 sub_agent --------------------------- */
// 配置项刻意做得多：模型、采样、上下文、自动启服务、工具轮数、超时等，
// 都能通过设置面板或 sub_agent({target:'local',action:'config'}) 修改。
const SUB_AGENT_DEFAULTS = {
  enabled: true,
  system: '',
  // cloud
  cloudModel: '',
  cloudMaxTurns: 6,
  cloudTimeoutMs: 120000,
  cloudTemperature: null,
  // local：Ollama 原生协议，或任意 OpenAI 兼容接口
  protocol: 'ollama',          // 'ollama' | 'openai'
  ollamaUrl: 'http://127.0.0.1:11434',
  apiBase: '',                 // OpenAI 兼容接口地址（完整 chat/completions 或 base）
  apiKey: '',
  customProtocol: false,       // true=直接用填写的地址，不再自动补 /chat/completions
  autoStart: true,
  autoStartCmd: 'ollama serve',
  defaultModel: '',
  // 能力声明（让模型/前端知道这个本地模型能做什么）
  capImage: false,             // 图片输入
  thinkingOnly: false,         // 仅思考模式
  nonThinkingOnly: false,      // 仅非思考模式
  thinkingMode: true,          // 思考模式（可选开关）
  defaultEffort: '',           // 默认思考强度：''=自动，low/medium/high/xhigh/max
  effortLevels: [],            // 支持的思考强度：['low','medium','high','xhigh','max']
  contextIn: 0,                // 输入上下文：0=使用提供商默认值
  contextOut: 0,               // 输出上下文：0=使用提供商默认值
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  numCtx: 8192,
  numPredict: 2048,
  repeatPenalty: 1.1,
  seed: 0,
  stop: '',
  keepAlive: '5m',
  think: false,
  toolsEnabled: true,
  maxTurns: 4,
  timeoutMs: 180000,
  stream: false,
  format: '',
};

function subAgentConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...SUB_AGENT_DEFAULTS };
  for (const k of Object.keys(SUB_AGENT_DEFAULTS)) {
    if (src[k] === undefined || src[k] === null) continue;
    const d = SUB_AGENT_DEFAULTS[k];
    if (typeof d === 'boolean') out[k] = Boolean(src[k]);
    else if (typeof d === 'number') {
      const n = Number(src[k]);
      if (Number.isFinite(n)) out[k] = n;
    } else if (k === 'stop') out[k] = Array.isArray(src[k]) ? src[k].join('\n') : String(src[k]);
    else if (k === 'effortLevels') out[k] = Array.isArray(src[k]) ? src[k].map(String).filter(Boolean) : [];
    else out[k] = String(src[k]);
  }
  return out;
}

function sanitizeSubAgentPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SUB_AGENT_DEFAULTS)) continue;
    const d = SUB_AGENT_DEFAULTS[k];
    if (typeof d === 'boolean') out[k] = Boolean(v);
    else if (typeof d === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (k === 'stop') out[k] = Array.isArray(v) ? v.join('\n') : String(v);
    else if (k === 'effortLevels') out[k] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    else out[k] = String(v);
  }
  return out;
}

function ollamaRoot(url) {
  let s = String(url || SUB_AGENT_DEFAULTS.ollamaUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/api\/(chat|tags|generate)$/i, '');
}

async function ollamaAlive(root, timeoutMs = 2500) {
  try {
    const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

/** 探活；本机地址且开启 autoStart 时自动拉起 ollama serve，最多等 8 秒 */
async function ensureOllama(cfg, log) {
  const root = ollamaRoot(cfg.ollamaUrl);
  if (await ollamaAlive(root)) return { ok: true, root, started: false };
  if (!cfg.autoStart) {
    return { ok: false, root, text: `Ollama 未运行（${root}）。请先启动 ollama serve，或在设置里改服务地址。` };
  }
  const isLocal = /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(root);
  if (!isLocal) {
    return { ok: false, root, text: `无法连接 Ollama（${root}）：远程地址不会自动启动，请先手动启动服务。` };
  }
  const cmd = cfg.autoStartCmd || 'ollama serve';
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('[sub_agent] 已尝试启动 Ollama：' + cmd);
  } catch (e) {
    return { ok: false, root, text: `自动启动 Ollama 失败：${e.message}` };
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ollamaAlive(root)) return { ok: true, root, started: true };
  }
  return { ok: false, root, text: `已尝试启动 Ollama（${cmd}）但仍无法连接，请确认已安装并在 PATH 中。` };
}

async function ollamaModels(root) {
  try {
    const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || []).map((m) => m.name).filter(Boolean);
  } catch { return []; }
}

/* ---- local 的 OpenAI 兼容分支 -------------------------------------------- */
function openAIChatUrl(cfg) {
  let s = String(cfg.apiBase || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (cfg.customProtocol) return s;                       // 用户勾选「自定义协议」：原样使用
  return s.replace(/\/+$/, '').replace(/\/chat\/completions\/?$/i, '') + '/chat/completions';
}

/** 设置面板的「测试连接」按钮走这里（sub_agent action=test），不真正跑任务 */
async function testLocalSubAgent(cfg) {
  if (cfg.protocol !== 'openai') {
    const root = ollamaRoot(cfg.ollamaUrl);
    const alive = await ollamaAlive(root, 3000);
    if (!alive) return { ok: false, text: `无法连接 Ollama（${root}）。请启动 ollama serve 或改服务地址。` };
    const models = await ollamaModels(root);
    return { ok: true, text: `Ollama 连接成功（${root}）${models.length ? '，可用模型：' + models.slice(0, 12).join('、') : '，暂无模型，请先 ollama pull'}。`, data: { root, models } };
  }
  const url = openAIChatUrl(cfg);
  if (!url) return { ok: false, text: '请先填写接口地址（OpenAI 兼容 chat/completions）。' };
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const payload = {
    model: String(cfg.defaultModel || 'test'),
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
    max_tokens: 1,
  };
  if (cfg.defaultEffort && cfg.effortLevels.includes(cfg.defaultEffort) && !cfg.nonThinkingOnly) {
    payload.reasoning_effort = cfg.defaultEffort;
  }
  const t0 = Date.now();
  let r, text = '';
  try {
    r = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(5000, Math.min(20000, cfg.timeoutMs || 12000))),
    });
    text = await r.text();
  } catch (e) {
    return { ok: false, text: `连接失败：${e.message}（${url}）` };
  }
  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, text: `HTTP ${r.status}：${text.slice(0, 300)}（${url}，${ms}ms）` };
  return { ok: true, text: `连接成功（HTTP ${r.status}，${ms}ms，${url}）。服务端已响应，模型名填 ${cfg.defaultModel || 'test'}。`, data: { url, status: r.status, ms } };
}

async function runOpenAILocalSubAgent({ args, cfg, definitions, call, log }) {
  const url = openAIChatUrl(cfg);
  if (!url) return { ok: false, text: 'local 使用 OpenAI 兼容接口，但设置里没填接口地址。请到 设置 → 子智能体 填写。' };
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const model = String(args.model || cfg.defaultModel || '').trim();
  if (!model) return { ok: false, text: 'local 使用 OpenAI 兼容接口，但没填模型名称。请到 设置 → 子智能体 填写，或在调用时传 model。' };
  const sys = [
    '你是一个专注于完成子任务的智能体。只做被交代的事，完成后直接给出结论，不要反问。',
    args.system || cfg.system || '',
  ].filter(Boolean).join('\n\n');
  let userContent = String(args.task);
  const images = Array.isArray(args.images) ? args.images : (args.image ? [args.image] : []);
  if (cfg.capImage && images.length) {
    userContent = [
      { type: 'text', text: String(args.task) },
      ...images.filter((x) => typeof x === 'string' && x.trim()).map((x) => ({ type: 'image_url', image_url: { url: x.trim() } })),
    ];
  }
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: userContent }];
  const tools = cfg.toolsEnabled ? toolsForSubAgent(definitions) : [];
  const maxTurns = Math.max(1, Math.min(12, Number(cfg.maxTurns) || 4));
  const trace = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const payload = { model, messages, stream: false };
    if (cfg.temperature !== null && cfg.temperature !== '') payload.temperature = Number(cfg.temperature);
    if (Number(cfg.contextOut) > 0) payload.max_tokens = Number(cfg.contextOut);
    // contextIn 在 Ollama 分支映射 num_ctx；OpenAI 兼容接口没有统一字段，不塞非标准参数。
    if (tools.length) payload.tools = tools;
    const effort = cfg.nonThinkingOnly ? '' : (args.effort || cfg.defaultEffort || '');
    if (effort && cfg.effortLevels.includes(String(effort))) payload.reasoning_effort = String(effort);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(10000, cfg.timeoutMs)),
      });
    } catch (e) {
      return { ok: false, text: `local 子智能体请求失败：${e.message}（${url}）` };
    }
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (!r.ok || !j) return { ok: false, text: `local 子智能体请求失败：HTTP ${r.status} ${raw.slice(0, 300)}` };
    const msg = j.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const entry = { role: 'assistant', content: msg.content || '' };
    if (calls.length) entry.tool_calls = calls;
    messages.push(entry);
    if (!calls.length) {
      return {
        ok: true,
        text: msg.content || '（子智能体没有返回内容）',
        data: { target: 'local', protocol: 'openai', model, url, turns: turn + 1, tools: trace },
      };
    }
    for (const tc of calls) {
      const name = tc.function?.name;
      let a = {};
      try { a = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      let out;
      try { out = await call(name, a); } catch (e) { out = { ok: false, text: e.message }; }
      trace.push({ name, ok: out.ok !== false });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out.text || JSON.stringify(out)).slice(0, 20000) });
    }
  }
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
  return { ok: true, text: last?.content || '（子智能体达到最大轮数仍未给出结论）', data: { target: 'local', protocol: 'openai', model, url, turns: maxTurns, tools: trace, limitHit: true } };
}

/** 子智能体的工具链：与主智能体同一套定义，但剔除 sub_agent 自身（防递归）与浏览器端 eval */
function toolsForSubAgent(definitions) {
  return definitions
    .filter((d) => d.function.name !== 'sub_agent')
    .filter((d) => !d.meta?.browser)
    .map((d) => ({ type: 'function', function: d.function }));
}

async function runCloudSubAgent({ args, cfg, definitions, store, call }) {
  const key = store.getApiKey();
  if (!key) return { ok: false, text: '本机未配置 API Key，cloud 子智能体不可用。' };
  const s = store.rawSettings ? store.rawSettings() : {};
  const base = String(s.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(args.model || cfg.cloudModel || s.model || 'deepseek-chat');
  const sys = [
    '你是一个专注于完成子任务的智能体。只做被交代的事，完成后直接给出结论，不要反问。',
    args.system || cfg.system || '',
  ].filter(Boolean).join('\n\n');
  const tools = cfg.toolsEnabled ? toolsForSubAgent(definitions) : [];
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: String(args.task) },
  ];
  const maxTurns = Math.max(1, Math.min(12, Number(cfg.cloudMaxTurns) || 6));
  const trace = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const payload = { model, messages, stream: false };
    if (tools.length) payload.tools = tools;
    if (cfg.cloudTemperature !== null && cfg.cloudTemperature !== '') payload.temperature = Number(cfg.cloudTemperature);
    let r;
    try {
      r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(10000, cfg.cloudTimeoutMs)),
      });
    } catch (e) {
      return { ok: false, text: `cloud 子智能体请求失败：${e.message}` };
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (!r.ok || !j) return { ok: false, text: `cloud 子智能体请求失败：HTTP ${r.status} ${text.slice(0, 200)}` };
    const msg = j.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const entry = { role: 'assistant', content: msg.content || '' };
    if (calls.length) entry.tool_calls = calls;
    messages.push(entry);
    if (!calls.length) {
      return {
        ok: true,
        text: msg.content || '（子智能体没有返回内容）',
        data: { target: 'cloud', model, turns: turn + 1, tools: trace },
      };
    }
    for (const tc of calls) {
      const name = tc.function?.name;
      let a = {};
      try { a = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      let out;
      try { out = await call(name, a); } catch (e) { out = { ok: false, text: e.message }; }
      trace.push({ name, ok: out.ok !== false });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out.text || JSON.stringify(out)).slice(0, 20000) });
    }
  }
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
  return { ok: true, text: last?.content || '（子智能体达到最大轮数仍未给出结论）', data: { target: 'cloud', model, turns: maxTurns, tools: trace, limitHit: true } };
}

async function runLocalSubAgent({ args, cfg, definitions, call, log }) {
  if (cfg.protocol === 'openai') return runOpenAILocalSubAgent({ args, cfg, definitions, call, log });
  const up = await ensureOllama(cfg, log);
  if (!up.ok) return { ok: false, text: up.text };
  const root = up.root;
  let model = String(args.model || cfg.defaultModel || '');
  if (!model) {
    const list = await ollamaModels(root);
    model = list[0] || '';
  }
  if (!model) return { ok: false, text: `Ollama 已连接（${root}）但没有任何模型，请先执行 ollama pull 拉一个模型。` };
  const sys = [
    '你是一个专注于完成子任务的智能体。只做被交代的事，完成后直接给出结论。',
    args.system || cfg.system || '',
  ].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: String(args.task) },
  ];
  const tools = cfg.toolsEnabled ? toolsForSubAgent(definitions) : [];
  const maxTurns = Math.max(1, Math.min(12, Number(cfg.maxTurns) || 4));
  const options = {
    temperature: cfg.temperature,
    top_p: cfg.topP,
    top_k: cfg.topK,
    num_ctx: cfg.numCtx,
    num_predict: cfg.numPredict,
    repeat_penalty: cfg.repeatPenalty,
  };
  if (cfg.seed) options.seed = cfg.seed;
  if (cfg.stop) options.stop = cfg.stop.split('\n').map((x) => x.trim()).filter(Boolean);
  const trace = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const payload = {
      model, messages, stream: false, options,
      keep_alive: cfg.keepAlive, think: Boolean(cfg.think),
    };
    if (tools.length) payload.tools = tools;
    if (cfg.format === 'json') payload.format = 'json';
    let r;
    try {
      r = await fetch(root + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(10000, cfg.timeoutMs)),
      });
    } catch (e) {
      return { ok: false, text: `local 子智能体请求失败：${e.message}（地址 ${root}）` };
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (!r.ok || !j) return { ok: false, text: `local 子智能体请求失败：HTTP ${r.status} ${text.slice(0, 200)}` };
    const msg = j.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const entry = { role: 'assistant', content: msg.content || '' };
    if (calls.length) entry.tool_calls = calls;
    messages.push(entry);
    if (!calls.length) {
      return {
        ok: true,
        text: msg.content || '（子智能体没有返回内容）',
        data: { target: 'local', model, root, turns: turn + 1, tools: trace, started: up.started },
      };
    }
    for (const tc of calls) {
      const name = tc.function?.name;
      const rawArgs = tc.function?.arguments;
      const a = rawArgs && typeof rawArgs === 'object' ? rawArgs : (() => {
        try { return JSON.parse(rawArgs || '{}'); } catch { return {}; }
      })();
      let out;
      try { out = await call(name, a); } catch (e) { out = { ok: false, text: e.message }; }
      trace.push({ name, ok: out.ok !== false });
      messages.push({ role: 'tool', content: String(out.text || JSON.stringify(out)).slice(0, 20000) });
    }
  }
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
  return { ok: true, text: last?.content || '（子智能体达到最大轮数仍未给出结论）', data: { target: 'local', model, root, turns: maxTurns, tools: trace, limitHit: true } };
}

function createTools({ store, upstream = 'https://api.deepseek.com', log = console.log, dataDir = '', cpl = null }) {
  const definitions = [
    {
      type: 'function',
      function: {
        name: 'get_balance',
        description: '查询当前 DeepSeek 账号余额（总余额、赠金、充值余额、是否可用）。用户问「我还有多少钱/余额」时使用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_models',
        description: '列出当前可用的 DeepSeek 模型，包含 id、上下文窗口、最大输出与是否支持图片输入。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'current_time',
        description: '获取本机的当前日期、时间、星期与时区。用户问「现在几点/今天几号」时使用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'peak_status',
        description: '查看当前 DeepSeek 峰谷时段（北京时间）：峰时还是谷时、计价规则与下次切换时间。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'compress_history',
        description: '压缩对话上下文：把较早的消息交给子模型摘要成一段，保留最近若干条原文，返回新的消息序列与节省的 token 数。上下文快满、或用户要求「压缩历史 / 精简上下文 / 省点 token」时使用。',
        parameters: {
          type: 'object',
          properties: {
            keep_recent: { type: 'integer', description: '保留最近多少条消息原文，默认 6，最小 2' },
            target_tokens: { type: 'integer', description: '摘要的目标 token 上限，默认 800，最大 4000' },
            style: { type: 'string', enum: ['brief', 'detailed'], description: '摘要风格：brief 要点式（默认），detailed 保留更多细节' },
            instruction: { type: 'string', description: '额外的压缩要求，例如「保留所有代码片段」' },
            model: { type: 'string', description: '用于压缩的模型，默认跟随当前模型' },
            dry_run: { type: 'boolean', description: '只统计能省多少，不真正调用模型' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_history',
        description: '在本地历史对话里按关键词搜索，返回匹配的对话标题、时间和出处片段。用户提到「之前聊过的…」时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            limit: { type: 'integer', description: '返回条数，默认 5，最大 20' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'usage_stats',
        description: '统计本地保存的对话数量、消息条数，以及累计输入/输出 token 与缓存命中情况。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      // meta.web 只是给前端看的标记，发请求前会被剥掉
      meta: { web: 'search' },
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索（本机执行，走 Bing 等搜索引擎）。返回标题、链接与摘要，用于获取实时或你不确定的信息：新闻、价格、版本发布、人物近况、赛事比分、政策法规、产品参数等。拿到结果后若摘要不足以回答，再调用 fetch_url 打开其中最相关的 1-3 个链接读原文。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，尽量具体，可带年份或站点名' },
            count: { type: 'integer', description: '返回条数，默认 8，最大 10' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      meta: { web: 'fetch' },
      type: 'function',
      function: {
        name: 'fetch_url',
        description: '抓取指定网页并提取正文纯文本（自动去导航、脚本与广告，超长会截断）。用于打开搜索结果里的链接、核对原文，或读取用户给出的网址。只支持公开的 http / https 页面。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整网址，必须带 http:// 或 https://' },
            max_chars: { type: 'integer', description: '正文最多返回多少字符，默认 8000，最大 40000' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },

    /* ---------- 小工具：纯本地、无副作用、毫秒级 ---------- */
    {
      type: 'function',
      function: {
        name: 'calculator',
        description: '计算数学表达式。支持 + - * / % ^ 括号、sqrt/abs/round/floor/ceil/min/max/pow/log/exp 函数与 PI、E 常量。用户要算账、换算、求值且不想自己按计算器时使用。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '表达式，如 (128*0.85+32)/3 或 sqrt(2)*PI' },
            precision: { type: 'integer', description: '结果保留小数位，默认 6' },
          },
          required: ['expression'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'hash_text',
        description: '计算文本的哈希值（十六进制）：MD5 / SHA1 / SHA2（sha224/sha256/sha384/sha512）/ SHA3（sha3-224/sha3-256/sha3-384/sha3-512）。用于校验、生成摘要、比对文件指纹文本。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要哈希的文本' },
            algorithm: { type: 'string', description: 'md5 / sha1 / sha224 / sha256 / sha384 / sha512 / sha3-224 / sha3-256 / sha3-384 / sha3-512，默认 sha256' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'base64_codec',
        description: 'Base64 编码或解码文本（UTF-8 安全，支持中文）。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '输入文本' },
            mode: { type: 'string', description: 'encode 或 decode，默认 encode' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'url_codec',
        description: 'URL 编码 / 解码一段文本（encodeURIComponent / decodeURIComponent）。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '输入文本，如查询参数值或整段 URL' },
            mode: { type: 'string', description: 'encode 或 decode，默认 encode' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'json_format',
        description: '校验并格式化 JSON 文本，可按点路径提取其中一段。用户给了 JSON 串要整理、校验或取某个字段时使用。',
        parameters: {
          type: 'object',
          properties: {
            json: { type: 'string', description: 'JSON 文本' },
            indent: { type: 'integer', description: '缩进空格数，默认 2' },
            path: { type: 'string', description: '可选点路径，如 data.items.0.name' },
          },
          required: ['json'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'text_stats',
        description: '统计文本的字符数、字数、行数、段落数、中英文词数。用户要数文章字数、统计行数时使用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要统计的文本' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'uuid_gen',
        description: '生成 UUID v4 随机标识符，可一次生成多个。',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'integer', description: '生成数量，默认 1，最大 50' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'random_pick',
        description: '在给定范围内取随机整数，或从候选列表里随机抽取若干项。用户要抽签、随机选时使用。',
        parameters: {
          type: 'object',
          properties: {
            min: { type: 'integer', description: '随机整数下限（含）' },
            max: { type: 'integer', description: '随机整数上限（含）' },
            items: { type: 'array', items: { type: 'string' }, description: '候选列表，与 min/max 二选一' },
            count: { type: 'integer', description: '抽取数量，默认 1' },
            unique: { type: 'boolean', description: '抽取是否不重复，默认 false' },
          },
          additionalProperties: false,
        },
      },
    },

    /* ---------- 网络小工具 ---------- */
    {
      type: 'function',
      function: {
        name: 'dns_lookup',
        description: '把域名解析为 IPv4/IPv6 地址（本机 DNS）。用户问某个域名对应什么 IP、或要确认域名能否解析时使用。',
        parameters: {
          type: 'object',
          properties: {
            hostname: { type: 'string', description: '域名，如 www.deepseek.com' },
            family: { type: 'integer', description: '4 / 6 / 0（全部），默认 0' },
          },
          required: ['hostname'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'port_check',
        description: '探测目标主机端口是否可连通（TCP 连接测试）。用户问某个服务端口通不通、网站/游戏服务器是否在线时使用。',
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: '主机名或 IP，如 example.com' },
            port: { type: 'integer', description: '端口 1-65535' },
            timeout_ms: { type: 'integer', description: '超时毫秒，默认 3000，最大 15000' },
          },
          required: ['host', 'port'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'http_request',
        description: '发送一个 HTTP 请求，返回状态码、响应头摘要和正文片段（默认前 6000 字）。用于调公开 API、查看网页状态或接口返回。仅允许公网 http(s)，本机与保留地址会被拒绝。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整 URL' },
            method: { type: 'string', description: 'GET / POST / PUT / DELETE / HEAD，默认 GET' },
            headers: { type: 'object', description: '请求头对象，如 {"Authorization":"Bearer xxx"}' },
            body: { type: 'string', description: '请求体文本（POST/PUT 时）' },
            max_chars: { type: 'integer', description: '正文最多返回多少字符，默认 6000，最大 30000' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'local_ip',
        description: '列出本机的 IPv4/IPv6 网络接口地址（网卡名与 IP）。用户问本机 IP、局域网 IP 时使用。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },

    /* ---------- 运算小工具 ---------- */
    {
      type: 'function',
      function: {
        name: 'base_convert',
        description: '数字进制转换：2 / 8 / 10 / 16 之间互转。用户要二进制、十六进制与十进制互转时使用。',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string', description: '数字文本，如 255 或 ff' },
            from: { type: 'integer', description: '源进制 2/8/10/16，默认 10' },
            to: { type: 'integer', description: '目标进制 2/8/10/16，默认 16' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'percentage',
        description: '百分比计算：求占比、增长率、折扣价、A 占 B 的百分比、在原价上加减百分比。用户要算折扣、涨幅、占比时使用。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'ratio（a 占 b 百分之几）/ growth（从 a 到 b 增长率）/ discount（原价 a 打 b 折后价格，b 用百分数如 75 表示 7.5 折）/ increase（a 增加 b% 后是多少）' },
            a: { type: 'number', description: '第一个数（原价 / 原值 / 分子）' },
            b: { type: 'number', description: '第二个数（对比值 / 折扣 / 分母 / 百分比）' },
          },
          required: ['mode', 'a', 'b'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'date_diff',
        description: '计算两个日期之间相差的天数/小时/分钟，或某日期距今多久。用户问间隔多少天、倒计时、已经过去多久时使用。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '起始日期，如 2026-01-01 或 ISO；留空则用当前时间' },
            to: { type: 'string', description: '结束日期；留空则用当前时间' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'unit_convert',
        description: '常用单位换算：长度（km/m/cm/mm/inch/ft/mile）、重量（kg/g/lb/oz）、温度（C/F/K）、数据大小（B/KB/MB/GB/TB）、时间（s/min/h/day）。',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'number', description: '数值' },
            from: { type: 'string', description: '源单位，如 km / C / MB' },
            to: { type: 'string', description: '目标单位，如 mile / F / GB' },
          },
          required: ['value', 'from', 'to'],
          additionalProperties: false,
        },
      },
    },

    /* ---------- 广义计算 / 文本处理小工具 ---------- */
    {
      type: 'function',
      function: {
        name: 'regex_test',
        description: '用正则匹配文本，返回匹配结果与分组（支持命名组）。用户要验证正则、提取文本片段、批量查找时用。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式，不含两侧的 /' },
            flags: { type: 'string', description: '标志位，如 gi / gm，默认 g' },
            text: { type: 'string', description: '待匹配文本' },
            limit: { type: 'integer', description: '最多返回多少条匹配，默认 20，最大 100' },
          },
          required: ['pattern', 'text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'diff_text',
        description: '逐行比较两段文本，返回新增行、删除行与未变化行数。用户要对比两段文字/代码差异、看改了什么时用。',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'string', description: '原文' },
            b: { type: 'string', description: '新文' },
            context: { type: 'boolean', description: '是否保留未变化的行，默认 false（只显示差异）' },
          },
          required: ['a', 'b'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'csv_json',
        description: 'CSV 与 JSON 互转：toJson 把 CSV 文本（首行为表头）转成对象数组，toCsv 把对象数组转成 CSV。用户要转换表格数据、导出导入数据时用。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'toJson 或 toCsv' },
            text: { type: 'string', description: 'CSV 文本（toJson）或 JSON 数组文本（toCsv）' },
            delimiter: { type: 'string', description: '分隔符，默认逗号' },
          },
          required: ['mode', 'text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'slugify',
        description: '把标题/中文文本转成 URL 或文件名安全的标识（小写、去符号、空格转连字符；中文默认保留，可转拼音式占位）。用户要生成链接别名、文件名、锚点时用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '输入文本' },
            separator: { type: 'string', description: '连接符，默认 -' },
            lower: { type: 'boolean', description: '是否转小写，默认 true' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'password_gen',
        description: '生成随机密码并估算强度。可指定长度、是否包含大小写/数字/符号、排除易混淆字符。用户要生成安全密码或令牌时用。',
        parameters: {
          type: 'object',
          properties: {
            length: { type: 'integer', description: '长度，默认 16，最大 128' },
            upper: { type: 'boolean', description: '含大写，默认 true' },
            lower: { type: 'boolean', description: '含小写，默认 true' },
            digits: { type: 'boolean', description: '含数字，默认 true' },
            symbols: { type: 'boolean', description: '含符号，默认 true' },
            excludeAmbiguous: { type: 'boolean', description: '排除 0/O/l/1/I 等易混淆字符，默认 true' },
            count: { type: 'integer', description: '生成几个，默认 1，最大 20' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'id_validator',
        description: '校验常见编号格式：中国身份证（含校验位）、邮箱、中国大陆手机号、IPv4、UUID。用户要验证填的号码/邮箱/地址是否合法时用。',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'idcard / email / phone / ipv4 / uuid' },
            value: { type: 'string', description: '待校验的值' },
          },
          required: ['type', 'value'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'timestamp_convert',
        description: '时间戳与日期互转：秒/毫秒时间戳转可读日期，或日期字符串转时间戳，支持时区偏移。用户问某时间戳是什么时间、或要拿日期的时间戳时用。',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string', description: '时间戳（纯数字）或日期字符串，如 1700000000 或 2026-11-23 12:00:00' },
            unit: { type: 'string', description: '输入是纯数字时的单位：s / ms，默认自动判断' },
            offsetHours: { type: 'number', description: '显示的时区偏移小时数，默认按本机时区' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'json_minify',
        description: '压缩 JSON：去掉空白与换行，保留结构。用户要把 JSON 压成一行、减小体积时用（与 json_format 相反）。',
        parameters: {
          type: 'object',
          properties: {
            json: { type: 'string', description: 'JSON 文本' },
          },
          required: ['json'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'token_count',
        description: '用 DeepSeek V4.1-Flash 分词器（API 名 deepseek-flash，与 V4-Pro/V3 共用词表）精确计算文本的 token 数，可返回每个 token 的 id 与片段。用户问这段文字多少 token、是否超上下文、估算费用时用。本地离线计算，不调用 API、不产生费用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要计算的文本' },
            detail: { type: 'boolean', description: '是否返回 token id 与片段列表，默认 false' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'qr_text',
        description: '把文本或网址生成二维码，保存成本机 PNG 图片并返回文件路径与尺寸；也可以返回终端字符画。用户要生成二维码、让手机扫码打开链接时用。支持到版本 40（单张最多 2953 字节 @L 级），内容 16KB 以内会自动切成多张并按 #i/N 编号。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要编码的内容，最多 16384 字节；超过单张容量（2953 字节 @L）会自动切成多张带 #i/N 编号的二维码' },
            level: { type: 'string', enum: ['L', 'M', 'Q', 'H'], description: '纠错等级，默认 M（越高越抗污损，容量越小）' },
            scale: { type: 'integer', description: '每个模块的像素数，默认 8，范围 2-20' },
            ascii: { type: 'boolean', description: '是否同时返回终端字符画二维码，默认 false' },
            filename: { type: 'string', description: '文件名（不含扩展名），默认按时间生成' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stat_calc',
        description: '对一串数字做统计：个数、总和、均值、中位数、众数、最值、极差、方差与标准差（样本/总体）、四分位数与 IQR、异常值。用户要算平均值、波动、分位数、找离群点时用。',
        parameters: {
          type: 'object',
          properties: {
            numbers: { type: 'string', description: '数字列表，用逗号/空格/换行分隔，如 "12, 15, 9, 22"' },
            precision: { type: 'integer', description: '保留几位小数，默认 4，最大 10' },
          },
          required: ['numbers'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'hex_view',
        description: '十六进制查看与还原：toHex 把文本转成带偏移和 ASCII 侧栏的 hex dump；fromHex 把十六进制串（支持空格、0x、逗号分隔）还原成文本。用户要看字节、读二进制残留、还原 hex 串时用。',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['toHex', 'fromHex'], description: 'toHex=文本转十六进制；fromHex=十六进制还原文本' },
            text: { type: 'string', description: '输入内容' },
            bytes_per_line: { type: 'integer', description: '每行字节数，默认 16，传 0 表示不分行' },
          },
          required: ['mode', 'text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'color_convert',
        description: '颜色格式互转与对比度计算：输入 #RRGGBB、rgb()、hsl() 或 color 名称，输出 HEX、RGB、HSL、HSV、相对亮度、与白/黑的 WCAG 对比度，并判断偏深还是偏浅。用户调色、检查文字可读性时用。',
        parameters: {
          type: 'object',
          properties: {
            color: { type: 'string', description: '颜色，如 #1e90ff、rgb(30,144,255)、hsl(210,100%,56%)' },
            background: { type: 'string', description: '可选：再算一个与背景色的对比度，如 #ffffff' },
          },
          required: ['color'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'text_kit',
        description: '文本批量处理工具箱：dedupe 去重、sort 排序（字典/数字/长度）、trim 清理空行与多余空白、wrap 加前后缀、split 按分隔符拆行、case 命名风格转换（camel/snake/kebab/pascal/const/upper/lower/title）。用户要整理名单、清洗数据、改命名风格时用。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['dedupe', 'sort', 'trim', 'wrap', 'split', 'case'], description: '要做的处理' },
            text: { type: 'string', description: '输入文本（按行处理）' },
            ignore_case: { type: 'boolean', description: '去重/排序时忽略大小写，默认 false' },
            desc: { type: 'boolean', description: '排序是否倒序，默认 false' },
            numeric: { type: 'boolean', description: '排序是否按数值大小，默认 false' },
            prefix: { type: 'string', description: 'wrap 时给每行加的前缀' },
            suffix: { type: 'string', description: 'wrap 时给每行加的后缀' },
            delimiter: { type: 'string', description: 'split 的分隔符，默认按换行' },
            case_type: { type: 'string', enum: ['camel', 'snake', 'kebab', 'pascal', 'const', 'upper', 'lower', 'title'], description: 'case 动作的目标风格' },
          },
          required: ['action', 'text'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'aes_crypto',
        description: 'AES 对称加解密（CBC/GCM/ECB）：支持 hex/base64 编码的 key 与 iv，GCM 会返回 auth tag。用户要解接口加密参数、复现前端加密结果、校验对称加解密时用。key 长度必须是 16/24/32 字节（128/192/256 位）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['encrypt', 'decrypt'], description: '加密或解密' },
            text: { type: 'string', description: '明文（encrypt）或密文（decrypt）' },
            key: { type: 'string', description: '密钥，按 key_encoding 解释' },
            mode: { type: 'string', enum: ['cbc', 'gcm', 'ecb'], description: '工作模式，默认 cbc' },
            iv: { type: 'string', description: '初始向量，CBC/GCM 必填（GCM 一般 12 字节，CBC 16 字节）' },
            tag: { type: 'string', description: 'GCM 解密时的 auth tag，按 input_encoding 解释' },
            key_encoding: { type: 'string', enum: ['utf8', 'hex', 'base64'], description: 'key 的编码，默认 utf8' },
            iv_encoding: { type: 'string', enum: ['utf8', 'hex', 'base64'], description: 'iv 的编码，默认 utf8' },
            input_encoding: { type: 'string', enum: ['utf8', 'hex', 'base64'], description: 'decrypt 时密文/tag 的编码，默认 base64' },
            output_encoding: { type: 'string', enum: ['base64', 'hex'], description: 'encrypt 时输出的编码，默认 base64' },
          },
          required: ['action', 'text', 'key'],
          additionalProperties: false,
        },
      },
    },
    {
      // 元工具：让模型自己搜索可用工具。检索到的工具会被前端追加到下一轮 tools，
      // 所以这里返回名字 + 描述 + 完整参数定义（这样模型下一轮直接能调）
      type: 'function',
      function: {
        name: 'find_tool',
        description: '搜索本机可用的工具目录，或用 action="list" 列出全部工具。当你觉得现有工具不够用、或需要确认有没有能做某件事的工具时调用它。传入任务描述会返回最相关的工具及完整参数定义；传 action="list" 则返回全部工具的名字与一句话说明。返回的工具会在下一轮自动可用，可直接调用。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['search', 'list'], description: 'list=列出全部工具目录（只要名字+一句话说明）；search=按 query 检索，默认 search' },
            query: { type: 'string', description: '你想做什么，如「把中文翻译成英文」「检查端口是否开放」「算 token 数」。action=search 时必填；action=list 时可省略' },
            top_k: { type: 'integer', description: 'search 时返回几个工具，默认 5，最大 10' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      // meta.subagent 让前端按 subAgentEnabled 过滤；云端专版整体禁用
      meta: { subagent: true },
      type: 'function',
      function: {
        name: 'sub_agent',
        description: '把一件独立的事交给子智能体去做，拿回它的结论。target=cloud 用你自己的 DeepSeek API Key 调官方接口（消耗额度、能力强）；target=local 用本机模型：Ollama 原生协议或任意 OpenAI 兼容接口（地址/Key/模型/思考强度/工具调用/图片输入都在设置里配）。子智能体继承当前会话的系统提示与工具链，可多轮调用工具。target=local 且 action=config 可读写本地子智能体配置，action=test 测试接口连通性。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['cloud', 'local'], description: 'cloud=官方 API；local=本机 Ollama 或 OpenAI 兼容接口' },
            action: { type: 'string', enum: ['run', 'config', 'test'], description: 'run=执行任务（默认）；config=读写本地配置（仅 local）；test=测试 local 接口连通性' },
            task: { type: 'string', description: '交给子智能体的任务，要自包含（它看不到本会话历史）' },
            system: { type: 'string', description: '可选。补充/覆盖子智能体的系统提示，默认沿用当前会话' },
            model: { type: 'string', description: '可选。覆盖模型：cloud 填 DeepSeek 模型名，local 填本地模型名' },
            images: { type: 'array', items: { type: 'string' }, description: '可选。图片 URL 或 data URL；需在设置里开启「图片输入」，OpenAI 兼容接口才生效' },
            effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: '可选。覆盖本次思考强度（需在设置里勾选为支持档位）' },
            config: { type: 'object', description: 'action=config 时要修改的字段；省略则返回当前完整配置' },
          },
          required: ['target'],
          additionalProperties: false,
        },
      },
    },
    {
      // eval 在当前浏览器标签页执行 JS，不经过服务端；前端按 evalEnabled 开关过滤。
      // 服务端不提供实现：即使有人绕过前端直接 POST /api/tools/call 也会被 call() 拒绝。
      meta: { browser: true },
      type: 'function',
      function: {
        name: 'eval',
        description: '【危险】在当前浏览器标签页执行一段 JavaScript（支持顶层 await），返回 console 输出与表达式值。代码只运行在用户自己的浏览器里，碰不到服务器，但能读本页 localStorage（含 API Key）与登录态——只执行你信任的代码。默认关闭，需在设置里打开「eval」开关。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的 JavaScript 代码，可用 console.log 输出，可顶层 await，最后一位表达式的值会作为返回值' },
          },
          required: ['code'],
          additionalProperties: false,
        },
      },
    },
    {
      // meta.cmd 让前端按 cmdEnabled 开关过滤；服务端 call() 还会再校验一次
      meta: { cmd: true },
      type: 'function',
      function: {
        name: 'cmd_run',
        description: '【危险】在本机 Windows cmd.exe 执行一条命令并返回输出。只在用户明确要求执行本机命令、且设置里开启了「命令执行」开关时可用。可以运行 dir、ipconfig、ping、type 等任意 cmd 指令。有 30 秒默认超时与输出上限；工作目录可用 cwd 指定。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 cmd 命令，如 dir 或 ping -n 2 127.0.0.1' },
            cwd: { type: 'string', description: '可选工作目录（绝对路径），默认服务所在目录' },
            timeout_ms: { type: 'integer', description: '超时毫秒，默认 30000，最大 120000' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
  ];

  function authHeaders() {
    const key = store.getApiKey();
    return key ? { authorization: 'Bearer ' + key, accept: 'application/json' } : { accept: 'application/json' };
  }

  async function upstreamJson(pathname) {
    const base = (store.getBaseUrl() || upstream).replace(/\/+$/, '');
    const r = await fetch(base + pathname, { headers: authHeaders() });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch {}
      throw new Error(`HTTP ${r.status}：${String(msg).slice(0, 200)}`);
    }
    return JSON.parse(text);
  }

  function fmtMoney(n) {
    const v = Number(n);
    return isFinite(v) ? v.toFixed(2) : String(n);
  }

  const impl = {
    async get_balance() {
      if (!store.getApiKey()) return { ok: false, text: '本机还没有配置 API Key，无法查询余额。请让用户在设置里填写。' };
      const data = await upstreamJson('/user/balance');
      const parts = [];
      parts.push('账户可用：' + (data.is_available ? '是' : '否（余额不足或账号受限）'));
      for (const b of data.balance_infos || []) {
        parts.push(`${b.currency} 总余额 ${fmtMoney(b.total_balance)}（赠金 ${fmtMoney(b.granted_balance)}，充值 ${fmtMoney(b.topped_up_balance)}）`);
      }
      return { ok: true, text: parts.join('\n'), data };
    },

    async list_models() {
      const data = await upstreamJson('/models');
      const rows = (data.data || []).map((m) => {
        const ctx = m.context_window ? Math.round(m.context_window / 1024) + 'K' : '未知';
        const out = m.max_output_tokens ? Math.round(m.max_output_tokens / 1024) + 'K' : '未知';
        const vis = (m.input_modalities || []).includes('image') ? '支持图片' : '纯文本';
        const effort = m.effort?.supported_levels ? m.effort.supported_levels.join('/') : '-';
        return `- ${m.id}（${m.name || m.id}）：上下文 ${ctx}，最大输出 ${out}，${vis}，思考档位 ${effort}`;
      });
      return { ok: true, text: rows.join('\n') || '（没有返回模型）', data };
    },

    async current_time() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const zh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
      const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知';
      const text = `${iso}（${zh}，时区 ${tz}，UTC 偏移 ${-d.getTimezoneOffset() / 60}h）`;
      return { ok: true, text, data: { iso, weekday: zh, tz } };
    },

    async peak_status() {
      // 与前端计价口径一致：北京时间周一至周五 09:00-12:00、14:00-18:00 为峰时，其余为谷时。
      const BJ = 8 * 3600 * 1000;
      const parts = (ms) => {
        const d = new Date(ms + BJ);
        return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), day: d.getUTCDay() };
      };
      const isPeak = (ms) => {
        const p = parts(ms);
        if (p.day === 0 || p.day === 6) return false;
        const m = p.h * 60 + p.mi;
        return (m >= 540 && m < 720) || (m >= 840 && m < 1080);
      };
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (ms) => {
        const p = parts(ms);
        return `${p.y}-${pad(p.mo + 1)}-${pad(p.da)} ${pad(p.h)}:${pad(p.mi)}`;
      };
      const now = Date.now();
      const cur = isPeak(now);
      const p0 = parts(now);
      // 状态只会在每天 00/09/12/14/18/24 点这些边界翻转，往后 8 天足够跨过周末。
      const dayStart = Date.UTC(p0.y, p0.mo, p0.da) - BJ;
      const cands = [];
      for (let d = 0; d <= 8; d++) for (const o of [0, 540, 720, 840, 1080, 1440]) cands.push(dayStart + d * 86400000 + o * 60000);
      cands.sort((a, b) => a - b);
      const next = cands.find((t) => t > now && isPeak(t) !== cur) || null;
      const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const lines = [
        `当前：${cur ? '峰时' : '谷时'}（北京时间 ${fmt(now)} ${wk[p0.day]}）`,
        '规则：工作日 09:00-12:00、14:00-18:00 为峰时，其余为谷时',
      ];
      if (next) {
        const mins = Math.max(0, Math.round((next - now) / 60000));
        const hh = Math.floor(mins / 60), mm = mins % 60;
        const span = hh > 0 ? (mm > 0 ? `${hh} 小时 ${mm} 分钟` : `${hh} 小时`) : `${mm} 分钟`;
        lines.push(`下次切换：${fmt(next)} → ${isPeak(next) ? '峰时' : '谷时'}（约 ${span}后）`);
      }
      lines.push('注：按北京时间计算，未计法定节假日/调休。');
      return { ok: true, text: lines.join('\n'), data: { peak: cur, bj: fmt(now), nextAt: next ? fmt(next) : null } };
    },

    async compress_history(args = {}, callCtx = {}) {
      const keep = Math.max(2, Math.min(80, Number(args.keep_recent) || 6));
      const target = Math.max(100, Math.min(4000, Number(args.target_tokens) || 800));
      const detailed = args.style === 'detailed';

      let messages = Array.isArray(args.messages) ? args.messages.slice() : null;
      const convId = callCtx.convId || null;
      if (!messages) {
        const conv = convId ? store.getConversation(convId) : null;
        if (!conv) {
          return { ok: false, text: '缺少会话上下文：直接在对话中调用本工具即可（前端会自动带上当前会话），或显式传 messages 参数。' };
        }
        messages = JSON.parse(JSON.stringify(conv.messages || []));
      }

      let tok;
      try { tok = require('./tokenizer-core.cjs').tokenize; } catch { tok = (s) => Math.ceil(String(s).length / 1.6); }
      const listTok = (list) => list.reduce((n, m) => n + (Number(tok(String(m.content || ''))) || 0), 0);
      const cap = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

      const sys = messages.filter((m) => m.role === 'system');
      const rest = messages.filter((m) => m.role !== 'system' && String(m.content || '').trim());
      const tail = rest.slice(-keep);
      const head = rest.slice(0, Math.max(0, rest.length - keep));

      if (!head.length) {
        return {
          ok: true,
          text: `当前可压缩消息只有 ${rest.length} 条，不超过保留数 ${keep} 条，无需压缩。`,
          data: { changed: false, before: listTok(messages), after: listTok(messages) },
        };
      }

      const before = listTok(messages);
      const src = head.map((m) => {
        const role = m.role === 'tool' ? '工具结果' : (m.role === 'user' ? '用户' : '助手');
        return `${role}：${cap(String(m.content || '').replace(/\s+/g, ' ').trim(), m.role === 'tool' ? 400 : 1200)}`;
      }).join('\n');

      if (args.dry_run) {
        const est = Math.max(0, before - listTok(head) + target);
        return {
          ok: true,
          text: `预演（未调用模型）：可把 ${head.length} 条早期消息压成约 ${target} tokens 的摘要，\n上下文 tokens：约 ${before} → 约 ${est}（可省 ${before - est}）。`,
          data: { changed: false, dryRun: true, before, estimateAfter: est, headCount: head.length, keep: tail.length },
        };
      }

      const key = store.getApiKey();
      if (!key) return { ok: false, text: '本机未配置 API Key，无法调用子模型压缩上下文。' };
      const s = store.rawSettings ? store.rawSettings() : {};
      const base = String(s.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
      const model = String(args.model || s.model || 'deepseek-chat');

      const guide = detailed
        ? '保留关键事实、数字、结论、代码片段与文件路径，可分点但不要展开无关细节。'
        : '只保留结论、关键事实与未完成事项，尽量简短。';
      const extra = args.instruction ? `\n额外要求：${String(args.instruction).slice(0, 500)}` : '';
      const prompt = [
        `把下面这段对话历史压缩成不超过 ${target} tokens 的摘要，供后续对话继续使用。`,
        guide,
        '不要编造、不要加评论，用中文，直接输出摘要正文。' + extra,
        '',
        src,
      ].join('\n');

      let summary = '';
      try {
        const r = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            max_tokens: Math.min(4096, Math.max(256, target * 2)),
          }),
          signal: AbortSignal.timeout(60000),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) return { ok: false, text: `压缩失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}` };
        summary = String(j.choices?.[0]?.message?.content || '').trim();
      } catch (e) {
        return { ok: false, text: `压缩请求失败：${e.message}` };
      }
      if (!summary) return { ok: false, text: '子模型没有返回摘要内容，请重试或换模型。' };

      const merged = [...sys, { role: 'assistant', content: `【此前对话摘要】\n${summary}` }, ...tail];
      const after = listTok(merged);
      const saved = Math.max(0, before - after);
      const pct = before > 0 ? Math.round((saved / before) * 100) : 0;

      const lines = [
        `已压缩 ${head.length} 条早期消息 → 1 段摘要（保留最近 ${tail.length} 条原文）`,
        `上下文 tokens：约 ${before} → 约 ${after}（节省 ${saved}，${pct}%）`,
        `压缩模型：${model}`,
        '',
        '摘要内容：',
        cap(summary, 1200),
        '',
        '说明：本工具只返回压缩结果，不改写会话历史；需要替换时请用户确认后由前端应用。',
      ];
      return {
        ok: true,
        text: lines.join('\n'),
        data: { changed: true, convId, before, after, saved, pct, headCount: head.length, keep: tail.length, model, summary, messages: merged },
      };
    },

    async search_history(args = {}) {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, text: '缺少 query 参数。' };
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const lower = q.toLowerCase();
      const hits = [];
      for (const c of store.listConversations()) {
        const title = c.title || '';
        let snippet = '';
        for (const m of c.messages || []) {
          const content = String(m.content || '');
          const idx = content.toLowerCase().indexOf(lower);
          if (idx >= 0) {
            snippet = content.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ');
            break;
          }
        }
        if (title.toLowerCase().includes(lower) || snippet) {
          hits.push({ id: c.id, title: title || '(无标题)', updatedAt: c.updatedAt || c.createdAt, snippet });
        }
        if (hits.length >= limit) break;
      }
      if (!hits.length) return { ok: true, text: `没有找到包含「${q}」的历史对话。`, data: [] };
      const text = hits.map((h, i) => `${i + 1}. [${h.title}]（${new Date(h.updatedAt).toLocaleString('zh-CN')}）${h.snippet ? '\n   …' + h.snippet + '…' : ''}`).join('\n');
      return { ok: true, text, data: hits };
    },

    async usage_stats() {
      const convs = store.listConversations();
      let msgs = 0, prompt = 0, completion = 0, hit = 0, tools = 0;
      const byModel = {};
      for (const c of convs) {
        for (const m of c.messages || []) {
          msgs++;
          if (m.usage) {
            prompt += m.usage.prompt_tokens || 0;
            completion += m.usage.completion_tokens || 0;
            hit += m.usage.prompt_cache_hit_tokens || 0;
            const st = m.usage.server_tool_use || {};
            tools += (st.tool_search || 0) + (st.tool_fetch || 0) + (st.tool_image_search || 0);
            const k = m.model || 'unknown';
            byModel[k] = (byModel[k] || 0) + (m.usage.total_tokens || 0);
          }
        }
      }
      const text = [
        `对话 ${convs.length} 个，消息 ${msgs} 条`,
        `累计输入 ${prompt} tokens（缓存命中 ${hit}），输出 ${completion} tokens，联网工具调用 ${tools} 次`,
        Object.keys(byModel).length ? '按模型 token：' + Object.entries(byModel).map(([k, v]) => `${k}=${v}`).join('，') : '暂无用量记录',
      ].join('\n');
      return { ok: true, text, data: { conversations: convs.length, messages: msgs, prompt, completion, hit, tools, byModel } };
    },

    async web_search(args = {}) {
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, text: '缺少 query 参数。' };
      const count = Math.min(20, Math.max(1, Number(args.count) || 8));
      const engines = [['bing-rss', searchBingRss], ['bing-html', searchBingHtml], ['360', search360]];
      const errors = [];
      let results = [];
      let used = '';
      for (const [name, engine] of engines) {
        try {
          const rows = await engine(query, count);
          if (rows.length) { results = rows; used = name; break; }
          errors.push(name + ' 无结果');
        } catch (e) {
          errors.push(name + ' 失败：' + e.message);
        }
      }
      if (!results.length) {
        return { ok: false, text: `搜索「${query}」没有拿到结果（${errors.join('；')}）。可以换个关键词重试，或直接让用户提供网址。` };
      }
      // 去重后按搜索引擎给出的顺序输出
      const seen = new Set();
      const list = [];
      for (const r of results) {
        const key = r.url.replace(/[#?].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(r);
        if (list.length >= count) break;
      }
      const body = list.map((r, i) => {
        const bits = [r.title, r.url];
        if (r.snippet) bits.push(r.snippet);
        if (r.date) bits.push('时间：' + r.date);
        return `${i + 1}. ${bits[0]}\n   ${bits[1]}${bits[2] ? '\n   ' + bits[2] : ''}${bits[3] ? '\n   ' + bits[3] : ''}`;
      }).join('\n');
      const text = `搜索「${query}」共 ${list.length} 条（来源 ${used}）：\n${body}\n\n提示：需要原文细节时用 fetch_url 打开上面最相关的链接。`;
      return { ok: true, text, data: { query, engine: used, results: list } };
    },

    async fetch_url(args = {}) {
      const raw = String(args.url || '').trim();
      if (!raw) return { ok: false, text: '缺少 url 参数。' };
      const url = assertPublicUrl(raw);
      const maxChars = Math.min(40000, Math.max(500, Number(args.max_chars) || 8000));

      const res = await fetchDoc(url);
      if (!res.ok) {
        return { ok: false, text: `抓取失败：HTTP ${res.status}（${url}）。可以换个链接或改用搜索引擎摘要。` };
      }
      const ct = res.contentType.toLowerCase();
      if (/application\/(pdf|zip|octet-stream)|image\/|video\/|audio\//.test(ct)) {
        return { ok: false, text: `该链接不是网页正文（${res.contentType.split(';')[0]}），无法提取文本：${url}` };
      }

      let title = '';
      let text = '';
      if (/json|javascript/.test(ct) || /^\s*[[{]/.test(res.text.slice(0, 64))) {
        try { text = JSON.stringify(JSON.parse(res.text), null, 2); }
        catch { text = res.text; }
      } else if (/html|xml/.test(ct) || /<html|<body|<div/i.test(res.text.slice(0, 2048))) {
        const parsed = htmlToText(res.text);
        title = parsed.title;
        text = parsed.text;
      } else {
        text = res.text.replace(/\r/g, '').trim();
      }

      if (!text) return { ok: false, text: `页面里没有提取到正文（可能是纯前端渲染或缺内容）：${url}` };

      const total = text.length;
      const cut = total > maxChars;
      if (cut) text = text.slice(0, maxChars);
      const head = [`链接：${res.finalUrl}`, title ? `标题：${title}` : '', res.charset !== 'utf-8' ? `编码：${res.charset}` : '']
        .filter(Boolean).join('\n');
      const tail = cut ? `\n\n（正文共 ${total} 字，已截断到前 ${maxChars} 字；需要更多可提高 max_chars 或分段抓取）` : '';
      return { ok: true, text: `${head}\n\n${text}${tail}`, data: { url: res.finalUrl, title, total, truncated: cut } };
    },

    async calculator(args = {}) {
      const expression = String(args.expression || '').trim();
      if (!expression) return { ok: false, text: '缺少 expression 参数。' };
      const precision = Math.min(12, Math.max(0, Number(args.precision) || 0));
      let value;
      try { value = evalArithmetic(expression); }
      catch (e) { return { ok: false, text: `计算失败：${e.message}。表达式 ${expression}` }; }
      const result = Number(value.toFixed(precision));
      return { ok: true, text: `${expression} = ${result}`, data: { expression, value: result } };
    },

    async hash_text(args = {}) {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      let alg = String(args.algorithm || 'sha256').toLowerCase().trim();
      // 兼容常见写法：SHA3_256 / SHA3-256 / sha3256 → sha3-256
      alg = alg.replace(/^sha3[\s_-]*(224|256|384|512)$/, 'sha3-$1');
      const ALGS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
        'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512'];
      if (!ALGS.includes(alg)) {
        return { ok: false, text: '不支持的算法 ' + alg + '，可选 ' + ALGS.join(' / ') + '。' };
      }
      const digest = crypto.createHash(alg).update(text, 'utf8').digest('hex');
      return { ok: true, text: `${alg}（${text.length} 字符）：${digest}`, data: { algorithm: alg, digest } };
    },

    async base64_codec(args = {}) {
      const text = String(args.text ?? '');
      const mode = String(args.mode || 'encode').toLowerCase();
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      if (mode === 'encode') {
        const out = Buffer.from(text, 'utf8').toString('base64');
        return { ok: true, text: out, data: { mode, result: out } };
      }
      if (mode === 'decode') {
        try {
          const buf = Buffer.from(text, 'base64');
          const out = buf.toString('utf8');
          if (!out) return { ok: false, text: '解码结果为空，请确认输入是合法的 Base64。' };
          return { ok: true, text: out, data: { mode, result: out } };
        } catch (e) { return { ok: false, text: 'Base64 解码失败：' + e.message }; }
      }
      return { ok: false, text: 'mode 只能是 encode 或 decode。' };
    },

    async url_codec(args = {}) {
      const text = String(args.text ?? '');
      const mode = String(args.mode || 'encode').toLowerCase();
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      try {
        const out = mode === 'decode' ? decodeURIComponent(text) : encodeURIComponent(text);
        return { ok: true, text: out, data: { mode, result: out } };
      } catch (e) { return { ok: false, text: 'URL 处理失败：' + e.message }; }
    },

    async json_format(args = {}) {
      const raw = String(args.json ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 json 参数。' };
      let obj;
      try { obj = JSON.parse(raw); }
      catch (e) { return { ok: false, text: 'JSON 解析失败：' + e.message }; }
      let target = obj;
      const path = String(args.path || '').trim();
      if (path) {
        for (const key of path.split('.')) {
          if (target === null || typeof target !== 'object' || !(key in target)) {
            return { ok: false, text: `路径 ${path} 不存在（在「${key}」处断开）。` };
          }
          target = target[key];
        }
      }
      const indent = Math.min(8, Math.max(0, Number(args.indent) || 2));
      const out = typeof target === 'string' ? target : JSON.stringify(target, null, indent);
      return { ok: true, text: out, data: { valid: true, type: Array.isArray(target) ? 'array' : typeof target } };
    },

    async text_stats(args = {}) {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      const chars = [...text].length;
      const charsNoSpace = [...text.replace(/\s/g, '')].length;
      const lines = text.split(/\r\n|\r|\n/).length;
      const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
      const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
      const words = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
      const text2 = `字符 ${chars}（不含空白 ${charsNoSpace}），行数 ${lines}，段落 ${paragraphs}，中文汉字 ${cjk}，英文/数字词 ${words}`;
      return { ok: true, text: text2, data: { chars, charsNoSpace, lines, paragraphs, cjk, words } };
    },

    async uuid_gen(args = {}) {
      const count = Math.min(50, Math.max(1, Number(args.count) || 1));
      const list = Array.from({ length: count }, () => crypto.randomUUID());
      return { ok: true, text: list.join('\n'), data: { uuids: list } };
    },

    async random_pick(args = {}) {
      const count = Math.min(50, Math.max(1, Number(args.count) || 1));
      const unique = args.unique === true;
      if (Array.isArray(args.items) && args.items.length) {
        const items = args.items.map(String);
        if (unique && count > items.length) return { ok: false, text: `unique=true 时数量不能超过候选数（${items.length}）。` };
        const pool = unique ? [...items] : items;
        const picks = [];
        for (let i = 0; i < count; i++) {
          const idx = crypto.randomInt(0, pool.length);
          picks.push(unique ? pool.splice(idx, 1)[0] : pool[idx]);
        }
        return { ok: true, text: picks.join('\n'), data: { picks } };
      }
      const min = Number.isFinite(Number(args.min)) ? Math.ceil(Number(args.min)) : 1;
      const max = Number.isFinite(Number(args.max)) ? Math.floor(Number(args.max)) : 100;
      if (max < min) return { ok: false, text: 'max 不能小于 min。' };
      if (max - min > 1e9) return { ok: false, text: '随机范围过大（上限 1e9）。' };
      const nums = [];
      for (let i = 0; i < count; i++) nums.push(crypto.randomInt(min, max + 1));
      return { ok: true, text: nums.join('\n'), data: { picks: nums } };
    },

    /* ---------- 网络小工具 ---------- */
    async dns_lookup(args = {}) {
      const hostname = String(args.hostname || '').trim();
      if (!hostname) return { ok: false, text: '缺少 hostname 参数。' };
      const family = [0, 4, 6].includes(Number(args.family)) ? Number(args.family) : 0;
      try {
        const addresses = await new Promise((resolve, reject) => {
          dns.lookup(hostname, { all: true, family, verbatim: true }, (err, addrs) => err ? reject(err) : resolve(addrs || []));
        });
        if (!addresses.length) return { ok: false, text: `${hostname} 没有解析到地址。` };
        const lines = addresses.map((a) => `${a.family === 6 ? 'IPv6' : 'IPv4'}  ${a.address}`);
        return { ok: true, text: `${hostname} 解析结果（${addresses.length} 条）：\n${lines.join('\n')}`, data: { hostname, addresses } };
      } catch (e) { return { ok: false, text: `解析 ${hostname} 失败：${e.message}` }; }
    },

    async port_check(args = {}) {
      const host = String(args.host || '').trim();
      const port = Number(args.port);
      if (!host) return { ok: false, text: '缺少 host 参数。' };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, text: 'port 必须是 1-65535 的整数。' };
      const timeout = Math.min(15000, Math.max(300, Number(args.timeout_ms) || 3000));
      const started = Date.now();
      return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (ok, text) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve({ ok, text, data: { host, port, reachable: ok, ms: Date.now() - started } });
        };
        socket.setTimeout(timeout);
        socket.on('connect', () => finish(true, `${host}:${port} 可连通（${Date.now() - started}ms）`));
        socket.on('timeout', () => finish(false, `${host}:${port} 连接超时（${timeout}ms，可能防火墙拦截或端口未开放）`));
        socket.on('error', (e) => finish(false, `${host}:${port} 不可达：${e.code || e.message}`));
        socket.connect(port, host);
      });
    },

    async sub_agent(args = {}) {
      const target = args.target === 'local' ? 'local' : 'cloud';
      const cfg = subAgentConfig(store.rawSettings ? store.rawSettings().subAgent : null);

      // 设置面板的「测试连接」：不跑任务，只探活并回显可用模型/HTTP 状态
      if (target === 'local' && args.action === 'test') {
        // 允许把当前表单配置随请求带来测试（设置落盘有 250ms 防抖，避免测到旧值）
        const patch = sanitizeSubAgentPatch(args.config || {});
        return testLocalSubAgent({ ...cfg, ...patch });
      }

      // local 的 config 子工具：不带 config 就返回当前配置；带就按白名单改
      if (target === 'local' && args.action === 'config') {
        if (!args.config || typeof args.config !== 'object') {
          return { ok: true, text: '本地子智能体当前配置：\n' + JSON.stringify(cfg, null, 2), data: cfg };
        }
        const patch = sanitizeSubAgentPatch(args.config);
        if (!Object.keys(patch).length) {
          return { ok: false, text: 'config 里没有可识别的字段。可用字段：' + Object.keys(SUB_AGENT_DEFAULTS).join(', ') };
        }
        store.patchSettings({ subAgent: { ...cfg, ...patch } });
        const now = { ...cfg, ...patch };
        return { ok: true, text: '已更新本地子智能体配置：\n' + JSON.stringify(patch, null, 2) + '\n\n当前完整配置：\n' + JSON.stringify(now, null, 2), data: now };
      }

      if (!cfg.enabled) return { ok: false, text: '子智能体已在设置里关闭（sub_agent）。' };
      if (!args.task || !String(args.task).trim()) return { ok: false, text: '缺少 task：请描述要子智能体完成的任务。' };
      const ctx = { args, cfg, definitions, store, call, log };
      return target === 'cloud' ? await runCloudSubAgent(ctx) : await runLocalSubAgent(ctx);
    },

    async http_request(args = {}) {
      const raw = String(args.url || '').trim();
      if (!raw) return { ok: false, text: '缺少 url 参数。' };
      let url;
      try { url = assertPublicUrl(raw); }
      catch (e) { return { ok: false, text: e.message }; }
      const method = String(args.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'].includes(method)) {
        return { ok: false, text: '不支持的方法 ' + method + '，可选 GET/POST/PUT/DELETE/HEAD/PATCH。' };
      }
      const maxChars = Math.min(30000, Math.max(200, Number(args.max_chars) || 6000));
      const headers = {};
      if (args.headers && typeof args.headers === 'object') {
        for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
      }
      try {
        const r = await fetch(url, {
          method, headers, redirect: 'follow',
          body: (method === 'POST' || method === 'PUT' || method === 'PATCH') ? String(args.body ?? '') : undefined,
          signal: AbortSignal.timeout(20000),
        });
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type') || '';
        const charset = sniffCharset(buf, ct);
        let text = decodeBuf(buf, charset);
        const total = text.length;
        const cut = total > maxChars;
        if (cut) text = text.slice(0, maxChars);
        if (/json|javascript/.test(ct) || /^\s*[[{]/.test(text.slice(0, 64))) {
          try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
        }
        const hs = [];
        for (const [k, v] of r.headers.entries()) {
          if (!hs.length || hs.length < 20) hs.push(`${k}: ${v}`);
        }
        const out = [
          `${method} ${url}`,
          `状态：${r.status} ${r.statusText}`,
          `最终地址：${r.url}`,
          `响应头：\n${hs.slice(0, 20).join('\n')}`,
          `正文${cut ? `（共 ${total} 字，截断到前 ${maxChars} 字）` : ''}：\n${text.slice(0, maxChars) || '（空）'}`,
        ].join('\n\n');
        return { ok: r.ok, text: out, data: { status: r.status, finalUrl: r.url, contentType: ct, truncated: cut } };
      } catch (e) { return { ok: false, text: `请求失败：${e.message}` }; }
    },

    async local_ip(args = {}) {
      const rows = [];
      const ifaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const a of addrs || []) {
          if (a.internal && a.family !== 'IPv4') continue;
          rows.push(`${name}  ${a.family}  ${a.address}${a.netmask ? '  掩码 ' + a.netmask : ''}${a.internal ? '  (回环)' : ''}`);
        }
      }
      return { ok: true, text: rows.join('\n') || '（没有探测到网络接口）', data: { interfaces: ifaces } };
    },

    /* ---------- 运算小工具 ---------- */
    async base_convert(args = {}) {
      const raw = String(args.value ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 value 参数。' };
      const from = Number(args.from) || 10;
      const to = Number(args.to) || 16;
      if (![2, 8, 10, 16].includes(from) || ![2, 8, 10, 16].includes(to)) {
        return { ok: false, text: '进制只能是 2 / 8 / 10 / 16。' };
      }
      const value = parseInt(raw, from);
      if (!Number.isFinite(value)) return { ok: false, text: `「${raw}」不是合法的 ${from} 进制数字。` };
      const out = value.toString(to);
      const shown = to === 16 ? out.toUpperCase() : out;
      return { ok: true, text: `${raw}（${from} 进制）= ${shown}（${to} 进制）`, data: { decimal: value, value: shown } };
    },

    async percentage(args = {}) {
      const mode = String(args.mode || '').toLowerCase();
      const a = Number(args.a), b = Number(args.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, text: 'a 和 b 必须是数字。' };
      const r = (n) => Number(n.toFixed(6));
      let text, value;
      switch (mode) {
        case 'ratio':
          if (b === 0) return { ok: false, text: '分母 b 不能为 0。' };
          value = r(a / b * 100); text = `${a} 占 ${b} 的 ${value}%`; break;
        case 'growth':
          if (a === 0) return { ok: false, text: '原值 a 不能为 0。' };
          value = r((b - a) / a * 100); text = `从 ${a} 到 ${b}，${value >= 0 ? '增长' : '下降'} ${Math.abs(value)}%`; break;
        case 'discount':
          if (b < 0 || b > 100) return { ok: false, text: '折扣 b 用百分数表示（如 75 表示打 7.5 折），应在 0-100 之间。' };
          value = r(a * b / 100); text = `原价 ${a} 打 ${b / 10} 折（即 ${b}%） = ${value}`; break;
        case 'increase':
          value = r(a * (1 + b / 100)); text = `${a} 增加 ${b}% = ${value}`; break;
        default:
          return { ok: false, text: 'mode 只能是 ratio / growth / discount / increase。' };
      }
      return { ok: true, text, data: { mode, value } };
    },

    async date_diff(args = {}) {
      const parse = (s) => {
        if (!s || !String(s).trim()) return new Date();
        const d = new Date(String(s).trim());
        if (isNaN(d.getTime())) throw new Error(`无法解析日期「${s}」`);
        return d;
      };
      let from, to;
      try { from = parse(args.from); to = parse(args.to); }
      catch (e) { return { ok: false, text: e.message }; }
      const ms = to.getTime() - from.getTime();
      const abs = Math.abs(ms);
      const days = Math.floor(abs / 86400000);
      const hours = Math.floor((abs % 86400000) / 3600000);
      const minutes = Math.floor((abs % 3600000) / 60000);
      const text = `${from.toISOString()} → ${to.toISOString()}：相差 ${days} 天 ${hours} 小时 ${minutes} 分钟（${ms >= 0 ? '正向' : '倒退'} ${Math.round(abs / 1000)} 秒）`;
      return { ok: true, text, data: { from: from.toISOString(), to: to.toISOString(), ms, days, hours, minutes } };
    },

    async unit_convert(args = {}) {
      const value = Number(args.value);
      const from = String(args.from || '').toLowerCase().trim();
      const to = String(args.to || '').toLowerCase().trim();
      if (!Number.isFinite(value)) return { ok: false, text: 'value 必须是数字。' };
      const GROUPS = {
        length: { km: 1000, m: 1, cm: 0.01, mm: 0.001, inch: 0.0254, '英寸': 0.0254, ft: 0.3048, '英尺': 0.3048, mile: 1609.344, '英里': 1609.344 },
        weight: { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, '磅': 0.45359237, oz: 0.028349523125, '盎司': 0.028349523125 },
        data: { b: 1, byte: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 },
        time: { s: 1, sec: 1, '秒': 1, min: 60, '分钟': 60, h: 3600, hour: 3600, '小时': 3600, d: 86400, day: 86400, '天': 86400 },
      };
      let group = null;
      for (const [g, units] of Object.entries(GROUPS)) {
        if (from in units && to in units) { group = g; break; }
      }
      if (group) {
        const units = GROUPS[group];
        const out = value * units[from] / units[to];
        return { ok: true, text: `${value} ${from} = ${Number(out.toPrecision(12))} ${to}`, data: { value: Number(out.toPrecision(12)), group } };
      }
      // 温度单独处理（非线性）
      const toC = (v, u) => ({ c: v, 'c': v, '摄氏度': v, f: (v - 32) * 5 / 9, 'f': (v - 32) * 5 / 9, '华氏度': (v - 32) * 5 / 9, k: v - 273.15, 'k': v - 273.15, '开尔文': v - 273.15 })[u];
      const fromC = (v, u) => ({ c: v, 'c': v, '摄氏度': v, f: v * 9 / 5 + 32, 'f': v * 9 / 5 + 32, '华氏度': v * 9 / 5 + 32, k: v + 273.15, 'k': v + 273.15, '开尔文': v + 273.15 })[u];
      const c = toC(value, from), out = fromC(c, to);
      if (c === undefined || out === undefined || !Number.isFinite(out)) {
        return { ok: false, text: `不支持的单位组合 ${from} → ${to}。支持长度/重量/数据/时间/温度（c/f/k）。` };
      }
      return { ok: true, text: `${value} ${from} = ${Number(out.toFixed(6))} ${to}`, data: { value: Number(out.toFixed(6)), group: 'temperature' } };
    },

    /* ---------- 广义计算 / 文本处理实现 ---------- */
    async regex_test(args = {}) {
      const pattern = String(args.pattern ?? '');
      const flags = String(args.flags ?? 'g');
      const text = String(args.text ?? '');
      if (!pattern) return { ok: false, text: '缺少 pattern 参数。' };
      if (text.length > 100000) return { ok: false, text: '文本过长（最多 10 万字符），请先截取。' };
      let re;
      try { re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); }
      catch (e) { return { ok: false, text: '正则表达式错误：' + e.message }; }
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const rows = [];
      let m, guard = 0;
      const started = Date.now();
      while ((m = re.exec(text)) && rows.length < limit && guard++ < limit * 2) {
        const g = {};
        for (const [k, v] of Object.entries(m.groups || {})) g[k] = v ?? '';
        rows.push({ match: m[0], index: m.index, groups: Object.keys(g).length ? g : undefined });
        if (!m[0]) re.lastIndex++;
      }
      const body = rows.map((r, i) =>
        `${i + 1}. 「${r.match}」 @${r.index}${r.groups ? '\n   分组：' + JSON.stringify(r.groups) : ''}`).join('\n');
      const text2 = `匹配 ${rows.length} 条${rows.length >= limit ? `（已到上限 ${limit}）` : ''}，耗时 ${Date.now() - started}ms：\n${body || '（没有匹配）'}`;
      return { ok: true, text: text2, data: { matches: rows } };
    },

    async diff_text(args = {}) {
      const a = String(args.a ?? '').split(/\r?\n/);
      const b = String(args.b ?? '').split(/\r?\n/);
      const context = args.context === true;
      // LCS 动态规划（行级），文本较大时限制规模避免 O(n*m) 爆炸
      if (a.length * b.length > 4e6) return { ok: false, text: '文本行数过多（LCS 矩阵超过 400 万格），请先截取。' };
      const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const rows = [];
      let i = 0, j = 0, same = 0, added = 0, removed = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { rows.push(`  ${a[i]}`); same++; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(`- ${a[i]}`); removed++; i++; }
        else { rows.push(`+ ${b[j]}`); added++; j++; }
      }
      while (i < a.length) { rows.push(`- ${a[i++]}`); removed++; }
      while (j < b.length) { rows.push(`+ ${b[j++]}`); added++; }
      const shown = context ? rows : rows.filter((r) => !r.startsWith('  '));
      const head = `相同 ${same} 行，新增 ${added} 行，删除 ${removed} 行`;
      return { ok: true, text: head + '\n\n' + (shown.join('\n') || '（无差异）'), data: { same, added, removed } };
    },

    async csv_json(args = {}) {
      const mode = String(args.mode || '').toLowerCase();
      const d = String(args.delimiter || ',').slice(0, 1) || ',';
      const raw = String(args.text ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 text 参数。' };
      const parseCsv = (s) => {
        const rows = []; let row = [], cell = '', quoted = false;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (quoted) {
            if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
          } else if (c === '"') quoted = true;
          else if (c === d) { row.push(cell); cell = ''; }
          else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
          else if (c !== '\r') cell += c;
        }
        if (cell || row.length) { row.push(cell); rows.push(row); }
        return rows.filter((r) => r.some((x) => x !== ''));
      };
      const toCsv = (val) => {
        const esc = (v) => {
          const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
          return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        return val.map((r) => r.map(esc).join(d)).join('\r\n');
      };
      try {
        if (mode === 'tojson') {
          const rows = parseCsv(raw);
          if (rows.length < 2) return { ok: false, text: 'CSV 至少需要表头 + 一行数据。' };
          const head = rows[0];
          const list = rows.slice(1).map((r) => {
            const o = {};
            head.forEach((h, i) => { o[h] = r[i] ?? ''; });
            return o;
          });
          return { ok: true, text: JSON.stringify(list, null, 2), data: { rows: list.length } };
        }
        if (mode === 'tocsv') {
          let obj;
          try { obj = JSON.parse(raw); } catch (e) { return { ok: false, text: 'JSON 解析失败：' + e.message }; }
          if (!Array.isArray(obj) || !obj.length) return { ok: false, text: '需要非空 JSON 数组。' };
          const keys = [...new Set(obj.flatMap((o) => Object.keys(o || {})))];
          const q = (v) => {
            const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          };
          const lines = [keys.join(d), ...obj.map((o) => keys.map((k) => q(o?.[k])).join(d))];
          return { ok: true, text: lines.join('\r\n'), data: { rows: obj.length } };
        }
        return { ok: false, text: 'mode 只能是 toJson 或 toCsv。' };
      } catch (e) { return { ok: false, text: '转换失败：' + e.message }; }
    },

    async slugify(args = {}) {
      const raw = String(args.text ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 text 参数。' };
      const sep = String(args.separator ?? '-').slice(0, 3) || '-';
      const lower = args.lower !== false;
      let s = raw
        .replace(/['"’“”]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, sep)
        .replace(new RegExp(sep + '+', 'g'), sep)
        .replace(new RegExp('^' + sep + '|' + sep + '$', 'g'), '');
      if (lower) s = s.toLowerCase();
      return { ok: true, text: s || sep, data: { slug: s } };
    },

    async password_gen(args = {}) {
      const length = Math.min(128, Math.max(4, Number(args.length) || 16));
      const count = Math.min(20, Math.max(1, Number(args.count) || 1));
      const sets = [];
      if (args.upper !== false) sets.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      if (args.lower !== false) sets.push('abcdefghijklmnopqrstuvwxyz');
      if (args.digits !== false) sets.push('0123456789');
      if (args.symbols !== false) sets.push('!@#$%^&*()-_=+[]{};:,.?/');
      if (!sets.length) return { ok: false, text: '至少启用一种字符集。' };
      let pool = sets.join('');
      if (args.excludeAmbiguous !== false) pool = pool.replace(/[0O1lI|]/g, '');
      // 保证每类至少一个字符
      const must = sets.map((s) => {
        const p = args.excludeAmbiguous !== false ? s.replace(/[0O1lI|]/g, '') : s;
        return p[crypto.randomInt(0, p.length)] || s[0];
      });
      const list = [];
      for (let n = 0; n < count; n++) {
        const chars = [...must];
        while (chars.length < length) chars.push(pool[crypto.randomInt(0, pool.length)]);
        // Fisher-Yates 洗牌
        for (let i = chars.length - 1; i > 0; i--) {
          const j = crypto.randomInt(0, i + 1);
          [chars[i], chars[j]] = [chars[j], chars[i]];
        }
        list.push(chars.join(''));
      }
      const entropy = Math.round(length * Math.log2(pool.length));
      const strength = entropy >= 100 ? '强' : entropy >= 65 ? '中' : '弱';
      return {
        ok: true,
        text: list.join('\n') + `\n\n估算熵 ${entropy} bit（${strength}），池大小 ${pool.length}`,
        data: { passwords: list, entropyBits: entropy, strength },
      };
    },

    async id_validator(args = {}) {
      const type = String(args.type || '').toLowerCase();
      const value = String(args.value ?? '').trim();
      if (!value) return { ok: false, text: '缺少 value 参数。' };
      let ok = false, detail = '';
      if (type === 'idcard') {
        if (!/^\d{17}[\dXx]$/.test(value)) { detail = '格式应为 17 位数字 + 校验位'; }
        else {
          const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
          const codes = '10X98765432';
          let sum = 0;
          for (let i = 0; i < 17; i++) sum += Number(value[i]) * w[i];
          const check = codes[sum % 11];
          ok = value[17].toUpperCase() === check;
          detail = ok ? '校验位正确' : `校验位应为 ${check}（实际 ${value[17]}）`;
          const y = Number(value.slice(6, 10)), m = Number(value.slice(10, 12)), d = Number(value.slice(12, 14));
          const dt = new Date(y, m - 1, d);
          if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d) { ok = false; detail += '；出生日期无效'; }
        }
      } else if (type === 'email') {
        ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
        detail = ok ? '邮箱格式正确' : '邮箱格式不正确';
      } else if (type === 'phone') {
        ok = /^1[3-9]\d{9}$/.test(value);
        detail = ok ? '中国大陆手机号格式正确' : '不是合法的中国大陆手机号';
      } else if (type === 'ipv4') {
        const parts = value.split('.');
        ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
        detail = ok ? 'IPv4 格式正确' : '不是合法的 IPv4 地址';
      } else if (type === 'uuid') {
        ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
        detail = ok ? 'UUID 格式正确' : '不是合法的 UUID（v1-v5）';
      } else {
        return { ok: false, text: 'type 只能是 idcard / email / phone / ipv4 / uuid。' };
      }
      return { ok, text: `${value}：${ok ? '✅ 合法' : '❌ 不合法'}（${detail}）`, data: { type, value, valid: ok, detail } };
    },

    async timestamp_convert(args = {}) {
      const raw = String(args.value ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 value 参数。' };
      let d;
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        const unit = String(args.unit || '').toLowerCase();
        const ms = unit === 's' ? n * 1000 : unit === 'ms' ? n : (raw.length <= 10 ? n * 1000 : n);
        d = new Date(ms);
      } else {
        d = new Date(raw.replace(/-/g, '/'));
      }
      if (isNaN(d.getTime())) return { ok: false, text: `无法解析时间「${raw}」。` };
      const off = Number.isFinite(Number(args.offsetHours)) ? Number(args.offsetHours) : null;
      const shown = off === null ? d.toString() : new Date(d.getTime() + off * 3600000).toISOString().replace('Z', `（UTC${off >= 0 ? '+' : ''}${off}）`);
      const text = [
        `UTC：${d.toISOString()}`,
        `本地：${d.toString()}`,
        off !== null ? `UTC${off >= 0 ? '+' : ''}${off}：${shown}` : '',
        `Unix 秒：${Math.floor(d.getTime() / 1000)}`,
        `Unix 毫秒：${d.getTime()}`,
      ].filter(Boolean).join('\n');
      return { ok: true, text, data: { iso: d.toISOString(), seconds: Math.floor(d.getTime() / 1000), ms: d.getTime() } };
    },

    async json_minify(args = {}) {
      const raw = String(args.json ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 json 参数。' };
      let obj;
      try { obj = JSON.parse(raw); }
      catch (e) { return { ok: false, text: 'JSON 解析失败：' + e.message }; }
      const out = JSON.stringify(obj);
      return { ok: true, text: out, data: { before: raw.length, after: out.length, saved: raw.length - out.length } };
    },

    async token_count(args = {}) {
      const text = String(args.text ?? '');
      const detail = args.detail === true;
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      try {
        // 普通模式：require 本地模块；SEA 内联模式：build.mjs 注入全局 tokenize 函数
        const fn = (typeof globalThis.__dsTokenize === 'function')
          ? globalThis.__dsTokenize
          : require('./tokenizer-core.cjs').tokenize;
        const r = fn(text, { detail });
        const vocabSize = r.vocabSize || 128000;
        const lines = [
          `分词器：DeepSeek V4.1-Flash（deepseek-flash，词表 ${vocabSize}）`,
          `字符数：${[...text].length}（UTF-8 ${Buffer.byteLength(text, 'utf8')} 字节）`,
          `Token 数：${r.count}`,
        ];
        if (detail) {
          lines.push('', 'Token 明细（id : 片段）：');
          lines.push(r.ids.map((id, i) => `${id}:${JSON.stringify(r.tokens[i])}`).join('  '));
        }
        return { ok: true, text: lines.join('\n'), data: { tokens: r.count, ids: r.ids, pieces: r.tokens, model: r.model, vocabSize } };
      } catch (e) { return { ok: false, text: '分词失败：' + e.message }; }
    },

    async find_tool(args = {}) {
      const action = String(args.action || '').trim().toLowerCase();
      const query = String(args.query || '').trim();

      // 子指令 list：直接给全部工具目录（名字 + 一句话说明），不做检索
      const LIST_RE = /^(list|all|全部|全部工具|所有工具|列出|列出全部|目录)$/i;
      const isList = action === 'list' || args.list === true || (!action && LIST_RE.test(query));
      if (isList) {
        // cmd_run 未开启时不出现在目录里，避免模型对着一个被服务端拒绝的工具空转
        const raw = store.rawSettings && store.rawSettings();
        const cmdOn = raw?.cmdEnabled === true;
        const all = definitions.filter((d) => d.function.name !== 'find_tool' && (cmdOn || !d.meta?.cmd));
        const names = all.map((d) => d.function.name);
        const lines = all.map((d) => {
          const f = d.function;
          let brief = String(f.description || '').split(/[。；\n]/)[0].trim();
          if (brief.length > 60) brief = brief.slice(0, 58) + '…';
          return `- ${f.name} — ${brief}`;
        });
        return {
          ok: true,
          text: `可用工具共 ${all.length} 个${cmdOn ? '' : '（cmd_run 未开启，未列出）'}：\n\n${lines.join('\n')}\n\n这只是目录，已全部加入下一轮可用。需要某个工具的完整参数定义，用 find_tool(query="工具名或任务描述") 检索。`,
          data: { action: 'list', names, count: all.length, listed: true },
        };
      }

      if (!query) return { ok: false, text: '缺少 query 参数。想列出全部工具请传 action="list"。' };
      const topK = Math.min(10, Math.max(1, Number(args.top_k) || 5));
      const hits = searchToolDefs(definitions, query, topK);
      if (!hits.length) {
        return { ok: false, text: `没有找到与「${query}」相关的工具。可用工具共 ${definitions.length} 个：可以换更短的关键词重试，或调用 find_tool({action:"list"}) 看完整目录。` };
      }
      const names = hits.map((h) => h.name);
      const lines = hits.map((h) => {
        const f = h.def.function;
        const params = Object.entries(f.parameters?.properties || {})
          .map(([k, v]) => `${k}${v?.description ? '（' + v.description + '）' : ''}`).join('、');
        return `### ${h.name}（相关度 ${h.score}）\n${f.description}\n参数：${params || '无'}`;
      });
      return {
        ok: true,
        text: `找到 ${hits.length} 个相关工具（名字：${names.join(', ')}）：\n\n${lines.join('\n\n')}\n\n这些工具已在下一轮自动可用，直接按参数调用即可。`,
        data: { names, tools: hits.map((h) => h.def.function) },
      };
    },

    async qr_text(args = {}) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      const lv = String(args.level || 'M').toUpperCase();
      const level = ['L', 'M', 'Q', 'H'].includes(lv) ? lv : 'M';
      const scale = Math.min(20, Math.max(2, Number(args.scale) || 8));
      const buf = Buffer.from(text, 'utf8');
      if (buf.length > QR_INPUT_MAX) {
        return { ok: false, text: `内容 ${buf.length} 字节，超过上限 ${QR_INPUT_MAX} 字节。请精简内容，或先压缩（如 base64 前先 gzip）。` };
      }

      // 单张装不下就按「第 i/N 张」切段（切在 UTF-8 字符边界上），每段各自成一个二维码
      const cap = qrCapacity(QR_MAX_VERSION, level);
      const reserve = 12;                         // 给 "#1/6\n" 这类前缀留位置
      const chunks = [];
      if (buf.length <= cap) {
        chunks.push(buf);
      } else {
        const step = Math.max(64, cap - reserve);
        let start = 0;
        while (start < buf.length) {
          let end = Math.min(buf.length, start + step);
          while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;   // 不切开多字节字符
          if (end <= start) end = Math.min(buf.length, start + step);
          chunks.push(buf.subarray(start, end));
          start = end;
        }
      }
      const total = chunks.length;

      let base = '';
      try {
        base = path.join(dataDir || os.tmpdir(), 'qr');
        fs.mkdirSync(base, { recursive: true });
      } catch { base = ''; }
      const rawName = String(args.filename || '').replace(/[^\w.-]+/g, '_').slice(0, 40) || `qr-${Date.now()}`;
      const stem = rawName.replace(/\.png$/i, '');

      const files = [];
      let firstQr = null;
      for (let i = 0; i < total; i++) {
        const body = chunks[i].toString('utf8');
        const payload = total > 1 ? `#${i + 1}/${total}\n${body}` : body;
        let qr;
        try { qr = qrMatrix(payload, level); } catch (e) { return { ok: false, text: e.message }; }
        if (!firstQr) firstQr = qr;
        if (!base) continue;
        const file = path.join(base, (total > 1 ? `${stem}-${i + 1}of${total}` : stem) + '.png');
        try {
          fs.writeFileSync(file, qrPng(qr.matrix, scale));
          files.push(file);
        } catch { /* 单张写失败不影响其它 */ }
      }

      const shown = text.length > 160 ? text.slice(0, 160) + '…' : text;
      const lines = [];
      if (files.length === 1) lines.push(`二维码已保存：${files[0]}`);
      else if (files.length > 1) {
        lines.push(`内容 ${buf.length} 字节，单张放不下，已切成 ${total} 张二维码（扫码顺序按文件名/t 标题里的 #i/N）：`);
        for (const f of files) lines.push(`  ${f}`);
      } else {
        lines.push('（图片写入失败，已改为只输出字符画）');
      }
      lines.push(`内容：${shown}`);
      lines.push(`规格：版本 ${firstQr.version}，${firstQr.size}×${firstQr.size} 模块，纠错 ${level}，掩码 ${firstQr.mask}，${scale}px/模块${total > 1 ? `，共 ${total} 张` : ''}`);
      if (args.ascii || !files.length) lines.push('', qrAscii(firstQr.matrix));
      return {
        ok: true,
        text: lines.join('\n'),
        data: {
          path: files[0] || '', paths: files, parts: total, bytes: buf.length,
          version: firstQr.version, size: firstQr.size, level, mask: firstQr.mask, scale,
          ascii: qrAscii(firstQr.matrix),
        },
      };
    },

    async stat_calc(args = {}) {
      const raw = String(args.numbers ?? '').trim();
      if (!raw) return { ok: false, text: '缺少 numbers 参数。' };
      const parts = raw.split(/[\s,;，；、|]+/).filter(Boolean);
      const nums = [];
      for (const p of parts) {
        const n = Number(String(p).replace(/[¥$€£,:]/g, '').replace(/%$/, ''));
        if (!Number.isFinite(n)) return { ok: false, text: `「${p}」不是有效数字，请只用数字和分隔符。` };
        nums.push(n);
      }
      if (!nums.length) return { ok: false, text: '没有解析到数字。' };
      const p = Math.min(10, Math.max(0, Number(args.precision) || 4));
      const fix = (x) => (Number.isFinite(x) ? Number(x.toFixed(p)) : x);
      const n = nums.length;
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / n;
      const medianOf = (arr) => (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
      const median = medianOf(sorted);
      const half = Math.floor(n / 2);
      const q1 = medianOf(sorted.slice(0, half));
      const q3 = medianOf(sorted.slice(n % 2 ? half + 1 : half));
      const iqr = q3 - q1;
      const dev = nums.map((x) => x - mean);
      const varPop = dev.reduce((s, d) => s + d * d, 0) / n;
      const varSample = n > 1 ? dev.reduce((s, d) => s + d * d, 0) / (n - 1) : 0;
      const freq = new Map();
      for (const x of nums) freq.set(x, (freq.get(x) || 0) + 1);
      const maxFreq = Math.max(...freq.values());
      const modes = maxFreq > 1 ? [...freq.entries()].filter(([, c]) => c === maxFreq).map(([v]) => v) : [];
      const lo = sorted[0], hi = sorted[n - 1];
      const outLow = q1 - 1.5 * iqr;
      const outHigh = q3 + 1.5 * iqr;
      const outliers = sorted.filter((x) => x < outLow || x > outHigh);
      const lines = [
        `个数 ${n}`,
        `总和 ${fix(sum)}`,
        `均值 ${fix(mean)}`,
        `中位数 ${fix(median)}`,
        `众数 ${modes.length ? modes.map(fix).join(', ') : '无重复值'}`,
        `最小 ${fix(lo)}　最大 ${fix(hi)}　极差 ${fix(hi - lo)}`,
        `方差 样本 ${fix(varSample)}　总体 ${fix(varPop)}`,
        `标准差 样本 ${fix(Math.sqrt(varSample))}　总体 ${fix(Math.sqrt(varPop))}`,
        `四分位 Q1 ${fix(q1)}　Q3 ${fix(q3)}　IQR ${fix(iqr)}`,
        `异常值(1.5×IQR) ${outliers.length ? outliers.map(fix).join(', ') : '无'}`,
      ];
      return {
        ok: true,
        text: lines.join('\n'),
        data: { count: n, sum: fix(sum), mean: fix(mean), median: fix(median), modes, min: fix(lo), max: fix(hi), varianceSample: fix(varSample), variancePop: fix(varPop), stdSample: fix(Math.sqrt(varSample)), stdPop: fix(Math.sqrt(varPop)), q1: fix(q1), q3: fix(q3), iqr: fix(iqr), outliers },
      };
    },

    async hex_view(args = {}) {
      const mode = String(args.mode || '').toLowerCase();
      const raw = String(args.text ?? '');
      if (!raw) return { ok: false, text: '缺少 text 参数。' };
      const per = args.bytes_per_line === 0 ? 0 : Math.min(64, Math.max(1, Number(args.bytes_per_line) || 16));
      if (mode === 'tohex') {
        const buf = Buffer.from(raw, 'utf8');
        const lines = [];
        const width = per || buf.length || 1;
        for (let off = 0; off < buf.length; off += width) {
          const chunk = buf.subarray(off, off + width);
          const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const asc = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
          lines.push(per ? `${off.toString(16).padStart(8, '0')}  ${hex.padEnd(per * 3 - 1)}  |${asc}|` : hex);
        }
        return { ok: true, text: lines.join('\n') || '（空）', data: { bytes: buf.length, hex: buf.toString('hex') } };
      }
      if (mode === 'fromhex') {
        const clean = raw.replace(/0x|\\x|[\s,;:|]/gi, '');
        if (!/^[0-9a-f]*$/i.test(clean)) return { ok: false, text: '含有非十六进制字符，请检查输入（只允许 0-9 a-f 和分隔符）。' };
        if (clean.length % 2) return { ok: false, text: `十六进制长度为奇数（${clean.length} 位），可能少了半字节。` };
        const buf = Buffer.from(clean, 'hex');
        const text = buf.toString('utf8');
        const bad = (text.match(/\ufffd/g) || []).length;
        const note = bad ? `\n（含 ${bad} 个无法按 UTF-8 解码的字节，可能是二进制或 GBK 编码；原文另存为 base64：${buf.toString('base64').slice(0, 60)}…）` : '';
        return { ok: true, text: text + note, data: { bytes: buf.length, base64: buf.toString('base64'), utf8Errors: bad } };
      }
      return { ok: false, text: 'mode 只能是 toHex 或 fromHex。' };
    },

    async color_convert(args = {}) {
      const parseColor = (input) => {
        const s = String(input || '').trim();
        if (!s) return null;
        let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
        if (m) {
          let hex = m[1];
          if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
          return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), alpha: 1 };
        }
        m = /^rgba?\(([^)]+)\)$/i.exec(s);
        if (m) {
          const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          if (p.length >= 3 && p.slice(0, 3).every((x) => Number.isFinite(x))) {
            return { r: p[0], g: p[1], b: p[2], alpha: p[3] ?? 1 };
          }
        }
        m = /^hsla?\(([^)]+)\)$/i.exec(s);
        if (m) {
          const p = m[1].split(/[\s,/]+/).filter(Boolean);
          const h = parseFloat(p[0]);
          const sat = parseFloat(p[1]) / 100;
          const li = parseFloat(p[2]) / 100;
          if ([h, sat, li].every((x) => Number.isFinite(x))) {
            const k = (n) => (n + h / 30) % 12;
            const a = sat * Math.min(li, 1 - li);
            const f = (n) => li - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
            return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), alpha: p[3] ? parseFloat(p[3]) : 1 };
          }
        }
        const NAMED = { red: '#f00', green: '#008000', blue: '#00f', black: '#000', white: '#fff', gray: '#808080', grey: '#808080', orange: '#ffa500', yellow: '#ff0', purple: '#800080', pink: '#ffc0cb' };
        if (NAMED[s.toLowerCase()]) return parseColor(NAMED[s.toLowerCase()]);
        return null;
      };

      const toHsl = ({ r, g, b }) => {
        const rr = r / 255, gg = g / 255, bb = b / 255;
        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
          else if (max === gg) h = ((bb - rr) / d + 2) / 6;
          else h = ((rr - gg) / d + 4) / 6;
        }
        return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
      };
      const toHsv = ({ r, g, b }) => {
        const rr = r / 255, gg = g / 255, bb = b / 255;
        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
          if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
          else if (max === gg) h = ((bb - rr) / d + 2) / 6;
          else h = ((rr - gg) / d + 4) / 6;
        }
        return { h: Math.round(h * 360), s: Math.round((max === 0 ? 0 : d / max) * 100), v: Math.round(max * 100) };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const hexOf = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
      const contrast = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      const c = parseColor(args.color);
      if (!c) return { ok: false, text: '无法识别颜色。支持 #RGB、#RRGGBB、rgb(r,g,b)、hsl(h,s%,l%) 以及少量英文色名。' };
      const hsl = toHsl(c), hsv = toHsv(c);
      const L = lum(c);
      const white = { r: 255, g: 255, b: 255 }, black = { r: 0, g: 0, b: 0 };
      const cw = contrast(c, white), cb = contrast(c, black);
      const yiq = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
      const lines = [
        `HEX ${hexOf(c)}`,
        `RGB rgb(${c.r}, ${c.g}, ${c.b})`,
        `HSL hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
        `HSV hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`,
        `相对亮度 ${L.toFixed(4)}`,
        `对比度 对白 ${cw.toFixed(2)}:1　对黑 ${cb.toFixed(2)}:1`,
        `明度(YIQ) ${Math.round(yiq * 100)}%　当这个颜色做底色时，建议用${yiq > 0.5 ? '黑色' : '白色'}文字`,
        `WCAG 正文(4.5:1) 把它当文字色：白底${cw >= 4.5 ? '通过' : '不通过'} / 黑底${cb >= 4.5 ? '通过' : '不通过'}`,
      ];
      const data = { hex: hexOf(c), rgb: [c.r, c.g, c.b], hsl, hsv, luminance: Number(L.toFixed(4)), contrastWhite: Number(cw.toFixed(2)), contrastBlack: Number(cb.toFixed(2)), isDark: yiq <= 0.5, suggestedTextColor: yiq > 0.5 ? '#000000' : '#FFFFFF', yiq: Math.round(yiq * 100) };
      if (args.background) {
        const bg = parseColor(args.background);
        if (!bg) return { ok: false, text: '背景色无法识别。' };
        const cc = contrast(c, bg);
        lines.push(`与背景 ${hexOf(bg)} 的对比度 ${cc.toFixed(2)}:1　正文 AA ${cc >= 4.5 ? '通过' : '不通过'}　AAA ${cc >= 7 ? '通过' : '不通过'}`);
        data.contrastWithBackground = Number(cc.toFixed(2));
      }
      return { ok: true, text: lines.join('\n'), data };
    },

    async text_kit(args = {}) {
      const action = String(args.action || '').toLowerCase();
      const text = String(args.text ?? '');
      if (!text) return { ok: false, text: '缺少 text 参数。' };
      const lines = text.split(/\r?\n/);
      const ic = args.ignore_case === true;

      if (action === 'dedupe') {
        const seen = new Set();
        const out = [];
        for (const line of lines) {
          const key = ic ? line.trim().toLowerCase() : line.trim();
          if (!key) { continue; }
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(line);
        }
        return { ok: true, text: out.join('\n'), data: { before: lines.filter((l) => l.trim()).length, after: out.length, removed: lines.filter((l) => l.trim()).length - out.length } };
      }

      if (action === 'sort') {
        const rows = lines.filter((l) => l.trim());
        const num = (s) => {
          const v = Number(String(s).trim().replace(/,/g, ''));
          return Number.isFinite(v) ? v : null;
        };
        rows.sort((a, b) => {
          if (args.numeric) {
            const na = num(a), nb = num(b);
            if (na !== null && nb !== null) return na - nb;
            if (na !== null) return -1;
            if (nb !== null) return 1;
          }
          const ka = ic ? a.toLowerCase() : a;
          const kb = ic ? b.toLowerCase() : b;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        if (args.desc) rows.reverse();
        return { ok: true, text: rows.join('\n'), data: { count: rows.length } };
      }

      if (action === 'trim') {
        const out = lines.map((l) => l.trim().replace(/[ \t]{2,}/g, ' ')).filter((l) => l);
        return { ok: true, text: out.join('\n'), data: { before: lines.length, after: out.length, removed: lines.length - out.length } };
      }

      if (action === 'wrap') {
        const pre = String(args.prefix ?? '');
        const suf = String(args.suffix ?? '');
        const out = lines.map((l) => pre + l + suf);
        return { ok: true, text: out.join('\n'), data: { count: out.length } };
      }

      if (action === 'split') {
        const d = args.delimiter === undefined || args.delimiter === '' ? null : String(args.delimiter);
        const parts = d ? text.split(d) : lines;
        const out = parts.map((p, i) => `${i + 1}. ${p.trim()}`).filter((x) => x.trim() !== '' && !/^\d+\.\s*$/.test(x));
        return { ok: true, text: out.join('\n'), data: { count: out.length, delimiter: d || '换行' } };
      }

      if (action === 'case') {
        const type = String(args.case_type || 'camel').toLowerCase();
        const words = (s) => s
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPResponse → HTTP Response
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // userName → user Name
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim().split(/\s+/).filter(Boolean);
        const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : '');
        const convert = (s) => {
          if (type === 'upper') return s.toUpperCase();
          if (type === 'lower') return s.toLowerCase();
          const ws = words(s);
          if (!ws.length) return s;
          switch (type) {
            case 'camel': return ws[0].toLowerCase() + ws.slice(1).map(cap).join('');
            case 'pascal': return ws.map(cap).join('');
            case 'snake': return ws.map((w) => w.toLowerCase()).join('_');
            case 'kebab': return ws.map((w) => w.toLowerCase()).join('-');
            case 'const': return ws.map((w) => w.toUpperCase()).join('_');
            case 'title': return ws.map(cap).join(' ');
            default: return s;
          }
        };
        const out = lines.map((l) => (l.trim() ? convert(l.trim()) : l));
        return { ok: true, text: out.join('\n'), data: { type, count: out.length } };
      }

      return { ok: false, text: 'action 只支持 dedupe / sort / trim / wrap / split / case。' };
    },

    async aes_crypto(args = {}) {
      const action = String(args.action || '').toLowerCase();
      const mode = String(args.mode || 'cbc').toLowerCase();
      if (!['encrypt', 'decrypt'].includes(action)) return { ok: false, text: 'action 只能是 encrypt 或 decrypt。' };
      if (!['cbc', 'gcm', 'ecb'].includes(mode)) return { ok: false, text: 'mode 只能是 cbc / gcm / ecb。' };
      const enc = (v, fallback) => (['utf8', 'hex', 'base64'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fallback);
      const toBuf = (v, encoding) => {
        const s = String(v ?? '');
        if (encoding === 'hex') return Buffer.from(s.replace(/0x|[\s:]/gi, ''), 'hex');
        if (encoding === 'base64') return Buffer.from(s, 'base64');
        return Buffer.from(s, 'utf8');
      };
      const key = toBuf(args.key, enc(args.key_encoding, 'utf8'));
      if (![16, 24, 32].includes(key.length)) {
        return { ok: false, text: `key 长度是 ${key.length} 字节，必须是 16/24/32 字节（128/192/256 位）。如果是十六进制字符串，请把 key_encoding 设为 hex。` };
      }
      const ivEnc = enc(args.iv_encoding, 'utf8');
      const inEnc = enc(args.input_encoding, 'base64');
      const outEnc = enc(args.output_encoding, 'base64');
      const alg = `aes-${key.length * 8}-${mode}`;
      try {
        if (action === 'encrypt') {
          const iv = mode === 'ecb' ? null : toBuf(args.iv, ivEnc);
          if (mode !== 'ecb' && (!iv || !iv.length)) return { ok: false, text: 'CBC / GCM 需要 iv 参数。' };
          const c = crypto.createCipheriv(alg, key, iv);
          const body = Buffer.concat([c.update(Buffer.from(String(args.text ?? ''), 'utf8')), c.final()]);
          const lines = [`模式 ${alg.toUpperCase()}`];
          lines.push(`密文(${outEnc}) ${body.toString(outEnc)}`);
          if (iv) lines.push(`iv(${ivEnc}) ${iv.toString('hex')}`);
          if (mode === 'gcm') lines.push(`tag(base64) ${c.getAuthTag().toString('base64')}`);
          return {
            ok: true,
            text: lines.join('\n'),
            data: { mode: alg, ciphertext: body.toString(outEnc), iv: iv ? iv.toString('hex') : null, tag: mode === 'gcm' ? c.getAuthTag().toString('base64') : null, outputEncoding: outEnc },
          };
        }
        const iv = mode === 'ecb' ? null : toBuf(args.iv, ivEnc);
        if (mode !== 'ecb' && (!iv || !iv.length)) return { ok: false, text: 'CBC / GCM 需要 iv 参数。' };
        const d = crypto.createDecipheriv(alg, key, iv);
        if (mode === 'gcm') {
          if (!args.tag) return { ok: false, text: 'GCM 解密需要 tag（auth tag）参数。' };
          d.setAuthTag(toBuf(args.tag, inEnc));
        }
        const plain = Buffer.concat([d.update(toBuf(args.text, inEnc)), d.final()]);
        const asText = plain.toString('utf8');
        const bad = (asText.match(/\ufffd/g) || []).length;
        return {
          ok: true,
          text: bad ? `${asText}\n\n（有 ${bad} 个字节不是合法 UTF-8，原文 hex：${plain.toString('hex').slice(0, 120)}）` : asText,
          data: { mode: alg, bytes: plain.length, plaintext: asText, hex: plain.toString('hex') },
        };
      } catch (e) {
        const msg = String(e.message || e);
        if (/bad decrypt|unable to authenticate|wrong final block/i.test(msg)) {
          return { ok: false, text: '解密失败：key / iv / 密文 / 编码方式不匹配，或密文被截断（' + msg + '）' };
        }
        return { ok: false, text: 'AES 处理失败：' + msg };
      }
    },

    async cmd_run(args = {}) {
      // 服务端二次校验：即使前端缓存了旧定义，没开开关也绝不执行
      const raw = store.rawSettings && store.rawSettings();
      if (!raw || raw.cmdEnabled !== true) {
        return { ok: false, text: '命令执行未开启。请到 设置 → 生成 → 命令执行（危险） 打开开关后再试。' };
      }
      const command = String(args.command || '').trim();
      if (!command) return { ok: false, text: '缺少 command 参数。' };
      if (command.length > 2000) return { ok: false, text: '命令过长（最多 2000 字符）。' };
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeout_ms) || 30000));
      log('[tool] cmd_run 执行：' + command.slice(0, 160));
      return runCommand({ command, cwd, timeoutMs });
    },
  };

  async function call(name, args, callCtx = {}) {
    // eval 只在浏览器主线程执行，服务端没有也不应有实现；拦截绕过前端的直接调用
    if (name === 'eval') return { ok: false, text: 'eval 只能在浏览器中执行，不支持服务端调用。' };
    const fn = impl[name];
    if (!fn) return { ok: false, text: `未知工具：${name}` };
    const started = Date.now();
    try {
      let parsed = args;
      if (typeof args === 'string') {
        try { parsed = args.trim() ? JSON.parse(args) : {}; } catch { parsed = {}; }
      }
      const res = await fn(parsed || {}, callCtx || {});
      return { ...res, elapsedMs: Date.now() - started };
    } catch (e) {
      log('[tool] ' + name + ' 失败: ' + e.message);
      return { ok: false, text: `工具 ${name} 执行失败：${e.message}`, elapsedMs: Date.now() - started };
    }
  }

  /* v1.16.0：内置工具全部通过 CPL 注册表登记（内置 js 插件形式）。
   * 没传 cpl 时保持旧行为，便于单独测试本文件。 */
  if (cpl) {
    try {
      cpl.registerBuiltinSync({
        ns: 'cdcp',
        name: '内置工具集',
        uniqueVersion: 1,
        version: '1.16.0',
        description: 'ChatBox 内置工具：联网检索、编解码、哈希、二维码、统计、命令执行等本地能力。',
        module: require('./cpl/builtin/tools.plugin.cjs'),
        context: { definitions, impl, call, store, log, dataDir },
      });
      return {
        definitions: cpl.registry.toolDefinitions(),
        names: cpl.registry.toolNames(),
        call: (name, args, callCtx) => cpl.callTool(name, args, { caller: 'cdcp', ...(callCtx || {}) }),
        callDirect: call,
      };
    } catch (e) {
      log('[cpl] 内置工具插件注册失败，回退到直接注册：' + e.message);
    }
  }

  return { definitions, call, names: Object.keys(impl) };
}

module.exports = { createTools, _internals: { shortDate, htmlToText, decodeBuf, sniffCharset, dropNoiseBlocks, pickMainHtml, qrMatrix, qrCapacity, QR_MAX_VERSION, searchToolDefs } };
