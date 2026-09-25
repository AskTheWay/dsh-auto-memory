# 记忆系统全景调研(2026-09-25)

> 四路并行调研(dsh 生态竞品 / 开源标杆 / 闭源产品 / 评测基准),决定 dsh-auto-memory 下一步迭代方向。
> 方法:GitHub 仓库原文 + 论文(arXiv)+ 官方文档/定价页;区分【已实现/宣称/论文指标/审计】。

---

# dsh 生态记忆插件全景

## 调研发现

# DeepSeek Harness (dsh) 记忆类插件生态调研报告

**调研时间:2026-09-25。方法:逐个 `gh api` 读 GitHub 仓库 README(11 个必查全部读到原文)+ awesome-dsh-plugin 全量 Memory 分类 + `topic:dsh-plugin` 搜索 + 官方仓库 Discussions GraphQL 检索 + npm downloads API。凡未读源码仅凭 README 的描述,下文标注"(README 宣称)";读到的实测数字标注数据来源与作者自述的局限。**

## 0. 官方立场(先说结论)

- `deepseek-ai/deepseek-harness`(235k stars,"Everything is a Plugin")**内核不自带任何记忆子系统**。官方文档 `docs/user/guide/mcp-memory.zh.md` 只提供**三份默认关闭的 MCP 参考配置**(Memorix / MCP Reference Memory / Engram,均需自行装服务器),并明文免责:DSH 不负责下载服务器、初始化数据库、embedding,且收录不代表认可;官方文档自己承认 MCP Reference Memory "搜索只是实体名/类型/观察的子串匹配,不提供 embedding、自动摘要、冲突消解或遗忘策略"。
- 两条要求"转原生"的 Feature 讨论:**#5333**(3 赞)要求原生自动加载 `~/.dsh/memory/` + MEMORY.md 索引,作者已核实 `dsh-agent-instructions` 的 seam 可复用(每会话 `paths` 已支持),这正是 dsh-auto-memory 以插件形态占据的位置;**#1638** 提议官方 `ctx.memory` 能力缝(Service Definition + Provider 拆分,TencentDB Agent Memory 做首个 provider)。**目前均未进入内核**。
- 生态规模:awesome-dsh-plugin 的 Memory 分类约 **195 个条目**(README 行 1741–1945),还不含 AGI 架构分类里的 dsh-engram/灵枢等。leetom314 在 9 月 8 日 README 里写"约 65 个记忆插件"——**这个数字半个月内已翻三倍**,该分类是目前 dsh 生态最拥挤的赛道。

## 1. 必查插件逐个分析

### 1.1 00080000/dsh-project-memory(15★,npm `@yolk_vat-y/dsh-project-memory` 3,595 dl/月,2026-08-19 建,9-25 仍在提交)
**定位:项目级"读时记忆"+任务桥,纯 JS 单依赖,无向量库。**
- **存储**:每项目 `.dsh-project-memory/`,分片 JSON(shards/ 每源文件一个自描述 JSON)+ experience.json + insights.json + tasks.json;v2 布局自动迁移。索引体积有实测:Java/Vue 项目约源码 0.5%(8.8MB→49KB),符号密集 TS monorepo 代码层 ~19%、文档层 ~106%(README 明说"0.5% 是稀疏端,不是保证")——**罕见的诚实披露**。
- **注入**:**"admission(准入)而非 retrieval(检索)"**是其核心论点:自动注入被重构为"本步是否要跨我曾被烧伤的边界",默认沉默。只有低维类型化 `when` 触发(ops/写入文件/意图词),`guard` 只能收窄;统计通道需相对分+IDF 加权覆盖率绝对下限(0.45)+≥2 个共享词;每会话硬顶(12 条/4000 字符)+ 冷却步数;注入以 user 消息追加在历史尾部**不破坏 prefix cache**;每次真实注入写 `injection-audit.jsonl`,**每步**(含未注入的步)写 `admission-shadow.jsonl`(全部候选+特征+拒绝原因),使阈值调优可离线回放。自带 8 场景合成评测基线(自报 precision/recall 1.00,README 明确标注"合成池、非你数据的证据")。
- **检索**:BM25(docs/symbols/experience/insights/task 五层)+ 可选 LLM 查询扩展(默认关);CJK 调优(短语加权、同义词表、CJK 感知边界);doc↔symbol 交叉链接**读取时计算不落盘**(不会过期);召回带 `path:line` 引用。
- **写入**:读时记忆化(`fs/observed` 模型读到即索引,默认开)、后台 watch(mtime+内容哈希,退避轮询)、经验笔记按重叠度去重(≥0.7 合并,0.65–0.7 强化)、insight 分 task/project/global 三层作用域自动晋升(2 个任务命中→project,3 个→global)、按活跃度而非纯年龄衰减(decayDays 90)。
- **UI**:dsh web 任务面板(拖拽卡片、行内编辑、四主题、双向 todo 同步)。
- **评价**:与 dsh-auto-memory 重叠最小(它是项目知识库不是个人记忆),但它的**注入准入+审计影子日志**方法论是全生态最精细的,值得借鉴。

### 1.2 0x7A7A6572/dsh-forge-studio 的 plugin-memory 子包(仓库 3★,npm `@zzerx/dsh-plugin-memory` v0.3.3,9-10 建)
**定位:偏好/身份/项目决策的个人记忆 + 实体图谱,设置面板一级入口。**
- **存储**:仓库 CLAUDE.md 硬性规定"持久化只走 `ctx.storage`"——记忆条目、原文留档、后台调用记录、实体与边全在官方存储域,无自建文件/DB。
- **注入**:新会话注入"全局+当前工作区"高重要性记忆(README 宣称)。
- **检索**:**明确不做向量**——子串匹配(标题/正文/摘要/别名/标签);语义去重靠相似度阈值+一次模型"新增/并入/跳过"判定,判定失败退化新建(fail-safe)。
- **写入**:每轮对话结束 LLM 提炼(后台模型可选:便宜模型提炼+强模型判定);**原文先落盘再抽条目**(模型失败不丢原文,可重抽)——很好的防丢设计;别名机制(alias 写入自动并入原条目);同作用域+同分类+同标题自动合并;内置"导入其他 AI 的记忆"提示词流程。
- **遗忘**:归档=软隐藏可恢复,删除才真删。
- **UI/工程**:设置面板"记忆"分区、canvas 记忆图谱(拖动缩放、悬停详情)、后台调用审计(用途/模型/耗时/条数/失败原因);**与其他记忆插件撞名时硬锁**(不注册工具不注入,面板提示)——生态内第一个显式处理插件互斥的。
- **多语言 React 客户端契约测试**(样式编译契约+外来类名门禁),工程规范高。

### 1.3 863683348/dsh-memory-setup(1★,npm 210 dl/月,9-11 最后提交)
**定位:"可审计个人记忆层",JSON+changelog,工具极多(约 30 个)。**
- **存储**:`<workspace>/.dsh-memory-setup/memory.json` 明文 JSON;**每次变更追加 changelog(when/what/why)**;每次保存写 .bak;快照(留 10)+ 恢复;v1.1 乐观锁(基于 revision 的 CAS,多会话/多 agent 安全);v1.0 sha256 完整性审计(memory_audit)。
- **注入**:动态 `systemPrompt.context()` 活节区,保存后 30 秒节流刷新;maxMemoryChars 6000;v0.9 memory_focus 按主题相关性注入;v1.0 hot/warm/cold 分层(hot 注入,cold 归档)。
- **检索**:KB 用 BM25(标题×3/标签×2/正文×1,IDF),v0.5 起可选 OpenAI 兼容 embedding 端点(默认关)。
- **写入**:一次性 onboarding 工具;从 README/package.json 自动提取项目约定(预览后应用);**教训必须带 evidence 字段("no evidence, no lesson")**;**教训命中计数≥阈值自动晋升为常设约定**(v0.7,自动跑,"memory literally learns from repeated mistakes");CLAUDE.md 导入;导入/合并(冲突取新/取双)。
- **遗忘**:lessonTtlDays 90 到期;changelog 上限 100。
- **亮点与教训**:审计链、证据门、教训→约定晋升是三个好想法;但 30 个工具对一个模型来说认知负担过大,无 UI(路线图里)。它是"用工具数量堆功能"路线的代表。

### 1.4 988hj7tczd-oss/harness-desktop 的 plugins/harness-memory(仓库 2★,8-31 最后提交)
**定位:官方 API 的最小参考实现。**
- 读其 `index.js` 源码(~150 行):`defineDomain/domainTable` 建 `memories` 表(id/text/tags/createdAt/updatedAt)→ `ctx.storageDomain.open` 持久化;system-prompt section(order 150)按**标签归类渲染**(偏好/项目约定/成功做法三组,updatedAt 倒序,maxMemories 50);`memory.save/forget` 两工具。无检索、无遗忘策略、无 UI 面板(桌面端另有 MemorySection.tsx)。
- 价值:证明**官方 ctx.storage 路线可行且极简**;作为对照基准,展示了"够用就好"的下限。

### 1.5 kenz1117/dsh-engram(7★,npm `@kenz1117/dsh-engram` 4,400 dl/月,9-22 提交)
**定位:生态内工程深度最高的重型个人记忆——"记忆宫殿"信息架构 + SQLite/FTS5/本地向量混合检索 + SM-2 间隔重复。**
- **存储**:SQLite 双库:`user.db` 全局 + `project-<hash>.db`(git origin 归一化哈希;无 git 用 cwd 全量 sha256,旧截断命名自动迁移)——"偏好跟人走,约定跟仓库走"。
- **宫殿架构(已实现,README 链到源码路径)**:按 kind 分五房(事实/偏好/决策/往事/技法),每房容量 9 满员开新房,桩位只增不回收;`tour_routes` append-only 固定巡游路线;门牌 0-1 评分(全库唯一 +0.4/日期锚 +0.3/同房前 6 字不重复 +0.3)。
- **检索**:FTS5(unicode61+中文 2-gram 预切词)+ 本地向量(Xenova/bge-small-zh-v1.5,512 维 q8,~50MB 离线,下载失败自动降级纯关键词并显式标记)RRF 融合 + 关系边一跳 + 新鲜度/命中次数乘性 boost;走廊路由(先选房间再房内检索);辅助 LLM 多查询改写(≤3 个,RRF,失败降级单查询);**证据门 `engram_assess`**——代码强制"声称充足+至少一条本批次有效证据+nextStrategy=answer"三齐才判充足,否则打回继续检索。
- **写入**:自动摄取(每轮提上一轮候选,会话结束补末轮,失败留 pending 键下次重放,(会话,轮次) 幂等);写入四态(复述并入强化/疑似矛盾建边待裁决/全新写入/低熵丢弃);DEFER 模糊带可交 **Jev SystemOne 外部裁决**(默认关,不可用静默回落纯规则);实体词典(name/aliases 归一化消解,记忆↔实体多对多);**历史会话回填**(按各会话自己的 cwd 分库,先零成本估算再执行,可暂停续跑)。
- **遗忘**:软删可恢复;衰减(30 天未访问且 importance<0.3 归档);**SM-2 间隔重复复习队列**(只给坐标+门牌线索不给正文,逼主动回忆;grade 推进调度;进入调度的条目豁免自动衰减);`engram_audit_forgotten` 闭馆考古复核遗忘是否得当。
- **注入与安全**:画像注入 CJK 感知 token 预算(中文 1.5 token/字——修复了除以 4 低估四倍的问题)、分级递减条目预算;**提示注入防护**(所有召回出口包 `<engram_memory_context>` 协议标签+使用警告,入库前剥离协议标签防伪造);**脱敏**(API key/AKIA/手机号/身份证正则清洗为 `[REDACTED:*]`);**防回声室**(摄取时把记忆召回工具输出替换为占位符,"既有记忆的复述不是新信息")。
- **UI**:设置页"记忆库"8 视图(今日/陈展/走廊/日志/回填/往事/实体/裁决),今日待回忆红色角标,双语。
- 共 20 个窄参数工具。**弱点**:重(需下载 50MB 嵌入模型)、概念多(宫殿/门牌/巡游/SM-2/Jev),上手成本全生态最高。

### 1.6 adoresever/graph-memory(628★/93 fork,9-09 提交;生态内星数最高的原生记忆插件)
**定位:上下文接管(context takeover)+ 类型化图记忆;跨宿主(OpenClaw Context Engine 适配器)。README 宣称 2026 年 4 月受邀清华大学讨论会(无第三方佐证)。**
- **存储**:SQLite `~/.dsh/graph-memory/graph-memory.db`;1.6 版架构:每完成一轮 turn 生成一段自包含 turn summary,再从同一句话派生 SPO 三元组;**图只做导航,原始问答永远做证据**——回召内容附精确的原始 question 与 final answer。
- **上下文接管**:默认保留最新 5 个完成轮,旧前缀折叠为单个归档标记;已完成轮只留问+答,剥离工具/推理轨迹;不动 DSH 事件日志。
- **检索/召回**:自动召回无需工具调用;向量 Top-K(可选 OpenAI 兼容 embedding 端点,缺省回退 FTS5);局部 LPA 社区收窄 + 查询时 PPR 排序。
- **实测数字(作者自跑、自报,且自述局限)**:真实 20 轮 GLM-5.2 任务,T20 首请求上下文 56,998→11,008 tokens(**−80.69%**),可见消息 171→21(−87.72%);全量 token 仅 −6.43%(计入 20 次轮提取+41 次 embedding);20/20 抽取成功;138/138 自动测试。作者明确标注"这是工程负载,不是 LoCoMo/LongMemEval 分数;基线非同时 A/B"。
- 每轮抽取成本:恰好一次辅助 LLM 调用;坏抽取进隔离区不阻断对话。
- **教训**:它把"记忆"重新定义为"上下文预算问题",benchmark 先行的写法(可复现脚本、每轮数据、局限清单)是全生态范本。

### 1.7 leetom314/dsh-tiered-memory(0★,9-09 提交)
**定位:Hermes Agent 记忆纪律的移植:三层 + 每层字符预算。**
- 三 tier(user/env/project)+ char 预算;`mem_set` 同 key upsert,**层满拒绝写**("tier full — delete or merge first"),不静默驱逐;`mem_query` 关键词自动路由到对应层,无命中返回 `[]` 不编造;`tier_summary` 列驱逐候选(冷/旧),`mem_delete` 显式删——**淘汰权交模型,不自动删**。
- 验证:单测行覆盖 98.5% + 真实 headless e2e(预算拒绝闭环:写被拒→看候选→删冷条目→重写成功)。
- **注意**:README 宣称"dsh 生态约 65 个记忆插件全是单层存储,本插件是分层+预算概念的首个实现"——**该宣称已过时且当时也不准确**(dsh-engram 的分库、meow 的七层都早于或同期);但"满层拒绝而非静默淘汰"的纪律值得注意。

### 1.8 398894496-arch/runtime36 → 已更名 **DSH-KRouter**(39★,9-12 提交)
**定位:Obsidian 第二大脑;"封存当天→蒸馏→晋升→次日命中那页"。检索是"锁"不是产品。**
- **检索即锁**:短名词 → 规范页 + 双 SHA-256 回执(`retrieval_status/canonical_source/source_sha256/canonical_match`);别名表 `canonical_sources.psv`;未命中返回 false+提示,**绝不含糊引用邻居**;无向量库,`python3+rg` 数十毫秒。
- **三层验证严格分离(README 反复强调勿混)**:(1) 实现:clone 模板 25/25 主题、39/39 别名、25/25 复述拒识;(2) 对比实验 N=36:对 lexical TF-IDF/MiniLM/BGE-M3 做同底数余弦阈值扫描,结论"此契约下(金标为空必须拒绝、绝不引邻居)羽量级锁胜过中量级向量栈"——**对比实验可回放**(冻结向量 JSON);(3) 作者自报 72 连续封存日/30 真实任务 25/25——**明示不在仓库、非回执**。
- L3 晋升:五闸通过→当天自动写 provisional;正式 active 仍要下一次同类任务时询问。
- DSH 侧:只读 7 工具(status/preference/correction/memory/project/search/suggest);日写手是默认开启的定时器(可用已登录 CLI 的 bypassPermissions 订阅道)——激进设计。
- 适用边界自己写清:不适合语义/模糊检索、不维护别名表就别装、英文笔记库需自换 CJK 样本。

