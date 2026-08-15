#!/usr/bin/env node
/**
 * Reverse-worker mode: credential classes, registration, relay of the existing
 * /term and /agent shapes, reconnect, and an unmodified driver script.
 *
 * Run: npm run test:reverse-worker
 */
import { WebSocket } from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerToken, validateWorkerHello } from '../src/reverse-worker.mjs';

const packageDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const PORT = 8093;
const CONTROLLER = 'controller-secret-token';
const WORKER = 'worker-secret-token';
const testRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-mcp-reverse-'));
const controllerTokenFile = path.join(testRoot, 'broker-token');
const workerTokenFile = path.join(testRoot, 'worker-token');
fs.writeFileSync(controllerTokenFile, CONTROLLER + '\n', { mode: 0o600 });
fs.writeFileSync(workerTokenFile, WORKER + '\n', { mode: 0o600 });
fs.mkdirSync(path.join(testRoot, 'workspace'), { recursive: true });

process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = CONTROLLER;
process.env.BROKER_WORKER_TOKEN = WORKER;
process.env.BROKER_REVERSE_WORKER = '1';
process.env.BROKER_AGENT = '1';
process.env.BROKER_TERM = '1';
process.env.BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE = '1';
process.env.BROKER_WORKSPACE = path.join(testRoot, 'workspace');
process.env.BROKER_AGENT_CWD = process.env.BROKER_WORKSPACE;

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ✓ ' + m); passed++; } else { console.log('  ✗ ' + m); failed++; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function onceMessage(ws, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
        ws.once('message', (buf) => {
            clearTimeout(timer);
            try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); }
        });
    });
}

function collectUntil(ws, predicate, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const got = [];
        const timer = setTimeout(() => reject(new Error('collect timeout: ' + JSON.stringify(got))), timeoutMs);
        const onMsg = (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
            got.push(msg);
            if (predicate(msg, got)) { clearTimeout(timer); ws.off('message', onMsg); resolve(got); }
        };
        ws.on('message', onMsg);
    });
}

function openWs(url) {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function connectWorker({ name = 'agy-box', token = WORKER, capabilities, sessions } = {}) {
    const ws = await openWs(`ws://127.0.0.1:${PORT}/worker`);
    const hello = {
        type: 'hello',
        token,
        name,
        capabilities: capabilities || { surfaces: ['term', 'agent'], cmds: ['shell', 'agy'], agents: ['agy'] },
    };
    if (sessions) hello.sessions = sessions;
    const welcome = onceMessage(ws);
    ws.send(JSON.stringify(hello));
    return { ws, welcome };
}

async function connectController(pathName, token = CONTROLLER) {
    const ws = await openWs(`ws://127.0.0.1:${PORT}${pathName}`);
    const first = onceMessage(ws);
    ws.send(JSON.stringify({ type: 'hello', token }));
    return { ws, first };
}

console.log('Reverse-worker validation helpers\n');

ok(validateWorkerHello({
    type: 'hello', name: 'agy-box',
    capabilities: { surfaces: ['term', 'agent'], cmds: ['agy'], agents: ['agy'] },
}).ok === true, 'valid worker hello is accepted');
ok(validateWorkerHello({
    type: 'hello', name: 'BOX',
    capabilities: { surfaces: ['term'], cmds: ['agy'] },
}).ok === false, 'worker name must match the public identity grammar');
ok(validateWorkerHello({
    type: 'hello', name: 'agy-box',
    capabilities: { surfaces: ['term'], cmds: ['/usr/bin/agy'] },
}).ok === false, 'capability lists reject host paths and unknown CLIs');
ok(validateWorkerHello({
    type: 'hello', name: 'agy-box',
    capabilities: { surfaces: ['agent'], agents: ['shell'] },
}).ok === false, 'shell is not a valid /agent advertisement');

try {
    loadWorkerToken({ controllerToken: 'same-secret', env: { BROKER_WORKER_TOKEN: 'same-secret' } });
    ok(false, 'equal controller and worker secrets fail closed');
} catch (e) {
    ok(/distinct/.test(e.message), 'equal controller and worker secrets fail closed');
}

function runDriver(args, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd: packageDir });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) {}
            resolve({ status: null, stdout, stderr, timedOut: true });
        }, timeoutMs);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr, timedOut: false });
        });
    });
}

