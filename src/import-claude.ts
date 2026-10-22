/**
 * 0.8.0:Claude Code 记忆导入桥(scan → 预览确认 → run)。
 * 0.10.0:导入溯源与撤销——每条导入记忆在 frontmatter 记 `origin`(slug/源文件/
 * 导入时间/内容指纹),面板按条目勾选;取消勾选已导入条目即撤销(删除)该条,
 * 导入后被编辑过的(指纹对不上)一律保留,只标注"已修改"。
 *
 * 背景:官方讨论区记忆类第一诉求是"把 Claude Code/Codex 的 memory 迁移
 * 过来"(#14);本插件数据模型与 Claude Code auto-memory 同构(MEMORY.md
 * 派生索引 + 单文件 frontmatter + 同款四类型),导入只需字段对齐,不涉及
 * 语义转换——全生态迁移成本最低。UI 流:面板按钮 → scan(只读预览)→
 * 用户勾选确认 → run(查重跳过 + 走 store.write 安全层 + 索引自动重建)。
 *
 * 格式对齐(2026-10-17 对本机 12 条真实样本实测):
 * - name/description:顶层直传(name 经 normalizeName,失败即用文件名重试)
 * - metadata.type → type:四枚举一致;未知/缺失缺省 reference
 * - title:Claude 无此字段,从正文第一个 H1 提取(≤80),无则缺省
 * - metadata.modified(ISO)→ createdMs/updatedMs(epoch);缺失用当前时间
 * - 正文:frontmatter 之后全文直传(redactSecrets/stripMemoryTags 由
 *   store.write 单点拦截,与工具/固化/面板同一条防线)
 *
 * 项目归属(slug 有损反解的精确解):Claude 的目录名把非字母数字全折叠为
 * '-',无法无歧义还原原路径;但项目目录下的 session *.jsonl 每条记录带
 * 真实 cwd——读首条含 cwd 的行即得精确路径(流式读头部,不整读大文件)。
 * 无 jsonl 的冷目录 → cwd=null → 该项目只能导入用户层(UI 明示)。
 *
 * 跨平台:源根 = join(homedir, '.claude', 'projects'),三平台同构;
 * 路径折叠用既有 projectKey(Windows/POSIX 双形态均有测试)。POSIX slug
 * 以 '-' 开头属正常形态,本模块不解析 slug(路径一律来自 jsonl cwd)。
 */

import { promises as fsp } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { contentFingerprint, normalizeName, projectKey, redactSecrets, stripMemoryTags } from './store.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryRecord, MemoryScope, MemoryType } from './types.ts'

const MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])
/** jsonl 头部读取上限:cwd 在首条记录就有,绝不整读数十 MB 的会话日志。 */
const CWD_HEAD_BYTES = 262_144

/** 解析后的单条 Claude 记忆(导入中间态)。 */
export interface ClaudeImportItem {
  name: string
  title?: string
  description: string
  type: MemoryType
  body: string
  modifiedMs?: number
}

/** 单条源记忆在目标层的关联状态(撤销导入的依据)。 */
export type ClaudeFileState =
  /** 目标层尚无同名记忆:勾选 = 导入。 */
  | 'pending'
  /** 就是这条导入的,且导入后内容未变:取消勾选 = 撤销(删除)。 */
  | 'imported'
  /** 来源匹配但内容指纹已变(导入后被编辑):保留,不可自动撤销。 */
  | 'modified'
  /** 0.8.0 旧导入(无 origin)但内容与源完全一致:可撤销。 */
  | 'legacy'
  /** 同名记忆已被别的来源/手工写入占用:保留,不导入也不撤销。 */
  | 'conflict'

/** 单文件解析预检结果(供 scan 预览,不落盘)。 */
export interface ScannedFile {
  file: string
  ok: boolean
  reason?: string
  /** 解析出的目标记忆名(ok 时必有)。 */
  name?: string
  description?: string
  type?: MemoryType
  /** 源内容指纹(与落盘指纹同口径);识别 0.8.0 无 origin 的旧导入用。 */
  fingerprint?: string
  /** 目标层关联状态;scan 阶段留空,annotateClaudeImport 填充。 */
  state?: ClaudeFileState
}

