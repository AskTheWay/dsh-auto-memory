/**
 * 记忆管理面板(主列全局面板)—— 0.9.1 视觉重设计:
 * - 真 CSS 类注入(官方 data-plugin-css 约定,见 client/index.ts 的 PANEL_CSS):
 *   hover/focus/clamp 等伪类能力回归,告别内联样式
 * - 卡片式记忆条目(border-l1 + 圆角 + bg-base),类型用描边色 tag 编码
 * - 胶囊筛选 chips(作用域) + 搜索框;两步确认删除(替代 window.confirm)
 * - 全套 --dsw-alias-* 官方主题 token,深浅/第三方主题自动跟随
 * 布局:用户级 | 项目级 双列(flexWrap 窄屏自动堆叠);面板自滚动。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryFace } from './index.ts'
import type { PluginMemoryLocaleKey } from './locales.ts'

/** 面板数据(host 半 memory-api 的响应形状)。 */
interface PanelMemory {
  name: string
  title?: string
  description: string
  type: string
  pinned: boolean
  disabled: boolean
  /** 软淘汰命中:文件仍在,但不会进入下一次注入索引。 */
  stale: boolean
  /** 可信状态(缺省 = 信任态;disputed/superseded 不注入)。 */
  status?: string
  /** 证据链(固化产物附带)。 */
  evidence?: { sessionId: string; quote: string }
  /** 创建时间(体检年龄口径)。 */
  createdMs?: number
  reads: number
  updatedMs?: number
  bytes: number
  /** 导入溯源(0.10.0):仅来源种类,完整来源路径不回显。 */
  importedFrom?: 'claude-code'
}

interface PanelGroup {
  key: string
  scope: string
  slug: string
  current?: boolean
  memories: PanelMemory[]
  indexBytes: number
  /** 该组当前索引全文(= 下一次会话注入的索引部分)。 */
  indexText?: string | null
}

type Translate = (key: PluginMemoryLocaleKey, params?: Record<string, string | number>) => string

/** 导入桥的逐条扫描结果(import.claude.scan;0.10.0 起带目标层状态)。 */
type ImportFileState = 'pending' | 'imported' | 'modified' | 'legacy' | 'conflict'
interface ImportScanFile {
  file: string
  name: string
  description: string
  type: string
  state: ImportFileState
}

interface ImportScanProject {
  slug: string
  importable: number
  cwd: string | null
  targetScope: 'project' | 'user'
  targetDir: string
  files: ImportScanFile[]
}

/** 条目选择键(slug 与文件名都不含 \u0000,拼接无歧义)。 */
function importKey(slug: string, file: string): string {
  return `${slug}\u0000${file}`
}

/** 记忆体检响应形状(health.report,1.0.0)。 */
interface HealthReportFace {
  unverified: Array<{ name: string; scope: string; slug: string; hasEvidence: boolean }>
  zombies: Array<{ name: string; scope: string; slug: string; ageDays: number }>
  conflicts: Array<{ kind: 'cross-scope' | 'near-duplicate'; a: { name: string; scope: string }; b: { name: string; scope: string } }>
}

/** 注入审计统计(audit.stats 响应形状,0.9.0;avgBytes/truncatedCount/scope 为 0.9.1 新增,projects 为 0.10.1 新增)。 */
interface AuditStatsFace {
  sessions: number
  injections: number
  avgBytes?: number
  memories: Array<{ name: string; injectedCount: number; truncatedCount?: number; lastTs: number; scope?: 'user' | 'project' | 'both' | 'missing' }>
  /** 按工作区聚合(旧宿主缺失时整块不显示)。 */
  projects?: Array<{
    cwd: string
    sessions: number
    injections: number
    avgBytes: number
    memories: number
    truncated: number
    lastTs: number
  }>
  timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number }>
}

/** 导入弹层状态机。 */
type ImportState =
  | { phase: 'loading' }
  | { phase: 'empty' }
  | { phase: 'failed' }
  | { phase: 'runFailed' } // 执行阶段失败(与扫描失败分开:部分记忆可能已落盘)
  | { phase: 'select'; projects: ImportScanProject[]; selected: Record<string, boolean>; allToUser: boolean }
  | { phase: 'applying' }
  | { phase: 'done'; summary: string }

/** 面板完整 props(由 main slot 渲染器组装:业务 face 直通交叉为顶层成员)。 */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'autoMemory'> & MemoryFace

/** 类型 tag 的 CSS 类映射(描边色编码,颜色定义在 PANEL_CSS)。 */
const TYPE_TAG: Record<string, string> = {
  user: 'dam-tag dam-tag--user',
  feedback: 'dam-tag dam-tag--feedback',
  project: 'dam-tag dam-tag--project',
  reference: 'dam-tag dam-tag--reference',
}