function spawnBroker(env, port) {
    return spawn(process.execPath, ['src/broker.mjs'], {
        cwd: packageDir,
        env: { ...process.env, BROKER_REVERSE_WORKER: '', BROKER_WORKER_TOKEN: '', ...env, BROKER_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

async function waitHealth(port, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return res.json();
        } catch (_) {}
        await sleep(50);
    }
    throw new Error('child broker health timeout');
}

const equal = spawnSync(process.execPath, ['src/broker.mjs'], {
    cwd: packageDir,
    env: {
        ...process.env,
        BROKER_PORT: '8094',
        BROKER_TOKEN: 'shared-secret',
        BROKER_WORKER_TOKEN: 'shared-secret',
        BROKER_REVERSE_WORKER: '1',
        BROKER_WORKSPACE: process.env.BROKER_WORKSPACE,
    },
    encoding: 'utf8',
});
ok(equal.status !== 0 && /distinct/.test(equal.stderr || ''),
    'broker startup refuses a worker token equal to the pairing token');

const offPort = 8095;
const offChild = spawnBroker({
    BROKER_TOKEN: 'off-controller',
    BROKER_WORKSPACE: process.env.BROKER_WORKSPACE,
}, offPort);
try {
    await waitHealth(offPort);
    const offHealth = await (await fetch(`http://127.0.0.1:${offPort}/health`)).json();
    ok(offHealth.reverseWorkerEnabled === false && offHealth.workers === undefined,
        'unflagged health reports reverse-worker off and omits a worker list');
    let destroyed = false;
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${offPort}/worker`);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('unflagged /worker stayed open')), 2000);
            ws.on('error', () => { destroyed = true; clearTimeout(timer); resolve(); });
            ws.on('close', () => { destroyed = true; clearTimeout(timer); resolve(); });
            ws.on('open', () => { clearTimeout(timer); reject(new Error('unflagged /worker accepted a handshake')); });
        });
    } catch (e) {
        if (/stayed open|accepted/.test(e.message)) throw e;
        destroyed = true;
    }
    ok(destroyed, 'unflagged broker destroys /worker upgrades like any unknown path');
} catch (e) {
    ok(false, 'unflagged /worker check: ' + (e.message || e));
} finally {
    offChild.kill('SIGTERM');
}

const { httpServer, reverseWorkerHub } = await import('../src/broker.mjs');
await sleep(250);

console.log('\nCredential classes and registration\n');

try {
    const health0 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(health0.reverseWorkerEnabled === true && Array.isArray(health0.workers) && health0.workers.length === 0,
        'enabled health reports reverse-worker on and an empty worker list');

    const rejectedWorker = await connectWorker({ token: CONTROLLER, name: 'agy-box' });
    const rejectedHello = await rejectedWorker.welcome.catch(e => e);
    ok(rejectedHello?.error === 'unauthorized' || rejectedHello instanceof Error,
        'controller pairing token is rejected on /worker');
    try { rejectedWorker.ws.close(); } catch (_) {}

    for (const [label, pathName] of [['/term', '/term'], ['/agent', '/agent'], ['/app', '/app']]) {
        const { ws, first } = await connectController(pathName, WORKER);
        const reply = await first;
        const unauthorized = reply.kind === 'error' || reply.error === 'unauthorized' || /unauthor/i.test(reply.text || reply.error || '');
        ok(unauthorized, `worker token is rejected on ${label}`);
        try { ws.close(); } catch (_) {}
    }

    const mcp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WORKER}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    ok(mcp.status === 401, 'worker token is rejected on /mcp');
    const doctor = await fetch(`http://127.0.0.1:${PORT}/doctor`, {
        headers: { Authorization: `Bearer ${WORKER}` },
    });
    ok(doctor.status === 401, 'worker token is rejected on /doctor');

    const { ws: worker, welcome } = await connectWorker({ name: 'agy-box' });
    const welcomed = await welcome;
    ok(welcomed.type === 'welcome' && welcomed.protocolVersion === 1 && welcomed.name === 'agy-box',
        'worker hello is acknowledged with welcome and the registered name');

    const health1 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    const listed = health1.workers || [];
    ok(listed.length === 1 && listed[0].name === 'agy-box' &&
        listed[0].surfaces.includes('term') && listed[0].cmds.includes('agy') &&
        !JSON.stringify(listed[0]).includes(os.hostname()) &&
        !Object.keys(listed[0]).some(k => /host|pid|path|address|ip/i.test(k)),
        'health lists the worker by name and capabilities without host details');

    const replacement = await connectWorker({ name: 'agy-box' });
    const replacedClose = new Promise((resolve) => worker.once('close', (code) => resolve(code)));
    const replacementWelcome = await replacement.welcome;
    const replacedCode = await replacedClose;
    ok(replacementWelcome.type === 'welcome' && replacedCode === 1000,
        'a second hello for the same name replaces the previous worker socket');
    const health2 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok((health2.workers || []).length === 1 && health2.workers[0].name === 'agy-box',
        'health still shows one worker after replacement');
    try { replacement.ws.close(); } catch (_) {}
    await sleep(100);
} catch (e) {
    console.log('  ✗ unexpected auth/registration error: ' + (e.stack || e));
    failed++;
}

