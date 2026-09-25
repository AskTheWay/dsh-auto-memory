/**
 * 记忆管理面板(主列全局面板):
 * - 分组列表:用户级 + 各项目组(当前工作区组标记可编辑)
 * - 容量条:每组索引字节 vs 注入预算(超 80% 预警)
 * - 逐条操作:编辑(标题/摘要/正文)、置顶/取消置顶、删除(带确认)
 * - 写入即生效:下次请求注入自动更新(纯文件派生索引,无需重启)
 *
 * 样式内联(官方 CSS Modules 管线未随 preset 发布);控件不依赖
 * ui-primitives 具体导出面(降低跨版本脆弱性),仅用原生元素。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
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
}

type Translate = (key: PluginMemoryLocaleKey, params?: Record<string, string | number>) => string

/** 面板完整 props(由 main slot 渲染器组装:业务 face 直通交叉为顶层成员)。 */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'autoMemory'> & MemoryFace

const GROUP_STYLE: React.CSSProperties = { margin: '16px 0', padding: '12px', border: '1px solid rgba(128,128,128,.35)', borderRadius: '8px' }
const BAR_STYLE: React.CSSProperties = { height: '6px', borderRadius: '3px', background: 'rgba(128,128,128,.3)', overflow: 'hidden', margin: '6px 0' }
const ROW_STYLE: React.CSSProperties = { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.15)' }

/** 记忆管理面板(face 方法经直通交叉成为顶层 props)。 */
export function MemoryPage({ t, list, read, write, del, currentCwd }: MemoryPageProps): ReactNode {
  const [groups, setGroups] = useState<PanelGroup[] | null>(null)
  const [maxBytes, setMaxBytes] = useState(4096)
  const [error, setError] = useState(false)
  const [editing, setEditing] = useState<{ group: PanelGroup; memory: PanelMemory; body: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(false)
    try {
      const data = await list()
      setGroups(data.groups as PanelGroup[])
      setMaxBytes(data.maxBytes)
    } catch {
      setError(true)
    }
  }, [list])

  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<Response>): Promise<void> => {
    setBusy(true)
    try {
      const response = await fn()
      if (!response.ok) console.warn('[auto-memory] action failed', response.status)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const cwd = (group: PanelGroup): string | undefined => (group.scope === 'project' && group.current === true ? currentCwd() : undefined)

  /** 打开编辑器:先拉取正文(列表响应不含 body)。 */
  const openEditor = async (group: PanelGroup, memory: PanelMemory): Promise<void> => {
    const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
    setEditing({ group, memory, body: 'body' in detail ? detail.body : '' })
  }

  if (error) {
    return <section style={{ padding: '24px' }}><p>{t('error')}</p><button onClick={() => { void load() }}>{t('retry')}</button></section>
  }
  if (groups === null) {
    return <section style={{ padding: '24px' }}><p>{t('loading')}</p></section>
  }

  const total = groups.reduce((sum, group) => sum + group.memories.length, 0)
  return (
    <section style={{ padding: '20px', maxWidth: '860px' }}>
      <h2>{t('title')}</h2>
      <p style={{ opacity: 0.75 }}>{t('intro')}</p>
      <p><button onClick={() => { void load() }} disabled={busy}>{t('refresh')}</button></p>
      {total === 0 && <p>{t('empty')}</p>}
      {groups.map(group => {
        const usage = group.indexBytes / maxBytes
        const hot = usage > 0.8
        return (
          <div key={group.key} style={GROUP_STYLE}>
            <h3 style={{ margin: '0 0 4px' }}>
              {group.scope === 'user' ? t('userScope') : `${t('projectScope')} · ${group.slug}`}
              {group.scope === 'project' && group.current !== true
                && <small style={{ marginLeft: '8px', opacity: 0.65 }}>{t('projectNeedsSession')}</small>}
            </h3>
            <div style={{ fontSize: '12px', color: hot ? '#d97706' : 'inherit' }}>
              {t('indexUsage')}: {group.indexBytes}{t('bytes')} {t('of')} {t('budget')} {maxBytes}{t('bytes')} ({Math.round(usage * 100)}%)
            </div>
            <div style={BAR_STYLE}>
              <div style={{ width: `${Math.min(100, usage * 100)}%`, height: '100%', background: hot ? '#d97706' : 'rgba(96,165,250,.9)' }} />
            </div>
            {group.memories.map(memory => (
              <div key={memory.name} style={ROW_STYLE}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <strong>{memory.title ?? memory.name}</strong>
                  {memory.pinned && <span title={t('pinned')}> 📌</span>}
                  {' '}<code style={{ fontSize: '11px', opacity: 0.7 }}>{memory.type}/{memory.name}</code>
                  <br />
                  <span style={{ fontSize: '13px', opacity: 0.85 }}>{memory.description}</span>
                  <span style={{ fontSize: '11px', opacity: 0.55 }}> · {memory.reads} {t('reads')}</span>
                </span>
                <span style={{ whiteSpace: 'nowrap' }}>
                  <button disabled={busy} onClick={() => { void openEditor(group, memory) }}>{t('edit')}</button>{' '}
                  <button disabled={busy} onClick={() => {
                    // 置顶切换必须先取正文再整条重写(列表响应不含 body,直接写会清空正文)
                    void (async () => {
                      const detail = await read({ name: memory.name, scope: group.scope, cwd: cwd(group) })
                      const bodyText = 'body' in detail ? detail.body : ''
                      await act(() => write({ cwd: cwd(group), scope: group.scope, name: memory.name, title: memory.title, description: memory.description, type: memory.type, body: bodyText, pinned: !memory.pinned }))
                    })()
                  }}>
                    {memory.pinned ? t('unpinAction') : t('pinAction')}
                  </button>{' '}
                  <button disabled={busy} onClick={() => { if (window.confirm(t('confirmDelete'))) void act(() => del({ cwd: cwd(group), scope: group.scope, name: memory.name })) }}>
                    {t('delete')}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )
      })}
      {editing !== null && (
        <MemoryEditor
          t={t}
          initial={editing.memory}
          initialBody={editing.body}
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
function MemoryEditor({ t, initial, initialBody, onSave, onCancel }: {
  t: Translate
  initial: PanelMemory
  initialBody: string
  onSave: (payload: { name: string; title?: string; description: string; type: string; body: string; pinned?: boolean }) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [title, setTitle] = useState(initial.title ?? '')
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initialBody)
  return (
    <div style={{ ...GROUP_STYLE, position: 'sticky', bottom: '12px', background: 'var(--dsh-bg, #fff)' }}>
      <h3 style={{ margin: 0 }}>{t('edit')}: <code>{initial.name}</code></h3>
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
        <button onClick={() => { void onSave({ name: initial.name, title: title.trim().length > 0 ? title.trim() : undefined, description, type: initial.type, body, pinned: initial.pinned }) }}>{t('save')}</button>{' '}
        <button onClick={onCancel}>{t('cancel')}</button>
      </p>
    </div>
  )
}
