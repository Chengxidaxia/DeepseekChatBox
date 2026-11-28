#!/usr/bin/env node
/* DeepSeek Chatbox 一键自检
 *
 * 把每次改完代码都要手敲的那一堆重复步骤收进一条命令：
 *   ① 全部 js/cjs/mjs 语法检查
 *   ② 元数据一致性（版本号真源、文档里的工具数字、不该写死的东西）
 *   ③ 真起一次服务（临时端口 + 临时数据目录），量冷启动耗时
 *   ④ 接口与防护实测（health / 插件清单 / 图标 / 跨站 / 内容类型 / 路径穿越）
 *   ⑤ 仓库状态（未提交改动、版本有没有跟着提交）
 *
 * 用法：
 *   node scripts/check.mjs            全量
 *   node scripts/check.mjs --fast     只做 ①②⑤，不起服务
 *   node scripts/check.mjs --keep     保留临时数据目录（排查用）
 *   node scripts/check.mjs --port 17600
 *
 * 退出码：0 全过（允许 WARN），1 有 FAIL。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const FAST = ARGV.includes('--fast');
const KEEP = ARGV.includes('--keep');
const PORT_ARG = (() => {
  const i = ARGV.indexOf('--port');
  return i >= 0 ? Number(ARGV[i + 1]) : 0;
})();

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};
const USE_COLOR = process.stdout.isTTY !== false && !process.env.NO_COLOR;
const paint = (c, s) => (USE_COLOR ? c + s + C.reset : s);

const results = { pass: 0, fail: 0, warn: 0 };
const lines = [];
function ok(name, extra = '') {
  results.pass++;
  lines.push(`  ${paint(C.green, 'PASS')} ${name}${extra ? paint(C.dim, '  ' + extra) : ''}`);
}
function bad(name, extra = '') {
  results.fail++;
  lines.push(`  ${paint(C.red, 'FAIL')} ${name}${extra ? '  ' + extra : ''}`);
}
function warn(name, extra = '') {
  results.warn++;
  lines.push(`  ${paint(C.yellow, 'WARN')} ${name}${extra ? '  ' + extra : ''}`);
}
function head(n, title) {
  lines.push('');
  lines.push(paint(C.bold + C.cyan, `[${n}] ${title}`));
}
function flush() {
  for (const l of lines) console.log(l);
  lines.length = 0;
}

/* ---------------------------- 路径与工具函数 ---------------------------- */

const SKIP_DIR = new Set(['node_modules', '.git', 'data', '.build', 'build', 'dist', '__pycache__', 'vendor']);
function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(abs, out);
    } else if (/\.(m?js|cjs)$/.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/* ------------------------------- ① 语法 ------------------------------- */

function checkSyntax() {
  head(1, '语法检查');
  const files = walk(ROOT);
  let badCount = 0;
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      badCount++;
      const msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ').trim();
      bad('语法错误：' + rel(f), msg);
    }
  }
  if (!badCount) ok(`${files.length} 个 js/cjs/mjs 文件语法通过`);
  return files;
}

/* ---------------------------- ② 元数据一致性 ---------------------------- */

