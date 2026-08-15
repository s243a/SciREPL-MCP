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

const missingReverseAck = path.join(testRoot, 'missing-reverse-ack');
const rejectedReverse = run('--output', missingReverseAck, '--no-install', '--enable-reverse-worker');
ok(rejectedReverse.status !== 0 && /acknowledge-reverse-worker-command-relay/.test(rejectedReverse.stderr) && !fs.existsSync(missingReverseAck),
    'reverse-worker setup fails before writing unless command relay is acknowledged');

if (process.platform !== 'win32') {
    const reverse = path.join(testRoot, 'reverse');
    const reverseRun = run('--output', reverse, '--no-install', '--enable-reverse-worker', '--acknowledge-reverse-worker-command-relay');
    const reverseLauncher = reverseRun.status === 0 ? fs.readFileSync(path.join(reverse, 'start-broker.sh'), 'utf8') : '';
    const reverseEnroll = reverseRun.status === 0 ? fs.readFileSync(path.join(reverse, 'worker-enroll.txt'), 'utf8') : '';
    const reverseToken = reverseRun.status === 0 ? fs.readFileSync(path.join(reverse, 'broker-token'), 'utf8').trim() : '';
    const reverseWorkerToken = reverseRun.status === 0 ? fs.readFileSync(path.join(reverse, 'worker-token'), 'utf8').trim() : '';
    ok(reverseRun.status === 0 && /BROKER_REVERSE_WORKER='1'/.test(reverseLauncher) &&
        /BROKER_WORKER_TOKEN_FILE/.test(reverseLauncher) && !reverseLauncher.includes(reverseWorkerToken) &&
        !reverseLauncher.includes('BROKER_AGENT=') &&
        reverseWorkerToken && reverseWorkerToken !== reverseToken &&
        /^[0-9a-f]{32}$/.test(reverseWorkerToken) &&
        reverseEnroll.includes('reverse-worker.mjs') && reverseEnroll.includes('another account') &&
        reverseEnroll.includes('BROKER_HOST') && reverseEnroll.includes('node scripts/reverse-worker.mjs') &&
        reverseEnroll.includes('--agents <cli-this-host-has>') && !/--agents agy\b/.test(reverseEnroll) &&
        !reverseEnroll.includes(process.execPath) &&
        !reverseEnroll.includes(reverseWorkerToken) &&
        !fs.existsSync(path.join(reverse, 'start-reverse-worker.sh')) &&
        !fs.existsSync(path.join(reverse, 'Start-Reverse-Worker.ps1')) &&
        !fs.existsSync(path.join(reverse, 'workspace')),
        'acknowledged reverse-worker setup writes portable enrollment material, not a same-host worker launcher');

    const oldLayout = path.join(testRoot, 'b3f8f99-layout');
    fs.mkdirSync(path.join(oldLayout, 'workspace'), { recursive: true });
    const oldPairing = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const oldWorker = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    fs.writeFileSync(path.join(oldLayout, 'broker-token'), oldPairing + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(oldLayout, 'worker-token'), oldWorker + '\n', { mode: 0o600 });
    const shQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
    const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const brokerEntry = path.join(packageDir, 'src', 'broker.mjs');
    const shim = path.join(packageDir, 'scripts', 'reverse-worker.mjs');
    const workerUrl = 'ws://127.0.0.1:8087/worker';
    const workerTokenPath = path.join(oldLayout, 'worker-token');
    const workspacePath = path.join(oldLayout, 'workspace');
    fs.writeFileSync(path.join(oldLayout, 'start-broker.sh'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `export BROKER_HOST='127.0.0.1'`,
        `export BROKER_PORT='8087'`,
        `export BROKER_TOKEN_FILE=${shQuote(path.join(oldLayout, 'broker-token'))}`,
        `export BROKER_WORKSPACE=${shQuote(workspacePath)}`,
        `export BROKER_AGENT_CWD=${shQuote(workspacePath)}`,
        `export BROKER_REVERSE_WORKER='1'`,
        `export BROKER_WORKER_TOKEN_FILE=${shQuote(workerTokenPath)}`,
        `exec ${shQuote(process.execPath)} ${shQuote(brokerEntry)}`,
        '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(path.join(oldLayout, 'Start-Broker.ps1'), [
        "$ErrorActionPreference = 'Stop'",
        `$env:BROKER_HOST = '127.0.0.1'`,
        `$env:BROKER_PORT = '8087'`,
        `$env:BROKER_REVERSE_WORKER = '1'`,
        `& ${psQuote(process.execPath)} ${psQuote(brokerEntry)}`,
        'exit $LASTEXITCODE',
        '',
    ].join('\r\n'));
    fs.writeFileSync(path.join(oldLayout, 'start-reverse-worker.sh'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `exec ${shQuote(process.execPath)} ${shQuote(shim)} --url ${shQuote(workerUrl)} --token-file ${shQuote(workerTokenPath)} --name worker --surfaces term,agent --cmds shell,claude,codex,gemini,agy --agents claude,codex,gemini,agy --cwd ${shQuote(workspacePath)}`,
        '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(path.join(oldLayout, 'Start-Reverse-Worker.ps1'), [
        "$ErrorActionPreference = 'Stop'",
        `& ${psQuote(process.execPath)} ${psQuote(shim)} --url ${psQuote(workerUrl)} --token-file ${psQuote(workerTokenPath)} --name worker --surfaces term,agent --cmds shell,claude,codex,gemini,agy --agents claude,codex,gemini,agy --cwd ${psQuote(workspacePath)}`,
        'exit $LASTEXITCODE',
        '',
    ].join('\r\n'));
    fs.writeFileSync(path.join(oldLayout, '.scirepl-mcp-setup.json'), JSON.stringify({
        schemaVersion: 1,
        generatedBy: 'SciREPL-MCP explicit broker setup',
        sourceRepository: repoDir,
        output: oldLayout,
        host: '127.0.0.1',
        port: 8087,
        agentEnabled: false,
        terminalEnabled: false,
        reverseWorkerEnabled: true,
        generatedFiles: ['start-broker.sh', 'Start-Broker.ps1', 'start-reverse-worker.sh', 'Start-Reverse-Worker.ps1'],
    }, null, 2) + '\n');
    const oldArgs = ['--output', oldLayout, '--no-install', '--enable-reverse-worker', '--acknowledge-reverse-worker-command-relay'];
    const blockedUpgrade = run(...oldArgs);
    ok(blockedUpgrade.status !== 0 && /--repair/.test(blockedUpgrade.stderr) &&
        /start-reverse-worker\.sh/.test(blockedUpgrade.stderr) && /rotat/.test(blockedUpgrade.stderr) &&
        fs.readFileSync(path.join(oldLayout, 'worker-token'), 'utf8').trim() === oldWorker &&
        fs.readFileSync(path.join(oldLayout, 'start-reverse-worker.sh'), 'utf8').includes('reverse-worker.mjs') &&
        !fs.existsSync(path.join(oldLayout, 'worker-enroll.txt')),
        'a real b3f8f99 same-host layout requires --repair before launcher retirement and token rotation');
    const repairedUpgrade = run(...oldArgs, '--repair');
    const retiredSh = fs.readFileSync(path.join(oldLayout, 'start-reverse-worker.sh'), 'utf8');
    const retiredPs = fs.readFileSync(path.join(oldLayout, 'Start-Reverse-Worker.ps1'), 'utf8');
    const rotatedOld = fs.readFileSync(path.join(oldLayout, 'worker-token'), 'utf8').trim();
    const upgradedEnroll = fs.readFileSync(path.join(oldLayout, 'worker-enroll.txt'), 'utf8');
    const upgradedMarker = JSON.parse(fs.readFileSync(path.join(oldLayout, '.scirepl-mcp-setup.json'), 'utf8'));
    ok(repairedUpgrade.status === 0 && retiredSh.includes('retired-same-host-reverse-worker') &&
        retiredPs.includes('retired-same-host-reverse-worker') &&
        rotatedOld && rotatedOld !== oldWorker && /^[0-9a-f]{32}$/.test(rotatedOld) &&
        /rotated/.test(repairedUpgrade.stdout) && /restart/.test(repairedUpgrade.stdout) &&
        upgradedEnroll.includes('--agents <cli-this-host-has>') &&
        upgradedMarker.generatedFiles.includes('worker-enroll.txt') &&
        !upgradedMarker.generatedFiles.includes('start-reverse-worker.sh'),
        'repairing a real b3f8f99 layout retires the same-host launchers, rotates the worker token, and writes enrollment');

    const ipv6 = path.join(testRoot, 'ipv6');
    const ipv6Run = run('--output', ipv6, '--no-install', '--host', '::1',
        '--enable-reverse-worker', '--acknowledge-reverse-worker-command-relay',
        '--worker-url', 'ws://[::1]:8087/worker');
    const ipv6Enroll = ipv6Run.status === 0 ? fs.readFileSync(path.join(ipv6, 'worker-enroll.txt'), 'utf8') : '';
    ok(ipv6Run.status === 0 && ipv6Enroll.includes('ws://[::1]:8087/worker') && !ipv6Enroll.includes('ws://::1:'),
        'enrollment brackets IPv6 when --worker-url is supplied');
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
