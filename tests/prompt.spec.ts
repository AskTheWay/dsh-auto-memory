/**
 * 提示词渲染层测试:花括号中和(审查 major 回归:3+ 连续 { 会残留 {{,
 * 在 0.1.5-rc.2 严格插值下炸掉全部模型请求)。
 */

import { describe, expect, it } from 'vitest'
import { neutralizeBraces } from '../src/prompt.ts'

describe('neutralizeBraces', () => {
  it('双花括号被中和', () => {
    expect(neutralizeBraces('a {{footer}} b')).toBe('a { {footer}} b')
    expect(neutralizeBraces('a {{footer}} b')).not.toContain('{{')
  })
  it('三个连续左花括号不残留 {{(Mustache raw partial 场景)', () => {
    expect(neutralizeBraces('Mustache raw partial: {{{footer}}}')).not.toContain('{{')
  })
  it('四个连续左花括号同样干净', () => {
    expect(neutralizeBraces('{{{{a}}}}')).not.toContain('{{')
  })
  it('大量连续左花括号收敛', () => {
    expect(neutralizeBraces('{'.repeat(50))).not.toContain('{{')
  })
  it('无花括号原样返回', () => {
    expect(neutralizeBraces('plain text 中文')).toBe('plain text 中文')
  })
})
