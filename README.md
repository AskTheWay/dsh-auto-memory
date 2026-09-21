# dsh-auto-memory

把 **Claude Code 的 auto-memory 记忆机制**移植为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生插件:
MEMORY.md 索引自动注入系统提示词 + 类型化记忆文件 + 记忆读写工具,
轻量、纯文件、无外部服务。

## 为什么

dsh 官方对记忆的支持仅是三份**默认关闭**的 MCP 外挂配置,且:
不自动注入(模型不主动调工具就没有记忆)、无自动摘要、无冲突消解、无遗忘策略。
`dsh-auto-memory` 是原生 Cordis 插件——索引随提示词组装自动注入,不依赖模型主动调用。

| 能力 | MCP 外挂方案 | dsh-auto-memory |
|---|---|---|
| 索引自动注入系统提示词 | ✗ | ✓(无记忆时零占用) |
| 类型化记忆(user/feedback/project/reference) | ✗ | ✓ |
| 中文标题索引行 | ✗ | ✓(title 字段) |
| 项目级/用户级分层,跨项目不串扰 | ✗ | ✓(含禁用开关贯通全部工具) |
| 并发/崩溃安全(跨进程文件锁 + 孤儿锁自愈) | — | ✓ |
| 遗忘/淘汰策略(P1) | ✗ | 计划中 |
| 会话结束自动固化(P1) | ✗ | 计划中 |

## 安装(本地开发)

```sh
# 1. 在插件仓库内构建产物并安装依赖
npm install && npm run build

# 2. 装入 dsh profile(绝对路径;官方 plugin-manager 拒绝相对路径)
dsh plugin --profile demo add D:/path/to/dsh-auto-memory

# 3. 重启 profile 生效
dsh web --profile demo
```

> npm 发布后可直接 `dsh plugin --profile demo add dsh-auto-memory`。

## 使用

对模型说一句 "记住我偏好 Python",或让它总结项目决策——插件提供
`memory_write / memory_read / memory_list / memory_delete` 四个工具,
记忆落在 `$DSH_HOME/memory/--<项目slug>--/`(项目级)与 `$DSH_HOME/memory/_user/`(用户级),
MEMORY.md 索引随系统提示词自动注入,下次会话自动带着记忆开工。

写入遵循 Claude Code 的规则:写前查重(同名更新而非堆积)、
不存代码库/AGENTS.md 已记录的内容、feedback 类型带 Why/How to apply、
相对日期转绝对、正文 `[[name]]` 交叉链接。

## 设计

见 [docs/design.md](docs/design.md)(设计决策)与 [docs/api-reports.md](docs/api-reports.md)(dsh 源码调研)。

## 路线图

- [x] P0:记忆存储 + 四工具 + 索引注入 + 分层作用域 + 并发/崩溃安全
- [ ] P1:会话结束自动固化、遗忘/淘汰、召回展开
- [ ] P2:Web UI 记忆管理卡片、token 成本/召回率评测

## License

MIT
