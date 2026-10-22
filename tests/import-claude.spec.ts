/**
 * 0.8.0 导入桥测试:scan(多项目/空项目/MEMORY.md 排除/无 .claude 目录)、
 * parse(类型映射缺省/H1 提取/name 回退/时间解析)、cwd 反解(jsonl 流式头部)、
 * run(计数/幂等 skip/allToUser/安全层脱敏/时间戳保留/项目层折叠)。
 * 0.10.0 撤销:annotate 逐条状态(pending/imported/modified/conflict)、
 * 条目级导入、revoke(来源匹配 + 未修改才删,两层查找)。
 * 外部世界断言原则:读真实落盘文件。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, contentFingerprint, projectKey } from '../src/store.ts'
import {
  parseClaudeMemory, extractCwdFromSessions, scanClaudeMemory, runClaudeImport,
  annotateClaudeImport, revokeClaudeImports,
} from '../src/import-claude.ts'

const SAMPLE = (over: Record<string, unknown> = {}, body = '# 标题行\n\n正文内容。'): string =>
  `---\nname: sample-memory\ndescription: 样例记忆\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: 00000000-0000-0000-0000-000000000000\n  modified: 2026-09-01T00:00:00.000Z\n${Object.entries(over).map(([k, v]) => `  ${k}: ${String(v)}\n`).join('')}---\n\n${body}\n`

let base: string
let store: MemoryStore

beforeEach(async () => {
  base = await fsp.mkdtemp(join(tmpdir(), 'dsh-import-'))
  store = new MemoryStore(join(base, 'memory-root'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('parseClaudeMemory', () => {
  it('标准样本:name/description 直传、type 映射、H1 提取、ISO 时间解析', () => {
    const item = parseClaudeMemory(SAMPLE(), 'fallback')
    expect(item).not.toBeNull()
    expect(item?.name).toBe('sample-memory')
    expect(item?.type).toBe('project')
    expect(item?.title).toBe('标题行')
    expect(item?.modifiedMs).toBe(Date.parse('2026-09-01T00:00:00.000Z'))
  })
  it('未知/缺失 type → reference 缺省;无 modified → undefined', () => {
    // 用 replace 而非 SAMPLE 的 over 注入:模板已含 type 行,追加会造成 YAML 重复键
    expect(parseClaudeMemory(SAMPLE().replace('type: project', 'type: weird-kind'), 'f')?.type).toBe('reference')
    expect(parseClaudeMemory(SAMPLE().replace('type: project', "type: ''"), 'f')?.type).toBe('reference')
    const noModified = parseClaudeMemory(`---\nname: x\ndescription: d\nmetadata:\n  type: user\n---\n\n正文`, 'f')
    expect(noModified?.type).toBe('user')
    expect(noModified?.modifiedMs).toBeUndefined()
  })
  it('name 不可归一化(中文)→ 回退文件名;两者都坏 → null', () => {
    const raw = SAMPLE().replace('name: sample-memory', 'name: 中文标识')
    expect(parseClaudeMemory(raw, 'file-name')?.name).toBe('file-name')
    expect(parseClaudeMemory('---\ndescription: d\n---\n正文', '中文')).toBeNull()
  })
  it('缺 description → null;无 H1 → title 缺省', () => {
    expect(parseClaudeMemory('---\nname: x\n---\n正文', 'f')).toBeNull()
    expect(parseClaudeMemory(`---\nname: x\ndescription: d\n---\n\n没有标题的正文`, 'f')?.title).toBeUndefined()
  })
  it('无 frontmatter → null', () => {
    expect(parseClaudeMemory('just plain text', 'f')).toBeNull()
  })
})

describe('extractCwdFromSessions', () => {
  it('jsonl 首条含 cwd 的记录生效(Windows 转义路径)', async () => {
    const dir = join(base, 'proj-with-sessions')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'abc.jsonl'), `{"timestamp":"...","cwd":"D:\\\\work\\\\proj"}\n{"cwd":"/other"}\n`, 'utf8')
    expect(await extractCwdFromSessions(dir)).toBe('D:\\work\\proj')
  })
  it('POSIX cwd 与超长 jsonl(头部无 cwd)均正确处理', async () => {
    const dir = join(base, 'posix-sessions')
    await fsp.mkdir(dir, { recursive: true })
    const filler = `{"pad":"${'x'.repeat(1000)}"}\n`.repeat(300) // 头部 256KB 无 cwd
    await fsp.writeFile(join(dir, 'big.jsonl'), `${filler}{"cwd":"/home/u/a"}\n`, 'utf8')
    expect(await extractCwdFromSessions(dir)).toBeNull()
    const dir2 = join(base, 'posix-ok')
    await fsp.mkdir(dir2, { recursive: true })
    await fsp.writeFile(join(dir2, 's.jsonl'), '{"cwd":"/home/u/a"}\n', 'utf8')
    expect(await extractCwdFromSessions(dir2)).toBe('/home/u/a')
  })
  it('无 jsonl / 目录不存在 → null', async () => {
    expect(await extractCwdFromSessions(base)).toBeNull()
    expect(await extractCwdFromSessions(join(base, 'nope'))).toBeNull()
  })
})

describe('scanClaudeMemory', () => {
  it('多项目统计、空项目跳过、MEMORY.md 排除、未装 → 空', async () => {
    const home = join(base, 'home')
    const p1 = join(home, '.claude', 'projects', 'D--proj-one', 'memory')
    const p2 = join(home, '.claude', 'projects', 'd--proj-two', 'memory')
    const empty = join(home, '.claude', 'projects', 'D--empty-proj', 'memory')
    await fsp.mkdir(p1, { recursive: true })
    await fsp.mkdir(p2, { recursive: true })
    await fsp.mkdir(empty, { recursive: true })
    await fsp.writeFile(join(p1, 'alpha.md'), SAMPLE(), 'utf8')
    await fsp.writeFile(join(p1, 'MEMORY.md'), '# 索引(应被排除)', 'utf8')
    await fsp.writeFile(join(p1, 'bad.md'), 'no frontmatter', 'utf8')
    await fsp.writeFile(join(p2, 'beta.md'), SAMPLE(), 'utf8')
    await fsp.writeFile(join(empty, 'MEMORY.md'), '# 空项目只有索引', 'utf8')
    const scan = await scanClaudeMemory(home)
    expect(scan.totalImportable).toBe(2)
    expect(scan.projects.map(p => p.slug)).toEqual(['D--proj-one', 'd--proj-two'])
    expect(scan.projects[0]?.files.map(f => f.file)).toEqual(['alpha.md', 'bad.md'])
    expect(await scanClaudeMemory(join(base, 'no-such-home'))).toEqual({ home: join(base, 'no-such-home', '.claude', 'projects'), projects: [], totalImportable: 0 })
  })
})

describe('runClaudeImport', () => {
  async function prepare(home: string): Promise<void> {
    const p1 = join(home, '.claude', 'projects', 'D--proj-one', 'memory')
    await fsp.mkdir(p1, { recursive: true })
    await fsp.writeFile(join(p1, 'alpha.md'), SAMPLE(), 'utf8')
    await fsp.writeFile(join(home, '.claude', 'projects', 'D--proj-one', 'sess.jsonl'), '{"cwd":"D:\\\\proj-one"}\n', 'utf8')
    const p2 = join(home, '.claude', 'projects', 'd--cold-dir', 'memory')
    await fsp.mkdir(p2, { recursive: true })
    await fsp.writeFile(join(p2, 'beta.md'), SAMPLE().replace('sample-memory', 'beta-memory').replace('type: project', 'type: user'), 'utf8')
    // 无 jsonl:cold-dir 无法定位原路径
  }

  it('按 cwd 分层导入 + 冷目录进用户层 + 幂等(重跑全 skip)', async () => {
    const home = join(base, 'home')
    await prepare(home)
    const scan = await scanClaudeMemory(home)
    const first = await runClaudeImport(store, scan, { allToUser: false })
    expect(first.imported).toBe(2)
    expect(first.skipped).toBe(0)
    // alpha 落项目层(文件名跟 name 字段走:sample-memory.md;目录名 = projectKey(cwd)),beta 落用户层
    const projectDir = join(join(base, 'memory-root'), projectKey('D:\\proj-one'))
    expect(await fsp.readFile(join(projectDir, 'sample-memory.md'), 'utf8')).toContain('样例记忆')
    expect(await fsp.readFile(join(join(base, 'memory-root'), '_user', 'beta-memory.md'), 'utf8')).toContain('beta')
    // 幂等
    const second = await runClaudeImport(store, await scanClaudeMemory(home), { allToUser: false })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(2)
  })

  it('allToUser:全部进用户层;时间戳保留(modified → created/updated)', async () => {
    const home = join(base, 'home2')
    await prepare(home)
    const scan = await scanClaudeMemory(home)
    const result = await runClaudeImport(store, scan, { allToUser: true })
    expect(result.imported).toBe(2)
    const userDir = join(join(base, 'memory-root'), '_user')
    const raw = await fsp.readFile(join(userDir, 'sample-memory.md'), 'utf8')
    expect(raw).toContain('created: ' + String(Date.parse('2026-09-01T00:00:00.000Z')))
  })

  it('安全层:源内容含密钥形态,落盘被脱敏', async () => {
    const home = join(base, 'home3')
    const dir = join(home, '.claude', 'projects', 'D--dirty', 'memory')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'dirty.md'), SAMPLE().replace('正文内容。', 'token 是 ghp_abcdefghijklmnopqrstuvwxyz012345'), 'utf8')
    const scan = await scanClaudeMemory(home)
    const result = await runClaudeImport(store, scan, { allToUser: true })
    expect(result.imported).toBe(1)
    const raw = await fsp.readFile(join(join(base, 'memory-root'), '_user', 'sample-memory.md'), 'utf8')
    expect(raw).not.toContain('ghp_abcdefghijklmnop')
    expect(raw).toContain('REDACTED')
  })

  it('slugs 过滤:只导入选中项目', async () => {
    const home = join(base, 'home4')
    await prepare(home)
    const scan = await scanClaudeMemory(home)
    const result = await runClaudeImport(store, scan, { slugs: ['d--cold-dir'], allToUser: false })
    expect(result.imported).toBe(1)
    expect(result.details[0]?.name).toBe('beta-memory')
  })

  it('failed 口径:scan 已判坏的文件不计数、不影响好文件(审查回归)', async () => {
    const home = join(base, 'home5')
    const dir = join(home, '.claude', 'projects', 'D--mixed', 'memory')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'good.md'), SAMPLE(), 'utf8')
    await fsp.writeFile(join(dir, 'broken.md'), 'no frontmatter at all', 'utf8') // scan 判 !ok
    const scan = await scanClaudeMemory(home)
    expect(scan.projects[0]?.importable).toBe(1)
    const result = await runClaudeImport(store, scan, { allToUser: true })
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(0) // 坏文件不在 importable 口径内,不计 failed
  })

  it('onlyIfAbsent 锁内判空:目标层已有同名 → skip 且不覆写原文(审查 TOCTOU 回归)', async () => {
    const home = join(base, 'home6')
    const dir = join(home, '.claude', 'projects', 'D--dup', 'memory')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'dup.md'), SAMPLE(), 'utf8')
    // 预置同名用户级记忆(内容不同)——锁内判空应拒绝覆盖
    await store.write({ name: 'sample-memory', description: '已有记忆,别碰', type: 'user', body: '原有正文' }, 'user')
    const scan = await scanClaudeMemory(home)
    const result = await runClaudeImport(store, scan, { allToUser: true })
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    const raw = await fsp.readFile(join(join(base, 'memory-root'), '_user', 'sample-memory.md'), 'utf8')
    expect(raw).toContain('原有正文') // 未被 Claude 版本覆盖
  })
})

describe('导入溯源与撤销(0.10.0)', () => {
  /** 造一个 Claude 项目目录:memory/*.md + 可选 session jsonl(cwd 反解源)。 */
  async function seed(home: string, slug: string, files: Array<[string, string]>, cwd?: string): Promise<void> {
    const dir = join(home, '.claude', 'projects', slug, 'memory')
    await fsp.mkdir(dir, { recursive: true })
    for (const [file, raw] of files) await fsp.writeFile(join(dir, file), raw, 'utf8')
    if (cwd !== undefined) {
      await fsp.writeFile(join(home, '.claude', 'projects', slug, 's.jsonl'), JSON.stringify({ cwd }), 'utf8')
    }
  }

  it('scan 返回逐条元数据;annotate 初始 pending,导入后 imported,frontmatter 带 origin', async () => {
    const home = join(base, 'rev-home1')
    await seed(home, 'D--p-one', [
      ['alpha.md', SAMPLE()],
      ['beta.md', SAMPLE().replace('sample-memory', 'beta-memory').replace('type: project', 'type: user')],
    ], 'D:\\p-one')
    const rawScan = await scanClaudeMemory(home)
    const alpha = rawScan.projects[0]?.files.find(f => f.file === 'alpha.md')
    expect(alpha).toMatchObject({ name: 'sample-memory', description: '样例记忆', type: 'project', ok: true })
    expect(alpha?.state).toBeUndefined() // scan 纯只读:状态由 annotate 补

    const scan = await annotateClaudeImport(store, rawScan)
    expect(scan.projects[0]?.files.map(f => f.state)).toEqual(['pending', 'pending'])
    const result = await runClaudeImport(store, scan, { allToUser: false })
    expect(result.imported).toBe(2)

    // 外部世界断言:落盘 frontmatter 真的带溯源块
    const raw = await fsp.readFile(join(join(base, 'memory-root'), projectKey('D:\\p-one'), 'sample-memory.md'), 'utf8')
    expect(raw).toContain('kind: claude-code')
    expect(raw).toContain('slug: D--p-one')
    expect(raw).toContain('file: alpha.md')
    expect(raw).toMatch(/hash: [0-9a-f]{16}/)

    const after = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(after.projects[0]?.files.map(f => f.state)).toEqual(['imported', 'imported'])
  })

  it('导入后修改内容 → modified;撤销保留、不删除;元数据变更(置顶)仍可撤销', async () => {
    const home = join(base, 'rev-home2')
    await seed(home, 'D--p-two', [['alpha.md', SAMPLE()]], 'D:\\p-two')
    const scan = await annotateClaudeImport(store, await scanClaudeMemory(home))
    await runClaudeImport(store, scan, { allToUser: false })
    const imported = await store.read('sample-memory', 'project', 'D:\\p-two')
    expect(imported?.origin).toBeDefined()

    // 仅元数据变更(正文原样):指纹仍匹配,状态保持 imported
    await store.write({
      name: 'sample-memory', description: imported!.description, type: imported!.type, body: imported!.body, pinned: true,
    }, 'project', 'D:\\p-two')
    const pinnedAnnotated = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(pinnedAnnotated.projects[0]?.files[0]?.state).toBe('imported')

    // 内容更新:状态转 modified,撤销时保留
    await store.write({
      name: 'sample-memory', description: imported!.description, type: imported!.type, body: '人工改写后的正文',
    }, 'project', 'D:\\p-two')
    const modifiedAnnotated = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(modifiedAnnotated.projects[0]?.files[0]?.state).toBe('modified')
    const revocation = await revokeClaudeImports(store, modifiedAnnotated, [{ slug: 'D--p-two', file: 'alpha.md' }])
    expect(revocation.revoked).toBe(0)
    expect(revocation.modified).toBe(1)
    expect((await store.read('sample-memory', 'project', 'D:\\p-two'))?.body).toContain('人工改写后的正文')
  })

  it('同名但不是从该源文件导入 → conflict,导入跳过', async () => {
    const home = join(base, 'rev-home3')
    await seed(home, 'D--p-three', [['alpha.md', SAMPLE()]])
    await store.write({ name: 'sample-memory', description: '手工已有记忆', type: 'user', body: '原有正文' }, 'user')
    const scan = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(scan.projects[0]?.files[0]?.state).toBe('conflict')
    const result = await runClaudeImport(store, scan, { allToUser: true })
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    // 撤销一条 conflict 条目不会有任何删除动作
    const revocation = await revokeClaudeImports(store, scan, [{ slug: 'D--p-three', file: 'alpha.md' }])
    expect(revocation.revoked).toBe(0)
    expect((await store.read('sample-memory', 'user'))?.body).toBe('原有正文')
  })

  it('撤销跨层:项目层与 allToUser 用户层的导入都能按来源找到并删除', async () => {
    const home = join(base, 'rev-home4')
    await seed(home, 'D--p-four', [
      ['alpha.md', SAMPLE()],
      ['beta.md', SAMPLE().replace('sample-memory', 'beta-memory')],
    ], 'D:\\p-four')
    const scan = await annotateClaudeImport(store, await scanClaudeMemory(home))
    // 条目级过滤:先只导入 alpha(项目层),beta 不在本次选择内
    const first = await runClaudeImport(store, scan, { files: [{ slug: 'D--p-four', file: 'alpha.md' }], allToUser: false })
    expect(first.imported).toBe(1)
    expect(await store.read('beta-memory', 'user')).toBeNull()
    // beta 强制进用户层
    await runClaudeImport(store, scan, { files: [{ slug: 'D--p-four', file: 'beta.md' }], allToUser: true })

    const annotated = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(annotated.projects[0]?.files.map(f => f.state)).toEqual(['imported', 'imported'])
    const revocation = await revokeClaudeImports(store, annotated, [
      { slug: 'D--p-four', file: 'alpha.md' },
      { slug: 'D--p-four', file: 'beta.md' },
    ])
    expect(revocation.revoked).toBe(2)
    expect(await store.read('sample-memory', 'project', 'D:\\p-four')).toBeNull()
    expect(await store.read('beta-memory', 'user')).toBeNull()
    // 删空后索引文件也移除(不留幽灵索引)
    const index = await fsp.readFile(join(join(base, 'memory-root'), projectKey('D:\\p-four'), 'MEMORY.md'), 'utf8').catch(() => '')
    expect(index).not.toContain('sample-memory')
  })

  it('撤销不存在的目标计入 missing;找不到源项目同样 missing', async () => {
    const home = join(base, 'rev-home5')
    await seed(home, 'D--p-five', [['alpha.md', SAMPLE()]])
    const scan = await annotateClaudeImport(store, await scanClaudeMemory(home))
    const revocation = await revokeClaudeImports(store, scan, [
      { slug: 'D--p-five', file: 'alpha.md' }, // 未导入过
      { slug: 'no-such-project', file: 'x.md' },
    ])
    expect(revocation.missing).toBe(2)
    expect(revocation.revoked).toBe(0)
  })

  it('0.8.0 旧导入(无 origin)内容一致 → legacy 可撤销;内容不同 → conflict 保留', async () => {
    const home = join(base, 'rev-home6')
    await seed(home, 'D--p-six', [['alpha.md', SAMPLE()]], 'D:\\p-six')
    // 模拟 0.8.0 导入产物:同名、同类型、同正文,但没有 origin 块
    await store.write({
      name: 'sample-memory', description: '样例记忆', type: 'project', body: '# 标题行\n\n正文内容。',
    }, 'project', 'D:\\p-six')
    const scan = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(scan.projects[0]?.files[0]?.state).toBe('legacy')
    const revocation = await revokeClaudeImports(store, scan, [{ slug: 'D--p-six', file: 'alpha.md' }])
    expect(revocation.revoked).toBe(1)
    expect(await store.read('sample-memory', 'project', 'D:\\p-six')).toBeNull()

    // 同名但内容不同(本地自写记忆):conflict,撤销绝不误删
    await store.write({
      name: 'sample-memory', description: '本地记忆', type: 'user', body: '本地正文',
    }, 'project', 'D:\\p-six')
    const scan2 = await annotateClaudeImport(store, await scanClaudeMemory(home))
    expect(scan2.projects[0]?.files[0]?.state).toBe('conflict')
    const revocation2 = await revokeClaudeImports(store, scan2, [{ slug: 'D--p-six', file: 'alpha.md' }])
    expect(revocation2.revoked).toBe(0)
    expect(revocation2.missing).toBe(1)
    expect((await store.read('sample-memory', 'project', 'D:\\p-six'))?.body).toBe('本地正文')
  })
})
