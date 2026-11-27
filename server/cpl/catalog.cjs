'use strict';
/**
 * CPL 接口目录
 *
 * 两组接口：
 *   HOOK_SPECS —— 可拦截的事件点（cj/json 侧 ≥50，js/py 侧 ≥100）
 *   API_SPECS  —— 可调用的能力（同样分开达标）
 *
 * 字段： [id, 说明, 是否可改写上下文(patch), 形参名]
 * patch=true 时，处理器的返回值会合并回上下文，后续逻辑看到被改写的内容。
 */

const HOOK_SPECS = [
  /* ---------------- 消息 ---------------- */
  ['message.before_send', '用户消息写入会话前', true, 'ctx'],
  ['message.after_send', '用户消息写入会话后', false, 'ctx'],
  ['message.before_receive', '收到模型首个分片前', true, 'ctx'],
  ['message.chunk', '收到模型正文分片', true, 'ctx'],
  ['message.reasoning_chunk', '收到模型思考分片', true, 'ctx'],
  ['message.after_receive', '一条助手消息接收完成', true, 'ctx'],
  ['message.before_render', '消息进入渲染前', true, 'ctx'],
  ['message.after_render', '消息渲染完成', false, 'ctx'],
  ['message.before_edit', '消息被编辑前', true, 'ctx'],
  ['message.after_edit', '消息被编辑后', false, 'ctx'],
  ['message.before_delete', '消息被删除前', true, 'ctx'],
  ['message.after_delete', '消息被删除后', false, 'ctx'],
  ['message.before_regenerate', '重新生成前', true, 'ctx'],
  ['message.after_regenerate', '重新生成后', false, 'ctx'],
  ['message.before_continue', '继续生成前', true, 'ctx'],
  ['message.after_continue', '继续生成后', false, 'ctx'],
  ['message.before_copy', '复制消息前', true, 'ctx'],
  ['message.after_copy', '复制消息后', false, 'ctx'],
  ['message.before_branch', '创建分支前', true, 'ctx'],
  ['message.after_branch', '创建分支后', false, 'ctx'],

  /* ---------------- 上下文 ---------------- */
  ['context.before_build', '构建请求上下文前', true, 'ctx'],
  ['context.after_build', '构建请求上下文后', true, 'ctx'],
  ['context.before_trim', '裁剪上下文前', true, 'ctx'],
  ['context.after_trim', '裁剪上下文后', true, 'ctx'],
  ['context.token_count', '统计 token 时', true, 'ctx'],
  ['context.system_prompt', '拼装系统提示词时', true, 'ctx'],
  ['context.before_compress', '上下文压缩前', true, 'ctx'],
  ['context.after_compress', '上下文压缩后', true, 'ctx'],
  ['context.before_summarize', '历史摘要生成前', true, 'ctx'],
  ['context.after_summarize', '历史摘要生成后', true, 'ctx'],

  /* ---------------- 请求 / 响应 ---------------- */
  ['request.before_build', '请求体构造前', true, 'ctx'],
  ['request.after_build', '请求体构造后', true, 'ctx'],
  ['request.before_send', '请求发出前', true, 'ctx'],
  ['request.after_send', '请求已发出', false, 'ctx'],
  ['request.after_response', '收到响应头', true, 'ctx'],
  ['request.chunk', '收到原始分片', true, 'ctx'],
  ['request.error', '请求出错', true, 'ctx'],
  ['request.retry', '请求重试时', true, 'ctx'],
  ['request.abort', '请求被中断', false, 'ctx'],
  ['request.done', '请求结束（含失败）', false, 'ctx'],

  ['response.before_parse', '解析响应前', true, 'ctx'],
  ['response.after_parse', '解析响应后', true, 'ctx'],
  ['response.before_render', '响应渲染前', true, 'ctx'],
  ['response.after_render', '响应渲染后', false, 'ctx'],
  ['response.tool_call_detected', '检测到工具调用', true, 'ctx'],
  ['response.finish_reason', '收到结束原因', true, 'ctx'],
  ['response.usage', '收到用量统计', true, 'ctx'],

  /* ---------------- 工具 ---------------- */
  ['tool.before_register', '工具注册前', true, 'ctx'],
  ['tool.after_register', '工具注册后', false, 'ctx'],
  ['tool.before_call', '工具执行前', true, 'ctx'],
  ['tool.after_call', '工具执行后', true, 'ctx'],
  ['tool.before_result', '工具结果返回模型前', true, 'ctx'],
  ['tool.after_result', '工具结果已返回', false, 'ctx'],
  ['tool.error', '工具执行异常', true, 'ctx'],
  ['tool.unknown', '调用了不存在的工具', true, 'ctx'],
  ['tool.definitions.before_build', '工具定义下发前', true, 'ctx'],
  ['tool.definitions.after_build', '工具定义下发后', true, 'ctx'],
  ['tool.round_limit', '工具轮次达到上限', true, 'ctx'],

  /* ---------------- 会话 ---------------- */
  ['conv.before_create', '新建会话前', true, 'ctx'],
  ['conv.after_create', '新建会话后', false, 'ctx'],
  ['conv.before_switch', '切换会话前', true, 'ctx'],
  ['conv.after_switch', '切换会话后', false, 'ctx'],
  ['conv.before_delete', '删除会话前', true, 'ctx'],
  ['conv.after_delete', '删除会话后', false, 'ctx'],
  ['conv.before_rename', '重命名会话前', true, 'ctx'],
  ['conv.after_rename', '重命名会话后', false, 'ctx'],
  ['conv.before_pin', '置顶切换前', true, 'ctx'],
  ['conv.after_pin', '置顶切换后', false, 'ctx'],
  ['conv.before_move', '移动到分组前', true, 'ctx'],
  ['conv.after_move', '移动到分组后', false, 'ctx'],
  ['conv.before_export', '导出会话前', true, 'ctx'],
  ['conv.after_export', '导出会话后', false, 'ctx'],

  /* ---------------- 分组 ---------------- */
  ['group.before_create', '新建分组前', true, 'ctx'],
  ['group.after_create', '新建分组后', false, 'ctx'],
  ['group.before_rename', '分组重命名前', true, 'ctx'],
  ['group.after_rename', '分组重命名后', false, 'ctx'],
  ['group.before_delete', '删除分组前', true, 'ctx'],
  ['group.after_delete', '删除分组后', false, 'ctx'],
  ['group.before_move', '分组排序前', true, 'ctx'],
  ['group.after_move', '分组排序后', false, 'ctx'],

  /* ---------------- 设置 ---------------- */
  ['settings.before_load', '读取设置前', true, 'ctx'],
  ['settings.after_load', '读取设置后', true, 'ctx'],
  ['settings.before_patch', '修改设置前', true, 'ctx'],
  ['settings.after_patch', '修改设置后', false, 'ctx'],
  ['settings.before_reset', '重置设置前', true, 'ctx'],
  ['settings.after_reset', '重置设置后', false, 'ctx'],
  ['settings.before_export', '导出设置前', true, 'ctx'],
  ['settings.after_export', '导出设置后', false, 'ctx'],

  /* ---------------- 存储 ---------------- */
  ['store.before_read', '读盘前', true, 'ctx'],
  ['store.after_read', '读盘后', true, 'ctx'],
  ['store.before_write', '写盘前', true, 'ctx'],
  ['store.after_write', '写盘后', false, 'ctx'],
  ['store.before_delete', '删除数据前', true, 'ctx'],
  ['store.after_delete', '删除数据后', false, 'ctx'],
  ['store.before_import', '导入数据前', true, 'ctx'],
  ['store.after_import', '导入数据后', false, 'ctx'],
  ['store.before_migrate', '数据迁移前', true, 'ctx'],
  ['store.after_migrate', '数据迁移后', false, 'ctx'],

  /* ---------------- UI ---------------- */
  ['ui.before_render', '界面渲染前', true, 'ctx'],
  ['ui.after_render', '界面渲染后', false, 'ctx'],
  ['ui.composer.before_mount', '输入区挂载前', true, 'ctx'],
  ['ui.composer.before_send', '点击发送前', true, 'ctx'],
  ['ui.composer.after_send', '点击发送后', false, 'ctx'],
  ['ui.composer.input', '输入框内容变化', true, 'ctx'],
  ['ui.message.before_mount', '消息节点挂载前', true, 'ctx'],
  ['ui.message.after_mount', '消息节点挂载后', false, 'ctx'],
  ['ui.message.action', '点击消息操作按钮', true, 'ctx'],
  ['ui.sidebar.before_mount', '侧栏挂载前', true, 'ctx'],
  ['ui.sidebar.item_click', '点击侧栏条目', true, 'ctx'],
  ['ui.theme.change', '主题变化', true, 'ctx'],
  ['ui.lang.change', '语言变化', true, 'ctx'],
  ['ui.dialog.before_open', '弹窗打开前', true, 'ctx'],
  ['ui.dialog.after_open', '弹窗打开后', false, 'ctx'],
  ['ui.dialog.before_close', '弹窗关闭前', true, 'ctx'],
  ['ui.contextmenu.build', '构建右键菜单', true, 'ctx'],
  ['ui.shortcut', '触发快捷键', true, 'ctx'],
  ['ui.settings.before_open', '打开设置前', true, 'ctx'],
  ['ui.settings.after_open', '打开设置后', false, 'ctx'],

  /* ---------------- 网络 ---------------- */
  ['net.before_request', '插件发起网络请求前', true, 'ctx'],
  ['net.after_response', '插件收到响应后', true, 'ctx'],
  ['net.error', '插件网络请求失败', true, 'ctx'],
  ['net.before_retry', '网络重试前', true, 'ctx'],
  ['net.timeout', '网络超时', true, 'ctx'],
  ['net.rate_limited', '被限流', true, 'ctx'],

  /* ---------------- 应用 ---------------- */
  ['app.before_start', '应用启动前', true, 'ctx'],
  ['app.after_start', '应用启动后', false, 'ctx'],
  ['app.ready', '就绪', false, 'ctx'],
  ['app.before_exit', '退出前', true, 'ctx'],
  ['app.tick', '心跳（每分钟）', false, 'ctx'],
  ['app.idle', '空闲', false, 'ctx'],
  ['app.error', '未捕获异常', true, 'ctx'],
  ['app.visibility', '页面可见性变化', true, 'ctx'],

  /* ---------------- 插件 ---------------- */
  ['cpl.before_load', '插件加载前', true, 'ctx'],
  ['cpl.after_load', '插件加载后', false, 'ctx'],
  ['cpl.before_enable', '插件启用前', true, 'ctx'],
  ['cpl.after_enable', '插件启用后', false, 'ctx'],
  ['cpl.before_disable', '插件禁用前', true, 'ctx'],
  ['cpl.after_disable', '插件禁用后', false, 'ctx'],
  ['cpl.before_unload', '插件卸载前', true, 'ctx'],
  ['cpl.after_unload', '插件卸载后', false, 'ctx'],
  ['cpl.conflict', '注册冲突', true, 'ctx'],
  ['cpl.install', '插件安装', false, 'ctx'],
  ['cpl.upgrade', '插件升级', false, 'ctx'],

  /* ---------------- 模型 ---------------- */
  ['model.before_select', '选择模型前', true, 'ctx'],
  ['model.after_select', '选择模型后', true, 'ctx'],
  ['model.before_call', '调用模型前', true, 'ctx'],
  ['model.after_call', '调用模型后', true, 'ctx'],
  ['model.error', '模型调用失败', true, 'ctx'],
  ['model.fallback', '模型降级', true, 'ctx'],

  /* ---------------- 子智能体 ---------------- */
  ['subagent.before_run', '子智能体运行前', true, 'ctx'],
  ['subagent.after_run', '子智能体运行后', true, 'ctx'],
  ['subagent.before_task', '子任务拆分前', true, 'ctx'],
  ['subagent.after_task', '子任务完成后', false, 'ctx'],
  ['subagent.before_compress', '子模型压缩前', true, 'ctx'],
  ['subagent.after_compress', '子模型压缩后', true, 'ctx'],

  /* ---------------- 附件 ---------------- */
  ['attachment.before_upload', '附件上传前', true, 'ctx'],
  ['attachment.after_upload', '附件上传后', false, 'ctx'],
  ['attachment.before_open', '打开附件前', true, 'ctx'],
  ['attachment.after_open', '打开附件后', false, 'ctx'],
  ['attachment.before_delete', '删除附件前', true, 'ctx'],
  ['attachment.after_delete', '删除附件后', false, 'ctx'],

  /* ---------------- 检索 / 用量 ---------------- */
  ['search.before_query', '工具检索前', true, 'ctx'],
  ['search.after_query', '工具检索后', true, 'ctx'],
  ['search.history.before', '历史检索前', true, 'ctx'],
  ['search.history.after', '历史检索后', true, 'ctx'],
  ['usage.before_count', '统计用量前', true, 'ctx'],
  ['usage.after_count', '统计用量后', true, 'ctx'],
  ['usage.before_cost', '计算费用前', true, 'ctx'],
  ['usage.after_cost', '计算费用后', true, 'ctx'],
];

