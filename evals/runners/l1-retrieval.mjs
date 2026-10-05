/**
 * L1 注入召回评测(免 judge、免 API):
 *   数据集 durable/updated 金标 → 直写 store(模拟"完美固化"上界)
 *   → 逐 probe 判定期望记忆是否可达(在注入索引文本中,或按名可读)。
 * 用法:node evals/runners/l1-retrieval.mjs [dataset](缺省 mini)
 * L3(固化精度,需一次 LLM 调用)独立于本 runner——见 evals/README.md。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { MemoryStore, serializeMemory } from '../../src/store.ts'
import { renderMemoryIndexText } from '../../src/prompt.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATASETS = join(HERE, '..', 'datasets', 'harness-sessions')
const CONFIG = { maxBytes: 4096, enableUserScope: true, autoSummarize: false }

const datasetName = process.argv[2] ?? 'mini'
const dataset = JSON.parse(await readFile(join(DATASETS, `${datasetName}.json`), 'utf8'))

// 数据集完整性校验(质量红线 → 机器可查的部分)
const errors = []
const sessionIds = new Set(dataset.sessions.map(s => s.id))
for (const fact of dataset.gold.facts) {
  for (const sid of fact.evidence_sessions) {
    if (!sessionIds.has(sid)) errors.push(`fact ${fact.name}: evidence session ${sid} 不存在`)
  }
  if (fact.label === 'updated' && !(fact.answer_from && fact.evidence_sessions.includes(fact.answer_from))) {
    errors.push(`fact ${fact.name}: updated 缺少合法 answer_from`)
  }
}
const factNames = new Set(dataset.gold.facts.map(f => f.name))
for (const probe of dataset.gold.probes) {
  for (const name of probe.expect) {
    if (!factNames.has(name)) errors.push(`probe "${probe.q.slice(0, 20)}…": expect ${name} 无对应金标`)
  }
}
if (errors.length > 0) {
  console.error('数据集校验失败:\n' + errors.map(e => `  - ${e}`).join('\n'))
  process.exit(1)
}

// 直写 store:每个会话目录写入该会话 evidence 的 durable/updated 金标(answer_from 版本)
// —— 模拟"完美固化"上界;真实固化质量由 L3 单独度量
const root = await mkdtemp(join(tmpdir(), 'l1-eval-'))
const store = new MemoryStore(root)
for (const session of dataset.sessions) {
  const facts = dataset.gold.facts.filter(f =>
    (f.label === 'durable' || f.label === 'updated')
    && f.evidence_sessions.includes(session.id)
    && (f.label !== 'updated' || session.id === f.answer_from))
  if (facts.length === 0) continue
  const dir = store.dir('project', session.cwd)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const now = Date.parse(session.date)
  for (const fact of facts) {
    await writeFile(join(dir, `${fact.name}.md`), serializeMemory({
      name: fact.name, description: fact.description, type: fact.type,
      body: fact.description, createdMs: now, updatedMs: now,
    }), 'utf8')
  }
}
// 每个出现过事实的工作区各刷新一次索引(多工作区数据集逐 cwd 重建)
for (const cwd of new Set(dataset.gold.facts.filter(f => f.label !== 'ephemeral')
  .flatMap(f => f.evidence_sessions)
  .map(sid => dataset.sessions.find(s => s.id === sid)?.cwd)
  .filter(cwd => cwd !== undefined))) {
  await store.refreshIndex('project', cwd)
}

// 逐 probe 判定:期望记忆名在任一工作区的注入索引中可达
const injectPerCwd = new Map()
for (const cwd of dataset.persona.workspaces) {
  injectPerCwd.set(cwd, renderMemoryIndexText(store, CONFIG, cwd))
}
let hit = 0
const misses = []
for (const probe of dataset.gold.probes) {
  if (probe.kind === 'abstention') continue // 拒答属 L2;L1 只测可达性
  const anyInjected = [...injectPerCwd.values()].some(text => text.length > 0)
  const allReachable = probe.expect.every(name => {
    const inIndex = [...injectPerCwd.values()].some(text => text.includes(`(${name}.md)`))
    return inIndex
  })
  if (anyInjected && allReachable) hit += 1
  else misses.push(probe)
}
const scored = dataset.gold.probes.filter(p => p.kind !== 'abstention').length
const recall = scored === 0 ? 1 : hit / scored

// 污染对照:ephemeral 不应被直写(直写模式下构造性成立,真实值由 L3 度量)
console.log(`[L1] dataset=${datasetName}`)
console.log(`     注入召回(direct-write 上界): ${hit}/${scored} = ${(recall * 100).toFixed(1)}%`)
console.log(`     拒答题: ${dataset.gold.probes.filter(p => p.kind === 'abstention').length} 道(L1 不计,L2 度量)`)
if (misses.length > 0) {
  console.log('     未命中:')
  for (const probe of misses) console.log(`       - [${probe.kind}] ${probe.q} (expect: ${probe.expect.join(', ')})`)
}
await rm(root, { recursive: true, force: true })
process.exit(misses.length > 0 ? 2 : 0)
