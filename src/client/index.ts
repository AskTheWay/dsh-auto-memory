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
import { PANEL_CSS } from './panel-style.ts'
import type { AuditStats, HealthReport, PanelGroup, SettingsView } from './panel-model.tsx'
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
  list: () => Promise<{ groups: PanelGroup[]; maxBytes: number; budgetBytes?: number; claudeImportPending?: number }>
  read: (query: { name: string; scope: string; cwd?: string }) => Promise<{ body: string; pinned: boolean; disabled: boolean }>
  write: (payload: { cwd?: string; scope: string; name: string; title?: string; description: string; type: string; body: string; pinned?: boolean; disabled?: boolean; status?: string; supersedes?: string; validUntilMs?: number }) => Promise<Response>
  del: (payload: { cwd?: string; scope: string; name: string }) => Promise<Response>
  /** 当前会话工作区的 cwd(项目组操作的定位键;无会话时 undefined)。 */
  currentCwd: () => string | undefined
  /** 0.8.0 导入桥:扫描 Claude Code 记忆(只读预览;0.10.0 起逐条带导入状态)。 */
  importScan: () => Promise<{
    found: boolean
    totalImportable: number
    projects: Array<{
      slug: string
      importable: number
      cwd: string | null
      targetScope: 'project' | 'user'
      targetDir: string
      files: Array<{
        file: string
        name: string
        description: string
        type: string
        state: 'pending' | 'imported' | 'modified' | 'legacy' | 'conflict'
      }>
    }>
  }>
  /** 0.10.0 导入/撤销一次应用:items = 要导入的源条目,revoke = 要撤销的已导入条目。 */
  importApply: (payload: {
    items: Array<{ slug: string, file: string }>
    revoke: Array<{ slug: string, file: string }>
    allToUser: boolean
  }) => Promise<Response>
  /** 0.9.0 注入审计统计(注入榜/时间线/汇总会话数)。 */
  auditStats: () => Promise<AuditStats>
  /** 1.0.0 记忆体检:待验证/僵尸/矛盾/已过期四榜(只读报告;行动在记忆卡片上)。 */
  healthReport: () => Promise<HealthReport>
  /** 1.10.0 dreaming 建议清单:读提案(库变化自动过期) + 应用提案(逐条,用户确认)。 */
  dreamProposals: () => Promise<{ proposals: Array<{ id: string; kind: string; targets: string[]; summary: string; reason: string }>; generatedAt: number; stale?: boolean }>
  dreamApply: (payload: { cwd?: string; id: string }) => Promise<Response>
  /** 1.2.0 反向导出桥:信任态记忆 → AGENTS.md 片段(纯文本)。 */
  exportAgents: () => Promise<{ content: string; count: number }>
  /** 1.4.0 设置中心:当前生效配置 + 每字段来源(profile / 用户覆盖)。 */
  configGet: () => Promise<SettingsView>
  /** 1.4.0 设置中心:写入部分覆盖(白名单字段;值 null = 重置回 profile 默认;越权键 400)。 */
  configSet: (payload: Record<string, number | boolean | null>) => Promise<Response>
}

const BASE = '/api/auto-memory'

function memoryFace(ctx: ClientContext): MemoryFace {
  return {
    list: async () => {
      const cwd = currentCwd(ctx)
      const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`
      const response = await fetch(`${BASE}/groups.list${query}`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`groups.list HTTP ${String(response.status)}`)
      return (await response.json()) as Awaited<ReturnType<MemoryFace['list']>>
    },
    read: async ({ name, scope, cwd }) => {
      const params = new URLSearchParams({ name, scope })
      if (cwd !== undefined) params.set('cwd', cwd)
      const response = await fetch(`${BASE}/memory.read?${params}`)
      // 非 2xx 必须抛错:调用方据此中止编辑/置顶——旧实现把 {error} 当数据,
      // 空 body 整条重写会清空记忆正文(审查确认的 major)
      if (!response.ok) throw new Error(`memory.read HTTP ${String(response.status)}`)
      return (await response.json()) as { body: string; pinned: boolean; disabled: boolean }
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
    importScan: async () => {
      const response = await fetch(`${BASE}/import.claude.scan`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`import.claude.scan HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['importScan']>
    },
    importApply: payload => fetch(`${BASE}/import.claude.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    auditStats: async () => {
      const response = await fetch(`${BASE}/audit.stats`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`audit.stats HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['auditStats']>
    },
    healthReport: async () => {
      const response = await fetch(`${BASE}/health.report`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`health.report HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['healthReport']>
    },
    dreamProposals: async () => {
      const response = await fetch(`${BASE}/dream.proposals`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`dream.proposals HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['dreamProposals']>
    },
    dreamApply: payload => fetch(`${BASE}/dream.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    exportAgents: async () => {
      const response = await fetch(`${BASE}/export.agents`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`export.agents HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['exportAgents']>
    },
    configGet: async () => {
      const response = await fetch(`${BASE}/config.get`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`config.get HTTP ${String(response.status)}`)
      return (await response.json()) as ReturnType<MemoryFace['configGet']>
    },
    configSet: payload => fetch(`${BASE}/config.set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    currentCwd: () => currentCwd(ctx),
  }
}

interface SessionsLike {
  list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: string, running?: boolean, updatedAt?: number }> } }
}

/** 从 sessions 快照解析当前工作区 cwd(#9:多工作区并存时不再取首个)。 */
function currentCwd(ctx: ClientContext): string | undefined {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId === undefined) return undefined
  const rows = Object.values(byId).filter(session =>
    session.cwd !== undefined && session.cwd.length > 0)
  if (rows.length === 0) return undefined
  // 优先正在运行的会话;其次最近活动的;同级按 cwd 稳定排序防抖动
  const running = rows.filter(session => session.running === true)
  const pool = running.length > 0 ? running : rows
  pool.sort((a, b) => {
    const delta = (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    return delta !== 0 ? delta : (a.cwd! < b.cwd! ? -1 : 1)
  })
  return pool[0]?.cwd
}

export { PANEL_CSS }

/** 样式与插件实例一起卸载，热更新时替换旧样式。 */
function injectPanelCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  const tagId = 'dsh-auto-memory/panel.css'
  document.querySelector('style[data-plugin-css="dsh-auto-memory/panel.css"]')?.remove()
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-auto-memory'
  tag.dataset.pluginCss = tagId
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

/** 注册侧栏入口与记忆管理面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auto-memory: dictionaries')
  ctx.effect(injectPanelCss, 'dsh-auto-memory: styles')
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
