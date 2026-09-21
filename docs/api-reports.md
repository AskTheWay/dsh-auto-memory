===== systemPrompt =====
## findings
# dsh 系统提示词子系统调研报告

核心包:`@deepseek-ai/dsh-system-prompt`,源码 `D:/python_workspace/agents/deepseek-harness/packages/core/system-prompt/src/index.ts`(单文件,全部 API 都在这里)。

## 1) `ctx.systemPrompt.section()` 完整签名

```ts
// packages/core/system-prompt/src/index.ts:455-464
section(section: PromptSection): () => void   // 返回 Cordis effect disposer

// packages/core/system-prompt/src/index.ts:52-76
export interface PromptSection {
  readonly name: string        // 层内唯一;同层重名抛错;scoped 层同名遮蔽全局层
  readonly order: number       // 必须有限数值(Number.isFinite),NaN/Infinity 抛 TypeError;升序拼接,同 order 按名称 code-unit 序
  readonly text: string | ((context: AssembleContext) => string)  // ★可以是函数,每次 assemble() 重新求值(同步调用!)
  readonly interpolate?: boolean  // 默认 true;false 保留字面 {{…}}
  readonly complete?: boolean     // true 时该段成为唯一完整提示词;多个 complete 段使组装失败
}
```

**text 可以是函数**——`assemble()` 内 `index.ts:606`:`typeof section.text === 'function' ? section.text(context) : section.text`,每次组装重新求值。这就是动态 MEMORY.md 索引的正确载体。**注意:text 函数是同步调用的**(assemble 是 async 方法但 text 调用点无 await),读 MEMORY.md 要么用 `node:fs` 同步读,要么异步预读到缓存;函数抛异常会直接炸掉该 step(走 `agent/error`)。返回 `''` 的段在 `renderPrompt()` 渲染时被丢弃(`index.ts:280-285` filter + `\n\n` join),所以"无记忆时不出段"只需返回空串。

`AssembleContext`(基础版 `index.ts:42-50`):`{ scope?: ScopeKey; signal?: AbortSignal }`;`dsh-agent` 包对它做了模块扩充(`packages/core/agent/src/runtime-types.ts:18-23`),增加 `agent?: Agent`——所以 text 函数里可写 `context.agent?.session.header.cwd` 拿到 cwd(每个 agent 有独立 cwd)。

## 2) `variable()` 与 `{{}}` 插值机制

```ts
// index.ts:538-547
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void
```
- name 必须匹配 `/^[a-z][a-z0-9_]*/`(VARIABLE_NAME,index.ts:186),否则抛错。
- **可以注册自定义变量**——README.zh.md 明说"任何插件都可以注册自己拥有的事实"。内置变量由 agent-loop 注册(`packages/core/agent-loop/src/index.ts:422-424`):`provider`、`model`、`cwd`(= `context.agent?.session.header.cwd`)。
- 插值规则(`interpolate()`,index.ts:326-363):严格模式——段文本里的 `{{name}}` 组,引用未注册变量**抛错**;已注册但本次求值为 `undefined` **抛错**;格式错误(有后续 `}}` 的不完整组)抛错;孤立 `{{` 无 `}}` 视为普通文本;替换值不会二次扫描;无转义语法(要字面花括号用 `interpolate: false`)。
- 性能注意:`assemble()` 会为**每次组装**求值**所有**已注册变量的 provider(index.ts:565-574),不管段里有没有引用。

## 3) order 数值分配惯例

集中分配表 `SECTION_ORDERS`(index.ts:125-160,`as const`,**未导出**);`getSectionOrder(name: PromptSectionOrderName)` 只接受仓库内部具名位置(类型为 `keyof typeof SECTION_ORDERS`),外部插件无法新增名字——官方 Agent Note(`.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.zh.md`)明确:"外部插件可以为自己的 section 或 context 选择任意有限数字 order。具名 order 查询属于仓库内部位置,而不是扩展 API。"外部段与官方段同 order 也合法(按名称 code-unit 序打破平局)。

官方占用值(全部为整数,相邻差 ≥10):
- `-1000` harness:identity;`0` deployment:persona-prefix;`500` plan:policy;`600` team:policy;`800` tools:ptc-only;`900` context:file-reference
- 本地工具:`1000` tool:bash、`1010` tool:pwsh、`1100` read、`1200` write、`1300` edit、`1400` glob、`1500` grep、`1600` jobs、`1700` pty
- 高层工具:`2000` web_search、`2100` web_fetch、`2200` lsp、`2300` session-query、`2400` goal、`2500` cordis、`2600` workflow、`2700` ralph、`2800` subagent、`2900` report、`3000` computer-use
- `3100` MCP servers;`5000` tools:sdk;`9000` deliverable file refs;`9900` structured output;`10000` harness source;`10100` web surface;`10200` persona-suffix
- runtime-context(独立序列 CONTEXT_ORDERS,index.ts:165-169):`110` sandbox、`115` approval、`120` subagent-delegation

**外部插件可用空档**(无保留机制,仅事实上的空隙):1–499、601–799、901–999、1701–1999、3101–4999、5001–8999、9901–9999、>10200。memory 索引段建议放 3000–4999 区间(如 4000)——位于所有 tool 指导与 tools:sdk 之间。

## 4) agent 作用域注册

机制三件套:
1. **agent 即 ScopeKey**:`packages/core/agent-loop/src/agent.ts:104-105` `this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`。`createScope`(`packages/core/scope/src/index.ts:137-147`)用 `ctx.extend({ [kScope]: key })` 给 `agent.ctx` 打上 agent 身份标记,`scopeOf(ctx)` 可读回。
2. **调用方上下文追踪**:SystemPrompt 是 Cordis `Service`;`vendor/cordis/src/service.ts:46-48` 定义 tracker `{ property: 'ctx' }`,加上 `vendor/cordis/src/utils.ts:165-218` 的 traceable proxy——通过某个 ctx 访问 `ctx.systemPrompt` 时,服务方法内的 `this.ctx` 解析为**调用方的 ctx**(`utils.ts:176`)。因此 `section()` 内 `this.layers.effect(this.ctx, …)`(`index.ts:459-463`)天然按调用 ctx 落层:`ScopedLayers.effect`(`packages/core/scope/src/store.ts:226-266`)用 `scopeOf(ctx)` 决定放全局层还是该 agent 的 scoped 层。
3. **遮蔽**:`assemble()` 用 `ScopedLayers.merge(scope, …)`(store.ts:208-217)合并全局层+scope 链层(近者胜),scoped 同名段遮蔽全局段。

**全局注册**:在插件 `apply(ctx, config)` 里直接 `ctx.systemPrompt.section(...)`(插件自身 ctx 无 scope 标记 → 全局层)。
**仅某 agent 生效**——两条官方路径:
- **路径 A(每 agent 注册)**:`ctx.on('agent/created', ({ agent }) => agent.ctx.systemPrompt.section(...))`,并在启动时补齐已存在 agent(`for (const agent of ctx.agents.list()) ...`),在 `agent/disposed` 时由 scoped ctx 生命周期自动回收。完整范本:`packages/context/file-reference-local/src/index.ts:66-97`——`agent.ctx.inject(['systemPrompt','tools'], (scope) => scope.systemPrompt.section({...}))`。
- **路径 B(全局注册+动态空串)**:注册一个全局段,text 函数按 `context.agent`/`context.scope` 判断,不适用时返回 `''`(渲染时丢弃)。范本:`packages/core/tools/src/index.ts:856-894`(`text: context => this.modeFor(context.scope) === 'ptc' ? PTC_ONLY_INSTRUCTION : ''`)及 `packages/mcp/mcp-client/src/server-context.ts:33-38`(`text: () => connection.instructions()`)。对 auto-memory 这种"每 agent 一个 cwd 一个索引"的需求,路径 B 更简单,且 text 函数里能拿到 `context.agent.session.header.cwd`。

agent 作用域事件监听用 scope 过滤(`ctx.on('agent/created')` 载荷里拿 agent;`@deepseek-ai/dsh-scope` 的 Scoped carrier)。

## 5) 组装时机(索引文件被工具改写后自动反映吗?——会)

- **每个 step 一次**:`packages/core/agent-loop/src/agent.ts:241-260` `preStep()` 对每个拟议 step(一轮内的每个模型请求,含工具结果后的下一步)都执行 `await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`。`assembleContextFor`(`packages/core/agent/src/dispatch.ts:174-176`)返回 `{ agent, scope: agent, signal? }`(agent 与 scope 永远一起设置,保证 agent-scoped 贡献不丢)。
- **函数 text 每次 assemble 重算** → step N 里 memory 工具改写 MEMORY.md 后,step N+1 的 preStep 重新 assemble、重新调 text() → **新索引自动进入下一次请求**,插件无需任何失效通知。同理变量 provider 也每次重算。
- 渲染结果进入历史的规则(`packages/core/agent-loop/src/runtime-context.ts:60-106` `SystemPromptProjection.project`,agent.ts:360-373 提交 `system/message`):文本未变 → 不产生任何提交(缓存友好);变化 → 默认原地替换首个 system 节点(前缀缓存从首个变化 token 失效),当适配器路由声明 `systemPromptUpdate: 'in-history'` 时改为在已缓存历史后追加。系统提示词以派生历史里的 system 角色消息到达模型(请求体无独立 system 字段)。
- 注册/注销会 emit `'system-prompt/change'`(index.ts:37,纯通知事件,loop 不监听——反正每步都重组装)。
- `AssembleContext.signal` 只属于当次组装请求。

## 6) 预算控制先例

**system-prompt 包本身没有任何段长度限制/截断机制**——唯一相关行为是空段丢弃。需要自行实现。仓库先例:
- `packages/skill/tool-skill/src/index.ts:61-79`:`catalogDescriptionMaxLength` 配置(schemastery `z.number().default(...)`)截断目录里每条 skill 描述——与"MEMORY.md 索引每条摘要限长"最接近的先例。
- `packages/fs/tool-str-replace-editor/src/index.ts:17,33-37`:`maybeTruncate(content, maxOutputChars)` + `<response clipped>` 标记。
- `packages/compaction/compaction-tool-result-pruner/`:工具结果的字符预算裁剪(config 化)。

## 与移植直接相关的补充发现

- **备选注入通道**:`ctx.systemPrompt.context(PromptContext)`(`{ name; order; text: string | ((context) => string) }`,index.ts:79-86,`context()` 注册 index.ts:490-499)——runtime context 不进系统提示词,而是渲染成**user 角色 durable 快照**追加在已缓存历史之后(只在整体快照文本变化时提交,`runtime-context.ts:147-157`),头部固定 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."(index.ts:304-308)。这是 dsh 为"会话中变化的动态事实"设计的缓存友好通道(sandbox/approval 策略都走这里)。若忠实移植 Claude Code(MEMORY.md 在系统提示词里)→ 用 section;若担心索引频繁变化打断 KV 前缀缓存 → 可考虑 context 通道。另有第三种模式:tool-skill 用 `agent/pre-step` waterfall 把目录作为 user 消息注入并按 digest 去重(`packages/skill/tool-skill/src/index.ts:213-251`)。
- **段命名惯例**:`domain:name`(`tool:*`、`context:*`、`mcp:*`、`deployment:*`、`preset:*`…),建议 `memory:*`。
- **外部 npm 插件形状**(Cordis 插件):`export const name`、`export const inject = ['systemPrompt', ...]`、`export function apply(ctx, config)`;Config 用 schemastery `z.object({...})` 挂 `static Config`。范本:`packages/preset/agent-presets/tests/fixtures/plugins/contribute.js`。
- 重名报错文案会提示正确做法:`prompt section "x" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`(index.ts:384-386)。
## codeSnippets
// ===== 1. PromptSection 完整类型(packages/core/system-prompt/src/index.ts:52-76)=====
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}
// SystemPrompt 服务方法(index.ts:455-464):
section(section: PromptSection): () => void

// ===== 2. 变量(index.ts:538-547)=====
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void

// ===== 3. AssembleContext 及 agent 扩充(index.ts:42-50 + packages/core/agent/src/runtime-types.ts:18-23)=====
export interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext { agent?: Agent }
}
// agent-loop 内置变量(packages/core/agent-loop/src/index.ts:422-424):
ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
ctx.systemPrompt.variable('model', context => context.agent?.options.model)
ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)

// ===== 4. 每步组装(packages/core/agent-loop/src/agent.ts:241-246)=====
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
  const signal = this.phase.abort.signal
  const claimed = this.inbox.claim(target, position.turn)
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
  // ...
}
// assembleContextFor(packages/core/agent/src/dispatch.ts:174-176):
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}

// ===== 5. 动态 text 求值(index.ts:602-611 assemble() 内)=====
const assembled = {
  name: section.name,
  text: typeof section.text === 'function' ? section.text(context) : section.text,
  ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
}

// ===== 6. agent 作用域注册范本(packages/context/file-reference-local/src/index.ts:66-97)=====
const installPrompt = (agent: Agent) => {
  const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
    scope.systemPrompt.section({
      name: 'context:file-reference',
      order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
      text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
    })
  })
}
for (const agent of ctx.agents.list()) installPrompt(agent)
ctx.on('agent/created', async ({ agent }) => { await installPrompt(agent) })
ctx.on('agent/disposed', ({ agent }) => disposePrompt(agent))

