/**
 * P1:会话结束自动固化(consolidation)。
 *
 * 流程(全部挂点来自源码调研,见 internal research notes eventsCompaction 报告):
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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MemoryStore } from './store.ts'
import { normalizeName, asMemoryType, DEFAULT_IMPORTANCE } from './store.ts'
import { decideConsolidationAction, detectContradictions, words } from './matching.ts'
import { collectInstructionDigest } from './instructions.ts'
import type { MemoryEvidence, MemoryScope, MemoryStatus, MemoryType } from './types.ts'

// dsh-subagent 在 AgentOptions 上声明的字段(此处同样声明合并,不引入对
// dsh-subagent 的依赖;SessionHeader.delegationDepth 官方类型已有,无需重复声明)
declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
    subagentDepth?: number
  }
}

// 0.2.x(session format v4)起,注入消息只接受 producer-owned 的 source kind:
// 旧的 { kind: 'plugin', plugin: '…' } 已从 MessageSourceMap 移除,既过不了 0.2.x 的
// 类型检查,v4 的持久消息准入也会在运行时拒绝
// (SessionFormatError: format v4 message requires a producer-owned source kind)。
// 本插件按官方 merge-extensible 惯例声明自己的 kind(session-format-v3-to-v4 的迁移
// 说明与 docs/api-reports.md 都以此为准;tool-skill 的 'skill-catalog'、
// dsh-skill 的 'skill-invocation' 同理)。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-auto-memory': { kind: 'dsh-auto-memory' }
  }
}

/** 固化配置(index.ts Config 的子集)。 */
export interface ConsolidationOptions {
  autoSummarize: boolean
  autoSummarizeMaxMemories: number
  autoSummarizeMaxTokens: number
  enableUserScope: boolean
  /** #17 候选有效分(importance ?? DEFAULT_IMPORTANCE[type])低于此值丢弃;0 禁用。 */
  minImportance: number
}

/** 一条固化候选(LLM 输出的一个元素,sanitize 前)。 */
export interface RawCandidate {
  name?: unknown
  title?: unknown
  description?: unknown
  type?: unknown
  body?: unknown
  scope?: unknown
  importance?: unknown
  /** 支撑该事实的转写逐字摘录(1.0.0;宽松校验,坏值只丢 evidence 不丢整条)。 */
  evidence?: unknown
}

