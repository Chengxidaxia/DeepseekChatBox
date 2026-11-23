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
const net = require('node:net');
const os = require('node:os');

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

function createTools({ store, upstream = 'https://api.deepseek.com', log = console.log }) {
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
        description: '计算文本的 MD5 / SHA1 / SHA256 / SHA512 哈希值（十六进制）。用于校验、生成摘要、比对文件指纹文本。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要哈希的文本' },
            algorithm: { type: 'string', description: 'md5 / sha1 / sha256 / sha512，默认 sha256' },
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
      const alg = String(args.algorithm || 'sha256').toLowerCase();
      if (!['md5', 'sha1', 'sha256', 'sha512'].includes(alg)) {
        return { ok: false, text: '不支持的算法 ' + alg + '，可选 md5 / sha1 / sha256 / sha512。' };
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

  async function call(name, args) {
    const fn = impl[name];
    if (!fn) return { ok: false, text: `未知工具：${name}` };
    const started = Date.now();
    try {
      let parsed = args;
      if (typeof args === 'string') {
        try { parsed = args.trim() ? JSON.parse(args) : {}; } catch { parsed = {}; }
      }
      const res = await fn(parsed || {});
      return { ...res, elapsedMs: Date.now() - started };
    } catch (e) {
      log('[tool] ' + name + ' 失败: ' + e.message);
      return { ok: false, text: `工具 ${name} 执行失败：${e.message}`, elapsedMs: Date.now() - started };
    }
  }

  return { definitions, call, names: Object.keys(impl) };
}

module.exports = { createTools, _internals: { shortDate, htmlToText, decodeBuf, sniffCharset, dropNoiseBlocks, pickMainHtml } };
