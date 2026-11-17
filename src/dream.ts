/**
 * 1.10.0「记忆沉淀」:dreaming 建议清单(只建议,绝不自动执行)。
 *
 * 借鉴(sage-mem 三级门控 + hermes copy-on-write 提案 + dsh-memory-hub
 * 近重复 merge 的 expected_version 思想,收敛为最小形态):
 * - 触发门控(最便宜先查):时间门(距上次运行 ≥24h,一次状态文件读)
 *   → 会话门(期间 ≥3 个会话结束,读同状态文件)→ 才发起分析;
 * - 分析:后台 LLM 调用(与固化同一条路由获取纪律)回读全库,输出结构化
 *   建议——合并重复 / 晋升置顶 / 退役停用 / 模式洞察,每条带理由;
 * - 落盘 proposals.json(原子写,含生成时间与库快照指纹);
 * - 应用:面板逐条确认后执行(merge 走 store.write + supersede 谱系;
 *   promote/retire 走 toggleFlag 语义)——**绝不自动提交**;
 * - 失败静默(与固化同纪律),提案文件损坏→当作无提案。
 */

import type { Context } from '@deepseek-ai/cordis'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { withLockRecovery, isExpired } from './store.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryRecord } from './types.ts'
import { descriptionSimilarity } from './matching.ts'

/** 提案文件名(记忆根目录下)。 */
export const PROPOSALS_FILENAME = 'proposals.json'

/** 提案状态文件(dreaming 门控的时间/会话计数;与提案分文件,提案可被清)。 */
const DREAM_STATE_FILENAME = 'dream-state.json'

/** 触发间隔(毫秒)与最小会话数。 */
const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000
const DREAM_MIN_SESSIONS = 3

/** 一条维护建议。 */
export interface Proposal {
  id: string
  kind: 'merge' | 'promote' | 'retire'
  /** merge:合并目标们(2-5 个 name);promote/retire:单条 name。 */
  targets: string[]
  /** 建议执行的动作预览(merge = 合并后的一句话摘要;其余 = 动作说明)。 */
  summary: string
  /** 为什么(给用户看的理由,LLM 生成)。 */
  reason: string
}

/** 提案文件形状。 */
export interface ProposalsFile {
  generatedAt: number
  /** 库快照指纹(记忆 name 集合的稳定哈希;库变化后提案视为过期)。 */
  fingerprint: string
  proposals: Proposal[]
}

/** 读提案(损坏/缺失 → null,调用方当无提案处理)。 */
export async function loadProposals(rootDir: string): Promise<ProposalsFile | null> {
  let raw: string
  try {
    raw = await fsp.readFile(join(rootDir, PROPOSALS_FILENAME), 'utf8')
  } catch { return null }
  try {
    const parsed = JSON.parse(raw) as Partial<ProposalsFile>
    if (typeof parsed.generatedAt !== 'number' || !Array.isArray(parsed.proposals) || typeof parsed.fingerprint !== 'string') return null
    const proposals: Proposal[] = []
    for (const p of parsed.proposals) {
      if (p === null || typeof p !== 'object') continue
      const item = p as Partial<Proposal>
      if (typeof item.id !== 'string' || typeof item.kind !== 'string' || !Array.isArray(item.targets)) continue
      if (item.kind !== 'merge' && item.kind !== 'promote' && item.kind !== 'retire') continue
      if (!item.targets.every((t): t is string => typeof t === 'string')) continue
      if (typeof item.summary !== 'string' || typeof item.reason !== 'string') continue
      proposals.push({ id: item.id, kind: item.kind, targets: item.targets, summary: item.summary.slice(0, 160), reason: item.reason.slice(0, 400) })
    }
    return { generatedAt: parsed.generatedAt, fingerprint: parsed.fingerprint, proposals }
  } catch { return null }
}

/** 库指纹:name 集合排序后的稳定字符串(库变化提案即过期,不误导)。 */
export function libraryFingerprint(records: Array<Pick<MemoryRecord, 'name'>>): string {
  return records.map(r => r.name).sort().join(',')
}

