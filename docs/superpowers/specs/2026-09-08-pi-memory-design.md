# pi-memory — Self-Improving Memory Extension for pi

**Date:** 2026-09-08
**Status:** Approved design (pre-implementation)
**Type:** pi extension (local, not published to npm)

## 1. Problem & Goals

pi agents start every session with no memory of prior sessions. Decisions, project facts, and
lessons from mistakes are re-derived (or re-forgotten) each time. Existing memory systems either
pollute the context window (full dumps) or rely purely on agent-initiated recall (misses).

Goals:

1. **Remember across sessions** — project facts, decisions, and lessons from mistakes survive
   session boundaries.
2. **Never pollute context** — fixed, budget-capped injection (<700 tokens) regardless of store
   size; full memory content only on explicit tool call.
3. **Self-improving** — the store gets better over time: consolidation distills sessions into
   memories, usage reinforces them, disuse decays them, contradictions supersede old versions.

Non-goals (v1):

- No embeddings / semantic search (keyword grep only; store layer is an interface so this can be
  added later).
- No cross-device sync, team sharing, or in-repo memory files.
- No approval gating on memory writes (silent with visible status; review via `/memory`).
- No npm publishing; local extension only.

## 2. Requirements (user-confirmed)

- Memory content: **project facts & decisions** and **lessons from mistakes**. (General user
  preferences are out of scope for v1.)
- Read strategy: **index + tools** — a small always-injected index of memory titles plus tools to
  read/search the full store.
- Write strategy: **both** explicit `memory_save` tool calls and automatic background
  consolidation.
- Storage: markdown files (research-backed; human-auditable, greppable, zero dependencies).

## 3. Architecture Overview

```
┌─────────────────────────── pi session ───────────────────────────┐
│                                                                    │
│  before_agent_start ──► inject.ts                                  │
│                          pinned lane (≤200 tok)                    │
│                          index lane  (≤400 tok)                    │
│                          policy text (~80 tok)                     │
│                                                                    │
│  LLM ◄──► tools.ts: memory_save / memory_search /                  │
│                    memory_read / memory_forget                     │
│                                                                    │
│  agent_settled (+60s idle) or session_shutdown ──► consolidate.ts  │
│                          transcript since watermark                │
│                          → ADD/UPDATE/DELETE/NOOP ops              │
│                          → usage.ts (strength/decay/prune)         │
└────────────────────────────────────────────────────────────────────┘
          │                     ▲
          ▼ store.ts            │
   ~/.pi/agent/memory/  (markdown files + INDEX.md)
```

## 4. Storage

### 4.1 Layout

```
~/.pi/agent/memory/
├── config.json                     # extension config (created with defaults on first run)
├── global/
│   ├── INDEX.md                    # auto-generated, never hand-edited
│   ├── archive/                    # decayed memories moved here (never auto-deleted)
│   └── mem-<id>.md
└── projects/<slug>/
    ├── INDEX.md
    ├── archive/
    ├── mem-<id>.md
    └── state.json                  # consolidation watermark + job state
```

`<slug>` is derived from the session's **resolved git root** (`git rev-parse --show-toplevel`);
for non-git directories, the absolute cwd. Slug = path with `/` → `-`, lowercased
(e.g. `Users-rasmus-src-myapp`). Rationale for a central store: survives branch switches and
repo moves, keeps user repos clean (same choice as Claude Code and Codex CLI).

### 4.2 Memory file format

```markdown
---
id: "mem-a1b2c3d4"
type: "decision"        # decision | fact | lesson
title: "One-line summary (imperative, specific)"
created: "2026-09-08T09:00:00.000Z"
lastUsed: "2026-09-08T09:00:00.000Z"
useCount: 0
strength: 0.5
scope: "project"        # project | global
pinned: false
revision: 0             # bumped on consolidation UPDATE
previousTitles: []      # last 3 superseded titles (provenance)
---
Body: 2–6 sentences. The fact, decision (with the *why*), or lesson (what failed,
the fix, how to avoid it next time).
```

All frontmatter values are JSON-serialized (strings quoted; numbers, booleans, and arrays bare).

- `id`: `mem-` + 8 hex chars (crypto random; collision check against store).
- `strength`: float 0–1, see §7.

### 4.3 INDEX.md (generated)

One line per memory, sorted by `strength` descending:

```
- [mem-a1b2c3d4] (decision ×3) Use pnpm workspace filters for test runs
- [mem-e5f6a7b8] (lesson) Never run migrations inside the Docker build stage
```

Hard caps: **max 60 lines / 4000 bytes**, whichever hits first. Overflow: lowest-strength entries
are dropped from the index (files stay; a trailing line
`…N more — use memory_search` is appended). Index writes are atomic (tmp + rename) and triggered
by any store mutation.

## 5. Injection (read path)

Hook: `before_agent_start`. Appends one fenced block to the system prompt:

```
## Memory

Pinned instructions (always apply):
- [mem-…] never push directly to main; open a PR

Relevant memories for this project (details via memory_read <id>):
- [mem-a1b2c3d4] (decision ×3) Use pnpm workspace filters for test runs
- …

Use memory_search <query> to find more. Save durable decisions, facts, and
lessons with memory_save — save immediately when the user corrects you.
```

