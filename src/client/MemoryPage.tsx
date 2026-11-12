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
  /** 已过有效期(1.6.0):不注入、文件保留,可续期。 */
  expired: boolean
  /** 有效期(epoch ms;缺省 = 永久)。 */
  validUntilMs?: number
  /** 可信状态(缺省 = 信任态;disputed/superseded 不注入)。 */
  status?: string
  /** #19 谱系:被取代(值=后继名)与取代(值=前代名)。 */
  supersededBy?: string
  supersedes?: string
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

/** 记忆体检响应形状(health.report,1.0.0;1.6.0 加 expired 榜)。 */
interface HealthReportFace {
  unverified: Array<{ name: string; scope: string; slug: string; hasEvidence: boolean }>
  zombies: Array<{ name: string; scope: string; slug: string; ageDays: number }>
  conflicts: Array<{ kind: 'cross-scope' | 'near-duplicate'; a: { name: string; scope: string }; b: { name: string; scope: string } }>
  expired: Array<{ name: string; scope: string; slug: string; expiredDays: number }>
}

/** 设置中心响应形状(config.get,1.4.0)。 */
interface SettingsFace {
  effective: Record<string, number | boolean>
  overrides: Record<string, number | boolean>
  sources: Record<string, string>
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
  timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number; injected?: string[]; truncatedNames?: string[] }>
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
/**
 * 类型标签:低饱和 tinted chip(1.6.0 用户实测反馈:全中性后记忆行灰成一片、
 * 无从扫读)——12% 透明底 + 对应色文字,彩色恢复"扫读区分度"但依然克制
 * (色块面积小,不与作用域身份色竞争)。
 */
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
  upload: ['M12 21V9', 'm7 14 5-5 5 5', 'M4 3h16'],
  chevron: ['m9 6 6 6-6 6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  pulse: ['M3 12h4l2-7 4 14 2-7h6'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 3'],
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
 * 记忆体检(1.0.0):待验证/僵尸/矛盾三榜——只读报告,行动在对应记忆卡片上
 * (卡片带 candidate 徽章与 ✓/⊘ 按钮;行内标注归属层)。
 * 1.5.0:并入独立体检 tab;每行可点 = 切回记忆 tab 并直达该卡片(onLocate)。
 * 1.6.0:第四榜「已过期」+ 行内一键续期 90 天(onRenew)。
 */
