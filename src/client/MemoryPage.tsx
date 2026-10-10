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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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

/** 面板完整 props(由 main slot 渲染器组装:业务 face 直通交叉为顶层成员)。 */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'autoMemory'> & MemoryFace

const GROUP_STYLE: React.CSSProperties = { margin: '16px 0', padding: '12px', border: '1px solid rgba(128,128,128,.35)', borderRadius: '8px' }
const BAR_STYLE: React.CSSProperties = { height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,.3)', overflow: 'hidden', margin: '6px 0' }
const ROW_STYLE: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }

/** 悬浮编辑器容器:官方主题变量(--dsw-alias-*)+ 半透明灰回退,深浅主题均可读。 */
const EDITOR_STYLE: React.CSSProperties = {
  ...GROUP_STYLE,
  position: 'sticky',
  bottom: '12px',
  background: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,0.65))',
  backdropFilter: 'blur(6px)',
  color: 'var(--dsw-alias-label-primary, inherit)',
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

/** 记忆管理面板(face 方法经直通交叉成为顶层 props)。 */
export function MemoryPage({ t, list, read, write, del, currentCwd }: MemoryPageProps): ReactNode {
  const [groups, setGroups] = useState<PanelGroup[] | null>(null)
  const [maxBytes, setMaxBytes] = useState(4096)
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ group: PanelGroup; memory: PanelMemory; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const [now, setNow] = useState(() => Date.now())

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
  }, [list])

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
    <section style={{ padding: '20px', maxWidth: '860px' }}>
      <h2 style={{ marginBottom: '4px' }}>{t('title')}</h2>
      <p style={{ marginTop: 0, opacity: 0.75 }}>{t('intro')}</p>

      {/* 顶部操作行:刷新 + 搜索 */}
      <p style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => { void load() }} disabled={busy}>↻ {t('refresh')}</button>
        <input
          style={{ flex: '1 1 200px', minWidth: '160px', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' }}
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

      {visibleGroups?.map(group => {
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
                    <button disabled={busy} title={t('edit')} onClick={() => { void openEditor(group, memory) }}>✏️</button>{' '}
                    <button disabled={busy} title={memory.pinned ? t('unpinAction') : t('pinAction')} onClick={() => { toggleFlag(group, memory, 'pinned') }}>{memory.pinned ? '📍' : '📌'}</button>{' '}
                    <button disabled={busy} title={memory.disabled ? t('unmuteAction') : t('muteAction')} onClick={() => { toggleFlag(group, memory, 'disabled') }}>{memory.disabled ? '🔈' : '🔇'}</button>{' '}
                    <button disabled={busy} title={t('delete')} onClick={() => { if (window.confirm(t('confirmDelete'))) void act(() => del({ cwd: cwd(group), scope: group.scope, name: memory.name })) }}>🗑</button>
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
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
      <h3 style={{ margin: 0 }}>✏️ {t('edit')}: <code>{initial.name}</code></h3>
      <p style={{ margin: '8px 0' }}>
        {t('titleField')}:{' '}
        <input style={{ width: '60%' }} value={title} onChange={event => { setTitle(event.target.value) }} />
      </p>
      <p style={{ margin: '8px 0' }}>
        {t('descriptionField')}:{' '}
        <input style={{ width: '80%' }} value={description} onChange={event => { setDescription(event.target.value) }} />
      </p>
      <p style={{ margin: '8px 0' }}>{t('bodyField')}:</p>
      <textarea style={{ width: '100%', minHeight: '120px', boxSizing: 'border-box' }} value={body} onChange={event => { setBody(event.target.value) }} />
      <p style={{ margin: '8px 0 0' }}>
        <button disabled={busy} onClick={() => { void onSave({ name: initial.name, title: title.trim().length > 0 ? title.trim() : undefined, description, type: initial.type, body, pinned: initial.pinned }) }}>💾 {t('save')}</button>{' '}
        <button disabled={busy} onClick={onCancel}>{t('cancel')}</button>
      </p>
    </div>
  )
}