- **Pinned lane** ≤200 tokens: memories with `pinned: true` (full body, trimmed to budget).
  Rationale: prohibitions must be always-present; recall is probabilistic (pi-hermes-memory's
  insight).
- **Index lane** ≤400 tokens: generated index lines (project first, then global).
- **Policy** ~80 tokens: fixed text (the last paragraph above).
- Token estimation: `ceil(chars / 4)` per lane; budgets are checked after rendering each lane,
  before appending.
- Total budget enforced by trimming in lane order: policy is never trimmed, index trims from the
  bottom, pinned truncates bodies oldest-last.

## 6. Tools (write & recall path)

All tools operate through `store.ts`. Tool results are terse (ids + titles + counts), never dump
the store.

### memory_save

```ts
parameters: {
  type: StringEnum(["decision", "fact", "lesson"]),
  title: Type.String(),              // one line, specific
  body: Type.String(),               // 2–6 sentences incl. the why
  scope: Type.Optional(StringEnum(["project", "global"])),  // default "project"
}
```

Write path: secret scan (§9) → dedup check (normalized-title exact match, or any contiguous
8-word sequence of the new body appearing in an existing same-type memory's body; on match,
return the existing id with a "similar memory exists — use /memory to edit or rephrase" note)
→ write file → regenerate index. Result: `{ id }`.

`promptGuidelines`: "Use memory_save to persist durable project decisions, facts, and lessons
from mistakes. Call it immediately when the user corrects your approach — corrections must not
wait for later."

### memory_search

```ts
parameters: {
  query: Type.String(),
  scope: Type.Optional(StringEnum(["project", "global", "all"])),  // default "all"
  type: Type.Optional(StringEnum(["decision", "fact", "lesson"])),
  limit: Type.Optional(Type.Number()),   // default 10
}
```

Keyword search: split query into terms (lowercase, strip stopwords), score = term hits in
title (×3) + body (×1), rank, return `id | type | title` lines. Never returns bodies.

### memory_read

```ts
parameters: { ids: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }) }
```

Returns full files (frontmatter stripped, id + title + body + useCount). Bumps `useCount` and
`lastUsed` for each id read.

### memory_forget

```ts
parameters: { id: Type.String() }
```

Moves the file to `archive/`, regenerates index. Used when the agent (or user) judges a memory
wrong or obsolete.

## 7. Consolidation & self-improvement loop

### 7.1 Trigger

- `agent_settled` → start an idle timer (default **60s**; reset by `agent_start` or any user
  input — only a fully idle stretch of 60s triggers a run).
- Also runs on `session_shutdown` (fire-and-forget with a short grace period).
- Single-flight: one consolidation per scope at a time; overlapping triggers are coalesced.
- Widget shows `memory: consolidating…` while running; failures notify once and retry on the
  next trigger. Never blocks or delays the session.

### 7.2 Extraction pass

One LLM call via `ctx.modelRegistry.complete` using `ctx.model` (config override:
`consolidationModel`). Inputs:

1. The existing index lines (both scopes).
2. The transcript **since the last watermark** (see 7.4), truncated head+tail to fit ~30k chars,
   with tool outputs elided (first 200 chars each).
3. The op schema and rules (below).

Structured output — a JSON array of ops (parsed leniently; invalid entries dropped, logged):

```json
[
  { "op": "ADD",    "type": "lesson", "title": "…", "body": "…", "scope": "project", "confidence": 0.9 },
  { "op": "UPDATE", "targetId": "mem-…", "title": "…", "body": "…", "reason": "contradicts: X changed" },
  { "op": "DELETE", "targetId": "mem-…", "reason": "obsolete" },
  { "op": "NOOP" }
]
```

Rules given to the model: extract only durable knowledge (not task logs); skip anything
derivable from the codebase; prefer UPDATE over ADD when similar; merge duplicates; mark
contradictions as UPDATE (old value is wrong now) with a reason; DELETE only for garbage/obsolete;
max **12 ops** per run, ordered by confidence.

### 7.3 Applying ops

- `ADD` (confidence ≥ 0.7): dedup check (§6 memory_save path); write file.
- `UPDATE`: target file is updated in place — body/title replaced, `revision` incremented, old
  title appended to `previousTitles` (keeping max 3) for provenance. Contradiction history lives
  in the file itself, not in links between files.
- `DELETE`: only soft — moves to `archive/` with a `.reason-<hash>` sidecar note; never unlinks.
- After ops: regenerate affected indexes; run decay/prune (7.5) for **both** scopes (global
  decay/prune piggybacks on every run, since consolidation itself is always per-project).

### 7.4 Watermark

Consolidation always runs for the **session's project scope**; ADD ops may target the global
scope when the model judges a lesson generalizes. `state.json` per project scope:

```json
{ "sessionId": "…", "lastEntryId": "…", "lastConsolidatedAt": "…" }
```

