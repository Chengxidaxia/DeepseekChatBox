# DeepSeek Chatbox

基于 DeepSeek 官方 API 的**本地全功能对话客户端**，界面按 `chat.deepseek.com` 的实际设计令牌复原（浅色 / 深色两套），无构建步骤、无外部 CDN 依赖，`node server.mjs` 即可运行。

- 前端：原生 ES Module + 本地化依赖（marked / highlight.js / KaTeX / Mermaid）
- 后端：Node 内置模块实现的静态服务 + DeepSeek API 反向代理（SSE 透传）
- **全部数据（含 API Key、对话、图片）都落在服务端 `data/` 目录**，浏览器不保存任何内容
- API Key 由本机代理注入 Authorization，不会随请求从浏览器发出，也不经过任何第三方

---

## 1. 启动

**双击 `启动.bat`**，或在本目录执行：

```bat
node server.mjs
```

浏览器打开 <http://127.0.0.1:17321>（启动脚本会自动打开）。

首次使用点左下角 **设置 → API Key** 填入 `sk-...`（写进 `data/settings.json`，不回显）；想先看界面可打开 **演示模式**（`?demo=1` 也可直达）。

### 数据存放（浏览器零存储）

```
deepseek-chatbox/data/            # 源码版
DeepSeekChatBox.exe
DeepSeekChatBox.exe 同级 data/    # 便携版：跟着 exe 走
├─ settings.json        设置 + API Key（DPAPI 密文字段 apiKeyEnc，绑定当前 Windows 用户）
├─ conversations.json   全部对话（含思考、引用、用量）
├─ ui.json              界面状态（侧栏收起等）
├─ attachments/         上传的图片（按 id 命名 + index.json）
├─ qr/                  qr_text 生成的二维码 PNG（同名覆盖，可随手删）
└─ backups/             对话自动备份，保留最近 10 份
```

- 前端只在内存里持有状态，改动通过 `PATCH /api/settings`、`PUT /api/conversations` 立即写盘
- 旧版（存在浏览器 localStorage）首次打开会自动迁移到服务端，迁移后**删除浏览器里的副本**
- 换浏览器、清缓存、换电脑拷走整个文件夹，聊天记录与 Key 都还在

> 端口被占用时：`node server.mjs --port 17331`（或 `set PORT=17331 && node server.mjs`）；只想本机访问加 `--local-only`。
> 若本机设置了环境变量 `DEEPSEEK_API_KEY`，页面里可以不填 Key（服务端自动补 Authorization）。

### 与官方 chat-demo 的关系

界面基准取自官方开源仓库 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）与
`cdn.deepseek.com/chat-demo` 的构建产物，**数值按源码逐项对齐**，不靠目测：

| 项 | 官方源码 | 本项目 |
|---|---|---|
| 侧栏 | `width: 261px; padding: 6px 12px 0` | 同 |
| 侧栏顶栏 | `height: 48; padding: 15px 0 10px 4px`，品牌文字 `20px/22px 600` | 同（品牌用官方 wordmark SVG） |
| 侧栏顶栏图标组 | `gap: 18px; margin-left: auto`，两个 34px 图标按钮（搜索 / 收起侧栏） | 同 |
| 收起态顶栏 | 侧栏收起后左端出现胶囊按钮组（展开 / 搜索 / 新建），顶栏左侧显示会话标题 | 同 |
| 新对话按钮 | `height: 40; radius 100px;` 三层阴影 | 同 |
| 移动抽屉 | `width: 300px; max-width: calc(100vw - 48px)` | 同 |
| 输入栏开关 | `height 34; padding 0 12; radius 18; 1px solid border-l2; 13px/20 500` | 同 |
| 输入框 | `radius 24`；textarea `min-height = line-height×2 + padding-top = 60` | 同 |
| 附件缩略图 | `64×64; radius 16; border-l2` | 同 |
| 设置面板 | `760×500; padding 19px 24px 22px`，左侧导航 `172px`，`navItem min-height 40` | 同 |
| 设置面板（手机） | 底部面板 `width 100%; height calc(100% - 64px); radius 24 24 0 0`，导航横排 | 同 |
| 欢迎语 | `24px/32px 600`，桌面 `padding 0 32px 64px` | 同（额外保留 4 个示例按钮） |
| 内容声明 | 手机端欢迎页底部「内容由 AI 生成，请仔细甄别」11px | 同 |
| 断点 | `768` | 移动布局用 767/760，抽屉用 900 |

### 已跟进的官方能力（v1.5.0）
| 能力 | 移植方式 |
|---|---|
| 消息分支切换 | `services/chat/branches.ts` → `public/js/branches.js`，树模型与 normalize / visible / append / select 一一对应 |
| 附件上传失败态 | `.attachmentFailed / .failed / .failedStatic / .failedReason` |
| 录音实时频谱 | `Spectrum.tsx` 算法整体移植（对数分段、倍频程倾斜、相邻加权、快起慢落） |
| 引用悬停卡片 | `HoverCard` 的 300/100ms 延迟 + 居中定位 + 放不下翻上方 |
| 独立搜索面板 | `SearchPanel` 尺寸（`calc(50vw - 4rem)` / max 390 / 头部 60），手机全屏 |
| textarea mirror | `.mirror` 撑高度技巧 |

刻意保留的差异：官方 demo 没有模型切换，本项目顶栏沿用官方骨架（左侧会话标题、
收起后左端「展开 / 搜索 / 新建」胶囊），把双模型切换、会话设置、主题放在顶栏右端；
官方用 localStorage + IndexedDB，本项目改为服务端 `data/` 落盘（见上文）。

### 手机 / 局域网访问（默认开启）

**双击 exe 或 bat 启动后，手机就能用**——不需要额外参数。启动窗口会打印：

```
手机访问（手机需与这台电脑连同一个 WiFi / 路由器）：
   http://192.168.x.x:17321/?k=xxxxxxxxxxxx    <- 启动窗口实际打印的那条
   访问口令：xxxxxxxxxxxx（12 位随机）
```

把这一行发到手机（微信/QQ 传给自己也行），手机浏览器打开即可。

| 项 | 说明 |
|---|---|
| 默认行为 | 监听 `0.0.0.0` + 口令保护，本机 `127.0.0.1` 免口令 |
| 只开本机 | `--local-only`（旧参数 `--no-lan` 等价） |
| 指定网卡 | `--host <本机局域网IP>`（用 ipconfig 查） |
| 访问口令 | 首次启动随机生成 12 位，存 `data/lan.json` 可随时查看；`?k=` 校验一次后种 30 天 Cookie 并跳转到干净 URL |
| 保护范围 | 除本机外**所有路径**（含静态资源与 `/api/*`）都要口令，防止同 WiFi 的人白嫖你的 Key |
| 关闭口令 | `--no-auth`（不建议；同网段任何人都能用你的 Key） |
| 地址筛选 | 启动时自动过滤 WSL / Hyper-V / VMware / Docker / VPN 等虚拟网卡，只给出真实网卡地址（`192.168` 优先） |
| 防火墙 | Windows 首次可能弹「允许访问」，勾选**专用网络**；否则手机连不上 |
| 语音限制 | 局域网是 http（非安全上下文），手机浏览器禁用 `getUserMedia`，**语音输入在手机上不可用**；朗读回答正常 |

### 便携版（单文件 exe，免 Node）

`portable/dist/DeepSeekChatBox.exe` —— **102.9 MB 单文件**，内嵌 Node 22 运行时 + 全部前端资源，双击即用：

