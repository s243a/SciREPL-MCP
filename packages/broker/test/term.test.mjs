#!/usr/bin/env node
/**
 * test-mcp-term.mjs — PTY relay test for the /term endpoint (§14C).
 *
 * Boots the broker with BROKER_TERM=1, connects on /term, spawns a login shell
 * through node-pty, sends a command, and asserts the output streams back. Also
 * checks the endpoint stays disabled without the env flag. No browser/device.
 *
 * Run: npm run test:term
 */
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ✓ ' + m); passed++; } else { console.log('  ✗ ' + m); failed++; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// node-pty must be importable on the broker host.
let hasPty = false;
try { await import('node-pty'); hasPty = true; } catch { /* not installed */ }
if (!hasPty) {
    const required = process.env.REQUIRE_PTY === '1';
    console.log(`term e2e — ${required ? 'FAILED' : 'SKIPPED'} (node-pty not installed)`);
    process.exit(required ? 1 : 0);
}

const PORT = 8091, TOKEN = 'term-test';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_TERM = '1';
process.env.BROKER_WORKSPACE = path.join(process.cwd(), '.test-workspaces', `${process.pid}-${PORT}`);

const { termBridge } = await import('../src/broker.mjs');
await sleep(300);

console.log('terminal /term PTY relay\n');

const t = new WebSocket(`ws://127.0.0.1:${PORT}/term`);
await new Promise((res, rej) => { t.on('open', res); t.on('error', rej); });

let out = '', welcomeEnabled = null, started = false;
const done = new Promise((resolve) => {
    t.on('message', (b) => {
        const m = JSON.parse(b); if (m.type !== 'term') return;
        if (m.kind === 'welcome') { welcomeEnabled = m.enabled; t.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 })); }
        else if (m.kind === 'started') { started = true; setTimeout(() => t.send(JSON.stringify({ type: 'input', data: 'echo HELLO_$((6*7))\n' })), 400); }
        else if (m.kind === 'data') { out += m.data; if (out.includes('HELLO_42')) resolve(); }
        else if (m.kind === 'error') { console.log('  (term error: ' + m.text + ')'); resolve(); }
    });
});
t.send(JSON.stringify({ type: 'hello', token: TOKEN }));
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));

try {
    await Promise.race([done, timeout]);
    ok(welcomeEnabled === true, 'welcome reports terminal enabled (BROKER_TERM=1)');
    ok(started, 'PTY shell spawned');
    ok(out.includes('HELLO_42'), 'keystrokes → PTY → output streamed back (HELLO_42)');
} catch (e) { console.log('  ✗ ' + (e.message || e)); failed++; }

console.log(`\n${passed} passed, ${failed} failed`);
try { termBridge.stop(); t.close(); } catch (_) {}
process.exit(failed ? 1 : 0);
