# dsh-auto-memory 设计文档

把 Claude Code 的 auto-memory 机制移植为 DeepSeek Harness (dsh) 原生插件的完整设计。
定位:轻量、纯文件、无外部服务、无 embedding 依赖——与生态里的平台型记忆产品
(OpenViking / MemOS / EverOS)差异化,忠实复刻 Claude Code 的机制并小幅超越。

## 1. 问题背景

dsh 官方对记忆的支持仅为三份默认关闭的 MCP 外挂配置(Memorix / MCP Reference Memory /
Engram),官方文档自认局限:不自动注入(模型不主动调工具就没有记忆)、无自动摘要、
无冲突消解、无遗忘策略、搜索只做子串匹配。

dsh-auto-memory 用原生 Cordis 插件补上这一层。

## 2. 数据模型(对齐 Claude Code)

### 2.1 单条记忆 = 一个 Markdown 文件

```markdown
---
name: short-kebab-case-slug
description: 一行摘要,用于召回相关性判断与索引展示
metadata:
  type: user | feedback | project | reference
---

正文:事实本身。feedback 类型必须跟 **Why:** 与 **How to apply:** 两行。
正文中用 [[other-name]] 链接相关记忆。
```

四种 `metadata.type` 的语义(对齐 Claude Code):

| type | 语义 | 典型内容 |
|---|---|---|
| `user` | 用户是谁:角色、专长、偏好 | "用户是 Python 后端工程师,面试准备中" |
| `feedback` | 用户对工作方式的指导(纠正+确认) | 必须 Why + How to apply |
| `project` | 进行中的工作、目标、约束(相对日期必须转绝对日期) | "dsh-auto-memory 项目 P0 截止 2026-09-29" |
| `reference` | 外部资源指针(URL、面板、工单) | "压测面板: http://..." |

### 2.2 索引 = MEMORY.md

```markdown
# Memory Index

- [标题](文件名.md) — 一句话钩子
```

每条记忆一行;MEMORY.md 是唯一注入系统提示词的部分(控制 token 预算),
正文只在召回时按需读取。

### 2.3 分层作用域

| 层 | 路径 | 注入范围 |
|---|---|---|
| 项目级 | `$DSH_HOME/memory/<workspace-slug>/` | 仅该项目 workspace 的会话 |
| 用户级 | `$DSH_HOME/memory/_user/` | 所有会话 |

workspace-slug 由 session.cwd 派生(路径安全化),项目级与用户级索引合并注入,
用户级在前。跨项目不串扰。

## 3. 注入策略

1. **索引注入**:`ctx.systemPrompt.section()` 注册一个 order 靠后的段,
   每次提示词组装时读取(缓存)MEMORY.md 内容注入。
2. **写入指导**:紧随索引的指令段,告知模型:何时该写(用户纠正/陈述偏好/项目关键决策)、
   写之前先读索引查重、按 description 匹配**更新而非堆积**、
   不写代码库/CLAUDE.md 已记录的内容。
3. **token 预算**:`maxBytes` 配置(默认 4096 字节)限制注入的索引+指令总长;
   超预算时按行截断(保留用户级),截断处留标记。

## 4. 工具面(对齐 Claude Code 的 Memory 工具语义)

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_write` | name, description, type, body, scope | 写入/更新单条记忆(按 name 匹配已有则覆盖),同步刷新索引 |
| `memory_read` | name | 读单条记忆全文 |
| `memory_list` | scope? | 列出记忆(name/description/type 一览) |
| `memory_delete` | name | 删除记忆并刷新索引 |

**不写自定义会话事件**(源码调研确认的硬约束):第三方插件的事件类型不在 dsh 构建期
`KNOWN_SESSION_EVENT_TYPES` 内,持久化后该会话 resume 会整体拒读(fail-closed 校验)。
审计走 `tool/call`/`tool/result` 核心事件即可。

## 4.1 实现层关键决策(源码调研拍板,详见 docs/api-reports.md)

1. **文件 IO 走 node:fs 而非 ctx.fs**:默认部署的 fs-sandbox 可写根(workspaceRoot/tmp)
   不含 `$DSH_HOME`,走 ctx.fs 必抛 `FS_SANDBOX_DENIED`;官方先例 skill-filesystem 访问
   `$DSH_HOME` 同样直接 node:fs。代价:不经审批/观测策略——由自建安全层补偿
   (normalizeName 把 name 压缩为纯 `[a-z0-9-]`,文件名无路径攻击面)。
2. **并发写走 `@deepseek-ai/dsh-atomic-write`**:`withFileLock`(跨进程 wx 文件锁,
   Windows EPERM 兼容官方已处理)+ `writeFileAtomic`(临时文件+rename 原子替换)。
   锁对象是各作用域的 MEMORY.md——同一 workspace 的写/删全串行。
3. **frontmatter 用 `yaml` 包**解析/序列化(skill-filesystem 同款),description 含
   冒号/引号时由 yaml 正确转义,不做手写解析。
4. **项目目录名照抄官方 `projectKey(cwd)` 算法**(`/ \ :` 折叠、`~HEX` 转义、
   `--slug--` 包装),与 `$DSH_HOME/sessions` 目录命名一致。
5. **0.1.5-rc.2 无 `interpolate` 开关**(0.1.6 才有):记忆内容含字面 `{{ }}` 会在严格
   插值下炸组装——注入副本由 `neutralizeBraces` 中和;peer 升级后换回开关。

## 5. P1:超越 Claude Code 的部分

1. **自动固化**:会话结束/compaction 时用 `ctx.llm` 总结本次会话中值得长期保留的
   事实,经去重后写入记忆(Claude Code 未做全自动)。
2. **遗忘与淘汰**:引用计数(每次 memory_read +1)、时间衰减、description 失配检测
   (提示更新),阈值可配置。
3. **召回展开**:索引命中后自动读取 top-k 相关记忆正文注入([[链接]] 图展开)。

## 6. 工程形态

- 独立 npm 包 `dsh-auto-memory`,TypeScript + tsdown 最薄构建(官方独立插件方案)
- `package.json` 带 `dsh.bundle` 声明;`cordis.patch.yml` 贡献挂载行
- 运行时依赖仅 `yaml` + `@deepseek-ai/schemastery`(官方惯例放 dependencies);
  框架包全走 peerDependencies(绝不放 dependencies,会装出第二 cordis 实例)
- 配置(schemastery):`maxBytes`(默认 4096)、`memoryDir`(默认 `$DSH_HOME/memory`)、
  `enableUserScope`(默认 true)、`autoSummarize`(默认 false,P1)

## 7. 明确不做

- embedding/向量检索(生态里平台型产品已卷,与"轻量复刻"定位冲突)
- 记忆的云端同步/多机共享
- 复刻 dsh 已有的能力(工具/沙箱/hooks/指令注入)
