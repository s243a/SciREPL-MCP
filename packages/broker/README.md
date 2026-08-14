# SciREPL MCP app-connected broker

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
  `BROKER_AGENT=1` after reading the repository
  [security policy](https://github.com/s243a/SciREPL-MCP/blob/main/SECURITY.md).
- Terminal access is **off by default**. `BROKER_TERM=1` can expose a real shell
  on the broker host.
- Use Tailscale Serve or an SSH tunnel for remote access. Do not expose the
  broker directly to the public internet.
- Transport is not currently a privilege signal. Tailscale Serve and an SSH
  forward both reach the loopback listener, and authenticated callers receive
  the same configured endpoint capabilities.
- SciREPL's on-device permissions govern notebook tools; they are not an
  operating-system sandbox for programs spawned on the broker host.

## Requirements

- Node.js 20 or newer; Node.js 22 is recommended.
- SciREPL Pro with its Remote bridge enabled.
- Tailscale Serve, or another private TLS reverse proxy, for an Android phone to
  reach a broker on another device. SSH forwarding is an alternative for a
  desktop MCP client, not a tunnel the Android app creates itself.
- Optional: `node-pty` and a POSIX-like shell for terminal mode.

## Explicit setup

Run setup from the repository root. The default creates a private token and
core-only Bash and PowerShell launchers under `~/scirepl-broker`; it does not
create active agent instructions.

```bash
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP
./setup-broker.sh
~/scirepl-broker/start-broker.sh
```

Setup requires Node.js 20 or newer and fails before writing if the current shell
still points to an older system Node. If you use NVM, run `nvm use 22` first.
Generated launchers retain the exact Node executable that passed this check, so
a later noninteractive shell cannot silently fall back to an older system Node.

Native Windows can prepare and launch the core bridge from PowerShell:

```powershell
./setup-broker.ps1
& "$HOME\scirepl-broker\Start-Broker.ps1"
```

Agent mode requires an explicit acknowledgement that the selected CLI runs on
the broker computer and may have that account's host access:

```bash
./setup-broker.sh \
  --enable-agent \
  --acknowledge-agent-host-access
```

This enables the structured `/agent` chat adapters. It does not enable the
interactive terminal/TUI versions of those agents. Interactive conveniences
such as `!ls`, slash commands, key-driven permission dialogs, and full-screen
interfaces may therefore be unavailable. A permitted SciREPL Bash cell can
still run through notebook MCP tools, but that is not a host-side shell escape.

Terminal mode requires a separate acknowledgement and installs the optional
native dependency:

```bash
./setup-broker.sh \
  --enable-terminal \
  --acknowledge-terminal-host-access
```

Pass both pairs of options to enable both features. Setup refuses a non-empty
unmarked output directory unless `--adopt` is supplied and refuses to replace
changed generated files unless `--repair` is supplied. Run
`./setup-broker.sh --help` for all options.

For the broader remote-agent surface—structured chat plus interactive
terminal/TUI agent choices—enable and acknowledge both agent and terminal mode:

```bash
./setup-broker.sh \
  --enable-agent \
  --acknowledge-agent-host-access \
  --enable-terminal \
  --acknowledge-terminal-host-access
```

Enabling only structured agent mode is also a valid least-privilege choice when
the operator intentionally wants to withhold PTYs, shell escapes, and interactive
host commands. Context files can tell an agent to avoid those capabilities, but
instructions such as `CLAUDE.md` are not an enforcement boundary. Provider-native
tool, sandbox, and approval settings in Claude, Codex, or another CLI are useful
complementary controls; they still do not replace OS isolation when that is
required.

The broker itself is plain ECMAScript and has no compile or bundle step. Default
setup runs `npm ci --omit=optional`. Terminal setup runs the full `npm ci` and
then verifies `node-pty` for the target operating system and CPU by opening a
real PTY. Do not copy `node_modules` between machines. On macOS, setup also
repairs a missing execute bit in `node-pty` 1.1.0's packaged helper before that
smoke test; this repair is platform-guarded and does not alter Linux or Windows
dependency files.

The token is never printed by setup. Display it locally when pairing a device:

```bash
cat "$HOME/scirepl-broker/broker-token"
```

You can instead supply `BROKER_TOKEN` or choose another file with
`BROKER_TOKEN_FILE`. Keep either value secret.

Check the local service:

```bash
curl http://127.0.0.1:8087/health
```

For manual development without generated launchers, run `npm ci --omit=optional`
and `npm start` from this package. Ordinary startup does not materialize active
agent context; see the
[agent-context guide](https://github.com/s243a/SciREPL-MCP/blob/main/docs/agent-context.md).

An already installed package exposes the equivalent `scirepl-mcp-setup`
command. In that layout dependencies were installed by the package manager, so
setup verifies them instead of expecting the source checkout's lockfile.

## Private Android access with Tailscale

Keep the broker bound to `127.0.0.1` and separately configure Tailscale Serve:

```bash
tailscale serve --bg localhost:8087
tailscale serve status
```

Serve supplies the private HTTPS/WSS endpoint. Do not use Tailscale Funnel. The
setup script prints this command but deliberately does not alter the host's
Tailscale configuration.

## Connect SciREPL Pro

In **AI Assistant Settings → Remote bridge**, enter:

- Broker URL: `wss://<your-tailscale-host>/app`
- Pairing token: the contents of the broker token file

For a local development page served over plain HTTP, `ws://127.0.0.1:8087/app`
can be used. The Android app is an HTTPS origin and therefore requires `wss://`
for a remote WebSocket.

### Connection identity and privileges

[Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)
can identify a tailnet user, and Serve strips spoofed inbound copies before
proxying to a localhost backend. Tailscale also offers identity lookup
facilities. The current broker does not consume those headers or assign different
privileges from them. An SSH forward likewise appears to the broker as a loopback
connection.

Consequently, “loopback” means where the proxy or tunnel reached the broker; it
does not prove that the original user was physically local. Capability is
determined by the pairing token plus the explicit agent/terminal feature flags.
Transport-aware authorization—validated Tailscale identity or a distinct SSH
listener/profile—remains a future hardening item. See the
[network section of the security policy](https://github.com/s243a/SciREPL-MCP/blob/main/SECURITY.md#network-and-transport-identity).

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
through a structured, non-PTY adapter. Use the acknowledged `--enable-agent`
setup shown above, then start its generated launcher. Setup materializes notebook
guidance only in its dedicated session workspace. A direct `BROKER_AGENT=1`
launch fails closed when that workspace is not prepared unless the operator
explicitly uses `BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE=1` for self-managed
context. Provider support varies; Claude is the verified persistent adapter,
while the Codex, Gemini, and Agy structured profiles are experimental.

Structured mode is appropriate for prompts and MCP tool calls. If a workflow
depends on terminal syntax such as `!ls`, interactive slash commands, a TUI, or
keyboard responses to CLI prompts, enable terminal mode too.

This is a host-trust decision. Claude supports a broker-supplied tool allowlist;
Codex, Gemini, and Agy may retain their normal ability to read files or run tools
on the host. None of these adapters should be described as an OS sandbox. The
broker passes a restricted environment by default; setting
`BROKER_AGENT_INHERIT_ENV=1` can expose host credentials to spawned processes.

## Optional terminal

Terminal mode requires the optional `node-pty` dependency and exposes a PTY to
the connected app. Use the acknowledged `--enable-terminal` setup shown above.
A terminal-only setup exposes only the `shell` choice. Enabling both features
makes the configured interactive agent/TUI choices available as well as the
structured `/agent` chat adapters. Those interactive modes cannot work without
`node-pty` and a compatible shell.

Use `BROKER_TERM_NO_SHELL=1` to remove the standalone shell option and prevent an
agent from dropping to a shell after it exits. This reduces convenience but does
not turn an agent CLI into a sandbox.

## Platforms

- **Linux and WSL:** supported for the core broker, agent adapters, and optional
  terminal. The current implementation has been exercised directly under WSL.
- **macOS:** supported by the same POSIX paths and tested automatically on a
  GitHub-hosted macOS runner. It has not yet been exercised on a maintainer-owned
  Mac or as a macOS app.
- **Android/Termux:** the core broker is JavaScript and can run under a current
  Termux Node.js package and has been exercised directly in Termux. Build
  `node-pty` on that same device if terminal mode is required. See the
  [platform guide](https://github.com/s243a/SciREPL-MCP/blob/main/docs/platforms.md).
- **Native Windows:** core bridge only. A future Windows terminal profile could
  use `node-pty`/ConPTY with PowerShell, but it is not implemented; use WSL for
  agent and terminal modes today.
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

- [Agent context and explicit workspace setup](https://github.com/s243a/SciREPL-MCP/blob/main/docs/agent-context.md)
- [Controlling a remote coding agent, with supervision](https://github.com/s243a/SciREPL-MCP/blob/main/docs/remote-agent-control.md)
- [Configuration reference](https://github.com/s243a/SciREPL-MCP/blob/main/docs/configuration.md)
- [Wire protocol](https://github.com/s243a/SciREPL-MCP/blob/main/docs/protocol.md)
- [Platform and device builds](https://github.com/s243a/SciREPL-MCP/blob/main/docs/platforms.md)
- [Security model](https://github.com/s243a/SciREPL-MCP/blob/main/SECURITY.md)
- [Extraction provenance](https://github.com/s243a/SciREPL-MCP/blob/main/PROVENANCE.md)

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
recorded in [PROVENANCE.md](https://github.com/s243a/SciREPL-MCP/blob/main/PROVENANCE.md).
Direct dependency licensing is summarized in
[THIRD_PARTY_NOTICES.md](https://github.com/s243a/SciREPL-MCP/blob/main/THIRD_PARTY_NOTICES.md).
