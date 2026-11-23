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
├─ settings.json        设置 + API Key（明文，仅本机）
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

刻意保留的差异：官方 demo 无顶栏（固定用 `deepseek-flash`，不需要模型切换），
本项目有双模型 + 会话设置 + 主题，因此保留 60px 顶栏；官方用 localStorage + IndexedDB，
本项目改为服务端 `data/` 落盘（见上文）。

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

`portable/dist/DeepSeekChatBox.exe` —— **98.9 MB 单文件**，内嵌 Node 22 运行时 + 全部前端资源，双击即用：

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
| 用量与费用 | `usage`（prompt/completion/cache hit/reasoning/tool）逐条展示，按设置里的**峰谷单价**估算并标注「高峰价/空闲价」 |

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
| `hash_text` | 文本哈希 | md5 / sha1 / sha256 / sha512 十六进制 |
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
| `qr_text` | **生成二维码（v1.10.0）** | 自研 QR 编码器（byte 模式，版本 1–10，L/M/Q/H），落盘为灰度 PNG 到 `data/qr/`，路径与规格一并返回；也可输出终端字符画 |
| `stat_calc` | 数字统计 | 均值 / 中位数 / 众数 / 极差 / 样本与总体方差、标准差 / 四分位与 IQR / 1.5×IQR 异常值 |
| `hex_view` | 十六进制查看与还原 | `toHex` 输出带偏移与 ASCII 侧栏的 hex dump；`fromHex` 容忍空格、`0x`、逗号分隔，非 UTF-8 时给 base64 |
| `color_convert` | 颜色互转与对比度 | HEX / RGB / HSL / HSV、相对亮度、YIQ、对白/黑及自定义背景的 WCAG 对比度 |
| `text_kit` | 文本批量处理 | 去重 / 排序（字典、数值、长度）/ 清理空行与空白 / 加前后缀 / 按分隔符拆行 / camel·snake·kebab·pascal·const·title 命名转换 |
| `aes_crypto` | AES 对称加解密 | CBC / GCM / ECB，key 与 iv 支持 utf8·hex·base64，GCM 返回 auth tag；用于复现前端加密、解接口密文 |
| `cmd_run` | **【危险】本机 cmd 执行命令** | 退出码 + stdout/stderr；默认关闭，见下 |

- 工具定义由 `GET /api/tools/definitions` 下发，执行走 `POST /api/tools/call`，浏览器不接触 Key
- 定义里的 `meta.web`（`search` / `fetch`）只用于前端区分「联网工具」与「本地工具」，发请求前会被剥掉；
  `meta.cmd` 用于前端按 `cmdEnabled` 开关过滤
- **工具按需加载（搜索引擎）**：40 个工具如果每次全量声明，光定义就约 5610 tokens/轮
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

### 手机端适配

不是简单缩窗口，按触屏特性重排了：

| 场景 | 做法 |
|---|---|
| 抽屉侧栏 | ≤900px 侧栏改为抽屉（宽 `min(86vw,340px)`）；选中会话/新建对话后自动收起；点遮罩关闭 |
| 手势 | 从屏幕左缘右滑打开侧栏，在侧栏内左滑关闭（带方向判定，不干扰纵向滚动） |
| 触摸目标 | 顶栏与输入栏按钮 ≥40×40，会话行 42px，侧栏功能项 44px |
| 触屏无 hover | 会话行操作按钮（移动分组/置顶/重命名/删除）改为常显，否则手机上永远摸不出来 |
| 输入栏 | 三个开关只留图标（带 `title`），发送键放大；`high` 档位保留文字 |
| 动态视口 | `100dvh` + `visualViewport` 写入 `--app-height`，软键盘弹出时输入框不会被挡住 |
| 安全区 | 顶栏/侧栏/输入区/弹窗底栏都加了 `env(safe-area-inset-*)`，适配刘海与底部横条 |
| 设置页 | ≤760px 全屏（底栏贴底），小对话框仍居中卡片 |
| iOS 缩放 | 所有输入控件字号抬到 16px，聚焦时不会自动放大整页 |
| 横屏 | ≤520px 高时压缩顶栏与输入区，输入栏保留文字但放开宽度（固定宽度会把文字挤成竖排） |
| 其他 | 去掉 tap 高亮、禁止长按选中、抹掉触摸后的 sticky hover、弹层宽度按视口收敛 |

### 界面
- 侧栏：Logo、搜索、新对话、置顶/今天/7 天/30 天/月份分组、悬停置顶·重命名·删除、余额、导出、设置
- 消息区：用户淡蓝气泡（`--ds-deepseek-50`）、助手纯文本、思考折叠块、搜索来源卡、代码块（语言标签 + 复制 + 高亮）、表格、KaTeX 公式、Mermaid 图、引用角标、用量行
- 输入区：圆角 24px、三层阴影、自动增高、`Enter` 发送 / `Shift+Enter` 换行、粘贴与拖拽上传、深度思考 / 智能搜索开关、思考强度、语音、发送/停止
- 主题：浅色 / 深色 / 跟随系统（令牌取自官方 `main.css` 的 `body` 与 `body[data-ds-dark-theme]`）
- 响应式：≤900px 侧栏变抽屉，默认收起

---

## 3. 目录结构

```
deepseek-chatbox/
├─ server.mjs              静态服务 + 服务端存储 API + /api/ds/* 代理 + /api/mock/* 演示
├─ server/store-core.cjs   存储核心（原子写、备份、附件、Key 掩码），源码版与便携版共用
├─ server/tools-core.cjs   内置工具实现（余额/模型/时间/历史/用量 + 联网搜索/网页抓取）
├─ server/lan-core.cjs     局域网口令（Cookie 会话、登录页、未授权拦截）
├─ data/                   运行时生成：设置 / 对话 / 附件 / 备份
├─ package.json
├─ 启动.bat                纯 ASCII + CRLF（chcp 65001 让程序中文日志正常显示），双击即用（源码版）
├─ DeepSeekChatBox-portable.zip   便携版压缩包（36.7 MB）
├─ portable/
│  ├─ sea-main.cjs         便携版入口（SEA / 源码双模式，资源从内嵌 blob 读）
│  ├─ build.mjs            构建脚本：收集 public → blob → 注入 node.exe
│  └─ dist/
│     ├─ DeepSeekChatBox.exe      单文件便携版（98.9 MB）
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
│  ├─ js/scope.js          分组 / 会话的独立设置弹窗
│  ├─ js/dialog.js         应用内 prompt / confirm（不用浏览器原生弹窗）
│  ├─ js/branches.js       消息分支树（parentId / selectedChildId，移植官方实现）
│  ├─ js/i18n.js           中/英文案
│  ├─ js/brand.js          鲸鱼图形
│  ├─ assets/              logo-wordmark.svg / logo-whale.svg
│  └─ vendor/              marked · highlight.js · katex(+fonts) · mermaid
```

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

- **API Key 安全**：明文写在 `data/settings.json`（你自己的机器/ U 盘上），代理不打印、不外传；`GET /api/store` 只返回掩码 `sk-xx…abcd`。公用电脑用完请点设置里的「清除」。
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
