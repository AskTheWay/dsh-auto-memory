# evals/ — 评测体系(三轴 + 预算解耦)

> 定位声明:本评测**不参与 LoCoMo 类打榜**(金标/judge 争议大,同系统分差 ±20)。
> 我们发布的是可复现的对照测量:同一 judge 下与自身 baseline 的差异、
> 机制开关前后的差异、预算口径之间的差异。
> 背景与完整调研见 [docs/landscape-2026-09.md](../docs/landscape-2026-09.md)。

## 预算解耦原则(本体系的核心纪律)

**能力测量不得被预算截断效应污染;预算研究必须显式声明场景。**

记忆系统的两个维度经常被混在一起报分:「检索/固化能力上限」和「在 4KB
预算下的实际保留」。混报的后果:LongMemEval 首跑的 23.3% 里,针位探针
事后证明相当一部分是「80 条记忆挤 14 行索引」的截断效应——那是预算行为,
不是记忆能力。因此所有注入类评测分两个口径,结果分文件落盘、不互相覆盖:

| 口径 | 注入预算 | 测什么 | 用法 |
|---|---|---|---|
| **capacity**(默认) | 256KB,不构成约束 | 记忆能力上限(检索/固化质量,与预算无关) | `--budget capacity` |
| **product** | 4096,真实默认 | 含截断效应的产品体验 | `--budget product` |

预算超限本身作为研究对象,只在**预算压力轴**(见下)显式进行。

## 总览:三轴一横切

| 轴 | 回答的问题 | runner | 预算条件 | 主指标 | 状态 |
|---|---|---|---|---|---|
| **A 机制正确性**(回归网,非评测) | 各机制按规格工作吗 | `tests/` + `l0/` 的 eviction/link 断言(224 tests,随 CI) | 不适用(直接断言行为) | 全绿 + KV-safe 字节断言 | ✅ |
| **B 组件质量** | 检索、固化这两个零件准吗 | `runners/l1-retrieval.mjs`(金标直写→注入可达)/`runners/l3-consolidation.mjs`(真实 LLM 固化) | **无预算维度**(直测组件,不经注入) | L1 召回 100%;L3 recall/precision/duplicates/污染 | ✅ |
| **C 系统效果** | 装上插件,agent 行为真的变好吗 | `runners/l2-e2e.mjs`(双组 lift)/`runners/l2-longmemeval.mjs`(行业基准对齐) | **双口径**(capacity/product) | lift;对齐分 | ✅(见下) |
| **D 预算压力** | 预算超限时系统怎么取舍 | `l0/` 的 budget/snr 断言 + `runners/l2-needle-probe.mjs` | **显式 4096,本轴就是研究超限** | 保留率;针位三环节定位 | ✅ |
| 横切:成本 | 代价多大 | (待办)所有 runner 输出 bytes/token 列 | 伴随维度 | 注入 bytes/次 | ⏳ 路线图 |

历史编号(L0/L1/L2/L3)为构建时间顺序,不再作为层级语义;文件名保留以免
破坏 CI 与历史结果引用,对照见上表。

## 轴 A:机制正确性(回归网)

`npm test` 的 224 个确定性断言,含:状态机与证据链语义、有效期过滤与续期、
readsBoost 数学、密钥检测口径、CJK 矛盾信号、KV-safe(同日无写入时注入
字节逐相同)。**这不是评测,是回归网**——它保证「机制按规格工作」,
轴 B/C/D 才在可信地基上测「规格本身好不好」。

## 轴 B:组件质量(无预算维度)

### L1 检索(`l1-retrieval.mjs`,无 API)

金标记忆直写 → 逐 probe 断言注入可达。mini 与 standard 均 **100%**
(完美固化上界——它测的是「检索不丢」,不测「固化会不会写出这些记忆」)。

### L3 固化(`l3-consolidation.mjs`,需 `DEEPSEEK_API_KEY`)

真实 LLM 固化 harness-sessions 剧本 → 对照金标算 recall/precision/
duplicates/污染率(结果入 `results/`)。与 L2 共享同一条代码路径。

## 轴 C:系统效果(双口径)

### 端到端双组 lift(harness-sessions;capacity 口径,该场景两口径等价)

| 数据集 | with 记忆 | baseline(无记忆) | **lift(净贡献)** | 拒答(with/without) |
|---|---|---|---|---|
| mini(3 会话/12 题) | 100% | 33.3% | **+66.7%** | 100% / 100% |
| standard(10 会话/30 题) | 95.8% | 16.7% | **+79.2%** | 83.3% / 100% |

记忆量个位数,4096 从不触发截断——lift 测的是纯记忆能力贡献。
baseline 答对的几乎全是通用知识可蒙对的;项目特定事实无记忆时全错。

### LongMemEval-S 对齐(双口径对照,同 30 题同种子)

| 跑次 | 口径 | Overall | Task-avg | knowledge-update | multi-session |
|---|---|---|---|---|---|
| 首跑(2026-10-24) | product(4096) | 23.3% | 33.9% | 1/5 | 0/8 |
| 1.3.0 复跑(2026-11-06) | product(4096) | 20.0% | 24.3% | 0/5 | 0/8 |
| **capacity 对照(2026-11-11)** | **capacity(256KB,零截断)** | **43.3%** | **56.4%** | **4/5** | **0/8** |

