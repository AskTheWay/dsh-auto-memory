/**
 * 0.8.0:Claude Code 记忆导入桥(scan → 预览确认 → run)。
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
import { normalizeName, projectKey } from './store.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryType } from './types.ts'

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

/** 单文件解析预检结果(供 scan 预览,不落盘)。 */
export interface ScannedFile {
  file: string
  ok: boolean
  reason?: string
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
      const ok = parseClaudeMemory(raw, file.replace(/\.md$/i, '')) !== null
      scanned.push({ file, ok, ...(ok ? {} : { reason: 'unparsable' }) })
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

/** 导入执行选项。 */
export interface ImportOptions {
  /** 只导入这些 slug(缺省 = scan 结果全部)。 */
  slugs?: string[]
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
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, details: [] }
  for (const project of selected) {
    // 目标层:allToUser 或无法定位原路径 → 用户层;否则按 jsonl cwd 折叠项目层
    const useProject = !options.allToUser && project.cwd !== null
    const targetCwd = useProject ? project.cwd as string : undefined
    const target = useProject ? 'project' as const : 'user' as const
    const existingNames = new Set((await store.list(target, targetCwd)).map(r => r.name))
    for (const file of project.files) {
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
