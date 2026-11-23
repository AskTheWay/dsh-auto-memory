import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { searchRecall } from '../src/recall.ts'
import { MemoryStore } from '../src/store.ts'
import { registerMemoryTools } from '../src/tools.ts'
import type { MemoryRecord } from '../src/types.ts'

function record(name: string, body: string, fields: Partial<MemoryRecord> = {}): MemoryRecord {
  return { name, body, type: 'project', scope: 'project', description: '里程碑与操作记录', ...fields }
}

describe('按需召回摘要', () => {
  it.each([
    ['where is the rollback entry', 'where we started. ' + 'old notes '.repeat(35) + 'The rollback entry is scripts/rollback.ps1.'],
    ['回滚脚本放在哪里', '旧的发布记录。'.repeat(36) + '回滚脚本放在 scripts/rollback.ps1。'],
  ])('问题 %s 的摘录保留正文命中处', (query, body) => {
    const [match] = searchRecall([record('release-note', body)], query, 0)
    expect(match?.excerpt).toContain('scripts/rollback.ps1')
    expect(match?.excerpt).toMatch(/^…/)
    expect(match?.excerpt.length).toBeLessThanOrEqual(120)
  })

  it('排序按词覆盖，保留跨层同名结果和八条上限', () => {
    const records = [
      record('shared', 'rollback entry'), record('shared', 'rollback entry', { scope: 'user' }),
      ...Array.from({ length: 9 }, (_, i) => record(`note-${i}`, 'rollback')),
      record('other', 'use compose'),
    ]
    const matches = searchRecall(records, 'rollback entry', 0)
    expect(matches).toHaveLength(8)
    expect(matches.slice(0, 2).map(match => [match.name, match.scope, match.score])).toEqual([
      ['shared', 'project', 1], ['shared', 'user', 1],
    ])
  })

  it('正文为空时返回摘要，纯元数据命中时仍给有界正文预览', () => {
    const matches = searchRecall([
      record('a', '  ', { description: 'rollback uses traces' }),
      record('b', 'old notes '.repeat(40), { keywords: ['rollback'] }),
    ], 'rollback', 0)
    expect(matches.map(match => match.name)).toEqual(['a', 'b'])
    expect(matches[0]?.excerpt).toBe('rollback uses traces')
    expect(matches[1]?.excerpt).toMatch(/^old notes.*…$/)
    expect(matches[1]?.excerpt.length).toBeLessThanOrEqual(120)
  })
})

it('实际注册的搜索、读取和链接都将状态传给模型，同时维持工作区隔离', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-recall-'))
  const cwd = join(root, 'current')
  const ctx = new Context()
  const store = new MemoryStore(root)
  const touches = vi.spyOn(store, 'touch')
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    registerMemoryTools(ctx, store, { enableUserScope: true, maxBytes: 16_384 })
    await store.write(record('release', 'rollback is pending [[old-release]]', { status: 'disputed', disabled: true }), 'project', cwd)
    await store.write(record('old-release', 'rollback plan 1', { status: 'superseded', validUntil: 1 }), 'project', cwd)
    await store.write(record('other-workspace', 'rollback plan 2'), 'project', join(root, 'other'))

    async function call(name: string, args: { name: string } | { query: string }) {
      const tool = ctx.tools.get(name)!
      const exec = { agent: { session: { header: { cwd } } } } as Parameters<typeof tool.execute>[1]
      const value = await tool.execute(args, exec) as Parameters<typeof tool.output.render>[1]
      const text = tool.output.render(args, value).map(block => block.type === 'text' ? block.text : '').join('\n')
      return { value, text }
    }

    const search = await call('memory_search', { query: 'rollback' })
    expect(search.value).toMatchObject({ matches: [
      { name: 'old-release', status: 'superseded', expired: true },
      { name: 'release', status: 'disputed', disabled: true },
    ] })
    expect(search.text).toContain('SUPERSEDED (historical)')
    expect(search.text).toContain('EXPIRED (historical')
    expect(search.text).toContain('DISPUTED (confirm before relying on it)')

    const read = await call('memory_read', { name: 'release' })
    expect(read.value).toMatchObject({ status: 'disputed', disabled: true, linked: [
      { name: 'old-release', status: 'superseded', expired: true },
    ] })
    expect(read.text.indexOf('DISPUTED')).toBeLessThan(read.text.indexOf('rollback is pending'))
    expect(read.text).toContain('- old-release [SUPERSEDED (historical) | EXPIRED')
  } finally {
    await Promise.allSettled(touches.mock.results.map(result => result.value))
    await ctx.fiber.dispose()
    await fsp.rm(root, { recursive: true, force: true })
  }
})
