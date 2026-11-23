/**
 * 0.9.0:注入审计日志(issue #11)——记录"哪个会话、何时、注入了哪些记忆"。
 *
 * 动机:注入是 system prompt 组装期的纯函数读,此前不留痕迹——无法回答
 * "这条记忆到底有没有在起作用""预算截断丢掉了谁"。审计把注入从黑盒变成
 * 可回放事实,是"可审计的轻量记忆"定位的收口(计数→审计→可视化闭环)。
 *
 * 数据流:systemPrompt.section 的 text 回调(每步求值)→ 按会话对注入集合
 * 去重(集合签名不变不记)→ fs.appendFile 追加一行 JSONL 到
 * $DSH_HOME/memory/audit.jsonl。
 *
 * 纪律:
 * - **绝不阻塞注入路径**:text 回调是同步的,审计 fire-and-forget;
 *   追加失败一律静默(ctx 级 logger 都不进——审计自身绝不能产生噪声);
 * - **审计文件不进记忆索引、不占注入预算**,与 store 的记忆文件完全隔离
 *   (它不是记忆,不适用"写必须走 store 锁"的硬约束——那是为记忆一致性
 *   设计的;审计是 append-only 事实流水,单行 < 数 KB,fs.appendFile 的
 *   O_APPEND 语义在 Windows/POSIX 下对小行追加是事实原子);
 * - 会话离开时清去重 Map(与 index.ts 的 refreshed 同款生命周期);
 * - 读取侧容错:坏行跳过(手改/损坏),绝不让统计 API 500。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { MemoryStore } from './store.ts'
import { projectKey, withLockRecovery } from './store.ts'
import type { Config } from './index.ts'
import { memoryNameFromIndexLine, renderMemoryIndexDetail, type InjectionItem } from './prompt.ts'
import { USER_SCOPE_DIR } from './types.ts'

/** 审计文件名(记忆根目录下,与 _user/--proj-- 目录平级)。 */
export const AUDIT_FILENAME = 'audit.jsonl'

/**
 * 追加一行审计。写纪律(对齐官方 dsh-session-persistence-jsonl 的调研结论,
 * 官方无裸 appendFile 先例):
 * - **跨进程锁**:CLI 与桌面端可能共享同一记忆库并发追加,withFileLock 串行化
 *   (withLockRecovery 带孤儿锁自愈,与 store 共用同一实现);
 * - **进程内串行**:promise 链(等价官方 JsonlSessionHandle 的 chain),单行
 *   一次写入,规避同进程交错;
 * - **失败静默且不断链**:每次追加从上一个已 settle 的状态接续,审计失败
 *   绝不影响注入,也不会毒化后续追加。
 */
let auditChain: Promise<void> = Promise.resolve()

/** 审计文件上限(超限保留尾部一半,锁内 rotation;常态年增长 MB 级,1MB 上限够数年)。 */
const AUDIT_MAX_BYTES = 1_048_576

export function appendAudit(rootDir: string, entry: AuditEntry | ConsolidationRun): Promise<void> {
  const file = join(rootDir, AUDIT_FILENAME)
  auditChain = auditChain.then(async () => {
    await fsp.mkdir(rootDir, { recursive: true })
    await withLockRecovery(file, async () => {
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      // 超上限时在同一把锁内保留最近的完整行，按 UTF-8 字节计量。
      const size = await fsp.stat(file).then(s => s.size).catch(() => 0)
      if (size > AUDIT_MAX_BYTES) {
        const raw = await fsp.readFile(file, 'utf8').catch(() => null)
        if (raw !== null) {
          const lines = raw.split('\n').filter(line => line.length > 0)
          const keptLines: string[] = []
          let keptBytes = 0
          for (const line of lines.toReversed()) { // 从尾保完整行,凑够一半预算即停
            if (keptBytes > AUDIT_MAX_BYTES / 2) break
            keptLines.push(line)
            keptBytes += Buffer.byteLength(line, 'utf8') + 1
          }
          await writeFileAtomic(file, `${keptLines.reverse().join('\n')}\n`, { mode: 0o600 })
        }
      }
    })
  }).catch(() => { /* 静默:审计绝不影响注入 */ })
  return auditChain
}

