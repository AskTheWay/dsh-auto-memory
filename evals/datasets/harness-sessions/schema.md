# harness-sessions 数据集格式(v1)

面向 coding-agent 记忆插件的合成评测数据集。每份数据 = 一个虚拟开发者的
多会话剧本 + 金标事实 + 探针题。指标定义见 [../README.md](../README.md)。

## 顶层结构

```jsonc
{
  "name": "mini",                  // 数据集标识
  "persona": {                     // 虚拟开发者画像(事实的语义锚)
    "name": "py-backend-interviewee",
    "stack": ["Python", "PostgreSQL"],
    "workspaces": ["D:/work/api-server", "D:/work/idgen"]  // 会话 cwd 池
  },
  "sessions": [                    // 时间递增的会话序列
    {
      "id": 1,
      "date": "2026-10-01",        // 绝对日期(知识更新题的时间锚)
      "cwd": "D:/work/api-server",
      "messages": [                // 模型可见的会话内容(user/assistant 交替)
        { "role": "user", "text": "..." },
        { "role": "assistant", "text": "..." }
      ]
    }
  ],
  "gold": {
    "facts": [                     // 金标事实:固化评测(L3)的对照物
      {
        "name": "pg-pool-lesson",  // 期望的记忆名(kebab;允许后缀容差)
        "type": "project",         // user|feedback|project|reference
        "label": "durable",        // durable=应固化;ephemeral=陷阱(不应固化);
                                   // updated=后续会话推翻(以 answer_from 为准)
        "evidence_sessions": [1],  // 事实出现的会话
        "answer_from": 3,          // 仅 updated:以该会话为准
        "description": "..."       // 一行要点(召回比对的宽松锚点)
      }
    ],
    "probes": [                    // 探针题:注入召回评测(L1)的判定物
      {
        "q": "...",                // 问题
        "expect": ["pg-pool-lesson"],  // 期望可用的记忆名;[] = 拒答题
        "kind": "single-hop"       // single-hop|multi-hop|temporal|
      }                            // knowledge-update|abstention
    ]
  }
}
```

## 判定规则(runner 实现,不在数据里)

- **L1 注入召回**(免 LLM):对每个非拒答 probe,期望记忆名出现在注入索引
  文本中(或按名可读)即命中;拒答 probe 的期望集为空,任何记忆被"硬拉"
  不扣分(拒答属 L2 端到端语义,L1 只测可达性)。
- **L3 固化精度**(需一次 LLM 固化调用):固化产物按 name/描述相似度映射到
  金标 → precision(写入的映射到 durable)/recall(durable 被捕获)/
  污染率(ephemeral 被写入)/更新正确率(updated 只取 answer_from 值)。

## 质量红线

- 每条 durable/updated 事实至少在一个会话里有**显式文本证据**;
- ephemeral 陷阱必须像"值得记"但实际是一次性噪声(临时报错、会话内代号);
- 拒答题的答案**不得**出现在任何会话文本中(防泄漏);
- 相对日期一律写成绝对日期(与插件写入纪律一致)。
