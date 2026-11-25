/* 工具搜索引擎 —— 根据用户问题检索相关工具，按需下发，省 token。
 *
 * 设计：
 * 1) 每个工具在服务端定义里带 meta.keys（检索关键词）；这里也有一份同款兜底表
 * 2) BM25 打分：词频 × 逆文档频率，长文档归一化；命中工具名权重加倍
 * 3) 中文按「连续汉字串 + 2-gram」切，英文按单词，避免依赖分词器
 * 4) (result) 始终带上「已在对话里调用过的工具」，保证多轮循环不断链
 *
 * 零依赖、浏览器端同步执行，几十个工具耗时 < 1ms。
 */

// 工具名 → 检索关键词。与服务端 tools-core.cjs 的 meta.keys 保持一致。
// 这里放一份兜底，即使服务端没给 meta 也能检索。
// 工具名 → 强检索关键词（工具独有，命中即高相关）。通用词交给 description 的弱匹配。
// 服务端 tools-core.cjs 里的 meta.keys 与这里保持一致即可；这里放兜底表。
const TOOL_KEYS = {
  get_balance: ['余额', '充值', '欠费', '账户余额', '还有多少钱', '账户剩余', 'balance'],
  list_models: ['模型列表', '有哪些模型', '可用模型', '模型版本', 'list models', '支持图片'],
  current_time: ['几点', '现在时间', '今天几号', '星期几', '当前日期', '时区', '现在几点'],
  search_history: ['历史对话', '之前聊过', '以前问过', '找对话', '搜索记录', '翻记录'],
  usage_stats: ['用量统计', '消耗token', '总共用了', '累计token', '花费统计'],
  web_search: ['搜索', '联网', '新闻', '最新消息', '查一下', '搜一下', '网上搜', '官网', '实时', '天气', 'search'],
  fetch_url: ['打开网址', '抓取网页', '读网页', '这个链接', '这个页面', 'fetch url', '读取网页'],
  calculator: ['计算', '算一下', '帮我算', '等于多少', '表达式', '加减乘除', '算账', 'calculate', '公式', '运算', '乘法', '除法'],
  hash_text: ['哈希', 'md5', 'sha1', 'sha256', 'sha512', '摘要', '校验值', '指纹', 'hash'],
  base64_codec: ['base64', '编码', '解码', 'encode', 'decode'],
  url_codec: ['url编码', 'url解码', 'encodeuri', '百分号编码', '转义url'],
  json_format: ['json格式', '格式化json', '美化json', '解析json', 'json校验'],
  text_stats: ['字数', '多少字', '字符数', '行数', '段落数', '统计文本', '统计字数'],
  uuid_gen: ['uuid', '唯一id', 'guid', '随机id', '生成标识'],
  random_pick: ['随机', '抽签', '抽取', '抽奖', '掷骰子', '随机选', 'random'],
  dns_lookup: ['dns', '解析域名', '域名解析', '域名对应ip', '查ip', 'nslookup'],
  port_check: ['端口', '端口通不通', '能否连接', '端口开放', '服务在线', 'telnet'],
  http_request: ['调接口', '发请求', 'http请求', 'get请求', 'post请求', '接口返回', '状态码'],
  local_ip: ['本机ip', '我的ip', '网卡地址', '局域网ip', 'ip地址'],
  base_convert: ['进制转换', '二进制', '十六进制', '八进制', '十进制转', 'hex', 'bin'],
  percentage: ['百分比', '打几折', '折扣', '增长率', '占比', '涨价', '降价', 'percent'],
  date_diff: ['相差多少天', '倒计时', '日期差', '过去多久', '间隔几天', '还有几天'],
  unit_convert: ['单位换算', '公里换', '英里', '公斤', '磅', '摄氏度', '华氏度', '温度换算', 'gb转mb'],
  regex_test: ['正则', 'regex', '正则表达式', '匹配提取', 'pattern'],
  diff_text: ['对比差异', '文本对比', '比较区别', '改了什么', 'diff', '逐行比较'],
  csv_json: ['csv', '表格转', '转csv', 'csv转json', '表格数据'],
  slugify: ['slug', '生成别名', '文件名', '友好url', '标题转链接'],
  password_gen: ['生成密码', '随机密码', '强密码', '密码生成器', 'password'],
  id_validator: ['验证身份证', '校验身份证', '手机号合法', '邮箱合法', '验证邮箱', 'validate'],
  timestamp_convert: ['时间戳', 'timestamp', 'unix时间', '毫秒转', '秒转日期', 'epoch'],
  json_minify: ['压缩json', 'json压缩', 'json一行', 'minify'],
  token_count: ['多少token', 'token数', '分词', 'tokenizer', '上下文长度', '计费token', 'token消耗'],
  qr_text: ['二维码', 'qrcode', 'qr code', '扫码', '生成二维码', '二维码图片'],
  stat_calc: ['统计', '平均值', '平均数', '均值', '中位数', '众数', '标准差', '方差', '分位数', '异常值', '离群值', 'statistics', 'average', 'median'],
  hex_view: ['十六进制', 'hexdump', 'hex view', '字节查看', '看字节', '十六进制查看', 'hex串', '转hex', 'xxd', '二进制查看'],
  color_convert: ['颜色转换', '色值', '颜色代码', 'rgb转', 'hsl', 'hex颜色', '对比度', 'wcag', '配色', 'color'],
  text_kit: ['去重', '排序文本', '清洗文本', '清理空行', '去空行', '加前缀', '拆列', '命名风格', '驼峰', 'snake', 'kebab', 'case转换', '整理名单'],
  aes_crypto: ['aes', '加解密', '对称加密', 'encrypt', 'decrypt', 'cbc', 'gcm', '加密参数', '解密密文', 'auth tag'],
  eval: ['浏览器', '执行js', '执行代码', '跑js', 'js脚本', 'console', '网页里执行', 'eval', 'javascript'],
  cmd_run: ['执行命令', 'cmd', '运行命令', '本机命令', '跑命令', 'powershell', 'shell'],
};

