/**
 * 模型可见的记忆工具面:memory_write / memory_read / memory_list / memory_delete。
 * 语义对齐 Claude Code 的 Memory 工具。
 *
 * 审查修复后的统一规则:
 * - 所有需要 project 作用域的工具在无 owning agent(无可信 cwd)时一律拒绝,
 *   与 memory_write 一致——绝不静默落到 process.cwd() 派生的错误项目目录。
 * - enableUserScope=false 时,user 层从一切路径(读/列/删的默认搜索、显式指定)
 *   一并剔除,不只挡写入——"跨项目不串扰"对全部工具成立。
 * - memory_write 未指定 scope 时先全层查重:已有同名记忆在哪个层就更新哪个层
 *   (查重更新优先于新建,避免跨层同名分叉)。
 * - 不追加自定义会话事件(第三方事件类型会导致 resume 拒读);审计走 tool/result。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store.ts'
import { normalizeName } from './store.ts'
import { expandLinks } from './links.ts'
import type { MemoryScope } from './types.ts'

/** 解析可选 scope 参数;未指定时返回 undefined(由调用方按查重/配置语义决定)。 */
function parseExplicitScope(raw: string | undefined): MemoryScope | undefined {
  if (raw === undefined) return undefined
  if (raw === 'user' || raw === 'project') return raw
  throw new Error(`invalid scope: ${JSON.stringify(raw)} (expected 'project' or 'user')`)
}

