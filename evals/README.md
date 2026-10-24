# evals/ — 记忆插件评测(方法学,非打榜)

> 定位声明:本评测**不参与 LoCoMo 类打榜**(金标/judge 争议大,同系统分差 ±20)。
> 我们发布的是"轻量文件型记忆的**确定性指标层**":无 LLM、无 API key、结果
> 100% 可复现,随 `npm test` 在 CI 中作为回归护栏运行。
> 背景与完整调研见 [docs/landscape-2026-09.md](../docs/landscape-2026-09.md)。

## 分层

| 层 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **L0 确定性指标** | 注入预算曲线 / 信噪比 / 淘汰零误杀 / 链接展开边界 | 无(纯计算) | ✅ `l0/`,随 CI 跑 |
| **L1 注入召回** | 合成数据集金标直写 → 逐 probe 注入可达性 | 无 API | ✅ `runners/l1-retrieval.mjs`(mini 与 standard 均 100%,完美固化上界) |
| **L3 固化精度** | recall / precision / 污染率 / 更新正确率(真实 LLM 固化) | `DEEPSEEK_API_KEY`,≈会话数次调用 | ✅ `runners/l3-consolidation.mjs`(结果入 `results/`) |
| **L2 端到端** | 固化 → 注入 → 双组(带/无记忆)探针问答 → 盲判;lift = 记忆净贡献 | `DEEPSEEK_API_KEY`,≈探针数×3 次调用 | ✅ `runners/l2-e2e.mjs`(结果入 `results/`) |
| **L2-LongMemEval** | 行业基准对齐:LongMemEval-S cleaned 子集(30 题分层抽样),官方 5 套 judge 模板 | `DEEPSEEK_API_KEY`,30 题≈1560 次调用 | ✅ `runners/l2-longmemeval.mjs`(结果入 `results/`) |

**数据集**:`datasets/harness-sessions/`(`schema.md` 格式与质量红线;`mini` 手写 3 会话/12 题;`standard` 合成 10 会话/30 题含 6 拒答、4 ephemeral 陷阱、2 updated 推翻)。与 L0 的合成记忆构造器不同,这里的数据是**带金标标签的完整会话剧本**——coding-agent 语境(四类型记忆、双工作区、跨会话引用),LoCoMo/LongMemEval 均不覆盖。

## L0 指标定义

### ① index-budget(注入预算曲线)

固定 `maxBytes=4096`,注入 N 条合成记忆(确定性 seed)后测量整段注入体积。

**Baseline(2026-09-25,CI 持续回归)**:

| N(记忆数) | 注入字节 | 断言 |
|---|---|---|
| 20 | 4065 | ≤ 4096,全量保留 |
| 50 | 4048 | ≤ 4096,截断生效 |
| 100 | 4018 | ≤ 4096 |
| 200 | 3940 | ≤ 4096,截断标记存在 |

附带:软淘汰使过半超龄零引用记忆出局后注入体积相应回落;空库输出 0 字节(零占用硬保证)。
**本指标已驱动一次真实修复**:预算语义从"仅索引"改为"索引+指导文本整段"(旧实现在拼接 policy 尾巴后可超预算 ~800B)。

### ② injection-snr(注入信噪比,characterization)

探针集(每第 4 条标记)在预算截断后的保留率。

| 场景 | 探针保留 | 解读 |
|---|---|---|
| 预算充足(N=20) | 5/5 = 100% | 全量注入,信噪比=结构占比 |
| 半量预算(N=50) | 5/13 ≈ 38% | 位置式截断 |
| N=100 | 5/25 = 20% | 同上 |
| N=200 | 5/50 = 10% | 同上 |
| **半量预算 + 探针置顶(0.3.0)** | **≥ 80%** | **pinned 优先截断:评测驱动迭代的第一次数字移动** |

**已知局限(有意钉板)**:未置顶时截断按索引行序(name 字典序),与相关性无关;
预算恒定 → 保留条数恒定(~20 条),探针均匀分布时保留绝对数也恒定。
**0.3.0 的 pinned 优先排序已在同预算下把置顶探针保留率提升至 ≥80%**
(同一 seed、同一批记忆、同一预算的对照断言,见 injection-snr.spec.ts);
完整的三因子相关性排序仍在路线图,届时更新本表。

