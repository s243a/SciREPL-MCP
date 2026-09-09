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
before publication.

The Playwright driver was migrated from the public UnifyWeaver repository:

- UnifyWeaver commit: `82e0766555b42c6399e4f69c1155af101b4d2e5d`
- Commit date: 2026-04-15
- Original implementation: `examples/sci-repl/scirepl-mcp-server.js`
- Original documentation: `examples/sci-repl/MCP_README.md` and
  `skills/skill_scirepl_mcp_claude.md`
- License: MIT, copyright 2026 UnifyWeaver Project

During migration the driver was repackaged, its documentation and skill were
made client-neutral, and compatibility and security defects were corrected.
The imported code does not include the SciREPL application, the UnifyWeaver
source tree, or the adjacent SciREPL Git submodule.

This repository is the canonical source for both host-side servers. SciREPL Pro
remains the source for the Android app and its app-side bridge.