- 不解压、不装 Node、不写注册表、不联网下载；删掉 exe 即彻底卸载
- 启动后自动挑端口（默认 17321，占用则顺延），已开实例时只打开浏览器不重复起服务
- 打包原理：Node SEA（`--experimental-sea-config`）+ postject 注入 blob
- 重新构建：`npm i`（装 devDependency postject）→ `node portable/build.mjs`（要求 Node ≥ 20.12）。
  postject 路径自动探测：环境变量 `POSTJECT_CLI` → 项目 `node_modules` → 上级 `node_modules`，换机器无需改源码

**已验证**：exe 从 `%TEMP%` 下运行、静态资源全部来自内嵌 blob（index/css/js/vendor/字体/mermaid 均 200）、
`portable: true`、mock 流完整、真实接口返回 401 且错误体透传、二次启动检测生效。

> 便携版是控制台程序，双击会留一个命令行窗口，关窗口即停服。
> 未做代码签名，首次运行 Windows 可能提示「未知发布者」→ 更多信息 → 仍要运行。
> 换端口不影响数据（服务端按文件存），只是浏览器地址变了；尽量保持 17321 空闲以免开两份实例。

---

## 2. 功能清单（对照官方文档实现）

### 对话与模型
| 功能 | 实现方式 |
|---|---|
| 流式输出 | `stream: true` + `stream_options.include_usage`，逐 chunk 渲染 |
| 模型切换 | `/models` 拉取；内置 `deepseek-flash`（文本+图片）、`deepseek-v4-pro`（文本） |
| 思考模式 | `thinking: {type: enabled/disabled}`，默认开启 |
| 思考强度 | `reasoning_effort: low / high / max`（设置里另有 none 语义：关闭思考） |
| 思考过程 | `reasoning_content` 折叠块，实时流式、结束显示耗时 |
| 多轮上下文 | 无状态 API，客户端拼接完整历史 |
| 会话标题 | 首次请求带 `title: {enabled: true}`，读 `delta.title`；失败用首条消息兜底 |
| 继续生成 | `base_url/ beta` + 最后一条 assistant 加 `prefix: true` |
| 重新生成 / 编辑重发 | **不截断**：在同一父节点下挂新分支，旧回答保留；消息下方 `‹ 1 / 2 ›` 可来回切换（移植官方 `branches.ts` 的 `parentId` + `selectedChildId` 树） |
| 用量与费用 | `usage`（prompt/completion/cache hit/reasoning/tool）逐条展示，按设置里的**峰谷单价**估算并标注「高峰价/空闲价」；**单价档位在收到 usage 的那一刻按消息发送时间定档并落盘**（`message.cost`），之后跨时段、改价都不回溯，历史费用不会漂 |

### 联网与文件
| 功能 | 实现方式 |
|---|---|
| 智能搜索（官方模式） | `tools: [{type:'deepseek_web_search'}]`，关闭思考为普通搜索、开启为深度思考搜索 |
| 阅读链接（官方模式） | `tools: [{type:'deepseek_read_url'}]` |
| 智能搜索（本地模式，默认） | 本机 `web_search` function：Bing RSS → Bing HTML → 360 逐级兜底，前端不需要任何 Key |
| 阅读链接（本地模式，默认） | 本机 `fetch_url` function：抓 HTML → 正文定位 → 去导航 → 转纯文本，超长自动截断 |
| 搜索进度 | 官方模式读流式 `server_tool_event`；本地模式显示工具卡片的「联网搜索 · 关键词」与耗时 |
| 来源引用 | 官方模式回传 `server_tool_calls`，`annotations` 按码点插入上标角标；本地模式由模型在正文里写 Markdown 链接 |
| 搜索结果面板 | 工具卡片「全部来源 N」→ 右侧独立面板（手机端全屏），尺寸对齐官方 `SearchPanel` |
| 图片输入 | 优先 Files API（`user_data`）拿 `file_id`，失败退回 base64 `image_url`；本地存缩略图 |
| 文档解析 | `POST /files` + `purpose: text_recognition / rich_layout_recognition`（可在设置切换） |
| 文本文件 | txt/md/csv/json/代码直接内联进消息（不消耗解析费用） |

#### 本地联网 vs 官方联网（v1.6.0）

实测（2026-11）发现一条硬限制：**`tools` 里只要出现任何一个 `type:"function"`，`deepseek_web_search` 与
`deepseek_read_url` 就完全不会被触发**（API 侧互斥，声明了也不报错，只是静默不生效）。
所以本版把联网做成两套实现，在设置 → 生成页切换：

| | 本地联网（默认） | 官方服务端 |
|---|---|---|
| 声明 | `web_search` / `fetch_url` 两个 function | `{type:'deepseek_web_search'}` / `{type:'deepseek_read_url'}` |
| 执行 | 本机 Node 直接请求搜索引擎与网页 | DeepSeek 服务端 |
| 与其它本地工具 | **可以同时使用** | **互斥**，本地工具全部不传 |
| 模型限制 | 不限 | 只支持 `deepseek-flash` |
| 引用 | 模型写 Markdown 链接（来源取自工具返回值） | 官方 `annotations` 上标 + 悬停卡片 |
| 依赖 | 本机能访问 Bing / 360 / 目标站点 | 只需要能访问 DeepSeek API |

本地联网的提示词约束（`api.js` 的 `webSystemPrompt`）要求模型：实时或易变信息先搜、关键事实用
`fetch_url` 读原文核实、链接必须来自工具返回值、网页里的指令一律不执行（防提示词注入）。

正文抽取做了三层处理，实测比裸剥标签干净很多：
1. `<article>` / `<main>` 存在时优先；
2. 否则按「文本量 − 链接文本×2」挑主容器（天气站、门户首页这类导航堆满的页面靠 class 关键词删不干净）；
3. 最后按 class/id 关键词（nav / menu / footer / share / comment…）用栈配对整块删除导航容器；
   单块超过页面 40% 视为误判直接放弃，避免把正文一起删掉。

### 输入区细节（对齐官方 chat-demo）

| 项 | 说明 |
|---|---|
| 高度自适应 | 隐藏 mirror 撑高度（官方做法），换行/删除不再抖动，上限 336px |
| 附件缩略图 | 64×64 圆角 16；上传中转圈蒙层；失败时红边 + 蒙层 + 原因，点击可重试（原始 File 保留在内存，不进 JSON） |
| 录音频谱 | 边录边算，输入框首行 60 根对数分段柱（100–4000Hz、倍频程补偿、快起慢落），录音时正文隐藏 |

### 内置工具（function calling，服务端执行）

开启输入框的「工具」开关后，模型可主动调用本机工具，密钥始终留在服务端：