/** sanitize 后的可写候选。 */
export interface SanitizedCandidate {
  name: string
  title?: string
  description: string
  type: MemoryType
  body: string
  scope: MemoryScope
  /** 重要度 1-10(固化模型显式打分;非法或缺省时回退类型缺省,由 store 兜底)。 */
  importance?: number
  /** 可信状态:candidate 默认;指令注入模式命中降级 disputed(1.0.0)。 */
  status: MemoryStatus
  /** 证据链(sessionId 来自固化调用点;quote 为 LLM 摘录,两者齐备才落)。 */
  evidence?: MemoryEvidence
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

// 指令注入检测的实现已下沉 store.write 单点(覆盖 memory_write 直写路径,
// 审查确认只挂固化会被绕过);此处转出口保持固化路径调用方与测试兼容。
import { detectDirectivePattern } from './store.ts'
export { detectDirectivePattern }

/**
 * 闲聊抑制(#17):候选正文是否为纯寒暄——强问候信号命中且剥掉问候后无实质内容。
 * 纪律(对齐 DIRECTIVE_PATTERNS 的 40% 误报教训;对抗审查实测首版中文误报 45% 后重设计):
 * - 强问候信号 = 句首问候(无 ——JS  对 CJK 是死分支)或句中感谢/道别/裸应答;
 * - 实质内容判定分语言:拉丁侧任何 >=3 字符 token;CJK 侧不依赖闭集词表
 *   (审查实测:两字词闭集对 函数/异常/线程/内存 大量漏列、3 字词条对 bigram
 *   分词器是死代码、无标点中英混排 glue 成混合 token 全漏)——改为长度门槛:
 *   剥掉句首问候与句尾客套后,剩余 CJK 字符 >=6 即有实质(自我介绍/偏好/
 *   技术问句天然过线;只有真·纯寒暄被拦,宁漏勿误)。
 */
const GREETING_PATTERNS: RegExp[] = [
  /^(?:你好|您好|hi|hello|hey|早上好|晚上好|下午好)/i,
  /(?:谢谢|感谢|thanks|thank you|多谢|再见|晚安|回头见|bye)/i,
  /^(?:好的|嗯+|哦+|ok|okay|got it|明白|收到)[。.!!~s]*$/i,
]

/** 纯函数:候选正文是否命中闲聊抑制(强问候 AND 剥问候后无实质内容)。 */
export function isChitchat(text: string): boolean {
  const greeting = GREETING_PATTERNS.some(pattern => pattern.test(text))
  if (!greeting) return false
  const stripped = text
    .replace(/^(?:你好|您好|hi|hello|hey|早上好|晚上好|下午好)[,，!！。~s]*/i, '')
    .replace(/(?:谢谢|感谢|多谢|辛苦了|再见|晚安|回头见)(啦|了|呢)?[。.!!~s]*$/g, '')
    .replace(/(?:thanks|thank[s!]you|bye|hello|hi|got it|ok)[!.~s]*/gi, '')
    .trim()
  if (/[a-z][a-z0-9-]{2,}/i.test(stripped)) return false
  const cjkCount = (stripped.match(/[一-鿿]/g) ?? []).length
  if (cjkCount >= 6) return false
  return true
}

/**
 * sanitize 单条候选:字段类型校验、name 归一化(不可归一化即丢弃)、
 * type 收窄、scope guard、长度截断;1.0.0 起统一标可信状态
 * (默认 candidate;正文命中指令注入模式则 disputed——store.write 单点
 * 还会再查一次 description,双保险幂等)。evidence 走调用点传入的
 * sessionId + LLM 摘录。返回 null 表示丢弃。
 */
export function sanitizeCandidate(raw: RawCandidate, enableUserScope: boolean, opts?: { sessionId?: string; transcript?: string }): SanitizedCandidate | null {
  try {
    const name = normalizeName(String(raw.name ?? ''))
    const description = String(raw.description ?? '').trim().slice(0, 160)
    const body = String(raw.body ?? '').trim().slice(0, 2000)
    const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim().slice(0, 80) : undefined
    if (description.length === 0 || body.length === 0) return null
    const type = asMemoryType(String(raw.type ?? 'reference'))
    const scope: MemoryScope = raw.scope === 'user' ? (enableUserScope ? 'user' : 'project') : 'project'
    const importance = typeof raw.importance === 'number' && Number.isSafeInteger(raw.importance)
      ? Math.min(10, Math.max(1, raw.importance)) : undefined
    // 可信状态:候选一律有主——默认 candidate;指令注入模式命中降级 disputed
    // (store.write 单点还有二次校验,此处前置判定让候选对象自洽可测)。
    const disputed = detectDirectivePattern(body) || detectDirectivePattern(description)
    const status: MemoryStatus = disputed ? 'disputed' : 'candidate'
    let quote = typeof raw.evidence === 'string' && raw.evidence.trim().length > 0
      ? raw.evidence.trim().slice(0, 400)
      : undefined
    // 逐字引用对照(审查 minor:prompt 压力下模型会伪造引用)——转写可得时,
    // 摘录的前 40 字符(空白归一)必须真实出现在转写里,否则视为幻觉引用丢弃
    // (宽松:只丢 evidence 不丢整条,与"坏值只丢字段"纪律一致)
    const transcript = opts?.transcript
    if (quote !== undefined && transcript !== undefined) {
      const probe = quote.replace(/\s+/g, ' ').slice(0, 40)
      if (probe.length > 0 && !transcript.replace(/\s+/g, ' ').includes(probe)) quote = undefined
    }
    const sessionId = opts?.sessionId
    const evidence = quote !== undefined && sessionId !== undefined && sessionId.length > 0
      ? { sessionId, quote }
      : undefined
    return {
      name, title, description, type, body, scope, status,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(importance !== undefined ? { importance } : {}),
    }
  } catch {
    return null
  }
}

/**
 * 组装给固化模型的指令(含已有记忆名以避免重复)。
 * instructionsDigest(0.7.2):工作区指令链(AGENTS.md/CLAUDE.md)摘要——固化
 * 模型看不到基线消息(转写只含 user/assistant 文本),喂摘要使其知悉指令链
 * 已记载的约束,避免把"代码注释用中文"这类稳定约束再固化成记忆(分诊规则:
 * 人写稳定约束→AGENTS.md,模型动态事实→记忆,同一事实只落一处)。
 */
export function buildConsolidationPrompt(existingNames: string[], transcript: string, maxMemories: number, instructionsDigest?: string): string {
  const known = existingNames.length > 0 ? existingNames.join(', ') : '(none)'
  const instructions = instructionsDigest !== undefined && instructionsDigest.trim().length > 0
    ? `The workspace instruction files below are ALREADY injected into every session of this
user. NEVER persist anything they record — that would duplicate a constraint the user
maintains by hand in AGENTS.md/CLAUDE.md:

<workspace-instructions>
${instructionsDigest}
</workspace-instructions>

`
    : ''
  return `You are the memory-consolidation step of a coding agent. Below is a transcript
summary of a session that just ended. Extract NEW facts worth persisting across
sessions for this user, following these rules:

${instructions}- Persist: who the user is (role, expertise, durable preferences); corrections or
  confirmations about how to work; ongoing goals/constraints with absolute dates;
  external resources worth returning to.
- Do NOT persist: one-off task details, anything recoverable from the codebase or
  AGENTS.md, session-specific context, anything the workspace instructions above
  already record.
- Existing memories (do not duplicate them): ${known}
- If a fact UPDATES an existing memory, output it with that memory's EXACT
  existing name — reusing the name replaces the old version; a new name
  creates a duplicate.
- Output AT MOST ${maxMemories} items. If nothing is worth persisting, output [].
- "importance" is 1-10: 8-10 = identity/durable preferences, 5-7 = project facts
  worth keeping, 1-4 = marginal references. Be conservative, not everything is 9.

Return ONLY a JSON array, each element exactly:
{"name":"kebab-case-id","title":"short human heading","description":"one line <=160 chars","type":"user|feedback|project|reference","body":"the fact in markdown; for feedback include **Why:** and **How to apply:** lines","scope":"project","importance":5,"evidence":"1-2 sentence VERBATIM quote from the transcript that supports this fact"}
"evidence" must be copied word-for-word from the transcript above — do not
paraphrase. If you cannot quote a supporting line, do not output that item.
Use scope "user" only for user-global preferences; default "project".
Write "name" in kebab-case English; write title/description/body in the SAME
language as the transcript (a Chinese transcript gets Chinese memories —
the user will read them).

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
/**
 * 挂载自动固化监听(autoSummarize=false 时 no-op)。
 * 返回会话通道供注入侧使用(#18 相关性截断):getQueryText 取该会话最近的
 * 真实 USER 文本(词集原料),flush 等在途固化落盘。
 */
export interface ConsolidationHandle {
  /** 最近 N 条真实 USER 输入拼接(无缓冲/未捕获 → undefined;截断防词集膨胀)。 */
  getQueryText: (sessionId: string) => string | undefined
  /** 等待在途固化落盘(测试用)。 */
  flush: () => Promise<void>
  /** 会话清理钩子(注入侧同会话清冻结词集时一并调)。 */
  cleanup: (sessionId: string) => void
}

export function registerConsolidation(ctx: Context, store: MemoryStore, options: ConsolidationOptions): ConsolidationHandle {
  const captures = new Map<string, SessionCapture>()
  // autoSummarize=false 时无固化,但仍保留 USER 捕获(#18 相关性截断的词集源,
  // 与固化开关解耦——注入侧的相关性不应依赖后台总结是否开启)
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
      if (!options.autoSummarize) return // 固化关:只留 USER 捕获(词集),ASSISTANT 不需要
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
    // 固化关:autoSummarize 分支整体跳过,但缓冲保留到 session/disposed
    // (#18 词集源生命周期与固化解耦,不能在此取走)
    if (!options.autoSummarize) return
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
        // 工作区指令链摘要(0.7.2):固化模型看不到基线消息,喂摘要防重复固化;
        // 读取失败静默降级为无摘要,绝不影响固化本身
        const digest = await collectInstructionDigest(cwd, resolveDshHome())
        const prompt = buildConsolidationPrompt(
          existing.map(r => r.name),
          cap.lines.join('\n\n'),
          options.autoSummarizeMaxMemories,
          digest,
        )
        const assembler = new BlockAssembler()
        const request: GenerateOptions = {
          provider,
          model,
          messages: [createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'dsh-auto-memory' },
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
        if (finish.kind === 'max-tokens') {
          // 审查 minor:evidence 抬高输出体积后截断边际变窄——截断会让
          // parseCandidates 找不到尾 ] 而整批丢弃,必须与"模型格式错误"可区分
          ctx.logger.warn('[dsh-auto-memory] consolidation output truncated at max_tokens; raising autoSummarizeMaxTokens is recommended')
          return
        }
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
          const candidate = sanitizeCandidate(raw, options.enableUserScope, { sessionId: agent.session.id, transcript: cap.lines.join('\n\n') })
          if (candidate === null) continue
          const existingAll = await store.listAll(cwd)
          // 同一性判定(0.7.0 更新替换语义):name 锚定/精确同名/描述复述 → 更新
          // 现有记忆(复用其 name/scope 与生命周期,覆写内容)而非跳过或并存;
          // 无匹配 → 新建。L3 暴露的两 bug(新旧并存、同义重复)由此闭环。
          // #17 价值门槛:update 命中豁免(echo 复述刷新 recency 锚,拦掉会
          // 加速既有记忆衰减);create 才按有效分/闲聊过滤——判定复用同一
          // decision(审查 minor:每候选重复跑两次 decideConsolidationAction)
          const decision = decideConsolidationAction(candidate, existingAll)
          if (decision.action === 'create') {
            const effectiveImportance = candidate.importance ?? DEFAULT_IMPORTANCE[candidate.type]
            if (effectiveImportance < options.minImportance) continue
            if (isChitchat(candidate.body)) continue
          }
          if (decision.action === 'update') {
            // #19 矛盾检测(演化谱系):强信号(日期/数值)命中 → 两步写——
            // 新记忆以新 name 先落盘(带 supersedes 指针),旧记忆转
            // superseded(带 supersededBy 回链)。次序不可反:旧先隐藏而新写
            // 失败 = 该事实从注入中消失;新先写失败 = 退化为已知的"新旧并存"
            // 形态,可被体检 near-duplicate 榜与下次固化兜底。
            const contradictions = detectContradictions(candidate, decision.target)
            if (contradictions.length > 0) {
              // 新记忆必须用**不同的文件名**——同名会原地覆写旧文件(覆写后无物
              // 可标 superseded,注入里该事实彻底消失,调研确认的陷阱)。
              // LLM 按指示复用旧名时加代后缀;名字冲突再加序号。
              // 后缀在 normalizeName 产物(≤64)之后追加会突破 64 帽(审查:
              // 65-67 字符名 parseMemory 拒收成幽灵文件)——基名超 61 时先截断。
              const baseName = candidate.name.length > 61 ? candidate.name.slice(0, 61) : candidate.name
              let newName = candidate.name === decision.target.name ? `${baseName}-v2` : candidate.name
              let attempt = 2
              while (existingAll.some(r => r.name === newName)) {
                attempt += 1
                newName = `${baseName}-v${String(attempt)}`
              }
              await store.write({
                ...candidate,
                name: newName,
                supersedes: decision.target.name,
              }, candidate.scope, cwd)
              try {
                const old = await store.read(decision.target.name, decision.target.scope, cwd)
                if (old !== null) {
                  await store.write({
                    name: old.name,
                    ...(old.title !== undefined ? { title: old.title } : {}),
                    description: old.description,
                    type: old.type,
                    body: old.body,
                    pinned: old.pinned,
                    disabled: old.disabled,
                    status: 'superseded',
                    supersededBy: newName,
                  }, decision.target.scope, cwd)
                }
              } catch (error) {
                // 半链(新已写、旧未标):不中止本批剩余候选——near-duplicate 兜底
                ctx.logger.warn(`[dsh-auto-memory] supersede second step failed: ${String(error)}`)
              }
              written += 1
              continue
            }
            // update 分支不传 status/evidence:由 store.write 单点判定——
            // 内容未变(echo 刷新)继承原状态(verified 不被复述冲掉,审查 major);
            // 内容变化降回 candidate+旧证据失效;指令模式命中 disputed。
            // (此前在此无条件重置 verified,被对抗审查实测证伪)
            await store.write({
              name: decision.target.name,
              title: candidate.title ?? undefined,
              description: candidate.description,
              type: candidate.type,
              body: candidate.body,
              ...(candidate.importance !== undefined ? { importance: candidate.importance } : {}),
            }, decision.target.scope, cwd)
            written += 1
            continue
          }
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

  return {
    // 词集原料:最近 6 条 USER 行(剥前缀),拼接截 1200 字符防词集膨胀
    getQueryText: sessionId => {
      const cap = captures.get(sessionId)
      if (cap === undefined) return undefined
      const userLines = cap.lines.filter(line => line.startsWith('USER: ')).slice(-6)
      if (userLines.length === 0) return undefined
      return userLines.map(line => line.slice('USER: '.length)).join('\n').slice(0, 1200)
    },
    flush: () => Promise.allSettled([...active]).then(() => undefined),
    cleanup: sessionId => { captures.delete(sessionId) },
  }
}

// probe 1793306596
