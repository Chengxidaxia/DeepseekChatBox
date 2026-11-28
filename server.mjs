// DeepSeek Chatbox — 本地服务：静态文件 + 服务端存储 + DeepSeek API 反向代理（SSE 透传）
// 数据全部落在本目录 ./data 下，浏览器不保存任何内容。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createStore } = require('./server/store-core.cjs');
const { createTools } = require('./server/tools-core.cjs');
const { createLan } = require('./server/lan-core.cjs');
const { createCpl } = require('./server/cpl/cpl.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const argVal = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const PORT = Number(argVal('--port') || process.env.PORT || 17321);
// 默认监听所有网卡：双击就能用手机打开（口令见启动日志）。
// 只想本机用就加 --local-only；--lan 仍保留，等同于默认行为。
const LOCAL_ONLY = process.argv.includes('--local-only') || process.argv.includes('--no-lan');
const HOST = process.env.HOST || argVal('--host') || (LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0');
const LAN_OPEN = HOST !== '127.0.0.1' && HOST !== 'localhost';
const NO_AUTH = process.argv.includes('--no-auth');
/* HTTPS 开关：--https（或 HTTPS=1）。局域网/RadminLAN 上跑的话强烈建议开，
 * 否则口令和 API Key 都是明文过网线。 */
const USE_HTTPS = process.argv.includes('--https') || process.env.HTTPS === '1';
/* 自动打开浏览器：--open 打开，--no-open 关闭（默认关闭，避免开发时每次启动都弹窗）。
 * 关键点：只有 listen 成功（端口真的在应答）之后才会打开，所以不会出现
 * 「网页先打开、服务端还没起来」的空白页/连接被拒。 */
const OPEN_ON_START = process.argv.includes('--open') && !process.argv.includes('--no-open');
const TLS_CERT = argVal('--cert');
const TLS_KEY = argVal('--key');
const DATA_DIR = path.resolve(argVal('--data-dir') || process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPSTREAM = 'https://api.deepseek.com';
const ENV_KEY = process.env.DEEPSEEK_API_KEY || '';

// 日志时间戳：本机时间 + 日期 + 时区偏移（ISO 8601 风格，避免 UTC 误读）
function logStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();          // 东八区 = +480 分钟
  const sign = off >= 0 ? '+' : '-';
  const tz = sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + tz;
}

function log(...a) {
  console.log('[' + logStamp() + ']', ...a);
}

// 版本号以服务端 package.json 为唯一真源；前端不再硬编码，统一通过 /api/version 读取。
let APP_VERSION = '';
try {
  APP_VERSION = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '');
} catch (e) {
  log('[警告] 读取 package.json 版本号失败：' + e.message);
}

let store;
try {
  store = createStore({ dataDir: DATA_DIR, log });
} catch (e) {
  console.error('\n[致命] 无法创建数据目录：' + DATA_DIR);
  console.error('  ' + e.message);
  console.error('  请把程序放到可写目录（例如 U 盘或桌面），或用 --data-dir 指定别的目录。\n');
  process.exit(1);
}

/** 列出可用于手机访问的 IPv4 地址：优先真实网卡，过滤虚拟网卡 */
function lanAddresses(limit = 2) {
  const SKIP = /vethernet|virtualbox|vmware|loopback|docker|wsl|hyper-v|tailscale|zerotier|radmin|tap|tun|npcap/i;
  const out = [];
  for (const [name, arr] of Object.entries(os.networkInterfaces())) {
    if (SKIP.test(name)) continue;
    for (const n of arr || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      out.push(n.address);
    }
  }
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y)).slice(0, limit);
}

/* 用系统默认浏览器打开 URL。detached + unref：浏览器独立存活，关掉本窗口也不会带走它。 */
function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      // start 的第一个引号参数是「窗口标题」，必须留空，否则 URL 会被当成标题而不打开
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open'; args = [url];
    } else {
      cmd = 'xdg-open'; args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    log('[提示] 自动打开浏览器失败：' + e.message);
    return false;
  }
}

