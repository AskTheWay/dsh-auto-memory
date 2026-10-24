/**
 * LongMemEval-S 子集评测(1.0 A 线:行业基准对齐):
 *   官方 cleaned 数据(hf-mirror 通道,277MB,500 题)→ 按 6 类型分层抽样 N=30
 *   → 每题:~50 个历史会话逐会话过本插件固化管线 → 4KB 预算注入索引 → 问答
 *   → 官方 5 套 judge 模板二值判定(yes/no,temperature 0)
 *   → Task-averaged Accuracy(6 类均值,论文主指标)+ Overall + Abstention 单列
 *
 * 用法:
 *   node evals/runners/l2-longmemeval.mjs --data <s_cleaned.json 路径> [--n 30] [--seed 20261] [--limit 2(试跑)]
 *   数据获取(唯一实测可靠通道,hf 官方域名被 DNS 污染):
 *   curl -L -o s_cleaned.json https://hf-mirror.com/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
 * 诚实声明:judge=deepseek-chat(官方为 gpt-4o-2024-08-06),分数与官方数字
 * 不严格可比;子集非全量;数据用 cleaned 版(官方 2025/09 起推荐)。
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
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.EVAL_MODEL ?? 'deepseek-chat'
if (API_KEY === undefined || API_KEY.length === 0) {
  console.error('需要 DEEPSEEK_API_KEY 环境变量。')
  process.exit(1)
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const DATA_PATH = arg('data', '')
const N = Number(arg('n', 30))
const SEED = Number(arg('seed', 20261))
const LIMIT = Number(arg('limit', 0)) // >0:只跑前 LIMIT 题(管线试跑)
if (DATA_PATH.length === 0) {
  console.error('用法: node evals/runners/l2-longmemeval.mjs --data <s_cleaned.json> [--n 30] [--seed 20261] [--limit 2]')
  process.exit(1)
}

async function chat(messages, maxTokens) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
      })
      if (!response.ok) throw new Error(`API ${String(response.status)}`)
      const data = /** @type {{ choices: Array<{ message: { content: string } }> }} */ (await response.json())
      return data.choices[0]?.message?.content ?? ''
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 3000))
    }
  }
  throw new Error('unreachable')
}

// ---- 官方判分模板(src/evaluation/evaluate_qa.py 原文复刻) ----
const JUDGE_BASE = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.'
const JUDGE_TEMPORAL = JUDGE_BASE + ' Note: For questions asking about the number of days, please allow for off-by-one errors; if the response is off by one day, still answer yes.'
const JUDGE_KNOWLEDGE_UPDATE = JUDGE_BASE + ' Note: If the question asks for some information but the model response contains some old out-dated information along with a new updated answer, please still answer yes as long as the updated answer is correct.'
const JUDGE_PREFERENCE = 'I will give you a question, the description of a correct response, and a response from a model. Please answer yes if the response recalls and utilizes the user\'s personal information correctly and thus fits the user\'s personal preference. Otherwise, answer no. \n\nQuestion: {question}\n\nDescription of Correct Response: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.'
const JUDGE_ABSTENTION = 'I will give you a question and a response from a model. The question is designed to be unanswerable, meaning the information required to answer it is not available in the knowledge source. The correct behavior is for the model to acknowledge that it cannot answer the question or that the information is not available. Please answer yes if the model response correctly identifies the question as unanswerable. Answer no if the model response attempts to provide an answer or guesses. \n\nQuestion: {question}\n\nModel Response: {response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.'

function judgePrompt(questionType, questionId, question, answer, response) {
  if (questionId.endsWith('_abs')) return JUDGE_ABSTENTION.replace('{question}', question).replace('{response}', response)
  if (questionType === 'temporal-reasoning') return JUDGE_TEMPORAL.replace('{question}', question).replace('{answer}', answer).replace('{response}', response)
  if (questionType === 'knowledge-update') return JUDGE_KNOWLEDGE_UPDATE.replace('{question}', question).replace('{answer}', answer).replace('{response}', response)
  if (questionType === 'single-session-preference') return JUDGE_PREFERENCE.replace('{question}', question).replace('{answer}', answer).replace('{response}', response)
  return JUDGE_BASE.replace('{question}', question).replace('{answer}', answer).replace('{response}', response)
}

// ---- 分层抽样:6 类型按 500 题总体比例 + 保 _abs(种子固定可复现) ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stratifiedSample(records, n, seed) {
  const rand = mulberry32(seed)
  const byType = new Map()
  for (const r of records) {
    const list = byType.get(r.question_type) ?? []
    list.push(r)
    byType.set(r.question_type, list)
  }
  for (const list of byType.values()) list.sort(() => rand() - 0.5)
  // 目标配额(四舍五入到至少 1),abs 题优先占类型内名额
  const quota = new Map()
  const total = records.length
  for (const [type, list] of byType) quota.set(type, Math.max(1, Math.round((list.length / total) * n)))
  const picked = []
  const absNeeded = 3
  let absPicked = 0
  for (const [type, list] of byType) {
    let take = quota.get(type)
    const abs = list.filter(r => r.question_id.endsWith('_abs'))
    const plain = list.filter(r => !r.question_id.endsWith('_abs'))
    for (const r of abs) {
      if (take > 0 && absPicked < absNeeded) { picked.push(r); take -= 1; absPicked += 1 }
    }
    for (const r of plain) {
      if (take > 0) { picked.push(r); take -= 1 }
    }
  }
  return picked.slice(0, n)
}

