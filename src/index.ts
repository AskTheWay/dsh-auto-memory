/**
 * dsh-auto-memory — 把 Claude Code 的 auto-memory 机制移植为 DeepSeek Harness 原生插件。
 *
 * MEMORY.md 索引自动注入系统提示词 + 类型化记忆文件(单文件 + frontmatter)
 * + memory_write/read/list/delete 四工具。轻量、纯文件、无外部服务。
 *
 * 插件形态:export const name / inject / Config / apply(严禁 default export,
 * Loader 会折叠默认导出并丢失 inject —— 官方 postmortem 0001)。
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// 类型层面:使 AssembleContext 的 agent 字段声明合并生效(来自 dsh-agent)
import type {} from '@deepseek-ai/dsh-agent'
import { MemoryStore } from './store.ts'
import { registerMemoryTools } from './tools.ts'
import { MEMORY_SECTION, renderMemoryIndexText } from './prompt.ts'
import { registerConsolidation } from './consolidate.ts'
import { registerMemoryApi } from './memory-api.ts'

export const name = 'dsh-auto-memory'
export const inject = ['tools', 'systemPrompt']

/** 插件配置(schemastery 声明,默认值写在 schema;用户经 profile patch 覆盖,整表替换)。 */
export interface Config {
  /** 注入索引段(含写入指导)的字节预算。 */
  maxBytes: number
  /** 记忆根目录;缺省 $DSH_HOME/memory(跟随 $DSH_HOME > ~/.dsh)。 */
  memoryDir?: string
  /** 是否启用用户级作用域(_user 目录注入所有会话)。 */
  enableUserScope: boolean
  /** P1:会话结束自动总结固化(需要可用模型路由;失败静默不影响会话)。 */
  autoSummarize: boolean
  /** 单次固化最多写入的新记忆数。 */
  autoSummarizeMaxMemories: number
  /** 固化模型调用的输出 token 上限。 */
  autoSummarizeMaxTokens: number
  /** P1:软淘汰阈值(天)——超过且从未被读取的记忆在索引重建时从注入索引隐藏(文件保留)。0 禁用。 */
  staleAfterDays: number
}

export const Config: z<Config> = z.object({
  maxBytes: z.number().default(4096),
  memoryDir: z.string(),
  enableUserScope: z.boolean().default(true),
  autoSummarize: z.boolean().default(false),
  autoSummarizeMaxMemories: z.number().default(5),
  autoSummarizeMaxTokens: z.number().default(2048),
  staleAfterDays: z.number().default(0),
})

export function apply(ctx: Context, config: Config): void {
  // resolve 归一:相对路径的记忆根会随 dsh 启动目录漂移,静默破坏持久性
  const rootDir = config.memoryDir !== undefined && config.memoryDir.length > 0
    ? resolve(config.memoryDir)
    : join(resolveDshHome(), 'memory')
  const store = new MemoryStore(rootDir, { staleAfterDays: config.staleAfterDays })

  registerMemoryTools(ctx, store, config.enableUserScope)

  // P2-2:Web 面板 API(宿主半路由;无 connection 服务的组合自动 no-op)
  registerMemoryApi(ctx, store, rootDir, { maxBytes: config.maxBytes })

  // P1:会话结束自动固化(autoSummarize=false 时 no-op)
  registerConsolidation(ctx, store, {
    autoSummarize: config.autoSummarize,
    autoSummarizeMaxMemories: config.autoSummarizeMaxMemories,
    autoSummarizeMaxTokens: config.autoSummarizeMaxTokens,
    enableUserScope: config.enableUserScope,
  })

  // P1:软淘汰的会话启动评估(审查 major 修复):淘汰是索引重建时的惰性评估,
  // 无新写入的仓库永远等不到重建——每个会话首 agent 创建时刷新一次两层索引。
  if (config.staleAfterDays > 0) {
    const refreshed = new Set<string>()
    ctx.on('agent/created', ({ agent }) => {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) return
      if (refreshed.has(agent.session.id)) return
      refreshed.add(agent.session.id)
      void store.refreshIndex('project', cwd)
      if (config.enableUserScope) void store.refreshIndex('user')
    })
    ctx.on('session/disposed', session => { refreshed.delete(session.id) })
  }

  // 唯一注入段:动态 text,每个 step 重组装时按当前 agent 的 cwd 重新求值;
  // 两层均无记忆时返回空串(整段消失,对齐 Claude Code"有记忆才注入")。
  // memory_write/delete 改动 MEMORY.md 后,下一个请求自动带上新索引(无需失效通知)。
  // 注意:0.1.5-rc.2 的 PromptSection 尚无 interpolate 开关(0.1.6-alpha.2 才有),
  // 严格插值下记忆内容含字面 {{ }} 会炸组装 —— 由 renderMemoryIndexText 内部中和;
  // peer 升级到 >=0.1.6 后可改用 interpolate: false 并去掉中和逻辑。
  ctx.systemPrompt.section({
    name: MEMORY_SECTION,
    order: 4000,
    text: context => renderMemoryIndexText(store, config, context.agent?.session.header.cwd),
  })
}
