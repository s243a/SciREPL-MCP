# Reverse-worker mode

Status: **implemented, default Off**. Protocol version 1. The broker does not
accept worker connections or relay `/agent` or `/term` commands unless it was
started with `BROKER_REVERSE_WORKER=1` after an explicit setup acknowledgement.
An unflagged broker does not create a worker token, does not listen on
`/worker`, and keeps the existing local-spawn paths for `/agent` and `/term`.

## Purpose and boundary

Today the broker is both the hub and the execution host. A controller (the
SciREPL app, `term-drive.mjs`, `agent-drive.mjs`, or another supervisor) speaks
`/term` or `/agent`, and the broker spawns the CLI or PTY on its own machine.
Worker and broker therefore share a host: the same account, the same filesystem,
the same quota, the same sandbox — or the lack of one.

Reverse-worker mode splits that. A small worker-side shim dials **out** to the
broker — the same outbound-client constraint the SciREPL app already uses on
`/app` — registers a name and advertised capabilities, and then takes commands.
The worker runs where its tools, quota, or sandbox live (another machine, a
container, a VM). Controllers and supervisors keep using the broker as the
single hub and keep speaking the same `/term` and `/agent` messages.

This is a **transport swap** behind the existing surfaces, not a third
controller protocol. An existing supervisor or driver script must work
unchanged whether the worker is local-spawned or reverse-connected.

The trust stack remains layered:

- Setup acknowledgement decides whether the broker will be a command-relay hub
  at all.
- The controller pairing token still authenticates every controller surface
  (`/mcp`, `/doctor`, `/app`, `/agent`, `/term`).
- A distinct worker credential authenticates `/worker` only. It authorizes
  "be commanded" — register, receive start/input/resize/stop, send stream
  events back. Nothing else.
- The worker host's own OS account, container, or VM is the execution
  boundary. The broker does not sandbox the worker, and the worker credential
  is not a sandbox.

This design does not make a same-user coding-agent process an operating-system
sandbox. It relocates where that process runs.

## Topology

```text
Controller (app, term-drive, agent-drive, supervisor)
    -- controller pairing token -->  /term  or  /agent
                                         |
                                         v
                                    SciREPL broker
                                      |        |
                     local spawn      |        |  relay (only when a
                     (existing path)  |        |  matching worker is
                                      |        |  connected)
                                      v        v
                                 host CLI    /worker  <-- worker token --
                                             (outbound WS)
                                                 |
                                                 v
                                           worker shim
                                                 |
                                                 v
                                           host CLI / PTY
                                      (tools, quota, sandbox)
```

The SciREPL app's `/app` notebook bridge is unchanged. Reverse mode does not
carry workbook bytes, does not add synthetic MCP tools, and does not touch the
workbook-file-transfer design.

