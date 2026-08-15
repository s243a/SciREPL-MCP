# Changelog

## 0.1.0 - Unreleased

- Add optional reverse-worker mode: a worker dials `/worker` with a distinct
  credential and the broker relays the existing `/agent` and `/term` controller
  messages to it. Default off; setup requires
  `--acknowledge-reverse-worker-command-relay` and writes enrollment material
  rather than a same-host worker launcher. Local spawn is unchanged when
  the flag is unset. Relayed `started` events carry a broker-authored `via`
  worker name; `BROKER_REVERSE_WORKER_STRICT=1` fails closed instead of
  falling through to local spawn. The worker shim can pass provider API keys
  or inherit its environment the same way local spawn does, and still does
  not inject the controller pairing token. Stop clears the reverse session so
  the next start re-selects a capable worker; controller `/term` detach starts
  shim grace; worker-link loss kills `/agent` children.

- Extract the SciREPL host-side MCP broker into an independently installable
  repository.
- Add the MCP-to-app bridge, opt-in remote-agent bridge, optional PTY terminal,
  and notebook-agent skill.
- Default to loopback networking, a persistent private pairing token, disabled
  privileged endpoints, and a restricted child-process environment.
- Add bounded payloads, authentication deadlines, connection and pending-call
  limits, protocol/version health reporting, standalone tests, and CI.
- Reject unadvertised tool calls, clear calls immediately on app disconnect,
  tolerate missing agent executables and malformed WebSocket traffic, and bound
  agent output/backpressure without limiting normal multi-megabyte plot results.
- Document the protocol, security model, configuration, supported platforms,
  and source provenance.
- Import the existing public Playwright/CDP driver as an independently
  installable package with a real stdio protocol test and Chromium smoke test.
- Add TypR and ClojureScript to the Playwright tool schemas, redact stored API
  keys and pairing data, validate tool arguments, fix directory globs, preserve
  attached browser tabs, and make deterministic UI reruns observable.
- Split the repository into dependency-isolated `broker` and
  `playwright-driver` packages so broker users do not install browser tooling.
- Store notebook-agent guidance as inert templates and materialize active
  provider context only during an explicit, acknowledged setup into a dedicated
  session workspace.
- Add shared Bash and PowerShell setup entry points, private generated launchers,
  conflict-safe repair with backups, symlink/path checks, and deterministic setup
  and no-implicit-seeding tests.
- Pin generated launchers to the Node 20+ executable that setup validated, so a
  service or new shell cannot silently fall back to an older system Node.
- Expose `scirepl-mcp-setup` for an installed package and verify its existing
  dependencies when a source-checkout lockfile is not present.
- Document that the broker itself is not compiled, that only optional terminal
  support has a native dependency, and that remote Android access normally uses
  Tailscale Serve while SSH forwarding is a desktop-client alternative.
- Record the current transport-identity limitation and the verified-but-not-yet-
  implemented Android WebView attachment path for the Playwright driver.
- Repair the missing executable bit in `node-pty` 1.1.0's macOS prebuilt
  `spawn-helper` without changing other platforms, and verify terminal setup by
  opening a real PTY rather than only importing the dependency.
