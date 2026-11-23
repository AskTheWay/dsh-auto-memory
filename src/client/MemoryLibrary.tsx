import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MemoryFace } from './index.ts'
import type { LibrarySearchHit } from '../recall.ts'
import {
  entryKey, entryTitle, formatBytes, formatDate, groupName, Icon, matchesStatus, memoryStatuses,
  MemoryStatus, memoryTypeLabel, memoryTypes, type PanelEntry, type PanelGroup, type PanelMemory, type Translate,
} from './panel-model.tsx'

type MemoryPatch = Partial<Parameters<MemoryFace['write']>[0]>
type BodyResult = { key: string; body: string } | { key: string; failed: true }
type SearchResult = { key: string; hits: LibrarySearchHit[] } | { key: string; failed: true }

interface LibraryProps {
  t: Translate
  groups: PanelGroup[]
  workspaceCwd: string | undefined
  revision: number
  active: boolean
  busy: boolean
  target: PanelEntry | null
  search: MemoryFace['search']
  read: MemoryFace['read']
  write: MemoryFace['write']
  del: MemoryFace['del']
  act: (request: () => Promise<Response>, failure?: string) => Promise<boolean>
  onImport: () => void
  onEditing: (editing: boolean) => void
}

export function MemoryLibrary({ t, groups, workspaceCwd, revision, active, busy, target, search, read, write, del, act, onImport, onEditing }: LibraryProps): ReactNode {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [kind, setKind] = useState('all')
  const [status, setStatus] = useState('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [bodyResult, setBodyResult] = useState<BodyResult | null>(null)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [readRetry, setReadRetry] = useState(0)
  const [editing, setEditing] = useState<{ entry: PanelEntry; body: string; cwd: string | undefined } | null>(null)
  const [deleteKey, setDeleteKey] = useState<string | null>(null)
  const [returnFocus, setReturnFocus] = useState(false)
  const lastTarget = useRef<PanelEntry | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const total = groups.reduce((n, g) => n + g.memories.length, 0)
  const needle = query.trim().toLowerCase()
  const filtering = needle.length > 0 || scope !== 'all' || kind !== 'all' || status !== 'all'
  const searchUser = scope === 'all' || scope === 'user'
  const searchCwd = scope === 'all' || scope === 'current' || scope === 'project' ? workspaceCwd : undefined
  const searchKey = JSON.stringify([needle, searchUser, searchCwd, revision])
  const needsSearch = needle.length > 0 && (searchUser || searchCwd !== undefined)
  const currentSearch = needsSearch && searchResult?.key === searchKey ? searchResult : null
  const searching = needsSearch && currentSearch === null

  useEffect(() => {
    if (!active || !needsSearch) return
    const request = new AbortController()
    const timer = setTimeout(() => {
      void search({ query: needle, user: searchUser, cwd: searchCwd }, request.signal)
        .then(({ hits }) => { if (!request.signal.aborted) setSearchResult({ key: searchKey, hits }) })
        .catch(() => { if (!request.signal.aborted) setSearchResult({ key: searchKey, failed: true }) })
    }, 180)
    return () => { clearTimeout(timer); request.abort() }
  }, [active, needsSearch, needle, searchUser, searchCwd, searchKey, search])

  const searchHits = useMemo(() => new Map(currentSearch !== null && 'hits' in currentSearch
    ? currentSearch.hits.map(hit => [JSON.stringify([hit.scope, hit.slug, hit.name]), hit])
    : []), [currentSearch])

  const results = useMemo(() => groups
    .filter(group => scope === 'all' || group.scope === scope || (scope === 'current' && group.current)
      || scope === `workspace:${group.key}`)
    .toSorted((a, b) => Number(b.current === true) - Number(a.current === true)
      || Number(b.scope === 'user') - Number(a.scope === 'user'))
    .map(group => ({ group, memories: group.memories.filter(memory =>
      (kind === 'all' || memory.type === kind)
      && matchesStatus(memory, status)
      && (!needle || `${entryTitle(memory)}\n${memory.description}\n${memory.name}`.toLowerCase().includes(needle)
        || searchHits.has(JSON.stringify([group.scope, group.slug, memory.name]))),
    ) }))
    .filter(result => result.memories.length > 0), [groups, scope, kind, status, needle, searchHits])

  const matches = results.reduce((n, row) => n + row.memories.length, 0)
  const first = results[0]
  const selectedGroup = results.find(({ group, memories }) => memories.some(memory => entryKey(group, memory.name) === selectedKey))
  const selectedMemory = selectedGroup?.memories.find(memory => entryKey(selectedGroup.group, memory.name) === selectedKey)
  const entry = editing?.entry ?? (selectedGroup && selectedMemory
    ? { group: selectedGroup.group, memory: selectedMemory }
    : first === undefined ? null : { group: first.group, memory: first.memories[0]! })
  const activeKey = entry === null ? null : entryKey(entry.group, entry.memory.name)
  const name = entry?.memory.name
  const entryScope = entry?.group.scope
  const entryCwd = editing !== null ? editing.cwd : entryScope === 'project' && entry?.group.current ? workspaceCwd : undefined
  const editable = entryScope === 'user' || entryCwd !== undefined
  const requestKey = `${revision}:${readRetry}:${activeKey ?? ''}:${entryCwd ?? ''}`
  const currentBody = bodyResult?.key === requestKey ? bodyResult : null

  useEffect(() => {
    if (!active || !editable || name === undefined || entryScope === undefined) return
    let canceled = false
    void read({ name, scope: entryScope, cwd: entryCwd })
      .then(detail => { if (!canceled) setBodyResult({ key: requestKey, body: detail.body }) })
      .catch(() => { if (!canceled) setBodyResult({ key: requestKey, failed: true }) })
    return () => { canceled = true }
  }, [active, editable, name, entryScope, entryCwd, requestKey, read])

  useEffect(() => {
    if (target === null || target === lastTarget.current || editing !== null) return
    lastTarget.current = target
    setQuery('')
    setScope('all')
    setKind('all')
    setStatus('all')
    setSelectedKey(entryKey(target.group, target.memory.name))
    setDeleteKey(null)
    setShowDetail(true)
  }, [target, editing])

  useEffect(() => {
    if (!showDetail || !active || activeKey === null) return
    headingRef.current?.focus({ preventScroll: true })
  }, [showDetail, active, activeKey, target])

  useEffect(() => {
    if (!active || !returnFocus) return
    const row = activeKey === null ? null : document.getElementById(`dam-record-${activeKey}`)
    if (row === null) searchRef.current?.focus()
    else row.focus({ preventScroll: true })
    setReturnFocus(false)
  }, [returnFocus, active, activeKey])

  const choose = (group: PanelGroup, memory: PanelMemory): void => {
    setSelectedKey(entryKey(group, memory.name))
    setDeleteKey(null)
    setShowDetail(true)
  }

  const back = (): void => {
    setShowDetail(false)
    setDeleteKey(null)
    setReturnFocus(true)
  }

  const resetFilters = (): void => {
    setQuery('')
    setScope('all')
    setKind('all')
    setStatus('all')
    setShowDetail(false)
  }

  const beginEdit = (): void => {
    if (entry === null || currentBody === null || !('body' in currentBody)) return
    setEditing({ entry, body: currentBody.body, cwd: entryCwd })
    setDeleteKey(null)
    onEditing(true)
  }

  const finishEdit = (): void => {
    setEditing(null)
    onEditing(false)
  }

  const update = (patch: MemoryPatch, keepBody: boolean): Promise<boolean> => {
    if (!entry || !editable) return Promise.resolve(false)
    const { group, memory } = entry
    const snapshot = { name: memory.name, scope: group.scope, cwd: entryCwd }
    return act(async () => {
      const body = keepBody ? (await read(snapshot)).body : patch.body ?? ''
      return write({ ...snapshot, title: memory.title, description: memory.description, type: memory.type, body,
        pinned: memory.pinned, disabled: memory.disabled, ...patch })
    })
  }

  const findRelative = (group: PanelGroup, name: string): PanelEntry | undefined => {
    const same = group.memories.find(memory => memory.name === name)
    if (same) return { group, memory: same }
    const other = groups.flatMap(g => g.memories.filter(memory => memory.name === name).map(memory => ({ group: g, memory })))
    return other.length === 1 ? other[0] : undefined
  }

  const lineage = (label: string, relatedName: string, group: PanelGroup): ReactNode => {
    const relative = findRelative(group, relatedName)
    return <div><dt>{label}</dt><dd>{relative
      ? <button type="button" className="dam-text-action" onClick={() => {
        resetFilters()
        choose(relative.group, relative.memory)
      }}>{entryTitle(relative.memory)}</button>
      : <code>{relatedName}</code>}</dd></div>
  }

  return <>
    <div className="dam-library-tools">
      <div className="dam-search">
        <Icon name="search" size={16} />
        <input ref={searchRef} type="search" name="memory-search" autoComplete="off" spellCheck={false} maxLength={256}
          value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
          disabled={editing !== null} onChange={event => { setQuery(event.target.value); setShowDetail(false); setDeleteKey(null) }} />
        {query && <button type="button" className="dam-icon-btn" aria-label={t('clearSearch')} disabled={editing !== null}
          onClick={() => { setQuery(''); setShowDetail(false); searchRef.current?.focus() }}><Icon name="close" size={14} /></button>}
      </div>
      <div className="dam-filters">
        <select className="dam-select" aria-label={t('scopeFilter')} value={scope} disabled={editing !== null}
          onChange={event => { setScope(event.target.value); setShowDetail(false); setDeleteKey(null) }}>
          <option value="all">{t('allScopes')}</option>
          <option value="user">{t('userScopeShort')}</option>
          <option value="current">{t('currentScope')}</option>
          <option value="project">{t('projectScope')}</option>
          {groups.some(g => g.scope === 'project' && !g.current) && <optgroup label={t('auditWorkspace')}>
            {groups.filter(g => g.scope === 'project' && !g.current).map(g => <option key={g.key} value={`workspace:${g.key}`}>{groupName(g, workspaceCwd, t)}</option>)}
          </optgroup>}
        </select>
        <select className="dam-select" aria-label={t('typeFilter')} value={kind} disabled={editing !== null}
          onChange={event => { setKind(event.target.value); setShowDetail(false); setDeleteKey(null) }}>
          <option value="all">{t('allTypes')}</option>
          {Object.entries(memoryTypes).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
        <select className="dam-select" aria-label={t('statusFilter')} value={status} disabled={editing !== null}
          onChange={event => { setStatus(event.target.value); setShowDetail(false); setDeleteKey(null) }}>
          <option value="all">{t('allStatuses')}</option>
          {Object.entries(memoryStatuses).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </div>
    </div>
    {needle && <p className="dam-note dam-search-status" role="status">{t(searching ? 'searchingBodies'
      : currentSearch !== null && 'failed' in currentSearch ? 'searchBodyFailed'
        : !needsSearch ? 'searchMetadataOnly' : 'searchBodyScope')}</p>}

    {total === 0 ? <div className="dam-empty">
      <h2>{t('emptyTitle')}</h2><p>{t('emptyLibrary')}</p>
      <button type="button" className="dam-btn" onClick={onImport}>{t('importBtn')}</button>
    </div> : matches === 0 && !editing ? <div className="dam-empty">
      <h2>{t(searching ? 'searchingBodies' : 'noSearchHits')}</h2>
      <button type="button" className="dam-btn" onClick={resetFilters}>{t('clearFilters')}</button>
    </div> : <div className="dam-library-grid" data-detail={showDetail ? 'open' : 'closed'}>
      <section className="dam-record-list" aria-label={t('resultList')}>
        <div className="dam-record-columns">
          <div><span aria-live="polite">{filtering ? t('filteredCount', { n: matches, total }) : t('memoryCount', { n: total })}</span>
            {filtering && <button type="button" className="dam-text-action" disabled={editing !== null} onClick={resetFilters}>{t('clearFilters')}</button>}</div>
          <span>{t('memoryState')}</span><span>{t('memoryReads')}</span>
        </div>
        {results.map(({ group, memories }) => <section className="dam-record-group" key={group.key} aria-label={groupName(group, workspaceCwd, t)}>
          <h3 className="dam-record-group-head" data-scope={group.current ? 'current' : group.scope}>
            <Icon name={group.scope === 'user' ? 'user' : 'folder'} size={14} />
            <span className="dam-ellipsize" title={group.slug}>{groupName(group, workspaceCwd, t)}</span>
            {group.current && <span className="dam-group-caption">{t('currentBadge')}</span>}
            {group.scope === 'project' && !group.current && <span className="dam-group-caption">{t('readonlyBadge')}</span>}
          </h3>
          <ul className="dam-records">
            {memories.map(memory => {
              const key = entryKey(group, memory.name)
              const hit = searchHits.get(JSON.stringify([group.scope, group.slug, memory.name]))
              const summary = hit === undefined ? memory.description : `${t(hit.field === 'body' ? 'searchHitBody' : 'searchHitKeyword')} · ${hit.excerpt}`
              return <li key={key}><button type="button" className="dam-record" id={`dam-record-${key}`} data-kind={memory.type} aria-current={key === activeKey ? 'true' : undefined}
                disabled={editing !== null && key !== activeKey} onClick={() => { choose(group, memory) }}>
                <span className="dam-record-main">
                  <span className="dam-record-title">
                    <span className="dam-ellipsize">{entryTitle(memory)}</span>{memory.pinned && <Icon name="pin" size={13} />}
                  </span>
                  <span className="dam-record-summary"><span className="dam-record-kind">{memoryTypeLabel(memory.type, t)}</span><span className="dam-ellipsize" title={summary}>{summary}</span></span>
                </span>
                <MemoryStatus memory={memory} t={t} />
                <span className="dam-record-reads">{memory.reads}</span>
              </button></li>
            })}
          </ul>
        </section>)}
      </section>

      <aside className="dam-inspector" aria-label={t('recordDetails')}>
        {entry === null ? <p className="dam-note">{t('pickMemory')}</p> : <>
          <button type="button" className="dam-btn dam-btn-quiet dam-back" disabled={editing !== null} onClick={back}><Icon name="back" />{t('backToList')}</button>
          <header className="dam-inspector-head">
            <div className="dam-inspector-location"><Icon name={entry.group.scope === 'user' ? 'user' : 'folder'} size={14} />
              <span className="dam-ellipsize" title={entry.group.slug}>{groupName(entry.group, workspaceCwd, t)}</span>
              <span className="dam-inspector-kind" data-kind={entry.memory.type}>{memoryTypeLabel(entry.memory.type, t)}</span></div>
            <h2 ref={headingRef} tabIndex={-1}>{entryTitle(entry.memory)}</h2>
            {entry.memory.description ? <p>{entry.memory.description}</p> : null}
          </header>

          {editing !== null ? <MemoryEditor key={activeKey} t={t} memory={editing.entry.memory} body={editing.body}
            busy={busy} onCancel={finishEdit} onSave={async patch => { if (await update(patch, false)) finishEdit() }} /> : <>
            <dl className="dam-record-facts">
              <div><dt>{t('memoryState')}</dt><dd className="dam-detail-states"><MemoryStatus memory={entry.memory} t={t} includeTrust /></dd></div>
              <div><dt>{t('memoryReads')}</dt><dd>{entry.memory.reads}</dd></div>
              {entry.memory.indexed !== undefined && <div><dt>{t('diskIndex')}</dt><dd>{t(entry.memory.indexed ? 'indexIncluded' : 'indexExcluded')}</dd></div>}
              {entry.memory.updatedMs !== undefined && <div><dt>{t('recordUpdated')}</dt><dd>{formatDate(entry.memory.updatedMs)}</dd></div>}
              {entry.memory.validUntilMs !== undefined && <div><dt>{t('recordValidity')}</dt><dd>{formatDate(entry.memory.validUntilMs)}</dd></div>}
              {entry.memory.supersededBy && lineage(t('successor'), entry.memory.supersededBy, entry.group)}
              {entry.memory.supersedes && lineage(t('predecessor'), entry.memory.supersedes, entry.group)}
            </dl>

            {(entry.memory.status === 'candidate' || entry.memory.status === 'disputed' || entry.memory.evidence !== undefined) && <section className="dam-evidence-box" data-state={entry.memory.status}>
              <h3>{t('evidenceTitle')}</h3>
              {entry.memory.evidence === undefined ? <p className="dam-note">{t('reviewEvidenceMissing')}</p> : <>
                <blockquote>{entry.memory.evidence.quote}</blockquote>
                <p className="dam-evidence-source"><span>{t('sourceSession')}</span><code title={entry.memory.evidence.sessionId}>{entry.memory.evidence.sessionId}</code></p>
              </>}
              {entry.memory.status === 'candidate' && <p className="dam-note">{t(entry.memory.aging ? 'reviewCandidateAging' : 'reviewCandidateHint')}</p>}
              {entry.memory.status === 'disputed' && <p className="dam-note">{t('reviewDisputedHint')}</p>}
              {editable && entry.memory.status === 'candidate' && <div className="dam-actions">
                <button type="button" className="dam-btn dam-btn-primary" disabled={busy} onClick={() => { void update({ status: 'verified' }, true) }}><Icon name="check" />{t('verifyAction')}</button>
                <button type="button" className="dam-btn" disabled={busy} onClick={() => { void update({ status: 'disputed' }, true) }}>{t('disputeAction')}</button>
              </div>}
              {editable && entry.memory.status === 'disputed' && <button type="button" className="dam-btn" disabled={busy}
                onClick={() => { void update({ status: 'candidate' }, true) }}>{t('restoreAction')}</button>}
            </section>}

            <section className="dam-body-section"><h3>{t('bodyField')}</h3>
              {!editable ? <p className="dam-note">{t('projectNeedsSession')}</p>
                : currentBody === null ? <p className="dam-note" role="status">{t('bodyLoading')}</p>
                  : 'failed' in currentBody ? <div className="dam-actions"><p className="dam-note">{t('bodyLoadFailed')}</p>
                    <button type="button" className="dam-btn" onClick={() => { setReadRetry(n => n + 1) }}>{t('retry')}</button></div>
                    : <pre className="dam-body">{currentBody.body || '—'}</pre>}
            </section>

            {entry.memory.importedFrom && <p className="dam-note">{t('importedBadge')}</p>}
            {entry.group.indexText && !editable && <details className="dam-index-group">
              <summary>{t('indexPreview')}</summary><pre className="dam-body">{entry.group.indexText}</pre>
            </details>}

            {editable && <div className="dam-inspector-actions">
              <div className="dam-actions">
                <button type="button" className="dam-btn" disabled={busy || currentBody === null || 'failed' in currentBody} onClick={beginEdit}><Icon name="edit" size={14} />{t('edit')}</button>
                <button type="button" className="dam-btn" disabled={busy} onClick={() => { void update({ pinned: !entry.memory.pinned }, true) }}>{t(entry.memory.pinned ? 'unpinAction' : 'pinAction')}</button>
                <button type="button" className="dam-btn" disabled={busy} onClick={() => { void update({ disabled: !entry.memory.disabled }, true) }}>{t(entry.memory.disabled ? 'unmuteAction' : 'muteAction')}</button>
                {entry.memory.status === 'superseded' && <button type="button" className="dam-btn" disabled={busy}
                  onClick={() => { void update({ status: 'candidate', supersedes: '' }, true) }}>{t('restoreAction')}</button>}
                <button type="button" className="dam-btn dam-btn-quiet dam-danger-text" disabled={busy}
                  onClick={() => { setDeleteKey(activeKey) }}>{t('delete')}</button>
              </div>
              {deleteKey !== null && deleteKey === activeKey && <div className="dam-delete-confirm">
                <p>{t('confirmDelete')}</p><div className="dam-actions">
                  <button type="button" className="dam-btn dam-btn-danger" disabled={busy} onClick={() => {
                    void act(() => del({ name: entry.memory.name, scope: entry.group.scope, cwd: entryCwd }), t('deleteFailed'))
                      .then(success => { if (success) { setSelectedKey(null); back() } })
                  }}>{t('delete')}</button>
                  <button type="button" className="dam-btn" disabled={busy} onClick={() => { setDeleteKey(null) }}>{t('cancel')}</button>
                </div>
              </div>}
            </div>}
          </>}
        </>}
      </aside>
    </div>}
  </>
}

function MemoryEditor({ t, memory, body, busy, onCancel, onSave }: {
  t: Translate
  memory: PanelMemory
  body: string
  busy: boolean
  onCancel: () => void
  onSave: (patch: MemoryPatch) => Promise<void>
}): ReactNode {
  const [title, setTitle] = useState(memory.title ?? '')
  const [description, setDescription] = useState(memory.description)
  const [draft, setDraft] = useState(body)
  const [initialDays] = useState(() => {
    const remaining = Math.ceil(((memory.validUntilMs ?? 0) - Date.now()) / 86_400_000)
    return remaining > 0 ? String(remaining) : ''
  })
  const [days, setDays] = useState(initialDays)
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  return <form className="dam-editor" onSubmit={event => {
    event.preventDefault()
    if (busy || !description.trim()) return
    const parsedDays = Number(days)
    if (days !== '' && !Number.isSafeInteger(parsedDays)) return
    const validUntilMs = days === initialDays ? undefined : days === '' ? 0 : Date.now() + parsedDays * 86_400_000
    void onSave({ title: title.trim() || undefined, description: description.trim(), body: draft, ...(validUntilMs === undefined ? {} : { validUntilMs }) })
  }}>
    <label>{t('titleField')}<input ref={titleRef} name="title" autoComplete="off" maxLength={80} value={title} disabled={busy} onChange={e => { setTitle(e.target.value) }} /></label>
    <label>{t('descriptionField')}<textarea name="description" required maxLength={160} rows={2} value={description} disabled={busy} onChange={e => { setDescription(e.target.value) }} /></label>
    <label>{t('bodyField')}<textarea name="body" rows={7} value={draft} disabled={busy} onChange={e => { setDraft(e.target.value) }} /></label>
    <label>{t('validUntilField')}<input name="validity" type="number" min={1} step={1} value={days} disabled={busy}
      placeholder={t(memory.expired ? 'expiredBadge' : 'validUntilNone')} title={t('validUntilHint')} onChange={e => { setDays(e.target.value) }} /></label>
    <div className="dam-actions">
      <button type="submit" className="dam-btn dam-btn-primary" disabled={busy || !description.trim()}>{t('save')}</button>
      <button type="button" className="dam-btn" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
    </div>
  </form>
}
