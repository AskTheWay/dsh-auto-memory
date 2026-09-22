# dsh-auto-memory

[English](README.md) | [中文](README.zh.md)

**把 Claude Code 的 auto-memory 机制移植为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生插件。**

为 dsh 智能体提供类型化持久记忆层:带 frontmatter 的记忆文件、自动注入系统提示词的
`MEMORY.md` 索引、四个模型工具——轻量、纯文件、无外部服务、无 embedding 依赖。

## 为什么

dsh 本体**没有记忆子系统**。官方对记忆的全部支持是三份*默认关闭*的 MCP 外挂配置
(Memorix、MCP Reference Memory、Engram),官方文档自己承认其局限:不自动注入
(模型必须主动调工具)、无自动摘要、无冲突消解、无遗忘策略。

`dsh-auto-memory` 用原生实现补上这一层:

| 能力 | MCP 外挂方案 | dsh-auto-memory |
|---|---|---|
| 索引自动注入每次系统提示词 | ✗ | ✓(无记忆时零占用) |
| 类型化记忆(user / feedback / project / reference) | ✗ | ✓ |
| 项目级 + 用户级分层,跨项目不串扰 | ✗ | ✓(作用域开关贯通全部工具路径) |
| 崩溃/并发安全(跨进程文件锁 + 孤儿锁自愈) | — | ✓ |
| 遗忘/淘汰策略(P1) | ✗ | 计划中 |
| 会话结束自动固化(P1) | ✗ | 计划中 |

## 安装

本地检出安装(npm 发布前):

```sh
npm install && npm run build
dsh plugin --profile demo add /绝对路径/dsh-auto-memory
dsh --profile demo            # 重启 profile 生效
```

发布后:`dsh plugin --profile demo add dsh-auto-memory`。

要求 `@deepseek-ai/dsh >= 0.1.5-rc.2`(Node `^22.19 || >=24`)。

## 使用

直接告诉智能体值得记住的事:

> "记住:我是 Python 后端工程师,正在准备面试,偏好中文交流。"

模型会调 `memory_write`。同一工作区的下一次会话,注入的索引已经在场——
问 *"你对我有什么了解?"* 它就能召回。

工具:`memory_write` / `memory_read` / `memory_list` / `memory_delete`。
写入规则对齐 Claude Code:查重更新而非堆积、不存代码库/AGENTS.md 已记录的内容、
`feedback` 类型带 **Why:** / **How to apply:** 行、相对日期转绝对、正文 `[[name]]` 交叉链接。

## 记忆保存在哪

```
$DSH_HOME/memory/                  # 默认 ~/.dsh/memory
├── --<工作区slug>--/              # 项目层(slug 由会话 cwd 派生)
│   ├── MEMORY.md                  # 索引(唯一被注入的部分)
│   └── 每条记忆一个.md             # frontmatter + 正文
└── _user/                         # 用户层(所有工作区共享)
```

每条记忆都是纯 Markdown——可手改、可 grep、对 git 友好:

```markdown
---
name: user-prefers-python
title: 后端工程师,偏好 Python
description: 正在准备面试;偏好中文交流
type: user
---

事实正文……用 [[其他记忆名]] 交叉链接。
```

## 工作原理

- **写入路径**:工具 `execute` → name 归一化为 `[a-z0-9-]`(保留字拒绝)→
  跨进程文件锁(官方 `dsh-atomic-write`)→ 原子写文件 → 全量重建索引。
  崩溃留下的孤儿锁自动自愈(死 pid 检测)。
- **注入路径**:单个动态系统提示词段(order 4000),每个 step 组装时重新求值;
  同步读索引、字节预算截断、中和字面 `{{`(0.1.5 无 `interpolate` 开关)。
  无记忆 → 空段 → 零 token。
- **审计**:不写自定义会话事件(第三方事件类型会导致 dsh 会话 resume 拒读);
  一切走标准 `tool/call` / `tool/result`。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖(config 整表替换——须重述全部键):

```yaml
- id: auto-memory
  config:
    maxBytes: 4096          # 注入预算(索引 + 指导文本)
    memoryDir: D:/memories  # 默认: $DSH_HOME/memory
    enableUserScope: true   # false: 用户层在所有路径禁用
    autoSummarize: false    # P1 占位
```

## 设计与调研

- [docs/design.md](docs/design.md) — 设计决策与取舍
- [docs/api-reports.md](docs/api-reports.md) — 支撑每个实现选择的 dsh 源码级调研
  (含本插件规避的陷阱清单)

## 路线图

- [x] P0:类型化存储 + 四工具 + 索引注入 + 分层作用域 + 崩溃安全
- [ ] P1:会话结束自动固化、遗忘/淘汰、召回展开
- [ ] P2:Web UI 记忆卡片、token 成本/召回质量评测

## 验证

```sh
npx vitest run          # 40 项测试:存储逻辑、花括号回归、真实 Cordis 栈
node scripts/demo.mjs   # 无 key 演示:写入 → 索引 → 注入 → 查重 → 删空
```

## 许可

MIT
