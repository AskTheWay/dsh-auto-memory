/**
 * 记忆插件无 key 演示:不开浏览器、不配模型,直接驱动核心链路。
 * 覆盖 0.1→0.5 的完整能力面:
 *   写入(自动脱敏)→ 三因子索引(置顶/重要度)→ 注入渲染(协议壳/预算)
 *   → 查重更新 → 召回展开 → 软淘汰 → 删空归零
 * Node >= 23.6 原生 type-stripping 直接跑 .ts。
 * 用法:node scripts/demo.mjs [记忆根目录](缺省临时目录,可重复运行)
 */

import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { renderMemoryIndexText } from '../src/prompt.ts'
import { expandLinks } from '../src/links.ts'

const CWD = process.cwd() // 演示工作区 = 当前目录(真实场景是会话 cwd)

const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'memory-demo-'))
const store = new MemoryStore(root, { staleAfterDays: 90 })
const config = { maxBytes: 4096, enableUserScope: true, autoSummarize: false }

const hr = (title) => console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)

hr('① 写入三条记忆(注意第三条带"泄漏"的假密钥——落盘前被自动脱敏)')
await store.write({
  name: 'user-prefers-python',
  title: '用户是 Python 后端工程师',
  description: '正在准备面试;偏好中文交流',
  type: 'user', importance: 9,
  body: '用户主攻 Python 后端,正在准备面试。相关项目: [[id-generator-benchmark]]。',
}, 'project', CWD)
await store.write({
  name: 'id-generator-benchmark',
  title: '压测过 PostgreSQL',
  description: 'psycopg2 连接池有踩坑经验(2026-09)',
  type: 'project',
  body: '在 id-generator-benchmark 项目中对 PostgreSQL 做过压测,psycopg2 连接池参数有实操教训。',
}, 'project', CWD)
const leaky = await store.write({
  name: 'legacy-note',
  description: 'key: ghp_aaaa' + 'a'.repeat(32),
  type: 'reference',
  body: '一条试图把密钥写进记忆的笔记(npm_' + 'b'.repeat(32) + ')。',
}, 'project', CWD)
console.log('第三条已写入,返回的 description:', leaky.description.slice(0, 60))
console.log('→ 密钥形态已被替换为 [REDACTED:*]')

const projectDir = join(root, (await readdir(root)).find(d => d.startsWith('--')))
console.log('落盘文件:', (await readdir(projectDir)).join(', '))

hr('② 三因子索引:置顶一条,观察排序(置顶 > 重要度 > 字典序)')
await store.write({
  name: 'aaa-dict-first',
  description: '字典序最前但重要度低',
  type: 'reference',
  body: '不重要。',
}, 'project', CWD)
await store.write({
  name: 'pinned-anchor', title: '用户明确说永远记住',
  description: '置顶信任锚点', type: 'feedback', pinned: true,
  body: '**Why:** 用户明确要求。 **How to apply:** 每次会话优先呈现。',
}, 'project', CWD)
console.log(await readFile(join(projectDir, 'MEMORY.md'), 'utf8'))

hr('③ 模型实际看到的注入段(协议壳 + 预算 + 写入指导)')
console.log(renderMemoryIndexText(store, config, CWD))

hr('④ 召回展开:memory_read 语义(正文 + [[链接]] 一层摘要)')
const record = await store.read('user-prefers-python', 'project', CWD)
const { linked } = await expandLinks(record.body, record.name, async name => store.read(name, 'project', CWD))
console.log(`读到: ${record.title}(${record.type}, importance ${record.importance})`)
if (linked.length > 0) console.log('链接展开:', linked.map(l => `${l.name} — ${l.description}`).join('; '))

hr('⑤ 软淘汰:legacy-note 标记为 200 天前 → 从索引消失,文件保留')
const legacyFile = join(projectDir, 'legacy-note.md')
await writeFile(legacyFile, (await readFile(legacyFile, 'utf8')).replace(/^updated: \d+$/m, `updated: ${Date.now() - 200 * 86_400_000}`), 'utf8')
await store.refreshIndex('project', CWD)
const afterEvict = renderMemoryIndexText(store, config, CWD)
console.log('索引中还有 legacy-note 吗:', afterEvict.includes('legacy-note') ? '在(异常!)' : '不在 ✓(文件仍在盘上)')

hr('⑥ 查重更新:同名再写 = 更新而非堆积;删空后注入归零')
await store.write({ name: 'user-prefers-python', description: '准备后端/系统方向面试;偏好中文', type: 'user', importance: 9, body: '更新后。' }, 'project', CWD)
const namesNow = (await store.list('project', CWD)).map(r => r.name)
console.log('更新后记忆集合:', namesNow.join(', '), `(共 ${namesNow.length} 条,无重复)`)
for (const name of [...namesNow]) await store.delete(name, 'project', CWD)
console.log('全部删除后注入段长度 =', renderMemoryIndexText(store, config, CWD).length, '(0 = 零占用)')

if (!process.argv[2]) await rm(root, { recursive: true, force: true })
console.log('\n演示完成。')
