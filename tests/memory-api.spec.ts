/**
 * 宿主 Web API 测试(0.10.0):不启服务器,用假 Connection 收集路由处理器,
 * 直接以 Request 调用。覆盖 import.claude.scan 的逐条状态返回、apply 的
 * "导入 + 撤销"一次往返、严格入参校验与 nothing to import 分支。
 * 外部世界断言原则:撤销后读真实落盘文件确认已删除。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore, projectKey } from '../src/store.ts'
import { registerMemoryApi } from '../src/memory-api.ts'

const BASE = '/api/auto-memory'
const CWD = 'D:\\api-proj'
const SLUG = 'D--api-proj'

const CLAUDE_MEMORY = `---
name: sample-memory
description: 样例记忆
metadata:
  node_type: memory
  type: project
  modified: 2026-09-01T00:00:00.000Z
---

# 标题

正文事实。
`

interface RegisteredRoute {
  path: string
  fetch: (request: Request) => Promise<Response>
}

let base: string
let home: string
let store: MemoryStore
let routes: Map<string, RegisteredRoute['fetch']>

function mount(homeDir: string, staleAfterDays = 0): void {
  routes = new Map()
  const connection = {
    fetch: {
      register: (route: RegisteredRoute): void => { routes.set(route.path, route.fetch) },
    },
  }
  // 只需 connection 服务的假 Context:registerMemoryApi 只调用 ctx.get('connection')
  const ctx = { get: (name: string) => (name === 'connection' ? connection : undefined) } as unknown as Context
  registerMemoryApi(ctx, store, join(base, 'memory-root'), { maxBytes: 4096, homeDir, staleAfterDays })
}

async function seedClaude(): Promise<void> {
  const projectDir = join(home, '.claude', 'projects', SLUG)
  const memoryDir = join(projectDir, 'memory')
  await fsp.mkdir(memoryDir, { recursive: true })
  await fsp.writeFile(join(memoryDir, 'alpha.md'), CLAUDE_MEMORY, 'utf8')
  await fsp.writeFile(join(projectDir, 's.jsonl'), JSON.stringify({ cwd: CWD }), 'utf8')
}

function post(path: string, payload: unknown): Promise<Response> {
  const handler = routes.get(`${BASE}/${path}`)
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  return handler(new Request(`http://local${BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-memory-api-'))
  home = join(base, 'home')
  store = new MemoryStore(join(base, 'memory-root'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('import.claude.scan / apply(0.10.0)', () => {
  it('scan 返回逐条文件名/记忆名/摘要/状态;初始 pending', async () => {
    await seedClaude()
    mount(home)
    const handler = routes.get(`${BASE}/import.claude.scan`)
    expect(handler).toBeDefined()
    const response = await handler!(new Request(`http://local${BASE}/import.claude.scan`))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      found: boolean
      totalImportable: number
      projects: Array<{ slug: string; files: Array<Record<string, unknown>> }>
    }
    expect(body.found).toBe(true)
    expect(body.totalImportable).toBe(1)
    expect(body.projects[0]?.slug).toBe(SLUG)
    expect(body.projects[0]?.files[0]).toMatchObject({
      file: 'alpha.md', name: 'sample-memory', description: '样例记忆', type: 'project', state: 'pending',
    })
  })

  it('apply:一次往返导入选中条目;再 apply 取消勾选 → 撤销删除;状态随之变化', async () => {
    await seedClaude()
    mount(home)

    const imported = await post('import.claude.apply', {
      items: [{ slug: SLUG, file: 'alpha.md' }], revoke: [], allToUser: false,
    })
    expect(imported.status).toBe(200)
    const importResult = await imported.json() as { imported: number; revoked: number }
    expect(importResult.imported).toBe(1)
    expect(importResult.revoked).toBe(0)

    // 落盘:项目层目录 + origin 溯源
    const target = join(join(base, 'memory-root'), projectKey(CWD), 'sample-memory.md')
    const raw = await fsp.readFile(target, 'utf8')
    expect(raw).toContain('file: alpha.md')

    // 重新扫描:状态 imported
    const scanHandler = routes.get(`${BASE}/import.claude.scan`)!
    const rescanned = await (await scanHandler(new Request(`http://local${BASE}/import.claude.scan`))).json() as {
      projects: Array<{ files: Array<{ state: string }> }>
    }
    expect(rescanned.projects[0]?.files[0]?.state).toBe('imported')

    // 取消勾选(revoke)后删除记忆文件
    const revoked = await post('import.claude.apply', {
      items: [], revoke: [{ slug: SLUG, file: 'alpha.md' }], allToUser: false,
    })
    const revokeResult = await revoked.json() as { revoked: number; imported: number }
    expect(revokeResult.revoked).toBe(1)
    expect(revokeResult.imported).toBe(0)
    expect(await store.read('sample-memory', 'project', CWD)).toBeNull()
    await expect(fsp.access(target)).rejects.toThrow()
  })

  it('apply 严格校验 items/revoke 形状:畸形目标 400(fail-closed,不降级成全量)', async () => {
    await seedClaude()
    mount(home)
    for (const payload of [
      { items: [{}], revoke: [], allToUser: false },
      { items: [], revoke: [{ slug: SLUG }], allToUser: false },
      { items: 'all', revoke: [], allToUser: false },
      { items: [], revoke: [null], allToUser: false },
    ]) {
      expect((await post('import.claude.apply', payload)).status).toBe(400)
    }
    // 未产生任何记忆
    expect(await store.list('project', CWD)).toHaveLength(0)
  })

  it('无 Claude Code 记忆 → apply 400 nothing to import', async () => {
    mount(join(base, 'no-claude-home'))
    const response = await post('import.claude.apply', { items: [], revoke: [], allToUser: false })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('nothing to import')
  })
})

describe('groups.list 显示逻辑(0.10.0)', () => {
  it('记忆按注入顺序返回(pinned → 三因子分 → name),并给出净预算 budgetBytes', async () => {
    await store.write({ name: 'z-low', description: '低分', type: 'reference', body: 'x', importance: 1 }, 'user')
    await store.write({ name: 'a-high', description: '高分', type: 'user', body: 'x', importance: 10 }, 'user')
    await store.write({ name: 'm-pinned', description: '置顶', type: 'feedback', body: 'x', importance: 1, pinned: true }, 'user')
    mount(home)
    const handler = routes.get(`${BASE}/groups.list`)
    expect(handler).toBeDefined()
    const body = await (await handler!(new Request(`http://local${BASE}/groups.list`))).json() as {
      groups: Array<{ memories: Array<{ name: string, stale: boolean }> }>
      maxBytes: number
      budgetBytes: number
    }
    expect(body.maxBytes).toBe(4096)
    // 净预算必须小于整段预算(扣掉写入指导+协议壳),且不能是负数
    expect(body.budgetBytes).toBeGreaterThan(0)
    expect(body.budgetBytes).toBeLessThan(body.maxBytes)
    // 面板顺序 = renderIndexBody 的顺序,而不是字母序
    expect(body.groups[0]?.memories.map(memory => memory.name)).toEqual(['m-pinned', 'a-high', 'z-low'])
    expect(body.groups[0]?.memories.every(memory => memory.stale === false)).toBe(true)
  })

  it('陈旧零引用记忆仍可见但标 stale(与"生效"区分)', async () => {
    await store.write({ name: 'ancient', description: '旧', type: 'user', body: 'x' }, 'user')
    const file = join(join(base, 'memory-root'), '_user', 'ancient.md')
    const raw = await fsp.readFile(file, 'utf8')
    const ancient = Date.now() - 100 * 86_400_000
    await fsp.writeFile(file, raw.replace(/^updated: \d+$/m, `updated: ${ancient}`), 'utf8')
    mount(home, 30)
    const handler = routes.get(`${BASE}/groups.list`)!
    const body = await (await handler(new Request(`http://local${BASE}/groups.list`))).json() as {
      groups: Array<{ memories: Array<{ name: string, stale: boolean }> }>
    }
    expect(body.groups.find(group => group.memories.some(memory => memory.name === 'ancient')))
      .toBeDefined()
    expect(body.groups.flatMap(group => group.memories).find(memory => memory.name === 'ancient')?.stale).toBe(true)
  })
})