// ---- 主流程 ----
console.log(`[LongMemEval-S] model=${MODEL} N=${N} seed=${SEED}`)
console.log('加载数据…')
const all = /** @type {any[]} */ (JSON.parse(await readFile(DATA_PATH, 'utf8')))
console.log(`  全量 ${String(all.length)} 题`)
const sample = stratifiedSample(all, N, SEED)
const byType = new Map()
for (const r of sample) byType.set(r.question_type, (byType.get(r.question_type) ?? 0) + 1)
console.log('  分层:', [...byType.entries()].map(([t, c]) => `${t}:${String(c)}`).join(' '))

const CONFIG = { maxBytes: 4096, enableUserScope: false, autoSummarize: false }
const CWD = '/longmemeval'
const results = []
const t0 = Date.now()

const targets = LIMIT > 0 ? sample.slice(0, LIMIT) : sample
for (let qi = 0; qi < targets.length; qi++) {
  const item = targets[qi]
  const label = `[${String(qi + 1)}/${String(targets.length)}] ${item.question_id} (${item.question_type}${item.question_id.endsWith('_abs') ? '/abs' : ''})`
  const root = await mkdtemp(join(tmpdir(), 'lme-'))
  try {
    const store = new MemoryStore(root)
    // 固化:逐会话过管线(每会话一次 LLM 调用)
    const sessions = /** @type {any[][]} */ (item.haystack_sessions)
    for (let si = 0; si < sessions.length; si++) {
      const transcript = sessions[si]
        .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 1500)}`)
        .join('\n\n')
      if (transcript.trim().length === 0) continue
      const existing = await store.listAll(CWD)
      const prompt = buildConsolidationPrompt(existing.map(r => r.name), transcript, 8)
      let text
      try {
        text = await chat([{ role: 'user', content: prompt }], 2048)
      } catch (error) {
        console.warn(`  ${label} 会话 ${String(si)} 固化失败: ${String(error).slice(0, 80)}`)
        continue
      }
      const candidates = parseCandidates(text) ?? []
      for (const raw of candidates) {
        const candidate = sanitizeCandidate(raw, false)
        if (candidate === null) continue
        const existingAll = await store.listAll(CWD)
        const dup = existingAll.find(r => r.name === candidate.name)
        if (dup !== undefined) {
          await store.write({ name: dup.name, description: candidate.description, type: candidate.type, body: candidate.body }, 'project', CWD)
        } else {
          await store.write(candidate, 'project', CWD)
        }
      }
    }
    // 问答:4KB 预算注入索引
    const indexText = renderMemoryIndexText(store, CONFIG, CWD)
    const question = indexText.length > 0
      ? `${indexText}\n\nUsing your memories of past sessions if helpful, answer: ${item.question}\nAnswer concisely. If you don't have the information, say so.`
      : `${item.question}\nAnswer concisely. If you don't have the information, say so.`
    const hypothesis = await chat([{ role: 'user', content: question }], 512)
    // 判分:官方模板
    const verdictRaw = await chat([{ role: 'user', content: judgePrompt(item.question_type, item.question_id, item.question, item.answer, hypothesis) }], 10)
    const correct = verdictRaw.toLowerCase().includes('yes')
    const memoryCount = (await store.listAll(CWD)).length
    results.push({ question_id: item.question_id, question_type: item.question_type, abs: item.question_id.endsWith('_abs'), correct })
    console.log(`  ${label} → ${correct ? '✓' : '✗'} (记忆 ${String(memoryCount)} 条, ${String(Math.round((Date.now() - t0) / 1000))}s 累计)`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- 指标:Task-averaged(6 类均值,论文主指标)+ Overall + Abstention ----
const byTypeResult = new Map()
for (const r of results) {
  if (r.abs) continue
  const list = byTypeResult.get(r.question_type) ?? []
  list.push(r)
  byTypeResult.set(r.question_type, list)
}
const perType = new Map()
for (const [type, list] of byTypeResult) {
  perType.set(type, { correct: list.filter(r => r.correct).length, total: list.length })
}
const taskAveraged = perType.size === 0 ? 0 : [...perType.values()].reduce((s, v) => s + v.correct / v.total, 0) / perType.size
const overall = results.length === 0 ? 0 : results.filter(r => r.correct).length / results.length
const absRows = results.filter(r => r.abs)
const abstention = absRows.length === 0 ? 0 : absRows.filter(r => r.correct).length / absRows.length

const result = {
  benchmark: 'LongMemEval-S (cleaned) subset', model: MODEL, judge: MODEL, date: new Date().toISOString(),
  subset: { n: results.length, seed: SEED, sampling: 'stratified by question_type, 3 abs included' },
  metrics: {
    taskAveragedAccuracy: Number((taskAveraged * 100).toFixed(1)),
    overallAccuracy: Number((overall * 100).toFixed(1)),
    abstentionAccuracy: Number((abstention * 100).toFixed(1)),
    perType: Object.fromEntries([...perType.entries()].map(([t, v]) => [t, `${String(v.correct)}/${String(v.total)}`])),
  },
  rows: results,
}
console.log(`\n[LongMemEval-S] Task-avg ${result.metrics.taskAveragedAccuracy}% | Overall ${result.metrics.overallAccuracy}% | Abstention ${result.metrics.abstentionAccuracy}%`)
console.log('     分项:', JSON.stringify(result.metrics.perType))
await mkdir(join(HERE, '..', 'results'), { recursive: true })
await writeFile(join(HERE, '..', 'results', 'l2-longmemeval.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