/* ------------------------------ CPL 扩展加载器 ------------------------------ */
// 插件跑在服务端；host 把「当前会话/设置/token 统计」这类宿主能力借给插件。
const cpl = createCpl({
  dataDir: DATA_DIR,
  version: APP_VERSION,   // 读不到 package.json 时为空串，不再写死版本号
  mode: 'local',
  log,
  host: {
    getConversations: () => store.listConversations(),
    getCurrentConv: () => {
      const list = store.listConversations();
      if (!list.length) return null;
      return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    },
    createConv: (title) => {
      const conv = {
        id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: title || '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      store.upsertConversation(conv);
      return conv;
    },
    deleteConv: (id) => store.deleteConversation(id),
    renameConv: (id, title) => {
      const c = store.getConversation(id);
      if (!c) return false;
      store.upsertConversation({ ...c, title: String(title || '').slice(0, 200), updatedAt: Date.now() });
      return true;
    },
    switchConv: () => false,   // 服务端不持有"当前选中"，由前端决定
    pinConv: (id, pinned) => {
      const c = store.getConversation(id);
      if (!c) return false;
      store.upsertConversation({ ...c, pinned: pinned === undefined ? !c.pinned : Boolean(pinned) });
      return true;
    },
    moveConv: (id, groupId) => {
      const c = store.getConversation(id);
      if (!c) return false;
      store.upsertConversation({ ...c, groupId: groupId || null });
      return true;
    },
    exportConv: (id) => store.getConversation(id) || null,
    getGroups: () => store.listGroups(),
    createGroup: (name) => {
      const g = { id: 'g_' + Date.now().toString(36), name: String(name || '新分组'), createdAt: Date.now() };
      const list = store.listGroups();
      list.push(g);
      store.setGroups(list);
      return g;
    },
    renameGroup: (id, name) => {
      const list = store.listGroups();
      const g = list.find((x) => x.id === id);
      if (!g) return false;
      g.name = String(name || '');
      store.setGroups(list);
      return true;
    },
    deleteGroup: (id) => store.deleteGroup(id),
    touchConv: (c) => store.upsertConversation(c),
    patchSettings: (p) => store.patchSettings(p),
    publicSettings: () => store.publicSettings(),
    keyPreview: () => store.publicSettings().keyPreview,
    countTokens: (text) => {
      try { return require('./server/tokenizer-core.cjs').tokenize(String(text ?? '')).count; }
      catch { return Math.ceil(String(text ?? '').length / 1.6); }
    },
  },
});

const tools = createTools({ store, log, dataDir: DATA_DIR, cpl });
const lan = LAN_OPEN && !NO_AUTH ? createLan({ dataDir: DATA_DIR, log }) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'ETOOLARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/* -------------------------------- TLS -------------------------------- */
/* 证书来源优先级：
 *   1. --cert/--key 指定的 PEM（自己用 mkcert / openssl 签的都行）
 *   2. data/tls/cert.pem + key.pem（手动放进去的）
 *   3. Windows 上自动生成自签 PFX（CurrentUser，5 年，含 localhost 与本机 IPv4）
 * 自签证书浏览器会提示不安全，点「继续访问」即可；局域网内部用足够。
 */
function ensureTls() {
  if (TLS_CERT && TLS_KEY) {
    return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
  }
  const dir = path.join(DATA_DIR, 'tls');
  const pemCert = path.join(dir, 'cert.pem');
  const pemKey = path.join(dir, 'key.pem');
  if (fs.existsSync(pemCert) && fs.existsSync(pemKey)) {
    return { cert: fs.readFileSync(pemCert), key: fs.readFileSync(pemKey) };
  }
  const pfx = path.join(dir, 'cert.pfx');
  const PASS = 'chatbox-tls';
  if (fs.existsSync(pfx)) return { pfx: fs.readFileSync(pfx), passphrase: PASS };

  if (process.platform !== 'win32') {
    throw new Error('自动生成证书只支持 Windows；请用 --cert/--key 指定 PEM，或把 cert.pem/key.pem 放进 data/tls/');
  }
  fs.mkdirSync(dir, { recursive: true });
  const names = ['localhost', '127.0.0.1', ...lanAddresses()];
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$dns=@(${names.map((x) => `'${x}'`).join(',')})`,
    "$c=New-SelfSignedCertificate -DnsName $dns -CertStoreLocation Cert:\\\\CurrentUser\\\\My -NotAfter (Get-Date).AddYears(5) -FriendlyName 'DeepSeek ChatBox' -KeyAlgorithm RSA -KeyLength 2048",
    `$p=ConvertTo-SecureString -String '${PASS}' -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password $p | Out-Null`,
    "$s=New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser');$s.Open('ReadWrite');$s.Remove($c);$s.Close()",
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 40000 });
  if (!fs.existsSync(pfx)) throw new Error('证书生成失败（data/tls/cert.pfx 不存在）');
  return { pfx: fs.readFileSync(pfx), passphrase: PASS };
}

/* ------------------------------- 静态文件 ------------------------------- */
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  // 注意必须是「目录本身或目录 + 分隔符」，不能用裸前缀：
  // `<root>/public-probe/x.txt` 也以 `<root>/public` 开头，裸前缀会放行兄弟目录
  const base = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  const hasDotDot = rel.split(/[\\/]+/).includes('..');
  if (hasDotDot || (target !== PUBLIC_DIR && !target.startsWith(base))) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      // 带扩展名的请求（favicon.ico / *.png / *.js …）一律 404：
      // 以前统一回落 index.html，浏览器会把 HTML 字节当图标解码，标签页就显示一堆花屏
      const ext = path.extname(rel).toLowerCase();
      if (ext) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('not found');
      }
      const idx = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(idx, (e2, buf) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isVendor = rel.startsWith('/vendor/');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': isVendor ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/* --------------------------------- 代理 --------------------------------- */
function pickBase(req) {
  const custom = req.headers['x-ds-base'];
  if (typeof custom === 'string' && /^https?:\/\/[^\s]+$/i.test(custom)) {
    return custom.replace(/\/+$/, '');
  }
  const saved = store.getBaseUrl();
  return saved && /^https?:\/\//i.test(saved) ? saved.replace(/\/+$/, '') : UPSTREAM;
}

function proxy(req, res, restPath) {
  const base = pickBase(req);
  const target = base + '/' + restPath.replace(/^\/+/, '');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-ds-base', 'origin', 'referer', 'authorization'].includes(k)) continue;
    headers[k] = v;
  }
  const key = store.getApiKey();
  if (key) headers.authorization = 'Bearer ' + key;
  const hasBody = !['GET', 'HEAD'].includes(req.method || 'GET');
  headers['accept-encoding'] = 'identity';

  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort();
  });

  const init = { method: req.method, headers, signal: ctrl.signal, redirect: 'follow' };
  if (hasBody) {
    init.body = req;
    init.duplex = 'half';
  }

  const started = Date.now();
  fetch(target, init)
    .then(async (up) => {
      const outHeaders = {};
      up.headers.forEach((v, k) => {
        if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k)) return;
        outHeaders[k] = v;
      });
      outHeaders['cache-control'] = outHeaders['cache-control'] || 'no-store';
      outHeaders['x-accel-buffering'] = 'no';
      res.writeHead(up.status, outHeaders);
      if (res.flushHeaders) res.flushHeaders();
      log(req.method, restPath, '->', up.status, (Date.now() - started) + 'ms');
      if (!up.body) return res.end();
      const reader = up.body.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
          }
          res.end();
        } catch {
          if (!res.writableEnded) res.end();
        }
      };
      pump();
    })
    .catch((e) => {
      if (ctrl.signal.aborted) return;
      log('proxy error', restPath, e.message);
      if (!res.headersSent) sendJson(res, 502, { error: { message: 'upstream request failed: ' + e.message, type: 'proxy_error' } });
      else res.end();
    });
}

/* ------------------------------- 演示模式 ------------------------------- */
const MOCK_TEXT = [
  '好的，这是一个 **Markdown 渲染测试**，用来验证聊天框的排版能力。',
  '',
  '## 能力清单',
  '',
  '| 能力 | 状态 | 说明 |',
  '| --- | --- | --- |',
  '| 流式输出 | ✅ | SSE 增量渲染 |',
  '| 思考过程 | ✅ | 可折叠的 `reasoning_content` |',
  '| 联网搜索 | ✅ | `deepseek_web_search` 服务端工具 |',
  '| 公式 | ✅ | 行内 $E=mc^2$ 与独立公式 |',
  '',
  '$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$',
  '',
  '```js',
  '// 计算斐波那契数列',
  'function fib(n) {',
  '  return n < 2 ? n : fib(n - 1) + fib(n - 2);',
  '}',
  'console.log([...Array(10).keys()].map(fib));',
  '```',
  '',
  '> 引用块：演示模式下不会真的请求 DeepSeek，只用于检查界面。',
  '',
  '- 支持有序列表',
  '- 支持 **加粗**、*斜体*、~~删除线~~、[链接](https://api-docs.deepseek.com/zh-cn/)',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[用户输入] --> B{思考模式}',
  '  B -- 开 --> C[深度思考搜索]',
  '  B -- 关 --> D[直接回答]',
  '  C --> E[带引用作答]',
  '  D --> E',
  '```',
];

function mockChat(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const stream = body.stream !== false;
    const id = 'mock-' + Math.random().toString(36).slice(2, 10);
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || 'deepseek-flash';
    const wantTitle = body.title && body.title.enabled;
    const usage = {
      prompt_tokens: 128, completion_tokens: 456, total_tokens: 584,
      prompt_tokens_details: { cached_tokens: 64 },
      prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 64,
      completion_tokens_details: { reasoning_tokens: 96 },
      server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 0 },
    };
    const reasoning = '用户想验证界面渲染。我需要依次演示思考块、搜索卡片、角标引用、代码块、表格、公式与 Mermaid 图。先规划输出结构，再逐块生成内容。';
    const annotations = [{ type: 'url_citation', url_citation: { url: 'https://api-docs.deepseek.com/zh-cn/', title: 'DeepSeek API Docs', start_index: 0, end_index: 8 } }];
    const serverToolCalls = [{
      index: 0, reasoning_content: '',
      calls: [{
        index: 0, id: 'srvtoolu_mock_1', type: 'deepseek_web_search', kind: 'search',
        action: { type: 'search', queries: ['DeepSeek API 文档', '聊天补全 参数'] },
        status: 'completed',
        sources: [
          { type: 'url', url: 'https://api-docs.deepseek.com/zh-cn/', title: 'DeepSeek API 文档', snippet: '首次调用 API、模型与价格、思考模式……', site_name: 'DeepSeek', site_icon: null, published_at: '2026-11-13T00:00:00+00:00' },
          { type: 'url', url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools', title: '联网工具', snippet: '两个服务端工具：deepseek_web_search 与 deepseek_read_url。', site_name: 'DeepSeek', site_icon: null, published_at: null },
        ],
      }],
    }];

    if (!stream) {
      const message = { role: 'assistant', content: MOCK_TEXT.join('\n'), reasoning_content: reasoning, annotations, server_tool_calls: serverToolCalls };
      if (wantTitle) message.title = '界面渲染演示';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const chunk = (delta, extra = {}) => send({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: extra.finish_reason ?? null, ...(extra.choice || {}) }],
      usage: extra.usage ?? null,
    });

    let aborted = false;
    res.on('close', () => (aborted = true));
    const fast = Boolean(body.__fast);
    const fnTools = (body.tools || []).filter((t) => t && t.type === 'function');
    const hasToolMsg = (body.messages || []).some((m) => m.role === 'tool');
    if (fnTools.length && !hasToolMsg) {
      // 演示：先让模型发起一次工具调用，走完整的 function calling 回路
      chunk({ role: 'assistant', content: '' });
      const callId = 'call_mock_' + Date.now().toString(36);
      chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fnTools[0].function.name, arguments: '' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] });
      chunk({}, { finish_reason: 'tool_calls', usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const steps = [];
    for (const piece of reasoning.match(/[\s\S]{1,8}/g) || []) steps.push(['reasoning', piece, 12]);
    steps.push(['event', { type: 'step_reasoning_done', step: 0 }, 60]);
    steps.push(['event', { type: 'call_started', step: 0, call: serverToolCalls[0].calls[0] }, 80]);
    steps.push(['event', { type: 'call_completed', step: 0, call: { ...serverToolCalls[0].calls[0], status: 'completed' } }, 180]);
    const text = MOCK_TEXT.join('\n');
    for (const piece of text.match(/[\s\S]{1,14}/g) || []) steps.push(['content', piece, 10]);

    let i = 0;
    const tick = () => {
      if (aborted) return;
      if (i >= steps.length) {
        chunk({ server_tool_calls: serverToolCalls, annotations, title: wantTitle ? '界面渲染演示' : undefined }, { finish_reason: 'stop', usage });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const [kind, payload, delay] = steps[i++];
      if (kind === 'reasoning') chunk({ reasoning_content: payload });
      else if (kind === 'content') chunk({ content: payload });
      else send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, server_tool_event: payload, finish_reason: null }], usage: null });
      setTimeout(tick, fast ? 0 : delay);
    };
    chunk({ role: 'assistant', content: '' });
    setTimeout(tick, fast ? 0 : 120);
  });
}

