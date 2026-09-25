/**
 * [[name]] 链接展开(纯函数,供工具层调用与 L0 评测测试)。
 * 一层展开、不递归;上限 LINK_LIMIT 条;自链排除;坏链接安全跳过。
 */

import type { MemoryRecord } from './types.ts'

/** 单次 read 最多展开的链接数。 */
export const LINK_LIMIT = 3

/** 链接摘要(附在读取结果尾部)。 */
export interface LinkedSummary {
  name: string
  description: string
}

/**
 * 从 body 中解析 [[kebab-name]] 链接并经 lookup 解析目标。
 * @param body - 被读记忆的正文
 * @param selfName - 自身 name(自链排除)
 * @param lookup - 按名查目标记忆(异步);不存在/畸形返回 null
 * @returns 命中的链接摘要(≤LINK_LIMIT)与是否发生了截断
 */
export async function expandLinks(
  body: string,
  selfName: string,
  lookup: (name: string) => Promise<Pick<MemoryRecord, 'name' | 'description'> | null> | Pick<MemoryRecord, 'name' | 'description'> | null,
): Promise<{ linked: LinkedSummary[]; truncated: boolean }> {
  const names = [...body.matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)].map(m => m[1])
  const unique = [...new Set(names)].filter(name => name !== selfName)
  const linked: LinkedSummary[] = []
  for (const name of unique) {
    if (linked.length >= LINK_LIMIT) break
    const target = await lookup(name)
    if (target !== null) linked.push({ name: target.name, description: target.description })
  }
  return { linked, truncated: unique.length > linked.length }
}
