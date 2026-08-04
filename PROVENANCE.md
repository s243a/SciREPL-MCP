# Source provenance

This repository began as a clean extraction of the host-side MCP broker from
the private SciREPL Pro repository. It deliberately does not contain that
repository's history, app source, signing material, build products, or secrets.

Initial extraction source:

- SciREPL Pro commit: `c3a6574b75a52ce09200a681b76afbddf403fde3`
- Extracted on: 2026-08-04
- Original paths: `mcp/broker.mjs`, `mcp/skills/scirepl-notebook/SKILL.md`,
  and the standalone `scripts/test-mcp-*.mjs` tests
- License: MIT, copyright 2026 UnifyWeaver Project

The extracted broker was then adapted for standalone packaging and hardened
before publication. The public repository is intended to become the canonical
source for the host-side broker. SciREPL Pro remains the source for the Android
app and its app-side bridge.
