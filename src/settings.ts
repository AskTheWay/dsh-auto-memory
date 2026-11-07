/**
 * 1.4.0:运行时设置(面板设置中心的后端)。
 *
 * 形态:$DSH_HOME/memory/settings.json 旁车文件存**用户覆盖**,合并于
 * profile 声明配置之上——不碰 dsh 的 settings 服务(demo profile 实测为
 * 内存态)、不要求用户编辑 cordis.patch.yml。注入侧参数(maxBytes)经
 * live 对象引用在下一个请求生效,无需重启。
 *
 * 纪律:
 * - 白名单字段 + 范围校验,畸形值静默忽略(与 parseMemory 同款 fail-safe);
 * - memoryDir 不可覆盖(改变记忆根=数据迁移,不属运行时设置);
 * - 原子写(writeFileAtomic,与 store 同纪律);并发写由 withLockRecovery
 *   串行化(设置写入极低频,复用 store 的锁实现避免新造轮子)。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { withLockRecovery } from './store.ts'

/** 设置文件名(记忆根目录下)。 */
export const SETTINGS_FILENAME = 'settings.json'

/** 可覆盖字段的白名单与范围(运行时设置;与 Config 字段同名)。 */
export const SETTABLE_FIELDS = {
  maxBytes: { kind: 'number', min: 1024, max: 65_536, step: 512 },
  minImportance: { kind: 'number', min: 0, max: 10, step: 1 },
  staleAfterDays: { kind: 'number', min: 0, max: 3650, step: 1 },
  autoSummarize: { kind: 'boolean' },
  autoSummarizeMaxMemories: { kind: 'number', min: 1, max: 20, step: 1 },
} as const

export type SettableField = keyof typeof SETTABLE_FIELDS
/** 用户覆盖的形状(全部可选;只存与 profile 不同的项也行,存了就生效)。 */
export type SettingsOverrides = Partial<Record<SettableField, number | boolean>>

/** 单字段校验:类型与范围都合法才收;畸形静默丢弃。 */
function validateField(field: SettableField, value: unknown): number | boolean | undefined {
  const spec = SETTABLE_FIELDS[field]
  if (spec.kind === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < spec.min || value > spec.max) return undefined
  return value
}

/** 解析+逐字段校验(坏字段丢弃);供 loadSettings 与锁内读共用。 */
async function readOverrides(file: string): Promise<SettingsOverrides> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: SettingsOverrides = {}
  for (const key of Object.keys(SETTABLE_FIELDS) as SettableField[]) {
    const value = validateField(key, (parsed as Record<string, unknown>)[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 读取覆盖快照(文件缺失/畸形 → 空;逐字段校验,坏字段丢弃)。 */
export async function loadSettings(rootDir: string): Promise<SettingsOverrides> {
  return readOverrides(join(rootDir, SETTINGS_FILENAME))
}

/** 持久化覆盖(锁内原子写;整文件重写,空对象也落盘=回到 profile 默认)。 */
export async function saveSettings(rootDir: string, overrides: SettingsOverrides): Promise<void> {
  const file = join(rootDir, SETTINGS_FILENAME)
  await withLockRecovery(file, async () => {
    await fsp.mkdir(rootDir, { recursive: true })
    await writeFileAtomic(file, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 })
  })
}

/**
 * 应用一次覆盖写入:校验入参 → 合并现文件 → 落盘 → 返回合并后的完整覆盖。
 * 入参整体非法字段会被逐个丢弃(不 400——设置面板允许部分成功),但若
 * 全部字段非法则原样返回现文件(无操作)。
 * 值为 null = 显式重置:删除该字段覆盖,回 profile 默认(设置中心"↺"按钮)。
 * 1.4.0 修复(审查 minor):读-改-写整体进锁——此前 load 在锁外,并发
 * config.set 各自读到旧文件后写回,后写覆盖先写丢更新(20/20 复现)。
 */
export async function applySettings(rootDir: string, patch: Record<string, unknown>): Promise<SettingsOverrides> {
  const file = join(rootDir, SETTINGS_FILENAME)
  return withLockRecovery(file, async () => {
    const next = await readOverrides(file)
    for (const key of Object.keys(SETTABLE_FIELDS) as SettableField[]) {
      if (patch[key] === null) { delete next[key]; continue }
      const value = validateField(key, patch[key])
      if (value !== undefined) next[key] = value as number | boolean
    }
    await fsp.mkdir(rootDir, { recursive: true })
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    return next
  })
}
