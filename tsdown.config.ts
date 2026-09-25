import { defineConfig } from 'tsdown'

// 基线模块表(浏览器模块表 PLATFORM_MODULES):必须保持 external。
const BASELINE = (id: string): boolean =>
  id === 'react' || id.startsWith('react/')
  || id === '@deepseek-ai/cordis' || id.startsWith('@deepseek-ai/cordis/')
  || id === '@deepseek-ai/dsh-client-store' || id.startsWith('@deepseek-ai/dsh-client-store/')
  || id === '@deepseek-ai/dsh-client-ui-slots' || id.startsWith('@deepseek-ai/dsh-client-ui-slots/')
  || id === '@deepseek-ai/dsh-client-ui-primitives' || id.startsWith('@deepseek-ai/dsh-client-ui-primitives/')
  || id === '@deepseek-ai/dsh-client-ui-dockkit' || id.startsWith('@deepseek-ai/dsh-client-ui-dockkit/')

export default [
  // ---------- 宿主半(Node)----------
  defineConfig({
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    // 产物扩展名与 package.json(main/exports 的 lib/index.js)保持一致
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  }),
  // ---------- 浏览器半 ----------
  // dsh 前端的插件加载协议要求 client bundle 为 CJS 闭包工厂:
  // window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
  // 官方 preset(packages/client/tsdown.client.ts)未发布,此处手写等价包装。
  defineConfig({
    name: 'dsh-auto-memory/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: true,
    clean: false, // 不能清掉宿主半产物
    deps: {
      neverBundle: BASELINE,
      alwaysBundle: (id) => !BASELINE(id),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: (chunk) =>
        `window.__ModuleLoader__.load({ id: "dsh-auto-memory", ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  }),
]