**预算效应占比首次量化:product→capacity = +23pp(翻倍)**。分项给出干净的机制分解:

- **knowledge-update 0/5 → 4/5**:这些题的针确实被固化入库,纯粹被 4KB 截断
  挤出注入——针位探针(2133c1b5)判定的机制②被实验证实;预算放开后该类
  几乎全对。ss-preference 0/2→2/2 同理
- **multi-session 0/8 铁打不动**:跨会话聚合类在零截断下依然全灭——机制①
  (固化层滤琐事+每会话独立固化导致碎片化)的专属领地,与预算无关
- temporal-reasoning 1/8→2/8:小幅,时间推理主要输在固化不在注入

**结论(更新)**:低分不是单一原因——**预算纪律在 ~80 条记忆库下吃掉 23 个
百分点**(这是 4KB 纪律的精确代价,产品定位下接受);**固化层的琐事过滤+
碎片化咬掉 multi-session 全部**(设计取舍,海捞针基准的针正是编码场景
要滤的东西)。两条边界各有实证坐标,product 口径的 20% 是两者叠加。

诚实声明:judge=deepseek-chat(官方 gpt-4o-2024-08-06),分数与官方数字不
严格可比;子集 30 题分层抽样(种子固定可复现,非全量 500)。定位是同一
judge 下口径间与自身 baseline 的对照,不是榜单数字。

## 轴 D:预算压力(显式研究超限)

### L0 确定性指标(`evals/l0/*.spec.ts`,随 CI)

**① index-budget(预算曲线)**:固定 4096,N 条合成记忆注入体积恒 ≤ 4096
(N=20/50/100/200 全量断言);空库输出 0 字节。曾驱动真实修复(预算语义
从「仅索引」改为「索引+指导文本整段」,旧实现超支 ~800B)。

**② injection-snr(截断保留率)**:探针在截断后的保留率。
无词集时排序为 pinned → 三因子(importance×recency×reads,1.6.0 起含引用
乘子);有查询场景的保留由相关性排序决定(见 `tests/v13.spec.ts` 的
重排语义断言)。历史基线:无置顶 38%→10%(随 N 增大),**置顶 ≥80%**
(0.3.0 起的对照断言);三因子排序上线后该表的数字为 0.3.0 时代口径,
重跑更新见路线图。

**③ eviction-correctness(淘汰零误杀)**:四类混合场景只有「超龄零引用」
被隐藏,文件零丢失,读一次即复活。

**④ link-expansion(链接展开边界)**:一层展开上限 3 条并标记 truncated、
自链排除、坏链接安全跳过、体积有界。

### 针位探针(`l2-needle-probe.mjs`,需 key)

单题三环节定位:固化入库 → 注入保留 → 问答判分,金标答案丢失在哪一环
一目了然。是 LongMemEval 负发现机制分解的工具,也是本轴的显微镜。

## 缺口路线图(按性价比)

1. ~~**LongMemEval capacity 对照跑**~~ ✅ 已完成(2026-11-11,43.3% vs
   product 20.0%,预算效应 +23pp 已量化,见轴 C)
2. **成本口径入表**——各 runner 输出固定 bytes/token 列(注入开销 1KB 级
   的叙事目前只在文档里)
3. **judge 校准**——故意错答对照组测 judge 区分度(L2/L3 的 judge 从未
   被校准过)
4. **#20 真实编码会话盲测**——系统效果轴收官:先过程信号(15-20 真实
   任务,测注入 token/误召回/重复检索),再结果 lift(100+ 任务)
5. **生命周期 e2e 链**——写入→注入→召回→矛盾→取代→过期→续期一条
   会话级全链路(目前只有单测碎片)
6. **SNR 表重跑**——三因子+reads 排序下的保留率更新 0.3.0 时代基线

## 复现

```sh
npm test                          # 轴A + 轴D 的 L0 断言(vitest 自动拾取)
node evals/runners/l1-retrieval.mjs mini && node evals/runners/l1-retrieval.mjs standard   # 轴B
DEEPSEEK_API_KEY=… node evals/runners/l3-consolidation.mjs mini                            # 轴B
DEEPSEEK_API_KEY=… node evals/runners/l2-e2e.mjs mini                                       # 轴C(capacity 默认)
DEEPSEEK_API_KEY=… node evals/runners/l2-longmemeval.mjs --data <s_cleaned.json> --n 30            # 轴C capacity
DEEPSEEK_API_KEY=… node evals/runners/l2-longmemeval.mjs --data <s_cleaned.json> --n 30 --budget product   # 轴C product
DEEPSEEK_API_KEY=… node evals/runners/l2-needle-probe.mjs <question_id>                     # 轴D
```

LongMemEval 数据获取(官方域名被 DNS 污染,hf-mirror 为实测可靠通道;277MB,不入库):

```sh
curl -L -o evals/datasets/longmemeval/s_cleaned.json \
  https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

**数据集**:`datasets/harness-sessions/`(`schema.md` 格式与质量红线;mini
手写 3 会话/12 题;standard 合成 10 会话/30 题含 6 拒答、4 ephemeral 陷阱、
2 updated 推翻)——带金标标签的完整会话剧本,coding-agent 语境(四类型
记忆、双工作区、跨会话引用),LoCoMo/LongMemEval 均不覆盖。
