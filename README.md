# SciREPL MCP

SciREPL MCP contains two independently installable servers for controlling
SciREPL from coding agents and other Model Context Protocol clients. Choose the
server that matches where SciREPL is running; installing one does not install
the other's dependencies.

| Server | Best for | Connection | Browser dependency |
| --- | --- | --- | --- |
| [App-connected broker](packages/broker/) | SciREPL Pro on Android or in a browser | SciREPL connects outward to the broker; MCP clients use Streamable HTTP | None |
| [Playwright driver](packages/playwright-driver/) | Free-PWA, hosted-PWA, and local-browser workbook automation | The server launches or attaches to Chromium over CDP; Android attachment is planned | Playwright and Chromium |

The two approaches are complementary. The broker calls the app's own approved
tools and can optionally host a remote coding-agent or terminal session. The
Playwright driver operates the visible notebook interface and is useful for
automated workbook testing, screenshots, and diagnosing browser behaviour.

## App-connected broker

```bash
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP
./setup-broker.sh
~/scirepl-broker/start-broker.sh
```

Setup requires Node.js 20 or newer and fails before writing if the current shell
still points to an older system Node. If you use NVM, run `nvm use 22` first. The
generated launcher retains that validated Node executable.

On native Windows, the core bridge can be prepared with
`./setup-broker.ps1` from PowerShell. Agent and terminal modes currently use
POSIX process conventions and should run under WSL. Native PowerShell/ConPTY is
a possible future terminal profile, not a current feature.

The broker is executed directly by Node.js; it is not compiled. Setup installs
only its JavaScript dependencies by default. Optional terminal mode installs and
verifies the native `node-pty` dependency on the machine that will run it.

See the [broker guide](packages/broker/README.md) for pairing SciREPL Pro,
connecting an MCP client, and enabling the optional agent or terminal surfaces.

## Playwright driver

```bash
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP/packages/playwright-driver
npm ci
npx playwright install chromium
npm test
npm start
```

See the [Playwright driver guide](packages/playwright-driver/README.md) for MCP
client configuration, attaching to an existing Chromium session, and the tool
catalog.

## Repository checks

The root package is an orchestration convenience only. It is deliberately not
an npm workspace, so installing the broker never pulls in Playwright.

```bash
npm run install:all
npm test
npm run audit
```

`npm run setup` is the explicit broker-environment setup command, not the
repository dependency-install command.

## Security and privacy

The app-connected broker binds to loopback by default and requires a pairing
token. Its remote-agent and terminal endpoints are disabled by default. The
Playwright driver can control a browser profile and everything visible to that
profile. Treat both as trusted local development tools, use encrypted tunnels
for remote access, and read the [security policy](SECURITY.md) before exposing
either service.

Neither server adds analytics or telemetry. Hosted model clients and coding
agents may still send selected notebook content to their configured providers.

The repository stores agent guidance only as inert `.template` files. Explicit
agent setup materializes conventional `AGENTS.md`, `CLAUDE.md`, and provider
settings inside a dedicated private session workspace; ordinary broker startup
does not create them. See the [agent-context guide](docs/agent-context.md).

The broker's agent and terminal surfaces can also be driven by another agent
acting as a supervisor — reviewing the worker CLI's permission prompts one by
one instead of granting standing permissions. The pattern, its driver scripts,
and its security trade-offs are documented in
[Controlling a remote coding agent](docs/remote-agent-control.md); the
controller-side rules ship as
`packages/broker/templates/remote-agent-supervisor-skill.md.template`.

## Project relationship

This standalone repository is intended to be the canonical public home for both
SciREPL MCP servers. After its initial publication it can be referenced from
UnifyWeaver at `examples/sci-repl/mcp` as a Git submodule, without mixing its
history into the UnifyWeaver repository.

The browser driver was originally developed in the public UnifyWeaver project;
the app-connected broker was extracted from SciREPL Pro. See
[PROVENANCE.md](PROVENANCE.md) for the exact source revisions and boundaries.

## License

MIT. See [LICENSE](LICENSE). Direct dependency licensing is summarized in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
