#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightWorkspace, randomToken, setupWorkspace, targetState, writePrivateFile } from '../src/workspace.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_DIR = path.resolve(PACKAGE_DIR, '../..');
const BROKER_ENTRY = path.join(PACKAGE_DIR, 'src', 'broker.mjs');
const SETUP_MARKER = '.scirepl-mcp-setup.json';

function usage() {
    console.log(`SciREPL MCP broker setup

Usage:
  node scripts/setup.mjs [options]

Options:
  --output PATH                         Setup directory (default: ~/scirepl-broker)
  --port N                              Broker port (default: 8087)
  --host ADDRESS                        Bind address (default: 127.0.0.1)
  --allow-non-loopback                  Acknowledge raw non-loopback exposure
  --enable-agent                        Enable structured, non-PTY agent chat
  --acknowledge-agent-host-access       Required with --enable-agent
  --enable-terminal                     Enable the host-side PTY/shell bridge;
                                        combine with agent mode for TUIs/! commands
  --acknowledge-terminal-host-access    Required with --enable-terminal
  --no-install                          Do not install npm dependencies
  --adopt                               Allow an existing unmarked setup directory
  --repair                              Back up and replace changed generated files
  --dry-run                             Validate and describe without writing
  -h, --help                            Show this help

The setup command never prints the pairing token. It creates launchers which
read the token from a private file. Active agent instructions are generated only
when --enable-agent is supplied with its acknowledgement.`);
}

