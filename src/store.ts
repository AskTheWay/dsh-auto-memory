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
 * 生命周期元数据(created/updated/lastRead/reads,毫秒)非法时静默忽略。
 * @param raw - 文件全文
 * @param scope - 所属作用域(由目录位置决定,文件内不存)
 */
export function parseMemory(raw: string, scope: MemoryScope): MemoryRecord | null {
  try {
    const fm = parseFrontmatter(raw)
    if (!fm) return null
    const { name, description, type, title, created, updated, lastRead, reads, pinned } = fm.data
    if (typeof name !== 'string' || typeof description !== 'string' || description.trim().length === 0) return null
    const parsedType = type === undefined ? 'reference' : asMemoryType(String(type))
    const asMs = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
    const asCount = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    return {
      name: normalizeName(name),
      title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined,
      description: description.trim(),
      type: parsedType,
      body: fm.body.trim(),
      scope,
      ...(pinned === true ? { pinned: true } : {}),
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
 * 渲染索引正文(一行一条)。排序:pinned 优先(组内 name 字典序)——置顶条目排在
 * 索引最前,注入预算截断(按行保前)因此天然优先保留它们;顺序对 KV 前缀缓存
 * 保持稳定(仅在 pinned 状态变化时移动)。无标题行;空列表返回空串。
 */
export function renderIndexBody(records: MemoryRecord[]): string {
  const byName = (a: MemoryRecord, b: MemoryRecord) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const ordered = [...records].sort((a, b) => {
    const pa = a.pinned === true ? 0 : 1
    const pb = b.pinned === true ? 0 : 1
    return pa !== pb ? pa - pb : byName(a, b)
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

/**
 * 记忆存储:管理 memoryDir 下两层目录。
 * 布局:memoryDir/--<project-slug>--/*.md 与 memoryDir/_user/*.md(各含 MEMORY.md)。
 */
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
  async write(record: Omit<MemoryRecord, 'scope'>, scope: MemoryScope, cwd?: string): Promise<MemoryRecord> {
    const dir = this.dir(scope, cwd)
    const file = join(dir, `${record.name}.md`)
    // withFileLock 要求父目录已存在,先建目录再取锁
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    let written: MemoryRecord
    await this.withLockRecovery(join(dir, INDEX_FILENAME), async () => {
      // 锁内读旧记录拿生命周期基线(created/读取计数跨更新保留)
      const existing = parseMemory(
        await fsp.readFile(file, 'utf8').catch(() => ''),
        scope,
      )
      // pinned 语义:显式 true/false 设置/取消;未提及时继承现状(与 created 同类)
      const pinned = record.pinned ?? existing?.pinned
      written = { ...record, ...(pinned === true ? { pinned: true } : {}), ...mergeLifecycleMeta(existing, Date.now()), scope }
      await writeFileAtomic(file, serializeMemory(written), { mode: 0o600, dirMode: 0o700 })
      await this.rebuildIndex(scope, cwd)
    })
    return written!
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
      await this.withLockRecovery(join(dir, INDEX_FILENAME), async () => {
        const record = parseMemory(await fsp.readFile(file, 'utf8').catch(() => ''), scope)
        if (record === null) return
        // 仅当旧记录当前处于"零引用超龄"隐藏态(本次计数会使其复活)才重建索引;
        // 否则 reads/lastRead 不进索引正文,重建产出逐字节相同——纯 O(N) 浪费(审查 major 修复)
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
      await this.withLockRecovery(join(dir, INDEX_FILENAME), async () => {
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
    await this.withLockRecovery(join(dir, INDEX_FILENAME), () => this.rebuildIndex(scope, cwd))
      .catch(() => {}) // 刷新失败不阻塞任何路径
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
