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

## Capabilities

### Core MCP bridge

`/mcp` forwards calls to the connected SciREPL app through `/app`. Notebook
reads, writes, and execution are then governed by the app's own permission
settings. Those settings protect the notebook; they do not control the broker
host.

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
- Managed agent configuration files containing the token are also written with
  mode `0600`.
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