/** 组装 dreaming 分析 prompt(全库回读,一次 LLM 调用)。 */
export function buildDreamPrompt(records: Array<Pick<MemoryRecord, 'name' | 'description' | 'type' | 'reads'> & { status?: MemoryRecord['status'] }>): string {
  const lines = records
    .filter(r => r.status === undefined || r.status === 'candidate' || r.status === 'verified')
    .map(r => `- ${r.name} [${r.type}] reads:${String(r.reads ?? 0)} — ${r.description}`)
    .join('\n')
  return `You are reviewing a memory library for maintenance. Below is every active memory (name, type, read count, one-line description).

Find consolidation opportunities. Output ONLY a JSON array (possibly empty), each element exactly one of:
{"kind":"merge","targets":["name-a","name-b"],"summary":"one merged line <=120 chars","reason":"why these belong together"}
{"kind":"promote","targets":["name"],"summary":"suggest pinning","reason":"why this is a durable anchor"}
{"kind":"retire","targets":["name"],"summary":"suggest muting","reason":"why this is obsolete/noise"}

Rules:
- merge only same-topic memories (2-5 targets, all of the same type); never merge across user/project types.
- retire only clearly obsolete items (zero reads AND superseded in substance by another entry) — be conservative.
- promote only when the user explicitly relies on it (high reads AND identity/anchor-like).
- At most 8 proposals total. If nothing is worth proposing, output [].

<memories>
${lines}
</memories>`
}

/** 解析 LLM 输出为提案(容错:截首尾 [],逐项校验)。 */
export function parseProposals(raw: string, fingerprint: string): Proposal[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    const out: Proposal[] = []
    for (const item of parsed.slice(0, 8)) {
      if (item === null || typeof item !== 'object') continue
      const p = item as Record<string, unknown>
      const kind = p.kind
      if (kind !== 'merge' && kind !== 'promote' && kind !== 'retire') continue
      const targets = Array.isArray(p.targets) ? [...new Set(p.targets.filter((t): t is string => typeof t === 'string' && t.length > 0))].slice(0, 5) : []
      if (targets.length === 0) continue
      if (kind === 'merge' && targets.length < 2) continue
      out.push({
        id: `p${String(out.length)}-${String(fingerprint.length)}${String(out.length * 7)}`,
        kind, targets,
        summary: String(p.summary ?? '').slice(0, 160),
        reason: String(p.reason ?? '').slice(0, 400),
      })
    }
    return out
  } catch { return [] }
}

