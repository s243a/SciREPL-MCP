#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const packageDir = process.cwd();
const repoDir = path.resolve(packageDir, '../..');
const testRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-mcp-setup-'));
const script = path.join(packageDir, 'scripts', 'setup.mjs');

let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};
const privateMode = (file) => process.platform === 'win32' || (fs.statSync(file).mode & 0o077) === 0;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: packageDir, encoding: 'utf8' });
let hasPty = false;
try { await import('node-pty'); hasPty = true; } catch (_) {}

console.log('Explicit broker setup — deterministic tests\n');

const core = path.join(testRoot, 'core');
const coreRun = run('--output', core, '--no-install');
ok(coreRun.status === 0, 'core-only setup succeeds without installing dependencies');
const tokenFile = path.join(core, 'broker-token');
const bashLauncher = path.join(core, 'start-broker.sh');
const psLauncher = path.join(core, 'Start-Broker.ps1');
ok(fs.existsSync(tokenFile) && fs.existsSync(bashLauncher) && fs.existsSync(psLauncher),
    'setup creates a private token and Bash/PowerShell launchers');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const launchText = fs.readFileSync(bashLauncher, 'utf8') + fs.readFileSync(psLauncher, 'utf8');
ok(/^[0-9a-f]{32}$/.test(token) && !launchText.includes(token) && launchText.includes('BROKER_TOKEN_FILE'),
    'launchers reference the token file and never embed or print the token');
ok(launchText.includes(process.execPath),
    'launchers retain the Node 20+ executable that passed setup validation');
ok(privateMode(tokenFile), 'pairing-token permissions are private where supported');
if (process.platform !== 'win32') {
    fs.chmodSync(tokenFile, 0o644);
    const dryRun = run('--output', core, '--no-install', '--dry-run');
    ok(dryRun.status === 0 && (fs.statSync(tokenFile).mode & 0o777) === 0o644,
        'dry-run validates without changing existing token permissions');
    fs.chmodSync(tokenFile, 0o600);
}
ok(!fs.existsSync(path.join(core, 'workspace', 'AGENTS.md')),
    'core-only setup does not create active agent instruction files');

const workbookArtifacts = path.join(testRoot, 'workbook-artifacts');
const workbookPrivate = path.join(testRoot, 'workbook-private');
const workbookSetup = path.join(testRoot, 'workbook-setup');
fs.mkdirSync(workbookArtifacts);
fs.mkdirSync(workbookPrivate);
const workbookConfig = path.join(workbookPrivate, 'workbook-io.json');
fs.writeFileSync(workbookConfig, JSON.stringify({
    schemaVersion: 1,
    maxContentBytes: 1048576,
    roots: [{ name: 'artifacts', path: workbookArtifacts, read: true, write: true, allowOverwrite: false }],
}), { mode: 0o600 });
const workbookRun = run('--output', workbookSetup, '--no-install', '--workbook-io-config', workbookConfig);
const workbookLaunchers = workbookRun.status === 0
    ? fs.readFileSync(path.join(workbookSetup, 'start-broker.sh'), 'utf8') +
      fs.readFileSync(path.join(workbookSetup, 'Start-Broker.ps1'), 'utf8')
    : '';
ok(workbookRun.status === 0 && workbookLaunchers.includes('BROKER_WORKBOOK_IO_CONFIG') &&
    workbookLaunchers.includes(workbookConfig) && workbookLaunchers.includes('BROKER_MAX_APP_WS_PAYLOAD_BYTES'),
    'setup validates and preserves an absolute workbook allowlist plus its required wire budget');
const relativeWorkbook = run('--output', path.join(testRoot, 'relative-workbook'), '--no-install',
    '--workbook-io-config', 'relative-config.json');
ok(relativeWorkbook.status !== 0 && /absolute path/.test(relativeWorkbook.stderr) &&
    !fs.existsSync(path.join(testRoot, 'relative-workbook')),
    'setup rejects a relative workbook allowlist before writing');

