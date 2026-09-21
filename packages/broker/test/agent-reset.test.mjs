#!/usr/bin/env node
/** Focused /agent reset protocol and lifecycle regressions. */
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8091;
const TOKEN = 'agent-reset-test-token';
const root = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-agent-reset-'));
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE = '1';
process.env.BROKER_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.BROKER_WORKSPACE, { recursive: true });

const fixtureBin = path.join(root, 'bin');
const descendantPidFile = path.join(root, 'local-descendant.pid');
const descendantTermFile = path.join(root, 'local-descendant-sigterm');
const descendantScript = path.join(fixtureBin, 'local-descendant.mjs');
const leaderScript = path.join(fixtureBin, 'local-agent.mjs');
fs.mkdirSync(fixtureBin, { recursive: true });
fs.writeFileSync(descendantScript, `import fs from 'node:fs';
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(descendantTermFile)}, 'received'));
fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
fs.writeFileSync(leaderScript, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: 'ignore' });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fixtureBin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${leaderScript}" %*\r\n`);
} else {
    fs.writeFileSync(path.join(fixtureBin, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(leaderScript)} "$@"\n`, { mode: 0o755 });
}
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`;

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

function waitKind(ws, kind, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error(`timed out waiting for ${kind}`));
        }, timeoutMs);
        const onMessage = (buf) => {
            let message; try { message = JSON.parse(buf.toString()); } catch { return; }
            if (message.type !== 'agent' || message.kind !== kind) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(message);
        };
        ws.on('message', onMessage);
    });
}

function processAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

const { httpServer, agentBridge } = await import('../src/broker.mjs');
await new Promise(resolve => setTimeout(resolve, 150));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

console.log('/agent reset protocol\n');
try {
    const welcome = waitKind(ws, 'welcome');
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    const welcomed = await welcome;
    ok(welcomed.capabilities?.resetSession === true,
        'welcome advertises the resetSession capability');

    const started = waitKind(ws, 'started');
    ws.send(JSON.stringify({ type: 'start', agent: 'codex' }));
    await started;

    const other = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    await new Promise((resolve, reject) => { other.on('open', resolve); other.on('error', reject); });
    const otherWelcome = waitKind(other, 'welcome');
    other.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    await otherWelcome;
    const deniedReset = waitKind(other, 'reset');
    other.send(JSON.stringify({ type: 'reset', requestId: 'foreign-clear' }));
    const denied = await deniedReset;
    ok(denied.requestId === 'foreign-clear' && denied.ok === false && /owned/.test(denied.error || ''),
        'correlated ownership failure uses a reset acknowledgement with ok:false');
    other.close();

    // Exercise the real local one-shot spawn path. The fake CLI exits on
    // SIGTERM but leaves a descendant that ignores it; Reset must wait until
    // the detached process group has been SIGKILLed.
    ws.send(JSON.stringify({ type: 'input', text: 'start descendant fixture' }));
    const childDeadline = Date.now() + 3000;
    while ((!agentBridge.child || !fs.existsSync(descendantPidFile)) && Date.now() < childDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const child = agentBridge.child;
    const descendantPid = fs.existsSync(descendantPidFile)
        ? Number(fs.readFileSync(descendantPidFile, 'utf8').trim())
        : 0;
    agentBridge.sessionId = 'captured-thread-id';
    agentBridge.sessionAgent = 'codex';
    agentBridge.buf = 'hidden buffered output';

    ws.send(JSON.stringify({ type: 'stop' }));
    const firstAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-1' }));
    const first = await firstAck;
    ok(first.requestId === 'clear-1' && first.ok === true, 'reset acknowledgement is correlated by requestId');
    ok(child && !processAlive(child.pid) && descendantPid > 0 && !processAlive(descendantPid) &&
        agentBridge.child === null && agentBridge.ws === null &&
        agentBridge.profile === null && agentBridge.name === null && agentBridge.mode === null &&
        agentBridge.sessionId === null && agentBridge.sessionAgent === null && agentBridge.buf === '' &&
        agentBridge.stoppedBy === null && agentBridge.resetting === null && agentBridge.quiescences.size === 0 &&
        (process.platform === 'win32' || fs.existsSync(descendantTermFile)),
    'local Stop then Reset waits for the stubborn descendant process group before clearing all state');

    const secondAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-2' }));
    const second = await secondAck;
    ok(second.requestId === 'clear-2' && second.ok === true && agentBridge.sessionId === null && agentBridge.name === null,
        'reset is idempotent when no session remains');

    // Simulate a child for which both TERM and KILL fail to produce an exit.
    // The failed record must remain visible, return ok:false, and be retried by
    // the next correlated Reset rather than disappearing as false success.
    const stuck = new EventEmitter();
    stuck.pid = undefined;
    stuck.exitCode = null;
    stuck.signalCode = null;
    const signals = [];
    stuck.kill = (signal) => {
        signals.push(signal);
        if (signals.length >= 3) {
            queueMicrotask(() => {
                stuck.exitCode = 0;
                stuck.emit('exit', 0, signal);
            });
        }
        return true;
    };
    agentBridge.child = stuck;
    agentBridge.ws = null;
    agentBridge.profile = {};
    agentBridge.name = 'codex';
    agentBridge.mode = 'oneshot';
    const failedAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-fails' }));
    const failedReset = await failedAck;
    ok(failedReset.requestId === 'clear-fails' && failedReset.ok === false &&
        /did not exit/.test(failedReset.error || '') && agentBridge.quiescences.size === 1,
    'a nonterminating child returns correlated ok:false and remains tracked');

    const blockedStart = waitKind(ws, 'error');
    ws.send(JSON.stringify({ type: 'start', agent: 'codex' }));
    const blocked = await blockedStart;
    ok(/has not quiesced/.test(blocked.text || '') && agentBridge.child === null &&
        agentBridge.name === null && agentBridge.quiescences.size === 1,
    'Start is refused while an earlier child still has a failed quiescence record');

    const retryAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-retry' }));
    const retried = await retryAck;
    ok(retried.requestId === 'clear-retry' && retried.ok === true &&
        signals.length >= 3 && agentBridge.quiescences.size === 0,
    'a later Reset retries the failed child termination before acknowledging success');

    const allowedStart = waitKind(ws, 'started');
    ws.send(JSON.stringify({ type: 'start', agent: 'codex' }));
    await allowedStart;
    ok(agentBridge.name === 'codex' && agentBridge.mode === 'oneshot',
        'Start is allowed again only after the retry proves quiescence');

    const finalAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-final' }));
    await finalAck;
} catch (error) {
    console.log('  ✗ unexpected error: ' + (error.stack || error));
    failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
try { ws.close(); } catch (_) {}
await agentBridge.reset();
await new Promise(resolve => httpServer.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