// ===== 7. 全局注册 + 按 agent 动态开关(packages/core/tools/src/index.ts:876-894)=====
private sdkSection(): PromptSection {
  return {
    name: 'tools:sdk',
    order: this.ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
    interpolate: false,
    text: (context) => {
      const mode = this.modeFor(context.scope)
      if (mode === 'native') return ''
      // ...
    },
  }
}

// ===== 8. 动态 MCP 指令段范本(packages/mcp/mcp-client/src/server-context.ts:32-39)=====
inner.systemPrompt.section({
  name: `mcp:${server}`,
  order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
  interpolate: false,
  text: () => connection.instructions(),
})

// ===== 9. 外部 npm 插件形状(packages/preset/agent-presets/tests/fixtures/plugins/contribute.js)=====
export const name = 'contribute'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({ name: `preset:${config.tool}`, order: 10, text: `...` }))
}

// ===== 10. runtime-context 备选通道(index.ts:79-86 + 304-308)=====
export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}
// joinContextSections 输出头: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + body

// ===== 11. dsh-auto-memory 索引段建议写法(综合以上结论)=====
// 插件 apply(ctx) 内全局注册,每步同步求值,空字符串=不出现:
ctx.systemPrompt.section({
  name: 'memory:index',
  order: 4000, // 外部插件自选,落在 3101-4999 空档
  text: (context) => {
    const cwd = context.agent?.session.header.cwd
    if (cwd === undefined) return ''
    return renderMemoryIndexSync(cwd) // 同步读或读缓存;抛错会炸掉该 step
  },
})
## gotchas
1. text 函数是同步调用(assemble() 内无 await):读 MEMORY.md 必须用 node:fs 同步 API,或异步预读+内存缓存;text 内抛异常会直接使该 step 失败并走 agent/error 事件——建议 try/catch 后返回 ''。
2. 所有已注册 variable 的 provider 每次组装都会被求值(即使无段引用),不要在 provider 里做昂贵 I/O。
3. 插值是严格模式:{{未知变量}}/{{无值变量}}/畸形组都会让组装抛错。索引文本里若可能出现字面 {{ }}(如引用用户代码),该段必须 interpolate: false——但注意 interpolate: false 时也无法用 {{cwd}} 等变量,需在 text 函数里自己拼接。
4. 变量名只能 /^[a-z][a-z0-9_]*$/。
5. 系统提示词变化会重写历史首个 system 节点,KV 前缀缓存从首个变化 token 起失效(仅 systemPromptUpdate:'in-history' 路由例外,由适配器声明,插件控制不了)。索引每步变化越频繁,缓存损失越大——这是选择 section(系统提示词内)vs context(user 快照,追加式、缓存友好)通道的核心权衡。
6. 不要调用 getSectionOrder():其参数类型 PromptSectionOrderName 是 keyof 内部 SECTION_ORDERS,外部包无法传入自己的名字;官方明确外部插件自选任意有限数字。
7. 同层段名重复抛错;想让某个 agent 覆盖全局段,必须经 agent.ctx 注册同名段(scoped 层遮蔽全局层),或用全局段+text 按 context.agent 返回空串/变体。
8. 在 agent/created 里注册时,还要处理启动时已存在的 agent(ctx.agents.list() 遍历),否则会漏掉 resume 场景(见 file-reference-local 范本)。
9. complete: true 是全量替换语义(该段成为唯一提示词段),多个 complete 段直接组装失败;memory 插件绝不要用。
10. order 用 NaN/Infinity 会 TypeError;同 order 的平局按段名 code-unit 序(非 locale 序),跨平台确定。
11. 注册 API 是 ctx.systemPrompt.section/service 但真正落层取决于调用方 ctx(cordis traceable 机制):同样的代码在插件 ctx 里是全局注册,在 agent.ctx 里是 agent 作用域注册——把注册代码放在错误的 ctx 上是最高频错误。
12. 工具 schema 与提示词段是独立输入:限制工具(restrict)不会自动移除对应 tool:* 段,需在 text 里自查(官方做法:text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : PROMPT)。
## openQuestions
1. `systemPromptUpdate: 'in-history'` 能力的具体适配器覆盖面(哪些 provider 路由声明了它)未逐一核实——只确认了机制存在于 prepareCall/llm 层(agent-loop README 引用),不影响 memory 插件实现(插件无法控制它)。
2. 外部插件发布为独立 npm 包后如何被 dsh 部署加载(Loader 对外部包名的解析、peerDependencies 版本要求)属于 app-boot/loader 范畴,本次未调研——实现时需另行确认插件加载配置格式(fixture 显示 entry module 需 ESM 可解析)。

---

===== agentInstructions =====
## findings
# dsh agent-instructions 插件调研报告(供 dsh-auto-memory 实现)

