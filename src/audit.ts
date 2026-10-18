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
import { withLockRecovery } from './store.ts'
import type { Config } from './index.ts'
import { renderMemoryIndexDetail } from './prompt.ts'

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

export function appendAudit(rootDir: string, entry: AuditEntry): Promise<void> {
  const file = join(rootDir, AUDIT_FILENAME)
  auditChain = auditChain.then(() => withLockRecovery(file, async () => {
    await fsp.mkdir(rootDir, { recursive: true })
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    // rotation(锁内):超上限保留尾部一半行(完整行对齐,丢弃最旧),
    // 审计文件是根目录下唯一只增文件且用户不可见——不设界即无界(审查确认)
    const size = await fsp.stat(file).then(s => s.size).catch(() => 0)
    if (size > AUDIT_MAX_BYTES) {
      const raw = await fsp.readFile(file, 'utf8').catch(() => null)
      if (raw !== null) {
        const lines = raw.split('\n').filter(line => line.length > 0)
        const keptLines: string[] = []
        let keptBytes = 0
        for (const line of lines.toReversed()) { // 从尾保完整行,凑够一半预算即停
          if (keptBytes > AUDIT_MAX_BYTES / 2) break
          keptLines.unshift(line)
          keptBytes += line.length + 1
        }
        await writeFileAtomic(file, `${keptLines.join('\n')}\n`, { mode: 0o600 })
      }
    }
  })).catch(() => { /* 静默:审计绝不影响注入 */ })
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
}

/** 读取全部审计条目(坏行跳过——对齐官方 jsonl 崩溃恢复语义:丢弃不完整尾行;文件不存在返回空)。 */
export async function readAudit(rootDir: string): Promise<AuditEntry[]> {
  let raw: string
  try {
    raw = await fsp.readFile(join(rootDir, AUDIT_FILENAME), 'utf8')
  } catch {
    return []
  }
  const entries: AuditEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<AuditEntry>
      if (typeof parsed.ts === 'number' && typeof parsed.sessionId === 'string' && Array.isArray(parsed.injected)) {
        entries.push({
          ts: parsed.ts,
          sessionId: parsed.sessionId,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
          injected: parsed.injected.filter((n): n is string => typeof n === 'string'),
          truncated: Array.isArray(parsed.truncated) ? parsed.truncated.filter((n): n is string => typeof n === 'string') : [],
          bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
        })
      }
    } catch { continue }
  }
  return entries
}

/** 统计聚合(audit.stats API 的载荷形状)。 */
export interface AuditStats {
  /** 审计覆盖的会话数(按 sessionId 去重)。 */
  sessions: number
  /** 注入事件总数(条目数)。 */
  injections: number
  /** 平均注入段字节(概览指标;无事件为 0)。 */
  avgBytes: number
  /** 逐记忆注入统计:注入次数降序,同频按名称;truncatedCount 是被预算挤出的次数。 */
  memories: Array<{ name: string; injectedCount: number; truncatedCount: number; lastTs: number }>
  /** 最近 sessionsLimit 个注入事件(时间线视图,ts 升序)。 */
  timeline: Array<{ ts: number; sessionId: string; cwd: string; count: number; bytes: number; truncated: number }>
}

/** 聚合审计统计(内存计算;条目量级 = 会话数 × 集合变化数,常态很小)。 */
export function aggregateAudit(entries: AuditEntry[], sessionsLimit = 50): AuditStats {
  const perSession = new Map<string, number>()
  const perMemory = new Map<string, { injectedCount: number; truncatedCount: number; lastTs: number }>()
  for (const entry of entries) {
    perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1)
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
  }
  const avgBytes = entries.length === 0
    ? 0
    : Math.round(entries.reduce((sum, entry) => sum + entry.bytes, 0) / entries.length)
  return {
    sessions: perSession.size,
    injections: entries.length,
    avgBytes,
    memories: [...perMemory.entries()]
      .map(([name, m]) => ({ name, ...m }))
      .sort((a, b) => b.injectedCount - a.injectedCount || a.name.localeCompare(b.name)),
    timeline: entries.slice(-sessionsLimit).map(entry => ({
      ts: entry.ts,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      count: entry.injected.length,
      bytes: entry.bytes,
      truncated: entry.truncated.length,
    })),
  }
}

/**
 * 挂载注入审计(section text 回调用):按会话对"注入集合签名"去重,
 * 变化即追加。返回 text(注入内容本身)——审计是副作用,绝不影响返回值。
 */
export function registerInjectionAudit(
  store: MemoryStore, config: Config, rootDir: string,
): { text: (cwd: string | undefined, sessionId: string | undefined) => string; cleanup: (sessionId: string) => void; flush: () => Promise<void> } {
  /** sessionId → 最近注入集合签名(含截断名单与 cwd——换工作区重算)。 */
  const lastSignature = new Map<string, string>()
  return {
    text: (cwd, sessionId) => {
    const detail = renderMemoryIndexDetail(store, config, cwd)
    if (detail.text.length === 0 || sessionId === undefined || cwd === undefined) {
      // 注入转空(会话中途 delete_all/删光):不记空事件,但必须复位该会话
      // 签名——否则空档后同名集合回归会被残留签名吞掉,真实再注入漏记(审查实测)
      if (sessionId !== undefined && detail.text.length === 0) lastSignature.delete(sessionId)
      return detail.text
    }
    const signature = `${cwd}\0${detail.injected.join(',')}\0|${detail.truncated.join(',')}`
    if (lastSignature.get(sessionId) === signature) return detail.text
    lastSignature.set(sessionId, signature)
    void appendAudit(rootDir, {
      ts: Date.now(), sessionId, cwd,
      injected: detail.injected, truncated: detail.truncated, bytes: detail.textBytes,
    })
    return detail.text
    },
    cleanup: sessionId => { lastSignature.delete(sessionId) },
    /** 等待在途审计落盘(测试与优雅退出用;注入路径永不 await 它)。 */
    flush: () => auditChain,
  }
}
