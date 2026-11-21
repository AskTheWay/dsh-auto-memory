import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryFace } from './index.ts'
import { ClaudeImport } from './ClaudeImport.tsx'
import { MemoryActivity } from './MemoryActivity.tsx'
import { MemoryLibrary } from './MemoryLibrary.tsx'
import { MemoryMaintenance } from './MemoryMaintenance.tsx'
import { MemorySettings } from './MemorySettings.tsx'
import { formatBytes, groupName, Icon, type AuditStats, type HealthReport, type MemoryTarget, type PanelEntry, type PanelGroup, type SettingsView, type Translate } from './panel-model.tsx'

export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<'autoMemory'> & MemoryFace

const tabs = [
  ['library', 'libraryTab'], ['activity', 'activityTab'], ['maintenance', 'maintenanceTab'], ['settings', 'settingsTitle'],
] as const
type Tab = typeof tabs[number][0]

interface LibraryData {
  groups: PanelGroup[]
  budget: number
  netBudget: number
  importCount: number
  workspaceCwd: string | undefined
  revision: number
}

export function MemoryPage({ t, list, read, write, del, currentCwd, importScan, importApply, auditStats, healthReport, exportAgents, configGet, configSet, dreamProposals, dreamApply }: MemoryPageProps): ReactNode {
  const [data, setData] = useState<LibraryData | null>(null)
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [tab, setTab] = useState<Tab>('library')
  const [target, setTarget] = useState<PanelEntry | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [editing, setEditing] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const refreshId = useRef(0)
  const busyRef = useRef(false)

  const load = useCallback(async () => {
    const revision = ++refreshId.current
    const workspaceCwd = currentCwd()
    const isCurrent = (): boolean => refreshId.current === revision
    setRefreshing(true)
    await Promise.allSettled([
      list().then(library => {
        if (!isCurrent()) return
        setData({ groups: library.groups, budget: library.maxBytes,
          netBudget: library.budgetBytes ?? library.maxBytes, importCount: library.claudeImportPending ?? 0, workspaceCwd, revision })
        setError(false)
      }).catch(() => { if (isCurrent()) setError(true) }),
      auditStats().then(audit => { if (isCurrent()) setStats(audit) }),
      healthReport().then(report => { if (isCurrent()) setHealth(report) }),
      configGet().then(config => { if (isCurrent()) setSettings(config) }),
    ])
    if (isCurrent()) setRefreshing(false)
  }, [list, currentCwd, auditStats, healthReport, configGet])

  useEffect(() => {
    void load()
    return () => { refreshId.current++ }
  }, [load])

  useEffect(() => { rootRef.current?.scrollTo({ top: 0 }) }, [tab])

  const act = async (request: () => Promise<Response>, failure = t('saveFailed')): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const response = await request()
      if (!response.ok) throw new Error(String(response.status))
      await load()
      return true
    } catch {
      setNotice({ text: failure, error: true })
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const find = (target: MemoryTarget): PanelEntry | null => {
    const candidates = (data?.groups ?? [])
      .filter(group => group.scope === target.scope && (target.slug === undefined || group.slug === target.slug))
      .flatMap(group => group.memories.filter(memory => memory.name === target.name).map(memory => ({ group, memory })))
    return candidates.length === 1 ? candidates[0]! : null
  }

  const locate = (record: MemoryTarget): void => {
    if (editing) { setTab('library'); setNotice({ text: t('keepEditing') }); return }
    const entry = find(record)
    if (!entry) return
    setTarget(entry)
    setTab('library')
    rootRef.current?.scrollTo({ top: 0 })
  }

  const canRenew = (record: MemoryTarget): boolean => {
    const entry = find(record)
    return entry?.group.scope === 'user' || (entry?.group.current === true && data?.workspaceCwd !== undefined)
  }

  const renew = async (record: MemoryTarget): Promise<void> => {
    const entry = find(record)
    if (!entry || !canRenew(record)) return
    const { group, memory } = entry
    const key = { name: memory.name, scope: group.scope, cwd: group.scope === 'project' ? data?.workspaceCwd : undefined }
    await act(async () => write({ ...key, title: memory.title, description: memory.description, type: memory.type,
      body: (await read(key)).body, pinned: memory.pinned, disabled: memory.disabled, status: memory.status,
      validUntilMs: Date.now() + 90 * 86_400_000,
    }), t('renewFailed'))
  }

  const queue = data?.groups.flatMap(group => group.memories.filter(memory => memory.status === 'candidate' || memory.status === 'disputed')
    .map(memory => ({ group, memory }))) ?? []

  const copy = (): void => {
    void exportAgents().then(result => navigator.clipboard.writeText(result.content))
      .then(() => { setNotice({ text: t('exportDone') }) }).catch(() => { setNotice({ text: t('exportFailed'), error: true }) })
  }

  return <div className="dam-root" ref={rootRef}>
    <div className="dam-shell">
      <header className="dam-header">
        <h1>{t('title')}</h1>
        <div className="dam-header-actions">
          <button type="button" className="dam-icon-btn" title={t('refresh')} aria-label={t('refresh')} disabled={busy || refreshing}
            onClick={() => { setNotice(null); void load() }}><Icon name="refresh" /></button>
          <button type="button" className="dam-btn dam-btn-quiet" title={t('exportTip')} disabled={busy} onClick={copy}><Icon name="upload" size={15} />{t('exportShort')}</button>
          <button type="button" className="dam-btn" disabled={busy || editing} onClick={() => { setImportOpen(true) }}>
            <Icon name="download" size={15} />{t('importShort')}{data !== null && data.importCount > 0 && <span className="dam-action-count" title={t('importHint', { n: data.importCount })}>{data.importCount}</span>}
          </button>
        </div>
      </header>
      <nav className="dam-tabs" role="tablist" aria-label={t('panel')}>
        {tabs.map(([key, label], index) => <button key={key} type="button" className="dam-tab" id={`dam-tab-${key}`} role="tab"
          aria-selected={tab === key} aria-controls={`dam-pane-${key}`} tabIndex={tab === key ? 0 : -1}
          onClick={() => { setNotice(null); setTab(key) }} onKeyDown={event => {
            const length = tabs.length
            const next = event.key === 'ArrowRight' ? (index + 1) % length : event.key === 'ArrowLeft' ? (index + length - 1) % length
              : event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : null
            if (next === null) return
            event.preventDefault()
            const nextTab = tabs[next]![0]
            setNotice(null)
            setTab(nextTab)
            document.getElementById(`dam-tab-${nextTab}`)?.focus()
          }}>
          {t(label)}{key === 'maintenance' && queue.length > 0 && <span className="dam-tab-count">{queue.length}</span>}
        </button>)}
      </nav>

      {notice && <div className="dam-notice" role={notice.error ? 'alert' : 'status'} data-error={notice.error ? 'true' : undefined}>
        <span>{notice.text}</span><button type="button" className="dam-icon-btn" aria-label={t('dismissAction')} onClick={() => { setNotice(null) }}><Icon name="close" size={14} /></button>
      </div>}

      {error && <div className="dam-notice" role="alert" data-error="true"><span>{t('error')}</span><button type="button" className="dam-btn" disabled={refreshing}
        onClick={() => { void load() }}>{t('retry')}</button></div>}

      <section className="dam-pane" id="dam-pane-library" aria-labelledby="dam-tab-library" role="tabpanel" hidden={tab !== 'library'}>
        {data === null ? refreshing && <p className="dam-note" role="status">{t('loading')}</p> : <>
          <MemoryLibrary t={t} groups={data.groups} workspaceCwd={data.workspaceCwd} revision={data.revision} active={tab === 'library'} busy={busy} target={target}
            read={read} write={write} del={del} act={act} onImport={() => { if (!editing && !busy) setImportOpen(true) }} onEditing={setEditing} />
          <IndexBudget t={t} data={data} />
        </>}
      </section>

      <section className="dam-pane" id="dam-pane-activity" aria-labelledby="dam-tab-activity" role="tabpanel" hidden={tab !== 'activity'}>
        {stats === null ? <p className="dam-note" role="status">{t(refreshing ? 'loading' : 'actionUnavailable')}</p>
          : <MemoryActivity t={t} stats={stats} groups={data?.groups ?? []} budget={data?.budget ?? 0} active={tab === 'activity'} />}
      </section>

      <section className="dam-pane" id="dam-pane-maintenance" aria-labelledby="dam-tab-maintenance" role="tabpanel" hidden={tab !== 'maintenance'}>
        {data === null ? <p className="dam-note" role="status">{t(refreshing ? 'loading' : 'actionUnavailable')}</p>
          : <MemoryMaintenance t={t} queue={queue} health={health} workspaceCwd={data.workspaceCwd} revision={data.revision} busy={busy}
            onLocate={locate} canLocate={record => find(record) !== null} canRenew={canRenew} onRenew={renew} dreamProposals={dreamProposals} dreamApply={dreamApply} act={act} />}
      </section>

      <section className="dam-pane" id="dam-pane-settings" aria-labelledby="dam-tab-settings" role="tabpanel" hidden={tab !== 'settings'}>
        {settings === null ? <p className="dam-note" role="status">{t(refreshing ? 'loading' : 'actionUnavailable')}</p>
          : <MemorySettings t={t} settings={settings} busy={busy} configSet={configSet} act={act} />}
      </section>

      {importOpen && <ClaudeImport t={t} scan={importScan} apply={importApply} reload={load} onClose={() => { setImportOpen(false) }} />}
    </div>
  </div>
}