### ③ eviction-correctness(淘汰零误杀)

四类混合(超龄零引用 / 超龄已读 / 新写入 / 无元数据旧文件):
只有第一类从注入索引隐藏;**文件层面零丢失**;被读一次即复活且此后豁免。
断言误杀数 = 0(等价 MemoryBank R=e^(−t/S) 的"召回重置强度"语义)。

### ④ link-expansion(链接展开边界)

`[[name]]` 一层展开:上限 3 条并标记 truncated、自链排除、坏链接安全跳过、
单次展开体积 ≤ 3×660 UTF-8 字节(有界性)。

## L2 结果(2026-10-25,deepseek-chat)

### 端到端双组对比(harness-sessions)

| 数据集 | with 记忆 | baseline(无记忆) | **lift(净贡献)** | 拒答(with/without) |
|---|---|---|---|---|
| mini(3 会话/12 题) | 100% | 33.3% | **+66.7%** | 100% / 100% |
| standard(10 会话/30 题) | 95.8% | 16.7% | **+79.2%** | 83.3% / 100% |

baseline 的正确题几乎全是通用知识可蒙对的(psycopg2 常见坑/中文偏好);项目特定事实(压测预热/夜猫子时间/部署目标)无记忆时全错——lift 即记忆系统的净贡献。

### LongMemEval-S 30 题分层抽样(接入官方协议的第一跑)

Task-averaged **33.9%** / Overall **23.3%** / Abstention **100%**(分项:ss-user 1/1,multi-session 0/8,temporal 0/8,knowledge-update 1/5,ss-assistant 1/3,ss-pref 1/2)。

**低分是实测发现而非事故**——根因与本插件的设计边界完全一致:

1. **场景错配**:LongMemEval 是"122k token 闲聊海捞针"(每题 ~50 会话),本插件的固化管线为编码会话的 durable 事实设计,在闲聊海上产出 ~109 条低价值记忆/题,4KB 预算只放 top 30 行,目标事实被挤出注入——**预算纪律在错误场景下就是错的**;
2. **证据碎片化**:答案事实散在多会话,每会话独立固化导致碎片化,无跨会话合并;
3. judge=deepseek-chat(官方 gpt-4o-2024-08-06),与官方数字不可比。

这组数字如实钉板:它量化了"轻量编码场景记忆"与"长程对话海捞针"两个任务的距离,是"不参与打榜"定位声明的实证注脚。Abstention 100%(对不可答问题全部正确拒答)与 harness-sessions 的 +79.2% lift 共同构成完整画像:**本插件在它的目标场景(编码会话)净贡献显著,在非目标场景(闲聊海)不假装能打**。

## 复现

```sh
npm test          # L0 随全量测试运行(vitest 自动拾取 evals/l0/*.spec.ts)
npm test && node evals/runners/l1-retrieval.mjs mini && node evals/runners/l1-retrieval.mjs standard
DEEPSEEK_API_KEY=… node evals/runners/l3-consolidation.mjs mini
DEEPSEEK_API_KEY=… node evals/runners/l2-e2e.mjs mini          # 端到端双组对比
DEEPSEEK_API_KEY=… node evals/runners/l2-longmemeval.mjs --data <s_cleaned.json> --n 30
```

LongMemEval 数据获取(官方域名被 DNS 污染,hf-mirror 为实测可靠通道;277MB,不入库):

```sh
curl -L -o evals/datasets/longmemeval/s_cleaned.json \
  https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

诚实声明:LongMemEval 子集为 30 题分层抽样(种子固定可复现,非官方全量 500);
judge 为 deepseek-chat(官方默认 gpt-4o-2024-08-06)——分数与官方榜单数字不
严格可比,定位是"同一 judge 下与自身 baseline 的对照"与"接入官方协议的
方法论演示"。

构造器(`helpers.ts` 的 seededRandom/makeMemories/seedStore)是未来
L1/L3 合成数据集(harness-sessions:虚拟开发者多会话剧本)的地基。
