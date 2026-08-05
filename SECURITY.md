# Security policy and threat model

SciREPL MCP is a local, single-user bridge. It is not designed as a public,
multi-tenant service.

## Supported deployment

The supported security boundary is:

1. The broker listens on loopback (`127.0.0.1`).
2. Remote traffic reaches it through a private Tailscale tailnet or an SSH
   tunnel that the user controls.
3. Every control and data endpoint requires the pairing token. `/health` is an
   unauthenticated status endpoint exposing broker/protocol versions, enabled
   feature flags, app connection state, and the advertised tool count.
4. The user trusts the computer running the broker and the software launched on
   that computer.

Do not use `BROKER_HOST=0.0.0.0`, Tailscale Funnel, a public reverse proxy, or a
public tunnel unless you have added a separate internet-facing security layer.
The pairing token alone is not intended to make this a public service.

## Network and transport identity

Tailscale can distinguish tailnet users. In particular,
[Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)
can identify the user while Serve strips inbound copies before forwarding to a
localhost service, and Tailscale exposes identity lookup facilities. The current
broker does not validate or authorize from that identity.

Both Tailscale Serve and SSH port forwarding normally present their connection
to the broker as loopback. A loopback source therefore identifies the local
proxy/tunnel endpoint, not necessarily the original person or device. The broker
does not currently have “local” and “remote” privilege tiers: the pairing token
authenticates the connection, while `BROKER_AGENT` and `BROKER_TERM` determine
which higher-capability endpoints exist.

The setup tool requires `--allow-non-loopback` when it is asked to generate a
raw non-loopback launcher, but direct use of `BROKER_HOST` remains an advanced
runtime bypass. That acknowledgement is not transport verification and does not
supply TLS/WSS. A future hardening mode should validate Tailscale identity or use
a distinct, explicitly configured SSH listener/profile before assigning any
transport-dependent privileges.

## Capabilities

### Core MCP bridge

`/mcp` forwards calls to the connected SciREPL app through `/app`. Notebook
reads, writes, and execution are then governed by the app's own permission
settings. Those settings protect the notebook; they do not control the broker
host.

### Playwright driver

The Playwright package is a stdio MCP server and does not listen on a network
port itself. It trusts the MCP client that launches it and inherits the host
account's operating-system permissions. Its tools intentionally can:

- navigate Chromium to a user-selected URL and control the resulting page;
- read host files named in workbook import, local-package, and VFS-overlay
  requests;
- enumerate host directories selected for a VFS overlay;
- write screenshots and workbook downloads to host paths;
- automatically accept JavaScript dialogs; and
- control the complete browser profile supplied through a CDP connection.

Use a dedicated browser profile and a minimally privileged host account. Do not
attach it to a personal browsing session or expose the launching MCP client to
untrusted users. The settings tool redacts values whose names indicate API keys,
tokens, credentials, passwords, secrets, or profiles. This reduces accidental
disclosure but is not a sandbox: an authorized JavaScript-kernel call still
controls the SciREPL page.

Android WebView control is not yet implemented by this package. A future ADB
attachment mode requires a debuggable APK, which expands the application attack
surface for computers authorized through ADB. Production/Play builds should keep
WebView debugging disabled. A separately identified debug build should be used
only on a development device or profile and should not share sensitive notebook
data with the release app.

### Remote agents

`/agent` is disabled unless `BROKER_AGENT=1` is set. Enabling it permits an
authenticated app user to start an installed coding-agent CLI on the broker
host.

- Claude can receive a tool allowlist, but that is a CLI policy rather than an
  operating-system sandbox.
- Codex, Gemini, and Agy may retain their normal host-side tools and filesystem
  access.
- The default child environment is allowlisted, but spawned programs can still
  read files available to the host account.
- `BROKER_AGENT_INHERIT_ENV=1` passes the complete broker environment and may
  expose API keys, cloud credentials, and other secrets.

Run the broker under a dedicated operating-system account, container, or VM if
you need stronger isolation.

Repository agent instructions are stored under inert `.template` names. Active
`AGENTS.md`, `CLAUDE.md`, and provider configuration files are created only by
the explicit agent setup command in its dedicated session workspace, or repaired
by an authenticated explicit `POST /doctor` when the generated launcher permits
management. Ordinary startup does not seed them. The unmanaged-workspace bypass
is an operator acknowledgement, not a safety check.

Running structured `/agent` without `/term` is a valid least-privilege profile:
it withholds the broker's PTY, direct shell selection, and interactive terminal
features while retaining supported prompt and MCP workflows. `CLAUDE.md`,
`AGENTS.md`, and similar context can reinforce an operator's intent, but an agent
can misunderstand, ignore, or be redirected away from instructions. Treat them
as guidance, never as authorization. Enforce capability limits with disabled
endpoints and terminal command/no-shell settings. Complement those broker-level
controls with provider-native controls—for example Claude tool/permission
policies or Codex sandbox and approval settings. Those are materially stronger
than prompt instructions, but remain version- and CLI-specific policy rather
than an operating-system boundary. Use an appropriately restricted account,
container, or VM for higher assurance.

### Terminal

`/term` is disabled unless `BROKER_TERM=1` is set. When enabled, it can provide
a real shell through `node-pty`. Anyone with the pairing token and network access
to the endpoint can exercise the configured terminal commands. Treat this as
remote shell access.

`BROKER_TERM_NO_SHELL=1` removes the explicit shell command and prevents the
configured agent command from falling back to a shell. It is a reduction in
capability, not a complete sandbox.

## Token handling

- Without `BROKER_TOKEN`, the broker creates a random 128-bit token at
  `~/scirepl-broker/broker-token` and enforces mode `0600` where supported.
- Agent configuration files materialized by explicit setup are written with mode
  `0600` where supported.
- The same pairing token currently authenticates `/mcp`, `/doctor`, `/app`,
  `/agent`, and `/term`. Optional high-capability endpoints are therefore gated
  off separately by configuration.
- SciREPL Pro stores its connection settings on the device. Notebook JavaScript
  and other same-origin app code should be treated as potentially able to access
  browser-managed application state.
- Rotate a compromised token by stopping the broker, replacing the token file,
  and updating every paired client.

Never commit token files or paste tokens into bug reports.

## Network hardening in the broker

The broker applies bounded HTTP and per-route WebSocket payloads, an authentication
deadline, a per-endpoint WebSocket connection cap, a pending-tool-call cap,
constant-time token comparison, and an HTTP header-count limit. These are
defence in depth for a private deployment; they do not convert it into a hardened
public gateway.

## Reporting a vulnerability

Once the GitHub repository is public, use its **Security → Report a
vulnerability** form so details are not disclosed in a public issue. If private
reporting is temporarily unavailable, open a minimal issue asking the maintainer
for a private contact method and do not include exploit details, tokens, personal
data, or private notebook contents.
