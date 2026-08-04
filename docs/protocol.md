# SciREPL broker protocol

Protocol version: **1**

The broker translates between MCP Streamable HTTP and SciREPL's outbound
WebSocket connection. JSON examples below omit unrelated fields.

## Endpoints

| Endpoint | Transport | Purpose | Default |
|---|---|---|---|
| `/health` | HTTP GET | Version, connection, and enabled-feature status | enabled |
| `/mcp` | MCP Streamable HTTP | External MCP client interface | enabled |
| `/doctor` | HTTP GET/POST | Inspect or explicitly repair the managed agent workspace | enabled, token required |
| `/app` | WebSocket | SciREPL app advertises and executes notebook tools | enabled |
| `/agent` | WebSocket | App chat to a host-side coding-agent CLI | disabled unless configured |
| `/term` | WebSocket | App terminal to a host-side PTY | disabled unless configured |

`/mcp` and `/doctor` use `Authorization: Bearer <token>`. WebSocket endpoints
authenticate in their first JSON `hello` message. An unauthenticated socket is
closed after the configured deadline.

`/health` is intentionally unauthenticated so clients can diagnose reachability
before pairing. It reveals broker/protocol versions, whether the app is connected,
the advertised tool count, and whether agent and terminal features are enabled;
it does not expose tool definitions, notebook data, tokens, or host paths.

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

## Remote agent (`/agent`)

The app first sends:

```json
{ "type": "hello", "token": "<pairing-token>" }
```

When enabled, the broker responds with detected CLI names in both `agents`
(for existing clients) and `availableAgents`, the complete adapter list in
`configuredAgents`, and the protocol version. The app can then send:

```json
{ "type": "start", "agent": "claude" }
{ "type": "input", "text": "Review my notebook" }
{ "type": "stop" }
```

Broker events use `{"type":"agent","kind":...}`. Kinds include `welcome`,
`started`, `assistant`, `tool_use`, `result`, `stderr`, `error`, and `exit`.
Adapter output is normalized, but raw CLI behaviour and privileges remain
provider-specific.

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
feature and is disabled by default.

## Compatibility

Version 1 accepts app hello messages that omit `protocolVersion`, preserving
compatibility with the initial SciREPL Pro bridge. New broker welcome and health
responses identify the protocol version so future clients can negotiate changes.
