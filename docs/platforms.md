# Platform and device builds

The core broker is JavaScript. The only optional native component is
`node-pty`, used for terminal mode. Install dependencies on the device where the
broker will run; never move a populated `node_modules` directory between CPUs or
operating systems.

## Linux and WSL

Node.js 22 is the recommended baseline:

```bash
nvm install 22
nvm use 22
npm ci
npm test
```

If `node-pty` must compile locally, install the platform's C/C++ build tools,
Python, and `make`. The core bridge can be installed without native packages:

```bash
npm ci --omit=optional
```

WSL is the recommended Windows environment for agent and terminal modes because
the current command adapters use POSIX shell quoting and process conventions.

## macOS

Install a current Node.js release and Xcode Command Line Tools, then run
`npm ci`. Core broker operation does not require `node-pty`; terminal mode does.

## Native Windows

The HTTP/WebSocket bridge can run under native Node.js, but the terminal and
agent launch paths are not yet treated as native-Windows compatible. Use WSL for
those features until Windows-specific adapters and CI coverage are added.

For the core bridge in PowerShell:

```powershell
npm ci --omit=optional
npm run test:broker
npm start
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

Install a local toolchain:

```bash
pkg update
pkg install git nodejs-lts python make clang
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP
npm ci --omit=optional
npm test
```

Start with the core bridge. If terminal mode is required, build the native
dependency on that same Android device:

```bash
npm install node-pty --build-from-source
npm run test:term
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

## Reproducible release direction

Before the first public binary or npm release, the project should add:

- signed Git tags;
- source-archive SHA-256 checksums;
- a CI matrix for supported Node versions and operating systems;
- a recorded `node-pty` build matrix for tested devices;
- dependency-license and vulnerability reports attached to each release.

Until then, cloning a tagged source revision and running `npm ci` on the target
device is the intended distribution method.
