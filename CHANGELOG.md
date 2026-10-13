# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions adhere to
[Semantic Versioning](https://semver.org/). Release notes per tag also live on
the [GitHub Releases](https://github.com/AskTheWay/dsh-auto-memory/releases)
page (generated from this file at publish time).

## [0.7.2] - 2026-10-14

### Added

- **Consolidation now sees the workspace instruction chain**: before the
  end-of-session LLM pass, the plugin discovers AGENTS.md/CLAUDE.md files by
  the same rules as the official `dsh-agent-instructions` layer (user-global
  `$DSH_HOME/AGENTS.md` → project root (`.git` marker) → session cwd, `.local`
  overlays, same-directory trimmed-duplicate dedup) and feeds a bounded digest
  (≤ 2 KB) into the consolidation prompt. Facts already recorded in
  instruction files are no longer re-consolidated as memories — enforcing the
  "hand-written constraints live in AGENTS.md, model-managed facts live in
  memory, one fact in exactly one place" split. Read failures degrade
  silently to no-digest; consolidation is never affected.
- Injection policy gains the matching rule (stable constraints belong in the
  injected instruction chain, never duplicated into memories).

### Fixed

- Hardened by an adversarial review (8 agents, findings verified by
  reproduction): literal `</workspace-instructions>` in instruction content is
  escaped so repository-controlled text cannot close the plugin-owned prompt
  frame and smuggle top-level directives into persistent memories (mirrors
  upstream `escapeInstructionFrameBody` and this repo's `stripMemoryTags`
  discipline); project-root discovery is fully async (no event-loop blocking
  on UNC shares or offline mapped drives); files over 1 MB are skipped whole
  (upstream `maxSourceBytes` semantics — no unbounded read before
  truncation); empty instruction files no longer consume digest budget.

## [0.7.1] - 2026-10-10

### Fixed

- Panel **mute toggle had no effect**: the write route only forwarded
  `disabled: true`, so "un-mute" was silently dropped and the inherited flag
  stuck forever. The flag is now forwarded both ways; action failures surface
  inline on the page instead of vanishing into the console.

### Changed

- Panel list state encoding: muted rows get a grey bar with a dimmed
  background, pinned rows an amber bar, active rows their type color — plus
  explicit `● active` / `⊘ muted` badges. Which memories will be injected is
  now readable at a glance.

## [0.7.0] - 2026-10-09

### Added

- **Update-replace semantics**: consolidation no longer lets new and old
  versions of the same fact coexist. A name-anchored matcher (prefix-tolerant
  token coverage, order-insensitive — `ignore-err-x` matches `err-x-ignore`)
  plus description-echo matching routes matched candidates to an in-place
  UPDATE (reusing the existing name/scope and lifecycle) instead of skipping
  or duplicating. The consolidation prompt also instructs the model to reuse
  the existing name when updating.
- `src/matching.ts` — the matching core shared by product and eval harness:
  the L3-validated mapping (name anchoring ∪ CJK-bigram coverage) is now a
  single implementation point. Evaluation methodology feeding back into
  product, round three.
- New L3 metric **duplicates** (gold facts still covered by >1 produced
  memory): mini 0 (was 1); standard 26→25 products with 2 remaining; mini
  precision 70→87.5%. Standard recall measured 75% in this single run —
  recorded honestly, run-to-run variance not yet measured.

### Changed

- Panel UX pass: overview header (totals + pinned/muted + budget bar),
  colored type badges (user/feedback/project/reference), search filter,
  relative timestamps, icon actions (✏️📌🔇🗑), empty-state 3-step onboarding,
  per-group summary lines, current-workspace badge.

## [0.6.1] - 2026-10-08

### Fixed

- **dsh 0.2.x compatibility** (first external contribution, #4 by @hh-wu):
  injected messages now use the producer-owned `source kind` (v4 shape).

### Changed

- Peer ranges relaxed: `@deepseek-ai/*` peers `<0.3.0`, cordis
  `>=4.0.2 <5.0.0` (the old `^4.0.2` mis-flagged `4.0.5-alpha.1`).
  Verified against the official desktop client 0.2.0-rc.2.

## [0.6.0] - 2026-10-07

### Added

- **harness-sessions evaluation datasets** (`evals/datasets/`): synthetic
  multi-session developer transcripts with gold-labeled facts
  (durable / ephemeral-trap / updated, evidence sessions, abstention probes) —
  the coding-agent memory scenario no public benchmark covers.
- **L1 injection recall** (zero-API runner): 100% on both datasets at the
  perfect-consolidation ceiling — the injection side loses nothing.
- **L3 consolidation quality** (one LLM call per session, same code path as
  the plugin): mini recall 100% / update-correctness 100% / pollution 0%;
  standard recall 83.3% / precision 84.6% / update-correctness 100% /
  pollution 0% (deepseek-chat, temperature 0). Ephemeral traps refused in
  every run.
- **Soft-mute** — a third state between keep and delete (muted memories stay
  on disk but are never injected) (#15).

### Fixed

- Consolidation now writes title/description in the transcript's language
  (Chinese transcripts used to produce English memories — measured, then
  fixed). Surfaced by the new eval.
- Panel resolves the current workspace from the running/most-recent session
  (#14).

## [0.5.2] - 2026-10-06

### Fixed

- CJK bigram tokenization for description similarity (#6) — Chinese echo
  dedup used to miss near-identical descriptions.
- Panel editor: buttons disabled while busy; action failures surfaced inline
  instead of dying as unhandled rejections (#12).
- GB11643 checksum validated before redacting 18-digit strings (#13) —
  ordinary 18-digit numbers (order IDs) are no longer eaten as id-cards.

## [0.5.1] - 2026-10-05

### Fixed

- Third adversarial review round (14 agents): 11 fixes, zero features.

## [0.5.0] - 2026-10-05

### Added

- **Three-factor ranking** (Generative Agents formula, embedding-free):
  injection index and memory_list order by pin → importance × recency
  (0.995^days, day-granular so index text stays stable within a day for
  KV-prefix caches). Auto-consolidation has the model assign importance 1-10;
  types carry sensible defaults.
- **Security pack**: every write path passes through redaction
  (`[REDACTED:github-token/npm-token/openai-key/aws-key/phone/id-card]` — the
  exact shapes that leaked in this project's own history) and protocol-tag
  escaping — the injected section is wrapped in `<memory_context>` and content
  can no longer forge the wrapper. Consolidation dedupes near-identical
  descriptions (Jaccard ≥ 0.7) instead of piling up echoes.

### Changed

- Eval arc completes: probe retention under half-budget pressure
  38% (positional) → 80% (pinned) → ≥90% (three-factor, unpinned) — same
  budget, same seed, better memories.

## [0.4.0] - 2026-10-04

### Added

- **Web UI memory panel** (dual-half plugin): the host registers authenticated
  `/api/auto-memory/*` routes over the existing locked store; the browser half
  registers a sidebar entry and a management page (grouped list with
  types/pins/read counts, per-scope capacity bars with budget warnings, inline
  editing, pin toggle, delete-with-confirm). One bundle serves Web and desktop
  clients; non-Web compositions stay no-op.
- CD pipeline: pushing a `v*` tag now builds, tests, smoke-loads both halves
  and publishes to npm with provenance.

### Fixed

- Panel routes register via a connection-ready callback (host load order used
  to skip them); the editor uses official theme variables (`--dsw-alias-*`)
  instead of hardcoded white — readable in dark mode.

## [0.3.0] - 2026-09-26

### Added

- **Pinned memories** (`pinned: true` on memory_write): pinned entries lead
  the index, survive budget truncation, and are exempt from staleness
  eviction — a trust anchor the user controls.
- Deterministic evaluation layer ([evals/](evals/README.md)) in CI: injection
  budget curves, eviction zero-misfire, link-expansion bounds, signal-to-noise
  characterization.

### Fixed

- Injection budget now covers the *whole* section (index + guidance); it used
  to overshoot by ~800 bytes. Caught by the new eval layer on its first run.
  Pinned-priority truncation lifted probe retention under half-budget
  pressure from 38% to ≥80%.

## [0.2.0] - 2026-09-25

### Added

- **Auto-consolidation** (`autoSummarize: true`): when a root session ends, a
  background LLM pass extracts durable new facts and files them as memories —
  deduplicated, capped, silent on failure.
- **Forgetting & eviction**: lifecycle metadata (created/updated/reads);
  `memory_read` counts references; `staleAfterDays` soft-hides zero-reference
  stale memories from the index (files kept); `memory_prune` dry-runs or
  deletes aged memories.
- **Recall expansion**: `memory_read` resolves `[[name]]` cross-links one
  level and attaches linked summaries.
- `memory_delete_all` — guarded by `tools/pre-execute` human approval: the
  model cannot self-confirm irreversible bulk deletes.

### Fixed

- Hardened by a second adversarial review (11 agents): single-lock `clear`
  window (no concurrent-write escape), conditional index rebuild on `touch`
  (no O(N) amplification), session-start stale refresh, subagent capture
  cleanup, abortable consolidation.

## [0.1.0] - 2026-09-22

### Added

- Initial release: typed store (user / feedback / project / reference),
  four tools (`memory_write` / `memory_read` / `memory_list` /
  `memory_delete`), single system-prompt injection section (order 4000,
  byte-budgeted, zero tokens when empty), workspace + user scope layers,
  cross-process lock with orphan recovery.
- Survived a 12-agent adversarial review before first publish: five
  production-grade traps fixed with regression tests, including the NTFS
  `memory`/`MEMORY.md` case-insensitive collision (silent data destruction)
  and the `{{{ }}}` prompt-crash bomb.

[0.1.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.1.0
[0.2.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.2.0
[0.3.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.3.0
[0.4.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.4.0
[0.5.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.5.0
[0.5.1]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.5.1
[0.5.2]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.5.2
[0.6.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.6.0
[0.6.1]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.6.1
[0.7.0]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.7.0
[0.7.1]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.7.1
[0.7.2]: https://github.com/AskTheWay/dsh-auto-memory/releases/tag/v0.7.2