| 工具 | 作用 | 返回 |
|---|---|---|
| `web_search` | **联网搜索**（本机执行） | 标题 / 链接 / 摘要 / 日期，Bing RSS 优先，失败换 Bing HTML、360 |
| `fetch_url` | **抓取网页正文**（本机执行） | 标题、最终 URL、编码与正文纯文本（默认 8000 字，可指定 max_chars） |
| `get_balance` | 查账号余额 | 总余额 / 赠金 / 充值余额 / 是否可用 |
| `list_models` | 列出可用模型 | id、上下文、最大输出、是否支持图片 |
| `current_time` | 本机当前时间 | ISO 时间、星期、时区、UTC 偏移 |
| `search_history` | 搜索本地历史对话 | 标题、时间、命中片段（最多 20 条） |
| `usage_stats` | 本地用量统计 | 对话数、消息数、输入/输出/缓存命中 tokens |
| `calculator` | 安全表达式计算（递归下降解析，**不用 eval**） | 支持 `+ - * / % ^`、括号、`sqrt/abs/round/min/max/pow/log/exp/三角函数`、`PI/E` |
| `hash_text` | 文本哈希 | md5 / sha1 / sha224 / sha256 / sha384 / sha512 / sha3-224 / sha3-256 / sha3-384 / sha3-512 十六进制 |
| `base64_codec` | Base64 编解码 | UTF-8 安全，支持中文 |
| `url_codec` | URL 编解码 | `encodeURIComponent` / `decodeURIComponent` |
| `json_format` | JSON 校验 / 格式化 / 点路径提取 | 美化输出，路径不存在时报错 |
| `text_stats` | 文本统计 | 字符数、去空白字符、行数、段落、汉字数、英文词数 |
| `uuid_gen` | 生成 UUID v4 | 一次 1–50 个 |
| `random_pick` | 随机整数 / 列表抽取 | 支持 `min/max`、`items`、`count`、`unique` |
| `dns_lookup` | 域名解析（本机 DNS） | IPv4 / IPv6 地址列表 |
| `port_check` | TCP 端口连通性探测 | 可连通 / 超时 / 拒绝，含耗时 |
| `http_request` | 发 HTTP 请求 | 状态码、响应头摘要、正文片段；禁本机与保留地址 |
| `local_ip` | 列出本机网卡 IP | 网卡名、IPv4/IPv6、掩码 |
| `base_convert` | 进制转换 | 2/8/10/16 互转 |
| `percentage` | 百分比计算 | 占比 / 增长率 / 折扣 / 增加百分比 |
| `date_diff` | 日期间隔 | 天/小时/分钟差 |
| `unit_convert` | 单位换算 | 长度/重量/温度/数据/时间 |
| `regex_test` | 正则匹配测试 | 匹配项、位置、命名分组 |
| `diff_text` | 逐行文本差异 | 新增/删除/相同行数（LCS） |
| `csv_json` | CSV ↔ JSON 互转 | 自动处理引号与逗号转义 |
| `slugify` | 生成 URL/文件名安全标识 | 保留中文、空格转连字符 |
| `password_gen` | 随机密码生成 | 可配置字符集，含熵与强度估算 |
| `id_validator` | 编号格式校验 | 身份证（含校验位）/ 邮箱 / 手机号 / IPv4 / UUID |
| `timestamp_convert` | 时间戳 ↔ 日期互转 | 秒/毫秒、时区偏移 |
| `json_minify` | JSON 压缩成一行 | 返回节省字节数 |
| `token_count` | **DeepSeek V4.1-Flash 分词器** | 本地精确算 token 数，可返回每个 token 的 id 与片段；离线、零费用 |
| `qr_text` | **生成二维码（v1.10.0，v1.12.0 扩到 16KB）** | 自研 QR 编码器（byte 模式，版本 1–40，L/M/Q/H，单张最多 2953 字节 @L），落盘为灰度 PNG 到 `data/qr/`；输入 ≤16KB，超单张容量自动切成多张并标 `#i/N`，也可输出终端字符画 |
| `stat_calc` | 数字统计 | 均值 / 中位数 / 众数 / 极差 / 样本与总体方差、标准差 / 四分位与 IQR / 1.5×IQR 异常值 |
| `hex_view` | 十六进制查看与还原 | `toHex` 输出带偏移与 ASCII 侧栏的 hex dump；`fromHex` 容忍空格、`0x`、逗号分隔，非 UTF-8 时给 base64 |
| `color_convert` | 颜色互转与对比度 | HEX / RGB / HSL / HSV、相对亮度、YIQ、对白/黑及自定义背景的 WCAG 对比度 |
| `text_kit` | 文本批量处理 | 去重 / 排序（字典、数值、长度）/ 清理空行与空白 / 加前后缀 / 按分隔符拆行 / camel·snake·kebab·pascal·const·title 命名转换 |
| `aes_crypto` | AES 对称加解密 | CBC / GCM / ECB，key 与 iv 支持 utf8·hex·base64，GCM 返回 auth tag；用于复现前端加密、解接口密文 |
| `eval` | **【默认关闭】浏览器端 JS 执行** | 支持 `await` 与 `console` 回显；服务端拦直接调用，只在浏览器主线程执行 |
| `sub_agent` | 子智能体（cloud / local） | local 可接 Ollama 原生接口或任意 OpenAI 兼容 `/chat/completions`；支持工具调用、图片输入与思考强度 |
| `peak_status` | 当前 DeepSeek 峰谷时段 | 北京时间、当前峰/谷、计价规则、下次切换时间（不含法定节假日/调休） |
| `compress_history` | 压缩对话上下文 | 把较早消息交给子模型摘要，保留最近 N 条原文，返回新序列与节省的 token；不自动改写历史 |
| `cmd_run` | **【危险】本机 cmd 执行命令** | 退出码 + stdout/stderr；默认关闭，见下 |

- 工具定义由 `GET /api/tools/definitions` 下发，执行走 `POST /api/tools/call`，浏览器不接触 Key
- 定义里的 `meta.web`（`search` / `fetch`）只用于前端区分「联网工具」与「本地工具」，发请求前会被剥掉；
  `meta.cmd` 用于前端按 `cmdEnabled` 开关过滤
- **工具按需加载（搜索引擎）**：44 个工具如果每次全量声明，光定义就约 5800 tokens/轮
  （新增这 6 个只多约 250 tokens，因为描述都控制在两行内）。
  现在用 `public/js/tool-search.js` 的 BM25 检索：工具名 + 强关键词 + 描述分词打分，
  每轮只下发与当前问题相关的工具（设置 → 生成 → 「工具按需加载」可选 4/8/16/全部）。
  实测「算 128×0.85」只下发 calculator（约 150 tokens，省 97%）；
  **已在对话里调用过的工具会自动保留**，多轮工具循环不会断链。
- **模型自己找工具（v1.9.0）**：`find_tool` 元工具常驻下发。模型判断现有工具不够用时，
  自己调 `find_tool(query)` 搜索工具目录 → 服务端返回匹配工具的名字/描述/参数 →
  前端把这些名字记入 `foundTools`，下一轮自动追加进 `tools`，模型直接调用。
  实测「算一下折扣」→ calculator + percentage，「检查端口」→ port_check。
  - **`list` 子指令（本次新增）**：`find_tool({action:"list"})`（或 `query:"list"/"全部"`）直接返回全部
    工具目录（名字 + 一句话说明，按 60 字截断），并把它们一并加入下一轮可用；
    `cmd_run` 未开启时不会出现在目录里。空参数调用会提示「想列出全部工具请传 action="list"」。
- `token_count` 用官方 `DeepSeek-V4.1-Flash` 的 `tokenizer.json`（6.4 MB，存 `public/vendor/tokenizer/`），
  自研 Node BPE 实现（`server/tokenizer-core.cjs`，零依赖）：预分词三条正则 + ByteLevel 映射 + merges 合并。
  V3 / R1 / V4-Pro / V4.1-Flash 共用同一份 128000 基础词表，所以一个词表覆盖全部模型。
- `web_search` / `fetch_url` 由输入框的「搜索」「阅读链接」开关控制，其余工具由「工具」开关控制；
  官方联网模式下「工具」开关会被禁用（互斥）
- **命令执行（v1.7.0，默认关闭）**：设置 → 生成 → 「开启命令执行 cmd_run」。开启后模型可在本机
  `cmd.exe` 直接执行任意命令（**不经过沙箱**，可读写文件、访问网络）。前端按 `cmdEnabled` 过滤下发，
  服务端 `tools.call()` 再校验一次——即使浏览器缓存了旧定义、或直接调 `/api/tools/call`，未开启时一律拒绝。
  默认超时 30 秒（最大 120 秒），输出上限 6 万字节（约 2 万字符），cmd 的 GBK 中文输出按替换字符数自动选解码。
  用完建议关掉。