const API_SPECS = [
  /* 消息 */
  ['messages.list', '读取会话消息列表', ['convId?']],
  ['messages.get', '按 id 取一条消息', ['convId?', 'msgId']],
  ['messages.find', '按条件查消息', ['convId?', 'predicate']],
  ['messages.append', '追加一条消息', ['convId?', 'message']],
  ['messages.update', '更新消息字段', ['convId?', 'msgId', 'patch']],
  ['messages.remove', '删除消息', ['convId?', 'msgId']],
  ['messages.clear', '清空会话消息', ['convId?']],
  ['messages.count', '消息条数', ['convId?']],

  /* 会话 */
  ['convs.list', '会话列表', []],
  ['convs.get', '取会话', ['id']],
  ['convs.current', '当前会话', []],
  ['convs.create', '新建会话', ['title?']],
  ['convs.delete', '删除会话', ['id']],
  ['convs.rename', '重命名会话', ['id', 'title']],
  ['convs.switch', '切换会话', ['id']],
  ['convs.pin', '置顶切换', ['id', 'pinned?']],
  ['convs.move', '移动到分组', ['id', 'groupId']],
  ['convs.export', '导出会话', ['id?']],
  ['convs.import', '导入会话', ['payload']],

  /* 分组 */
  ['groups.list', '分组列表', []],
  ['groups.create', '新建分组', ['name']],
  ['groups.rename', '重命名分组', ['id', 'name']],
  ['groups.delete', '删除分组', ['id']],
  ['groups.move', '分组排序', ['id', 'index']],

  /* 工具 */
  ['tools.register', '注册工具', ['tool']],
  ['tools.unregister', '注销工具', ['name']],
  ['tools.list', '工具清单', []],
  ['tools.get', '取工具定义', ['name']],
  ['tools.call', '调用工具', ['name', 'args']],
  ['tools.names', '工具名数组', []],

  /* hook */
  ['hooks.register', '注册 hook', ['spec']],
  ['hooks.unregister', '注销 hook', ['hookId']],
  ['hooks.list', 'hook 清单', ['hookId?']],
  ['hooks.emit', '主动触发 hook', ['hookId', 'ctx']],

  /* 事件总线 */
  ['events.on', '订阅自定义事件', ['name', 'fn']],
  ['events.once', '订阅一次', ['name', 'fn']],
  ['events.off', '取消订阅', ['name', 'fn']],
  ['events.emit', '派发自定义事件', ['name', 'payload']],

  /* KV（插件私有命名空间） */
  ['kv.get', '读键', ['key', 'fallback?']],
  ['kv.set', '写键', ['key', 'value']],
  ['kv.delete', '删键', ['key']],
  ['kv.keys', '列出键', ['prefix?']],
  ['kv.clear', '清空命名空间', []],
  ['kv.incr', '自增计数', ['key', 'delta?']],

  /* 配置 */
  ['config.get', '读插件配置项', ['key', 'fallback?']],
  ['config.set', '写插件配置项', ['key', 'value']],
  ['config.all', '全部配置', []],
  ['config.schema', '配置 schema', []],

  /* 网络 */
  ['net.fetch', '发起 HTTP 请求', ['url', 'opts?']],
  ['net.get', 'GET 文本', ['url', 'opts?']],
  ['net.post', 'POST 请求', ['url', 'body', 'opts?']],
  ['net.head', 'HEAD 探测', ['url']],
  ['net.download', '下载为 Buffer', ['url', 'opts?']],

  /* 文件（限插件目录） */
  ['fs.read', '读插件目录文件', ['relPath', 'encoding?']],
  ['fs.write', '写插件目录文件', ['relPath', 'data']],
  ['fs.exists', '判断存在', ['relPath']],
  ['fs.list', '列目录', ['relDir?']],
  ['fs.remove', '删文件', ['relPath']],
  ['fs.mkdir', '建目录', ['relDir']],

  /* UI（声明式） */
  ['ui.toast', '轻提示', ['text', 'level?']],
  ['ui.notify', '通知', ['text', 'opts?']],
  ['ui.dialog', '弹窗', ['html', 'opts?']],
  ['ui.confirm', '确认框', ['text']],
  ['ui.addComposerButton', '加输入区按钮', ['spec']],
  ['ui.addSettingsSection', '加设置分区', ['spec']],
  ['ui.addMessageAction', '加消息操作', ['spec']],
  ['ui.addSidebarItem', '加侧栏项', ['spec']],
  ['ui.addCommand', '注册命令', ['spec']],
  ['ui.addSlashCommand', '注册斜杠命令', ['spec']],
  ['ui.setThemeToken', '设置主题变量', ['name', 'value']],
  ['ui.openUrl', '打开链接', ['url']],

  /* 日志 */
  ['log.debug', '调试日志', ['...args']],
  ['log.info', '信息日志', ['...args']],
  ['log.warn', '警告日志', ['...args']],
  ['log.error', '错误日志', ['...args']],

  /* 工具函数 */
  ['util.uuid', '生成 UUID', []],
  ['util.hash', '文本哈希', ['text', 'alg?']],
  ['util.base64.encode', 'base64 编码', ['text']],
  ['util.base64.decode', 'base64 解码', ['text']],
  ['util.json.parse', '安全 JSON 解析', ['text', 'fallback?']],
  ['util.json.stringify', 'JSON 序列化', ['value', 'pretty?']],
  ['util.sleep', '延时', ['ms']],
  ['util.clamp', '数值夹取', ['v', 'min', 'max']],
  ['util.format', '模板占位替换', ['tpl', 'vars']],
  ['util.slug', '生成 slug', ['text']],
  ['util.random', '随机数/抽取', ['min?', 'max?']],
  ['util.now', '当前时间戳', []],
  ['util.date.format', '日期格式化', ['ts?', 'fmt?']],
  ['util.date.diff', '日期差', ['a', 'b', 'unit?']],
  ['util.bytes', '字节数格式化', ['n']],
  ['util.truncate', '截断文本', ['text', 'max', 'tail?']],
  ['util.deepMerge', '深合并', ['a', 'b']],
  ['util.template', '简单模板渲染', ['tpl', 'vars']],

  /* AI */
  ['ai.complete', '一次补全', ['prompt', 'opts?']],
  ['ai.chat', '多轮对话', ['messages', 'opts?']],
  ['ai.summarize', '摘要', ['text', 'opts?']],
  ['ai.compressHistory', '压缩历史', ['messages', 'opts?']],

  /* 上下文 */
  ['ctx.countTokens', '统计 token', ['text']],
  ['ctx.truncate', '按 token 截断', ['text', 'maxTokens']],
  ['ctx.systemPrompt', '读取系统提示词', []],
  ['ctx.messages', '当前上下文消息', ['convId?']],

  /* 插件自身 */
  ['plugin.info', '当前插件信息', []],
  ['plugin.self', '当前插件命名空间', []],
  ['plugin.version', '当前插件唯一版本号', []],
  ['plugin.dataDir', '插件数据目录', []],
  ['plugin.config', '插件配置对象', []],

  /* cpl */
  ['cpl.version', 'CPL 版本', []],
  ['cpl.plugins', '已装插件列表', []],
  ['cpl.emit', '触发 hook', ['hookId', 'ctx']],
  ['cpl.hooks', 'hook 目录', []],
  ['cpl.apis', 'API 目录', []],

  /* 存储（受限） */
  ['store.settings', '读设置（脱敏）', []],
  ['store.patchSettings', '改设置（白名单）', ['patch']],
  ['store.apiKeyPreview', 'Key 掩码', []],

  /* 平台 */
  ['platform.info', '运行平台信息', []],
  ['platform.node', 'Node 版本', []],
  ['platform.isWindows', '是否 Windows', []],
];

