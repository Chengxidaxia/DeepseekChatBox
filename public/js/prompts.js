/* 欢迎页预设提示词池：中英各 128 句，每次随机展示 4 句（v1.14.1） */

export const ZH_SAMPLES = [
  // 写作润色
  '把这段话改写成更正式的邮件', '帮我润色这段文字，让它更简洁有力', '将这段口语化表达改写成书面语',
  '帮我把这篇文章扩写到 800 字', '用更生动的语言重写这段描述', '帮我把这段冗长的文字压缩成三句话',
  '给这篇文章起 10 个吸引人的标题', '检查这段文字的语病并给出修改建议',
  // 编程开发
  '帮我写一个批量重命名的脚本', '用 Python 实现一个 LRU 缓存', '解释这段正则表达式每一部分的作用',
  '帮我把这段代码重构成函数式写法', '写一个带错误重试的 HTTP 请求封装', '用 SQL 查询出每个部门薪资最高的员工',
  '帮我排查这段 JavaScript 的内存泄漏', '把这段同步代码改成 async/await 版本',
  // 学习解释
  '解释一下 Transformer 的注意力机制', '用初中生能听懂的话解释量子纠缠', '给我讲讲贝叶斯定理的直观例子',
  '解释一下什么是区块链的共识机制', '用类比的方式讲清楚递归', '帮我梳理操作系统的进程与线程区别',
  '解释一下梯度下降为什么能优化模型', '给我讲讲 HTTP 和 HTTPS 的区别',
  // 数据分析
  '分析这组销售数据的趋势并给出建议', '帮我写一个统计词频的 Python 脚本', '用表格对比这三个方案的优劣',
  '根据这些数据预测下个月的销量', '帮我找出这份数据里的异常值', '把这段 CSV 数据整理成结构化表格',
  '计算一下这组数据的均值和标准差', '用数据说明这个结论是否可靠',
  // 翻译语言
  '把这段话翻译成地道的英文', '帮我把这段英文翻译成通顺的中文', '将这段技术文档翻译成日语',
  '把这段中文诗歌翻译成英文并保留意境', '帮我检查这段英文邮件有没有语法错误', '把这段文言文翻译成现代汉语',
  '用简洁的英文概括这段文字', '帮我把这段产品说明本地化成法语',
  // 头脑风暴
  '给我的咖啡店想 10 个营销创意', '帮我想 20 个适合做短视频的选题', '为这个产品起名，要求简短好记',
  '列出这个项目的潜在风险', '给我一些提升团队效率的创意', '帮我想几个吸引人的活动口号',
  '为这篇公众号文章想 5 个开头', '列出这个功能的 10 个用户场景',
  // 邮件沟通
  '总结这个链接的要点：https://api-docs.deepseek.com/zh-cn/', '帮我写一封请假邮件',
  '把这段话改写成更委婉的拒绝邮件', '帮我写一封感谢客户合作的邮件', '写一封跟进项目进度的礼貌邮件',
  '帮我把这封邮件压缩到 100 字以内', '写一封申请加薪的邮件，语气专业', '帮我回复这封客户投诉邮件',
  // 总结提炼
  '把这篇文章总结成 5 个要点', '用三句话概括这段长文', '帮我提炼这段会议记录的关键决定',
  '把这份报告压缩成一页摘要', '总结这段对话的核心结论', '帮我把这份文档做成思维导图大纲',
  '提取这篇文章里的所有数据', '用表格总结这几个方案的差异',
  // 方案规划
  '帮我制定一个学习 Python 的三个月计划', '为这个产品写一份上线方案', '帮我规划一次三天两夜的旅行',
  '制定一个每周健身计划', '帮我写一个项目的风险应对方案', '给这个创业想法做一份商业计划',
  '规划一下这次团队建设的流程', '帮我做一个季度目标拆解',
  // 创意故事
  '写一个关于时间旅行的短篇开头', '帮我构思一个科幻小说的世界观', '续写这个故事的下一段',
  '写一个有反转的微小说', '帮我想一个童话故事的结局', '用古风写一段描写雪景的文字',
  '写一个适合孩子的睡前故事', '帮我设计一个人物的性格与背景',
  // 代码审查
  '帮我审查这段代码的安全问题', '指出这段 SQL 的性能隐患', '检查这段代码有没有空指针风险',
  '帮我评估这个接口的并发问题', '找出这段循环里的性能瓶颈', '检查这段配置有没有泄露密钥',
  '帮我写一个单元测试覆盖这个函数', '评估这段代码的可维护性',
  // 数学计算
  '帮我解这个一元二次方程', '计算一下这个复利投资的收益', '用多种方法证明这个几何题',
  '帮我算一下这组数据的方差', '解释一下概率论中的大数定律', '帮我推导这个公式',
  '计算这个排列组合的结果', '算出这个定积分的近似值',
  // 生活实用
  '帮我列一份一周食材采购清单', '给我一个 30 分钟晚餐食谱', '帮我写一封租房合同补充协议',
  '制定一个家庭月度预算表', '帮我规划一次搬家流程', '给我一些缓解失眠的建议',
  '写一份健身饮食计划', '帮我整理这份待办清单的优先级',
  // 文档处理
  '帮我把这段内容整理成 Markdown 表格', '将这份笔记改造成结构化文档', '帮我生成一个 README 模板',
  '把这段会议记录整理成行动项', '帮我把这份提纲扩展成完整文章', '将这段 JSON 格式化并注释',
  '帮我写一个 API 接口文档', '把这份内容转成适合 PPT 的大纲',
  // 决策辅助
  '帮我分析这两个 offer 的利弊', '用决策矩阵比较这三个方案', '帮我判断这个技术选型是否合适',
  '列出选择这个方案的理由与风险', '帮我做一次 SWOT 分析', '从成本角度比较这两个方案',
  '帮我评估这个创业想法的可行性', '列出这个决定的长期影响',
  // 提问技巧
  '帮我把这个问题描述得更清楚', '给我 10 个可以深入追问的问题', '把这个模糊需求拆解成具体任务',
  '帮我写一个清晰的 bug 报告', '将这个问题改写成可搜索的关键词', '帮我想几个从不同角度切入的提问',
  '把这段需求整理成用户故事', '帮我列出这个任务的验收标准',
];

