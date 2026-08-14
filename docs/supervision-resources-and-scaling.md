# Supervised agent runs: resources, scaling, and the cost of review

Field measurements from the first production use of the supervised
remote-agent pattern (see `remote-agent-control.md`): a Claude controller
driving the Antigravity CLI (`agy`, Gemini 3.6/3.7 Flash High) through the
broker's `/term` surface to translate notebook workbooks, with Claude
subagents (Sonnet 4.6-class, one Opus pilot) running the per-prompt review
loop. One task type, one machine, one worker CLI — treat every number as a
calibrated example, not a benchmark.

**Reference hardware:** Intel i7-10700KF (8 cores visible), 9.7 GiB RAM,
Ubuntu 22.04 under WSL2. Worker model inference is cloud-side; local load is
orchestration only.

## What a supervision stack costs locally

Measured mid-run (`ps`/`free`, steady state):

| Component | RSS | CPU | Lifetime |
| --- | --- | --- | --- |
| Broker (`broker.mjs`) | ~85 MB | ~0% | persistent |
| agy session (parent + helper child) | ~300 MB × 2 | ~10% of a core each | per live session |
| Driver invocation (`term-drive.mjs`) | ~60 MB | negligible | seconds, transient |
| Supervisor (Claude subagent) | **~0 local** | — | cloud context; its only local footprint is the transient driver process |

**Rule of thumb: one parallel supervision lane ≈ +700 MB RAM and +20–25% of
one core** (its own broker on another port, its own PTY, its own agy). That
figure is orchestration RAM only — it excludes OS/WSL2 VM overhead and any
co-resident workloads (browser test suites, builds), which on the reference
machine are the larger and lumpier consumers. With that caveat the machine
could host 3–4 lanes before memory pressure; in practice
the ceiling is the controller's attention across interleaved reports, not
hardware. Workers writing to disjoint directories need no git worktrees —
partition by path and give the shared index a single writer.

An asymmetry worth internalizing: the *worker* is a local process (Gemini
inference is remote, but the CLI, its TUI, and its scratch scripts are
local); the *supervisor* is a remote context (Claude tokens, no local RAM).
Adding workers costs memory; adding supervisors costs tokens.

## How wall-clock scales with task size

Five sessions, same task type (translate notebook markdown, code cells kept
byte-identical), increasing size. "md chars" is the translatable volume:

| Session | Files | md chars | Wall-clock | Approvals | Throughput |
| --- | --- | --- | --- | --- | --- |
| Pilot (1 file) | 1 | 941 | ~11 min | 4 | ~85 chars/min |
| Batch of 5 (small) | 5 | 5,768 | 14.6 min | 8 | ~395 chars/min |
| Batch of 4 (large files) | 4 | 9,571 | 20.8 min | 13 | ~460 chars/min |
| Batch of 5 (medium) | 5 | 11,642 | 19.4 min | 16 | ~600 chars/min |
| **Whole locale (15 files)** | 15 | 27,922 | ~39 min | 30 | **~715 chars/min** |

**Throughput rises with task size.** (The chars/min metric is
translation-specific; expect different absolute numbers — though the same
amortization shape — for code generation, refactoring, or analysis tasks.)
Session fixed costs — spin-up, the
worker probing file formats, writing its batch scripts — amortize across
more files. The 15-file session did the same volume as four small sessions
in roughly 60% of their combined time. Approvals also scale sublinearly
(2 per file at 15 files vs 4 at 1 file) because the worker aggregates: it
writes one batch script covering several files and asks one permission for
it, moving the review surface from per-edit diffs to the script itself.

