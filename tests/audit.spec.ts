/**
 * 0.9.0 注入审计测试:appendAudit 落盘与失败静默、readAudit 坏行/尾行容错、
 * aggregateAudit 聚合、registerInjectionAudit 按会话签名去重与截断名单、
 * renderMemoryIndexDetail 的 injected/truncated 解析。
 * 外部世界断言原则:读真实落盘文件。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, serializeMemory } from '../src/store.ts'
import type { Config } from '../src/index.ts'
import { renderMemoryIndexDetail } from '../src/prompt.ts'
import {
  appendAudit, readAudit, aggregateAudit, registerInjectionAudit, AUDIT_FILENAME,
} from '../src/audit.ts'

let base: string
let store: MemoryStore
let config: Config

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-audit-'))
  store = new MemoryStore(base)
  config = { maxBytes: 4096, enableUserScope: true, autoSummarize: false } as Config
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('appendAudit / readAudit', () => {
  it('追加 JSONL 行并可读回;坏行与不完整尾行跳过(官方 jsonl 恢复语义)', async () => {
    await appendAudit(base, { ts: 1, sessionId: 's1', cwd: '/a', injected: ['x'], truncated: [], bytes: 100 })
    await appendAudit(base, { ts: 2, sessionId: 's1', cwd: '/a', injected: ['x', 'y'], truncated: [], bytes: 120 })
    // 手工写坏行与不完整尾行(崩溃残留形态)
    await fsp.appendFile(join(base, AUDIT_FILENAME), 'not json\n{"ts":3}\n{"ts":4,"sessionId":"s2"', 'utf8')
    const entries = await readAudit(base)
    expect(entries.map(e => e.ts)).toEqual([1, 2]) // 坏行/不完整行/字段缺失行全部跳过
  })
  it('写入失败静默(只读目录)且不断链——后续追加仍可恢复', async () => {
    const badRoot = join(base, 'file-as-root') // 用文件占位目录名,mkdir/append 必败
    await fsp.writeFile(badRoot, 'x', 'utf8')
    await expect(appendAudit(badRoot, { ts: 1, sessionId: 's', cwd: '', injected: [], truncated: [], bytes: 0 })).resolves.toBeUndefined()
    await appendAudit(base, { ts: 5, sessionId: 'ok', cwd: '', injected: [], truncated: [], bytes: 0 }) // 链未断
    expect((await readAudit(base)).length).toBe(1)
  })
  it('并发追加(同进程串行链)全部落盘且行完整', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      appendAudit(base, { ts: i, sessionId: `s${i}`, cwd: '', injected: [`m${i}`], truncated: [], bytes: i })))
    const entries = await readAudit(base)
    expect(entries.length).toBe(20)
    expect(entries.map(e => e.ts)).toEqual(Array.from({ length: 20 }, (_, i) => i)) // 顺序保持
  })
})

describe('aggregateAudit', () => {
  it('会话数/注入数/注入榜降序/时间线截取', () => {
    const stats = aggregateAudit([
      { ts: 1, sessionId: 'a', cwd: '/p', injected: ['x', 'y'], truncated: ['z'], bytes: 10 },
      { ts: 2, sessionId: 'a', cwd: '/p', injected: ['x'], truncated: [], bytes: 5 },
      { ts: 3, sessionId: 'b', cwd: '/q', injected: ['x', 'y'], truncated: [], bytes: 8 },
    ])
    expect(stats.sessions).toBe(2)
    expect(stats.injections).toBe(3)
    expect(stats.avgBytes).toBe(8) // (10 + 5 + 8) / 3 四舍五入
    expect(stats.memories[0]).toEqual({ name: 'x', injectedCount: 3, truncatedCount: 0, lastTs: 3 })
    expect(stats.memories[1]?.name).toBe('y')
    // 只出现在截断名单里的记忆也留在榜内(截断次数是区分度来源)
    expect(stats.memories.find(m => m.name === 'z')).toEqual({ name: 'z', injectedCount: 0, truncatedCount: 1, lastTs: 0 })
    expect(stats.timeline.length).toBe(3)
    expect(stats.timeline[0]?.truncated).toBe(1) // 截断名单在首条(ts=1)
  })
})

describe('registerInjectionAudit(按会话签名去重)', () => {
  it('同集合第二次调用不追加;集合变化追加;cleanup 后同集合也会重新记', async () => {
    await store.write({ name: 'alpha', description: 'd', type: 'user', body: 'b' }, 'user')
    const audit = registerInjectionAudit(store, config, base)
    expect(audit.text('/w', 's1')).toContain('alpha')
    expect(audit.text('/w', 's1')).toContain('alpha') // 同集合:去重
    await audit.flush()
    let entries = await readAudit(base)
    expect(entries.length).toBe(1)
    await store.write({ name: 'beta', description: 'd2', type: 'user', body: 'b2' }, 'user')
    audit.text('/w', 's1') // 集合变化:追加
    audit.text('/w', 's2') // 新会话:追加
    await audit.flush()
    entries = await readAudit(base)
    expect(entries.length).toBe(3)
    audit.cleanup('s1')
    audit.text('/w', 's1') // 清理后重新记
    await audit.flush()
    expect((await readAudit(base)).length).toBe(4)
  })
  it('无记忆(cwd 无索引)返回空文本且不写审计', async () => {
    const audit = registerInjectionAudit(store, config, base)
    expect(audit.text('/nowhere', 's1')).toBe('')
    expect(await readAudit(base)).toEqual([])
  })
})

describe('renderMemoryIndexDetail(注入/截断名单)', () => {
  it('预算内:injected=全量,truncated 空;text 与旧 renderMemoryIndexText 一致', async () => {
    await store.write({ name: 'alpha', description: 'd', type: 'user', body: 'b' }, 'user')
    await store.write({ name: 'beta', description: 'd2', type: 'user', body: 'b2' }, 'user')
    const detail = renderMemoryIndexDetail(store, config, '/w')
    expect(detail.injected.sort()).toEqual(['alpha', 'beta'])
    expect(detail.truncated).toEqual([])
    expect(detail.text).toContain('alpha')
    expect(detail.textBytes).toBe(Buffer.byteLength(detail.text, 'utf8'))
  })
  it('超预算:truncated 名单 = 全量 - 保留(审计的核心数据)', async () => {
    // 极小预算强制截断;1024 是预算下限(见 prompt.ts Math.max),用下限触发
    const tight = { ...config, maxBytes: 1024 } as Config
    for (let i = 0; i < 30; i++) {
      await store.write({ name: `mem-${String(i).padStart(2, '0')}`, description: `${'长描述'.repeat(12)}-${i}`, type: 'user', body: 'b' }, 'user')
    }
    const detail = renderMemoryIndexDetail(store, tight, '/w')
    expect(detail.text).toContain('index truncated')
    expect(detail.truncated.length).toBeGreaterThan(0)
    expect(detail.injected.length + detail.truncated.length).toBe(30) // 名单守恒
    for (const name of detail.injected) expect(detail.truncated).not.toContain(name)
  })
  it('title 含字面 ](fake.md) 不劫持名单解析(审查回归:行首锚定+贪婪回溯)', async () => {
    await store.write({ name: 'normal-mem', description: 'd', type: 'user', body: 'b' }, 'user')
    await store.write({ name: 'real-name', title: 'fix [docs](api.md) link', description: 'd', type: 'user', body: 'b' }, 'user')
    const detail = renderMemoryIndexDetail(store, config, '/w')
    expect(detail.injected.sort()).toEqual(['normal-mem', 'real-name']) // 幽灵名 api 不得出现
  })
  it('跨作用域同名遇截断:truncated 按 multiset 差集守恒(审查回归)', async () => {
    const tight = { ...config, maxBytes: 1024, enableUserScope: true } as Config
    const cwd = 'D:\\dup-proj'
    await store.write({ name: 'dup', description: 'short', type: 'user', body: 'b' }, 'user')
    await store.write({ name: 'dup', description: `${'超长'.repeat(300)}`, type: 'project', body: 'b' }, 'project', cwd)
    const detail = renderMemoryIndexDetail(store, tight, cwd)
    expect(detail.injected.length + detail.truncated.length).toBe(2) // 守恒不被同名打破
  })
  it('注入转空后同集合回归会重新记账(审查回归:签名复位)', async () => {
    await store.write({ name: 'alpha', description: 'd', type: 'user', body: 'b' }, 'user')
    const audit = registerInjectionAudit(store, config, base)
    audit.text('/w', 's1')
    await audit.flush()
    await store.delete('alpha', 'user')
    audit.text('/w', 's1') // 空注入:复位签名
    await store.write({ name: 'alpha', description: 'd', type: 'user', body: 'b' }, 'user')
    audit.text('/w', 's1') // 回归:必须重新记账
    await audit.flush()
    const entries = await readAudit(base)
    expect(entries.length).toBe(2)
  })
})