/** 一条注入审计记录。 */
export interface AuditEntry {
  /** 注入发生时刻(epoch ms)。 */
  ts: number
  /** 注入目标会话。 */
  sessionId: string
  /** 会话工作区(项目层定位键)。 */
  cwd: string
  /** 实际注入的记忆 name 列表(截断后保留的)。 */
  injected: string[]
  /** 因预算截断被挤出注入的 name 列表(未截断为空)。 */
  truncated: string[]
  /** 注入段总字节(索引+指导+协议壳,即该会话为此付出的 prompt 成本)。 */
  bytes: number
  /** 新记录携带真实作用域。历史记录缺失时只按名称展示。 */
  items?: InjectionItem[]
  budget?: number
  frozen?: boolean
}

export const CONSOLIDATION_OUTCOMES = ['completed', 'no-transcript', 'no-route', 'unavailable', 'truncated', 'invalid-output', 'aborted', 'failed'] as const

export interface ConsolidationRun {
  kind: 'consolidation'
  ts: number
  cwd: string
  sessionId: string
  outcome: typeof CONSOLIDATION_OUTCOMES[number]
  candidates: number
  written: number
}

function isAuditTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000
}

/** 读取全部审计条目(坏行跳过——对齐官方 jsonl 崩溃恢复语义:丢弃不完整尾行;文件不存在返回空)。 */
export async function readAudit(rootDir: string): Promise<AuditEntry[]> {
  return (await readAuditLog(rootDir)).injections
}

export async function readAuditLog(rootDir: string): Promise<{ injections: AuditEntry[]; consolidation: ConsolidationRun[] }> {
  let raw: string
  try {
    raw = await fsp.readFile(join(rootDir, AUDIT_FILENAME), 'utf8')
  } catch {
    return { injections: [], consolidation: [] }
  }
  const entries: AuditEntry[] = []
  const consolidation: ConsolidationRun[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<AuditEntry>
      const run = parsed as Partial<ConsolidationRun>
      if (run.kind === 'consolidation') {
        if (isAuditTime(run.ts) && typeof run.cwd === 'string' && typeof run.sessionId === 'string'
          && run.outcome !== undefined && CONSOLIDATION_OUTCOMES.includes(run.outcome)
          && typeof run.candidates === 'number' && Number.isSafeInteger(run.candidates) && run.candidates >= 0
          && typeof run.written === 'number' && Number.isSafeInteger(run.written) && run.written >= 0 && run.written <= run.candidates) {
          consolidation.push({ kind: run.kind, ts: run.ts, cwd: run.cwd, sessionId: run.sessionId,
            outcome: run.outcome, candidates: run.candidates, written: run.written })
        }
        continue
      }
      if (isAuditTime(parsed.ts) && typeof parsed.sessionId === 'string' && Array.isArray(parsed.injected)) {
        const items = Array.isArray(parsed.items) && parsed.items.every(item => item !== null && typeof item === 'object'
          && typeof item.name === 'string' && (item.scope === 'user' || item.scope === 'project') && typeof item.included === 'boolean')
          ? parsed.items : undefined
        entries.push({
          ts: parsed.ts,
          sessionId: parsed.sessionId,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
          injected: parsed.injected.filter((n): n is string => typeof n === 'string'),
          truncated: Array.isArray(parsed.truncated) ? parsed.truncated.filter((n): n is string => typeof n === 'string') : [],
          bytes: typeof parsed.bytes === 'number' && Number.isFinite(parsed.bytes) && parsed.bytes >= 0 ? parsed.bytes : 0,
          ...(items === undefined ? {} : { items }),
          ...(typeof parsed.budget === 'number' && Number.isFinite(parsed.budget) && parsed.budget >= 0 ? { budget: parsed.budget } : {}),
          ...(typeof parsed.frozen === 'boolean' ? { frozen: parsed.frozen } : {}),
        })
      }
    } catch { continue }
  }
  return { injections: entries, consolidation }
}

/** 单个工作区的注入统计(按 cwd 聚合;面板"按项目"视图)。 */
export interface AuditProjectStats {
  /** 工作区绝对路径(空串归为 unknown)。 */
  cwd: string
  /** 该工作区出现过的会话数(去重)。 */
  sessions: number
  /** 注入事件数。 */
  injections: number
  /** 平均注入段字节。 */
  avgBytes: number
  /** 在该工作区注入过/被截断过的记忆条数(去重)。 */
  memories: number
  /** 截断事件总数。 */
  truncated: number
  /** 最近一次注入时刻。 */
  lastTs: number
}

