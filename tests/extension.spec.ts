import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { evaluationBudget } from '../evals/budget.ts'
import { appendAudit, readAuditLog } from '../src/audit.ts'
import { registerConsolidation } from '../src/consolidate.ts'
import { Config } from '../src/index.ts'
import { renderMemoryIndexDetail } from '../src/prompt.ts'
import { MemoryStore } from '../src/store.ts'

describe('16 KiB 产品默认预算', () => {
  it('宿主与评测共用默认值，历史 4 KiB 压力档仍可复现', () => {
    const current = Config({} as Config)
    expect(current.maxBytes).toBe(16_384)
    expect(evaluationBudget()).toEqual({ mode: 'product', bytes: current.maxBytes, suffix: 'product-16384' })
    expect(evaluationBudget('legacy-4k')).toEqual({ mode: 'legacy-4k', bytes: 4096, suffix: 'legacy-4k' })
    expect(evaluationBudget('capacity').bytes).toBe(262_144)
    expect(() => evaluationBudget('16kb')).toThrow('Unknown budget mode')
    expect(Config({ maxBytes: 4096 } as Config).maxBytes).toBe(4096)
  })

  it('默认档能保留 4 KiB 放不下的记忆，整段仍受预算约束', () => {
    const current = Config({} as Config)
    const rows = Array.from({ length: 150 }, (_, i) => `- [记忆 ${i}](mem-${i}.md) — ${'工作区决策'.repeat(5)}`).join('\n')
    const store = { readIndexSync: (scope: string) => scope === 'project' ? rows : null } as unknown as MemoryStore
    const standard = renderMemoryIndexDetail(store, current, '/current')
    const low = renderMemoryIndexDetail(store, { ...current, maxBytes: 4096 }, '/current')
    expect(standard.textBytes).toBeLessThanOrEqual(current.maxBytes)
    expect(standard.injected.length).toBeGreaterThan(low.injected.length)
    expect(low.truncated.length).toBeGreaterThan(0)
  })
})

it('已启用固化的会话无模型路由时，记录原因和写入数', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-memory-run-'))
  try {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const ctx = { on: (name: string, cb: (...args: unknown[]) => void) => { handlers.set(name, cb) },
      effect() {}, get: () => undefined } as unknown as Context
    const handle = registerConsolidation(ctx, new MemoryStore(root), Config({ autoSummarize: true } as Config), run => appendAudit(root, run))
    const session = { id: 'sample', header: { cwd: '/workspace' } }
    handlers.get('session/event')!(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请记录回归流程' }] } })
    handlers.get('agent/disposed')!({ agent: { session, options: {} } })
    await handle.flush()
    const log = await readAuditLog(root)
    expect(log.injections).toEqual([])
    expect(log.consolidation).toEqual([expect.objectContaining({
      cwd: '/workspace', sessionId: 'sample', outcome: 'no-route', candidates: 0, written: 0,
    })])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
