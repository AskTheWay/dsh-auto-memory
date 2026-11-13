/**
 * 1.7.0「记忆维护」测试:keywords(解析/清洗/透传继承/检索打分参与)、
 * aging 降权档(isAging/memoryScore 因子)、死链体检榜、
 * 引用纪律段注入(policy 文本扩展后预算语义不破)。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, parseMemory, serializeMemory, isAging, isExpired, memoryScore, AGING_DAYS, AGING_DECAY } from '../src/store.ts'
import { sanitizeCandidate, type RawCandidate } from '../src/consolidate.ts'
import { buildHealthReport } from '../src/memory-api.ts'
import { descriptionCoverage } from '../src/matching.ts'
import { renderMemoryIndexText } from '../src/prompt.ts'
import type { MemoryRecord } from '../src/types.ts'
import type { Config } from '../src/index.ts'

let base: string
let store: MemoryStore
let config: Config

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-17-'))
  store = new MemoryStore(base)
  config = { maxBytes: 4096, enableUserScope: true, autoSummarize: false } as Config
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('keywords:解析与序列化', () => {
  it('parseMemory 解析合法数组(清洗:非空/≤24 字符/前 5 个);非法整体丢弃', () => {
    const raw = (fm: string): string => `---\nname: a\ndescription: d\ntype: user\n${fm}\n---\n\nbody`
    expect(parseMemory(raw('keywords: [db, postgres, psycopg2]'), 'user')?.keywords).toEqual(['db', 'postgres', 'psycopg2'])
    expect(parseMemory(raw('keywords: [ok, ""]'), 'user')?.keywords).toEqual(['ok']) // 空串滤除
    expect(parseMemory(raw('keywords: [a, b, c, d, e, f, g]'), 'user')?.keywords).toHaveLength(5) // 截前 5
    expect(parseMemory(raw('keywords: 42'), 'user')?.keywords).toBeUndefined()
    expect(parseMemory(raw('keywords: [42, true]'), 'user')?.keywords).toBeUndefined()
  })
  it('serialize → parse 往返;write 透传继承(未传保留旧值,空数组清除)', async () => {
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v', keywords: ['db', 'postgres'] }, 'user')
    expect((await store.read('a', 'user'))?.keywords).toEqual(['db', 'postgres'])
    // 元数据写(pinned 翻转)不剥 keywords
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v', pinned: true }, 'user')
    expect((await store.read('a', 'user'))?.keywords).toEqual(['db', 'postgres'])
    // 空数组 = 清除哨兵
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v', keywords: [] }, 'user')
    expect((await store.read('a', 'user'))?.keywords).toBeUndefined()
    // 覆盖
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v', keywords: ['x'] }, 'user')
    expect((await store.read('a', 'user'))?.keywords).toEqual(['x'])
    const back = await store.read('a', 'user')
    const { scope: _omit, ...rest } = back!
    expect(parseMemory(serializeMemory(rest), 'user')?.keywords).toEqual(['x'])
  })
  it('检索打分参与:keywords 让不同措辞的查询命中(无向量的语义泛化)', () => {
    const plain = '用户偏好 psycopg2 连接池,压测前要预热'
    const scorePlain = descriptionCoverage('database pool', plain)
    const scoreWithKw = descriptionCoverage('database pool', `${plain} db postgres pool`)
    expect(scoreWithKw).toBeGreaterThan(scorePlain)
  })
})

describe('keywords:固化候选', () => {
  it('sanitize:数组/逗号串都收;清洗同 store 口径;缺省 = 无', () => {
    const raw = (kw: unknown): RawCandidate =>
      ({ name: 'x', description: 'd', type: 'user', body: 'b', keywords: kw })
    expect(sanitizeCandidate(raw(['db', 'postgres']), true)?.keywords).toEqual(['db', 'postgres'])
    expect(sanitizeCandidate(raw('db, postgres，sqlite'), true)?.keywords).toEqual(['db', 'postgres', 'sqlite'])
    expect(sanitizeCandidate(raw(['ok', 'x'.repeat(30)]), true)?.keywords).toEqual(['ok'])
    expect(sanitizeCandidate(raw([]), true)?.keywords).toBeUndefined()
    expect(sanitizeCandidate(raw(42), true)?.keywords).toBeUndefined()
  })
})

describe('aging 降权档(1.7.0)', () => {
  const now = 1_760_000_000_000
  const memory = (over: Partial<MemoryRecord>): MemoryRecord =>
    ({ name: 'a', description: 'd', type: 'user', body: 'b', scope: 'user', importance: 7, createdMs: now - 100 * 86_400_000, updatedMs: now - 100 * 86_400_000, ...over })
  it('isAging:仅 candidate 且出生超 90 天;verified 豁免;无出生锚不参与;编辑不洗白', () => {
    expect(isAging(memory({ status: 'candidate' }), now)).toBe(true)
    expect(isAging(memory({ status: 'verified' }), now)).toBe(false)
    expect(isAging(memory({ status: undefined }), now)).toBe(false)
    expect(isAging(memory({ status: 'candidate', createdMs: now - 10 * 86_400_000 }), now)).toBe(false)
    expect(isAging(memory({ status: 'candidate', createdMs: undefined, updatedMs: undefined }), now)).toBe(false)
    // 出生超龄但昨天被 echo/编辑重写(updatedMs 很新)——照样 aging(锚=出生时钟)
    expect(isAging(memory({ status: 'candidate', updatedMs: now - 1_000 }), now)).toBe(true)
    expect(AGING_DAYS).toBe(90)
  })
  it('memoryScore:aging ×0.85 温和降权;KV 不变式保持(无写入时分数逐字节稳定)', () => {
    const aging = memory({ status: 'candidate' })
    const fresh = memory({ status: 'verified' }) // 同锚点同重要度
    const base1 = 7 * Math.pow(0.995, 100)
    expect(memoryScore(aging, now)).toBeCloseTo(base1 * AGING_DECAY, 9)
    expect(memoryScore(fresh, now)).toBeCloseTo(base1, 9)
    expect(memoryScore(aging, now)).toBe(memoryScore(aging, now)) // 确定性
  })
})

describe('死链体检榜(1.7.0)', () => {
  it('[[target]] 不在库 → 入榜;活链/自链不报;superseded 来源不报', () => {
    const now = 1_760_000_000_000
    const m = (name: string, body: string, status?: MemoryRecord['status']): { record: MemoryRecord, scope: 'user' | 'project', slug: string } =>
      ({ record: { name, description: 'd', type: 'user', body, scope: 'user', ...(status !== undefined ? { status } : {}) }, scope: 'user', slug: '_user' })
    const report = buildHealthReport([
      m('a', '见 [[b]] 与 [[ghost-1]]'), // b 活,ghost 死
      m('b', '见 [[a]]'),               // 活链
      m('c', '见 [[a]] 与 [[a]]'),       // 去重后一个 a
      m('d', '[[d]] 自链', 'superseded'), // 自链+superseded 免检
    ], now)
    expect(report.deadLinks).toEqual([{ from: 'a', scope: 'user', slug: '_user', target: 'ghost-1' }])
  })
})

describe('引用纪律段与预算语义(1.7.0)', () => {
  it('policy 文本含引用纪律;注入仍恒 ≤ 预算(上界断言不破)', async () => {
    const { MEMORY_POLICY_TEXT } = await import('../src/prompt.ts')
    expect(MEMORY_POLICY_TEXT).toContain('Citation discipline')
    for (let i = 0; i < 50; i++) {
      await store.write({ name: `m${String(i).padStart(2, '0')}`, description: `事实 ${'x'.repeat(60)}`, type: 'user', body: 'b' }, 'user')
    }
    const text = renderMemoryIndexText(store, config, '/w')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
    // 过期/纪律共存:扩展 policy 后空库依旧零注入
    const empty = new MemoryStore(join(base, 'empty'))
    expect(renderMemoryIndexText(empty, config, '/w')).toBe('')
  })
})

describe('CONTRACT「保证」档测试背书(审查 major 修复)', () => {
  it('伪造证据摘录被转写对照拦下:quote 前 40 字不在 transcript → 丢 evidence', () => {
    const raw: RawCandidate = { name: 'x', description: 'd', type: 'user', body: 'b', evidence: '这是模型编造的摘录,转写里根本没有这句话' }
    // 转写不含该摘录 → evidence 被丢弃
    const out1 = sanitizeCandidate(raw, true, { sessionId: 's1', transcript: '用户说:我喜欢用 psycopg2 连接池' })
    expect(out1?.evidence).toBeUndefined()
    // 转写确实包含 → 保留
    const real: RawCandidate = { name: 'x', description: 'd', type: 'user', body: 'b', evidence: '我喜欢用 psycopg2 连接池,压测前要预热' }
    const out2 = sanitizeCandidate(real, true, { sessionId: 's1', transcript: '用户提到:我喜欢用 psycopg2 连接池,压测前要预热,不然数据会很惨' })
    expect(out2?.evidence?.quote).toBe('我喜欢用 psycopg2 连接池,压测前要预热')
  })
  it('AGENTS.md 导出滤过期与不信任态:只导 status 缺省/verified 且未过期', async () => {
    const { trustedForExport } = await import('../src/export-agents.ts')
    const now = Date.now()
    const records = [
      { name: 'ok', description: '信任态未过期', type: 'user', body: 'b', scope: 'user' },
      { name: 'v', description: '已验证', type: 'user', body: 'b', scope: 'user', status: 'verified' as const },
      { name: 'exp', description: '已过期', type: 'user', body: 'b', scope: 'user', validUntil: now - 1 },
      { name: 'cand', description: '候选', type: 'user', body: 'b', scope: 'user', status: 'candidate' as const },
    ] as never[]
    const names = trustedForExport(records).map(r => r.name)
    expect(names).toContain('ok')
    expect(names).toContain('v')
    expect(names).not.toContain('exp')
    expect(names).not.toContain('cand')
  })
  it('aging 锚=出生时钟:编辑/echo 重写刷新 updatedMs 不洗白 aging(审查 minor 修复)', () => {
    const now = 1_760_000_000_000
    const born = now - 100 * 86_400_000
    const editedRecently = { name: 'a', description: 'd', type: 'user', body: 'b', scope: 'user', status: 'candidate', createdMs: born, updatedMs: now - 1_000 } as import('../src/types.ts').MemoryRecord
    expect(isAging(editedRecently, now)).toBe(true) // 出生超 90 天,昨天刚被 echo 重写也照样 aging
  })
})
