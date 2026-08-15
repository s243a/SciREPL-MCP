/**
 * reverse-worker.mjs — broker-side registry and command relay for reverse-worker
 * mode. Controllers keep speaking /term and /agent; this module is the transport
 * that forwards those messages to a worker that dialed /worker.
 *
 * Disabled unless createReverseWorkerHub({ enabled: true }) is used. Token
 * loading and the /worker WebSocket server are the caller's responsibility to
 * skip when BROKER_REVERSE_WORKER is unset.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writePrivateFile } from './workspace.mjs';

export const WORKER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const KNOWN_TERM_CMDS = Object.freeze(['shell', 'claude', 'codex', 'gemini', 'agy']);
export const KNOWN_AGENTS = Object.freeze(['claude', 'codex', 'gemini', 'agy']);
export const TERM_EVENT_KINDS = Object.freeze(['started', 'data', 'exit', 'error']);
export const AGENT_EVENT_KINDS = Object.freeze(['started', 'assistant', 'tool_use', 'result', 'stderr', 'error', 'exit']);
export const CHILD_ENV_ALLOWLIST = Object.freeze([
    'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LANGUAGE', 'COLORTERM', 'TERM', 'PREFIX',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);
export const PROVIDER_API_KEYS = Object.freeze([
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
]);
export const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.MSC';

function envLookupKey(source, name) {
    if (!source || typeof source !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(source, name)) return name;
    const needle = name.toLowerCase();
    return Object.keys(source).find(key => key.toLowerCase() === needle);
}

function envLookup(source, name) {
    const key = envLookupKey(source, name);
    if (key === undefined) return undefined;
    const value = source[key];
    return value == null ? undefined : value;
}

function assignWindowsSearchVar(env, source, canonical, { mirror, fallback } = {}) {
    const value = envLookup(source, canonical);
    const resolved = value !== undefined ? value : fallback;
    if (resolved === undefined) return;
    env[canonical] = resolved;
    if (mirror) env[mirror] = resolved;
}

export function childProcessEnv({ inheritEnv = false, useApiKey = false, source = process.env, extra = {} } = {}) {
    const env = {};
    const allowed = new Set(CHILD_ENV_ALLOWLIST);
    for (const [key, value] of Object.entries(source)) {
        if (inheritEnv || allowed.has(key) || key.startsWith('LC_')) env[key] = value;
    }
    const pathValue = envLookup(source, 'PATH');
    if (pathValue !== undefined) {
        env.PATH = pathValue;
        const pathKey = envLookupKey(source, 'PATH');
        if (process.platform === 'win32' || (pathKey && pathKey !== 'PATH')) env.Path = pathValue;
    }
    assignWindowsSearchVar(env, source, 'PATHEXT', {
        fallback: process.platform === 'win32' ? DEFAULT_WINDOWS_PATHEXT : undefined,
    });
    if (process.platform === 'win32' || envLookup(source, 'SYSTEMROOT') !== undefined) {
        assignWindowsSearchVar(env, source, 'SYSTEMROOT', { mirror: 'SystemRoot' });
    }
    if (process.platform === 'win32' || envLookup(source, 'WINDIR') !== undefined) {
        assignWindowsSearchVar(env, source, 'WINDIR', { mirror: 'windir' });
    }
    if (process.platform === 'win32' || envLookup(source, 'COMSPEC') !== undefined) {
        assignWindowsSearchVar(env, source, 'COMSPEC', { mirror: 'ComSpec' });
    }
    if (useApiKey) {
        for (const key of PROVIDER_API_KEYS) {
            if (source[key]) env[key] = source[key];
        }
    }
    Object.assign(env, extra);
    return env;
}

export function terminateChild(child, graceMs = 1000) {
    if (!child) return;
    const pid = child.pid;
    try {
        if (process.platform === 'win32') {
            if (pid) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
            else child.kill();
        } else if (pid) {
            try { process.kill(-pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
        } else {
            child.kill('SIGTERM');
        }
    } catch (_) {}
    setTimeout(() => {
        try {
            if (process.platform === 'win32') {
                try { child.kill(); } catch (_) {}
            } else if (pid) {
                try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
            } else {
                try { child.kill('SIGKILL'); } catch (_) {}
            }
        } catch (_) {}
    }, graceMs);
}

const TERM_KIND_SET = new Set(TERM_EVENT_KINDS);
const AGENT_KIND_SET = new Set(AGENT_EVENT_KINDS);
const SURFACE_SET = new Set(['term', 'agent']);

export function secretMatches(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
    const actual = Buffer.from(candidate);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export function boundedInteger(raw, fallback, min, max, name) {
    const value = raw === undefined || raw === '' || raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}; received ${JSON.stringify(raw)}`);
    }
    return value;
}

export function auditSafeIdentity(value) {
    if (typeof value !== 'string') return '?';
    if (WORKER_NAME_RE.test(value)) return value;
    if (KNOWN_TERM_CMDS.includes(value) || KNOWN_AGENTS.includes(value)) return value;
    return '?';
}

export function defaultWorkerTokenFile() {
    return process.env.BROKER_WORKER_TOKEN_FILE || path.join(os.homedir(), 'scirepl-broker', 'worker-token');
}

export function workerWebSocketUrl(host, port, pathname = '/worker') {
    const dial = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : String(host || '');
    const hostname = dial.includes(':') ? `[${dial}]` : dial;
    return `ws://${hostname}:${port}${pathname}`;
}

export function loadWorkerToken({ controllerToken, env = process.env } = {}) {
    if (typeof controllerToken !== 'string' || !controllerToken) {
        throw new Error('reverse-worker mode requires a controller pairing token so the worker credential can be distinct from it');
    }
    const file = env.BROKER_WORKER_TOKEN_FILE || path.join(os.homedir(), 'scirepl-broker', 'worker-token');
    let value;
    let source;
    if (env.BROKER_WORKER_TOKEN) {
        value = env.BROKER_WORKER_TOKEN;
        source = 'BROKER_WORKER_TOKEN';
    } else {
        try {
            if (fs.existsSync(file)) {
                value = fs.readFileSync(file, 'utf8').trim();
                if (!value) throw new Error('worker token file is empty');
                try { fs.chmodSync(file, 0o600); } catch (_) {}
                source = file;
            } else {
                value = crypto.randomBytes(16).toString('hex');
                writePrivateFile(file, value + '\n', { exclusive: true });
                source = file;
            }
        } catch (e) {
            throw new Error(`cannot load or create worker token at ${file}: ${e.message}`);
        }
    }
    if (!value) throw new Error('worker token is empty');
    if (secretMatches(value, controllerToken)) {
        throw new Error('worker token must be distinct from the controller pairing token; a single secret cannot both drive the hub and be commanded by it');
    }
    return { value, source };
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

export function validateWorkerHello(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'hello') {
        return { ok: false, error: 'hello required' };
    }
    if (typeof msg.name !== 'string' || !WORKER_NAME_RE.test(msg.name)) {
        return { ok: false, error: 'invalid name' };
    }
    const capabilities = msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : null;
    if (!capabilities) return { ok: false, error: 'invalid capabilities' };
    const surfaces = uniqueStrings(Array.isArray(capabilities.surfaces) ? capabilities.surfaces : []);
    if (!surfaces.length || surfaces.some(s => !SURFACE_SET.has(s))) {
        return { ok: false, error: 'invalid capabilities' };
    }
    const cmds = uniqueStrings(Array.isArray(capabilities.cmds) ? capabilities.cmds : []);
    const agents = uniqueStrings(Array.isArray(capabilities.agents) ? capabilities.agents : []);
    if (cmds.some(c => !KNOWN_TERM_CMDS.includes(c)) || agents.some(a => !KNOWN_AGENTS.includes(a))) {
        return { ok: false, error: 'invalid capabilities' };
    }
    if (surfaces.includes('term') && !cmds.length) return { ok: false, error: 'invalid capabilities' };
    if (surfaces.includes('agent') && !agents.length) return { ok: false, error: 'invalid capabilities' };
    if (agents.includes('shell')) return { ok: false, error: 'invalid capabilities' };

    const sessions = { term: { live: false }, agent: { live: false } };
    if (msg.sessions && typeof msg.sessions === 'object') {
        for (const surface of ['term', 'agent']) {
            const claimed = msg.sessions[surface];
            if (claimed && typeof claimed === 'object' && claimed.live === true) {
                sessions[surface] = { live: true, cmd: typeof claimed.cmd === 'string' ? claimed.cmd : undefined };
            }
        }
    }
    return { ok: true, name: msg.name, capabilities: { surfaces, cmds, agents }, sessions };
}

export function controllerCommand(surface, msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (surface === 'term') {
        if (msg.type === 'start') return { type: 'start', surface, cmd: msg.cmd, cols: msg.cols, rows: msg.rows };
        if (msg.type === 'input') return { type: 'input', surface, data: String(msg.data || '') };
        if (msg.type === 'resize') return { type: 'resize', surface, cols: msg.cols, rows: msg.rows };
        if (msg.type === 'stop') return { type: 'stop', surface };
        if (msg.type === 'detach') return { type: 'detach', surface };
    }
    if (surface === 'agent') {
        if (msg.type === 'start') return { type: 'start', surface, agent: msg.agent };
        if (msg.type === 'input') return { type: 'input', surface, text: String(msg.text || '') };
        if (msg.type === 'stop') return { type: 'stop', surface };
    }
    return null;
}

export function isForwardableWorkerEvent(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'term') return TERM_KIND_SET.has(msg.kind);
    if (msg.type === 'agent') return AGENT_KIND_SET.has(msg.kind);
    return false;
}

function socketOpen(ws) {
    return !!(ws && ws.readyState === 1);
}

export function createReverseWorkerHub({
    enabled,
    strict = false,
    workerToken,
    protocolVersion,
    maxPayloadBytes,
    maxConnections,
    authTimeoutMs,
    sendJson,
    audit = () => {},
} = {}) {
    const workers = new Map();
    const sessions = { term: null, agent: null };
    const wss = enabled
        ? new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes, perMessageDeflate: false })
        : null;

    function listPublic() {
        return [...workers.values()].map(worker => ({
            name: worker.name,
            surfaces: [...worker.capabilities.surfaces],
            cmds: [...worker.capabilities.cmds],
            agents: [...worker.capabilities.agents],
        }));
    }

    function healthFields() {
        if (!enabled) return { reverseWorkerEnabled: false };
        return { reverseWorkerEnabled: true, reverseWorkerStrict: !!strict, workers: listPublic() };
    }

    function advertisedTermCmds() {
        const cmds = new Set();
        for (const worker of workers.values()) {
            if (worker.capabilities.surfaces.includes('term')) {
                for (const cmd of worker.capabilities.cmds) cmds.add(cmd);
            }
        }
        return [...cmds];
    }

    function advertisedAgents() {
        const agents = new Set();
        for (const worker of workers.values()) {
            if (worker.capabilities.surfaces.includes('agent')) {
                for (const agent of worker.capabilities.agents) agents.add(agent);
            }
        }
        return [...agents];
    }

    function findWorker(surface, requested) {
        const matches = [];
        for (const worker of workers.values()) {
            if (!socketOpen(worker.ws)) continue;
            if (!worker.capabilities.surfaces.includes(surface)) continue;
            const list = surface === 'term' ? worker.capabilities.cmds : worker.capabilities.agents;
            if (list.includes(requested)) matches.push(worker);
        }
        matches.sort((a, b) => a.connectedAt - b.connectedAt || a.name.localeCompare(b.name));
        return matches[0] || null;
    }

    function workerBySocket(ws) {
        for (const worker of workers.values()) {
            if (worker.ws === ws) return worker;
        }
        return null;
    }

    function forwardToWorker(worker, payload) {
        if (!worker || !socketOpen(worker.ws)) return false;
        return sendJson(worker.ws, payload, maxPayloadBytes);
    }

    function sendController(session, payload) {
        if (!session || !socketOpen(session.controllerWs)) return false;
        return sendJson(session.controllerWs, payload, maxPayloadBytes);
    }

    function notifyWorkerGone(session, surface) {
        const name = session.workerName || session.worker?.name || 'unknown';
        if (surface === 'term') {
            sendController(session, { type: 'term', kind: 'error', text: `worker '${name}' disconnected` });
            sendController(session, { type: 'term', kind: 'exit', code: null });
        } else {
            sendController(session, { type: 'agent', kind: 'error', text: `worker '${name}' disconnected` });
            sendController(session, { type: 'agent', kind: 'result', text: '' });
        }
    }

    function dropSession(surface, { notify = false } = {}) {
        const session = sessions[surface];
        if (!session) return;
        if (notify) notifyWorkerGone(session, surface);
        sessions[surface] = null;
    }

    function workerHandles(worker, surface, requested) {
        if (!worker || !socketOpen(worker.ws)) return false;
        if (!worker.capabilities.surfaces.includes(surface)) return false;
        const list = surface === 'term' ? worker.capabilities.cmds : worker.capabilities.agents;
        return list.includes(requested);
    }

    function register(ws, parsed) {
        const next = {
            ws,
            name: parsed.name,
            capabilities: parsed.capabilities,
            connectedAt: Date.now(),
        };
        const previous = workers.get(parsed.name);
        if (previous && previous.ws !== ws) {
            if (socketOpen(previous.ws)) {
                sendJson(ws, { type: 'error', error: 'worker name is already connected' }, maxPayloadBytes);
                try { ws.close(1008, 'worker name is already connected'); } catch (_) {}
                return null;
            }
            for (const surface of ['term', 'agent']) {
                const session = sessions[surface];
                if (!session || session.worker !== previous) continue;
                if (parsed.sessions[surface].live) {
                    session.worker = next;
                    session.workerName = next.name;
                } else {
                    dropSession(surface, { notify: true });
                }
            }
            try { previous.ws.close(1000, 'replaced by a new worker connection'); } catch (_) {}
            audit(`worker '${auditSafeIdentity(parsed.name)}' replaced`);
        } else {
            const name = auditSafeIdentity(parsed.name);
            const surfaces = parsed.capabilities.surfaces.map(auditSafeIdentity).join(',');
            const cmds = parsed.capabilities.cmds.map(auditSafeIdentity).join(',');
            const agents = parsed.capabilities.agents.map(auditSafeIdentity).join(',');
            audit(`worker '${name}' connected surfaces=${surfaces} cmds=${cmds} agents=${agents}`);
        }
        workers.set(parsed.name, next);
        return next;
    }

    function unregister(ws) {
        const worker = workerBySocket(ws);
        if (!worker) return;
        if (workers.get(worker.name) !== worker) return;
        workers.delete(worker.name);
        audit(`worker '${auditSafeIdentity(worker.name)}' disconnected`);
        for (const surface of ['term', 'agent']) {
            const session = sessions[surface];
            if (session && session.worker === worker) dropSession(surface, { notify: true });
        }
    }

    function onWorkerEvent(worker, msg) {
        if (!isForwardableWorkerEvent(msg)) return;
        const surface = msg.type;
        const session = sessions[surface];
        if (!session || session.worker !== worker) return;
        const { via: _ignored, ...rest } = msg;
        const outbound = rest.kind === 'started' ? { ...rest, via: worker.name } : rest;
        sendController(session, outbound);
        if (rest.kind === 'started') {
            const reattach = !!(rest.reattached || rest.reused);
            const requested = auditSafeIdentity(session.requested);
            const name = auditSafeIdentity(worker.name);
            if (surface === 'term') {
                audit(`term '${requested}' ${reattach ? 'reattached' : 'started'} via worker '${name}'`);
            } else {
                audit(`agent '${requested}' ${reattach ? 'reused' : 'ready'} via worker '${name}'`);
            }
        }
        if (surface === 'term' && rest.kind === 'exit') sessions.term = null;
    }

    function authDeadline(ws) {
        const timer = setTimeout(() => {
            try { ws.close(1008, 'authentication timeout'); } catch (_) { try { ws.terminate(); } catch (_) {} }
        }, authTimeoutMs);
        ws.once('close', () => clearTimeout(timer));
        return () => clearTimeout(timer);
    }

    if (wss) {
        wss.on('connection', (ws) => {
            let authed = false;
            const authenticated = authDeadline(ws);
            ws.on('error', (e) => audit(`WebSocket /worker closed after protocol error: ${e.code || e.message || 'unknown error'}`));
            ws.on('message', (buf) => {
                let msg;
                try { msg = JSON.parse(buf.toString()); } catch { return; }
                if (msg.type === 'hello') {
                    if (authed) {
                        sendJson(ws, { type: 'error', error: 'already authenticated' }, maxPayloadBytes);
                        return;
                    }
                    if (!secretMatches(msg.token, workerToken)) {
                        sendJson(ws, { type: 'error', error: 'unauthorized' }, maxPayloadBytes);
                        try { ws.close(1008, 'unauthorized'); } catch (_) {}
                        return;
                    }
                    const parsed = validateWorkerHello(msg);
                    if (!parsed.ok) {
                        sendJson(ws, { type: 'error', error: parsed.error }, maxPayloadBytes);
                        try { ws.close(1008, parsed.error); } catch (_) {}
                        return;
                    }
                    const worker = register(ws, parsed);
                    if (!worker) return;
                    authenticated();
                    authed = true;
                    sendJson(ws, { type: 'welcome', protocolVersion, name: parsed.name }, maxPayloadBytes);
                    return;
                }
                if (!authed) return;
                const worker = workerBySocket(ws);
                if (worker) onWorkerEvent(worker, msg);
            });
            ws.on('close', () => unregister(ws));
        });
    }

    function auditRequested(surface, requested, workerName) {
        const req = auditSafeIdentity(requested);
        const name = auditSafeIdentity(workerName);
        if (surface === 'term') audit(`term '${req}' start requested via worker '${name}'`);
        else audit(`agent '${req}' start requested via worker '${name}'`);
    }

    function auditStopRequested(surface, requested, workerName) {
        const req = auditSafeIdentity(requested);
        const name = auditSafeIdentity(workerName);
        if (surface === 'term') audit(`term '${req}' stop requested via worker '${name}'`);
        else audit(`agent '${req}' stop requested via worker '${name}'`);
    }

    function bindAndStart(surface, controllerWs, msg, worker, requested) {
        sessions[surface] = { worker, workerName: worker.name, controllerWs, requested };
        auditRequested(surface, requested, worker.name);
        const command = controllerCommand(surface, { ...msg, type: 'start' });
        if (command) forwardToWorker(worker, command);
        return true;
    }

    function tryStart(surface, controllerWs, msg) {
        if (!enabled) return false;
        const requested = surface === 'term'
            ? String(msg.cmd || 'shell').trim()
            : String(msg.agent || 'claude').trim();
        const existing = sessions[surface];
        if (existing) {
            if (existing.requested === requested && workerHandles(existing.worker, surface, requested)) {
                existing.controllerWs = controllerWs;
                auditRequested(surface, requested, existing.workerName || existing.worker.name);
                const command = controllerCommand(surface, { ...msg, type: 'start' });
                if (command) forwardToWorker(existing.worker, command);
                return true;
            }
            if (existing.worker && socketOpen(existing.worker.ws)) {
                forwardToWorker(existing.worker, { type: 'stop', surface });
            }
            auditStopRequested(surface, existing.requested, existing.workerName);
            sessions[surface] = null;
        }
        const worker = findWorker(surface, requested);
        if (!worker) {
            if (strict) {
                const payload = surface === 'term'
                    ? { type: 'term', kind: 'error', text: `no reverse worker advertised '${requested}'` }
                    : { type: 'agent', kind: 'error', text: `no reverse worker advertised '${requested}'` };
                sendJson(controllerWs, payload, maxPayloadBytes);
                return true;
            }
            return false;
        }
        return bindAndStart(surface, controllerWs, msg, worker, requested);
    }

    function tryRelay(surface, controllerWs, msg) {
        if (!enabled) return false;
        const session = sessions[surface];
        if (!session) return false;
        session.controllerWs = controllerWs;
        if (!session.worker || !socketOpen(session.worker.ws)) {
            dropSession(surface, { notify: true });
            return true;
        }
        const command = controllerCommand(surface, msg);
        if (command) forwardToWorker(session.worker, command);
        return true;
    }

    function tryStop(surface, controllerWs) {
        if (!enabled) return false;
        const session = sessions[surface];
        if (!session) return false;
        session.controllerWs = controllerWs;
        if (session.worker && socketOpen(session.worker.ws)) {
            forwardToWorker(session.worker, { type: 'stop', surface });
        }
        auditStopRequested(surface, session.requested, session.workerName);
        sessions[surface] = null;
        return true;
    }

    function detach(surface, controllerWs) {
        if (!enabled) return false;
        const session = sessions[surface];
        if (!session || session.controllerWs !== controllerWs) return false;
        if (surface === 'agent') {
            if (session.worker && socketOpen(session.worker.ws)) {
                forwardToWorker(session.worker, { type: 'stop', surface: 'agent' });
            }
            auditStopRequested(surface, session.requested, session.workerName);
            sessions.agent = null;
            return true;
        }
        if (session.worker && socketOpen(session.worker.ws)) {
            forwardToWorker(session.worker, { type: 'detach', surface: 'term' });
        }
        session.controllerWs = null;
        return true;
    }

    function canHandle(surface, requested) {
        if (!enabled) return false;
        return !!findWorker(surface, requested);
    }

    return {
        enabled: !!enabled,
        strict: !!strict,
        wss,
        maxConnections: maxConnections || 4,
        healthFields,
        listPublic,
        advertisedTermCmds,
        advertisedAgents,
        canHandle,
        tryStart,
        tryRelay,
        tryStop,
        detach,
        _workers: workers,
        _sessions: sessions,
    };
}