function IndexBudget({ t, data }: { t: Translate; data: LibraryData }): ReactNode {
  const groups = data.groups.filter(group => (group.current || group.scope === 'user') && group.indexBytes > 0)
  const size = groups.reduce((sum, group) => sum + group.indexBytes, 0)
  const fixed = size === 0 ? 0 : Math.max(0, data.budget - data.netBudget)
  const over = Math.max(0, size + fixed - data.budget)
  const budget = Math.max(1, data.budget)
  const fixedPct = Math.min(100, fixed * 100 / budget)
  const contentPct = Math.min(100 - fixedPct, size * 100 / budget)

  return <details className="dam-index-usage">
    <summary>
      <span className="dam-index-label">{t('indexEstimate')}</span>
      <span className="dam-index-meter" aria-hidden="true" data-over={over > 0 ? 'true' : undefined}>
        <i style={{ width: `${contentPct}%` }} /><i style={{ width: `${fixedPct}%` }} />
      </span>
      <span className="dam-index-size">{formatBytes(size + fixed)} / {formatBytes(data.budget)}</span>
      <Icon name="chevron" size={14} />
    </summary>
    <div className="dam-index-body">
      <p className="dam-note">{t('indexNote')}</p>
      {groups.length === 0 && <p className="dam-note">{t('indexNoRows')}</p>}
      {over > 0 && <p className="dam-danger-text">{t('overBudget', { bytes: formatBytes(over) })}</p>}
      {fixed > 0 && <p className="dam-note">{t('fixedAllowance')} {formatBytes(fixed)}</p>}
      {groups.map(group => <details className="dam-index-group" key={group.key}><summary>{groupName(group, data.workspaceCwd, t)} <span className="dam-note">{formatBytes(group.indexBytes)}</span></summary>
        <pre className="dam-body">{group.indexText ?? '—'}</pre></details>)}
    </div>
  </details>
}