/** 一个 Claude 项目的扫描结果。 */
export interface ClaudeProjectScan {
  slug: string
  sourceDir: string
  /** jsonl 反解出的原工作区路径;null = 无法定位(只能导入用户层)。 */
  cwd: string | null
  files: ScannedFile[]
  importable: number
}

/** 整体扫描结果(home 下无 .claude/projects 时 projects 为空)。 */
export interface ClaudeScanResult {
  home: string
  projects: ClaudeProjectScan[]
  totalImportable: number
}

/** 剥离 frontmatter:返回 [yaml 对象|null, 正文]。 */
function splitFrontmatter(raw: string): [Record<string, unknown> | null, string] {
  if (!raw.startsWith('---')) return [null, raw]
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return [null, raw]
  const head = raw.slice(3, end).replace(/^\r?\n/, '')
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  try {
    const parsed = parseYaml(head)
    return [parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null, body]
  } catch {
    return [null, body]
  }
}

/** 从正文提取第一个 H1 作 title(≤80 截断);无 H1 返回 undefined。 */
function titleFromBody(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim())
    if (match !== null) return match[1].trim().slice(0, 80)
    if (line.trim().length > 0 && !line.trim().startsWith('#')) break // 正文已开始,不再找标题
  }
  return undefined
}

/** normalizeName 的安全包装:不可归一化(如中文)抛错而非返回 null——转成 null 供回退。 */
function tryNormalize(raw: string): string | null {
  try {
    return normalizeName(raw)
  } catch {
    return null
  }
}

/** 解析单条 Claude 记忆文件;name/description 缺失或不可归一化返回 null。 */
export function parseClaudeMemory(raw: string, fallbackName: string): ClaudeImportItem | null {
  const [front, body] = splitFrontmatter(raw)
  if (front === null) return null
  const description = typeof front.description === 'string' ? front.description.trim().slice(0, 160) : ''
  if (description.length === 0) return null
  const metadata = (front.metadata !== null && typeof front.metadata === 'object') ? front.metadata as Record<string, unknown> : {}
  const rawType = typeof metadata.type === 'string' ? metadata.type : undefined
  const type: MemoryType = rawType !== undefined && MEMORY_TYPES.has(rawType) ? rawType as MemoryType : 'reference'
  const name = tryNormalize(typeof front.name === 'string' ? front.name : '') ?? tryNormalize(fallbackName)
  if (name === null || name.length === 0) return null
  const title = titleFromBody(body)
  const modifiedMs = typeof metadata.modified === 'string' ? Date.parse(metadata.modified) : Number.NaN
  return {
    name, description, type,
    body: body.trim().slice(0, 4000),
    ...(title !== undefined ? { title } : {}),
    ...(Number.isFinite(modifiedMs) ? { modifiedMs } : {}),
  }
}

/** 源内容指纹:与 store 落盘指纹同口径(先脱敏/剥标签,再算 type+desc+body)。 */
function sourceFingerprint(item: ClaudeImportItem): string {
  return contentFingerprint({
    description: stripMemoryTags(redactSecrets(item.description)),
    type: item.type,
    body: stripMemoryTags(redactSecrets(item.body)),
  })
}

/**
 * 从项目目录的 session jsonl 头部提取真实 cwd(流式读 CWD_HEAD_BYTES;
 * 逐行 JSON.parse,首个含 cwd 的记录胜出)。无 jsonl / 无 cwd → null。
 */
