/**
 * P1:会话结束自动固化(consolidation)。
 *
 * 流程(全部挂点来自源码调研,见 docs/api-reports.md eventsCompaction 报告):
 * 1. 会话进行中:监听 `session/event`(fire-and-forget),把人类输入与模型回复的
 *    文本以轻量摘要形式累积进内存缓冲(不读 deprecated 的 snapshotEvents/eventAt,
 *    不写任何自定义会话事件)。
 * 2. `agent/disposed` 时(session 仍活、agent.options 路由可用——官方最佳挂点):
 *    过滤 subagent(header.delegationDepth > 0),用 ctx.llm.stream 后台调用
 *    (BlockAssembler 消费),让模型从缓冲中提取"值得跨会话保留的新事实"。
 * 3. 候选经 sanitize(normalizeName/类型/scope/截断)与查重(同名跳过)后,
 *    走 store.write 写入——完整复用 P0 的锁/原子写/安全层。
 *
 * 安全边界:
 * - 一切失败静默(ctx.logger.warn),绝不影响会话与 resume;
 * - LLM 输出不可信:逐项校验,坏项丢弃;
 * - emit 监听不被 await:active 集合 + ctx.effect teardown 排空在途 Promise
 *   (command-compact 模式),插件卸载/进程优雅退出时不截断写入;
 * - 已知限制(接受):进程崩溃时未固化的缓冲丢失,已有记忆不受影响。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型:SessionEvent(事件判别联合)与 Agent/AgentOptions 的声明合并
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { MemoryStore } from './store.ts'
import { normalizeName, asMemoryType } from './store.ts'
import type { MemoryScope, MemoryType } from './types.ts'

// dsh-subagent 在 AgentOptions 上声明的字段(此处同样声明合并,不引入对
// dsh-subagent 的依赖;SessionHeader.delegationDepth 官方类型已有,无需重复声明)
declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
    subagentDepth?: number
  }
}

/** 固化配置(index.ts Config 的子集)。 */
export interface ConsolidationOptions {
  autoSummarize: boolean
  autoSummarizeMaxMemories: number
  autoSummarizeMaxTokens: number
  enableUserScope: boolean
}

/** 一条固化候选(LLM 输出的一个元素,sanitize 前)。 */
export interface RawCandidate {
  name?: unknown
  title?: unknown
  description?: unknown
  type?: unknown
  body?: unknown
  scope?: unknown
}

/** sanitize 后的可写候选。 */
export interface SanitizedCandidate {
  name: string
  title?: string
  description: string
  type: MemoryType
  body: string
  scope: MemoryScope
}

// ---------- 纯函数(可测) ----------

const USER_MAX_CHARS = 2000
const ASSISTANT_MAX_CHARS = 500
const MAX_TURNS = 40
const MAX_BUFFER_CHARS = 24_000

/** 从一条会话事件提取捕获文本;不关心的事件返回 null。 */
export function captureText(kind: 'user' | 'assistant', message: { content: unknown } | undefined): string | null {
  if (message === undefined || !Array.isArray(message.content)) return null
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) return null
  const cap = kind === 'user' ? USER_MAX_CHARS : ASSISTANT_MAX_CHARS
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** 追加一行到缓冲并执行容量控制(丢最旧)。 */
export function appendCapped(lines: string[], line: string): string[] {
  const next = [...lines, line]
  while (next.length > MAX_TURNS || next.join('\n').length > MAX_BUFFER_CHARS) {
    if (next.length <= 1) break
    next.shift()
  }
  return next
}

/** 从 LLM 输出文本中提取 JSON 数组(容错:截取首个 [ 到最后一个 ]);失败返回 null。 */
export function parseCandidates(raw: string): RawCandidate[] | null {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? (parsed as RawCandidate[]) : null
  } catch {
    return null
  }
}

/**
 * sanitize 单条候选:字段类型校验、name 归一化(不可归一化即丢弃)、
 * type 收窄、scope guard、长度截断。返回 null 表示丢弃。
 */
export function sanitizeCandidate(raw: RawCandidate, enableUserScope: boolean): SanitizedCandidate | null {
  try {
    const name = normalizeName(String(raw.name ?? ''))
    const description = String(raw.description ?? '').trim().slice(0, 160)
    const body = String(raw.body ?? '').trim().slice(0, 2000)
    const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim().slice(0, 80) : undefined
    if (description.length === 0 || body.length === 0) return null
    const type = asMemoryType(String(raw.type ?? 'reference'))
    const scope: MemoryScope = raw.scope === 'user' ? (enableUserScope ? 'user' : 'project') : 'project'
    return { name, title, description, type, body, scope }
  } catch {
    return null
  }
}

/** 组装给固化模型的指令(含已有记忆名以避免重复)。 */
export function buildConsolidationPrompt(existingNames: string[], transcript: string, maxMemories: number): string {
  const known = existingNames.length > 0 ? existingNames.join(', ') : '(none)'
  return `You are the memory-consolidation step of a coding agent. Below is a transcript
summary of a session that just ended. Extract NEW facts worth persisting across
sessions for this user, following these rules:

- Persist: who the user is (role, expertise, durable preferences); corrections or
  confirmations about how to work; ongoing goals/constraints with absolute dates;
  external resources worth returning to.
- Do NOT persist: one-off task details, anything recoverable from the codebase or
  AGENTS.md, session-specific context.
- Existing memories (do not duplicate them): ${known}
- Output AT MOST ${maxMemories} items. If nothing is worth persisting, output [].

Return ONLY a JSON array, each element exactly:
{"name":"kebab-case-id","title":"short human heading","description":"one line <=160 chars","type":"user|feedback|project|reference","body":"the fact in markdown; for feedback include **Why:** and **How to apply:** lines","scope":"project"}
Use scope "user" only for user-global preferences; default "project".

<transcript>
${transcript}
</transcript>`
}

