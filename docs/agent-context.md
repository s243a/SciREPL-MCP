# Agent context and session workspace

Coding agents launched by the app-connected broker need to know that the user's
work is in SciREPL notebook cells rather than ordinary files. This repository
ships that guidance without silently applying it to anyone who clones the
project.

## Inert source templates

The public source files are deliberately named:

- `packages/broker/templates/session-context.md.template`
- `packages/broker/templates/scirepl-notebook-skill.md.template`

They are not named `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or `SKILL.md` in the
source tree, so normal agent discovery does not load them merely because the
repository was opened.

## Explicit materialization

Agent setup requires both an enabling option and a host-access acknowledgement:

```bash
./setup-broker.sh \
  --enable-agent \
  --acknowledge-agent-host-access
```

The setup command creates active context only under the dedicated output
workspace, by default `~/scirepl-broker/workspace`. It writes provider-specific
copies, local MCP configuration, a canonical readable guide, and
`.scirepl-mcp/manifest.json` recording the managed boundary.

Normal broker startup only inspects this workspace. It does not create or update
agent instructions. An authenticated `POST /doctor` can perform an explicit
repair only when the generated launcher has set `BROKER_MANAGE_WORKSPACE=1`.
Changed generated files are backed up before replacement.

## Existing and custom directories

Setup refuses a non-empty unmarked output directory unless `--adopt` is supplied.
It also refuses edited generated files unless `--repair` is supplied, and rejects
managed paths that traverse symbolic links. Use a dedicated directory rather
than pointing setup at a source checkout or home directory.

Advanced users who supply and audit all agent context themselves can set
`BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE=1`. That bypass is intentionally explicit:
without a prepared workspace or that override, `/agent` will not launch a CLI.

## Trust boundary

The context tells an agent how to operate SciREPL and to respect the app's
permission decisions. It is guidance, not an operating-system sandbox. Agent
CLIs may still read files or execute programs available to the broker account.
An agent-only launch without terminal mode is a useful enforceable reduction in
broker capability; a sentence in `CLAUDE.md` asking an agent not to use a shell
is not equivalent. Use endpoint flags, command restrictions, provider policy,
and provider-native sandbox/approval controls together. Use a dedicated host
account, container, or VM when stronger isolation is required.