function checkMeta(files) {
  head(2, '元数据一致性（版本 / 文档数字 / 写死项）');
  const pkg = readJson(path.join(ROOT, 'package.json')) || {};
  const version = pkg.version || '';
  version ? ok('package.json 版本号', 'v' + version) : bad('package.json 读不到版本号');

  // 前端不该再自带版本号（统一走 /api/version）
  const verJs = path.join(ROOT, 'public/js/version.js');
  if (fs.existsSync(verJs)) {
    const s = read(verJs) || '';
    if (/=\s*['"]\d+\.\d+\.\d+['"]/.test(s)) warn('public/js/version.js 里写死了版本号', '应改为 /api/version');
    else ok('前端版本号来自 /api/version（未写死）');
  }

  // 便携版入口不应硬编码版本（'0.0.0' 是读不到 package.json 时的兜底，不算）
  const sea = read(path.join(ROOT, 'portable/sea-main.cjs')) || '';
  const hardVer = [...sea.matchAll(/=\s*['"](\d+\.\d+\.\d+)['"]/g)].map((m) => m[1]).filter((v) => v !== '0.0.0');
  if (hardVer.length) warn('portable/sea-main.cjs 写死了版本号', hardVer.join(', '));
  else if (sea.includes('__DS_CB_VERSION__')) ok('便携版版本号由打包时注入（源码无写死）');
  else warn('portable/sea-main.cjs 找不到版本占位符 __DS_CB_VERSION__');

  // 文档里的版本号
  const docs = [
    'README.md',
    'portable/dist/使用说明.txt',
    '.build/green/DeepSeekChatBox/使用说明.txt',
  ];
  for (const d of docs) {
    const s = read(path.join(ROOT, d));
    if (s === null) { warn(`文档缺失：${d}`); continue; }
    if (!version) continue;
    if (s.includes(version)) ok(`${d} 已包含 v${version}`);
    else bad(`${d} 没写当前版本 v${version}`, '发布前必须同步');
  }

  // 专版版本对齐（若存在）
  const wbPkgPath = path.resolve(ROOT, '../deepseek-chatbox-wbapp/package.json');
  const wbPkg = readJson(wbPkgPath);
  if (wbPkg) {
    if (wbPkg.version === version) ok('专版 wbapp 版本对齐', 'v' + wbPkg.version);
    else warn('专版 wbapp 版本未对齐', `wbapp v${wbPkg.version} vs 主仓 v${version}`);
  }

  // 不该写死的插件相关映射
  const front = files.filter((f) => rel(f).startsWith('public/js/'));
  let hard = 0;
  for (const f of front) {
    const s = read(f) || '';
    if (/BUILTIN_ICONS/.test(s)) { hard++; bad('前端仍在写死内置插件图标表：' + rel(f)); }
    for (const ns of ['cdcp', 'cdcptools']) {
      const re = new RegExp(`['"\`]${ns}['"\`]`);
      if (re.test(s)) { hard++; warn(`前端出现内置命名空间字面量 ${ns}：${rel(f)}`, '应从服务端下发字段读取'); }
    }
  }
  if (!hard) ok('前端没有写死的内置插件映射', `检查了 ${front.length} 个文件`);

  // 服务端：内置插件元数据应由 spec 声明，而不是全量兜底
  const cpl = read(path.join(ROOT, 'server/cpl/cpl.cjs')) || '';
  if (/permissions:\s*\['tools',\s*'hooks'[\s\S]{0,120}?\],\s*\n\s*requires:/.test(cpl)) {
    // 只在 makeBuiltinRuntime 之外出现才可疑；下面用更精确的判断
  }
  if (/permissions:\s*Array\.isArray\(spec\.permissions\)/.test(cpl)) ok('内置插件权限由 spec 声明（无统一兜底）');
  else bad('内置插件权限仍可能是统一写死的默认值');

  return { version };
}

/* ------------------------------ ③ 起服务 ------------------------------ */

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitHealth(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { ms: Date.now() - t0, body: await r.json() };
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

async function startServer() {
  head(3, '启动服务（临时端口 / 临时数据目录）');
  const port = PORT_ARG || await freePort(17600);
  const dataDir = path.join(os.tmpdir(), 'ds-cb-check-' + Date.now());
  const child = spawn(process.execPath, [
    'server.mjs', '--port', String(port), '--local-only', '--no-open', '--data-dir', dataDir,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const h = await waitHealth(port);
  if (!h) {
    bad('服务 30 秒内没起来', out.split('\n').slice(-6).join(' | '));
    child.kill();
    return { port, child, dataDir, up: false };
  }
  ok('服务就绪', `${h.ms} ms（浏览器应在这一刻之后才打开，启动脚本的时序问题看这个数）`);
  if (h.body && h.body.app === 'deepseek-chatbox') ok('健康接口自报身份正确', 'v' + h.body.version);
  else bad('健康接口返回异常', JSON.stringify(h.body).slice(0, 120));
  return { port, child, dataDir, up: true, bootMs: h.ms, health: h.body };
}

/* --------------------------- ④ 接口与防护 --------------------------- */

/* 文档里写的工具数必须等于代码里真实的工具数 —— 这类数字最容易被忘在旧版本里 */
function checkDocNumbers(tools) {
  const PATTERNS = [
    /工具共\s*(\d+)\s*个/g,
    /内置工具（(\d+)\s*个）/g,
    /(\d+)\s*个内置工具/g,
    /(\d+)\s*个工具如果/g,
    /内置工具（(\d+)\s*个工具/g,
  ];
  const docs = [
    'README.md',
    'portable/dist/使用说明.txt',
    '.build/green/DeepSeekChatBox/使用说明.txt',
  ];
  let checked = 0;
  for (const d of docs) {
    const s = read(path.join(ROOT, d));
    if (!s) continue;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const n = Number(m[1]);
        checked++;
        if (n === tools) ok(`${d} 工具数正确`, `${n} 个`);
        else bad(`${d} 工具数过时`, `写的是 ${n}，实际 ${tools}`);
      }
    }
  }
  if (!checked) warn('文档里没找到可校验的工具数写法', `实际 ${tools} 个`);
}

async function checkApi(ctx, version) {
  head(4, '接口与防护');
  const base = `http://127.0.0.1:${ctx.port}`;
  const get = async (p, opt) => {
    try { return await fetch(base + p, opt); } catch (e) { return { ok: false, status: 0, text: async () => e.message }; }
  };

  // 版本号
  const vr = await get('/api/version');
  const vj = vr.ok ? await vr.json().catch(() => null) : null;
  (vj && vj.version === version)
    ? ok('/api/version 与 package.json 一致', 'v' + vj.version)
    : bad('/api/version 不一致', `接口 ${vj && vj.version} / 真源 ${version}`);

  // 插件清单
  const pr = await get('/api/cpl/plugins');
  const pj = pr.ok ? await pr.json().catch(() => null) : null;
  if (!pj || !Array.isArray(pj.plugins)) {
    bad('/api/cpl/plugins 不可用');
  } else {
    const ids = pj.plugins.map((p) => p.id);
    const builtin = pj.plugins.filter((p) => p.builtin);
    const tools = pj.stats?.tools ?? 0;
    ok('插件清单可读', `${pj.plugins.length} 个插件 / ${tools} 个工具`);

    for (const need of ['cdcp', 'cdcptools', 'cpl']) {
      ids.includes(need) ? ok(`内置插件在列表里：${need}`) : bad(`内置插件缺失：${need}`);
    }

    // 权限必须是数组（空数组也算合法：表示不调用扩展接口）
    const badPerm = pj.plugins.filter((p) => !Array.isArray(p.permissions));
    badPerm.length
      ? bad('有插件 permissions 不是数组', badPerm.map((p) => p.id).join(','))
      : ok('所有插件都带 permissions 数组');

    // cdcp 不该宣称自己有扩展能力
    const cdcp = pj.plugins.find((p) => p.id === 'cdcp');
    if (cdcp && Array.isArray(cdcp.permissions) && cdcp.permissions.length === 0) ok('cdcp 权限为空（不虚标）');
    else if (cdcp) warn('cdcp 声明了权限', JSON.stringify(cdcp.permissions));

    // 图标地址由服务端下发
    const noIcon = builtin.filter((p) => !p.iconUrl);
    noIcon.length
      ? warn('有内置插件没给 iconUrl', noIcon.map((p) => p.id).join(','))
      : ok('内置插件 iconUrl 均已下发');
    if (builtin[0]?.iconUrl) {
      const ir = await get(builtin[0].iconUrl);
      ir.ok ? ok('内置插件图标可访问', builtin[0].iconUrl) : bad('内置插件图标 404', builtin[0].iconUrl);
    }

    // 第三方图标接口不该把不存在的插件当成 200
    const ir2 = await get('/api/cpl/icon/__nope__');
    (ir2.status === 404) ? ok('/api/cpl/icon 对未知插件返回 404') : warn('/api/cpl/icon 未知插件返回 ' + ir2.status);

    // 工具计数应当自洽：所有内置工具都挂在 cdcptools 下
    const ct = pj.plugins.find((p) => p.id === 'cdcptools');
    if (ct && tools > 0 && (ct.counts?.tools || 0) === tools) ok('工具全部登记在 cdcptools 下', `${tools} 个`);
    else if (tools > 0) warn('工具计数不自洽', `全局 ${tools} / cdcptools ${ct?.counts?.tools}`);

    if (tools > 0) checkDocNumbers(tools);
  }

  // 静态入口（设置页的每个分标签都应有自己的地址）
  const pages = ['/', '/cpl', '/settings',
    '/settings/general', '/settings/model', '/settings/gen', '/settings/data', '/settings/about'];
  for (const p of pages) {
    const r = await get(p);
    const txt = r.ok ? await r.text() : '';
    const isHtml = /<html|<!doctype/i.test(txt.slice(0, 400));
    r.ok && isHtml ? ok(`页面可访问：${p}`) : bad(`页面异常：${p}`, 'HTTP ' + r.status);
  }

  // 防护：跨站写请求
  const csrf = await get('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: '{"x":1}',
  });
  (csrf.status === 403) ? ok('跨站 Origin 的写请求被拒（403）') : bad('跨站写请求没被拒', 'HTTP ' + csrf.status);

  // 防护：非 JSON 写请求（表单/纯文本）
  const ct = await get('/api/settings', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"x":1}',
  });
  (ct.status === 415) ? ok('非 application/json 的写请求被拒（415）') : bad('非 json 写请求没被拒', 'HTTP ' + ct.status);

  // 防护：路径穿越
  for (const probe of ['/%2e%2e%2fpackage.json', '/..%2fpackage.json']) {
    const r = await get(probe);
    const txt = r.ok ? await r.text() : '';
    (r.status !== 200 || !/"name"\s*:\s*"deepseek-chatbox"/.test(txt))
      ? ok('路径穿越被挡住', probe + ' → ' + r.status)
      : bad('路径穿越读到了 package.json', probe);
  }
}

/* ---------------------------- ⑤ 仓库状态 ---------------------------- */

function checkGit(version) {
  head(5, '仓库状态');
  let out = '';
  try {
    out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    warn('不是 git 仓库或 git 不可用，跳过');
    return;
  }
  const changed = out.split('\n').filter(Boolean);
  if (!changed.length) ok('工作区干净（没有未提交改动）');
  else {
    warn(`有 ${changed.length} 项未提交改动`, '确认是否要一起提交');
    for (const l of changed.slice(0, 12)) lines.push(paint(C.dim, '       ' + l));
    if (changed.length > 12) lines.push(paint(C.dim, `       … 另有 ${changed.length - 12} 项`));
  }

  try {
    const last = execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: ROOT, encoding: 'utf8' }).trim();
    ok('最近一次提交', last);
    // 版本号有没有跟代码一起提交：HEAD 之后的 package.json 若改动过，说明版本还没提交
    const pkgDirty = changed.some((l) => /package\.json$/.test(l));
    if (pkgDirty) warn('package.json 有未提交改动', '发版时记得「改版本 → 提交 → 打 tag」顺序');
    // tag 是否指向 HEAD
    try {
      const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      if (tags) ok('HEAD 上有 tag', tags.split('\n').join(' '));
      else warn('HEAD 上没有 tag', `当前版本 v${version}，发版后应打 tag`);
    } catch { /* ignore */ }
  } catch {
    warn('仓库还没有提交记录');
  }

  // 发布产物是否落后于源码
  const zip = path.join(ROOT, 'DeepSeekChatBox-portable.zip');
  if (fs.existsSync(zip)) {
    const zipT = fs.statSync(zip).mtimeMs;
    const newer = walk(ROOT)
      .filter((f) => !rel(f).startsWith('.build/'))
      .filter((f) => fs.statSync(f).mtimeMs > zipT);
    newer.length
      ? warn('发布 zip 比源码旧', `${newer.length} 个源文件更新过，需要重新打包`)
      : ok('发布 zip 不比源码旧');
  }
}

/* ------------------------------- 主流程 ------------------------------- */

console.log(paint(C.bold, 'DeepSeek Chatbox 自检') + paint(C.dim, `  ${ROOT}`));

const files = checkSyntax();
flush();
const { version } = checkMeta(files);
flush();

let ctx = null;
try {
  if (!FAST) {
    ctx = await startServer();
    flush();
    if (ctx.up) {
      await checkApi(ctx, version);
      flush();
    }
  }
} finally {
  if (ctx?.child && !ctx.child.killed) {
    ctx.child.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
  if (ctx?.dataDir) {
    if (KEEP) console.log(paint(C.dim, `\n临时数据目录保留：${ctx.dataDir}`));
    else fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
}

checkGit(version);
flush();

const total = results.pass + results.fail + results.warn;
console.log('');
console.log(
  paint(C.bold, '结果：') +
  paint(C.green, `${results.pass} PASS`) + ' / ' +
  (results.fail ? paint(C.red, `${results.fail} FAIL`) : '0 FAIL') + ' / ' +
  (results.warn ? paint(C.yellow, `${results.warn} WARN`) : '0 WARN') +
  paint(C.dim, `   共 ${total} 项`)
);
if (results.fail) {
  console.log(paint(C.red, '有 FAIL，先修完再提交。'));
  process.exit(1);
}
process.exit(0);