/** 统计聚合(audit.stats API 的载荷形状)。 */
export interface AuditStats {
  /** 审计覆盖的会话数(按 sessionId 去重)。 */
  sessions: number
  /** 注入事件总数(条目数)。 */
  injections: number
  /** 平均注入段字节(概览指标;无事件为 0)。 */
  avgBytes: number
  /** 逐记忆注入统计:注入次数降序,同频按名称;truncatedCount 是被预算挤出的次数。
   *  scope(0.9.1):该记忆当前所在作用域(user/project/both=两层同名/missing=已删除)。 */
  memories: Array<{ name: string; injectedCount: number; truncatedCount: number; lastTs: number; scope: 'user' | 'project' | 'both' | 'missing' }>
  /** 每条确切记忆，以及无法还原作用域的旧记录（scope=unknown）。 */
  scopedMemories: Array<{ name: string; scope: 'user' | 'project' | 'unknown'; slug?: string; injectedCount: number; truncatedCount: number }>
  /** 按工作区聚合(注入次数降序):回答"哪个项目在吃预算/被截断"。 */
  projects: AuditProjectStats[]
  /** 最近 sessionsLimit 个注入事件(时间线视图,ts 升序)。 */
  timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number; injected?: string[]; truncatedNames?: string[];
    items?: InjectionItem[]; projectSlug?: string; budget?: number; frozen?: boolean }>
}

/**
 * 聚合审计统计(内存计算;条目量级 = 会话数 × 集合变化数,常态很小)。
 * store 用于标注每条记忆的作用域(0.9.1:用户级/项目级在注入榜上可分辨)——
 * 传 undefined 则跳过标注(UI 兼容旧宿主)。
 */
