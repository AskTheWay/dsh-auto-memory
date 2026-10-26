/**
 * 1.2.0 B 线测试:memory_search 的评分与截断(descriptionCoverage 有向覆盖、
 * CJK bigram 查询、limit 8、excerpt)、export-agents 的渲染格式与信任过滤。
 */

import { describe, expect, it } from 'vitest'
import { renderAgentsExport, trustedForExport } from '../src/export-agents.ts'
import { descriptionCoverage } from '../src/matching.ts'
import type { MemoryRecord } from '../src/types.ts'

const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  name: 'x', description: 'd', type: 'user', body: 'b', scope: 'user', ...over,
})

describe('memory_search 评分语义(descriptionCoverage 有向覆盖)', () => {
  it('query 词被记忆覆盖的比例即分;body 参与匹配', () => {
    const memory = rec({ name: 'pg-lesson', description: '连接池教训', body: 'psycopg2 连接必须用 context manager' })
    // 查询三词,两个命中(pg/连接池 经 name+description,context manager 经 body)
    expect(descriptionCoverage('psycopg2 连接池 context manager', `pg-lesson\n连接池教训\npsycopg2 连接必须用 context manager`)).toBeGreaterThan(0)
  })
  it('CJK 查询经 bigram 命中中文记忆', () => {
    expect(descriptionCoverage('连接池', 'pg-lesson\n连接池教训\nbody')).toBeGreaterThanOrEqual(0.5)
  })
  it('不相关查询零分(被 filter 剔除)', () => {
    expect(descriptionCoverage('kubernetes', 'pg-lesson\n连接池教训\npsycopg2')).toBeLessThan(0.2)
  })
})

describe('export-agents', () => {
  it('渲染格式:标题+来源注释+逐条列表', () => {
    const md = renderAgentsExport([
      { name: 'user-prefers-chinese', description: '用户偏好中文', scope: 'user' },
      { name: 'pg-lesson', description: '连接池教训', scope: 'project' },
    ], '2026-10-25')
    expect(md).toContain('## Memory (exported from dsh-auto-memory, 2026-10-25)')
    expect(md).toContain('- 用户偏好中文 (user-prefers-chinese)')
    expect(md).toContain('- 连接池教训 (pg-lesson)')
    expect(md).toContain('AGENTS.md') // 来源注释(工具名锚定)
  })
  it('空集返回空串(不产出空标题)', () => {
    expect(renderAgentsExport([], '2026-10-25')).toBe('')
  })
  it('信任过滤:candidate/disputed/superseded 不导;undefined/verified 导', () => {
    const records = [
      rec({ name: 'legacy', status: undefined }),
      rec({ name: 'ver', status: 'verified' }),
      rec({ name: 'cand', status: 'candidate' }),
      rec({ name: 'disp', status: 'disputed' }),
      rec({ name: 'sup', status: 'superseded' }),
    ]
    expect(trustedForExport(records).map(r => r.name)).toEqual(['legacy', 'ver'])
  })
})
