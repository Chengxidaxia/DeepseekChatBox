'use strict';
/**
 * 内置插件：全部内置工具
 *
 * 这个文件就是「内置工具插件」本体。以后新增内置工具，只要在
 * host.context.impl / definitions 里补一项，这里会自动注册；
 * 或者直接在本文件里用 cdcp.tools.register() 注册新工具。
 *
 * 注意：注册到 cdcp 命名空间（fullId 就是工具名），与历史调用方式完全兼容。
 */

module.exports = function registerBuiltinTools(cdcp, host) {
  const ctx = (host && host.context) || {};
  const defs = ctx.definitions || [];
  const impl = ctx.impl || {};

  // 常驻/动态的排序：稳定的只读工具排前面（与 api.js buildPayload 的分层配合）
  const STABLE = new Set(['get_balance', 'usage_stats', 'search_history', 'current_time', 'peak_status']);

  let order = 0;
  for (const def of defs) {
    const fn = def && def.function;
    if (!fn || !fn.name) continue;
    const name = fn.name;
    const handler = impl[name];
    if (typeof handler !== 'function') {
      // eval 这类只在前端执行的工具：保留定义给模型，服务端调用时明确拒绝
      cdcp.tools.register({
        name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {}, additionalProperties: false },
        order: STABLE.has(name) ? order : 1000 + order,
        handler: async () => ({ ok: false, text: `${name} 只能在浏览器中执行，不支持服务端调用。` }),
      });
      order++;
      continue;
    }
    cdcp.tools.register({
      name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {}, additionalProperties: false },
      order: STABLE.has(name) ? order : 1000 + order,
      handler: async (args, callCtx) => handler(args || {}, callCtx || {}),
    });
    order++;
  }

  cdcp.log.info(`内置工具插件注册完成：${order} 个`);
};