Only one worker is logically active per **name**. Several workers may be
connected under different names. Controllers do not name a worker on the
existing surfaces; the broker selects a connected worker that advertised the
requested CLI. See [Worker selection](#worker-selection).

## Same wire semantics, new transport

Controllers continue to speak the protocol in [protocol.md](protocol.md).

`/term` after an authenticated hello:

```json
{ "type": "start", "cmd": "shell", "cols": 80, "rows": 24 }
{ "type": "input", "data": "echo hello\n" }
{ "type": "resize", "cols": 100, "rows": 30 }
{ "type": "stop" }
```

Broker events remain `{"type":"term","kind":...}` with kinds `welcome`,
`started`, `data`, `exit`, and `error`. Reattachment still uses
`{"kind":"started","cmd":"...","reattached":true}`.

`/agent` after an authenticated hello:

```json
{ "type": "start", "agent": "claude" }
{ "type": "input", "text": "Review my notebook" }
{ "type": "stop" }
```

Broker events remain `{"type":"agent","kind":...}` with kinds `welcome`,
`started`, `assistant`, `tool_use`, `result`, `stderr`, `error`, and `exit`.

The broker's job in reverse mode is to forward those controller messages to a
registered worker and forward the worker's events back, without rewriting
field names or inventing a parallel event vocabulary. A driver that already
handles local-spawn events must not need a reverse-mode branch.

Relayed `started` events carry one extra broker-authored field, `via`, set
to the registered worker name. Local-spawn `started` events do not gain
this field, so an unflagged broker's wire shape is unchanged. Existing
drivers ignore unknown fields; a supervisor that cares where code ran can
assert `via` matches the expected worker. The worker cannot set or spoof
`via` — the broker strips any inbound copy and writes its own.

### When the broker relays versus spawns

On each controller `start`:

1. If reverse-worker mode is off, the existing local-spawn path runs. No
   worker registry is consulted.
2. If reverse-worker mode is on and a connected worker advertised the
   requested surface and CLI, the broker relays. It does not also spawn
   locally for that start. The resulting `started` event includes
   `"via":"<worker-name>"`.
3. If reverse-worker mode is on and no connected worker can handle the
   request:
   - with `BROKER_REVERSE_WORKER_STRICT=1`, the start fails closed with
     an `error` naming the missing advertisement. The broker does not
     spawn locally. This is the right setting when the point of reverse
     mode is that execution must not happen on the broker host.
   - otherwise the existing local-spawn path runs when that surface is
     itself enabled (`BROKER_AGENT=1` / `BROKER_TERM=1`). Otherwise the
     start fails with the same class of `error` event a disabled or
     unknown command already produces.

A session that began on a worker stays on that worker. Mid-session input is
never silently failed over to a local spawn; a dead worker produces an error
(and `exit` on `/term`, `result` or `exit` on `/agent`) rather than a surprise
local process. Strict mode only affects the *start* decision when no worker
is available; it does not change an in-flight reverse session.

`/term` and `/agent` remain the controller-facing endpoints even when local
spawn is off. When reverse mode is on, their `welcome` lists are the union of
any locally configured CLIs and the CLIs advertised by currently connected
workers. A controller that connects before any worker has registered will not
see those CLIs; workers should be connected first. This is the same ordering
constraint as "the app must be connected before MCP tools exist."

## Worker endpoint (`/worker`)

`/worker` is a WebSocket. It exists only when `BROKER_REVERSE_WORKER=1`. When
the flag is off, an upgrade to `/worker` is treated as an unknown path and
the socket is destroyed, identical to any other unrecognised upgrade.

Authentication uses the first JSON `hello`, with the same deadline as `/app`
(`BROKER_WS_AUTH_TIMEOUT_MS`). The hello token must be the **worker**
credential. The controller pairing token is rejected even when it is
otherwise valid. An unauthenticated socket is closed after the deadline.

### Registration hello

Worker to broker:

```json
{
  "type": "hello",
  "token": "<worker-token>",
  "name": "agy-box",
  "capabilities": {
    "surfaces": ["term", "agent"],
    "cmds": ["agy"],
    "agents": ["agy"]
  },
  "sessions": {
    "term": { "live": false },
    "agent": { "live": false }
  }
}
```

Rules:

- `name` is required and must match `^[a-z][a-z0-9_-]{0,63}$`. It is the
  worker's public identity in health, audit, and replacement. It is not a
  hostname and must not be one.
- `capabilities.surfaces` is a non-empty array whose entries are only
  `term` and/or `agent`.
- `capabilities.cmds` lists `/term` command names the worker will accept.
  `capabilities.agents` lists `/agent` adapter names. Each entry must be
  one of the broker's known CLI names (`shell`, `claude`, `codex`,
  `gemini`, `agy`). Version 1 does not accept free-form host paths or
  arbitrary executables as capability strings; that would leak host
  vocabulary onto the unauthenticated health surface and invite confused
  deputies.
- A `term` surface requires at least one `cmds` entry. An `agent` surface
  requires at least one `agents` entry. `shell` is valid only as a `cmds`
  entry, never as an `agents` entry.
