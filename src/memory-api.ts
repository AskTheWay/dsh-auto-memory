/**
 * 宿主半的 Web API:浏览器面板经 Connection 认证围栏读写记忆。
 *
 * 形态(源码调研结论,见 docs/api-reports.md):
 * - `ctx.connection.fetch.register` 注册路由(dsh 认证围栏内,loopback 默认);
 * - 路径用点号分段(/api/auto-memory/memories.list)避开网关的两段认领形状;
 * - 机会式获取 connection:非 web 组合(headless/测试栈)没有该服务,静默 no-op;
 * - 事件白名单硬编码:浏览器侧靠操作后 refetch 刷新,不做推送。
 *
 * 作用域定位:项目层目录由 cwd 派生(projectKey 单向),因此:
 * - list 扫描 memoryDir 下全部目录(用户级 + 每个项目 slug),全局只读总览;
 * - 写/删操作由浏览器带 ?cwd=(从当前会话快照取得),走 store 原生路径。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型:Connection 服务(fetch 路由注册面)
import type {} from '@deepseek-ai/dsh-client-connection'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, INDEX_FILENAME, parseMemory, projectKey } from './store.ts'
import { normalizeName } from './store.ts'
import type { MemoryScope, MemoryType } from './types.ts'
import { USER_SCOPE_DIR } from './types.ts'

/** 面板条目(浏览器可见的字段子集)。 */
export interface PanelMemory {
  name: string
  title?: string
  description: string
  type: MemoryType
  pinned: boolean
  reads: number
  updatedMs?: number
  bytes: number
}

/** 一组记忆(用户级或某个项目 slug)。 */
export interface PanelGroup {
  key: string
  scope: MemoryScope
  /** 项目目录名(--slug--);用户层为 _user。 */
  slug: string
  /** 该组是否对应当前会话的工作区(可执行写/删操作)。 */
  current?: boolean
  memories: PanelMemory[]
  indexBytes: number
  indexText: string | null
}

const BASE = '/api/auto-memory'

/** 列出一个目录组(读文件,畸形/符号链接跳过——与 store.list 同纪律)。 */
async function readGroup(dir: string, scope: MemoryScope, slug: string): Promise<PanelGroup> {
  const group: PanelGroup = { key: slug, scope, slug, memories: [], indexBytes: 0, indexText: null }
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return group
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const file = join(dir, entry)
    const raw = await fsp.readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    if (entry.toLowerCase() === INDEX_FILENAME.toLowerCase()) {
      group.indexBytes = Buffer.byteLength(raw, 'utf8')
      group.indexText = raw.trim().length > 0 ? raw : null
      continue
    }
    const record = parseMemory(raw, scope)
    if (record === null) continue
    group.memories.push({
      name: record.name,
      ...(record.title !== undefined ? { title: record.title } : {}),
      description: record.description,
      type: record.type,
      pinned: record.pinned === true,
      reads: record.reads ?? 0,
      ...(record.updatedMs !== undefined ? { updatedMs: record.updatedMs } : {}),
      bytes: Buffer.byteLength(raw, 'utf8'),
    })
  }
  group.memories.sort((a, b) => (a.pinned === b.pinned ? (a.name < b.name ? -1 : 1) : a.pinned ? -1 : 1))
  return group
}

/** 扫描记忆根目录的全部组(用户级在前,项目组按目录名序)。 */
export async function scanGroups(rootDir: string): Promise<PanelGroup[]> {
  const groups: PanelGroup[] = [await readGroup(join(rootDir, USER_SCOPE_DIR), 'user', USER_SCOPE_DIR)]
  let entries: string[]
  try {
    entries = await fsp.readdir(rootDir)
  } catch {
    return groups
  }
  for (const entry of entries.sort()) {
    if (!entry.startsWith('--') || !entry.endsWith('--')) continue
    if (entry === USER_SCOPE_DIR) continue
    groups.push(await readGroup(join(rootDir, entry), 'project', entry))
  }
  return groups.filter(group => group.memories.length > 0 || group.indexText !== null)
}

/** 注册面板 API(宿主半入口;无 connection 服务时 no-op)。 */
export function registerMemoryApi(ctx: Context, store: MemoryStore, rootDir: string, config: { maxBytes: number }): void {
  const connection = ctx.get('connection')
  if (connection === undefined) return // 非 web 组合:面板不存在,不注册

  const json = (data: unknown, status = 200): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }))

  connection.fetch.register({
    path: `${BASE}/groups.list`, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const cwd = new URL(request.url).searchParams.get('cwd') ?? undefined
      const groups = await scanGroups(rootDir)
      if (cwd !== undefined && cwd.length > 0) {
        const currentSlug = projectKey(cwd)
        for (const group of groups) {
          if (group.scope === 'project' && group.slug === currentSlug) group.current = true
        }
      }
      return json({ groups, maxBytes: config.maxBytes })
    },
  })

  connection.fetch.register({
    path: `${BASE}/memory.read`, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const name = url.searchParams.get('name') ?? ''
      const scope = (url.searchParams.get('scope') ?? 'user') as MemoryScope
      const cwd = scope === 'project' ? url.searchParams.get('cwd') ?? undefined : undefined
      if (scope === 'project' && cwd === undefined) return json({ error: 'project scope requires cwd' }, 400)
      try {
        const record = await store.read(name, scope, cwd)
        if (record === null) return json({ error: 'not found' }, 404)
        return json({ name: record.name, title: record.title, description: record.description, type: record.type, body: record.body, pinned: record.pinned === true })
      } catch (error) {
        return json({ error: String(error) }, 400)
      }
    },
  })

  connection.fetch.register({
    path: `${BASE}/memory.write`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as {
          cwd?: string; scope: MemoryScope; name: string; title?: string
          description: string; type: MemoryType; body: string; pinned?: boolean
        }
        const cwd = body.scope === 'project' ? body.cwd : undefined
        if (body.scope === 'project' && (cwd === undefined || cwd.length === 0)) {
          return json({ error: 'project scope requires cwd' }, 400)
        }
        const name = normalizeName(body.name) // 抛错即 400,模型与面板同一条归一化路径
        await store.write({
          name,
          ...(body.title !== undefined && body.title.trim().length > 0 ? { title: body.title.trim() } : {}),
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          description: body.description,
          type: body.type,
          body: body.body,
        }, body.scope, cwd)
        return json({ ok: true, name })
      } catch (error) {
        return json({ error: String(error) }, 400)
      }
    },
  })

  connection.fetch.register({
    path: `${BASE}/memory.delete`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as { cwd?: string; scope: MemoryScope; name: string }
        const cwd = body.scope === 'project' ? body.cwd : undefined
        if (body.scope === 'project' && (cwd === undefined || cwd.length === 0)) {
          return json({ error: 'project scope requires cwd' }, 400)
        }
        const removed = await store.delete(body.name, body.scope, cwd)
        return removed ? json({ ok: true }) : json({ error: 'not found' }, 404)
      } catch (error) {
        return json({ error: String(error) }, 400)
      }
    },
  })
}
