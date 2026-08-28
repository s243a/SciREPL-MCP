# Platform and device builds

The broker is executed directly as JavaScript; it is not compiled, transpiled,
or included in the Android APK. The only optional native component is
`node-pty`, used for terminal mode. Install dependencies on the device where the
broker will run; never move a populated `node_modules` directory between CPUs or
operating systems.

The commands in this guide are for the app-connected broker. Explicit setup
commands run from the `SciREPL-MCP` repository root; manual dependency and test
commands identify when they run from `packages/broker`.

## Linux and WSL

Node.js 22 is the recommended baseline:

```bash
nvm install 22
nvm use 22
cd SciREPL-MCP
./setup-broker.sh
```

Setup checks the Node version before it writes anything. If a newly opened WSL
shell still selects the distribution's older `/usr/bin/node`, run `nvm use 22`
before setup or configure NVM's default alias.

If `node-pty` must compile locally, install the platform's C/C++ build tools,
Python, and `make`. Manual core installation from `packages/broker` needs no
native toolchain:

```bash
npm ci --omit=optional
```

WSL is the recommended Windows environment for agent and terminal modes because
the current command adapters use POSIX shell quoting and process conventions.
Structured `/agent` adapters do not require `node-pty`; interactive agent/TUI
sessions exposed through `/term` do. Reverse-worker mode uses the same POSIX
process conventions; the worker shim needs `node-pty` on the worker host when
it advertises `/term`.

The current implementation has been exercised directly under WSL. Termux is
also directly tested as described below; other Linux distributions use the same
Node/POSIX paths but may differ in package names and native build tooling.

## macOS

Install a current Node.js release and Xcode Command Line Tools, then run
`npm ci`. Core broker operation does not require `node-pty`; terminal mode does.

The macOS terminal path is covered by the repository's GitHub-hosted macOS CI,
including a real PTY relay test. It has not yet been exercised on a
maintainer-owned Mac, and this project does not build or distribute a macOS app.
The install/setup path repairs the missing executable bit in `node-pty` 1.1.0's
macOS prebuilt `spawn-helper`; that repair is not run on Linux or Windows.

## Native Windows

The HTTP/WebSocket bridge can run under native Node.js, but the terminal and
agent launch paths are not yet treated as native-Windows compatible. Use WSL for
those features until Windows-specific adapters and CI coverage are added.

`node-pty` can use Windows ConPTY, so a native PowerShell terminal profile is a
possible future extension. It would still require Windows-specific command,
quoting, path, setup, and CI work; it is not a current feature.

For the core bridge in PowerShell:

```powershell
./setup-broker.ps1
& "$HOME\scirepl-broker\Start-Broker.ps1"
```

In another PowerShell window, read the generated pairing token with:

```powershell
Get-Content "$HOME\scirepl-broker\broker-token"
```

PowerShell environment settings use `$env:NAME='value'`. For example,
`$env:BROKER_PORT='8088'; npm start`. Remote-agent and terminal examples in this
repository use POSIX syntax intentionally; run those modes in WSL for now.

## Android with Termux

Prefer a current Termux build from the project's documented
[F-Droid or GitHub release channels](https://github.com/termux/termux-app#installation).
Termux distributions use different signing keys, so do not mix packages from
different channels without uninstalling the old installation first.

Install the core requirements first:

```bash
pkg update
pkg install git nodejs-lts
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP
./setup-broker.sh
```

Start with the core bridge. If terminal mode is required, build the native
dependency on that same Android device:

```bash
pkg install python make clang
cd packages/broker
npm install node-pty --build-from-source
npm run test:term
cd ../..
./setup-broker.sh \
  --enable-terminal \
  --acknowledge-terminal-host-access \
  --no-install \
  --repair
```

Android and Termux versions vary; a successful core test does not guarantee
that `node-pty` can be built for every device. Record the device architecture,
Android version, Termux source/version, Node version, and compiler output when
reporting a failure.

Running the broker inside Termux on the **same phone** as SciREPL has additional
Android routing and background-execution constraints. That topology is
experimental. The simpler supported topology is SciREPL on the phone and the
broker on a PC, WSL environment, Mac, Linux host, or server in the same private
tailnet.

## Private remote access with Tailscale

Keep the broker on loopback and ask Tailscale Serve to proxy it privately:

```bash
tailscale serve --bg localhost:8087
tailscale serve status
```

Tailscale documents Serve as tailnet-only sharing. **Serve** and **Funnel** are
not interchangeable; do not enable Funnel for this broker. See the official
[Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
Setup prints the Serve command as guidance but does not inspect or change an
existing Serve configuration.

The resulting HTTPS hostname is used as:

```text
SciREPL app:  wss://<host>.<tailnet>.ts.net/app
MCP client:   https://<host>.<tailnet>.ts.net/mcp
```

## SSH tunnel

An MCP client on another computer can reach a loopback-bound broker over SSH:

```bash
ssh -N -L 8087:127.0.0.1:8087 user@broker-host
```

The MCP client then connects to `http://127.0.0.1:8087/mcp`. An Android WebView
does not create this SSH tunnel itself, so the phone normally still uses a
private `wss://` endpoint such as Tailscale Serve.

Tailscale Serve and SSH forwarding both appear to the broker as loopback. The
current protocol uses the pairing token and feature flags, not transport identity,
for authorization. See the security policy before designing different “local”
and “remote” privilege levels.

## Reproducible release direction

Before the first public binary or npm release, the project should add:

- signed Git tags;
- source-archive SHA-256 checksums;
- a recorded `node-pty` build matrix for tested devices;
- dependency-license and vulnerability reports attached to each release.

Until then, cloning a tagged source revision and running `npm ci` on the target
device is the intended distribution method.