export const EN_SAMPLES = [
  // Writing polish
  'Rewrite this paragraph as a formal email', 'Polish this text to be shorter and sharper',
  'Turn this casual wording into professional prose', 'Expand this article to about 800 words',
  'Rewrite this description with more vivid language', 'Compress this long paragraph into three sentences',
  'Suggest 10 catchy titles for this article', 'Proofread this text and list the grammar fixes',
  // Programming
  'Write a batch rename script in Python', 'Implement an LRU cache from scratch',
  'Explain each part of this regex', 'Refactor this code into a functional style',
  'Write an HTTP client with retry and backoff', 'Query the highest-paid employee per department in SQL',
  'Help me find the memory leak in this JavaScript', 'Convert this synchronous code to async/await',
  // Learning
  'Explain attention in Transformers', 'Explain quantum entanglement to a middle schooler',
  "Give me an intuitive example of Bayes' theorem", 'Explain how blockchain consensus works',
  'Explain recursion using an everyday analogy', 'Compare processes and threads in plain language',
  'Why does gradient descent minimize loss?', 'Explain the difference between HTTP and HTTPS',
  // Data analysis
  'Analyze this sales data and suggest next steps', 'Write a Python script to count word frequencies',
  'Compare these three options in a table', "Forecast next month's sales from this data",
  'Find the outliers in this dataset', 'Turn this CSV into a structured table',
  'Compute the mean and standard deviation', 'Is this conclusion supported by the data?',
  // Translation
  'Translate this into natural English', 'Translate this English text into fluent Chinese',
  'Translate this technical doc into Japanese', 'Translate this poem keeping its imagery',
  'Check this English email for grammar errors', 'Translate this classical Chinese into modern Chinese',
  'Summarize this text in concise English', 'Localize this product description into French',
  // Brainstorming
  'Give me 10 marketing ideas for a coffee shop', 'Suggest 20 short video topics',
  'Name this product with something short and memorable', 'List the potential risks of this project',
  'Suggest creative ways to boost team productivity', 'Write 5 catchy slogans for the campaign',
  'Draft 5 openings for this article', 'List 10 user scenarios for this feature',
  // Email
  'Summarize https://api-docs.deepseek.com/ in a few points', 'Write a leave request email',
  'Rewrite this as a polite refusal', 'Write a thank-you email to a client',
  'Draft a polite project follow-up email', 'Cut this email down to 100 words',
  'Write a professional salary increase request', 'Reply to this customer complaint professionally',
  // Summarize
  'Summarize this article into 5 key points', 'Recap this long text in three sentences',
  'Extract the key decisions from these meeting notes', 'Condense this report into a one-page brief',
  'Summarize the core conclusion of this conversation', 'Turn this document into a mind map outline',
  'Extract every number from this article', 'Compare these options in a summary table',
  // Planning
  'Make a three-month plan to learn Python', 'Write a launch plan for this product',
  'Plan a three-day trip for me', 'Create a weekly workout schedule',
  'Write a risk mitigation plan for this project', 'Draft a business plan for this startup idea',
  'Plan the agenda for our team building day', 'Break this quarterly goal into weekly tasks',
  // Creative
  'Write the opening of a time-travel short story', 'Build a worldbuilding outline for a sci-fi novel',
  'Continue this story from where it stops', 'Write a flash fiction with a twist ending',
  'Suggest an ending for this fairy tale', 'Describe a snowy scene in classical style',
  'Write a bedtime story for a child', "Design a character's personality and backstory",
  // Code review
  'Review this code for security issues', 'Point out the performance risks in this SQL',
  'Check this code for null pointer risks', 'Assess the concurrency issues in this API',
  'Find the bottleneck in this loop', 'Check this config for leaked secrets',
  'Write unit tests for this function', 'Evaluate the maintainability of this code',
  // Math
  'Solve this quadratic equation step by step', 'Calculate the return on this compound investment',
  'Prove this geometry problem in two ways', 'Compute the variance of this dataset',
  'Explain the law of large numbers intuitively', 'Derive this formula for me',
  'Compute this permutation result', 'Approximate this integral numerically',
  // Daily life
  'Make a weekly grocery list for me', 'Suggest a 30-minute dinner recipe',
  'Draft a rental agreement addendum', 'Build a monthly household budget',
  'Plan the steps for moving house', 'Suggest ways to improve my sleep',
  'Write a workout and diet plan', 'Prioritize this to-do list for me',
  // Documents
  'Format this content as a Markdown table', 'Restructure these notes into a clean document',
  'Generate a README template', 'Turn these meeting notes into action items',
  'Expand this outline into a full article', 'Format and annotate this JSON',
  'Write an API reference doc', 'Turn this content into a slide outline',
  // Decisions
  'Weigh the pros and cons of these two offers', 'Compare these options with a decision matrix',
  'Is this tech stack a good fit?', 'List the reasons and risks of this choice',
  'Run a SWOT analysis for me', 'Compare these options by cost',
  'Evaluate the feasibility of this startup idea', 'List the long-term impact of this decision',
  // Asking better
  'Help me phrase this question more clearly', 'Give me 10 follow-up questions',
  'Break this vague request into concrete tasks', 'Write a clear bug report',
  'Turn this into searchable keywords', 'Suggest questions from different angles',
  'Turn this requirement into user stories', 'List the acceptance criteria for this task',
];

/** 随机抽取 n 条预设；语言按 zh / en 区分 */
export function welcomeSamples(lang, count = 4) {
  const pool = lang === 'en' ? EN_SAMPLES : ZH_SAMPLES;
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}
