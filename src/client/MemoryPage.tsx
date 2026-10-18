/**
 * 记忆管理面板(主列全局面板)—— 0.7.0 UI 人性化改造:
 * - 顶部总览:全局记忆数/置顶/停用统计 + 总预算使用条
 * - 类型徽章着色(user 蓝 / feedback 橙 / project 绿 / reference 灰)
 * - 搜索过滤框:实时按名称/摘要/标题过滤(纯前端)
 * - 相对时间显示("3 天前")替代裸时间戳
 * - 每组摘要行(N 条 · X 置顶 · Y 停用)+ 容量条 + 注入预览
 * - 空状态三步引导(说"记住…" → 写入落盘 → 下次会话自动注入)
 * - 操作按钮带图标:✏️ 编辑 / 📌 置顶 / 🔇 停用 / 🗑 删除
 *
 * 样式内联(官方 CSS Modules 管线未随 preset 发布);控件不依赖
 * ui-primitives 具体导出面(降低跨版本脆弱性),仅用原生元素。
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
  reads: number
  updatedMs?: number
  bytes: number
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

/** 导入桥的扫描响应(import.claude.scan)。 */
interface ImportScanProject {
  slug: string
  importable: number
  cwd: string | null
  targetScope: 'project' | 'user'
  targetDir: string
}

/** 注入审计统计(audit.stats 响应形状,0.9.0;truncatedCount/avgBytes 为 0.9.1 新增,旧宿主缺失时按 0 兜底)。 */
interface AuditStatsFace {
  sessions: number
  injections: number
  avgBytes?: number
  memories: Array<{ name: string; injectedCount: number; truncatedCount?: number; lastTs: number }>
  timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number }>
}

/** 导入弹层状态机。 */
type ImportState =
  | { phase: 'loading' }
  | { phase: 'empty' }
  | { phase: 'failed' }
  | { phase: 'runFailed' } // 执行阶段失败(与扫描失败分开:部分记忆可能已落盘)
  | { phase: 'select'; projects: ImportScanProject[]; selected: Record<string, boolean>; allToUser: boolean }
  | { phase: 'running' }
  | { phase: 'done'; summary: string }

/** 面板完整 props(由 main slot 渲染器组装:业务 face 直通交叉为顶层成员)。 */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'autoMemory'> & MemoryFace

const GROUP_STYLE: React.CSSProperties = { margin: '16px 0', padding: '12px', border: '1px solid rgba(128,128,128,.35)', borderRadius: '8px' }
const BAR_STYLE: React.CSSProperties = { height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,.3)', overflow: 'hidden', margin: '6px 0' }
const ROW_STYLE: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }

/**
 * 编辑器浮层:遵循官方 elevation 规范(border: 0 + --dsw-elevation-prominent
 * 阴影层级),底色走主题分层(bg-layer-2)而非硬编码灰;变量缺失时回退深色半透明。
 */
const EDITOR_STYLE: React.CSSProperties = {
  position: 'sticky',
  bottom: '12px',
  padding: '16px',
  borderRadius: '12px',
  border: 0,
  background: 'var(--dsw-alias-bg-layer-2, rgba(32,34,40,.94))',
  backdropFilter: 'blur(10px)',
  boxShadow: 'var(--dsw-elevation-prominent, 0 3px 8px rgba(0,0,0,.14), 0 0 20px rgba(0,0,0,.18))',
  color: 'var(--dsw-alias-label-primary, inherit)',
}

/** 表单输入控件:主题分层底 + 分层描边,圆角填充式(标题/摘要/正文/搜索框共用)。 */
const FIELD_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  outline: 'none',
}

/** 字段标签:小号弱化字(caption 层级),与输入框拉开视觉主次。 */
const FIELD_LABEL: React.CSSProperties = {
  margin: '10px 0 6px',
  fontSize: '11px',
  letterSpacing: '.05em',
  color: 'var(--dsw-alias-label-caption, rgba(128,128,128,.9))',
}

