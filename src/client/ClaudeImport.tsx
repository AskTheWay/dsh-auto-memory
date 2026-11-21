import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryFace } from './index.ts'
import { Icon, type Translate } from './panel-model.tsx'

type Scan = Awaited<ReturnType<MemoryFace['importScan']>>
type ImportState = { phase: 'loading' | 'empty' | 'scanFailed' | 'applying' | 'applyFailed' }
  | { phase: 'select'; projects: Scan['projects']; selected: Record<string, boolean>; allToUser: boolean }
  | { phase: 'done'; summary: string }

const fileKey = (slug: string, file: string): string => `${slug}\u0000${file}`
const canSelect = (file: Scan['projects'][number]['files'][number]): boolean => file.state !== 'modified' && file.state !== 'conflict'

export function ClaudeImport({ t, scan, apply, reload, onClose }: {
  t: Translate
  scan: MemoryFace['importScan']
  apply: MemoryFace['importApply']
  reload: () => Promise<void>
  onClose: () => void
}): ReactNode {
  const [state, setState] = useState<ImportState>({ phase: 'loading' })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const scanRef = useRef(scan)
  useEffect(() => {
    const originalFocus = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    let canceled = false
    void scanRef.current().then(result => {
      if (canceled) return
      if (!result.found || result.projects.length === 0) { setState({ phase: 'empty' }); return }
      const selected = Object.fromEntries(result.projects.flatMap(project => project.files.map(file => [fileKey(project.slug, file.file), true])))
      setState({ phase: 'select', projects: result.projects, selected, allToUser: false })
    }).catch(() => { if (!canceled) setState({ phase: 'scanFailed' }) })
    return () => {
      canceled = true
      dialog?.close()
      if (originalFocus instanceof HTMLElement && originalFocus.isConnected) originalFocus.focus()
    }
  }, [])

  const items: Array<{ slug: string; file: string }> = []
  const revoke: Array<{ slug: string; file: string }> = []
  if (state.phase === 'select') {
    for (const project of state.projects) {
      for (const file of project.files) {
        const selected = state.selected[fileKey(project.slug, file.file)] === true
        if (selected && file.state === 'pending') items.push({ slug: project.slug, file: file.file })
        if (!selected && (file.state === 'imported' || file.state === 'legacy')) revoke.push({ slug: project.slug, file: file.file })
      }
    }
  }

  const run = async (): Promise<void> => {
    if (state.phase !== 'select' || items.length + revoke.length === 0) return
    setState({ phase: 'applying' })
    try {
      const response = await apply({ items, revoke, allToUser: state.allToUser })
      if (!response.ok) throw new Error(String(response.status))
      const { imported, skipped, failed, revoked, keptModified, revokeMissing } = await response.json() as {
        imported: number; skipped: number; failed: number; revoked: number; keptModified: number; revokeMissing: number
      }
      await reload()
      const kept = keptModified + revokeMissing
      setState({ phase: 'done', summary: t('importDone', { n: imported, s: skipped, f: failed, r: revoked }) + (kept > 0 ? ` ${t('importKeptNote', { k: kept })}` : '') })
    } catch {
      await reload()
      setState({ phase: 'applyFailed' })
    }
  }

  return <dialog ref={dialogRef} className="dam-dialog" aria-labelledby="dam-import-title" onCancel={event => {
    event.preventDefault()
    if (state.phase !== 'applying') onClose()
  }}>
    <header className="dam-dialog-head"><h2 id="dam-import-title">{t('importTitle')}</h2>
      <button type="button" className="dam-icon-btn" aria-label={t('cancel')} disabled={state.phase === 'applying'} onClick={onClose}><Icon name="close" /></button></header>
    <div className="dam-dialog-body">
      {state.phase === 'loading' && <p role="status">{t('loading')}</p>}
      {state.phase === 'empty' && <p>{t('importEmpty')}</p>}
      {state.phase === 'scanFailed' && <p role="alert">{t('importScanFailed')}</p>}
      {state.phase === 'applyFailed' && <p role="alert">{t('importRunFailed')}</p>}
      {state.phase === 'applying' && <p role="status">{t('importApplying')}</p>}
      {state.phase === 'done' && <p role="status">{state.summary}</p>}
      {state.phase === 'select' && <>
        <div className="dam-import-list">
          {state.projects.map(project => {
            const selectable = project.files.filter(canSelect)
            const allChecked = selectable.length > 0 && selectable.every(file => state.selected[fileKey(project.slug, file.file)] === true)
            const mixed = !allChecked && selectable.some(file => state.selected[fileKey(project.slug, file.file)] === true)
            return <section className="dam-import-group" key={project.slug}>
              <label className="dam-import-group-head">
                {selectable.length > 0 && <input className="dam-check" type="checkbox" checked={allChecked}
                  ref={el => { if (el) el.indeterminate = mixed }} onChange={event => {
                    const checked = event.target.checked
                    setState({ ...state, selected: { ...state.selected, ...Object.fromEntries(selectable.map(file => [fileKey(project.slug, file.file), checked])) } })
                  }} />}
                <span><strong>{project.slug}</strong><small>{project.targetScope === 'user' ? t('userScopeShort') : project.targetDir}</small></span>
              </label>
              {project.files.map(file => {
                const key = fileKey(project.slug, file.file)
                const statusLabel = file.state === 'imported' ? t('importStateImported') : file.state === 'legacy' ? t('importStateLegacy')
                  : file.state === 'modified' ? t('importStateModified') : file.state === 'conflict' ? t('importStateConflict') : undefined
                return <label className="dam-import-entry" key={key}>
                  <input type="checkbox" className="dam-check" disabled={!canSelect(file)} checked={state.selected[key] === true}
                    onChange={event => { setState({ ...state, selected: { ...state.selected, [key]: event.target.checked } }) }} />
                  <span><strong>{file.name}</strong><small>{file.description}</small></span>
                  {statusLabel && <span className="dam-note">{statusLabel}</span>}
                </label>
              })}
            </section>
          })}
        </div>
        <label className="dam-import-option"><input type="checkbox" className="dam-check" checked={state.allToUser}
          onChange={event => { setState({ ...state, allToUser: event.target.checked }) }} />{t('importAllToUser')}</label>
        <p className="dam-note">{t('importRevokeWarning')}</p>
      </>}
    </div>
    {state.phase !== 'applying' && <footer className="dam-dialog-actions">
      <button type="button" className="dam-btn" onClick={onClose}>{t(state.phase === 'done' ? 'doneAction' : 'cancel')}</button>
      {state.phase === 'select' && <button type="button" className="dam-btn dam-btn-primary" disabled={items.length + revoke.length === 0} onClick={() => { void run() }}>
        {t('importApplyCount', { n: items.length, r: revoke.length })}
      </button>}
    </footer>}
  </dialog>
}