const HOOK_MAP = new Map(HOOK_SPECS.map(([id, desc, patch, arg]) => [id, { id, desc, patch, arg }]));
const API_MAP = new Map(API_SPECS.map(([id, desc, params]) => [id, { id, desc, params }]));

/** JSON 插件可用的子集：只读型 + 无危险副作用 */
const JSON_HOOKS = new Set([
  'message.before_send', 'message.after_send', 'message.before_receive', 'message.chunk',
  'message.after_receive', 'message.before_render', 'message.after_render', 'message.before_copy',
  'context.before_build', 'context.after_build', 'context.before_trim', 'context.after_trim',
  'context.token_count', 'context.system_prompt', 'context.before_compress', 'context.after_compress',
  'request.before_build', 'request.after_build', 'request.before_send', 'request.after_response',
  'request.error', 'response.before_parse', 'response.after_parse', 'response.before_render',
  'response.after_render', 'response.tool_call_detected', 'response.usage',
  'tool.before_call', 'tool.after_call', 'tool.before_result', 'tool.after_result', 'tool.error',
  'tool.definitions.before_build', 'tool.definitions.after_build', 'tool.round_limit',
  'conv.before_create', 'conv.after_create', 'conv.before_switch', 'conv.after_switch',
  'conv.before_delete', 'conv.after_delete', 'conv.before_rename', 'conv.after_rename',
  'conv.before_export', 'conv.after_export', 'group.before_create', 'group.after_create',
  'settings.before_load', 'settings.after_load', 'settings.before_patch', 'settings.after_patch',
  'store.before_read', 'store.after_read', 'store.before_write', 'store.after_write',
  'store.before_import', 'store.after_import',
  'ui.before_render', 'ui.after_render', 'ui.theme.change', 'ui.lang.change',
  'ui.composer.before_send', 'ui.message.before_mount', 'ui.message.after_mount',
  'net.before_request', 'net.after_response', 'net.error',
  'app.before_start', 'app.after_start', 'app.ready', 'app.tick',
  'search.before_query', 'search.after_query', 'search.history.before', 'search.history.after',
  'usage.before_count', 'usage.after_count', 'usage.before_cost', 'usage.after_cost',
  'model.before_select', 'model.after_select', 'model.before_call', 'model.after_call',
  'subagent.before_run', 'subagent.after_run', 'subagent.before_compress', 'subagent.after_compress',
  'attachment.before_upload', 'attachment.after_upload', 'attachment.before_open', 'attachment.after_open',
]);