- 一次提问最多 **10 轮**「模型请求工具 → 本地执行 → 再请求」的往返（一轮可同时调多个工具，所以不是"只能调 10 次工具"）；
  用满后不再静默停下，而是**关掉工具通道并给模型一条系统提示**，让它基于已有结果直接作答、信息不足就明说
- **连续多轮、以及同一轮里的多个调用会合并成一张折叠卡片**
  （`工具调用 ×N` + 工具名汇总），点开才列出每次调用的参数、结果与耗时，不再一行一个占满屏幕
- 关闭开关即不声明 `tools`，请求体退回普通对话

### 插件系统 CPL（v1.16.0）

**CPL = ChatBox Plugin Loader**，扩展加载器。插件装一次，可以拦消息、改上下文、加工具、加界面入口。

#### 插件包结构

```
myplugin.zip
├─ data.json        清单：id / uniqueVersion / name / description / author / permissions / requires …
├─ contents/*.json  方法定义（非复杂逻辑用这个就够了）
├─ scripts/*.js|py  代码（复杂逻辑；可只放其中一个）
├─ assets/          素材
└─ fav.png          图标（缺了用默认图标）
```

三种写法可以共存：`json` 负责声明式拦截，`js` / `py` 负责写逻辑。同一个插件里的方法共享一个命名空间。

#### ID 体系

```
[namespace@][版本条件]:方法名
```

| 写法 | 含义 |
|---|---|
| `function` | 省略命名空间 → 插件内指向**自己**，其余场景指向 `cdcp` |
| `myplug:onSend` | 插件 `myplug` 的方法，不限版本 |
| `myplug@13520:onSend` | 同上，且唯一版本号必须等于 13520 |
| `myplug@>=13520:onSend` | 大于等于；另支持 `>` `=` `<` `<=` |
| `myplug@[13520,14520]:onSend` | 闭区间；也支持 `(a,b)` `[a,b)` `(a,b]` |
| `@>=13520:onSend` | 省略命名空间 + 带版本：插件内指向自己，其余指向 `cdcp` |

- `@` 与版本条件必须**同时出现或同时省略**
- 版本号是 **unsigned long long**（与语义版本无关，纯数字，用 BigInt 比较）
- 版本条件在**调用侧真的会校验**：工具 / API / hook 解析时都会比对目标的 `uniqueVersion`，
  比如 `demo@>999:foo` 当前是 `13520` 就会失败并明确告诉你「版本条件不满足：…（当前 uniqueVersion 13520）」，
  不会静默命中一个不匹配的版本
- 版本条件只影响**解析是否命中**，不影响注册：注册表里每个命名空间只保留一个版本（安装时同名插件无法共存）
- 保留命名空间：`cdcp`（chatbox 自身）、`cdcptools`（内置工具集）、`cpl`（加载器）
- **同名对象插件优先**；插件之间同名的，后加载者胜并记入冲突列表

#### 工具的命名与调用

**分隔符口径（v1.16.2）**：命名空间与方法之间**一律用冒号** `ns:方法名` —— 内部 ID、插件页、日志、文档、插件内调用写法全按这个来。
只有一个地方不得不转义：发给模型的 `function.name`，因为 OpenAI / DeepSeek 只接受 `[A-Za-z0-9_-]`，冒号会让整条请求 400，
所以模型侧自动换成 `ns__方法名`（唯一使用双下划线的地方）。插件里写两种都认，但推荐冒号。

| 场景 | 规则 |
|---|---|
| 模型看到的工具名 | 内置工具保持裸名（`current_time`）；第三方插件工具 `命名空间__工具名`（API 硬限制，唯一转义处） |
| 插件内调用 `tools.call('foo')` | 先找**自己**注册的 `foo`，没有再回退到 **cdcp / cdcptools** 的 `foo`；都找不到就报未知工具 |
| 插件内调用自己的工具 | `tools.call('foo')` 或 `tools.call('myplug:foo')`，两者等价 |
| 插件内调用别的插件的工具 | 必须写全 `别的ns:foo`（或兼容写法 `别的ns__foo`）；裸名永远不会落到别的插件上 |
| 两个插件注册同名工具 | 不会互相覆盖：各自带自己的命名空间，都能被调到 |

#### 接口规模

| 侧 | hook 点 | 能力 API |
|---|---|---|
| `json` | 91 | 78 |
| `js` / `py` | 169 | 117 |

hook 覆盖：消息 / 上下文 / 请求响应 / 工具 / 会话 / 分组 / 设置 / 存储 / 界面 / 网络 / 应用 / 插件 / 模型 / 子智能体 / 附件 / 检索 / 用量。
API 覆盖：消息 / 会话 / 工具 / hook / 事件总线 / KV / 配置 / 网络 / 文件 / 界面 / 日志 / 工具函数 / AI / 上下文 / 平台。

实测口径：`GET /api/cpl/catalog` 会返回真实数量，README 不写死估算值。

#### json 方法长什么样

```json
{
  "id": "stamp",
  "name": "给消息加标记",
  "actions": [
    { "type": "message.before_send", "event": "ctx.set", "args": [{ "stamped": true }] }
  ],
  "before": [],
  "after": []
}
```

- `type` = 触发条件（hook 点），`event` = 要触发的事件（cdcp API / hook / 插件自定义事件），`args` 传给事件
- `args` 里的 `"{{content}}"` 会从上下文取值
- `event: "ctx.set"` 是约定出口：参数对象直接合并回上下文（可改写能力）
- `before` / `after` 填完整 ID，决定同一点上多个处理器的先后（拓扑排序）

#### 管理页（独立整页 `/cpl`）

插件管理器是**独立页面**，不挤在设置弹窗里：

- 本地版：`http://127.0.0.1:17321/cpl`（`/cpl/` 同效）。设置里点「插件」会直接跳到这一页，**左上角返回键**回聊天
- 云端专版：入口同为「设置 → 插件」，走 `#/cpl`（静态托管下不依赖服务端对自定义路径的兜底，也不会被资源网关拦）
- 页面能力：安装（上传 zip）、启用 / 禁用、卸载、全部重载
- 每个插件显示接口计数（工具 / Hook / API / UI）、权限、前置依赖、错误信息
- 详情里可展开运行日志与插件自己的配置项（`data.json` 的 `config` schema）
- 列表里 `cdcp`（ChatBox 自身）与 `cpl`（加载器本体）**和普通插件一样显示**：描述、接口计数、详情与日志；
  区别只有一条——核心插件不给禁用 / 卸载（开关与删除按钮置灰，`title` 说明原因）
- 元数据全部由服务端下发，前端不写死：**权限**取自插件自己的 `spec.permissions` / `data.json`（内置插件也逐个声明，`cdcp` 是空数组＝不调用扩展接口），**图标**走 `iconUrl`（内置 → `/assets/plugin-*.png`，第三方 → `/api/cpl/icon/<ns>`），新增内置插件不用改前端
- 详情里的**「实现」**一行说明插件是用什么形式写的：内置插件是「内置模块（服务端 js，不经过插件包）」，第三方是「N 个 JSON 方法」「N 个脚本」。
  内置插件的 **方法/脚本计数本来就是 0** —— 它们不走 `data.json` 方法也不走 js/py 脚本，而是由 `registerBuiltinSync` 直接注册；
  真实的产出体现在「接口」一行的工具数上（`cdcptools` = 44 个工具）

#### 安全边界（不夸大）

- 插件在**服务端执行**，权限需在 `data.json` 里声明（`net` / `fs` / `ui` / `tools` / `kv` / `config` / `ai` / `store` …）
- `js` 走 `node:vm` 沙箱、`py` 走子进程；沙箱挡手滑，**挡不住蓄意逃逸** —— 只装信任的包
- hook 处理器有超时（5s）与熔断（连续失败 5 次停 60s），插件异常不会拖垮主程序
- 云端专版：**只接受 json 插件**（无可执行代码），插件定义存在浏览器侧、按账号隔离，服务端在请求内临时执行后即销毁

