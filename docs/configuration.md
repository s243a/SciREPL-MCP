# Configuration reference

Configuration is read from environment variables when the broker starts.

## Core

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_HOST` | `127.0.0.1` | Listening address. Keep loopback and use a private proxy/tunnel. Directly setting a non-loopback value bypasses setup's acknowledgement check. |
| `BROKER_PORT` | `8087` | HTTP and WebSocket port. |
| `BROKER_TOKEN` | unset | Explicit pairing token. When set, it takes precedence over the token file. |
| `BROKER_TOKEN_FILE` | `~/scirepl-broker/broker-token` | Persistent token location. Created with mode `0600` where supported. |
| `BROKER_CALL_TIMEOUT_MS` | `120000` | Timeout for an app-side notebook tool call. |
| `BROKER_MAX_PENDING_CALLS` | `32` | Maximum concurrent calls awaiting the app. |
| `BROKER_MAX_HTTP_BODY_BYTES` | `1048576` | Maximum `/mcp` JSON request body. |
| `BROKER_MAX_APP_WS_PAYLOAD_BYTES` | `16777216` | Maximum `/app` message payload. This larger cap accommodates base64 plots and file results. |
| `BROKER_MAX_AGENT_WS_PAYLOAD_BYTES` | `1048576` | Maximum inbound `/agent` message payload. |
| `BROKER_MAX_TERM_WS_PAYLOAD_BYTES` | `1048576` | Maximum inbound `/term` message payload. |
| `BROKER_MAX_WS_CONNECTIONS` | `4` | Connection cap for each WebSocket endpoint. |
| `BROKER_WS_AUTH_TIMEOUT_MS` | `5000` | Time allowed for a WebSocket client to send an authenticated hello. |

### Planned workbook file configuration

`BROKER_WORKBOOK_IO_CONFIG` is reserved by the workbook file-transfer design for
an absolute, immutable-at-runtime JSON allowlist. It is **not read by the current
broker**, and setting it does not enable any tools yet. The proposed file format,
8 MiB maximum, private placement, cross-platform path rules, and generated-
launcher requirements are specified in [Workbook file transfer through the
broker](workbook-file-transfer.md).

## Remote agents

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_AGENT` | `0` | Set to `1` to enable `/agent` and host-side CLI spawning. |
| `BROKER_WORKSPACE` | `~/scirepl-broker/workspace` | Default session-workspace path used when `BROKER_AGENT_CWD` is unset. |
| `BROKER_AGENT_CWD` | value of `BROKER_WORKSPACE` | Working directory for spawned agents and terminals. Ordinary startup never creates context here. |
| `BROKER_MANAGE_WORKSPACE` | `0` | Set by the generated agent launcher to permit an authenticated, explicit `POST /doctor` repair. It does not make startup write files. |
| `BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE` | `0` | Advanced bypass allowing agent launch without the exact generated context. Use only when you provide and audit the workspace yourself. |
| `BROKER_AGENT_ALLOWED_TOOLS` | `mcp__scirepl__*` | Claude CLI tool allowlist. It does not restrict other adapters. |
| `BROKER_AGENT_FULL` | `0` | Set to `1` to omit Claude's tool allowlist. This affects Claude only. |
| `BROKER_AGENT_USE_API_KEY` | `0` | Pass recognized provider API-key variables to spawned agents. Provider billing and terms then apply. |
| `BROKER_AGENT_INHERIT_ENV` | `0` | Pass the broker's complete environment to child processes. This may disclose secrets. |
| `BROKER_MAX_AGENT_BUFFER_BYTES` | `1048576` | Maximum buffered agent output without a complete event (or total plain-text turn output). |

The default child environment contains common process variables such as
`HOME`, `PATH`, `SHELL`, locale variables, temporary-directory paths, and the
local MCP connection values. Files readable by the broker account remain
readable to a spawned process even when the environment is restricted.

The recommended setup command creates conventional agent context only in a
dedicated workspace. Without a current generated workspace or the explicit
unmanaged bypass, `/agent` refuses to launch a CLI. See
[Agent context and session workspace](agent-context.md).

`/agent` is a structured non-PTY transport. Prompts and MCP notebook tools can
work without terminal support, but terminal-only behaviour such as `!ls`,
interactive slash commands, key-driven prompts, and full-screen TUIs requires
`/term`. Executing a permitted SciREPL Bash cell through MCP is separate from a
host-side shell escape.

## Terminal

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_TERM` | `0` | Set to `1` to enable `/term`. Requires `node-pty`. |
| `BROKER_TERM_NO_SHELL` | `0` | Remove the direct shell choice and prevent agent-to-shell fallback. |
| `BROKER_TERM_CMDS` | `shell,claude,codex,gemini,agy` | Comma-separated allowed terminal selections. |
| `BROKER_TERM_SHELL` | `$SHELL` or `bash` | POSIX-like shell used by the PTY adapter. |
| `BROKER_TERM_GRACE_MS` | `600000` | How long a disconnected PTY is retained for reattachment. |

## Setup options

The shared Bash and PowerShell entry points call the same Node.js implementation.
Important command-line options are:

| Option | Effect |
|---|---|
| `--output PATH` | Place the private token, generated launchers, and optional workspace under this dedicated directory. |
| `--enable-agent --acknowledge-agent-host-access` | Enable structured, non-PTY `/agent` adapters and materialize their explicit session context. |
| `--enable-terminal --acknowledge-terminal-host-access` | Enable `/term`, install/verify `node-pty`, and create its working directory. Combine it with agent mode for interactive agent/TUI choices. |
| `--repair` | Back up and replace edited or stale generated files. |
| `--adopt` | Allow setup to use an existing non-empty directory that has no setup marker. |
| `--host ADDRESS --allow-non-loopback` | Explicitly accept raw non-loopback binding. This does not prove Tailscale/SSH or provide TLS. |
| `--no-install` | Skip dependency installation, normally for development or tests. |
| `--dry-run` | Perform read-only validation and print the planned configuration. |

Setup never prints or embeds the pairing token in its launchers.

## Examples

Core broker only:

```bash
./setup-broker.sh
~/scirepl-broker/start-broker.sh
```

Remote-agent chat with a dedicated workspace:

```bash
./setup-broker.sh \
  --enable-agent \
  --acknowledge-agent-host-access
```

Structured chat plus the default interactive terminal/agent choices:

```bash
./setup-broker.sh \
  --enable-agent \
  --acknowledge-agent-host-access \
  --enable-terminal \
  --acknowledge-terminal-host-access
```

To restrict this to Claude and Codex without a shell fallback, add
`BROKER_TERM_NO_SHELL=1` and `BROKER_TERM_CMDS=claude,codex` to the private
launcher. A later `--repair` may replace edited generated launchers after making
a timestamped backup.