/** 去重噪声:描述相似度 ≥0.9 的对子直接降级为 merge 候选(不依赖 LLM 的确定性建议)。 */
export function deterministicMergeCandidates(records: Array<Pick<MemoryRecord, 'name' | 'description'>>, perGroupLimit = 200): Array<{ a: string, b: string, score: number }> {
  const out: Array<{ a: string, b: string, score: number }> = []
  for (let i = 0; i < records.length && i < perGroupLimit; i++) {
    for (let j = i + 1; j < records.length && j < perGroupLimit; j++) {
      const score = descriptionSimilarity(records[i]!.description, records[j]!.description)
      if (score >= 0.9) out.push({ a: records[i]!.name, b: records[j]!.name, score })
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 8)
}

/** 门控状态读写(单文件 JSON;损坏→重置)。 */
interface DreamState { lastRun: number, sessionsEnded: number }
async function readState(rootDir: string): Promise<DreamState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(join(rootDir, DREAM_STATE_FILENAME), 'utf8')) as Partial<DreamState>
    return { lastRun: typeof parsed.lastRun === 'number' ? parsed.lastRun : 0, sessionsEnded: typeof parsed.sessionsEnded === 'number' ? parsed.sessionsEnded : 0 }
  } catch { return { lastRun: 0, sessionsEnded: 0 } }
}
async function writeState(rootDir: string, state: DreamState): Promise<void> {
  await writeFileAtomic(join(rootDir, DREAM_STATE_FILENAME), `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

/**
 * 挂载 dreaming(在 index.ts 的 session/disposed 处调用 noteSessionEnded;
 * agent 路由可得时在 agent/disposed 后尝试触发分析)。
 */
export function registerDreaming(ctx: Context, store: MemoryStore, rootDir: string, enabled: () => boolean): { noteSessionEnded: () => void; tryRun: (getRoute: () => { provider: string, model: string } | undefined) => void; flush: () => Promise<void> } {
  let running: Promise<void> | null = null
  let pendingRoute: { provider: string, model: string } | undefined
  return {
    noteSessionEnded: () => {
      if (!enabled()) return
      void (async () => {
        const state = await readState(rootDir)
        await writeState(rootDir, { ...state, sessionsEnded: state.sessionsEnded + 1 })
      })().catch(() => {})
    },
    tryRun: getRoute => {
      if (!enabled()) return
      pendingRoute = getRoute() ?? pendingRoute
      if (running !== null) return
      running = (async () => {
        try {
          const state = await readState(rootDir)
          const now = Date.now()
          if (now - state.lastRun < DREAM_INTERVAL_MS) return
          if (state.sessionsEnded < DREAM_MIN_SESSIONS) return
          const route = pendingRoute
          if (route === undefined) return
          const llm = ctx.get('llm')
          if (llm === undefined) return
          const all = await store.listAll()
          if (all.length < 8) return // 库太小没有沉淀价值
          // 只对"当前在注入视图里"的记忆提建议(审查 minor 修复:superseded/
          // disabled 进建议会产生合并进隐藏记录/改写谱系/promote 无感失效)
          const nowMs = Date.now()
          const active = all.filter(r => r.disabled !== true
            && r.status !== 'disputed' && r.status !== 'superseded'
            && !isExpired(r, nowMs))
          if (active.length < 4) { await writeState(rootDir, { lastRun: nowMs, sessionsEnded: 0 }); return }
          const fingerprint = libraryFingerprint(active)
          // LLM 建议与确定性近重复建议合并(LLM 缺席时确定性建议仍可用)
          const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
          const prompt = buildDreamPrompt(active)
          const assembler = new BlockAssembler()
          for await (const chunk of llm.stream({
            provider: route.provider, model: route.model,
            messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'dsh-auto-memory' } })],
            maxTokens: 2048,
          })) assembler.push(chunk)
          const finish = assembler.finish
          if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') return
          const text = assembler.blocks().filter((b): b is { type: 'text', text: string } => b.type === 'text').map(b => b.text).join('\n')
          let proposals = parseProposals(text, fingerprint)
          // 确定性近重复补充(未与 LLM 建议重叠的)
          const llmPairs = new Set(proposals.flatMap(p => p.targets))
          for (const pair of deterministicMergeCandidates(active)) {
            if (proposals.length >= 8) break
            if (llmPairs.has(pair.a) || llmPairs.has(pair.b)) continue
            proposals.push({
              id: `d${String(proposals.length)}-${pair.a}`,
              kind: 'merge', targets: [pair.a, pair.b],
              summary: `${pair.a} + ${pair.b}`,
              reason: `descriptions are ${Math.round(pair.score * 100)}% identical (deterministic near-duplicate check)`,
            })
          }
          proposals = proposals.slice(0, 8)
          await withLockRecovery(join(rootDir, PROPOSALS_FILENAME), async () => {
            await fsp.mkdir(rootDir, { recursive: true })
            await writeFileAtomic(join(rootDir, PROPOSALS_FILENAME), `${JSON.stringify({ generatedAt: now, fingerprint, proposals } satisfies ProposalsFile, null, 2)}\n`, { mode: 0o600 })
          })
          await writeState(rootDir, { lastRun: now, sessionsEnded: 0 })
          if (proposals.length > 0) ctx.logger.info(`[dsh-auto-memory] dreaming: ${String(proposals.length)} proposal(s) ready`)
        } catch { /* 静默: dreaming 绝不影响任何主路径 */ }
        finally { running = null }
      })()
    },
    flush: () => running ?? Promise.resolve(),
  }
}
