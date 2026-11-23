import type { ReactNode } from 'react'
import type { PluginMemoryLocaleKey } from './locales.ts'
import type { ConsolidationRun } from '../audit.ts'
import type { InjectionItem } from '../prompt.ts'

export type Translate = (key: PluginMemoryLocaleKey, params?: Record<string, string | number>) => string

export interface PanelMemory {
  name: string
  title?: string
  description: string
  type: string
  pinned: boolean
  disabled: boolean
  stale: boolean
  indexed?: boolean
  expired: boolean
  aging: boolean
  validUntilMs?: number
  status?: string
  supersededBy?: string
  supersedes?: string
  evidence?: { sessionId: string; quote: string }
  createdMs?: number
  reads: number
  updatedMs?: number
  bytes: number
  importedFrom?: 'claude-code'
}

export interface PanelGroup {
  key: string
  scope: string
  slug: string
  current?: boolean
  memories: PanelMemory[]
  indexBytes: number
  indexText?: string | null
}

export interface MemoryTarget {
  name: string
  scope: string
  slug?: string
}

export interface PanelEntry {
  group: PanelGroup
  memory: PanelMemory
}

export interface HealthReport {
  unverified: Array<MemoryTarget & { hasEvidence: boolean }>
  zombies: Array<MemoryTarget & { ageDays: number }>
  conflicts: Array<{ kind: 'cross-scope' | 'near-duplicate'; a: MemoryTarget; b: MemoryTarget }>
  expired: Array<MemoryTarget & { expiredDays: number }>
  deadLinks: Array<{ from: string; scope: string; slug: string; target: string }>
}

export interface SettingsView {
  effective: Record<string, number | boolean>
  overrides: Record<string, number | boolean>
  sources: Record<string, string>
}

export interface AuditEntry {
  ts: number
  sessionId: string
  cwd: string
  count: number
  bytes: number
  truncated: number
  injected?: string[]
  truncatedNames?: string[]
  items?: InjectionItem[]
  projectSlug?: string
  budget?: number
  frozen?: boolean
}

export interface ProjectAudit {
  cwd: string
  sessions: number
  injections: number
  avgBytes: number
  memories: number
  truncated: number
  lastTs: number
}

export interface AuditStats {
  sessions: number
  injections: number
  avgBytes?: number
  memories: Array<{ name: string; injectedCount: number; truncatedCount?: number; lastTs: number }>
  scopedMemories?: Array<{ name: string; scope: 'user' | 'project' | 'unknown'; slug?: string; injectedCount: number; truncatedCount: number }>
  projects?: ProjectAudit[]
  timeline: AuditEntry[]
  projectSlug?: string | null
  workspaces?: string[]
  consolidation?: ConsolidationRun | null
  consolidationEnabled?: boolean
}

export const memoryTypes = {
  user: 'kindUser', feedback: 'kindFeedback', project: 'kindProject', reference: 'kindReference',
} as const satisfies Record<string, PluginMemoryLocaleKey>

export const memoryStatuses = {
  candidate: 'statusCandidate', verified: 'statusVerified', disputed: 'statusDisputed',
  superseded: 'statusSuperseded', expired: 'expiredBadge', disabled: 'mutedShort',
  stale: 'staleShort', active: 'activeState',
} as const satisfies Record<string, PluginMemoryLocaleKey>

export function memoryTypeLabel(type: string, t: Translate): string {
  const label = Object.hasOwn(memoryTypes, type) ? memoryTypes[type as keyof typeof memoryTypes] : undefined
  return label === undefined ? type : t(label)
}

export function memoryStatus(memory: PanelMemory): keyof typeof memoryStatuses {
  if (memory.status === 'disputed' || memory.status === 'superseded') return memory.status
  if (memory.disabled) return 'disabled'
  if (memory.expired) return 'expired'
  if (memory.stale) return 'stale'
  if (memory.status === 'candidate' || memory.status === 'verified') return memory.status
  return 'active'
}

export function matchesStatus(memory: PanelMemory, status: string): boolean {
  if (status === 'disabled' || status === 'expired' || status === 'stale') return memory[status]
  return status === 'all' || memory.status === status || memoryStatus(memory) === status
}

export function MemoryStatus({ memory, t, includeTrust }: { memory: PanelMemory; t: Translate; includeTrust?: boolean }): ReactNode {
  const primary = memoryStatus(memory)
  const trust = memory.status === 'candidate' || memory.status === 'verified' ? memory.status : null
  const states: Array<keyof typeof memoryStatuses> = includeTrust && trust !== null && trust !== primary ? [primary, trust] : [primary]
  return states.map(state => <span key={state} className="dam-state" data-state={state}>{t(memoryStatuses[state])}</span>)
}

/** 标识由作用域目录与文件名共同决定，避免同名记录串到另一个工作区。 */
export function entryKey(group: PanelGroup, name: string): string {
  return encodeURIComponent(JSON.stringify([group.key, name]))
}

export function entryTitle(memory: PanelMemory): string {
  return memory.title?.trim() || memory.name
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function workspaceName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

export function groupName(group: PanelGroup, cwd: string | undefined, t: Translate): string {
  if (group.scope === 'user') return t('userScopeShort')
  if (group.current && cwd) return workspaceName(cwd)
  const label = group.slug.replace(/^--|--$/g, '')
  return label.length > 40 ? `…${label.slice(-39)}` : label
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

const icons = {
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16'],
  upload: ['M12 21V9', 'm7 14 5-5 5 5', 'M4 3h16'],
  chevron: ['m9 6 6 6-6 6'],
  back: ['M20 12H4', 'm11 5-7 7 7 7'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
  pin: ['M12 17v5', 'M9 3h6l-1 7 2 4H8l2-4-1-7Z'],
  check: ['m5 12 4 4L19 6'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'],
} as const

export function Icon({ name, size = 16 }: { name: keyof typeof icons; size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {icons[name].map(path => <path key={path} d={path} />)}
  </svg>
}