包根目录:`D:\python_workspace\agents\deepseek-harness\packages\context\agent-instructions\`
源码仅 6 个文件:`src/index.ts`(入口/编排)、`src/config.ts`(配置)、`src/files.ts`(发现+读取)、`src/render.ts`(渲染+预算)、`src/state.ts`(持久状态+对账)、`src/digest.ts`(SHA-1)。

## 1) AGENTS.md 注入到哪里 —— 不是系统提示词,是持久 user 角色消息

**它完全不动系统提示词**(devDependencies 有 dsh-system-prompt 但运行时未用)。设计原则(README.zh.md「设计理念」):工作区指令是**持久对话内容**,以普通 `user/message` 事件进入会话日志,可回放/压缩/恢复。

注入路径有两条,均产自 `compose()`(index.ts:108-225):

**(a) pre-step 折入当前步批次**(index.ts:315-341,核心注入点):
```ts
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
  const decision = await next()          // waterfall,先放行
  await waitForProjections(agent)
  const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
  const desired = await compose(agent, signal, messages, pending)
  if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
    syncInbox(agent, messages, desired); return decision   // 留在 inbox 不进请求
  }
  for (const message of pending) agent.inbox.remove(message.id)
  if (desired === undefined || decision.messages.some(m => sameContextPayload(m, desired))) return decision
  const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
  const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)  // 紧跟已领取消息之后
  return { ...decision, messages: entered }   // 改写进入该步的 UserMessage[]
})
```
事件签名(packages/core/agent/src/runtime-types.ts:320,`@mode waterfall`):
```ts
'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
// PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }  (runtime-types.ts:112)
```

**(b) 异步写入 inbox 'next-step'**(工具 touch 后的刷新,index.ts:227-279 `syncInbox`/`queueProjection`):用 `agent.inbox.prepend('next-step', desired)` / `agent.inbox.replace(id, desired)` / `agent.inbox.remove(id)`,并对同 payload 幂等(先查 `claimed`/会话面中是否已存在)。

消息本体构造(index.ts:215-224):
```ts
createUserMessage({
  content,   // UserMessage['content'][number][] 即 ContentBlock[]
  source: { kind: 'agent-instructions', form: 'instructions', baseline: true?, baselineIdentity?: string, changes: AgentInstructionChange[] },
})
```
类型注册(state.ts:48-52,合并扩展 dsh-llm 的 source 联合类型):
```ts
export interface AgentInstructionSource {
  kind: 'agent-instructions'; form: 'instructions'  // ContextForm 语义轴
  baseline?: true; baselineIdentity?: string; changes: AgentInstructionChange[]
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'agent-instructions': AgentInstructionSource } }
```
`AgentInstructionChange = { action: 'set' | 'replace' | 'remove'; scope: string; path: string; digest?: string }`(render.ts:47-52,digest 为 SHA-1 hex)。

模型可见文本由插件自己包 `<\system-reminder>` 帧(render.ts:242,`buildInstructionText`),内容里字面 `<\/system-reminder>` 被转义成 `<\/system-reminder>`(render.ts:81-83)。

## 2) 文件读取:ctx.fs 优先,缺失时插件生命周期 = no-op;独立导出函数回退 Node fs

- 插件生命周期(index.ts:119-120):`const fileSystem = ctx.get('fs'); if (fileSystem === undefined) return undefined` → **无 fs 提供方时整个插件不注入任何内容**(模块头注释:"Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products mount it as a no-op")。fs 不在 inject 列表里,是机会式获取。
- 但 `src/files.ts` 的所有导出函数签名是 `fileSystem?: FileSystem` 形参,`undefined` 时**回退 Node fs**:`nodeStatFile` 用 `stat`(node:fs/promises),`nodeTextChunks` 用 `createReadStream(path, { encoding: 'utf8', signal })`(files.ts:102-115, 329-332);有提供方时走 `fileSystem.resolve(path, {signal}) → FsTarget`,再 `fileSystem.stat(target, signal)` / `fileSystem.streamText(target, signal)`(files.ts:117-139, 346-348)。
- `FileSystem` 是抽象类 Service(packages/fs/fs/src/index.ts:86,`super(ctx, 'fs')`),关键方法签名:
  ```ts
  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  abstract writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
  abstract editText(target, edit: FsEditRequest, expected?: { version: FsVersion }, ...): Promise<FsEditOutcome>
  ```
  `FsInfo = { version: FsVersion; type: 'file'|'directory'|'other'; size?: number }`(packages/fs/fs/src/types.ts:76)。`FsVersion`/`FsTargetKey` 是 Branded 类型(不可自造,只能从 provider 拿)。`FS_NOT_FOUND` 是 provider 端"确认不存在"的错误码(files.ts:99)。
- 读不存在/失败语义:Node 侧 `ENOENT`/`ENOTDIR` → absent;provider 侧抛错 → unavailable(该候选跳过);但 `findProjectRoot`/`existsAsMarker` 中非缺失类错误**原样抛出**(README.zh.md:根标记元数据决策,权限失败必须失败而非换祖先根)。

## 3) 缓存与失效:无 watcher,三个触发点 + 版本/digest 快路径

**重读触发点**(README「已知限制」明确:没有文件系统 watcher):
1. **每个 `agent/pre-step`**:compose() 都会跑;基线只在「无可见基线 / baselineIdentity 不匹配」时重载(identity 匹配则保留,不重读)。恢复会话靠此对账。
2. **`tools/result` 事件**(emit 模式,packages/core/tools/src/index.ts:191):成功(非 isError、非 aborted、有 agent)的 `read`/`write`/`edit` 调用(index.ts:74 `FILE_TOUCH_TOOL_NAMES = new Set(['read','write','edit'])`)提取 `exec.arguments.file_path`(string),记为 touch。嵌套执行(PTC 子调用)沿 `exec.parent: ToolExecutionToken` 逐层上浮(index.ts:343-359,`executionTouches: Map<ToolExecutionToken, ProjectionTouch[]>`),只有根执行触发投影。
3. **`session/event` 的 `step/end`**:`stepIsOpen()` 为真(step 尚未入持久历史)时 touch 先攒在 `stepTouches: WeakMap<Session, ProjectionTouch[]>`,等 `step/end` 再 `queueProjection`(index.ts:286-313)。投影用 `projectionTails: WeakMap<Agent, Promise<void>>` 串行排队,pre-step 里 `waitForProjections` 等它排空。

**发现新文件的机制**:touchedPath → `descendantDirsBetween(cwd, touchedPath)`(files.ts:225-232)算出 cwd 到该文件之间途经的**更深目录**,对每个目录的全部候选 scope 做探测;`reconcileInstructionContext`(state.ts:247-434)把这些 scope 与可见状态对比,新文件 → `set`(渲染 "Additional instructions from: ..."),内容变化 → `replace`("Updated instructions from: ..."),消失 → `remove`("Instructions removed: ...")。README 强调:发现只跟随结构化 fs 工具,**bash cd 不触发**。

**版本缓存快路径**(state.ts):
```ts
export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>
export interface InstructionVersionState { path: string; version: FsVersion; digest: string; trimmedDigest: string }
```
scope key = `candidateScopeKey(directory, candidateName)` = `` `${directory}\u0000${candidateName}` ``(render.ts:110-125,NUL 分隔符防碰撞)。probe 返回 `ScopeInstructionProbe = { kind:'present'; file: ProbedInstructionFile } | { kind:'absent' } | { kind:'unavailable' }`(files.ts:74-77)。命中快路径的条件(state.ts:376-390):cached.path === probed.displayPath && cached.version === probed.version && 可见 change 非 remove && path/digest 一致 → 跳过重读。否则重读并比较 SHA-1 digest;同 path 同 digest → 只更新缓存不产生消息。**同目录一个成员 unavailable 时整组回滚保留上次结果**(state.ts:353-365,缓存热度不能决定兄弟转换是否发出)。

**基线复用/替换**:`workspaceBaselineIdentity(config, cwd, projectRoot)` 把发现配置序列化成 JSON(config.ts:69-82);`visibleBaselineSource`(index.ts:46-63)从已领取消息和会话面(`agent.session.surface.nodes` + 废弃的 `agent.session.eventAt(seq)` 读 `user/message` 事件)找最后一条 `baseline === true` 的消息;identity 匹配 → 复用不注入;不匹配 → 注入完整替换基线(带 REPLACEMENT intro,且对旧基线各 scope 生成 `remove` change,index.ts:167-176)。

## 4) maxBytes 预算的精确实现(render.ts)

两级预算:
- **`maxSourceBytes`**(默认 1,048,576):单文件硬上限。stat 已知 size 超限或流式累计字节超限 → **整文件跳过**(readBounded 返回 undefined,files.ts:334-364)。files.ts:340 有 TODO:聚合源预算未实现,每文件独立计。
- **`maxBytes`**:完整渲染消息(含 `<\system-reminder>` 帧、intro、预算标记、全部 section)的 UTF-8 字节上限;`<=0` 或非有限 → 插件整体禁用(index.ts:116-118)。dsh-base 默认给 65,536。

`renderInstructionContext(files, maxBytes, style)`(render.ts:275-332)的**精确降级顺序**(files 按 broadest→most-specific 排序):
1. 全量渲染能塞下 → 原样返回,`omitted=[]`、`truncated=[]`。
2. **从最宽泛侧整文件丢弃**:`for (start = 1; start < files.length; start++)` 逐个尝试 `files.slice(start)`,第一个塞下的后缀胜出,`omitted = files.slice(0, start)`。
3. 只剩最具体文件仍超 → **二分截断该文件**(`truncateToFit`,render.ts:249-273,对 `includedBytes` 在 [0, originalBytes] 上二分,找最大可塞下的截断长度);先用原 intro 试,塞不下换 `COMPACT_AGENT_INSTRUCTIONS_INTRO`("Workspace instructions were omitted or truncated to fit the configured byte budget.")再试一次。
4. 再塞不下 → 只留 section 标题行(`withTruncatedContent(file, 0)`);最后只剩预算通知文本;终极兜底对通知文本硬截断。
- **截断标记**(markerText,render.ts:215-225):`Workspace instruction budget ${maxBytes} bytes: omitted <path1>, <path2>; truncated <path> from <originalBytes> to <includedBytes> bytes`,放在 body 第一块。
- 工具函数:`byteLength = Buffer.byteLength(v,'utf8')`;`truncateUtf8`(render.ts:69-79)截断后回退 UTF-8 续字节避免劈开码点。
- 动态变更批有自己的预算路径 `renderInstructionChanges(items, maxBytes)`(render.ts:192-213):渲染塞不下的 change 直接不产生消息也不提交缓存(state.ts:425-429),下轮重试。

## 5) inject 声明与依赖

- `export const inject = ['sessionProjections']`(index.ts:34)——唯一硬依赖。用途仅一处:`stepIsOpen` 里 `ctx.sessionProjections.stateOf(session, 'turnBoundary')`(index.ts:287),返回 `TurnBoundaryProjection | undefined`(`{ openTurnStartSeq; lastStepStartSeq; lastStepBoundary: { kind:'start'|'end'; seq } | null; lastTurn }`,packages/core/agent/src/types.ts:69-78);缺失时**抛错** `'agent-instructions requires the turnBoundary session projection'`。`stateOf` 签名(packages/session/session-projection/src/index.ts:319):`stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined`。
- `fs` 为机会式依赖(`ctx.get('fs')`),不在 inject。
- 插件形态:`export function apply(ctx: Context, config: Config): void`;`export const name = 'agent-instructions'`(state.ts:34);`export const Config = z.object({...})`(schemastery,config.ts:39)。package.json peerDeps:@deepseek-ai/cordis、dsh-agent、dsh-fs、dsh-home-paths、dsh-llm、dsh-session、dsh-session-projection、dsh-tools;runtime deps:@deepseek-ai/dsh-util-values(assertNever)、@deepseek-ai/schemastery。
- 消费的事件:`'session/event'`(判断 `event.type === 'step/end'`)、`'agent/pre-step'`(waterfall)、`'tools/result'`(emit)。清理用 `ctx.effect(() => () => {...}, 'agent-instructions.projectionLifecycle')`。

## 6) 可直接复用到 MEMORY.md 索引注入的代码模式

1. **pre-step 折入**(index.ts:315-341 整段):MEMORY.md 索引应当像基线一样作为持久 user 消息注入——`await next()` → compose → `decision.messages.toSpliced(lastClaimedIndex+1, 0, desired)`。这是 dsh 里"把内容放进下一次模型请求且进入持久历史"的标准姿势,比系统提示词 section 更贴合 Claude Code auto-memory 的语义(Claude 也是把 MEMORY.md 注入系统提示词,但 dsh 的可恢复模型可见状态全部走会话日志;若坚持改系统提示词需走 dsh-system-prompt,那是另一套 API,不建议)。更简单的替代:`agent.inject(message)`(runtime-types.ts:241,"Queue model-facing context for the next pre-step without waking the driver")——如果不需要 agent-instructions 那种复杂幂等管理,auto-memory 用它即可。
2. **类型化 source + MessageSourceMap 合并声明**(state.ts:37-52):照抄写 `'auto-memory': AutoMemorySource`,可加 `form: 'instructions'`(dsh-llm 的 ContextForm 联合已含 'instructions',message.ts:50-62,UI 可据此归类)。
3. **`<\system-reminder>` 自包帧 + escapeInstructionFrameBody**(render.ts:10-11, 81-83, 242):帧由生产者烤进 content,内容中闭合标签必须转义。
4. **statFile/readBounded 双后端模式**(files.ts:102-147, 334-364):`ctx.get('fs')` 缺失回退 Node fs 的写法,及 stat 先行(拿 size/version)→ 流式限字节的读法。
5. **预算渲染全套**(render.ts:65-79, 215-332):byteLength/truncateUtf8/markerText/renderInstructionContext/truncateToFit 可近乎原样搬去限制 MEMORY.md 索引体积(auto-memory 只有一个文件,会走「单文件二分截断」分支)。
6. **workspaceBaselineIdentity + visibleBaselineSource**(config.ts:69-82, index.ts:46-63):配置指纹 JSON + 扫描 claimed 消息与会话面找旧基线,决定复用还是替换——MEMORY.md 索引同样需要"恢复会话时不重复注入、配置变了才重注"。
7. **digest 缓存**(digest.ts 全部 + state.ts:191-231):`instructionContentSha1`/`trimmedInstructionDigest` + `WeakMap<Session, Map<scope, {version, digest}>>`,防止每次 pre-step 重读 MEMORY.md 全文——这是把"每步都 compose"成本压到 metadata 比较的关键。
8. **touch 驱动失效**(index.ts:74-82, 343-359):auto-memory 自己的 memory_write/delete 工具跑完后想刷新索引,可在自己的工具实现里直接 queueProjection 等价物,不必依赖 fs 工具名;但如果要感知外部编辑 MEMORY.md,照抄 `tools/result` 监听 read/write/edit + `filePathFromExecution` + 父 token 上浮即可。
9. **config.ts 的 schemastery 声明 + resolveConfig 默认值归一**、RESERVED_PATH_SEGMENTS 过滤(config.ts:119-123)。
10. **`resolveDshHome`/`dshHomeDisplay`**(packages/util/home-paths/src/index.ts:87-123):`$DSH_HOME` 或 `~/.dsh` 解析与 `~/.dsh`/`$DSH_HOME` 符号化显示,auto-memory 的记忆目录(如 `~/.claude/projects/<slug>/memory/` 或 `$DSH_HOME` 下)应复用这对函数保持一致。
## codeSnippets
// 1) 入口与依赖声明 — D:\python_workspace\agents\deepseek-harness\packages\context\agent-instructions\src\index.ts
export function apply(ctx: Context, config: Config): void   // 标准cordis插件
export const inject = ['sessionProjections']               // index.ts:34(唯一硬依赖)
const fileSystem = ctx.get('fs')                            // index.ts:119 机会式fs,undefined即no-op
if (fileSystem === undefined) return undefined

// 2) 注入消息构造 — index.ts:215-224 + state.ts:37-52
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // (message.ts:204) 泛型:T & {id?:never;role?:never} => T & {id;role:'user'}
createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'agent-instructions', form: 'instructions', baseline: true, baselineIdentity: identity, changes },
})
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'agent-instructions': AgentInstructionSource } }

// 3) pre-step 折入 — index.ts:315-341(事件签名见 packages/core/agent/src/runtime-types.ts:320)
const decision = await next()
const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired) }

// 4) inbox API — packages/core/agent/src/runtime-types.ts:48-100(Inbox接口)
agent.inbox.nextStep                    // readonly UserMessage[]
agent.inbox.prepend('next-step', msg); agent.inbox.replace(id, msg); agent.inbox.remove(id)
agent.inject(message)                   // runtime-types.ts:241 更简单的"下个pre-step注入"通道

// 5) fs 双后端 — src/files.ts
async function statFile(path, fileSystem?: FileSystem, signal?): Promise<StatFileProbe>  // absent/present/unavailable
  // 有provider: await fileSystem.resolve(path, {signal}) → FsTarget; await fileSystem.stat(target, signal) → FsInfo|undefined
  // 无provider: node stat(); createReadStream(path,{encoding:'utf8',signal})
async function readBounded(file, maxSourceBytes, fileSystem?, signal?): Promise<string | undefined> // 超限整文件丢弃

// 6) FileSystem 服务关键签名 — packages/fs/fs/src/index.ts:86-277(declare module cordis: Context.fs)
resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>   // FsInfo={version:FsVersion; type:'file'|'directory'|'other'; size?:number}
streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
readText(target: FsTarget, signal?: AbortSignal): Promise<string>
writeText(target, content: string, expected?: FsWriteIntent, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
editText(target, edit: FsEditRequest, expected?: { version: FsVersion }, ...): Promise<FsEditOutcome>

// 7) 预算渲染 — src/render.ts:275-332 renderInstructionContext 降级顺序
// 全量→丢最宽泛文件(omitted标记)→二分截断最具体文件(换COMPACT intro再试)→仅标题→仅通知→硬截断
// 标记: `Workspace instruction budget ${maxBytes} bytes: omitted <paths>; truncated <p> from <orig> to <incl> bytes`
function truncateUtf8(value: string, maxBytes: number): string  // render.ts:69 续字节回退,不劈码点

// 8) 版本缓存 — src/state.ts
type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>
interface InstructionVersionState { path: string; version: FsVersion; digest: string; trimmedDigest: string }
// scope key: candidateScopeKey(dir, name) = `${dir}\u0000${name}`(render.ts:123)
// 快路径(state.ts:376-390): path===probed.displayPath && version===probed.version && 可见digest一致 → 跳过重读

// 9) tools/result 失效 — index.ts:74-82, 343-359(事件:packages/core/tools/src/index.ts:191 emit模式)
const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])
// exec: Readonly<ToolExecution>{ name; arguments; agent?; parent?: ToolExecutionToken; token; signal }
// 提取 exec.arguments.file_path;嵌套调用沿 exec.parent 上浮到根执行才触发投影;step开启时延迟到 session/event 的 step/end

// 10) home 路径 — packages/util/home-paths/src/index.ts
resolveDshHome(configured?: string, env = process.env): string   // configured > $DSH_HOME > ~/.dsh(空白env视为未设置)
dshHomeDisplay(resolvedHome): string                             // '~/.dsh' 或 '$DSH_HOME'
## gotchas
1. **无 fs 提供方 = 完全 no-op**:插件生命周期强依赖 `ctx.get('fs')` 返回值,缺失时 compose 直接 return undefined,连 Node fs 都不用(files.ts 的 Node 回退只服务于包外直接调用其导出函数的场景)。dsh-auto-memory 若想让记忆功能在无 fs provider 的部署也工作,必须自己决定回退策略(如直接 Node fs——但那会绕过沙箱/远程后端,一般不建议照抄)。
2. **消息一旦进入 pre-step 批次就是持久历史**:`decision.messages` 里的内容会成为 `user/message` 事件进入会话日志,压缩(compaction)前一直在派生历史里占 token。auto-memory 的索引应控制 maxBytes(dsh-base 给 agent-instructions 的默认是 65536 字节),且"每条记忆文件全文"绝不该全注入——只注入 MEMORY.md 索引本身。
3. **注入消息的幂等要自己做**:agent-instructions 用 `sameContextPayload`(isDeepStrictEqual 比较 content+source)防止重复注入,并用 baselineIdentity 决定恢复会话时复用还是替换基线。auto-memory 若每次 pre-step 无脑重建消息,会在会话里堆出大量重复 user 消息。
4. **`<\/system-reminder>` 转义是安全边界**:记忆文件内容是"用户/仓库可控文本",不转义就能闭合插件控制的帧(render.ts escapeInstructionFrameBody;README「不变式」一节)。照抄。
5. **step 边界规则**:工具 touch 发生在"开放 step"内时必须延迟到 `step/end` 再投影,否则异步投影会在步骤历史尚未持久化时改写 inbox,产生顺序错乱;这套 stepIsOpen/sessionProjections/turnBoundary 逻辑是 inject 硬依赖存在的原因。auto-memory 若只在自己的 memory_* 工具回调里同步刷新,可以避开整个复杂度,但要注意 PTC 嵌套执行(parent token)场景。
6. **`agent.session.eventAt(seq)` 是 deprecated 读取路径**(源码里带 oxlint-disable 注释,"migration deferred"),新代码不要学;surface.nodes 遍历也标注了迁移待定。
7. **发现跟随结构化 fs 工具而非 shell**:bash 的 cd/cat 不触发刷新——设计决策已写进 README「已知限制」。auto-memory 的 memory_read 工具天然知道路径,不需要这个间接层。
8. **symlink 指令文件会被跟随**(stat/resolve 跟随末段 symlink),README 明确列为信任边界风险。若 auto-memory 允许记忆文件是 symlink,同样要考虑。
9. **FsVersion/FsTargetKey 是 Branded 类型**,只能从 provider 的 resolve/stat 拿到,不能自己构造;版本比较用 `===`(opaque string)。
10. **maxBytes<=0 或非有限数 = 插件禁用**(不是"无限制");maxSourceBytes<=0 同样整体禁用(loadBaselineInstructionSet files.ts:419-420)。
11. **同目录去重是"trim 后内容一致"才折叠**(trimmedInstructionDigest):AGENTS.md 与 CLAUDE.md 内容相同只渲染一份;auto-memory 单文件场景用不上,但若记忆目录有索引+别名文件需注意。
12. **providor 端"确认不存在"的错误码是 `FS_NOT_FOUND`**(files.ts:98-100),与 Node 的 ENOENT/ENOTDIR 分开处理;unavailable(瞬时失败)≠ absent(确认没有)——刷新时 unavailable 保留旧状态不产生 remove 消息。
13. **apply 的 config 是 schemastery schema 对象**(`Config: z<Config>`),dsh 用它生成配置目录;npm 插件包要按此规范导出同名 `Config` 与 `name`。
## openQuestions
1. dsh-system-prompt(系统提示词 section 注册 API)未在本任务范围内调研——若产品要求 MEMORY.md 必须进系统提示词而非持久 user 消息,需要另行读 packages/*/system-prompt 包的 AssembleContext/section API(agent-instructions 走的是 user 消息路线,本报告已论证该路线更贴合持久记忆语义)。
2. `Session.surface.nodes`/`eventAt` 的新替代 API(migration deferred 注释指向何处)未追踪;写新代码时建议先查 dsh-session 当前推荐的历史读取方式。
3. dsh npm 插件的加载机制(cordis-plugin-loader 如何发现/安装外部 npm 包、config 如何从 profile YAML 传入)未调研——那是另一份调研的范围,但它决定 dsh-auto-memory 的打包形态(package.json exports 需仿照本包:`"."` → `./lib/index.js` + `./src/*` 直出 TS)。

---

===== skillInject =====
## findings
# dsh tool-skill 插件与 agent.inject 机制调研报告

## 1) agent.inject():完整签名、消息模型、时机

**签名**(`packages/core/agent/src/runtime-types.ts:241`,运行时接口合并进 `Agent`):
```ts
inject(message: UserMessage): void
```

**实现**(`packages/core/agent-loop/src/agent.ts:145-147`,`ReactLoopAgent implements Agent`):
```ts
inject(input: UserMessage): void { this.send(input, 'next-step', false) }
```
`send(message: UserMessage, target: InboxTarget, wakeup: boolean): void`。`InboxTarget = 'next-turn' | 'next-step'`(`packages/core/agent/src/types.ts:30`)。三个兄弟方法:
- `followup(message)` → `send(msg, 'next-turn', true)`:排一个新 turn 并唤醒
- `steer(message)` → `send(msg, 'next-step', true)`:最近 step 边界消费、唤醒
- `inject(message)` → `send(msg, 'next-step', false)`:**排队但不唤醒**

**官方文档语义**(runtime-types.ts:233-241):为下一个 pre-step 排入模型可见上下文、不唤醒 driver。running driver 在最近的后续 step 边界认领;idle driver 挂在 inbox 直到 followup/steer 唤醒;可能错过一个 pre-step 已认领其批次的请求;cancel/dispose 可能丢弃。

**消息模型**:`UserMessage`(`packages/llm/llm/src/message.ts:143`)= `{ id: MessageId, role: 'user', content: ContentBlock[], source: MessageSource }`,用 `createUserMessage(input)`(message.ts:204,from `'@deepseek-ai/dsh-llm'`)构造,自动生成 UUID id 并 deepFreeze。注入上下文的 source 标准写法是 `{ kind: 'plugin', plugin: '<插件名>' } & ContextFormed`。`ContextFormed`(message.ts:81-97)可选语义标签:`form: 'instructions' | 'catalog' | 'snapshot' | 'relay' | 'recall'`(无附加字段)或 `form: 'notice'`(必带 `summary: string`,上限 `CONTEXT_SUMMARY_MAX_CHARS = 120`,用 `boundContextSummary()` 截断)或 `form: 'snapshot'`(必带 `sections: ContextSnapshotSection[]`)。`MessageSourceMap`(message.ts:102)是 merge-extensible——插件 `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'my-kind': MySource } }` 加自己的 kind(tool-skill 加了 `'skill-catalog'`,dsh-skill 加了 `'skill-invocation'`)。

**注入后模型看到什么**:消息进 next-step inbox → loop 的 `preStep()` 通过 `inbox.claim()` 认领 → 过 `agent/pre-step` waterfall → step 提交时逐条 `session.append('user/message', message, { surfaceOp: 'append' })`(`packages/core/agent-loop/src/agent.ts:374-377`)——即成为 **durable、模型可见的 user 角色历史消息**,以 user-role 消息呈现(非 system)。`SessionEventMap['user/message']` 的文档(types.ts:290-297)明确:"a user-role message on the model-visible surface: a direct human prompt..., a synthetic `agent.inject()` context (file-change notices, subdir AGENTS.md, skill content, cron notifications, …)"。

**何时用(真实用例)**:
- `packages/jobs/tool-jobs/src/index.ts:278-299`:后台 job 完成通知——busy owner 用 `owner.inject(message)`(notice form;busy 时 notice 留在 next-step inbox,turn 无法越过它关闭);idle owner 用 `owner.followup(message)`(未认领的 notice = 模型永远不会知道的完成事件,必须唤醒)。
- `packages/subagent/subagent/src/continuation-activation.ts:871-881`:子代理结算通知——parent 正在关闭时 `parent.inject(message)`,否则按 parent.status 选择 queue/steer 唤醒。

## 2) tool-skill 的 apply() 结构

文件:`packages/skill/tool-skill/src/index.ts`。插件入口约定(cordis):
```ts
export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']   // ← 声明依赖的 ctx 服务(cordis 服务注入),与 Agent.inject 方法无关!
export interface Config { catalogDescriptionMaxLength?: number }
export const Config: z<Config> = z.object({ catalogDescriptionMaxLength: z.number().default(500) })

export function apply(ctx: Context, config: Config = {}): void { ... }
```
apply() 做四件事:

**(a) 注册 `skill` 工具**(81-161 行):`defineTool({ name: 'skill', description, parameters: { name: { type: 'string', required: true, description } }, output: { schema, render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }] }, execute, presentCall })` 后 `ctx.tools.register(skillTool)`。execute 内:
```ts
const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
const skill = await ctx.skills.get(args.name, lookup)
return { name: skill.name, provider: skill.provider, ...skill.resourceBase !== undefined ? { resourceBase: { ...skill.resourceBase } } : {}, content: skill.content }
```
校验 `isSkillName`(kebab-case)与 `isModelInvocable`。

**(b) 用户 `/name` 手势监听**(177-204 行):`ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {...})`。waterfall 模式:先 `const decision = await next()`(拿到底层 decision),再返回 `{ ...decision, messages: [...decision.messages, ...injections] }`。只扫 `source.kind === 'user'` 的消息文本块,`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 匹配,加载 user-invocable 技能,注入 `createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill) }], source: { kind: 'skill-invocation', name, form: 'instructions' } })`。

**(c) 目录(catalog)监听**(213-251 行):第二个 `agent/pre-step` listener。关键判断 `ctx.tools.get(skillTool.name, agent) === skillTool`(精确注册对象身份——scoped 同名 shadow 不会继承目录);`await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })`,`snapshot.complete` 为 false 则跳过;`skills.filter(isModelInvocable)` → entries(`{ name, description(截断) }`)→ `digestCatalogEntries`(对 entries JSON 做 sha256)→ 与会话历史中已发布的 catalog digest 比对:相同则移除 pending 的旧消息;不同则发布 `renderCatalogMessage`(首次)或 `renderCatalogUpdate`(替换,`update: true`)——都是 `createUserMessage`,文本为 `<\system-reminder>` 包裹的 `<available_skills>` 名单,source 为 `{ kind: 'skill-catalog', form: 'catalog', entries }`(entries 是结构化 durable 记录,UI 消费者不得 re-parse 模型文本)。从未发布过且无技能时完全不注入。

**(d) 类型合并声明**(43-47 行):`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'skill-catalog': SkillCatalogSource } }`。

**没有 systemPrompt.section**——tool-skill 不往系统提示词写任何东西,目录是 durable user 消息。

## 3) 技能目录读取与模型发现机制

**tool-skill 本身不读文件系统**。读取分层:
- `ctx.skills` 服务 = `SkillRegistry`(`packages/skill/skill/src/index.ts`),API:
  - `list(options?: SkillViewOptions): Promise<SkillSummary[]>`(SkillSummary 含 name/description/whenToUse?/invocation/path?/source/provider/resourceBase?)
  - `snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>`(`{ skills: SkillSummary[], complete: boolean }`;incomplete 不缓存,消费方保 last-good 下次重试)
  - `get(name: string, options?: SkillViewOptions): Promise<SkillDefinition | undefined>`(SkillDefinition = SkillSummary + content: string + metadata?)
  - `registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`;`register(skill: SkillRegistration): () => void`(runtime 技能,rank 250)
  - `SkillViewOptions = { cwd?: string, signal?: AbortSignal, scope?: ScopeKey }`(scope 传 agent 本身——agent 即其自身 scope key)
  - 变更事件 `'skills/change'(): void`
- 目录提供者 = `@deepseek-ai/dsh-skill-filesystem`(`packages/skill/skill-filesystem/src/index.ts`):`export const name = 'skill-filesystem'; export const inject = ['skills']`。Config:`providerName`(默认 'filesystem')、`includeDefaultRoots`、`dshHome`(默认 `$DSH_HOME` 或 `~/.dsh`)、`agentsHome`(默认 `$DSH_AGENTS_HOME` 或 `~/.agents`)、`customSkillDirs: string[]`、`watch`(chokidar + `watchStabilityThresholdMs` 200ms 稳定阈值)、`bundledSkillDir` 等。rank:PROJECT_DSH=100 < PROJECT_AGENTS=200 < CUSTOM=300 < USER_DSH=400 < USER_AGENTS=500 < BUNDLED=600,同层内同名低 rank 赢。发现 directory-bundle 与 flat Markdown + YAML frontmatter。

**模型发现机制 = 名单注入(catalog)+ 按精确名加载,不是搜索**。流程:pre-step 注入含 `- \`name\`: description` 行的 `<available_skills>` 名单(description 规范化空白、截断到 `catalogDescriptionMaxLength` 默认 500、escapeText 转义)→ 模型按名单用 `skill` 工具按名加载全文 → `renderSkillContent()`(from `@deepseek-ai/dsh-skill`)渲染成 `<skill_content name="...">` 块。目录成员/描述/可见性变化时以 sha256 digest 对比(entries 而非渲染文本),变了才追加一条**完整替换目录**;全部移除则发空目录退役旧名。

## 4) agent.inject vs systemPrompt.section 的选择

dsh 有**三层**注入通道,语义不同:

| 通道 | 生命周期 | 进入模型的方式 | 适用 |
|---|---|---|---|
| `ctx.systemPrompt.section({ name, order, text, interpolate?, complete? })`(`packages/core/system-prompt/src/index.ts:455`) | 每次模型请求重新组装 | system prompt 文本(renderPrompt),不进对话历史 | **常驻规则/身份/用法说明**,内容对每次请求恒定或可整体重算 |
| `ctx.systemPrompt.context({ name, order, text })`(同文件 :490) | 每步组装快照 | loop 在 preStep 里生成 durable user 消息,前缀 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."(`agent-loop/src/agent.ts:248-255`、`system-prompt/src/index.ts:304-308`) | **当前状态类**内容(cwd、sandbox policy),新快照声明取代旧的 |
| `agent.inject(message)` | 一次性排队 | next-step inbox → claim 后成为 durable `user/message` | **时间点事件**:刚发生的事实通知、中途补充材料,发一次留痕即可 |

判据:**内容需要在每一次请求中出现且由最新值整体重建 → section/context;内容是"发生了某事"的事件、注入后即历史 → inject**。tool-skill 的目录选择 durable user 消息而非 section,因为目录是会话可见事实、要进持久历史、要能整体替换、且 UI 需要结构化 `source.entries` 而非 re-parse 提示词。另注意第三条注入通道:`ctx.on('agent/pre-step', ...)` waterfall 直接改 `decision.messages`(tool-skill 的做法)——适合需要**跨 step 去重/替换**(digest 比对)的派生注入,与 inject 的区别是不经 inbox、每次 step 都重算。

对 auto-memory 的直接映射:MEMORY.md 索引是"每步都在的当前状态" → `systemPrompt.context`(快照式、自动 supersede)或 `section`(若想不占历史);memory_write 后的反馈走工具结果本身;任何异步外部事件(如计划任务写入的新记忆提示)才用 `agent.inject`。

## 5) 会话事件追加(exec.agent.session.append)API

**exec 上下文**:`ToolRunContext`(`packages/core/tools/src/index.ts:401-418`)extends `ToolExecution` extends `ToolExecutionInput`(:309-335)。关键字段:`{ readonly callId: ToolCallId, readonly rootCallId, readonly name: string, readonly arguments: unknown, readonly agent?: Agent, readonly signal: AbortSignal }` + 方法 `deferContext(context: UserMessage): void`(工具结果后追加上下文消息)、`concludeTurn(): void`。`exec.agent` 由 agent loop 设置,可能 undefined。

**Session.append 签名**(`packages/core/session/src/index.ts:719-723`):
```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T>
```
- `SessionEventType = keyof SessionEventMap`;`SurfaceEventType = 'system/message' | 'user/message' | 'assistant/message' | 'tool/result'`(types.ts:417-421)——**只有这四种**必须带第三参 `SurfaceIntent`:`{ surfaceOp: 'append' }` 或 `{ surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: SessionSeq[] }`(assistant/message 不许带 sourceEventSeqs)。log-only 事件(todo/write、turn/start 等)禁止带。
- `user/message` 的 data 直接就是 `UserMessage` 对象(无 turn/step 包裹);`system/message`/`assistant/message`/`tool/result` 的 data 是 `{ turn, step, message, ... }`。
- 真实用例(`packages/todo/tool-todo/src/index.ts:203-211`):`exec.agent.session.append('todo/write', { todos })`——先检查 `exec.agent` 存在,否则 throw `'todo_write requires an owning agent session'`。

**事件类型命名约定**:两段 kebab-case `<域>/<动作>`,域 = 插件短名。参照 `KNOWN_SESSION_EVENT_TYPES`(`packages/core/session/src/known-event-types.ts`,repo 生成):`todo/write`、`schedule/change`、`goal/change`、`compaction/start`、`workspace/changes`、`subagent/catalog`、`feedback/record`、`hook/invoked`、`session/title` 等;少量三段(`agent/inbox/spliced`、`team/message/delivered`)。类型声明方式 = module merge:
```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'todo/write': { todos: TodoItem[] } }  // packages/todo/tool-todo/src/types.ts:28-33
}
```

**payload 校验要求**:**没有 per-type JSON Schema 校验**。运行时校验是:① `data` 与 surface 元数据必须**无损 JSON 可序列化**(`snapshotJsonValue`,拒绝 BigInt/undefined/symbol/循环引用/Date/Map/Set/稀疏数组/-0);② `validateSessionEventData` + `surfaceManager.validateNext`(surface 契约:非 surface 类型不得带 surfaceOp/sourceEventSeqs、surface 类型必须带、replace 范围与覆盖完整);③ 消息类事件要求 identified message(id 非空串、role 匹配类型、source 为带非空 kind 的对象、content 为数组——seed/读回边界 `assertMessageEventShape`,index.ts:328-385)。类型正确性靠 TS 泛型编译期保证。若要持久化投影状态,另有 `ctx.sessionProjections.register({ key, stateSchema: ZodType, init, apply, wire, stateVersion })`(`packages/session/session-projection/src/index.ts:233`,zod 校验 fold 状态,tool-todo 134-145 行为完整范例)。
## codeSnippets
// ============ Agent.inject 声明 — packages/core/agent/src/runtime-types.ts:233-242 ============
// Queue model-facing context for the next pre-step without waking the driver...
inject(message: UserMessage): void

// ============ 实现 — packages/core/agent-loop/src/agent.ts:128-147 ============
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
followup(input: UserMessage): void { this.send(input, 'next-turn', true) }
steer(input: UserMessage): void   { this.send(input, 'next-step', true) }
inject(input: UserMessage): void  { this.send(input, 'next-step', false) }

// ============ 插件骨架 — packages/skill/tool-skill/src/index.ts:24-25,77 ============
export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(skillTool)
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // ...构造注入
    return { ...decision, messages: [...decision.messages, ...injections] }
  })
}

// ============ 注入消息构造(tool-jobs 通知) — packages/jobs/tool-jobs/src/index.ts:280-298 ============
const message = createUserMessage({
  content: [{ type: 'text', text: fitCompletionNotice(snapshot) }],
  source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: completionSummary(snapshot) },
})
if (delivery === 'wakeup' && owner.status === 'idle' && spent < wakeBudget) owner.followup(message)
else owner.inject(message)

// ============ MessageSourceMap 合并 — packages/skill/tool-skill/src/index.ts:43-47 ============
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'skill-catalog': SkillCatalogSource }
}

// ============ SessionEventMap 合并 — packages/todo/tool-todo/src/types.ts:28-33 ============
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
    'todo/write': { todos: TodoItem[] }
  }
}

// ============ 工具内追加事件 — packages/todo/tool-todo/src/index.ts:203-211 ============
execute(args, exec) {
  const todos = toTodoList(args.todos, allowParallel)
  if (!exec.agent) throw new Error('todo_write requires an owning agent session')
  exec.agent.session.append('todo/write', { todos })
  return Promise.resolve({ todos: ..., counts: ... })
}

// ============ Session.append — packages/core/session/src/index.ts:719-723 ============
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T>
// 用例(测试):session.append('user/message', message, { surfaceOp: 'append' })
//             session.append('todo/write', { todos })   // log-only,无第三参

// ============ systemPrompt 三件套 — packages/core/system-prompt/src/index.ts ============
ctx.systemPrompt.section({ name: 'tool:jobs', order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'), text: '...' })
ctx.systemPrompt.context({ name, order, text: string | ((context: AssembleContext) => string) })  // :490
ctx.systemPrompt.tools((context: AssembleContext) => ({ schemas, knownNames? }))                   // :522

// ============ skills 服务 — packages/skill/skill/src/index.ts:470-517 ============
async list(options?: SkillViewOptions): Promise<SkillSummary[]>
async snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>  // { skills, complete }
async get(name: string, options?: SkillViewOptions): Promise<SkillDefinition | undefined>
// SkillViewOptions = { cwd?: string; signal?: AbortSignal; scope?: ScopeKey }  (:103-119)
// tool-skill 内 lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }

// ============ defineTool — packages/core/tools/src/schema.ts:483-513 ============
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  readonly parameters: S                     // { key: { type, required?, description?, enum?, items?... } }
  readonly output: { readonly schema: O; render(args, value): ContentBlock[]; presentationMeta?(...) }
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  timeoutMs?: number; isConcurrencySafe?(args): boolean
}
## gotchas
1. **两个 "inject" 同名不同物**:插件入口的 `export const inject = ['tools', 'skills']` 是 cordis 服务依赖声明(数组);`agent.inject(message)` 是 Agent 方法。读 dsh 源码/写代码时务必区分。
2. **外部 npm 插件不要写自定义 log-only session 事件**:`KNOWN_SESSION_EVENT_TYPES` 是本 repo 静态生成的(packages/core/session/src/known-event-types.ts),out-of-repo 插件的事件类型不在其中;`Session.append()` 签名**没有设置 `ignorable: true` 的入口**(那是持久化 envelope 字段,只在读回/上传层出现)。后果:写了自定义事件类型的 session 持久化后,resume 时 `validateStoredEvents`(packages/session/session-persistence/src/storage-contract.ts:75)抛 `SessionFormatUnsupportedError` 拒绝加载整个 log("event type ... unknown to this harness and not marked ignorable")。**MEMORY.md 方案(状态存文件)天然规避此问题;工具内只写 `user/message` 等核心已知类型或干脆不写事件。** repo 内插件(todo 等)因列表同 repo 生成而免于此问题。
3. **data 形状按类型不同**:`'user/message'` 的 data 是 UserMessage 本体(无 turn/step 包裹、无 { message } 包装);`'system/message'|'assistant/message'|'tool/result'` 是 `{ turn, step, message, ... }`。照抄 todo 模式最安全。
4. **surface 事件第三参必填**:`session.append('user/message', msg, { surfaceOp: 'append' })`——漏掉第三参在 SurfaceEventType 上是编译错误(opts 是必需 tuple);log-only 事件带第三参同样编译错误。
5. **pre-step waterfall 顺序语义**:先 `await next()` 再 `[...decision.messages, 追加]` = 你的注入落在所有**后注册** listener 产物之后(tool-skill 注释:background first(catalog),模型要行动的材料 last;靠注册顺序确定位置)。listener 注册顺序 = 执行顺序。
6. **注入消息 source 要有自己的 MessageSourceMap kind**(merge declare),且读回时防御性校验:seed 校验只保证 source.kind 是非空字符串,不检查任何 per-kind 字段(tool-skill 的 `readCatalogEntries` 就是对损坏记录返回 undefined 而不是 throw——throw 会废掉该会话后续每一轮)。
7. **`form: 'notice'` 必带 summary(≤120 字符)**,用 `boundContextSummary()` 截;`form: 'snapshot'` 必带 sections。form 词汇是语义的(instructions/catalog/snapshot/notice/relay/recall),不许放视觉信息。
8. **`exec.agent` 可能 undefined**(非 agent 调用方/嵌套调用),工具里必须检查(todo 直接 throw)。
9. **systemPrompt.section 同 scope 重名 throw**;要 per-agent 覆盖需通过 `agent.ctx.systemPrompt.section(...)`(scoped 注册);order 必须有限数;集中位次表 `getSectionOrder('TOOL_XXX')` 只列了 repo 内插件,外部插件自选未占用的小数 order(如 tool-workflow 测试用 115.5;TOOL_* 区 1000-3000,TOOLS_SDK=5000)。
10. **`agent.session.eventAt()` / `snapshotEvents()` 已标 @deprecated**(新代码禁用,tool-skill 源码里带 oxlint-disable 注释)。读会话历史应走 `ctx.sessionProjections` 投影或 `session/event` 事件流,不要模仿 tool-skill 的 catalogHistory 直读。
11. 技能/命令名与注入通道的 `isSkillName` 语法是 `^[a-z0-9]+(?:-[a-z0-9]+)*$`(纯 kebab);`/name` 手势只认 `source.kind === 'user'` 的消息——外部注入文本不能伪造用户手势。
12. `agent.inject` 排队后**可能被 cancel/dispose 丢弃、可能错过已认领批次**;需要保证送达的完成通知应像 tool-jobs 那样按 `owner.status` 分流(idle→followup,busy→inject)。
13. 插件 mount 配置是 YAML 插件列表(`- name: '@deepseek-ai/dsh-tool-skill'`),config 字段即 `Config` schema 的字段(schemastery `z.object`);包须 `"type": "module"`、构建产物 `lib/index.js` + `lib/types/index.d.ts`、`@deepseek-ai/*` 全部放 peerDependencies。
## openQuestions
1. `ctx.agents`(AgentRegistry,packages/core/agent/src/index.ts:27-28)的完整 API(enter/withInitiator/get/何时用 `agent/created` 拿 agent 引用)未逐行读——若 dsh-auto-memory 需要在 agent 创建时机(agent/created)读 MEMORY.md 并注入,建议补读该文件。
2. 外部插件是否有任何官方途径写带 `ignorable: true` 的持久事件——`Session.append` 签名明确无入口,未发现替代 API;结论"外部插件不写自定义事件类型"基于 storage-contract 的 fail-closed 拒绝逻辑,建议向 dsh 维护者确认是否有规划中的注册机制。
3. plugin-manager(packages/boot/plugin-manager/)加载外部 npm 插件的安装与信任细节(签名校验、安装目录、版本解析)未读,仅从 README 的 YAML mount 例子推断;独立发布 npm 包前建议补读。
4. tool-todo 附属 invariant 包(append 'todo/write' 需 open turn 的校验,tests/invariant.spec.ts 出现 "outside any open turn")的注册机制未读——若外部插件也想注册会话 invariant,机制未知。

---

===== packaging =====
## findings
# dsh 插件工程化与分发调研报告

## 1. 独立(非 monorepo)插件 npm 包的最小工程

**两种角色,一种 manifest 规则**(docs/user/develop/basic/publish.zh.md):组合包(bundle)= 带 `dsh.bundle` manifest 的 npm 包;profile = `$DSH_HOME/profiles/<name>` 下的目录,由 dsh 自动生成维护,不是你发布的。

**JS 插件最小 package.json**(publish.zh.md L35-44 原文):
```json
{ "name": "dsh-hello-plugin", "version": "0.1.0", "type": "module",
  "main": "index.js", "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

**TS 插件完整形态**(以官方 `packages/todo/tool-todo/package.json` 为准,并已核对 npm 上已发布的 `@deepseek-ai/dsh-tool-todo@0.1.6-alpha.2`):
- `type: "module"`、`main: "lib/index.js"`、`types: "lib/types/index.d.ts"`
- `exports`:`{ ".": { "types": ..., "default": "./lib/index.js" }, "./package.json": "./package.json" }`(如有多入口加 `./invariant` 等)。`main` 单独存在也够(模块 fallback 兼容无 exports 包);`exports` 是最佳实践
- `files`: 必须含构建产物 `lib/...` 与 `cordis.patch.yml`(patch 文件不在 files 里 = 安装后层丢失)
- `dsh.bundle` 结构(packages/util/package-manifest/src/types.ts `DshBundleManifest`):只有一个字段 `patch: string`,即相对包根的 patch 文件路径。可选 `dsh.manifestVersion: 1`
- **peerDependencies 必须列:插件 import 的每一个 @deepseek-ai 框架包**。官方 tool-todo 的 peer:`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-projection`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`。**版本写法**:dsh 家族锁步发版(全家族同一版本号),写 `^<家族版本>`;cordis 独立线写 `^4.0.2`;`@deepseek-ai/schemastery` 按官方惯例放 **dependencies**(非 peer),写 `^3.18.2`。已发布实测(dsh-tool-todo@0.1.6-alpha.2):peer 全部是 `"^0.1.6-alpha.2"`,deps 是 `{"zod":"^4.4.3","@deepseek-ai/schemastery":"^3.18.2"}`。当前 registry dist-tags:`alpha=0.1.6-alpha.2`、`next=0.1.5-rc.2`、`latest=0.0.1-rc.1`(latest 是旧线)——**peer 范围要对准用户实际装的 dsh 线**,注意 semver 预发布范围 `^0.1.6-alpha.2` 不匹配 `0.1.5-rc.2`
- 引擎:`"engines": { "node": "^22.19.0 || >=24.0.0" }`(根 package.json 口径)

## 2. TypeScript 构建

- **官方 monorepo 内是两段式**:根 `package.json` 的 `build:lib:host` = `tsc -b tsconfig.host.json`(项目引用,tsc 发射 JS+DTS 到各包 `lib/types/`)+ `tsdown --env.DSH_BUILD_FACE host`(根 tsdown.config.ts,workspace 模式,把 `lib/types/{index,...}.js` 转译到 `lib/`,`dts: false` 因为 DTS 已由 tsc 生成)。包内 tsdown 配置(如 packages/boot/app-boot/tsdown.config.ts)只消费 `lib/types/*.js`。这套依赖 monorepo 项目引用,**外部包不要照抄**
- **产物布局**:`lib/index.js`(运行入口,来自 main/exports)、`lib/types/index.d.ts`(类型,来自 tsc)。官方包 `exports` 里 `"."` 的 types 指 `./lib/types/index.d.ts`,default 指 `./lib/index.js`
- **独立仓库最薄构建 = 单独用 tsdown 直接转译 src/**(publish.md L163 明文:"A dedicated tsdown config can transpile `src/` without project references or type checking")。repo 用 tsdown `^0.22.2`(根 package.json devDependencies)。见 codeSnippets 里可复制的 `tsdown.config.ts`(`entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', dts: true`)+ 独立 `tsconfig.json`(不需要 extends tsconfig.base.json,那是 monorepo 解析门面)
- `scripts`:`"build": "tsdown"`、`"prepare": "tsdown"`(git 安装用,须自包含)。npm 发布装预构建产物,`pnpm publish`/`npm publish` 前先 build(prepare 也会在 publish 前跑)

## 3. cordis.patch.yml insert 行完整字段

条目类型是 `EntryOptions`(vendor/loader/src/config/entry.ts):`{ id: string; name: string; config?: any; group?: boolean|null; disabled?: boolean|null; inject?: Inject|null }`。`id` 必填(层内稳定标识,后续层按它覆盖/禁用);`name` 是**模块说明符**——已安装插件写 **npm 包名**(如 `dsh-hello-plugin`,支持子路径导出如 `'@deepseek-ai/dsh-plugin-manager/tools'`);本地源码开发写**绝对路径**(如 `/abs/path/src/my-plugin.ts`,patch 只贡献配置不改解析锚点);`config` 即传给 `apply(ctx, config)` 并经 Schemastery schema 校验的值(支持 `!!js` 表达式);`inject` 声明服务依赖。官方大范例:packages/bundle/base/cordis.patch.yml。

**patch 语义**(vendor/include/src/index.ts `applyEntryPatches`,L57-127):
- `{ insert: [EntryOptions...] }`:顶层 insert 追加到根列表;`{ id: X, insert: [...] }` 追加进 id 为 X 的 group 行
- 非 insert patch(`{ id, config?, disabled?, inject?, name? }`)按 `id` 定位目标行,**整表替换** `config`(不深合并,必须重述全部键);可选 `name` 是守卫——与目标行 name 不匹配则整条跳过并警告;patch 命中不到任何行仅警告跳过
- 层顺序:profile 的 `dsh.profile.bundles` 依序 → profile 自己 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 各 `--patch`(后层按行胜出)

## 4. `dsh plugin add ./本地目录` 流程(pnpm 与 peer 解析)

流程(packages/boot/plugin-manager/src/operations.ts `runPluginCommand` + packages/boot/app-boot/src/profile.ts `initProfile`):
1. profile 不存在则初始化 `$DSH_HOME/profiles/<name>/`:写 `package.json`(`{ name: "dsh-profile-<n>", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }`)、空 `cordis.patch.yml`、以及 **`pnpm-workspace.yaml`**:`packages: [.]` / `nodeLinker: hoisted` / **`autoInstallPeers: false`**(profile.ts L183-188)
2. 以 profile 目录为 cwd 把参数转发给 pnpm(`dsh plugin --profile X add ...` 等价于在该目录跑 pnpm);相对路径 spec 先锚定到**调用目录**(`anchorPathSpec`,`add .` 在插件 checkout 里就是装该 checkout)
3. pnpm 成功后 `reconcile`:重读依赖,凡声明 `dsh.bundle` 的包被 append 进 `dsh.profile.bundles` 并即时校验 patch 可解析;无 `dsh.bundle` 的依赖保留为普通依赖并打警告

**peerDependencies 不会被 pnpm 装齐**(`autoInstallPeers: false`):dsh 系列框架包运行时由**模块 fallback**提供——启动时 dsh 把安装包依赖闭包(含传递依赖+peer,BFS)符号链接到 `$DSH_HOME/profiles/node_modules`(profile 目录的父级,Node 向上查找自然命中),保证所有插件共享安装的同一个 cordis 实例。因此**绝不能把 cordis/dsh-* 放 dependencies**(会装出第二实例破坏 Context 声明合并)。peer 的 semver 范围在 fallback 解析时不检查,只约束文档与 pnpm 警告;真正约束是 API 兼容。

**本地目录要否先 build**:要(除非纯 JS)。目录安装产生 `link:` 依赖(publish.zh.md L90 的 profile deps 显示 `"dsh-hello-plugin": "link:/path/to/hello-plugin"`),link 依赖**不跑任何生命周期脚本**,所以 TS 包必须先自己 build 出 `lib/`。对照:git 安装(`add github:you/pkg`)会跑 `prepare`,但 pnpm≥10 默认拦截,需把包名写进该 profile `pnpm-workspace.yaml` 的 `allowBuilds: <name>: true` 再重跑(build-approval.ts 就是这个机制;失败分类见 install-failure.ts 的 `build-blocked`);tarball(`add ./x.tgz`)与 npm 安装是预构建,免授权。装完**须重启 profile**(层变化不热重载;仅 cordis.patch.yml 编辑热重载)。

## 5. 插件配置的用户覆盖

插件导出 `Config`(Schemastery schema + 同名 interface,默认值写 schema 里,见 docs/user/develop/basic/config.zh.md)。组合包在自己的 cordis.patch.yml insert 行里给 `config` 默认值;用户在 **profile 的 `cordis.patch.yml`**(`$DSH_HOME/profiles/<name>/cordis.patch.yml`)写按 `id` 的覆盖行,只写 `id` + `config`,**必须重述该行全部配置键**(整表替换不深合并;不写 config 的键回落 schema 默认值而非保留 bundle 值)。也可在 home 层 `$DSH_HOME/cordis.patch.yml` 或 `--patch` 覆盖层覆盖(优先级更高)。范例:packages/bundle/web-app/cordis.patch.yml 的 `- id: system-prompt` + `config:`。覆盖后触发插件热替换(HMR)。

## 6. npm publish 注意事项 / 官方模板仓库

- **官方没有插件模板仓库**(全 docs 检索无 template/scaffold/starter 仓库;教程用一次性 hello-plugin/scratch-plugin 目录,publish.zh.md L23-31)。dsh-auto-memory 需自建仓库
- 发布装**预构建产物**:npm 上发布 `lib/`(pnpm publish 前构建);`pnpm pack` 出 tarball 给用户 `dsh plugin add ./x.tgz` 也免构建授权
- **git 分发**需自包含 `prepare`(不假设旁边有 monorepo checkout;专用 tsdown 配置直接转译 src/)+ 用户 allowBuilds 授权(视为允许安装期执行该包代码,建议锁 commit)
- scoped 包(如 `@yourorg/...`)需 `"publishConfig": { "access": "public" }`;非 scoped 名不需要
- 官方家族发版(scripts/release/publish.ts + families.ts):dsh 家族锁步版本、dist-tag 按 channel 分(`alpha`/`canary` 用同名 tag,rc 走 `next`)、逐 tarball 校验 integrity 后 `npm publish`(无 --access,靠每包 publishConfig)。第三方插件无需照搬,普通 `npm publish` 即可
- 验证工具:官方用 publint 校验包入口(hygiene 的一部分),独立插件建议发布前 `pnpm pack` + publint 检查

## 关键事实速查
- profile pnpm-workspace.yaml 模板(profile.ts L183-188):`packages: [- .]`、`nodeLinker: hoisted`、`autoInstallPeers: false`;pnpm ≥10 从 pnpm-workspace.yaml(非 .npmrc)读设置;repo 固定 pnpm 11.7.0
- `dsh.bundle.patch` 路径解析:`join(packageDir, declared)`(profile.ts `loadProfileDirectory` L894)
- bundle 解析双锚:先 dsh 安装锚、后 profile 目录(`resolveBundleDir`),所以内置包永远用安装内副本
- profile 目录文件权限:POSIX 上 0700/0600;manifest 以 2 空格 JSON + 换行原子写回
## codeSnippets
// ===== 1. 独立 TS 插件包 package.json(完整可复制)=====
// 依据 publish.zh.md 示例 + packages/todo/tool-todo/package.json 发布版实测(registry 数据)
{
  "name": "dsh-auto-memory",
  "version": "0.1.0",
  "description": "Claude Code style auto-memory for dsh",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "scripts": {
    "build": "tsdown",
    "prepare": "tsdown"          // git 安装时 pnpm 会跑(需用户 allowBuilds)
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "^0.1.6-alpha.2",
    "@deepseek-ai/dsh-system-prompt": "^0.1.6-alpha.2"
  },
  "devDependencies": { "tsdown": "^0.22.2", "typescript": "^5.9.0" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}

// ===== 2. cordis.patch.yml(insert 行完整字段)=====
// 官方范例: packages/bundle/base/cordis.patch.yml;类型: vendor/loader/src/config/entry.ts EntryOptions
- insert:
    - id: auto-memory                     // 行 id,后续层按它覆盖
      name: dsh-auto-memory               // 已安装包: npm 包名(或子路径导出 'pkg/subpath');本地源码: 绝对路径
      config:                             // 可选;整表传给 apply(ctx, config),schema 校验
        memoryDir: !!js ctx.workspace?.root ?? process.cwd()   // !!js 表达式可用
      inject: [workspace]                 // 可选;服务注入(数组或 intercept 形式)
      # disabled: true                    // 可选;布尔或 !!js 表达式

// ===== 3. 最薄独立构建配置 =====
// tsdown.config.ts(官方推荐工具,repo 用 tsdown ^0.22.2;publish.md L163:直接转译 src/,免项目引用)
import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,          // 声明文件;不需要对外类型可省
})

// tsconfig.json(独立仓库版;repo 的 tsconfig.base.json 只适合 monorepo)
{
  "compilerOptions": {
    "target": "es2024", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "verbatimModuleSyntax": false
  },
  "include": ["src"]
}

// ===== 4. 用户覆盖插件配置($DSH_HOME/profiles/<name>/cordis.patch.yml)=====
// 语义: vendor/include/src/index.ts applyEntryPatches——按 id 定位、整表替换 config、不深合并
- id: auto-memory
  name: dsh-auto-memory   // 可选守卫:与目标行 name 不符则整条跳过
  config:
    memoryDir: /custom/path    // 必须重述全部字段,未列出的字段回落到 schema 默认值(不是保留原值)

// ===== 5. 关键签名(源码)=====
// packages/util/package-manifest/src/types.ts
export interface DshBundleManifest { patch: string }   // 相对包根的 patch 文件路径
// vendor/include/src/index.ts
export function applyEntryPatches(data: EntryOptions[], patches: PatchOptions[] | undefined,
  warn: (message: string, ...args: any[]) => void): EntryOptions[]
export interface PatchOptions { id?: string; insert?: EntryOptions[]; name?: string; config?: any;
  group?: boolean | null; disabled?: boolean | null; inject?: any; intercept?: any; isolate?: any; [key: string]: any }
// vendor/loader/src/config/entry.ts
export interface EntryOptions { id: string; name: string; config?: any;
  group?: boolean | null; disabled?: boolean | null; inject?: Inject | null }
// packages/boot/plugin-manager/src/operations.ts
export function anchorPathSpec(argument: string, cwd: string): string
// packages/boot/app-boot/src/profile.ts —— profile 初始化写入的 pnpm-workspace.yaml:
// packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n
## gotchas
1. **patch 整表替换 config,不深合并**——覆盖行必须重述全部键;漏写的键回落到插件 schema 默认值,不是保留 bundle 层原值(publish.zh.md L123-126、base patch 头注释)。同理你的 bundle patch 覆盖 dsh-base 的行时也要全量重述。
2. **非 insert patch 的 `name` 是守卫不是定位键**:提供且与目标行 name 不匹配时整条 patch 被跳过(仅警告);定位只靠 `id`(applyEntryPatches L115-118)。patch 命中不到行也只是警告,不报错——id 拼错会静默失效。
3. **绝不能把 @deepseek-ai/cordis 或 dsh-* 框架包放 dependencies**:profile 用 autoInstallPeers:false + hoisted linker,peer 由 $DSH_HOME/profiles/node_modules 符号链接提供单实例;dependencies 会装出第二个 cordis 实例,破坏 Context 声明合并。@deepseek-ai/schemastery 例外,官方惯例放 dependencies(与 zod 等小库同级)。
4. **peer 版本范围要对准用户实际安装的 dsh 线**:dsh 家族锁步发版但 dist-tag 分线(latest=0.0.1-rc.1 旧线、next=0.1.5-rc.2、alpha=0.1.6-alpha.2);semver 预发布范围 ^0.1.6-alpha.2 匹配不到 0.1.5-rc.2。peer 范围在运行时 fallback 解析中不被校验,pnpm 装时也只警告不失败——真正的兼容约束是 API。
5. **本地目录 add 不会跑构建脚本**(link: 依赖无生命周期钩子):TS 包必须先手动 build 出 lib/ 再 `dsh plugin add ./dir`。git 安装跑 prepare 但被 pnpm≥10 拦截,要用户在 profile 的 pnpm-workspace.yaml 写 `allowBuilds: <包名>: true` 后重跑 add(dsh 会提示要复制的确切键;install-failure.ts 归类为 build-blocked)。
6. **files 必须包含 cordis.patch.yml**,否则 npm 安装后 bundle 层丢失,插件被当普通依赖(只有警告,不激活)。
7. **insert 行的 name 在已安装形态必须是包名**(Node 模块解析能找到),只有本地 --patch overlay 里才用绝对路径;相对路径不行(patch 只贡献配置,不改变以 profile 目录为锚的解析)。
8. **装/卸/升级 bundle 后必须重启 profile**;只有 cordis.patch.yml(home/profile 两层)编辑走 HMR 热重载。
9. 插件模块不要同时 export default(tool-todo README 引 postmortem 0001:Loader 的 unwrapExports 会折叠默认导出并丢掉 inject)。函数/命名空间插件导出 `name`、`inject`、`apply` 即可。
10. Config 必须是 Schemastery schema(满足 Standard Schema 接口),不能导出普通对象当 Config;默认值写在 schema(.default(...)),不写进 interface。
11. tsc+项目引用的双段构建是 monorepo 专用;独立包直接 tsdown 转译 src/。不要 extends 仓库的 tsconfig.base.json(其 paths 是源码解析门面,外部无意义)。
12. Windows 上 profile 目录权限语义与 POSIX 0700/0600 不同,但 dsh 统一按此请求;开发调试时 profile 在 $DSH_HOME(默认 ~/.dsh)下,不在插件仓库里。
## openQuestions
1. peerDependencies 的最低必列集合只能按"实际 import 的包"确定:dsh-auto-memory 最终用哪些服务(tools/system-prompt/workspace/session 等)取决于功能调研报告的结论,本报告给出规则与官方 tool-todo 的实测样例。2. registry 数据取自 npmmirror 镜像(npmjs.org 直连被网络策略拦截),版本号以镜像同步为准,写 peer 范围前建议用 `npm view @deepseek-ai/dsh dist-tags` 再核对一次。3. 独立包的 .d.ts 生成策略(tsdown 内置 dts vs tsc --emitDeclarationOnly)官方无硬性要求——docs 只说"专用 tsdown 配置直接转译 src/ 不做类型检查";若插件不对外导出类型,dts 可省。4. `dsh --profile <name> --from-default-profile <template>` 创建规则细节在 apps/cli/reference/README.zh.md#profile-boot,本次未逐行核对该 flag 与 `dsh plugin` 初始化的全部差异(不影响插件包本身的工程化)。

---

===== eventsCompaction =====
## findings
# dsh 事件系统 / compaction / ctx.llm 调研报告（供 dsh-auto-memory P1 实现）

## 1) 与 session 生命周期、turn 结束、compaction 相关的事件总清单

dsh 事件分两层：**实时 harness 事件**（Cordis `Events` 接口，声明合并扩展，监听用 `ctx.on`）与**持久会话事件**（`SessionEventMap`，追加用 `session.append`，通过 `session/event` 转发观察）。

### 1a. 实时 harness 事件（`declare module '@deepseek-ai/cordis' { interface Events {...} }`）

**会话生命周期**（声明于 `packages/core/session/src/index.ts:38-83`）：

| 事件 | 模式 | 签名 |
|---|---|---|
| `session/created` | emit | `(session: Session): void`。同步 throw 会否决并回滚发布 |
| `session/disposed` | emit | `(session: Session): void`。会话离开 live store（含回滚），监听器失败被吞掉记日志 |
| `session/event` | emit | `(session: Session, event: SessionEvent): void`。**post-commit、fire-and-forget** 追加通知 |
| `session/flush` | parallel | `(session: Session): Promise<void> \| void`。awaited 持久化屏障；唯一正确入口是 `ctx.sessions.flush(session): Promise<boolean>`（不是裸 `ctx.parallel`） |

**Agent 生命周期与 turn/step**（声明于 `packages/core/agent/src/runtime-types.ts:245-394`）：

| 事件 | 模式 | 载荷 |
|---|---|---|
| `agent/created` | serial | `{ agent: Agent; source: SessionStartSource; signal?: AbortSignal }`，`SessionStartSource = 'startup' \| 'resume' \| 'clear' \| 'compact'`（区分新建/恢复） |
| `agent/disposed` | emit | `{ agent: Agent }`。AgentLoop 在 driver 静默、scoped 注册展开**之后、session 脱离之前**发出 |
| `agent/status` | emit | `{ agent: Agent; status: 'idle' \| 'running' }` |
| `agent/turn-stopping` | serial | `{ agent: Agent; turn: number; signal: AbortSignal }`，awaited；turn 自然结束前的检查点，steer 可续轮 |
| `agent/pre-step` | waterfall | `(payload: { agent; messages: UserMessage[]; turn; step; signal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>`，`PreStepDecision = { kind: 'reject' } \| { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }` |
| `agent/request` | waterfall | `(payload: { agent; turn; step; signal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>` |
| `agent/request-error` | waterfall | `(payload: { agent; turn; step; provider: string; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy \| undefined; signal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>`，`RequestErrorAction = { kind: 'retry' } \| undefined` |
| `agent/error` | emit | `{ agent; turn; step; error: unknown }` |
| `agent/inbox/inserted` / `claimed` / `discarded` | emit | `{ agent; message: UserMessage; turn? }` |

**compaction 相关**：
- `compaction/summary-error`（waterfall，声明于 `packages/compaction/compaction/src/index.ts:99`）：`(payload: { session: Session; sourceEventSeqs: readonly SessionSeq[]; error: unknown; signal?: AbortSignal }, next: () => boolean): boolean` —— 摘要失败后的**同步**恢复钩子（要求先落盘输入变更再返回 true）。
- `llm/stream`（waterfall，`packages/llm/llm/src/index.ts:72`）：`(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>` —— 拦截一切模型调用（compaction/重放/路由）。

### 1b. 持久会话事件（`SessionEventMap`，`packages/core/session/src/types.ts:269-406`）

envelope：`SessionEvent<T> = { type: T; seq: SessionSeq; time: number; data: SessionEventMap[T]; ignorable?: true } & (T extends SurfaceEventType ? SurfaceIntent<T> : { surfaceOp?: never; sourceEventSeqs?: never })`。核心成员：

- `'turn/start': { turn: number }`；`'turn/end': { turn: number; reason: TurnEndReason }`——`TurnEndReason` 为可合并联合：`completed | aborted(reason: TurnEndCancelCause) | blocked | error(error: LlmFailure) | max-tokens | interrupted`
- `'step/start' | 'step/end': { turn: number; step: number }`
- `'user/message': UserMessage`（data 即消息本体，surface 事件）；`'system/message': { turn; step; message: SystemMessage }`
- `'assistant/message': { turn; step; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }`；`'assistant/attempt': { turn; step; stream }`
- `'tool/call': { turn; step; callId: ToolCallId; name; arguments }`；`'tool/result': { turn; step; message: ToolResultMessage; error?; meta? }`
- `'request/header': { header: EpochHeader; reason: 'initial'|'resume'|'change'|'series'; startsSeries?: true }`；`'request/context': { provider; model; contextWindow?; systemPromptUpdate? }`
- `'session/end-seed': { inherited?: true }`（构造 seed 边界，只有 Session 构造器可写）
- compaction 包声明合并（`packages/compaction/compaction/src/types.ts:17-91`）：
  - `'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }`（数字=自动轮内归属，null=手动独立事务）
  - `'compaction/summary': { compactionId; sourceCommandId?; summary: ContentBlock[]; shadowedRange: { start: SessionSeq; end: SessionSeq }; shadowedSeqs: SessionSeq[]; shadowedTokenCount: number; provider: string; model: string; maxTokens?; usage? } & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?; llmStreamCall?: never })`
  - `'compaction/end': { compactionId; sourceCommandId?; turn: number | null; error?: string }`
  - `'compaction/prune': { shadowedRange; shadowedSeqs; shadowedTokenCount }`

## 2) compaction 触发机制

**Seam**：`ctx.compaction: CompactionEngine`（抽象 Service，`packages/compaction/compaction/src/index.ts:112-186`）：
```ts
abstract compactIfNeeded(agent: CompactionAgentContext, trigger: 'pressure' | 'context-overflow', signal: AbortSignal): Promise<CompactionResult | null>
abstract compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>
abstract compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>
```
`CompactionAgentContext = { session: Session; options: { provider?: string; model?: string } }`；`ManualCompactAgentContext` 增加 `runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>`。

**后端 `dsh-compaction-basic`**（`packages/compaction/compaction-basic/src/index.ts`，`static inject = ['llm', 'tokenMeter', 'sessions']`）三条触发路径：
1. **自动压力**（`auto: true` 默认开）：注册为 `ctx.on('agent/pre-step', async ({ agent, signal }, next) => ...)` waterfall 监听器，**在请求派发之前**每步检查。阈值配置：`thresholdRatio`（默认 0.8，即 `floor(routedContextWindow × 0.8)`）、`retainRatio`（默认 0.16）/`retainTokens` 互斥、`maxTokens`（摘要输出上限，默认 8192）、`compactionRetries`（1）、`modelPolicies: Array<{ provider; model; ...partial }>` 按路由覆盖。测量用单例 `ctx.tokenMeter.measure(session)`。触发后先跑可选 `ctx.toolResultPruner`（无模型调用，可能完全省去摘要），再选最旧平衡范围做摘要。
2. **溢出恢复**：`ctx.on('agent/request-error', ...)`，当 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE`（`'CONTEXT_WINDOW_EXCEEDED'`，从 `@deepseek-ai/dsh-llm` 导入）时绕过阈值强制压缩，仅当 `agent.session.surface.replaceGeneration` 前进才返回 `{ kind: 'retry' }`。
3. **手动**：`/compact` 命令（`packages/compaction/command-compact`）→ `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`，要求 agent 空闲，通过 `agent.runMaintenance` 在轮间执行，写 `turn: null` 的独立标记对。

摘要路由回退链：配置的 `summarizationProvider/Model`（默认空）→ 最新持久路由 `session.requestHeader()?.config` → `agent.options`（见 `routedTarget`/`summarizeWithLlm`，`compaction-basic/src/index.ts:49-68`、`summarizer.ts:126-141`）。

**可挂钩点**：压缩前后没有专门 before/after 事件，但 (a) `compaction/start`/`summary`/`end` 持久事件可经 `session/event` 观察；(b) 压力压缩在 `agent/pre-step` waterfall 内执行，其他插件按注册顺序在其前后链接；(c) `compaction/summary-error` waterfall 可参与失败恢复；(d) 持久锁=未闭合的 `compaction/start`（较新 `session/end-seed` 之前的视为陈旧忽略）。

## 3) ctx.llm 发起模型调用

服务：`ctx.llm: LlmRuntime`（`packages/llm/llm/src/index.ts:336`），核心 API：
```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk>   // index.ts:1110
prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>  // 一次性绑定适配器代次
listProviders(): LlmProviderInfo[]; resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
```
`GenerateOptions`（`packages/llm/llm/src/types.ts:455-495`）：`{ provider: string; model: string; reasoningEffort?: ReasoningEffortId; messages: Message[]; system?: string; tools?: ToolSchema[]; temperature?; maxTokens?; stop?: string[]; signal?: AbortSignal; sessionId?: Branded<'SessionId'>; purpose?: 'compaction' | 'session-title' }`。

**无活跃请求时可直接调用**——compaction 摘要器与 session-title 生成器都是插件后台直呼 `ctx.llm.stream()`（不经 agent loop 的 `agent/request` 扩展点）。标准消费模板（`compaction-basic/src/summarizer.ts:143-179`）：
```ts
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
const assembler = new BlockAssembler()
const messages = [ /* 历史/内容 */, createUserMessage({ content: [{ type: 'text', text: INSTRUCTION }], source: { kind: 'plugin', plugin: 'dsh-auto-memory' } }) ]
for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens, sessionId: agent.session.id, signal })) assembler.push(chunk)
// assembler.finish: FinishReason（终止保证）；失败是 { kind: 'error'|'aborted', failure: LlmFailure } 分片而非异常
// assembler.blocks(): ContentBlock[]；assembler.usage?: TokenUsage
```
路由/模型选择：`provider` 命中已注册适配器（未注册 → 终止分片 code `NO_ADAPTER`，不是异常）；稳定失败码：`NO_ADAPTER`/`MISSING_CREDENTIAL`/`INVALID_CREDENTIAL`/`AUTH`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`/`IMAGE_OFFLOAD_REQUIRED` 等，按 code 路由勿解析文本。每次 `stream()` 都过 `llm/stream` waterfall。`purpose` 是**闭集**（仅 `'compaction' | 'session-title'`，不可声明合并扩展）——记忆调用应省略。消息构造必须用不可变构造器（`packages/llm/llm/src/message.ts`）：`createUserMessage/createSystemMessage(text, plugin)/createAssistantMessage/createToolResultMessage/freezeMessage`。

