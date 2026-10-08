/**
 * 记忆匹配核心(0.7.0):固化候选 ↔ 现有记忆的同一性判定与动作决策。
 *
 * 单一事实源:L3 评测验证过的映射机制(name 锚定前缀容错 ∪ CJK bigram 词覆盖)
 * 从 evals runner 搬进产品代码——评测方法学反哺产品,同一段逻辑两处共用。
 *
 * 决策语义(更新替换,解 L3 暴露的两 bug):
 * - 同一事实的新版本 → **更新**(复用现有 name/scope,覆写内容,保留生命周期)
 * - 纯复述回声 → 更新(等价于去重刷新)
 * - 无匹配 → 新建
 */

import type { MemoryRecord } from './types.ts'

/** 分词:拉丁词 + CJK 字符二元组(bigram,检索标准做法)。 */
export function words(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(w => w.length > 0)
  const out = new Set<string>()
  for (const token of tokens) {
    if (/^[一-鿿]+$/.test(token)) {
      if (token.length === 1) out.add(token)
      else for (let i = 0; i + 1 < token.length; i++) out.add(token.slice(i, i + 2))
    } else {
      out.add(token)
    }
  }
  return out
}

/** 词匹配带前缀容错(≥5 字符前缀相等视为同词:alloc≈allocation)。 */
export function wordHit(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true
  return false
}

/**
 * name 锚定覆盖:金标侧 name 的词在产物侧 name 中的覆盖比例。
 * name 恒为英文 kebab,跨语言稳定;词序无关(ignore-err-x ≈ err-x-ignore)。
 */
export function nameCoverage(goldName: string, producedName: string): number {
  const g = goldName.split('-').filter(w => w.length > 1)
  if (g.length === 0) return 0
  const p = producedName.split('-').filter(w => w.length > 1)
  let hit = 0
  for (const w of g) if (p.some(x => wordHit(w, x))) hit += 1
  return hit / g.length
}

/** 描述词覆盖率:gold 侧要点词被 produced 包含的比例(有向)。 */
export function descriptionCoverage(goldDescription: string, producedDescription: string): number {
  const g = words(goldDescription)
  if (g.size === 0) return 0
  const p = words(producedDescription)
  let hit = 0
  for (const w of g) if (p.has(w)) hit += 1
  return hit / g.size
}

/** 描述相似度(Jaccard,双向;与旧 descriptionSimilarity 同算法,单一实现点)。 */
export function descriptionSimilarity(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let intersection = 0
  for (const w of wa) if (wb.has(w)) intersection += 1
  return intersection / (wa.size + wb.size - intersection)
}

/** 匹配阈值(冻结:调整须经 L3 评测对比,见 evals/README 反自嗨条款)。 */
export const MATCH = {
  /** name 锚定:≥0.6 视为同一记忆(实测:词序重排 100%、deploy 前缀对 50%) */
  NAME_COVERAGE: 0.6,
  /** 描述 Jaccard:≥0.7 视为复述(原查重线,保持) */
  DESCRIPTION_SIMILARITY: 0.7,
} as const

/** 候选与现有记忆的匹配强度评分(降序比较用)。 */
export interface MemoryMatch {
  existing: MemoryRecord
  score: number
  basis: 'exact-name' | 'name-coverage' | 'description-similarity'
}

/** 在现有记忆中找候选的最佳匹配;无匹配返回 null。 */
export function pickBestMatch(candidate: { name: string, description: string }, existingList: readonly MemoryRecord[]): MemoryMatch | null {
  let best: MemoryMatch | null = null
  for (const existing of existingList) {
    let score = 0
    let basis: MemoryMatch['basis'] = 'description-similarity'
    if (existing.name === candidate.name) {
      score = 1
      basis = 'exact-name'
    } else {
      const nc = nameCoverage(existing.name, candidate.name)
      if (nc >= MATCH.NAME_COVERAGE) {
        score = nc
        basis = 'name-coverage'
      } else {
        const sim = descriptionSimilarity(existing.description, candidate.description)
        if (sim >= MATCH.DESCRIPTION_SIMILARITY) {
          score = sim
          basis = 'description-similarity'
        }
      }
    }
    if (score > 0 && (best === null || score > best.score)) best = { existing, score, basis }
  }
  return best
}

/** 固化动作决策(纯函数):更新(复用现有身份)或新建。 */
export type ConsolidationAction =
  | { action: 'update'; target: MemoryRecord; basis: MemoryMatch['basis'] }
  | { action: 'create' }

export function decideConsolidationAction(candidate: { name: string, description: string }, existingList: readonly MemoryRecord[]): ConsolidationAction {
  const match = pickBestMatch(candidate, existingList)
  if (match === null) return { action: 'create' }
  return { action: 'update', target: match.existing, basis: match.basis }
}
