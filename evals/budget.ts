import { DEFAULT_MAX_BYTES } from '../src/budget.ts'

/** 用不同文件名保留历史样本，避免 16 KiB 的跑次覆盖原 4 KiB 结果。 */
export function evaluationBudget(mode = 'product'): { mode: string; bytes: number; suffix: string } {
  const bytes = mode === 'product' ? DEFAULT_MAX_BYTES : mode === 'legacy-4k' ? 4096 : mode === 'capacity' ? 262_144 : undefined
  if (bytes === undefined) throw new Error(`Unknown budget mode ${JSON.stringify(mode)}. Use product, legacy-4k, or capacity.`)
  return { mode, bytes, suffix: mode === 'product' ? `product-${bytes}` : mode }
}