/** 行内操作图标(单色 SVG,跟随主题文字色;不依赖 emoji 字体)。 */
const ICONS = {
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
  pin: ['M12 17v5', 'M9 3h6l-1 7 2 4H8l2-4-1-7Z'],
  unmute: ['M11 5 6 9H3v6h3l5 4V5Z', 'M16 9a4 4 0 0 1 0 6', 'M19 6a8 8 0 0 1 0 12'],
  mute: ['M11 5 6 9H3v6h3l5 4V5Z', 'm17 9 4 6', 'm21 9-4 6'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16'],
  chevron: ['m9 6 6 6-6 6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
} as const

function Icon({ name, size = 14 }: { name: keyof typeof ICONS, size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map(path => <path key={path} d={path} />)}
    </svg>
  )
}

/** 类型筛选 chips 的顺序(与 tag 编码一致)。 */
const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'] as const

/** 按项目统计条的配色(确定性轮换;只用于项目身份,不承载语义)。 */
const PROJECT_COLORS = ['#4d76e6', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899'] as const

/** 字节数的紧凑展示(索引体积都很小,统一 B/KB)。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * 项目目录名可读化:slug 把路径分隔符全折叠成 '-' 不可逆,这里只做"末段截短",
 * 完整值放 title——不假装能还原路径。
 */
function shortProjectName(slug: string): string {
  const inner = slug.replace(/^--/, '').replace(/--$/, '')
  if (inner.length <= 38) return inner
  return `…${inner.slice(-37)}`
}

/** 相对时间(纯函数,渲染时求值)。 */
function relativeTime(ms: number | undefined, now: number, t: Translate): string | null {
  if (ms === undefined) return null
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return t('minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hoursAgo', { n: hours })
  return t('daysAgo', { n: Math.floor(hours / 24) })
}

/** 按项目统计行的形状(与服务端 projects 一致)。 */
type ProjectRow = NonNullable<AuditStatsFace['projects']>[number]

/**
 * 旧宿主(还没有 projects 字段)的前端兜底:用 timeline 最近 50 条现算。
 * 只影响历史完整性,不影响本次会话;服务端升级后自动改用精确聚合。
 */
function projectsFromTimeline(timeline: AuditStatsFace['timeline']): ProjectRow[] {
  const perProject = new Map<string, { sessions: Set<string>, injections: number, bytes: number, truncated: number, lastTs: number }>()
  for (const entry of timeline) {
    const cwd = entry.cwd.length > 0 ? entry.cwd : 'unknown'
    const project = perProject.get(cwd) ?? { sessions: new Set<string>(), injections: 0, bytes: 0, truncated: 0, lastTs: 0 }
    project.sessions.add(entry.sessionId)
    project.injections += 1
    project.bytes += entry.bytes
    project.truncated += entry.truncated
    project.lastTs = Math.max(project.lastTs, entry.ts)
    perProject.set(cwd, project)
  }
  return [...perProject.entries()]
    .map(([cwd, project]) => ({
      cwd,
      sessions: project.sessions.size,
      injections: project.injections,
      avgBytes: project.injections === 0 ? 0 : Math.round(project.bytes / project.injections),
      memories: 0,
      truncated: project.truncated,
      lastTs: project.lastTs,
    }))
    .sort((a, b) => b.injections - a.injections || b.lastTs - a.lastTs || a.cwd.localeCompare(b.cwd))
}

/**
 * 注入统计卡(0.10.1 重设计):
 * 头部 = 图标 + 标题 + 摘要 + chevron;主体 = 指标条 + 注入占比条 + 截断榜
 * + 时间线。行一律用固定列网格(作用域圆点/名字/进度条/比例/警告),不再用
 * emoji 徽章——emoji 宽度随平台变化,是之前"项目图标挤歪统计列"的根因。
 */
/**
 * 记忆体检卡(1.0.0):待验证/僵尸/矛盾三榜——只读报告,行动在对应记忆卡片上
 * (卡片带 candidate 徽章与 ✓/⊘ 按钮;行内标注归属层)。
 */
function HealthSection({ health, t }: { health: HealthReportFace; t: Translate }): ReactNode {
  const scopeLabel = (scope: string): string => (scope === 'user' ? t('scopeUser') : t('scopeProject'))
  return (
    <details className="dam-health">
      <summary>
        <span aria-hidden>🩺</span>
        <span className="dam-stats-title">{t('healthTitle')}</span>
        <span className="dam-stats-sub">
          {health.unverified.length} / {health.zombies.length} / {health.conflicts.length}
        </span>
      </summary>
      <div className="dam-health-body">
        <p className="dam-section">{t('healthUnverified')}</p>
        {health.unverified.map(m => (
          <div key={`u-${m.scope}-${m.slug}-${m.name}`} className="dam-health-row">
            <span className="dam-badge dam-badge--cand">? {t('statusCandidate')}</span>
            <code title={m.name}>{m.name}</code>
            <span className="dam-health-meta">{scopeLabel(m.scope)}{m.hasEvidence ? ' · 📎' : ''}</span>
          </div>
        ))}
        <p className="dam-section">{t('healthZombies')}</p>
        {health.zombies.map(m => (
          <div key={`z-${m.scope}-${m.slug}-${m.name}`} className="dam-health-row">
            <span className="dam-badge dam-badge--muted">💤</span>
            <code title={m.name}>{m.name}</code>
            <span className="dam-health-meta">{scopeLabel(m.scope)} · {m.ageDays}d</span>
          </div>
        ))}
        <p className="dam-section">{t('healthConflicts')}</p>
        {health.conflicts.map((c, i) => (
          <div key={`c-${String(i)}`} className="dam-health-row">
            <span className="dam-badge dam-badge--danger">{c.kind === 'cross-scope' ? t('healthCrossScope') : t('healthNearDup')}</span>
            <code title={c.a.name}>{c.a.name}</code>
            <span className="dam-health-meta">↔ {c.b.name} ({scopeLabel(c.b.scope)})</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function StatsSection({ stats, t, now }: { stats: AuditStatsFace; t: Translate; now: number }): ReactNode {
  type StatsMemory = AuditStatsFace['memories'][number]
  type Scope = NonNullable<StatsMemory['scope']>
  const total = stats.memories.length
  const allFull = total > 0 && stats.memories.every(m => m.injectedCount === stats.injections)
  const avgBytes = stats.avgBytes
    ?? (stats.timeline.length > 0 ? Math.round(stats.timeline.reduce((sum, e) => sum + e.bytes, 0) / stats.timeline.length) : 0)
  const ranked = stats.memories.slice(0, 8)
  const rest = stats.memories.slice(8)
  const truncated = stats.memories
    .filter(m => (m.truncatedCount ?? 0) > 0)
    .sort((a, b) => (b.truncatedCount ?? 0) - (a.truncatedCount ?? 0))
  const projects = stats.projects ?? projectsFromTimeline(stats.timeline)
  const projectsApproximate = stats.projects === undefined
  const maxProjectInjections = projects.reduce((max, project) => Math.max(max, project.injections), 0)
  const scopeByName = new Map(stats.memories.map(memory => [memory.name, memory.scope]))

  const scopeLabel = (scope: Scope | undefined): string => {
    switch (scope) {
      case 'user': return t('scopeUser')
      case 'project': return t('scopeProject')
      case 'both': return t('scopeBoth')
      default: return t('scopeMissing')
    }
  }

  /** 注入榜一行:作用域圆点 + 名字 + 占比条 + n/m + 截断警告(所有列固定对齐)。 */
  const rankRow = (memory: StatsMemory): ReactNode => {
    const scope = memory.scope ?? 'missing'
    const pct = stats.injections === 0 ? 0 : Math.min(100, (memory.injectedCount / stats.injections) * 100)
    return (
      <div key={memory.name} className="dam-rank-row" data-scope={scope}>
        <span className="dam-scope-dot" title={scopeLabel(memory.scope)} />
        <code className="dam-rank-name" title={memory.name}>{memory.name}</code>
        <span className="dam-mini-bar" title={`${memory.injectedCount}/${stats.injections}`}>
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="dam-ratio">{memory.injectedCount}/{stats.injections}</span>
        <span className="dam-rank-warn">{(memory.truncatedCount ?? 0) > 0 ? `⚠ ${memory.truncatedCount}` : ''}</span>
      </div>
    )
  }

  /** 截断榜一行:同一套作用域圆点/名字对齐,右侧只放截断次数。 */
  const truncRow = (memory: StatsMemory): ReactNode => (
    <div key={memory.name} className="dam-trunc-row" data-scope={scopeByName.get(memory.name) ?? 'missing'}>
      <span className="dam-scope-dot" title={scopeLabel(scopeByName.get(memory.name))} />
      <code className="dam-rank-name" title={memory.name}>{memory.name}</code>
      <span className="dam-warn">⚠ {memory.truncatedCount}</span>
    </div>
  )

  return (
    <details className="dam-stats">
      <summary>
        <span className="dam-stats-glyph" aria-hidden="true">📊</span>
        <span className="dam-stats-titles">
          <span className="dam-stats-title">{t('statsTitle')}</span>
          <span className="dam-stats-sub">
            {stats.sessions} {t('statsSessions')} · {stats.injections} {t('statsInjections')} · {t('statsAvg')} {(avgBytes / 1024).toFixed(1)}K
          </span>
        </span>
        <span className="dam-stats-chev" aria-hidden="true">›</span>
      </summary>

      <div className="dam-stats-body">
        {/* 指标条:一个容器三格,用分隔线而不是三个独立盒子 */}
        <div className="dam-metrics">
          <div className="dam-metric"><b>{stats.sessions}</b><span>{t('statsSessions')}</span></div>
          <div className="dam-metric"><b>{stats.injections}</b><span>{t('statsInjections')}</span></div>
          <div className="dam-metric"><b>{(avgBytes / 1024).toFixed(1)}K</b><span>{t('statsAvg')}</span></div>
        </div>

        <div className="dam-block">
          <div className="dam-block-head">
            <p className="dam-section">{t('statsTopInjected')}</p>
            <div className="dam-legend">
              {(['user', 'project', 'both', 'missing'] as const).map(scope => (
                <span key={scope} className="dam-legend-item">
                  <span className="dam-scope-dot" data-scope={scope} />{scopeLabel(scope)}
                </span>
              ))}
            </div>
          </div>
          {allFull && <p className="dam-note">{t('statsAllInjected', { n: total, m: stats.injections })}</p>}
          {ranked.map(rankRow)}
          {rest.length > 0 && (
            <details className="dam-subdetails">
              <summary>{t('statsAll', { n: total })}</summary>
              {rest.map(rankRow)}
            </details>
          )}
        </div>

        {projects.length > 0 && (
          <div className="dam-block">
            <p className="dam-section">{t('statsProjects')}</p>
            {projectsApproximate && <p className="dam-note">{t('statsProjectsRecent')}</p>}
            <div className="dam-proj-head">
              <span>{t('statsProjectCol')}</span>
              <span>{t('statsProjectSessions')}</span>
              <span>{t('statsProjectInjections')}</span>
              <span />
              <span>{t('statsProjectAvg')}</span>
              <span />
            </div>
            {projects.map((project, index) => {
              const label = project.cwd.split(/[\\/]/).pop() || project.cwd
              const width = maxProjectInjections === 0 ? 0 : Math.min(100, (project.injections / maxProjectInjections) * 100)
              return (
                <div
                  key={project.cwd}
                  className="dam-proj-row"
                  title={projectsApproximate ? project.cwd : `${project.cwd}\n${project.memories} ${t('statsMemories')}`}
                >
                  <code className="dam-proj-name">{label || '—'}</code>
                  <span className="dam-proj-stat">{project.sessions}</span>
                  <span className="dam-proj-stat">{project.injections}</span>
                  <span className="dam-proj-bar">
                    <i style={{
                      width: `${width}%`,
                      background: PROJECT_COLORS[index % PROJECT_COLORS.length],
                    }} />
                  </span>
                  <span className="dam-proj-stat">{(project.avgBytes / 1024).toFixed(1)}K</span>
                  <span className="dam-proj-warn">{project.truncated > 0 ? `⚠ ${project.truncated}` : ''}</span>
                </div>
              )
            })}
          </div>
        )}

        {truncated.length > 0 && (
          <div className="dam-block">
            <p className="dam-section">{t('statsTruncatedTop')}</p>
            {truncated.map(truncRow)}
          </div>
        )}

        <div className="dam-block">
          <p className="dam-section">{t('statsTimeline')}</p>
          <div className="dam-timeline">
            {stats.timeline.slice(-8).reverse().map((entry, index) => (
              <div key={`${entry.sessionId}-${entry.ts}`} className="dam-tl-item" data-latest={index === 0 ? '1' : '0'}>
                <div className="dam-tl-top">
                  <span className="dam-tl-ws" title={entry.cwd}>{(entry.cwd.split(/[\\/]/).pop() ?? entry.cwd) || '—'}</span>
                  <span className="dam-tl-time">{relativeTime(entry.ts, now, t)}</span>
                  {entry.truncated > 0 && <span className="dam-warn">⚠ {entry.truncated}</span>}
                </div>
                <div className="dam-tl-meta">
                  <span className="dam-pill">{entry.count} {t('statsMemories')}</span>
                  <span className="dam-pill">{(entry.bytes / 1024).toFixed(1)} KB</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  )
}

/** 记忆管理面板(face 方法经直通交叉成为顶层 props)。 */
export function MemoryPage({ t, list, read, write, del, currentCwd, importScan, importApply, auditStats, healthReport, exportAgents }: MemoryPageProps): ReactNode {
  const [groups, setGroups] = useState<PanelGroup[] | null>(null)
  const [maxBytes, setMaxBytes] = useState(4096)
  /** 索引净预算(host 扣掉写入指导/协议壳后返回;旧宿主缺失时回退 maxBytes)。 */
  const [budgetBytes, setBudgetBytes] = useState(4096)
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ group: PanelGroup; memory: PanelMemory; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  /** 作用域筛选 chips:all / user / project。 */
  const [scopeFilter, setScopeFilter] = useState('all')
  /** 类型筛选 chips:all / user / feedback / project / reference。 */
  const [typeFilter, setTypeFilter] = useState('all')
  /** 卡片正文展开缓存:key = groupKey\0name;只缓存成功结果,失败可重试。 */
  const [bodies, setBodies] = useState<Record<string, { body?: string, loading?: boolean, error?: boolean }>>({})
  /** 分组折叠状态:未显式设置时,非当前工作区的项目组默认折叠。 */
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({})
  /** 两步删除:当前处于"待确认"状态的记忆名(null=无)。 */
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** 注入审计统计(0.9.0;取不到时静默无统计区——审计绝不影响面板可用性)。 */
  const [stats, setStats] = useState<AuditStatsFace | null>(null)
  /** 记忆体检(1.0.0;旧宿主无路由时 null → 体检区不显示)。 */
  const [health, setHealth] = useState<HealthReportFace | null>(null)
  /** Claude 可同步条数(watcher 透传;undefined = 旧宿主/未扫描,不显示提示)。 */
  const [claudePending, setClaudePending] = useState<number | undefined>(undefined)
  /** 导出 AGENTS.md 的成功提示(导出桥 1.2.0)。 */
  const [exportNote, setExportNote] = useState<string | null>(null)
  /** 导入桥状态机:loading(扫描)→ select(勾选)→ applying → done。 */
  const [importer, setImporter] = useState<ImportState | null>(null)
  /** 扫描请求序号:弹层关闭即作废在途请求,迟到的响应不得复活弹层(审查修复)。 */
  const importSeq = useRef(0)

  const load = useCallback(async () => {
    setError(false)
    try {
      const data = await list()
      setGroups(data.groups as PanelGroup[])
      setMaxBytes(data.maxBytes)
      // 与注入路径同一口径:净预算由宿主计算,旧宿主没有该字段时回退到 maxBytes
      setBudgetBytes(data.budgetBytes ?? data.maxBytes)
      // Claude 可同步条数(watcher 透传;旧宿主无该字段 = undefined 不提示)
      setClaudePending(data.claudeImportPending)
      setNow(Date.now())
    } catch {
      setError(true)
    }
    // 三路并行(审查 minor:串行时大库每次操作双倍全扫延迟)
    const [statsRes, healthRes] = await Promise.allSettled([auditStats(), healthReport()])
    if (statsRes.status === 'fulfilled') setStats(statsRes.value)
    if (healthRes.status === 'fulfilled') setHealth(healthRes.value)
  }, [list, auditStats, healthReport])

  useEffect(() => { void load() }, [load])

  // 导入弹层是模态:Esc 关闭(与遮罩点击同语义)
  useEffect(() => {
    if (importer === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      importSeq.current++
      setImporter(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [importer])

  /** 前端过滤:作用域 + 类型 chips + 名称/标题/摘要子串(不区分大小写)。 */
  const needle = filter.trim().toLowerCase()
  const visibleGroups = useMemo(() => {
    if (groups === null) return null
    const filtering = needle.length > 0 || typeFilter !== 'all'
    return groups
      .filter(g => scopeFilter === 'all' || g.scope === scopeFilter)
      .map(group => ({
        ...group,
        memories: group.memories.filter(memory =>
          (typeFilter === 'all' || memory.type === typeFilter)
          && (needle.length === 0
            || memory.name.toLowerCase().includes(needle)
            || memory.description.toLowerCase().includes(needle)
            || (memory.title ?? '').toLowerCase().includes(needle))),
      }))
      // 过滤态下不再保留"只有索引正文、没有命中记忆"的空组
      .filter(group => group.memories.length > 0 || (!filtering && group.indexText != null))
  }, [groups, needle, scopeFilter, typeFilter])

  /** 类型 chips 的计数:按作用域过滤后的全集统计(与类型筛选无关)。 */
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    if (groups === null) return counts
    for (const group of groups) {
      if (scopeFilter !== 'all' && group.scope !== scopeFilter) continue
      for (const memory of group.memories) counts[memory.type] = (counts[memory.type] ?? 0) + 1
    }
    return counts
  }, [groups, scopeFilter])

  const act = async (fn: () => Promise<Response>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      const response = await fn()
      if (!response.ok) setActionError(response.status === 404 ? t('deleteFailed') : t('saveFailed'))
    } catch {
      setActionError(t('saveFailed')) // 网络层失败不再成为未处理 rejection(#8)
    } finally {
      setBusy(false)
      await load()
    }
  }

  const cwd = (group: PanelGroup): string | undefined => (group.scope === 'project' && group.current === true ? currentCwd() : undefined)

  /** 非当前工作区的项目组没有 cwd,读写必然 400:UI 直接呈现只读,而不是点了报错。 */
  const canWrite = (group: PanelGroup): boolean => group.scope === 'user' || group.current === true

  /** 卡片正文展开/收起(懒加载 + 缓存;只读组没有 cwd,不允许展开)。 */
  const toggleBody = (group: PanelGroup, memory: PanelMemory): void => {
    if (!canWrite(group)) return
    const key = `${group.key}\u0000${memory.name}`
    const cached = bodies[key]
    if (cached?.body !== undefined) {
      setBodies(previous => {
        const next = { ...previous }
        delete next[key]
        return next
      })
      return
    }
    setBodies(previous => ({ ...previous, [key]: { loading: true } }))
    void read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
      .then(detail => { setBodies(previous => ({ ...previous, [key]: { body: detail.body } })) })
      .catch(() => { setBodies(previous => ({ ...previous, [key]: { error: true } })) })
  }

  /** 打开编辑器:先拉取正文(列表响应不含 body);失败中止,绝不以空正文打开。 */
  const openEditor = async (group: PanelGroup, memory: PanelMemory): Promise<void> => {
    try {
      const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
      setEditing({ group, memory, body: detail.body })
    } catch (error) {
      console.warn('[auto-memory] read failed, editor aborted', error)
      await load()
    }
  }

  /** 读正文后整条重写的切换(pin/mute 共用;失败把错误上屏,绝不静默)。 */
  const toggleFlag = (group: PanelGroup, memory: PanelMemory, field: 'pinned' | 'disabled'): void => {
    void (async () => {
      try {
        const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
        await act(() => write({
          cwd: cwd(group), scope: group.scope, name: memory.name, title: memory.title,
          description: memory.description, type: memory.type, body: detail.body,
          pinned: field === 'pinned' ? !memory.pinned : memory.pinned,
          disabled: field === 'disabled' ? !memory.disabled : memory.disabled,
        }))
      } catch (error) {
        // 项目组非当前工作区时 read 会 400(无 cwd)——必须让用户看见,而非无声吞掉
        console.warn('[auto-memory] read failed, toggle aborted', error)
        setActionError(t('saveFailed'))
      }
    })()
  }

  /** 可信状态流转(1.0.0):读正文后带 status 整条重写(verify/dispute/restore 共用)。 */
  const setStatus = (group: PanelGroup, memory: PanelMemory, status: string): void => {
    void (async () => {
      try {
        const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
        await act(() => write({
          cwd: cwd(group), scope: group.scope, name: memory.name, title: memory.title,
          description: memory.description, type: memory.type, body: detail.body,
          pinned: memory.pinned, disabled: memory.disabled, status,
        }))
      } catch (error) {
        console.warn('[auto-memory] status change aborted', error)
        setActionError(t('saveFailed'))
      }
    })()
  }

  if (error) {
    return <div className="dam-root"><p>{t('error')}</p><button className="dam-btn" onClick={() => { void load() }}>{t('retry')}</button></div>
  }
  if (groups === null) {
    return <div className="dam-root"><p>{t('loading')}</p></div>
  }

  const total = groups.reduce((sum, group) => sum + group.memories.length, 0)
  const totalPinned = groups.reduce((sum, group) => sum + group.memories.filter(m => m.pinned).length, 0)
  const totalMuted = groups.reduce((sum, group) => sum + group.memories.filter(m => m.disabled).length, 0)
  const totalStale = groups.reduce((sum, group) => sum + group.memories.filter(m => m.stale && !m.disabled).length, 0)
  // 一次注入只含"用户层 + 当前项目层";其他工作区的索引不计入,不能用全库字节数
  const injectedBytes = groups.reduce((sum, group) =>
    sum + (group.scope === 'user' || group.current === true ? group.indexBytes : 0), 0)
  const totalUsage = injectedBytes / budgetBytes
  const userCount = groups.filter(g => g.scope === 'user').reduce((sum, group) => sum + group.memories.length, 0)
  const projectCount = total - userCount
  const visibleCount = visibleGroups?.reduce((sum, group) => sum + group.memories.length, 0) ?? 0
  const filtering = filter.trim().length > 0 || typeFilter !== 'all' || scopeFilter !== 'all'

  /** 一个分组(可折叠):组头 + 注入预算/索引预览 + 紧凑记忆行。 */
  const renderGroup = (group: PanelGroup): ReactNode => {
    const readonly = !canWrite(group)
    const injected = group.scope === 'user' || group.current === true
    const usage = injected ? group.indexBytes / budgetBytes : 0
    const hot = usage > 0.8
    const pinnedCount = group.memories.filter(m => m.pinned).length
    const mutedCount = group.memories.filter(m => m.disabled).length
    const staleCount = group.memories.filter(m => m.stale && !m.disabled).length
    // 搜索/类型筛选后 group.memories 已是子集:组头同时给出"显示 / 全组"才不误导
    const fullGroup = groups?.find(candidate => candidate.key === group.key)
    const totalInGroup = fullGroup?.memories.length ?? group.memories.length
    const shownCount = group.memories.length
    // 非当前工作区的项目组默认折叠;正在编辑的记忆所在组强制展开
    const defaultClosed = group.scope === 'project' && group.current !== true
    const collapsed = editing?.group.key === group.key ? false : (closedGroups[group.key] ?? defaultClosed)
    // 当前工作区有真实 cwd:直接用 basename,比反解 slug 干净;其他工作区只能截短 slug
    const projectLabel = group.scope === 'project' && group.current === true
      ? (currentCwd()?.split(/[\\/]/).filter(Boolean).pop() ?? shortProjectName(group.slug))
      : shortProjectName(group.slug)
    return (
      <section
        key={group.key}
        className="dam-group"
        data-scope={group.scope}
        data-current={group.current === true ? '1' : '0'}
        data-open={collapsed ? '0' : '1'}
      >
        <button
          type="button"
          className="dam-group-head"
          aria-expanded={!collapsed}
          onClick={() => { setClosedGroups(previous => ({ ...previous, [group.key]: !collapsed })) }}
        >
          <span className="dam-group-icon" aria-hidden="true">{group.scope === 'user' ? '👤' : '📁'}</span>
          <span className="dam-group-name">
            <span className="dam-group-title" title={group.slug}>
              {group.scope === 'user' ? t('userScopeShort') : projectLabel}
            </span>
            <span className="dam-group-sub">
              {group.scope === 'user'
                ? t('userScopeHint')
                : `${t('projectScope')} · ${group.current === true ? t('currentBadge') : t('readonlyBadge')}`}
            </span>
          </span>
          <span className="dam-group-meta">
            {shownCount < totalInGroup ? `${shownCount} / ${totalInGroup}` : String(shownCount)} {t('overviewMemories')}
            {pinnedCount > 0 && <> · 📌 {pinnedCount}</>}
            {mutedCount > 0 && <> · 🔇 {mutedCount}</>}
            {staleCount > 0 && <> · ⏳ {staleCount}</>}
          </span>
          <span className="dam-chevron" aria-hidden="true"><Icon name="chevron" size={12} /></span>
        </button>

        {!collapsed && (
          <div className="dam-group-body">
            <div className="dam-group-tools">
              {injected
                ? (
                  <span className="dam-budget" title={`${formatBytes(injectedBytes)} / ${formatBytes(budgetBytes)}`}>
                    <span className="dam-budget-track"><i data-hot={hot ? '1' : '0'} style={{ width: `${Math.min(100, usage * 100)}%` }} /></span>
                    <span className="dam-budget-label">{formatBytes(group.indexBytes)} / {formatBytes(budgetBytes)}</span>
                  </span>
                )
                : <span className="dam-group-hint">{t('notInjectedHint')}</span>}
              {group.indexText != null && (
                <details className="dam-index">
                  <summary>{t('injectedPreview')}</summary>
                  <pre>{group.indexText}</pre>
                </details>
              )}
            </div>

            <div className="dam-memory-list">
              {group.memories.map(memory => {
                const when = relativeTime(memory.updatedMs, now, t)
                const confirming = deletingName === memory.name
                const bodyState = bodies[`${group.key}\u0000${memory.name}`]
                const expanded = bodyState?.body !== undefined
                const actionsDisabled = busy || importer !== null || readonly
                const readonlyHint = readonly ? t('projectNeedsSession') : undefined
                if (editing !== null && editing.memory.name === memory.name && editing.group.key === group.key) {
                  return (
                    <MemoryEditor
                      key={memory.name}
                      t={t}
                      initial={editing.memory}
                      initialBody={editing.body}
                      busy={busy}
                      inline
                      onCancel={() => { setEditing(null) }}
                      onSave={async payload => {
                        await act(() => write({ cwd: cwd(group), scope: group.scope, ...payload }))
                        setEditing(null)
                      }}
                    />
                  )
                }
                return (
                  <div
                    key={memory.name}
                    className="dam-memory"
                    data-muted={memory.disabled ? '1' : '0'}
                    data-stale={memory.stale && !memory.disabled ? '1' : '0'}
                    data-expanded={expanded ? '1' : '0'}
                  >
                    <div
                      className="dam-memory-main"
                      role={readonly ? undefined : 'button'}
                      tabIndex={readonly ? -1 : 0}
                      title={readonly ? t('projectNeedsSession') : (expanded ? t('hideBody') : t('showBody'))}
                      onClick={() => { if (!readonly) toggleBody(group, memory) }}
                      onKeyDown={event => {
                        if (readonly) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggleBody(group, memory)
                        }
                      }}
                    >
                      <div className="dam-memory-line">
                        <span className={TYPE_TAG[memory.type] ?? TYPE_TAG.reference}>{memory.type}</span>
                        {memory.importedFrom === 'claude-code' && (
                          <span className="dam-badge dam-badge--ok" title={t('importedBadge')}>Claude</span>
                        )}
                        <span className="dam-memory-title">{memory.title ?? memory.name}</span>
                        {memory.pinned && <span className="dam-memory-pin" title={t('pinned')}>📌</span>}
                        {memory.disabled && <span className="dam-badge dam-badge--muted">{t('mutedShort')}</span>}
                        {memory.stale && !memory.disabled && <span className="dam-badge dam-badge--warn">{t('staleShort')}</span>}
                        {memory.status === 'candidate' && <span className="dam-badge dam-badge--cand" title={t('statusTipCandidate')}>? {t('statusCandidate')}</span>}
                        {memory.status === 'verified' && <span className="dam-badge dam-badge--ok" title={t('statusVerified')}>✓ {t('statusVerified')}</span>}
                        {memory.status === 'disputed' && <span className="dam-badge dam-badge--danger" title={t('statusTipDisputed')}>⊘ {t('statusDisputed')}</span>}
                        {memory.status === 'superseded' && <span className="dam-badge dam-badge--muted" title={t('statusSuperseded')}>⟳ {t('statusSuperseded')}</span>}
                        <span
                          className="dam-memory-time"
                          title={memory.updatedMs !== undefined ? new Date(memory.updatedMs).toLocaleString() : undefined}
                        >{memory.reads} {t('reads')}{when !== null ? ` · ${when}` : ''}</span>
                      </div>
                      <p className="dam-memory-desc">{memory.description}</p>
                      {bodyState?.loading === true && <p className="dam-note">⏳ {t('bodyLoading')}</p>}
                      {bodyState?.error === true && <p className="dam-err">{t('bodyLoadFailed')}</p>}
                    </div>

                    <div className="dam-memory-actions">
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-on={expanded ? '1' : '0'}
                        disabled={actionsDisabled}
                        title={readonlyHint ?? (expanded ? t('hideBody') : t('showBody'))}
                        aria-label={expanded ? t('hideBody') : t('showBody')}
                        onClick={() => { toggleBody(group, memory) }}
                      ><Icon name="book" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        disabled={actionsDisabled}
                        title={readonlyHint ?? t('edit')}
                        aria-label={t('edit')}
                        onClick={() => { void openEditor(group, memory) }}
                      ><Icon name="edit" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-on={memory.pinned ? '1' : '0'}
                        disabled={actionsDisabled}
                        title={readonlyHint ?? (memory.pinned ? t('unpinAction') : t('pinAction'))}
                        aria-label={memory.pinned ? t('unpinAction') : t('pinAction')}
                        onClick={() => { toggleFlag(group, memory, 'pinned') }}
                      ><Icon name="pin" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-on={memory.disabled ? '1' : '0'}
                        disabled={actionsDisabled}
                        title={readonlyHint ?? (memory.disabled ? t('unmuteAction') : t('muteAction'))}
                        aria-label={memory.disabled ? t('unmuteAction') : t('muteAction')}
                        onClick={() => { toggleFlag(group, memory, 'disabled') }}
                      ><Icon name={memory.disabled ? 'unmute' : 'mute'} /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-danger="1"
                        disabled={actionsDisabled}
                        title={readonlyHint ?? t('delete')}
                        aria-label={t('delete')}
                        onClick={() => { setDeletingName(memory.name) }}
                      ><Icon name="trash" /></button>
                    </div>

                    {expanded && bodyState?.body !== undefined && <pre className="dam-body dam-memory-body">{bodyState.body}</pre>}

                    {/* 证据链(1.0.0):固化产物的来源会话与逐字摘录——验证决策的依据 */}
                    {expanded && memory.evidence !== undefined && (
                      <div className="dam-evidence" title={`${t('evidenceTitle')} · ${memory.evidence.sessionId}`}>
                        <span className="dam-evidence-label">{t('evidenceTitle')}</span>
                        <span className="dam-evidence-quote">“{memory.evidence.quote}”</span>
                      </div>
                    )}

                    {/* 可信状态操作(1.0.0):candidate→验证/质疑;disputed/superseded→恢复注入 */}
                    {memory.status === 'candidate' && !readonly && (
                      <div className="dam-status-actions">
                        <button type="button" className="dam-btn dam-btn-primary" disabled={busy || actionsDisabled} title={t('statusTipCandidate')} onClick={() => { setStatus(group, memory, 'verified') }}>{t('verifyAction')}</button>
                        <button type="button" className="dam-btn" disabled={busy || actionsDisabled} onClick={() => { setStatus(group, memory, 'disputed') }}>{t('disputeAction')}</button>
                      </div>
                    )}
                    {(memory.status === 'disputed' || memory.status === 'superseded') && !readonly && (
                      <div className="dam-status-actions">
                        {/* 恢复 = 回到 candidate 待验证(而非直接 verified)——
                            争议内容的复核必须重新过验证,审查确认 verified 太强 */}
                        <button type="button" className="dam-btn" disabled={busy || actionsDisabled} onClick={() => { setStatus(group, memory, 'candidate') }}>{t('restoreAction')}</button>
                      </div>
                    )}

                    {confirming && (
                      <div className="dam-memory-confirm">
                        <span>{t('confirmDelete')}</span>
                        <button
                          type="button"
                          className="dam-btn dam-btn-danger"
                          disabled={busy}
                          onClick={() => {
                            setDeletingName(null)
                            void act(() => del({ cwd: cwd(group), scope: group.scope, name: memory.name }))
                          }}
                        >{t('delete')}</button>
                        <button type="button" className="dam-btn" disabled={busy} onClick={() => { setDeletingName(null) }}>{t('cancel')}</button>
                      </div>
                    )}
                  </div>
                )
              })}
              {group.memories.length === 0 && <p className="dam-note">{t('noSearchHits')}</p>}
            </div>
          </div>
        )}
      </section>
    )
  }

  const userGroups = visibleGroups?.filter((g: PanelGroup) => g.scope === 'user') ?? []
  const projectGroups = visibleGroups?.filter((g: PanelGroup) => g.scope !== 'user') ?? []

  return (
    <div className="dam-root">
      <div className="dam-shell">
      <header className="dam-header">
        <div className="dam-heading">
          <h2 className="dam-title">{t('title')}</h2>
          <p className="dam-intro">{t('intro')}</p>
        </div>
        <div className="dam-header-actions">
          {/* 反向导出桥(1.2.0):信任态记忆 → AGENTS.md 片段,复制到剪贴板 */}
          <button
            type="button"
            className="dam-btn dam-btn-ghost"
            disabled={busy}
            title={t('exportTip')}
            onClick={() => {
              void exportAgents()
                .then(res => navigator.clipboard.writeText(res.content))
                .then(() => { setActionError(null); setExportNote(t('exportDone')) })
                .catch(() => { setExportNote(null); setActionError(t('exportFailed')) })
            }}
          >⬇ {t('exportAction')}</button>
          <button type="button" className="dam-btn dam-btn-ghost" onClick={() => { void load() }} disabled={busy}>
            <Icon name="refresh" /> {t('refresh')}
          </button>
          <button
            type="button"
            className="dam-btn dam-btn-primary"
            disabled={busy || importer !== null || editing !== null}
            onClick={() => {
              const seq = ++importSeq.current
              setImporter({ phase: 'loading' })
              void importScan()
                .then(scan => {
                  if (seq !== importSeq.current) return // 弹层已关闭:丢弃迟到响应
                  if (scan.found && scan.projects.length > 0) {
                    // 默认全选:未导入=待导入,已导入=保留;取消勾选才是"撤销"
                    const selected: Record<string, boolean> = {}
                    for (const p of scan.projects) {
                      for (const f of p.files) selected[importKey(p.slug, f.file)] = true
                    }
                    setImporter({ phase: 'select', projects: scan.projects, selected, allToUser: false })
                  } else {
                    setImporter({ phase: 'empty' })
                  }
                })
                .catch(() => {
                  if (seq !== importSeq.current) return
                  setImporter({ phase: 'failed' })
                })
            }}
          >
            <Icon name="download" /> {t('importBtn')}
          </button>
        </div>
      </header>

      {/* 导入提示条(watcher 透传:Claude 目录有可同步记忆且尚未打开过导入时) */}
      {claudePending !== undefined && claudePending > 0 && importer === null && (
        <div className="dam-import-hint">
          <span>📥 {t('importHint', { n: claudePending })}</span>
          <button type="button" className="dam-btn" onClick={() => {
            const btn = document.querySelector<HTMLButtonElement>('.dam-header-actions .dam-btn-primary')
            btn?.click()
          }}>{t('healthView')}</button>
        </div>
      )}
      {exportNote !== null && <div className="dam-export-note">✓ {exportNote}</div>}

      <div className="dam-overview">
        <span className="dam-stat"><b>{filtering ? `${String(visibleCount)} / ${String(total)}` : String(total)}</b> {t('overviewMemories')}</span>
        <span className="dam-stat"><b>{totalPinned}</b> {t('overviewPinned')}</span>
        <span className="dam-stat"><b>{totalMuted}</b> {t('overviewMuted')}</span>
        {totalStale > 0 && <span className="dam-stat"><b>{totalStale}</b> {t('overviewStale')}</span>}
        <span className="dam-usage" title={`${t('budget')} ${formatBytes(maxBytes)}`}>
          <span className="dam-usage-label">{t('indexUsage')} {Math.round(totalUsage * 100)}% · {formatBytes(injectedBytes)} / {formatBytes(budgetBytes)}</span>
          <span className="dam-usage-track"><i data-hot={totalUsage > 0.8 ? '1' : '0'} style={{ width: `${Math.min(100, totalUsage * 100)}%` }} /></span>
        </span>
      </div>

      <div className="dam-toolbar">
        <div className="dam-search">
          <span className="dam-search-icon"><Icon name="search" size={13} /></span>
          <input
            value={filter}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            onChange={event => { setFilter(event.target.value) }}
          />
          {filter.trim().length > 0 && (
            <button type="button" className="dam-search-clear" title={t('clearFilters')} aria-label={t('clearFilters')} onClick={() => { setFilter('') }}>
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
        <div className="dam-segment" role="group" aria-label={t('overviewMemories')}>
          {([['all', t('allScopes'), total], ['user', t('userScopeShort'), userCount], ['project', t('projectScope'), projectCount]] as const).map(([key, label, count]) => (
            <button
              type="button"
              key={key}
              data-on={scopeFilter === key ? '1' : '0'}
              onClick={() => { setScopeFilter(key) }}
            >{label} <span>{count}</span></button>
          ))}
        </div>
        <select
          className="dam-select"
          aria-label={t('allTypes')}
          value={typeFilter}
          onChange={event => { setTypeFilter(event.target.value) }}
        >
          <option value="all">{t('allTypes')} · {total}</option>
          {TYPE_ORDER.map(type => (
            <option key={type} value={type}>{type} · {typeCounts[type] ?? 0}</option>
          ))}
        </select>
        {filtering && (
          <button
            type="button"
            className="dam-btn dam-btn-ghost"
            onClick={() => { setFilter(''); setScopeFilter('all'); setTypeFilter('all') }}
          >{t('clearFilters')}</button>
        )}
      </div>

      {actionError !== null && <div className="dam-err dam-banner">{actionError}</div>}

      {total === 0 && (
        <div className="dam-empty">
          <span className="dam-empty-icon" aria-hidden="true">🧠</span>
          <h3>{t('emptyTitle')}</h3>
          <p>{t('emptyStep1')}</p>
          <p className="dam-note">{t('emptyStep2')} · {t('emptyStep3')}</p>
        </div>
      )}

      {stats !== null && stats.injections > 0 && <StatsSection stats={stats} t={t} now={now} />}
      {health !== null && (health.unverified.length > 0 || health.zombies.length > 0 || health.conflicts.length > 0) && (
        <HealthSection health={health} t={t} />
      )}

      <div className="dam-groups">
        {userGroups.map(renderGroup)}
        {projectGroups.map(renderGroup)}
      </div>

      {total > 0 && (visibleGroups?.length ?? 0) === 0 && <p className="dam-note">{t('noSearchHits')}</p>}

      {importer !== null && (
        <div
          className="dam-modal-backdrop"
          onMouseDown={event => {
            if (event.target !== event.currentTarget) return
            importSeq.current++
            setImporter(null)
          }}
        >
          <div className="dam-modal" role="dialog" aria-modal="true" aria-label={t('importTitle')}>
            <ImportDialog
              t={t}
              state={importer}
              onClose={() => { importSeq.current++; setImporter(null) }}
              onToggleProject={(slug, value) => {
                if (importer.phase !== 'select') return
                const project = importer.projects.find(p => p.slug === slug)
                if (project === undefined) return
                const selected = { ...importer.selected }
                // 父勾选只作用于可操作条目:已修改/同名占用永远保留,不参与批量切换
                for (const f of project.files) {
                  if (f.state === 'pending' || f.state === 'imported' || f.state === 'legacy') {
                    selected[importKey(slug, f.file)] = value
                  }
                }
                setImporter({ ...importer, selected })
              }}
              onToggleFile={(slug, file, value) => {
                if (importer.phase !== 'select') return
                setImporter({ ...importer, selected: { ...importer.selected, [importKey(slug, file)]: value } })
              }}
              onAllToUser={value => {
                if (importer.phase !== 'select') return
                setImporter({ ...importer, allToUser: value })
              }}
              onApply={async () => {
                if (importer.phase !== 'select') return
                // 勾选的 pending = 导入;取消勾选的 imported = 撤销;modified/conflict 不参与
                const items: Array<{ slug: string, file: string }> = []
                const revoke: Array<{ slug: string, file: string }> = []
                for (const project of importer.projects) {
                  for (const file of project.files) {
                    const checked = importer.selected[importKey(project.slug, file.file)] === true
                    if (checked && file.state === 'pending') items.push({ slug: project.slug, file: file.file })
                    if (!checked && (file.state === 'imported' || file.state === 'legacy')) {
                      revoke.push({ slug: project.slug, file: file.file })
                    }
                  }
                }
                if (items.length === 0 && revoke.length === 0) return
                setImporter({ phase: 'applying' })
                try {
                  const response = await importApply({ items, revoke, allToUser: importer.allToUser })
                  if (!response.ok) throw new Error(String(response.status))
                  const result = await response.json() as {
                    imported: number, skipped: number, failed: number,
                    revoked: number, keptModified: number, revokeMissing: number,
                  }
                  const kept = result.keptModified + result.revokeMissing
                  setImporter({
                    phase: 'done',
                    summary: t('importDone', { n: result.imported, s: result.skipped, f: result.failed, r: result.revoked })
                      + (kept > 0 ? ` ${t('importKeptNote', { k: kept })}` : ''),
                  })
                } catch {
                  // 执行失败≠扫描失败:部分记忆可能已落盘/已撤销,刷新列表 + 独立文案
                  setImporter({ phase: 'runFailed' })
                } finally {
                  await load()
                }
              }}
            />
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/** 单条记忆编辑器(标题/摘要/正文,保存即重建索引、下次注入生效)。
 * inline=true:在被编辑卡片的原位展开(0.9.1 行内编辑),去 sticky 浮层形态
 * 并自动滚入视野;缺省(false)保持底部浮层形态(兼容既有调用面)。 */
function MemoryEditor({ t, initial, initialBody, busy, inline, onSave, onCancel }: {
  t: Translate
  initial: PanelMemory
  initialBody: string
  /** 保存进行中:禁用 Save/Cancel,防双击重复提交(#8) */
  busy: boolean
  inline?: boolean
  onSave: (payload: { name: string; title?: string; description: string; type: string; body: string; pinned?: boolean }) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [title, setTitle] = useState(initial.title ?? '')
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initialBody)
  const rootRef = useRef<HTMLDivElement>(null)
  // 行内编辑展开时滚到最近可见位置:编辑器比卡片高,不滚可能落在视口外
  useEffect(() => {
    if (inline) rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inline])
  return (
    <div ref={rootRef} className={inline ? 'dam-form dam-form--inline' : 'dam-form'}>
      <div className="dam-form-title"><span className="dam-form-bar" />{t('edit')}: <code>{initial.name}</code></div>
      <label className="dam-label">{t('titleField')}</label>
      <input className="dam-input" value={title} onChange={event => { setTitle(event.target.value) }} />
      <label className="dam-label">{t('descriptionField')}</label>
      <input className="dam-input" value={description} onChange={event => { setDescription(event.target.value) }} />
      <label className="dam-label">{t('bodyField')}</label>
      <textarea className="dam-textarea" value={body} onChange={event => { setBody(event.target.value) }} />
      <div className="dam-row">
        <button className="dam-btn dam-btn-primary" disabled={busy} onClick={() => { void onSave({ name: initial.name, title: title.trim().length > 0 ? title.trim() : undefined, description, type: initial.type, body, pinned: initial.pinned }) }}>💾 {t('save')}</button>
        <button className="dam-btn" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </div>
  )
}

/**
 * 导入 Claude Code 记忆的浮层弹窗(0.8.0;0.10.0 逐条选择 + 撤销):
 * loading → empty/failed → select(逐项目/逐条勾选,已导入条目取消勾选=撤销)
 * → applying → done(结果摘要;关闭后列表已刷新)。
 */
function ImportDialog({ t, state, onClose, onToggleProject, onToggleFile, onAllToUser, onApply }: {
  t: Translate
  state: ImportState
  onClose: () => void
  onToggleProject: (slug: string, value: boolean) => void
  onToggleFile: (slug: string, file: string, value: boolean) => void
  onAllToUser: (value: boolean) => void
  onApply: () => Promise<void>
}): ReactNode {
  // 操作计数:勾选的 pending = 将导入;取消勾选的 imported = 将撤销
  const counts = state.phase === 'select'
    ? state.projects.reduce((acc, project) => {
      for (const file of project.files) {
        const checked = state.selected[importKey(project.slug, file.file)] === true
        if (checked && file.state === 'pending') acc.pending += 1
        if (!checked && (file.state === 'imported' || file.state === 'legacy')) acc.revoke += 1
      }
      return acc
    }, { pending: 0, revoke: 0 })
    : { pending: 0, revoke: 0 }
  return (
    <div className="dam-form">
      <div className="dam-form-title"><span className="dam-form-bar" />{t('importTitle')}</div>
      {state.phase === 'loading' && <p style={{ margin: '12px 0' }}>⏳ …</p>}
      {state.phase === 'empty' && <p style={{ margin: '12px 0' }}>{t('importEmpty')}</p>}
      {state.phase === 'failed' && <p className="dam-err" style={{ margin: '12px 0' }}>{t('importScanFailed')}</p>}
      {state.phase === 'runFailed' && <p className="dam-err" style={{ margin: '12px 0' }}>{t('importRunFailed')}</p>}
      {state.phase === 'select' && (
        <div>
          <div className="dam-import-wrap">
            {state.projects.map(project => {
              const selectable = project.files.filter(f => f.state === 'pending' || f.state === 'imported' || f.state === 'legacy')
              const allChecked = selectable.length > 0
                && selectable.every(f => state.selected[importKey(project.slug, f.file)] === true)
              const someChecked = selectable.some(f => state.selected[importKey(project.slug, f.file)] === true)
              const importedCount = project.files.filter(f => f.state === 'imported').length
              return (
                <div key={project.slug} className="dam-import-group">
                  <div className="dam-import-head">
                    {selectable.length > 0 && (
                      <input
                        type="checkbox"
                        className="dam-check"
                        checked={allChecked}
                        ref={el => { if (el !== null) el.indeterminate = someChecked && !allChecked }}
                        onChange={e => { onToggleProject(project.slug, e.target.checked) }}
                      />
                    )}
                    <code className="dam-import-slug">{project.slug}</code>
                    <span className="dam-group-meta">
                      {project.targetScope === 'project'
                        ? <>📁 <code style={{ fontSize: 11 }}>{project.targetDir}</code></>
                        : <>👤 {t('importNoCwd')}</>}
                    </span>
                    {importedCount > 0 && (
                      <span className="dam-badge dam-badge--ok">{t('importStateImported')} {importedCount}</span>
                    )}
                  </div>
                  <div className="dam-import-items">
                    {project.files.map(file => {
                      const checked = state.selected[importKey(project.slug, file.file)] === true
                      // modified/conflict 锁死:撤销只处理"导入后未改动"的条目
                      const locked = file.state === 'modified' || file.state === 'conflict'
                      return (
                        <label key={file.file} className="dam-import-item" data-locked={locked ? '1' : '0'}>
                          <input
                            type="checkbox"
                            className="dam-check"
                            checked={checked}
                            disabled={locked}
                            onChange={e => { onToggleFile(project.slug, file.file, e.target.checked) }}
                          />
                          <span className="dam-import-main">
                            <span className="dam-import-name">
                              <code>{file.name}</code> <span className="dam-import-file">{file.file}</span>
                            </span>
                            <span className="dam-import-desc">{file.description}</span>
                          </span>
                          {file.state === 'imported' && (
                            <span className="dam-badge dam-badge--ok">{t('importStateImported')}</span>
                          )}
                          {file.state === 'legacy' && (
                            <span className="dam-badge dam-badge--ok" title={t('importStateLegacyHint')}>{t('importStateLegacy')}</span>
                          )}
                          {file.state === 'modified' && (
                            <span className="dam-badge dam-badge--warn" title={t('importStateModifiedHint')}>{t('importStateModified')}</span>
                          )}
                          {file.state === 'conflict' && (
                            <span className="dam-badge dam-badge--muted" title={t('importStateConflictHint')}>{t('importStateConflict')}</span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="dam-label">
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" className="dam-check" checked={state.allToUser} onChange={e => { onAllToUser(e.target.checked) }} /> {t('importAllToUser')}
            </label>
          </p>
          <p className="dam-note">{t('importRevokeWarning')}</p>
        </div>
      )}
      {state.phase === 'applying' && <p style={{ margin: '12px 0' }}>{t('importApplying')}</p>}
      {state.phase === 'done' && <p style={{ margin: '12px 0' }}>✅ {state.summary}</p>}
      <div className="dam-row">
        {state.phase === 'select' && (
          <button
            className="dam-btn dam-btn-primary"
            disabled={counts.pending === 0 && counts.revoke === 0}
            onClick={() => { void onApply() }}
          >📥 {t('importApplyCount', { n: counts.pending, r: counts.revoke })}</button>
        )}
        {state.phase === 'done' && (
          <button className="dam-btn dam-btn-primary" onClick={onClose}>✓ {t('refresh')}</button>
        )}
        {state.phase !== 'applying' && state.phase !== 'done' && (
          <button className="dam-btn" onClick={onClose}>{t('cancel')}</button>
        )}
      </div>
    </div>
  )
}