function parseArgs(argv) {
    const options = {
        output: path.join(os.homedir(), 'scirepl-broker'),
        port: 8087,
        host: '127.0.0.1',
        allowNonLoopback: false,
        enableAgent: false,
        acknowledgeAgent: false,
        enableTerminal: false,
        acknowledgeTerminal: false,
        install: true,
        adopt: false,
        repair: false,
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
            return argv[++i];
        };
        if (arg === '--output' || arg === '-o') options.output = value();
        else if (arg === '--port') options.port = Number(value());
        else if (arg === '--host') options.host = value();
        else if (arg === '--allow-non-loopback') options.allowNonLoopback = true;
        else if (arg === '--enable-agent') options.enableAgent = true;
        else if (arg === '--acknowledge-agent-host-access') options.acknowledgeAgent = true;
        else if (arg === '--enable-terminal') options.enableTerminal = true;
        else if (arg === '--acknowledge-terminal-host-access') options.acknowledgeTerminal = true;
        else if (arg === '--no-install') options.install = false;
        else if (arg === '--adopt') options.adopt = true;
        else if (arg === '--repair') options.repair = true;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown option: ${arg}`);
    }
    return options;
}

function isWithin(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function validate(options) {
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error('--port must be an integer from 1 to 65535');
    }
    if (!options.host || /[\r\n]/.test(options.host)) throw new Error('--host must be a non-empty address');
    if (!isLoopbackHost(options.host) && !options.allowNonLoopback) {
        throw new Error('a non-loopback --host requires --allow-non-loopback; this exposes the broker without proving Tailscale or SSH transport');
    }
    if (options.enableAgent && !options.acknowledgeAgent) {
        throw new Error('--enable-agent requires --acknowledge-agent-host-access because agent CLIs may access this computer');
    }
    if (options.enableTerminal && !options.acknowledgeTerminal) {
        throw new Error('--enable-terminal requires --acknowledge-terminal-host-access because it exposes a host PTY or shell');
    }
    if (process.platform === 'win32' && (options.enableAgent || options.enableTerminal)) {
        throw new Error('agent and terminal modes currently require Linux, macOS, or WSL; use the PowerShell setup for the core broker only');
    }

    options.output = path.resolve(options.output.replace(/^~(?=$|[\\/])/, os.homedir()));
    const dangerous = [path.parse(options.output).root, os.homedir(), REPO_DIR, PACKAGE_DIR];
    if (dangerous.some(candidate => path.resolve(candidate) === options.output) ||
        isWithin(REPO_DIR, options.output) || isWithin(options.output, REPO_DIR)) {
        throw new Error(`refusing dangerous setup directory: ${options.output}`);
    }
}

function assertUnlinkedPath(destination) {
    let existing = path.resolve(destination);
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
    }
    if (fs.existsSync(existing) && fs.realpathSync(existing) !== path.resolve(existing)) {
        throw new Error(`setup path crosses a symbolic link: ${existing}`);
    }
}

function shQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function psQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function environment(options, tokenFile, workspace) {
    const env = {
        BROKER_HOST: options.host,
        BROKER_PORT: String(options.port),
        BROKER_TOKEN_FILE: tokenFile,
        BROKER_WORKSPACE: workspace,
        BROKER_AGENT_CWD: workspace,
    };
    if (options.enableAgent) {
        env.BROKER_AGENT = '1';
        env.BROKER_MANAGE_WORKSPACE = '1';
    }
    if (options.enableTerminal) {
        env.BROKER_TERM = '1';
        if (!options.enableAgent) env.BROKER_TERM_CMDS = 'shell';
    }
    return env;
}

function bashLauncher(env) {
    const lines = ['#!/usr/bin/env bash', 'set -euo pipefail'];
    for (const [key, value] of Object.entries(env)) lines.push(`export ${key}=${shQuote(value)}`);
    lines.push(`exec ${shQuote(process.execPath)} ${shQuote(BROKER_ENTRY)}`, '');
    return lines.join('\n');
}

function powerShellLauncher(env) {
    const lines = ["$ErrorActionPreference = 'Stop'"];
    for (const [key, value] of Object.entries(env)) lines.push(`$env:${key} = ${psQuote(value)}`);
    lines.push(`& ${psQuote(process.execPath)} ${psQuote(BROKER_ENTRY)}`, 'exit $LASTEXITCODE', '');
    return lines.join('\r\n');
}

function setupManifest(options, files) {
    return JSON.stringify({
        schemaVersion: 1,
        generatedBy: 'SciREPL-MCP explicit broker setup',
        sourceRepository: REPO_DIR,
        output: options.output,
        host: options.host,
        port: options.port,
        agentEnabled: options.enableAgent,
        terminalEnabled: options.enableTerminal,
        generatedFiles: files,
    }, null, 2) + '\n';
}

function generatedTargets(options, env) {
    const definitions = [
        ['start-broker.sh', bashLauncher(env)],
        ['Start-Broker.ps1', powerShellLauncher(env)],
    ];
    definitions.push([SETUP_MARKER, setupManifest(options, definitions.map(([rel]) => rel))]);
    return definitions.map(([rel, content]) => ({
        rel,
        abs: path.join(options.output, rel),
        content: Buffer.from(content),
    }));
}

function backup(file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(destination, 0o600); } catch (_) {}
    return destination;
}

function prepareOutput(options) {
    assertUnlinkedPath(options.output);
    if (!fs.existsSync(options.output)) return;
    const stat = fs.lstatSync(options.output);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`setup path must be a real directory, not a link or file: ${options.output}`);
    const entries = fs.readdirSync(options.output);
    if (entries.length && !entries.includes(SETUP_MARKER) && !options.adopt) {
        throw new Error(`setup directory is non-empty and has no ${SETUP_MARKER}; inspect it and rerun with --adopt`);
    }
}

function installDependencies(options) {
    if (!options.install || options.dryRun) return;
    if (!fs.existsSync(path.join(PACKAGE_DIR, 'package-lock.json'))) {
        console.log('[setup] installed-package layout detected; using its existing dependencies');
        return;
    }
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = options.enableTerminal ? ['ci'] : ['ci', '--omit=optional'];
    console.log(`[setup] installing broker dependencies (${options.enableTerminal ? 'including optional terminal support' : 'core only'})`);
    const result = spawnSync(command, args, { cwd: PACKAGE_DIR, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
}

function verifyCoreDependencies(options) {
    if (options.dryRun) return;
    const expression = "Promise.all([import('ws'), import('@modelcontextprotocol/sdk/server/index.js')]).catch(error => { console.error(error.message); process.exit(1); })";
    const result = spawnSync(process.execPath, ['-e', expression], {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        shell: false,
    });
    if (result.status !== 0) {
        throw new Error(`broker dependencies are unavailable${result.stderr ? `: ${result.stderr.trim()}` : ''}; install this package normally or run setup from a source checkout with its lockfile`);
    }
}

function verifyTerminalDependency(options) {
    if (!options.enableTerminal || options.dryRun) return;
    const result = spawnSync(process.execPath, ['-e', "import('node-pty').catch(error => { console.error(error.message); process.exit(1); })"], {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        shell: false,
    });
    if (result.status !== 0) {
        throw new Error(`terminal support requires a working node-pty installation for this OS/CPU${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    }
}

