/* 构建单文件便携版：node.exe + SEA 注入静态资源
 * 用法：node portable/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pub = path.join(root, 'public');
const outDir = path.join(here, 'dist');
const buildDir = path.join(here, 'build');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// postject CLI：优先环境变量指定，其次项目内 devDependency，最后上级目录的 node_modules
// （这样换机器不用改源码：npm i 后直接跑即可）
function findPostject() {
  const candidates = [
    process.env.POSTJECT_CLI,
    path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(here, 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(root, '..', 'node_modules', 'postject', 'dist', 'cli.js'),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try { return createRequire(pathToFileURL(path.join(root, 'package.json'))).resolve('postject/dist/cli.js'); } catch {}
  throw new Error('找不到 postject。请先执行 npm i -D postject，或设置环境变量 POSTJECT_CLI 指向 cli.js。');
}
const POSTJECT = findPostject();
console.log('postject:', POSTJECT);

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

// 1) 收集资源
const assets = {};
function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else assets['public/' + r] = abs;
  }
}
walk(pub);
const assetCount = Object.keys(assets).length;
const assetBytes = Object.values(assets).reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`assets: ${assetCount} files, ${(assetBytes / 1048576).toFixed(1)} MB`);

// 2) 把存储核心内联进入口（SEA 只能加载单个主文件，不能再 require 本地模块）
const coreSrc = fs.readFileSync(path.join(root, 'server', 'store-core.cjs'), 'utf8')
  .replace('module.exports = { createStore, DEFAULT_SETTINGS };', 'return { createStore, DEFAULT_SETTINGS };');
const toolsSrc = fs.readFileSync(path.join(root, 'server', 'tools-core.cjs'), 'utf8')
  // 末尾导出可能带调试用的 _internals，统一按结尾那条替换
  .replace(/module\.exports\s*=\s*\{[\s\S]*?\};\s*$/, 'return { createTools };');
if (toolsSrc.includes('module.exports')) throw new Error('tools-core.cjs 的导出语句没替换成功');
const lanSrc = fs.readFileSync(path.join(root, 'server', 'lan-core.cjs'), 'utf8')
  .replace('module.exports = { createLan };', 'return { createLan };');
// tokenizer-core：内联实现 + 注入词表（SEA 无真实文件系统，tools-core 也不能 require 它）
const tokenizerSrc = fs.readFileSync(path.join(root, 'server', 'tokenizer-core.cjs'), 'utf8')
  .replace(/module\.exports\s*=\s*\{[\s\S]*?\};\s*$/, 'return { tokenize, loadTokenizer, setTokenizerJson };');
if (tokenizerSrc.includes('module.exports')) throw new Error('tokenizer-core.cjs 的导出语句没替换成功');
const tokenizerJson = fs.readFileSync(path.join(root, 'public', 'vendor', 'tokenizer', 'tokenizer.json'), 'utf8');
const mainSrc = fs.readFileSync(path.join(here, 'sea-main.cjs'), 'utf8');
for (const tag of ['/*__STORE_CORE__*/', '/*__TOOLS_CORE__*/', '/*__LAN_CORE__*/', '/*__TOKENIZER__*/']) {
  if (!mainSrc.includes(tag)) throw new Error('sea-main.cjs 缺少内联占位符 ' + tag);
}
const bundlePath = path.join(buildDir, 'sea-main.bundle.cjs');
// 注意：必须用函数式 replacement，否则源码里的 $' / $& 会被 String.replace 当成特殊替换模式
let bundle = mainSrc.replace('/*__STORE_CORE__*/', () =>
  'const { createStore, DEFAULT_SETTINGS } = (function () {\n' + coreSrc + '\n})();');
bundle = bundle.replace('/*__TOOLS_CORE__*/', () =>
  'const { createTools } = (function () {\n' + toolsSrc + '\n})();');
bundle = bundle.replace('/*__LAN_CORE__*/', () =>
  'const { createLan } = (function () {\n' + lanSrc + '\n})();');
bundle = bundle.replace('/*__TOKENIZER__*/', () =>
  'const { tokenize: _dsTokenize, setTokenizerJson } = (function () {\n' + tokenizerSrc + '\n})();\n'
  + 'setTokenizerJson(' + tokenizerJson + ');\n'
  + 'globalThis.__dsTokenize = _dsTokenize;');
fs.writeFileSync(bundlePath, bundle);
console.log(`bundle: ${(fs.statSync(bundlePath).size / 1024).toFixed(0)} KB (store-core + tools-core + lan-core + tokenizer + 6.4MB 词表已内联)`);

// 3) sea-config
const cfgPath = path.join(buildDir, 'sea-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  main: bundlePath,
  output: path.join(buildDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

// 4) 生成 blob
console.log('generating SEA blob ...');
execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit', cwd: root });
const blobPath = path.join(buildDir, 'sea-prep.blob');
console.log(`blob: ${(fs.statSync(blobPath).size / 1048576).toFixed(2)} MB`);

// 5) 复制 node.exe
const exePath = path.join(outDir, 'DeepSeekChatBox.exe');
fs.copyFileSync(process.execPath, exePath);
console.log(`copied runtime -> ${exePath} (${(fs.statSync(exePath).size / 1048576).toFixed(1)} MB)`);

// 6) 注入
console.log('injecting blob ...');
execFileSync(process.execPath, [POSTJECT, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE], { stdio: 'inherit' });

const finalSize = fs.statSync(exePath).size;
console.log(`\nDONE: ${exePath}`);
console.log(`size: ${(finalSize / 1048576).toFixed(1)} MB`);