/** 主操作按钮(保存):主题主按钮填充色 + 前景字色。 */
const BTN_PRIMARY: React.CSSProperties = {
  padding: '6px 18px',
  borderRadius: '8px',
  border: 0,
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  background: 'var(--dsw-alias-button-primary-fill, #3b6ef5)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
}

/** 次操作按钮(取消):幽灵式,透明底 + 分层描边 + 次级字色。 */
const BTN_GHOST: React.CSSProperties = {
  padding: '6px 18px',
  borderRadius: '8px',
  cursor: 'pointer',
  font: 'inherit',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/** 类型徽章配色(半透明底 + 深字,深浅主题均可读)。 */
const TYPE_BADGE: Record<string, { label: string; style: React.CSSProperties }> = {
  user: { label: 'user', style: { background: 'rgba(96,165,250,.18)', color: '#3b82f6' } },
  feedback: { label: 'feedback', style: { background: 'rgba(245,158,11,.18)', color: '#d97706' } },
  project: { label: 'project', style: { background: 'rgba(34,197,94,.16)', color: '#16a34a' } },
  reference: { label: 'reference', style: { background: 'rgba(148,163,184,.2)', color: '#64748b' } },
}

/** 小徽章通用形状。 */
const BADGE_STYLE: React.CSSProperties = { display: 'inline-block', fontSize: '10px', lineHeight: '16px', padding: '0 6px', borderRadius: '4px', verticalAlign: '1px', fontWeight: 600, letterSpacing: '.02em' }

/** 状态徽章:生效(绿)/已停用(灰)——一眼分辨哪些记忆会被注入。 */
const STATE_ACTIVE: React.CSSProperties = { ...BADGE_STYLE, background: 'rgba(34,197,94,.15)', color: '#16a34a' }
const STATE_MUTED: React.CSSProperties = { ...BADGE_STYLE, background: 'rgba(148,163,184,.25)', color: '#64748b' }

/**
 * 行级视觉编码(左侧 3px 色条 + 底色),状态优先:
 * 停用 = 灰实条 + 灰底 + 降不透明度;置顶 = 琥珀条 + 微琥珀底;
 * 普通生效 = 类型色条(与类型徽章同色,行与徽章互相印证)。
 */
function rowVisual(memory: PanelMemory): React.CSSProperties {
  const base: React.CSSProperties = { ...ROW_STYLE, borderLeft: '3px solid', paddingLeft: '8px', borderRadius: '2px' }
  const typeColor = (TYPE_BADGE[memory.type] ?? TYPE_BADGE.reference).style.color
  if (memory.disabled) {
    return { ...base, borderLeftColor: 'rgba(148,163,184,.7)', background: 'rgba(148,163,184,.1)', opacity: 0.6 }
  }
  if (memory.pinned) {
    return { ...base, borderLeftColor: '#d97706', background: 'rgba(245,158,11,.07)' }
  }
  return { ...base, borderLeftColor: typeColor }
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

/**
 * 注入统计区样式(纯手绘 CSS,浏览器半禁三方库):
 * 指标卡用弱蓝底 + 细描边拉开层次;注入榜用点阵而非横条——每次注入一个点,
 * 同分条目天然排成整齐的一行(横条在全同分时全满、没有区分度,看起来就"丑");
 * 时间轴用左边线 + 圆点,最新一条强调蓝。
 */
const STATS_METRIC: React.CSSProperties = {
  flex: '1 1 96px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(96,165,250,.07)',
  border: '1px solid rgba(96,165,250,.16)',
}
const STATS_LABEL: React.CSSProperties = { margin: '10px 0 4px', fontSize: 11, opacity: 0.7, letterSpacing: '.02em' }
const STATS_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(128,128,128,.12)' }
const STATS_NAME: React.CSSProperties = { fontSize: 11, flex: '0 1 40%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const STATS_COUNT: React.CSSProperties = { fontSize: 10, opacity: 0.65, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const STATS_TRUNC_BADGE: React.CSSProperties = { fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 999, background: 'rgba(217,119,6,.15)', color: '#d97706', fontWeight: 600 }

/** 注入统计主体:概览指标 + 注入点阵榜 + 截断榜 + 时间轴。 */
function StatsSection({ stats, t, now }: { stats: AuditStatsFace; t: Translate; now: number }): ReactNode {
  type StatsMemory = AuditStatsFace['memories'][number]
  const total = stats.memories.length
  const dotCount = Math.min(stats.injections, 20)
  const allFull = total > 0 && stats.memories.every(m => m.injectedCount === stats.injections)
  const ranked = stats.memories.slice(0, 8)
  const rest = stats.memories.slice(8)
  const truncated = stats.memories
    .filter(m => (m.truncatedCount ?? 0) > 0)
    .sort((a, b) => (b.truncatedCount ?? 0) - (a.truncatedCount ?? 0))
  const avgBytes = stats.avgBytes
    ?? (stats.timeline.length > 0 ? Math.round(stats.timeline.reduce((sum, e) => sum + e.bytes, 0) / stats.timeline.length) : 0)

  /** 一行注入榜:名字 + 点阵(每次注入一点) + 比例 + 截断徽章。 */
  const rankRow = (m: StatsMemory): ReactNode => (
    <div key={m.name} style={STATS_ROW}>
      <code title={m.name} style={STATS_NAME}>{m.name}</code>
      <span title={`${m.injectedCount}/${stats.injections}`} style={{ display: 'flex', alignItems: 'center', gap: 3, flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
        {Array.from({ length: dotCount }, (_, i) => (
          <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 6px', background: i < m.injectedCount ? '#60a5fa' : 'rgba(128,128,128,.22)' }} />
        ))}
        {stats.injections > dotCount && <span style={{ fontSize: 10, opacity: 0.6 }}>…</span>}
      </span>
      <span style={STATS_COUNT}>{m.injectedCount}/{stats.injections}</span>
      {(m.truncatedCount ?? 0) > 0 && <span style={{ ...STATS_TRUNC_BADGE, whiteSpace: 'nowrap' }}>⚠ {m.truncatedCount}</span>}
    </div>
  )

  return (
    <details style={GROUP_STYLE}>
      <summary style={{ cursor: 'pointer' }}>
        📊 {t('statsTitle')} — {stats.sessions} {t('statsSessions')} · {stats.injections} {t('statsInjections')}
      </summary>

      {/* 概览:三段指标卡(会话数 / 注入段数 / 平均段体积) */}
      <div style={{ display: 'flex', gap: 10, margin: '12px 0 2px', flexWrap: 'wrap' }}>
        {[
          { value: String(stats.sessions), label: t('statsSessions') },
          { value: String(stats.injections), label: t('statsInjections') },
          { value: `${(avgBytes / 1024).toFixed(1)}K`, label: t('statsAvg') },
        ].map(metric => (
          <div key={metric.label} style={STATS_METRIC}>
            <strong style={{ fontSize: 18, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{metric.value}</strong>
            <span style={{ fontSize: 10, opacity: 0.65 }}>{metric.label}</span>
          </div>
        ))}
      </div>

      {/* 注入榜:点阵 + 比例;全同分时给一句摘要,避免"全是 3×"的呆板 */}
      <p style={STATS_LABEL}>{t('statsTopInjected')}</p>
      {allFull && <p style={{ margin: '0 0 6px', fontSize: 11, opacity: 0.65 }}>{t('statsAllInjected', { n: total, m: stats.injections })}</p>}
      {ranked.map(rankRow)}
      {rest.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.65 }}>{t('statsAll', { n: total })}</summary>
          {rest.map(rankRow)}
        </details>
      )}

      {/* 截断榜:被预算挤出注入的记忆——注入集合稳定时这里才是区分度 */}
      {truncated.length > 0 && (
        <>
          <p style={STATS_LABEL}>{t('statsTruncatedTop')}</p>
          {truncated.map(m => (
            <div key={m.name} style={STATS_ROW}>
              <code title={m.name} style={STATS_NAME}>{m.name}</code>
              <span style={{ flex: '1 1 auto' }} />
              <span style={{ ...STATS_COUNT, color: '#d97706', opacity: 1 }}>⚠ {m.truncatedCount}</span>
            </div>
          ))}
        </>
      )}

      {/* 时间轴:左边线 + 圆点,最新一条强调蓝 */}
      <p style={STATS_LABEL}>{t('statsTimeline')}</p>
      <div style={{ borderLeft: '2px solid rgba(128,128,128,.22)', marginLeft: 4, paddingLeft: 12, maxHeight: 220, overflowY: 'auto' }}>
        {stats.timeline.slice(-8).reverse().map((e, index) => (
          <div key={`${e.sessionId}-${e.ts}`} style={{ position: 'relative', padding: '4px 0' }}>
            <span style={{ position: 'absolute', left: -17, top: 9, width: 7, height: 7, borderRadius: '50%', background: index === 0 ? '#60a5fa' : 'rgba(128,128,128,.45)' }} />
            <div style={{ display: 'flex', gap: 8, fontSize: 11, alignItems: 'baseline' }}>
              <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{relativeTime(e.ts, now, t)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.cwd}>{(e.cwd.split(/[\\/]/).pop() ?? e.cwd) || '—'}</span>
              {e.truncated > 0 && <span style={{ ...STATS_TRUNC_BADGE, whiteSpace: 'nowrap' }}>⚠ {t('statsTruncated')}{e.truncated}</span>}
            </div>
            <div style={{ fontSize: 10, opacity: 0.6, marginTop: 1 }}>{e.count} {t('statsMemories')} · {(e.bytes / 1024).toFixed(1)}K</div>
          </div>
        ))}
      </div>
    </details>
  )
}

/** 记忆管理面板(face 方法经直通交叉成为顶层 props)。 */
export function MemoryPage({ t, list, read, write, del, currentCwd, importScan, importRun, auditStats }: MemoryPageProps): ReactNode {
  const [groups, setGroups] = useState<PanelGroup[] | null>(null)
  const [maxBytes, setMaxBytes] = useState(4096)
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ group: PanelGroup; memory: PanelMemory; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [now, setNow] = useState(() => Date.now())
  /** 注入审计统计(0.9.0;取不到时静默无统计区——审计绝不影响面板可用性)。 */
  const [stats, setStats] = useState<AuditStatsFace | null>(null)
  /** 导入桥状态机:loading(扫描)→ select(勾选)→ running → done。 */
  const [importer, setImporter] = useState<ImportState | null>(null)
  /** 扫描请求序号:弹层关闭即作废在途请求,迟到的响应不得复活弹层(审查修复)。 */
  const importSeq = useRef(0)

  const load = useCallback(async () => {
    setError(false)
    try {
      const data = await list()
      setGroups(data.groups as PanelGroup[])
      setMaxBytes(data.maxBytes)
      setNow(Date.now())
    } catch {
      setError(true)
    }
    try {
      setStats(await auditStats())
    } catch { /* 无审计数据(旧版宿主/文件缺失):统计区不显示 */ }
  }, [list, auditStats])

  useEffect(() => { void load() }, [load])

  /** 前端过滤:名称/标题/摘要的子串匹配(不区分大小写)。 */
  const needle = filter.trim().toLowerCase()
  const visibleGroups = useMemo(() => {
    if (groups === null || needle.length === 0) return groups
    return groups.map(group => ({
      ...group,
      memories: group.memories.filter(memory =>
        memory.name.toLowerCase().includes(needle)
        || memory.description.toLowerCase().includes(needle)
        || (memory.title ?? '').toLowerCase().includes(needle)),
    })).filter(group => group.memories.length > 0 || group.indexText != null)
  }, [groups, needle])

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

  if (error) {
    return <section style={{ padding: '24px' }}><p>{t('error')}</p><button onClick={() => { void load() }}>{t('retry')}</button></section>
  }
  if (groups === null) {
    return <section style={{ padding: '24px' }}><p>{t('loading')}</p></section>
  }

  const total = groups.reduce((sum, group) => sum + group.memories.length, 0)
  const totalPinned = groups.reduce((sum, group) => sum + group.memories.filter(m => m.pinned).length, 0)
  const totalMuted = groups.reduce((sum, group) => sum + group.memories.filter(m => m.disabled).length, 0)
  const totalIndex = groups.reduce((sum, group) => sum + group.indexBytes, 0)
  const totalUsage = totalIndex / maxBytes

  return (
    <section style={{
      padding: '20px', maxWidth: '1100px',
      // 自滚动:main slot 挂载容器不提供页面级滚动,内容超出会被裁掉
      // (导入后列表变长即触发);自滚后 sticky 弹层也相对本容器正确吸附
      height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <h2 style={{ marginBottom: '4px' }}>{t('title')}</h2>
      <p style={{ marginTop: 0, opacity: 0.75 }}>{t('intro')}</p>

      {/* 顶部操作行:刷新 + 搜索 + 导入 */}
      <p style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => { void load() }} disabled={busy}>↻ {t('refresh')}</button>{' '}
        <button disabled={busy || importer !== null || editing !== null} onClick={() => {
          const seq = ++importSeq.current
          setImporter({ phase: 'loading' })
          void importScan()
            .then(scan => {
              if (seq !== importSeq.current) return // 弹层已关闭:丢弃迟到响应
              if (scan.found && scan.projects.length > 0) {
                const selected: Record<string, boolean> = {}
                for (const p of scan.projects) selected[p.slug] = true
                setImporter({ phase: 'select', projects: scan.projects, selected, allToUser: false })
              } else {
                setImporter({ phase: 'empty' })
              }
            })
            .catch(() => {
              if (seq !== importSeq.current) return
              setImporter({ phase: 'failed' })
            })
        }}>{t('importBtn')}</button>
        <input
          style={{ ...FIELD_STYLE, flex: '1 1 200px', minWidth: '160px', padding: '4px 10px' }}
          placeholder={t('searchPlaceholder')} value={filter} onChange={event => { setFilter(event.target.value) }}
        />
        {actionError !== null && <span style={{ color: '#d97706' }}>{actionError}</span>}
      </p>

      {/* 顶部总览统计 */}
      <div style={{ ...GROUP_STYLE, display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span>🧠 <strong>{total}</strong> {t('overviewMemories')}</span>
        <span>📌 <strong>{totalPinned}</strong> {t('overviewPinned')}</span>
        <span>🔇 <strong>{totalMuted}</strong> {t('overviewMuted')}</span>
        <span style={{ flex: '1 1 120px', minWidth: '120px' }}>
          <span style={{ fontSize: '11px', opacity: 0.75, display: 'block', marginBottom: '2px' }}>
            {t('indexUsage')} {Math.round(totalUsage * 100)}%
          </span>
          <span style={{ ...BAR_STYLE, display: 'block', margin: 0 }}>
            <span style={{ display: 'block', width: `${Math.min(100, totalUsage * 100)}%`, height: '100%', background: totalUsage > 0.8 ? '#d97706' : 'rgba(96,165,250,.9)' }} />
          </span>
        </span>
      </div>

      {/* 空状态三步引导 */}
      {total === 0 && (
        <div style={{ ...GROUP_STYLE, textAlign: 'center', opacity: 0.9 }}>
          <p style={{ marginBottom: '4px' }}>🗣 {t('emptyStep1')}</p>
          <p style={{ margin: '4px 0' }}>📝 {t('emptyStep2')}</p>
          <p style={{ margin: '4px 0' }}>✨ {t('emptyStep3')}</p>
        </div>
      )}

      {/* 注入审计统计(0.9.0):概览指标卡 + 注入点阵榜 + 截断榜 + 时间轴 */}
      {stats !== null && stats.injections > 0 && <StatsSection stats={stats} t={t} now={now} />}

      {/* 组区:用户级 | 项目级 两列(各有内容才分列;flexWrap 窄屏自动堆叠) */}
      {(() => {
        const renderGroup = (group: PanelGroup): ReactNode => {
          const usage = group.indexBytes / maxBytes
          const hot = usage > 0.8
          const pinnedCount = group.memories.filter(m => m.pinned).length
          const mutedCount = group.memories.filter(m => m.disabled).length
          return (
            <div key={group.key} style={GROUP_STYLE}>
              <h3 style={{ margin: '0 0 4px' }}>
                {group.scope === 'user' ? '👤 ' : '📁 '}
                {group.scope === 'user' ? t('userScope') : `${t('projectScope')} · ${group.slug}`}
                {group.scope === 'project' && group.current === true && <span title={t('currentBadge')}> ✅</span>}
                {group.scope === 'project' && group.current !== true
                  && <small style={{ marginLeft: '8px', opacity: 0.65 }}>{t('projectNeedsSession')}</small>}
              </h3>
              {/* 组摘要行 */}
              <div style={{ fontSize: '12px', opacity: 0.8 }}>
                {group.memories.length} {t('overviewMemories')}
                {pinnedCount > 0 && <> · 📌 {pinnedCount}</>}
                {mutedCount > 0 && <> · 🔇 {mutedCount}</>}
              </div>
              <div style={{ fontSize: '12px', color: hot ? '#d97706' : 'inherit' }}>
                {t('indexUsage')}: {group.indexBytes}{t('bytes')} {t('of')} {t('budget')} {maxBytes}{t('bytes')} ({Math.round(usage * 100)}%)
              </div>
              <div style={BAR_STYLE}>
                <div style={{ width: `${Math.min(100, usage * 100)}%`, height: '100%', background: hot ? '#d97706' : 'rgba(96,165,250,.9)' }} />
              </div>
              {group.indexText != null && (
                <details style={{ margin: '6px 0' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '12px', opacity: 0.8 }}>👁 {t('injectedPreview')}</summary>
                  <pre style={{ margin: '6px 0 0', padding: '8px', background: 'rgba(127,127,127,0.12)', borderRadius: '6px', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{group.indexText}</pre>
                </details>
              )}
              {group.memories.map(memory => {
                const badge = TYPE_BADGE[memory.type] ?? TYPE_BADGE.reference
                const when = relativeTime(memory.updatedMs, now, t)
                return (
                  <div key={memory.name} style={rowVisual(memory)}>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <strong>{memory.title ?? memory.name}</strong>
                      {' '}<span style={{ ...BADGE_STYLE, ...badge.style }}>{badge.label}</span>
                      {' '}<span style={memory.disabled ? STATE_MUTED : STATE_ACTIVE}>{memory.disabled ? `⊘ ${t('muted')}` : `● ${t('activeState')}`}</span>
                      <br />
                      <span style={{ fontSize: '13px', opacity: 0.85 }}>{memory.description}</span>
                      <span style={{ fontSize: '11px', opacity: 0.55 }}> · {memory.reads} {t('reads')}{when !== null ? ` · ${when}` : ''}</span>
                    </span>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {/* 导入弹层开着时互斥禁用:两弹层同为 sticky 会互相遮挡(审查修复) */}
                      <button disabled={busy || importer !== null} title={t('edit')} onClick={() => { void openEditor(group, memory) }}>✏️</button>{' '}
                      <button disabled={busy || importer !== null} title={memory.pinned ? t('unpinAction') : t('pinAction')} onClick={() => { toggleFlag(group, memory, 'pinned') }}>{memory.pinned ? '📍' : '📌'}</button>{' '}
                      <button disabled={busy || importer !== null} title={memory.disabled ? t('unmuteAction') : t('muteAction')} onClick={() => { toggleFlag(group, memory, 'disabled') }}>{memory.disabled ? '🔈' : '🔇'}</button>{' '}
                      <button disabled={busy || importer !== null} title={t('delete')} onClick={() => { if (window.confirm(t('confirmDelete'))) void act(() => del({ cwd: cwd(group), scope: group.scope, name: memory.name })) }}>🗑</button>
                    </span>
                  </div>
                )
              })}
            </div>
          )
        }
        const userGroups = visibleGroups?.filter(g => g.scope === 'user') ?? []
        const projectGroups = visibleGroups?.filter(g => g.scope !== 'user') ?? []
        return (
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: projectGroups.length > 0 ? '1 1 420px' : '1 1 100%', minWidth: 0 }}>
              {userGroups.map(renderGroup)}
            </div>
            <div style={{ flex: userGroups.length > 0 ? '1 1 420px' : '1 1 100%', minWidth: 0 }}>
              {projectGroups.map(renderGroup)}
            </div>
          </div>
        )
      })()}
      {filter.trim().length > 0 && (visibleGroups?.length ?? 0) === 0 && <p style={{ opacity: 0.7 }}>{t('noSearchHits')}</p>}
      {editing !== null && (
        <MemoryEditor
          t={t}
          initial={editing.memory}
          initialBody={editing.body}
          busy={busy}
          onCancel={() => { setEditing(null) }}
          onSave={async payload => {
            await act(() => write({ cwd: cwd(editing.group), scope: editing.group.scope, ...payload }))
            setEditing(null)
          }}
        />
      )}
      {importer !== null && (
        <ImportDialog
          t={t}
          state={importer}
          onClose={() => { importSeq.current++; setImporter(null) }}
          onToggle={(slug, value) => {
            if (importer.phase !== 'select') return
            setImporter({ ...importer, selected: { ...importer.selected, [slug]: value } })
          }}
          onAllToUser={value => {
            if (importer.phase !== 'select') return
            setImporter({ ...importer, allToUser: value })
          }}
          onRun={async () => {
            if (importer.phase !== 'select') return
            const slugs = importer.projects.filter(p => importer.selected[p.slug]).map(p => p.slug)
            if (slugs.length === 0) return
            setImporter({ phase: 'running' })
            try {
              const response = await importRun({ slugs, allToUser: importer.allToUser })
              if (!response.ok) throw new Error(String(response.status))
              const result = await response.json() as { imported: number; skipped: number; failed: number }
              setImporter({ phase: 'done', summary: t('importDone', { n: result.imported, s: result.skipped, f: result.failed }) })
            } catch {
              // 执行失败≠扫描失败:部分记忆可能已落盘,刷新列表 + 独立文案(审查修复)
              setImporter({ phase: 'runFailed' })
            } finally {
              await load()
            }
          }}
        />
      )}
    </section>
  )
}

/** 单条记忆编辑器(标题/摘要/正文,保存即重建索引、下次注入生效)。 */
function MemoryEditor({ t, initial, initialBody, busy, onSave, onCancel }: {
  t: Translate
  initial: PanelMemory
  initialBody: string
  /** 保存进行中:禁用 Save/Cancel,防双击重复提交(#8) */
  busy: boolean
  onSave: (payload: { name: string; title?: string; description: string; type: string; body: string; pinned?: boolean }) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [title, setTitle] = useState(initial.title ?? '')
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initialBody)
  return (
    <div style={EDITOR_STYLE}>
      <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ display: 'inline-block', width: '3px', height: '15px', borderRadius: '2px', background: 'var(--dsw-alias-brand-primary, #3b6ef5)' }} />
        {t('edit')}: <code style={{ fontWeight: 500 }}>{initial.name}</code>
      </h3>
      <p style={FIELD_LABEL}>{t('titleField')}</p>
      <input style={FIELD_STYLE} value={title} onChange={event => { setTitle(event.target.value) }} />
      <p style={FIELD_LABEL}>{t('descriptionField')}</p>
      <input style={FIELD_STYLE} value={description} onChange={event => { setDescription(event.target.value) }} />
      <p style={FIELD_LABEL}>{t('bodyField')}</p>
      <textarea style={{ ...FIELD_STYLE, minHeight: '140px', resize: 'vertical' }} value={body} onChange={event => { setBody(event.target.value) }} />
      <p style={{ margin: '14px 0 0', display: 'flex', gap: '8px' }}>
        <button disabled={busy} style={BTN_PRIMARY} onClick={() => { void onSave({ name: initial.name, title: title.trim().length > 0 ? title.trim() : undefined, description, type: initial.type, body, pinned: initial.pinned }) }}>💾 {t('save')}</button>
        <button disabled={busy} style={BTN_GHOST} onClick={onCancel}>{t('cancel')}</button>
      </p>
    </div>
  )
}

/**
 * 导入 Claude Code 记忆的浮层弹窗(0.8.0):
 * loading → empty/failed → select(逐项目勾选 + 目标层展示 + allToUser 选项)
 * → running → done(结果摘要;关闭后列表已刷新)。
 */
function ImportDialog({ t, state, onClose, onToggle, onAllToUser, onRun }: {
  t: Translate
  state: ImportState
  onClose: () => void
  onToggle: (slug: string, value: boolean) => void
  onAllToUser: (value: boolean) => void
  onRun: () => Promise<void>
}): ReactNode {
  return (
    <div style={EDITOR_STYLE}>
      <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ display: 'inline-block', width: '3px', height: '15px', borderRadius: '2px', background: 'var(--dsw-alias-brand-primary, #3b6ef5)' }} />
        {t('importTitle')}
      </h3>
      {state.phase === 'loading' && <p style={{ margin: '12px 0' }}>⏳ …</p>}
      {state.phase === 'empty' && <p style={{ margin: '12px 0' }}>{t('importEmpty')}</p>}
      {state.phase === 'failed' && <p style={{ margin: '12px 0', color: 'var(--dsw-alias-state-warn-primary, #d97706)' }}>{t('importScanFailed')}</p>}
      {state.phase === 'runFailed' && <p style={{ margin: '12px 0', color: 'var(--dsw-alias-state-warn-primary, #d97706)' }}>{t('importRunFailed')}</p>}
      {state.phase === 'select' && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', margin: '10px 0' }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                <th style={{ padding: '4px 6px' }} />
                <th style={{ padding: '4px 6px' }}>{t('importProjectCol')}</th>
                <th style={{ padding: '4px 6px' }}>{t('importCountCol')}</th>
                <th style={{ padding: '4px 6px' }}>{t('importTargetCol')}</th>
              </tr>
            </thead>
            <tbody>
              {state.projects.map(p => (
                <tr key={p.slug} style={{ borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))' }}>
                  <td style={{ padding: '4px 6px' }}>
                    <input type="checkbox" checked={state.selected[p.slug] === true} onChange={e => { onToggle(p.slug, e.target.checked) }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}><code style={{ fontSize: 12 }}>{p.slug}</code></td>
                  <td style={{ padding: '4px 6px' }}>{p.importable}</td>
                  <td style={{ padding: '4px 6px' }}>
                    {p.targetScope === 'project' ? <>📁 <code style={{ fontSize: 11 }}>{p.targetDir}</code></> : <>👤 {t('importNoCwd')}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: '6px 0', fontSize: '12px' }}>
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={state.allToUser} onChange={e => { onAllToUser(e.target.checked) }} /> {t('importAllToUser')}
            </label>
          </p>
          <p style={{ margin: '6px 0', fontSize: '12px', opacity: 0.7 }}>{t('importDupNote')}</p>
        </div>
      )}
      {state.phase === 'running' && <p style={{ margin: '12px 0' }}>{t('importRunning')}</p>}
      {state.phase === 'done' && <p style={{ margin: '12px 0' }}>✅ {state.summary}</p>}
      <p style={{ margin: '12px 0 0', display: 'flex', gap: '8px' }}>
        {state.phase === 'select' && (
          <button style={BTN_PRIMARY} disabled={!Object.values(state.selected).some(Boolean)} onClick={() => { void onRun() }}>📥 {t('importRun')}</button>
        )}
        {state.phase === 'done' && (
          <button style={BTN_PRIMARY} onClick={onClose}>✓ {t('refresh')}</button>
        )}
        {state.phase !== 'running' && state.phase !== 'done' && (
          <button style={BTN_GHOST} onClick={onClose}>{t('cancel')}</button>
        )}
      </p>
    </div>
  )
}
