# Agent 记忆系统调研与 dsh-auto-memory 扩展路线

2026-11-23。面向 DeepSeek Harness 的个人编码场景，当前优先级是**让用户和 Agent 找得到相关记忆，并看得出证据能否直接使用**。`dsh-auto-memory` 已有细粒度的信任状态、来源摘录、项目隔离、注入记录和维护建议。后续优先把这些能力串成可诊断的召回过程，沿用本地 Markdown 和会话快照。

## 近期项目与实践

| 项目 | 已公开的机制 | 可以迁移到本插件的做法 |
| --- | --- | --- |
| Claude Code Auto Memory | 项目按仓库共享主题文件。`MEMORY.md` 在会话开始读入前 200 行或 25 KB，达到任一限制即截断。主题正文按需读取。 | 保留精简目录、主题正文和预算提示。共享工作树的做法适合将来纳入显式工作区映射。 [Claude Code 官方文档](https://code.claude.com/docs/en/memory) |
| Claude-Mem | 将简短搜索结果、时间线和完整观察分成三层。官方发布页已有 v16.0.3。 | 搜索摘要给出足够线索，让 Agent 据此选择少数 `memory_read`。使用阶段消耗应实测。 [搜索文档](https://docs.claude-mem.ai/usage/search-tools) · [v16.0.3](https://github.com/thedotmack/claude-mem/releases/tag/v16.0.3) |
| `@restregular/dsh-memory` | DSH 社区插件，区分启动概览和按轮召回。提供输入框旁的会话级作用域选择与注入审计。 | 借鉴作用域选择和审计入口。接入前在当前宿主验证该选择能覆盖注入、工具检索和自动固化。 [项目公告](https://github.com/deepseek-ai/deepseek-harness/discussions/10872) · [源码](https://github.com/RestRegular/dsh-memory) |
| `haitang1/dsh-memory` | 编码 Agent 的 Markdown 摘要和会话 rollout。已记录宿主重载后注入注册被跳过、固化输出上限过低但界面未能反映的实际故障。 | 增加最近一次自动固化尝试及结果。为宿主重载和插件禁用重启做真实挂载检查。 [更新记录](https://github.com/haitang1/dsh-memory/blob/main/CHANGELOG.md) |
| `dsh-memory-rag` 与 memsearch | 前者支持离线 BM25、Ollama 和云 embedding。后者用 Markdown 保存原文，派生 Milvus 混合索引。memsearch v0.4.25（11 月 19 日）修复了 Windows 路径与维护进程问题。 | 先把词法检索和中英文夹杂的语料做成可复现基线。规模足够大时再试可重建索引，安装和升级纳入 Windows 验收。 [DSH RAG Releases](https://github.com/Aonysen/dsh-memory-rag/releases) · [memsearch DSH 文档](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/README.md) · [v0.4.25](https://github.com/zilliztech/memsearch/releases/tag/v0.4.25) |
| OpenClaw Memory Core | 区分人工指令、精选长期记忆、会话或日志和维护纪要。晋升依赖来源、召回次数和查询多样性。支持来源引用。 | 维护建议给出对象、证据及拟改字段。对跨会话信号同时检查来源和多样性，避免重复搜索抬高同一条记忆。 [记忆架构](https://docs.openclaw.ai/concepts/memory-architecture) · [配置参考](https://docs.openclaw.ai/reference/memory-config) |
| Hindsight | 结构化 retain、recall、reflect。v1.2.3 修复了异常文件摄入，并让 Hermes 的看板 worker 只读取记忆。 | 将读、写、固化和生命周期可观测性分开，按场景验证读取和写入。 [论文](https://aclanthology.org/2026.acl-demo.27/) · [v1.2.3](https://github.com/vectorize-io/hindsight/releases/tag/v1.2.3) |
| Memorable | 作者白皮书用工具轨迹总结可复用流程，记录步骤、输入输出及验证动作，并用任务是否完成等指标对照。 | 从已验证的排障或发布记录中形成手册候选。记录适用范围、失败信号和验证方法，经确认再给后续任务引用。 [2026 年 10 月白皮书](https://www.memorable.sh/whitepaper/memorable-whitepaper-oct-2026.pdf) |

公开项目的性能数字随任务、模型和预算变化。近期《Memory Tax》论文用原始历史检索作对照，报告了专用记忆系统在多种情形下反而丢失证据。对本插件，改进门槛应包含较轻方案、定量质量指标和实际任务成本。 [论文](https://arxiv.org/abs/2610.34073)

## 本次落地 · 搜索摘录和召回状态

搜索曾按查询第一个空白分隔词找正文摘录。第一个词在无关段落、中文问法与正文略有差异时，即使结果命中了相关信息，也可能只显示开头。现在先沿用词覆盖率选出最多 8 条，再为这些结果选择覆盖最多不同查询词的正文窗口。中文二元组和英文词都参与定位，摘录有 120 个 UTF-16 码元上限。同名结果仍带各自的作用域。 [实现](../src/recall.ts)

显式搜索、读取正文和一层链接都带可信状态及生命周期提示。例如 `DISPUTED` 提示依赖前重核，`SUPERSEDED` 标出历史版本和已知的后继名称，`EXPIRED` 提示时效已失。停用记忆仍可主动查阅。这个改动使用已存的状态，沿用首条用户消息后的注入快照和现有 Markdown 格式。 [Agent 工具](../src/tools.ts) · [回归用例](../tests/recall.spec.ts)

用一个中文和一个英文的回滚脚本查询做定向对照。两个查询在旧排序和新排序下都命中原记录，含正确脚本路径的摘录由 0/2 变为 2/2，每条 119 个 UTF-16 码元。结果衡量这两种摘要回归，端到端任务正确率仍需在代表性任务上测量。 [测试样例](../tests/recall.spec.ts)

## 后续优先级

| 优先级 | 用户遇到的问题 | 交付和验收 |
| --- | --- | --- |
| P1 · 记忆库全文检索 | Web 和记忆工具的搜索能力不一致。Web 目前只匹配标题、摘要和名称。 | 复用正文摘录，在当前作用域内返回命中字段和正文片段。保留类型、状态过滤。验证空查询、同名、只读项目、中英文夹杂和 1,000 条记录下的 P95 响应时间。 |
| P1 · 召回和写入诊断 | 用户难以判断「没记住」出在没固化、未入索引、预算截断还是会话已定格。旧审计仅按名称聚合，同名会混在一起。 | 对新记录保存作用域、工作区和文件名，区分「已写入」「进入索引」「实际注入」和「按需召回」。固化显示最近完成时间和结果计数。旧记录继续按已知信息展示。用同名跨层、超预算和重启用例验证归因。 |
| P2 · 会话级记忆控制 | 临时任务需要在通用偏好、仅当前项目和不使用记忆之间选择。 | 先验证 DSH 宿主是否暴露可信的会话级配置。测试该选择对首次注入、`memory_*` 和后台固化的一致性，以及已有会话的快照语义。通过后再确定交互。 |
| P2 · 词法检索升级 | 长期库增长后，词覆盖对版本号、路径和同义措辞的排序可能不足。 | 对比现有有向词覆盖、字段加权 BM25 和可选的本地混合检索。同一金标、预算和作用域约束下比较 Recall@8、MRR@8、P50/P95、注入字节和端到端正确率。以多语言、长正文、历史冲突这些真实场景作回归。 |
| P3 · 可验证的流程记忆 | Agent 每次处理同类排障或迁移都要重新搜证据。 | 在现有反馈类型上试行流程模板，记录前置条件、验证命令及来源并交给用户确认。用同类真实任务的重做时间、成功率和无用工具调用测收益。 |

全文检索和按工作区的注入诊断已落地。旧日志没有保存具体作用域，面板保留名称记录，新的条目可追溯到确切作用域、工作区与文件名。最近一次自动固化仅记录结果、时间与计数。

当前 DSH 会话头是冻结的创建元数据。会话级控制仍需验证启动前选择、恢复会话和托管子会话时，是否能统一约束快照、记忆工具和固化。

LongMemEval 和 L2 E2E 的 `product` 档采用应用的 16 KiB 默认值，旧 4 KiB 档仍可通过 `legacy-4k` 复现。等需要端到端评测时可在同一任务集和 judge 下比较，历史分数保留原预算标识。 [评测预算](../evals/budget.ts) · [产品默认值](../src/budget.ts)
