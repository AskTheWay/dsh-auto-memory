/**
 * 1.4.0 设置中心测试:白名单校验/加载容错/应用与持久化往返/config 路由
 * (get 返回生效值与来源标记;set 白名单写入 + 原地生效 live 对象 + 越权 400)。
 * 外部世界断言原则:读真实落盘文件。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, saveSettings, applySettings, SETTABLE_FIELDS } from '../src/settings.ts'

let base: string

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-settings-'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('settings 纯函数层', () => {
  it('文件缺失 → 空覆盖;畸形 JSON → 空;坏字段丢弃、好字段保留', async () => {
    expect(await loadSettings(base)).toEqual({})
    await fsp.writeFile(join(base, 'settings.json'), '{not json', 'utf8')
    expect(await loadSettings(base)).toEqual({})
    await fsp.writeFile(join(base, 'settings.json'), JSON.stringify({ maxBytes: 4096, minImportance: 99, autoSummarize: 'yes', unknown: 1 }), 'utf8')
    expect(await loadSettings(base)).toEqual({ maxBytes: 4096 }) // 越界/类型错/白名单外全丢
  })
  it('applySettings:白名单字段合并持久化并可往返;未知字段忽略不报错', async () => {
    const first = await applySettings(base, { maxBytes: 8192, minImportance: 1, evil: 'x' })
    expect(first).toEqual({ maxBytes: 8192, minImportance: 1 })
    const second = await applySettings(base, { staleAfterDays: 30 })
    expect(second).toEqual({ maxBytes: 8192, minImportance: 1, staleAfterDays: 30 })
    // 文件真实落盘
    const raw = JSON.parse(await fsp.readFile(join(base, 'settings.json'), 'utf8'))
    expect(raw).toEqual(second)
    expect(await loadSettings(base)).toEqual(second)
  })
  it('saveSettings 空对象也落盘(= 回到 profile 默认的显式记录)', async () => {
    await saveSettings(base, {})
    expect(JSON.parse(await fsp.readFile(join(base, 'settings.json'), 'utf8'))).toEqual({})
  })
  it('applySettings:null = 显式重置(删覆盖回 profile;磁盘同步消失)', async () => {
    await applySettings(base, { maxBytes: 8192, minImportance: 2 })
    const merged = await applySettings(base, { maxBytes: null, minImportance: 6 })
    expect(merged).toEqual({ minImportance: 6 }) // maxBytes 覆盖已删,minImportance 更新
    expect(JSON.parse(await fsp.readFile(join(base, 'settings.json'), 'utf8'))).toEqual({ minImportance: 6 })
  })
  it('SETTABLE_FIELDS 白名单不含 memoryDir(运行时设置不可改记忆根)', () => {
    expect(Object.keys(SETTABLE_FIELDS).includes('memoryDir')).toBe(false)
  })
})

describe('config 路由(memory-api 挂载)', () => {
  it('get/set 往返:set 后 get 返回新生效值 + override 来源;live 对象被原地更新;越权键 400', async () => {
    const { registerMemoryApi } = await import('../src/memory-api.ts')
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const fakeCtx = {
      get: (name: string) => name === 'connection' ? { fetch: { register: ({ path, fetch }: { path: string, fetch: (r: Request) => Promise<Response> }) => { routes.set(path, fetch) } } } : undefined,
      on: () => {},
      effect: () => {},
    }
    const live: { maxBytes: number, minImportance: number, staleAfterDays: number, autoSummarize: boolean, [key: string]: unknown } = { maxBytes: 4096, minImportance: 4, staleAfterDays: 0, autoSummarize: false }
    const profile = { ...live }
    registerMemoryApi(fakeCtx as never, null as never, base, live, profile)
    expect(routes.has('/api/auto-memory/config.get')).toBe(true)

    const get1 = await routes.get('/api/auto-memory/config.get')!(new Request('http://x/config.get'))
    const body1 = await get1.json()
    expect(body1.effective.maxBytes).toBe(4096)
    expect(body1.sources.maxBytes).toBe('profile')

    const set = await routes.get('/api/auto-memory/config.set')!(new Request('http://x/config.set', {
      method: 'POST', body: JSON.stringify({ maxBytes: 16384, minImportance: 1 }),
    }))
    expect(set.ok).toBe(true)
    expect(live.maxBytes).toBe(16384) // live 对象原地生效(下一个注入请求用新预算)
    expect(live.minImportance).toBe(1)

    const get2 = await routes.get('/api/auto-memory/config.get')!(new Request('http://x/config.get'))
    const body2 = await get2.json()
    expect(body2.effective.maxBytes).toBe(16384)
    expect(body2.sources.maxBytes).toBe('override')
    expect(body2.overrides).toEqual({ maxBytes: 16384, minImportance: 1 })

    const bad = await routes.get('/api/auto-memory/config.set')!(new Request('http://x/config.set', {
      method: 'POST', body: JSON.stringify({ memoryDir: '/tmp/evil' }),
    }))
    expect(bad.status).toBe(400) // 白名单外字段(改记忆根)拒绝
    const bad2 = await routes.get('/api/auto-memory/config.set')!(new Request('http://x/config.set', {
      method: 'POST', body: JSON.stringify([1, 2]),
    }))
    expect(bad2.status).toBe(400) // 非对象拒绝

    // 单字段重置(审查 minor 修复):null 删覆盖,live 回 profile 默认,其余覆盖保留
    const reset = await routes.get('/api/auto-memory/config.set')!(new Request('http://x/config.set', {
      method: 'POST', body: JSON.stringify({ maxBytes: null }),
    }))
    expect(reset.ok).toBe(true)
    expect(live.maxBytes).toBe(4096) // 覆盖删除 → 回 profile 默认
    expect(live.minImportance).toBe(1) // 未触及的覆盖仍在
    const get3 = await routes.get('/api/auto-memory/config.get')!(new Request('http://x/config.get'))
    const body3 = await get3.json()
    expect(body3.sources.maxBytes).toBe('profile')
    expect(body3.sources.minImportance).toBe('override')

    // GET 即收敛点(审查 minor 修复):手改盘后 GET 以磁盘为真值源,
    // effective/sources 同源,live 被同步(含"盘上消失的覆盖回 profile")
    await fsp.writeFile(join(base, 'settings.json'), JSON.stringify({ staleAfterDays: 42 }), 'utf8')
    const get4 = await routes.get('/api/auto-memory/config.get')!(new Request('http://x/config.get'))
    const body4 = await get4.json()
    expect(body4.effective.staleAfterDays).toBe(42)
    expect(body4.sources.staleAfterDays).toBe('override')
    expect(live.staleAfterDays).toBe(42)
    expect(live.minImportance).toBe(4) // 磁盘已无此覆盖 → 回 profile 默认
    expect(body4.overrides).toEqual({ staleAfterDays: 42 })
  })
})
