/**
 * 0.7.0 匹配核心与更新替换决策的单元测试(纯函数,无依赖)。
 */

import { describe, expect, it } from 'vitest'
import {
  words, wordHit, nameCoverage, descriptionCoverage, descriptionSimilarity,
  decideConsolidationAction, MATCH,
} from '../src/matching.ts'
import type { MemoryRecord } from '../src/types.ts'

const base = { description: 'd', body: 'b', scope: 'project' as const }
const mem = (over: Partial<MemoryRecord>): MemoryRecord => ({ name: 'x', type: 'user', ...base, ...over })

describe('words / wordHit(0.7.0 从 L3 runner 搬入产品)', () => {
  it('CJK bigram + 拉丁词(Set 插入序)', () => {
    expect([...words('用户偏好 python')]).toEqual(['用户', '户偏', '偏好', 'python'])
  })
  it('前缀容错(≥5 字符)', () => {
    expect(wordHit('alloc', 'allocation')).toBe(true)
    expect(wordHit('pool', 'pools')).toBe(false) // <5 不容错
    expect(wordHit('redis', 'redis')).toBe(true)
  })
})

describe('nameCoverage(词序无关的 name 锚定)', () => {
  it('词序重排 = 100%(同义重复 bug 的判例)', () => {
    expect(nameCoverage('ignore-err-tmp-5501', 'err-tmp-5501-ignore')).toBe(1)
  })
  it('前缀容错命中', () => {
    expect(nameCoverage('workerid-redis-alloc', 'idgen-workerid-redis-allocation')).toBeGreaterThanOrEqual(2 / 3)
  })
  it('不相干 name 低覆盖', () => {
    expect(nameCoverage('user-prefers-chinese', 'pg-pool-lesson')).toBeLessThan(MATCH.NAME_COVERAGE)
  })
})

describe('decideConsolidationAction(更新替换语义)', () => {
  it('精确同名 → update(保留现有身份)', () => {
    const existing = [mem({ name: 'deploy-target', description: '旧方案' })]
    const decision = decideConsolidationAction({ name: 'deploy-target', description: '新方案' }, existing)
    expect(decision.action).toBe('update')
    if (decision.action === 'update') expect(decision.target.name).toBe('deploy-target')
  })
  it('name 词序重排 → update(ERR-TMP-5501 同义重复判例)', () => {
    const existing = [mem({ name: 'ignore-err-tmp-5501', description: '临时告警不用管' })]
    const decision = decideConsolidationAction({ name: 'err-tmp-5501-ignore', description: '那个码不用管' }, existing)
    expect(decision.action).toBe('update')
  })
  it('描述复述(Jaccard≥0.7)→ update', () => {
    const existing = [mem({ name: 'old', description: 'user prefers python backend' })]
    const decision = decideConsolidationAction({ name: 'new-name', description: 'user prefers python backend dev' }, existing)
    expect(decision.action).toBe('update')
  })
  it('无匹配 → create', () => {
    const existing = [mem({ name: 'user-prefers-chinese', description: '中文交流' })]
    const decision = decideConsolidationAction({ name: 'pg-pool-lesson', description: '连接池教训' }, existing)
    expect(decision.action).toBe('create')
  })
  it('多候选时取最高分(name 精确 > 覆盖 > 复述)', () => {
    const existing = [
      mem({ name: 'alpha', description: '完全不同的话题' }),
      mem({ name: 'target-name', description: '别的事' }),
    ]
    const decision = decideConsolidationAction({ name: 'target-name', description: '全新描述' }, existing)
    expect(decision.action).toBe('update')
    if (decision.action === 'update') expect(decision.target.name).toBe('target-name')
  })
})

describe('descriptionSimilarity(单一实现点,行为等价旧版)', () => {
  it('中文后缀近重复 ≥0.7;同义改写 <0.7(合并语义:改写是真实更新非回声)', () => {
    expect(descriptionSimilarity('用户是准备面试的 Python 后端工程师', '用户是准备面试的 Python 后端工程师(补充)')).toBeGreaterThanOrEqual(0.7)
    expect(descriptionSimilarity('用户是准备面试的 Python 后端工程师', '用户为 Python 后端工程师,正在准备面试')).toBeLessThan(0.7)
  })
  it('不同主题 <0.2', () => {
    expect(descriptionSimilarity('用户偏好中文', 'PG 连接池压测教训')).toBeLessThan(0.2)
  })
  it('descriptionCoverage 有向:金标词被产物包含(跨语言以技术词锚定)', () => {
    expect(descriptionCoverage('psycopg2 连接 context manager', 'always use context manager for psycopg2 connections')).toBeGreaterThanOrEqual(0.75)
  })
})
