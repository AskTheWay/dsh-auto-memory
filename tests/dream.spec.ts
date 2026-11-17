/**
 * 1.10.0「记忆沉淀」测试:dreaming 建议清单纯函数层(提案解析/库指纹/
 * 确定性近重复/提示组装)+ proposals 读写容错 + 应用路由(merge 谱系/
 * promote/retire)。外部世界断言原则:读真实落盘文件。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProposals, libraryFingerprint, buildDreamPrompt, parseProposals, deterministicMergeCandidates, PROPOSALS_FILENAME, type ProposalsFile } from '../src/dream.ts'

let base: string

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-dream-'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('提案解析与容错', () => {
  it('parseProposals:合法数组逐项校验;单元素 merge 拒绝;非 JSON 返回空', () => {
    const raw = JSON.stringify([
      { kind: 'merge', targets: ['a', 'b'], summary: '合并', reason: '同主题' },
      { kind: 'promote', targets: ['c'], summary: '置顶', reason: '高频' },
      { kind: 'retire', targets: ['d'], summary: '停用', reason: '过时' },
      { kind: 'merge', targets: ['x'], summary: '缺目标', reason: '应拒' },
      { kind: 'hack', targets: ['y'], summary: '?', reason: '?' },
    ])
    const out = parseProposals(raw, 'fp')
    expect(out.map(p => p.kind)).toEqual(['merge', 'promote', 'retire'])
    expect(out[0]!.targets).toEqual(['a', 'b'])
    expect(parseProposals('not json at all', 'fp')).toEqual([])
    expect(parseProposals('前置文本 [ ] 后置', 'fp')).toEqual([])
  })
  it('loadProposals:合法文件往返;损坏/缺失返回 null;字段清洗(截断)', async () => {
    const file: ProposalsFile = {
      generatedAt: 1_760_000_000_000,
      fingerprint: 'a,b,c',
      proposals: [{ id: 'p0-11', kind: 'merge', targets: ['a', 'b'], summary: 's'.repeat(300), reason: 'r'.repeat(600) }],
    }
    await fsp.writeFile(join(base, PROPOSALS_FILENAME), JSON.stringify(file), 'utf8')
    const loaded = await loadProposals(base)
    expect(loaded?.fingerprint).toBe('a,b,c')
    expect(loaded?.proposals[0]!.summary.length).toBeLessThanOrEqual(160)
    expect(loaded?.proposals[0]!.reason.length).toBeLessThanOrEqual(400)
    await fsp.writeFile(join(base, PROPOSALS_FILENAME), '{broken', 'utf8')
    expect(await loadProposals(base)).toBeNull()
    await fsp.rm(join(base, PROPOSALS_FILENAME))
    expect(await loadProposals(base)).toBeNull()
  })
})

describe('确定性层', () => {
  it('libraryFingerprint:name 集合排序稳定——库变化提案即过期', () => {
    const a = [{ name: 'b' }, { name: 'a' }, { name: 'c' }]
    expect(libraryFingerprint(a)).toBe('a,b,c')
    expect(libraryFingerprint([{ name: 'a' }])).not.toBe(libraryFingerprint(a))
  })
  it('deterministicMergeCandidates:描述 ≥0.9 相似的对子按分降序;不相似不进', () => {
    const records = [
      { name: 'm1', description: '用户偏好 psycopg2 连接池 压测前预热' },
      { name: 'm2', description: '用户偏好 psycopg2 连接池 压测前预热' },
      { name: 'm3', description: '完全不同的另一件事 关于部署流程' },
    ]
    const pairs = deterministicMergeCandidates(records)
    expect(pairs.length).toBe(1)
    expect(pairs[0]).toMatchObject({ a: 'm1', b: 'm2' })
  })
  it('buildDreamPrompt:含每条记忆行与 kind 枚举说明;过滤 disputed/superseded', () => {
    const records: Array<{ name: string, description: string, type: 'user' | 'project', reads: number, status?: 'verified' | 'superseded' }> = [
      { name: 'ok', description: 'd', type: 'user', reads: 2, status: 'verified' },
      { name: 'superseded-item', description: 'd2', type: 'user', reads: 0, status: 'superseded' },
      { name: 'plain', description: 'd3', type: 'project', reads: 1 },
    ]
    const prompt = buildDreamPrompt(records)
    expect(prompt).toContain('ok')
    expect(prompt).toContain('plain')
    expect(prompt).not.toContain('superseded-item')
    expect(prompt).toContain('"kind":"merge"')
  })
})

describe('审查修复回归(1.10.0)', () => {
  it('parseProposals targets 去重:[a,a] 拒绝(防自我 supersede)', () => {
    const out = parseProposals(JSON.stringify([{ kind: 'merge', targets: ['a', 'a'], summary: 's', reason: 'r' }]), 'fp')
    expect(out).toEqual([]) // 去重后长度 1 < 2 → merge 拒绝
  })
})