const MOCK_MODELS = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'], output_modalities: ['text'], effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text'], output_modalities: ['text'], effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
  ],
};

/* -------------------------------- 路由 -------------------------------- */
let tlsOpts = null;
if (USE_HTTPS) {
  try { tlsOpts = ensureTls(); }
  catch (e) {
    log('[错误] 启用 HTTPS 失败：' + e.message);
    log('       退回 HTTP（口令与内容会在局域网里明文传输）');
  }
}
const requestHandler = async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // 局域网访问需口令（本机 127.0.0.1 免校验）
    if (lan && await lan.guard(req, res, url)) return;

    // 跨站防护：浏览器里任何一个网页都能向 127.0.0.1 发「简单请求」，
    // 不带 Origin 也读不到响应，但副作用照样发生（调工具 / 改设置 / 删会话）。
    // 两道闸：① 有 Origin 必须同源；② 带 body 的写请求只收 application/json
    //（表单只能发 text/plain / urlencoded / multipart，发不了 json，预检也会被拒）
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin) {
        let oh = '';
        try { oh = new URL(origin).host; } catch {}
        if (oh !== req.headers.host) return sendJson(res, 403, { error: '拒绝跨站请求（Origin 不匹配）' });
      }
      const rawOk = p === '/api/cpl/install' || p === '/api/import' || p.startsWith('/api/upload');
      const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
      const ct = String(req.headers['content-type'] || '');
      if (hasBody && !rawOk && !/^application\/json\b/i.test(ct)) {
        return sendJson(res, 415, { error: '只接受 application/json（拒绝跨站表单提交）' });
      }
    }

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true, app: 'deepseek-chatbox', mode: 'source', storage: 'server',
        hasKey: Boolean(store.getApiKey()), dataDir: store.dir, version: APP_VERSION, node: process.version,
      });
    }
    if (p === '/api/version') {
      return sendJson(res, 200, { version: APP_VERSION });
    }
    if (p === '/api/store' && method === 'GET') {
      return sendJson(res, 200, store.snapshot());
    }
    if (p === '/api/settings' && (method === 'PUT' || method === 'PATCH')) {
      return sendJson(res, 200, store.patchSettings(await readJson(req)));
    }
    if (p === '/api/ui' && (method === 'PUT' || method === 'PATCH')) {
      return sendJson(res, 200, store.setUi(await readJson(req)));
    }
    if (p === '/api/groups' && method === 'GET') {
      return sendJson(res, 200, store.listGroups());
    }
    if (p === '/api/groups' && (method === 'PUT' || method === 'POST')) {
      const body = await readJson(req);
      if (Array.isArray(body.groups)) {
        const n = store.setGroups(body.groups);
        return sendJson(res, 200, { ok: true, count: n });
      }
      return sendJson(res, 200, store.upsertGroup(body.group || body));
    }
    if (p.startsWith('/api/groups/') && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/groups/'.length));
      return sendJson(res, 200, { ok: store.deleteGroup(id) });
    }
    if (p === '/api/tools/definitions' && method === 'GET') {
      return sendJson(res, 200, { tools: tools.definitions });
    }
    if (p === '/api/tools/call' && method === 'POST') {
      const body = await readJson(req);
      if (!body || !body.name) return sendJson(res, 400, { ok: false, text: 'name 必填' });
      return sendJson(res, 200, await tools.call(body.name, body.arguments, { convId: body.convId || null }));
    }

    /* ------------------------------- CPL ------------------------------- */
    if (p === '/api/cpl/plugins' && method === 'GET') {
      const cat = cpl.catalog();
      return sendJson(res, 200, {
        ok: true,
        plugins: cpl.listPlugins(),
        stats: cpl.registry.stats(),
        mode: cpl.mode,
        version: cpl.version,
        limits: {
          hooks: cat.hooks.length, apis: cat.apis.length,
          jsonHooks: cat.jsonHooks.length, jsonApis: cat.jsonApis.length,
        },
        allowScripts: cpl.allowScripts,
      });
    }
    if (p === '/api/cpl/catalog' && method === 'GET') {
      return sendJson(res, 200, cpl.catalog());
    }
    if (p === '/api/cpl/ui' && method === 'GET') {
      return sendJson(res, 200, { ok: true, entries: cpl.uiSnapshot() });
    }
    if (p === '/api/cpl/logs' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      return sendJson(res, 200, { ok: true, logs: cpl.logsFor(u.searchParams.get('plugin') || '', Number(u.searchParams.get('limit')) || 200) });
    }
    if (p === '/api/cpl/install' && method === 'POST') {
      const buf = await readBody(req);
      if (!buf.length) return sendJson(res, 400, { ok: false, error: '请求体为空：请上传插件 zip' });
      try {
        const plugin = await cpl.install(buf);
        return sendJson(res, 200, { ok: true, plugin });
      } catch (e) {
        log('[cpl] 安装失败：' + e.message);
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
    if (p === '/api/cpl/reload' && method === 'POST') {
      const r = await cpl.reloadAll();
      return sendJson(res, 200, { ok: true, ...r, plugins: cpl.listPlugins() });
    }
    if (p === '/api/cpl/hook' && method === 'POST') {
      const body = await readJson(req);
      if (!body || !body.hook) return sendJson(res, 400, { ok: false, error: 'hook 必填' });
      const ctx = await cpl.emit(body.hook, body.ctx || {}, { from: 'web' });
      return sendJson(res, 200, { ok: true, ctx });
    }
    if (p.startsWith('/api/cpl/plugins/')) {
      const rest = p.slice('/api/cpl/plugins/'.length);
      const slash = rest.indexOf('/');
      const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const action = slash === -1 ? '' : rest.slice(slash + 1);
      if (!action && method === 'GET') {
        const pl = cpl.getPlugin(id);
        return pl ? sendJson(res, 200, { ok: true, plugin: pl }) : sendJson(res, 404, { ok: false, error: '插件不存在' });
      }
      if (!action && method === 'DELETE') {
        try { cpl.uninstall(id); return sendJson(res, 200, { ok: true }); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      }
      if (action === 'enable' || action === 'disable') {
        try {
          const plugin = await cpl.setEnabled(id, action === 'enable');
          return sendJson(res, 200, { ok: true, plugin });
        } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      }
      if (action === 'config' && method === 'POST') {
        const body = await readJson(req);
        const rt = cpl.plugins.get(id);
        if (!rt) return sendJson(res, 404, { ok: false, error: '插件不存在' });
        const cache = cpl._cfgCacheFor(id, path.join(cpl.pluginsDir, id, '_config.json'), rt.meta.config);
        for (const [k, v] of Object.entries(body || {})) cache.set(k, v);
        return sendJson(res, 200, { ok: true, config: Object.fromEntries(cache) });
      }
    }
    if (p.startsWith('/api/cpl/icon/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/cpl/icon/'.length));
      const rt = cpl.plugins.get(id);
      if (!rt || !rt.icon) return sendJson(res, 404, { error: 'no icon' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      return res.end(rt.icon);
    }
    if (p === '/api/conversations' && (method === 'PUT' || method === 'POST')) {
      const body = await readJson(req);
      if (Array.isArray(body.conversations)) {
        const n = store.replaceConversations(body.conversations, body.mode || 'replace');
        return sendJson(res, 200, { ok: true, count: n });
      }
      return sendJson(res, 200, store.upsertConversation(body.conversation || body));
    }
    if (p === '/api/conversations' && method === 'DELETE') {
      return sendJson(res, 200, { ok: true, count: store.clearConversations() });
    }
    if (p.startsWith('/api/conversations/')) {
      const id = decodeURIComponent(p.slice('/api/conversations/'.length));
      if (method === 'DELETE') return sendJson(res, 200, { ok: store.deleteConversation(id) });
      if (method === 'GET') {
        const c = store.getConversation(id);
        return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: 'not found' });
      }
      if (method === 'PUT') return sendJson(res, 200, store.upsertConversation(await readJson(req)));
    }
    if (p === '/api/import' && method === 'POST') {
      const body = await readJson(req);
      const n = store.importSnapshot(body.data ?? body, body.mode || 'merge');
      return sendJson(res, 200, { ok: true, count: n });
    }
    if (p === '/api/attachments' && method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'file');
      const mime = req.headers['content-type'] || 'application/octet-stream';
      const buf = await readBody(req, 64 * 1024 * 1024);
      return sendJson(res, 200, store.saveAttachment(buf, name, mime));
    }
    if (p.startsWith('/api/attachments/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/attachments/'.length));
      const found = store.readAttachment(id);
      if (!found) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': found.meta.mime || 'application/octet-stream',
        'content-length': found.buffer.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return res.end(found.buffer);
    }

    if (p.startsWith('/api/mock/')) {
      const sub = p.slice('/api/mock/'.length);
      if (sub === 'chat/completions') return mockChat(req, res);
      if (sub === 'models') return sendJson(res, 200, MOCK_MODELS);
      if (sub === 'user/balance') return sendJson(res, 200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] });
      return sendJson(res, 404, { error: 'unknown mock endpoint' });
    }
    if (p.startsWith('/api/ds/')) {
      return proxy(req, res, p.slice('/api/ds/'.length) + (url.search || ''));
    }

    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, p);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (e.code === 'ETOOLARGE') return sendJson(res, 413, { error: '请求体过大' });
    log('API 错误', p, e.message);
    return sendJson(res, 500, { error: e.message });
  }
};