/** JSON 插件可用的 API 子集：只读 / 纯函数为主 */
const JSON_APIS = new Set([
  'messages.list', 'messages.get', 'messages.find', 'messages.count', 'messages.append',
  'convs.list', 'convs.get', 'convs.current', 'convs.create', 'convs.rename', 'convs.export',
  'groups.list', 'groups.create', 'groups.rename',
  'tools.list', 'tools.get', 'tools.names', 'tools.call',
  'hooks.list', 'events.emit',
  'kv.get', 'kv.set', 'kv.delete', 'kv.keys', 'kv.incr',
  'config.get', 'config.set', 'config.all', 'config.schema',
  'net.fetch', 'net.get', 'net.post', 'net.head',
  'ui.toast', 'ui.notify', 'ui.addComposerButton', 'ui.addSettingsSection', 'ui.addMessageAction',
  'ui.addSidebarItem', 'ui.addCommand', 'ui.addSlashCommand',
  'log.info', 'log.warn', 'log.error',
  'util.uuid', 'util.hash', 'util.base64.encode', 'util.base64.decode', 'util.json.parse',
  'util.json.stringify', 'util.format', 'util.slug', 'util.random', 'util.now', 'util.date.format',
  'util.date.diff', 'util.bytes', 'util.truncate', 'util.deepMerge', 'util.template', 'util.clamp',
  'ctx.countTokens', 'ctx.truncate', 'ctx.systemPrompt', 'ctx.messages',
  'plugin.info', 'plugin.self', 'plugin.version',
  'cpl.version', 'cpl.plugins', 'cpl.hooks', 'cpl.apis',
  'store.settings', 'store.apiKeyPreview', 'platform.info', 'platform.node', 'platform.isWindows',
  'ai.summarize',
]);

module.exports = {
  HOOK_SPECS, API_SPECS, HOOK_MAP, API_MAP,
  JSON_HOOKS, JSON_APIS,
};