export async function extractCwdFromSessions(projectDir: string): Promise<string | null> {
  let entries
  try {
    entries = await fsp.readdir(projectDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const handle = await open(join(projectDir, entry.name), 'r')
      try {
        const buffer = Buffer.alloc(CWD_HEAD_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, CWD_HEAD_BYTES, 0)
        const head = buffer.toString('utf8', 0, bytesRead)
        for (const line of head.split('\n')) {
          if (!line.includes('"cwd"')) continue
          try {
            const record = JSON.parse(line) as { cwd?: unknown }
            if (typeof record.cwd === 'string' && record.cwd.length > 0) return record.cwd
          } catch { continue }
        }
      } finally {
        await handle.close()
      }
    } catch { continue } // 单个 jsonl 读取失败:试下一个
  }
  return null
}

/** 扫描 homedir 下全部 Claude Code 项目的记忆(只读,无任何副作用)。 */
export async function scanClaudeMemory(homeDir: string): Promise<ClaudeScanResult> {
  const root = join(homeDir, '.claude', 'projects')
  const projects: ClaudeProjectScan[] = []
  let entries: string[] = []
  try {
    entries = await fsp.readdir(root)
  } catch {
    return { home: root, projects, totalImportable: 0 } // 未装 Claude Code:空结果
  }
  for (const slug of entries.sort()) {
    const memoryDir = join(root, slug, 'memory')
    let files: string[] = []
    try {
      files = (await fsp.readdir(memoryDir)).filter(f => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'memory.md')
    } catch { continue } // 无 memory 子目录:跳过该项目
    if (files.length === 0) continue
    const scanned: ScannedFile[] = []
    for (const file of files) {
      const raw = await fsp.readFile(join(memoryDir, file), 'utf8').catch(() => null)
      if (raw === null) { scanned.push({ file, ok: false, reason: 'unreadable' }); continue }
      const item = parseClaudeMemory(raw, file.replace(/\.md$/i, ''))
      scanned.push(item === null
        ? { file, ok: false, reason: 'unparsable' }
        : { file, ok: true, name: item.name, description: item.description, type: item.type, fingerprint: sourceFingerprint(item) })
    }
    const importable = scanned.filter(s => s.ok).length
    if (importable === 0) continue
    projects.push({
      slug,
      sourceDir: memoryDir,
      cwd: await extractCwdFromSessions(join(root, slug)),
      files: scanned,
      importable,
    })
  }
  return { home: root, projects, totalImportable: projects.reduce((sum, p) => sum + p.importable, 0) }
}

/** 来源是否匹配某条 Claude 源文件(撤销判定的第一道门)。 */
function sameOrigin(record: MemoryRecord, slug: string, file: string): boolean {
  const origin = record.origin
  return origin !== undefined && origin.kind === 'claude-code'
    && origin.slug === slug && origin.file === file
}

/**
 * 给 scan 结果补上逐条目标层状态(pending/imported/modified/legacy/conflict)。
 * 只读,无副作用。查找范围:用户层 + 该项目 cwd 派生的项目层——allToUser
 * 与冷目录导入都落在用户层,撤销必须两层都能找到,不能只查"自然目标层"。
 */
export async function annotateClaudeImport(store: MemoryStore, scan: ClaudeScanResult): Promise<ClaudeScanResult> {
  const projects: ClaudeProjectScan[] = []
  for (const project of scan.projects) {
    const records = [
      ...await store.list('user'),
      ...(project.cwd !== null ? await store.list('project', project.cwd) : []),
    ]
    const files = project.files.map((file): ScannedFile => {
      if (!file.ok || file.name === undefined) return file
      // 来源匹配优先:即使同名占位存在,origin 能唯一定位"当年导的就是它"
      const source = records.find(record => sameOrigin(record, project.slug, file.file))
      if (source !== undefined) {
        const untouched = source.origin?.hash === contentFingerprint(source)
        return { ...file, state: untouched ? 'imported' : 'modified' }
      }
      const sameName = records.find(record => record.name === file.name)
      if (sameName === undefined) return { ...file, state: 'pending' }
      // 0.8.0 旧导入没有 origin:只有"无来源标记 + 内容与源逐字一致"才认作
      // 可撤销的旧导入。宁可少删(落到 conflict 保留),也绝不删错本地记忆。
      const legacy = sameName.origin === undefined && file.fingerprint !== undefined
        && contentFingerprint(sameName) === file.fingerprint
      return { ...file, state: legacy ? 'legacy' : 'conflict' }
    })
    projects.push({ ...project, files })
  }
  return { ...scan, projects }
}

