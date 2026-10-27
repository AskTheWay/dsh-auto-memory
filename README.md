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

The whole system surfaces in one panel: typed memories with trust badges and
evidence, injection statistics (which memories fired, per project, what got
budget-truncated), and the Claude Code import/export bridges.

![dsh-auto-memory panel: injection stats, trust badges, import/export](imgs/image-2.png)

---

## Highlights

**1.x — trustworthy memory + measured end-to-end**: consolidation products are
born `candidate` with verbatim evidence quotes; only *you* can grant
`verified`; disputed memories are never re-injected; every write passes an
injection-pattern guard at the store choke point. And it's measured: four
evaluation layers (deterministic / recall / consolidation / end-to-end) plus a
LongMemEval-S alignment run — including an honestly published off-target score.
Full history: [CHANGELOG.md](CHANGELOG.md) ·
[Releases](https://github.com/AskTheWay/dsh-auto-memory/releases)

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

### Trustworthy, not just persistent (1.0.0)

Model-consolidated memories can be confidently wrong — and a wrong memory
gets re-injected every session. So memories carry a **trust status**:
consolidation products are born `candidate` (with a verbatim evidence quote
from the transcript — fabricated citations are dropped by checking against
it), `verified` can only be granted by *you* in the panel, `disputed` /
`superseded` are never injected. Every write path passes an injection-pattern
guard at the store choke point; content changes downgrade trust and expire
old evidence. A `🩺` health board surfaces unverified / zombie / conflicting
memories for review. Same flat files, same zero services — now with an audit
trail for *whether to believe them*.

## One minute to feel it

```sh
node scripts/demo.mjs   # no API key, no browser: watch write → index → inject → recall → forget
```

Or for real, in a chat: tell your agent things worth remembering. The model
calls `memory_write` / `memory_read` / `memory_list` / `memory_search` /
`memory_delete`, following Claude Code's write discipline: **dedupe-and-update
over piling up**, absolute dates only, `[[name]]` cross-links, `feedback`
memories carry **Why:** / **How to apply:** lines.

## The memory panel

The whole memory system has one home in the dsh Web UI: user-scope and
project-scope groups, per-memory read counts and trust badges, pin / disable /
edit / delete, injection statistics (per memory and per project, with budget
truncation boards), the health board, and the Claude Code import/export
bridges — see the screenshot at the top.

## Import from Claude Code — and take it back

The panel's **📥 Import from Claude Code** button scans
`~/.claude/projects/*/memory` read-only and lists every memory grouped by source
project. Tick what you want and apply: fields map one-to-one (same four types,
H1 → title, ISO `modified` → epoch), same-name memories are skipped, never
overwritten.

Imported files carry an `origin` block (`kind` / `slug` / `file` / `imported` /
`hash`) in their frontmatter, so the checkbox becomes reversible: uncheck an
already-imported memory and apply, and it is deleted from this plugin — the
Claude Code source stays untouched and can be re-imported any time. If the
memory was edited after import, the content fingerprint no longer matches; the
entry is marked **modified** and kept, never silently discarded. Memories
imported by earlier versions (no `origin` block) are recognised by exact content
equality and marked **legacy import**, so they can be revoked the same way.

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

- **Injection cost is a flat line** — measured on the real render path
  (typical ~40-char descriptions, default 4 KB budget):

  | memories | 0 | 10 | 20 | 50 | 100 | 200 |
  |---|---|---|---|---|---|---|
  | injected section | **0 B** | 2.3 KB (~564 tok) | 3.2 KB (~801 tok) | 4.0 KB (~1008 tok) | 4.0 KB | 4.0 KB |

  The byte budget is a hard ceiling — from 50 memories on, the section is
  pinned at the cap no matter how many exist (oldest/lowest-ranked rows
  truncate with a marker). An empty store injects **0 bytes**: the whole
  section disappears.
- **Compaction-proof by construction**: the index rides in a *dynamic*
  system-prompt section re-evaluated on every step assembly — context
  compaction only compresses conversation history, so memories survive every
  compaction without re-injection tricks. Approaches that store memories as
  session-log messages lose theirs on the first compaction pass.
- **End-to-end lift measured** (L2, the layer above the pipeline): with the
  full consolidation → injection → QA loop, the model answers project-specific
  probe questions at **95.8% with memories vs 16.7% without — a +79.2 point
  net contribution** (standard dataset, 30 probes, blind LLM judge). An
  honest off-target data point is published too: on LongMemEval-S (122k-token
  chat-haystack needle-search, 30-question stratified subset, official judge
  protocol) the plugin scores 23.3% overall — quantifying exactly how far
  this coding-scenario design is from the chat-needle task, instead of
  cherry-picking benchmarks. [Results](evals/results/) ·
  [methodology](evals/README.md)
- **Eviction never misfires**: four-class mixed scenario — only
  stale-zero-read memories get hidden; zero files lost; one read revives.
- **Known limitation, pinned as baseline**: budget truncation is currently
  positional (index order), not relevance-ranked — probe retention under
  half-budget pressure drops to ~38%→10% as N grows. **Pinning fixes it for
  what matters**: pinned probes retain **≥80%** at the same budget (0.3.0);
  full relevance ranking remains on the roadmap.

This evaluation layer already caught a real bug: the byte budget used to
exclude the policy text, overshooting by ~800 bytes (fixed, regression-tested).

**Verified platform matrix** (manually tested, not just declared):

| | CLI | Desktop | Web profile |
|---|---|---|---|
| dsh version | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.1-rc.2 |
| status | ✓ tools/prompt/consolidation | ✓ panel + import + audit | ✓ panel + import |

**188 tests + four evaluation layers (L0 deterministic / L1 recall / L3 consolidation / L2 end-to-end + LongMemEval alignment). 0 runtime deps beyond `yaml`, ~35 kB installed.**

## Install

```sh
dsh plugin --profile demo add dsh-auto-memory   # from npm (prebuilt)
dsh --profile demo                               # restart the profile
```

From source: `npm install && npm run build && dsh plugin --profile demo add /abs/path`.
Requires `@deepseek-ai/dsh >= 0.1.5-rc.2` (Node `^22.19 || >=24`). Works with
the official desktop client — verified on 0.2.0-rc.2.

## Configuration

Override in your profile's `cordis.patch.yml` (config replaces wholesale):

```yaml
- id: auto-memory
  config:
    maxBytes: 4096          # injection budget (index + guidance + wrapper)
    memoryDir: D:/memories  # default: $DSH_HOME/memory
    enableUserScope: true   # false: user layer off on every path
    autoSummarize: false         # true: on root-session end, a background LLM files durable new facts
    autoSummarizeMaxMemories: 5  # cap per consolidation
    autoSummarizeMaxTokens: 2048 # consolidation output cap
    staleAfterDays: 0            # >0: soft-hide zero-read memories older than N days (files kept)
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
[postmortem: shipping a PR to awesome-dsh-plugin](docs/postmortem-pr-5696.md)

## Roadmap

- [x] P0 — typed store, four tools, prompt injection, scoped layers, crash safety
- [x] P1 — auto-consolidation on session end, forgetting & eviction, recall expansion, human-gated bulk delete
- [x] P2 — Web UI memory panel, token-cost / recall-quality benchmarks
- [x] P3 — update-replace semantics, matching core shared with the eval harness
- [x] 0.8–1.0 — Claude Code import bridge (revocable), injection audit + stats, trustworthy memory (status / evidence / guard / health)
- [x] 1.1–1.2 — L2 end-to-end + LongMemEval alignment, `memory_search`, import watcher, reverse AGENTS.md export
- [ ] L2 refinements (relevance-ranked truncation), community-driven work

## Changelog

Per-version notes: [CHANGELOG.md](CHANGELOG.md) ·
[GitHub Releases](https://github.com/AskTheWay/dsh-auto-memory/releases)

## License

MIT