const server = tlsOpts ? https.createServer(tlsOpts, requestHandler) : http.createServer(requestHandler);
const SCHEME = tlsOpts ? 'https' : 'http';
const LOCAL_URL = `${SCHEME}://127.0.0.1:${PORT}/`;

/* 端口被占用时先问一句「是不是已经有一个自己在跑」——是就直接把浏览器指过去，
 * 而不是甩一串 EADDRINUSE 堆栈。二次双击启动脚本是很常见的操作。 */
function probeSelf() {
  return new Promise((resolve) => {
    const mod = tlsOpts ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = mod.get({
        host: '127.0.0.1', port: PORT, path: '/api/health',
        timeout: 1500, rejectUnauthorized: false,
      }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; if (b.length > 8192) req.destroy(); });
        res.on('end', () => {
          try { finish(JSON.parse(b).app === 'deepseek-chatbox'); } catch { finish(false); }
        });
      });
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
    } catch { finish(false); }
  });
}

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    if (await probeSelf()) {
      log(`端口 ${PORT} 上已经有一个 DeepSeek Chatbox 在运行，直接打开它。`);
      log(`地址：${LOCAL_URL}`);
      if (OPEN_ON_START) openBrowser(LOCAL_URL);
      process.exit(0);
    }
    log(`[致命] 端口 ${PORT} 被其他程序占用。换一个端口启动，例如：node server.mjs --port ${PORT + 1}`);
    process.exit(1);
  }
  log('[致命] 服务启动失败：' + (e.message || String(e)));
  process.exit(1);
});