const terminal = path.join(testRoot, 'terminal');
const terminalRun = run('--output', terminal, '--no-install', '--enable-terminal', '--acknowledge-terminal-host-access');
if (process.platform === 'win32') {
    ok(terminalRun.status !== 0 && /WSL/.test(terminalRun.stderr),
        'native Windows setup directs terminal mode to WSL');
} else if (!hasPty) {
    ok(terminalRun.status !== 0 && /working node-pty/.test(terminalRun.stderr) && !fs.existsSync(terminal),
        'terminal setup fails clearly and before writing when node-pty is unavailable');
} else {
    const terminalLauncher = fs.readFileSync(path.join(terminal, 'start-broker.sh'), 'utf8');
    ok(terminalRun.status === 0 && fs.statSync(path.join(terminal, 'workspace')).isDirectory() &&
        !fs.existsSync(path.join(terminal, 'workspace', 'AGENTS.md')) && /BROKER_TERM_CMDS='shell'/.test(terminalLauncher),
        'terminal-only setup creates an empty workspace and exposes only the shell command');
}

const missingAck = path.join(testRoot, 'missing-ack');
const rejected = run('--output', missingAck, '--no-install', '--enable-agent');
ok(rejected.status !== 0 && /acknowledge-agent-host-access/.test(rejected.stderr) && !fs.existsSync(missingAck),
    'agent setup fails before writing unless host access is acknowledged');

const agent = path.join(testRoot, 'agent');
const agentArgs = ['--output', agent, '--no-install', '--enable-agent', '--acknowledge-agent-host-access'];
const agentRun = run(...agentArgs);
if (process.platform === 'win32') {
    ok(agentRun.status !== 0 && /WSL/.test(agentRun.stderr),
        'native Windows setup directs structured agent mode to WSL');
} else {
    const workspace = path.join(agent, 'workspace');
    ok(agentRun.status === 0 && fs.existsSync(path.join(workspace, 'AGENTS.md')) &&
        fs.existsSync(path.join(workspace, 'CLAUDE.md')) && fs.existsSync(path.join(workspace, 'GEMINI.md')),
        'acknowledged agent setup creates provider context only in the dedicated workspace');
    ok(fs.existsSync(path.join(workspace, '.scirepl-mcp', 'manifest.json')) &&
        fs.existsSync(path.join(workspace, '.claude', 'skills', 'scirepl-notebook', 'SKILL.md')) &&
        fs.existsSync(path.join(workspace, '.codex', 'config.toml')),
        'agent setup installs its marker, notebook guide, and client configuration');
    ok(!['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].some(name => fs.existsSync(path.join(repoDir, name))),
        'setup never places active agent instructions in the repository root');

    const rerun = run(...agentArgs);
    ok(rerun.status === 0, 'setup is idempotent when generated files are unchanged');

    const agentsFile = path.join(workspace, 'AGENTS.md');
    fs.appendFileSync(agentsFile, '\nuser edit\n');
    const conflict = run(...agentArgs);
    ok(conflict.status !== 0 && /--repair/.test(conflict.stderr) && fs.readFileSync(agentsFile, 'utf8').includes('user edit'),
        'setup preserves an edited generated file unless repair is explicit');
    const repaired = run(...agentArgs, '--repair');
    const backups = fs.readdirSync(workspace).filter(name => name.startsWith('AGENTS.md.bak-'));
    ok(repaired.status === 0 && backups.length === 1 && !fs.readFileSync(agentsFile, 'utf8').includes('user edit'),
        'repair backs up and restores an edited generated instruction file');
}

const dangerous = run('--output', path.join(repoDir, 'generated-setup'), '--no-install');
ok(dangerous.status !== 0 && /dangerous setup directory/.test(dangerous.stderr),
    'setup refuses to generate active configuration inside the source repository');

const rawNetwork = run('--output', path.join(testRoot, 'raw-network'), '--no-install', '--host', '0.0.0.0');
ok(rawNetwork.status !== 0 && /allow-non-loopback/.test(rawNetwork.stderr),
    'non-loopback binding requires an explicit exposure acknowledgement');

if (process.platform !== 'win32') {
    const linked = path.join(testRoot, 'linked-workspace');
    const outside = path.join(testRoot, 'outside');
    fs.mkdirSync(path.join(linked, 'workspace'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(linked, 'workspace', '.codex'));
    const linkedRun = run('--output', linked, '--no-install', '--adopt', '--enable-agent', '--acknowledge-agent-host-access');
    ok(linkedRun.status !== 0 && /unsafe managed paths/.test(linkedRun.stderr) &&
        !fs.existsSync(path.join(linked, 'broker-token')) && !fs.existsSync(path.join(linked, 'workspace', 'AGENTS.md')),
        'agent setup rejects a symlinked managed path before creating any files');
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(testRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