### 1.9 1014029855/dsh-codevault(2★,9-16 提交)
**定位:源码阅读档案——"读懂的那一刻记一笔",每 仓库/文件/符号 一张卡。**
- **存储**:`library.jsonl` 只追加事件流(唯一记录源)+ 生成的 `notes/<对象>.md` 卡片 + `hub/<repo>.md` 清单 + MOC.md;**版本历史=事件流本身重放**(read_history 回到任意时点,无需额外存储);卡片间 [[wikilink]] 按坐标自动生成,Obsidian 图谱开箱即用。
- **写入纪律**:快记 2-4 句 / 深读 ≥200 字(内置 code-reading 技能框架:对象坐标→机制→提炼/比较→存疑);同对象重读不开新卡,追加时间线+readCount+要点去重合并;`read_expand` 快记原位升级深读,文件名不漂移;**标签闭集纪律**(tags 只接受已有标签,newTags 显式扩词);记不准就不编(repo/ref 拿不准不写)。
- **回访问题**:每条记录可带 2-3 条 revisit 问题攒在卡尾,回看时先自答——**主动回忆设计**。
- vault 联动:对 Obsidian vault 只读检索,人工确认后 read_link 补链;删除需确认+重建。
- 11 工具 + /codevault 命令;smoke.mjs 无 cordis 依赖可测。

