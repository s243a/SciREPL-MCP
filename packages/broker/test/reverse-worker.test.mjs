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
import { childProcessEnv, loadWorkerToken, validateWorkerHello, workerWebSocketUrl, boundedInteger, auditSafeIdentity } from '../src/reverse-worker.mjs';

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

const envDefault = childProcessEnv({
    source: { HOME: '/home/w', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', SCIREPL_MCP_BEARER: 'controller', FOO: 'bar' },
});
ok(envDefault.HOME === '/home/w' && envDefault.PATH === '/bin' &&
    envDefault.ANTHROPIC_API_KEY === undefined && envDefault.SCIREPL_MCP_BEARER === undefined && envDefault.FOO === undefined,
    'shim child env allowlist omits provider keys and the controller token by default');
const envKeys = childProcessEnv({
    useApiKey: true,
    source: { HOME: '/home/w', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'ok', FOO: 'bar' },
});
ok(envKeys.ANTHROPIC_API_KEY === 'sk-secret' && envKeys.OPENAI_API_KEY === 'ok' && envKeys.FOO === undefined,
    '--use-api-key passes provider keys without inheriting the rest of the environment');
const envInherit = childProcessEnv({
    inheritEnv: true,
    source: { HOME: '/home/w', FOO: 'bar', ANTHROPIC_API_KEY: 'sk-secret' },
});
ok(envInherit.FOO === 'bar' && envInherit.ANTHROPIC_API_KEY === 'sk-secret',
    '--inherit-env passes the shim environment through');

ok(workerWebSocketUrl('127.0.0.1', 8087) === 'ws://127.0.0.1:8087/worker',
    'worker URL leaves IPv4 hosts unbracketed');
ok(workerWebSocketUrl('::1', 8087) === 'ws://[::1]:8087/worker',
    'worker URL brackets IPv6 loopback');
ok(workerWebSocketUrl('::', 8087) === 'ws://127.0.0.1:8087/worker',
    'worker URL maps unspecified IPv6 bind to loopback IPv4');
ok(auditSafeIdentity('agy') === 'agy' && auditSafeIdentity("shell'\n[broker] x") === '?',
    'audit identities accept known CLIs and reject newline injection');
ok(boundedInteger('', 1048576, 1024, 16777216, 'cap') === 1048576, 'bounded integer uses fallback when unset');
try {
    boundedInteger('NaN', 1048576, 1024, 16777216, '--max-outbound-buffered-bytes');
    ok(false, 'NaN backpressure is rejected');
} catch (e) {
    ok(/must be an integer/.test(e.message), 'NaN backpressure is rejected');
}
try {
    boundedInteger('Infinity', 1048576, 1024, 16777216, '--max-outbound-buffered-bytes');
    ok(false, 'Infinity backpressure is rejected');
} catch (e) {
    ok(/must be an integer/.test(e.message), 'Infinity backpressure is rejected');
}

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
        env: { ...process.env, BROKER_REVERSE_WORKER: '', BROKER_WORKER_TOKEN: '', BROKER_REVERSE_WORKER_STRICT: '', ...env, BROKER_PORT: String(port) },
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

const strictPort = 8092;
const strictChild = spawnBroker({
    BROKER_TOKEN: 'strict-controller',
    BROKER_WORKER_TOKEN: 'strict-worker-token',
    BROKER_REVERSE_WORKER: '1',
    BROKER_REVERSE_WORKER_STRICT: '1',
    BROKER_TERM: '1',
    BROKER_AGENT: '1',
    BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE: '1',
    BROKER_WORKSPACE: process.env.BROKER_WORKSPACE,
}, strictPort);
try {
    const strictHealth = await waitHealth(strictPort);
    ok(strictHealth.reverseWorkerEnabled === true && strictHealth.reverseWorkerStrict === true,
        'strict reverse-worker health reports reverseWorkerStrict');
    const strictTerm = new WebSocket(`ws://127.0.0.1:${strictPort}/term`);
    await new Promise((res, rej) => { strictTerm.on('open', res); strictTerm.on('error', rej); });
    const strictFirst = onceMessage(strictTerm);
    strictTerm.send(JSON.stringify({ type: 'hello', token: 'strict-controller' }));
    await strictFirst;
    const strictReply = onceMessage(strictTerm);
    strictTerm.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
    const strictMsg = await strictReply;
    ok(strictMsg.type === 'term' && strictMsg.kind === 'error' && /no reverse worker advertised/.test(strictMsg.text || ''),
        'strict mode fails a start that no worker advertised instead of spawning locally');
    try { strictTerm.close(); } catch (_) {}
} catch (e) {
    ok(false, 'strict reverse-worker check: ' + (e.message || e));
} finally {
    strictChild.kill('SIGTERM');
}

const { httpServer, reverseWorkerHub, termBridge } = await import('../src/broker.mjs');
await sleep(250);

console.log('\nCredential classes and registration\n');

try {
    const health0 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(health0.reverseWorkerEnabled === true && health0.reverseWorkerStrict === false &&
        Array.isArray(health0.workers) && health0.workers.length === 0,
        'enabled health reports reverse-worker on, strict off, and an empty worker list');

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

    const raced = await connectWorker({ name: 'agy-box' });
    const racedHello = await raced.welcome;
    const healthRaced = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(racedHello.error === 'worker name is already connected' &&
        (healthRaced.workers || []).length === 1 && healthRaced.workers[0].name === 'agy-box',
        'a rapid second hello for a live name without a live-session claim is rejected');
    try { raced.ws.close(); } catch (_) {}

    const replacement = await connectWorker({
        name: 'agy-box',
        sessions: { term: { live: true, cmd: 'shell' }, agent: { live: false } },
    });
    const replacedClose = new Promise((resolve) => worker.once('close', (code) => resolve(code)));
    const replacementWelcome = await replacement.welcome;
    const replacedCode = await replacedClose;
    ok(replacementWelcome.type === 'welcome' && replacedCode === 1000,
        'a live-session claim can replace a still-connected worker of the same name');
    const health2 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok((health2.workers || []).length === 1 && health2.workers[0].name === 'agy-box',
        'health still shows one worker after replacement');

    const secondHello = onceMessage(replacement.ws);
    replacement.ws.send(JSON.stringify({
        type: 'hello',
        token: WORKER,
        name: 'other-box',
        capabilities: { surfaces: ['agent'], agents: ['claude'] },
    }));
    const secondHelloReply = await secondHello;
    const healthAfterSecond = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(secondHelloReply.error === 'already authenticated' &&
        (healthAfterSecond.workers || []).length === 1 &&
        healthAfterSecond.workers[0].name === 'agy-box',
        'a second hello on an authenticated worker socket is rejected without registering aliases');

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
            worker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd, via: 'spoofed' }));
        } else if (msg.surface === 'term' && msg.type === 'input') {
            worker.send(JSON.stringify({ type: 'term', kind: 'data', data: 'HELLO_42\n', via: 'spoofed' }));
        } else if (msg.surface === 'agent' && msg.type === 'start') {
            worker.send(JSON.stringify({ type: 'agent', kind: 'started', text: msg.agent, experimental: true, via: 'spoofed' }));
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
    ok(termGot.some(m => m.type === 'term' && m.kind === 'started' && m.cmd === 'shell' && m.via === 'relay-box'),
        '/term started is unchanged except for a broker-authored via worker name');
    ok(termGot.some(m => m.type === 'term' && m.kind === 'started' && m.via === 'relay-box') &&
        !termGot.some(m => m.kind === 'started' && m.via === 'spoofed'),
        'worker cannot spoof the via field on started');
    ok(termGot.some(m => m.type === 'term' && m.kind === 'data' && m.data.includes('HELLO_42') && m.via === undefined),
        '/term input/data round-trips through the reverse worker without a spoofable via');
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
    ok(agentGot.some(m => m.type === 'agent' && m.kind === 'started' && m.text === 'agy' && m.via === 'relay-box'),
        '/agent started is unchanged except for a broker-authored via worker name');
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

console.log('\nLifecycle routing, detach, and audit\n');

try {
    const audit = [];
    const origLog = console.log;
    let agyWorker, claudeWorker, agent, agyCmds, claudeCmds, agyWelcome, claudeWelcome;
    console.log = (...args) => {
        const line = args.join(' ');
        if (line.includes('[broker]')) audit.push(line);
        origLog(...args);
    };
    try {
    ({ ws: agyWorker, welcome: agyWelcome } = await connectWorker({
        name: 'agy-only',
        capabilities: { surfaces: ['agent'], agents: ['agy'] },
    }));
    await agyWelcome;
    ({ ws: claudeWorker, welcome: claudeWelcome } = await connectWorker({
        name: 'claude-only',
        capabilities: { surfaces: ['agent'], agents: ['claude'] },
    }));
    await claudeWelcome;
    agyCmds = [];
    claudeCmds = [];
    agyWorker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'welcome') return;
        agyCmds.push(msg);
        if (msg.type === 'start') agyWorker.send(JSON.stringify({ type: 'agent', kind: 'started', text: msg.agent }));
    });
    claudeWorker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'welcome') return;
        claudeCmds.push(msg);
        if (msg.type === 'start') claudeWorker.send(JSON.stringify({ type: 'agent', kind: 'started', text: msg.agent }));
    });

    agent = await connectController('/agent');
    await agent.first;
    const agyStarted = collectUntil(agent.ws, (m) => m.kind === 'started');
    agent.ws.send(JSON.stringify({ type: 'start', agent: 'agy' }));
    await agyStarted;
    agent.ws.send(JSON.stringify({ type: 'stop' }));
    const stopDeadline = Date.now() + 1000;
    while (!agyCmds.some(m => m.type === 'stop') && Date.now() < stopDeadline) await sleep(20);
    const claudeStarted = collectUntil(agent.ws, (m) => m.kind === 'started' && m.text === 'claude');
    agent.ws.send(JSON.stringify({ type: 'start', agent: 'claude' }));
    await claudeStarted;
    } finally {
        console.log = origLog;
    }

    ok(agyCmds.some(m => m.type === 'start' && m.agent === 'agy') &&
        !agyCmds.some(m => m.type === 'start' && m.agent === 'claude') &&
        claudeCmds.some(m => m.type === 'start' && m.agent === 'claude') &&
        agyCmds.some(m => m.type === 'stop'),
        'stop clears the reverse session so a later start selects a worker that advertised that CLI');
    ok(audit.some(l => /agent 'agy' start requested via worker 'agy-only'/.test(l)) &&
        audit.some(l => /agent 'agy' ready via worker 'agy-only'/.test(l)) &&
        audit.some(l => /agent 'agy' stop requested via worker 'agy-only'/.test(l)) &&
        audit.some(l => /agent 'claude' start requested via worker 'claude-only'/.test(l)) &&
        audit.some(l => /agent 'claude' ready via worker 'claude-only'/.test(l)),
        'audit logs start requested before worker ack, started/ready on ack, and stop requested');

    try { agent.ws.close(); } catch (_) {}
    try { agyWorker.close(); } catch (_) {}
    try { claudeWorker.close(); } catch (_) {}
    await sleep(100);

    const { ws: termWorker, welcome: termWelcome } = await connectWorker({
        name: 'term-box',
        capabilities: { surfaces: ['term'], cmds: ['shell'] },
    });
    await termWelcome;
    const termCmds = [];
    termWorker.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'welcome') return;
        termCmds.push(msg);
        if (msg.type === 'start') termWorker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: msg.cmd }));
    });
    const term = await connectController('/term');
    await term.first;
    const termStarted = collectUntil(term.ws, (m) => m.kind === 'started');
    term.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
    await termStarted;
    const detached = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('detach not forwarded')), 2000);
        const onMsg = (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
            if (msg.type === 'detach' && msg.surface === 'term') {
                clearTimeout(timer);
                termWorker.off('message', onMsg);
                resolve(msg);
            }
        };
        termWorker.on('message', onMsg);
    });
    try { term.ws.close(); } catch (_) {}
    await detached;
    ok(termCmds.some(m => m.type === 'detach' && m.surface === 'term') &&
        !termCmds.some(m => m.type === 'stop'),
        'controller /term disconnect forwards detach and does not stop the worker PTY');
    try { termWorker.close(); } catch (_) {}
    await sleep(100);

    const injLogs = [];
    const injOrig = console.log;
    console.log = (...args) => { injLogs.push(args.join(' ')); injOrig(...args); };
    try {
        const { ws: injWorker, welcome: injWelcome } = await connectWorker({
            name: 'inj-box',
            capabilities: { surfaces: ['term'], cmds: ['shell'] },
        });
        await injWelcome;
        injWorker.on('message', (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
            if (msg.type === 'start') {
                injWorker.send(JSON.stringify({ type: 'term', kind: 'started', cmd: "shell'\n[broker] injected-pwn" }));
            }
        });
        const injTerm = await connectController('/term');
        await injTerm.first;
        const injStarted = collectUntil(injTerm.ws, (m) => m.kind === 'started');
        injTerm.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
        await injStarted;
        try { injTerm.ws.close(); } catch (_) {}
        try { injWorker.close(); } catch (_) {}
        await sleep(50);
    } finally {
        console.log = injOrig;
    }
    ok(injLogs.some(l => /term 'shell' started via worker 'inj-box'/.test(l)) &&
        !injLogs.some(l => /injected-pwn/.test(l)),
        'audit uses the controller-requested CLI and ignores worker-supplied started text');
} catch (e) {
    console.log('  ✗ unexpected lifecycle error: ' + (e.stack || e));
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
        await sleep(150);

        const graceShim = spawn(process.execPath, [
            path.join(packageDir, 'scripts', 'reverse-worker.mjs'),
            '--url', `ws://127.0.0.1:${PORT}/worker`,
            '--token-file', workerTokenFile,
            '--name', 'grace-box',
            '--surfaces', 'term',
            '--cmds', 'shell',
            '--cwd', process.env.BROKER_WORKSPACE,
            '--grace-ms', '150',
        ], { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('grace shim welcome timeout')), 5000);
            graceShim.stderr.on('data', (d) => {
                if (/welcome/.test(d.toString())) { clearTimeout(timer); resolve(); }
            });
            graceShim.on('error', reject);
        });
        const graceTerm = await connectController('/term');
        await graceTerm.first;
        const graceStarted = collectUntil(graceTerm.ws, (m) => m.kind === 'started');
        graceTerm.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
        await graceStarted;
        try { graceTerm.ws.close(); } catch (_) {}
        await sleep(400);
        const graceTerm2 = await connectController('/term');
        await graceTerm2.first;
        const graceStarted2 = collectUntil(graceTerm2.ws, (m) => m.kind === 'started');
        graceTerm2.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
        const afterGrace = await graceStarted2;
        ok(afterGrace.some(m => m.kind === 'started' && m.via === 'grace-box' && m.reattached !== true),
            'expired term grace does not reattach a controller that disconnected');
        try { graceTerm2.ws.close(); } catch (_) {}
        try { graceShim.kill('SIGTERM'); } catch (_) {}
        await sleep(200);

        const localTerm = await connectController('/term');
        await localTerm.first;
        const localStarted = collectUntil(localTerm.ws, (m) => m.kind === 'started');
        localTerm.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
        const localGot = await localStarted;
        ok(localGot.some(m => m.kind === 'started' && m.via === undefined),
            'with no worker, /term start stays on the local PTY');
        const sneak = await connectWorker({
            name: 'sneak-box',
            capabilities: { surfaces: ['term'], cmds: ['shell'] },
        });
        await sneak.welcome;
        let sneakStart = false;
        sneak.ws.on('message', (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
            if (msg.type === 'start') sneakStart = true;
        });
        const localReattach = collectUntil(localTerm.ws, (m) => m.kind === 'started');
        localTerm.ws.send(JSON.stringify({ type: 'start', cmd: 'shell', cols: 80, rows: 24 }));
        const reattachGot = await localReattach;
        ok(reattachGot.some(m => m.kind === 'started' && m.reattached === true && m.via === undefined) && !sneakStart,
            'a later worker does not steal an already-running local PTY');
        try { localTerm.ws.close(); } catch (_) {}
        try { sneak.ws.close(); } catch (_) {}
        await sleep(100);
        if (termBridge.running()) termBridge.stop();
    } catch (e) {
        console.log('  ✗ real shim error: ' + (e.stack || e));
        failed++;
    }
} else {
    console.log('\nReal shim + term-drive — skipped (node-pty not installed)\n');
}