export function aggregateAudit(entries: AuditEntry[], sessionsLimit = 50, store?: MemoryStore): AuditStats {
  const perSession = new Map<string, number>()
  const perMemory = new Map<string, { injectedCount: number; truncatedCount: number; lastTs: number }>()
  const perIdentity = new Map<string, AuditStats['scopedMemories'][number]>()
  const countIdentity = (name: string, scope: 'user' | 'project' | 'unknown', slug: string | undefined, included: boolean): void => {
    const key = JSON.stringify([scope, slug, name])
    const row = perIdentity.get(key) ?? { name, scope, ...(slug === undefined ? {} : { slug }), injectedCount: 0, truncatedCount: 0 }
    if (included) row.injectedCount++
    else row.truncatedCount++
    perIdentity.set(key, row)
  }
  const perProject = new Map<string, {
    sessions: Set<string>
    injections: number
    bytes: number
    names: Set<string>
    truncated: number
    lastTs: number
  }>()
  for (const entry of entries) {
    perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1)
    // 按工作区聚合:空 cwd 归为 unknown(无会话上下文的裸组装不会产生审计行,
    // 但历史数据/手改可能留下空串)
    const cwdKey = entry.cwd.length > 0 ? entry.cwd : 'unknown'
    const project = perProject.get(cwdKey) ?? {
      sessions: new Set<string>(), injections: 0, bytes: 0, names: new Set<string>(), truncated: 0, lastTs: 0,
    }
    project.sessions.add(entry.sessionId)
    project.injections += 1
    project.bytes += entry.bytes
    project.truncated += entry.truncated.length
    project.lastTs = Math.max(project.lastTs, entry.ts)
    for (const name of entry.injected) project.names.add(name)
    for (const name of entry.truncated) project.names.add(name)
    perProject.set(cwdKey, project)
    for (const name of entry.injected) {
      const current = perMemory.get(name) ?? { injectedCount: 0, truncatedCount: 0, lastTs: 0 }
      current.injectedCount += 1
      current.lastTs = Math.max(current.lastTs, entry.ts)
      perMemory.set(name, current)
    }
    // 截断名单同样计入(被挤出注入的记忆才是有信息量的那部分——注入榜在
    // 注入集合稳定的会话里全是同分,截断次数才是区分度)
    for (const name of entry.truncated) {
      const current = perMemory.get(name) ?? { injectedCount: 0, truncatedCount: 0, lastTs: 0 }
      current.truncatedCount += 1
      perMemory.set(name, current)
    }
    if (entry.items === undefined) {
      for (const name of entry.injected) countIdentity(name, 'unknown', undefined, true)
      for (const name of entry.truncated) countIdentity(name, 'unknown', undefined, false)
    } else {
      const slug = entry.cwd.length === 0 ? undefined : projectKey(entry.cwd)
      for (const item of entry.items) {
        if (item.scope === 'user') countIdentity(item.name, 'user', USER_SCOPE_DIR, item.included)
        else countIdentity(item.name, slug === undefined ? 'unknown' : 'project', slug, item.included)
      }
    }
  }
  const avgBytes = entries.length === 0
    ? 0
    : Math.round(entries.reduce((sum, entry) => sum + entry.bytes, 0) / entries.length)
  // 作用域标注(0.9.1):反查 store 判断每条被统计的记忆在哪个层。
  // 项目层 cwd 不定(审计行各带 cwd,但同名记忆跨项目可能多处存在)——
  // 取统计里出现过的全部 cwd 逐个查,任一命中即算 project。
  const memories: AuditStats['memories'] = [...perMemory.entries()]
    .map(([name, m]) => ({ name, ...m, scope: 'missing' as const }))
    .sort((a, b) => b.injectedCount - a.injectedCount || a.name.localeCompare(b.name))
  if (store !== undefined) {
    const cwds = [...new Set(entries.map(e => e.cwd).filter(c => c.length > 0))]
    // 同步走 readIndexSync(注入热路径同款),从索引行解析记忆名集合
    const namesInIndex = (scope: 'user' | 'project', cwd?: string): Set<string> => {
      const index = store.readIndexSync(scope, cwd) ?? ''
      return new Set(index.split('\n').flatMap(line => memoryNameFromIndexLine(line) ?? []))
    }
    const userNames = namesInIndex('user')
    const projectNames = new Set(cwds.flatMap(cwd => [...namesInIndex('project', cwd)]))
    for (const m of memories) {
      const inUser = userNames.has(m.name)
      const inProject = projectNames.has(m.name)
      m.scope = inUser && inProject ? 'both' : inUser ? 'user' : inProject ? 'project' : 'missing'
    }
  }
  const projects: AuditStats['projects'] = [...perProject.entries()]
    .map(([cwd, project]) => ({
      cwd,
      sessions: project.sessions.size,
      injections: project.injections,
      avgBytes: project.injections === 0 ? 0 : Math.round(project.bytes / project.injections),
      memories: project.names.size,
      truncated: project.truncated,
      lastTs: project.lastTs,
    }))
    .sort((a, b) => b.injections - a.injections || b.lastTs - a.lastTs || a.cwd.localeCompare(b.cwd))
  return {
    sessions: perSession.size,
    injections: entries.length,
    avgBytes,
    memories,
    scopedMemories: [...perIdentity.values()],
    projects,
    // 1.4.0:时间线条目携带注入/截断名单(面板展开查看具体内容);
    // 名单封顶 60 防极端载荷(单次注入常态 ~30 行)
    timeline: entries.slice(-sessionsLimit).map(entry => ({
      ts: entry.ts,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      count: entry.injected.length,
      bytes: entry.bytes,
      truncated: entry.truncated.length,
      injected: entry.injected.slice(0, 60),
      truncatedNames: entry.truncated.slice(0, 60),
      ...(entry.items === undefined ? {} : { items: [
        ...entry.items.filter(item => item.included).slice(0, 60),
        ...entry.items.filter(item => !item.included).slice(0, 60),
      ] }),
      ...(entry.cwd.length === 0 ? {} : { projectSlug: projectKey(entry.cwd) }),
      ...(entry.budget === undefined ? {} : { budget: entry.budget }),
      ...(entry.frozen === undefined ? {} : { frozen: entry.frozen }),
    })),
  }
}

