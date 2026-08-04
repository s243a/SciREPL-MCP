# Configuration reference

Configuration is read from environment variables when the broker starts.

## Core

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_HOST` | `127.0.0.1` | Listening address. Keep loopback unless you understand the exposure. |
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

## Remote agents

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_AGENT` | `0` | Set to `1` to enable `/agent` and host-side CLI spawning. |
| `BROKER_WORKSPACE` | `~/scirepl-broker/workspace` | Broker-managed workspace root. Useful for isolated installations and tests. |
| `BROKER_AGENT_CWD` | `~/scirepl-broker/workspace` | Working directory for spawned agents. A custom value disables automatic management of workspace files. |
| `BROKER_AGENT_ALLOWED_TOOLS` | `mcp__scirepl__*` | Claude CLI tool allowlist. It does not restrict other adapters. |
| `BROKER_AGENT_FULL` | `0` | Set to `1` to omit Claude's tool allowlist. This affects Claude only. |
| `BROKER_AGENT_USE_API_KEY` | `0` | Pass recognized provider API-key variables to spawned agents. Provider billing and terms then apply. |
| `BROKER_AGENT_INHERIT_ENV` | `0` | Pass the broker's complete environment to child processes. This may disclose secrets. |
| `BROKER_MAX_AGENT_BUFFER_BYTES` | `1048576` | Maximum buffered agent output without a complete event (or total plain-text turn output). |

The default child environment contains common process variables such as
`HOME`, `PATH`, `SHELL`, locale variables, temporary-directory paths, and the
local MCP connection values. Files readable by the broker account remain
readable to a spawned process even when the environment is restricted.

## Terminal

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_TERM` | `0` | Set to `1` to enable `/term`. Requires `node-pty`. |
| `BROKER_TERM_NO_SHELL` | `0` | Remove the direct shell choice and prevent agent-to-shell fallback. |
| `BROKER_TERM_CMDS` | `shell,claude,codex,gemini,agy` | Comma-separated allowed terminal selections. |
| `BROKER_TERM_SHELL` | `$SHELL` or `bash` | POSIX-like shell used by the PTY adapter. |
| `BROKER_TERM_GRACE_MS` | `600000` | How long a disconnected PTY is retained for reattachment. |

## Examples

Core broker only:

```bash
npm start
```

Remote-agent chat with a dedicated workspace:

```bash
BROKER_AGENT=1 \
BROKER_AGENT_CWD="$HOME/scirepl-agent-workspace" \
npm start
```

Terminal restricted to interactive Claude and Codex sessions without a shell
fallback:

```bash
BROKER_TERM=1 \
BROKER_TERM_NO_SHELL=1 \
BROKER_TERM_CMDS="claude,codex" \
npm start
```