## 4) 插件里 ctx.on 的类型安全写法

事件名与载荷完全由 Cordis `Events` 接口的**声明合并**提供类型：只要 import（直接或传递）了声明对应事件的包，`ctx.on('session/event', (session, event) => ...)` 的参数自动推断。三要点：
- waterfall 事件监听器第二参数是 `next`：`ctx.on('agent/pre-step', async ({ agent, signal }, next) => { ...; return next() })`（实例见 `compaction-basic/src/index.ts:144-162`）。
- `SessionEvent` 是按 `type` 判别的联合：`if (event.type === 'turn/end') event.data.reason.kind === 'completed'` 自动收窄。
- 自定义事件声明（也是给 `session.append` 提供类型）：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'memory/xxx': Payload } }`（范例 `packages/todo/tool-todo/src/types.ts:28-33`）。但见 gotcha——第三方类型会被持久化读路径拒读。
- 作用域：`session/*`、`agent/*` 事件声明带 `this: Scoped<Session|Agent>`，在 agent 作用域 ctx（`agent.ctx`）上注册的监听器只收该 agent 的会话；根 ctx 注册则收全部。

## 5) session.append 持久化、resume 重放与 SessionProjectionMap

**写入路径**：`session.append` 同步提交进内存日志并 post-commit 发 `session/event`；`dsh-session-persistence-jsonl` 的 tracker（`session-persistence-jsonl/src/storage.ts:534-566`）`ctx.on('session/event')` 按 id 路由进写句柄缓冲（批窗口）→ `ctx.on('session/flush')` drain+fsync → `ctx.on('session/disposed')` 最终 drain+close → 插件 fiber teardown 关闭全部句柄。任何类型的 append 事件都会被写盘（写路径不校验类型）。

**致命约束（读路径）**：`validateStoredEvents`（`packages/session/session-persistence/src/storage-contract.ts:69-80`）在加载时**拒绝**任何不在构建期生成的 `KNOWN_SESSION_EVENT_TYPES`（`packages/core/session/src/known-event-types.ts`，仓库内全部 `SessionEventMap` 声明）且未带 `ignorable: true` 的事件类型，抛 `SessionFormatUnsupportedError`。而 `Session.append`（`packages/core/session/src/index.ts:719-770`）构造 envelope 时**无法设置 `ignorable`**（该字段只能出现在裸构造的 seed 事件里）。⇒ **第三方插件用 session.append 写自定义事件类型到被持久化的会话，会让该会话之后无法 resume**。

**resume 重放**：恢复时完整存储日志成为构造 seed；`seq < firstLiveSeq` 的事件**不会**重发到 `session/event`（构造 seed 不发布）；边界以 `session/end-seed` 持久化。新代码禁止用 `session.snapshotEvents()/eventAt()/ownEvents()` 回扫历史（`@deprecated`，见 `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`）——**官方替代是投影**。

**SessionProjectionMap 机制**（`packages/session/session-projection/src/index.ts` + `src/types.ts`）：可合并类型表 `SessionProjectionStateMap`（host 态）与 `SessionProjectionMap`（客户端可见值）。`ctx.sessionProjections.register(definition)`：
```ts
interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S = SessionProjectionStateMap[K]> {
  key: K; stateSchema: ZodType<S>; stateVersion: number
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S
  apply(state: S, event: SessionEvent): S   // 必须同步；无关事件返回同一引用（Object.is 闸门）
  wire?: { viewSchema: ZodType<SessionProjectionMap[K]>; view(state: S): SessionProjectionMap[K] }  // 省略 = host-only
}
```
注册表只订阅一次 `session/event`，主动驱动所有单元（惰性建 cell、首次触达在内存日志上折叠，因此 **resume 后状态自动重建**）；`snapshot(session, keys?)` → `{ asOfSeq: SessionSeqCursor; values }`；`onChanged(listener)`；`stateOf(session, key)`；`checkpoint/restore` 配合 `dsh-session-projection-cache` 跳过冷折叠。**这正是 dsh-auto-memory 存"会话内待固化记忆状态"的官方姿势**（host-only：只在 StateMap 合并键、不写 wire）。

## 6) 会话关闭/结束的挂点与自动固化最佳位置

| 挂点 | 时机 | 可用性 |
|---|---|---|
| `agent/turn-stopping`（serial, awaited） | 每个自然 turn 关闭前（非会话结束） | 可安全做轻量同步/awaited 工作；steer 可续轮 |
| `session/event` 的 `turn/end`（emit） | 每轮落盘后 fire-and-forget | 读 `reason` 判断轮次结局；不能阻塞 |
| `agent/status` → `idle`（emit） | driver 每次静止 | 可触发 `agent.runMaintenance(task)` 做轮间后台任务（compactNow 同款机制） |
| **`agent/disposed`（emit）** | driver 静默+scoped 注册展开后、**session 脱离前** | **agent 与 session 仍活**：可读投影、可 append、可 `ctx.sessions.flush(session)`。最佳"会话结束"挂点。但 emit 不 await 异步监听器 |
| `session/disposed`（emit） | 会话已离开 store | **太晚**：attachments 已摘除，此后 `session.append` 不再发 `session/event`、持久化 writer 在此关闭——写会话日志会丢 |
| `api-session/removed`（emit, `sessionId: SessionId`） | session-controller 的 UI 镜像 | 仅宿主侧通知，晚于核心拆卸 |

**推荐方案（P1 自动总结固化）**：增量捕获用投影（`sessionProjections` 单元在 `turn/end` 上更新待固化缓冲）→ 固化触发放 `agent/disposed`（session 仍可读、agent.options/路由可用）或 `agent/status`→idle 的 `runMaintenance`；记忆本体写**插件自己的磁盘文件**（不依赖会话日志存活）。**异步完成保障**：emit 监听器不被 await，参照 `command-compact/src/index.ts:86-107` 的模式——维护 `active: Set<Promise>`，在 `ctx.effect(function* () { yield async () => { await Promise.allSettled(active) }; yield 注册 } )` 中让 teardown 先排空在途任务（Cordis 卸载 fiber 时 await effect disposer）。
## codeSnippets
// ===== 后台 LLM 调用模板（照抄自 packages/compaction/compaction-basic/src/summarizer.ts:119-179）=====
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const assembler = new BlockAssembler()
const messages: Message[] = [
  // ...待总结内容(来自插件的投影状态)
  createUserMessage({
    content: [{ type: 'text', text: '总结指令...' }],
    source: { kind: 'plugin', plugin: 'dsh-auto-memory' },
  }),
]
const options: GenerateOptions = {
  provider: target.provider,   // 如 session.requestHeader()?.config ?? agent.options
  model: target.model,
  messages,
  maxTokens: 4096,
  sessionId: agent.session.id,
  // purpose 不设（联合类型闭集，仅 'compaction' | 'session-title'，不可自定义）
  signal,                       // 可选，来自 runMaintenance(signal => ...) 或自建 AbortController
}
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
  throw new Error(assembler.finish.failure.message)  // failure.code 路由，勿解析 message 文本
}
const text = assembler.blocks().filter(b => b.type === 'text')

// ===== 轮次结束监听（packages/compaction/compaction-basic/src/index.ts:170 的同款写法）=====
ctx.on('session/event', (session, event) => {
  if (event.type === 'turn/end') {
    // event.data.reason: TurnEndReason 判别联合（switch on reason.kind 自动收窄）
  }
})

// ===== 类型监听 serial 事件（packages/core/agent/src/runtime-types.ts:381 声明）=====
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  // awaited：此处可安全做轻量收尾；steer(agent.steer(...)) 可续轮
})

// ===== 自定义 session 事件类型合并（todo 范例 packages/todo/tool-todo/src/types.ts:28-47）=====
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'memory/consolidated': { entries: string[] }   // 警告：追加进持久会话会导致 resume 拒读，见 gotchas
  }
}
// session.append('memory/consolidated', { entries }) 类型通过，但勿用于会被持久化的会话

// ===== 投影定义（packages/session/session-projection/src/index.ts:48-93）=====
const def = {
  key: 'memory',                       // 对应 SessionProjectionStateMap 合并键
  stateSchema,                         // ZodType<S>
  stateVersion: 1,
  init: (_header, _inherited) => ({ lastSeq: -1, digest: '' }),
  apply: (state, event) => event.type === 'turn/end' ? { ...state, lastSeq: event.seq } : state,  // 无关事件返回同一引用
} // 省略 wire → host-only
const dispose = ctx.sessionProjections.register(def)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)

// ===== 收尾防截断（packages/compaction/command-compact/src/index.ts:86-107）=====
const active = new Set<Promise<void>>()
ctx.effect(function* () {
  yield async () => { await Promise.allSettled(active) }   // teardown 先排空在途任务
  yield ctx.on(...)  // 注册监听
}, 'dsh-auto-memory lifecycle')

// ===== 会话事件 envelope（packages/core/session/src/types.ts:470-493）=====
type SessionEvent<T> = { type: T; seq: SessionSeq; time: number; data: SessionEventMap[T]; ignorable?: true } & SurfaceFields
## gotchas
1. **自定义会话事件会毁掉 resume（最重要）**：仓库外插件的事件类型不在构建期生成的 `KNOWN_SESSION_EVENT_TYPES` 里；`Session.append` 写入时持久化后端不检查，但读回时 `validateStoredEvents`（session-persistence/src/storage-contract.ts:75）直接抛 `SessionFormatUnsupportedError` 拒读整个会话。且 `Session.append` 无法打 `ignorable: true`（envelope 内部构造，types.ts:741-747 无此参数；只有裸构造 seed 事件能带）。⇒ dsh-auto-memory **不要把记忆状态写成自定义会话事件**；用插件自有文件（对齐 Claude Code 的 memory/*.md）+ SessionProjection 做会话内状态。
2. **`session/disposed` 之后 append 无效**：store attachments 已摘除，`session.append` 不再发布 `session/event`，持久化 writer 恰在此事件里 close。固化必须在 `agent/disposed`（session 尚活）或更早完成。
3. **emit 监听器不被 await**：`agent/disposed`/`session/event` 是 fire-and-forget，监听器 rejection 只被记日志。长耗时固化需自行用 `ctx.effect` teardown 排空（command-compact 模式），否则进程退出时可能被截断。
4. **resume 不重放 session/event**：seed 事件（seq < firstLiveSeq）不发布到 firehose；插件必须在 `agent/created`（source==='resume'）时依赖投影重建状态，禁止新代码调用已废弃的 `session.snapshotEvents()/eventAt()/ownEvents()`（有 lint 禁止）。
5. **llm 失败不是异常**：`ctx.llm.stream()` 的 provider 失败/取消以终止 `finish` 分片（`{kind:'error'|'aborted', failure}`）结束；必须检查 `assembler.finish`，按 `failure.code` 路由。服务内无重试（llm-retry 只挂 agent 步骤）。
6. **`purpose` 是闭集**：`GenerateOptions.purpose?: 'compaction' | 'session-title'`，非声明合并接口；记忆调用省略即可，勿试图塞自定义值（编译报错）。
7. **消息必须用不可变构造器**（`createUserMessage` 等，构造即 deepFreeze）；`source` 必填（插件注入用 `{ kind: 'plugin', plugin: '<包名>' }`）。`system` 字段仅一次性调用使用；loop 请求把系统提示词作为 messages[0]。
8. **压力压缩藏在 `agent/pre-step` waterfall 里**：依赖注册顺序在其前后挂钩，不要假设自己是第一个 pre-step 监听器；活动 `compaction/start` 未闭合会阻塞所有压缩入口（busy）。
9. **`session/flush` 别裸 dispatch**：必须走 `ctx.sessions.flush(session)`（store 持有 carrier/作用域）；flush 是 awaited parallel，第一个监听器失败会在全部 settle 后抛出。
10. **作用域过滤**：在 agent 作用域 ctx 注册的 `session/*`/`agent/*` 监听器只收该 agent 的会话；根 ctx 注册收全部——记忆插件要跨会话聚合时应在根 ctx 注册。
11. **compactRegion 在完全关闭的会话上抛错**（"no open turn"）；空闲压缩用 `compactNow`（需 agent idle）。
## openQuestions
1. 第三方插件给持久会话写自定义事件的"官方 sanctioned 路径"不存在：`Session.append` 无法打 `ignorable: true`（Agent Note 2026-08-30 只承诺读侧保留该字段，提到"某个现存第三方插件依赖它"但仓库内没有生产者写路径示例）。若 P1 坚持要持久会话日志记录，需向上游确认是否有未公开 API 或未来计划。
2. `agent/disposed` 异步监听器在进程硬退出（kill -9 / 崩溃）时的行为未在源码中保证——只有优雅 teardown（fiber 卸载）才会走 effect disposer 排空；崩溃场景下"会话结束固化"只能靠崩溃后下次 resume 时的补偿逻辑（可在 agent/created source==='resume' 时检查投影缓冲 vs 磁盘记忆水位）。建议实现时做这个补偿。
3. session-controller（UI 关闭会话）触发核心拆卸的精确先后（api-session/removed vs session/disposed 谁先）未逐行验证；对本插件无影响（推荐挂 agent/disposed），如需 UI 联动再查 packages/api/session-controller。