console.log('\nRelay round-trips\n');

try {
    const { ws: worker, welcome: workerWelcome } = await connectWorker({ name: 'relay-box' });
    await workerWelcome;
    const forwarded = [];
    worker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'welcome') return;
        forwarded.push(msg);
        if (msg.surface === 'term' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd }));
        } else if (msg.surface === 'term' && msg.type === 'input') {
            worker.send(JSON.stringify({ type: 'term', kind: 'data', data: 'HELLO_42\n' }));
        } else if (msg.surface === 'agent' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'agent', kind: 'started', text: msg.agent, experimental: true }));
        } else if (msg.surface === 'agent' && msg.type === 'input') {
            worker.send(JSON.stringify({ type: 'agent', kind: 'assistant', text: 'pong:' + msg.text }));
            worker.send(JSON.stringify({ type: 'agent', kind: 'result', text: '' }));
        }
    });

    const term = await connectController('/term');
    const termWelcome = await term.first;
    ok(termWelcome.kind === 'welcome' && termWelcome.enabled === true && (termWelcome.cmds || []).includes('shell'),
        '/term welcome lists the reverse worker\'s advertised cmds');
    const termEvents = collectUntil(term.ws, (m) => m.kind === 'data' && /HELLO_42/.test(m.data || ''));
    term.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
    await sleep(50);
    term.ws.send(JSON.stringify({ type: 'input', data: 'echo HELLO_42\n' }));
    const termGot = await termEvents;
    ok(termGot.some(m => m.type === 'term' && m.kind === 'started' && m.cmd === 'shell'),
        '/term start/started shapes are unchanged when relayed');
    ok(termGot.some(m => m.type === 'term' && m.kind === 'data' && m.data.includes('HELLO_42')),
        '/term input/data round-trips through the reverse worker');
    ok(forwarded.some(m => m.type === 'start' && m.surface === 'term' && m.cmd === 'shell'),
        'worker receives the controller start with a surface field');

    const agent = await connectController('/agent');
    const agentWelcome = await agent.first;
    ok(agentWelcome.kind === 'welcome' && (agentWelcome.agents || []).includes('agy'),
        '/agent welcome lists the reverse worker\'s advertised agents');
    const agentEvents = collectUntil(agent.ws, (m) => m.kind === 'result');
    agent.ws.send(JSON.stringify({ type: 'start', agent: 'agy' }));
    await sleep(50);
    agent.ws.send(JSON.stringify({ type: 'input', text: 'ping' }));
    const agentGot = await agentEvents;
    ok(agentGot.some(m => m.type === 'agent' && m.kind === 'started' && m.text === 'agy'),
        '/agent start/started shapes are unchanged when relayed');
    ok(agentGot.some(m => m.kind === 'assistant' && m.text === 'pong:ping') && agentGot.some(m => m.kind === 'result'),
        '/agent input/assistant/result round-trips through the reverse worker');

    try { term.ws.close(); } catch (_) {}
    try { agent.ws.close(); } catch (_) {}
    try { worker.close(); } catch (_) {}
    await sleep(100);
} catch (e) {
    console.log('  ✗ unexpected relay error: ' + (e.stack || e));
    failed++;
}

console.log('\nReconnect semantics\n');

try {
    const { ws: worker, welcome: reboxWelcome } = await connectWorker({ name: 'rebox' });
    await reboxWelcome;
    worker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.surface === 'term' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd }));
        }
    });
    const term = await connectController('/term');
    await term.first;
    const started = collectUntil(term.ws, (m) => m.kind === 'started');
    term.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
    await started;
    const gone = collectUntil(term.ws, (m, all) => all.some(x => x.kind === 'error') && all.some(x => x.kind === 'exit'));
    worker.close();
    const afterDrop = await gone;
    ok(afterDrop.some(m => m.kind === 'error' && /rebox/.test(m.text || '')) && afterDrop.some(m => m.kind === 'exit'),
        'worker disconnect unblocks the controller with error then exit');

    const { ws: worker2, welcome: worker2Welcome } = await connectWorker({
        name: 'rebox',
        sessions: { term: { live: true, cmd: 'shell' }, agent: { live: false } },
    });
    await worker2Welcome;
    let reattachStart = null;
    worker2.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.surface === 'term' && msg.type === 'start') {
            reattachStart = msg;
            worker2.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd, reattached: true }));
        }
    });
    const reattached = collectUntil(term.ws, (m) => m.kind === 'started' && m.reattached === true);
    term.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
    const reattachEvents = await reattached;
    ok(reattachStart && reattachEvents.some(m => m.reattached === true),
        'a reconnected worker claiming a live term session can reattach on the next start');
    try { term.ws.close(); } catch (_) {}
    try { worker2.close(); } catch (_) {}
    await sleep(100);
} catch (e) {
    console.log('  ✗ unexpected reconnect error: ' + (e.stack || e));
    failed++;
}

