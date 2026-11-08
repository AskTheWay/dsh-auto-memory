/**
 * 1.6.0「记忆也有保质期」测试:有效期(validUntil 解析/过期过滤/续期复活/
 * 写入透传与 0 清除哨兵/元数据写继承)、reads 排序闭环(readsBoost 数学与
 * 不变式)、写入门禁透明告警(detectSecrets)、CJK 矛盾 fixture
 * (中文日期/中文单位)、固化候选 validUntilDays、体检 expired 榜。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, parseMemory, isExpired, memoryScore, detectSecrets, renderIndexBody, DEFAULT_IMPORTANCE } from '../src/store.ts'
import { detectContradictions } from '../src/matching.ts'
import { sanitizeCandidate, type RawCandidate } from '../src/consolidate.ts'
import { buildHealthReport } from '../src/memory-api.ts'
import type { MemoryRecord } from '../src/types.ts'

let base: string
let store: MemoryStore

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-16-'))
  store = new MemoryStore(base)
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('有效期:解析与过期判定', () => {
  it('parseMemory 解析合法 validUntil;非法值(负数/字符串/小数)静默丢弃', () => {
    const raw = (fm: string): string => `---\nname: a\ndescription: d\ntype: user\n${fm}\n---\n\nbody`
    expect(parseMemory(raw('validUntil: 1760000000000'), 'user')?.validUntil).toBe(1_760_000_000_000)
    expect(parseMemory(raw('validUntil: -1'), 'user')?.validUntil).toBeUndefined()
    expect(parseMemory(raw("validUntil: 'soon'"), 'user')?.validUntil).toBeUndefined()
    expect(parseMemory(raw('validUntil: 1.5'), 'user')?.validUntil).toBeUndefined()
    expect(parseMemory(raw(''), 'user')?.validUntil).toBeUndefined()
  })
  it('isExpired 边界:无值=否;未来=否;恰好到期=是;已过=是(pinned 不豁免)', () => {
    const now = 1_760_000_000_000
    const memory = (validUntil?: number, pinned?: boolean): MemoryRecord =>
      ({ name: 'a', description: 'd', type: 'user', body: 'b', scope: 'user', ...(validUntil !== undefined ? { validUntil } : {}), ...(pinned === true ? { pinned: true } : {}) })
    expect(isExpired(memory(undefined), now)).toBe(false)
    expect(isExpired(memory(now + 1), now)).toBe(false)
    expect(isExpired(memory(now), now)).toBe(true)
    expect(isExpired(memory(now - 1), now)).toBe(true)
    expect(isExpired(memory(now - 1, true), now)).toBe(true)
  })
})

describe('有效期:注入过滤与续期复活', () => {
  it('renderIndexBody 过滤过期记忆;写新 validUntil(续期)后恢复注入', async () => {
    await store.write({ name: 'fresh', description: '在保质期内', type: 'user', body: 'b', validUntil: Date.now() + 86_400_000 }, 'user')
    await store.write({ name: 'gone', description: '已过期', type: 'user', body: 'b', validUntil: Date.now() - 1 }, 'user')
    const records = await store.list('user')
    const body = renderIndexBody(records)
    expect(body).toContain('fresh')
    expect(body).not.toContain('gone')
    // 续期:重写过期条目带新 validUntil(面板「续 90 天」同路径)
    await store.write({ name: 'gone', description: '已过期', type: 'user', body: 'b', validUntil: Date.now() + 90 * 86_400_000 }, 'user')
    expect(renderIndexBody(await store.list('user'))).toContain('gone')
  })
  it('store.write 透传语义:未传继承;显式 0 清除;显式值覆盖', async () => {
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v1', validUntil: Date.now() + 1000 }, 'user')
    // 未传 validUntil 的元数据写(pinned 翻转):保质期保留
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v1', pinned: true }, 'user')
    expect((await store.read('a', 'user'))?.validUntil).toBeGreaterThan(Date.now())
    expect((await store.read('a', 'user'))?.pinned).toBe(true)
    // 显式 0 = 清除(永久)
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v1', validUntil: 0 }, 'user')
    expect((await store.read('a', 'user'))?.validUntil).toBeUndefined()
    // 显式值 = 覆盖
    const later = Date.now() + 5000
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'v1', validUntil: later }, 'user')
    expect((await store.read('a', 'user'))?.validUntil).toBe(later)
  })
})

describe('reads 排序闭环(readsBoost 第四因子)', () => {
  const now = 1_760_000_000_000
  const memory = (reads?: number, anchor = now - 86_400_000): MemoryRecord =>
    ({ name: 'a', description: 'd', type: 'user', body: 'b', scope: 'user', importance: 7, updatedMs: anchor, ...(reads !== undefined ? { reads } : {}) })
  it('数学:boost = 1 + 0.15×min(reads,20);无 reads 按 0 计;上限 ×4', () => {
    const base1 = 7 * Math.pow(0.995, 1)
    expect(memoryScore(memory(undefined), now)).toBeCloseTo(base1 * 1, 9)
    expect(memoryScore(memory(3), now)).toBeCloseTo(base1 * 1.45, 9)
    expect(memoryScore(memory(20), now)).toBeCloseTo(base1 * 4, 9)
    expect(memoryScore(memory(99), now)).toBeCloseTo(base1 * 4, 9) // 封顶
  })
  it('排序不变式:同重要度同时间锚,高频召回者在前;reads=0 者不受罚', () => {
    const hot = memory(10)
    const cold = memory(0)
    expect(memoryScore(hot, now)).toBeGreaterThan(memoryScore(cold, now))
    // 无时间锚旧文件也参与 boost
    const noAnchor = { ...memory(5), updatedMs: undefined } as MemoryRecord
    expect(memoryScore(noAnchor, now)).toBeCloseTo(7 * 1.75, 9)
  })
})

describe('写入门禁透明告警(detectSecrets)', () => {
  it('高置信密钥计数:ghp_/npm_/sk-含数字/AKIA;sk-button 类 kebab 不误杀', () => {
    expect(detectSecrets('token is ghp_Aaaa11aa2aaa3Aaa4aaa5Aaa6aaa')).toBe(1)
    expect(detectSecrets('npm_Bbbb11bb2bbb3Bbb4bbb5Bbb6bbb7Bbb8bbb9CC0')).toBe(1)
    expect(detectSecrets('sk-Cccc11dd22dd33dd44dd55dd66dd77dd88dd')).toBe(1)
    expect(detectSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(1)
    expect(detectSecrets('两个都在: ghp_Aaaa11aa2aaa3Aaa4aaa5Aaa6aaa 与 sk-Cccc11dd22dd33dd44dd55dd66dd77dd88dd')).toBe(2)
    expect(detectSecrets('类名 sk-button-primary 不是密钥')).toBe(0)
    expect(detectSecrets('无敏感内容')).toBe(0)
  })
})

describe('CJK 矛盾 fixture(1.6.0 补中文单位)', () => {
  it('中文日期集不相交 → date 信号(中文场景的演化谱系触发器)', () => {
    const a = { description: '用户 2026年3月 入职当前公司', body: '' }
    const b = { description: '用户 2026年9月 已离职', body: '' }
    const signals = detectContradictions(a, b)
    expect(signals.some(s => s.kind === 'date')).toBe(true)
  })
  it('中文同单位数值不同 → number 信号(元/岁/人等 1.6.0 新增单位)', () => {
    expect(detectContradictions({ description: '时薪 50 元', body: '' }, { description: '时薪 80 元', body: '' })
      .some(s => s.kind === 'number')).toBe(true)
    expect(detectContradictions({ description: '团队 5 人', body: '' }, { description: '团队 12 人', body: '' })
      .some(s => s.kind === 'number')).toBe(true)
    expect(detectContradictions({ description: '用户 28 岁', body: '' }, { description: '用户 29 岁', body: '' })
      .some(s => s.kind === 'number')).toBe(true)
  })
  it('同值不误报;拉丁单位回归不受影响', () => {
    expect(detectContradictions({ description: '时薪 50 元', body: '' }, { description: '时薪 50 元', body: '' })).toHaveLength(0)
    expect(detectContradictions({ description: '预算 2GB', body: '' }, { description: '预算 8GB', body: '' })
      .some(s => s.kind === 'number')).toBe(true)
  })
})

describe('固化候选 validUntilDays', () => {
  it('sanitize:合法天数保留(1-3650);越界/非法/缺省丢弃(永久)', () => {
    const raw = (days?: unknown): RawCandidate =>
      ({ name: 'plan-x', description: '三月迭代计划', type: 'project', body: '…', importance: 6, ...(days !== undefined ? { validUntilDays: days } : {}) })
    expect(sanitizeCandidate(raw(90), true)?.validUntilDays).toBe(90)
    expect(sanitizeCandidate(raw(3650), true)?.validUntilDays).toBe(3650)
    expect(sanitizeCandidate(raw(9999), true)?.validUntilDays).toBeUndefined()
    expect(sanitizeCandidate(raw(0), true)?.validUntilDays).toBeUndefined()
    expect(sanitizeCandidate(raw(-5), true)?.validUntilDays).toBeUndefined()
    expect(sanitizeCandidate(raw('90'), true)?.validUntilDays).toBeUndefined()
    expect(sanitizeCandidate(raw(), true)?.validUntilDays).toBeUndefined()
  })
})

describe('体检 expired 榜', () => {
  it('过期条目入榜(disputed/superseded 不重复报);未过期不入;expiredDays 为正', () => {
    const now = 1_760_000_000_000
    const m = (name: string, validUntil: number, status?: MemoryRecord['status']): { record: MemoryRecord, scope: 'user' | 'project', slug: string } =>
      ({ record: { name, description: 'd', type: 'user', body: 'b', scope: 'user', validUntil, ...(status !== undefined ? { status } : {}) }, scope: 'user', slug: '_user' })
    const report = buildHealthReport([
      m('over', now - 3 * 86_400_000),
      m('fine', now + 86_400_000),
      m('over-disputed', now - 86_400_000, 'disputed'),
    ], now)
    expect(report.expired).toHaveLength(1)
    expect(report.expired[0]!.name).toBe('over')
    expect(report.expired[0]!.expiredDays).toBe(3)
  })
})

describe('审查修复回钉(1.6.0 对抗审查)', () => {
  it('withValidUntil:三分支共用的天数折算——矛盾分支不再静默丢保质期(major 修复)', async () => {
    const { withValidUntil, sanitizeCandidate } = await import('../src/consolidate.ts')
    // 时效矛盾场景:旧「时薪 50 元」→ 候选 80 元 + 90 天保质期
    const candidate = sanitizeCandidate({ name: 'pay-rate', description: '时薪 80 元', type: 'user', body: 'x', validUntilDays: 90 }, true)!
    expect(candidate.validUntilDays).toBe(90)
    const writeInput = withValidUntil(candidate)
    expect((writeInput as Record<string, unknown>).validUntilDays).toBeUndefined()
    expect((writeInput as Record<string, unknown>).validUntil).toBeGreaterThan(Date.now())
    // supersede 两步写第一步 = 同款折算(落盘后新版本带保质期)
    const asWrite = writeInput as unknown as Parameters<typeof store.write>[0]
    await store.write({ ...asWrite, name: 'pay-rate-v2', supersedes: 'pay-rate' }, 'user')
    const successor = await store.read('pay-rate-v2', 'user')
    expect(successor?.validUntil).toBeGreaterThan(Date.now())
    // 无天数:不产生 validUntil 键(永久)
    const plain = withValidUntil({ name: 'x', description: 'd', validUntilDays: undefined })
    expect((plain as Record<string, unknown>).validUntil).toBeUndefined()
  })
  it('renderIndexBody 排序:readsBoost 让高频召回者排前(引用闭环)', async () => {
    const anchor = Date.now() - 86_400_000
    await store.write({ name: 'hot', description: '高频召回', type: 'user', body: 'b', importance: 6, reads: 10, updatedMs: anchor }, 'user')
    await store.write({ name: 'cold', description: '零召回', type: 'user', body: 'b', importance: 6, reads: 0, updatedMs: anchor }, 'user')
    const body = renderIndexBody(await store.list('user'))
    expect(body.indexOf('hot')).toBeLessThan(body.indexOf('cold'))
  })
  it('memory.write 路由透传 validUntilMs(0=清除哨兵)', async () => {
    const { registerMemoryApi } = await import('../src/memory-api.ts')
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const fakeCtx = {
      get: (name: string) => name === 'connection' ? { fetch: { register: ({ path, fetch }: { path: string, fetch: (r: Request) => Promise<Response> }) => { routes.set(path, fetch) } } } : undefined,
      on: () => {},
      effect: () => {},
    }
    const MemoryStore2 = (await import('../src/store.ts')).MemoryStore
    const apiStore = new MemoryStore2(base)
    registerMemoryApi(fakeCtx as never, apiStore, base, { maxBytes: 4096 }, { maxBytes: 4096 })
    const write = routes.get('/api/auto-memory/memory.write')!
    // 写入未来保质期
    const future = Date.now() + 86_400_000
    await write(new Request('http://x/memory.write', { method: 'POST', body: JSON.stringify({ scope: 'user', name: 't', description: 'd', type: 'user', body: 'b', validUntilMs: future }) }))
    const r1 = await apiStore.read('t', 'user')
    expect(r1?.validUntil).toBe(future)
    // 哨兵 0 清除
    await write(new Request('http://x/memory.write', { method: 'POST', body: JSON.stringify({ scope: 'user', name: 't', description: 'd', type: 'user', body: 'b', validUntilMs: 0 }) }))
    expect((await apiStore.read('t', 'user'))?.validUntil).toBeUndefined()
  })
})