- `sessions` is optional and used on reconnect. See
  [Reconnect](#reconnect). Unknown fields are ignored.

Broker acknowledgement:

```json
{ "type": "welcome", "protocolVersion": 1, "name": "agy-box" }
```

A validation or authentication failure sends
`{"type":"error","error":"unauthorized"}` or
`{"type":"error","error":"<validation class>"}` and closes the socket with
code 1008. Error text may name the failed field class (`name`,
`capabilities`, `token`). It must not echo the presented token, a host
path, or a remote address.

### Relay messages

After welcome, the broker sends the controller's command with one added
field, `surface`, so a single worker socket can carry both `/term` and
`/agent` without a third opcode set:

```json
{ "type": "start", "surface": "term", "cmd": "agy", "cols": 80, "rows": 24 }
{ "type": "input", "surface": "term", "data": "echo hello\n" }
{ "type": "resize", "surface": "term", "cols": 100, "rows": 30 }
{ "type": "stop", "surface": "term" }
{ "type": "start", "surface": "agent", "agent": "agy" }
{ "type": "input", "surface": "agent", "text": "Review my notebook" }
{ "type": "stop", "surface": "agent" }
```

The worker replies with the same event objects controllers already consume:

```json
{ "type": "term", "kind": "started", "cmd": "agy" }
{ "type": "term", "kind": "data", "data": "..." }
{ "type": "term", "kind": "exit", "code": 0 }
{ "type": "agent", "kind": "started", "text": "agy" }
{ "type": "agent", "kind": "assistant", "text": "..." }
{ "type": "agent", "kind": "result", "text": "" }
```

The broker forwards those events to the bound controller socket without
changing `type`, `kind`, or payload fields. It may drop an event whose
`type` is not `term` or `agent`, or whose `kind` is not in the documented
set for that surface. It does not interpret CLI output.

Version 1 keeps the broker's existing single-session-per-surface model: at
most one live `/term` session and one live `/agent` session, regardless of
how many workers are connected. Multiplexing many concurrent controller
sessions onto one worker is out of scope.

## Credential model

Two secrets, two jobs.

| Credential | Stored by default | Authenticates | Authorizes |
|---|---|---|---|
| Controller pairing token | `~/scirepl-broker/broker-token` (mode `0600`) or `BROKER_TOKEN` | `/mcp`, `/doctor`, `/app`, `/agent`, `/term` | Drive notebook tools, inspect/repair the prepared workspace, spawn or command workers through the existing surfaces, read `/doctor` |
| Worker token | `~/scirepl-broker/worker-token` (mode `0600`) or `BROKER_WORKER_TOKEN` | `/worker` only | Register under one name, advertise capabilities, receive commands, send stream events |

Attenuation, stated as a bound:

> A worker credential authorizes **be commanded**. It does not authorize
> commanding.

Concretely, a request authenticated with the worker token is rejected on
every controller surface. A request authenticated with the controller
token is rejected on `/worker`. `/health` remains unauthenticated and
must not become a place that distinguishes the two secrets.

Startup fails closed if reverse-worker mode is on and the two secrets are
equal. A single string cannot be both "drive the hub" and "be commanded
by the hub"; treating it as either would collapse the attenuation.

The worker token is created only when reverse-worker mode is enabled
(setup, or first runtime start with `BROKER_REVERSE_WORKER=1` and no
`BROKER_WORKER_TOKEN`). An unflagged broker never creates that file.

Rotate either secret by stopping the broker, replacing the corresponding
file, and updating every client that holds it. Rotating the worker token
does not require rotating the controller token, and the reverse.

## Identity, uniqueness, and health

The worker's identity is its registered `name`. Health and audit use that
name. They do not use the TCP peer address, `Host` header, Tailscale
identity (the broker still does not consume Serve headers), hostname,
username, pid, or working directory.

`GET /health` remains unauthenticated. When reverse-worker mode is off it
gains only `reverseWorkerEnabled: false`, matching how `agentEnabled` and
`termEnabled` already report disabled privileged features. When the mode
is on it also reports the connected workers:

```json
{
  "reverseWorkerEnabled": true,
  "workers": [
    {
      "name": "agy-box",
      "surfaces": ["term", "agent"],
      "cmds": ["agy"],
      "agents": ["agy"]
    }
  ]
}
```

The list is registration metadata only. It must not include hostnames,
addresses, pids, paths, token fingerprints, or session transcripts.
`/doctor` is unchanged: it describes the broker host's prepared workspace,
not remote workers.

### One worker per name

A second hello with an already-connected name is **rejected** with
`worker name is already connected` for as long as that name's socket is
still open. Connection age and a `sessions` live claim are not permission
to replace it: two real shims with the same name must not interrupt an
active session. There is no securely verifiable reconnection identity in
version 1, so the hub fails closed while the existing socket is open.

A dropped socket that later redials is a new registration for that name.
If the previous socket has already closed:

- The new hello is accepted. Health still shows one entry for that name.
- In-flight controller sessions that still pointed at the dead worker are
  treated as a worker disconnect (see [Failure modes](#failure-modes))
  unless the new hello's `sessions` object claims the corresponding
  surface is still live. A live claim rebinds the existing controller
  session to the new socket; the next controller `start` is forwarded and
  the worker may answer `reattached: true`.
- The previous (already-closed) socket is not a live session to steal.
  The close reason `replaced by a new worker connection` is reserved for
  that unregister race, not for kicking a still-open peer.

Different names may advertise the same CLI. Controllers using the existing
surfaces cannot choose among them.

### Worker selection

When a controller `start` names a CLI and more than one connected worker
advertised it, version 1 selects the worker with the oldest successful
registration. The choice is deterministic and is written to the audit
line. A later `start` reuses that worker only when the requested CLI is
unchanged and that worker still advertises it. `stop` forwards `stop` and
**clears** the reverse session, so the next `start` selects again among
currently connected workers. Switching CLIs without an explicit `stop`
also stops the previous reverse session before selecting.

`/agent` has one surface-wide placement and one owner controller. A
locally ready one-shot session (no child yet) occupies the surface the
same way a running child does: another controller cannot start a
simultaneous reverse session, and inputs never fall through from a bound
reverse worker to a newly started local child. Explicit `/agent` `stop`
releases that ownership and deactivates the adapter; a later `input`
fails until `start`. Resume identifiers are stored separately, keyed by
agent name, so switching providers cannot reuse the wrong session.
`/term` stays local while a PTY is already running. Reverse mode must not
create a second live session beside a local one.

Operators who need a specific machine should give that worker a
unique advertised CLI, or run one worker name per broker. Explicit
controller-side worker addressing would be a protocol change and is
rejected in version 1 so existing drivers stay unmodified.

## Reconnect

Precedent is `/app`: the client dials out again, presents the same
credential, and the new socket becomes the logical connection. Pending
work on the old socket is not silently continued without an explicit live
session claim.

| Who dropped | What is preserved | What the other side sees |
|---|---|---|
| Controller `/term` disconnect, worker still connected | The worker keeps its PTY for the shim's `--grace-ms` (default 600000). `--grace-ms 0` stops the PTY immediately. The broker forwards `{type:"detach",surface:"term"}` so the shim **starts** that grace timer (or cleanup). It does **not** forward `stop`. | Next controller `start` is relayed; if grace has not expired the worker answers `started` with `reattached: true` and nudges a redraw, matching local `/term`. After expiry (or with zero grace) the next `start` is a new spawn. |
| Controller `/agent` disconnect, worker still connected | Nothing. Local `/agent` already kills the child on controller close; reverse mode forwards `stop` so the semantics match. | Worker stops the CLI. A later `start` is a new session (CLI resume flags still apply on the worker host if the adapter supports them). |
| Worker disconnect, controller still connected | The worker shim keeps a live PTY across its own reconnect for the same grace period. It **kills** `/agent` children on socket close so they cannot outlive the controller's error/result. The broker does not keep a PTY. | The broker sends `error` then `exit` (term) or `error` then `result` (agent) to the bound controller. The controller must `start` again. If the reconnected worker claims `sessions.term.live`, that later `start` may reattach. |
| Broker process restart | Nothing in the broker. The worker shim reconnects with backoff and re-registers. A still-live PTY is advertised in `sessions`. | Controllers reconnect as they do today. A `start` after both sides are back is a reattach if the shim preserved the process. |
| Both die | Nothing. | Fresh registration, fresh `start`. |

The shim reconnects with exponential backoff (1s, 2s, 4s, … capped at
15s) and resets the backoff after a session that reached `welcome` (close
after welcome is a completed session, not a failed handshake). Being
replaced by another worker is treated as a failed session so backoff
grows instead of immediately redialing. A second authenticated `hello`
on the same `/worker` socket is rejected with `already authenticated`;
it does not register another name. Outbound worker frames that exceed
the 1 MiB `bufferedAmount` cap close the socket with code 1013, matching
the hub. Caps that are not safe integers (`NaN`, `Infinity`) are
rejected at shim startup. After welcome the hub sends WebSocket pings
every 15s and terminates a worker that does not pong within 30s, so a
half-open TCP session cannot occupy a name forever. That is a bounded
liveness check, not an application-level heartbeat protocol.

`/app` replacement of a still-open previous socket is **not** the model
for `/worker`. A second worker hello with the same name while the first
socket is still up is rejected. A dropped socket that later redials is
accepted because the previous socket is gone; a `sessions` live claim may
then rebind a surviving controller session. Version 1 has no signed
reconnect identity that would make kicking a live socket safe.

## Audit continuity

The supervision pattern's claim is that every action is prompted, logged,
and attributed. Reverse mode must not break that claim by making the
broker's existing start/stop trail point at the wrong host or at nobody.

The broker's audit trail is the same `[broker]` stdout it already uses for
local spawns. Reverse mode adds attribution; it does not invent a second
log format and it does not change the text of local-spawn lines.

Local (unchanged):

```text
[broker] term 'agy' started (pid 1234)
[broker] agent 'agy' ready (one-shot per turn)
```

Reverse:

```text
[broker] worker 'agy-box' connected surfaces=term,agent cmds=agy agents=agy
[broker] term 'agy' start requested via worker 'agy-box'
[broker] term 'agy' started via worker 'agy-box'
[broker] term 'agy' reattached via worker 'agy-box'
[broker] term 'agy' stop requested via worker 'agy-box'
[broker] agent 'agy' start requested via worker 'agy-box'
[broker] agent 'agy' ready via worker 'agy-box'
[broker] agent 'agy' reused via worker 'agy-box'
[broker] agent 'agy' stop requested via worker 'agy-box'
[broker] worker 'agy-box' replaced
[broker] worker 'agy-box' disconnected
```

Rules:

- Relayed start **request**, successful start/reattach/ready/reused (when the
  worker acknowledges `started`), stop **request**, worker connect, replace, and
  disconnect are logged, attributed to the worker `name`. The broker does
  not log `started` before the worker has launched or reattached anything,
  and it does not log `stopped` without an acknowledgement it does not
  have. Audit lines interpolate only validated worker names and known CLI
  tokens from the controller request; worker-supplied `cmd`/`text` is never
  copied into `[broker]` stdout.
- Input bytes, PTY data, assistant text, and prompts are not logged by
  the broker. They never were on the local path. The supervisor's own
  decision log remains the place those appear, exactly as
  [remote-agent-control.md](remote-agent-control.md) already requires.
- Host details (pid, path, peer address) are omitted from reverse-mode
  lines. Local-spawn lines may still mention a local pid because that
  process is on the broker host; a reverse pid would be a lie or a leak.
- A stolen worker credential that impersonates a name produces audit
  lines under that name. The trail attributes actions to the registered
  identity, not to proof of possession of a particular machine. This is
  the same honesty the pairing token already has ("whoever held the
  token") and is why revocation speed still matters.

## Startup configuration

Configuration follows the broker's environment-variable convention. The
setup acknowledgement is the operator-facing enablement; the environment
variable is what the generated launcher actually sets, matching agent and
terminal mode.

```text
BROKER_REVERSE_WORKER=1
BROKER_WORKER_TOKEN_FILE=/absolute/path/to/worker-token
```

| Variable | Default | Purpose |
|---|---:|---|
| `BROKER_REVERSE_WORKER` | `0` | Set to `1` to accept `/worker` connections and relay matching `/agent` and `/term` starts. |
| `BROKER_REVERSE_WORKER_STRICT` | `0` | When reverse-worker mode is on, set to `1` to fail a `start` that no connected worker advertised, instead of falling through to local spawn. Read only when reverse-worker mode is on. |
| `BROKER_WORKER_TOKEN` | unset | Explicit worker credential. When set, it takes precedence over the worker token file. |
| `BROKER_WORKER_TOKEN_FILE` | `~/scirepl-broker/worker-token` | Persistent worker-token location. Created with mode `0600` where supported, only when reverse-worker mode is on and `BROKER_WORKER_TOKEN` is unset. |
| `BROKER_MAX_WORKER_WS_PAYLOAD_BYTES` | `1048576` | Maximum inbound `/worker` message payload. Read only when reverse-worker mode is on, so an unflagged broker ignores a typo here. |

Setup flags, in the existing pair style:

```text
--enable-reverse-worker
--acknowledge-reverse-worker-command-relay
```

The acknowledgement names the load-bearing risk: the broker becomes a
**command-relay hub**. Controllers will send the same privileged `/agent`
and `/term` messages they send today, and this broker will forward them
to whoever authenticated as that worker. The worker host executes them.
Setup refuses `--enable-reverse-worker` without the acknowledgement, the
same way it refuses `--enable-agent` without
`--acknowledge-agent-host-access`.

Setup writes `BROKER_REVERSE_WORKER=1` and `BROKER_WORKER_TOKEN_FILE` into
the generated broker launcher and creates a worker token distinct from
the pairing token. It writes `worker-enroll.txt` describing how to copy
that token to **another** account, container, or host and run the shim
there with the capabilities that host actually has. The example uses
`node scripts/reverse-worker.mjs` (not this broker's Node path or
checkout) and an `--agents <cli-this-host-has>` placeholder rather than a
hardcoded CLI. `--worker-url` bakes in a reachable `ws://` or `wss://` URL
ending in `/worker`; loopback binds otherwise write a `BROKER_HOST`
placeholder. It does **not** generate a same-host
`start-reverse-worker.sh` beside `broker-token`. Upgrading a directory
from the old same-host layout (commit `b3f8f99`: marker lists
`start-reverse-worker.sh` / `Start-Reverse-Worker.ps1`, no
`worker-enroll.txt`) **requires `--repair`**. Without it, setup refuses so
it cannot retire those launchers or rotate the worker token. With
`--repair` it disables the leftover launchers and rotates the worker
token; stop any old shim and restart the broker so the previous token is
no longer accepted. It does **not**
create a workspace or advertise terminal support merely because reverse
mode is on. Worker installation is separate; `node-pty` is a worker-host
dependency when `--surfaces` includes `term`, and the shim smoke-checks
the native module before advertising terminal support.

It does **not** imply `BROKER_AGENT=1` or `BROKER_TERM=1`. Those flags
still mean "this broker may spawn locally." Reverse-only enablement is a
valid least-privilege choice: the hub relays, the worker host executes,
the broker host does not grow a PTY. IPv6 example URLs are bracketed
(`ws://[::1]:8087/worker`).

Native Windows setup rejects reverse-worker mode for the same reason it
rejects agent and terminal mode: the shim's process conventions are
POSIX. Use WSL.

Unset `BROKER_REVERSE_WORKER` means disabled. Explicit but invalid
configuration (empty worker token, worker token equal to the controller
token, invalid payload cap) fails broker startup. It never degrades to
"accept the controller token on `/worker`" or silently disables the mode.

## Worker shim

`packages/broker/scripts/reverse-worker.mjs` is the worker-side counterpart
of `term-drive.mjs`: a small `ws` client. CLI children are launched with
the broker's `cross-spawn` helper so Windows npm `.cmd` shims run without
`shell:true`. Optional `node-pty` is still required for `/term`, the same
optional dependency the broker already uses.

```bash
node packages/broker/scripts/reverse-worker.mjs \
  --url ws://HOST:8087/worker \
  --token-file ~/scirepl-broker/worker-token \
  --name agy-box \
  --surfaces term,agent \
  --cmds agy \
  --agents agy \
  --cwd /path/to/target-repo
```

It connects out, sends the registration hello, supervises a local CLI or
PTY on `start`, relays streams, and on socket drop keeps a live PTY for
the terminal grace period while it reconnects. Welcome does **not** cancel
that grace; a later `start` does (reattach). `/agent` children are sent
`SIGTERM` then `SIGKILL` (process group on POSIX, `taskkill /t /f` on
Windows) when the worker link drops, and adapter `sessionId` is cleared
so a later CLI cannot resume unrelated context. Process-group `SIGKILL`
is scheduled independently of the group leader's exit so a descendant
that ignores `SIGTERM` is still reaped. Persistent `started` is
emitted only after the OS `spawn` event. Session preservation is the
shim's job for `/term` only. The shim defaults to `--surfaces agent` and
PATH-detected agents; it does not advertise `term` or every CLI unless
asked, and it refuses `term` unless `node-pty` loads and a throwaway PTY
spawn succeeds. Hub-to-worker
`detach` is the signal to start term grace; controllers never send it.

Child processes get a restricted environment by default (the same class of
allowlist as local spawn: `HOME`, `PATH`, locale, temp dirs, XDG). On
Windows the shim also preserves and canonicalizes `Path`/`PATH` and
`PATHEXT` (plus `SystemRoot` / `ComSpec` needed to launch `.cmd`) without
inheriting provider secrets. That
is enough for interactive `/term` logins that authenticate from config
files. One-shot `/agent` adapters that authenticate from the environment
need an explicit opt-in, matching the broker's local flags:

- `--use-api-key` (or `BROKER_AGENT_USE_API_KEY=1`) passes
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and
  `GOOGLE_API_KEY` when they are set in the shim's own environment.
- `--inherit-env` (or `BROKER_AGENT_INHERIT_ENV=1`) passes the shim's
  complete environment. This may disclose secrets on the worker host.

The shim still does **not** inject the controller pairing token or the
broker's `SCIREPL_MCP_BEARER`. See [Notebook MCP from a reverse
worker](#notebook-mcp-from-a-reverse-worker).

### Notebook MCP from a reverse worker

Local spawn currently points a child CLI at `http://127.0.0.1:<port>/mcp`
with the controller pairing token. On a remote worker host that address
is the worker machine, and placing the controller token there would
collapse token separation for that host.

Version 1 therefore does **not** automatically wire worker-side CLIs to
the broker's `/mcp`. A worker that needs notebook tools must reach `/mcp`
through an operator-provided tunnel and a **controller-class** credential
the operator chose to store on the worker host. That is a deployment
choice, not a property of the worker token. The worker token remains
unable to call `/mcp`. The primary supervised path — `/term` against a
CLI that already has its tools and a git workspace on the worker host —
does not require this loop.

## Failure modes

### Worker dies mid-turn

The `/worker` socket closes. The broker logs
`worker '<name>' disconnected`, sends the bound controller an `error`
whose text names the worker identity and the class (`worker disconnected`),
then sends `exit` on `/term` or `result` (empty text) on `/agent` so
existing drivers unblock. It does not spawn locally to finish the turn.

If the shim process died, the PTY died with it. A new shim under the same
name is a fresh worker; `sessions.*.live` must be false. A later
controller `start` begins a new process.

If only the network died and the shim is still running, the shim
reconnects, claims `sessions.term.live` when the PTY survived, and a
later `start` reattaches.

### Broker restarts

In-memory registry and controller bindings are gone. The shim's reconnect
loop re-registers. Controllers reconnect with the same hello they already
use. A `/term` `start` after both are back is a reattach if the shim
preserved the PTY; otherwise it is a new spawn on the worker host. Audit
lines after the restart are a new process's stdout; operators who need a
durable trail already redirect broker logs.

### Both die

No session, no PTY, no registry. The next healthy pair (shim hello, then
controller `start`) is a new session. CLI-native resume (`agy -c`,
`claude --resume`) may still reconstruct provider conversation state on
the worker host; that is the adapter's feature, not the broker's.

### Worker never connects

Controllers see the ordinary welcome for whatever local surfaces are
enabled. A `start` for a CLI that is only advertised by an absent worker
fails closed under `BROKER_REVERSE_WORKER_STRICT=1`. Without strict mode
it fails the same way an unknown or missing local CLI already fails, or
falls through to local spawn when that path is enabled and the CLI is
present on the broker host. Fall-through is visible on the wire: a
local-spawn `started` event has no `via` field.

### Malformed or oversized worker frames

`/worker` uses the same payload cap class as `/agent` and `/term` (default
1 MiB), the same authentication deadline, and the same per-endpoint
connection cap. Oversized or protocol-broken sockets are closed without
crashing the broker, matching the existing unauthenticated-frame
hardening.

## Security: what this mode adds for an attacker holding each credential class

These notes use the same honesty bar as
[remote-agent-control.md](remote-agent-control.md) and [SECURITY.md](../SECURITY.md).
They are not a substitute for a review proportional to what the
deployment protects.

The bound that still governs the whole ladder:

> A secret's confidentiality is limited by the most-exposed principal that
> legitimately reads it.

Reverse mode adds a second principal (the worker host) and a second
secret (the worker token). That is a real expansion of the trust
universe, which is why the mode is default Off and acknowledged.

### Attacker holds the controller pairing token

The ceiling is unchanged in kind and larger in location. They can still
drive `/term` and `/agent`, call `/mcp`, and read `/doctor`. If a reverse
worker is connected, those commands now execute on the **worker host**,
not (or not only) on the broker host. Blast radius follows the worker's
account, filesystem, and network — which is the point of the mode, and
also the new harm. They cannot register a worker or impersonate one
without the worker token.

Defence-in-depth that still applies: bind the broker to loopback and
reach it through a tailnet or SSH tunnel; restrict `BROKER_TERM_CMDS` /
worker-advertised cmds so the PTY can only become the intended CLI; keep
the pairing token in a `0600` file; rotate on suspicion. Restricting the
terminal to one agent CLI remains friction, not a sandbox: a determined
controller-token holder can still drive that CLI and approve its prompts.

### Attacker holds the worker token

They can dial `/worker` and register a **free** name. A second hello for
a name whose socket is still open is rejected; the token is not
permission to kick a live same-name worker. That is enough to:

- **Receive** every `/term` and `/agent` command the broker would have
  relayed to that name, including task text and keystrokes that answer
  permission prompts.
- **Forge** the event stream the controller sees: fake `assistant` /
  `data` / `result` events, or run a different executable than the one
  advertised. They cannot drop a still-connected worker of the same name.
- **Do nothing else on the hub.** They cannot call `/mcp`, read or repair
  `/doctor`, connect as the app on `/app`, or drive `/term` and `/agent`
  as a controller. Workbook-transfer tools, if they are ever implemented,
  remain controller-authenticated and are out of this credential's scope.

They cannot, with this token alone, spawn a process on the broker host.
The worker token is not a remote-shell credential for the hub; it is a
remote-shell *target* credential. The damage on the worker host is
whatever the attacker's own process does there — they already have a
process that can present the token.

The distinctive hub-side harm is **impersonation of a commanded worker**:
a supervisor believes it is driving `agy-box` and is instead driving the
attacker. Audit lines will say `via worker 'agy-box'`, and relayed
`started` events will carry `"via":"agy-box"`.

The highest-value form of that impersonation is **live-session rebind
after the legitimate socket has dropped**. A second hello cannot kick a
still-open worker of the same name, even with a `sessions` live claim.
Once the previous socket is gone, a redial that claims
`sessions.term.live` (or `sessions.agent.live`) inherits the in-flight
controller session: the broker rebinds the existing controller socket to
the new worker and does **not** send the controller a disconnect. The
controller keeps talking to what it thinks is the same PTY. Anyone
holding the worker token can do this after a disconnect — it is how a
legitimate shim reconnects after a network blip, and it is how a token
thief slides into a live supervised turn if they win the reconnect.
Forging a fresh `started` stream after the
controller has to `start` again is noisier; this path is quiet. The
bound is still the worker token, not host identity. Revocation is
delete-the-worker-token-file and restart, the same "seconds, one person"
shape as the pairing token. Until then, treat any worker that connected
after a suspected leak as untrustworthy, including one that presents the
expected name and a live-session claim.

### Attacker holds both

They have the current pairing-token ceiling plus the ability to plant a
worker. This is the collapse case. Rotate both secrets. The
acknowledgement exists so operators notice they are holding two secrets
before the first leak.

### Attacker holds neither, but can reach `/health` or `/worker`

`/health` grows a worker-name and capability list. That is intentional
reachability diagnosis and a small information bump: an unauthenticated
client learns that reverse mode is on and which CLI names are currently
commandable. It does not learn tokens, hosts, or paths. Do not put
sensitive strings in worker names.

`/worker` without the worker token closes like any other failed hello.
The endpoint's mere existence (when the flag is on) is a new
unauthenticated handshake surface; the same deadline, payload cap, and
connection cap apply. When the flag is off the path is not registered.

### What this mode does not claim

- It does not authenticate the worker host, only possession of the worker
  token. Tailscale identity headers are still not consumed.
- It does not encrypt beyond whatever the operator already uses to reach
  the broker (Tailscale Serve, SSH, loopback). The worker hello carries
  the worker token in JSON, as `/app` already carries the pairing token.
- It does not prevent a controller-token holder from approving a worker's
  permission prompts. Supervision policy still lives in the controller.
- It does not keep workbook or `/mcp` powers out of a worker host if the
  operator copies the controller token there to wire notebook tools.
- It does not survive a malicious worker that lies about its
  capabilities. Advertised `cmds` are a routing key, not a remote
  attestation.

The honest security claim is the supervision claim, surviving the
topology change: **every relayed action is still prompted on the
controller-facing surface, logged on the broker with a worker identity,
and reversible on the worker's git workspace when the operator pointed
the shim at one.** Attackers who hold a token can still act. They cannot
act without leaving that trail, and they cannot turn a stolen worker
token into a controller.

## Tests

Implementation covers at least:

- `/worker` absent (upgrade destroyed) when the flag is off;
- worker token rejected on `/mcp`, `/doctor`, `/app`, `/agent`, and
  `/term`;
- controller token rejected on `/worker`;
- equal secrets refused at startup;
- registration welcome, health listing without host fields, one-name
  occupancy (a second connection for a live name is rejected even with a
  live-session claim; a redial is accepted only after the previous socket
  has closed);
- `/term` and `/agent` relay round-trips with the documented message
  shapes, including a broker-authored `via` on `started` that the worker
  cannot spoof;
- `BROKER_REVERSE_WORKER_STRICT=1` fails a start that no worker
  advertised, instead of local spawn;
- worker disconnect unblocks the controller; reconnect plus a new
  `start` can reattach when `sessions.term.live` is claimed;
- an existing driver script (`term-drive.mjs`, and `/agent` equivalently)
  against a reverse worker, unmodified;
- setup refuses `--enable-reverse-worker` without
  `--acknowledge-reverse-worker-command-relay`, writes a worker token
  distinct from the pairing token, writes `worker-enroll.txt` rather than
  a same-host worker launcher, accepts `--worker-url`, writes a
  `BROKER_HOST` placeholder for loopback binds, and on upgrade of a real
  old same-host layout requires `--repair` before disabling leftover
  launchers and rotating the worker token;
- `stop` then `start` of a different advertised CLI selects a matching
  worker instead of reusing the previous session;
- a second authenticated `hello` on one `/worker` socket is rejected
  without registering another name;
- a second connection for an already-live worker name is rejected while
  that socket is open, including when the new hello claims a live session;
- controller `/term` disconnect forwards `detach` so shim grace starts;
  `--grace-ms 0` stops immediately; an expired grace does not reattach;
- CLI children are launched through the production `cross-spawn` helper
  (native `.cmd` on Windows; PATH commands everywhere) without `shell:true`;
- persistent NDJSON, one-shot NDJSON, and plain-text children finalize
  after stdout/stderr close, including when a grandchild writes after the
  parent exits; late stderr cannot leak into the next session;
- signaling the shim waits for process-tree termination before exit;
- a locally ready one-shot `/agent` session occupies the surface so a
  second controller cannot start a simultaneous reverse session, and
  inputs stay on the bound reverse worker;
- explicit local `/agent` `stop` releases ownership for both one-shot and
  persistent adapters so another controller can start immediately, while
  parked resume identity is not reused across providers;
- audit lines ignore worker-supplied `cmd`/`text` and log stop as
  requested rather than completed.

Use a protocol-level fake worker for auth, relay, reconnect, and driver
compatibility so core CI without `node-pty` still proves the transport
swap. Exercise the real shim against a shell PTY when `node-pty` is
present.

## Recommendation

Keep the default Off. Enable reverse-worker mode when the CLI must run
somewhere the broker must not: a sandboxed container, a machine with the
provider quota, a VM that holds the target git checkout. Leave it off
when broker and worker already share a host — local spawn is fewer
moving parts and one fewer secret.

Use the existing supervision policy against the same `/term` surface.
Point the shim's `--cwd` at a git repository on the worker host. Do not
copy the controller token onto the worker host unless that host must
call `/mcp`, and treat that copy as a second controller-class secret.

Implement controller-addressable worker names, concurrent sessions per
surface, or attested host identity only if a deployment actually needs
them; each is a protocol change and would break the "existing driver
unmodified" requirement that justifies this mode.
