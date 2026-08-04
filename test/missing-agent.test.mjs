#!/usr/bin/env node
/**
 * Regression: an enabled adapter whose CLI is absent must report an error to
 * the app, not crash the broker through an unhandled ChildProcess error event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 8096, TOKEN = 'missing-agent-test-token';
const root = path.join(process.cwd(), '.test-workspaces', `missing-agent-${process.pid}-${PORT}`);
const emptyBin = path.join(root, 'empty-bin');
fs.mkdirSync(emptyBin, { recursive: true });
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_WORKSPACE = path.join(root, 'workspace');
process.env.TMPDIR = path.join(root, 'tmp');
process.env.PATH = emptyBin;

let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

const { httpServer } = await import('../src/broker.mjs');
await new Promise(resolve => setTimeout(resolve, 200));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
const waitKind = (kind, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`timed out waiting for ${kind}`)); }, timeoutMs);
    const onMessage = (buf) => {
        const message = JSON.parse(buf.toString());
        if (message.type !== 'agent' || message.kind !== kind) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
    };
    ws.on('message', onMessage);
});

console.log('Missing agent executable — regression tests\n');

try {
    const welcome = waitKind('welcome');
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    const welcomeMessage = await welcome;
    ok(Array.isArray(welcomeMessage.agents) && welcomeMessage.agents.length === 0 &&
        Array.isArray(welcomeMessage.availableAgents) && welcomeMessage.availableAgents.length === 0 &&
        welcomeMessage.configuredAgents.includes('claude') && welcomeMessage.configuredAgents.includes('gemini'),
        'welcome distinguishes configured adapters from installed CLIs');

    const persistentError = waitKind('error');
    const persistentExit = waitKind('exit');
    ws.send(JSON.stringify({ type: 'start', agent: 'claude' }));
    const [claudeError] = await Promise.all([persistentError, persistentExit]);
    ok(/failed to start claude|ENOENT/i.test(claudeError.text || ''),
        'missing persistent CLI reports an error without terminating the broker');

    const oneShotStarted = waitKind('started');
    ws.send(JSON.stringify({ type: 'start', agent: 'gemini' }));
    await oneShotStarted;
    const oneShotError = waitKind('error');
    const oneShotResult = waitKind('result');
    ws.send(JSON.stringify({ type: 'input', text: 'hello' }));
    const [geminiError] = await Promise.all([oneShotError, oneShotResult]);
    ok(/failed to start gemini|ENOENT/i.test(geminiError.text || ''),
        'missing one-shot CLI completes the turn with an error instead of crashing');

    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(health.ok === true, 'broker remains healthy after both launch failures');
} catch (e) {
    console.log('  ✗ unexpected error: ' + (e.stack || e));
    failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
try { ws.close(); } catch (_) {}
await new Promise(resolve => httpServer.close(resolve));
process.exit(failed ? 1 : 0);
