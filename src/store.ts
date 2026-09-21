/**
 * 记忆存储层:类型化记忆文件 CRUD + MEMORY.md 索引维护。
 *
 * 关键设计决策(依据源码调研与对抗性审查,见 docs/api-reports.md):
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
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { MemoryRecord, MemoryScope, MemoryType } from './types.ts'
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
 * 解析单个记忆文件内容;任何畸形(含不可归一化的 name)一律返回 null,
 * 绝不抛错——单个坏文件不得砖掉 list/write/delete(审查确认的 major 修复)。
 * @param raw - 文件全文
 * @param scope - 所属作用域(由目录位置决定,文件内不存)
 */
export function parseMemory(raw: string, scope: MemoryScope): MemoryRecord | null {
  try {
    const fm = parseFrontmatter(raw)
    if (!fm) return null
    const { name, description, type, title } = fm.data
    if (typeof name !== 'string' || typeof description !== 'string' || description.trim().length === 0) return null
    const parsedType = type === undefined ? 'reference' : asMemoryType(String(type))
    return {
      name: normalizeName(name),
      title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined,
      description: description.trim(),
      type: parsedType,
      body: fm.body.trim(),
      scope,
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
  }).trimEnd()
  return `---\n${frontmatter}\n---\n\n${record.body.trim()}\n`
}

/**
 * 渲染索引正文(一行一条,按 name 排序保证跨 rebuild 稳定——索引文本稳定
 * 才能保住 KV 前缀缓存)。无标题行:标题由注入层统一添加;空列表返回空串。
 */
export function renderIndexBody(records: MemoryRecord[]): string {
  const ordered = [...records].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const lines = ordered.map(r => `- [${r.title ?? r.name}](${r.name}.md) — ${r.description}`)
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

/**
 * 记忆存储:管理 memoryDir 下两层目录。
 * 布局:memoryDir/--<project-slug>--/*.md 与 memoryDir/_user/*.md(各含 MEMORY.md)。
 */
export class MemoryStore {
  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  private readonly rootDir: string

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

  /**
   * 写入(同名覆盖=更新),并在文件锁内重建该作用域索引。
   * 锁对象是索引文件:同一 workspace 的写/删串行化,跨进程安全;
   * 孤儿锁(Ctrl+C/崩溃残留)自动回收(见 withLockRecovery)。
   */
  async write(record: Omit<MemoryRecord, 'scope'>, scope: MemoryScope, cwd?: string): Promise<MemoryRecord> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${record.name}.md`)
    // withFileLock 要求父目录已存在,先建目录再取锁
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await this.withLockRecovery(join(dir, INDEX_FILENAME), async () => {
      await writeFileAtomic(file, serializeMemory(record), { mode: 0o600, dirMode: 0o700 })
      await this.rebuildIndex(scope, cwd)
    })
    return { ...record, scope }
  }

  /** 删除单条并重建索引;不存在/目录消失返回 false。 */
  async delete(name: string, scope: MemoryScope, cwd?: string): Promise<boolean> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${normalizeName(name)}.md`)
    let removed = false
    try {
      await this.withLockRecovery(join(dir, INDEX_FILENAME), async () => {
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
   * 带孤儿锁自愈的文件锁:官方包设计"contender 永不移除已存在的锁,孤儿恢复是
   * 运维操作"——但交互式 CLI 的 Ctrl+C/崩溃会让 .lock 永久残留,砖掉此后所有
   * 写/删(审查确认的 major)。此处超时后检查锁内 pid:持有进程已死则回收重试一次。
   */
  private async withLockRecovery<T>(lockTarget: string, operation: () => Promise<T>): Promise<T> {
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
      if (alive) throw error // 活进程真持有,让超时错误冒泡(模型可读文案由工具层转译)
      await fsp.rm(lockPath, { force: true })
      return await withFileLock(lockTarget, operation)
    }
  }

  /** 全量重建指定作用域的 MEMORY.md(须持锁调用);删空时移除索引文件。 */
  private async rebuildIndex(scope: MemoryScope, cwd?: string): Promise<void> {
    const dir = this.dir(scope, cwd)
    const records = await this.list(scope, cwd)
    const indexFile = join(dir, INDEX_FILENAME)
    if (records.length === 0) {
      await fsp.rm(indexFile, { force: true })
      return
    }
    await writeFileAtomic(indexFile, renderIndexBody(records), { mode: 0o600, dirMode: 0o700 })
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
