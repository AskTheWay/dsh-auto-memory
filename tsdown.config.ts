import { defineConfig } from 'tsdown'

// 独立仓库最薄构建:直接转译 src/,不做 monorepo 项目引用。
// (官方 publish 文档明示的独立插件构建方式)
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  // 产物扩展名与 package.json(main/exports 的 lib/index.js)保持一致
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
