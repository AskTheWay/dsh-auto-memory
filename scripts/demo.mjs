/**
 * 记忆插件无 key 演示:不开浏览器、不配模型,直接驱动核心链路——
 *   写入记忆 → MEMORY.md 索引重建 → 模拟系统提示词组装(索引注入)
 * Node >= 23.6 原生 type-stripping 直接跑 .ts;依赖解析走本仓库 node_modules。
 * 用法:node scripts/demo.mjs [记忆根目录](缺省 ./.demo-memory,可重复运行)
 */

import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { renderMemoryIndexText } from '../src/prompt.ts'

const CWD = process.cwd() // 演示工作区 = 当前目录(真实场景是会话 cwd)

const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'memory-demo-'))
const store = new MemoryStore(root)
const config = { maxBytes: 4096, enableUserScope: true, autoSummarize: false }

const hr = (title) => console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`)

hr(`① 模拟模型调用 memory_write(记忆根: ${root})`)
await store.write({
  name: 'user-prefers-python',
  title: '用户是 Python 后端工程师',
  description: '正在准备面试;偏好中文交流',
  type: 'user',
  body: '用户主攻 Python 后端,正在准备面试。相关项目: [[id-generator-benchmark]]。',
}, 'project', CWD)
await store.write({
  name: 'id-generator-benchmark',
  title: '压测过 PostgreSQL',
  description: 'psycopg2 连接池有踩坑经验(2026-09)',
  type: 'project',
  body: '在 id-generator-benchmark 项目中对 PostgreSQL 做过压测,psycopg2 连接池参数有实操教训。',
}, 'project', CWD)
const projectDir = join(root, (await readdir(root)).find(d => d.startsWith('--')))
console.log('落盘文件:', (await readdir(projectDir)).join(', '))
console.log('\nMEMORY.md 内容:')
console.log(await readFile(join(projectDir, 'MEMORY.md'), 'utf8'))

hr('② 模拟下一次会话的系统提示词组装(模型看到的注入)')
const injected = renderMemoryIndexText(store, config, CWD)
console.log(injected)

hr('③ 查重更新:同名再写,索引仍是一条(更新而非堆积)')
await store.write({
  name: 'user-prefers-python',
  title: '用户是 Python 后端工程师',
  description: '正在准备后端/系统方向面试;偏好中文交流',
  type: 'user',
  body: '更新后的正文。',
}, 'project', CWD)
console.log(await readFile(join(projectDir, 'MEMORY.md'), 'utf8'))

hr('④ 删光记忆:索引文件移除,注入段消失(无记忆零占用)')
await store.delete('user-prefers-python', 'project', CWD)
await store.delete('id-generator-benchmark', 'project', CWD)
const after = renderMemoryIndexText(store, config, CWD)
console.log(`注入段长度 = ${after.length}(空串 = 模型看不到任何 memory 内容)`)
console.log(`残留文件 = ${(await readdir(projectDir)).join(', ') || '(无)'}`)

if (!process.argv[2]) await rm(root, { recursive: true, force: true })
console.log('\n演示完成。')
