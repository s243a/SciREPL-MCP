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

export function childProcessEnv({ inheritEnv = false, useApiKey = false, source = process.env, extra = {} } = {}) {
    const env = {};
    const allowed = new Set(CHILD_ENV_ALLOWLIST);
    for (const [key, value] of Object.entries(source)) {
        if (inheritEnv || allowed.has(key) || key.startsWith('LC_')) env[key] = value;
    }
    if (useApiKey) {
        for (const key of PROVIDER_API_KEYS) {
            if (source[key]) env[key] = source[key];
        }
    }
    Object.assign(env, extra);
    return env;
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

export function defaultWorkerTokenFile() {
    return process.env.BROKER_WORKER_TOKEN_FILE || path.join(os.homedir(), 'scirepl-broker', 'worker-token');
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

    function register(ws, parsed) {
        const next = {
            ws,
            name: parsed.name,
            capabilities: parsed.capabilities,
            connectedAt: Date.now(),
        };
        const previous = workers.get(parsed.name);
        if (previous && previous.ws !== ws) {
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
            audit(`worker '${parsed.name}' replaced`);
        } else {
            audit(`worker '${parsed.name}' connected surfaces=${parsed.capabilities.surfaces.join(',')} cmds=${parsed.capabilities.cmds.join(',')} agents=${parsed.capabilities.agents.join(',')}`);
        }
        workers.set(parsed.name, next);
        return next;
    }

    function unregister(ws) {
        const worker = workerBySocket(ws);
        if (!worker) return;
        if (workers.get(worker.name) !== worker) return;
        workers.delete(worker.name);
        audit(`worker '${worker.name}' disconnected`);
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
                    authenticated();
                    authed = true;
                    register(ws, parsed);
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

    function tryStart(surface, controllerWs, msg) {
        if (!enabled) return false;
        const requested = surface === 'term'
            ? String(msg.cmd || 'shell').trim()
            : String(msg.agent || 'claude').trim();
        const existing = sessions[surface];
        if (existing && existing.worker && socketOpen(existing.worker.ws)) {
            existing.controllerWs = controllerWs;
            const command = controllerCommand(surface, msg);
            if (command) forwardToWorker(existing.worker, command);
            return true;
        }
        if (existing && existing.worker && !socketOpen(existing.worker.ws)) {
            dropSession(surface, { notify: false });
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
        sessions[surface] = { worker, workerName: worker.name, controllerWs, requested };
        if (surface === 'term') audit(`term '${requested}' started via worker '${worker.name}'`);
        else audit(`agent '${requested}' ready via worker '${worker.name}'`);
        const command = controllerCommand(surface, { ...msg, type: 'start' });
        if (command) forwardToWorker(worker, command);
        return true;
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
        return tryRelay(surface, controllerWs, { type: 'stop' });
    }

    function detach(surface, controllerWs) {
        if (!enabled) return false;
        const session = sessions[surface];
        if (!session || session.controllerWs !== controllerWs) return false;
        if (surface === 'agent') {
            if (session.worker && socketOpen(session.worker.ws)) {
                forwardToWorker(session.worker, { type: 'stop', surface: 'agent' });
            }
            sessions.agent = null;
            return true;
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
