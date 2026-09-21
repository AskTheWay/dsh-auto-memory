/**
 * 存储层纯逻辑测试:不依赖任何 dsh 包,全平台可跑(vitest)。
 * 外部世界断言原则(docs/testing 规则):重新读磁盘文件,不查对象内部状态。
 * 含对抗性审查确认问题的回归:保留字 memory、中文 name 坏文件不砖存储、
 * 孤儿锁自愈、删空移除索引、排序稳定、title 渲染。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MemoryStore, INDEX_FILENAME, normalizeName, parseMemory, projectKey, serializeMemory, renderIndexBody,
} from '../src/store.ts'
import type { MemoryRecord } from '../src/types.ts'

const CWD = 'D:\\work\\my project'

let root: string
let store: MemoryStore

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'dsh-auto-memory-'))
  store = new MemoryStore(root)
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('projectKey', () => {
  it('Windows 路径转成官方 slug 形式', () => {
    expect(projectKey('D:\\work\\proj')).toBe('--D-work-proj--')
  })
  it('POSIX 路径同样折叠分隔符', () => {
    expect(projectKey('/home/u/a')).toBe('--home-u-a--')
  })
  it('连续分隔符合并为一个连字符', () => {
    expect(projectKey('a//b')).toBe('--a-b--')
  })
  it('非安全字符转 ~HEX 转义', () => {
    expect(projectKey('a b')).toBe(`--a~0020b--`)
  })
  it('空路径抛错', () => {
    expect(() => projectKey('')).toThrow()
  })
})

describe('normalizeName', () => {
  it('保留合法 kebab-case', () => {
    expect(normalizeName('user-prefers-python')).toBe('user-prefers-python')
  })
  it('大写与空格折叠', () => {
    expect(normalizeName('My Preference')).toBe('my-preference')
  })
  it('非法字符折叠为连字符', () => {
    expect(normalizeName('foo_bar!baz')).toBe('foo-bar-baz')
  })
  it('纯中文(无法归一化)抛错', () => {
    expect(() => normalizeName('中文记忆')).toThrow(/kebab-case/)
  })
  it('保留字 memory 抛错(大小写不敏感文件系统上与 MEMORY.md 撞名,审查 blocker 回归)', () => {
    expect(() => normalizeName('memory')).toThrow(/reserved/)
    expect(() => normalizeName('Memory')).toThrow(/reserved/)
  })
})

describe('frontmatter 往返', () => {
  it('序列化→解析 无损往返(含可选 title)', () => {
    const record: Omit<MemoryRecord, 'scope'> = {
      name: 'user-prefers-python',
      title: '用户偏好 Python',
      description: '用户是 Python 后端工程师: 面试准备中',
      type: 'user',
      body: '正文事实,含 [[id-generator-benchmark]] 链接。',
    }
    const parsed = parseMemory(serializeMemory(record), 'user')
    expect(parsed).toEqual({ ...record, scope: 'user' })
  })
  it('无 title 的旧文件仍可解析', () => {
    const parsed = parseMemory(serializeMemory({ name: 'a', description: 'd', type: 'user', body: 'b' }), 'project')
    expect(parsed?.title).toBeUndefined()
  })
  it('description 含冒号与引号不破坏 yaml', () => {
    const record: Omit<MemoryRecord, 'scope'> = {
      name: 'x', description: 'key: "value" with: colons', type: 'reference', body: 'b',
    }
    expect(parseMemory(serializeMemory(record), 'project')?.description).toBe(record.description)
  })
  it('CRLF 容忍', () => {
    const raw = serializeMemory({ name: 'a', description: 'd', type: 'user', body: 'b' }).replace(/\n/g, '\r\n')
    expect(parseMemory(raw, 'project')?.name).toBe('a')
  })
  it('无 frontmatter 返回 null', () => {
    expect(parseMemory('just body', 'project')).toBeNull()
  })
  it('缺 name 返回 null', () => {
    expect(parseMemory('---\ndescription: d\n---\n\nbody', 'project')).toBeNull()
  })
  it('非法 type 返回 null', () => {
    expect(parseMemory('---\nname: a\ndescription: d\ntype: bogus\n---\n\nbody', 'project')).toBeNull()
  })
  it('不可归一化的中文 name 返回 null 而非抛错(审查 major 回归:坏文件不砖存储)', () => {
    expect(parseMemory('---\nname: 中文标题\ndescription: d\n---\n\nbody', 'project')).toBeNull()
  })
})

describe('MemoryStore CRUD 与索引', () => {
  it('write 后 MEMORY.md 出现索引行(无独立标题行,按 name 排序)', async () => {
    await store.write({ name: 'b-second', description: '第二条', type: 'user', body: 'y' }, 'project', CWD)
    await store.write({ name: 'a-first', description: '第一条', type: 'user', body: 'x' }, 'project', CWD)
    const index = await fsp.readFile(join(root, projectKey(CWD), INDEX_FILENAME), 'utf8')
    const lines = index.split('\n').filter(l => l.startsWith('- '))
    expect(lines).toEqual([
      '- [a-first](a-first.md) — 第一条',
      '- [b-second](b-second.md) — 第二条',
    ])
  })

  it('title 出现在索引行链接文本', async () => {
    await store.write({ name: 'a', title: '用户偏好中文交流', description: 'd', type: 'user', body: 'x' }, 'project', CWD)
    const index = await fsp.readFile(join(root, projectKey(CWD), INDEX_FILENAME), 'utf8')
    expect(index).toContain('- [用户偏好中文交流](a.md) — d')
  })

  it('同名 write 覆盖而非新建(update 语义)', async () => {
    await store.write({ name: 'a', description: '旧', type: 'user', body: 'x' }, 'project', CWD)
    await store.write({ name: 'a', description: '新', type: 'user', body: 'y' }, 'project', CWD)
    const records = await store.list('project', CWD)
    expect(records).toHaveLength(1)
    expect(records[0]?.description).toBe('新')
    expect((await store.read('a', 'project', CWD))?.body).toBe('y')
  })

  it('read 不存在返回 null;findIn 用户级优先', async () => {
    expect(await store.read('nope', 'project', CWD)).toBeNull()
    await store.write({ name: 'm', description: '用户级', type: 'user', body: 'u' }, 'user')
    await store.write({ name: 'm', description: '项目级', type: 'user', body: 'p' }, 'project', CWD)
    expect((await store.findIn('m', ['user', 'project'], CWD))?.scope).toBe('user')
  })

  it('delete 移除文件与索引行;删空后 MEMORY.md 文件消失(无占位残留)', async () => {
    await store.write({ name: 'gone', description: '待删', type: 'project', body: 'x' }, 'project', CWD)
    expect(await store.delete('gone', 'project', CWD)).toBe(true)
    const dir = join(root, projectKey(CWD))
    await expect(fsp.readFile(join(dir, INDEX_FILENAME), 'utf8')).rejects.toThrow(/ENOENT/)
    expect(store.readIndexSync('project', CWD)).toBeNull()
    expect(await store.delete('gone', 'project', CWD)).toBe(false)
  })

  it('目录不存在时 delete 返回 false 而非抛错', async () => {
    expect(await store.delete('anything', 'project', CWD)).toBe(false)
    expect(await store.delete('anything', 'user')).toBe(false)
  })

  it('list 跳过畸形文件与 MEMORY.md 本身(坏文件不砖存储,审查 major 回归)', async () => {
    const dir = join(root, projectKey(CWD))
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'broken.md'), 'no frontmatter at all', 'utf8')
    await fsp.writeFile(join(dir, 'chinese-name.md'), '---\nname: 中文\ndescription: d\n---\n\nbody', 'utf8')
    await store.write({ name: 'ok', description: '正常', type: 'user', body: 'x' }, 'project', CWD)
    const records = await store.list('project', CWD)
    expect(records.map(r => r.name)).toEqual(['ok'])
  })

  it('project 作用域缺少 cwd 时抛错(不静默回退 process.cwd())', () => {
    expect(() => store.dir('project')).toThrow(/session cwd/)
  })

  it('readIndexSync:无索引返回 null;写入后可读', async () => {
    expect(store.readIndexSync('project', CWD)).toBeNull()
    await store.write({ name: 'a', description: 'd', type: 'user', body: 'x' }, 'project', CWD)
    expect(store.readIndexSync('project', CWD)).toContain('- [a](a.md)')
  })

  it('并发写不同记忆:两条都落盘且索引完整(文件锁串行化)', async () => {
    await Promise.all([
      store.write({ name: 'one', description: '第一条', type: 'user', body: 'x' }, 'project', CWD),
      store.write({ name: 'two', description: '第二条', type: 'user', body: 'y' }, 'project', CWD),
    ])
    const records = await store.list('project', CWD)
    expect(new Set(records.map(r => r.name))).toEqual(new Set(['one', 'two']))
    expect(store.readIndexSync('project', CWD)).toContain('one')
    expect(store.readIndexSync('project', CWD)).toContain('two')
  })

  it('孤儿锁自愈:残留死进程 pid 的 .lock 不砖写入(审查 major 回归)', async () => {
    const dir = join(root, projectKey(CWD))
    await fsp.mkdir(dir, { recursive: true })
    // 伪造官方锁格式:内容为持有进程 pid;99999999 大概率不存在
    await fsp.writeFile(join(dir, `${INDEX_FILENAME}.lock`), '99999999\n', { flag: 'wx' })
    await store.write({ name: 'after-orphan', description: 'd', type: 'user', body: 'x' }, 'project', CWD)
    expect(await store.read('after-orphan', 'project', CWD)).not.toBeNull()
    // 操作完成后锁被释放
    await expect(fsp.stat(join(dir, `${INDEX_FILENAME}.lock`))).rejects.toThrow(/ENOENT/)
  })

  it('用户级与项目级目录隔离', async () => {
    await store.write({ name: 'shared', description: 'u', type: 'user', body: 'x' }, 'user')
    await store.write({ name: 'local', description: 'p', type: 'user', body: 'x' }, 'project', CWD)
    expect((await store.list('user')).map(r => r.name)).toEqual(['shared'])
    expect((await store.list('project', CWD)).map(r => r.name)).toEqual(['local'])
  })
})

describe('renderIndexBody', () => {
  it('空列表返回空串(注入层据此省略整段);非空一行一条', () => {
    expect(renderIndexBody([])).toBe('')
    const text = renderIndexBody([
      { name: 'a', description: 'A', type: 'user', body: '', scope: 'user' },
    ])
    expect(text).toBe('- [a](a.md) — A\n')
    expect(text).not.toContain('#')
  })
})
