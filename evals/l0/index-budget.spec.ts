/**
 * L0-① 索引注入预算曲线(确定性,无 LLM)。
 * 回答:记忆攒到几十上百条时,注入是否仍被预算控制?软淘汰是否让曲线回落?
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, INDEX_FILENAME } from '../../src/store.ts'
import { renderMemoryIndexText } from '../../src/prompt.ts'
import { bytes, makeMemories, seedStore } from './helpers.ts'

const CWD = 'D:\\work\\eval-budget'

let root: string

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'eval-budget-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('index-budget', () => {
  it('曲线:N=20/50/100/200 注入体积均 ≤ maxBytes,超预算时截断标记存在', async () => {
    const rows: Array<[number, number]> = []
    for (const n of [20, 50, 100, 200]) {
      const store = new MemoryStore(join(root, `n${n}`))
      await seedStore(store, makeMemories(n, 1000 + n), 'project', CWD)
      const injected = renderMemoryIndexText(store, { maxBytes: 4096, enableUserScope: false, autoSummarize: false } as never, CWD)
      rows.push([n, bytes(injected)])
      // 硬断言:无论多少条,注入永不超预算(截断兜底)
      expect(bytes(injected)).toBeLessThanOrEqual(4096)
      if (bytes(renderMemoryIndexText(store, { maxBytes: Number.MAX_SAFE_INTEGER, enableUserScope: false } as never, CWD)) > 4096) {
        expect(injected).toContain('index truncated')
      }
    }
    // 数字随测试输出,供 evals/README 的 baseline 表更新
    console.table(rows.map(([n, b]) => ({ memories: n, injectedBytes: b })))
  })

  it('软淘汰回落:过半记忆超龄零引用后,注入体积显著下降且文件全保留', async () => {
    const store = new MemoryStore(join(root, 'stale'), { staleAfterDays: 30 })
    const memories = makeMemories(40, 7)
    await seedStore(store, memories, 'project', CWD)
    // 改造一半为超龄零引用(手改 updated 字段)
    const dir = store.dir('project', CWD)
    const ancient = Date.now() - 60 * 86_400_000
    for (const m of memories.slice(0, 20)) {
      const file = join(dir, `${m.name}.md`)
      const raw = await fsp.readFile(file, 'utf8')
      await fsp.writeFile(file, raw.replace(/^updated: \d+$/m, `updated: ${ancient}`), 'utf8')
    }
    await store.refreshIndex('project', CWD)
    const after = store.readIndexSync('project', CWD) ?? ''
    expect(after.split('\n').filter(l => l.startsWith('- '))).toHaveLength(20)
    // 文件与索引文件本体全部保留(40 条记忆 + MEMORY.md)
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md') && f !== INDEX_FILENAME)
    expect(files).toHaveLength(40)
  })

  it('空库零注入:无记忆时输出为空串(零 token 占用的硬保证)', async () => {
    const store = new MemoryStore(join(root, 'empty'))
    const injected = renderMemoryIndexText(store, { maxBytes: 4096, enableUserScope: true } as never, CWD)
    expect(injected).toBe('')
    expect(bytes(injected)).toBe(0)
  })
})