console.log('\nUnmodified controller driver\n');

try {
    const { ws: worker, welcome: driveWelcome } = await connectWorker({
        name: 'drive-box',
        capabilities: { surfaces: ['term', 'agent'], cmds: ['shell', 'agy'], agents: ['agy'] },
    });
    await driveWelcome;
    worker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.surface === 'term' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd }));
        } else if (msg.surface === 'term' && msg.type === 'input') {
            worker.send(JSON.stringify({ type: 'term', kind: 'data', data: 'HELLO_42\r\n' }));
        } else if (msg.surface === 'agent' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'agent', kind: 'started', text: msg.agent }));
        } else if (msg.surface === 'agent' && msg.type === 'input') {
            worker.send(JSON.stringify({ type: 'agent', kind: 'assistant', text: 'ok-from-reverse' }));
            worker.send(JSON.stringify({ type: 'agent', kind: 'result', text: '' }));
        }
    });

    const termDrive = await runDriver([
        path.join(packageDir, 'scripts', 'term-drive.mjs'),
        '--url', `ws://127.0.0.1:${PORT}/term`,
        '--token-file', controllerTokenFile,
        '--start', 'shell',
        '--send', 'echo HELLO_42',
        '--read-ms', '2000',
    ]);
    ok(termDrive.status === 0 && /HELLO_42/.test(termDrive.stdout || ''),
        'unmodified term-drive.mjs drives a reverse worker through /term');

    const promptFile = path.join(testRoot, 'prompt.txt');
    fs.writeFileSync(promptFile, 'say ok');
    const agentDrive = await runDriver([
        path.join(packageDir, 'scripts', 'agent-drive.mjs'),
        '--url', `ws://127.0.0.1:${PORT}/agent`,
        '--token-file', controllerTokenFile,
        '--agent', 'agy',
        '--prompt-file', promptFile,
        '--timeout-ms', '8000',
    ]);
    ok(agentDrive.status === 0 && /ok-from-reverse/.test(agentDrive.stdout || ''),
        'unmodified agent-drive.mjs drives a reverse worker through /agent');

    await new Promise((resolve) => { worker.once('close', resolve); try { worker.close(); } catch (_) { resolve(); } });
} catch (e) {
    console.log('  ✗ unexpected driver error: ' + (e.stack || e));
    failed++;
}

let hasPty = false;
try { await import('node-pty'); hasPty = true; } catch (_) {}
if (hasPty) {
    console.log('\nReal shim + term-drive\n');
    try {
        const shim = spawn(process.execPath, [
            path.join(packageDir, 'scripts', 'reverse-worker.mjs'),
            '--url', `ws://127.0.0.1:${PORT}/worker`,
            '--token-file', workerTokenFile,
            '--name', 'shim-box',
            '--surfaces', 'term',
            '--cmds', 'shell',
            '--cwd', process.env.BROKER_WORKSPACE,
            '--grace-ms', '5000',
        ], { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] });
        const shimReady = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('shim welcome timeout')), 5000);
            shim.stderr.on('data', (d) => {
                if (/welcome/.test(d.toString())) { clearTimeout(timer); resolve(); }
            });
            shim.on('error', reject);
        });
        await shimReady;
        const driven = await runDriver([
            path.join(packageDir, 'scripts', 'term-drive.mjs'),
            '--url', `ws://127.0.0.1:${PORT}/term`,
            '--token-file', controllerTokenFile,
            '--start', 'shell',
            '--send', 'echo HELLO_42',
            '--read-ms', '2500',
        ], 20000);
        ok(driven.status === 0 && /HELLO_42/.test(driven.stdout || ''),
            'real reverse-worker shim + unmodified term-drive.mjs round-trip a shell echo');
        try { shim.kill('SIGTERM'); } catch (_) {}
    } catch (e) {
        console.log('  ✗ real shim error: ' + (e.stack || e));
        failed++;
    }
} else {
    console.log('\nReal shim + term-drive — skipped (node-pty not installed)\n');
}

ok(reverseWorkerHub.enabled === true, 'imported broker exposed the reverse-worker hub');

console.log(`\n${passed} passed, ${failed} failed`);
await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    httpServer.close(() => { clearTimeout(timer); resolve(); });
});
fs.rmSync(testRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
