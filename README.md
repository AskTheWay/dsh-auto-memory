# dsh-auto-memory

[![CI](https://github.com/AskTheWay/dsh-auto-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/AskTheWay/dsh-auto-memory/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-auto-memory)](https://www.npmjs.com/package/dsh-auto-memory)
[![npm downloads](https://img.shields.io/npm/dm/dsh-auto-memory)](https://www.npmjs.com/package/dsh-auto-memory)
[![License: MIT](https://img.shields.io/npm/l/dsh-auto-memory)](LICENSE)
[![Node](https://img.shields.io/node/v/dsh-auto-memory)](package.json)

[English](README.md) | [中文](README.zh.md)

> ### Your dsh agent forgets everything you tell it. Every. Single. Session.
> **Fix it with one command.** Claude Code-style persistent memory for
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — native,
> zero servers, zero embeddings, zero setup.

```sh
dsh plugin --profile demo add dsh-auto-memory
```

Say *"Remember: I'm a Python backend engineer preparing for interviews"* today —
open a brand-new session tomorrow, ask *"what do you know about me?"*, and it
**remembers**.

---

## What's new in 0.3.0 (P2)

- **Pinned memories** (`pinned: true` on memory_write): pinned entries lead
  the index, survive budget truncation, and are exempt from staleness
  eviction — a trust anchor the user controls.
- **Eval-driven fix**: the injection budget now covers the *whole* section
  (index + guidance); it used to overshoot by ~800 bytes. Caught by the new
  deterministic evaluation layer on its first run.
- **Deterministic eval layer** ([evals/](evals/README.md)) in CI: injection
  budget curves, eviction zero-misfire, link-expansion bounds, and a
  signal-to-noise characterization — which pinned-priority truncation then
  improved from **38% → ≥80% probe retention** under half-budget pressure.
  Same budget, better memories.

## What's new in 0.2.0 (P1)

- **Auto-consolidation** (`autoSummarize: true`): when a root session ends, a
  background LLM pass extracts durable new facts from the session and files
  them as memories — deduplicated, capped, fully silent on failure. Claude
  Code doesn't do this automatically.
- **Forgetting & eviction**: every memory carries lifecycle metadata
  (created/updated/reads); `memory_read` counts references; `staleAfterDays`
  soft-hides zero-reference stale memories from the injected index (files
  kept); `memory_prune` lists (dry-run) or deletes aged memories.
- **Recall expansion**: `memory_read` resolves `[[name]]` cross-links one
  level and attaches linked summaries.
- `memory_delete_all` — guarded by `tools/pre-execute` **human approval**:
  the model cannot self-confirm irreversible bulk deletes.
- Hardened by a second adversarial review (11 agents): single-lock `clear`
  (no concurrent-write escape), conditional index rebuild on `touch`
  (no O(N) amplification), session-start stale refresh, subagent capture
  cleanup, abortable consolidation.

Tools: `memory_write` / `memory_read` / `memory_list` / `memory_delete` /
`memory_prune` / `memory_delete_all`.

## Claude Code has this. dsh didn't. Now it does.

DeepSeek Harness is the hottest open agent harness on GitHub right now —
models, tools, sandboxes, everything is a plugin. But it ships with **no memory
subsystem at all**. The official answer is three *default-off* MCP configs to
third-party servers, which the official docs themselves qualify: not
auto-injected, no forgetting policy, substring-only search. Your agent has
amnesia by design.

`dsh-auto-memory` closes that gap natively:

| | MCP bridge approach | **dsh-auto-memory** |
|---|---|---|
| Memories injected into **every** system prompt, automatically | ✗ | ✓ (zero tokens when empty) |
| Typed memories: user / feedback / project / reference | ✗ | ✓ |
| Workspace + user scope layers — no cross-project leakage | ✗ | ✓ |
| Crash & concurrency safety (cross-process locks, orphan recovery) | — | ✓ |
| External services / databases / embeddings required | ✓✓✓ | **none — just plain Markdown files** |

Memories are ordinary files under `$DSH_HOME/memory/` — hand-editable,
grep-able, git-friendly, yours.

## One minute to feel it

```sh
node scripts/demo.mjs   # no API key, no browser: watch write → index → inject → recall → forget
```

Or for real, in a chat: tell your agent things worth remembering. The model
calls `memory_write` / `memory_read` / `memory_list` / `memory_delete`,
following Claude Code's write discipline: **dedupe-and-update over piling up**,
absolute dates only, `[[name]]` cross-links, `feedback` memories carry
**Why:** / **How to apply:** lines.

## What the model actually sees

Every request, one system-prompt section (order 4000) carries the index —
re-evaluated per step, byte-budgeted, and **gone entirely when the store is
empty**:

```
# Persistent memory index
## Project memories
- [压测过 PostgreSQL](id-generator-benchmark.md) — psycopg2 连接池有踩坑经验 (2026-09)
- [用户是 Python 后端工程师](user-prefers-python.md) — 正在准备面试; 偏好中文交流
```

Chinese titles, YAML frontmatter, one file per memory — exactly the Claude
Code `MEMORY.md` model, rebuilt natively on dsh's prompt-assembly pipeline.

## Hardened before first release

This plugin survived a **12-agent adversarial code review** (680k tokens of
source-level scrutiny) before v0.1.0. Five production-grade traps were caught
and fixed — with regression tests — including two that would have been
field incidents:

- **The NTFS silent destroyer**: a memory named `memory` collides with
  `MEMORY.md` on case-insensitive filesystems — the write *succeeds* while
  destroying the record. Blocked by a reserved-name guard.
- **The poisoned-prompt bomb**: three literal `{{{ }}}` braces in any memory
  could crash *every* model request in the workspace — with no way for the
  model to self-recover. Neutralized by a converging sanitizer.

Plus: orphaned-lock self-healing (Ctrl+C can't brick your memory store),
symlink-read protection, malformed-file tolerance, stable index ordering to
protect KV-prefix caches, and a strict no-custom-session-events policy (they
make dsh sessions refuse to resume).

## Measured, not just claimed

A deterministic evaluation layer ([evals/](evals/README.md)) runs in CI —
no LLM, fully reproducible:

- **Injection budget holds at any scale**: 20/50/100/200 memories → the
  injected section stays ≤ 4 KB (4065/4048/4018/3940 bytes measured), with
  truncation markers; empty store injects **0 bytes**.
- **Eviction never misfires**: four-class mixed scenario — only
  stale-zero-read memories get hidden; zero files lost; one read revives.
- **Known limitation, pinned as baseline**: budget truncation is currently
  positional (index order), not relevance-ranked — probe retention under
  half-budget pressure drops to ~38%→10% as N grows. **Pinning fixes it for
  what matters**: pinned probes retain **≥80%** at the same budget (0.3.0);
  full relevance ranking remains on the roadmap.

This evaluation layer already caught a real bug: the byte budget used to
exclude the policy text, overshooting by ~800 bytes (fixed, regression-tested).

**78 tests (incl. a deterministic eval layer). 0 runtime deps beyond `yaml`. 15 kB installed.**

## Install

```sh
dsh plugin --profile demo add dsh-auto-memory   # from npm (prebuilt)
dsh --profile demo                               # restart the profile
```

From source: `npm install && npm run build && dsh plugin --profile demo add /abs/path`.
Requires `@deepseek-ai/dsh >= 0.1.5-rc.2` (Node `^22.19 || >=24`).

## Configuration

Override in your profile's `cordis.patch.yml` (config replaces wholesale):

```yaml
- id: auto-memory
  config:
    maxBytes: 4096          # injection budget
    memoryDir: D:/memories  # default: $DSH_HOME/memory
    enableUserScope: true   # false: user layer off on every path
```

## How it works (60 seconds)

- **Write**: tool `execute` → name normalized to `[a-z0-9-]` (reserved names
  rejected) → cross-process file lock (official `dsh-atomic-write`) → atomic
  write → full index rebuild inside the lock.
- **Inject**: one dynamic section re-evaluated on every step assembly; reads
  the index synchronously, enforces the byte budget, neutralizes `{{`.
  Tool writes take effect on the **very next request** — no restart, ever.
- **Audit**: no custom session events (third-party types make dsh refuse to
  resume); everything flows through standard `tool/call` / `tool/result`.

Deep dives: [design decisions](docs/design.md) ·
[dsh source-level research](docs/api-reports.md) ·
[postmortem: shipping a PR to awesome-dsh-plugin](docs/postmortem-pr-5696.md)

## Roadmap

- [x] P0 — typed store, four tools, prompt injection, scoped layers, crash safety
- [x] P1 — auto-consolidation on session end, forgetting & eviction, recall expansion, human-gated bulk delete
- [ ] P2 — Web UI memory cards, token-cost / recall-quality benchmarks

## License

MIT