/** 条目级目标(slug + 源文件名),导入与撤销共用。 */
export interface ImportTarget {
  slug: string
  file: string
}

/** 撤销结果计数。 */
export interface RevokeResult {
  revoked: number
  /** 目标源文件当前没有可撤销记录(已被手工删除/源已变)。 */
  missing: number
  /** 判定与删除之间内容被改(或扫描后改过):保留,不删。 */
  modified: number
  failed: number
  details: Array<{ name: string; action: 'revoked' | 'missing' | 'modified' | 'failed' }>
}

/**
 * 撤销导入:只删"来源匹配 + 内容指纹未变"的记忆(判定与删除在同一把
 * store 锁内,store.deleteIf)。0.8.0 旧导入没有 origin,改用"无来源标记 +
 * 同名 + 内容与源逐字一致"判定。导入后被编辑过的保留并计入 modified——
 * 撤销绝不能抹掉后来的人工/模型编辑。
 */
export async function revokeClaudeImports(
  store: MemoryStore,
  scan: ClaudeScanResult,
  targets: readonly ImportTarget[],
): Promise<RevokeResult> {
  const result: RevokeResult = { revoked: 0, missing: 0, modified: 0, failed: 0, details: [] }
  const bySlug = new Map(scan.projects.map(project => [project.slug, project]))
  for (const target of targets) {
    const project = bySlug.get(target.slug)
    if (project === undefined) {
      result.missing += 1
      result.details.push({ name: target.file, action: 'missing' })
      continue
    }
    // 旧导入(无 origin)的撤销凭证:源内容指纹;仅 legacy 状态提供
    const sourceFile = project.files.find(file => file.file === target.file)
    const legacyName = sourceFile?.state === 'legacy' ? sourceFile.name : undefined
    const legacyFingerprint = sourceFile?.state === 'legacy' ? sourceFile.fingerprint : undefined
    const layers: Array<{ scope: MemoryScope, cwd?: string }> = [
      { scope: 'user' },
      ...(project.cwd !== null ? [{ scope: 'project' as const, cwd: project.cwd }] : []),
    ]
    let handled = false
    for (const layer of layers) {
      const records = await store.list(layer.scope, layer.cwd)
      const matches = [
        ...records.filter(record => sameOrigin(record, target.slug, target.file)),
        ...(legacyName !== undefined && legacyFingerprint !== undefined
          ? records.filter(record => record.name === legacyName && record.origin === undefined
            && contentFingerprint(record) === legacyFingerprint)
          : []),
      ]
      for (const record of matches) {
        handled = true
        const byOrigin = record.origin !== undefined
        try {
          const removed = await store.deleteIf(record.name, layer.scope, layer.cwd, current => byOrigin
            ? sameOrigin(current, target.slug, target.file)
              && current.origin?.hash === contentFingerprint(current)
            // 旧导入:锁内再次确认"仍无来源且内容未变",否则保留
            : current.origin === undefined && current.name === record.name
              && legacyFingerprint !== undefined && contentFingerprint(current) === legacyFingerprint)
          if (removed) {
            result.revoked += 1
            result.details.push({ name: record.name, action: 'revoked' })
          } else {
            result.modified += 1
            result.details.push({ name: record.name, action: 'modified' })
          }
        } catch {
          result.failed += 1
          result.details.push({ name: record.name, action: 'failed' })
        }
      }
    }
    if (!handled) {
      result.missing += 1
      result.details.push({ name: target.file, action: 'missing' })
    }
  }
  return result
}

/** 导入执行选项。 */
export interface ImportOptions {
  /** 只导入这些 slug(缺省 = scan 结果全部)。 */
  slugs?: string[]
  /** 条目级选择(slug+file);缺省 = 选中项目全部可导入文件。 */
  files?: readonly ImportTarget[]
  /** true:全部导入用户层(忽略 cwd 反解);false:有 cwd 的进项目层。 */
  allToUser: boolean
}

