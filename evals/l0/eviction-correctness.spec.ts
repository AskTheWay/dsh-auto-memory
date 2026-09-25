/**
 * L0-③ 淘汰零误杀(确定性)。
 * 四类混合场景断言:软淘汰只隐藏"超龄且零引用"一类;文件永不丢失;读取复活。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../../src/store.ts'

const CWD = 'D:\\work\\eval-evict'
const OLD = Date.now() - 200 * 86_400_000

let root: string
let store: MemoryStore

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'eval-evict-'))
  store = new MemoryStore(root, { staleAfterDays: 90 })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('eviction-correctness', () => {
  it('四类混合:只有"超龄零引用"被隐藏,误杀数 = 0', async () => {
    // A 超龄零引用(应隐藏)/ B 超龄但被读过(应保留)/ C 新写入(应保留)/ D 无元数据旧文件(应保留)
    await store.write({ name: 'a-stale-zero-read', description: 'A', type: 'user', body: 'x' }, 'project', CWD)
    await store.write({ name: 'b-stale-but-read', description: 'B', type: 'user', body: 'x' }, 'project', CWD)
    await store.write({ name: 'c-fresh', description: 'C', type: 'user', body: 'x' }, 'project', CWD)
    const dir = store.dir('project', CWD)
    // A、B 改为超龄
    for (const name of ['a-stale-zero-read', 'b-stale-but-read']) {
      const file = join(dir, `${name}.md`)
      const raw = await fsp.readFile(file, 'utf8')
      await fsp.writeFile(file, raw.replace(/^updated: \d+$/m, `updated: ${OLD}`), 'utf8')
    }
    // D:无生命周期元数据的手写旧文件
    await fsp.writeFile(join(dir, 'd-legacy.md'), '---\nname: d-legacy\ndescription: D\n---\n\nx', 'utf8')
    // B 读取一次(reads: 1)
    await store.touch('b-stale-but-read', 'project', CWD)
    // 触发重算(touch 已触发;再显式刷新一次确保 D 参与)
    await store.refreshIndex('project', CWD)

    const index = store.readIndexSync('project', CWD) ?? ''
    expect(index).not.toContain('a-stale-zero-read') // 唯一应隐藏的
    expect(index).toContain('b-stale-but-read')
    expect(index).toContain('c-fresh')
    expect(index).toContain('d-legacy')
    // 零误杀硬断言:文件层面 4 条全在
    expect((await store.list('project', CWD)).length).toBe(4)
  })

  it('隐藏后读取即复活(touch 重建索引),且此后不再被淘汰', async () => {
    await store.write({ name: 'revive-me', description: 'R', type: 'user', body: 'x' }, 'project', CWD)
    const dir = store.dir('project', CWD)
    const file = join(dir, 'revive-me.md')
    const raw = await fsp.readFile(file, 'utf8')
    await fsp.writeFile(file, raw.replace(/^updated: \d+$/m, `updated: ${OLD}`), 'utf8')
    await store.refreshIndex('project', CWD)
    expect(store.readIndexSync('project', CWD)).toBeNull() // 唯一条目被隐藏 → 索引移除
    await store.touch('revive-me', 'project', CWD)        // 读取:reads=1 → 复活
    expect(store.readIndexSync('project', CWD)).toContain('revive-me')
    // 再老化一次也不隐藏(reads>0 永久豁免)
    const raw2 = await fsp.readFile(file, 'utf8')
    await fsp.writeFile(file, raw2.replace(/^updated: \d+$/m, `updated: ${OLD}`), 'utf8')
    await store.refreshIndex('project', CWD)
    expect(store.readIndexSync('project', CWD)).toContain('revive-me')
  })
})
