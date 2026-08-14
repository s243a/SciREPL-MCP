# Controlling a remote coding agent, with supervision

The broker was built so the SciREPL app can drive a coding agent on a desktop.
The same two surfaces let **another agent** be the driver: a strong model
(the *controller*) sends tasks to a cheaper or more specialised CLI agent (the
*worker*), reviews every permission the worker requests, and verifies what it
produced. This page documents that pattern as field-tested: the first
production use was Claude (controller) driving the Antigravity CLI `agy`
(worker) to translate notebook workbooks, with an Opus subagent handling the
per-prompt review loop.

The short version of the trust model: **the worker does the volume, the
controller does the judgment, the human does the privilege changes.**

## Start the broker for supervision

```bash
BROKER_HOST=<tailscale-ip> \
BROKER_AGENT=1 \
BROKER_TERM=1 \
BROKER_TERM_CMDS=agy \
BROKER_AGENT_CWD=/path/to/target-repo \
BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE=1 \
node packages/broker/src/broker.mjs
```

Decisions encoded there:

- **Name the worker, exclude `shell`.** `BROKER_TERM_CMDS=agy` means the PTY
  can only become that one CLI. With a shell in the list, a token holder gets
  a terminal and every other safeguard is moot; with only an agent CLI, every
  consequential action still has to pass that agent's own permission prompt.
- **Point `BROKER_AGENT_CWD` at a git repository.** The repo is the shared
  state between worker and controller. `git status`/`git diff` after a turn
  is the controller's precise, verbosity-controlled view of what actually
  happened — far better than trusting the worker's own summary. It is also
  the rollback.
- Tailscale binding keeps the broker off the open internet while allowing a
  controller on another tailnet machine. The bearer token
  (`~/scirepl-broker/broker-token`, mode 0600) is still required on every
  connection.

## Two surfaces, one choice

**`/agent` (headless one-shot).** The broker spawns the CLI per turn
(`agy --add-dir <cwd> [-c] -p <text>`), buffers its stdout, and delivers one
blob at exit. Session context persists across turns via the CLI's own resume.
Good for pure Q&A. Two sharp edges, learned the hard way:

- A permission the CLI needs but cannot prompt for in headless mode is
  **auto-denied**, and the only trace is a clipped stderr line — the turn
  otherwise looks like a success with empty output.
- Output beyond the buffer cap kills the whole turn.

**`/term` (interactive PTY).** The broker spawns the CLI under a PTY; its
full TUI — including permission prompts, with target paths and diffs — is the
event stream, and the controller answers each prompt. The PTY survives
WebSocket disconnects, so a blocking connect–act–read–detach loop works.
This is the supervised path: prefer it whenever the worker will need file or
command permissions.

Driver scripts for both live in `packages/broker/scripts/`:

```bash
# one-shot turn
node packages/broker/scripts/agent-drive.mjs \
  --url ws://HOST:8087/agent --token-file ~/scirepl-broker/broker-token \
  --agent agy --prompt-file task.txt

# supervised session, one step at a time
node packages/broker/scripts/term-drive.mjs \
  --url ws://HOST:8087/term --token-file ~/scirepl-broker/broker-token \
  --send 'the task text'            # then repeatedly:
node packages/broker/scripts/term-drive.mjs ... --read-ms 8000          # look
node packages/broker/scripts/term-drive.mjs ... --send-raw '1'          # answer a menu
node packages/broker/scripts/term-drive.mjs ... --send-raw "$(printf '\x07')"  # expand (agy ctrl+g)
```

## The review policy

This is the controller's contract; the supervisor skill template
(`packages/broker/templates/remote-agent-supervisor-skill.md.template`)
carries the same rules for installation into a controller's skill directory.

1. Never pick an "always allow" option, and never one that persists to the
   worker's settings file. Standing grants are a human decision.
2. Never approve a partially hidden command. agy truncates long commands with
   `⋯ (N lines hidden)`; expand (ctrl+g) and read all of it first.
3. Scripts by reference need reading, not trusting. Mid-task, workers switch
   from inline commands to "run this helper script" with only a path in the
   prompt (agy writes them under
   `~/.gemini/antigravity-cli/brain/<session>/scratch/`). Read the file
   yourself, in full, directly from the filesystem — never through the
   worker. **The supervisor therefore needs read access to the worker's
   scratch directory, not just the workspace.** A supervisor that cannot
   read the referenced file must deny and ask the worker to inline the
   command. (Observed in production: a 285-line `translate_all.py` reviewed
   this way and approved; blind approval and reflexive denial were both the
   wrong answer.)
4. Approve reads inside the workspace, and writes whose target and shown diff
   match the task — including referenced scripts read in full that only read
   declared inputs and write inside the task's target subtree.
5. Deny git commands (the controller commits, after review), writes outside
   the workspace, undeclared network access, and anything not understood.
   Tell the worker why in one line; let it adapt. Network access is a
   *declarable* scope, not a category ban: when the task brief says the
   worker may consult the web (documentation lookups, API references),
   the supervisor gates each request like any other prompt — but the
   review criterion differs from file writes. A URL is an egress channel:
   approve requests to well-known documentation hosts with plainly
   readable paths; deny opaque endpoints, parameter-heavy URLs that could
   carry encoded workspace data out, and any request whose destination
   the task did not foreseeably need. When in doubt, deny and ask the
   worker to state what it is looking for — the reformulated request is
   usually easier to judge.
6. Log every decision — request, verdict, reason. The audit trail is a
   deliverable.