No automatic worker-side decomposition (subagent fan-out) was observed even
at 15 files — likely because the task framing ("work in batches of 3–5,
verify each batch") reads as a sequential plan. Parallelism, if wanted,
should come from explicit parallel lanes (previous section), which keeps
each approval stream attributable to one supervisor.

**Session reuse is the largest single speedup measured.** Repeating the
same task shape in a continued worker session (second 15-file locale in
the same conversation as the first) took ~10 minutes and 7 approvals
against the fresh session's ~39 minutes and 30: the worker skipped all
format probing and went straight to its proven script templates. Two
caveats keep this from being free: conversational context accumulates
(per-turn input cost grows with history, and limits eventually bite), and
the knowledge is session-scoped — it evaporates on restart. Mitigation:
make task files self-contained (terminology, format rules, and
constraints in the file, not the conversation) so restarting costs one
re-probing run, not a knowledge loss; continue sessions while they stay
fast and treat slowdown as the restart signal.

## The cost of review

Supervisor context spend, per session (Claude tokens, tool calls):

| Session | Approvals | Supervisor tokens | Tokens/approval | Tool calls | Duration |
| --- | --- | --- | --- | --- | --- |
| Pilot (Opus) | 3 | 44k | ~14.7k | 29 | 11 min |
| Batch of 5 | 16 | 118k | ~7.4k | 55 | 19 min |
| Batch of 5 | 8 | 74k | ~9.3k | 32 | 15 min |
| Batch of 4 | 13 | 106k | ~8.2k | 58 | 21 min |
| Whole locale | 30 | 178k | ~5.9k | 127 | 39 min |

Tokens per approval fall as sessions grow — the sublinear-review claim in a
single column. ~6k tokens per reviewed permission is a useful planning
figure for large sessions.

Observations:

- **Review is the serial path.** Worker generation time between prompts is
  what grows with volume; the review cost grows with *approvals*, which
  aggregation keeps sublinear. Telling the worker to aggregate harder would
  shave little (review is already cheap per file) while making each single
  approval carry more risk; per-edit prompts would multiply approvals ~4×
  for marginal safety when a downstream mechanical gate re-verifies every
  file anyway. The worker's natural equilibrium was left alone.
- **~180k tokens ≈ a practical supervisor ceiling.** The whole-locale
  session finished just under it. Briefs should include a context-handover
  clause (stop cleanly between decisions, report state, successor resumes
  the same live session) rather than letting a supervisor degrade.
- **Supervisor tier can be modest.** After an Opus pilot validated the
  policy, Sonnet-class supervisors ran every later session; the one
  non-mechanical judgment (a script referenced by path with no inline code)
  was handled correctly by reading the file from disk. The controller's
  own verification gate is the backstop that makes a cheaper reviewer
  acceptable: reviewer tier buys latitude, the gate buys correctness.
- **Human review time: ~zero during runs.** The human's cost concentrates
  where it should — privilege decisions (enabling agent mode, trusting a
  workspace) and end-of-run quality opinions, not per-action babysitting.

## Costs this document does not capture

- Worker-side (Gemini) token/quota consumption per *supervised* session —
  observed only as a weekly quota percentage during the runs. Paths to real
  numbers, in order of quality:
  1. **Headless JSON mode — verified working.** `agy --output-format json
     -p "…"` returns `{conversation_id, status, response, duration_seconds,
     num_turns, usage}` with `input_tokens`, `output_tokens`,
     `thinking_tokens`, `cache_read_tokens`, `total_tokens`. A trivial
     probe measured **~15.2k input tokens of fixed overhead per
     invocation** (system prompt + tools) against 29 output tokens — the
     token-level view of why fewer, larger sessions beat many small ones.
     The broker's agy adapter predates this flag (its comment says "no
     JSON mode"); teaching the one-shot profile `--output-format json` and
     parsing `usage` would give per-turn accounting on the `/agent`
     surface. **But note what headless costs in trust:** it cannot prompt,
     so anything beyond read-only work needs standing grants or
     `--dangerously-skip-permissions` — and recovering safety then means
     sandboxing (isolated worktrees, containers, throwaway users), i.e.
     the resource cost the supervised PTY path avoids. Headless JSON mode
     is the right tool for *bounded read-only* jobs where exact token
     accounting matters; for work that writes, per-action supervision
     with coarser accounting remains the cheaper total package.
  2. **TUI slash commands through the PTY.** `/term` is a real PTY, so
     `/usage` and `/context` are just keystrokes — bracketing a session
     with `/usage` readings yields a per-session quota delta, at
     whatever coarseness the backend reports.
  Interactive PTY sessions (the supervised path) still lack per-turn
  numbers; slash-command bracketing is the available instrument there.
- Controller-side orchestration tokens (task authoring, verification,
  commits) — interleaved with unrelated work in the same context. Rough
  order of magnitude from this campaign: per locale, noticeably below one
  supervisor session's spend — verification is mechanical (gate scripts,
  not reading translations) and task files are generated, so the
  controller's marginal cost per repetition is small and front-loaded in
  the first run.
- Translation *quality* review by native speakers — deferred by design;
  the pipeline's gates prove structure, not prose.
