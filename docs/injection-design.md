# Injection Design — 注入时机 × 上下文选择 × KV 缓存

> 决策记录(2026-11-17,基于 dsh 0.2.2-rc.3 宿主源码级调研 + 官方三家口径
> + dsh 生态五家实现对照)。回答一个问题:**记忆应该在什么时机、以什么通道、
> 注入哪些内容,同时尽最大可能保住前缀缓存。**

## 决策一览

| 维度 | 我们的选择 | 一句话理由 |
|---|---|---|
| 通道 | `systemPrompt.section`(order 4000) | node 0 受 compaction 保护=**真免疫**;context 通道的 user 快照可被压,需重注入机制自补 |
| 时机 | **会话注入快照**:首 USER 后的那次组装定格,会话内绝对不变(1.9.0) | 对齐官方三家;0.2.x 下 section 变化=追加整条 system message,快照使其零追加 |
| 内容 | 预算内全量;超预算先按首 USER 词集相关性重排、再两层保底配额装填(project 60%) | "在哪个项目"是最强相关信号;全量常驻是最诚实的上下文 |
| 按需层 | `memory_search` 工具(渐进披露 top-8+excerpt) | 常驻层放不下/不需要的,模型自己拉 |
| 变化语义 | 写入落盘 → 本会话注入不变(工具即时可读),**下会话生效** | 与 Claude Code 官方 auto-memory 同语义 |

## 为什么留在 section 通道(而不是 context)

dsh 0.2.x 宿主有两条注入通道,语义根本不同(源码:`system-prompt/index.ts`
的 SystemPromptProjection 与 `agent-loop/runtime-context.ts`):

- **section**(进 system prompt):变化时,capable route + continuing series
  下**不改头部,追加一条新 system message** 到缓存历史之后——不炸缓存,
  但每变一次历史多一整条 system prompt(token 单调增长);仅 incapable
  route / broken series(含 tools schema 变化)才替换头部真炸。
- **context**(动态运行时上下文):物化为 durable **user 快照消息**追加到
  序列尾部,变化零缓存损失;但它是普通消息——**会被 compaction 压掉**,
  需要"压缩→代次归零→重注入"自补(sage-mem 的做法),且快照在历史里
  单调累积。

我们的记忆段在 system prompt 的 node 0 内——**宿主对 node 0 有 compaction
保护**("node 0 holds the system prompt"),这是唯一无需任何重注入机制的
真免疫通道。context 通道的"变化零损失"优势对快照化的我们不再重要(会话内
不变=零变化),而它的 compaction 脆弱性是永久负债。**结论:留在 section,
用会话快照把"变化"本身消灭。**

## 会话注入快照(1.9.0,核心机制)

时间线:

```
组装 1(首 USER 前)  动态求值,不缓存——给空库→首写入场景一个定格机会
组装 2(首 USER 已知) 用首 USER 词集做一次性选择(超预算时相关性重排)
                     → 定格为会话快照
组装 3..N            直返快照——写入/跨天/索引重建都不改本会话注入
下一会话             重新走组装 1-2(新会话新快照)
```

收益链:
1. **KV(0.2.x 语义)**:会话内零 section 变化 = 零追加 system message;
   跨天变化消失(旧实现次日首次组装可能重排)
2. **token**:不追加 = 历史不因记忆而增长
3. **选择质量**:首 USER 是任务书,一次性选择比"冻结词集+每请求重算"更
   彻底——且取代并简化了 1.6.0 的懒冻结词集(一个机制而非两个)
4. **语义对齐**:Codex「会话边界注入一次,稳态回合不重建」;Claude Code
   「project context 会话开始读盘,compaction 后重读未变则命中」

行为变化(有意):`memory_write` 落盘后**本会话注入不变**——模型写完的
记忆立即经工具(`memory_read`/`memory_search`)可读,注入到下会话生效。
与 Claude Code 官方 auto-memory 同语义;换来的是本会话前缀绝对稳定。

## 两层保底配额

超预算截断发生在两层拼接之后:user 层大库会把本工作区的 project 记忆
整体挤出——而"这个会话在哪个项目里"是最强相关性信号。装填规则:

- project 行(本工作区)保底 **60%** 净预算
- user 行竞争剩余 40% + project 未用完的余量
- user 行装不下的余量二次回流给 user(总量恒 ≤ 预算)

## 官方口径对照(为什么这样放)

- **Anthropic prompt caching 指南**:"静态内容放最前;按变化频率分层设
  断点(tools rarely change, context updates daily)"——记忆正是
  daily 级,放可独立失效的后段;我们的 order 4000 在全部工具段
  (1000-3000)与 MCP(3100)之后,记忆变化不触及前面的大头
- **Claude Code 三层模型**:system prompt(核心指令+tools)/ project
  context(CLAUDE.md、auto memory)/ conversation——记忆在第二层,
  变化只炸第二层之后;dsh 的 section 体系里我们的等位层就是 4000
- **Codex memory v2**:会话边界注入一次(memory_summary.md 截 5000
  token 进 developer instructions),稳态回合不重建

## 生态五家做法对照(2026-11-17 实读源码)

| 方案 | 通道 | 时机 | 选择逻辑 | KV 处理 |
|---|---|---|---|---|
| **我们** | section(4000) | 会话快照(首 USER 定格) | 预算内全量;超预算词集重排+两层配额 | 会话内绝对不变;node 0 压缩免疫 |
| dsh-memory-hub 0.8.1 | context | 每回合(首 step 预检) | BM25-lite,top-6/600tok 快照 | 宿主 context 通道零损失;同任务不重排 |
| sage-mem 2.10.2 | context(interpolate:false) | 每步 assemble,三层去重压成每问一次 | baseline 线(会话首 ≤8 条无条件)+检索线(段落级) | 签名去重;压缩→代次归零重注入 |
| dsh-mneme(0.5.3→0.16) | context(85/90,memory+user-settings 双块);0.16 起另加 section(150 memory-guide,能力探测式) | 每步惰性 | 静态池(类型直通+importance 门槛,零检索) | 库低频变更兜底,无会话内工程 |
| whale-pal | 5 段 section | 常驻目录(≤300 字无时间戳) | 目录常驻+编号,正文按需取回 | "pre-step 注入次数=0"口径;无时间戳纪律 |

各家取舍光谱:**hub/sage-mem 拿相关性(每回合重选),付出变化管理与压缩
自补;mne/whale-pal 拿稳定(静态选择),付出相关性**。我们的会话快照是
中间态:会话级的相关性(首 USER 一次性选择)+ 绝对的稳定(定格)。

## 明确不做

- **每回合预检注入**(hub 路线):每回合一条新快照消息,历史单调增长;
  DSH 下我们的 section 快照零增长更优
- **消息流注入**(claude-mem 路线):compaction 即丢,重注入是永久债
- **记忆段挪到 order 10500(最末)**:9900+ 的 runtime 尾段稳定性不受我们
  控制——尾部稳则小赚、尾部不稳则每请求跟炸,当前 4000 是隔离风险的
  安全位
