#!/usr/bin/env node
/**
 * reverse-worker.mjs — dial out to the broker's /worker endpoint, register, and
 * run local CLI/PTY processes on the broker's command. Controllers keep speaking
 * /term and /agent at the hub; this process is the execution host.
 *
 *   node reverse-worker.mjs --url ws://HOST:8087/worker --token-file FILE \
 *        --name agy-box --surfaces term,agent --cmds agy --agents agy \
 *        [--cwd DIR] [--grace-ms 600000] [--use-api-key] [--inherit-env]
 *
 * Reconnects with backoff. A live PTY survives socket drop for --grace-ms so a
 * later start can reattach, matching the broker's local /term behaviour.
 * Does not read or embed the controller pairing token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { childProcessEnv, boundedInteger, KNOWN_AGENTS, terminateChild } from '../src/reverse-worker.mjs';
import { nodePtyUsable } from '../src/node-pty-support.mjs';
import { truncateCodePoints } from '../src/utf8-pipes.mjs';
import { finalizeAfterStdioClose, spawnUtf8Child } from '../src/spawn-child.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const argIdx = (n) => process.argv.indexOf(`--${n}`);
const arg = (n, d) => { const i = argIdx(n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => argIdx(n) !== -1;
const csv = (n, d) => String(arg(n, d) || '').split(',').map(s => s.trim()).filter(Boolean);

const url = arg('url');
const tokenFile = arg('token-file');
const tokenArg = arg('token', '');
if (!url || (!tokenFile && !tokenArg)) {
    console.error('usage: reverse-worker.mjs --url ws://HOST:PORT/worker --token-file FILE --name NAME [--surfaces term,agent] [--cmds LIST] [--agents LIST] [--cwd DIR] [--use-api-key] [--inherit-env]');
    process.exit(2);
}

const TOKEN = (tokenArg || fs.readFileSync(tokenFile, 'utf8')).trim();
const NAME = arg('name', 'worker');

function nodePtyAvailable() {
    return nodePtyUsable();
}

function commandExists(name) {
    const envPath = process.env.PATH || process.env.Path || '';
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of envPath.split(path.delimiter)) {
        if (!dir) continue;
        const names = process.platform === 'win32'
            ? [name, ...exts.map(ext => name + ext)]
            : [name];
        for (const file of names) {
            try {
                if (fs.statSync(path.join(dir, file)).isFile()) return true;
            } catch (_) {}
        }
    }
    return false;
}

const SURFACES = has('surfaces') ? csv('surfaces') : ['agent'];
if (SURFACES.includes('term') && !nodePtyAvailable()) {
    console.error('reverse-worker.mjs: --surfaces includes term but node-pty is not usable on this host');
    process.exit(2);
}
const CMDS = has('cmds') ? csv('cmds') : (SURFACES.includes('term') ? ['shell'] : []);
const AGENTS = has('agents')
    ? csv('agents')
    : (SURFACES.includes('agent') ? KNOWN_AGENTS.filter(commandExists) : []);
if (SURFACES.includes('agent') && !AGENTS.length) {
    console.error('reverse-worker.mjs: pass --agents listing CLIs this host has; none were found on PATH');
    process.exit(2);
}
if (SURFACES.includes('term') && !CMDS.length) {
    console.error('reverse-worker.mjs: --surfaces includes term but --cmds is empty');
    process.exit(2);
}
const CWD = path.resolve(arg('cwd', process.cwd()));
let GRACE_MS;
let MAX_AGENT_BUFFER_BYTES;
let MAX_OUTBOUND_BUFFERED_BYTES;
try {
    GRACE_MS = boundedInteger(arg('grace-ms', ''), 600000, 0, 86400000, '--grace-ms');
    MAX_AGENT_BUFFER_BYTES = boundedInteger(arg('max-agent-buffer-bytes', ''), 1048576, 4096, 67108864, '--max-agent-buffer-bytes');
    MAX_OUTBOUND_BUFFERED_BYTES = boundedInteger(arg('max-outbound-buffered-bytes', ''), 1048576, 1024, 16777216, '--max-outbound-buffered-bytes');
} catch (e) {
    console.error('reverse-worker.mjs: ' + (e.message || e));
    process.exit(2);
}
const TERM_SHELL = process.env.SHELL || 'bash';
const TERM_NO_SHELL = has('no-shell') || process.env.BROKER_TERM_NO_SHELL === '1';
const USE_API_KEY = has('use-api-key') || process.env.BROKER_AGENT_USE_API_KEY === '1';
const INHERIT_ENV = has('inherit-env') || process.env.BROKER_AGENT_INHERIT_ENV === '1';

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function resolveTermCmd(name) {
    const want = (name || 'shell').trim();
    if (!CMDS.includes(want)) return null;
    if (want === 'shell') return { cmd: TERM_SHELL, args: ['-l'], label: TERM_SHELL };
    const agentCmd = want === 'agy' ? `agy --add-dir ${shq(CWD)}` : shq(want);
    const inner = TERM_NO_SHELL
        ? `${agentCmd}; ec=$?; echo; echo "[${want} exited ($ec)]"`
        : `${agentCmd}; ec=$?; echo; echo "[${want} exited ($ec) — you're in a shell now; exit/Ctrl-D to close]"; exec ${shq(TERM_SHELL)} -i`;
    return { cmd: TERM_SHELL, args: ['-c', inner], label: want };
}

const AGENT_PROFILES = {
    claude: {
        cmd: 'claude',
        args(opts = {}) {
            const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
            if (opts.resume) a.push('--resume', opts.resume);
            return a;
        },
        encodeTurn(text) {
            return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
        },
        normalize(o) {
            if (o.type === 'assistant' && o.message) {
                const blocks = o.message.content || [];
                const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
                const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name);
                if (tools.length) return { kind: 'tool_use', tool: tools.join(', '), text };
                if (text) return { kind: 'assistant', text };
                return null;
            }
            if (o.type === 'result') return { kind: 'result', text: o.result || '', error: o.is_error || false };
            return null;
        },
    },
    codex: {
        experimental: true, mode: 'oneshot', cmd: 'codex',
        buildArgs(text, sessionId) {
            return sessionId
                ? ['exec', 'resume', '--skip-git-repo-check', '--json', sessionId, text]
                : ['exec', '--skip-git-repo-check', '--json', text];
        },
        sessionIdFrom(o) { return (o.type === 'thread.started' && o.thread_id) ? o.thread_id : null; },
        normalize(o) {
            if (o.type === 'item.completed' && o.item?.type === 'agent_message') return { kind: 'assistant', text: o.item.text || '' };
            if (o.type === 'turn.completed') return { kind: 'result', text: '' };
            if (o.type === 'error' || o.error) return { kind: 'error', text: o.message || 'codex error' };
            return null;
        },
    },
    gemini: {
        experimental: true, mode: 'oneshot', cmd: 'gemini',
        buildArgs(text, sessionId) { const a = ['-p', text, '-o', 'stream-json']; if (sessionId) a.push('-r', 'latest'); return a; },
        sessionIdFrom(o) { return (o.type === 'init' && o.session_id) ? o.session_id : null; },
        normalize(o) {
            if (o.type === 'message') return o.role === 'assistant' ? { kind: 'assistant', text: o.content || '' } : null;
            if (o.type === 'tool_call' || o.type === 'tool') return { kind: 'tool_use', tool: o.name || 'tool', text: '' };
            if (o.type === 'result') return { kind: 'result', text: '' };
            if (o.type === 'error') return { kind: 'error', text: o.message || 'gemini error' };
            return null;
        },
    },
    agy: {
        experimental: true, mode: 'oneshot', format: 'text', cmd: 'agy',
        buildArgs(text, sessionId) {
            const a = ['--add-dir', CWD];
            if (sessionId) a.push('-c');
            a.push('-p', text);
            return a;
        },
    },
};

const term = { pty: null, label: null, cols: 80, rows: 24, grace: null };
const agent = { child: null, profile: null, name: null, buf: '', sessionId: null, sessionAgent: null, mode: null };

function forgetResumeUnless(name) {
    const owner = agent.sessionAgent || agent.name;
    if (owner && owner !== name) {
        agent.sessionId = null;
        agent.sessionAgent = null;
    }
}

function rememberResume(id) {
    if (!id || !agent.name) return;
    agent.sessionId = id;
    agent.sessionAgent = agent.name;
}

let stopping = false;
let activeWs = null;
let send = () => false;

function sendJson(ws, payload) {
    if (!ws || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > MAX_OUTBOUND_BUFFERED_BYTES) {
        try { ws.close(1013, 'outbound backpressure limit'); } catch (_) {}
        return false;
    }
    try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
}

function bindSender(ws) {
    send = (payload) => sendJson(ws, payload);
}

function spawnEnv() {
    return childProcessEnv({ inheritEnv: INHERIT_ENV, useApiKey: USE_API_KEY });
}

function spawnChild(command, args, stdio) {
    return spawnUtf8Child(command, args, {
        env: spawnEnv(),
        cwd: CWD,
        stdio,
        detached: process.platform !== 'win32',
        windowsHide: true,
    });
}

function emitAgentStderr(text) {
    send({ type: 'agent', kind: 'stderr', text: truncateCodePoints(text, 500) });
}

async function startTerm(msg) {
    if (term.pty) {
        if (term.grace) { clearTimeout(term.grace); term.grace = null; }
        try { term.pty.write('\f'); } catch (_) {}
        send({ type: 'term', kind: 'started', cmd: term.label, reattached: true });
        return;
    }
    const spec = resolveTermCmd(msg.cmd);
    if (!spec) {
        send({ type: 'term', kind: 'error', text: `command not allowed: ${msg.cmd} (allowed: ${CMDS.join(', ')})` });
        return;
    }
    let ptyLib;
    try { ptyLib = (await import('node-pty')).default || (await import('node-pty')); }
    catch (e) { send({ type: 'term', kind: 'error', text: 'node-pty not installed on the worker host' }); return; }
    if (!fs.existsSync(CWD) || !fs.statSync(CWD).isDirectory()) {
        send({ type: 'term', kind: 'error', text: 'worker cwd does not exist' });
        return;
    }
    term.cols = msg.cols || 80;
    term.rows = msg.rows || 24;
    let p;
    try {
        p = ptyLib.spawn(spec.cmd, spec.args, {
            name: 'xterm-256color',
            cols: term.cols,
            rows: term.rows,
            cwd: CWD,
            env: { ...spawnEnv(), TERM: 'xterm-256color' },
        });
    } catch (e) {
        send({ type: 'term', kind: 'error', text: 'spawn failed: ' + (e.message || e) });
        return;
    }
    term.pty = p;
    term.label = spec.label;
    p.onData((d) => send({ type: 'term', kind: 'data', data: d }));
    p.onExit(({ exitCode }) => {
        if (term.pty === p) {
            term.pty = null;
            term.label = null;
            if (term.grace) { clearTimeout(term.grace); term.grace = null; }
            send({ type: 'term', kind: 'exit', code: exitCode });
        }
    });
    send({ type: 'term', kind: 'started', cmd: spec.label });
}

function inputTerm(data) {
    if (term.pty) { try { term.pty.write(data); } catch (_) {} }
}

function resizeTerm(cols, rows) {
    if (cols && rows) {
        term.cols = cols;
        term.rows = rows;
        if (term.pty) { try { term.pty.resize(cols, rows); } catch (_) {} }
    }
}

function stopTerm() {
    if (term.grace) { clearTimeout(term.grace); term.grace = null; }
    if (term.pty) {
        try { term.pty.kill(); } catch (_) {}
        term.pty = null;
        term.label = null;
    }
}

function parkTerm() {
    if (!term.pty || term.grace) return;
    if (GRACE_MS <= 0) {
        stopTerm();
        return;
    }
    term.grace = setTimeout(() => { term.grace = null; stopTerm(); }, GRACE_MS);
}

function startAgent(name) {
    const prof = AGENT_PROFILES[name];
    if (!prof) { send({ type: 'agent', kind: 'error', text: `unknown agent: ${name}` }); return; }
    if (!AGENTS.includes(name)) { send({ type: 'agent', kind: 'error', text: `agent not advertised: ${name}` }); return; }
    forgetResumeUnless(name);
    if (prof.mode === 'oneshot') {
        stopAgentChild();
        agent.profile = prof;
        agent.name = name;
        agent.mode = 'oneshot';
        send({ type: 'agent', kind: 'started', text: name, experimental: !!prof.experimental });
        return;
    }
    if (agent.child && agent.name === name) {
        agent.mode = 'persistent';
        send({ type: 'agent', kind: 'started', text: name, experimental: !!prof.experimental, reused: true });
        return;
    }
    stopAgentChild();
    const resume = agent.sessionId || null;
    let child;
    try { child = spawnChild(prof.cmd, prof.args({ resume }), ['pipe', 'pipe', 'pipe']); }
    catch (e) { send({ type: 'agent', kind: 'error', text: `spawn failed: ${e.message}` }); return; }
    agent.child = child;
    agent.profile = prof;
    agent.name = name;
    agent.mode = 'persistent';
    agent.buf = '';
    child.once('spawn', () => {
        if (agent.child !== child) return;
        send({ type: 'agent', kind: 'started', text: name, experimental: !!prof.experimental, resumed: !!resume });
    });
    child.stdout.on('data', (d) => {
        if (agent.child !== child) return;
        const chunk = typeof d === 'string' ? d : d.toString();
        if (Buffer.byteLength(agent.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
            agent.child = null;
            terminateChild(child);
            send({ type: 'agent', kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes without a complete event` });
            send({ type: 'agent', kind: 'exit', code: null });
            return;
        }
        agent.buf += chunk;
        let i;
        while ((i = agent.buf.indexOf('\n')) >= 0) {
            const line = agent.buf.slice(0, i); agent.buf = agent.buf.slice(i + 1);
            if (!line.trim()) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            if (o.session_id) rememberResume(o.session_id);
            const n = prof.normalize(o);
            if (n) send({ type: 'agent', ...n });
        }
    });
    child.stderr.on('data', (d) => {
        if (agent.child !== child) return;
        emitAgentStderr(d);
    });
    finalizeAfterStdioClose(child, {
        onSpawnError(e) {
            if (agent.child !== child) return;
            agent.child = null;
            send({ type: 'agent', kind: 'error', text: `failed to start ${name}: ${e.message || e}` });
            send({ type: 'agent', kind: 'exit', code: null });
        },
        onClose(code) {
            if (agent.child !== child) return;
            agent.child = null;
            send({ type: 'agent', kind: 'exit', code });
        },
    });
}

function oneshotTurn(text) {
    if (agent.child) return false;
    const prof = agent.profile;
    if (!prof) { send({ type: 'agent', kind: 'error', text: 'no agent running' }); return false; }
    let child;
    try { child = spawnChild(prof.cmd, prof.buildArgs(text, agent.sessionId), ['ignore', 'pipe', 'pipe']); }
    catch (e) { send({ type: 'agent', kind: 'error', text: 'spawn failed: ' + (e.message || e) }); send({ type: 'agent', kind: 'result', text: '' }); return false; }
    agent.child = child;
    agent.buf = '';
    let sawResult = false;
    if (prof.format === 'text') {
        child.stdout.on('data', (d) => {
            if (agent.child !== child) return;
            const chunk = typeof d === 'string' ? d : d.toString();
            if (Buffer.byteLength(agent.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
                agent.child = null;
                terminateChild(child);
                send({ type: 'agent', kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes` });
                send({ type: 'agent', kind: 'result', text: '' });
                return;
            }
            agent.buf += chunk;
        });
        child.stderr.on('data', (d) => {
            if (agent.child !== child) return;
            emitAgentStderr(d);
        });
        finalizeAfterStdioClose(child, {
            onSpawnError(e) {
                if (agent.child !== child) return;
                agent.child = null;
                send({ type: 'agent', kind: 'error', text: `failed to start ${agent.name}: ${e.message || e}` });
                send({ type: 'agent', kind: 'result', text: '' });
            },
            onClose(code) {
                if (agent.child !== child) return;
                agent.child = null;
                if (!agent.sessionId) rememberResume('_continue_');
                const out = agent.buf.trim();
                if (out) send({ type: 'agent', kind: 'assistant', text: out });
                send(code ? { type: 'agent', kind: 'error', text: `${agent.name} exited (${code})` } : { type: 'agent', kind: 'result', text: '' });
            },
        });
        return true;
    }
    child.stdout.on('data', (d) => {
        if (agent.child !== child) return;
        const chunk = typeof d === 'string' ? d : d.toString();
        if (Buffer.byteLength(agent.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
            agent.child = null;
            terminateChild(child);
            send({ type: 'agent', kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes without a complete event` });
            send({ type: 'agent', kind: 'result', text: '' });
            return;
        }
        agent.buf += chunk;
        let i;
        while ((i = agent.buf.indexOf('\n')) >= 0) {
            const line = agent.buf.slice(0, i); agent.buf = agent.buf.slice(i + 1);
            if (!line.trim()) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const sid = prof.sessionIdFrom && prof.sessionIdFrom(o); if (sid) rememberResume(sid);
            const n = prof.normalize(o); if (n) { if (n.kind === 'result') sawResult = true; send({ type: 'agent', ...n }); }
        }
    });
    child.stderr.on('data', (d) => {
        if (agent.child !== child) return;
        emitAgentStderr(d);
    });
    finalizeAfterStdioClose(child, {
        onSpawnError(e) {
            if (agent.child !== child) return;
            agent.child = null;
            send({ type: 'agent', kind: 'error', text: `failed to start ${agent.name}: ${e.message || e}` });
            send({ type: 'agent', kind: 'result', text: '' });
        },
        onClose(code) {
            if (agent.child !== child) return;
            agent.child = null;
            if (!sawResult) send(code ? { type: 'agent', kind: 'error', text: `${agent.name} exited (${code})` } : { type: 'agent', kind: 'result', text: '' });
        },
    });
    return true;
}

function inputAgent(text) {
    if (!agent.profile || !agent.mode) { send({ type: 'agent', kind: 'error', text: 'no agent running' }); return false; }
    if (agent.mode === 'oneshot') return oneshotTurn(text);
    if (!agent.child) { send({ type: 'agent', kind: 'error', text: 'no agent running' }); return false; }
    try { agent.child.stdin.write(agent.profile.encodeTurn(text)); return true; } catch { return false; }
}

function stopAgentChild() {
    const child = agent.child;
    agent.child = null;
    terminateChild(child);
}

function stopAgent() {
    if (agent.sessionId && agent.name) agent.sessionAgent = agent.name;
    stopAgentChild();
    agent.profile = null;
    agent.name = null;
    agent.mode = null;
    agent.buf = '';
}

function resetAgent() {
    stopAgent();
    agent.sessionId = null;
    agent.sessionAgent = null;
}

function sessionClaim() {
    return {
        term: { live: !!term.pty, cmd: term.label || undefined },
        agent: { live: !!agent.child || (agent.mode === 'oneshot' && !!agent.name) },
    };
}

async function handleCommand(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.surface === 'term') {
        if (msg.type === 'start') await startTerm(msg);
        else if (msg.type === 'input') inputTerm(String(msg.data || ''));
        else if (msg.type === 'resize') resizeTerm(msg.cols, msg.rows);
        else if (msg.type === 'stop') stopTerm();
        else if (msg.type === 'detach') parkTerm();
        return;
    }
    if (msg.surface === 'agent') {
        if (msg.type === 'start') startAgent(msg.agent || 'claude');
        else if (msg.type === 'input') inputAgent(String(msg.text || ''));
        else if (msg.type === 'stop') stopAgent();
    }
}

function helloPayload() {
    return {
        type: 'hello',
        token: TOKEN,
        name: NAME,
        capabilities: { surfaces: SURFACES, cmds: CMDS, agents: AGENTS },
        sessions: sessionClaim(),
    };
}

function connectOnce() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        activeWs = ws;
        let settled = false;
        let welcomed = false;
        const done = (err) => {
            if (settled) return;
            settled = true;
            if (activeWs === ws) activeWs = null;
            if (!stopping) {
                parkTerm();
                resetAgent();
            }
            if (err) reject(err); else resolve();
        };
        ws.on('open', () => {
            bindSender(ws);
            sendJson(ws, helloPayload());
        });
        ws.on('error', (e) => done(e));
        ws.on('close', (code, reason) => {
            const why = Buffer.isBuffer(reason) ? reason.toString() : String(reason || '');
            if (welcomed && /replaced by a new worker connection/.test(why)) {
                done(new Error(`ws closed (${code}) ${why}`));
                return;
            }
            if (welcomed) done();
            else done(new Error(`ws closed (${code}) ${why}`));
        });
        ws.on('message', (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
            if (msg.type === 'welcome') {
                welcomed = true;
                console.error(`[reverse-worker] welcome name=${msg.name || NAME}`);
                return;
            }
            if (msg.type === 'error') {
                console.error('[reverse-worker] error: ' + (msg.error || 'unknown'));
                try { ws.close(); } catch (_) {}
                return;
            }
            handleCommand(msg).catch((e) => {
                console.error('[reverse-worker] command failed: ' + (e.message || e));
            });
        });
    });
}

async function main() {
    let backoff = 1000;
    while (!stopping) {
        try {
            await connectOnce();
            backoff = 1000;
        } catch (e) {
            if (stopping) break;
            console.error(`[reverse-worker] disconnected: ${e.message || e}; retry in ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            backoff = Math.min(backoff * 2, 15000);
        }
    }
}

async function shutdown() {
    if (stopping) return;
    stopping = true;
    const child = agent.child;
    agent.child = null;
    agent.profile = null;
    agent.name = null;
    agent.mode = null;
    agent.buf = '';
    agent.sessionId = null;
    try { if (activeWs) activeWs.close(); } catch (_) {}
    stopTerm();
    await terminateChild(child);
    process.exit(0);
}

process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });

if (!SURFACES.length) {
    console.error('reverse-worker.mjs: --surfaces must include term and/or agent');
    process.exit(2);
}

main();
