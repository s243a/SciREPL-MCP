# SciREPL MCP

SciREPL MCP is the auditable, host-side companion for **SciREPL Pro**. It lets
an Android or browser notebook connect outward to a computer running the broker,
then exposes the notebook's approved tools to an MCP client.

This repository contains the broker source. It does **not** contain the closed
SciREPL Pro Android application, and possessing this source does not reproduce
the APK. Keeping the broker public allows users to inspect the network-facing
component, build its optional native dependency on their own device, and run it
on infrastructure they control.

```text
MCP client  -- HTTP /mcp -->  SciREPL MCP  <-- WebSocket /app --  SciREPL Pro
                                      |
                                      +-- optional /agent --> coding-agent CLI
                                      +-- optional /term  --> local PTY/shell
```

## Security at a glance

- The broker binds to `127.0.0.1` by default.
- A 128-bit pairing token is required on every control and data endpoint. The
  intentionally public `/health` endpoint exposes only versions, feature flags,
  app connection state, and tool count. By default the token is generated once
  and stored at `~/scirepl-broker/broker-token` with mode `0600`.
- Remote-agent spawning is **off by default**. Enable it only with
  `BROKER_AGENT=1` after reading [SECURITY.md](SECURITY.md).
- Terminal access is **off by default**. `BROKER_TERM=1` can expose a real shell
  on the broker host.
- Use Tailscale Serve or an SSH tunnel for remote access. Do not expose the
  broker directly to the public internet.
- SciREPL's on-device permissions govern notebook tools; they are not an
  operating-system sandbox for programs spawned on the broker host.

## Requirements

- Node.js 20 or newer; Node.js 22 is recommended.
- SciREPL Pro with its Remote bridge enabled.
- Tailscale or SSH when the phone and broker are not on the same trusted host.
- Optional: `node-pty` and a POSIX-like shell for terminal mode.

## Install from source

```bash
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP
npm ci
npm test
```

For the core MCP bridge without terminal support or native compilation:

```bash
npm ci --omit=optional
```

Do not copy `node_modules` between machines. `node-pty` contains native code and
must be built or installed on the target operating system and CPU architecture.

## Start the broker

```bash
npm start
```

The first start creates a persistent token file. Display it when pairing a
device:

```bash
cat "$HOME/scirepl-broker/broker-token"
```

You can instead supply `BROKER_TOKEN` or choose another file with
`BROKER_TOKEN_FILE`. Keep either value secret.

Check the local service:

```bash
curl http://127.0.0.1:8087/health
```

## Connect SciREPL Pro

In **AI Assistant Settings → Remote bridge**, enter:

- Broker URL: `wss://<your-tailscale-host>/app`
- Pairing token: the contents of the broker token file

For a local development page served over plain HTTP, `ws://127.0.0.1:8087/app`
can be used. The Android app is an HTTPS origin and therefore requires `wss://`
for a remote WebSocket.

## Connect an MCP client

Point a Streamable HTTP MCP client at:

```text
https://<your-tailscale-host>/mcp
Authorization: Bearer <pairing-token>
```

For example, with Claude Code:

```bash
claude mcp add --transport http scirepl \
  https://<your-tailscale-host>/mcp \
  --header "Authorization: Bearer <pairing-token>"
```

The tools advertised by the connected app then appear under the `scirepl` MCP
server. If no app is connected, the broker has no notebook tools to advertise.

## Optional remote-agent chat

The `/agent` endpoint lets the SciREPL Pro panel converse with a coding-agent CLI
installed on the broker host:

```bash
BROKER_AGENT=1 npm start
```

This is a host-trust decision. Claude supports a broker-supplied tool allowlist;
Codex, Gemini, and Agy may retain their normal ability to read files or run tools
on the host. None of these adapters should be described as an OS sandbox. The
broker passes a restricted environment by default; setting
`BROKER_AGENT_INHERIT_ENV=1` can expose host credentials to spawned processes.

## Optional terminal

Terminal mode requires the optional `node-pty` dependency and exposes a PTY to
the connected app:

```bash
BROKER_TERM=1 npm start
```

Use `BROKER_TERM_NO_SHELL=1` to remove the standalone shell option and prevent an
agent from dropping to a shell after it exits. This reduces convenience but does
not turn an agent CLI into a sandbox.

## Platforms

- **Linux, macOS, and WSL:** supported for the core broker. WSL is recommended
  over native Windows for terminal and agent modes because those paths currently
  assume POSIX shell behaviour.
- **Android/Termux:** the core broker is JavaScript and can run under a current
  Termux Node.js package. Build `node-pty` on that same device if terminal mode is
  required. See [docs/platforms.md](docs/platforms.md).
- **Other devices:** install Node.js locally, clone the repository, and run
  `npm ci --omit=optional` first. Add `node-pty` only after the core bridge works.

## Data flow and telemetry

The broker itself sends no analytics or telemetry. Notebook tool definitions,
arguments, and results travel between SciREPL and the selected MCP client over
the network path you configure. If that client—or an agent CLI launched through
`/agent` or `/term`—uses a hosted model, it may send prompts and selected notebook
content to that model provider under the client's settings and the provider's
terms. The broker cannot make a third-party model service "on-device."

## Documentation

- [Configuration reference](docs/configuration.md)
- [Wire protocol](docs/protocol.md)
- [Platform and device builds](docs/platforms.md)
- [Security model](SECURITY.md)
- [Extraction provenance](PROVENANCE.md)

## Tests

```bash
npm test                  # deterministic broker/auth/image tests; PTY test skips if unavailable
npm run test:broker
npm run test:term
```

Real-agent tests are opt-in because they invoke locally installed CLIs and may
consume a subscription or API allowance:

```bash
RUN_AGENT_E2E=1 npm run test:agent
RUN_AGENT_E2E=1 npm run test:session
RUN_AGENT_E2E=1 npm run test:oneshot
RUN_AGENT_E2E=1 npm run test:oneshot:notebook
```

Browser-to-app integration tests remain in the SciREPL Pro repository because
they require the complete app and its `ToolCore` implementation.

## License

MIT. See [LICENSE](LICENSE). The initial extraction and source boundary are
recorded in [PROVENANCE.md](PROVENANCE.md). Direct dependency licensing is
summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
