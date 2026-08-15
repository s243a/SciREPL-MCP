# Proposal: attenuation-ordered directory authority

**Status:** design proposal, not scheduled. Extends the workbook
file-transfer design (`workbook-file-transfer.md`, implemented in PR #7)
with a governing principle and two features that fall out of it. The
carve-out portion (§2) hardens the current static design on its own and is
the natural first slice whenever this is picked up.

## The principle

**Authority only attenuates downward.** The broker's configured bounds are
the outer limit of all workbook file transfer. The app layer may refine —
narrow, select within — those bounds, but can never exceed them: anything
outside broker bounds is unreachable from the app layer *by construction*,
not by a precedence check that could be misordered or forgotten.

This is capability attenuation, and it resolves two designs that were
being discussed as separate features:

- A "deny list" stops being a sibling mechanism to the allowlist with a
  precedence rule between them. It is simply the shape of the broker's
  bounds: the app cannot allow what was never inside its inherited
  authority.
- Dynamic app-side grants stop being dangerous. The renderer-forgery
  objection (an app→broker grant request is renderer state, forgeable by
  notebook code) collapses: a forged request can only *select within*
  bounds the operator already authorized. Widening is a broker-layer act
  by definition, requiring hands on the host — which is precisely the
  broker layer's authority domain.

## 1. Bounds as roots minus carve-outs

Express broker configuration as bounds: allowlisted roots minus
carve-outs, where carve-outs can exclude paths *inside* allowed roots.

- Frozen at launch, like the current allowlist.
- Carve-outs support patterns (`**/settings.json`, `.git/` everywhere —
  subsuming the current per-root `.git` special case).
- **Seeded self-protection set**, present by default: the broker's own
  token file, broker config, the workbook-io config, and this carve-out
  configuration itself — a transfer tool that can rewrite its own
  authority configuration is a privilege-escalation loop. Plus the obvious
  credential and config classes: `~/.ssh`, `~/.gnupg`, `~/.aws`, agent-CLI
  settings and permission files, shell rc files, systemd user units,
  crontabs, browser profiles.
- Operator-extendable. Shrinking below the seeded self-protection set only
  via an explicit acknowledgement flag in the existing
  `--acknowledge-…` style, if permitted at all.

**Motivating today-problem:** the current pilot configuration allowlists
`~/.gemini/antigravity-cli/brain/` — one directory away from
`~/.gemini/antigravity-cli/settings.json`, an agent-CLI permission file.
The present root does not reach it; the pattern (allowed roots adjacent to
security-critical config, separated only by configuration care) is what
seeded carve-outs make structurally safe.

## 2. App-side refinement (launch-flag gated, default off)

The app may request activating a sub-scope within broker bounds at
runtime — "this session transfers only within `catalog:.pilot/run-42/`" —
without operator config edits or broker restarts.

- Because a forged request can only narrow, hostile renderer code gains
  nothing but the ability to choose among already-authorized directories.
- Refinements are per-connection, audit-logged, and reset on disconnect.
- Per-call app permission (the default-Off `scirepl_ai_workbook_io` gate)
  is unaffected and still applies inside any refinement.

## 3. Widening, if ever, is broker-layer only

By definition under the principle. Mechanisms, all requiring host access:
config edit plus restart (exists today); or, if judged worth speccing, a
host-side marker file (e.g. `.scirepl-transfer-allow`) placed in a target
directory by the host user — requestable from the app, pre-authorizable
only by a hand that can write the host filesystem. Marker semantics would
still sit below carve-outs: a marker inside a carved-out path is void.

## 4. Receipts name the effective scope

Receipts and audit records should identify the authority that was live at
call time (bounds ∩ active refinement), so post-hoc review can reconstruct
not just what happened but what *could have* happened. This extends the
existing content-free receipt schema with scope identifiers only — never
absolute host paths.

## Sequencing

§1 is independent and is the hardening slice: it strengthens the merged
PR #7 design with no new surfaces. §2 and §3 are UX conveniences that
should only follow once §1's bounds model is the implemented substrate.
An adversarial design pass (the repo's standing convention) precedes any
implementation.