// ---------- 会话缓冲 ----------

interface SessionCapture {
  cwd: string | undefined
  lines: string[]
}

/** 挂载自动固化监听(autoSummarize=false 时 no-op)。 */
export function registerConsolidation(ctx: Context, store: MemoryStore, options: ConsolidationOptions): void {
  if (!options.autoSummarize) return

  const captures = new Map<string, SessionCapture>()
  const active = new Set<Promise<void>>()
  // teardown 时中止在途 LLM 调用(否则排空只能干等截断输出;审查 minor 修复)
  const abort = new AbortController()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const message = event.data
      // 只捕获真实人类输入(插件注入的上下文不含持久价值)
      if (message.source?.kind !== 'user') return
      const text = captureText('user', message as { content: unknown })
      if (text === null) return
      const cap = captures.get(session.id) ?? { cwd: session.header.cwd, lines: [] }
      cap.cwd = session.header.cwd ?? cap.cwd
      cap.lines = appendCapped(cap.lines, `USER: ${text}`)
      captures.set(session.id, cap)
    } else if (event.type === 'assistant/message') {
      const text = captureText('assistant', event.data.message as { content: unknown })
      if (text === null) return
      const cap = captures.get(session.id) ?? { cwd: session.header.cwd, lines: [] }
      cap.cwd = session.header.cwd ?? cap.cwd
      cap.lines = appendCapped(cap.lines, `ASSISTANT: ${text}`)
      captures.set(session.id, cap)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const cap = captures.get(agent.session.id)
    if (cap === undefined) return
    // 无论是否固化都取走缓冲:subagent 的捕获也会在此清理,否则常驻进程
    // 的 captures Map 随子代理会话无界增长(审查 major 修复)
    captures.delete(agent.session.id)
    // 过滤 subagent:固化只针对根会话(child 的内容会在父会话流中体现)
    const depth = Math.max(agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)
    if (depth > 0) return
    const cwd = cap.cwd ?? agent.session.header.cwd
    if (cwd === undefined) return
    const provider = agent.options.provider
    const model = agent.options.model
    if (provider === undefined || model === undefined) return // 无路由信息,放弃(静默)
    // 机会式获取 llm 服务:autoSummarize 部署(base)必有;无服务的组合(如测试栈)静默跳过
    const llm = ctx.get('llm')
    if (llm === undefined) return

    const task = (async (): Promise<void> => {
      try {
        const existing = await store.listAll(cwd)
        const prompt = buildConsolidationPrompt(
          existing.map(r => r.name),
          cap.lines.join('\n\n'),
          options.autoSummarizeMaxMemories,
        )
        const assembler = new BlockAssembler()
        const request: GenerateOptions = {
          provider,
          model,
          messages: [createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'dsh-auto-memory' },
          })],
          maxTokens: options.autoSummarizeMaxTokens,
          sessionId: agent.session.id,
          signal: abort.signal,
        }
        for await (const chunk of llm.stream(request)) assembler.push(chunk)
        // finish 是 getter 属性(非方法);失败/中止以终止分片形式返回,不是异常
        const finish = assembler.finish
        if (finish.kind === 'error') {
          ctx.logger.warn('[dsh-auto-memory] consolidation llm failed')
          return
        }
        if (finish.kind === 'aborted') return // teardown 中止属正常,不告警
        const text = assembler.blocks()
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        const candidates = parseCandidates(text)
        if (candidates === null) {
          ctx.logger.warn('[dsh-auto-memory] consolidation output was not a JSON array; skipped')
          return
        }
        let written = 0
        for (const raw of candidates) {
          if (written >= options.autoSummarizeMaxMemories) break
          const candidate = sanitizeCandidate(raw, options.enableUserScope)
          if (candidate === null) continue
          // 查重:任何作用域已有同名 → 跳过(自动更新有风险,保守起见只新增)
          if (await store.findIn(candidate.name, options.enableUserScope ? ['user', 'project'] : ['project'], cwd) !== null) continue
          await store.write(candidate, candidate.scope, cwd)
          written += 1
        }
        if (written > 0) ctx.logger.info(`[dsh-auto-memory] consolidated ${written} memor${written === 1 ? 'y' : 'ies'}`)
      } catch (error) {
        ctx.logger.warn(`[dsh-auto-memory] consolidation failed: ${String(error)}`)
      }
    })()
    active.add(task)
    void task.finally(() => { active.delete(task) })
  })

  // 会话离开 live store 时兜底清理缓冲(agent/disposed 未覆盖的关闭路径)
  ctx.on('session/disposed', session => {
    captures.delete(session.id)
  })

  // teardown:先中止在途 LLM 调用,再排空(emit 监听不被 await,优雅退出靠这里兜底)
  ctx.effect(function* () {
    yield async () => {
      abort.abort()
      await Promise.allSettled([...active])
    }
  }, 'dsh-auto-memory consolidation')
}
