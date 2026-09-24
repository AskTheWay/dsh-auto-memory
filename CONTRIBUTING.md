# Contributing

Thanks for your interest in improving dsh-auto-memory!

## Project map

```
src/
  index.ts        Plugin entry: name / inject / Config (schemastery) / apply
  store.ts        File-backed store: frontmatter, lifecycle meta, locking, index
  tools.ts        Model-facing tools (memory_write/read/list/delete/prune/delete_all)
  prompt.ts       System-prompt injection (single dynamic section, order 4000)
  consolidate.ts  P1 auto-consolidation (session capture → agent/disposed → LLM)
  types.ts        Core types (MemoryRecord, MemoryType, MemoryScope)
tests/            vitest: store logic, consolidation pure functions, real-stack integration
docs/             design.md (decisions) · api-reports.md (dsh source research)
                  postmortem-pr-5696.md (shipping war stories)
scripts/demo.mjs  Key-less demo: write → index → inject → dedupe → forget
```

## Development

```sh
npm install
npm run build        # tsdown → lib/ (Node half only)
npm test             # vitest run
npx tsc --noEmit     # strict type check
node scripts/demo.mjs
```

Requirements: Node `^22.19 || >=24`, target runtime `@deepseek-ai/dsh >= 0.1.5-rc.2`.
Local tryout: `npm run build && dsh plugin --profile demo add /abs/path/to/dsh-auto-memory`.

## Before you open a PR

- `npx tsc --noEmit`, `npm test`, and `npm run build` all pass.
- New behavior comes with tests (store changes: real-file assertions; tool changes:
  schema + integration; consolidation: pure-function tests).
- Commit style: `type: summary` (`feat:` / `fix:` / `docs:` / `chore:`), any language.
- One PR per concern; keep the diff reviewable.

## Hard constraints (learned the hard way — see docs/postmortem-pr-5696.md)

1. **No custom session event types** — third-party event types make dsh refuse to
   resume the session log. Audit flows through standard `tool/call` / `tool/result`.
2. **All writes go through the store's file lock** (`withFileLock` on the scope's
   `MEMORY.md`) and `writeFileAtomic`. Never write memory files directly.
3. **Memory names are normalized to `[a-z0-9-]`** (reserved name `memory` rejected);
   treat every model-supplied string as untrusted (see sanitizeCandidate).
4. **No default export** from the plugin entry (the dsh Loader collapses it and
   drops `inject`).
5. **`@deepseek-ai/*` framework packages stay in peerDependencies** — a second
   bundled instance breaks Cordis declaration merging.
6. **The injected prompt text must survive strict interpolation** (no bare `{{`
   reaches the section text — `neutralizeBraces` handles it until peer
   `>=0.1.6`'s `interpolate: false` lands).

## Design references

- [docs/design.md](docs/design.md) — architecture decisions and trade-offs
- [docs/api-reports.md](docs/api-reports.md) — dsh source-level research backing
  every integration choice
- dsh plugin docs: [user/develop](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs/user/develop)