console.log('\nWorker-link loss kills /agent children\n');
try {
    const binDir = path.join(testRoot, 'fake-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const pidFile = path.join(testRoot, 'fake-claude.pid');
    const fakeScript = path.join(binDir, 'claude.mjs');
    fs.writeFileSync(fakeScript, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 60000);
`);
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    } else {
        fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`, { mode: 0o755 });
    }
    const killShim = spawn(process.execPath, [
        path.join(packageDir, 'scripts', 'reverse-worker.mjs'),
        '--url', `ws://127.0.0.1:${PORT}/worker`,
        '--token-file', workerTokenFile,
        '--name', 'kill-box',
        '--surfaces', 'agent',
        '--agents', 'claude',
        '--cwd', process.env.BROKER_WORKSPACE,
    ], {
        cwd: packageDir,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('kill shim welcome timeout')), 5000);
        killShim.stderr.on('data', (d) => {
            if (/welcome/.test(d.toString())) { clearTimeout(timer); resolve(); }
        });
        killShim.on('error', reject);
    });
    const killer = await connectController('/agent');
    await killer.first;
    const killStarted = collectUntil(killer.ws, (m) => m.kind === 'started');
    killer.ws.send(JSON.stringify({ type: 'start', agent: 'claude' }));
    await killStarted;
    const waitPid = Date.now() + 4000;
    while (!fs.existsSync(pidFile) && Date.now() < waitPid) await sleep(30);
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : 0;
    const pidAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    ok(pid > 0 && pidAlive(pid), 'fake claude child is running after reverse start');
    const registered = reverseWorkerHub._workers.get('kill-box');
    try { registered.ws.close(); } catch (_) {}
    const deadDeadline = Date.now() + 3000;
    while (pid > 0 && pidAlive(pid) && Date.now() < deadDeadline) await sleep(30);
    ok(pid > 0 && !pidAlive(pid), 'worker-link loss kills the /agent child');
    try { killer.ws.close(); } catch (_) {}
    try { killShim.kill('SIGTERM'); } catch (_) {}
} catch (e) {
    console.log('  ✗ agent-kill-on-disconnect error: ' + (e.stack || e));
    failed++;
}

ok(reverseWorkerHub.enabled === true, 'imported broker exposed the reverse-worker hub');

console.log(`\n${passed} passed, ${failed} failed`);
await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    httpServer.close(() => { clearTimeout(timer); resolve(); });
});
fs.rmSync(testRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