function ensureToken(tokenFile, dryRun, candidate = randomToken()) {
    if (fs.existsSync(tokenFile)) {
        if (fs.lstatSync(tokenFile).isSymbolicLink() || !fs.lstatSync(tokenFile).isFile()) {
            throw new Error(`pairing-token path must be a regular file: ${tokenFile}`);
        }
        const token = fs.readFileSync(tokenFile, 'utf8').trim();
        if (!token) throw new Error(`pairing-token file is empty: ${tokenFile}`);
        if (!dryRun) try { fs.chmodSync(tokenFile, 0o600); } catch (_) {}
        return token;
    }
    if (!dryRun) writePrivateFile(tokenFile, candidate + '\n', { exclusive: true });
    return candidate;
}

function writeGenerated(targets, options) {
    const states = targets.map(target => ({ target, state: targetState(target) }));
    const unsafe = states.filter(({ state }) => state.startsWith('unsafe') || state === 'unreadable');
    if (unsafe.length) throw new Error(`refusing unsafe generated paths: ${unsafe.map(({ target }) => target.rel).join(', ')}`);
    const conflicts = states.filter(({ state }) => state === 'outdated');
    if (conflicts.length && !options.repair) {
        throw new Error(`generated files differ: ${conflicts.map(({ target }) => target.rel).join(', ')}; rerun with --repair to back them up and replace them`);
    }
    if (options.dryRun) return { created: [], updated: [], backups: [] };
    const result = { created: [], updated: [], backups: [] };
    for (const { target, state } of states) {
        if (state === 'current') continue;
        if (state === 'outdated') result.backups.push(backup(target.abs));
        writePrivateFile(target.abs, target.content, { exclusive: state === 'missing' });
        try { if (target.rel.endsWith('.sh')) fs.chmodSync(target.abs, 0o700); } catch (_) {}
        (state === 'missing' ? result.created : result.updated).push(target.rel);
    }
    return result;
}

function main() {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
        throw new Error(`Node.js 20 or newer is required (found ${process.versions.node}); select Node 22 first, for example with: nvm use 22`);
    }
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { usage(); return; }
    validate(options);
    prepareOutput(options);

    const tokenFile = path.join(options.output, 'broker-token');
    const workspace = path.join(options.output, 'workspace');
    const token = ensureToken(tokenFile, true);
    const env = environment(options, tokenFile, workspace);
    const targets = generatedTargets(options, env);

    // Complete every read-only preflight before installing or writing anything.
    writeGenerated(targets, { ...options, dryRun: true });
    if (options.enableAgent) preflightWorkspace({ workspace, port: options.port, token, callTimeoutMs: 120000 }, { repair: options.repair });
    installDependencies(options);
    verifyCoreDependencies(options);
    verifyTerminalDependency(options);

    let workspaceResult = null;
    if (!options.dryRun) {
        fs.mkdirSync(options.output, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(options.output, 0o700); } catch (_) {}
        ensureToken(tokenFile, false, token);
        if (options.enableTerminal) {
            fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
            try { fs.chmodSync(workspace, 0o700); } catch (_) {}
        }
        if (options.enableAgent) {
            workspaceResult = setupWorkspace({ workspace, port: options.port, token, callTimeoutMs: 120000 }, { repair: options.repair });
        }
        writeGenerated(targets, options);
    }

    console.log(`[setup] ${options.dryRun ? 'validated' : 'ready'}: ${options.output}`);
    console.log(`[setup] broker: ${options.host}:${options.port} (${isLoopbackHost(options.host) ? 'loopback' : 'non-loopback — no transport verification is enforced'})`);
    console.log(`[setup] agent: ${options.enableAgent ? 'enabled with an explicit session workspace' : 'disabled'}`);
    console.log(`[setup] terminal: ${options.enableTerminal ? 'enabled' : 'disabled'}`);
    if (workspaceResult) console.log(`[setup] agent context: ${workspaceResult.created.length} created, ${workspaceResult.updated.length} repaired`);
    if (!options.dryRun) {
        console.log(`[setup] start with ${process.platform === 'win32' ? path.join(options.output, 'Start-Broker.ps1') : path.join(options.output, 'start-broker.sh')}`);
        console.log(`[setup] pairing token stored privately at ${tokenFile} (not printed)`);
        if (isLoopbackHost(options.host)) {
            console.log(`[setup] Android remote access: configure Tailscale separately with: tailscale serve --bg localhost:${options.port}`);
            console.log('[setup] Desktop MCP alternative: use an SSH local-forward; the Android app does not create that tunnel.');
        } else {
            console.log('[setup] warning: raw non-loopback binding does not verify Tailscale/SSH and does not provide TLS/WSS.');
        }
    }
}

try { main(); }
catch (error) {
    console.error(`[setup] error: ${error.message || error}`);
    process.exitCode = 1;
}
