/**
 * L0-② 注入信噪比(确定性;characterization test)。
 * 回答:预算截断保留的是相关记忆还是位置靠前的记忆?
 *
 * 已知局限(本测试的作用就是把它钉死为 baseline):
 * 当前截断按索引行序(name 字典序)——与相关性无关。探针(name 前缀靠后)
 * 在预算压力下会被截掉。记录该数字;引入 pinned 优先 / 三因子排序后,
 * 更新断言为更高保留率,即完成一次评测驱动的迭代。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../../src/store.ts'
import { renderMemoryIndexText } from '../../src/prompt.ts'
import { bytes, makeMemories, seedStore } from './helpers.ts'

const CWD = 'D:\\work\\eval-snr'

let root: string

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'eval-snr-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('injection-snr', () => {
  it('预算充足:探针 100% 保留,信噪比 = 无关条目占比(结构性数字)', async () => {
    // 20 条,每第 4 条为探针(5 条);maxBytes 放得下全部
    const store = new MemoryStore(join(root, 'roomy'))
    const memories = makeMemories(20, 42, 4)
    await seedStore(store, memories, 'project', CWD)
    const injected = renderMemoryIndexText(store, { maxBytes: 8192, enableUserScope: false } as never, CWD)
    for (const m of memories.filter(x => x.probe)) {
      expect(injected).toContain(`(${m.name}.md)`)
    }
    // 行数从索引真相统计(injected 还含 policy 的 "- " 行,不能直接数)
    const indexLines = (store.readIndexSync('project', CWD) ?? '').split('\n').filter(l => l.startsWith('- '))
    expect(indexLines).toHaveLength(20)
    // 预算充足时"信噪比"即结构占比:无关 15/20 = 75%(无检索筛选,全量注入)
    console.log('预算充足:注入 20 条,探针 5,无关占比 75%')
  })

  it('预算压力(半量截断):探针保留率 = 位置式截断的 baseline(已知缺陷钉板)', async () => {
    // 60 条、15 探针;maxBytes 压到约可容纳一半
    const store = new MemoryStore(join(root, 'tight'))
    const memories = makeMemories(60, 42, 4)
    await seedStore(store, memories, 'project', CWD)
    const full = renderMemoryIndexText(store, { maxBytes: Number.MAX_SAFE_INTEGER, enableUserScope: false } as never, CWD)
    const halfBudget = Math.ceil(bytes(full) / 2)
    const injected = renderMemoryIndexText(store, { maxBytes: halfBudget, enableUserScope: false } as never, CWD)
    const retained = memories.filter(m => m.probe && injected.includes(`(${m.name}.md)`))
    const lines = injected.split('\n').filter(l => l.startsWith('- '))
    // 截断确实发生
    expect(lines.length).toBeLessThan(60)
    // characterization:字典序截断下,探针按 name 均匀分散,保留率 ≈ 截断比例附近
    // (记录实测值;引入相关性排序后,本断言应更新为显著更高)
    console.log(`预算压力:保留 ${lines.length}/60 条,探针保留 ${retained.length}/15(${Math.round((retained.length / 15) * 100)}%)`)
    expect(retained.length).toBeGreaterThan(0)
    expect(retained.length).toBeLessThanOrEqual(15)
  })

  it('pinned 优先截断(评测驱动迭代闭环):探针置顶后,同预算压力下保留率 ≥ 80%', async () => {
    // 同一 seed 同一批 60 条;把 15 条探针全部置顶,其余不变
    const store = new MemoryStore(join(root, 'pinned'))
    const memories = makeMemories(60, 42, 4).map(m => (m.probe ? { ...m, pinned: true } : m))
    await seedStore(store, memories, 'project', CWD)
    const full = renderMemoryIndexText(store, { maxBytes: Number.MAX_SAFE_INTEGER, enableUserScope: false } as never, CWD)
    const halfBudget = Math.ceil(bytes(full) / 2)
    const injected = renderMemoryIndexText(store, { maxBytes: halfBudget, enableUserScope: false } as never, CWD)
    const retained = memories.filter(m => m.probe && injected.includes(`(${m.name}.md)`))
    // 闭环断言:同一预算下,置顶探针保留率从 baseline(~38%)跃升至 ≥80%
    expect(retained.length / 15).toBeGreaterThanOrEqual(0.8)
    // 置顶条目带 📌 标记(模型可见的保护语义)
    const pinnedLine = injected.split('\n').find(l => l.includes('📌'))
    expect(pinnedLine).toBeDefined()
    console.log(`pinned 闭环:同预算下探针保留 ${retained.length}/15(${Math.round((retained.length / 15) * 100)}%)`)
  })
})
