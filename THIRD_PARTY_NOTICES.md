# Third-party notices

SciREPL MCP uses the following principal runtime dependencies:

| Package | Locked version | License | Used by | Project |
|---|---:|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | Both servers | [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| `cross-spawn` | 7.0.6 | MIT | App-connected broker | [cross-spawn](https://github.com/moxystudio/node-cross-spawn) |
| `ws` | 8.21.3 | MIT | App-connected broker | [ws](https://github.com/websockets/ws) |
| `node-pty` (optional) | 1.1.0 | MIT | App-connected broker terminal | [node-pty](https://github.com/microsoft/node-pty) |
| `playwright` (direct) / `playwright-core` (transitive) | 1.62.1 | Apache-2.0 | Playwright driver | [Playwright](https://github.com/microsoft/playwright) |

The complete resolved dependency graph and exact integrity hashes are recorded
in each package's `package-lock.json`. Installed packages retain their own
license files and notices. This summary is informational; the applicable
upstream license text controls each dependency.
