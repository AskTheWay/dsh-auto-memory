# 引流文案包(自行复制发布)

## ① 知乎 / 掘金(中文长文,蹭 DeepSeek 主场热度)

**标题(二选一)**:
- 你的 DeepSeek Harness 智能体每次都失忆?我给它写了个原生记忆插件
- 给 23 万 star 的 DeepSeek Harness 补上它缺失的记忆系统

**正文**:

用 dsh 的人应该都有这个体感:每次新会话,智能体都不认识你。你是谁、用什么技术栈、项目做到哪了,全部重来。

查了下源码和文档,发现 dsh 根本没有记忆子系统——官方给的方案是三份默认关闭的 MCP 外挂配置,要自己起第三方服务,而且模型不主动调工具就没有任何记忆注入。文档自己都承认:无自动注入、无遗忘策略、搜索只做子串匹配。

所以我写了 dsh-auto-memory:把 Claude Code 的 auto-memory 机制(Claude Code 用户习以为常的那套 MEMORY.md)原生平移到 dsh 上。

一条命令安装:

```sh
dsh plugin --profile demo add dsh-auto-memory
```

核心行为:
- 记忆是 $DSH_HOME/memory/ 下的纯 Markdown 文件(带 frontmatter,四类:user/feedback/project/reference)
- MEMORY.md 索引自动注入每次系统提示词,无记忆时零占用
- 六个工具(memory_write/read/list/delete/prune/delete_all),写入遵循 Claude Code 纪律:查重更新而非堆积
- 项目级/用户级两层作用域,跨项目不串扰

0.2.0 加了两个 Claude Code 都没有的东西:
- **自动固化**:根会话结束时,后台用 LLM 总结本次会话值得长期记住的新事实,自动写入记忆
- **遗忘淘汰**:memory_read 计引用数,staleAfterDays 把零引用的超龄记忆从索引软隐藏,memory_prune 清理

开发过程中印象最深的几件事:
1. 官方 fs-sandbox 的可写根不含 $DSH_HOME,记忆工具必须直接走 node:fs——这是读了 skill-filesystem 源码才确认的官方先例
2. 第三方插件写自定义会话事件,会导致整个会话 resume 时被拒读(fail-closed 校验)——所以审计只走标准 tool/result 事件
3. 发布前的多轮对抗性代码审查抓出 5 个生产级 bug:比如在 Windows 上,一条名叫 "memory" 的记忆会和 MEMORY.md 在大小写不敏感文件系统上撞名,写入"成功"但数据静默销毁;再比如记忆里三个字面 {{{ }}} 花括号就能让整个工作区的模型请求全炸,而且模型无法自救

排错过程都写在仓库 docs/ 的 postmortem 里了,两轮 9 个错误,感兴趣的可以看。

仓库:https://github.com/AskTheWay/dsh-auto-memory(双语 README)
npm:dsh-auto-memory
已被 awesome-dsh-plugin 收录,桌面客户端的 dsh-market 插件市场里可以一键装。

欢迎踩坑反馈,尤其是自动固化的总结质量和遗忘阈值该怎么定。

---

## ② Discord(官方频道,英文短帖)

> Just released **dsh-auto-memory** — native persistent memory for dsh agents, a port of Claude Code's auto-memory model. MEMORY.md index injected into every system prompt, typed memory files, zero external services. 0.2.0 adds session-end auto-consolidation and reference-based forgetting (things Claude Code doesn't do).
> `dsh plugin --profile demo add dsh-auto-memory`
> No-key demo: `node scripts/demo.mjs` → https://github.com/AskTheWay/dsh-auto-memory
> Also on awesome-dsh-plugin / dsh-market. Feedback on the consolidation prompt welcome!

入口:dsh 仓库 README 的 Discord 邀请链接(discord.gg/Ycq5dCaS4),找 showcase/plugins 相关频道贴。

---

## ③ 发布检查清单

- [x] GitHub Discussions 官方展示帖(已由助手代发):https://github.com/deepseek-ai/deepseek-harness/discussions/7790
- [ ] 知乎(建:DeepSeek 话题 + AI Agent 话题)
- [ ] 掘金/V2EX 分享区
- [ ] Discord showcase 频道(用上面②的文案)
- [ ] (攒 1-2 周反馈后)Show HN / r/LocalLLaMA 英文阵地