7. Verification of the produced work is the controller's job, never the
   worker's claim. Diff against sources; check the invariants the task
   defined. Commit only after that.

If the worker is blocked on a permission the policy cannot grant, the loop
stops and a human decides. In the first production run, the controller's own
safety layer refused to let it edit the worker's `permissions.allow` file —
that boundary (no agent expands another agent's standing privileges) is the
correct shape, and this workflow exists so it never needs to be crossed:
per-action approval makes standing grants unnecessary.

### Delegating the loop

The review loop is many small reads of a redrawing TUI — cheap decisions,
expensive context. If the controller platform supports subagents, spawn one
with: the driver invocation, the policy above verbatim, the task description,
and the audit obligation. The parent keeps verification and commits. This
splits cost from judgment cleanly: the parent context pays once for the
outcome and the audit trail, not for every screen redraw.

## Security: what the agent-only restriction buys, and what it does not

Restricting the terminal surface to one agent CLI is **defence-in-depth, not
a sandbox**. Be precise about the difference:

- Against *accidents* and *casual token exposure*, it is a real improvement:
  there is no shell prompt to type into, the worker starts in the target
  repo, refuses obviously destructive requests, and every action is visible
  in one loggable stream.
- Against a *determined* token holder, it is friction, not a boundary: they
  can drive the worker to request a command and approve the prompt
  themselves. The ceiling of a stolen token is still command execution as
  the broker's user — noisier and slower than a shell, but reachable.

So: keep the token in its 0600 file, never in a clipboard or shell history;
bind to a tailnet address or loopback-plus-tunnel; treat tailnet ACLs as part
of the perimeter; and rotate the token (delete the file; the broker
regenerates) after any suspected exposure.

### Design for post-compromise, not just prevention

Every prevention measure above is friction — raising an attacker's cost,
never zeroing their probability. In a system where agents act autonomously
at machine speed, the properties that decide how bad a bad day gets are the
post-compromise ones, and they are the ones most often left unbuilt:

- **Audit trails.** Every worker action in this pattern passes through a
  prompt that a supervisor logged with a verdict and a reason, and every
  file change lands in git. When something goes wrong, "what exactly
  happened, in what order, approved by whom" is a query, not a forensic
  reconstruction. An audit trail that attributes actions to an identity
  (see the tailnet-identity follow-up) is worth more than one that
  attributes them to "whoever held the token".
- **Revocation speed.** How long from "something is wrong" to "it can no
  longer act"? Here: delete the token file and restart the broker —
  seconds, one person, no coordination. Measure this in your own setup;
  if revocation requires a meeting, the design is wrong.
- **Blast-radius scoping.** The worker writes one directory subtree of one
  git repository; the supervisor holds no standing grants; the index has a
  single writer; commits happen only after verification. Assume the worker
  (or its supervisor) goes fully hostile and ask what the maximum damage
  is — then check whether that damage is (a) visible in the logs,
  (b) reversible from git, (c) contained to the declared scope. If any
  answer is no, fix the scope before adding more prevention.

The pattern's honest security claim is not "attackers cannot act" — it is
"every action is prompted, logged, attributed, and reversible." For
autonomous-agent systems, that accountability property is usually the
highest-value security investment available, and the easiest to skip.

### Scope of this document

These notes document one working pattern and the reasoning behind its
choices. They are practitioner field notes, not a security review, a threat
model, or a compliance artifact — and they are not a substitute for
security expertise proportional to what the system protects. If the broker
host touches production credentials, sensitive data, or systems whose
compromise carries real-world consequences, have someone whose job is
security review the deployment; nothing in these documents should be read
as making that unnecessary.

## Known rough edges (both fixable in the broker)

Observed in the first production run; candidate improvements, roughly in
value order:

1. `/agent` turns have no structured outcome. A permission auto-deny, an
   empty answer, and a buffer-cap kill all arrive as `result` with little or
   no text. A `turn` envelope (exit code, duration, bytes, truncated flag,
   denied-permission name when detectable) would let a controller react
   mechanically instead of parsing stderr.
2. The broker could report **files changed per turn** by diffing
   `BROKER_AGENT_CWD` before/after (it already knows the directory). That
   would make the controller independent of the worker's self-reporting even
   on the headless surface.
3. stderr pass-through is clipped to 500 bytes per chunk; permission-denial
   explanations can be cut mid-sentence.
4. A per-turn reply-verbosity hint (full / summary / files-only) that
   controllers could set per request rather than an env var.
5. A read-only, token-authenticated file-fetch endpoint scoped to the
   workspace and the worker's scratch directory, so a REMOTE supervisor can
   review referenced scripts (policy rule 3) without filesystem access to
   the broker host. Until it exists, remote supervisors must deny
   script-by-reference prompts.
6. Token hardening, in ascending order of cost and honesty about limits.
   The bound that governs the whole ladder:

   > **A secret's confidentiality is limited by the most-exposed principal
   > that legitimately reads it.**

   Every rung below therefore raises attacker cost rather than creating a
   boundary. (a) Group-readable token file (`640`, dedicated group)
   only helps once broker and controller run as separate users — which is
   itself the first cheap sandboxing step. (b) Per-surface or short-lived
   tokens scope what a stolen string grants. (c) Tailscale Serve identity
   headers replace the bearer secret with asserted tailnet identity:
   nothing copyable to steal, revocation via ACLs, and actions attribute
   to a node in the audit trail instead of to "whoever had the string".
