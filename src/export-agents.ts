/**
 * 1.2.0:反向导出桥——把已信任的记忆渲染成 AGENTS.md 片段。
 *
 * 方向与导入桥相反:导入桥把 Claude/Claude Code 的记忆带进来,导出桥把本插件
 * 的信任态记忆交给"任何吃 AGENTS.md 惯例的工具"(Claude Code/Codex/Cursor)。
 * 导出口径:**只导信任态**(status 缺省或 verified)——candidate 未经验证、
 * disputed 有争议,都不该出现在指令文件里(1.0.0 可信语义的自然延伸)。
 * 纯文本拼接,零依赖;面板按钮触发,复制即用。
 */

import type { MemoryRecord, MemoryScope } from './types.ts'

/** 导出条目(面板可见的形状)。 */
export interface AgentExportItem {
  name: string
  description: string
  scope: MemoryScope
}

/** 渲染 AGENTS.md 片段(纯函数,便于测试)。 */
export function renderAgentsExport(items: AgentExportItem[], dateISO: string): string {
  if (items.length === 0) return ''
  const lines = [
    `## Memory (exported from dsh-auto-memory, ${dateISO})`,
    '',
    '<!-- Trusted memories from the dsh-auto-memory plugin, formatted as AGENTS.md-convention notes. -->',
  ]
  for (const item of items) {
    lines.push(`- ${item.description} (${item.name})`)
  }
  return `${lines.join('\n')}\n`
}

/** 过滤信任态:status 缺省或 verified;其余(candidate/disputed/superseded)不导。 */
export function trustedForExport(records: MemoryRecord[]): MemoryRecord[] {
  return records.filter(r => r.status === undefined || r.status === 'verified')
}