/**
 * 挂载注入审计(section text 回调用):按会话对"注入集合签名"去重,
 * 变化即追加。返回 text(注入内容本身)——审计是副作用,绝不影响返回值。
 *
 * 会话注入快照(1.9.0,统一并取代 1.6.0 的懒冻结词集):**首条 USER 到达后
 * 的那次组装做一次性选择,结果定格为会话快照,此后会话内绝对不变**。
 * - 时机对齐官方三家:Codex「会话边界注入一次,稳态回合不重建」/Claude Code
 *   「project context 会话开始读盘」/Anthropic「按变化频率分层」;
 * - KV 升级:dsh 0.2.x 下 section 变化=向历史**追加一整条 system message**
 *   (capable route 不炸缓存但单调吃 token)——快照使会话内零追加、跨天零
 *   变化,是 0.2.x 语义下的最强稳定;
 * - 选择升级:首 USER 是任务书,快照定格时用它做一次性相关性选择(预算内
 *   全量时无需选择),取代懒冻结的"首次截断时刻";
 * - 行为变化(与官方 Claude Code 一致):memory_write 落盘后本会话注入不变
 *   (工具即时可读、注入下会话生效)。
 * 已知例外(审查确认,如实声明):无真实 USER 输入的会话(subagent 合成
 * 注入/纯程序驱动)词集恒 undefined→永不定格,保持每组装动态求值(即
 * 1.8.0 行为,写入即时反映,0.2.x 下会追加 system message);已定格会话的
 * maxBytes 改动于下一会话生效(快照基准=定格时配置)。
 * 首组装(首 USER 前)仍动态求值(不缓存):给空库→会话首写入等场景一个
 * 在首 USER 时定格的机会。
 */
export function registerInjectionAudit(
  store: MemoryStore, config: Config, rootDir: string,
  getQueryText?: (sessionId: string) => string | undefined,
): { text: (cwd: string | undefined, sessionId: string | undefined) => string; cleanup: (sessionId: string) => void; flush: () => Promise<void> } {
  /** sessionId → 最近注入集合签名(含截断名单与 cwd——换工作区重算)。 */
  const lastSignature = new Map<string, string>()
  /** sessionId → 定格的会话注入快照文本(1.9.0;定格后直返,不再求值)。 */
  const sessionSnapshot = new Map<string, string>()
  return {
    text: (cwd, sessionId) => {
    // 快照已定格:会话内绝对稳定——写入/跨天/索引重建都不改本会话注入
    // (审计签名天然恒定,不再追加;0.2.x 下零追加 system message)
    const snap = sessionId !== undefined ? sessionSnapshot.get(sessionId) : undefined
    if (snap !== undefined) return snap
    // 首条 USER 可得(词集源):一次性选择 + 定格快照
    let query = sessionId !== undefined && getQueryText !== undefined ? getQueryText(sessionId) : undefined
    if (query !== undefined && query.trim().length === 0) query = undefined
    const detail = renderMemoryIndexDetail(store, config, cwd, query)
    if (detail.text.length === 0 || sessionId === undefined || cwd === undefined) {
      // 注入转空(会话中途 delete_all/删光):不记空事件,但必须复位该会话
      // 签名——否则空档后同名集合回归会被残留签名吞掉,真实再注入漏记(审查实测)。
      if (sessionId !== undefined && detail.text.length === 0) lastSignature.delete(sessionId)
      return detail.text
    }
    if (query !== undefined) {
      // 快照定格纪律(1.9.0):只要首 USER 已知就定格——预算内全量也定格
      // (字节与动态求值相同,但把「会话内不变」从输出稳定升级为显式快照,
      // 后续写入/跨天不再进入本会话注入)。空文本不定格(空库首写入场景
      // 留给下一次组装)。
      sessionSnapshot.set(sessionId, detail.text)
    }
    const frozen = query !== undefined
    const signature = JSON.stringify([cwd, config.maxBytes, frozen, detail.items])
    if (lastSignature.get(sessionId) === signature) return detail.text
    lastSignature.set(sessionId, signature)
    void appendAudit(rootDir, {
      ts: Date.now(), sessionId, cwd,
      injected: detail.injected, truncated: detail.truncated, bytes: detail.textBytes,
      items: detail.items, budget: config.maxBytes, frozen,
    })
    return detail.text
    },
    cleanup: sessionId => { lastSignature.delete(sessionId); sessionSnapshot.delete(sessionId) },
    /** 等待在途审计落盘(测试与优雅退出用;注入路径永不 await 它)。 */
    flush: () => auditChain,
  }
}
