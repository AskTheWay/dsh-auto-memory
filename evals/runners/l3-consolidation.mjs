/**
 * L3 固化精度评测(每会话一次 LLM 调用,标准数据集约 10 次调用):
 *   数据集会话文本 → buildConsolidationPrompt(与插件真实固化同一条代码路径)
 *   → DeepSeek API → parseCandidates/sanitizeCandidate → 查重 → store.write
 *   → 对照金标算四指标:
 *     recall(durable 被捕获)/ precision(写入映射到金标)
 *     / 污染率(ephemeral 被固化)/ 更新正确率(updated 取 answer_from 版本)
 * 用法:DEEPSEEK_API_KEY=sk-... node evals/runners/l3-consolidation.mjs [dataset](缺省 mini)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { MemoryStore, descriptionSimilarity } from '../../src/store.ts'
import { buildConsolidationPrompt, parseCandidates, sanitizeCandidate } from '../../src/consolidate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATASETS = join(HERE, '..', 'datasets', 'harness-sessions')
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.EVAL_MODEL ?? 'deepseek-chat'
const MAX_MEMORIES = 8

if (API_KEY === undefined || API_KEY.length === 0) {
  console.error('需要 DEEPSEEK_API_KEY 环境变量(一次运行 ≈ 数据集会话数次调用)。')
  process.exit(1)
}

const datasetName = process.argv[2] ?? 'mini'
const dataset = /** @type {any} */ (JSON.parse(await readFile(join(DATASETS, `${datasetName}.json`), 'utf8')))

/** 单次固化 LLM 调用(与插件 consolidate.ts 同 prompt、同解析路径)。 */
async function consolidate(existingNames, transcript) {
  const prompt = buildConsolidationPrompt(existingNames, transcript, MAX_MEMORIES)
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048, temperature: 0,
    }),
  })
  if (!response.ok) throw new Error(`API ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  const data = /** @type {{ choices: Array<{ message: { content: string } }> }} */ (await response.json())
  const text = data.choices[0]?.message?.content ?? ''
  return parseCandidates(text) ?? []
}

// ---- 逐会话驱动固化(复刻 registerConsolidation 的写入语义)----
const root = await mkdtemp(join(tmpdir(), 'l3-eval-'))
const store = new MemoryStore(root)
for (const session of dataset.sessions) {
  const transcript = session.messages
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`)
    .join('\n\n')
  const existing = await store.listAll(session.cwd)
  let candidates
  try {
    candidates = await consolidate(existing.map(r => r.name), transcript)
  } catch (error) {
    console.error(`session ${String(session.id)} API 调用失败: ${String(error)}`)
    process.exit(1)
  }
  let written = 0
  for (const raw of candidates) {
    if (written >= MAX_MEMORIES) break
    const candidate = sanitizeCandidate(raw, true)
    if (candidate === null) continue
    // 与插件同款查重:同名或描述 Jaccard≥0.7 跳过(旧值保留——更新正确率据此判定)
    if (existing.some(e => e.name === candidate.name
      || descriptionSimilarity(e.description, candidate.description) >= 0.7)) continue
    await store.write(candidate, candidate.scope, session.cwd)
    written += 1
  }
  console.log(`session ${String(session.id)}(${session.cwd.split('/').pop()}):固化 ${String(written)} 条`)
}

// ---- 对照金标算指标 ----
const goldDurable = dataset.gold.facts.filter(f => f.label === 'durable')
const goldUpdated = dataset.gold.facts.filter(f => f.label === 'updated')
const goldEphemeral = dataset.gold.facts.filter(f => f.label === 'ephemeral')
// 汇总产物:user 层 + 数据集各 cwd 的 project 层(store 安全设计:project 需显式 cwd)
const produced = [
  ...await store.list('user'),
  ...await Promise.all([...new Set(dataset.sessions.map(s => s.cwd))]
    .map(cwd => store.list('project', cwd))),
].flat()

/** 分词(与 descriptionSimilarity 同款,含 CJK bigram)。 */
function words(text) {
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(w => w.length > 0)
  const out = new Set()
  for (const token of tokens) {
    if (/^[一-鿿]+$/.test(token)) {
      if (token.length === 1) out.add(token)
      else for (let i = 0; i + 1 < token.length; i++) out.add(token.slice(i, i + 2))
    } else out.add(token)
  }
  return out
}

/**
 * 证据词覆盖率:金标要点词在产物描述中的覆盖比例。
 * 固化产物是完整句子、金标是压缩短语,Jaccard 天然偏低(实测 12-45%),
 * 覆盖率(金标词被产物包含的比例)才是语义命中的正确度量。
 */
function coverage(goldDescription, producedDescription) {
  const g = words(goldDescription)
  if (g.size === 0) return 0
  const p = words(producedDescription)
  let hit = 0
  for (const w of g) if (p.has(w)) hit += 1
  return hit / g.size
}

