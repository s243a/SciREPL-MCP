# Changelog

## 0.1.0 - Unreleased

- Extract the SciREPL host-side MCP broker into an independently buildable
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
