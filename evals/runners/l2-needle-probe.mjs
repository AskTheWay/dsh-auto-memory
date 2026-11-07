/**
 * 单题针位探针(1.3.1 复跑后的根因诊断,一次性):
 *   取一道错题,跑同一条固化管线,然后定位金标答案在哪一环丢失:
 *   A) 从未固化(store 里没有任何 body 含答案关键片段)
 *   B) 已固化但被截断(body 在 store,但不在注入索引前 30 行)
 *   C) 已注入但模型没答对(索引里有,判分仍 ✗)
 * 用法:DEEPSEEK_API_KEY=… node evals/runners/l2-needle-probe.mjs <question_id>
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { MemoryStore, DEFAULT_IMPORTANCE } from '../../src/store.ts'
import { renderMemoryIndexText } from '../../src/prompt.ts'
import { buildConsolidationPrompt, parseCandidates, sanitizeCandidate, isChitchat } from '../../src/consolidate.ts'
import { decideConsolidationAction, detectContradictions } from '../../src/matching.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY = process.env.DEEPSEEK_API_KEY
const QID = process.argv[2] ?? '4bc144e2'
if (KEY === undefined) { console.error('need DEEPSEEK_API_KEY'); process.exit(1) }

const all = JSON.parse(await readFile(join(HERE, '..', 'datasets', 'longmemeval', 's_cleaned.json'), 'utf8'))
const item = all.find(q => q.question_id === QID)
if (item === undefined) { console.error('question not found:', QID); process.exit(1) }
console.log(`探针题:${item.question_id} (${item.question_type})\nQ: ${item.question}\n金标答案: ${item.answer}\n证据会话: ${item.answer_session_ids.join(', ')}`)

async function chat(messages, maxTokens) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: maxTokens, temperature: 0 }),
  })
  if (!r.ok) throw new Error(`API ${String(r.status)}`)
  return (await r.json()).choices[0]?.message?.content ?? ''
}

const root = await mkdtemp(join(tmpdir(), 'probe-'))
const store = new MemoryStore(root)
const CWD = '/longmemeval'
// 与 runner 相同:逐会话固化(答案证据会话标记 last,与原序一致)
for (let si = 0; si < item.haystack_sessions.length; si++) {
  const transcript = item.haystack_sessions[si]
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 1500)}`)
    .join('\n\n')
  if (transcript.trim().length === 0) continue
  const existing = await store.listAll(CWD)
  const prompt = buildConsolidationPrompt(existing.map(r => r.name), transcript, 8)
  const text = await chat([{ role: 'user', content: prompt }], 2048)
  const candidates = parseCandidates(text) ?? []
  for (const raw of candidates) {
    const candidate = sanitizeCandidate(raw, false)
    if (candidate === null) continue
    const existingAll = await store.listAll(CWD)
    const decision = decideConsolidationAction(candidate, existingAll)
    if (decision.action === 'create') {
      const eff = candidate.importance ?? DEFAULT_IMPORTANCE[candidate.type]
      if (eff < 4) continue
      if (isChitchat(candidate.body)) continue
      await store.write(candidate, 'project', CWD)
    } else {
      const contra = detectContradictions(candidate, decision.target)
      if (contra.length > 0) {
        const base = candidate.name.length > 61 ? candidate.name.slice(0, 61) : candidate.name
        let newName = candidate.name === decision.target.name ? `${base}-v2` : candidate.name
        let n = 2
        while (existingAll.some(r => r.name === newName)) { n += 1; newName = `${base}-v${String(n)}` }
        await store.write({ ...candidate, name: newName, supersedes: decision.target.name }, 'project', CWD)
        const old = await store.read(decision.target.name, 'project', CWD)
        if (old !== null) await store.write({ name: old.name, description: old.description, type: old.type, body: old.body, status: 'superseded', supersededBy: newName }, 'project', CWD)
      } else {
        await store.write({ name: decision.target.name, description: candidate.description, type: candidate.type, body: candidate.body, ...(candidate.importance !== undefined ? { importance: candidate.importance } : {}) }, 'project', CWD)
      }
    }
  }
}

// ---- 定位丢失环节 ----
const answerLower = item.answer.toLowerCase()
/** 金标答案的区分性关键词(含数字/货币;≥2 字符,题目专有名词并入) */
const STOP = new Set(['how', 'much', 'did', 'spend', 'and', 'the', 'was', 'were', 'has', 'had', 'with', 'that', 'this', 'from', 'they', 'them', 'their', 'have', 'which', 'would', 'could', 'about', 'into', 'than', 'then', 'when', 'what', 'where', 'user', 'assistant'])
const answerTerms = [...new Set((answerLower.match(/[a-z0-9]{2,}/g) ?? []).filter(w => !STOP.has(w)))]
const questionTerms = [...new Set((item.question.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !STOP.has(w)))]
const terms = [...answerTerms, ...questionTerms]
console.log(`\n答案词(${String(answerTerms.length)}): ${answerTerms.join(', ')} | 题目词(${String(questionTerms.length)}): ${questionTerms.join(', ')}`)

const records = await store.listAll(CWD)
console.log(`\nstore 总量: ${String(records.length)} 条(可见 ${(records.filter(r => r.status !== 'superseded' && r.status !== 'disputed').length)} 条`)

// A) 固化命中:某条 body/description 同时含 ≥ 半数答案词,或含任一答案词+题目词
const consolidatedHits = records.filter(r => {
  const text = `${r.description} ${r.body}`.toLowerCase()
  const ansHits = answerTerms.filter(t => text.includes(t)).length
  if (ansHits >= Math.max(1, Math.ceil(answerTerms.length * 0.6))) {
    return questionTerms.some(qt => text.includes(qt)) || ansHits >= answerTerms.length
  }
  return false
})
console.log(`\n[A] 固化命中(含 ≥ 半数关键词): ${String(consolidatedHits.length)} 条`)
for (const r of consolidatedHits.slice(0, 5)) {
  console.log(`    - ${r.name} (${r.type}${r.status !== undefined ? `,${r.status}` : ''}): ${r.description.slice(0, 70)}`)
}

// B) 注入命中:索引文本含答案词
const indexText = renderMemoryIndexText(store, { maxBytes: 4096, enableUserScope: false, autoSummarize: false }, CWD)
const inIndex = answerTerms.filter(t => indexText.toLowerCase().includes(t))
console.log(`\n[B] 注入索引含答案词: ${String(inIndex.length)}/${String(answerTerms.length)}${inIndex.length > 0 ? ` (${inIndex.join(', ')})` : ''}`)
console.log(`    索引行数: ${String((indexText.match(/^- \[/gm) ?? []).length)}(预算 4KB)`)

// C) 问答(如果 A/B 有命中,看模型是否答对)
if (consolidatedHits.length > 0 || inIndex.length >= 2) {
  const q = indexText.length > 0 ? `${indexText}\n\nUsing your memories of past sessions if helpful, answer: ${item.question}\nAnswer concisely.` : item.question
  const hyp = await chat([{ role: 'user', content: q }], 512)
  console.log(`\n[C] 模型回答: ${hyp.slice(0, 200)}`)
  console.log(`    金标: ${item.answer}`)
}

await rm(root, { recursive: true, force: true })
