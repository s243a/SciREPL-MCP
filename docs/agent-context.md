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

Antigravity/Agy reads its workspace MCP servers from
`.agents/mcp_config.json`. Setup writes the required `serverUrl` form there,
along with the broker's current loopback URL and bearer header. This differs
from Gemini CLI's `.gemini/settings.json`, which uses `url`; the two formats are
managed separately. Both files contain connection credentials and are written
privately (mode 0600 where supported).

Normal broker startup only inspects this workspace. It does not create or update
agent instructions. An authenticated `POST /doctor` can perform an explicit
repair only when the generated launcher has set `BROKER_MANAGE_WORKSPACE=1`.
Changed generated files and files whose private permissions have drifted are
backed up before replacement.

The doctor owns each generated file as a complete document; it does not merge
unrelated user entries into a provider configuration. A backup of an edited MCP
configuration can contain credentials and is therefore also written privately.

## Existing and custom directories

Setup refuses a non-empty unmarked output directory unless `--adopt` is supplied.
It also refuses edited generated files unless `--repair` is supplied, and rejects
managed paths that traverse symbolic links. Use a dedicated directory rather
than pointing setup at a source checkout or home directory.

Advanced users who supply and audit all agent context themselves can set
`BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE=1`. That bypass is intentionally explicit:
without a prepared workspace or that override, `/agent` will not launch a CLI.

Antigravity may also load a user-global MCP file. Invalid JSON in that global
file can prevent the provider from reaching an otherwise valid workspace
configuration. Setup and doctor intentionally do not inspect or overwrite global
provider settings; validate them separately if Agy reports a configuration parse
error.

## Trust boundary

The context tells an agent how to operate SciREPL and to respect the app's
permission decisions. It is guidance, not an operating-system sandbox. Agent
CLIs may still read files or execute programs available to the broker account.
An agent-only launch without terminal mode is a useful enforceable reduction in
broker capability; a sentence in `CLAUDE.md` asking an agent not to use a shell
is not equivalent. Use endpoint flags, command restrictions, provider policy,
and provider-native sandbox/approval controls together. Use a dedicated host
account, container, or VM when stronger isolation is required.