/** 中文按 2-gram + 单字，英文/数字按单词。生成检索词数组 */
function terms(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  // 英文 / 数字 / base64 / json 这类
  for (const m of s.matchAll(/[a-z][a-z0-9_+-]*/g)) if (m[0].length > 1) out.push(m[0]);
  for (const m of s.matchAll(/\d+/g)) out.push(m[0]);
  // 中文：连续汉字串整体 + 2-gram
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length >= 2) out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

let indexCache = null;
function buildIndex(defs) {
  if (indexCache && indexCache.defs === defs) return indexCache;
  const docs = (defs || []).map((d) => {
    const name = d?.function?.name || '';
    const meta = d?.meta || {};
    const keys = meta.keys || TOOL_KEYS[name] || [];
    const desc = d?.function?.description || '';
    // 关键词权重高：重复 3 次；描述里的英文词也算进来
    const corpus = [...keys, ...keys, ...keys, name, desc].join(' ');
    const tf = {};
    for (const t of terms(corpus)) tf[t] = (tf[t] || 0) + 1;
    const params = d?.function?.parameters?.properties || {};
    for (const v of Object.values(params)) {
      for (const t of terms(String(v?.description || ''))) tf[t] = (tf[t] || 0) + 0.5;
    }
    return { name, def: d, tf, len: Object.values(tf).reduce((a, b) => a + b, 0) || 1 };
  });
  const df = {};
  for (const doc of docs) for (const t of Object.keys(doc.tf)) df[t] = (df[t] || 0) + 1;
  const N = docs.length || 1;
  const idf = {};
  for (const [t, n] of Object.entries(df)) idf[t] = Math.log(1 + (N - n + 0.5) / (n + 0.5));
  indexCache = { defs, docs, idf, N };
  return indexCache;
}

const K1 = 1.5, B = 0.75;