---

### 会话分组与独立设置
| 功能 | 实现方式 |
|---|---|
| 朗读回答 | `POST /v1/tools/tts`（`stella` / `tide`，wav） |
| 语音输入 | MediaRecorder 录 Ogg Opus → `POST /v1/tools/asr` |
| 用户元信息 | 每轮插入 `latest_reminder`（日期,星期,所在地,Web,语言），可关闭 |
| 内容安全 | `safety_check: {level:'high'}`，处理 `finish_reason: content_filter` 与 `refusal` |
| 余额 | `GET /user/balance` |
| JSON 输出 | `response_format: {type:'json_object'}`，客户端校验并提示 |
| 数据管理 | 服务端落盘；导出 JSON / 导出 Markdown / 导入 / 清空 |

- **三级设置**：全局 → 分组 → 会话，逐层覆盖；改哪一级由「独立设置」开关决定
- **分组**：侧栏底部「新建分组」，对话行上的文件夹图标可移动分组；分组头可折叠、可改名/删除（删组不删对话）
- **会话设置**（顶栏齿轮）：分组归属、模型、系统提示词、思考/强度、搜索/阅读链接/工具、安全、JSON、温度、max tokens
- 组内有独立设置时，输入框的开关只影响当前会话（自动拆成会话级覆盖，不动同组其它对话）

#### 设置页的每个分标签都是独立地址

| 页面 | 本地 | 云端专版 |
|---|---|---|
| 通用（API Key / 语言 / 主题） | `/settings/general` | `#/settings/general` |
| 模型与参数 | `/settings/model` | `#/settings/model` |
| 生成（联网 / 本地工具 / 子智能体） | `/settings/gen` | `#/settings/gen` |
| 数据（存储位置 / 导入导出） | `/settings/data` | `#/settings/data` |
| 关于（版本 / 快捷键） | `/settings/about` | `#/settings/about` |
| 插件管理 | `/cpl` | `#/cpl` |

- 直接访问任一带 tab 的地址会打开对应分页（左侧导航同步选中，标签页标题跟着变），不再全落到同一个 `/settings`
- 页内点导航切换分页时用 `history.replaceState` 同步地址栏，不整页刷新（云端 hash 变化也不会触发重新挂载）
- `/settings` 等价于 `/settings/general`；`/settings/plugins` 会跳到 `/cpl`（插件管理器本来就是一整页）
- 设置入口（侧栏齿轮、错误提示里的「打开设置」）统一跳 `/settings/general`；录入过程中再点齿轮仍是弹窗，不会丢失未保存的输入

### 手机端适配

不是简单缩窗口，按触屏特性重排了：

| 场景 | 做法 |
|---|---|
| 抽屉侧栏 | ≤900px 侧栏改为抽屉（宽 `min(86vw,340px)`）；选中会话/新建对话后自动收起；点遮罩关闭 |
| 手势 | 从屏幕左缘右滑打开侧栏，在侧栏内左滑关闭（带方向判定，不干扰纵向滚动） |
| 触摸目标 | 顶栏与输入栏按钮 ≥38×38，收起态胶囊内按钮 28×28（官方同规格），会话行 42px，侧栏功能项 44px |
| 触屏无 hover | 会话行操作按钮（移动分组/置顶/重命名/删除）改为常显，否则手机上永远摸不出来 |
| 输入栏 | 三个开关只留图标（带 `title`），发送键放大；`high` 档位保留文字 |
| 动态视口 | `100dvh` + `visualViewport` 写入 `--app-height`，软键盘弹出时输入框不会被挡住 |
| 安全区 | 顶栏/侧栏/输入区/弹窗底栏都加了 `env(safe-area-inset-*)`，适配刘海与底部横条 |
| 设置页 | ≤760px 全屏（底栏贴底），小对话框仍居中卡片 |
| iOS 缩放 | 所有输入控件字号抬到 16px，聚焦时不会自动放大整页 |
| 横屏 | ≤520px 高时压缩顶栏与输入区，输入栏保留文字但放开宽度（固定宽度会把文字挤成竖排） |
| 其他 | 去掉 tap 高亮、禁止长按选中、抹掉触摸后的 sticky hover、弹层宽度按视口收敛 |

### 界面
- 侧栏：Logo、搜索、收起侧栏、置顶/今天/7 天/30 天/月份分组、行尾「…」菜单（重命名 / 置顶 / 移动到分组 / 多选 / 删除）、自定义分组的「…」菜单（新建对话 / 重命名 / 分组设置 / 多选本组 / 删除）、多选批量（置顶·删除·导出）、余额、导出、设置
- 顶栏：左侧当前会话标题；收起侧栏后左端出现「展开 / 搜索 / 新建」胶囊；右端模型切换、会话设置、主题切换
- 上下文用量面板：输入框下方「上下文 3.4K / 1M · 0.3%」胶囊（或点回答底部的用量行）打开——上半是占用百分比 + 分段条（系统提示 / 历史对话 / 本轮输入 / 工具结果）+ 图例，下半是两条滑条：**总上下文上限**（32K～1M，超出后发送时按整轮截断历史）与**思考强度**（快速 / 标准 / 极致）
- 消息区：用户淡蓝气泡（`--ds-deepseek-50`）、助手纯文本、思考折叠块、搜索来源卡、代码块（语言标签 + 复制 + 高亮）、表格、KaTeX 公式、Mermaid 图、引用角标、用量行
- 输入区：圆角 24px、三层阴影、自动增高、`Enter` 发送 / `Shift+Enter` 换行、粘贴与拖拽上传、深度思考 / 智能搜索开关、思考强度、语音、发送/停止
- 主题：浅色 / 深色 / 跟随系统（令牌取自官方 `main.css` 的 `body` 与 `body[data-ds-dark-theme]`）
- 响应式：≤900px 侧栏变抽屉，默认收起

#### 视觉取值的来源（全部为官方站实测，非估算）

用无头浏览器加载官方页面读取 computed style，逐项对齐：

| 项 | 官方取值 | 本项目 |
|---|---|---|
| 字体栈 | `"quote-cjk-patch", "Inter", system-ui, …` | 同（内置 Inter 拉丁子集 4 字重，共 114KB） |
| 正文字号 / 行高 | 16px / 28px | 同 |
| 侧栏 | 261px、`#f9fafb`、`padding 6px 12px 0`、右边框 `1px rgba(0,0,0,.04)` | 同 |
| 会话项 | 40px 高、`radius 12px`、`padding 9px 6px 9px 10px`、14px/22px | 同 |
| 新对话按钮 | 236×40、`radius 100px`、`padding 0 16px`、14px/500 | 同 |
| 输入框外壳 | `radius 24px`、`border 1px rgba(0,0,0,.1)`、三层阴影 `0 4px 12px rgba(0,0,0,.02), 0 2px 2px rgba(72,104,178,.01), 0 30px 60px rgba(72,104,178,.03)` | 同 |
| 输入框内边距 | `12px 12px 0 16px`、字号 16px | 同 |
| 深度思考 / 智能搜索 | 34px 高、`radius 18px`、13px/24px 500；选中 `#edf3fe` 底 + `#b7c8fe` 边框 + `#3964fe` 字 | 同 |
| 发送按钮 | 34×34、`radius 50%`、`#3964fe` | 同 |
| 品牌色 | `#3964fe`（`--dsw-static-deepseek-500`） | 同 |