const HIT_COVERAGE = 0.6

/** 词匹配带前缀容错(≥5 字符前缀相等视为同词:alloc≈allocation)。 */
function wordHit(a, b) {
  if (a === b) return true
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true
  return false
}

/** name 锚定覆盖:金标 name 的词在产物 name 中的覆盖比例(跨语言稳定:name 恒为英文)。 */
function nameCoverage(goldName, producedName) {
  const g = goldName.split('-').filter(w => w.length > 1)
  if (g.length === 0) return 0
  const p = producedName.split('-').filter(w => w.length > 1)
  let hit = 0
  for (const w of g) if (p.some(x => wordHit(w, x))) hit += 1
  return hit / g.length
}

const NAME_COVERAGE = 0.6

/** 固化产物 → 金标映射:name 锚定(≥0.6)或证据词覆盖(≥0.6),取并集。 */
function mapToGold(memory) {
  for (const fact of [...goldDurable, ...goldUpdated]) {
    if (memory.name === fact.name) return fact
    if (nameCoverage(fact.name, memory.name) >= NAME_COVERAGE) return fact
    if (coverage(fact.description, memory.description) >= HIT_COVERAGE) return fact
  }
  return null
}

let captured = 0
for (const fact of [...goldDurable, ...goldUpdated]) {
  const hit = produced.some(m => mapToGold(m) === fact)
  if (hit) captured += 1
}
const mapped = produced.map(m => mapToGold(m)).filter(f => f !== null)

let pollution = 0
const pollutionDetail = []
for (const fact of goldEphemeral) {
  const hit = produced.find(m => m.name === fact.name
    || coverage(fact.description, m.description) >= HIT_COVERAGE)
  if (hit !== undefined) {
    pollution += 1
    pollutionDetail.push(`${fact.name} ← ${hit.name}`)
  }
}

// 更新正确率:updated 金标的 answer_from 版本存在于任一产物即正确
// (查重机制下新旧版本可能并存——并存本身不判错,可从 precision 侧观察)
let updatedOk = 0
const updatedDetail = []
for (const fact of goldUpdated) {
  const any = produced.some(m => m.name === fact.name
    || coverage(fact.description, m.description) >= HIT_COVERAGE)
  if (any) updatedOk += 1
  else updatedDetail.push(fact.name)
}

const recall = (goldDurable.length + goldUpdated.length) === 0 ? 1 : captured / (goldDurable.length + goldUpdated.length)
const precision = produced.length === 0 ? 0 : mapped.length / produced.length
const pollutionRate = goldEphemeral.length === 0 ? 0 : pollution / goldEphemeral.length
const updateCorrect = goldUpdated.length === 0 ? 1 : updatedOk / goldUpdated.length

// dump 模式:打印产物与每金标最佳覆盖,定位漏配
if (process.argv.includes('--dump')) {
  console.log('\n=== 产物 ===')
  for (const m of produced) console.log(`  [${m.scope}] ${m.name} — ${m.description}`)
  console.log('=== 金标覆盖 ===')
  for (const fact of [...goldDurable, ...goldUpdated]) {
    const best = produced.map(m => ({ n: m.name, c: coverage(fact.description, m.description) }))
      .sort((a, b) => b.c - a.c)[0]
    console.log(`  ${fact.name.padEnd(34)} 最佳:${(best?.n ?? '-').padEnd(38)} ${((best?.c ?? 0) * 100).toFixed(0)}%`)
  }
}

const result = {
  dataset: datasetName, model: MODEL, date: new Date().toISOString(),
  produced: produced.length,
  metrics: {
    recall: Number((recall * 100).toFixed(1)),
    precision: Number((precision * 100).toFixed(1)),
    pollutionRate: Number((pollutionRate * 100).toFixed(1)),
    updateCorrect: Number((updateCorrect * 100).toFixed(1)),
  },
  gold: { durable: goldDurable.length, updated: goldUpdated.length, ephemeral: goldEphemeral.length },
}
console.log(`\n[L3] dataset=${datasetName} model=${MODEL}`)
console.log(`     固化产物 ${String(produced.length)} 条(金标:durable ${String(goldDurable.length)} / updated ${String(goldUpdated.length)} / ephemeral ${String(goldEphemeral.length)})`)
console.log(`     recall=${result.metrics.recall}%  precision=${result.metrics.precision}%  污染率=${result.metrics.pollutionRate}%  更新正确率=${result.metrics.updateCorrect}%`)
await mkdir(join(HERE, '..', 'results'), { recursive: true })
await writeFile(join(HERE, '..', 'results', `l3-${datasetName}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8')
await rm(root, { recursive: true, force: true })
