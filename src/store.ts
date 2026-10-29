/**
 * 记忆存储层:类型化记忆文件 CRUD + MEMORY.md 索引维护。
 *
 * 关键设计决策(依据源码调研与对抗性审查,见 internal research notes):
 * 1. **必须用 node:fs 而非 ctx.fs**——默认部署的 fs-sandbox 可写根不含 $DSH_HOME,
 *    走 ctx.fs 会抛 FS_SANDBOX_DENIED;官方先例 skill-filesystem 访问 $DSH_HOME
 *    下的文件同样直接用 node:fs。
 * 2. **并发写用 @deepseek-ai/dsh-atomic-write**(writeFileAtomic + withFileLock),
 *    跨进程文件锁,Windows 兼容由官方包处理;孤儿锁由本层自愈(见 withLockRecovery)。
 * 3. **MEMORY.md 是派生物**:真相源是记忆文件集;每次写入/删除后全量重建索引,
 *    删空时直接移除索引文件(保证"无记忆不出段")。
 * 4. **不写自定义会话事件**——第三方事件类型会导致会话 resume 拒读。审计走 tool/result。
 * 5. **frontmatter 用 yaml 包解析**(skill-filesystem 同款)。
 * 6. **任何单个畸形/恶意文件都不得砖掉存储操作**:解析失败一律跳过(含不可归一化
 *    的 name),symlink 条目跳过(防止目录外内容被吸进索引注入系统提示词)。
 */

import { promises as fsp, lstatSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { MemoryEvidence, MemoryOrigin, MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from './types.ts'
import { USER_SCOPE_DIR } from './types.ts'

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'] as const

/** 索引文件名(派生物,随写入重建;删空时移除)。 */
export const INDEX_FILENAME = 'MEMORY.md'

/** 大小写不敏感文件系统(NTFS/APFS)上与索引文件冲突的保留名。 */
const RESERVED_NAMES = new Set(['memory'])

/**
 * 把会话 cwd 编码为文件系统安全的项目目录名。
 * 照抄官方算法(packages/session/session-persistence-jsonl/src/format.ts projectKey):
 * `/` `\` `:` 折叠为 `-`,非 [A-Za-z0-9._-] 字符转 `~XXXX` 大写十六进制,
 * 去前导 `-`,空串用 `root`,限长 251,整体包成 `--<slug>--`。
 * 与 $DSH_HOME/sessions 的目录命名一致(如 `--D-a-b--`)。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 归一化模型提供的记忆名:压缩为纯 kebab-case。
 * 只放行 [a-z0-9-],从根上消除路径攻击面(文件名即 `${name}.md`)。
 * `memory` 为保留字(大小写不敏感文件系统上与 MEMORY.md 撞名,写入会被静默销毁)。
 */
export function normalizeName(input: string): string {
  const slug = input.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`memory name must normalize to kebab-case [a-z0-9-] (got: ${JSON.stringify(input)})`)
  }
  if (RESERVED_NAMES.has(slug)) {
    throw new Error(`memory name "${slug}" is reserved (collides with the ${INDEX_FILENAME} index on case-insensitive filesystems); pick a more specific name`)
  }
  return slug
}

/** 校验并收窄记忆类型。 */
export function asMemoryType(raw: string): MemoryType {
  const hit = MEMORY_TYPES.find(t => t === raw)
  if (!hit) throw new Error(`invalid memory type: ${JSON.stringify(raw)} (expected one of ${MEMORY_TYPES.join('/')})`)
  return hit
}

/**
 * 文件锁 + 孤儿锁自愈(模块级,store 与审计共用,单一实现点):
 * 官方包设计"contender 永不移除已存在的锁,孤儿恢复是运维操作"——但交互式
 * CLI 的 Ctrl+C/崩溃会让 .lock 永久残留,砖掉此后所有写/删(审查确认的
 * major)。超时后检查锁内 pid:持有进程已死则回收锁重试一次;活进程持有则
 * 让超时错误冒泡(模型可读文案由工具层转译)。
 */
export async function withLockRecovery<T>(lockTarget: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(lockTarget, operation)
  } catch (error) {
    if (!/timed out waiting for the writer lock/.test(String(error))) throw error
    const lockPath = `${lockTarget}.lock`
    const pidRaw = await fsp.readFile(lockPath, 'utf8').catch(() => null)
    if (pidRaw === null) throw error // 锁已消失,让调用方按原错误重试语义处理
    const pid = Number.parseInt(pidRaw.trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) throw error
    let alive: boolean
    try {
      // Windows 上 pid 0 是 System Idle;process.kill(pid, 0) 仅探测不发送信号
      process.kill(pid, 0)
      alive = true
    } catch {
      alive = false
    }
    if (alive) throw error
    await fsp.rm(lockPath, { force: true })
    return await withFileLock(lockTarget, operation)
  }
}