Inter 只覆盖拉丁字符（`unicode-range` 与官方一致），中文继续走系统字体 —— 这也是官方做法，不是缺字。
官方空态没有「建议胶囊」，本项目的是自创组件，仅沿用官方的 18px 圆角与 13px/500 语言。

### 近期能力（v1.12.6 – v1.16.1）

| 能力 | 版本 | 说明 |
|---|---|---|
| 会话链接与标题同步 | v1.12.3 | 地址栏 `/a/chat/s/<uuid>` 与官方一致，可分享、刷新恢复；标签页标题随会话标题变化 |
| 附件查看与管理 | v1.12.1 | 消息内文本附件可预览、图片可看大图；编辑消息时可预览/移除附件 |
| 浏览器端 `eval` | v1.13.0 | 默认关闭，支持 `await` / `console` 回显，只在浏览器主线程执行 |
| `sub_agent` 子智能体 | v1.13.2 / v1.13.4 | cloud / local；local 支持 Ollama 与 OpenAI 兼容接口，含工具调用、图片输入、思考强度 |
| 官方导出包导入 | v1.13.2 | 直接导入 DeepSeek 官网导出的对话数据包 |
| 设置「关于」页 | v1.14.1 | 显示应用名、版本号、仓库/更新日志链接、快捷键与存储说明 |
| 欢迎页 128 句预设 | v1.14.1 | 中英各 128 条，进入欢迎页随机展示 4 条 |
| 工具执行中可打断 | v1.14.1 | 工具往返期间按钮保持停止态，停止后不会留下残缺 `tool_calls` 导致下一轮 400 |
| 开关分层 | v1.14.2 | 设置页决定「能不能用」（分组可覆盖全局），发送框按钮决定「这次要不要用」；能力闸门不可被会话突破 |
| 峰谷查询 `peak_status` | v1.14.3 | 查当前峰/谷、计价规则与下次切换；版本号同时改为后端唯一真源 |
| 思考块展开状态保持 | v1.15.0 | 手动打开的历史思考块在重绘 / 模型状态切换后不被关闭，内容按消息 id 精确定位 |
| 输入草稿按会话保留 | v1.15.0 | 切走时保留、切回时恢复；只存内存，刷新即丢，发送后作废 |
| 会话草稿与思考块 | v1.15.0 | 输入草稿按会话保留（内存）、历史思考块展开状态不被重绘重置 |
| **CPL 扩展加载器** | v1.16.0 | 插件 zip 安装 / 启停 / 卸载 / 热重载；169 个 hook + 117 个 API；json / js / py 三种写法 |
| 插件管理独立页 | v1.16.0 | 插件管理器是整页 `/cpl`（云端走 `#/cpl`），设置里点「插件」直接跳转，不再占用设置弹窗 |
| 内置工具插件化 | v1.16.0 | 44 个内置工具全部通过 CPL 注册表登记，以后加工具走同一套注册 |
| 上下文压缩 `compress_history` | v1.16.0 | 调子模型压缩历史，保留最近 N 条，报告节省 token |
| 上下文压缩修复 | v1.16.1 | 修云端专版取不到会话、token 统计恒为 0；预演在「压不动」时给出明确说明 |
| 工具轮次上限 1024 | v1.16.0 | 单次回复内「请求工具 → 执行 → 再请求」的往返上限从 10 提到 1024 |

---

## 3. 目录结构

```
deepseek-chatbox/
├─ server.mjs              静态服务 + 服务端存储 API + /api/ds/* 代理 + /api/mock/* 演示
├─ server/store-core.cjs   存储核心（原子写、备份、附件、Key 掩码），源码版与便携版共用
├─ server/tools-core.cjs   内置工具实现（余额/模型/时间/历史/用量 + 联网搜索/网页抓取）
├─ server/lan-core.cjs     局域网口令（Cookie 会话、登录页、未授权拦截）
├─ server/cpl/             CPL 扩展加载器
│  ├─ cpl.cjs              引擎：装载/生命周期/hook 分发/沙箱/用户隔离
│  ├─ ids.cjs              ID 体系（namespace@版本条件:方法名，含区间与比较符）
│  ├─ registry.cjs         注册表：工具/hook/API/UI、冲突仲裁、before-after 拓扑排序
│  ├─ catalog.cjs          接口目录（169 hook / 117 API，含 json 子集）
│  ├─ package.cjs          插件包校验（data.json、方法定义、路径安全）
│  ├─ zip.cjs              零依赖 zip 读取
│  ├─ api.cjs              能力桥（117 个 API 的实现）
│  └─ builtin/tools.plugin.cjs  内置工具插件（44 个工具都经它注册）
├─ data/                   运行时生成：设置 / 对话 / 附件 / 备份
├─ package.json
├─ scripts/check.mjs       一键自检（语法 / 元数据 / 起服务实测 / 仓库状态），见 §3.1
├─ 启动.bat                纯 ASCII + CRLF（chcp 65001 让程序中文日志正常显示），双击即用（源码版）
├─ DeepSeekChatBox-portable.zip   便携版压缩包（38.1 MB）
├─ portable/
│  ├─ sea-main.cjs         便携版入口（SEA / 源码双模式，资源从内嵌 blob 读）
│  ├─ build.mjs            构建脚本：收集 public → blob → 注入 node.exe
│  └─ dist/
│     ├─ DeepSeekChatBox.exe      单文件便携版（102.9 MB）
│     └─ 使用说明.txt             给最终用户的说明（UTF-8 BOM + CRLF）
├─ public/
│  ├─ index.html           结构 + 图标 sprite + 内联 wordmark
│  ├─ css/tokens.css       官方设计令牌（明/暗）
│  ├─ css/app.css          布局与组件
│  ├─ js/app.js            主流程（渲染、流式、会话、语音）
│  ├─ js/api.js            API 封装（payload 构造、SSE 解析、上传、TTS/ASR）
│  ├─ js/markdown.js       渲染管线（代码/公式/引用/Mermaid）
│  ├─ js/store.js          本地存储与会话管理
│  ├─ js/settings.js       设置弹窗
│  ├─ js/cpl-page.js       插件管理独立页（/cpl 整页，云端走 #/cpl）
│  ├─ js/scope.js          分组 / 会话的独立设置弹窗
│  ├─ js/dialog.js         应用内 prompt / confirm（不用浏览器原生弹窗）
│  ├─ js/branches.js       消息分支树（parentId / selectedChildId，移植官方实现）
│  ├─ js/i18n.js           中/英文案
│  ├─ js/brand.js          鲸鱼图形
│  ├─ js/version.js        应用元信息 + 版本号读取（GET /api/version）
│  ├─ js/prompts.js        欢迎页预设（中英各 128 条）
│  ├─ js/eval-tool.js      浏览器端 JS 执行工具
│  ├─ js/import-official.js 官方导出包导入
│  ├─ js/tool-search.js    工具检索（BM25 + 中文 2-gram + 别名）
│  ├─ js/holiday.js        节假日查询（峰谷自动判断）
│  ├─ assets/              logo-wordmark.svg / logo-whale.svg
│  └─ vendor/              marked · highlight.js · katex(+fonts) · mermaid
```

---

### 3.1 一键自检（改完代码跑这一条就够）

```bash
npm run check          # 全量：语法 + 元数据 + 真起一次服务 + 接口/防护实测 + 仓库状态
npm run check:fast     # 快速：不起服务，只查语法 / 版本 / 写死项 / git
node scripts/check.mjs --keep --port 17600   # 保留临时数据目录 / 指定端口
```