### 1.10 FuRongJun-1999/dsh-memory 灵枢 LINGSHU(250★/20 fork,9-25 提交;星数第二高的原生记忆插件)
**定位:"白箱 AGI 架构探索"——元认知/持续学习/世界模型/自我改进叙事;Python 大脑(md_cg 认知图)+ stdio MCP server,DSH 只是桥之一(CodeBuddy/ZCode/Codex/Claude Code 均可挂)。**
- **存储**:纯 Markdown 认知图 + CCG 六要素记忆卡(功能名/生效条件/子功能/执行/验证方式/**不适用条件**);索引只是派生物可随时重建,**原文即真源**。
- **写入**:三道闸门(audit→一致性→gated 三问四态)确定性规则裁决,**零 LLM 黑箱判断**;`committed` 字段语义严格(ok=true 不等于落盘,非 ACCEPT 进 review_queue);**遗忘只能显式 `cg(op=forget)`,不做静默淘汰**;写入凭据 RBAC token(默认只读 guest,读得到写不进)。
- 宣称:九轮自治缺陷挖掘 49 项修复、全量 179 套测试全绿(自报);"双实例互验(判据冻结)"。
- **注意**:安装链长(Node 插件+Python 解释器桥+watchdog),README 大量篇幅在讲排查(ENOENT/超时);六要素卡的"不适用条件"字段是好的结构化想法。

### 1.11 863683348/dsh-plugin-focus(1★,9-11 提交)
**定位:不是通用记忆——对抗 compaction 漂移的"焦点板"。**
- `.dsh/focus.md` 纯文本板:钉住目标/硬约束/决策(kind: objective/constraint/decision/note;status open/done);**每轮开始+内容变化时自动重注入**(agent/pre-step waterfall,镜像官方 dsh-time-context 机制——压缩后被甩掉的板第一步就回来);clear 时归档到 .bak 累积;maxEntries 60/maxChars 8000;路径经 `ctx.fs.contains` 囚禁在工作区内;纯逻辑 lib/board.js 零 Cordis 依赖可单测;处理过一次真实兼容性事故(JSON-Schema required 不被 dsh-tools DSL 支持,导致整个 profile 起不来)并写明修复——**rc 快变期兼容性风险的活案例**。

## 2. 必查之外、按星数/下载量值得点名的高相关插件(README/awesome 描述,未逐个读源码)

- **omdsh-dev/dsh-mnemon**(411★,npm 36,100 dl/月——**原生记忆插件下载量第一**):可组合架构 Source(拥有记忆+投影)×Strategy(选择/常驻/检索策略)×View;三层(Runtime 偏好/USER·MEMORY 投影、Documents 搜索后读、Memory Spaces 按需证据);Mnemon Native 需另装 `mnemon` CLI;空闲评审有界化(spawn 检查点、5 分钟间隔、20 次上限、Agent Teams 冲突暂停)。**代表"框架化/可组合"路线。**
- **csyangwen/dsh-memory-evolve**(332★):五轨记忆+git 分支感知+回合内自我审查+技能自我进化+COI 调度+会话广播;大而全路线,默认多数关闭。
- **slow-stack/mneme 的 dsh-mneme**(仓库 121★,npm `@modusensus/dsh-mneme` 11,206 dl/月):SQLite 主库 + **人类可编辑 Markdown 镜像**(9 个分类 md,人工修改优先合并回库);借鉴 Claude autoDream 的后台巩固(去重/合并/冲突冻结待人工裁决);实体/属性/时间轴三层;agent+workspace 双隔离。**与 dsh-auto-memory 定位最接近的高下载量竞品。**
- **Phant0Meow/dsh-meow-memory**(118★):node:sqlite 七层;**KV/上下文缓存友好**(静态 section 文本恒定);首轮只注入长期记忆、次轮起每消息关键词 top-2;**压缩后自动重注入**(压缩信号释放已见记录,一个回合补回被压缩甩掉的记性);空闲 dream 整理+艾宾浩斯衰减打分。
- **PerryLink/dsh-memento**(118★,npm 4,031 dl/月):实现 #1638 提议的 **`ctx.memory` 类型化能力缝** + SQLite provider + **审批瀑布写门**(写在 service 层非工具层,模型路径无法绕过;writePolicy ask|auto|off 对模型不可见;拒绝也落审计行)+ 硬预算(满则结构化报错,绝不截断/自动压缩)+ 快照冻结;附 dsh-memory-protocol v1 适配器注册表与**可分发的符合性测试套件**;README 维护对 DSH 0.1.2→0.1.7 各版本 API 变更的适配矩阵。
- **tinqiao-oss/engramory**(191★,npm 1,056 dl/月):**记忆协议而非系统**——一份约束性纪律规则+doctor 校验器;一文件=一事实;**MEMORY.md 索引硬顶(200 行/25KB)用 dsh 的 `ctx.tools.guard()` 单调拒绝强制**("一旦 guard 给出拒绝理由,后到的监听器不能再翻回允许"),跨 Claude Code/Codex/Kiro/OpenClaw 共用一份库;README 明确警告同名仓库非本项目——**与我们撞名困境同款处理范例**。
- **seriousz158/dsh-memory**(181★):本地 **git 仓库**做记忆(检查点提交、清空前留恢复点、拒绝 symlink 逃逸/路径竞争);空闲会话同步在隔离 workspace 里跑(模型只能编辑副本,宿主校验后写真库)。
- **ZSeven-W/dsh-noema**(128★):非向量本地记忆 Noema 桥;从 **9 种 agent 工具导入**;15 语言 README。
- **JingxuanC/causal-memory**(81★):决策→结果因果边(关系类型 caused/enabled/prevented),SQLite,17 工具 MCP stdio。
- **Aik358/dsh-auto-memory**(78★,npm `@a9i5k4/dsh-auto-memory` 9,045 dl/月):**与我们同名**。主动联想记忆:固定边界零提示召回、三层自动固化、技能结晶、handoff 台账+PLAN 白板(跨上下文窗存活)、水位感知(自动探测模型窗口)、外部记忆继承、无人值守模式。见 takeaways。
- 跨 harness 重型系统(带 dsh 适配器,非 dsh 原生):MemOS(11.5k★,宣称 35.24% token 节省——**论文指标,非 dsh 实测**)、volcengine/OpenViking(38.6k★)、EverMind EverOS(13.2k★,"Markdown-native 自进化记忆层")、zilliz memsearch(2.7k★,Markdown+Milvus)、agentscope ReMe(3.5k★)、plastic-labs honcho(7.3k★)、rohitg00/agentmemory(28.8k★,"基于真实 benchmark 的 #1"——自我定位宣称)、TencentDB Agent Memory(经 dsh-tdai-memory 接入,四层 L0-L3,提取单次 20-30s 且需 embedding 端点——Discussion #14 实测者证言)。

## 3. 官方 Discussions 里的用户诉求(未被满足的)

- **#14「求一个 memory 能力」(11 赞/38 评论,记忆类讨论中热度第一)**:楼主原话"想要把 codex 和 claude code 的 memory 迁移过来,有什么快速方案吗"。**迁移/导入是第一诉求**。楼内出现的方案:桥接(YYTbit 的 dsh-plugin-claude-bridge 直读 Claude memory/skills/CLAUDE.md 自动注入)、原生插件(dsh-memory、dsh-mnemon、sage-mem——**fork 自 Claude Code 生态最主流的 claude-mem**,数据模型同源所以"不是格式迁移问题")、腾讯 TencentDB(重,要 embedding)、SGME(独立 HTTP 记忆引擎,带 import_history 全量补录)。
- **同帖暴露的质量问题**:第三方目录站 dshbase.com 逐个实测安装,当场抓到插件未声明 `inject: ["systemPrompt"]` 装上即报错、npm 版本没发上去等——**装不上/版本不同步是用户对记忆插件的常见差评来源**。
- 同帖两种极简派声音:"直接让他总结写文档,要用时搜索"(文档+搜索派);"开创造模式说需求就行"(DSH 能自己生成记忆插件——这解释了为什么有 ~200 个)。
- **#5333**:要求内核原生加载 `~/.dsh/memory/`+MEMORY.md("让 markdown 记忆约定不再是 AGENTS.md 驱动的软合同"),并给出可行性论证;插件作者跟帖佐证 seam 可用。**未被官方回应采纳(截至调研日)。**
- **#1638**:`ctx.memory` 官方能力缝提案,评论区在收紧契约(隔离身份、审计);**#7714**:`.agent/` 目录规范 RFC。**协议标准化是社区在推、官方未定的方向。**
- 大量 "DSH | xxx-memory" Show-and-tell 帖(597 条命中)——**供给侧爆炸,需求侧仍集中在"迁移、可靠、别乱注入、别丢"四件事**。

## 4. 生态结构判断

**拥挤区(不要再做)**:①"跨会话记忆+自动提炼+设置面板"通型(数十个);②SQLite+FTS5+可选向量的混合检索(dsh-engram/meow/mneme/memory-connect/living-memory……);③"记忆+上下文压缩"组合;④"Claude Code 风格"标签本身(hr98w/dsh-memory、sage-mem、isheng-eqi/dsh-hermes-memory、GodCC6 只读桥、lovezi0/dsh-memory-palace、jisi71 双账本、Aik358 与我们同名同叙事)。

**稀缺区(有需求、少人做好)**:①**确定性强制**(预算/上限的 guard 拒绝、审批瀑布、审计回放)——engramory/memento/project-memory 三家各自实现,仍是少数;②**注入成本纪律**(prefix-cache 友好、变更才重注入、delta 注入、admission 门);③**压缩存活**(compaction 后重注入/前提漂移检测);④**溯源**(sessionId+eventRange 引用、bi-temporal 有效期、SHA 回执);⑤**导入桥**(Claude/Codex/33 种 agent 会话日志);⑥**互操作协议**(mm://、dsh-memory-protocol、engramory、ctx.memory 缝——四五个尝试混战,无标准);⑦**评测**(只有 graph-memory/KRouter/project-memory/Marquez807(受控实验 0/18 vs 14/18)认真做)。

## 横向对比

# dsh 记忆插件横向对比表

## 必查 11 家

| 插件(star/npm 月下载) | 存储 | 注入方式 | 检索 | 写入策略 | 遗忘 | UI | 状态信号 |
|---|---|---|---|---|---|---|---|
| **dsh-project-memory**(15★ / 3,595) | 分片 JSON,纯 JS 单依赖,无向量库 | 准入制触发注入(when/guard/覆盖率绝对下限/会话预算/冷却),注入全审计+每步影子日志,prefix-cache 友好 | BM25+可选 LLM 查询扩展,CJK 调优,doc↔symbol 读时联链,path:line 引用 | 读时记忆化+后台 watch;重叠去重;insight 三作用域自动晋升;按活跃度衰减 | decayDays 90,archive | web 任务面板(拖拽/编辑/主题/双向 todo 同步) | 已实现;注入评测 1.00 为合成池自报 |
| **forge-studio plugin-memory**(3★ / v0.3.3) | 官方 ctx.storage(条目+原文留档+实体边) | 会话开局注入全局+工作区高重要性 | 子串匹配(明示不做向量)+一次模型去重判定 | 每轮 LLM 提炼(可选后台模型);原文先落盘防丢;别名归并;导入他 AI 画像 | 归档软隐藏/真删 | 设置面板一级"记忆"分区+canvas 图谱+后台调用审计 | 已实现;与撞名记忆插件硬锁互斥 |
| **dsh-memory-setup**(1★ / 210) | 明文 memory.json+changelog+.bak+快照+sha256 审计 | 动态 systemPrompt.context 活节区(30s 节流),6000 字上限,hot/warm/cold 分层 | KB BM25(题×3/签×2/文×1),embedding 可选默认关 | onboarding;项目约定自动提取;**教训必须带证据**;**教训命中≥阈值自动晋升约定**;CAS 乐观锁 | TTL 90 天+changelog 截断 | 无(约 30 个工具) | 已实现;工具数过多是负担 |
| **harness-desktop harness-memory**(2★ / —) | 官方 ctx.storage domainTable(参考实现级) | system-prompt section(按标签三组渲染,50 条上限,updatedAt 序) | 无(仅列举) | memory.save/forget | memory.forget | 桌面端 MemorySection | 已实现(读源码确认) |
| **dsh-engram**(7★ / 4,400) | SQLite 双库(user+按 git origin 哈希项目库),宫殿房间/桩位坐标 | 每轮画像快照(curated 优先,CJK 感知 token 预算,分级递减);协议标签防注入;脱敏;防回声 | FTS5(中文 2-gram)+本地 bge-small-zh(q8 离线)RRF+边一跳+recency/hit boost;房间路由;多查询改写;**证据门 assess 代码强制** | 自动摄取(轮末补做+幂等键);四态写入;Jev 外裁(可选);实体词典;历史会话回填(估算→执行→续跑) | 软删;衰减归档;**SM-2 复习队列(只给线索不给正文)**;闭馆考古 | 设置页 8 视图+待回忆红角标,双语,20 工具 | 已实现(README 链源码);重、概念多 |
| **graph-memory**(628★ / 398) | SQLite;turn summary→SPO;社区+PPR;图导航、原始 Q/A 做证据 | **上下文接管**:留最新 5 轮,旧前缀折叠为标记,自动召回无需工具 | 向量 Top-K(可选)+FTS5 回退;LPA 收窄+PPR 排序 | 每完成轮恰一次辅助 LLM 抽取;坏抽取隔离 | 保留策略(最新 N 轮) | 插件清单页 | 实测:20 轮首请求 −80.69%(自跑自报,非 A/B,非 LoCoMo) |
| **dsh-tiered-memory**(0★ / —) | 三层(user/env/project)+每层 char 预算(纯 JS 单文件) | 无主动注入(工具按需) | mem_query 关键词路由层,无命中返回[] | mem_set upsert,**层满拒绝写**(不静默驱逐) | tier_summary 列候选,显式删,不自动删 | 无 | 行覆盖 98.5%+headless e2e;"65 个插件皆单层"宣称已失效 |
| **DSH-KRouter**(39★ / —) | Obsidian vault(markdown 页+canonical_sources.psv 别名表) | 不注入聊天;次日会话命中"那页"(只读 7 工具) | **名词→页+双 SHA 回执**;未命中拒绝并给别名提示;无向量,python3+rg 数十 ms | 定时器日写手:封存→蒸馏→五闸→当天 provisional(active 需人确认) | 无遗忘(笔记永存,invalid_at 过滤) | 无(依赖 Obsidian) | 三层验证分离:clone 25/25、对比 N=36 可回放、作者 72 天自报(明示无佐证) |
| **dsh-codevault**(2★ / —) | append-only JSONL 事件流+生成的 md 卡片(版本=事件重放)+[[wikilink]] | 不注入(按需查) | 按仓库/路径/符号/标签查;vault 只读检索 | 读时记一笔(快记/深读);同卡追加去重;原位升级;标签闭集;记不准不编 | 删除需确认+重建 | /codevault 命令;vault 浏览器 | 已实现;smoke.mjs 可测 |
| **灵枢 dsh-memory**(250★ / —) | 纯 md 认知图(Python md_cg 大脑,MCP stdio 多宿主)+六要素卡 | 自动记忆钩子(session/event)+自动召回注入 | 规则化检索引擎(零 LLM 黑箱),条件路由+时间线 | 三道闸门确定性裁决;committed 严格语义;RBAC token 默认只读 | 仅显式 forget,无静默淘汰 | 无专用面板(凭据/桥探针日志) | 179 测试自报;安装链长(Node+Python 桥) |
| **dsh-plugin-focus**(1★ / —) | `.dsh/focus.md` 纯文本板(工作区囚禁) | **每轮开始+变更即重注入**(pre-step,压缩存活);instructions 节区 | focus get( newest-first,截断视图) | set/append 结构化条目(objective/constraint/decision) | clear→归档 .bak 累积;maxEntries 60 | 实验性只读 web 面板 | 已实现;纯逻辑单测;处理过真实兼容事故 |

## 高相关补充(README/awesome 描述)

| 插件(star/月下载) | 一句话定位 | 关键机制 |
|---|---|---|
| **dsh-mnemon**(411★ / 36,100) | 可组合记忆框架,原生下载第一 | Source×Strategy×View;Runtime/Documents/Memory Spaces 三层;另装 mnemon CLI |
| **dsh-memory-evolve**(332★ / —) | 五轨记忆+自我进化全家桶 | git 分支感知、回合内审查、技能进化、COI 调度 |
| **dsh-mneme**(121★ / 11,206) | autoDream 梦境巩固 | SQLite+**人类可编辑 md 镜像(人工优先)**;冲突冻结待裁决;agent/workspace 隔离 |
| **dsh-meow-memory**(118★ / —) | 七层+缓存友好 | 静态 section 保 KV cache;**压缩后自动重注入**;艾宾浩斯打分;空闲 dream |
| **dsh-memento**(118★ / 4,031) | ctx.memory 能力缝+审批门 | **service 层审批瀑布模型绕不过**;硬预算满则报错;协议符合性套件;DSH 版本适配矩阵 |
| **engramory**(191★ / 1,056) | 记忆协议(非系统) | **MEMORY.md 200 行/25KB 硬顶用 ctx.tools.guard() 单调拒绝强制**;跨 4 宿主共用 |
| **seriousz158/dsh-memory**(181★ / —) | git 仓库记忆 | 清空前检查点提交;空闲同步跑在隔离副本;拒绝 symlink 逃逸 |
| **Aik358/dsh-auto-memory**(78★ / 9,045) | **与我们同名**:主动联想记忆 | 固定边界零提示召回;handoff 台账+PLAN 白板;水位感知;外部记忆继承 |
| dsh-hermes-memory / sage-mem / hr98w / trilogy / memory-palace / memory-delta | "Claude Code 风格"拥挤带 | Hermes 双库有界(2200/1375 字);sage-mem fork 自 claude-mem;delta 只注入变化条目;trilogy 三文件变更才重注入 |
| MemOS / OpenViking / EverOS / memsearch / ReMe / agentmemory / TencentDB | 跨 harness 重型系统(带 dsh 适配) | 向量/图/服务端;MemOS 35.24% token 节省为论文指标非 dsh 实测 |

## 生态层面对比(官方 vs 插件)

| 层面 | 现状 |
|---|---|
| 官方内核 | 无记忆子系统;仅 3 份默认关 MCP 参考配置(子串搜索、无遗忘策略、无自动注入,#5333/#1638 两条原生提案未落地) |
| 赛道规模 | awesome Memory 分类 ~195 条;~30 个 topic:dsh-plugin 记忆仓库;头部原生:graph-memory 628★、灵枢 250★、dsh-mnemon 411★ |
| 用户需求(Discussions) | 迁移导入(#14 首问)、装得上(dshbase 实测抓错)、别乱注入、压缩别丢、协议互通 |

## 对本项目的启示

# 对 dsh-auto-memory 的可借鉴点与差异化判断

## 0. 先说一个必须马上处理的事实:撞名

生态里存在 **Aik358/dsh-auto-memory**(78★,npm `@a9i5k4/dsh-auto-memory` **9,045 dl/月**,比我们早约一个月),定位"主动联想记忆"(零提示自动召回、handoff 台账、PLAN 白板、水位感知、技能结晶)。我们的 AskTheWay/dsh-auto-memory 9-22 才建仓(1★,npm 名 `dsh-auto-memory` 暂无下载)。两者都在 awesome 列表 Memory 分类里,用户搜索必然混淆。**建议**:①README 顶部加 engramory 式显式声明("本仓库仅 AskTheWay/dsh-auto-memory,npm 包名 dsh-auto-memory;@a9i5k4/dsh-auto-memory 是无关项目");②考虑 npm scope 或改名;③在对比表中正面列差异(我们是"零提示零成本、读路径无 LLM、审批式治理",它是"主动注入型")——被比不丢人,混淆才丢人。

## 1. 立即值得抄的(纯文件、零依赖、与我们架构同构)

1. **索引硬顶从"自律"变"他律"(engramory)**:MEMORY.md 200 行/25KB 的上限,人家用 dsh 的 `ctx.tools.guard()` 单调拒绝实现——超限的写直接被拒,缩小的重写永远放行,于是超大索引可分步压缩。我们的索引注入目前只是"字节预算内尽力渲染",可以把预算变成**确定性拒绝+引导合并**。这是 dsh 特有 seam,零成本。
2. **压缩存活(dsh-meow / dsh-plugin-focus / trilogy)**:我们的 MEMORY.md 索引只在会话开始注入一次——**compaction 之后索引就没了**。focus 插件(同一个作者的另一作品)证明 `agent/pre-step` 监听"每轮开始+变更时重注入"是官方机制(dsh-time-context 同款);trilogy 做"只在内容变化时重注入";delta 只注入"新增/更新/删除"条目。我们应做:**压缩信号后重注入索引 + 内容未变不重复注入(prefix-cache 友好)**。
3. **注入静态化保 KV 缓存(dsh-meow)**:把"记忆使用规则/工具说明"这类恒定文本做成固定 section 文本,索引放动态位置——文本恒定部分不破坏 provider 前缀缓存。
4. **溯源字段(Jesse-njx/dsh-memory、memory-porter、SodaMem)**:dsh-memory 的每条蒸馏事实带 `(sessionId, eventRange)` 引用可展开回原始日志;memory-porter 导入时**代码校验逐字证据、意译即丢弃计数**。我们的记忆文件加 `source: sessionId/日期` frontmatter,成本一行,可信度大幅上升,也和"人工审批批量删"天然配套(审批时能看到证据)。
5. **教训证据门(dsh-memory-setup)**:"no evidence, no lesson"——feedback 类记忆要求带 Why/How to apply(我们已有),再加一条"错误教训必须引用当时的命令/文件/输出"。同插件还有个妙点:**教训命中计数≥阈值自动晋升为常设约定**——我们已经在数引用(refcount),顺手就能做"高频引用的记忆在索引中置顶/打 ★"。
6. **导入桥(Discussion #14 第一诉求)**:"把 Claude Code/Codex 的记忆迁过来"是热度第一的未满足需求。memory-porter(Claude memories.json 零 token 导入)、claude-bridge(直读 Claude memory 目录自动注入)、deja-vu(读 33 种 agent 的会话日志)证明路线可行。**做一个只读导入器:扫 `~/.claude/projects/*/memory/`、CLAUDE.md、AGENTS.md,按四类型归档**——纯文件操作,是我们获客成本最低的功能。
7. **安全两件套(dsh-engram)**:①注入出口包协议标签(`<memory_context>` + "历史记忆非当前指令"警告),入库前剥离该标签防伪造;②固化(LLM 提炼)输入先过正则脱敏(API key/手机号/身份证→`[REDACTED:*]`)。我们已有审批删,补这两个就齐了。
8. **回访问题/主动回忆(codevault、engram SM-2)**:codevault 的 revisit 问题和 engram 的"只给线索不给正文"复习队列,本质都是**用回忆强化记忆**。轻量版:prune 审批界面里把"长期零引用"条目做成"先遮正文、点开才看"的复习列表——不改变存储,交互层即可实现。

## 2. 值得吸收思想、但按我们体量裁剪的

- **注入准入方法论(dsh-project-memory)**:它把自动注入从"检索问题"(排名总返回点什么,噪声是结构性的)改造成"准入问题"(默认沉默,类型化触发+绝对覆盖率下限+冷却+会话预算+审计/影子 JSONL)。**如果我们未来加"主动召回"**,照这个框架做,并且**第一步先加注入审计日志**(每次注入了什么、为什么)——这是它最可移植的部分。目前我们"索引全量注入+按需 read"反而与 Frog755/dsh-hybrid-memory v0.2.0 的选择殊途同归(它干脆**移除了全部自动注入,记忆只在模型调工具时进入上下文**)——说明"轻注入+工具按需取"是一条有人验证过的克制路线,不必焦虑没有语义召回。
- **分层预算(dsh-tiered-memory)**:层满拒绝写("tier full — delete or merge first")而非静默驱逐。我们已有软淘汰,可以加"索引满时,新写入触发合并建议而非静默截断"。
- **取代链而非静默覆盖(dsh-engram supersedes / memory-connect reviseMemory / SodaMem 双时态)**:同主题记忆更新时保留 `superseded-by:` 链接而不是覆盖——纯 markdown 可表达,审批删时有据可查。
- **git 友好(seriousz158)**:记忆目录可选 git 化+变更前检查点。我们已 git-friendly,可加"固化前自动 commit"可选项。

## 3. 明确不建议引入的(及其能力边界,供权衡)

- **向量/嵌入**(dsh-engram 本地 bge、graph-memory、memory-connect):能解决"换个说法就查不到",代价是 50MB 模型下载或外部端点、维护两套检索、CJK 分词调优。**替代方案已存在**:BM25+中文 2-gram(bigram-Jaccard×FTS5 RRF,dsh-evolve 做到零 token 确定性召回)+ `[[name]]` 别名展开(我们已有)。若要补检索短板,先做**纯关键词倒排 + 标题/标签加权 BM25**(零依赖可实现),不动架构。
- **SQLite**(meow/memento/mneme):换来结构化查询与并发安全,丢掉"用户拿记事本就能改"的白箱性。engramory 和我们证明纯 markdown 足够;mneme 的折中(SQLite 主库+人类可编辑 md 镜像、**人工修改优先合并回库**)是若真要升级时的路线,但现在没必要。
- **重型架构**(图/社区/PPR、记忆宫殿、MCP 服务端):认知成本高(engram 20 个工具、宫殿五概念),且 Discussion #14 显示用户真实痛点是"迁移、可靠、别乱注入",不是"更复杂的记忆模型"。灵枢 250★ 说明"白箱 AGI 叙事"有流量,但那是叙事红利不是产品契合。
- **自动梦见/后台巩固 daemon**(autoDream 类):我们"会话结束 LLM 固化"已是够用粒度;后台定时任务带来常驻进程与权限问题(dsh 环境对常驻 spawn 敏感,mnemon 专门为此做界化)。

## 4. 差异化定位判断(结论)

我们的定位("纯 Markdown、无服务、无 embedding、MEMORY.md 索引、审批式治理")**被生态验证为正确但不再独特**——"Claude Code 风格"拥挤带上至少 6 家。真正属于我们且值得强化的组合拳:
1. **引用计数驱动的软淘汰 + 人工审批批量删**——生态里只有我们把它做成主路径(别家多为自动衰减或纯手动);顺着 refcount 做"高频引用置顶/晋升"与"零引用复习队列",把这条线做深就是壁垒。
2. **确定性约束**:索引硬顶 guard、delete_all 审批(已有)、写入审计日志、溯源字段——"可审计的轻量记忆"这个组合在轻量带里没有第二家(dsh-memory-setup 有审计但重工具无 UI;engramory 有 guard 但是协议不是系统)。
3. **导入桥 + 压缩重注入**两个高需求低实现量的功能补齐。
4. **生态动作**:处理撞名;在 README 维护"已测试的 DSH 版本矩阵"(memento 式,dshbase 在逐个实测安装,兼容性是被公开记录的);关注 ctx.memory 缝(#1638/PerryLink)与 mm:// 协议——**给我们留一个"协议适配器"后门**(将来若官方定缝,记忆文件格式不动、加一层 provider 适配即可),不必现在站队。
5. **量化自己的注入成本**:学 graph-memory/trilogy,给出一组"每会话索引注入 token 数、压缩后重注入成本"的实测数字放进 README——这个赛道没人对轻量插件做过诚实计量,做了就是信任状。

---

# 开源记忆系统标杆

## 调研发现

# AI Agent 记忆系统开源标杆调研报告(2026-09)

> 说明:每条尽量注明来源;【已实现】=开源代码/官方文档可验证,【宣称】=厂商自述未独立复现,【论文指标】=论文报告数字(基准本身有争议,见 §8)。截至 2026-09-25。

## 1. Mem0(mem0ai/mem0)——"提取-固化"管道的事实标准,且已是 dsh 生态直接竞品

**形态**:三层——pip/npm 库(自带向量库)、自托管 server(docker compose,默认开 auth)、云平台([README](https://github.com/mem0ai/mem0))。YC S24。

**写入策略(两代,均已开源可查)**:
- 论文版([arXiv 2504.19413](https://arxiv.org/abs/2504.19413),2025):两阶段管道。① extraction:LLM 把对话分解为原子事实;② consolidation:LLM 对照既有记忆做工具调用决策 **ADD / UPDATE / DELETE / NOOP**,处理去重与矛盾。【已实现】这是业界被引用最多的"更新 vs 追加"方案。
- v3 版(README "New Memory Algorithm, April 2026")【已实现,但注意 README 自己声明分数来自含专有优化的托管平台,开源 SDK"方向性相似但不等同"]:
  - **单遍 ADD-only 提取**:一次 LLM 调用,只增不改不删("Memories accumulate; nothing is overwritten")——把冲突处理从写入端移到检索端;
  - agent 确认过的事实(如"已帮用户装好 Redis")作为一等公民入库;
  - 实体抽取→嵌入→跨记忆做实体链接(entity linking)用于检索加权;
  - 多信号检索:语义 + BM25 关键词 + 实体匹配并行打分融合;时间感知排序(问"现在/过去/将来"时选对时点的实例)。
- 平台闭源功能([docs.mem0.ai llms.txt](https://docs.mem0.ai/llms.txt)):**Dream**(后台合成:Synthesis 合并重复+Supersede 取代过时事实,Merge 常开)、**Memory Decay**(搜索时提升近期被强化的记忆、抑制陈旧记忆,opt-in、只调权不过滤)、Temporal Reasoning、Profiles(每用户"常新摘要"一次读全)、Graph Memory、Entity-Scoped Memory(user/agent/app/run 四级 scope 隔离)、Advanced Retrieval(关键词/rerank/hybrid)。【已实现但仅平台】
- **Agent-as-a-Judge 方向**:Mem0 开源了评测框架 [memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)(README 提及);未找到 Mem0 官方同名产品功能,该词主要出自独立论文 arXiv:2506.21506。**Deep Memory**:2025 年宣发的平台功能(用私有语料迭代优化检索),当前 docs 索引已无独立页面,并入 Advanced Retrieval——【宣称,不可在开源版复现】。
- **多用户隔离**:user_id / agent_id / run_id / app_id 四级 scope 键,"防记忆跨 scope 泄漏"是官方叙事;OpenMemory MCP 本地共享跨客户端(Claude/ChatGPT 等)记忆,但需 Docker+Postgres+Qdrant(SSRN 论文指出)。
- **LOCOMO 数字**:论文 66.9% vs OpenAI Memory 52.9%(LLM-as-Judge),p95 1.44s vs 17.12s,每查询 ~1.8K vs 26K tokens【论文指标】;v3 宣称 LoCoMo 92.5 / LongMemEval 94.4 / BEAM-1M 64.1【宣称,平台版】。
- **dsh 集成**:`@mem0/deepseek-plugin` 0.3.0【已实现,来源 docs.mem0.ai/integrations/deepseek-plugin.md】:挂 `system-prompt/assemble` 钩子在每次模型请求前自动召回(用最新人类消息检索、未见结果注入上下文);挂 `session/event` 只在**完成的回合**自动捕获;注册 `search_memory`/`add_memory` 两工具;fail-open(记忆服务挂了不阻塞 agent);需 Mem0 云 API key。文档中明确以"Unlike file-based memory plugins"作对照——**Mem0 官方把文件型插件列为主要对手**。

## 2. Letta(原 MemGPT,letta-ai/letta→letta-code)——从向量库分页转向"git 化 Markdown 记忆文件系统"

**历史(MemGPT, arXiv:2310.08560)**【论文+已实现】:OS 式虚拟上下文。三层记忆:core memory(常驻上下文,persona/human 块)、recall memory(对话历史检索)、archival memory(向量库);**self-editing memory**:agent 自己调用 `core_memory_append/replace`、`archival_memory_insert/search`、`conversation_search` 等函数编辑记忆,而非外部管道写入;heartbeat 机制驱动异步整理。DMR 基准 93.4%(MemGPT 自建,后被 Zep 引用)。

**现状(letta-ai/letta-code,README + docs.letta.com)**【已实现,且与 dsh-auto-memory 高度同构】:
- **MemFS**:记忆是 agent 名下的 git 仓库,投影为真实目录,agent 用普通文件工具读写;每次记忆修改都是 commit(版本历史、冲突解决、未提交变更边界清晰);可 `/memory-repository set` 同步到 GitHub;**记忆子代理(dreaming、memory doctor)用 git worktrees 并发改记忆不阻塞主 agent**。文件形态 = Markdown + YAML frontmatter(description 字段)。
- **上下文经济**:`system/` 下文件(persona.md、human.md)每回合注入系统提示词;`system/` 之外的文件不进上下文,**但文件树本身常驻系统提示词,目录/文件名作为路标(signposts)引导按需读取**;`reference/`、`skills/` 等目录。
- **默认无向量索引**:"MemFS does not include a semantic or vector index by default. Agents find memory in its Markdown files with normal file-search and read tools."语义/混合检索是可选 mod(`memfs-search`,基于 QMD)。——头部玩家公开选择"文件树+grep 优先,语义检索后置"。
- **Dreaming(sleep-time compute 产品化)**:`/sleeptime` 配置,两种触发:完成 N 个 agent 步骤后 / 上下文压缩(compaction)时;后台子代理回顾近期对话、固化经验到记忆;可选"Agent reviews before applying"(第二后台会话中 agent 复核修订,费 token、不需人批)。论文 [arXiv:2504.13171](https://arxiv.org/abs/2504.13171)。另有 `/init` 引导记忆、`/remember` 显式教学(agent 决定落盘位置并 commit)、`/doctor` 审计记忆放置/重复/系统提示词 token 占用、`/palace` 查看记忆宫殿、`/sleeptime` 周期性"做梦"。
- 多用户/多 agent:每 agent 独立 MemFS 仓库;shared memory 仓库供多云 agent 共享。Context Constitution(github.com/letta-ai/context-constitution)定义"什么进上下文、什么顺序、什么粒度、停留多久"。

## 3. Zep / Graphiti(getzep/graphiti)——时间感知知识图谱:矛盾不删除,只失效

**Graphiti(OSS 框架)**【已实现,README】:时序上下文图谱。四要素:Entities(节点,摘要随时间演化)、Facts/Relationships(三元组边,**带有效性窗口**)、Episodes(原始数据溯源,每条派生事实可回溯)、Custom Types(Pydantic 定义 prescribed ontology,或 learned ontology 涌现)。
- **bi-temporal**:每条事实双时间线——valid time(世界中为真的时间)+ ingestion time(系统获知时间),支持"任意时点为真"的历史查询([Zep docs](https://www.getzep.com/ai-agents/temporal-knowledge-graph))。
- **冲突处理 = edge invalidation**:新事实与旧事实矛盾时**不删除旧边**,标记 invalid/superseded,全历史保留。这是"更新 vs 追加"的第三条路线:追加 + 失效标记。
- **检索**:混合——语义嵌入 + BM25 关键词 + 图遍历,不依赖 LLM 摘要;增量构建,无需全图重算;实体消解。
- 部署:Graphiti 自带图数据库(BYO Neo4j/FalkorDB);Zep 商业版用自研 Context Graph Engine,宣称 sub-200ms。
- **论文**([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)):DMR 94.8% vs MemGPT 93.4%;LongMemEval 准确率 +18.5% 且延迟 -90%【论文指标】。Zep 曾公开质疑 Mem0 的 LOCOMO 数字(自测 75.14%)。

## 4. LangGraph memory(checkpointer + store)——记忆即基础设施原语,策略全留白

【已实现,[docs.langchain.com persistence.md / stores.md](https://docs.langchain.com/oss/python/langgraph/persistence)】
- **短期记忆 = Checkpointer**:按 `thread_id` 每步保存图状态快照,支持续聊、human-in-the-loop、time-travel、故障恢复。仅线程内。
- **长期记忆 = Store(跨线程)**:key-value 库,`namespace` 为任意长度元组(典型 `(user_id, "memories")`),API:`put(namespace, key, value)` / `get` / `search`(无 query=列出命名空间;带 query=语义检索,需配 embedding index)/ `delete`;Item 自带 `created_at`/`updated_at`。后端:InMemory(开发)/ Postgres / Mongo / Redis / Upstash。
- **官方范式**:三种接入——Store 作为节点内对象写("hot path" 节点模式)、包装成工具让 agent 调用、或 BaseStore 注入(2024-10 长期记忆博客)。
- **关键空白**:LangGraph 不提供提取管道、冲突处理、衰减、打分排序——同名 key 直接覆盖,策略完全交给开发者。它是"记忆原语层",与 Mem0/Letta 这类"记忆产品层"互补。

## 5. A-MEM(agiresearch/A-MEM, arXiv:2502.12110)——Zettelkasten 笔记网络:写入即链接、邻居共演化

【论文+已实现】每条记忆 = 结构化笔记:**content + LLM 生成的 keywords + tags + context(上下文描述)+ 时间戳 + 嵌入向量**(ChromaDB)。
- **写入即整理**:新增笔记时 ① LLM 生成结构化属性;② 向量检索历史相似笔记;③ LLM 判断并建立笔记间**链接**(link generation,语义相似+时间邻近);④ **memory evolution**:被链接的旧笔记的 context 会被更新以纳入新邻居关系——网络随写入持续重组。
- 检索:向量相似 + tag/keyword 过滤。
- 指标:GPT-4o-mini 上 LOCOMO 较基线平均 F1 +49.11%(作者宣称);token 用量 1.2K–2.5K vs 基线 ~16.9K(论文)。**OpenReview 同行质疑**:RAG 在同模型上仍优于 A-MEM。
- 依赖 ChromaDB 嵌入,但"笔记属性结构 + 自动双向链接 + 邻居演化"的思想不需要向量库也能移植(LLM 判断相似即可)。

## 6. OpenViking(volcengine/OpenViking)与 MemOS(MemTensor/MemOS)——"记忆操作系统"两派

**OpenViking:上下文数据库 = 可浏览的虚拟文件系统**【已实现,README】
- 一切上下文统一进 `viking://` 树:resources(文档/代码)、user/{id}/memories(preferences 等)、skills、peers——**记忆、RAG、技能一个文件系统**,agent 用 ls/tree/read/write/grep 导航。
- **L0/L1/L2 渐进加载**:每个语义化目录带生成的 `.abstract.md`(L0 一句话摘要,快速判相关性)与 `.overview.md`(L1 结构要点,供规划),L2 原文按需读。**先读摘要再读原文**是核心省 token 机制。
- **Session commit**:会话可提交——归档对话并**提取记忆为 Markdown**,可检查、可编辑、可合并;`ov compile` 可把素材组织成 wiki/知识图谱/报告。
- **Scoped search**:语义检索可限定子树(某项目/某记忆目录),而非全库平铺向量池。
- 指标【自测,README benchmark 报告,用豆包模型】:LoCoMo 上三个 agent 原生记忆 24–57% → 接入后 80–83%,输入 token -34~91%,延迟 -58~66%;tau2-bench 任务成功率 +6.9pp(retail)/+11.9pp(airline)。AGPLv3。需要 embedding 模型 + VLM(server 模式,~/.openviking/ov.conf)。

**MemOS:记忆即可管理系统资源**【论文 arXiv:2507.03724 + 已实现】
- **MemCube** 统一三态记忆:plaintext(明文)/ activation(KV-cache)/ parameter(模型权重),封装内容+溯源+版本元数据,可组合、迁移、融合(明文记忆可沉淀进参数记忆,桥接检索与持续学习);MemScheduler 异步调度、多级记忆调度;多知识库 = 多 Cube,隔离+受控共享。
- 自然语言反馈修正记忆("Memory Feedback & Correction")。
- 指标:LoCoMo 88.83 / LongMemEval 89.20(经自建 OmniMemEval,14 商业产品对比);论文宣称 +43.7% vs OpenAI Memory、token -35.24%【论文/宣称】。
- **dsh 直接竞品**:`@memtensor/memos-local-plugin`("Reflect2Evolve",MemOS README 2026-08-17 宣布接入 DeepSeek Harness)【已实现】:本地优先,SQLite 持久化 + FTS5 全文 + 向量**混合检索**、smart dedup;分层自进化记忆 **L1 traces(对话轨迹)→ L2 policies(跨任务策略归纳)→ L3 world models + 技能结晶(skill crystallization)**;reflection 加权价值回传;三级检索;附 Memory Viewer 面板。同核适配 OpenClaw/Hermes/dsh 三平台。

## 7. Honcho(plastic-labs/honcho)——不存对话存"结论":用户建模 + 心理理论

【已实现,README】**The Honcho Loop**:Store(把消息/事件/工具轨迹存到 session)→ **Reason(后台异步队列推理,更新 peer 表示)** → Query(peer representations / context query / search / 自然语言洞察)→ Inject。
- 模型:**workspace → peers → sessions → messages**;记忆主体是 **(observer, observed) 对**——"Agent A 对用户 B 的认识",与 Mem0(记忆属于用户)、Letta(记忆由 agent 编辑)正交;天然表达矛盾与视角差异。
- **Dialectic(辩证)用户建模**:不回放原始 chunk,而是通过推理得出关于用户的结论(信念/偏好/意图,含矛盾),官方称"reasoning-first memory";chat endpoint 直接用自然语言问"这个用户怎么看 X"。
- 宣称"agent memory 的 Pareto Frontier"(自家 evals 页)【宣称】。FastAPI 可自托管;有 MCP/Claude Code/OpenCode/OpenClaw 集成。

## 8. 横切机制提炼(写入/更新/冲突/检索/遗忘/隔离)

- **写入时机谱系**:agent 自编辑工具(MemGPT/Letta Code)→ 回合完成自动捕获(Mem0 dsh 插件挂 session/event)→ 空闲期后台固化(Letta dreaming、Honcho 后台推理、Mem0 Dream)→ 会话提交时(OpenViking session commit、dsh-auto-memory 会话结束固化)。
- **更新 vs 追加**:三代方案并存——①LLM 写入端仲裁(ADD/UPDATE/DELETE/NOOP,Mem0 论文);②**ADD-only + 检索端融合排序**(Mem0 v3,写入更快更省、历史无损,矛盾由检索时时间排序解决);③**追加 + 失效标记**(Graphiti bi-temporal invalidation);④追加 + 邻居演化(A-MEM)。
- **检索打分**:注意归属——"recency/importance/relevance 三元打分"出自 **Generative Agents**(Park et al., arXiv:2304.03442):score = α·relevance(余弦)+ β·recency(指数衰减 0.995^小时)+ γ·importance(LLM 打 1–10 分),各项 min-max 归一、论文等权;MemGPT 的检索是 embedding 向量召回。Mem0 v3 = 语义+BM25+实体信号并行融合 + 时间排序 + Decay 调权;Graphiti = 向量+BM25+图遍历;Letta MemFS 默认 = 文件树导航(无打分,可选混合检索 mod)。
- **遗忘/衰减**:Mem0 平台 Memory Decay(调权不删)、Graphiti validity window(失效不删)、Letta /doctor 审计 + 手工重组、A-MEM 无遗忘、OpenViking/MemOS 无显式遗忘(靠分层与合并)。**没有任何一家默认物理删除用户记忆**——"软淘汰"是共识,dsh 的 staleAfterDays+引用计数方向正确。
- **多用户隔离**:scope 键(Mem0 user/agent/run/app 四级)≈ namespace 元组(LangGraph)≈ 目录树(OpenViking user/{id})≈ 每 agent 独立 git 仓库(Letta)≈ workspace/peer 对(Honcho)。本质都是"路径/键前缀隔离"。
- **基准可信度**:LOCOMO 多方注水指控——第三方实测其 GPT-4o-mini judge 接受 62.81% 的"主题对但事实错"回答(bloo-mind "Benchmark Theatre");Zep 与 Mem0 互指对方数字;RetainDB 指出"全量上下文"也能打平。**不要为跑分引入重方案**。

## 横向对比

# 横向对比:开源记忆系统 × 关键维度

| 系统 | 形态/存储 | 写入时机与策略 | 更新 vs 追加 / 冲突 | 检索与打分 | 遗忘/衰减 | 多用户隔离 | 重依赖 | 基准(标注可信级) |
|---|---|---|---|---|---|---|---|---|
| **Mem0** | 库/自托管/云;向量库(平台+图引擎) | 回合完成自动捕获 + add 工具;论文版两阶段提取→固化;v3 单遍 **ADD-only** | 论文版:LLM 仲裁 ADD/UPDATE/DELETE/NOOP;v3:只追加,冲突留检索端;平台 Dream 后台 supersede/merge | v3 多信号融合(语义+BM25+实体链接)+时间感知排序;平台 rerank/hybrid;Memory Decay 检索时调权 | 平台 Memory Decay(调权不删);OSS 版靠 DELETE 决策 | user/agent/run/app 四级 scope;OpenMemory MCP 跨客户端共享(Docker+PG+Qdrant) | 向量库必选;平台功能闭源 | LoCoMo 66.9→92.5、LongMemEval 94.4【92.5 为平台宣称,README 自认 OSS 不等同】 |
| **Letta(MemGPT)** | agent 状态库;**现为 git 仓库 + Markdown(MemFS)** | agent 自编辑工具(/remember 等)+ **dreaming 后台固化**(N 步后或 compaction 时触发) | commit 即版本;冲突走 git;可选 agent 复核 dreaming 产出 | **system/ 目录每回合注入;文件树常驻提示词作路标,按需 read;默认无向量索引**(可选 memfs-search mod) | /doctor 审计重复与 token 膨胀;人工/agent 重组;无自动衰减 | 每 agent 独立 MemFS;shared memory 仓库共享;跨机 git 同步 | 默认无(!);语义检索可选 QMD;云后端闭源 | DMR 93.4%(MemGPT 论文);sleep-time compute arXiv:2504.13171 |
| **Zep/Graphiti** | 时序知识图谱(Neo4j/FalkorDB 或自研引擎) | episode 摄入→非阻塞抽取实体/事实边 | **追加+edge invalidation(bi-temporal:valid/ingestion 双时间,失效不删)**,历史全保留 | 混合:向量+BM25+图遍历;实体消解;增量构建 | validity window(时点查询);无物理删除 | 每用户/实体一个 context graph(Zep 管理海量图) | 图数据库必选+LLM 抽取 | DMR 94.8 vs MemGPT 93.4;LongMemEval +18.5%、延迟-90%【论文】 |
| **LangGraph** | checkpointer(线程快照)+ store(KV) | 开发者自定:节点热路径写/工具写/BaseStore 注入 | 同 key put 直接覆盖;**无内建冲突/提取/衰减策略** | namespace 元组前缀过滤;可选 embedding index 语义 search;无相关性以外的打分 | 无(建议自建保留策略,官方仅给 cron 清 checkpoint 示例) | namespace tuple(典型 (user_id,"memories")) | DB 后端可选(PG/Redis/Mongo);索引可选 | 不参赛(原语层,非产品) |
| **A-MEM** | 笔记网络(ChromaDB 向量) | add_note 即触发:LLM 生成 keywords/tags/context→检索相似→**link generation**→**邻居笔记 context 演化** | 追加+网络演化(不删);无显式冲突处理 | 向量相似 + tag/keyword 过滤 | 无遗忘机制 | 无内建多用户(单库) | ChromaDB+LLM | LoCoMo F1 +49.11% vs 基线(gpt-4o-mini)【作者宣称,OpenReview 质疑】;token 1.2–2.5K vs 16.9K |
| **OpenViking** | **虚拟文件系统 viking://**(记忆/RAG/技能统一;server 模式) | 会话 commit 时归档对话+**提取 Markdown 记忆**(可查可改可合并);写入带 L0/L1 摘要生成 | 追加为主;可人工编辑合并;ov compile 重组 | **L0 摘要→L1 概览→L2 原文渐进加载**;scoped search(限定子树);语义检索 | 无显式衰减;靠分层+合并压缩 | 目录树 user/{id}/ 天然隔离 | 需 embedding 模型+VLM;server 进程;AGPLv3 | LoCoMo 24–57%→80–83%,token -34~91%(自测,豆包模型)【自报】 |
| **MemOS** | MemOS 服务(Neo4j+Qdrant 自托管);MemCube 统一明文/激活/参数记忆 | 异步 MemScheduler;消息入库即调度;local-plugin 反思驱动(Reflect2Evolve) | 追加+自然语言反馈修正;MemCube 可组合/融合/迁移 | 统一 Memory API;local-plugin:FTS5+向量混合+三级检索(L1/L2/L3 分层) | 无显式遗忘;分层沉淀(traces→policies→skills) | 多 MemCube 知识库隔离+受控共享 | 重(Neo4j+Qdrant);local-plugin 仅 SQLite | LoCoMo 88.83 / LongMemEval 89.20(OmniMemEval 自建)+43.7% vs OpenAI Memory【论文/宣称】 |
| **Honcho** | FastAPI 服务(可自托管/云);peer 表示库 | Store 消息→**后台异步 Reason 更新 peer 表示** | 不存 chunk 存结论;辩证推理容忍矛盾(视角即 (observer,observed) 对) | 查询 peer representations / context query / **自然语言问"用户怎么看 X"(chat endpoint)** | 无显式遗忘(表示随推理更新) | workspace/peers;(observer,observed) 多视角对 | 服务+后台 LLM 推理成本 | 自称 Pareto Frontier(自家 evals)【宣称】 |
| **dsh-auto-memory(对照)** | **纯 Markdown 文件+MEMORY.md 索引,零服务零 embedding** | 会话结束 LLM 自动固化 + memory_write 手动 | 四类型+软淘汰(staleAfterDays+引用计数);人工审批批量删 | 索引注入系统提示词;[[name]] 链接展开;memory_read/list | 软淘汰(过期+低引用,不直接删,审批制) | 按目录/project(文件路径天然隔离) | **无**(纯文件) | 未跑分 |

**一张速查:更新策略光谱** —— Mem0 论文(写入端 LLM 仲裁)→ Mem0 v3(ADD-only+检索端融合)→ Graphiti(追加+时态失效)→ A-MEM(追加+邻居演化)→ Letta(git 提交+人工/agent 重组)→ dsh 现状(会话结束批量固化+软淘汰,尚无写入端冲突仲裁)。

## 对本项目的启示

# 对 dsh-auto-memory 的可借鉴点与差异化判断

## 0. 最重要的结论:路线已被验证,不必转向

- **Letta(前 MemGPT)最新架构 MemFS 就是"git 化的 Markdown 记忆文件系统"**:system/ 目录注入系统提示词、文件树常驻提示词作索引、按需 read、默认无向量索引("agents find memory with normal file-search and read tools")、后台 dreaming 固化。这与 dsh-auto-memory 的"MEMORY.md 索引注入 + 文件记忆 + 会话结束固化"几乎同构——头部研究型公司从向量库退回文件形态,是我们定位的最强背书(docs.letta.com/concepts/memfs)。
- **Mem0 官方在 DSH 插件文档里直接以 "Unlike file-based memory plugins" 作为对照句式**——文件型插件被头部商业玩家视为主要对手;MemOS 也发布了 dsh 本地插件(@memtensor/memos-local-plugin,SQLite+FTS5+向量)。生态里"重"方案正在涌入 dsh,轻量纯文件是稀缺且站得住的生态位。
- LOCOMO 分数普遍注水(第三方实测 judge 接受 62.81% 错误答案;Zep/Mem0 互质疑;全上下文基线也能打平),**不要为跑分引入 embedding/数据库**。轻量叙事应主打:可审计(纯文本可 diff 可 git)、token 效率(A-MEM 证明结构化笔记 1.2–2.5K token 可敌 16.9K 全量)、零依赖零成本、fail-open。

## 1. 可立即落地(纯文件、无新依赖)的迭代点

1. **打分检索(优先级最高)**:把 Generative Agents(Park 2023)的三元打分搬到文件元数据上——`score = 相关性(关键词/tag 命中数,记忆文件可在固化时由 LLM 生成 keywords 字段)+ 最近性(指数衰减 0.995^h,用文件 mtime 或 frontmatter 的 last_accessed)+ 重要性(引用计数 ≈ importance,或写入时让 LLM 打 1–10 存 frontmatter)`。作用于 memory_read/search 与"哪些条目进 MEMORY.md 索引"的排序。这是 Mem0 v3"多信号融合"与平台 Memory Decay 的零依赖等价物。
2. **写入端冲突仲裁(第二优先)**:固化提示词从"纯追加"升级为 Mem0 论文版——让固化 LLM 对照同主题旧记忆输出 ADD / UPDATE / DELETE / NOOP 建议,**DELETE 不直接执行而是进已有的审批批量删流程**(与 dsh 现有人工审批机制无缝衔接);或更保守的 Graphiti 式:不改旧文件,在新记忆 frontmatter 写 `supersedes: <旧名>` + 给旧文件标 `superseded_by`,检索时默认取最新实例但历史可查。两条路线都只需 frontmatter 字段+提示词。
3. **时间元数据与时间感知检索**:frontmatter 增加 created/updated/last_accessed/superseded_at。检索层规则:问"现在/最新"时优先非 superseded 的最新实例(Mem0 v3 temporal reasoning 的文件版)。成本≈0,直接提升"偏好变更"类查询质量。
4. **固化时自动链接(A-MEM link generation 的文件版)**:新记忆写入时,固化 LLM 顺带给出应建立 [[name]] 链接的旧记忆并做**双向链接**(旧文件也加回链)。dsh 已有 [[name]] 展开机制,补"写入时建议链接+双向化"即可让网络效应随使用增长;A-MEM 的 memory evolution(更新邻居的 context)可暂缓,性价比低。
5. **记忆写入时生成 keywords/aliases 字段**:弥补无 embedding 的语义泛化短板——同义词/别名在固化时由 LLM 写进 frontmatter,检索时参与打分。这是无向量库条件下对"语义检索"最便宜的近似。
6. **索引分层(OpenViking L0/L1 思想)**:MEMORY.md 已是 L1;可在索引条目层面贯彻"先给结论再看原文"——索引行写成 Honcho 式"结论"(用户是谁/偏好什么)而非"话题标签";记忆量大后可为类型目录加 L0 单行摘要(甚至就放在 MEMORY.md 每个类型段落的标题行)。
7. **doctor/审计命令(Letta /doctor 的等价物)**:新增 memory 工具或 dsh 命令:检测重复记忆(内容相似提示)、死链([[name]] 指向不存在)、超长记忆(建议拆分)、索引膨胀(超预算条目),输出清理建议进审批流。Letta 证明"记忆库需要定期体检"是真实需求,而 dsh 的审批制让这件事比竞品更安全。
8. **显式教学入口**:Letta `/remember` 的等价——用户说"记住 X"时 agent 直接 memory_write(已有工具,缺的是提示词里显式鼓励此路径 + 会话结束固化时不与之重复入库,dedup 规则写进固化提示词)。

## 2. 中期考虑(仍无外部服务)

- **后台"做梦"(Letta dreaming/Mem0 Dream 的文件版)**:在 staleAfterDays 检查之外,增加低频(如每 N 个会话)后台任务:让 LLM 回读某类型全部记忆,输出"合并重复/沉淀模式/晋升高频引用记忆进索引顶部/降级长期未用"的建议清单→审批执行。dsh 的引用计数已经提供了打分原料,这是把它从"淘汰依据"升级为"重组依据"。
- **多级 scope(Mem0 四级/LangGraph namespace 的文件版)**:目录即 scope(user/project/agent 维度用路径前缀表达),memory_list 天然支持;若 dsh 有多 profile 场景,在 frontmatter 加 scope 字段即可过滤。OpenViking 的 user/{id}/ 目录树证明文件系统做隔离绰绰有余。
- **会话轨迹→策略/技能沉淀(MemOS local-plugin L1→L2→L3 的取舍版)**:不必照搬四层,但可在"事实/偏好/过程/项目"四类型外考虑第五类"教训/策略"(lesson):由 dreaming 阶段从多条过程记忆归纳,引用计数天然标识高价值教训。这正对 dsh-auto-memory 作为编码助手的场景(比聊天更受益于 procedural memory)。

## 3. 明确不建议引入的重方案(及其能力,供权衡)

- **向量库/embedding**:所有竞品都有,但 Letta MemFS 默认没有、A-MEM 证明 LLM 生成 keywords 可部分替代、且 dsh 定位明确排斥。若未来真要语义检索,走"可选的可插拔索引文件"(如离线生成的轻量关键词倒排表),不引服务。
- **知识图谱+bi-temporal(Graphiti)**:edge invalidation + 时点查询是优雅的冲突方案,但成本是图数据库+LLM 抽取管道;文件版用 `supersedes/superseded_by` frontmatter + 时间戳可拿到 80% 价值。
- **KV store/checkpointer(LangGraph)**:dsh harness 本身管理会话状态,记忆插件无需自建持久层。
- **后台推理服务(Honcho dialectic)**:"存结论不存对话"的思想已可借(索引行结论化),但常驻 Reason 服务违背零依赖定位。

## 4. 差异化定位建议(对外叙事)

dsh-auto-memory 相对已入场的三个重方案(Mem0 dsh plugin 需云 API key、MemOS local plugin 需 SQLite+双索引、OpenViking 需 server+VLM+embedding)的独特卖点应明确为:**纯文件可 git 审计、人工审批删除(唯一把"遗忘权"交给用户的)、零 token 常驻成本可控(索引注入即预算)、无外部服务无 API key 无数据外流、软淘汰+引用计数**。下一步迭代按性价比排序:打分检索 > 写入端冲突仲裁(supersedes)> 时间元数据 > 固化时双向链接+keywords > doctor 审计 > dreaming 重组——前四项都只是"固化提示词 + frontmatter 字段 + 检索排序函数"级别的改动,完全在轻量定位内。

---

# 闭源/产品化记忆系统

## 调研发现

# 闭源/产品化记忆系统调研报告

> 标注约定:**[已实现]**=官方文档/官方博客当前生效内容(本次调研已读原文);**[报道]**=媒体报道,未经官方公告逐字核对;**[社区]**=用户社区观察;**[论文]**=arXiv 论文指标。调研日期 2026-09-25。

---

## 1. ChatGPT Memory(OpenAI)

**来源:** OpenAI 帮助中心《Memory in ChatGPT》(help.openai.com/en/articles/8590148,已读全文,2026 年 6 月截图版本)。

### 架构:三层数据源 + 两代体验
- **记忆数据源分五类**[已实现]:past chats(历史对话)、saved memories(显式笔记)、custom instructions、Library 文件、连接的应用(如 Gmail)。"Memory does not retain every detail"——ChatGPT 自行判断相关性。
- **两个独立开关**[已实现]:
  - **Reference saved memories**:显式笔记(旧体系,"User is vegetarian" 这类离散条目);
  - **Reference chat history**(2025-04 推出):不落库、按需检索全部历史对话,"chat history 引用无单独存储上限"。
  - 联动规则:关掉 saved memories 会连带关掉 chat history;反向可只关 chat history。
- **两代体验可切换**[已实现]:**Improved Memory**(持续更新的宽泛摘要,模糊条目边界)vs **Legacy saved memories**(离散条目列表),Settings > Personalization > Memory > 切换。这是 OpenAI 自己在"结构化条目"与"摘要式记忆"之间摇摆的直接证据。
- **saved memories 双写入**[已实现]:"details that you explicitly ask ChatGPT to remember or that ChatGPT saves as useful context"——显式"记住这个" + 自动保存并存。
- 部分付费计划的 saved memories 附加**搜索、排序、自动优先级、版本历史**[已实现]。

### 用户可见性/透明度(本次调研最重要的发现)
- **Memory summary**[已实现]:高层摘要视图,不保证包含全部;可直接在文本框**输入修正**,或**划选文字修正**,或对某段选"Don't mention this again"(降权但不删源)。
- **Sources(引用展示)**[已实现]:当回答用到了个人化上下文,回答下方出现 Sources 区,列出贡献了这次个性化的 past chat / saved memory / custom instruction / file / email;每条可:打开源、**修正/删除 saved memory**、删除被引用的 chat、**标记 relevant / not relevant**。这是"为什么想起这条"的产品级答案。
- **容量上限**:无官方数字[已实现-官方未披露];存在"memory is full"满载状态,满后新记忆需覆盖/合并旧记忆[社区];reference chat history 明确"无单独存储上限"[已实现]。
- **Temporary chat**[已实现]:开始前可选是否带入已有记忆/自定义指令(选 Unpersonalized);临时会话**不创建也不更新记忆**;保存临时会话即转正式、此后按常规记忆规则。开始后不可改。
- **隐私/删除语义**[已实现]:删除单条 saved memory 不影响原对话;要彻底移除须"删记忆条目 + 删来源会话 + 删 Library 文件 + 断开 app 连接"多源清理;删除传播需要时间,OpenAI 保留已删记忆日志至多 30 天;关闭 reference chat history 后派生记忆 30 天内删除。受监管工作区(Healthcare/Enterprise Regulated)默认关闭 improved memory,且提供 **Project-only memory**(项目内记忆隔离)。

### 亮点
Sources 引用 + 划选修正 + relevant/not relevant 反馈回路;"Don't mention this again"提供删除与保留之间的第三档控制。

### 局限
Improved memory 摘要不透明("may omit details");无容量数字,用户撞墙才知道;记忆-来源多副本导致"删不干净"问题(官方自己写了 5 步清理指南)。

---

## 2. Claude.ai / Anthropic

### 2a. Projects(项目知识)
**来源:** Anthropic 官方公告《Collaborate with Claude on Projects》(anthropic.com/news/projects,2024-10,已读全文)。
- 每个 Project:**200K 上下文窗口**(相当于 500 页书)装 knowledge 文件(文档/代码/访谈/过往工作)+ **Project instructions**(语气、角色视角等自定义指令),项目内全部会话共享[已实现]。
- 定位是"避免冷启动"的静态知识,非自动记忆;当时面向 Pro/Team。
- Team 版有项目内 activity feed 共享最佳会话快照[已实现]。

### 2b. Claude 记忆功能演进线(2025.10 → 2026.9)
**来源:** 官方支持文档《Use Claude's chat search and memory to build on previous context》(support.claude.com/en/articles/11817273,已读全文,更新于 2026-09-15);官方 changelog;The Verge/ZDNet/CNET 报道。

时间线:
- **2025-09-29**:Claude API **memory tool** beta 上线(见 2c)[已实现]。
- **2025-10**:claude.ai 记忆功能向 Pro/Max 推出(The Verge: theverge.com/news/804124/anthropic-claude-ai-memory-upgrade-all-subscribers)[报道];changelog 2025-11-06 记录"记忆默认为所有用户开启"[已实现]。
- **legacy 形态**:自动摘要,**每 24 小时**生成一次跨会话 memory summary,注入每个新独立会话[已实现]。
- **新形态**:改为**边聊边存**——"Claude saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end. Mention that a deadline moved, and your next conversation already knows"。即从"日批摘要"转向"topic 粒度增量写入"[已实现]。
- **2026-08**:chat 与 **Cowork 共享同一份记忆**(账户级统一):"ask Cowork to draft an update for your manager, and it already knows who that is"[已实现,官方支持文档];记忆**导入/导出**(从 ChatGPT/Gemini 等迁入,实验性)[已实现]。
- **2026-09**:记忆与会话生命周期联动——"When a conversation expires or is deleted, related memory entries are updated"[已实现,官方支持文档]。

### 2c. Claude API memory tool + managed memory stores(对 dsh 定位最重要的印证)
**来源:** Claude Docs《Memory tool》(docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool,已读全文);Platform Docs《Using agent memory》(platform.claude.com,搜索摘要)。

- **memory tool**(`{"type": "memory_20250818"}`,beta,现近 GA)[已实现]:**纯文件方案**——Claude 通过 6 个命令(view / create / str_replace / insert / delete / rename)操作客户端本地 `/memories` 目录下的文件,跨会话持久。客户端实现存储,官方文档初始目录即含一个 `CLAUDE.md` 风格 stub。
- **自动注入系统提示词**[已实现,官方文档原文]:"IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE. MEMORY PROTOCOL: 1. Use the view command…record status/progress/thoughts in your memory. ASSUME INTERRUPTION: Your context window might be reset at any moment…"(假设中断、随时落盘——与 dsh 的索引注入+自动固化同构)。
- **官方防膨胀指令**(模型写乱时建议加)[已实现]:"keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. **Do not create new files unless necessary**."
- **官方安全建议四条**[已实现]:敏感信息过滤;文件大小限制+**读命令分页**;**记忆过期——"Consider clearing out memory files periodically that haven't been accessed in an extended time"**(基于访问时间的淘汰,= dsh 引用计数+staleAfterDays 的官方背书);路径穿越防护(/memories 前缀校验、canonical path、拒绝 ../)。
- **与 context editing 联动**[已实现]:上下文接近清理阈值时自动警告 Claude,促使它把重要信息从将被清掉的 tool results 落盘到记忆文件——记忆作为工作上下文的延伸层。
- **Managed memory stores**(`memstore_*`,platform.claude.com API)[已实现,API 文档存在;2026-04-23 发布细节来自媒体]:托管记忆库以**文件形式存储**,可通过 API 导出/编辑/管理,官方明说用途:"building **review workflows, correcting bad memories, or seeding stores** before any session begins"。

### 2d. claude.ai 记忆的用户控制面板[已实现,官方支持文档]
- Settings > Memory 三开关:**Generate memory from chats**(生成记忆)、**Search and reference chats**(RAG 检索历史)、**Include sensitive topics in memory**(敏感话题 opt-in)。
- **敏感话题默认不存**(健康、种族、宗教、政治、性别认同等);Claude 首次因此拒存时会弹一次性提示,可就地开启;关闭该开关会**连带删除已存的敏感条目**。
- **Topics 视图**:Settings > Memory 下列出全部记忆 topic,逐条读/编辑(铅笔图标)/删除;"**Fix something in one topic and the change applies to every conversation from then on**"(编辑即时生效)。也可在聊天里自然语言增删改。
- **Past chat citations**:检索历史时显示引用源,并可直接**删除对应会话**。
- **Incognito chats**(幽灵图标):不进历史、不进记忆。
- **Project memory**:每个项目独立记忆空间+独立 project summary,与非项目聊天隔离。
- **组织级控制**(Team/Enterprise):管理员开关默认关;组织级关闭会**立即删除全员记忆**;HIPAA/公共部门/定制保留协议组织不可用;管理员**不能**查看/编辑个人记忆。
- 记忆遵循既有聊天数据保留政策(与会话同生命周期)。

### 亮点
topic 粒度增量写入(替代日批摘要);敏感话题"默认不存+一次性 opt-in+关闭即清除"的三段式;记忆-会话删除联动;API 记忆库"文件形态+可审计编辑"。

### 局限
legacy 24h 摘要曾因"会话需过夜才生效"被抱怨;无容量视图;企业默认全关说明隐私顾虑重。

---

## 3. Companion 类

### 3a. Character.ai
**来源:** 官方博客《Smarter Memory for Smarter Chats》(blog.character.ai/memory,2026-05-21,已读全文);官方支持文档 Pinned Memories(support.character.ai,每 chat 固定 5 条 pin);Community Update 2025-04/05(Chat Memories 全员 rollout)[已实现]。

- **统一 Memory 屏**:聊天头笔记本图标进入,三大功能集中呈现[已实现]。
- **Story Memory**(全员):用户主动写入的背景/关键事件/"定格时刻";**长按任意消息 → Pin** 即"原文原样"锁入 Story Memory("Confessions, plot twists…preserved exactly as it landed")。c.ai+ 双倍 pin 数、更大容量、更好管理工具。
- **Facts**(c.ai+ 付费功能):自动抽取的实体事实,分 **Persona / 当前 Character / 配角** 三个 tab;可手动 Add a Fact、编辑自动条目、**禁用**、删除不想要的配角。
- **跨会话迁移**:新开 chat 时可选 "**copy Facts to new chat memory**" 或 "start fresh(干净开始)"——记忆带入/重置做成显式二选一。
- **Memory Usage 可视化**:条形/分区显示当前 chat 记忆被 **Facts / Story Memories / message history** 各占多少,**快满时预警**;免费版有简化条,完整可视化是 c.ai+ 功能。
- **自动整理 + 用户保护区**:"As your chats stretch on, Memory tidies older context in the background and keeps what matters…**Anything you've written into Story Memory or pinned yourself is protected. It stays put no matter how full the bar gets**."(自动淘汰永不触碰用户手写/置顶内容)
- 历史:Pinned Memories 早期为每 chat 5 条置顶消息[已实现,官方支持文档];2025-04/05 向全员推出可编辑的 Chat Memories 自由文本框(容量有限,编辑/删除旧条目腾空间)[已实现]。
- 容量分层:免费版受限,c.ai+ 双倍 pin/更大 Memory[已实现]。

### 3b. Replika
**来源:** 官方帮助中心《What does my Replika remember about me?》(help.replika.com,已读全文);社区分析(r/replika)[社区]。

- **三类记忆 + 一个日记**(官方表格)[已实现]:
  | 类型 | 内容 | 存放 |
  |---|---|---|
  | Facts | 你告诉它的事实 + 资料填写(姓名/性别/生日/关系状态) | Memory tab & profile |
  | Events | 你分享的事件及你的感受 | Memory tab(Events 区) |
  | Chat history | 完整对话记录 | Chat |
  | Diary | **Replika 自己视角**对你俩对话的想法(第一人称) | Diary tab |
- **管理路径**:主屏 → 点 Replika 名字 → Memory → 滚动浏览 → 点单条**读全文或 Remove**;Memory 屏 ⚙️ → **Delete All Memories**;清聊天历史是**独立操作**(与删记忆分离)。
- **隐私默认**:只记住你明确分享的内容;记忆仅自己可见、不用于训练[已实现,官方声明]。
- **局限**[社区]:只有被写进字段的事实才可靠召回,对话里顺带提的常"忘记";记忆量与 Replika 等级挂钩;删除关联记忆会影响相关细节召回(用户被告诫别乱删)。

---

## 4. 商业 API 记忆服务

### 4a. Mem0 Cloud
**来源:** mem0.ai/pricing(已读全文,2026-09 版)。

- **定价与配额**[已实现]:
  | 套餐 | 价格 | add/月 | retrieval/月 | 项目 |
  |---|---|---|---|---|
  | Hobby | 免费 | 10,000 | 1,000 | 1 |
  | Starter | $19/月 | 50,000 | 5,000 | 1 |
  | Pro | $249/月 | 500,000 | 50,000 | 无限(多项目支持、私有 Slack、高级分析、**Graph memory(实体链接)**、**Dream(Memory Consolidation)**) |
  | Enterprise | 定制 | 无限 | 无限 | +SLA、on-prem、审计日志、SSO、定制集成 |
  - 终端用户数全档无限。合规:HIPAA Ready、SOC 2 Type I、GDPR Ready。支持 usage-based 议价。
- **能力要点**:add/search/get/update/delete/history REST API;Graph Memory 与 **Dream(记忆固化/整理)** 是 Pro 档卖点——"会话结束固化+图实体链接"被做成了付费墙分层。周边产品:OpenMemory(本地)、Gateway、CLI、**MCP 集成**。
- 学术:Mem0 有 LoCoMo 基准论文(arXiv 2504.19413)自证优于基线[论文,自报指标]。开源版(GitHub 62.5k star)与 Cloud 功能分层明确。
- **局限**(对本调研):平台主打开发者 API,无终端用户可见的记忆管理 UI 叙事;检索按次计费,透明度设计面向开发者而非最终用户。

### 4b. Zep Cloud
**来源:** getzep.com/pricing(已读全文);help.getzep.com《Context Construction》(已读全文)。

- **模型**:基于 Graphiti 时序知识图谱的 **Context Graph**——从对话自动抽取带**时间有效性**的 facts(双时态建模:事件时间 vs 摄入时间),实体+关系边,可配自定义实体/边类型;API 返回拼装好的 **Context Block** 直接进 prompt。
- **记忆引用**[已实现,文档]:上下文块内每条事实携带**来源对话引用(memory citations)**,展示检索到的事实来自哪段历史。
- **定价**[已实现]:
  | 套餐 | 价格 | credits/月 | 项目 | MCP seats | 备注 |
  |---|---|---|---|---|---|
  | Free | 0 | 10,000 | 2 | 1 | 变速限流、低优先级、无滚存 |
  | Flex | $125/月 | 50,000(超额 $25/10K,20% 自动充值,30 天滚存) | 5 | 5 | 600 RPM、1 天 API 日志 |
  | Flex Plus | $375/月 | 200,000 | 10 | 15 | +**Observations、自定义抽取指令、Webhooks、Analytics** |
  | Enterprise | 定制 | 议价 | 无限 | 定制 | SOC 2 Type II、HIPAA BAA、1 年审计/API 日志、DPA、BYOK/BYOC |
  - **计费单位 Episode**(≤350 字节=1 credit,超出按 350B 递增);**检索/存储/threads/用户/图存储一律 0 credit**——只对写入计费,读免费无限。
  - 值得注意:**Memory MCP Server seats 单独卖**——记忆以 MCP 服务形态交付并按席位收费。
- 学术:arXiv 2501.13956《Zep: A Temporal Knowledge Graph Architecture for Agent Memory》,自报在 LoCoMo 上优于 MemGPT 且延迟大幅降低[论文,自报指标]。
- **局限**:重栈(图数据库+LLM 抽取管线),成本随写入量线性;用户可见性设计同样面向开发者。

---

## 关键横向趋势(供判断)

1. **"为什么想起这条"已成标配**:ChatGPT Sources、Claude past chat citations、Zep memory citations——三家头部都以"引用来源+就地删除/反馈"解决记忆透明度。
2. **显式记忆与自动记忆双轨**普遍:用户主动 pin/write 的内容 + 系统自动抽取的条目分层,且**自动淘汰只碰自动层,用户手写层受保护**(Character.ai 明文)。
3. **文件型记忆被官方背书**:Anthropic memory tool 就是"Markdown 文件目录 + 命令式工具 + 系统提示词协议 + 访问时间淘汰",dsh-auto-memory 的路线与之一致,且 dsh 多出类型化/审批/引用计数。
4. **会话生命周期联动**(Claude 2026.9):记忆条目应能溯源到产生它的会话,并随会话删除而更新。
5. **容量可视化 + 满载预警**(Character.ai Memory Usage)是唯一直面"容量上限提示"的产品,按类型分区展示占用。
6. **隐私档位化**:incognito/temporary chat(会话级免记忆)、敏感话题 opt-in(类别级)、组织级总闸(关即删全员)构成三级隐私梯度。

## 横向对比

| 维度 | ChatGPT Memory | Claude.ai(记忆) | Claude API memory tool | Character.ai | Replika | Mem0 Cloud | Zep Cloud |
|---|---|---|---|---|---|---|---|
| **记忆模型** | saved memories(离散条目)+ chat history 引用(不落库检索)+ Improved Memory 持续摘要 | topic 粒度条目,边聊边存;Project 独立记忆空间 | /memories 文件目录,模型自由读写 6 命令 | Facts(自动抽取)+ Story Memory(手写/Pin)+ 消息历史 | Facts + Events + Chat history + Diary(AI 视角) | 向量+LLM 抽取的事实条目,+Graph(实体链接,Pro 档) | 时序知识图谱(facts 带双时态有效期,Context Graph) |
| **写入方式** | 显式"记住这个"+自动保存 | 自动边聊边存 + 聊天内自然语言指令 | 模型自主决定落盘(MEMORY PROTOCOL 注入) | Facts 自动;Story Memory 手写+长按 Pin | 用户陈述/资料填写,系统存字段 | API add(),应用显式调用 | API 发送 Episode,自动抽取 |
| **用户可见性/透明度** | Sources 区列出影响回答的记忆/会话/文件/邮件,可标 relevant/not relevant | Past chat citations 引用源+可删会话;Topics 列表 | (开发者侧)文件可直接查看 | Memory 屏集中呈现,Facts 按 Persona/角色/配角分 tab | Memory tab 滚动列表,点开读全文 | Dashboard/History(开发者向) | 每条事实携带来源引用(面向开发者) |
| **编辑权** | 列表编辑/删除单条/全部清除;摘要上划选修正;版本历史(部分档) | Topics 逐条编辑/删除,改一处全会话生效;聊天内改 | 文件任意改(API/直接编辑) | Facts 可编辑/禁用/删配角;Story Memory 可增删 | 单条 Remove;Delete All Memories | API update/delete/history | API 全 CRUD |
| **"别提这个"软控制** | Don't mention this again(降权不删源) | 告诉 Claude 忘记/别用(行为层) | 无(文件即真相) | 无(禁用 Fact 近似) | 无 | 无 | 无 |
| **容量上限提示** | 无官方数字,"memory full" 满载态[社区] | 未披露 | 文件大小自管(官方建议分页+限制) | Memory Usage 分区条形图(Facts/Story/历史)+快满预警,免费简化/付费完整 | 容量有限,删旧腾新 | 按请求量计费(10K add/月起) | Episode 字数计费(检索存储免费) |
| **自动整理 vs 用户保护区** | Improved memory 自动更新摘要 | 自动存 topic | 防膨胀指令(勿乱建文件,及时删旧) | **自动 tidy 旧上下文,Pin/手写内容受保护不动** | 无自动淘汰(字段制) | Dream 固化(Pro 档) | 图自动失效旧事实(时态) |
| **淘汰机制** | 无披露 | 会话删除/过期→相关记忆联动更新 | 官方建议:按**最后访问时间**清理 | 引用计数近似:pin 数上限(免费 5 条/chat) | 无 | 高级版固化整理 | 时间有效性自动过期 |
| **隐私/免记忆模式** | Temporary chat(可选带入记忆);关 chat history 引用 30 天删派生 | Incognito chat;敏感话题默认不存+一次性 opt-in,关闭即删;组织级关即删全员 | 客户端自管,敏感过滤建议 | 无特别模式 | 只记明确分享内容;不用于训练 | HIPAA/SOC2/GDPR;on-prem(企业) | SOC2 II/HIPAA BAA/BYOC;DPA |
| **跨会话/跨端记忆迁移** | 无(数据源内部打通) | 导入导出(实验性);chat↔Cowork 账户级共享 | 文件天然可拷贝 | 新 chat 可选 copy Facts / start fresh | 无 | OpenMemory 本地版 | MCP Server 分发 |
| **收费墙位置** | 版本历史等高级管理 | 免费+付费档均有 | API 计费 | Facts/完整容量视图/pin 加倍=c.ai+ | 记忆量随等级/订阅 | Graph+Dream=$249 起 | Observations/Webhooks/Analytics=$375 起 |
| **产品形态对 P2 最可抄的点** | Sources 徽章+relevant 反馈+划选修正 | Topics 列表"改一处即生效"+citations | 文件+协议+访问时间淘汰(路线印证) | Memory Usage 容量条+Pin 保护区+copy-to-new-chat | 单条点开即删,Delete All 独立入口 | 固化(Dream)分层 | 引用随事实返回 |

## 对本项目的启示

# 对 dsh-auto-memory 的可借鉴点与差异化判断

## 总判断

**路线被官方背书,无需转向。** Anthropic memory tool(memory_20250818)就是"Markdown/文本文件目录 + 命令式工具 + 系统提示词注入协议 + 建议按最后访问时间清理"——与 dsh 的"MEMORY.md 索引注入 + 六工具 + 引用计数 + staleAfterDays"同构,且 dsh 在结构化(四类型)、治理(审批批量删)上更严。Anthropic 2026 年托管记忆库还把"文件形态、可导出、可审计编辑(review workflows / correcting bad memories / seeding stores)"当卖点。不引入数据库/向量库是对的:重方案(Mem0 Graph、Zep 时序图)卖的是规模化多租户的抽取与检索,单用户单机纯文件场景下其核心收益(检索召回、实体消歧)用"索引注入+[[name]] 链接"已能覆盖 80%。

## P2 Web UI 记忆管理卡片:可直接照抄的交互(按优先级)

1. **容量分区条(Memory Usage,抄 Character.ai)**:卡片顶部一条分区条,按四类型显示记忆条数/估算 token 占用(索引 token 成本本来就可算);超过注入预算阈值(如索引 N 条上限的 80%)显示预警。这是唯一直面"容量上限提示"的先例,且 Character.ai 把完整版做成了付费功能——说明它有感知价值。纯文件方案实现成本极低(遍历文件统计)。
2. **"本次注入了哪些"徽章(抄 ChatGPT Sources / Claude citations)**:dsh 每次会话注入 MEMORY.md 索引(以及被展开的 [[name]] 条目)时,把清单记到会话元数据;Web UI 卡片显示"最近一次会话注入了这 12 条",点击跳到对应文件。这回答了"为什么想起这条",是三家头部公认标配,dsh 当前完全缺失,且 dsh 的注入机制是确定性的(非 RAG),比 ChatGPT 更容易做精确溯源。
3. **Pin/保护区标记(抄 Character.ai "It stays put no matter how full the bar gets")**:给记忆文件加 `pinned: true` frontmatter(或约定类型);软淘汰(staleAfterDays+引用计数)**永不淘汰 pinned 条目**,Web UI 用盾牌/图钉标记受保护项。官方最佳实践(Anthropic"按访问时间清理")+ Character.ai(自动整理不碰用户手写)双重印证:dsh 的软淘汰需要一个用户显式锚点,否则用户会因"重要记忆被淘汰"失去信任。
4. **列表逐条"改一处即生效"(抄 Claude Topics)**:Web UI 编辑记忆文件后立即写回并重建索引,UI 上明示"下一次会话立即生效"(Claude 原话 "the change applies to every conversation from then on")。dsh 纯文件天然支持,只需把这句话写进交互文案。
5. **单条点开即删 + Delete All 独立入口 + 范围预告(抄 Replika + Claude 组织级)**:列表项点开显示全文 + Remove 按钮;delete_all 放二级确认并预告影响("将删除 N 个文件,M 条索引项")——对应 Claude 组织级"关闭即删全员"的事前明示。dsh 已有人工审批批量删,审批界面直接展示这个预告即可。
6. **"Don't mention this again"第三档(抄 ChatGPT)**:在删除与保留之间加一档"停用"(文件保留、索引摘除、不再注入)。dsh 实现为 frontmatter `disabled: true` 或移动到 archive 子目录;Web UI 一个开关。成本极低,补齐控制梯度。
7. **"带入哪些记忆开新会话"(抄 Character.ai copy Facts to new chat / start fresh)**:如果 dsh 未来支持多项目/多记忆库,新建时给二选一;单库场景下可弱化为"导出选中记忆为独立 Markdown 包"。
8. **来源会话溯源(抄 Claude 2026.9 记忆-会话联动)**:memory_write 时在 frontmatter 记 `source_session`;会话转录删除时提示"有 N 条记忆来自该会话,是否一并删除"。纯文件加一行元数据即可,先记不做也行(为未来留钩子)。

## 值得吸收但不照抄的(重方案能力 → 轻量等价物)

- **Zep 的"引用随事实返回"(memory citations)** → dsh 等价物就是 [[name]] 展开时的来源标注 + 上述注入清单;不需要图数据库。
- **Mem0 的 Dream(记忆固化,Pro 档卖点)** → dsh 的会话结束 LLM 自动固化已同思路;可补的是 Character.ai 式"固化后的整理(合并重复/更新过期)"一步,在软淘汰扫描时顺带做(纯 LLM 调用,无新依赖)。
- **Mem0/Zep 的 history/audit(记忆变更历史)** → 轻量等价:每次写记忆前把旧版存为 `.bak` 或依赖 git;Web UI 提供"查看此条历史版本"(ChatGPT 部分档已有版本历史,证明这是可感知价值)。
- **时间有效性(Zep 双时态)** → frontmatter 记 `created/updated/lastAccessed`,过时事实不删而是 `supersededBy: [[新条目]]` 链接——用 [[name]] 机制模拟时序图谱的"新旧行"语义。

## 差异化(dsh 已有而调研对象普遍没有的)

- **引用计数**:所有调研对象都没有把"被使用次数"作为淘汰信号(Anthropic 只建议"最后访问时间");dsh 可在 UI 显示每条记忆的命中次数,让淘汰决策可见、可解释。
- **人工审批批量删**:无一家有"批量删需审批"的中间态(它们要么逐条删要么 Reset all);这是 dsh 面向开发者/信任敏感用户的独特治理点,应在 Web UI 突出(审批队列视图)。
- **[[name]] 链接展开**:最接近的是 Mem0 Graph 的实体链接,但那是数据库功能;纯文件实现链接展开是独有卖点。
- **纯文件=零迁移成本**:Claude 2026 年才把"记忆可导出/导入"当实验性功能推,dsh 的记忆库就是一个文件夹,导出=复制目录。Web UI 上放一个"导出为 zip/文件夹"按钮即可宣称同等能力。

## 一句话优先级建议

P2 卡片第一版做四件:类型分区容量条 + 注入清单徽章 + 逐条编辑/停用/删除(即时生效文案)+ pinned 保护标记;审批批量删和引用计数是现成差异化,在 UI 里给它们一等公民位置;导出按钮收尾。

---

# 评测方法与基准

## 调研发现

# 记忆系统评测方法与基准调研(供 dsh-auto-memory 设计 evals/ 用)

> 标注约定:【实测】= 论文/仓库中有可复现数字;【宣称】= 厂商自报、有争议;【审计】= 第三方质疑性结论。所有数字均给出来源。

## 1. LoCoMo 基准(ACL 2024, arXiv 2402.17753)

**结构**【实测,来源:[论文](https://arxiv.org/abs/2402.17753) + [snap-research/locomo 仓库](https://github.com/snap-research/locomo)】
- 发布集为 **locomo10**:10 段超长双人对话(从原始 50 段中挑选最长、标注质量最高的;原始全集平均 300 turns / 9K tokens / 最多 35 sessions,发布后的 10 段明显更长——Mem0 论文按发布集统计为约 600 条对话 / 约 26K tokens / 每段)。
- 三类任务:**QA**(每段平均约 200 题,含 question/answer/category/evidence 对话 id)、**事件摘要**(逐 session 逐说话人标注 `events_session_<n>` 金标)、多模态对话生成。后续各家评测几乎只做 QA。
- QA 五类别:single-hop / multi-hop / temporal / open-domain / **adversarial**(无金标答案,考"识别不可回答";Mem0、dsh-memory 等均剔除 category 5)。
- 指标:原论文用词面 F1 等自动指标 + 人工评估;后来的系统(Mem0 等)改用 **LLM-as-a-Judge** 为主。

**各家引用的成绩**(全部为厂商/团队自报,【宣称】):

| 系统 | LoCoMo 总分 | 来源 |
|---|---|---|
| Full-context (GPT-4o-mini, 26K tokens 全塞) | J=72.90 | Mem0 论文 Table 2 |
| **Mem0** | J=66.88 / Mem0g=68.44 | Mem0 论文 |
| Zep | J=65.99(Mem0 跑的);Zep 博客自纠为 ~75.14%→84%;Mem0 再反驳 58.44% | 三方互撕,见 §3 |
| Letta Filesystem(纯文件+grep/search/open/close 工具,GPT-4o-mini) | **74.0%** | [Letta 博客](https://www.letta.com/blog/benchmarking-ai-agent-memory) |
| dsh-memory(本生态竞品,dsh+Markdown 记忆) | 73.05%(+Consolidate 77.60%) | [hr98w/dsh-memory](https://github.com/hr98w/dsh-memory) |
| A-Mem / LangMem / OpenAI memory | J=48.38 / 58.10 / 52.90 | Mem0 论文 |

**关键事实:文件系统工具打平/超过了所有专用记忆系统**(Letta 74.0% > full-context 72.9% > Mem0g 68.44%)。Letta 的结论:agent 会用文件工具(在训练数据里见过)比会用专用记忆 API 更重要;agent 能自己改写查询、迭代搜索。这对"纯文件+工具召回"路线是极强的正名。

**LoCoMo 的可信度问题**【审计】:
- AgentOS 审计称 **64% 的答案金标有错、LLM judge 会放行高达 63% 的故意错误答案**([agentos.sh](https://agentos.sh/blog/agentos-memory-sota-longmemeval),宣称口径)。
- Letta 指出 Mem0 论文的 MemGPT 数字无法由 MemGPT 原班团队复现(无回填代码)。
- 结论:LoCoMo 分数受 judge prompt / 模型 / 提问改写影响极大,同系统分差可达 ±20 点。**可用来做自证回归(自己 vs 自己的 ablation),不适合打榜横比。**

## 2. LongMemEval(ICLR 2025, arXiv 2410.10813)

【实测,[官方仓库](https://github.com/xiaowu0162/LongMemEval) 已通读】
- 500 道人工精编问题,**五能力轴**:信息抽取、跨会话推理、时间推理、知识更新、**拒答(abstention,题号带 `_abs` 后缀)**。数据类型上分 6 种 `question_type`:`single-session-user` / `single-session-assistant` / `single-session-preference` / `multi-session` / `temporal-reasoning` / `knowledge-update`。
- **三个规模变体**:`_s`(约 115K tokens / 约 40 sessions,80 个 filler)、`_m`(约 500 sessions / ~1.5M tokens)、`oracle`(只含证据 session,用于测回答模型上限)。2025/09 发布 cleaned 版修正了干扰 session 污染答案的问题。
- **对检索评测最宝贵的设计**:每个 haystack turn 带 `has_answer: true` 标注、每题带 `answer_session_ids`——官方直接支持 **turn 级与 session 级召回准确率**评测(不需要 LLM judge 就能测检索层)。评测协议:喂时间戳历史 → 你的系统在线记忆 → 答题 → 官方 `evaluate_qa.py`(按题型使用不同 GPT-4o judge prompt,与人工评估高相关)。
- 核心发现:商业记忆助手与长上下文 LLM 在持续交互上**准确率下降约 30%**;提出记忆设计三阶段(索引/检索/阅读)+ 三个优化(session 分解、fact 增广 key、时间感知查询扩展)。
- Zep 论文在 LongMemEval_S 上的对照【实测,[Zep 论文](https://arxiv.org/abs/2501.13956)】:full-context GPT-4o-mini 55.4%(31.3s,115K tokens)vs Zep 63.8%(3.20s,**1.6K tokens**);GPT-4o 60.2%→71.2%。注意 Zep 在 `single-session-assistant` 类反而下降 9-18%(检索式记忆对"助手自己说过的话"最弱——注入式索引的通病)。
- **LongMemEval-V2**(2026/05,[仓库](https://github.com/xiaowu0162/LongMemEval-V2)):451 题、web-agent 轨迹 haystack(最大 115M tokens)、五能力改为静态状态回忆/动态状态跟踪/工作流知识/环境坑/前提意识;`memory_modules/` 接口把**记忆系统当作可插拔模块**评测(含 `codex` vanilla 编码 agent 记忆基线),指标=答案准确率+查询延迟(LAFS)。这是"工具型/agent 语境记忆评测"的最新学术形态,证明该方向已不是空白,但**尚未有面向 CLI harness 插件的开源轻量实现**。

## 3. Mem0 论文评测协议(arXiv 2504.19413)【实测,全文已读】

- **架构**:两阶段(抽取→更新),逐消息对 (m_{t-1}, m_t) 处理;上下文=异步会话摘要+最近 m=10 条消息;更新阶段取 top s=10 相似记忆,LLM 经 tool-call 从 **ADD/UPDATE/DELETE/NOOP** 四操作中决策(UPDATE 要求新事实信息量更大才替换);全链 GPT-4o-mini + 向量库;Mem0g=实体-关系图(Neo4j)。
- **评测协议**:LOCOMO 10 段(剔除 adversarial);指标 F1/BLEU-1/**LLM-as-a-Judge(J)**,J **跑 10 次报均值±1σ**;部署指标:检索注入 token(cl100k_base 计)、检索延迟与总延迟(p50/p95)。
- **结果**(Table 2):Overall J——full-context 72.90 > Mem0g 68.44 > **Mem0 66.88** > Zep 65.99 > 最佳 RAG(k=2, chunk 256)60.97 > LangMem 58.10 > OpenAI 52.90 > A-Mem 48.38。分类:open-domain Zep 最佳(J 76.60);temporal Mem0g 最佳(J 58.13);multi-hop Mem0 F1 28.64 / J 51.15;single-hop Mem0 J 67.13。**注意:全上下文准确率最高,记忆赢在成本**——Mem0 注入 1764 tokens vs full-context 26031,p95 延迟 1.44s vs 17.12s(-91%),token 省 >90%。
- 记忆库体积:Mem0 ~7K tokens/会话,Mem0g ~14K,Zep 图 **>600K tokens**(Mem0 的攻击点)。
- **诚实要点**:论文自己承认 full-context J 更高;这为"记忆=成本-质量权衡"而非"记忆=更准"的叙事提供依据。
- **Mem0×Zep 争议**【宣称】:Mem0 论文评 Zep J=65.99;Zep 博客反驳自己重测 75.14%(后称 84%);Mem0 发文"Revisiting Zep's 84%: 58.44%"。同一系统 58↔84 点摆动,是"vendor 跑 vendor 基准不可信"的标准案例。另:Zep 论文本身用的是 DMR(MemGPT 的 500 会话单题集)+LongMemEval_S,**并没有**在论文里跑 LoCoMo;DMR 上 Zep 94.8% vs full-context 94.4%,几乎无差——Zep 自己也承认该基准太弱。

## 4. 经典打分公式(可直接借给文件型插件)

**MemoryBank(AAAI 2024, arXiv 2305.10250)**【实测,全文已读】
- 遗忘:**R = e^(−t/S)**,S(记忆强度)离散化、首次提及初始化为 1;**每次被召回 S+1、t 清零**(越用越不忘)。检索=DPR 式双塔稠密检索+FAISS。
- **评测方法论是最直接的先例**:ChatGPT 扮演 15 个虚拟人格用户 × 10 天合成对话(每天≥2 话题)→ 人工写 **194 道探针问题**(中英各 97)→ 打分四指标:**记忆检索准确率(0/1)、回答正确性(0/0.5/1)、上下文连贯性(0/0.5/1)、并列排名 s=1/r**。结果如 SiliconFriend-ChatGPT 英文检索准确率 0.763/正确性 0.716。
- 这就是"合成多会话脚本+探针问题+分层打分"模板,我们只需把人工打分换成 LLM judge 并加校准。

**Generative Agents(UIST 2023, arXiv 2304.03442)**【实测,原文公式】
- 检索分 = α_recency·recency + α_importance·importance + α_relevance·relevance,**三个 α 全为 1**;
- recency = **0.995^(距上次检索的小时数)**;importance = 记忆创建时 LLM 打 **1-10 整数**("打扫房间"=2,"约暗恋对象"=8);relevance = 记忆与查询 embedding 的**余弦相似度**;三者 min-max 归一到 [0,1] 后相加。
- 评测:25 agent × 5 能力(自我认知/记忆/计划/反应/反思)× 5 题访谈,100 名人类评估者排序,TrueSkill 计分;完整架构 μ=29.89 vs 无记忆 μ=21.21(d=8.16)。错误模式分析值得抄:检索失败、记忆片段不完整、embellishment 式幻觉。
- 对无 embedding 的 dsh-auto-memory:recency/importance 可零成本平替(相对时间衰减 + LLM 写入时顺手打分),relevance 用 BM25/关键词重合替代——**三因子框架照搬,实现换轻量版**。

## 5. 工具型记忆评测的先例地图(回答"是否空白")

| 先例 | 形态 | 与我们的关系 |
|---|---|---|
| **Letta Filesystem on LoCoMo**(2025.08 博客) | 真实 agent + grep/search_files 工具自主检索 | 直接同类:文件+工具召回打赢专用记忆系统;其 tool-rule 约束(先 search 后 answer)是可抄的评测护栏 |
| **Letta Leaderboard / Memory Benchmark**(2025.05) | 固定 Letta 框架,评各模型的记忆**读/写/更新**工具调用能力,动态生成交互 | "评模型用记忆工具的能力"这一维度已有人做 |
| **Letta Context-Bench / Letta Evals**(2025.10) | 开源评测框架:文件操作链、实体关系追踪、多步检索 | 证明了"文件操作即记忆评测"成立 |
| **LongMemEval-V2**(2026.05) | memory_modules 可插拔接口 + codex 基线 + 延迟准确率双指标 | 学术界已进入 agent 语境记忆评测 |
| **OpenViking Claude Code LoCoMo benchmark**(volcengine) | 4 条路径评**原生 Claude Code auto-memory**(Prompted 模式=每 session 一次 `claude -p` 自主写 MEMORY.md,QA 新会话只见记忆不见原文) | **我们机制的最接近公开评测**;其"三边界"(形成期看不到问题/QA 看不到原文/同 sample 题共享冻结记忆快照)应原样照抄 |
| **hr98w/dsh-memory benchmark/locomo**(本生态,26★) | 仿 OpenViking:baseline/memory/memory-consolidate 三模式,独立 DSH_HOME、QA guard 只读、judge CORRECT/WRONG、分阶段 token/耗时、canonical 结果入库+交互式 HTML 报告;结果 2.60/73.05/77.60(单次,未平均) | **"社区没人做过 dsh 插件评测"不成立**——已有直接先例;但其评测只有端到端准确率,且其调研文档自认缺"Workspace 原生数据集" |

**结论**:工具型记忆注入的评测**学术上不空白**(LongMemEval-V2、Letta 系、OpenViking 已铺路),**dsh 生态内也已破冰**(dsh-memory)。真正的空白是:**(a) 面向 coding-agent 会话的合成记忆评测数据集**;**(b) 注入成本/误召回/固化精度等多维指标**;**(c) judge 校准审计**。dsh-memory 只做了端到端准确率一项。


## 横向对比

| 基准/系统 | 任务结构 | 指标 | 技术路线 | 关键数字(口径) | 规模 | 对文件型插件可借鉴点 | 局限/争议 |
|---|---|---|---|---|---|---|---|
| **LoCoMo**(ACL 2024) | 双人超长对话 QA(5 类,含 adversarial)+事件摘要+多模态生成 | 词面 F1/BLEU + 人工;后人用 LLM-Judge | 纯数据集 | 10 段对话、每段约 200 题(cat.1-4 共约 1540) | ~26K tokens/段,最多 35 sessions | evidence 对话 id 支持检索级评测 | 金标错漏多(AgentOS 称 64% 有错,judge 放行 63% 故意错答);双人闲聊≠agent 会话;同系统分差 ±20 点不可横比 |
| **LongMemEval**(ICLR 2025) | 用户-助手历史+500 题/5 能力/6 题型,含拒答 | 按题型分 prompt 的 LLM-judge;**turn 级 has_answer + session 级 answer_session_ids 支持免 judge 召回率** | 数据集+官方 evaluate_qa.py | 商业助手/长上下文模型掉 30% | S=115K tok / M~1.5M tok / oracle | **检索层金标标注法**;abstention 题;attribute 控制+filler 拼装管线 | 聊天助手语境,非工具型;无延迟指标 |
| **Mem0**(arXiv 2504.19413) | 两阶段抽取+更新,ADD/UPDATE/DELETE/NOOP tool-call;GPT-4o-mini+向量库;Mem0g 加图 | J 跑 10 次报均值±σ;注入 token;p50/p95 延迟;记忆库体积 | 向量库(+Neo4j) | J=66.88/68.44;注入 1764 tok vs full 26031;p95 -91%;库 7K/14K tok/会话 | LOCOMO-10 | **四操作更新协议;部署指标三件套(token/延迟/体积);J 多次取均值** | full-context 72.90 反而最高(自己承认);与 Zep 互撕(58↔84 摆动) |
| **Zep/Graphiti**(arXiv 2501.13956) | 双时间线知识图+社区摘要+混合检索(cos/BM25/BFS)+重排 | LLM-judge;延迟;上下文 token | Neo4j 图 | DMR 94.8%(≈full 94.4%);LME_S 63.8-71.2% @1.6K tok、2.6-3.2s vs full 55.4-60.2% @115K、~30s | LME_S 500 题 | 混合检索思想;题型细分报表 | 图>600K tok(Mem0 实测);LoCoMo 数字只在博客不在论文;single-session-assistant 类倒退 9-18% |
| **Letta Filesystem**(博客 2025.08) | 记忆=原始对话文件;agent 用 grep/search_files/open/close 自主迭代检索;tool-rule 先搜后答 | LLM-judge 准确率 | **纯文件+OS 工具** | **74.0%**(GPT-4o-mini)>Mem0g 68.44、≈full-context 72.9 | LOCOMO-10 | 直接同类路线正名;tool-rule 评测护栏;"简单工具在训练分布内"论点 | 单次博客数字;依赖模型工具调用能力 |
| **MemoryBank**(AAAI 2024) | DPR 检索+遗忘;**R=e^(−t/S),召回 S+1、t 归零** | 人工四指标:检索准确率(0/1)/正确性(0/.5/1)/连贯性(0/.5/1)/排名 1/r | FAISS 向量 | 检索准确率 0.71-0.86(三变体双语) | 15 虚拟用户×10 天+194 探针题 | **合成多会话+探针问题模板**;强度-衰减公式(=引用计数软淘汰的理论依据) | 人工打分贵;无拒答/更新测试 |
| **Generative Agents**(UIST 2023) | memory stream+反思;检索=**0.995^h 衰减+LLM 1-10 重要度+余弦相关度,min-max 后等权和** | 人类排序+TrueSkill;5 能力×5 题访谈 | 无库,自然语言流+embedding | 完整架构 μ=29.89 vs 无记忆 21.21(d=8.16) | 25 agents×2 游戏日 | **三因子检索框架**(可换轻量实现);错误模式分类(漏检/片段/脑补) | 仿真语境;单次运行数千美元 |
| **Letta Leaderboard/Context-Bench** | 固定框架评模型**读/写/更新**记忆工具调用;文件操作链/实体追踪/多步检索 | 任务通过率 | Letta 框架 | 各模型公开排名 | 动态生成 | "评模型会不会用记忆工具"是独立于检索质量的维度 | 绑定 Letta 框架 |
| **LongMemEval-V2**(2026.05) | web-agent 轨迹 haystack+451 题/5 agent 能力;memory_modules 可插拔(含 codex 基线) | 答案准确率+**查询延迟(LAFS)** | 模块化接口 | 公开 leaderboard(small/medium) | 最大 115M tokens | "记忆模块=黑盒接口"抽象;延迟计分先例 | 重基建(vLLM/截图包),轻量插件无法直接跑 |
| **OpenViking CC-LoCoMo** | 评**原生 Claude Code auto-memory**:每 session 一次 `claude -p` 自主写 MEMORY.md,QA 新会话只见记忆 | LLM-judge CORRECT/WRONG | 被测物=我们的同类机制 | Prompted/SDK-iso/SDK-noiso/e2e 四路径同管线可比 | LOCOMO-10 | **三边界协议**(形成期盲/QA 无原文/冻结快照共享)应照抄 | 数字用 doubao 模型收集,依赖模型 |
| **hr98w/dsh-memory benchmark** | dsh 同赛道:baseline/memory/+consolidate 三模式,独立 DSH_HOME,QA guard 只读 | Judge Accuracy(主)+分类准确率+token F1+**分阶段 token/耗时**;canonical 结果+HTML 报告 | Markdown+索引注入(与我们同) | **2.60 / 73.05 / 77.60**(单次、未平均) | LOCOMO-10 | 全套工程化范本(沙箱隔离/可复现命令/结果入库);benchmark/ 目录组织 | 只有端到端准确率;无注入成本/误召回/固化精度;无原生数据集(其文档自认) |
| **dsh-auto-memory(本项目)** | MEMORY.md 索引注入+六工具+会话结束 LLM 固化+软淘汰(staleAfterDays+引用计数)+[[链接]]展开+审批批量删 | 尚无评测(tests/ 仅 vitest 单测:store/prompt/consolidate/integration) | 纯文件,零库零 embedding | — | — | 参见 takeaways 的 evals/ 设计 | 缺评测即缺对外可信度与迭代护栏 |

## 对本项目的启示

# 对 dsh-auto-memory 的可借鉴点与 evals/ 落地设计

## 一、必须先修正的预期(三个事实)

1. **"社区没人做过 dsh 插件评测"不成立**。竞品 [hr98w/dsh-memory](https://github.com/hr98w/dsh-memory)(26★)已内置 LoCoMo-10 三模式评测(2.60/73.05/77.60),且工程化程度很高(独立 DSH_HOME、QA guard、canonical 结果、HTML 报告);上游还有 [OpenViking 把原生 Claude Code auto-memory 在 LoCoMo 上评过](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo/claudecode)。**再复刻一个 LoCoMo 准确率数字没有贡献价值,且 LoCoMo 金标/judge 争议(AgentOS 称 64% 金标有错)使绝对数字不可比、不可打榜。**
2. **文件+工具召回路线已被正名**:Letta Filesystem 用 4 个 OS 文件工具在 LoCoMo 拿 74.0%,超过 Mem0g(68.44%)与 full-context(72.9%)。我们不需要为"没有向量库"道歉,评测应证明的是**在成本预算内的召回质量**,不是绝对 SOTA。
3. **学界口径已收敛为"准确率+成本+延迟"三件套**(Mem0: J 分+注入 token+p50/p95;LongMemEval-V2: 准确率+LAFS 延迟分)。dsh-auto-memory 的独特成本结构(索引每会话必注入 + 工具按需读取)恰好是这个框架下最好讲的故事:**索引注入 token 恒定可控 vs 检索式记忆的不可控**。

## 二、evals/ 目录设计(四层,按成本递增)

```
evals/
├── datasets/
│   ├── harness-sessions/          # ★合成多会话脚本(核心差异化资产)
│   │   ├── gen/                    # 一次性生成脚本(LLM 生成后人工校对、commit 为 fixture)
│   │   ├── mini.json               # 3 sessions / ~20 金标事实 / 15 探针题 → CI 冒烟
│   │   └── standard.json           # 15-20 sessions / ~100 金标事实 / 60+ 探针题
│   └── README.md                   # 数据 schema 说明
├── metrics/                       # 纯 TS 计算,无 LLM,可被 L0/L1 复用
├── runners/
│   ├── l0-unit.vitest.ts           # 进现有 vitest,每次 push 跑
│   ├── l1-retrieval.mjs            # 免 LLM-judge 的检索层评测(可 LLM 固化后离线跑)
│   ├── l2-e2e.mjs                  # 端到端(需 DSH + API key)
│   └── l3-consolidation.mjs        # 固化精度(需 API key)
├── judge/                          # LLM judge prompt + 校准集
└── results/                        # canonical 结果快照(照抄 dsh-memory 模式)
```

**数据集构造(harness-sessions,对标 MemoryBank 15 用户×10 天 + LongMemEval 属性控制拼装)**:
- 每条剧本 = 一个虚拟开发者 persona(技术栈/偏好/习惯)+ 跨日期的 N 个 dsh 会话;会话内容对齐四类型记忆:偏好("别用 print 调试,用 logging")/项目事实("PG 在 barcode_pg 容器 15432 端口")/决策("选纯 Markdown 不选 SQLite,为了 git 管理")/教训("npm -g 要管理员终端")。
- 每个事实打三类标签:**durable(应存)/ ephemeral(一次性噪声,如临时报错文本,测"不该存而存")/ updated(后续会话推翻前值,测知识更新)**;每道探针题带 `answer_session_ids` + `expected_memory_type`(直接抄 LongMemEval 的标注法)。
- 题型配比抄五能力轴:单跳事实 / 跨会话组合(multi-hop)/ 时间推理("上次改配置是几周前?")/ 知识更新(答新值不答旧值)/ **拒答(记忆里没有,应说不知道——防索引注入诱发脑补,这是注入式架构最该测而没人测的)**。
- 生成管线:LLM 按 schema 生成 → 自动校验(事实标签唯一、探针题 evidence 存在)→ 人工过一遍 → commit。一次性成本,之后免 API 跑 L1。

**指标(与现有六工具/软淘汰机制一一对应)**:

| 层 | 指标 | 定义 | 跑法 |
|---|---|---|---|
| **L0 确定性**(无 LLM) | 索引注入 token 曲线 | MEMORY.md 在 N=20/50/100/200 条记忆下的 token 数与截断行为;stale 过滤后曲线 | vitest(现有 store/prompt 单测旁加 spec) |
| | 注入信噪比 | 索引中被探针集命中的条目占比 vs 死条目(零命中)占比 | vitest |
| | 软淘汰正确性 | 到期+零引用 → 从索引消失但文件保留;引用过的 → 保留(等价 MemoryBank R=e^(−t/S) 的召回重置语义) | vitest |
| | [[链接]]展开 | 一层展开的 token 上界、坏链接不炸 | vitest |
| **L1 检索层**(固化结果离线跑,免 judge) | 召回命中率 Recall@prompt | 探针题触发 memory_read 后,期望记忆出现在索引或读取结果中的比例(turn/session 级,抄 LongMemEval has_answer 语义) | scripts(固化一次→多题复用冻结快照) |
| | 误召回率 | 单题注入/读回的**无关**记忆 token 占比(ephemeral 噪声被固化、或读了不相关文件) | 同上 |
| | 工具调用效率 | 每题 memory_read 次数、命中所需轮数(Letta:agent 迭代搜索能力) | 同上 |
| **L2 端到端** | QA 准确率 | 三模式对比:无记忆 / 仅工具(固化关) / 工具+自动固化;LLM judge CORRECT/WRONG,分类报告 | scripts,参照 OpenViking 三边界:形成期看不到问题、QA 只见记忆不见原文、同剧本题共享冻结快照 |
| | 端到端 token/延迟 | 分阶段(固化/QA)token 与耗时(dsh-memory 已按此口径,保持可比) | 同上 |
| **L3 固化精度** | 固化 precision | 自动固化产出的新记忆中,映射到 durable 金标的比例(其余=噪声/幻觉) | scripts,judge 判映射 |
| | 固化 recall | durable 金标事实被捕获比例 | 同上 |
| | 污染率 | ephemeral 事实被固化为长期记忆的比例(**软淘汰的 downstream 目标**) | 同上 |
| | 去重率 | 与既有库近重复的新增比例 | 同上 |
| **judge 校准**(贯穿) | judge 假阳/假阴率 | 注入"故意错误答案"对照组(AgentOS 审计法),报告 judge 放行率;judge 固定 seed/温度,同题跑 3 次看方差(Mem0 是 10 次取均值,我们 3 次够用) | scripts |

**跑法取舍**:L0 进 vitest(现有 `npm test` 零成本扩展,CI 即回归护栏);L1 免 judge、固化一次后可重复跑,也可进 CI 的 nightly;L2/L3 独立 `evals/runners/*.mjs` + 环境变量(API key、模型、并发),`workflow_dispatch` 手动触发,结果 JSON+Markdown 报告入库 `evals/results/`。**不要把 LLM-in-the-loop 塞进 vitest**(慢、贵、抖动,会毁掉单测信任度)。

## 三、可借鉴的具体机制(按优先级)

1. **OpenViking 三边界协议**照抄(形成期对问题盲测、QA 拿不到原始会话、同剧本题共享冻结记忆快照但互不共享上下文)——这是所有可信记忆评测的地基。
2. **LongMemEval 的两级 evidence 标注**照抄到合成数据集;顺带吸收其教训:干扰 session 不能污染答案(他们 2025/09 发 cleaned 版修复过此问题)。
3. **Mem0 部署三件套**(注入 token / p50-p95 延迟 / 记忆库体积)写进报告模板;我们的"库体积"=全部 Markdown 文件字符数,天然优势可量化。
4. **Mem0 四操作协议**(ADD/UPDATE/DELETE/NOOP + "UPDATE 需新信息量更大")可作为 memory_write 冲突处理的对照基线,评测里加"重复写入同一事实 → 库不膨胀"的检查。
5. **MemoryBank 强度衰减**为现有 staleAfterDays+引用计数提供理论叙述;可选增强:被 memory_read 命中即重置 stale 计时(现在已有 reads 计数,补一个"命中续命"语义即可,公式上等价于 S+1、t 归零)。
6. **Generative Agents 三因子排序**可作 memory_list/memory_read 结果排序的轻量实现:recency=0.995^天(免 LLM)、importance=固化时 LLM 顺手打 1-10、relevance=查询词与 name/summary 的词面重合(BM25 式)。三因子各自可在 L1 里单独消融。
7. **拒答题**(LongMemEval abstention)是注入式索引最需要的防御性测试:索引存在≠该答,防止"看见记忆就往上凑"。
8. **judge 校准**是低成本高可信度的差异化:公布"我们的 judge 对故意错答的放行率",直接回应 LoCoMo 生态的最大痛点。

## 四、开源贡献判断(修正后的结论)

- **不再成立的**:第一个 dsh 插件评测(dsh-memory 已做 LoCoMo-10);"工具型记忆评测空白"(Letta/LongMemEval-V2/OpenViking 已占)。
- **仍然成立的三个空白,且 dsh-memory 的调研文档亲口承认缺第一个**:
  1. **harness/coding-agent 语境的合成记忆评测数据集**(LoCoMo 是双人闲聊,LongMemEval 是聊天助手;现有公开集没有一个测"项目事实/决策/教训/偏好"四类型 + Workspace 隔离)——做成 `dsh-memory-eval-dataset` 独立发布或本仓库 evals/datasets/,任何 dsh 记忆插件都能跑;
  2. **多维指标体系**(误召回率/注入信噪比/固化 precision-recall/污染率/拒答),现有评测全是端到端准确率单指标;
  3. **judge 校准审计实践**(故意错答对照组)。
- **建议叙事**:不打榜、不喊 SOTA,发布"轻量文件型记忆插件的评测方法学"——报告形式如"在 X token 注入预算下达到 Y 召回率、固化污染率 Z%",引用 Letta 74% 佐证文件路线,引用 Mem0 full-context 72.9% 佐证"记忆是成本-质量权衡"。这比一个 LoCoMo 分数更有可信度,也正好是 dsh-auto-memory"轻量纯文件"定位的护城河证明。
- **执行顺序**:L0(vitest,1 天)→ 数据集 mini + L1(2-3 天)→ L3 固化精度(接现有 consolidate.ts,1-2 天)→ L2 端到端(参照 dsh-memory runner 隔离模式,3-5 天)。L2 若时间紧可砍,前三层已足以支撑 README 里的量化声明与迭代回归。
