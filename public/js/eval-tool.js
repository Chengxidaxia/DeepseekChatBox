/* 浏览器端 JS 执行工具（eval）
 *
 * 与服务端 cmd_run 的本质区别：这里的代码只在你自己的浏览器标签页里跑，
 * 碰不到服务器文件系统/进程，也碰不到别的用户数据。浏览器沙箱本身就是隔离层。
 *
 * 但仍然危险：代码能读本页 localStorage（API Key、云会话）、能调本页云 SDK、
 * 能 fetch 外网，所以默认关闭，必须在设置里显式打开。
 */

const MAX_OUTPUT = 20000;   // 输出字符上限
const MAX_CODE = 20000;     // 代码长度上限

/** 把任意值安全地转成字符串（循环引用 / 大对象不炸） */
function stringify(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return (v.stack || v.name + ': ' + v.message);
  try {
    const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x), 2);
    if (s !== undefined && s.length <= MAX_OUTPUT) return s;
  } catch { /* 循环引用等，落到 String */ }
  try { return String(v); } catch { return '[无法序列化]'; }
}

/** 在浏览器主线程执行 JS。返回与服务端工具同构的 { ok, text, data }。 */
export async function runBrowserEval(args = {}, isEnabled = false) {
  if (!isEnabled) {
    return { ok: false, text: '浏览器代码执行未开启。请到 设置 → 生成 → 开启 eval（危险） 后再试。' };
  }
  // DeepSeek 的 tool_calls.arguments 是 JSON 字符串，不是对象；服务端工具在 /api/tools/call
  // 里会先 JSON.parse，eval 走浏览器本地执行，必须在这里做同样的归一化。
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); }
    catch { return { ok: false, text: 'eval 的 arguments 不是合法 JSON：' + a.slice(0, 200) }; }
  }
  const code = String((a && (a.code ?? a.expression ?? a.script)) || '');
  if (!code.trim()) return { ok: false, text: '缺少 code 参数：要执行一段 JavaScript 代码。' };
  if (code.length > MAX_CODE) return { ok: false, text: `代码过长（最多 ${MAX_CODE} 字符）。` };

  const lines = [];
  const push = (level, parts) => {
    const s = parts.map(stringify).join(' ');
    let line = '[' + level + '] ' + s;
    if (lines.join('\n').length + line.length > MAX_OUTPUT) {
      line = line.slice(0, Math.max(0, MAX_OUTPUT - lines.join('\n').length)) + '…（输出已截断）';
      lines.push(line);
      return;
    }
    lines.push(line);
  };
  // 只在本次执行的函数作用域里替换 console，执行完立即还原，不影响页面其它代码。
  const sandboxConsole = {
    log: (...a) => push('log', a),
    info: (...a) => push('info', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    debug: (...a) => push('debug', a),
    table: (...a) => push('table', a),
  };

  const t0 = performance.now();
  let value, error = null;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // 表达式模式能像浏览器控制台一样回显最后一个表达式的值（含顶层 await）；
  // 多语句代码在这一步会抛 SyntaxError，回退到语句模式，结果靠 console.log 输出。
  let fn;
  try {
    fn = new AsyncFunction('console', '"use strict";\nreturn (async () => (' + code + '\n))();');
  } catch {
    // 多语句代码：把最后一条语句（若是纯表达式）自动 return，模拟控制台回显。
    // 只做保守识别：末尾取到分号/换行前的最后一段，且不含声明/控制流关键字才加 return。
    const trimmed = code.trim().replace(/;\s*$/, '');
    const m = trimmed.match(/(?:^|[\n;])\s*([^\n;]+)\s*$/);
    let body = '"use strict";\n' + code;
    const last = m && m[1].trim();
    if (last && !/^\s*(const|let|var|return|throw|if|for|while|switch|function|class|break|continue|import|export|}\s*else)\b/.test(last)
        && !/\b(const|let|var)\s/.test(last) && !/[{}]\s*$/.test(last)) {
      try {
        // 先验证「return 最后一段」整体语法是否成立，不成立就放弃回显
        new AsyncFunction('console', '"use strict";\n' + code + '\nreturn (' + last + ');');
        body = '"use strict";\n' + code + '\nreturn (' + last + ');';
      } catch { /* 保持原 body */ }
    }
    try { fn = new AsyncFunction('console', body); }
    catch (e) { return { ok: false, text: '代码语法错误：' + stringify(e).slice(0, MAX_OUTPUT), data: { error: true } }; }
  }
  try {
    value = await fn(sandboxConsole);
  } catch (e) {
    error = e;
  }
  const elapsedMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = stringify(error);
    const text = (lines.length ? lines.join('\n') + '\n' : '') + '执行出错：' + msg;
    return { ok: false, text: text.slice(0, MAX_OUTPUT), data: { elapsedMs, error: true } };
  }
  if (value !== undefined) {
    let s = stringify(value);
    if (s.length > MAX_OUTPUT) s = s.slice(0, MAX_OUTPUT) + '…（输出已截断）';
    lines.push('=> ' + s);
  }
  return {
    ok: true,
    text: lines.join('\n') || '(执行完成，无输出)',
    data: { elapsedMs, returned: value === undefined ? null : typeof value },
  };
}
