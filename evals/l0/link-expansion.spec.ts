/**
 * L0-④ [[link]] 展开边界(确定性)。
 * 上限、自链排除、坏链接安全、单次读取的 token 增量有界。
 */

import { describe, expect, it } from 'vitest'
import { expandLinks, LINK_LIMIT } from '../../src/links.ts'
import { bytes } from './helpers.ts'

const DICT: Record<string, { name: string; description: string }> = {
  'alpha': { name: 'alpha', description: '第一条' },
  'beta': { name: 'beta', description: '第二条' },
  'gamma': { name: 'gamma', description: '第三条' },
  'delta': { name: 'delta', description: '第四条' },
}

const lookup = (name: string) => DICT[name] ?? null

describe('link-expansion', () => {
  it('单链接解析', async () => {
    const { linked, truncated } = await expandLinks('参见 [[alpha]]', 'self', lookup)
    expect(linked).toEqual([{ name: 'alpha', description: '第一条' }])
    expect(truncated).toBe(false)
  })

  it('超过上限截断并标记 truncated', async () => {
    const body = '[[alpha]] [[beta]] [[gamma]] [[delta]] 以及重复 [[alpha]]'
    const { linked, truncated } = await expandLinks(body, 'self', lookup)
    expect(linked).toHaveLength(LINK_LIMIT)
    expect(linked.map(l => l.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(truncated).toBe(true)
  })

  it('自链排除;坏链接(不存在/畸形语法)安全跳过', async () => {
    const dict: Record<string, { name: string; description: string }> = { ...DICT, 'ok-side': { name: 'ok-side', description: 'x' } }
    const { linked } = await expandLinks('[[self]] [[missing]] [[BAD NAME]] [[ok-side]]', 'self', name => dict[name] ?? null)
    expect(linked.map(l => l.name)).toEqual(['ok-side'])
  })

  it('单次展开的体积增量有界:≤ LINK_LIMIT × 每条摘要上限(UTF-8 字节口径)', async () => {
    const long = '很长的描述'.repeat(40) // 200 个中文字符 ≈ 600 UTF-8 字节
    const dict: Record<string, { name: string; description: string }> = {
      a: { name: 'a', description: long },
      b: { name: 'b', description: long },
      c: { name: 'c', description: long },
      d: { name: 'd', description: long },
      e: { name: 'e', description: long },
    }
    const { linked } = await expandLinks('[[a]] [[b]] [[c]] [[d]] [[e]]', 'self', name => dict[name] ?? null)
    const rendered = linked.map(l => `- ${l.name} — ${l.description}`).join('\n')
    expect(linked).toHaveLength(LINK_LIMIT)
    expect(bytes(rendered)).toBeLessThanOrEqual(LINK_LIMIT * 660) // 每条 ≈600B 摘要 + 包装余量
  })
})
