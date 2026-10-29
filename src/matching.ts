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

/** 在现有记忆中找候选的最佳匹配;无匹配返回 null。
 * #19:superseded 记忆不参与匹配——被取代的旧文件若被 update-in-place,
 * 新内容会写进永不注入的文件,与真正的新记忆分叉(演化谱系的必改配套)。 */
export function pickBestMatch(candidate: { name: string, description: string }, existingList: readonly MemoryRecord[]): MemoryMatch | null {
  let best: MemoryMatch | null = null
  for (const existing of existingList) {
    if (existing.status === 'superseded') continue
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

/** #19 矛盾信号:词集差集上的结构化分歧(日期/同单位数值/枚举翻转)。 */
export interface ContradictionSignal {
  kind: 'date' | 'number' | 'enum'
  /** 人可读证据(如 "2026-09-01 vs 2026-10-15")。 */
  evidence: string
}

/** 日期提取:ISO 与常见简写(YYYY/MM、YYYY年M月),返回归一化 YYYY-MM。 */
function extractDates(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/\b(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2}))?/g)) {
    const year = match[1]!
    const month = String(match[2]).padStart(2, '0')
    out.push(match[3] !== undefined ? `${year}-${month}-${String(match[3]).padStart(2, '0')}` : `${year}-${month}`)
  }
  return out
}

/** 数值提取:带单位上下文的数字(同单位不同值才算矛盾)。 */
function extractNumbers(text: string): Array<{ value: string; unit: string }> {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(%|GB|KB|MB|天|次|个|小时|分钟|秒|[vV]\d+)/g)]
    .map(match => ({ value: match[1]!, unit: match[2]!.toLowerCase() }))
}

/**
 * #19 矛盾检测(纯函数,旁路——不动 MATCH 冻结阈值与 decideConsolidationAction):
 * 在"同一性已确立"(update 基率=同一事实的新版本)的前提下,对双方
 * description+body 的词集差集做三类结构化分歧判定。纪律(对齐
 * DIRECTIVE_PATTERNS 的 40% 误报教训):**只有强信号(日期集不相交/
 * 同单位数值不同)才判矛盾**;枚举翻转词仅作辅助信号单独返回、不单独触发
 * supersede(调用方决定合并策略)。
 */
export function detectContradictions(
  a: { description: string, body: string },
  b: { description: string, body: string },
): ContradictionSignal[] {
  const textA = `${a.description}\n${a.body}`
  const textB = `${b.description}\n${b.body}`
  const signals: ContradictionSignal[] = []
  // 日期:两侧都有日期且集合不相交 → 强信号(有交集=时间演进的中性描述)
  const datesA = extractDates(textA)
  const datesB = extractDates(textB)
  if (datesA.length > 0 && datesB.length > 0) {
    const shared = datesA.some(d => datesB.includes(d))
    if (!shared) signals.push({ kind: 'date', evidence: `${datesA.join('/')} vs ${datesB.join('/')}` })
  }
  // 数值:同单位且值不同 → 强信号(精确比对,排除单位相同值也相同的正常复述)
  const numsA = extractNumbers(textA)
  const numsB = extractNumbers(textB)
  for (const na of numsA) {
    const sameUnit = numsB.find(nb => nb.unit === na.unit && nb.value !== na.value)
    if (sameUnit !== undefined) {
      signals.push({ kind: 'number', evidence: `${na.value}${na.unit} vs ${sameUnit.value}${sameUnit.unit}` })
      break
    }
  }
  return signals
}