| 步骤 | 检查内容 |
|---|---|
| ① 语法 | 全部 `js` / `cjs` / `mjs`（含 `scripts/`、`public/js`）逐个 `node --check` |
| ② 元数据 | 版本号真源（`package.json`）与 README / 两份使用说明 / 专版 `package.json` 是否一致；前端与便携版入口有没有写死版本；前端有没有写死内置插件映射；文档里写的工具数是否等于实际工具数 |
| ③ 起服务 | 临时端口 + 临时数据目录冷启动，量**从进程启动到 `/api/health` 可应答**的耗时（启动脚本的时序问题看这个数） |
| ④ 接口与防护 | `/api/version`、`/api/cpl/plugins`（内置插件齐全、权限是数组、`iconUrl` 可访问、工具全登记在 `cdcptools`）、`/`、`/cpl`、`/settings` 能否打开、跨站 Origin → 403、非 JSON 写请求 → 415、`%2e%2e%2f` 穿越 → 403 |
| ⑤ 仓库状态 | 未提交改动清单、最近一次提交、HEAD 有没有 tag、发布 zip 是否比源码旧 |

- 退出码：`0` 全过（允许 WARN），`1` 有 FAIL。提交 / 发版前必须 0 FAIL。
- WARN 是「需要人看一眼」的提示（未提交、没打 tag、zip 落后），不阻塞。
- 服务端自检用的临时 `--data-dir`，不会动到 `data/` 里的真实会话与 Key。

---

## 4. 接口对应（全部来自 api-docs.deepseek.com/zh-cn 的当前版本）

| 用途 | 端点 |
|---|---|
| 对话 | `POST /chat/completions` |
| 前缀续写 | `POST /beta/chat/completions`（最后一条 assistant `prefix: true`） |
| 模型 | `GET /models` |
| 余额 | `GET /user/balance` |
| 文件 | `POST /files`、`GET/DELETE /files/{id}` |
| 语音 | `POST /v1/tools/tts`、`POST /v1/tools/asr` |
| 搜索/抓取（独立接口，未内置 UI） | `POST /v1/tools/search`、`POST /v1/tools/fetch` |
| OCR（未内置 UI） | `POST /v1/tools/ocr` |

代理规则：`/api/ds/<path>` → `https://api.deepseek.com/<path>`，方法、请求体、响应（含 SSE）原样透传；可用设置里的 Base URL 或请求头 `x-ds-base` 指向兼容代理。

---

## 5. 注意事项

- **API Key 安全**：用 **Windows DPAPI**（CurrentUser 范围，底层 `CryptProtectData`）加密后存 `data/settings.json` 的 `apiKeyEnc`，明文只在内存中。文件被拷到别的机器 / 别的 Windows 账户、或误传进备份与压缩包时只有密文可看。代理不打印、不外传；`GET /api/store` 只返回掩码 `sk-xx…abcd`。
  - 纯 Node 零依赖：通过系统自带 PowerShell 调 `System.Security.Cryptography.ProtectedData`；便携版 SEA 同样生效。
  - 首次读到旧版明文 `apiKey` 会自动加密迁移；解密失败（换账户/换机）会提示重新填写。
  - 非 Windows 或 DPAPI 调用失败时回退明文并打警告。**边界**：DPAPI 绑定的是 Windows 用户，同一用户下能执行代码的程序仍可调 DPAPI 解密——它防的是“文件被读走/拷走”，不防“同用户恶意程序”。公用电脑用完请点设置里的「清除」。
- **数据即文件**：删 `data/` 等于清空所有数据（含 Key）；迁移直接拷整个文件夹。
- **峰谷定价**（2026-11 官方表）：模型按「百万 tokens」计费，分空闲/高峰两档，**空闲价是高峰价的一半**。
  高峰 = 周一至周五 09:00-12:00、14:00-18:00（北京时间）；其余时段、周末、法定节假日均为空闲。
  **法定节假日自动判断（v1.9.0）**：`public/js/holiday.js` 按顺序查询多个免费 API
  （jiejiariapi → xiaoai.me → pinjia.day → Nager.Date），任一个成功即用，结果按日期存 localStorage 缓存，
  一天只请求一次；全部失败时退回「周末判断」不影响主流程。调休补班日（周末但要上班）按高峰处理。
  这些源均在本机实测通过（2026-11-23），详见下方「节假日 API 调研」。
  设置 → 生成 里有 2 个模型 × 3 类用量 × 2 档 = **12 个价格**，默认值已按官方表填好：

  | 模型 | 缓存命中 空闲/高峰 | 缓存未命中 空闲/高峰 | 输出 空闲/高峰 |
  |---|---|---|---|
  | `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
  | `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

  - 时段判断可切「自动识别 / 按空闲价 / 按高峰价」；自动模式走上面的节假日 API，识别不到时退回周末规则
  - 只估算模型 token；Search / Fetch / 文件解析 / TTS / ASR 不在此列（官方另计）
  - 旧版单档价格会自动迁移：旧值视为高峰价，空闲价按一半折算，并写回 `data/settings.json`
- **联网工具限制**：官方模式下 `deepseek_web_search` / `deepseek_read_url` 只能配 `deepseek-flash`；声明后 `temperature / top_p / stop / response_format` 会被服务端忽略；用过联网工具的回答不能再「继续生成」；并且**只要同时声明了任何本地 function，官方联网工具就静默失效**（v1.6.0 起默认改走本地联网，不受这条限制）。
- **本地联网的边界**：搜索走 Bing（`cn.bing.com`，失败自动换 `www.bing.com`、360），抓取走目标站点直连。
  本机访问不到的站点（实测 DuckDuckGo、维基百科在部分网络下不通）会返回失败提示，此时模型会换关键词或改用摘要。
  另有反爬站点（知乎、小红书等）返回 401/403，属于站点限制，不是程序问题。
  `fetch_url` 允许抓公网 http(s) 与 `127.0.0.1`（v1.6.1 起，方便抓本机服务）；其余本机/保留地址仍拦：
  `127.0.0.2` 等 127 段其他地址、`localhost`、`0.0.0.0`、`::1`、`169.254.x`（云元数据）、`fe80:*`。
- **思考模式限制**：思考模式下 `temperature / presence_penalty / frequency_penalty` 不生效；`top_p` 行为随模型而异。
- **图片**：`deepseek-v4-pro` 不支持图片输入，选它时会提示；图片经压缩（最长边 1568px）后上传。
- **存储**：对话写入 `data/conversations.json`（原子 rename，另有 5 分钟一次的滚动备份）；图片进 `data/attachments/`，不塞进 JSON。浏览器 `localStorage` 全程为空（可用 DevTools 验证）。
- **反代与跨域**：浏览器直连 `api.deepseek.com` 会受 CORS 限制，所以必须经本地服务转发；请保持服务运行。
- **演示模式**：`/api/mock/*` 返回内置示例（含思考、搜索卡、表格、代码、公式、Mermaid），不产生任何费用。

---

## 6. 节假日 API 调研（v1.9.0，2026-11-23 实测）

为峰谷自动模式找中国法定节假日/调休数据源，以下均来自各服务官方文档或知名开源项目，
并在本机逐一发起真实请求核验（连通性、状态码、返回结构），不是凭搜索摘要：