/* CPL：把已安装插件加载进注册表。失败不影响主服务启动。 */
cpl.boot()
  .then((r) => log(`[cpl] 插件加载完成：${r.loaded} 个${r.problems?.length ? '，问题：' + r.problems.join('；') : ''}`))
  .catch((e) => log('[cpl] 插件加载失败：' + e.message));

server.listen(PORT, HOST, () => {
  log(`DeepSeek Chatbox 运行中: ${SCHEME}://127.0.0.1:${PORT}`);
  log(`数据目录: ${store.dir}`);
  log(`API Key: ${store.getApiKey() ? '已配置（服务端）' : '未配置'}${ENV_KEY ? ' [环境变量]' : ''}`);
  if (tlsOpts) log('传输：HTTPS（自签证书，首次访问浏览器会提示不安全，点「继续」即可）');
  else if (USE_HTTPS) log('传输：HTTP（HTTPS 启动失败，已退回）');
  else log('传输：HTTP（局域网内明文；需要加密就加 --https 启动）');
  if (LAN_OPEN) {
    const ips = lanAddresses();
    console.log('');
    log('手机访问（手机需与这台电脑连同一个 WiFi / 路由器）：');
    if (lan) {
      if (ips.length) {
        log(`   ${SCHEME}://${ips[0]}:${PORT}/?k=${lan.token}    <- 一般就是这条`);
        if (ips[1]) log(`   ${SCHEME}://${ips[1]}:${PORT}/?k=${lan.token}`);
        log(`   访问口令：${lan.token}`);
        log('   连不上就换上面另一条，或 ipconfig 看本机 IPv4 地址再拼 :' + PORT);
      } else {
        log(`   没找到局域网 IP。请用 ipconfig 查看本机 IPv4，再访问 ${SCHEME}://<IP>:${PORT}/?k=${lan.token}`);
        log(`   访问口令：${lan.token}`);
      }
      log('   只想自己这台电脑用：加 --local-only 启动。');
    } else {
      for (const ip of ips) log(`   ${SCHEME}://${ip}:${PORT}/`);
      log('   ⚠ 已用 --no-auth 关闭口令，同网段任何人都能使用你的 API Key。');
    }
    console.log('');
  }
  // 放在最后：上面这些行先刷出来，用户看到日志的同一瞬间浏览器才开始加载，
  // 端口此时已经在应答，不会出现「网页比服务端快」的空白页。
  if (OPEN_ON_START) {
    log('正在用默认浏览器打开…（不想自动打开就加 --no-open）');
    if (!openBrowser(LOCAL_URL)) log('请手动访问：' + LOCAL_URL);
  }
});

process.on('SIGINT', () => {
  log('已停止');
  process.exit(0);
});
