/**
 * L2 端到端评测(每题 3 次 LLM 调用:固化已在会话阶段完成,此处问答×2 组 + 盲判):
 *   数据集会话 → 固化管线(与 L3 同路径) → 构建注入索引
 *   → 逐探针题双组作答:WITH(带记忆索引)/ WITHOUT(空库,索引段整段消失)
 *   → LLM 盲判(不见组别,只对答案与金标描述)
 *   → 指标:with 组正确率 / baseline(无记忆)正确率 / lift(记忆净贡献)/ 拒答正确率
 * 用法:DEEPSEEK_API_KEY=sk-... node evals/runners/l2-e2e.mjs [dataset](缺省 mini)
 * 意义:L1 只证明"记忆在场",L2 证明"模型因它答对了"——端到端净效果。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../../src/store.ts'
import { renderMemoryIndexText } from '../../src/prompt.ts'
import { buildConsolidationPrompt, parseCandidates, sanitizeCandidate } from '../../src/consolidate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATASETS = join(HERE, '..', 'datasets', 'harness-sessions')
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.EVAL_MODEL ?? 'deepseek-chat'
const MAX_MEMORIES = 8

if (API_KEY === undefined || API_KEY.length === 0) {
  console.error('需要 DEEPSEEK_API_KEY 环境变量(固化 + 双组问答 + 盲判,mini 约 40 次调用)。')
  process.exit(1)
}

const datasetName = process.argv[2] ?? 'mini'
const dataset = /** @type {any} */ (JSON.parse(await readFile(join(DATASETS, `${datasetName}.json`), 'utf8')))

/** 单次 LLM 调用(chat)。 */
async function chat(messages, maxTokens = 1024) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
  })
  if (!response.ok) throw new Error(`API ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  const data = /** @type {{ choices: Array<{ message: { content: string } }> }} */ (await response.json())
  return data.choices[0]?.message?.content ?? ''
}

// ---- 阶段 1:固化(与 L3 runner 同一条代码路径) ----
console.log(`[L2] dataset=${datasetName} model=${MODEL}`)
console.log('阶段 1/3:固化(逐会话)')
const root = await mkdtemp(join(tmpdir(), 'l2-e2e-'))
const store = new MemoryStore(root)
for (const session of dataset.sessions) {
  const transcript = session.messages
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`)
    .join('\n\n')
  const existing = await store.listAll(session.cwd)
  const prompt = buildConsolidationPrompt(existing.map(r => r.name), transcript, MAX_MEMORIES)
  const text = await chat([{ role: 'user', content: prompt }], 2048)
  const candidates = parseCandidates(text) ?? []
  for (const raw of candidates) {
    const candidate = sanitizeCandidate(raw, true)
    if (candidate === null) continue
    const decision = (await import('../../src/matching.ts')).decideConsolidationAction(candidate, await store.listAll(session.cwd))
    if (decision.action === 'update') {
      await store.write({ name: decision.target.name, title: candidate.title ?? undefined, description: candidate.description, type: candidate.type, body: candidate.body, ...(candidate.importance !== undefined ? { importance: candidate.importance } : {}) }, decision.target.scope, session.cwd)
    } else {
      await store.write(candidate, candidate.scope, session.cwd)
    }
  }
  console.log(`  session ${String(session.id)}: 固化完成`)
}

// ---- 阶段 2:双组问答 ----
console.log('阶段 2/3:探针问答(WITH / WITHOUT 双组)')
const CONFIG = { maxBytes: 4096, enableUserScope: true, autoSummarize: false }
const cwds = [...new Set(dataset.persona.workspaces)]
const withIndex = cwds.map(cwd => renderMemoryIndexText(store, CONFIG, cwd)).filter(t => t.length > 0).join('\n\n')
const emptyStore = new MemoryStore(await mkdtemp(join(tmpdir(), 'l2-empty-')))
const withoutIndex = cwds.map(cwd => renderMemoryIndexText(emptyStore, CONFIG, cwd)).filter(t => t.length > 0).join('\n\n')

/** 金标描述表:judge 需要知道"正确答案长什么样"(按 expect 名单聚合)。 */
const factDescription = new Map(dataset.gold.facts.map(f => [f.name, `${f.description}`]))

