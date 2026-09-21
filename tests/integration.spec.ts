/**
 * 集成测试:在真实 Cordis 栈(真 SystemPrompt + 真 ToolRuntime 服务)上挂载插件,
 * 断言工具注册与系统提示词段注入。配置走完整对象(loader 的 schemastery 校验
 * 不在此路径,由 Config schema 的默认值与 profile 层保证)。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as autoMemory from '../src/index.ts'

describe('dsh-auto-memory 插件挂载', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await fsp.mkdtemp(join(tmpdir(), 'dsh-auto-memory-it-'))
    ctx = new Context()
  })

  afterEach(async () => {
    // teardown 铁律:即使断言失败也要 dispose
    await ctx.fiber.dispose()
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('挂载成功:注册四个 memory_* 工具,不抛错', async () => {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(autoMemory, { maxBytes: 4096, memoryDir: root, enableUserScope: true, autoSummarize: false })

    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const tool of ['memory_write', 'memory_read', 'memory_list', 'memory_delete']) {
      expect(names, `registered tools: ${names.join(', ')}`).toContain(tool)
    }
  })

  it('系统提示词:唯一 memory 段注册、无记忆时段为空、渲染不抛错', async () => {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(autoMemory, { maxBytes: 4096, memoryDir: root, enableUserScope: true, autoSummarize: false })

    const assembly = await ctx.systemPrompt.assemble()
    // 裸组装无 agent:动态段求值为空串(渲染时被丢弃)——无记忆不占系统提示词
    const sections = assembly.sections.filter(section => section.name.startsWith('memory:'))
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('memory:index')
    expect(sections[0]?.text).toBe('')
    // 插值渲染安全
    expect(() => renderPrompt(assembly)).not.toThrow()
  })

  it('卸载(HMR 安全):dispose 后工具从注册表消失', async () => {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    const fiber = await ctx.plugin(autoMemory, { maxBytes: 4096, memoryDir: root, enableUserScope: true, autoSummarize: false })
    expect(ctx.tools.schemas().map(s => s.name)).toContain('memory_write')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('memory_write')
  })

  it('插件模块无 default export(Loader 折叠会丢 inject)', () => {
    expect('default' in autoMemory).toBe(false)
    expect(autoMemory.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof autoMemory.apply).toBe('function')
  })
})