/** 导入结果计数。 */
export interface ImportResult {
  imported: number
  /** 同名精确命中:跳过不覆盖(导入不碰用户已有记忆,合并语义留给固化管线)。 */
  skipped: number
  failed: number
  /** 逐条明细(供 UI 展示)。 */
  details: Array<{ name: string; action: 'imported' | 'skipped' | 'failed'; target: 'user' | 'project' }>
}

/**
 * 执行导入:scan → 逐条 parse → 目标层查重(精确同名即跳过)→ store.write
 * (安全层/锁/索引重建全走既有单点)。幂等:重跑同名全 skip。
 */
export async function runClaudeImport(store: MemoryStore, scan: ClaudeScanResult, options: ImportOptions): Promise<ImportResult> {
  const selected = options.slugs !== undefined
    ? scan.projects.filter(p => options.slugs?.includes(p.slug))
    : scan.projects
  const fileFilter = options.files !== undefined
    ? new Set(options.files.map(target => `${target.slug}\u0000${target.file}`))
    : undefined
  // 同一批共享导入时间:origin.importedMs 是"这批什么时候进来的"的锚点
  const importedMs = Date.now()
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, details: [] }
  for (const project of selected) {
    // 目标层:allToUser 或无法定位原路径 → 用户层;否则按 jsonl cwd 折叠项目层
    const useProject = !options.allToUser && project.cwd !== null
    const targetCwd = useProject ? project.cwd as string : undefined
    const target = useProject ? 'project' as const : 'user' as const
    const existingNames = new Set((await store.list(target, targetCwd)).map(r => r.name))
    for (const file of project.files) {
      // 条目级选择:未选中的文件直接跳过(项目级 slugs 过滤仍在外层生效)
      if (fileFilter !== undefined && !fileFilter.has(`${project.slug}\u0000${file.file}`)) continue
      // 审查口径对齐:scan 已判不可解析的文件不属于 importable 口径,run 里
      // 静默跳过——failed 只统计"scan 认为可导入但 run 时读不到"的真 IO 错误
      if (!file.ok) continue
      const raw = await fsp.readFile(join(project.sourceDir, file.file), 'utf8').catch(() => null)
      if (raw === null) {
        result.failed += 1
        result.details.push({ name: file.file, action: 'failed', target })
        continue
      }
      const item = parseClaudeMemory(raw, file.file.replace(/\.md$/i, ''))
      if (item === null) continue // scan 后被改坏:与 scan 口径一致地忽略
      if (existingNames.has(item.name)) {
        result.skipped += 1
        result.details.push({ name: item.name, action: 'skipped', target })
        continue
      }
      // onlyIfAbsent:同名判定下沉到 store 锁内——锁外快照存在 TOCTOU
      // (导入期间并发写入的同名记忆会被覆盖,审查确认),锁内原子判空根治
      const created = await store.write({
        name: item.name,
        ...(item.title !== undefined ? { title: item.title } : {}),
        description: item.description,
        type: item.type,
        body: item.body,
        // 导入溯源:撤销导入只认这条记录(store 会在清洗后算内容指纹)
        origin: { kind: 'claude-code', slug: project.slug, file: file.file, importedMs },
        ...(item.modifiedMs !== undefined ? { createdMs: item.modifiedMs, updatedMs: item.modifiedMs } : {}),
        onlyIfAbsent: true,
      }, target, targetCwd)
      if (created === null) {
        result.skipped += 1
        result.details.push({ name: item.name, action: 'skipped', target })
        continue
      }
      existingNames.add(item.name) // 同批内重名也按 skip 处理
      result.imported += 1
      result.details.push({ name: item.name, action: 'imported', target })
    }
  }
  return result
}

/** projectKey 再导出(供 UI/API 展示目标目录名)。 */
export { projectKey }