function answerPrompt(indexText, question) {
  const memory = indexText.length > 0
    ? `${indexText}\n\nUse the memory above if it helps; if it does not contain the answer, say you don't know.`
    : 'You have no memory of past sessions.'
  return `${memory}\n\nQuestion: ${question}\nAnswer concisely in the same language as the question.`
}

const JUDGE_SYSTEM = 'You are a strict, blind grader for a memory QA benchmark. Given a question, the expected fact(s) described in natural language, and an answer, judge ONLY whether the answer conveys the expected fact(s). Output ONLY JSON: {"verdict":"correct"|"wrong"|"abstain"} — "abstain" means the answer says it does not know / has no such information. Do not reward guesses that happen to sound right.'

async function judge(question, expectedDescriptions, answer, expectAbstain) {
  const expected = expectAbstain
    ? 'The question asks about something NOT covered by the available information. The correct behavior is to say you do not know / have no record of it.'
    : `Expected fact(s): ${expectedDescriptions.join('; ')}`
  const raw = await chat([
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `Question: ${question}\n${expected}\n\nAnswer: ${answer}` },
  ], 256)
  const match = /\{[^}]*\}/.exec(raw)
  try {
    const parsed = JSON.parse(match !== null ? match[0] : raw)
    return parsed.verdict === 'correct' || parsed.verdict === 'wrong' || parsed.verdict === 'abstain' ? parsed.verdict : 'wrong'
  } catch { return 'wrong' }
}

const scored = dataset.gold.probes.filter(p => p.kind !== 'abstention')
const abstentions = dataset.gold.probes.filter(p => p.kind === 'abstention')
const rows = []
let done = 0
for (const probe of dataset.gold.probes) {
  const expectedDescriptions = probe.expect
    .map(name => factDescription.get(name))
    .filter(d => d !== undefined)
  for (const group of ['with', 'without']) {
    const indexText = group === 'with' ? withIndex : withoutIndex
    const answer = await chat([{ role: 'user', content: answerPrompt(indexText, probe.q) }], 512)
    const expectAbstain = probe.expect.length === 0
    const verdict = await judge(probe.q, expectedDescriptions, answer, expectAbstain)
    rows.push({ q: probe.q, kind: probe.kind, group, verdict, answer: answer.slice(0, 200) })
  }
  done += 1
  console.log(`  [${String(done)}/${String(dataset.gold.probes.length)}] ${probe.kind}: ${probe.q.slice(0, 24)}…`)
}

// ---- 阶段 3:指标(scored 题计 correct;abstention 题正确行为 = abstain) ----
const verdictOf = (q, group) => rows.find(r => r.q === q.q && r.group === group)?.verdict ?? 'wrong'
const acc = (probes, group) => probes.length === 0
  ? 1
  : probes.filter(p => verdictOf(p, group) === (p.expect.length === 0 ? 'abstain' : 'correct')).length / probes.length
const withScored = acc(scored, 'with')
const withoutScored = acc(scored, 'without')
const withAbstain = acc(abstentions, 'with')
const withoutAbstain = acc(abstentions, 'without')

const result = {
  dataset: datasetName, model: MODEL, date: new Date().toISOString(),
  probes: { scored: scored.length, abstention: abstentions.length },
  metrics: {
    e2eRecall: Number((withScored * 100).toFixed(1)),
    baselineRecall: Number((withoutScored * 100).toFixed(1)),
    lift: Number(((withScored - withoutScored) * 100).toFixed(1)),
    abstentionWith: Number((withAbstain * 100).toFixed(1)),
    abstentionWithout: Number((withoutAbstain * 100).toFixed(1)),
  },
  rows,
}
console.log(`\n[L2] 端到端(with 记忆): ${result.metrics.e2eRecall}% | baseline(无记忆): ${result.metrics.baselineRecall}% | lift: ${result.metrics.lift > 0 ? '+' : ''}${result.metrics.lift}%`)
console.log(`     拒答正确率 with ${result.metrics.abstentionWith}% / without ${result.metrics.abstentionWithout}%`)
await mkdir(join(HERE, '..', 'results'), { recursive: true })
await writeFile(join(HERE, '..', 'results', `l2-${datasetName}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8')
await rm(root, { recursive: true, force: true })
