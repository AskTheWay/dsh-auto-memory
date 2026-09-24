/**
 * P1 自动固化纯函数测试:捕获、缓冲容量、LLM 输出解析、候选 sanitize。
 */

import { describe, expect, it } from 'vitest'
import {
  appendCapped, buildConsolidationPrompt, captureText, parseCandidates, sanitizeCandidate,
} from '../src/consolidate.ts'

describe('captureText', () => {
  it('提取文本块并合并', () => {
    const message = { content: [{ type: 'text', text: '你好' }, { type: 'image', url: 'x' }, { type: 'text', text: '世界' }] }
    expect(captureText('user', message as never)).toBe('你好\n世界')
  })
  it('user 超长截断到 2000 并加省略号', () => {
    const text = 'a'.repeat(3000)
    const out = captureText('user', { content: [{ type: 'text', text }] } as never)
    expect(out?.length).toBe(2001)
    expect(out?.endsWith('…')).toBe(true)
  })
  it('assistant 截断到 500', () => {
    const out = captureText('assistant', { content: [{ type: 'text', text: 'b'.repeat(800) }] } as never)
    expect(out?.length).toBe(501)
  })
  it('无文本返回 null', () => {
    expect(captureText('user', { content: [{ type: 'image', url: 'x' }] } as never)).toBeNull()
    expect(captureText('user', undefined)).toBeNull()
  })
})

describe('appendCapped(缓冲容量控制)', () => {
  it('正常追加', () => {
    expect(appendCapped(['a'], 'b')).toEqual(['a', 'b'])
  })
  it('超过条数上限丢最旧', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
    const out = appendCapped(lines, 'new')
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out[out.length - 1]).toBe('new')
    expect(out).not.toContain('line-0')
  })
})

describe('parseCandidates(LLM 输出容错解析)', () => {
  it('纯 JSON 数组', () => {
    expect(parseCandidates('[{"name":"a"}]')).toEqual([{ name: 'a' }])
  })
  it('从包裹文本中提取', () => {
    expect(parseCandidates('Here you go:\n[{"name":"a"}]\nhope it helps')).toEqual([{ name: 'a' }])
  })
  it('无数组返回 null', () => {
    expect(parseCandidates('no json here')).toBeNull()
  })
  it('JSON 对象(非数组)返回 null', () => {
    expect(parseCandidates('{"name":"a"}')).toBeNull()
  })
})

describe('sanitizeCandidate', () => {
  it('合法候选原样通过', () => {
    const out = sanitizeCandidate(
      { name: 'User-Prefers-Python', title: '偏好 Python', description: ' d ', type: 'user', body: ' b ', scope: 'project' },
      true,
    )
    expect(out).toEqual({ name: 'user-prefers-python', title: '偏好 Python', description: 'd', type: 'user', body: 'b', scope: 'project' })
  })
  it('不可归一化 name(中文)丢弃', () => {
    expect(sanitizeCandidate({ name: '中文', description: 'd', type: 'user', body: 'b' }, true)).toBeNull()
  })
  it('保留字 memory 丢弃', () => {
    expect(sanitizeCandidate({ name: 'memory', description: 'd', type: 'user', body: 'b' }, true)).toBeNull()
  })
  it('非法 type 丢弃;缺省 type 为 reference', () => {
    expect(sanitizeCandidate({ name: 'a', description: 'd', type: 'bogus', body: 'b' }, true)).toBeNull()
    expect(sanitizeCandidate({ name: 'a', description: 'd', body: 'b' }, true)?.type).toBe('reference')
  })
  it('enableUserScope=false 时 user 请求降级为 project', () => {
    expect(sanitizeCandidate({ name: 'a', description: 'd', type: 'user', body: 'b', scope: 'user' }, false)?.scope).toBe('project')
  })
  it('超长字段截断', () => {
    const out = sanitizeCandidate({ name: 'a', description: 'x'.repeat(300), type: 'user', body: 'y'.repeat(3000) }, true)
    expect(out?.description.length).toBe(160)
    expect(out?.body.length).toBe(2000)
  })
  it('缺 description 或 body 丢弃', () => {
    expect(sanitizeCandidate({ name: 'a', body: 'b' }, true)).toBeNull()
    expect(sanitizeCandidate({ name: 'a', description: 'd' }, true)).toBeNull()
  })
})

describe('buildConsolidationPrompt', () => {
  it('包含已有记忆名、上限与转写文本', () => {
    const prompt = buildConsolidationPrompt(['alpha', 'beta'], 'USER: hi', 5)
    expect(prompt).toContain('alpha, beta')
    expect(prompt).toContain('AT MOST 5')
    expect(prompt).toContain('USER: hi')
  })
})
