/**
 * 0.7.2:固化感知工作区指令链(AGENTS.md/CLAUDE.md)。
 *
 * 背景:dsh-base 默认启用的 @deepseek-ai/dsh-agent-instructions 把
 * $DSH_HOME/AGENTS.md(用户全局)与"项目根→会话 cwd"目录链上的
 * AGENTS.md/CLAUDE.md(+ .local overlay)注入首请求基线消息;但自动固化的
 * 转写缓冲只捕获 user/assistant 文本(基线消息的 source.kind 是
 * 'agent-instructions',进不来),固化模型只"知道有 AGENTS.md 这回事"
 * (prompt 软条款)却看不到内容——可能把指令链已记载的约束再固化成一条
 * 记忆,双写违反用户与 AGENTS.md 里约定的分诊规则(人写稳定约束→AGENTS.md,
 * 模型动态事实→本插件,同一事实只落一处)。
 *
 * 实现选择:按官方发现规则(README 默认值)轻量重实现文件发现,固化前
 * 把指令链摘要喂进固化 prompt。不走官方包导出的 discoverBaseline* 也不读
 * 会话日志投影:前者要求新增 peer 依赖且在 provider-only 环境读不到,后者
 * (surface.nodes/eventAt)在 0.1.5/0.2.x 双版本下兼容负担重。摘要级感知
 * 已足以防重复固化;"磁盘态领先于会话已对账态"的差异方向是保守的(多感知
 * →少固化)。文件系统读取失败一律静默降级为"无指令链"(与固化失败静默同
 * 纪律,绝不影响固化本身)。
 *
 * 规则对齐 dsh-agent-instructions@0.1.5-rc.2(lib/index.js 默认值):
 * - 根标记 ['.git'](stat 成功即算,git worktree 的 .git 文件也认);
 *   到文件系统根仍无标记 → cwd 本身作为根
 * - 链序:用户全局在前,随后项目根→…→cwd(含两端,宽泛→具体);
 *   每目录基础候选在前、local overlay 在后
 * - 同级去重:同目录内 trim 后内容一致的后续候选丢弃(AGENTS.md 优先于
 *   CLAUDE.md——由候选顺序决定);不同目录即使内容相同也不折叠
 * - 候选名固定官方默认,不读宿主配置(轻量感知,不追求逐字节镜像)
 */

import { promises as fsp } from 'node:fs'
// node:fs 直读:$DSH_HOME 与项目目录均不在默认 fs-sandbox 的授权面内,
// 走 ctx.fs 会抛 FS_SANDBOX_DENIED(store 同纪律,官方先例 skill-filesystem)
import { dirname, join, resolve } from 'node:path'

/** 官方默认候选(基础在前、local overlay 在后,同目录内的发现顺序)。 */
export const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] as const

/** 官方默认项目根标记。 */
const PROJECT_ROOT_MARKERS = ['.git'] as const

/** 官方默认单文件大小上限(maxSourceBytes):超限候选整个跳过不整载。 */
const MAX_SOURCE_BYTES = 1_048_576

/** 固化 prompt 中指令摘要的总预算(字符;transcript 缓冲上限 24k,2k 摘要可接受)。 */
export const INSTRUCTION_DIGEST_MAX_CHARS = 2048

/**
 * 框闭合标签转义:指令文件属仓库控制文本(clone 的仓库 AGENTS.md 并非用户手写),
 * 字面闭合标签可让内容逃出插件自有的 <workspace-instructions> 框、以顶层指令
 * 身份欺骗固化模型,落库后获得跨会话 system prompt 持久性——官方
 * escapeInstructionFrameBody 与本仓库 stripMemoryTags 同一纪律。容忍空白词法
 * 变体(`</workspace-instructions >`),仿 stripMemoryTags 的容忍正则。
 */
function escapeFrameClose(text: string): string {
  return text.replaceAll(/<\/\s*workspace-instructions\s*>/gi, '<\\/workspace-instructions>')
}

/** 从 cwd 逐级上溯找项目根;无标记则 cwd 本身(官方 fallback 语义)。全程异步——宿主是常驻进程,UNC/掉线盘上同步 stat 会阻塞事件循环(审查 minor)。 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    // stat(不区分文件/目录)成功即算——git worktree 的 .git 是文件
    let hit = false
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        await fsp.stat(join(current, marker))
        hit = true
        break
      } catch { /* 不存在或不可读:视为无标记,继续上溯(与官方"IO 失败中止"的偏差方向保守:多感知→少固化) */ }
    }
    if (hit) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd) // 到文件系统根:cwd 即根
    current = parent
  }
}

