import { useEffect, useState, type ReactNode } from 'react'
import type { MemoryFace } from './index.ts'
import { entryKey, entryTitle, groupName, Icon, MemoryStatus, type HealthReport, type MemoryTarget, type PanelEntry, type Translate } from './panel-model.tsx'

type MaintenanceProps = {
  t: Translate
  queue: PanelEntry[]
  health: HealthReport | null
  workspaceCwd: string | undefined
  revision: number
  busy: boolean
  onLocate: (target: MemoryTarget) => void
  canLocate: (target: MemoryTarget) => boolean
  canRenew: (target: MemoryTarget) => boolean
  onRenew: (target: MemoryTarget) => Promise<void>
  dreamProposals: MemoryFace['dreamProposals']
  dreamApply: MemoryFace['dreamApply']
  act: (request: () => Promise<Response>, failure?: string) => Promise<boolean>
}

export function MemoryMaintenance({ t, queue, health, workspaceCwd, revision, busy, onLocate, canLocate, canRenew, onRenew, dreamProposals, dreamApply, act }: MaintenanceProps): ReactNode {
  const locate = (target: MemoryTarget, label = t('maintenanceInspect')): ReactNode => <button type="button" className="dam-btn dam-btn-quiet"
    disabled={!canLocate(target) || busy} onClick={() => { onLocate(target) }}>{label}<Icon name="chevron" size={13} /></button>

  const queueOrder = queue.toSorted((a, b) => Number(b.memory.status === 'disputed') - Number(a.memory.status === 'disputed'))
  return <div className="dam-maintenance">
    <section className="dam-surface" aria-labelledby="dam-queue-title">
      <header className="dam-section-head"><h2 id="dam-queue-title">{t('queueTitle')}</h2></header>
      {queueOrder.length === 0 ? <p className="dam-note dam-section-empty">{t('queueEmpty')}</p> : <ul className="dam-review-list">
        {queueOrder.map(({ group, memory }) => <li key={entryKey(group, memory.name)}>
          <div className="dam-review-main">
            <span className="dam-review-name">{entryTitle(memory)}</span>
            <span className="dam-note dam-ellipsize">{groupName(group, workspaceCwd, t)}</span>
          </div>
          <MemoryStatus memory={memory} t={t} />
          {locate({ name: memory.name, scope: group.scope, slug: group.slug })}
        </li>)}
      </ul>}
    </section>

    {health !== null && <div className="dam-maintenance-checks">
      <CheckList label={t('maintenanceExpired')} count={health.expired.length} empty={t('healthNone')} defaultOpen={health.expired.length > 0}>
        {health.expired.map(item => <li key={JSON.stringify([item.scope, item.slug, item.name])}>
          <div className="dam-review-main"><span className="dam-review-name">{item.name}</span><span className="dam-note">{t('expiredAgo', { n: item.expiredDays })}</span></div>
          <div className="dam-actions">
            {canRenew(item) && <button type="button" className="dam-btn" disabled={busy} onClick={() => { void onRenew(item) }}>{t('renewAction')}</button>}
            {locate(item)}
          </div>
        </li>)}
      </CheckList>
      <CheckList label={t('maintenanceConflicts')} count={health.conflicts.length} empty={t('healthNone')}>
        {health.conflicts.map(({ kind, a, b }, index) => <li key={JSON.stringify([a, b, index])}>
          <div className="dam-review-main"><span className="dam-review-name">{a.name} / {b.name}</span>
            <span className="dam-note">{t(kind === 'cross-scope' ? 'healthCrossScope' : 'healthNearDup')}</span></div>
          <div className="dam-actions">{locate(a, t(a.scope === 'user' ? 'scopeUser' : 'scopeProject'))}{locate(b, t(b.scope === 'user' ? 'scopeUser' : 'scopeProject'))}</div>
        </li>)}
      </CheckList>
      <CheckList label={t('maintenanceIdle')} count={health.zombies.length} empty={t('healthNone')}>
        {health.zombies.map(item => <li key={JSON.stringify([item.scope, item.slug, item.name])}>
          <div className="dam-review-main"><span className="dam-review-name">{item.name}</span><span className="dam-note">{t('maintenanceIdleMeta', { n: item.ageDays })}</span></div>
          {locate(item)}
        </li>)}
      </CheckList>
      <CheckList label={t('maintenanceLinks')} count={health.deadLinks.length} empty={t('healthNone')}>
        {health.deadLinks.map(item => <li key={JSON.stringify([item.scope, item.slug, item.from, item.target])}>
          <div className="dam-review-main"><span className="dam-review-name">{item.from}</span><code>{item.target}</code></div>
          {locate({ name: item.from, scope: item.scope, slug: item.slug })}
        </li>)}
      </CheckList>
    </div>}

    <MaintenanceSuggestions t={t} revision={revision} workspaceCwd={workspaceCwd} busy={busy} fetchSuggestions={dreamProposals} applySuggestion={dreamApply} act={act} />
  </div>
}

function CheckList({ label, count, empty, defaultOpen, children }: { label: string; count: number; empty: string; defaultOpen?: boolean; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return <details className="dam-checklist" open={open} onToggle={e => { setOpen(e.currentTarget.open) }}>
    <summary><span>{label}</span><span className="dam-list-count">{count}</span><Icon name="chevron" size={14} /></summary>
    {count > 0 ? <ul className="dam-review-list">{children}</ul> : <p className="dam-note dam-section-empty">{empty}</p>}
  </details>
}

function MaintenanceSuggestions({ t, revision, workspaceCwd, busy, fetchSuggestions, applySuggestion, act }: {
  t: Translate
  revision: number
  workspaceCwd: string | undefined
  busy: boolean
  fetchSuggestions: MemoryFace['dreamProposals']
  applySuggestion: MemoryFace['dreamApply']
  act: MaintenanceProps['act']
}): ReactNode {
  const [data, setData] = useState<Awaited<ReturnType<MemoryFace['dreamProposals']>> | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  useEffect(() => {
    let canceled = false
    void fetchSuggestions().then(result => { if (!canceled) { setData(result); setFailed(false) } })
      .catch(() => { if (!canceled) setFailed(true) })
    return () => { canceled = true }
  }, [fetchSuggestions, revision])

  return <section className="dam-surface">
    <header className="dam-section-head"><h2>{t('dreamTitle')}</h2></header>
    {failed ? <p className="dam-note dam-section-empty">{t('maintenanceProposalUnavailable')}</p>
      : data === null ? <p className="dam-note dam-section-empty" role="status">{t('loading')}</p>
        : data.stale ? <p className="dam-note dam-section-empty">{t('dreamStale')}</p>
          : data.proposals.length === 0 ? <p className="dam-note dam-section-empty">{t('dreamEmpty')}</p>
            : <ul className="dam-review-list">{data.proposals.map(proposal => <li key={proposal.id}>
              <div className="dam-review-main">
                <span className="dam-review-name">{proposal.summary}</span>
                <span className="dam-note">{proposal.reason}</span>
                <code>{proposal.targets.join(', ')}</code>
              </div>
              <button type="button" className="dam-btn" disabled={busy || confirmed === proposal.id} onClick={() => {
                void act(() => applySuggestion({ id: proposal.id, cwd: workspaceCwd }), t('dreamFailed'))
                  .then(success => { if (success) setConfirmed(proposal.id) })
              }}>{confirmed === proposal.id ? t('dreamApplied') : t(proposal.kind === 'merge' ? 'dreamMerge' : proposal.kind === 'promote' ? 'dreamPromote' : 'dreamRetire')}</button>
            </li>)}</ul>}
  </section>
}