function HealthSection({ health, t, onLocate, onRenew, busy }: { health: HealthReportFace; t: Translate; onLocate: (name: string) => void; onRenew: (target: { name: string; scope: string; slug: string }) => Promise<void>; busy: boolean }): ReactNode {
  const scopeLabel = (scope: string): string => (scope === 'user' ? t('scopeUser') : t('scopeProject'))
  return (
    <section className="dam-stats">
      <header className="dam-stats-head">
        <span className="dam-stats-glyph" aria-hidden="true"><Icon name="pulse" size={15} /></span>
        <span className="dam-stats-titles">
          <span className="dam-stats-title">{t('healthTitle')}</span>
          <span className="dam-stats-sub">{t('healthHint')}</span>
        </span>
        <span className="dam-row" style={{ gap: '5px', marginLeft: 'auto', marginRight: '4px' }}>
          {health.unverified.length > 0 && <span className="dam-health-pill" data-kind="unverified">? {health.unverified.length}</span>}
          {health.zombies.length > 0 && <span className="dam-health-pill" data-kind="zombies"><Icon name="clock" size={10} /> {health.zombies.length}</span>}
          {health.expired.length > 0 && <span className="dam-health-pill" data-kind="conflicts">⏱ {health.expired.length}</span>}
          {health.conflicts.length > 0 && <span className="dam-health-pill" data-kind="conflicts">⚠ {health.conflicts.length}</span>}
        </span>
      </header>
      <div className="dam-health-cols">
        <div className="dam-block">
          <p className="dam-section">{t('healthUnverified')}</p>
          {health.unverified.length === 0 && <p className="dam-note">{t('healthNone')}</p>}
          {health.unverified.map(m => (
            <button
              type="button"
              key={`u-${m.scope}-${m.slug}-${m.name}`}
              className="dam-health-row"
              title={t('healthLocateTip')}
              onClick={() => { onLocate(m.name) }}
            >
              <span className="dam-badge dam-badge--cand">? {t('statusCandidate')}</span>
              <code title={m.name}>{m.name}</code>
              <span className="dam-health-meta">{scopeLabel(m.scope)}{m.hasEvidence ? ' · 📎' : ''}</span>
            </button>
          ))}
        </div>
        <div className="dam-block">
          <p className="dam-section">{t('healthZombies')}</p>
          {health.zombies.length === 0 && <p className="dam-note">{t('healthNone')}</p>}
          {health.zombies.map(m => (
            <button
              type="button"
              key={`z-${m.scope}-${m.slug}-${m.name}`}
              className="dam-health-row"
              title={t('healthLocateTip')}
              onClick={() => { onLocate(m.name) }}
            >
              <span className="dam-badge dam-badge--muted"><Icon name="clock" size={10} /></span>
              <code title={m.name}>{m.name}</code>
              <span className="dam-health-meta">{scopeLabel(m.scope)} · {m.ageDays}d</span>
            </button>
          ))}
        </div>
        <div className="dam-block">
          <p className="dam-section">{t('healthConflicts')}</p>
          {health.conflicts.length === 0 && <p className="dam-note">{t('healthNone')}</p>}
          {health.conflicts.map((c, i) => (
            <button
              type="button"
              key={`c-${String(i)}`}
              className="dam-health-row"
              title={t('healthLocateTip')}
              onClick={() => { onLocate(c.a.name) }}
            >
              <span className="dam-badge dam-badge--danger">{c.kind === 'cross-scope' ? t('healthCrossScope') : t('healthNearDup')}</span>
              <code title={c.a.name}>{c.a.name}</code>
              <span className="dam-health-meta" title={`${c.b.name} (${scopeLabel(c.b.scope)})`}>↔ {c.b.name} ({scopeLabel(c.b.scope)})</span>
            </button>
          ))}
        </div>
        <div className="dam-block">
          <p className="dam-section">{t('healthExpired')}</p>
          {health.expired.length === 0 && <p className="dam-note">{t('healthNone')}</p>}
          {health.expired.map(m => (
            <span key={`e-${m.scope}-${m.slug}-${m.name}`} className="dam-health-row">
              <button type="button" className="dam-health-locate" title={t('healthLocateTip')} onClick={() => { onLocate(m.name) }}>
                <span className="dam-badge dam-badge--warn">⏱ {t('expiredAgo', { n: m.expiredDays })}</span>
                <code title={m.name}>{m.name}</code>
                <span className="dam-health-meta">{scopeLabel(m.scope)}</span>
              </button>
              <button type="button" className="dam-btn" disabled={busy} title={t('renewAction')} onClick={() => { void onRenew({ name: m.name, scope: m.scope, slug: m.slug }) }}>{t('renewAction')}</button>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

function StatsSection({ stats, t, now, groups, budgetBytes }: { stats: AuditStatsFace; t: Translate; now: number; groups: PanelGroup[] | null; budgetBytes: number }): ReactNode {
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
  const truncTotal = stats.memories.reduce((sum, m) => sum + (m.truncatedCount ?? 0), 0)
  const projects = stats.projects ?? projectsFromTimeline(stats.timeline)
  const projectsApproximate = stats.projects === undefined
  const maxProjectInjections = projects.reduce((max, project) => Math.max(max, project.injections), 0)
  const scopeByName = new Map(stats.memories.map(memory => [memory.name, memory.scope]))
  /** 时间线展开状态:当前展开的注入事件 ts(null=全部收起)。 */
  const [openTs, setOpenTs] = useState<number | null>(null)

  // ---- 1.4.0 新增派生数据 ----
  /** 活动柱图:最近 24 次注入(时间升序),高=字节,全柱品牌蓝+latest 强调。
   * 1.6.0 修复:定标含当前生效预算(scaleMax = max(数据, 预算))——Y 轴与
   * 预算参考线随设置中心的索引预算即刻变化,而不是停在历史数据的量级 */
  const activity = stats.timeline.slice(-24)
  const maxActivityBytes = activity.reduce((max, e) => Math.max(max, e.bytes), 0)
  const scaleMax = Math.max(maxActivityBytes, budgetBytes)
  /** 预算参考线位置(图内百分比;贴顶/贴底时略收以免溢出边框) */
  const budgetLinePos = budgetBytes > 0
    ? Math.min(96, Math.max(2, Math.round(100 - (budgetBytes / scaleMax) * 100)))
    : null
  /** 作用域分布:按注入次数加权的 user/project/both/missing 份额 */
  const scopeShare = new Map<Scope | 'missing', number>()
  for (const m of stats.memories) {
    const key = m.scope ?? 'missing'
    scopeShare.set(key, (scopeShare.get(key) ?? 0) + m.injectedCount)
  }
  const scopeTotal = [...scopeShare.values()].reduce((a, b) => a + b, 0) || 1
  /** 类型分布:全库记忆的 4 类型条数(groups 全集,与 stats 正交) */
  const typeShare = new Map<string, number>()
  let typeTotal = 0
  if (groups !== null) {
    for (const g of groups) {
      for (const m of g.memories) {
        typeShare.set(m.type, (typeShare.get(m.type) ?? 0) + 1)
        typeTotal += 1
      }
    }
  }

  const scopeLabel = (scope: Scope | undefined): string => {
    switch (scope) {
      case 'user': return t('scopeUser')
      case 'project': return t('scopeProject')
      case 'both': return t('scopeBoth')
      default: return t('scopeMissing')
    }
  }

  /** 注入榜一行:排名 + 作用域圆点 + 名字 + 占比条 + n/m + 截断警告。 */
  const rankRow = (memory: StatsMemory, index: number): ReactNode => {
    const scope = memory.scope ?? 'missing'
    const pct = stats.injections === 0 ? 0 : Math.min(100, (memory.injectedCount / stats.injections) * 100)
    return (
      <div key={memory.name} className="dam-rank-row" data-scope={scope} data-rank={String(index + 1)}>
        <span className="dam-rank-num">{index + 1}</span>
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

  /** 分布条一段(seg):纯色块,宽度=份额;百分比写在图例行(段内白字在浅色
   段上对比度不足,实测叠字看不清——1.5.0 审查后用户实测反馈)。 */
  const distSeg = (key: string, kind: 'scope' | 'type', value: number, colorHint: string, label: string): ReactNode => {
    const pct = (value / (kind === 'scope' ? scopeTotal : typeTotal)) * 100
    if (pct <= 0) return null
    return (
      <span
        key={key}
        className="dam-dist-seg"
        data-scope={kind === 'scope' ? key : undefined}
        data-type={kind === 'type' ? key : undefined}
        style={{ width: `${pct}%` }}
        title={`${label}: ${value} (${Math.round(pct)}%)${colorHint.length > 0 ? '' : ''}`}
      />
    )
  }

  return (
    <section className="dam-stats">
      <header className="dam-stats-head">
        <span className="dam-stats-glyph" aria-hidden="true"><Icon name="chart" size={15} /></span>
        <span className="dam-stats-titles">
          <span className="dam-stats-title">{t('statsTitle')}</span>
          <span className="dam-stats-sub">
            {stats.sessions} {t('statsSessions')} · {stats.injections} {t('statsInjections')} · {t('statsAvg')} {(avgBytes / 1024).toFixed(1)}K
          </span>
        </span>
      </header>

      <div className="dam-stats-body">
        {/* 指标条:四格(会话/注入/均段/截断) */}
        <div className="dam-metrics">
          <div className="dam-metric"><b>{stats.sessions}</b><span>{t('statsSessions')}</span></div>
          <div className="dam-metric"><b>{stats.injections}</b><span>{t('statsInjections')}</span></div>
          <div className="dam-metric"><b>{(avgBytes / 1024).toFixed(1)}K</b><span>{t('statsAvg')}</span></div>
          <div className="dam-metric"><b style={{ color: truncTotal > 0 ? 'var(--dsw-alias-state-warn-primary,#d97706)' : undefined }}>{truncTotal}</b><span>{t('statsTruncMetric')}</span></div>
        </div>

        {/* 活动柱图:最近注入的字节走势;**定标含当前生效预算**(1.6.0 修复:
            用户反馈 Y 轴停在旧数据量级、不随设置中心的索引预算变化——现在
            Y 轴顶 = max(数据, 预算),并画预算虚线参考线,改预算即刻可见) */}
        {activity.length > 1 && (
          <div className="dam-block">
            <p className="dam-section">{t('statsActivity')}</p>
            <div className="dam-chart-row">
              <div className="dam-chart-y" aria-hidden="true">
                <span>{(scaleMax / 1024).toFixed(1)}K</span>
                <span>{(scaleMax / 2048).toFixed(1)}K</span>
                <span>0</span>
              </div>
              <div className="dam-chart">
                <div className="dam-chart-grid" aria-hidden="true"><i /><i /><i /></div>
                {budgetLinePos !== null && (
                  <span
                    className="dam-chart-budget"
                    style={{ top: `${budgetLinePos}%` }}
                    title={`${t('budget')} ${formatBytes(budgetBytes)}`}
                  >
                    <b>{formatBytes(budgetBytes)}</b>
                  </span>
                )}
                {activity.map((entry, index) => {
                  const height = scaleMax === 0 ? 4 : Math.max(6, Math.round((entry.bytes / scaleMax) * 100))
                  const isLatest = index === activity.length - 1
                  const label = (entry.cwd.split(/[\\/]/).pop() ?? entry.cwd) || '—'
                  return (
                    <span
                      key={`${entry.sessionId}-${entry.ts}`}
                      className="dam-chart-bar"
                      data-latest={isLatest ? '1' : '0'}
                      style={{ height: `${height}%` }}
                      title={`${label} · ${(entry.bytes / 1024).toFixed(1)}K · ${entry.count}${t('statsMemories')}${entry.truncated > 0 ? ` · ⚠${entry.truncated}` : ''}\n${new Date(entry.ts).toLocaleString()}`}
                    />
                  )
                })}
              </div>
              <span aria-hidden="true" />
              <div className="dam-chart-cap">
                <span>{relativeTime(activity[0]?.ts, now, t)}</span>
                <span>{relativeTime(activity[Math.floor(activity.length / 2)]?.ts, now, t)}</span>
                <span>{relativeTime(activity[activity.length - 1]?.ts, now, t)}</span>
              </div>
            </div>
          </div>
        )}

        {/* 双分布:作用域(按注入加权)+ 类型(全库条数) */}
        {(scopeShare.size > 1 || typeShare.size > 1) && (
          <div className="dam-duo">
            {scopeShare.size > 1 && (
              <div className="dam-dist">
                <p className="dam-section" style={{ margin: 0 }}>{t('statsScopeShare')}</p>
                <div className="dam-dist-bar">
                  {([...scopeShare.entries()] as Array<[Scope | 'missing', number]>)
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, value]) => distSeg(key, 'scope', value, '', scopeLabel(key === 'missing' ? undefined : key)))}
                </div>
                <div className="dam-legend">
                  {([...scopeShare.entries()] as Array<[Scope | 'missing', number]>)
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, value]) => (
                      <span key={key} className="dam-legend-item">
                        <span className="dam-scope-dot" data-scope={key} />{scopeLabel(key === 'missing' ? undefined : key)} {value} <i className="dam-legend-pct">{Math.round((value / scopeTotal) * 100)}%</i>
                      </span>
                    ))}
                </div>
              </div>
            )}
            {typeShare.size > 1 && (
              <div className="dam-dist">
                <p className="dam-section" style={{ margin: 0 }}>{t('statsTypeShare')}</p>
                <div className="dam-dist-bar">
                  {(['user', 'feedback', 'project', 'reference'] as const)
                    .filter(type => (typeShare.get(type) ?? 0) > 0)
                    .map(type => distSeg(type, 'type', typeShare.get(type) ?? 0, '', type))}
                </div>
                <div className="dam-legend">
                  {(['user', 'feedback', 'project', 'reference'] as const)
                    .filter(type => (typeShare.get(type) ?? 0) > 0)
                    .map(type => (
                      <span key={type} className="dam-legend-item">
                        <span className="dam-scope-dot" data-type={type} style={{ background: undefined }} />{type} {typeShare.get(type)} <i className="dam-legend-pct">{Math.round(((typeShare.get(type) ?? 0) / typeTotal) * 100)}%</i>
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

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
          {ranked.map((memory, index) => rankRow(memory, index))}
          {rest.length > 0 && (
            <details className="dam-subdetails">
              <summary>{t('statsAll', { n: total })}</summary>
              {rest.map((memory, index) => rankRow(memory, index + 8))}
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
            {projects.map(project => {
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
                    <i style={{ width: `${width}%` }} />
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
            {stats.timeline.slice(-8).reverse().map((entry, index) => {
              const names = entry.injected ?? []
              const cutNames = entry.truncatedNames ?? []
              const expandable = names.length > 0 || cutNames.length > 0
              const open = openTs === entry.ts
              return (
                <div
                  key={`${entry.sessionId}-${entry.ts}`}
                  className="dam-tl-item"
                  data-latest={index === 0 ? '1' : '0'}
                  data-open={open ? '1' : '0'}
                  role={expandable ? 'button' : undefined}
                  tabIndex={expandable ? 0 : -1}
                  title={expandable ? (open ? t('statsCollapse') : t('statsExpand')) : undefined}
                  onClick={() => { if (expandable) setOpenTs(open ? null : entry.ts) }}
                  onKeyDown={event => {
                    if (!expandable) return
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenTs(open ? null : entry.ts) }
                  }}
                >
                  <div className="dam-tl-top">
                    <span className="dam-tl-ws" title={entry.cwd}>{(entry.cwd.split(/[\\/]/).pop() ?? entry.cwd) || '—'}</span>
                    <span className="dam-tl-time">{relativeTime(entry.ts, now, t)}</span>
                    {entry.truncated > 0 && <span className="dam-warn">⚠ {entry.truncated}</span>}
                    {expandable && <span className="dam-tl-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
                  </div>
                  <div className="dam-tl-meta">
                    <span className="dam-pill">{entry.count} {t('statsMemories')}</span>
                    <span className="dam-pill">{(entry.bytes / 1024).toFixed(1)} KB</span>
                  </div>
                  {open && (
                    <div className="dam-tl-names">
                      {names.map(name => (
                        <span key={name} className="dam-tl-name" title={name}><span className="dam-scope-dot" data-scope={scopeByName.get(name) ?? 'missing'} />{name}</span>
                      ))}
                      {cutNames.map(name => (
                        <span key={`cut-${name}`} className="dam-tl-name dam-tl-name--cut" title={`${name} — ${t('statsTruncatedTop')}`}><span aria-hidden="true">✂</span>{name}</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

/** 记忆管理面板(face 方法经直通交叉成为顶层 props)。 */
export function MemoryPage({ t, list, read, write, del, currentCwd, importScan, importApply, auditStats, healthReport, exportAgents, configGet, configSet }: MemoryPageProps): ReactNode {
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
  /** #19 谱系跳转:待滚动到的记忆名(设置后清筛选+展开组,由 effect 完成滚动)。 */
  const [jumpTarget, setJumpTarget] = useState<string | null>(null)
  /**
   * 1.5.0 tab 导航:记忆(默认,C 位)/ 洞察(统计+召回)/ 体检 / 设置。
   * 旧宿主降级:对应数据源缺失的 tab 不渲染;三者全缺时 tab 行整体消失,
   * 面板退化为纯列表形态(与 1.4.x 一致)。
   */
  const [tab, setTab] = useState<'memories' | 'insights' | 'health' | 'settings'>('memories')
  /** 跨 tab 跳转的强制重触发计数(切 tab 不改变 visibleGroups 引用,effect 不会重跑)。 */
  const [jumpNonce, setJumpNonce] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  /** 注入审计统计(0.9.0;取不到时静默无统计区——审计绝不影响面板可用性)。 */
  const [stats, setStats] = useState<AuditStatsFace | null>(null)
  /** 记忆体检(1.0.0;旧宿主无路由时 null → 体检区不显示)。 */
  const [health, setHealth] = useState<HealthReportFace | null>(null)
  /** 设置中心(1.4.0;旧宿主无路由时 null → 设置卡不显示)。 */
  const [settings, setSettings] = useState<SettingsFace | null>(null)
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
    const [statsRes, healthRes, settingsRes] = await Promise.allSettled([auditStats(), healthReport(), configGet()])
    if (statsRes.status === 'fulfilled') setStats(statsRes.value)
    if (healthRes.status === 'fulfilled') setHealth(healthRes.value)
    if (settingsRes.status === 'fulfilled') setSettings(settingsRes.value)
  }, [list, auditStats, healthReport, configGet])

  useEffect(() => { void load() }, [load])

  /**
   * #19 谱系/体检行跳转:清筛选 + **显式展开目标所在组** + 滚动到卡片。
   * 1.5.0 审查修复(major):不能 setClosedGroups({}) 清空——非当前工作区的项目组
   * 回落默认折叠,卡片不在 DOM,滚动落空且 visibleGroups 引用不变导致 effect
   * 永不重试;改为只把目标组置为展开(其余组保持用户当前展开态)。
   * 由 effect 驱动(组展开与筛选清空是异步重渲染,同步 scrollIntoView 找不到
   * 节点);滚动+高亮后清除目标防重复触发。找不到目标(dangling 后继)静默 no-op。
   */
  const jumpTo = (name: string): void => {
    setFilter('')
    setScopeFilter('all')
    setTypeFilter('all')
    // 显式展开含目标记忆的全部组(跨层同名时两层都展开)
    setClosedGroups(previous => {
      const next = { ...previous }
      for (const g of groups ?? []) {
        if (g.memories.some(m => m.name === name)) next[g.key] = false
      }
      return next
    })
    setTab('memories') // 体检/谱系跨 tab 跳转:先回到记忆页
    setJumpNonce(n => n + 1) // 强制滚动 effect 重跑(切 tab 不触发 visibleGroups 引用变化)
    setJumpTarget(name)
  }

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

  /** 面板滚动容器 ref(切 tab 时复位滚动位置,审查 minor 修复)。 */
  const rootRef = useRef<HTMLDivElement>(null)

  /** 切 tab 复位面板滚动(内容高度不同,旧位置会被钳制成"半路");声明在跳转 effect 之前——jumpTo 同批切 tab 时先复位再 scrollIntoView 目标。 */
  useEffect(() => { rootRef.current?.scrollTo({ top: 0 }) }, [tab])

  // #19 谱系跳转的滚动 effect:依赖 visibleGroups 的引用变化(组展开/筛选
  // 清空触发重渲染后卡片才存在);找到即滚动+闪烁高亮,找不到静默(dangling)
  useEffect(() => {
    if (jumpTarget === null) return
    // 精确匹配:id = dam-m-<groupKey>-<name>,groupKey 已知('_user'/'--slug--');
    // 用 groups 全集拼出精确 id 再 getElementById,避免 endsWith 对
    // 'foo-v2'/'staging-foo-v2' 的后缀误匹配(审查实测错导航)
    const element = groups?.flatMap(g => g.memories.some(m => m.name === jumpTarget)
      ? [document.getElementById(`dam-m-${g.key}-${jumpTarget}`)]
      : []).find(el => el !== null)
    if (element === undefined) return
    element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // 焦点随行(审查 minor 修复):点击方(体检行)已随 tab 隐藏失焦——把焦点
    // 移到目标卡,键盘用户不落回 body;tabindex 动态补,一次性属性
    element.setAttribute('tabindex', '-1')
    element.focus({ preventScroll: true })
    element.classList.add('dam-lineage-hit')
    window.setTimeout(() => { element.classList.remove('dam-lineage-hit') }, 1600)
    setJumpTarget(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleGroups 引用变化/跨 tab nonce 均需重试
  }, [jumpTarget, jumpNonce, tab, visibleGroups, groups])

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

  /** 可信状态流转(1.0.0):读正文后带 status 整条重写(verify/dispute/restore 共用)。
   *  restore(离开 superseded)时同时清本条 supersedes(断链两侧同步,#19)。 */
  const setStatus = (group: PanelGroup, memory: PanelMemory, status: string): void => {
    void (async () => {
      try {
        const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
        const leaving = memory.status === 'superseded' && status !== 'superseded'
        await act(() => write({
          cwd: cwd(group), scope: group.scope, name: memory.name, title: memory.title,
          description: memory.description, type: memory.type, body: detail.body,
          pinned: memory.pinned, disabled: memory.disabled, status,
          ...(leaving ? { supersedes: '' } : {}),
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
  /** 顶条构成显示(1.6.0 透明化):固定开销 = maxBytes − 净预算,前端算零后端改动;
   *  旧宿主无 budgetBytes 字段(回退=maxBytes)时差值为 0,自动降级单段显示 */
  const fixedOverhead = Math.max(0, maxBytes - budgetBytes)
  const usageTotalPct = maxBytes > 0 ? Math.min(100, Math.round(((injectedBytes + fixedOverhead) / maxBytes) * 100)) : 0
  const fixedPct = maxBytes > 0 ? Math.min(100, (fixedOverhead / maxBytes) * 100) : 0
  const idxPct = maxBytes > 0 ? Math.min(100 - fixedPct, (injectedBytes / maxBytes) * 100) : 0
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
          <span className="dam-group-icon" aria-hidden="true"><Icon name={group.scope === 'user' ? 'user' : 'folder'} size={14} /></span>
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
            {pinnedCount > 0 && <> · <Icon name="pin" size={10} /> {pinnedCount}</>}
            {mutedCount > 0 && <> · <Icon name="mute" size={10} /> {mutedCount}</>}
            {staleCount > 0 && <> · <Icon name="clock" size={10} /> {staleCount}</>}
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
                    id={`dam-m-${group.key}-${memory.name}`}
                    className="dam-memory"
                    data-pinned={memory.pinned ? '1' : '0'}
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
                        {memory.pinned && <span className="dam-memory-pin" title={t('pinned')}><Icon name="pin" size={11} /></span>}
                        {memory.disabled && <span className="dam-badge dam-badge--muted">{t('mutedShort')}</span>}
                        {memory.stale && !memory.disabled && <span className="dam-badge dam-badge--warn">{t('staleShort')}</span>}
                        {memory.expired && <span className="dam-badge dam-badge--warn" title={t('validUntilHint')}>⏱ {t('expiredBadge')}</span>}
                        {memory.status === 'candidate' && <span className="dam-badge dam-badge--cand" title={t('statusTipCandidate')}>? {t('statusCandidate')}</span>}
                        {memory.status === 'verified' && <span className="dam-badge dam-badge--ok" title={t('statusVerified')}>✓ {t('statusVerified')}</span>}
                        {memory.status === 'disputed' && <span className="dam-badge dam-badge--danger" title={t('statusTipDisputed')}>⊘ {t('statusDisputed')}</span>}
                        {memory.status === 'superseded' && memory.supersededBy === undefined && <span className="dam-badge dam-badge--muted" title={t('statusSuperseded')}>⟳ {t('statusSuperseded')}</span>}
                        {memory.status === 'superseded' && memory.supersededBy !== undefined && (
                          <span
                            className="dam-badge dam-badge--muted dam-lineage-link"
                            title={`${t('statusSuperseded')} → ${memory.supersededBy}`}
                            role="button"
                            tabIndex={0}
                            onClick={event => { event.stopPropagation(); jumpTo(memory.supersededBy!) }}
                            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); jumpTo(memory.supersededBy!) } }}
                          >⟳ {t('statusSuperseded')} → {memory.supersededBy}</span>
                        )}
                        {memory.status !== 'superseded' && memory.supersedes !== undefined && (
                          <span className="dam-badge dam-badge--ok" title={t('lineageReplaces', { name: memory.supersedes })}>⇄ {memory.supersedes}</span>
                        )}
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
                        data-tone="brand"
                      ><Icon name="book" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        disabled={actionsDisabled}
                        title={readonlyHint ?? t('edit')}
                        aria-label={t('edit')}
                        onClick={() => { void openEditor(group, memory) }}
                        data-tone="brand"
                      ><Icon name="edit" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-on={memory.pinned ? '1' : '0'}
                        disabled={actionsDisabled}
                        title={readonlyHint ?? (memory.pinned ? t('unpinAction') : t('pinAction'))}
                        aria-label={memory.pinned ? t('unpinAction') : t('pinAction')}
                        onClick={() => { toggleFlag(group, memory, 'pinned') }}
                        data-tone="warn"
                      ><Icon name="pin" /></button>
                      <button
                        type="button"
                        className="dam-icon-btn"
                        data-on={memory.disabled ? '1' : '0'}
                        disabled={actionsDisabled}
                        title={readonlyHint ?? (memory.disabled ? t('unmuteAction') : t('muteAction'))}
                        aria-label={memory.disabled ? t('unmuteAction') : t('muteAction')}
                        onClick={() => { toggleFlag(group, memory, 'disabled') }}
                        data-tone="muted"
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

  // ---- 1.5.0 tab 可见性(旧宿主降级矩阵):数据源缺失的 tab 不渲染 ----
  const showInsights = stats !== null && stats.injections > 0
  const healthIssueCount = health === null
    ? 0
    : health.unverified.length + health.zombies.length + health.conflicts.length + health.expired.length
  const showHealth = health !== null && healthIssueCount > 0
  const showSettings = settings !== null
  const showTabBar = showInsights || showHealth || showSettings
  // 活动页数据消失(体检清零/旧宿主)时渲染期回落,避免停在空白 tab
  const activeTab = tab === 'insights' && !showInsights
    ? 'memories'
    : tab === 'health' && !showHealth
      ? 'memories'
      : tab === 'settings' && !showSettings
        ? 'memories'
        : tab

  /**
   * 打开 Claude 导入弹层(头部按钮/提示条/空状态三处共用一个入口;
   * 1.5.0 消灭旧版"提示条按钮 querySelector 转发点击头部按钮"的 hack)。
   */
  const openImporter = (): void => {
    if (busy || importer !== null || editing !== null) return
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
  }

  /**
   * 过期记忆一键续期(1.6.0):按 scope+slug 精确定组(跨层/跨项目同名不串,
   * 审查 major 修复),先读原正文(write 路由整条重写,body 缺省会清空),
   * 带新 validUntilMs=now+90d 重写;显式透传 status 避免触发降级判定;
   * 项目组沿用 cwd(group) 门禁——非当前工作区只读组直接提示失败。
   */
  const renewExpired = async (target: { name: string; scope: string; slug: string }): Promise<void> => {
    const group = groups?.find(g => g.scope === target.scope && g.slug === target.slug)
    const memory = group?.memories.find(m => m.name === target.name)
    if (group === undefined || memory === undefined) return
    if (group.scope === 'project' && group.current !== true) {
      setActionError(t('renewFailed'))
      return
    }
    const owningCwd = cwd(group)
    try {
      const full = await read({ name: target.name, scope: group.scope, ...(owningCwd !== undefined ? { cwd: owningCwd } : {}) })
      await act(() => write({
        ...(owningCwd !== undefined ? { cwd: owningCwd } : {}),
        scope: group.scope,
        name: target.name,
        description: memory.description,
        type: memory.type,
        body: full.body,
        ...(memory.pinned ? { pinned: true } : {}),
        ...(memory.disabled ? { disabled: true } : {}),
        ...(memory.status !== undefined ? { status: memory.status } : {}),
        validUntilMs: Date.now() + 90 * 86_400_000,
      }))
    } catch {
      setActionError(t('renewFailed'))
    }
  }

  return (
    <div className="dam-root" ref={rootRef}>
      <div className="dam-shell">
      {/* 顶条(1.5.0):标题一行(intro 收进 title 提示)+ 全局动作 */}
      <header className="dam-header">
        <div className="dam-heading">
          <span className="dam-brand-mark" aria-hidden="true" />
          <h2 className="dam-title" title={t('intro')}>{t('title')}</h2>
        </div>
        <div className="dam-header-side">
          {/* 索引占用(全局信号,常驻——旧宿主降级无 tab 行时也可见,审查 minor 修复) */}
          <span className="dam-usage" title={`${t('budget')} ${formatBytes(maxBytes)} · ${t('usageFixedTip')}`}>
            <span className="dam-usage-label">{t('indexUsage')} {String(usageTotalPct)}% · {t('usageIdx')} {formatBytes(injectedBytes)}{fixedOverhead > 0 ? ` + ${t('usageFixed')} ${formatBytes(fixedOverhead)}` : ''} / {formatBytes(maxBytes)}</span>
            <span className="dam-usage-track">
              {fixedOverhead > 0 && <i className="dam-usage-fixed" style={{ width: `${String(Math.round(fixedPct))}%` }} />}
              <i data-hot={usageTotalPct > 80 ? '1' : '0'} style={{ width: `${String(Math.round(idxPct))}%` }} />
            </span>
          </span>
        </div>
        <div className="dam-header-actions">
          {/* 反向导出桥(1.2.0):信任态记忆 → AGENTS.md 片段,复制到剪贴板 */}
          <button
            type="button"
            className="dam-btn dam-btn-ghost"
            disabled={busy}
            title={t('exportTip')}
            aria-label={t('exportAction')}
            onClick={() => {
              void exportAgents()
                .then(res => navigator.clipboard.writeText(res.content))
                .then(() => { setActionError(null); setExportNote(t('exportDone')) })
                .catch(() => { setExportNote(null); setActionError(t('exportFailed')) })
            }}
          ><Icon name="upload" size={13} /></button>
          <button type="button" className="dam-btn dam-btn-ghost" onClick={() => { void load() }} disabled={busy} aria-label={t('refresh')} title={t('refresh')}>
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="dam-btn dam-btn-primary"
            disabled={busy || importer !== null || editing !== null}
            onClick={openImporter}
          >
            <Icon name="download" size={13} /> {t('importBtn')}
          </button>
        </div>
      </header>

      {/* tab 导航 + 右侧全局信号(索引占用;下划线式与列表级 segment 区分)。
          至少一个可选 tab 才渲染,否则退化为纯列表(最旧宿主) */}
      {showTabBar && (
        <nav className="dam-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={activeTab === 'memories'} className="dam-tab" data-on={activeTab === 'memories' ? '1' : '0'} onClick={() => { setTab('memories') }}>
            {t('tabMemories')} <span className="dam-tab-count">{String(total)}</span>
          </button>
          {showInsights && (
            <button type="button" role="tab" aria-selected={activeTab === 'insights'} className="dam-tab" data-on={activeTab === 'insights' ? '1' : '0'} onClick={() => { setTab('insights') }}>
              {t('tabInsights')}
            </button>
          )}
          {showHealth && (
            <button type="button" role="tab" aria-selected={activeTab === 'health'} className="dam-tab" data-on={activeTab === 'health' ? '1' : '0'} onClick={() => { setTab('health') }}>
              {t('tabHealth')} <span className="dam-tab-count dam-tab-count--alert">{String(healthIssueCount)}</span>
            </button>
          )}
          {showSettings && (
            <button type="button" role="tab" aria-selected={activeTab === 'settings'} className="dam-tab" data-on={activeTab === 'settings' ? '1' : '0'} onClick={() => { setTab('settings') }}>
              {t('settingsTitle')}
            </button>
          )}
        </nav>
      )}

      {/* 导入提示条(watcher 透传:Claude 目录有可同步记忆且尚未打开过导入时) */}
      {claudePending !== undefined && claudePending > 0 && importer === null && (
        <div className="dam-import-hint">
          <span><Icon name="download" size={12} /> {t('importHint', { n: claudePending })}</span>
          <button type="button" className="dam-btn" onClick={openImporter}>{t('healthView')}</button>
        </div>
      )}
      {exportNote !== null && <div className="dam-export-note">✓ {exportNote}</div>}
      {actionError !== null && <div className="dam-err dam-banner">{actionError}</div>}

      {/*
        1.5.0 审查修复(minor):tab 面板常挂载 + CSS 隐藏(而非条件卸载)——
        切 tab 往返不丢 MemoryEditor 未保存正文/SettingsCard 滑块草稿/
        StatsSection 展开态,滚动位置也随 DOM 保留。
      */}
      <div className="dam-tabpane" data-on={activeTab === 'memories' ? '1' : '0'}>
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

          {/* 状态芯片行:概览三计数(零值隐藏,全零整行不渲染) */}
          {(totalPinned > 0 || totalMuted > 0 || totalStale > 0) && (
            <div className="dam-chips">
              {totalPinned > 0 && <span className="dam-chip"><Icon name="pin" size={11} /> {totalPinned} {t('overviewPinned')}</span>}
              {totalMuted > 0 && <span className="dam-chip"><Icon name="mute" size={11} /> {totalMuted} {t('overviewMuted')}</span>}
              {totalStale > 0 && <span className="dam-chip"><Icon name="clock" size={11} /> {totalStale} {t('overviewStale')}</span>}
              {filtering && <span className="dam-chip dam-chip--filter">{t('showingOf', { shown: visibleCount, total })}</span>}
            </div>
          )}

          {total === 0 && (
            <div className="dam-empty">
              <span className="dam-empty-icon" aria-hidden="true"><Icon name="book" size={34} /></span>
              <h3>{t('emptyTitle')}</h3>
              <p>{t('emptyStep1')}</p>
              <p className="dam-note">{t('emptyStep2')} · {t('emptyStep3')}</p>
              <button type="button" className="dam-btn dam-btn-primary" disabled={busy || importer !== null || editing !== null} onClick={openImporter}>
                <Icon name="download" size={13} /> {t('importBtn')}
              </button>
            </div>
          )}

          <div className="dam-groups">
            {userGroups.map(renderGroup)}
            {projectGroups.map(renderGroup)}
          </div>

          {total > 0 && (visibleGroups?.length ?? 0) === 0 && <p className="dam-note">{t('noSearchHits')}</p>}
      </div>

      <div className="dam-tabpane" data-on={activeTab === 'insights' ? '1' : '0'}>
        {stats !== null && (
          <div className="dam-insights">
            <StatsSection stats={stats} t={t} now={now} groups={groups} budgetBytes={budgetBytes} />
            {groups !== null && <RecallSection stats={stats} groups={groups} t={t} />}
          </div>
        )}
      </div>

      <div className="dam-tabpane" data-on={activeTab === 'health' ? '1' : '0'}>
        {health !== null && showHealth && (
          <HealthSection health={health} t={t} onLocate={jumpTo} onRenew={renewExpired} busy={busy} />
        )}
      </div>

      <div className="dam-tabpane" data-on={activeTab === 'settings' ? '1' : '0'}>
        {settings !== null && (
          <SettingsCard
            t={t}
            settings={settings}
            avgRowBytes={groups !== null && groups.length > 0
              ? Math.max(24, Math.round(groups.reduce((s, g) => s + g.indexBytes, 0) / Math.max(1, groups.reduce((s, g) => s + g.memories.length, 0))))
              : 96}
            onSaved={async () => {
              try { setSettings(await configGet()) } catch { /* 保持现值 */ }
              await load()
            }}
            configSet={configSet}
          />
        )}
      </div>

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
  onSave: (payload: { name: string; title?: string; description: string; type: string; body: string; pinned?: boolean; validUntilMs?: number }) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [title, setTitle] = useState(initial.title ?? '')
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initialBody)
  // 有效期(1.6.0):初值 = 剩余天数(向上取整);空 = 清除(永久)。
  // 保存时**只在用户改过该字段才发 validUntilMs**(dirty 检测,审查修复)——
  // 否则编辑一条已过期记忆、只改正文,空初值会发哨兵 0 静默清保质期+复活
  const [validDays, setValidDays] = useState(() => {
    if (initial.validUntilMs === undefined) return ''
    const remaining = Math.ceil((initial.validUntilMs - Date.now()) / 86_400_000)
    return remaining > 0 ? String(remaining) : ''
  })
  const validDaysInit = useRef(validDays)
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
      <label className="dam-label" title={t('validUntilHint')}>{t('validUntilField')} · {t('validUntilHint')}</label>
      <input className="dam-input" type="number" min={1} max={3650} placeholder={t('validUntilNone')} value={validDays} onChange={event => { setValidDays(event.target.value) }} />
      <div className="dam-row">
        <button className="dam-btn dam-btn-primary" disabled={busy} onClick={() => {
          const validDaysDirty = validDays !== validDaysInit.current
          const parsedDirty = Number(validDays)
          void onSave({
          name: initial.name,
          title: title.trim().length > 0 ? title.trim() : undefined,
          description,
          type: initial.type,
          body,
          pinned: initial.pinned,
          // dirty 才发:未改字段不触碰保质期;改过则 数值=续期 N 天,清空=清除(永久)
          ...(validDaysDirty
            ? {
              validUntilMs: validDays.trim().length > 0 && Number.isSafeInteger(parsedDirty) && parsedDirty > 0
                ? Date.now() + parsedDirty * 86_400_000
                : 0,
            }
            : {}),
        }) }}>{t('save')}</button>
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

/**
 * 召回排行 + 注入→召回漏斗(1.4.0)。
 * reads 来自 store(memory_read 计数 + 搜索命中 top-3),injectedCount 来自
 * 注入审计——两榜对照即漏斗:注入多而零召回 = 占预算;注入少而常召回 = 被埋没。
 */
function RecallSection({ stats, groups, t }: { stats: AuditStatsFace; groups: PanelGroup[]; t: Translate }): ReactNode {
  /** name → {reads(跨层求和), scope(取首个出现层)};再并上注入次数。 */
  const readsByName = new Map<string, { reads: number; scope: string }>()
  for (const group of groups) {
    for (const memory of group.memories) {
      const hit = readsByName.get(memory.name)
      if (hit === undefined) readsByName.set(memory.name, { reads: memory.reads, scope: group.scope })
      else hit.reads += memory.reads
    }
  }
  const injectedByName = new Map(stats.memories.map(m => [m.name, m.injectedCount]))
  const rows = [...readsByName.entries()]
    .map(([name, info]) => ({ name, reads: info.reads, injected: injectedByName.get(name) ?? 0, scope: info.scope }))
  const topRecall = [...rows].sort((a, b) => b.reads - a.reads || b.injected - a.injected).slice(0, 8)
  const maxReads = Math.max(1, ...rows.map(r => r.reads))
  const maxInj = Math.max(1, ...rows.map(r => r.injected))
  // 漏斗四象限:注入 ≥ 半数事件 且 reads ≥ 2 视为活跃(经验阈值)
  const injActive = (r: { injected: number }) => r.injected >= Math.max(2, stats.injections * 0.5)
  const readActive = (r: { reads: number }) => r.reads >= 2
  const hh = rows.filter(r => injActive(r) && readActive(r))
  const hz = rows.filter(r => injActive(r) && !readActive(r)).sort((a, b) => b.injected - a.injected)
  const lh = rows.filter(r => !injActive(r) && readActive(r)).sort((a, b) => b.reads - a.reads)
  const ll = rows.filter(r => !injActive(r) && !readActive(r))

  /** 双条行:上条=注入(蓝) 下条=召回(绿),宽度各按自身最大值归一;顶部图例标注。 */
  const dualRow = (row: { name: string; reads: number; injected: number; scope: string }): ReactNode => (
    <div key={row.name} className="dam-recall-row">
      <code className="dam-rank-name" title={row.name}>{row.name}</code>
      <span className="dam-dualbar" title={`inj ${String(row.injected)} · reads ${String(row.reads)}`}>
        <i style={{ width: `${Math.round((row.injected / maxInj) * 100)}%` }} />
        <em style={{ width: `${Math.round((row.reads / maxReads) * 100)}%` }} />
      </span>
      <span className="dam-ratio">{row.reads}/{row.injected}</span>
    </div>
  )

  /** 双条图例(可见,不只靠 hover):● 注入 ● 召回 + 比率含义 */
  const dualLegend = (
    <div className="dam-legend dam-legend--dual">
      <span className="dam-legend-item"><i className="dam-dot dam-dot--inj" />{t('legendInj')}</span>
      <span className="dam-legend-item"><i className="dam-dot dam-dot--rec" />{t('legendRec')}</span>
      <span className="dam-legend-item dam-ratio-hint">{t('legendRatio')}</span>
    </div>
  )

  const quadrant = (label: string, count: number, tone: string): ReactNode => (
    <div key={label} className={`dam-quad dam-quad--${tone}`}>
      <b>{String(count)}</b>
      <span>{label}</span>
    </div>
  )

  return (
    <section className="dam-stats">
      <header className="dam-stats-head">
        <span className="dam-stats-glyph" aria-hidden="true"><Icon name="target" size={15} /></span>
        <span className="dam-stats-titles">
          <span className="dam-stats-title">{t('recallTitle')}</span>
          <span className="dam-stats-sub">{t('recallHint')}</span>
        </span>
      </header>
      <div className="dam-stats-body">
        {dualLegend}
        {/* 漏斗阈值在注入样本 <4 时结构性失效(阈值≥2 永不可达 → 全部落
            LH/LL 假象)——样本不足时隐藏象限区与行动建议,只留召回榜 */}
        {stats.injections >= 4 && (
          <div className="dam-duo">
            <div className="dam-block">
              <p className="dam-section" style={{ margin: 0 }}>{t('funnelTitle')}</p>
              <div className="dam-quad-grid-inner">
                {quadrant(t('funnelQuadHH'), hh.length, 'ok')}
                {quadrant(t('funnelQuadHZ'), hz.length, 'warn')}
                {quadrant(t('funnelQuadLH'), lh.length, 'info')}
                {quadrant(t('funnelQuadLL'), ll.length, 'muted')}
              </div>
            </div>
            <div className="dam-block">
              <p className="dam-section" style={{ margin: 0 }}>{t('recallTop')}</p>
              {topRecall.length > 0 ? topRecall.map(dualRow) : <p className="dam-note">{t('healthNone')}</p>}
            </div>
          </div>
        )}
        {stats.injections < 4 && (
          <div className="dam-block">
            <p className="dam-section" style={{ margin: 0 }}>{t('recallTop')}</p>
            {topRecall.length > 0 ? topRecall.map(dualRow) : <p className="dam-note">{t('healthNone')}</p>}
          </div>
        )}
        {stats.injections >= 4 && hz.length > 0 && (
          <div className="dam-block">
            <p className="dam-section">{t('funnelQuadHZ')} · {t('funnelSuggestMute')}</p>
            {hz.slice(0, 5).map(dualRow)}
          </div>
        )}
        {stats.injections >= 4 && lh.length > 0 && (
          <div className="dam-block">
            <p className="dam-section">{t('funnelQuadLH')} · {t('funnelSuggestPin')}</p>
            {lh.slice(0, 5).map(dualRow)}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * 设置中心卡(1.4.0):预设一键切换 + 白名单字段滑块/开关 + 来源徽章 +
 * 保存(POST config.set,宿主原地改 live 配置,下一个请求生效)。
 */
function SettingsCard({ t, settings, avgRowBytes, onSaved, configSet }: {
  t: Translate
  settings: SettingsFace
  /** 当前索引行均宽(字节)——预算滑块的「约可装 N 条」预览用。 */
  avgRowBytes: number
  onSaved: () => Promise<void>
  configSet: (payload: Record<string, number | boolean | null>) => Promise<Response>
}): ReactNode {
  const effective = settings.effective
  const [maxBytes, setMaxBytes] = useState(Number(effective.maxBytes))
  const [minImportance, setMinImportance] = useState(Number(effective.minImportance))
  const [staleDays, setStaleDays] = useState(Number(effective.staleAfterDays))
  const [autoSummarize, setAutoSummarize] = useState(effective.autoSummarize === true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // 外部生效值变化(保存成功刷新/手动刷新/重置)后本地跟随——否则重置回
  // profile 默认时,本地仍持旧值显示成"未保存的改动"
  useEffect(() => {
    setMaxBytes(Number(effective.maxBytes))
    setMinImportance(Number(effective.minImportance))
    setStaleDays(Number(effective.staleAfterDays))
    setAutoSummarize(effective.autoSummarize === true)
  }, [effective.maxBytes, effective.minImportance, effective.staleAfterDays, effective.autoSummarize])

  const preset = maxBytes <= 4096 && minImportance >= 4 ? 'focus' : maxBytes >= 8192 && minImportance <= 1 ? 'companion' : ''
  const fits = Math.max(1, Math.floor((maxBytes * 0.66) / avgRowBytes))

  const srcBadge = (field: string): ReactNode => {
    const source = settings.sources[field]
    if (source === undefined) return null
    return <span className={source === 'override' ? 'dam-src dam-src--own' : 'dam-src'}>{source === 'override' ? t('setSourceOverride') : t('setSourceProfile')}</span>
  }

  const send = (patch: Record<string, number | boolean | null>): void => {
    setBusy(true)
    setNote(null)
    void configSet(patch)
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status))
        setNote(t('setSaved'))
        await onSaved()
      })
      .catch(() => { setNote(t('setSaveFailed')) })
      .finally(() => { setBusy(false) })
  }

  // 单字段重置:值传 null = 删覆盖回 profile 默认(后端 profileDefaults 恢复)
  const resetField = (field: string): void => { send({ [field]: null }) }

  const dirty = maxBytes !== Number(effective.maxBytes)
    || minImportance !== Number(effective.minImportance)
    || staleDays !== Number(effective.staleAfterDays)
    || autoSummarize !== (effective.autoSummarize === true)

  return (
    <section className="dam-stats dam-settings">
      <header className="dam-stats-head">
        <span className="dam-stats-glyph" aria-hidden="true"><Icon name="gear" size={15} /></span>
        <span className="dam-stats-titles">
          <span className="dam-stats-title">{t('settingsTitle')}</span>
          <span className="dam-stats-sub">{t('settingsIntro')}</span>
        </span>
      </header>
      <div className="dam-stats-body">
        {/* 预设:一键换档(专注=默认行为;陪伴=大预算低门槛) */}
        <div className="dam-row" style={{ gap: '8px' }}>
          <button
            type="button"
            className="dam-preset"
            data-active={preset === 'focus' ? '1' : '0'}
            disabled={busy}
            title={t('presetFocusTip')}
            onClick={() => {
              setMaxBytes(4096)
              setMinImportance(4)
            }}
          >{t('presetFocus')}{preset === 'focus' ? ` · ${t('presetActive')}` : ''}</button>
          <button
            type="button"
            className="dam-preset"
            data-active={preset === 'companion' ? '1' : '0'}
            disabled={busy}
            title={t('presetCompanionTip')}
            onClick={() => {
              setMaxBytes(16_384)
              setMinImportance(1)
            }}
          >{t('presetCompanion')}{preset === 'companion' ? ` · ${t('presetActive')}` : ''}</button>
        </div>

        <div className="dam-ctrl">
          <label>
            <span className="dam-ctrl-head">{t('setMaxBytes')} {srcBadge('maxBytes')}
              {settings.sources.maxBytes === 'override' && (
                <button type="button" className="dam-reset" disabled={busy} aria-label={t('setResetField')} title={t('setResetField')} onClick={() => { resetField('maxBytes') }}>↺</button>
              )}
            </span>
            <span className="dam-ctrl-val">{(maxBytes / 1024).toFixed(1)} KB</span>
            <input type="range" min={1024} max={65536} step={512} value={maxBytes} onChange={e => { setMaxBytes(Number(e.target.value)) }} />
            <span className="dam-ctrl-hint">{t('setMaxBytesHint')} · {t('setFits', { n: fits })}</span>
          </label>
        </div>
        <div className="dam-ctrl">
          <label>
            <span className="dam-ctrl-head">{t('setMinImportance')} {srcBadge('minImportance')}
              {settings.sources.minImportance === 'override' && (
                <button type="button" className="dam-reset" disabled={busy} aria-label={t('setResetField')} title={t('setResetField')} onClick={() => { resetField('minImportance') }}>↺</button>
              )}
            </span>
            <span className="dam-ctrl-val">{String(minImportance)}{minImportance === 0 ? ' (off)' : ''}</span>
            <input type="range" min={0} max={10} step={1} value={minImportance} onChange={e => { setMinImportance(Number(e.target.value)) }} />
            <span className="dam-ctrl-hint">{t('setMinImportanceHint')}</span>
          </label>
        </div>
        <div className="dam-ctrl">
          <label>
            <span className="dam-ctrl-head">{t('setStaleDays')} {srcBadge('staleAfterDays')}
              {settings.sources.staleAfterDays === 'override' && (
                <button type="button" className="dam-reset" disabled={busy} aria-label={t('setResetField')} title={t('setResetField')} onClick={() => { resetField('staleAfterDays') }}>↺</button>
              )}
            </span>
            <span className="dam-ctrl-val">{String(staleDays)}{staleDays === 0 ? ' (off)' : ' d'}</span>
            <input type="range" min={0} max={3650} step={1} value={staleDays} onChange={e => { setStaleDays(Number(e.target.value)) }} />
            <span className="dam-ctrl-hint">{t('setStaleDaysHint')}</span>
          </label>
        </div>
        <div className="dam-ctrl dam-ctrl--toggle">
          <label>
            <span className="dam-ctrl-head">{t('setAutoSummarize')} {srcBadge('autoSummarize')}
              {settings.sources.autoSummarize === 'override' && (
                <button type="button" className="dam-reset" disabled={busy} aria-label={t('setResetField')} title={t('setResetField')} onClick={() => { resetField('autoSummarize') }}>↺</button>
              )}
            </span>
            <input type="checkbox" className="dam-check" checked={autoSummarize} onChange={e => { setAutoSummarize(e.target.checked) }} />
          </label>
        </div>

        <div className="dam-row">
          <button type="button" className="dam-btn dam-btn-primary" disabled={busy || !dirty} onClick={() => {
            // 只发真正改动的字段(审查 major 修复):全量发会把未动字段
            // 固化成 override——来源徽章误标,profile 后续修改被旧值压死
            const patch: Record<string, number | boolean | null> = {}
            if (maxBytes !== Number(effective.maxBytes)) patch.maxBytes = maxBytes
            if (minImportance !== Number(effective.minImportance)) patch.minImportance = minImportance
            if (staleDays !== Number(effective.staleAfterDays)) patch.staleAfterDays = staleDays
            if (autoSummarize !== (effective.autoSummarize === true)) patch.autoSummarize = autoSummarize
            if (Object.keys(patch).length === 0) return
            send(patch)
          }}>{t('setSave')}</button>
          {note !== null && <span className={note === t('setSaved') ? 'dam-ok' : 'dam-err'}>{note}</span>}
        </div>
      </div>
    </section>
  )
}
