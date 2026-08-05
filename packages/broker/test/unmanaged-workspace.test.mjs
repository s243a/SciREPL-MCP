#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 8095;
const root = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-mcp-unmanaged-'));
const workspace = path.join(root, 'workspace');
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = 'unmanaged-startup-test-token';
process.env.BROKER_WORKSPACE = workspace;
process.env.BROKER_AGENT = '1';
process.env.BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE = '1';
delete process.env.BROKER_MANAGE_WORKSPACE;

let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

console.log('Ordinary broker startup — workspace regression\n');
const { httpServer } = await import('../src/broker.mjs');
await new Promise(resolve => setTimeout(resolve, 150));

ok(!fs.existsSync(workspace), 'ordinary startup does not create a session workspace');
const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
ok(health.ok === true && health.workspaceReady === false,
    'health reports an unprepared workspace without mutating it');
const doctor = await (await fetch(`http://127.0.0.1:${PORT}/doctor`, {
    headers: { Authorization: `Bearer ${process.env.BROKER_TOKEN}` },
})).json();
ok(doctor.ok === false && doctor.allowUnmanaged === true && doctor.deficiencies.some(item => /does not exist/.test(item)),
    'unmanaged override does not waive the requirement for an existing workspace directory');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
const messages = [];
ws.on('message', buffer => messages.push(JSON.parse(buffer.toString())));
ws.send(JSON.stringify({ type: 'hello', token: process.env.BROKER_TOKEN }));
await new Promise(resolve => setTimeout(resolve, 50));
ws.send(JSON.stringify({ type: 'start', agent: 'claude' }));
await new Promise(resolve => setTimeout(resolve, 50));
ok(messages.some(message => message.kind === 'welcome' && message.workspaceReady === false && message.agents.length === 0) &&
    messages.some(message => message.kind === 'error' && /workspace/.test(message.text || '')),
    'enabled agent endpoint refuses to launch from an unprepared workspace');

console.log(`\n${passed} passed, ${failed} failed`);
try { ws.terminate(); } catch (_) {}
await new Promise(resolve => httpServer.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
