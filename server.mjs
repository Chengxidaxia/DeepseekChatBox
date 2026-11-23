// DeepSeek Chatbox — 本地服务：静态文件 + 服务端存储 + DeepSeek API 反向代理（SSE 透传）
// 数据全部落在本目录 ./data 下，浏览器不保存任何内容。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createStore } = require('./server/store-core.cjs');
const { createTools } = require('./server/tools-core.cjs');
const { createLan } = require('./server/lan-core.cjs');

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
const DATA_DIR = path.resolve(argVal('--data-dir') || process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPSTREAM = 'https://api.deepseek.com';
const ENV_KEY = process.env.DEEPSEEK_API_KEY || '';

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
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

const tools = createTools({ store, log, dataDir: DATA_DIR });
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

/* ------------------------------- 静态文件 ------------------------------- */
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // 局域网访问需口令（本机 127.0.0.1 免校验）
    if (lan && await lan.guard(req, res, url)) return;

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true, app: 'deepseek-chatbox', mode: 'source', storage: 'server',
        hasKey: Boolean(store.getApiKey()), dataDir: store.dir, node: process.version,
      });
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
      return sendJson(res, 200, await tools.call(body.name, body.arguments));
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
});

server.listen(PORT, HOST, () => {
  log(`DeepSeek Chatbox 运行中: http://127.0.0.1:${PORT}`);
  log(`数据目录: ${store.dir}`);
  log(`API Key: ${store.getApiKey() ? '已配置（服务端）' : '未配置'}${ENV_KEY ? ' [环境变量]' : ''}`);
  if (LAN_OPEN) {
    const ips = lanAddresses();
    console.log('');
    log('手机访问（手机需与这台电脑连同一个 WiFi / 路由器）：');
    if (lan) {
      if (ips.length) {
        log(`   http://${ips[0]}:${PORT}/?k=${lan.token}    <- 一般就是这条`);
        if (ips[1]) log(`   http://${ips[1]}:${PORT}/?k=${lan.token}`);
        log(`   访问口令：${lan.token}`);
        log('   连不上就换上面另一条，或 ipconfig 看本机 IPv4 地址再拼 :' + PORT);
      } else {
        log(`   没找到局域网 IP。请用 ipconfig 查看本机 IPv4，再访问 http://<IP>:${PORT}/?k=${lan.token}`);
        log(`   访问口令：${lan.token}`);
      }
      log('   只想自己这台电脑用：加 --local-only 启动。');
    } else {
      for (const ip of ips) log(`   http://${ip}:${PORT}/`);
      log('   ⚠ 已用 --no-auth 关闭口令，同网段任何人都能使用你的 API Key。');
    }
    console.log('');
  }
});

process.on('SIGINT', () => {
  log('已停止');
  process.exit(0);
});