/** 解析 frontmatter(参考 skill-filesystem parseFrontmatter,容忍 CRLF)。 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  for (;;) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const parsed = parseYaml(raw.slice(start, lineStart)) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return {
        data: parsed as Record<string, unknown>,
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * 解析导入溯源块;任何字段缺失/非法一律返回 undefined(按"无来源"处理,
 * 即不可撤销——fail-closed 方向:宁可撤销不了,也不能删错记忆)。
 */
export function parseOrigin(value: unknown): MemoryOrigin | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'claude-code') return undefined
  // 路径型标识限长:前端/面板永不回显该字段,但坏数据不应无限膨胀 frontmatter
  if (typeof raw.slug !== 'string' || raw.slug.length === 0 || raw.slug.length > 512) return undefined
  if (typeof raw.file !== 'string' || raw.file.length === 0 || raw.file.length > 512) return undefined
  if (typeof raw.imported !== 'number' || !Number.isSafeInteger(raw.imported) || raw.imported <= 0) return undefined
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]{16}$/.test(raw.hash)) return undefined
  return { kind: 'claude-code', slug: raw.slug, file: raw.file, importedMs: raw.imported, hash: raw.hash }
}

/**
 * 导入内容指纹(纯函数):type + 清洗后 description/body 的 sha256 前 16 位。
 * 写入路径全量继承导入时的值;撤销导入时与当前内容重算值比对,不等即视为
 * "导入后被改过"。长度 16 hex 足够(撤销是单机、按条比对,无碰撞压力)。
 */
