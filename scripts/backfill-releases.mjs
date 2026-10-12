/**
 * 补建历史 GitHub Releases(一次性脚本):
 *   读 CHANGELOG.md 的每个版本段 → 对应 tag 建 Release(已存在的跳过)。
 *
 * 用法:GH_TOKEN=<AskTheWay PAT(repo 权限)> node scripts/backfill-releases.mjs [--dry]
 *
 * 注意:token 只从环境变量读,绝不写进仓库/日志/results。
 * v0.3.0 从未打过 tag:脚本通过 target_commitish 指向其发布提交,
 * GitHub 会在建 Release 时自动创建该 tag。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'AskTheWay/dsh-auto-memory'
/** 从未推送过的 tag → 发布提交(其余 tag 远端已存在,Release 直接挂)。 */
const MISSING_TAGS = { 'v0.3.0': 'e2d3987' }

const TOKEN = process.env.GH_TOKEN
if (TOKEN === undefined || TOKEN.length === 0) {
  console.error('需要 GH_TOKEN 环境变量(repo 读写的 PAT)。')
  process.exit(1)
}
const DRY = process.argv.includes('--dry')
/** --only <ver>:只处理该版本(缺省处理 CHANGELOG 全部版本)。 */
const onlyIndex = process.argv.indexOf('--only')
const ONLY = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined

const HERE = dirname(fileURLToPath(import.meta.url))
const changelog = await readFile(join(HERE, '..', 'CHANGELOG.md'), 'utf8')

// 解析 CHANGELOG:## [ver] - date 段落(到下一个 ## 或文件尾)
const sections = new Map()
const lines = changelog.split('\n')
let current = null
for (const line of lines) {
  const match = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line)
  if (match !== null) {
    current = { version: match[1], date: match[2], body: [] }
    sections.set(match[1], current)
    continue
  }
  if (/^## /.test(line)) current = null // 未知小节(如文件头标题)结束当前段
  if (current !== null) current.body.push(line)
}

// 远端已存在的 Release → 跳过
const api = (path, init) => fetch(`https://api.github.com${path}`, {
  ...init,
  headers: {
    authorization: `Bearer ${TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(init?.headers ?? {}),
  },
})

const existing = await api(`/repos/${REPO}/releases?per_page=100`)
if (!existing.ok) {
  console.error(`列 Release 失败: ${String(existing.status)} ${await existing.text()}`)
  process.exit(1)
}
const existingTags = new Set((await existing.json()).map(r => r.tag_name))

for (const { version, date, body } of sections.values()) {
  if (ONLY !== undefined && version !== ONLY) continue
  const tag = `v${version}`
  if (existingTags.has(tag)) {
    console.log(`跳过 ${tag}(Release 已存在)`)
    continue
  }
  const notes = body.join('\n').trim()
  if (notes.length === 0) {
    console.log(`跳过 ${tag}(CHANGELOG 段为空)`)
    continue
  }
  const payload = {
    tag_name: tag,
    name: tag,
    body: `Released ${date}\n\n${notes}`,
    ...(MISSING_TAGS[tag] !== undefined ? { target_commitish: MISSING_TAGS[tag] } : {}),
  }
  if (DRY) {
    console.log(`[dry] 将建 ${tag}:${notes.split('\n')[0]}…`)
    continue
  }
  const created = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  console.log(created.ok ? `✓ ${tag}` : `✗ ${tag}: ${String(created.status)} ${(await created.text()).slice(0, 200)}`)
}
console.log(DRY ? '(dry run,未做更改)' : '补齐完成')
