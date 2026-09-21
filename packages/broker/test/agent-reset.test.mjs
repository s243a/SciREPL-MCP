#!/usr/bin/env node
/** Focused /agent reset protocol and lifecycle regressions. */
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
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

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
    });
    await new Promise(resolve => child.once('spawn', resolve));
    agentBridge.child = child;
    agentBridge.sessionId = 'captured-thread-id';
    agentBridge.sessionAgent = 'codex';
    agentBridge.buf = 'hidden buffered output';

    const firstAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-1' }));
    const first = await firstAck;
    ok(first.requestId === 'clear-1' && first.ok === true, 'reset acknowledgement is correlated by requestId');
    ok(!processAlive(child.pid) && agentBridge.child === null && agentBridge.ws === null &&
        agentBridge.profile === null && agentBridge.name === null && agentBridge.mode === null &&
        agentBridge.sessionId === null && agentBridge.sessionAgent === null && agentBridge.buf === '' &&
        agentBridge.stoppedBy === null && agentBridge.resetting === null,
    'ack is emitted only after the child is quiesced and all captured session state is cleared');

    const secondAck = waitKind(ws, 'reset');
    ws.send(JSON.stringify({ type: 'reset', requestId: 'clear-2' }));
    const second = await secondAck;
    ok(second.requestId === 'clear-2' && second.ok === true && agentBridge.sessionId === null && agentBridge.name === null,
        'reset is idempotent when no session remains');
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
