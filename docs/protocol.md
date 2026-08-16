# SciREPL broker protocol

Protocol version: **1**

The broker translates between MCP Streamable HTTP and SciREPL's outbound
WebSocket connection. JSON examples below omit unrelated fields.

## Endpoints

| Endpoint | Transport | Purpose | Default |
|---|---|---|---|
| `/health` | HTTP GET | Version, connection, and enabled-feature status | enabled |
| `/mcp` | MCP Streamable HTTP | External MCP client interface | enabled |
| `/doctor` | HTTP GET/POST | Inspect or explicitly repair the prepared agent workspace | enabled, token required |
| `/app` | WebSocket | SciREPL app advertises and executes notebook tools | enabled |
| `/agent` | WebSocket | App chat to a host-side coding-agent CLI | disabled unless configured |
| `/term` | WebSocket | App terminal to a host-side PTY | disabled unless configured |
| `/worker` | WebSocket | Reverse worker registers and receives `/agent` and `/term` commands | disabled unless configured |

`/mcp` and `/doctor` use `Authorization: Bearer <token>`. WebSocket endpoints
authenticate in their first JSON `hello` message. An unauthenticated socket is
closed after the configured deadline.

`/health` is intentionally unauthenticated so clients can diagnose reachability
before pairing. It reveals broker/protocol versions, whether the app is connected,
the advertised tool count, whether agent, terminal, and reverse-worker features
are enabled, connected reverse-worker names and advertised CLIs (never host
details), and whether the exact generated agent workspace is ready. It does
not expose tool definitions, notebook data, tokens, or host paths.

`GET /doctor` is read-only. `POST /doctor` creates missing generated workspace
files and backs up/replaces stale ones only when the broker was started with
`BROKER_MANAGE_WORKSPACE=1`, which the explicit agent setup launcher supplies.
Ordinary broker startup never seeds agent instructions or provider settings.
Managed settings include Antigravity's workspace-local
`.agents/mcp_config.json`; GET reports it like any other managed file, while
POST is required to create or repair it.

## App bridge (`/app`)

App to broker:

```json
{
  "type": "hello",
  "token": "<pairing-token>",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_cells",
        "description": "List notebook cells",
        "parameters": { "type": "object", "properties": {} }
      }
    }
  ]
}
```

Broker acknowledgement:

```json
{ "type": "welcome", "protocolVersion": 1, "tools": 1 }
```

Broker tool request:

```json
{ "type": "call", "id": "<uuid>", "name": "list_cells", "args": {} }
```

App result:

```json
{ "type": "result", "id": "<same-uuid>", "output": "<text>" }
```

An app error uses an `error` field instead of `output`. The broker maps textual
results to MCP text content. A result matching a `data:image/...;base64,...` URL
is mapped to an MCP image content block.

Only one app bridge is logically active. Tool definitions are supplied by the
app, not hard-coded into this repository.

### Broker-owned workbook file tools

An explicitly configured broker adds `export_workbook_to_file` and
`import_workbook_from_file` when the app advertises the corresponding base
workbook tool. These protocol-v1 wrappers relocate exact UTF-8 bytes through an
allowlisted host directory and return a content-free receipt. They do not alter,
cache, or pre-answer the app's per-call workbook permission. The authoritative
schemas, receipt, path-hardening, transport budget, and audit contract are in
[Workbook file transfer through the broker](workbook-file-transfer.md).

For the internal app call, the broker adds reserved `brokerRoot` and
`brokerPath` fields containing only the validated public root alias and relative
path. They are display context for a future destination-aware SciREPL Pro
confirmation, not app-side path authority, and an ordinary MCP caller may not
claim them. Existing Pro versions safely ignore the extra fields; their
localized confirmation-string update is a separate app follow-up.

## Remote agent (`/agent`)

The app first sends:

```json
{ "type": "hello", "token": "<pairing-token>" }
```

When enabled, the broker responds with detected CLI names in both `agents`
(for existing clients) and `availableAgents`, the complete adapter list in
`configuredAgents`, the `workspaceReady` state, and the protocol version. If the
workspace is unprepared and the advanced unmanaged override is absent, `agents`
is empty and a start request fails closed. The app can then send:

```json
{ "type": "start", "agent": "claude" }
{ "type": "input", "text": "Review my notebook" }
{ "type": "stop" }
```

Broker events use `{"type":"agent","kind":...}`. Kinds include `welcome`,
`started`, `assistant`, `tool_use`, `result`, `stderr`, `error`, and `exit`.
Adapter output is normalized, but raw CLI behaviour and privileges remain
provider-specific.

The structured `/agent` path does not require a PTY. Interactive agent/TUI modes
use `/term` and therefore require terminal support as well. This includes
terminal-only conveniences such as `!ls`, interactive slash commands, keyboard
permission prompts, and full-screen interfaces.

## Terminal (`/term`)

After an authenticated hello, the app can send:

```json
{ "type": "start", "cmd": "shell", "cols": 80, "rows": 24 }
{ "type": "input", "data": "echo hello\n" }
{ "type": "resize", "cols": 100, "rows": 30 }
{ "type": "stop" }
```

The broker replies with `{"type":"term","kind":...}` events such as
`welcome`, `started`, `data`, `exit`, and `error`. Terminal mode is a privileged
feature and is disabled by default. When reverse-worker mode is enabled, `/term`
and `/agent` keep these exact controller message shapes and the broker may
relay them instead of spawning locally. Relayed `started` events include a
broker-authored `via` field naming the worker; local-spawn `started` events do
not. `BROKER_REVERSE_WORKER_STRICT=1` fails a start that no worker advertised
instead of falling through to local spawn.

## Reverse worker (`/worker`)

Disabled unless `BROKER_REVERSE_WORKER=1`. A worker authenticates with a
**worker** credential distinct from the controller pairing token, registers a
name and advertised CLIs, and then receives the same `start` / `input` /
`resize` / `stop` commands controllers already send on `/term` and `/agent`,
plus hub-only `detach` on `/term` so the worker can start reconnect grace.
A second authenticated `hello` on the same socket is an error. The worker
replies with the same `{"type":"term"|"agent","kind":...}` events. The
authoritative topology, credential attenuation, reconnect, failure, and
security design is [Reverse-worker mode](reverse-worker.md).

## Compatibility

Version 1 accepts app hello messages that omit `protocolVersion`, preserving
compatibility with the initial SciREPL Pro bridge. New broker welcome and health
responses identify the protocol version so future clients can negotiate changes.
