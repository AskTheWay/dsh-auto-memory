/**
 * 浏览器半:侧栏"记忆"入口 + 主列记忆管理面板。
 *
 * 结构照官方样板(ui-plugin-manager):全局面板挂 main slot,侧栏图标挂
 * sidebar.panellist;数据经宿主半注册的 /api/auto-memory/* 路由(认证围栏内)
 * fetch 获取,操作后 refetch 刷新(事件白名单硬编码,不做推送)。
 *
 * 约束(激活失败会白屏整个前端,务必保守):
 * - 值导入仅限基线模块表(react / cordis / ui-primitives);其余一律 import type;
 * - inject 只声明 web 组合必有的稳定服务(slots、locale);
 * - 样式内联(官方 CSS Modules 管线未随 preset 发布)。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型:LocaleNamespaceMap / slots 与 'main'/'sidebar.panellist' 声明合并(编译期擦除)
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MemoryPage } from './MemoryPage.tsx'
import { MemoryPanelIcon } from './MemoryPanelIcon.tsx'
import { en, zh, type PluginMemoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory panel copy. */
    'autoMemory': PluginMemoryLocaleKey
  }
}

/** 词典命名空间。 */
export const NS = 'autoMemory'

/** 侧栏入口与主面板共用的面板 id。 */
export const PANEL_ID = 'auto-memory' as MainPanelId

/** 浏览器半依赖的服务(slots/locale 为 web 组合必有;sessions 来自基线 client-store)。 */
export const inject = ['slots', 'locale', 'sessions']

/** 面板可用的操作面(宿主半路由的浏览器侧封装;组件永不直接拿 ctx)。 */
export interface MemoryFace {
  list: () => Promise<{ groups: unknown[]; maxBytes: number }>
  read: (query: { name: string; scope: string; cwd?: string }) => Promise<{ body: string; pinned: boolean } | { error: string }>
  write: (payload: { cwd?: string; scope: string; name: string; title?: string; description: string; type: string; body: string; pinned?: boolean }) => Promise<Response>
  del: (payload: { cwd?: string; scope: string; name: string }) => Promise<Response>
  /** 当前会话工作区的 cwd(项目组操作的定位键;无会话时 undefined)。 */
  currentCwd: () => string | undefined
}

const BASE = '/api/auto-memory'

function memoryFace(ctx: ClientContext): MemoryFace {
  return {
    list: async () => {
      const cwd = currentCwd(ctx)
      const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`
      const response = await fetch(`${BASE}/groups.list${query}`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`groups.list HTTP ${String(response.status)}`)
      return (await response.json()) as { groups: unknown[]; maxBytes: number }
    },
    read: async ({ name, scope, cwd }) => {
      const params = new URLSearchParams({ name, scope })
      if (cwd !== undefined) params.set('cwd', cwd)
      return (await fetch(`${BASE}/memory.read?${params}`)).json() as Promise<{ body: string; pinned: boolean } | { error: string }>
    },
    write: payload => fetch(`${BASE}/memory.write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    del: payload => fetch(`${BASE}/memory.delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    currentCwd: () => currentCwd(ctx),
  }
}

interface SessionsLike {
  list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: string }> } }
}

/** 从 sessions 快照取一个可用的工作区 cwd(官方 ui-reference 同款读取面)。 */
function currentCwd(ctx: ClientContext): string | undefined {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId === undefined) return undefined
  for (const session of Object.values(byId)) {
    if (session.cwd !== undefined && session.cwd.length > 0) return session.cwd
  }
  return undefined
}

/** 注册侧栏入口与记忆管理面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auto-memory: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => memoryFace(ctx),
  }, MemoryPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 50,
    label: () => t('panel'),
    locale: NS,
  }, MemoryPanelIcon))
}