| # | 服务 | 端点示例 | 本机实测 | 说明 |
|---|---|---|---|---|
| 1 | jiejiariapi | `api.jiejiariapi.com/v1/is_holiday?date=2026-10-01` | ✅ 200，2.6s | 单日判断最准；匿名 50 次/天，Key 100 次/天 |
| 2 | jiejiariapi | `api.jiejiariapi.com/v1/holidays/2026` | ✅ 200，5.8s | 全年节假日 map |
| 3 | jiejiariapi | `api.jiejiariapi.com/v1/workdays/2026` | ✅ 200，3.6s | 全年工作日（含调休） |
| 4 | xiaoai.me | `publicapi.xiaoai.me/holiday/day?date=2026-10-01` | ✅ 200，1.2s | daytype 0/1/2/3 区分工作日/节假日/双休/调休 |
| 5 | xiaoai.me | `publicapi.xiaoai.me/holiday/year?date=2026` | ✅ 200，0.3s | 全年数据，最快 |
| 6 | pinjia.day | `pinjia.day/api/v1/holidays?year=2026` | ✅ 200，2.6s | 明确标注调休补班，含国务院文号 |
| 7 | Nager.Date | `date.nager.at/api/v3/PublicHolidays/2026/CN` | ✅ 200，4.8s | 国际知名开源项目，100+ 国家，无 Key |
| 8 | Nager.Date | `date.nager.at/api/v3/AvailableCountries` | ✅ 200，0.7s | 国家代码列表 |
| 9 | chinese-days | `cdn.jsdelivr.net/npm/chinese-days@1.5.4/dist/chinese-days.json` | ✅ 200，1.3s | 开源库 JSON，2004–2026 + 农历节气 |
| 10 | ShuYZ 中国节假日 | `raw.githubusercontent.com/lanceliao/china-holiday-calender/master/holidayAPI.json` | ✅ 200，0.9s | GitHub 开源，ICS + JSON，含补班数组 |
| 11 | ShuYZ（国内镜像） | `www.shuyz.com/githubfiles/china-holiday-calender/master/holidayAPI.json` | ✅ 200，0.8s | 同上，国内直连 |
| 12 | timor.tech | `timor.tech/api/holiday/info/2026-10-01` | ⚠️ 本机超时 | 知名免费源，本机网络不通（文档称已支持 HTTPS） |
| 13 | jieri8.com | `www.jieri8.com/api/holidays.php?year=2026` | ❌ 404 | 文档地址已失效 |
| 14 | Calendarific | `calendarific.com/api/v2/holidays?...` | ❌ 401 | 需 API Key（有免费额度） |
| 15 | public-holidays-api.com | `.../v1/holidays?country=CN&year=2026` | ❌ 连接失败 | 本机不通 |

程序实际使用 1/4/6/7 四个（单日查询、多源兜底），其余列作备选。

## 7. 快捷键

| 按键 | 动作 |
|---|---|
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `Ctrl / ⌘ + Enter` | 换行（主输入框与编辑框一致，不会被当成发送） |
| `Ctrl / ⌘ + K` | 新建对话 |
| `Esc` | 关闭弹层 / 停止生成 |

---

## 8. 已验证

- 代理连通性：伪造 Key 请求真实接口返回 `401 Authentication Fails`，错误体完整透传
- 流式链路：演示模式跑到结束，DOM 校验 `msgs=2 / code=1 / table=1 / katex=2 / mermaid=1 / cites=1 / streaming=false`
- 渲染检查：浅色、深色、1400px 与 820px 三种视口截图核对（见 `.build/ui*.png`）
- 工具回路：演示模式下模型先调用 `get_balance` → 服务端执行 → 结果回传 → 第二轮作答，DOM 校验 `msgs=3`（tool 消息不单独成块）
- 真实工具：用真实 Key 调 `get_balance` 返回 `CNY 总余额 12.00`，`current_time`/`usage_stats` 正常
- 请求体：`payload` 校验含 `tools[function]`、`assistant.tool_calls`、`role:"tool"` + `tool_call_id`，且 `response_format` 在带工具时被正确省略
- 分组：建组、移入、折叠、组内新建、会话独立设置落盘（`groups.json` / `conversations.json`）均验证通过
- 移动分组回归：移出 → 服务端 `groupId: null`、对话回到未分组区；移入 → `groupId: g_xxx`、回到组内，双向落盘均确认
- 手机端（CDP 设备模拟 390×844 / 375×667 / 844×390 横屏）：抽屉 335px、scrim 生效、选中会话自动收起、设置页全屏、对话框居中、菜单不越界
- 软键盘占位（视口 844→500）：`--app-height` 跟随、输入框完整可见、消息区正常压缩
- 局域网：`127.0.0.1` 免口令 200；局域网 IP 无口令 401 登录页；`?k=` 302+Set-Cookie；Cookie 200；错误口令 403；默认模式（不加 `--lan`）局域网 IP 连不上
- 手机经局域网跑完整流式回答：消息 3 条、会话落盘、无失败请求、无 JS 异常
- 弹层：菜单容器实测 260×219（此前 .up 的 `bottom` 与 inline `top` 冲突导致塌陷成 18px，白底只剩一条，选项溢出成"透明"假象）
- 对话框：浅色 / 深色 / 便携版三种环境截图核对，Esc 与 Enter 均生效，不再出现浏览器原生 prompt
- 错误态：401 显示红色提示条，用户消息保留、输入框恢复可用
- 本地联网（v1.6.0）：`web_search` 实测 120–650ms 返回 6–10 条（Bing RSS）；`fetch_url` 抓天气网得出「晴 / 8 / -4℃」且导航已被剔除；
  完整回路问「今天北京天气」→ 模型自行 `current_time` + `web_search` → `fetch_url` 读天气网 → 3 轮内给出带来源的回答
- 编码：`fetch_url` 对 GBK/GB2312 页面用 `TextDecoder('gbk')` 解码验证通过（`d6d0 cec4` → 中文）
- 安全：`fetch_url` 抓 `http://127.0.0.1:...` 放行（v1.6.1，实测抓到本机测试页正文）；`127.0.0.2`、`localhost`、`169.254.169.254`、`::1` 仍被拒绝；知乎 403 如实返回失败
- 互斥：声明 1 个 function 时官方 `deepseek_web_search` 触发次数 0，只声明官方工具时为 2 次（8 条引用）
- 小工具（v1.7.0）：16 个工具全部加载；`calculator` 实测 `(128*0.85+32)/3=47`、`2^10+sqrt(81)=1033`，
  尝试 `__import__("os")` 被解析器拒绝（无 eval）；哈希 / Base64（含中文）/ URL 编码 / JSON 点路径 / 字数统计 / UUID / 随机抽取逐项通过
- cmd 工具：开启时 `ver` 正确返回中文（GBK 自动解码），`ping -n 30` 配 1 秒超时被终止并标记；
  关闭开关后直接调 `/api/tools/call` 被服务端拒绝；前端 `buildPayload` 实测关闭下发 14 个工具（无 `cmd_run`）、开启 15 个（含）
- 设置面板：截图核对红色危险提示与开关排版正常，无溢出

---

## 9. 版本号规则

**网页版（本地 Web + WorkBuddy 专版）只有 `vMAJOR.MINOR.PATCH`，不带构建号。**
修 bug 发版时 `PATCH + 1`，例：`v1.12.5` → `v1.12.6`（历史 tag 保留原名，不追溯）。

**版本号真源在后端**：各自 `package.json` 的 `version` 字段。
前端不硬编码，运行时通过 `GET /api/version` 读取（见 `public/js/version.js` 的 `loadAppVersion()`）；`/api/health` 也返回 `version`。
便携版（SEA 单文件）运行环境里没有磁盘上的 `package.json`，所以 `portable/build.mjs` 在打包时把 `package.json` 的版本
注入到源码占位符 `__DS_CB_VERSION__` 里 —— 源码本身不写死版本，真源仍然只有 `package.json` 一处。

`vX.Y.Z.buildN` 那套累计构建计数**只属于 iOS 原生仓库**（`deepseek-chatbox-cpp`），
口径见该仓库 `docs/版本号与构建计数.md`。根目录 `build-count.json` 已删除（历史留档停在 88，`release.py` 不读写）；
`--test` 只影响 Release 标题的「（测试构建）」标注。