/**
 * 发现指令链文件(宽泛→具体):$DSH_HOME/AGENTS.md → 项目根→…→cwd 每目录的
 * 基础+local 候选。只判存在性不读内容;同级去重在 render 阶段(需读内容)。
 * 任何目录不可读则静默跳过该目录(不中断整条链)。
 */
export async function discoverInstructionFiles(cwd: string, dshHome: string): Promise<string[]> {
  const paths: string[] = []
  // 用户全局固定单文件,无 local overlay;与项目候选同样只收录真实存在的文件
  const globalFile = join(dshHome, 'AGENTS.md')
  try {
    const entry = await fsp.stat(globalFile)
    if (entry.isFile() && entry.size <= MAX_SOURCE_BYTES) paths.push(globalFile)
  } catch { /* 不存在或不可读:跳过 */ }
  const root = await findProjectRoot(cwd)
  const chain: string[] = []
  for (let current = resolve(cwd);; current = dirname(current)) {
    chain.unshift(current)
    if (current === root) break
    if (dirname(current) === current) break // 防御:root 不在祖先链上时到顶即止
  }
  for (const dir of chain) {
    for (const name of INSTRUCTION_CANDIDATES) {
      const file = join(dir, name)
      try {
        const entry = await fsp.stat(file)
        // 大小门(官方 maxSourceBytes 语义):超限文件整个跳过,绝不整载后才截断
        if (entry.isFile() && entry.size <= MAX_SOURCE_BYTES) paths.push(file)
      } catch { /* 不存在或不可读:跳过该候选 */ }
    }
  }
  return paths
}

/**
 * 读文件渲染成固化 prompt 的指令摘要:同目录 trim 一致去重(首个胜出)、
 * 每文件截 500 字符、总量不超 maxTotalChars(装不下时从最具体端截断——
 * 与官方"较宽泛的先省略"一致,但我们先保底宽泛文件可见,剩余预算给具体)。
 * 单文件读取失败按"该文件不存在"处理(静默)。返回空串表示无指令链。
 */
export async function renderInstructionDigest(paths: string[], maxTotalChars = INSTRUCTION_DIGEST_MAX_CHARS): Promise<string> {
  const seenDigest = new Map<string, string>() // dirname → 该目录已收录首个候选的 trim 摘要
  const parts: string[] = []
  let used = 0
  for (const file of paths) {
    if (used >= maxTotalChars) break
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch { continue } // 读取失败按不存在处理
    if (raw.trim().length === 0) continue // 空文件:只有路径头、零信息,白占预算(审查测试缺口)
    const dir = dirname(file)
    const head = raw.slice(0, 500)
    const trimmedKey = raw.trim().slice(0, 500)
    const existingKey = seenDigest.get(dir)
    if (existingKey !== undefined && existingKey === trimmedKey) continue // 同级 trim 一致:重复副本
    if (existingKey === undefined) seenDigest.set(dir, trimmedKey)
    // 转义在截断后、拼装前:仓库控制文本不得闭合插件自有框架(major 修复)
    const escaped = escapeFrameClose(head)
    const header = `--- ${file} ---\n`
    const budget = maxTotalChars - used - header.length
    if (budget <= 0) break // 连头行都放不下:预算耗尽(实测曾超限的根因:头行未计入当次)
    const slice = escaped.length > budget ? `${escaped.slice(0, Math.max(0, budget - 1))}…` : escaped
    parts.push(`${header}${slice}`)
    used += header.length + slice.length + 1 // +1 = join('\n') 分隔符(首个不存在,保守方向)
  }
  return parts.join('\n')
}

/** 顶层便捷:发现+渲染一步(固化触发点用;失败静默返回空串)。 */
export async function collectInstructionDigest(cwd: string, dshHome: string, maxTotalChars = INSTRUCTION_DIGEST_MAX_CHARS): Promise<string> {
  try {
    return await renderInstructionDigest(await discoverInstructionFiles(cwd, dshHome), maxTotalChars)
  } catch {
    return ''
  }
}