/** 注册四个记忆工具。 */
export function registerMemoryTools(ctx: Context, store: MemoryStore, enableUserScope: boolean): void {  /** 当前部署可访问的作用域(user 层被配置禁用时从一切路径剔除)。 */
  const availableScopes = (): readonly MemoryScope[] => enableUserScope ? ['user', 'project'] : ['project']

  const guardScope = (scope: MemoryScope): MemoryScope => {
    if (scope === 'user' && !enableUserScope) {
      throw new Error("user scope is disabled by configuration (enableUserScope: false); use 'project'")
    }
    return scope
  }

  /** 需要 project 作用域时可信赖的会话 cwd;缺失即拒绝(与官方 tool-todo 同语义)。 */
  const requireCwd = (cwd: string | undefined): string => {
    if (cwd === undefined) throw new Error('this memory tool requires an owning agent session (no session cwd to resolve the project scope)')
    return cwd
  }

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Write or update one persistent memory (a fact that should survive across sessions). '
      + 'Reuse an existing name to UPDATE that memory instead of creating a near-duplicate. '
      + 'Write when: the user states who they are or their preferences (user); the user corrects or confirms '
      + 'how you should work (feedback — include **Why:** and **How to apply:** lines); ongoing work, goals or '
      + 'constraints emerge (project — absolute dates only); an external resource is worth returning to (reference). '
      + 'Do NOT store what the codebase or AGENTS.md/CLAUDE.md already records.',
    parameters: {
      name: {
        type: 'string', required: true,
        description: 'kebab-case identifier (e.g. "user-prefers-python"); also the storage key — reuse to update',
      },
      description: {
        type: 'string', required: true,
        description: 'One-line summary shown in the injected memory index; keep it under ~160 chars',
      },
      type: {
        type: 'string', required: true, enum: ['user', 'feedback', 'project', 'reference'],
        description: 'user=who the user is; feedback=how to work (Why/How to apply); project=ongoing work/goals; reference=external pointers',
      },
      body: {
        type: 'string', required: true,
        description: 'The fact itself, in markdown. Cross-link with [[other-name]]. feedback type: end with **Why:** and **How to apply:** lines',
      },
      title: {
        type: 'string',
        description: 'Optional human-readable heading shown in the index (any language); defaults to name',
      },
      pinned: {
        type: 'boolean',
        description: 'Pin this memory: it sorts first in the index, survives budget truncation, and is never hidden by staleness eviction. Use when the user explicitly says to keep something forever; unpin by passing false',
      },
      scope: {
        type: 'string', enum: ['project', 'user'],
        description: "project: only this workspace's sessions; user: all sessions of this user. Default: update the layer where this name already exists, else project",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['created', 'updated'] },
          scope: { type: 'string', required: true, enum: ['project', 'user'] },
          pinned: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory ${value.operation}: ${value.name} (${value.scope}${value.pinned ? ', pinned' : ''})` }],
    },
    async execute(args, exec) {
      const cwd = requireCwd(exec.agent?.session.header.cwd)
      const name = normalizeName(args.name)
      // 未显式指定 scope:先在可访问层内查重,命中层即更新层;未命中落到 project
      const explicit = parseExplicitScope(args.scope)
      const existing = await store.findIn(name, availableScopes(), cwd)
      const scope = guardScope(explicit ?? existing?.scope ?? 'project')
      await store.write({
        name,
        title: args.title !== undefined && args.title.trim().length > 0 ? args.title.trim() : undefined,
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
        description: args.description.trim(),
        type: args.type,
        body: args.body,
      }, scope, cwd)
      const operation: 'created' | 'updated' = existing === null || existing.scope !== scope ? 'created' : 'updated'
      return { name, operation, scope, pinned: (args.pinned ?? existing?.pinned) === true }
    },
    presentCall: args => ({ card: 'generic', title: `Memory write: ${String(args.name)}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one persistent memory by name (full body, with one level of [[name]] cross-links resolved). '
      + 'Search the injected memory index for the name first.',
    parameters: {
      name: { type: 'string', required: true, description: 'Memory name from the index (kebab-case)' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Limit to one scope; default searches user then project' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
          type: { type: 'string', required: true },
          body: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          linked: {
            type: 'array',
            description: 'One-line summaries of memories referenced via [[name]] in the body',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const linkedList = value.linked ?? []
        const linked = linkedList.length === 0
          ? ''
          : `\n\nLinked memories:\n${linkedList.map(l => `- ${l.name} — ${l.description}`).join('\n')}`
        return [{ type: 'text', text: `--- name: ${value.name}\ndescription: ${value.description}\ntype: ${value.type}\nscope: ${value.scope}\n---\n\n${value.body}${linked}` }]
      },
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      const record = await (async () => {
        const explicit = parseExplicitScope(args.scope)
        if (explicit !== undefined) return store.read(args.name, guardScope(explicit), requireCwd(cwd))
        return store.findIn(args.name, availableScopes(), requireCwd(cwd))
      })()
      if (record === null) throw new Error(`memory not found: ${JSON.stringify(normalizeName(args.name))} — call memory_list to see available names`)
      // 读取计数(best-effort,失败不影响返回)
      void store.touch(record.name, record.scope, cwd).catch(() => {})
      // 召回展开:一层 [[name]] 链接摘要(纯函数见 src/links.ts)
      const { linked } = await expandLinks(record.body, record.name, name =>
        store.findIn(name, availableScopes(), cwd))
      return { name: record.name, description: record.description, type: record.type, body: record.body, scope: record.scope, linked }
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Memory read: ${String(args.name)}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List persistent memories (name, description, type, scope). Use before writing to avoid duplicates.',
    parameters: {
      scope: { type: 'string', enum: ['project', 'user'], description: 'Limit to one scope; default lists both' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                type: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                pinned: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.memories.length === 0
          ? 'No memories yet.'
          : value.memories.map(m => `- ${m.name}${m.pinned ? ' 📌' : ''} (${m.scope}/${m.type}) — ${m.description}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      const explicit = parseExplicitScope(args.scope)
      const scopes: readonly MemoryScope[] = explicit !== undefined
        ? [guardScope(explicit)]
        : availableScopes()
      const memories = (await Promise.all(scopes.map(async scope => {
        const records = scope === 'project' ? await store.list(scope, requireCwd(cwd)) : await store.list(scope)
        return records.map(r => ({ name: r.name, description: r.description, type: r.type, scope: r.scope, pinned: r.pinned === true }))
      }))).flat()
      return { memories }
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Memory list', kind: 'other', rawInput: null }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: 'Delete one persistent memory by name. Use when a memory turned out wrong or obsolete.',
    parameters: {
      name: { type: 'string', required: true, description: 'Memory name to delete (kebab-case)' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Scope to delete from; default searches user then project' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Deleted memory: ${value.name} (${value.scope})` }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      const name = normalizeName(args.name)
      const explicit = parseExplicitScope(args.scope)
      const searchScopes: readonly MemoryScope[] = explicit !== undefined ? [guardScope(explicit)] : availableScopes()
      for (const scope of searchScopes) {
        const targetCwd = scope === 'project' ? requireCwd(cwd) : cwd
        if (await store.delete(name, scope, targetCwd)) {
          return { name, scope }
        }
      }
      throw new Error(`memory not found: ${JSON.stringify(name)}`)
    },
    presentCall: args => ({ card: 'generic', title: `Memory delete: ${String(args.name)}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_prune',
    description: 'List (dry-run, default) or delete memories not updated within olderThanDays. '
      + 'Use to keep the store healthy: propose a dry-run first, show the candidates to the user, '
      + 'then delete only with their consent. Memories without lifecycle metadata are never matched.',
    parameters: {
      olderThanDays: { type: 'integer', required: true, description: 'Match memories whose last update is older than this many days' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Limit to one scope; default both' },
      dryRun: { type: 'boolean', description: 'true (default): only list candidates; false: delete them' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', required: true },
          deleted: { type: 'integer', required: true, description: 'Number actually deleted (0 in dry-run)' },
          candidates: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                daysSinceUpdate: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const head = value.dryRun
          ? `Prune dry-run: ${value.candidates.length} candidate(s) older than threshold — re-run with dryRun=false to delete`
          : `Pruned ${value.deleted} of ${value.candidates.length} candidate(s)`
        const lines = value.candidates.map(c => `- ${c.name} (${c.scope}, ${c.daysSinceUpdate}d since update) — ${c.description}`)
        return [{ type: 'text', text: lines.length === 0 ? `${head}.` : `${head}\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      // 下限校验(审查 minor 修复):0/负数会匹配全部有元数据记忆,等于绕过确认的批量删除
      if (!Number.isSafeInteger(args.olderThanDays) || args.olderThanDays < 1) {
        throw new Error('olderThanDays must be an integer >= 1')
      }
      const cwd = exec.agent?.session.header.cwd
      const explicit = parseExplicitScope(args.scope)
      const scopes: readonly MemoryScope[] = explicit !== undefined ? [guardScope(explicit)] : availableScopes()
      const now = Date.now()
      const candidates: { name: string; scope: MemoryScope; description: string; days: number }[] = []
      for (const scope of scopes) {
        const records = scope === 'project' ? await store.list(scope, requireCwd(cwd)) : await store.list(scope)
        for (const record of records) {
          const updated = record.updatedMs ?? record.createdMs
          if (updated === undefined) continue
          const days = Math.floor((now - updated) / 86_400_000)
          if (days >= args.olderThanDays) candidates.push({ name: record.name, scope, description: record.description, days })
        }
      }
      const dryRun = args.dryRun !== false
      let deleted = 0
      if (!dryRun) {
        // 单条失败不中断整批(审查 minor 修复):如实计数,失败项留在候选清单中可重试
        for (const candidate of candidates) {
          try {
            if (await store.delete(candidate.name, candidate.scope, candidate.scope === 'project' ? requireCwd(cwd) : cwd)) {
              deleted += 1
            }
          } catch {
            // 跳过失败项,计数如实
          }
        }
      }
      return {
        dryRun,
        deleted,
        candidates: candidates.map(c => ({ name: c.name, description: c.description, scope: c.scope, daysSinceUpdate: c.days })),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Memory prune: ${String(args.olderThanDays)}d`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete_all',
    description: 'Delete ALL memories in a scope (or both). Destructive — requires confirm=true and '
      + 'an explicit statement from the user that they want everything forgotten.',
    parameters: {
      scope: { type: 'string', enum: ['project', 'user'], description: 'Scope to clear; default both' },
      confirm: { type: 'boolean', required: true, description: 'Must be explicitly true to delete' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scopes: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string', required: true },
                deleted: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Deleted ${value.scopes.map(s => `${s.deleted} in ${s.scope}`).join(', ')}`,
      }],
    },
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('memory_delete_all requires confirm=true (destructive); ask the user first')
      const cwd = exec.agent?.session.header.cwd
      const explicit = parseExplicitScope(args.scope)
      const scopes: readonly MemoryScope[] = explicit !== undefined ? [guardScope(explicit)] : availableScopes()
      const results = []
      for (const scope of scopes) {
        const deleted = await store.clear(scope, scope === 'project' ? requireCwd(cwd) : cwd)
        results.push({ scope, deleted })
      }
      return { scopes: results }
    },
    presentCall: args => ({ card: 'generic', title: `Memory delete-all${args.scope === undefined ? '' : ` (${String(args.scope)})`}`, kind: 'other', rawInput: args }),
  }))

  // 破坏性操作的硬闸(审查 major 修复:模型自证 confirm 可被注入伪造):
  // tools/pre-execute 返回 ask → 交由 dsh 审批服务向用户弹确认(allowed-once 才执行,
  // 无审批服务的组合按 deny 处理)。模型无法单方通过。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (exec.name === 'memory_delete_all') {
      return { kind: 'ask', reason: 'memory_delete_all permanently deletes every memory in scope' }
    }
    if (exec.name === 'memory_prune' && (exec.arguments as { dryRun?: boolean } | null)?.dryRun === false) {
      return { kind: 'ask', reason: 'memory_prune (dryRun=false) permanently deletes matching memories' }
    }
    return decision
  })
}
