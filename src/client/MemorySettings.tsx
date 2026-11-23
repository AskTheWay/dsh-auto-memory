import { useState, type ReactNode } from 'react'
import { DEFAULT_MAX_BYTES } from '../budget.ts'
import type { MemoryFace } from './index.ts'
import { formatBytes, type SettingsView, type Translate } from './panel-model.tsx'

const fields = {
  maxBytes: { label: 'setMaxBytes', hint: 'setMaxBytesHint', min: 1024, max: 65_536, step: 512 },
  staleAfterDays: { label: 'setStaleDays', hint: 'setStaleDaysHint', min: 0, max: 3650, step: 1 },
  minImportance: { label: 'setMinImportance', hint: 'setMinImportanceHint', min: 0, max: 10, step: 1 },
  autoSummarizeMaxMemories: { label: 'setAutoSummarizeMax', hint: 'settingsMaxHint', min: 1, max: 20, step: 1 },
} as const

const presets = [
  { label: 'presetFocus', maxBytes: 4096, minImportance: 4 },
  { label: 'presetBalanced', maxBytes: DEFAULT_MAX_BYTES, minImportance: 4 },
  { label: 'presetCompanion', maxBytes: 32_768, minImportance: 1 },
] as const

type SettingsProps = {
  t: Translate
  settings: SettingsView
  busy: boolean
  configSet: MemoryFace['configSet']
  act: (request: () => Promise<Response>, failure?: string) => Promise<boolean>
}

export function MemorySettings({ t, settings, busy, configSet, act }: SettingsProps): ReactNode {
  const [draft, setDraft] = useState<Record<string, number | boolean>>({})
  const [saved, setSaved] = useState(false)
  const value = (key: string): number | boolean | undefined => draft[key] ?? settings.effective[key]
  const dirty = Object.fromEntries(Object.entries(draft).filter(([key, next]) => next !== settings.effective[key]))
  const hasChanges = Object.keys(dirty).length > 0

  const update = (change: Record<string, number | boolean>): void => {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...change }))
  }

  const reset = (key: string): void => {
    setSaved(false)
    void act(() => configSet({ [key]: null }), t('setSaveFailed')).then(success => {
      if (!success) return
      setDraft(previous => Object.fromEntries(Object.entries(previous).filter(([field]) => field !== key)))
      setSaved(true)
    })
  }

  const source = (key: string, name: string): ReactNode => <div className="dam-setting-source">
    <span>{t(settings.sources[key] === 'override' ? 'overrideValue' : 'defaultProfile')}</span>
    {settings.sources[key] === 'override' && <button type="button" className="dam-text-action" disabled={busy} onClick={() => { reset(key) }}>{t('resetSetting', { name })}</button>}
  </div>

  const numeric = (key: keyof typeof fields): ReactNode => {
    if (settings.effective[key] === undefined) return null
    const field = fields[key]
    const current = Number(value(key))
    const output = key === 'maxBytes' ? formatBytes(current)
      : key === 'staleAfterDays' ? current === 0 ? t('settingOff') : t('settingDays', { n: current })
        : key === 'minImportance' && current === 0 ? t('settingOff') : current
    return <div className="dam-setting-row">
      <div className="dam-setting-copy"><label htmlFor={`dam-setting-${key}`}>{t(field.label)}</label><p id={`dam-setting-note-${key}`} className="dam-note">{t(field.hint)}</p></div>
      <div className="dam-setting-field">
        <div className="dam-range"><input type="range" id={`dam-setting-${key}`} name={key} aria-describedby={`dam-setting-note-${key}`}
          min={field.min} max={field.max} step={field.step} value={current} disabled={busy}
          onChange={event => { update({ [key]: Number(event.target.value) }) }} />
          <output htmlFor={`dam-setting-${key}`}>{output}</output></div>
        {source(key, t(field.label))}
      </div>
    </div>
  }

  return <form className="dam-settings-form" onSubmit={event => {
    event.preventDefault()
    if (!hasChanges || busy) return
    setSaved(false)
    void act(() => configSet(dirty), t('setSaveFailed')).then(success => {
      if (success) { setDraft({}); setSaved(true) }
    })
  }}>
    <section className="dam-surface">
      <header className="dam-section-head"><h2>{t('settingsBudget')}</h2></header>
      <div className="dam-preset-group" role="group" aria-label={t('presetLabel')}>
        {presets.map(preset => {
          const selected = value('maxBytes') === preset.maxBytes && value('minImportance') === preset.minImportance
          return <button key={preset.label} type="button" className="dam-preset" aria-pressed={selected} disabled={busy}
            onClick={() => { update({ maxBytes: preset.maxBytes, minImportance: preset.minImportance }) }}><span>{t(preset.label)}</span><span>{formatBytes(preset.maxBytes)}</span></button>
        })}
      </div>
      {numeric('maxBytes')}
      {numeric('staleAfterDays')}
    </section>
    <section className="dam-surface">
      <header className="dam-section-head"><h2>{t('settingsConsolidation')}</h2></header>
      <div className="dam-setting-row">
        <div className="dam-setting-copy"><label htmlFor="dam-setting-autoSummarize">{t('setAutoSummarize')}</label><p className="dam-note" id="dam-auto-hint">{t('settingsAutoHint')}</p></div>
        <div className="dam-setting-field">
          <input id="dam-setting-autoSummarize" name="autoSummarize" className="dam-check" type="checkbox" role="switch" checked={value('autoSummarize') === true} disabled={busy}
            aria-describedby="dam-auto-hint" onChange={event => { update({ autoSummarize: event.target.checked }) }} />
          {source('autoSummarize', t('setAutoSummarize'))}
        </div>
      </div>
      {numeric('minImportance')}
      {numeric('autoSummarizeMaxMemories')}
    </section>
    <div className="dam-settings-actions">
      <button type="submit" className="dam-btn dam-btn-primary" disabled={busy || !hasChanges}>{t('setSave')}</button>
      {hasChanges && <span className="dam-note dam-settings-draft">{t('settingsDraft')}</span>}
      {saved && <span className="dam-note" role="status">{t('setSaved')}</span>}
    </div>
  </form>
}
