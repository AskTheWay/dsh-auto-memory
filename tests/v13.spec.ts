/**
 * 1.3.0 三件测试:#17 价值过滤(isChitchat 双条件/minImportance 门槛/
 * echo 豁免)、#18 相关性截断(重排语义/KV-safe 兼容)、#19 演化谱系
 * (detectContradictions 强信号/supersede 两步写/谱系往返与继承/
 * pickBestMatch 跳过 superseded)。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../src/store.ts'
import type { Config } from '../src/index.ts'
import { renderMemoryIndexDetail } from '../src/prompt.ts'
import { isChitchat } from '../src/consolidate.ts'
import { detectContradictions, pickBestMatch } from '../src/matching.ts'
import type { MemoryRecord } from '../src/types.ts'

let base: string
let store: MemoryStore
let config: Config

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-13-'))
  store = new MemoryStore(base)
  config = { maxBytes: 4096, enableUserScope: true, autoSummarize: false, minImportance: 4 } as Config
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('#17 isChitchat(强问候 AND 剥问候后无实质内容)', () => {
  it('纯寒暄命中', () => {
    expect(isChitchat('你好呀,吃了吗')).toBe(true)
    expect(isChitchat('thanks!')).toBe(true)
    expect(isChitchat('好的。')).toBe(true)
    expect(isChitchat('收到,谢谢')).toBe(true)
  })
  it('宁漏勿误门槛:"今天天气不错"(6 字)按新设计放行——含可固化内容的短寒暄不拦', () => {
    // 审查 45% 误报教训后的设计取舍:CJK >=6 即有实质;5 字以下的真·纯寒暄才拦
    expect(isChitchat('你好,今天天气不错')).toBe(false)
    expect(isChitchat('你好,早点休息')).toBe(true) // 4 字
  })
  it('问候+技术内容不误伤(合法决策/偏好)', () => {
    expect(isChitchat('好的,那就部署到 Bun 上')).toBe(false)
    expect(isChitchat('你好,psycopg2 连接池的问题解决了吗')).toBe(false)
    expect(isChitchat('谢谢!git 分支名用 kebab-case')).toBe(false)
  })
  it('无问候模式的技术闲谈不拦(漏报优于误报)', () => {
    expect(isChitchat('这个项目挺有意思的')).toBe(false)
  })
})

describe('#18 相关性截断', () => {
  it('不传 query:行为与旧版逐字节一致(KV-safe 兼容)', async () => {
    for (let i = 0; i < 30; i++) {
      await store.write({ name: `mem-${String(i).padStart(2, '0')}`, description: `描述 ${i} ${'长'.repeat(20)}`, type: 'user', body: 'b' }, 'user')
    }
    const tight = { ...config, maxBytes: 2048 } as Config
    const a = renderMemoryIndexDetail(store, tight, '/w')
    const b = renderMemoryIndexDetail(store, tight, '/w')
    expect(a.text).toBe(b.text)
    expect(a.truncated.length).toBeGreaterThan(0)
  })
  it('带 query:相关行优先保留(pinned 仍领先;展示序恢复)', async () => {
    await store.write({ name: 'pg-lesson', description: 'PostgreSQL 连接池部署教训', type: 'user', body: 'b' }, 'user')
    await store.write({ name: 'ui-color', description: '前端配色方案', type: 'user', body: 'b' }, 'user')
    for (let i = 0; i < 20; i++) {
      await store.write({ name: `fill-${String(i).padStart(2, '0')}`, description: `填充 ${i} ${'长'.repeat(18)}`, type: 'user', body: 'b' }, 'user')
    }
    // 预算收紧到只容 ~10 行:pg-lesson(相关)必须活,ui-color(不相关)可被挤出
    const tight = { ...config, maxBytes: 1400 } as Config
    const detail = renderMemoryIndexDetail(store, tight, '/w', 'PostgreSQL 连接池 部署')
    expect(detail.injected).toContain('pg-lesson')
    expect(detail.injected.length).toBeLessThan(22) // 确实发生截断
    expect(detail.injected.length + detail.truncated.length).toBe(22) // 名单守恒
    // KV-safe:同 query 两次渲染字节一致
    const again = renderMemoryIndexDetail(store, tight, '/w', 'PostgreSQL 连接池 部署')
    expect(detail.text).toBe(again.text)
  })
})

describe('#19 detectContradictions(强信号纪律)', () => {
  it('日期矛盾:两侧日期集不相交', () => {
    const signals = detectContradictions(
      { description: '部署定在 2026-10-20', body: '' },
      { description: '部署定在 2026-09-15', body: '' },
    )
    expect(signals.some(s => s.kind === 'date')).toBe(true)
  })
  it('同单位数值不同 → 矛盾', () => {
    const signals = detectContradictions(
      { description: '缓存 2GB', body: '' },
      { description: '缓存 8GB', body: '' },
    )
    expect(signals.some(s => s.kind === 'number')).toBe(true)
  })
  it('普通更新(无日期/数值分歧)不判矛盾', () => {
    expect(detectContradictions(
      { description: '用户偏好中文', body: '' },
      { description: '用户偏好中文交流', body: '' },
    )).toEqual([])
  })
  it('日期相同(时间演进中性)不判矛盾', () => {
    expect(detectContradictions(
      { description: '2026-10-20 部署完成', body: '' },
      { description: '2026-10-20 部署记录', body: '' },
    )).toEqual([])
  })
})

describe('#19 演化谱系落盘与语义', () => {
  it('supersededBy/supersedes 往返 + write 继承(面板重写不剥链)', async () => {
    await store.write({ name: 'new', description: 'd', type: 'user', body: 'b', supersedes: 'old' }, 'user')
    // 面板式整条重写(不带谱系字段)
    await store.write({ name: 'new', description: 'd', type: 'user', body: 'b' }, 'user')
    expect((await store.read('new', 'user'))?.supersedes).toBe('old')
    const old = await store.write({ name: 'old', description: 'd2', type: 'user', body: 'b2', status: 'superseded', supersededBy: 'new' }, 'user')
    expect(old?.status).toBe('superseded')
    expect(old?.supersededBy).toBe('new')
    // 落盘往返
    const raw = await fsp.readFile(join(base, '_user', 'old.md'), 'utf8')
    expect(raw).toContain('supersededBy: new')
  })
  it('离开 superseded 态清 supersededBy(链只活在被取代态)', async () => {
    await store.write({ name: 'old', description: 'd', type: 'user', body: 'b', status: 'superseded', supersededBy: 'new' }, 'user')
    await store.write({ name: 'old', description: 'd', type: 'user', body: 'b', status: 'verified' }, 'user')
    const after = await store.read('old', 'user')
    expect(after?.status).toBe('verified')
    expect(after?.supersededBy).toBeUndefined()
  })
  it('superseded 不注入;谱系徽章数据可从 readGroup 形状取(端到端)', async () => {
    await store.write({ name: 'live', description: '活记忆', type: 'user', body: 'b' }, 'user')
    await store.write({ name: 'dead', description: '死记忆', type: 'user', body: 'b', status: 'superseded', supersededBy: 'live' }, 'user')
    const detail = renderMemoryIndexDetail(store, config, '/w')
    expect(detail.injected).toContain('live')
    expect(detail.injected).not.toContain('dead')
  })
  it('pickBestMatch 跳过 superseded(防新内容写进永不注入文件)', () => {
    const record = (over: Partial<MemoryRecord>): MemoryRecord => ({ name: 'x', description: 'd', type: 'user', body: 'b', scope: 'user', ...over })
    const list = [record({ name: 'target', status: 'superseded' })]
    // 'target' 精确同名本应 score=1 最优;superseded 被跳过后无匹配
    expect(pickBestMatch({ name: 'target', description: 'd' }, list)).toBeNull()
    // 混入合法项时:匹配的是合法项而非 superseded(basis 不为 exact-name)
    const mixed = [record({ name: 'target', status: 'superseded' }), record({ name: 'unrelated', description: 'd' })]
    const match = pickBestMatch({ name: 'target', description: 'd' }, mixed)
    expect(match?.existing.name).toBe('unrelated')
  })
})
