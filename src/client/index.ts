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
  list: () => Promise<{ groups: unknown[]; maxBytes: number; budgetBytes?: number }>
  read: (query: { name: string; scope: string; cwd?: string }) => Promise<{ body: string; pinned: boolean; disabled: boolean }>
  write: (payload: { cwd?: string; scope: string; name: string; title?: string; description: string; type: string; body: string; pinned?: boolean; disabled?: boolean }) => Promise<Response>
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
  auditStats: () => Promise<{ sessions: number; injections: number; memories: Array<{ name: string; injectedCount: number; lastTs: number }>; timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number }> }>
}

const BASE = '/api/auto-memory'

function memoryFace(ctx: ClientContext): MemoryFace {
  return {
    list: async () => {
      const cwd = currentCwd(ctx)
      const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`
      const response = await fetch(`${BASE}/groups.list${query}`, { headers: { 'cache-control': 'no-store' } })
      if (!response.ok) throw new Error(`groups.list HTTP ${String(response.status)}`)
      return (await response.json()) as { groups: unknown[]; maxBytes: number; budgetBytes?: number }
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

/** 面板样式表(官方主题 token 驱动;深浅主题与第三方主题自动跟随)。 */
export const PANEL_CSS = `
.dam-root{display:flex;justify-content:flex-start;align-items:flex-start;width:100%;height:100%;overflow-y:auto;box-sizing:border-box;padding:clamp(16px,3vw,32px);}
.dam-shell{width:100%;max-width:1040px;margin:0;min-width:0;display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);}
.dam-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;}
.dam-heading{display:flex;flex-direction:column;gap:3px;min-width:0;}
.dam-title{font-size:18px;font-weight:650;margin:0;letter-spacing:-.01em;}
.dam-intro{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0;}
.dam-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dam-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dam-search{position:relative;display:flex;align-items:center;flex:1;min-width:220px;}
.dam-search input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:7px 30px 7px 30px;font-size:12.5px;outline:none;font-family:inherit;}
.dam-search input:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.dam-search-icon{position:absolute;left:9px;display:inline-flex;color:var(--dsw-alias-label-tertiary);pointer-events:none;}
.dam-search-clear{position:absolute;right:6px;width:20px;height:20px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;}
.dam-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dam-segment{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}
.dam-segment button{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}
.dam-segment button span{font-size:10px;opacity:.65;font-variant-numeric:tabular-nums;}
.dam-segment button[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08);}
.dam-select{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 10px;font-size:12px;font-family:inherit;cursor:pointer;outline:none;}
.dam-select:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.dam-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}
.dam-btn svg{flex:none;}
.dam-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}
.dam-btn:disabled{opacity:.5;cursor:default;}
.dam-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);}
.dam-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:transparent;}
.dam-btn-primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-bg-base,#fff);}
.dam-btn-primary:hover{color:var(--dsw-alias-bg-base,#fff);opacity:.88;}
.dam-btn-danger-ghost{color:var(--dsw-alias-state-error-primary,#ef4444);}
.dam-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}
.dam-btn-danger:hover{color:#fff;opacity:.9;}
.dam-overview{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}
.dam-stat{display:inline-flex;align-items:baseline;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dam-stat b{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}
.dam-usage{flex:1;min-width:170px;margin-left:auto;}
.dam-usage-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary);display:block;margin-bottom:4px;text-align:right;font-variant-numeric:tabular-nums;}
.dam-usage-track{display:block;height:5px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;}
.dam-usage-track i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4d76e6);transition:width .2s ease;}
.dam-usage-track i[data-hot="1"]{background:var(--dsw-alias-state-warn-primary,#d97706);}
.dam-groups{display:flex;flex-direction:column;gap:10px;}
.dam-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .12s ease;}
.dam-group[data-scope]{border-left-width:3px;}
.dam-group[data-scope="user"]{border-left-color:#3b82f6;}
.dam-group[data-scope="project"]{border-left-color:#8b5cf6;}
.dam-group[data-scope="project"][data-current="1"]{border-left-color:#16a34a;}
.dam-group-head{display:grid;grid-template-columns:18px minmax(0,1fr) auto 16px;gap:10px;align-items:center;width:100%;padding:11px 14px;border:0;background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer;}
.dam-group-head:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-group-icon{font-size:13px;text-align:center;line-height:1;}
.dam-group-name{display:flex;flex-direction:column;gap:1px;min-width:0;}
.dam-group-title{font-weight:600;font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dam-group-sub{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dam-group-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
.dam-chevron{display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;transform:rotate(90deg);}
.dam-group[data-open="0"] .dam-chevron{transform:rotate(0deg);}
.dam-group-body{padding:0 10px 10px;display:flex;flex-direction:column;gap:6px;}
.dam-group-tools{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 4px 4px;border-top:1px solid var(--dsw-alias-border-l1);}
.dam-budget{display:inline-flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;max-width:380px;}
.dam-budget-track{display:block;width:190px;flex:none;height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;}
.dam-budget-track i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4d76e6);transition:width .2s ease;}
.dam-budget-track i[data-hot="1"]{background:var(--dsw-alias-state-warn-primary,#d97706);}
.dam-budget-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums;}
.dam-group-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:1;}
.dam-index>summary{cursor:pointer;font-size:10.5px;color:var(--dsw-alias-label-tertiary);list-style:none;white-space:nowrap;}
.dam-index>summary::-webkit-details-marker{display:none;}
.dam-index pre{margin:6px 0 0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;}
.dam-tag{font-size:11px;border-radius:6px;padding:1px 7px;white-space:nowrap;border:1px solid transparent;}
.dam-tag--user{color:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);}
.dam-tag--feedback{color:var(--dsw-alias-state-warn-primary,#d97706);border-color:var(--dsw-alias-state-warn-primary,#d97706);}
.dam-tag--project{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a);}
.dam-tag--reference{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}
.dam-memory-list{display:flex;flex-direction:column;gap:1px;}
.dam-memory{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;padding:8px;border-radius:9px;transition:background .12s ease;}
.dam-memory:hover,.dam-memory:focus-within{background:var(--dsw-alias-interactive-bg-hover);}
.dam-memory[data-muted="1"]{opacity:.6;}
.dam-memory-main{min-width:0;cursor:pointer;outline:none;}
.dam-memory-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d76e6);outline-offset:2px;border-radius:6px;}
.dam-memory-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;}
.dam-memory-title{font-weight:600;font-size:12.5px;line-height:18px;min-width:120px;flex:1;overflow-wrap:anywhere;}
.dam-memory-pin{font-size:10px;line-height:1;}
.dam-memory-time{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.dam-memory-desc{margin:2px 0 0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.dam-memory-actions{display:flex;align-items:flex-start;gap:2px;opacity:.85;transition:opacity .12s ease;}
.dam-memory:hover .dam-memory-actions,.dam-memory:focus-within .dam-memory-actions{opacity:1;}
@media (hover:none){.dam-memory-actions{opacity:1;}}
.dam-icon-btn{display:inline-grid;place-items:center;width:27px;height:27px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}
.dam-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dam-icon-btn[data-on="1"]{color:var(--dsw-alias-brand-primary,#4d76e6);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 30%,transparent);}
.dam-icon-btn[data-danger="1"]:hover{color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);}
.dam-icon-btn:disabled{opacity:.35;cursor:default;}
.dam-memory-body{grid-column:1 / -1;margin:6px 0 2px;}
.dam-memory-confirm{grid-column:1 / -1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;margin-top:4px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 6%,transparent);font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dam-body{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;}
/* ---- 注入统计卡(0.10.1):指标条 + 占比条榜 + 截断榜 + 时间线 ---- */
.dam-stats{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 4%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1));overflow:hidden;}
.dam-stats>summary{list-style:none;display:flex;align-items:center;gap:11px;padding:12px 16px;cursor:pointer;user-select:none;transition:background .12s ease;}
.dam-stats>summary::-webkit-details-marker{display:none;}
.dam-stats>summary:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-stats[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l1);}
.dam-stats-glyph{flex:none;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-size:15px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 11%,transparent);}
.dam-stats-titles{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;}
.dam-stats-title{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);}
.dam-stats-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dam-stats-chev{flex:none;font-size:16px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .18s ease;}
.dam-stats[open] .dam-stats-chev{transform:rotate(90deg);}
.dam-stats-body{display:flex;flex-direction:column;gap:14px;padding:14px 16px 16px;max-height:420px;overflow-y:auto;}
.dam-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.dam-metric{padding:9px 13px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:1px;min-width:0;}
.dam-metric:first-child{border-left:0;}
.dam-metric b{font-size:18px;line-height:23px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);}
.dam-metric span{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dam-block{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dam-block-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:3px;}
.dam-section{margin:0;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);}
.dam-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.dam-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);}
.dam-legend-item{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}
.dam-scope-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--scope-color,var(--dsw-alias-label-tertiary));box-shadow:0 0 0 2px color-mix(in srgb,var(--scope-color,var(--dsw-alias-border-l2)) 16%,transparent);}
.dam-legend-item .dam-scope-dot{width:6px;height:6px;box-shadow:none;}
.dam-rank-row[data-scope="user"],.dam-trunc-row[data-scope="user"]{--scope-color:var(--dsw-alias-brand-primary,#3b82f6);}
.dam-rank-row[data-scope="project"],.dam-trunc-row[data-scope="project"]{--scope-color:#8b5cf6;}
.dam-rank-row[data-scope="both"],.dam-trunc-row[data-scope="both"]{--scope-color:#8b5cf6;}
.dam-rank-row[data-scope="missing"],.dam-trunc-row[data-scope="missing"]{--scope-color:#94a3b8;}
.dam-scope-dot[data-scope="user"]{--scope-color:var(--dsw-alias-brand-primary,#3b82f6);}
.dam-scope-dot[data-scope="project"]{--scope-color:#8b5cf6;}
.dam-scope-dot[data-scope="both"]{background:linear-gradient(90deg,#3b82f6 0 50%,#8b5cf6 50% 100%);}
.dam-scope-dot[data-scope="missing"]{--scope-color:#94a3b8;}
.dam-rank-row[data-scope="both"] .dam-scope-dot{background:linear-gradient(90deg,#3b82f6 0 50%,#8b5cf6 50% 100%);}
.dam-rank-row[data-scope="both"] .dam-mini-bar i{background:linear-gradient(90deg,#3b82f6,#8b5cf6);}
.dam-rank-row{display:grid;grid-template-columns:8px minmax(0,280px) minmax(60px,1fr) 44px 34px;align-items:center;gap:10px;padding:5px 8px;margin:0 -8px;border-radius:8px;transition:background .12s ease;}
.dam-rank-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-rank-name{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.dam-mini-bar{height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;}
.dam-mini-bar i{display:block;height:100%;border-radius:999px;background:var(--scope-color,var(--dsw-alias-brand-primary,#4d76e6));transition:width .2s ease;}
.dam-ratio{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}
.dam-rank-warn{font-size:10px;line-height:16px;text-align:right;white-space:nowrap;color:var(--dsw-alias-state-warn-primary,#d97706);}
.dam-trunc-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:10px;padding:4px 8px;margin:0 -8px;border-radius:8px;transition:background .12s ease;}
.dam-trunc-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-trunc-row .dam-warn{justify-self:end;}
/* ---- 按项目统计(0.10.1):固定列 + 项目色条 ---- */
.dam-proj-head,.dam-proj-row{display:grid;grid-template-columns:minmax(0,280px) 34px 34px minmax(60px,1fr) 44px 30px;align-items:center;gap:8px;padding-left:8px;padding-right:8px;margin:0 -8px;}
.dam-proj-head{font-size:10px;color:var(--dsw-alias-label-tertiary);text-align:right;padding-top:2px;padding-bottom:2px;}
.dam-proj-head span:first-child{text-align:left;}
.dam-proj-row{padding-top:5px;padding-bottom:5px;border-radius:8px;transition:background .12s ease;}
.dam-proj-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-proj-name{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.dam-proj-stat{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-tertiary);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dam-proj-bar{height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;}
.dam-proj-bar i{display:block;height:100%;border-radius:999px;}
.dam-proj-warn{font-size:10px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#d97706);text-align:right;white-space:nowrap;}
.dam-warn{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;font-weight:600;white-space:nowrap;color:var(--dsw-alias-state-warn-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 12%,transparent);}
.dam-timeline{display:flex;flex-direction:column;border-left:1.5px solid var(--dsw-alias-border-l2);margin:2px 0 0 4px;padding:2px 0 0 14px;}
.dam-tl-item{position:relative;padding:4px 0;}
.dam-tl-item::before{content:"";position:absolute;left:-18px;top:9px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2);}
.dam-tl-item[data-latest="1"]::before{background:var(--dsw-alias-brand-primary,#4d76e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d76e6) 22%,transparent);}
.dam-tl-top{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:16px;min-width:0;}
.dam-tl-time{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin-left:auto;}
.dam-tl-ws{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dam-tl-meta{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.dam-pill{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);line-height:15px;}
.dam-subdetails>summary{cursor:pointer;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);padding:4px 0;list-style:none;}
.dam-subdetails>summary::-webkit-details-marker{display:none;}
.dam-form{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px;position:sticky;bottom:12px;box-shadow:var(--dsw-elevation-prominent,0 3px 8px rgba(0,0,0,.14),0 0 20px rgba(0,0,0,.18));}
.dam-form--inline{position:static;box-shadow:none;border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.dam-form-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;}
.dam-form-bar{width:3px;height:14px;border-radius:2px;background:var(--dsw-alias-brand-primary,#4d76e6);display:inline-block;}
.dam-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin:4px 0 0;}
.dam-input,.dam-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;}
.dam-input:focus,.dam-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}
.dam-textarea{resize:vertical;min-height:120px;}
.dam-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.dam-err{color:var(--dsw-alias-state-warn-primary,#d97706);font-size:12px;}
.dam-banner{padding:8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 35%,transparent);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 7%,transparent);}
.dam-empty{display:flex;flex-direction:column;align-items:center;gap:4px;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:34px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;background:var(--dsw-alias-bg-layer-1);}
.dam-empty-icon{font-size:26px;line-height:1;margin-bottom:4px;}
.dam-empty h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dam-empty p{margin:0;max-width:520px;}
.dam-modal-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.42);backdrop-filter:blur(2px);}
.dam-modal{width:min(760px,100%);max-height:min(82vh,820px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.28);padding:18px;}
.dam-modal .dam-form{position:static;box-shadow:none;border:0;background:transparent;padding:0;max-height:none;}
.dam-table{width:100%;border-collapse:collapse;font-size:12.5px;}
.dam-table th{text-align:left;padding:4px 6px;font-weight:500;opacity:.7;}
.dam-table td{padding:4px 6px;border-top:1px solid var(--dsw-alias-border-l1);}
.dam-check{accent-color:var(--dsw-alias-brand-primary,#4d76e6);}
/* ---- Claude Code 导入弹层(0.10.0):逐条勾选 + 状态徽章 + 撤销 ---- */
.dam-import-wrap{display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow-y:auto;padding-right:2px;}
.dam-import-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;}
.dam-import-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px;}
.dam-import-slug{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.dam-import-items{display:flex;flex-direction:column;gap:2px;margin-top:4px;}
.dam-import-item{display:flex;align-items:flex-start;gap:8px;padding:4px 6px;border-radius:7px;cursor:pointer;transition:background .12s ease;}
.dam-import-item:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dam-import-item[data-locked="1"]{cursor:default;opacity:.72;}
.dam-import-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;}
.dam-import-name{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:12px;line-height:17px;}
.dam-import-file{font-size:10.5px;color:var(--dsw-alias-label-tertiary);}
.dam-import-desc{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.dam-badge{flex:none;align-self:center;font-size:10.5px;line-height:16px;padding:0 7px;border-radius:999px;white-space:nowrap;border:1px solid transparent;}
.dam-badge--ok{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent);}
.dam-badge--warn{color:var(--dsw-alias-state-warn-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 12%,transparent);}
.dam-badge--muted{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}
`

/** 幂等注入面板样式(官方 data-plugin-css 约定)。 */
function injectPanelCss(): void {
  const tagId = 'dsh-auto-memory/panel.css'
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-auto-memory'
  tag.dataset.pluginCss = tagId
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

/** 注册侧栏入口与记忆管理面板。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auto-memory: dictionaries')
  // 样式注入(参照官方 client bundle 的 data-plugin-css 约定,幂等)——
  // 内联 style 没有 hover/focus/line-clamp 能力,0.9.1 起面板视觉层走真 CSS 类
  injectPanelCss()
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