export function contentFingerprint(fields: Pick<MemoryRecord, 'description' | 'type' | 'body'>): string {
  return createHash('sha256')
    .update(`${fields.type}\n${fields.description.trim()}\n${fields.body.trim()}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * 解析单个记忆文件内容;任何畸形(含不可归一化的 name)一律返回 null,
 * 绝不抛错——单个坏文件不得砖掉 list/write/delete(审查确认的 major 修复)。
 * 生命周期元数据(created/updated/lastRead/reads,毫秒)非法时静默忽略。
 * @param raw - 文件全文
 * @param scope - 所属作用域(由目录位置决定,文件内不存)
 */
export function parseMemory(raw: string, scope: MemoryScope): MemoryRecord | null {
  try {
    const fm = parseFrontmatter(raw)
    if (!fm) return null
    const { name, description, type, title, created, updated, lastRead, reads, pinned, importance, disabled, origin, status, evidence, supersededBy, supersedes } = fm.data
    if (typeof name !== 'string' || typeof description !== 'string' || description.trim().length === 0) return null
    const parsedType = type === undefined ? 'reference' : asMemoryType(String(type))
    const asMs = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
    const asCount = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const asImportance = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10 ? value : undefined
    const parsedOrigin = parseOrigin(origin)
    // 可信状态:非法枚举静默回退 undefined(信任态)——手改 YAML 写错不砖存储(现纪律)
    const parsedStatus = status === 'candidate' || status === 'verified' || status === 'disputed' || status === 'superseded'
      ? (status as MemoryStatus)
      : undefined
    // 证据链:两个成分都合法才保留(半截证据比没证据更骗人)
    const evidenceRaw = (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)) ? evidence as Record<string, unknown> : null
    const parsedEvidence = evidenceRaw !== null
      && typeof evidenceRaw.sessionId === 'string' && evidenceRaw.sessionId.length > 0
      && typeof evidenceRaw.quote === 'string' && evidenceRaw.quote.length > 0
      ? { sessionId: evidenceRaw.sessionId.slice(0, 128), quote: evidenceRaw.quote.slice(0, 400) }
      : undefined
    // #19 谱系指针:kebab-case 名(≤64;与 normalizeName 同形状但不复用——
    // 它抛异常且保留字 memory 会炸 parse,这里静默丢字段)
    const asLineage = (value: unknown): string | undefined =>
      typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64 ? value : undefined
    return {
      name: normalizeName(name),
      title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined,
      description: description.trim(),
      type: parsedType,
      body: fm.body.trim(),
      scope,
      ...(pinned === true ? { pinned: true } : {}),
      ...(disabled === true ? { disabled: true } : {}),
      ...(asImportance(importance) !== undefined ? { importance: asImportance(importance) } : {}),
      ...(parsedStatus !== undefined ? { status: parsedStatus } : {}),
      ...(parsedEvidence !== undefined ? { evidence: parsedEvidence } : {}),
      ...(asLineage(supersededBy) !== undefined ? { supersededBy: asLineage(supersededBy)! } : {}),
      ...(asLineage(supersedes) !== undefined ? { supersedes: asLineage(supersedes)! } : {}),
      ...(parsedOrigin !== undefined ? { origin: parsedOrigin } : {}),
      createdMs: asMs(created),
      updatedMs: asMs(updated),
      lastReadMs: asMs(lastRead),
      reads: asCount(reads),
    }
  } catch {
    return null // 坏 name/type 等统一跳过,与契约一致
  }
}

/** 序列化一条记忆为文件内容(frontmatter 由 yaml.stringify 正确转义特殊字符)。 */
export function serializeMemory(record: Omit<MemoryRecord, 'scope'>): string {
  const frontmatter = stringifyYaml({
    name: record.name,
    ...(record.title !== undefined ? { title: record.title } : {}),
    description: record.description,
    type: record.type,
    ...(record.pinned === true ? { pinned: true } : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(record.importance !== undefined ? { importance: record.importance } : {}),
    // 可信状态与证据链(1.0.0):status 缺省即信任态不落键;evidence 整块进出
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.evidence !== undefined ? { evidence: { sessionId: record.evidence.sessionId, quote: record.evidence.quote } } : {}),
    // #19 演化谱系(扁平两个 string;与 status 同款条件落盘)
    ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
    ...(record.supersedes !== undefined ? { supersedes: record.supersedes } : {}),
    // 导入溯源(嵌套块):字段名短、YAML 正确转义;缺省即普通记忆
    ...(record.origin !== undefined ? {
      origin: {
        kind: record.origin.kind,
        slug: record.origin.slug,
        file: record.origin.file,
        imported: record.origin.importedMs,
        hash: record.origin.hash,
      },
    } : {}),
    ...(record.createdMs !== undefined ? { created: record.createdMs } : {}),
    ...(record.updatedMs !== undefined ? { updated: record.updatedMs } : {}),
    ...(record.lastReadMs !== undefined ? { lastRead: record.lastReadMs } : {}),
    ...(record.reads !== undefined ? { reads: record.reads } : {}),
  }).trimEnd()
  return `---\n${frontmatter}\n---\n\n${record.body.trim()}\n`
}

/**
 * 覆盖写入时的元数据合并(纯函数,便于测试):
 * 首次写入生成 created/updated;更新保留 created 与读取计数,刷新 updated。
 */
export function mergeLifecycleMeta(existing: MemoryRecord | null, now: number): LifecycleMeta {
  return {
    createdMs: existing?.createdMs ?? now,
    updatedMs: now,
    ...(existing?.lastReadMs !== undefined ? { lastReadMs: existing.lastReadMs } : {}),
    ...(existing?.reads !== undefined ? { reads: existing.reads } : {}),
  }
}

/** 生命周期元数据子集。 */
export interface LifecycleMeta {
  createdMs: number
  updatedMs: number
  lastReadMs?: number
  reads?: number
}

/**
 * 渲染索引正文(一行一条)。排序:pinned 优先 → 三因子分(importance×recency,
 * 天粒度衰减保证当日稳定,不破坏 KV 前缀缓存)→ name 字典序稳定 tiebreak。
 */
export function renderIndexBody(records: MemoryRecord[]): string {
  const now = Date.now()
  // 软停用(#10):不注入但文件保留——与软淘汰同款"隐藏不删除"语义;
  // memory_list 与 memory_read 仍可见/可读,取消停用即恢复注入
  // 可信状态过滤(1.0.0):disputed(争议)与 superseded(被取代)不注入——
  // 与 disabled 同款"隐藏不删除"语义,文件保留、面板可见、可恢复;
  // candidate 照常注入(固化产物零行为破坏,验证引导交给体检榜)
  const visible = records.filter(record =>
    record.disabled !== true
    && record.status !== 'disputed'
    && record.status !== 'superseded')
  const ordered = [...visible].sort((a, b) => {
    const pa = a.pinned === true ? 0 : 1
    const pb = b.pinned === true ? 0 : 1
    if (pa !== pb) return pa - pb
    const sa = memoryScore(a, now)
    const sb = memoryScore(b, now)
    if (sa !== sb) return sb - sa
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const lines = ordered.map(r => `- [${r.title ?? r.name}](${r.name}.md)${r.pinned === true ? ' 📌' : ''} — ${r.description}`)
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** 判断路径是否为符号链接(读路径防护:防目录外内容被吸进索引注入系统提示词)。 */
function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false // 不存在按非链接处理,由调用方的存在性语义兜底
  }
}

/** 判断一条记忆是否"陈旧零引用"(软淘汰候选;纯函数,可测)。 */
export function isStale(record: MemoryRecord, staleAfterDays: number, nowMs: number): boolean {
  if (staleAfterDays <= 0) return false
  if (record.pinned === true) return false // 置顶保护:信任锚点,永不软淘汰
  if ((record.reads ?? 0) > 0) return false // 被读过的不淘汰
  const updated = record.updatedMs ?? record.createdMs
  if (updated === undefined) return false // 无生命周期元数据的旧文件不参与
  return nowMs - updated > staleAfterDays * 86_400_000
}

// ---------- P0.5 安全包:写入脱敏与协议标签防护 ----------

/** 高置信密钥/敏感串模式(曾在本项目亲历泄漏形态:ghp_/npm_/sk-)。 */
const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  // sk- 要求至少一位数字,避免误杀 sk-button-primary 等 kebab 命名(审查确认的误杀面)
  { kind: 'openai-key', re: /\bsk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}\b/g },
  // 认证 scheme 大小写不敏感(RFC 7235),真值部分需含 JWT 头或 =/(+ 拦 Basic base64)
  { kind: 'bearer', re: /\bbearer\s+(?:eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9_\-]{16,}[=+/][A-Za-z0-9_\-=/+]{10,})/gi },
  { kind: 'slack-token', re: /\bxox[bposa]-[0-9A-Za-z-]{10,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_\-]{30,}\b/g },
  { kind: 'phone', re: /\b1[3-9]\d{9}\b/g },
  { kind: 'id-card', re: /\b\d{17}[\dXx]\b/g },
]

/**
 * GB11643 身份证校验位验证:18 位号码仅当末位与加权模 11 校验相符才算真身份证。
 * 纯长度匹配会把订单号/雪花 ID 等任意 18 位数字一并误杀(#7)。
 */
function isValidIdCard(candidate: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(candidate)) return false
  const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
  const CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(candidate[i]) * WEIGHTS[i]
  return candidate[17].toUpperCase() === CHECKS[sum % 11]
}

/**
 * 写入前脱敏(纯函数,可测):把高置信密钥/手机号/身份证替换为 [REDACTED:kind]。
 * 应用于 description/body——所有写路径(工具/固化/面板)都经 store.write,单点拦截。
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, match => (kind === 'id-card' && !isValidIdCard(match) ? match : `[REDACTED:${kind}]`))
  }
  return out
}

/**
 * 入库前剥离注入协议标签字样(防闭合逃逸伪造)。匹配放宽到容忍空白/大小写/
 * 属性变体(LLM 分词器对这些变体的容忍度远高于词法精确匹配——审查确认
 * 单空格即可穿透精确形式)。转义后壳永远只有一层,内容无法闭壳。
 */
export function stripMemoryTags(text: string): string {
  return text
    .replace(/<\s*\/?\s*memory_context[^>]*>/gi, match => match.replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;')))
}

/** 写入内容统一清洗(脱敏 + 协议标签防护)。 */
/**
 * 指令注入模式检测(1.0.0 可信记忆;所有写入路径的单点防线,审查确认
 * 只挂固化路径会被 memory_write 直写绕过)。
 *
 * 词表纪律(对抗审查实测校准,漏报优于误报——误报会把合法记忆静默踢出
 * 注入):每条必须"指令动词+对象"结构齐全。裸名词("系统提示词"作为研究
 * 对象)与裸动词("扮演缓存角色")都不算——40% 误报的教训。
 */
const DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\b[^.]{0,40}\b(?:previous|prior|above|all)\b[^.]{0,20}\b(?:instructions?|prompts?|rules?)/i,
  /\byou\s+are\s+now\b/i,
  /\b(?:reveal|show|print|output|leak|expose)\b[^.]{0,30}\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /(?:忽略|无视)[^.]{0,20}(?:之前|上面|以上)[^.]{0,20}(?:指令|提示|规则)/,
  /(?:输出|泄露|打印)[^.]{0,15}系统提示词/,
]

/** 纯函数:文本是否命中指令注入模式(检测 body 与 description;title 过短误报高不查)。 */
export function detectDirectivePattern(text: string): boolean {
  return DIRECTIVE_PATTERNS.some(pattern => pattern.test(text))
}

function sanitizeContent(text: string): string {
  return stripMemoryTags(redactSecrets(text))
}

// ---------- P0.5 三因子排序(Generative Agents 公式的免 embedding 版) ----------

/** 各类型缺省重要度(1-10;固化时 LLM 可显式覆盖)。 */
export const DEFAULT_IMPORTANCE: Readonly<Record<MemoryType, number>> = {
  feedback: 8,
  user: 7,
  project: 6,
  reference: 4,
}

/**
 * 三因子评分(纯函数):importance × recency(0.995^天,天粒度取整保证当日稳定,
 * 不破坏 KV 前缀缓存)。relevance 需查询上下文,仅用于读取场景,不进注入排序。
 */
export function memoryScore(record: MemoryRecord, nowMs: number): number {
  const importance = record.importance ?? DEFAULT_IMPORTANCE[record.type]
  const anchor = record.lastReadMs ?? record.updatedMs ?? record.createdMs
  if (anchor === undefined) return importance // 无时间锚的旧文件:只看重要度
  const days = Math.max(0, Math.floor((nowMs - anchor) / 86_400_000))
  return importance * Math.pow(0.995, days)
}

/**
 * 描述相似度(Jaccard 词集,含 CJK bigram):固化防回声的查重依据。
 * 0.7.0 起算法单一实现点在 matching.ts,此处再导出以兼容既有导入。
 */
export { descriptionSimilarity } from './matching.ts'

/**
 * 记忆存储:管理 memoryDir 下两层目录。
 * 布局:memoryDir/--<project-slug>--/*.md 与 memoryDir/_user/*.md(各含 MEMORY.md)。
 */
/** write 入参:origin 只提供来源三要素,内容指纹由 store 清洗后计算。 */
export interface MemoryWriteInput extends Omit<MemoryRecord, 'scope' | 'origin'> {
  /** 导入桥专用:目标层已有同名记忆时放弃写入(锁内判定,返回 null)。 */
  onlyIfAbsent?: boolean
  origin?: Omit<MemoryOrigin, 'hash'>
}

export class MemoryStore {
  constructor(rootDir: string, options?: { staleAfterDays?: number }) {
    this.rootDir = rootDir
    this.staleAfterDays = options?.staleAfterDays ?? 0
  }

  private readonly rootDir: string
  /** 软淘汰阈值(天);0 = 禁用。索引重建时评估:陈旧零引用的记忆从索引隐藏(文件保留)。 */
  private readonly staleAfterDays: number

  /** 作用域对应目录;project 作用域必须携带会话 cwd(绝不静默回退 process.cwd())。 */
  dir(scope: MemoryScope, cwd?: string): string {
    if (scope === 'user') return join(this.rootDir, USER_SCOPE_DIR)
    if (cwd === undefined) throw new Error('project scope requires a session cwd (refusing to fall back to process.cwd())')
    return join(this.rootDir, projectKey(cwd))
  }

  /** 列出指定作用域全部记忆(畸形文件与 symlink 跳过;按 name 稳定排序)。 */
  async list(scope: MemoryScope, cwd?: string): Promise<MemoryRecord[]> {
    const dir = this.dir(scope, cwd)
    let dirents
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return [] // 目录不存在 = 无记忆
    }
    const records: MemoryRecord[] = []
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue
      if (dirent.name.toLowerCase() === INDEX_FILENAME.toLowerCase()) continue
      const file = join(dir, dirent.name)
      if (isSymlink(file)) continue
      const raw = await fsp.readFile(file, 'utf8').catch(() => null)
      const record = raw === null ? null : parseMemory(raw, scope)
      if (record) records.push(record)
    }
    return records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** 读单条记忆;不存在/为 symlink/畸形返回 null。 */
  async read(name: string, scope: MemoryScope, cwd?: string): Promise<MemoryRecord | null> {
    const file = join(this.dir(scope, cwd), `${normalizeName(name)}.md`)
    if (isSymlink(file)) return null
    const raw = await fsp.readFile(file, 'utf8').catch(() => null)
    return raw === null ? null : parseMemory(raw, scope)
  }

  /** 按优先级在多个作用域检索 name。 */
  async findIn(name: string, scopes: readonly MemoryScope[], cwd?: string): Promise<MemoryRecord | null> {
    for (const scope of scopes) {
      const record = await this.read(name, scope, cwd)
      if (record !== null) return record
    }
    return null
  }

  /** 合并两层作用域的全部记忆(用户级在前)。 */
  async listAll(cwd?: string): Promise<MemoryRecord[]> {
    return [...await this.list('user'), ...await this.list('project', cwd)]
  }

  /**
   * 写入(同名覆盖=更新),并在文件锁内重建该作用域索引。
   * 锁对象是索引文件:同一 workspace 的写/删串行化,跨进程安全;
   * 孤儿锁(Ctrl+C/崩溃残留)自动回收(见 withLockRecovery)。
   */
  async write(record: MemoryWriteInput, scope: MemoryScope, cwd?: string): Promise<MemoryRecord | null> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${record.name}.md`)
    // withFileLock 要求父目录已存在,先建目录再取锁
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    let written: MemoryRecord | undefined
    await withLockRecovery(join(dir, INDEX_FILENAME), async () => {
      // 锁内读旧记录拿生命周期基线(created/读取计数跨更新保留)
      const existing = parseMemory(
        await fsp.readFile(file, 'utf8').catch(() => ''),
        scope,
      )
      // onlyIfAbsent(导入桥):同名判定下沉锁内,杜绝锁外快照的 TOCTOU
      // (导入期间并发写入的同名记忆会被覆盖);命中即放弃本次写入,返回 null
      // 固化候选显式带 status(sanitize 恒带 candidate)不允许复活 superseded
      // 文件(审查 major:同名候选 create 路径会覆写 superseded 文件使其重新
      // 注入)——superseded 只能经用户面板 restore 离开
      if (record.onlyIfAbsent === true && existing !== null) return
      // 可信状态与证据链(1.0.0,审查后统一单点语义):
      // - 调用方显式传 status → 按传入值(面板 verify/dispute/restore 是唯一
      //   人工流转入口;固化候选自带 candidate/disputed)
      // - 调用方未传且内容相对 existing **发生变化** → 信任重评:
      //   verified/candidate 降回 candidate(内容变了,旧验证不覆盖新内容);
      //   undefined(用户手写信任态)保持;disputed/superseded 保留(fail-closed)
      //   同时旧 evidence 失效(逐字引用罩不住新内容)
      // - 内容未变(纯 echo 刷新/置顶停用等元数据写) → 原样继承,verified
      //   不被常规流量冲掉(审查 major:复述刷新剥验证)
      // - 注入扫描在 store 单点:body/description 命中指令注入模式 → disputed。
      //   只挂固化路径会被 memory_write 直写绕过(审查 major:guard 整体可绕)
      const pinned = record.pinned ?? existing?.pinned
      const disabled = record.disabled ?? existing?.disabled
      const importance = record.importance ?? existing?.importance
      const title = record.title ?? existing?.title
      // 安全包:所有写入路径统一过脱敏 + 协议标签防护(单点拦截,含 title——
      // title 进索引行即注入内容,绕过即穿透壳/泄密,审查 blocker)
      const description = sanitizeContent(record.description)
      const body = sanitizeContent(record.body)
      const contentChanged = existing !== null
        && (existing.description !== description || existing.body !== body || existing.type !== record.type)
      // #19 superseded 复活守卫(审查 major):固化候选(sanitize 恒带 status
      // 'candidate')不允许覆写 superseded 文件——create 路径的同名候选会把它
      // 复活重新注入,与谱系语义矛盾。superseded 只能经用户面板显式 restore
      // 离开(显式传其它 status)。放在内容计算后:面板 restore 传 'candidate'
      // 是显式传值(record.status !== undefined),不受此守卫影响——守卫只拦
      // "status === 'candidate' 且内容变化"的固化形态。
      if (existing?.status === 'superseded' && record.status === 'candidate' && contentChanged) return
      let status = record.status ?? existing?.status
      if (record.status === undefined && contentChanged) {
        if (existing?.status === 'verified' || existing?.status === 'candidate') status = 'candidate'
      }
      if (record.status === undefined && (detectDirectivePattern(body) === true || detectDirectivePattern(description) === true)) status = 'disputed'
      // evidence.quote 是自由文本(固化模型提供),与 description/body 同过
      // sanitizeContent 单点清洗;内容变化且调用方未带新证据 → 旧证据失效
      const evidenceSource = record.evidence ?? (contentChanged ? undefined : existing?.evidence)
      const evidence: MemoryEvidence | undefined = evidenceSource !== undefined
        ? { sessionId: evidenceSource.sessionId, quote: sanitizeContent(evidenceSource.quote) }
        : undefined
      // #19 谱系指针继承(防面板整条重写剥链——toggleFlag/setStatus 不带谱系字段);
      // 离开 superseded 态(显式传非 superseded 的 status)时清 supersededBy(链只活在被取代态)
      const supersededBy = status === 'superseded' ? (record.supersededBy ?? existing?.supersededBy) : undefined
      const supersedes = record.supersedes ?? existing?.supersedes
      // 导入溯源:首次导入按清洗后内容算指纹;后续任何写入(工具/固化/面板
      // 置顶停用)原样继承首次指纹,绝不重算——指纹只标记"导入瞬间的内容",
      // 撤销时用它判定这条是否已被改过。内容更新不重算 ≠ 指纹失效,比对时
      // 当前内容重算值自然对不上,落进"已修改,保留"分支。
      const origin: MemoryOrigin | undefined = record.origin !== undefined
        ? { ...record.origin, hash: contentFingerprint({ description, type: record.type, body }) }
        : existing?.origin
      // origin/onlyIfAbsent 是 write 入参专用字段,不落盘;先剥离再展开
      const fields: Omit<MemoryRecord, 'scope' | 'origin'> = record
      const next: MemoryRecord = {
        ...fields,
        ...(pinned === true ? { pinned: true } : {}),
        ...(disabled === true ? { disabled: true } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
        ...(supersededBy !== undefined ? { supersededBy } : {}),
        ...(supersedes !== undefined ? { supersedes } : {}),
        ...(title !== undefined ? { title: sanitizeContent(title) } : {}),
        description,
        body,
        ...(origin !== undefined ? { origin } : {}),
        ...mergeLifecycleMeta(existing, Date.now()),
        // 显式传入的时间戳优先(导入桥保留 Claude 原始 modified;
        // 现有写入路径不传,行为不变——mergeLifecycleMeta 的 now 语义照旧)
        ...(record.createdMs !== undefined ? { createdMs: record.createdMs } : {}),
        ...(record.updatedMs !== undefined ? { updatedMs: record.updatedMs } : {}),
        scope,
      }
      written = next
      await writeFileAtomic(file, serializeMemory(next), { mode: 0o600, dirMode: 0o700 })
      await this.rebuildIndex(scope, cwd)
    })
    // onlyIfAbsent 命中(锁内提前 return)时 written 未赋值 → null 表示未写入
    return written ?? null
  }

  /**
   * 记录一次读取(遗忘策略的引用计数):锁内重写 frontmatter 的 reads/lastRead。
   * best-effort:任何失败只放弃计数,绝不让 memory_read 因计数而失败。
   */
  async touch(name: string, scope: MemoryScope, cwd?: string): Promise<void> {
    try {
      const dir = this.dir(scope, cwd)
      const file = join(dir, `${normalizeName(name)}.md`)
      if (!(await fsp.stat(file).then(() => true, () => false))) return
      await withLockRecovery(join(dir, INDEX_FILENAME), async () => {
        const record = parseMemory(await fsp.readFile(file, 'utf8').catch(() => ''), scope)
        if (record === null) return
        // 仅当旧记录当前处于"零引用超龄"隐藏态(本次计数会使其复活)才重建索引;
        // 行为决策(非纯优化,审查修正注释):仅在旧记录处于"零引用超龄"隐藏态
        // (本次计数会使其复活)时才重建索引。lastReadMs 是三因子排序锚点,
        // 若每次 touch 都重建,注入段文本会随每次 memory_read 抖动、打击 KV
        // 前缀缓存——故接受"排序到下次 write/delete/refresh 才生效"的延迟。
        const visibilityWillChange = isStale(record, this.staleAfterDays, Date.now())
        const touched: MemoryRecord = {
          ...record,
          reads: (record.reads ?? 0) + 1,
          lastReadMs: Date.now(),
        }
        await writeFileAtomic(file, serializeMemory(touched), { mode: 0o600, dirMode: 0o700 })
        if (visibilityWillChange) await this.rebuildIndex(scope, cwd)
      })
    } catch {
      // 计数失败静默:索引/读取不受影响
    }
  }

  /**
   * 清空一个作用域的全部记忆(含索引);返回真实删除条数。
   * 整个删除在单个锁窗口内完成(审查 major 修复:快照-逐条删除会让并发 write
   * 逃过"Delete ALL"语义——同 workspace 的自动固化/另一会话写入会残留),
   * 单条失败跳过并如实计数,不虚报。
   */
  async clear(scope: MemoryScope, cwd?: string): Promise<number> {
    const dir = this.dir(scope, cwd)
    let removed = 0
    try {
      await withLockRecovery(join(dir, INDEX_FILENAME), async () => {
        let entries: string[]
        try {
          entries = await fsp.readdir(dir)
        } catch {
          return // 目录不存在 = 无记忆
        }
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue // 跳过 .lock/.tmp 及无关文件
          if (entry.toLowerCase() === INDEX_FILENAME.toLowerCase()) continue
          try {
            await fsp.unlink(join(dir, entry))
            removed += 1
          } catch {
            // 单条失败(占用/权限)跳过,如实计数
          }
        }
        await fsp.rm(join(dir, INDEX_FILENAME), { force: true })
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return removed
      throw error
    }
    return removed
  }

  /**
   * 带锁重算一次索引(会话启动挂点用):软淘汰是惰性评估,无新写入的仓库
   * 需要外部触发刷新,否则 staleAfterDays 永不兑现(审查 major 修复)。静默失败。
   */
  async refreshIndex(scope: MemoryScope, cwd?: string): Promise<void> {
    const dir = this.dir(scope, cwd)
    const dirExists = await fsp.stat(dir).then(() => true, () => false)
    if (!dirExists) return
    await withLockRecovery(join(dir, INDEX_FILENAME), () => this.rebuildIndex(scope, cwd))
      .catch(() => {}) // 刷新失败不阻塞任何路径
  }

  /** 删除单条并重建索引;不存在/目录消失返回 false。 */
  async delete(name: string, scope: MemoryScope, cwd?: string): Promise<boolean> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${normalizeName(name)}.md`)
    let removed = false
    try {
      await withLockRecovery(join(dir, INDEX_FILENAME), async () => {
        try {
          await fsp.unlink(file)
        } catch {
          removed = false
          return
        }
        removed = true
        await this.rebuildIndex(scope, cwd)
      })
    } catch (error) {
      // 目录在 stat 与取锁之间被外部删除:归一化为"无记忆可删"
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
    return removed
  }

  /**
   * 条件删除:锁内重新解析记录并执行 predicate,满足才 unlink + 重建索引。
   * 撤销导入专用——"来源匹配 + 内容指纹未变"的判定与删除必须在同一锁窗口内,
   * 否则扫描与删除之间的编辑会被静默抹掉(与 onlyIfAbsent 同一套 TOCTOU 纪律)。
   * 文件不存在/被并发删除返回 false。
   */
  async deleteIf(
    name: string,
    scope: MemoryScope,
    cwd: string | undefined,
    predicate: (record: MemoryRecord) => boolean,
  ): Promise<boolean> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${normalizeName(name)}.md`)
    let removed = false
    try {
      await withLockRecovery(join(dir, INDEX_FILENAME), async () => {
        const record = parseMemory(await fsp.readFile(file, 'utf8').catch(() => ''), scope)
        if (record === null || !predicate(record)) return
        try {
          await fsp.unlink(file)
        } catch {
          return
        }
        removed = true
        await this.rebuildIndex(scope, cwd)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
    return removed
  }

  /**
   * 带孤儿锁自愈的文件锁:官方包设计"contender 永不移除已存在的锁,孤儿恢复是
   * 运维操作"——但交互式 CLI 的 Ctrl+C/崩溃会让 .lock 永久残留,砖掉此后所有
   * 写/删(审查确认的 major)。此处超时后检查锁内 pid:持有进程已死则回收重试一次。
   */
  /** 全量重建指定作用域的 MEMORY.md(须持锁调用);删空时移除索引文件。
   *  软淘汰:staleAfterDays>0 时,陈旧零引用的记忆不进索引(文件保留,memory_list 可见)。 */
  private async rebuildIndex(scope: MemoryScope, cwd?: string): Promise<void> {
    const dir = this.dir(scope, cwd)
    const records = await this.list(scope, cwd)
    const visible = records.filter(record => !isStale(record, this.staleAfterDays, Date.now()))
    const indexFile = join(dir, INDEX_FILENAME)
    if (visible.length === 0) {
      await fsp.rm(indexFile, { force: true })
      return
    }
    await writeFileAtomic(indexFile, renderIndexBody(visible), { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * 同步读取索引正文(供系统提示词 text 函数;索引有 maxBytes 预算,直接读盘成本可忽略,
   * 不做缓存——mtime/size 缓存在粗时间戳文件系统上会注入陈旧索引,审查确认为隐患)。
   * 文件缺失/symlink/损坏返回 null。
   */
  readIndexSync(scope: MemoryScope, cwd?: string): string | null {
    const file = join(this.dir(scope, cwd), INDEX_FILENAME)
    if (isSymlink(file)) return null
    try {
      const text = readFileSync(file, 'utf8')
      return text.trim().length > 0 ? text : null
    } catch {
      return null
    }
  }
}
