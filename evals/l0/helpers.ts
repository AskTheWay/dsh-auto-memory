/**
 * L0 评测共用的合成记忆构造器(确定性,无 LLM)。
 * 供 index-budget / injection-snr / eviction-correctness / link-expansion 使用,
 * 也是未来 L1/L3 合成数据集(harness-sessions)的地基。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { MemoryStore } from '../../src/store.ts'
import { serializeMemory } from '../../src/store.ts'

/** 确定性伪随机(mulberry32):同 seed 产出完全一致,保证评测可复现。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 一条合成记忆。 */
export interface SynthMemory {
  name: string
  title: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  body: string
  /** 是否属于"探针集"(模拟当前任务相关,信噪比评测用)。 */
  probe?: boolean
}

const TOPICS_ZH = ['数据库连接池', '日志规范', '鉴权中间件', '索引优化', '部署流水线', '依赖升级', '缓存策略', '接口限流', '测试覆盖', '配置管理']
const TOPICS_EN = ['connection-pool', 'logging-policy', 'auth-middleware', 'index-tuning', 'deploy-pipeline', 'dep-upgrade', 'cache-strategy', 'rate-limit', 'test-coverage', 'config-management']

/**
 * 生成 n 条长度分布贴近真实使用的合成记忆(name 字典序分散)。
 * probeEvery>0 时,每第 probeEvery 条标记为探针。
 */
export function makeMemories(n: number, seed = 42, probeEvery = 0): SynthMemory[] {
  const rand = seededRandom(seed)
  const out: SynthMemory[] = []
  for (let i = 0; i < n; i++) {
    const zh = TOPICS_ZH[i % TOPICS_ZH.length]
    const en = TOPICS_EN[i % TOPICS_EN.length]
    const descLen = 24 + Math.floor(rand() * 40) // 24-63 字符,贴近真实 description
    out.push({
      name: `m${String(i).padStart(4, '0')}-${en}`,
      title: `${zh}经验`,
      description: `关于${zh}的第${i}条结论`.padEnd(descLen, ',实测有效'),
      type: (['user', 'feedback', 'project', 'reference'] as const)[i % 4],
      body: `正文:${zh}的实践要点 ${'x'.repeat(40 + Math.floor(rand() * 60))}`,
      ...(probeEvery > 0 && i % probeEvery === 0 ? { probe: true } : {}),
    })
  }
  return out
}

/**
 * 批量落盘(绕过逐条 write 的 O(N²) 索引重建):直接写文件 + 单次 refreshIndex。
 * 写入当前时刻的生命周期元数据(软淘汰/信噪比评测需要 updated/reads 参与)。
 */
export async function seedStore(store: MemoryStore, memories: SynthMemory[], scope: 'project' | 'user', cwd?: string): Promise<void> {
  const dir = store.dir(scope, cwd)
  await fsp.mkdir(dir, { recursive: true })
  const now = Date.now()
  for (const m of memories) {
    await fsp.writeFile(
      join(dir, `${m.name}.md`),
      serializeMemory({ name: m.name, title: m.title, description: m.description, type: m.type, body: m.body, createdMs: now, updatedMs: now }),
      'utf8',
    )
  }
  await store.refreshIndex(scope, cwd)
}

/** 字节长度(与 maxBytes 预算同单位)。 */
export function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
