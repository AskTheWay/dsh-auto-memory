import { descriptionCoverage, words } from './matching.ts'
import { isExpired } from './store.ts'
import type { MemoryRecord, MemoryScope, MemoryStatus } from './types.ts'

type RecallRecord = Pick<MemoryRecord, 'status' | 'disabled' | 'validUntil' | 'supersededBy'>

export interface RecallState {
  status?: MemoryStatus
  disabled?: boolean
  expired?: boolean
  supersededBy?: string
}

/** 保留历史条目的可查性，给摘要、正文和链接提供同一套状态。 */
export function recallState(record: RecallRecord, now: number): RecallState {
  return {
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(isExpired(record, now) ? { expired: true } : {}),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
  }
}

export function recallNotes(state: RecallState): string {
  const notes: string[] = []
  if (state.status === 'candidate') notes.push('CANDIDATE (unverified)')
  if (state.status === 'verified') notes.push('VERIFIED')
  if (state.status === 'disputed') notes.push('DISPUTED (confirm before relying on it)')
  if (state.status === 'superseded' || state.supersededBy !== undefined) {
    const successor = state.supersededBy === undefined ? '' : ` by ${JSON.stringify(state.supersededBy)}`
    notes.push(`SUPERSEDED${successor} (historical)`)
  }
  if (state.expired === true) notes.push('EXPIRED (historical; re-confirm before relying on it)')
  if (state.disabled === true) notes.push('DISABLED (excluded from automatic injection)')
  return notes.length === 0 ? '' : ` [${notes.join(' | ')}]`
}

const EXCERPT_LIMIT = 120
const EXCERPT_WINDOW = EXCERPT_LIMIT - 2 // 留两个位置给首尾省略号

/** 在固定长度的正文窗口内最大化不同查询词的覆盖，采用与检索一致的中文二元组。 */
function matchingExcerpt(body: string, queryWords: ReadonlySet<string>, fallback: string, literal?: string): string {
  const compact = (body.trim() || fallback).replace(/\s+/g, ' ').trim()
  if (compact.length <= EXCERPT_LIMIT) return compact

  const hits: { term: string; start: number; end: number }[] = []
  for (const match of compact.matchAll(/[a-z0-9一-鿿]+/gi)) {
    const term = match[0].toLowerCase()
    if (term.length > 1 && /^[一-鿿]+$/.test(term)) {
      for (let i = 0; i + 1 < term.length; i++) {
        const bigram = term.slice(i, i + 2)
        if (queryWords.has(bigram)) hits.push({ term: bigram, start: match.index + i, end: match.index + i + 2 })
      }
    } else if (term.length <= EXCERPT_WINDOW && queryWords.has(term)) {
      hits.push({ term, start: match.index, end: match.index + term.length })
    }
  }

  const counts = new Map<string, number>()
  let left = 0
  let bestCount = 0
  let start = 0
  for (const hit of hits) {
    counts.set(hit.term, (counts.get(hit.term) ?? 0) + 1)
    while (hit.end - hits[left]!.start > EXCERPT_WINDOW) {
      const term = hits[left++]!.term
      const count = counts.get(term)!
      if (count === 1) counts.delete(term)
      else counts.set(term, count - 1)
    }
    if (counts.size <= bestCount) continue
    bestCount = counts.size
    start = Math.max(0, hit.end - EXCERPT_WINDOW, Math.min(hits[left]!.start - 20, compact.length - EXCERPT_WINDOW))
  }
  const literalStart = literal === undefined ? -1 : compact.toLowerCase().indexOf(literal)
  if (literalStart >= 0) start = Math.max(0, Math.min(literalStart - 20, compact.length - EXCERPT_WINDOW))
  const end = start + EXCERPT_WINDOW
  const excerpt = compact.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '').trim()
  return `${start > 0 ? '…' : ''}${excerpt}${end < compact.length ? '…' : ''}`
}

export const LIBRARY_QUERY_LIMIT = 256

export interface LibrarySearchHit {
  name: string
  scope: MemoryScope
  slug: string
  field: 'body' | 'keywords'
  excerpt: string
}

/** 面板按完整短语或所有词匹配正文；短语也可命中代码标识符的一部分。 */
export function searchLibrary(records: readonly MemoryRecord[], query: string, slug: string): LibrarySearchHit[] {
  const phrase = query.trim().replace(/\s+/g, ' ').toLowerCase()
  if (phrase.length === 0) return []
  const terms = words(phrase)
  const matches = (text: string): boolean => {
    if (text.replace(/\s+/g, ' ').toLowerCase().includes(phrase)) return true
    const tokens = words(text)
    return terms.size > 0 && [...terms].every(term => tokens.has(term))
  }
  return records.flatMap(record => {
    const keywords = record.keywords?.join(', ') ?? ''
    const field = matches(record.body) ? 'body' : matches(keywords) ? 'keywords' : null
    if (field === null) return []
    const excerpt = matchingExcerpt(field === 'body' ? record.body : keywords, terms, '', phrase)
    return [{ name: record.name, scope: record.scope, slug, field, excerpt }]
  })
}

/** 只为最终返回的 8 条生成正文摘要。排序继续沿用有向词覆盖。 */
export function searchRecall(records: readonly MemoryRecord[], query: string, now: number) {
  const queryWords = words(query)
  return records
    .map(record => ({ record, score: descriptionCoverage(query, `${record.name}\n${record.title ?? ''}\n${record.description}\n${record.body}\n${record.keywords?.join(' ') ?? ''}`) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name))
    .slice(0, 8)
    .map(({ record, score }) => ({
      name: record.name, description: record.description, type: record.type, scope: record.scope,
      score, excerpt: matchingExcerpt(record.body, queryWords, record.description), ...recallState(record, now),
    }))
}