/** 检索：返回按相关度排序的 [{name,def,score}] */
export function searchTools(defs, query, { topK = 8, minScore = 3 } = {}) {
  const idx = buildIndex(defs);
  const qTerms = terms(query);
  const lower = String(query || '').toLowerCase();
  if (!qTerms.length) return [];
  const avgdl = idx.docs.reduce((a, d) => a + d.len, 0) / idx.N;
  const scored = [];
  for (const doc of idx.docs) {
    // 强关键词：整词命中给大分；关键词的 2-gram 命中给中分（容忍口语变体）
    const strong = TOOL_KEYS[doc.name] || (doc.def?.meta?.keys || []);
    let strongHit = 0;
    const qChars = lower.replace(/[^\p{L}\p{N}]+/gu, '');
    for (const k of strong) {
      const kw = String(k).toLowerCase();
      if (!kw) continue;
      if (lower.includes(kw)) { strongHit += kw.length >= 4 ? 12 : 8; continue; }
      // 关键词本身是中文且较长时，用 2-gram 部分匹配（至少 2 字，避免单字噪声）
      if (/[\u4e00-\u9fff]/.test(kw) && kw.length >= 3) {
        const grams = terms(kw).filter((t) => t.length >= 2);
        const hit = grams.filter((g) => qChars.includes(g) || lower.includes(g)).length;
        if (hit >= Math.max(2, grams.length - 1)) strongHit += 5;
      }
    }
    // 弱匹配：BM25 兜底（捕捉描述里的同义表达）
    let weak = 0;
    for (const t of qTerms) {
      const tf = doc.tf[t];
      if (!tf) continue;
      const idf = idx.idf[t] ?? Math.log(1 + (idx.N - 0.5) / 1.5);
      weak += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.len / avgdl));
    }
    let score = strongHit + weak * 0.35;
    // 工具名被完整提及时强命中
    if (lower.includes(doc.name.toLowerCase())) score += 10;
    if (score > 0) scored.push({ name: doc.name, def: doc.def, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score >= minScore).slice(0, topK);
}

/**
 * 组装本轮要下发的工具：检索命中 + 显式必带 + 已在对话里用过的（多轮不断链）。
 *
 * 缓存友好（DeepSeek 前缀缓存按 token 序列匹配，tools 排在最前，一改就整段 miss）：
 * - sticky 是「上一轮下发过的工具名（有序）」。本轮先原样保留这段，新工具追加到末尾，
 *   集合只增不减，因此 tools 序列的前缀能连续命中缓存。
 * - sticky 超出上限时从最久未用的开始淘汰（一次淘汰只造成一次 miss，可接受）。
 */
export function pickTools(defs, query, {
  topK = 8,
  always = [],          // 必带工具名（如开关控制的联网工具）
  usedNames = [],       // 本对话已调用过的工具名
  sticky = [],          // 上一轮已下发的工具名（保持顺序，前缀稳定）
  maxTools = 24,        // sticky 上限，避免越滚越多把 token 吃光
  enabled = true,       // localTools 总开关
  cmdEnabled = false,
  evalEnabled = false,
  subAgentEnabled = true,
} = {}) {
  if (!enabled && !always.length) return { defs: [], names: [], hits: [] };
  const hits = enabled ? searchTools(defs, query, { topK }) : [];
  const byName = new Map((defs || []).map((d) => [d?.function?.name, d]));
  const allowed = (n) => {
    const d = byName.get(n);
    if (!d) return false;
    if (d?.meta?.cmd && !cmdEnabled) return false;
    if (d?.meta?.browser && !evalEnabled) return false;
    if (d?.meta?.subagent && !subAgentEnabled) return false;
    if (d?.meta?.web && !always.includes(n)) return false;   // 联网工具只由 always 带入
    return true;
  };

  const names = new Set();
  // 1) always 先入，顺序固定
  for (const n of always) if (allowed(n)) names.add(n);
  // 2) sticky：沿用上一轮顺序，保住缓存前缀
  for (const n of sticky) if (allowed(n)) names.add(n);
  // 3) 本对话用过的工具必须保留，否则 messages 里的 tool_calls 与 tools 不匹配
  for (const n of usedNames) if (allowed(n)) names.add(n);
  // 4) 新命中的追加末尾
  for (const h of hits) if (allowed(h.name)) names.add(h.name);

  // 输出顺序 = always → sticky → 其余按定义原序；新工具天然排在后半段
  const order = [];
  const seen = new Set();
  const push = (n) => { if (names.has(n) && !seen.has(n)) { seen.add(n); order.push(n); } };
  for (const n of always) push(n);
  for (const n of sticky) push(n);
  for (const n of usedNames) push(n);
  for (const d of defs || []) push(d?.function?.name);

  // 超上限时从尾部（最久未用、非 always）淘汰
  while (order.length > maxTools) {
    let cut = -1;
    for (let i = order.length - 1; i >= 0; i--) {
      if (!always.includes(order[i])) { cut = i; break; }
    }
    if (cut < 0) break;
    order.splice(cut, 1);
  }

  const out = [];
  for (const n of order) {
    const d = byName.get(n);
    if (!d) continue;
    const clean = { ...d };
    delete clean.meta;
    out.push(clean);
  }
  return { defs: out, names: order, hits: hits.map((h) => ({ name: h.name, score: Number(h.score.toFixed(2)) })) };
}

export { TOOL_KEYS, terms };
