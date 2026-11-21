import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatBytes, formatDate, workspaceName, type AuditEntry, type AuditStats, type PanelGroup, type ProjectAudit, type Translate } from './panel-model.tsx'

type ActivityProps = { t: Translate; stats: AuditStats; groups: PanelGroup[]; budget: number; active: boolean }
type SortKey = 'injected' | 'truncated' | 'reads'

function projectRows(timeline: AuditEntry[]): ProjectAudit[] {
  const grouped = Map.groupBy(timeline, record => record.cwd)
  return [...grouped.entries()].map(([cwd, records]) => ({
    cwd, sessions: new Set(records.map(record => record.sessionId)).size,
    injections: records.length,
    avgBytes: Math.round(records.reduce((sum, record) => sum + record.bytes, 0) / records.length),
    truncated: records.reduce((sum, record) => sum + record.truncated, 0),
    lastTs: Math.max(...records.map(record => record.ts)),
    memories: 0,
  })).sort((a, b) => b.injections - a.injections || b.lastTs - a.lastTs)
}

export function MemoryActivity({ t, stats, groups, budget, active }: ActivityProps): ReactNode {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('injected')
  const [showAllMemories, setShowAllMemories] = useState(false)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  const firstIndex = Math.max(0, stats.timeline.length - 24)
  const recent = stats.timeline.slice(firstIndex).map((record, index) => ({ record, key: JSON.stringify([record.ts, record.sessionId, record.cwd, firstIndex + index]) }))
  const selected = recent.find(row => row.key === selectedKey) ?? recent.at(-1)
  const projects = stats.projects ?? projectRows(stats.timeline)
  const mean = stats.avgBytes ?? (stats.timeline.length === 0 ? 0 : Math.round(stats.timeline.reduce((sum, record) => sum + record.bytes, 0) / stats.timeline.length))
  const max = Math.max(1, budget, ...recent.map(row => row.record.bytes))

  useEffect(() => {
    const chart = chartRef.current
    const bar = chart?.querySelector('[aria-pressed="true"]')
    if (!active || !chart || !bar) return
    const bounds = chart.getBoundingClientRect()
    const button = bar.getBoundingClientRect()
    if (button.left < bounds.left) chart.scrollLeft += button.left - bounds.left - 4
    if (button.right > bounds.right) chart.scrollLeft += button.right - bounds.right + 4
  }, [active, selected?.key])

  const memoryRows = useMemo(() => {
    const rows = new Map(stats.memories.map(record => [record.name, { name: record.name, injected: record.injectedCount, truncated: record.truncatedCount ?? 0, reads: 0 }]))
    for (const group of groups) {
      for (const memory of group.memories) {
        const row = rows.get(memory.name) ?? { name: memory.name, injected: 0, truncated: 0, reads: 0 }
        row.reads += memory.reads
        rows.set(memory.name, row)
      }
    }
    return [...rows.values()].filter(row => row.injected + row.truncated + row.reads > 0)
      .sort((a, b) => b[sortBy] - a[sortBy] || a.name.localeCompare(b.name))
  }, [stats.memories, groups, sortBy])

  return <div className="dam-activity">
    <section className="dam-activity-overview" aria-labelledby="dam-activity-title">
      <div className="dam-section-head">
        <div><h2 id="dam-activity-title">{t('activityTab')}</h2>
          {stats.injections > 0 && <p className="dam-note">{t('auditSummary', { injections: stats.injections, sessions: stats.sessions, bytes: formatBytes(mean) })}</p>}</div>
        {recent.length > 0 && <div className="dam-chart-legend">
          {recent.some(({ record }) => record.truncated > 0) && <span className="dam-legend-excluded">{t('auditTruncated')}</span>}
          {budget > 0 && <span className="dam-legend-limit">{t('indexLimit')} {formatBytes(budget)}</span>}
        </div>}
      </div>
      {recent.length === 0 ? <div className="dam-empty dam-empty-inline"><h3>{t('auditEmpty')}</h3><p>{t('auditEmptyHint')}</p></div> : <>
        <figure className="dam-chart" aria-label={t('auditLatest', { n: recent.length })}>
          <div className="dam-chart-axes" aria-hidden="true"><span>{formatBytes(max)}</span><span>{formatBytes(Math.round(max / 2))}</span><span>0</span></div>
          <div className="dam-chart-scroll" ref={chartRef}>
            <div className="dam-chart-plot" style={{ minWidth: recent.length * 22 }}>
              <div className="dam-chart-mid" aria-hidden="true" />
              {budget > 0 && <div className="dam-chart-limit" aria-hidden="true" style={{ bottom: `${budget * 100 / max}%` }} />}
              <div className="dam-chart-bars" role="group" aria-label={t('auditVolume')} onKeyDown={event => {
                const index = recent.findIndex(row => row.key === selected?.key)
                const last = recent.length - 1
                const next = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(last, index + 1)
                  : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
                if (next === null) return
                event.preventDefault()
                setSelectedKey(recent[next]!.key)
                event.currentTarget.querySelectorAll('button')[next]?.focus({ preventScroll: true })
              }}>
                {recent.map(({ key, record }) => {
                  const label = t('auditSelect', { date: formatDate(record.ts), project: workspaceName(record.cwd) || t('auditUnknownWorkspace'), bytes: formatBytes(record.bytes), n: record.truncated })
                  return <button type="button" key={key} className="dam-chart-bar" aria-pressed={selected?.key === key} tabIndex={selected?.key === key ? 0 : -1}
                    data-excluded={record.truncated > 0 ? 'true' : undefined} title={label} aria-label={label} onClick={() => { setSelectedKey(key) }}>
                    <span aria-hidden="true" style={{ height: `${Math.max(1, record.bytes * 100 / max)}%` }} />
                  </button>
                })}
              </div>
            </div>
          </div>
          <figcaption><span>{formatDate(recent[0]!.record.ts)}</span><span>{t('auditLatest', { n: recent.length })}</span><span>{formatDate(recent.at(-1)!.record.ts)}</span></figcaption>
        </figure>
        {selected && <article className="dam-event" aria-live="polite">
          <div className="dam-event-head">
            <div><h3 className="dam-ellipsize" title={selected.record.cwd}>{workspaceName(selected.record.cwd) || t('auditUnknownWorkspace')}</h3>
              <time dateTime={new Date(selected.record.ts).toISOString()}>{formatDate(selected.record.ts)}</time>
              {selected.record.sessionId && <p className="dam-event-session dam-note">{t('auditSession')} <code>{selected.record.sessionId}</code></p>}
            </div>
            <dl className="dam-event-metrics">
              <div><dt>{t('auditVolume')}</dt><dd>{formatBytes(selected.record.bytes)}</dd></div>
              <div data-result="included"><dt>{t('auditEventMemory')}</dt><dd>{selected.record.count}</dd></div>
              <div data-result={selected.record.truncated > 0 ? 'excluded' : undefined}><dt>{t('auditTruncated')}</dt><dd>{selected.record.truncated}</dd></div>
            </dl>
          </div>
          {(selected.record.injected?.length || selected.record.truncatedNames?.length) ? <div className="dam-event-content">
            <AuditItems result="included" title={t('auditEventMemory')} names={selected.record.injected} count={selected.record.count} />
            <AuditItems result="excluded" title={t('auditEventTruncated')} names={selected.record.truncatedNames} count={selected.record.truncated} />
          </div> : <p className="dam-note">{t('auditEventNoNames')}</p>}
        </article>}
      </>}
    </section>

    {(memoryRows.length > 0 || projects.length > 0) && <div className="dam-audit-tables">
      {memoryRows.length > 0 && <section className="dam-surface">
        <header className="dam-section-head"><div><h2>{t('auditByMemory')}</h2><p className="dam-note">{t('auditComparisonNote')}</p></div></header>
        <div className="dam-table-scroll"><table className="dam-data-table">
          <thead><tr><th scope="col">{t('memoryName')}</th>{([['injected', 'statsProjectInjections'], ['truncated', 'auditTruncated'], ['reads', 'memoryReads']] as const).map(([key, label]) =>
            <th scope="col" key={key} aria-sort={sortBy === key ? 'descending' : 'none'}><button className="dam-column-sort" type="button" onClick={() => { setSortBy(key) }}>
              {t(label)}{sortBy === key && <span aria-hidden="true">↓</span>}</button></th>)}</tr></thead>
          <tbody>{(showAllMemories ? memoryRows : memoryRows.slice(0, 8)).map(row => <tr key={row.name}>
            <th scope="row"><span className="dam-ellipsize" title={row.name}>{row.name}</span></th><td>{row.injected}</td><td>{row.truncated}</td><td>{row.reads}</td>
          </tr>)}</tbody>
        </table></div>
        {memoryRows.length > 8 && <button type="button" className="dam-btn dam-btn-quiet dam-more" aria-expanded={showAllMemories} onClick={() => { setShowAllMemories(v => !v) }}>
          {showAllMemories ? t('auditLessRows') : t('auditAllRows', { n: memoryRows.length })}</button>}
      </section>}
      {projects.length > 0 && <section className="dam-surface">
        <header className="dam-section-head"><div><h2>{t('auditByWorkspace')}</h2>
          {stats.projects === undefined && <p className="dam-note">{t('statsProjectsRecent')}</p>}</div></header>
        <div className="dam-table-scroll"><table className="dam-data-table">
          <thead><tr><th scope="col">{t('auditWorkspace')}</th><th scope="col">{t('statsProjectInjections')}</th><th scope="col">{t('auditTruncated')}</th><th scope="col">{t('statsProjectAvg')}</th></tr></thead>
          <tbody>{(showAllProjects ? projects : projects.slice(0, 8)).map(project => <tr key={project.cwd}>
            <th scope="row"><span className="dam-ellipsize" title={project.cwd}>{workspaceName(project.cwd) || t('auditUnknownWorkspace')}</span></th>
            <td>{project.injections}</td><td>{project.truncated}</td><td>{formatBytes(project.avgBytes)}</td>
          </tr>)}</tbody>
        </table></div>
        {projects.length > 8 && <button type="button" className="dam-btn dam-btn-quiet dam-more" aria-expanded={showAllProjects} onClick={() => { setShowAllProjects(v => !v) }}>
          {showAllProjects ? t('auditLessRows') : t('auditAllRows', { n: projects.length })}</button>}
      </section>}
    </div>}
  </div>
}

function AuditItems({ result, title, names, count }: { result: 'included' | 'excluded'; title: string; names: string[] | undefined; count: number }): ReactNode {
  if (!names?.length) return null
  return <div data-result={result}><h4>{title}{count > names.length && <span className="dam-note"> {names.length} / {count}</span>}</h4>
    <ul>{names.map((name, i) => <li key={`${i}:${name}`}><code>{name}</code></li>)}</ul></div>
}
