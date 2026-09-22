# dsh-auto-memory

[English](README.md) | [中文](README.zh.md)

**Claude Code-style auto-memory, as a native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.**

A typed persistent-memory layer for dsh agents: memory files with frontmatter,
a `MEMORY.md` index auto-injected into the system prompt, and four model-facing
tools — lightweight, file-only, zero external services, no embeddings required.

## Why

dsh itself has **no memory subsystem**. The official answer to memory is three
*default-off* MCP bridge configs to third-party servers (Memorix, MCP Reference
Memory, Engram) — which the official docs themselves qualify: not auto-injected
(the model must choose to call a tool), no summarization, no conflict
resolution, no forgetting.

`dsh-auto-memory` closes that gap natively:

| Capability | MCP bridge approach | dsh-auto-memory |
|---|---|---|
| Index auto-injected into every system prompt | ✗ | ✓ (zero footprint when empty) |
| Typed memories (user / feedback / project / reference) | ✗ | ✓ |
| Workspace-scoped + user-scoped layers, no cross-project leakage | ✗ | ✓ (scope flag enforced on every tool path) |
| Crash/concurrency safety (cross-process file locks + orphan-lock recovery) | — | ✓ |
| Forgetting / eviction policy (P1) | ✗ | planned |
| Auto-consolidation on session end (P1) | ✗ | planned |

## Install

From a checkout (until the package is published to npm):

```sh
npm install && npm run build
dsh plugin --profile demo add /absolute/path/to/dsh-auto-memory
dsh --profile demo            # restart the profile to activate
```

Once published: `dsh plugin --profile demo add dsh-auto-memory`.

Requires `@deepseek-ai/dsh >= 0.1.5-rc.2` (Node `^22.19 || >=24`).

## Usage

Just tell the agent things worth remembering:

> "Remember: I'm a Python backend engineer, preparing for interviews, prefer Chinese."

The model calls `memory_write`. Next session, same workspace, the injected
index is already there — ask *"what do you know about me?"* and it recalls.

Tools: `memory_write` / `memory_read` / `memory_list` / `memory_delete`.
Write rules follow Claude Code: dedupe-and-update over piling up, never store
what the codebase or AGENTS.md already records, `feedback` memories carry
**Why:** / **How to apply:** lines, relative dates become absolute, bodies
cross-link with `[[name]]`.

## Where memories live

```
$DSH_HOME/memory/                  # defaults to ~/.dsh/memory
├── --<workspace-slug>--/          # project layer (slug derived from session cwd)
│   ├── MEMORY.md                  # the index (the only part injected)
│   └── one-file-per-memory.md     # frontmatter + body
└── _user/                         # user layer (shared across all workspaces)
```

Each memory is plain Markdown — hand-editable, grep-able, git-friendly:

```markdown
---
name: user-prefers-python
title: Backend engineer, prefers Python
description: Preparing for interviews; prefers Chinese
type: user
---

Facts… cross-link with [[other-memory]].
```

## How it works

- **Write path**: tool `execute` → name normalized to `[a-z0-9-]` (reserved
  names rejected) → cross-process file lock (official `dsh-atomic-write`) →
  atomic file write → full index rebuild. Orphaned locks from crashes are
  self-healed (stale-pid detection).
- **Inject path**: one dynamic system-prompt section (order 4000) re-evaluated
  on every step assembly; reads the index synchronously, enforces a byte
  budget, neutralizes literal `{{` (0.1.5 has no `interpolate` switch). Empty
  store → empty section → zero tokens.
- **Audit**: no custom session events (third-party event types make dsh
  sessions fail to resume); everything flows through standard `tool/call` /
  `tool/result`.

## Configuration

Override via your profile's `cordis.patch.yml` (config replaces wholesale —
restate every key):

```yaml
- id: auto-memory
  config:
    maxBytes: 4096          # injection budget (index + policy text)
    memoryDir: D:/memories  # default: $DSH_HOME/memory
    enableUserScope: true   # false: user layer off on every path
    autoSummarize: false    # P1 placeholder
```

## Design & research

- [docs/design.md](docs/design.md) — design decisions and trade-offs
- [docs/api-reports.md](docs/api-reports.md) — dsh source-level API research
  backing every implementation choice (including the traps this plugin avoids)

## Roadmap

- [x] P0: typed store + four tools + index injection + scoped layers + crash safety
- [ ] P1: auto-consolidation on session end, forgetting/eviction, recall expansion
- [ ] P2: Web UI memory cards, token-cost / recall-quality benchmarks

## Verification

```sh
npx vitest run          # 40 tests: store logic, braces regression, real Cordis stack
node scripts/demo.mjs   # key-less demo: write → index → injection → dedupe → empty
```

## License

MIT