On each run: process entries after `lastEntryId` on the current branch
(`ctx.sessionManager.getBranch()`), then advance the watermark. If the session changed, start
from the branch tip backwards until the previous watermark's session is exhausted (bounded at
200 entries). Runs triggered from `session_shutdown` are best-effort (short grace period); the
watermark only advances after successful op application, so an interrupted run resumes on the
next trigger.

### 7.5 Usage, decay, pruning

Recomputed during every consolidation run:

- `strength = base × 0.5 ^ (daysSinceLastUsed / 14)`, where `base = min(1, 0.3 + 0.1 × useCount)`.
  (Two-week half-life; usage builds a ceiling that decay eats slowly.)
- Prune rule: `lastUsed` older than **30 days** AND `strength < 0.3` → move to `archive/`
  (removed from index). Pinned memories are exempt.
- Reinforce: when consolidation output references a memory as evidence (UPDATE target or
  explicitly cited), its `lastUsed` bumps.

This is the retention loop: **use it or lose it**, with archives as a safety net (nothing is ever
hard-deleted).

## 8. Commands & UI

- `/memory` — list memories for current project + global (strength-sorted, archivable filter).
  Select → view / edit (opens `$EDITOR` on the file) / forget / pin-unpin. Show stats line
  (counts per type/scope, archive size).
- `/memory-preview` — print exactly what would be injected right now (all three lanes, with token
  estimates), borrowed from pi-hermes-memory.
- Widget (footer): `mem: 12 (3 pinned)` or `memory: consolidating…`.
- `session_start` restores widget state; `session_shutdown` cancels timers and pending jobs.

## 9. Guardrails & error handling

- **Secret scan** on every write (tool + consolidation ADD/UPDATE): regexes for API-key shapes
  (`sk-…`, `AKIA…`, `ghp_…`, `xoxb-…`, `Bearer …`), `KEY=/TOKEN=/SECRET=` assignments, and
  long base64/hex blobs ≥32 chars. On hit: reject that op, notify with the reason, continue
  other ops.
- **Atomic writes**: tmp file + rename for memory files and indexes.
- **Corrupt frontmatter**: skip the file, warn once per session, exclude from index.
- **No model configured / API failure**: consolidation skipped (widget shows
  `memory: idle (no model)`); tool reads/writes unaffected.
- **Abort**: all async work takes `ctx.signal` / shutdown signal; watermark advances only after
  successful op application, so interrupted runs resume cleanly.
- **fs errors** (permission, disk): notify once, disable writes for the session, reads continue.

## 10. Module layout

```
~/pi-memory/
├── package.json            # name: pi-memory (private), dev-only deps: vitest, @types/*
├── tsconfig.json
├── docs/superpowers/specs/ # this spec
├── src/
│   ├── index.ts            # entry: default export, registration, event wiring, idle timer
│   ├── store.ts            # MarkdownStore: load/save/move/frontmatter, index gen, atomic IO
│   ├── inject.ts           # lane rendering + budget trimming + token estimation
│   ├── tools.ts            # 4 tool definitions + secret scan + dedup check
│   ├── consolidate.ts      # trigger logic, extraction call, op application, watermark
│   ├── usage.ts            # strength/decay/prune math (pure functions)
│   ├── commands.ts         # /memory, /memory-preview
│   └── config.ts           # load/merge config.json over defaults
└── test/
    ├── store.test.ts
    ├── inject.test.ts
    ├── tools.test.ts
    ├── consolidate.test.ts
    └── usage.test.ts
```

Loaded via a symlink `~/.pi/agent/extensions/pi-memory → ~/pi-memory` (directory-style
extension, `src/index.ts` as entry per `package.json` `pi.extensions`), so `/reload` works.

## 11. Configuration (defaults; `~/.pi/agent/memory/config.json`)

```json
{
  "enabled": true,
  "idleSeconds": 60,
  "indexMaxLines": 60,
  "indexMaxBytes": 4000,
  "pinnedMaxTokens": 200,
  "indexMaxTokens": 400,
  "pruneDays": 30,
  "pruneStrength": 0.3,
  "halfLifeDays": 14,
  "maxOpsPerRun": 12,
  "consolidationModel": null,        // null = current model
  "globalEnabled": true
}
```

## 12. Testing

- **Unit (vitest):** store CRUD + frontmatter round-trip + corrupt-file skip; index generation,
  budget trimming order; strength/decay/prune math (fixed clock); secret-scan regexes; dedup
  checks; slug derivation.
- **Integration:** drive the extension against a temp `memory/` dir. Mock
  `ctx.modelRegistry.complete` with scripted op outputs; simulate `before_agent_start`,
  tool calls, and `agent_settled`; assert injected content, budgets, op application, watermark
  advance, and archive behavior.
- **Manual:** `/memory` flows, widget states, symlink install + `/reload`, a real multi-session
  smoke test (save → new session → index shows it → read → consolidate a correction).

## 13. Success criteria

1. Injection cost ≤700 tokens, constant as the store grows.
2. After a session where a decision is made, the next session's index contains it without manual
   action.
3. A user correction in session N appears as a lesson in session N+1's injection or is trivially
   recalled via `memory_search`.
4. Store size stays bounded in practice: pruning keeps active memories within index budget.
5. Zero added latency to the agent hot path (consolidation is off the critical path).
