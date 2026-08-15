#!/usr/bin/env node
/**
 * broker.mjs — host-side bridge for SciREPL's MCP and remote-agent features.
 *
 * Bridges an external MCP client (e.g. Claude Code, `--transport http`) to the
 * SciREPL app, which connects OUT to this broker over a WebSocket and runs tools
 * via its shared ToolCore. The WebView can't listen, so the app is the WS client
 * and this broker is the listener (§3 "the one hard constraint").
 *
 *   MCP client ⇄ (Streamable HTTP /mcp) ⇄ broker ⇄ (WebSocket /app) ⇄ SciREPL app ⇄ ToolCore
 *
 * Auth: a shared pairing token (BROKER_TOKEN env, or auto-generated and stored
 * in a private file) is required on both links — Bearer on /mcp and in the
 * initial WebSocket hello.
 *
 * See ../../../docs/configuration.md for environment settings in the source tree.
 * Run: npm start
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { inspectWorkspace, setupWorkspace, writePrivateFile } from './workspace.mjs';
import { configureUtf8Pipes, truncateCodePoints } from './utf8-pipes.mjs';

const PACKAGE_METADATA = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const BROKER_VERSION = PACKAGE_METADATA.version;
if (typeof BROKER_VERSION !== 'string' || !BROKER_VERSION) throw new Error('package.json must contain a version');

function integerSetting(name, fallback, min, max) {
    const raw = process.env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}; received ${JSON.stringify(raw)}`);
    }
    return value;
}

const PORT = integerSetting('BROKER_PORT', 8087, 1, 65535);
// Bind loopback by default: the broker is reachable ONLY via `tailscale serve`
// (which proxies from the tailnet to localhost) or an ssh tunnel (`ssh -L`), not
// on the raw LAN. Set BROKER_HOST=0.0.0.0 to expose it directly (less secure).
const HOST = process.env.BROKER_HOST || '127.0.0.1';
const TOKEN_FILE = process.env.BROKER_TOKEN_FILE || path.join(os.homedir(), 'scirepl-broker', 'broker-token');
function loadOrCreateToken() {
    if (process.env.BROKER_TOKEN) return { value: process.env.BROKER_TOKEN, source: 'BROKER_TOKEN' };
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const value = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
            if (!value) throw new Error('token file is empty');
            try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
            return { value, source: TOKEN_FILE };
        }
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
        const value = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(TOKEN_FILE, value + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
        return { value, source: TOKEN_FILE };
    } catch (e) {
        throw new Error(`cannot load or create broker token at ${TOKEN_FILE}: ${e.message}`);
    }
}
const TOKEN_INFO = loadOrCreateToken();
const TOKEN = TOKEN_INFO.value;
const CALL_TIMEOUT_MS = integerSetting('BROKER_CALL_TIMEOUT_MS', 120000, 1000, 3600000);
const MAX_HTTP_BODY_BYTES = integerSetting('BROKER_MAX_HTTP_BODY_BYTES', 1048576, 1024, 67108864);
// App results can contain base64 plots, so /app deliberately has a larger cap
// than the control-oriented agent and terminal endpoints.
const MAX_APP_WS_PAYLOAD_BYTES = integerSetting('BROKER_MAX_APP_WS_PAYLOAD_BYTES', 16777216, 1024, 67108864);
const MAX_AGENT_WS_PAYLOAD_BYTES = integerSetting('BROKER_MAX_AGENT_WS_PAYLOAD_BYTES', 1048576, 1024, 16777216);
const MAX_TERM_WS_PAYLOAD_BYTES = integerSetting('BROKER_MAX_TERM_WS_PAYLOAD_BYTES', 1048576, 1024, 16777216);
const MAX_WS_CONNECTIONS = integerSetting('BROKER_MAX_WS_CONNECTIONS', 4, 1, 100);
const MAX_PENDING_CALLS = integerSetting('BROKER_MAX_PENDING_CALLS', 32, 1, 1024);
const MAX_AGENT_BUFFER_BYTES = integerSetting('BROKER_MAX_AGENT_BUFFER_BYTES', 1048576, 4096, 67108864);
const WS_AUTH_TIMEOUT_MS = integerSetting('BROKER_WS_AUTH_TIMEOUT_MS', 5000, 100, 60000);
const PROTOCOL_VERSION = 1;

function sendWsJson(ws, payload, maxBufferedBytes) {
    if (!ws || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > maxBufferedBytes) {
        try { ws.close(1013, 'outbound backpressure limit'); } catch (_) {}
        return false;
    }
    try { ws.send(JSON.stringify(payload)); return true; }
    catch { return false; }
}

// ── Remote-agent config (§14B structured chat) ──────────────────────────────
// A spawned agent runs on THIS machine. This is opt-in because the capabilities
// of each external CLI differ: Claude supports a tool allowlist, while other
// adapters may retain their ordinary host access. BROKER_AGENT=1 is therefore a
// deliberate acknowledgement of that host-side trust boundary.
const AGENT_ENABLED = process.env.BROKER_AGENT === '1';
const AGENT_ALLOWED_TOOLS = process.env.BROKER_AGENT_ALLOWED_TOOLS || 'mcp__scirepl__*';
const AGENT_FULL_ACCESS = process.env.BROKER_AGENT_FULL === '1'; // Claude-specific allowlist bypass
const AGENT_USE_API_KEY = process.env.BROKER_AGENT_USE_API_KEY === '1';
const AGENT_INHERIT_ENV = process.env.BROKER_AGENT_INHERIT_ENV === '1';
// Spawned agents/terminals use a dedicated session workspace (not the SciREPL
// source repo). Active CLAUDE.md/AGENTS.md files are created only by the explicit
// setup command. Ordinary broker startup is deliberately read-only toward it.
// NON-hidden path: Antigravity (agy) excludes any workspace whose path contains a
// hidden component (a dir starting with '.'), so '~/.scirepl-broker/...' was never
// recognized as an active workspace. Keep the workspace root non-hidden.
const DEFAULT_WORKSPACE = process.env.BROKER_WORKSPACE || path.join(os.homedir(), 'scirepl-broker', 'workspace');
const AGENT_CWD = process.env.BROKER_AGENT_CWD || DEFAULT_WORKSPACE;
const MANAGE_WORKSPACE = process.env.BROKER_MANAGE_WORKSPACE === '1';
const ALLOW_UNMANAGED_AGENT_WORKSPACE = process.env.BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE === '1';
const WORKSPACE_OPTIONS = { workspace: AGENT_CWD, port: PORT, token: TOKEN, callTimeoutMs: CALL_TIMEOUT_MS };

function workspaceInspection() {
    try { return inspectWorkspace(WORKSPACE_OPTIONS); }
    catch (error) {
        return { ready: false, files: {}, missing: [], outdated: [], unsafe: [], error: error.message || String(error) };
    }
}

function workspaceDirectoryProblem() {
    try {
        if (!fs.existsSync(AGENT_CWD) || !fs.statSync(AGENT_CWD).isDirectory()) {
            return 'agent workspace does not exist — run the explicit broker setup command first';
        }
    } catch (_) {
        return 'agent workspace cannot be accessed safely';
    }
    return null;
}

function agentWorkspaceProblem() {
    const directoryProblem = workspaceDirectoryProblem();
    if (directoryProblem) return directoryProblem;
    if (ALLOW_UNMANAGED_AGENT_WORKSPACE || workspaceInspection().ready) return null;
    return 'agent workspace is not prepared — run setup-broker.sh or setup-broker.ps1 with --enable-agent, or explicitly set BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE=1 for a self-managed workspace';
}

// ── Doctor: report remote-environment deficiencies (read-only). Fixes happen
//    only on an explicit POST, which backs up any file it changes. ─────────────
function hasCmd(c) { try { return spawnSync('sh', ['-c', `command -v ${c}`], { timeout: 4000 }).status === 0; } catch { return false; } }
function doctorReport() {
    const inspection = workspaceInspection();
    const agents = { claude: hasCmd('claude'), codex: hasCmd('codex'), gemini: hasCmd('gemini'), agy: hasCmd('agy') };
    const deficiencies = [];
    const directoryProblem = workspaceDirectoryProblem();
    if (AGENT_ENABLED && directoryProblem) deficiencies.push(directoryProblem);
    else if (AGENT_ENABLED && !inspection.ready && !ALLOW_UNMANAGED_AGENT_WORKSPACE) {
        for (const m of inspection.missing) deficiencies.push(`missing ${m}`);
        for (const m of inspection.outdated) deficiencies.push(`outdated ${m}`);
        for (const m of inspection.unsafe) deficiencies.push(`unsafe ${m}`);
        if (inspection.error) deficiencies.push(`workspace inspection failed: ${inspection.error}`);
    }
    if (AGENT_ENABLED && !Object.values(agents).some(Boolean)) deficiencies.push('remote agents enabled, but no supported agent CLI was found on PATH');
    const fixable = MANAGE_WORKSPACE ? [...inspection.missing, ...inspection.outdated] : [];
    return {
        ok: deficiencies.length === 0,
        workspace: AGENT_CWD,
        managed: MANAGE_WORKSPACE,
        allowUnmanaged: ALLOW_UNMANAGED_AGENT_WORKSPACE,
        workspaceReady: inspection.ready,
        files: inspection.files,
        agents,
        agentEnabled: AGENT_ENABLED,
        termEnabled: TERM_ENABLED,
        missing: inspection.missing,
        outdated: inspection.outdated,
        unsafe: inspection.unsafe,
        fixable,
        deficiencies,
    };
}

// Spawned processes receive a small environment allowlist by default. Set
// BROKER_AGENT_INHERIT_ENV=1 only when the process intentionally needs every
// host variable; this may expose credentials to the spawned CLI.
function spawnEnv() {
    const env = {};
    const allowed = new Set([
        'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
        'LANG', 'LANGUAGE', 'COLORTERM', 'TERM', 'PREFIX', 'ANDROID_ROOT',
        'ANDROID_DATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    ]);
    for (const [key, value] of Object.entries(process.env)) {
        if (AGENT_INHERIT_ENV || allowed.has(key) || key.startsWith('LC_')) env[key] = value;
    }
    if (AGENT_USE_API_KEY) {
        for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
            if (process.env[key]) env[key] = process.env[key];
        }
    }
    Object.assign(env, { SCIREPL_SESSION: '1', SCIREPL_BROKER_PORT: String(PORT), SCIREPL_MCP: 'scirepl', SCIREPL_MCP_BEARER: TOKEN });
    return env;
}
// ── Terminal config (§14C). /term exposes a REAL PTY (full shell) on this
//    machine, so it is OFF unless explicitly enabled. ──────────────────────────
const TERM_ENABLED = process.env.BROKER_TERM === '1';
// BROKER_TERM_NO_SHELL=1: lock out shell access via the terminal — no standalone
// 'shell' command, and agents do NOT drop to a shell when they exit (the session
// just ends). Use when you want terminal AGENTS but not a raw PC shell.
const TERM_NO_SHELL = process.env.BROKER_TERM_NO_SHELL === '1';
const TERM_CMDS = (process.env.BROKER_TERM_CMDS || 'shell,claude,codex,gemini,agy')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(c => !(TERM_NO_SHELL && c === 'shell'));
const TERM_SHELL = process.env.BROKER_TERM_SHELL || process.env.SHELL || 'bash';
const TERM_GRACE_MS = integerSetting('BROKER_TERM_GRACE_MS', 600000, 0, 86400000); // keep PTY alive this long after a WS drop

// ── App bridge: the single connected SciREPL app (WS) and its advertised tools ──
const appBridge = {
    ws: null,
    tools: [],                 // tool defs the app advertised (ToolCore.defs())
    pending: new Map(),        // call id → { resolve, reject, timer }
    connected() { return this.ws && this.ws.readyState === 1; },
    rejectPending(reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason || 'SciREPL app disconnected'));
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this.pending.clear();
    },
    call(name, args) {
        if (!this.connected()) return Promise.reject(new Error('SciREPL app not connected to broker'));
        if (this.pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error(`too many pending tool calls (limit ${MAX_PENDING_CALLS})`));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`tool '${name}' timed out after ${CALL_TIMEOUT_MS}ms`));
            }, CALL_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            if (!sendWsJson(this.ws, { type: 'call', id, name, args }, MAX_APP_WS_PAYLOAD_BYTES)) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('SciREPL app connection could not accept the tool call'));
            }
        });
    },
    resolveCall(id, output, error) {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (error) p.reject(new Error(error)); else p.resolve(output);
    },
};

// ── Self-pointing MCP config: the spawned agent drives the notebook through THIS
//    broker's /mcp, so the app's confirm/Review/write-scope gates still apply. ──
let _mcpConfigPath = null;
function mcpConfigPath() {
    if (_mcpConfigPath) return _mcpConfigPath;
    const cfg = { mcpServers: { scirepl: {
        type: 'http', url: `http://127.0.0.1:${PORT}/mcp`,
        headers: { Authorization: `Bearer ${TOKEN}` },
    } } };
    const p = path.join(os.tmpdir(), `scirepl-mcp-${PORT}.json`);
    writePrivateFile(p, JSON.stringify(cfg));
    _mcpConfigPath = p;
    return p;
}
function codexMcpConfigArgs() {
    return [
        '-c', `mcp_servers.scirepl.url="http://127.0.0.1:${PORT}/mcp"`,
        '-c', 'mcp_servers.scirepl.bearer_token_env_var="SCIREPL_MCP_BEARER"',
        '-c', 'mcp_servers.scirepl.required=true',
        '-c', 'mcp_servers.scirepl.default_tools_approval_mode="approve"',
        '-c', `mcp_servers.scirepl.tool_timeout_sec=${Math.ceil(CALL_TIMEOUT_MS / 1000)}`,
    ];
}

// ── Agent adapters: each maps a normalized session onto a CLI's stream protocol.
//    claude is verified; codex/gemini are experimental profile slots. ──────────
const AGENT_PROFILES = {
    claude: {
        cmd: 'claude',
        // -p stream-json stays alive for multi-turn (verified, claude 2.1.185).
        // opts.resume = a prior session_id → restore context across a respawn.
        args(opts = {}) {
            const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
            a.push('--mcp-config', mcpConfigPath(), '--strict-mcp-config');
            if (!AGENT_FULL_ACCESS) a.push('--allowedTools', AGENT_ALLOWED_TOOLS);
            if (opts.resume) a.push('--resume', opts.resume);
            return a;
        },
        encodeTurn(text) {
            return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
        },
        // Normalize a stdout JSON line → { kind, text?, tool?, raw } or null to skip.
        normalize(o) {
            if (o.type === 'system') return { kind: 'system', text: o.subtype || 'system', raw: o };
            if (o.type === 'rate_limit_event') return { kind: 'rate_limit', raw: o.rate_limit_info || o };
            if (o.type === 'assistant' && o.message) {
                const blocks = o.message.content || [];
                const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
                const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name);
                if (tools.length) return { kind: 'tool_use', tool: tools.join(', '), text, raw: o };
                if (text) return { kind: 'assistant', text, raw: o };
                return null;
            }
            if (o.type === 'result') return { kind: 'result', text: o.result || '', error: o.is_error || false, cost: o.total_cost_usd, raw: o };
            return null;
        },
    },
    // codex (OpenAI) — one-shot per turn (codex exec --json), resume by thread_id.
    codex: {
        experimental: true, mode: 'oneshot', cmd: 'codex',
        // --skip-git-repo-check: the session workspace isn't a git repo, which codex
        // otherwise refuses to run in. MCP is supplied per invocation via -c so
        // the broker token stays in SCIREPL_MCP_BEARER instead of global config.
        buildArgs(text, sessionId) {
            const cfg = codexMcpConfigArgs();
            return sessionId
                ? ['exec', 'resume', '--skip-git-repo-check', '--json', ...cfg, sessionId, text]
                : ['exec', '--skip-git-repo-check', '--json', ...cfg, text];
        },
        sessionIdFrom(o) { return (o.type === 'thread.started' && o.thread_id) ? o.thread_id : null; },
        normalize(o) {
            if (o.type === 'thread.started') return { kind: 'system', text: 'thread ' + String(o.thread_id || '').slice(0, 8) };
            if (o.type === 'item.completed' && o.item) {
                const it = o.item;
                if (it.type === 'agent_message') return { kind: 'assistant', text: it.text || '' };
                if (it.type === 'reasoning') return null;
                if (/command|tool|exec|patch|file/i.test(it.type || '')) return { kind: 'tool_use', tool: it.type, text: it.text || it.command || '' };
                return null;
            }
            if (o.type === 'turn.completed') return { kind: 'result', text: '', usage: o.usage };
            if (o.type === 'error' || o.error) return { kind: 'error', text: o.message || JSON.stringify(o).slice(0, 200) };
            return null;
        },
    },
    // gemini (Google) — one-shot per turn (gemini -p -o stream-json), resume latest.
    gemini: {
        experimental: true, mode: 'oneshot', cmd: 'gemini',
        buildArgs(text, sessionId) { const a = ['-p', text, '-o', 'stream-json']; if (sessionId) a.push('-r', 'latest'); return a; },
        sessionIdFrom(o) { return (o.type === 'init' && o.session_id) ? o.session_id : null; },
        normalize(o) {
            if (o.type === 'init') return { kind: 'system', text: o.model || 'init' };
            if (o.type === 'message') return o.role === 'assistant' ? { kind: 'assistant', text: o.content || '' } : null;
            if (o.type === 'tool_call' || o.type === 'tool') return { kind: 'tool_use', tool: o.name || 'tool', text: '' };
            if (o.type === 'result') return { kind: 'result', text: '', usage: o.stats };
            if (o.type === 'error') return { kind: 'error', text: o.message || JSON.stringify(o).slice(0, 200) };
            return null;
        },
    },
    // agy (antigravity) — one-shot, PLAIN TEXT output (no JSON mode); multi-turn via
    // -c/--continue. The bridge's text path captures raw stdout as the answer.
    agy: {
        experimental: true, mode: 'oneshot', format: 'text', cmd: 'agy',
        // --add-dir registers the session workspace so agy loads GEMINI.md/context in
        // -p mode (cwd alone isn't enough in print mode). -c continues the session.
        buildArgs(text, sessionId) {
            const a = ['--add-dir', AGENT_CWD];
            if (sessionId) a.push('-c');
            a.push('-p', text);
            return a;
        },
    },
};

// ── Agent bridge: one spawned remote-agent session bound to one app WS. ────────
//    start() is IDEMPOTENT — a live session for the same agent is reused, so a
//    redundant start from the app never wipes context. A genuine respawn (crash,
//    or agent switch back) resumes via the captured session_id. ────────────────
const agentBridge = {
    ws: null, child: null, profile: null, name: null, buf: '', sessionId: null,
    running() { return !!this.child; },
    start(ws, name) {
        if (!AGENT_ENABLED) { sendWsJson(ws, { type: 'agent', kind: 'error', text: 'remote agents disabled — restart with BROKER_AGENT=1 after reviewing the host-access warning' }, MAX_AGENT_BUFFER_BYTES); return; }
        const workspaceProblem = agentWorkspaceProblem();
        if (workspaceProblem) { sendWsJson(ws, { type: 'agent', kind: 'error', text: workspaceProblem }, MAX_AGENT_BUFFER_BYTES); return; }
        const prof = AGENT_PROFILES[name];
        if (!prof) { sendWsJson(ws, { type: 'agent', kind: 'error', text: `unknown agent: ${name}` }, MAX_AGENT_BUFFER_BYTES); return; }
        // One-shot agents (codex/gemini): no long-lived process — each turn spawns a
        // fresh CLI and resumes by session id. Just (re)bind and signal ready.
        if (prof.mode === 'oneshot') {
            if (this.name && this.name !== name) this.sessionId = null;
            this.stop();
            this.ws = ws; this.profile = prof; this.name = name; this.mode = 'oneshot';
            sendWsJson(ws, { type: 'agent', kind: 'started', text: name, experimental: !!prof.experimental }, MAX_AGENT_BUFFER_BYTES);
            console.log(`[broker] agent '${name}' ready (one-shot per turn)`);
            return;
        }
        this.mode = 'persistent';
        // Reuse a healthy session for the same agent (the key context-preserving fix).
        if (this.child && this.name === name) {
            this.ws = ws; // re-bind to the (possibly reconnected) app WS
            sendWsJson(ws, { type: 'agent', kind: 'started', text: name, experimental: !!prof.experimental, reused: true }, MAX_AGENT_BUFFER_BYTES);
            console.log(`[broker] agent '${name}' start reused (pid ${this.child.pid})`);
            return;
        }
        // Switching to a different agent → drop any old session context.
        if (this.name && this.name !== name) this.sessionId = null;
        this.stop();
        const env = spawnEnv();
        const resume = this.sessionId || null; // respawn of the same agent → resume context
        let child;
        try {
            child = spawn(prof.cmd, prof.args({ resume }), { env, cwd: AGENT_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            sendWsJson(ws, { type: 'agent', kind: 'error', text: `spawn failed: ${e.message}` }, MAX_AGENT_BUFFER_BYTES); return;
        }
        configureUtf8Pipes(child);
        this.ws = ws; this.child = child; this.profile = prof; this.name = name; this.buf = '';
        const send = (m) => this.ws === ws && sendWsJson(ws, { type: 'agent', ...m }, MAX_AGENT_BUFFER_BYTES);
        // spawn() reports command-not-found and similar launch failures through
        // an asynchronous 'error' event, not the surrounding try/catch.
        child.once('error', (e) => {
            if (this.child !== child) return;
            this.child = null;
            send({ kind: 'error', text: `failed to start ${name}: ${e.message || e}` });
            send({ kind: 'exit', code: null });
        });
        child.stdout.on('data', (d) => {
            if (this.child !== child) return;
            const chunk = d;
            if (Buffer.byteLength(this.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
                this.child = null;
                try { child.kill('SIGTERM'); } catch (_) {}
                send({ kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes without a complete event` });
                send({ kind: 'exit', code: null });
                return;
            }
            this.buf += chunk;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                if (o.session_id) this.sessionId = o.session_id; // capture for --resume
                const n = prof.normalize(o);
                if (n) send(n);
            }
        });
        child.stderr.on('data', (d) => send({ kind: 'stderr', text: truncateCodePoints(d, 500) }));
        child.on('exit', (code) => { if (this.child === child) { this.child = null; send({ kind: 'exit', code }); } });
        send({ kind: 'started', text: name, experimental: !!prof.experimental, resumed: !!resume });
        console.log(`[broker] agent '${name}' launch requested${child.pid ? ' (pid ' + child.pid + ')' : ''}${resume ? ' [resumed ' + resume.slice(0, 8) + ']' : ''}`);
    },
    input(text) {
        if (this.mode === 'oneshot') return this._oneshotTurn(text);
        if (!this.child) return false;
        try { this.child.stdin.write(this.profile.encodeTurn(text)); return true; } catch { return false; }
    },
    // One turn = spawn the CLI with the prompt as an arg (resuming the captured
    // session for context), stream its JSON events, exit. Exit is NORMAL here — we
    // never send 'exit' (which the app treats as the agent dying); only 'result'.
    _oneshotTurn(text) {
        if (this.child) return false; // a turn is already in flight
        const prof = this.profile, ws = this.ws;
        const send = (m) => this.ws === ws && sendWsJson(ws, { type: 'agent', ...m }, MAX_AGENT_BUFFER_BYTES);
        let child;
        try { child = spawn(prof.cmd, prof.buildArgs(text, this.sessionId), { env: spawnEnv(), cwd: AGENT_CWD, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { send({ kind: 'error', text: 'spawn failed: ' + (e.message || e) }); send({ kind: 'result', text: '' }); return false; }
        configureUtf8Pipes(child);
        this.child = child; this.buf = ''; let sawResult = false;
        child.once('error', (e) => {
            if (this.child !== child) return;
            this.child = null;
            send({ kind: 'error', text: `failed to start ${this.name}: ${e.message || e}` });
            send({ kind: 'result', text: '' });
        });
        if (prof.format === 'text') {
            // Plain-text agents (agy): no JSON to parse — accumulate stdout as the
            // answer, emit it on exit, and remember to --continue next turn.
            child.stdout.on('data', (d) => {
                if (this.child !== child) return;
                const chunk = d;
                if (Buffer.byteLength(this.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
                    this.child = null;
                    try { child.kill('SIGTERM'); } catch (_) {}
                    send({ kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes` });
                    send({ kind: 'result', text: '' });
                    return;
                }
                this.buf += chunk;
            });
            child.stderr.on('data', (d) => send({ kind: 'stderr', text: truncateCodePoints(d, 500) }));
            child.on('exit', (code) => {
                if (this.child !== child) return;
                this.child = null;
                if (!this.sessionId) this.sessionId = '_continue_'; // enable -c/--continue next turn
                const out = this.buf.trim();
                if (out) send({ kind: 'assistant', text: out });
                send(code ? { kind: 'error', text: `${this.name} exited (${code})` } : { kind: 'result', text: '' });
            });
            return true;
        }
        child.stdout.on('data', (d) => {
            if (this.child !== child) return;
            const chunk = d;
            if (Buffer.byteLength(this.buf) + Buffer.byteLength(chunk) > MAX_AGENT_BUFFER_BYTES) {
                this.child = null;
                try { child.kill('SIGTERM'); } catch (_) {}
                send({ kind: 'error', text: `agent output exceeded ${MAX_AGENT_BUFFER_BYTES} bytes without a complete event` });
                send({ kind: 'result', text: '' });
                return;
            }
            this.buf += chunk;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
                if (!line.trim()) continue;
                let o; try { o = JSON.parse(line); } catch { continue; }
                const sid = prof.sessionIdFrom && prof.sessionIdFrom(o); if (sid) this.sessionId = sid;
                const n = prof.normalize(o); if (n) { if (n.kind === 'result') sawResult = true; send(n); }
            }
        });
        child.stderr.on('data', (d) => send({ kind: 'stderr', text: truncateCodePoints(d, 500) }));
        child.on('exit', (code) => { if (this.child === child) { this.child = null; if (!sawResult) send(code ? { kind: 'error', text: `${this.name} exited (${code})` } : { kind: 'result', text: '' }); } });
        return true;
    },
    stop() {
        if (this.child) { try { this.child.kill('SIGTERM'); } catch (_) {} this.child = null; console.log('[broker] agent stopped'); }
    },
    reset() { this.stop(); this.sessionId = null; this.name = null; },
};

// ── Terminal bridge (§14C): a real PTY relayed to xterm.js in the app. ─────────
//    Maps a requested name to a command; 'shell' = the login shell, 'claude' =
//    the interactive Claude TUI (true TTY — permission keypresses etc.). ───────
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // POSIX single-quote
function resolveTermCmd(name) {
    const want = (name || 'shell').trim();
    if (!TERM_CMDS.includes(want)) return null;
    if (want === 'shell') return { cmd: TERM_SHELL, args: ['-l'], label: TERM_SHELL };
    // Agents run INSIDE a shell so quitting the agent drops you to a shell prompt
    // (and the PTY = shell persists, so there's no exit/restart churn). Non-login
    // `-c` preserves the broker's inherited PATH (node 22) for codex/gemini; the
    // trailing interactive shell then loads the user's rc.
    let agentCmd;
    if (want === 'claude') {
        // notebook-aware: same self-pointing MCP config as the /agent claude.
        const a = ['claude', '--mcp-config', mcpConfigPath(), '--strict-mcp-config'];
        if (!AGENT_FULL_ACCESS) a.push('--allowedTools', AGENT_ALLOWED_TOOLS);
        agentCmd = a.map(shq).join(' ');
    } else if (want === 'agy') {
        // agy doesn't treat cwd as the active workspace — register it explicitly so
        // it loads GEMINI.md / the SciREPL context (even interactively).
        agentCmd = `agy --add-dir ${shq(AGENT_CWD)}`;
    } else if (want === 'codex') {
        // notebook-aware: same self-pointing MCP config as the /agent codex path.
        agentCmd = ['codex', ...codexMcpConfigArgs()].map(shq).join(' ');
    } else {
        agentCmd = shq(want); // gemini auto-loads .gemini/settings.json from cwd
    }
    // With BROKER_TERM_NO_SHELL, the agent does NOT fall back to a shell on exit —
    // the session just ends (no shell escape). Otherwise quitting drops to a shell.
    const inner = TERM_NO_SHELL
        ? `${agentCmd}; ec=$?; echo; echo "[${want} exited ($ec)]"`
        : `${agentCmd}; ec=$?; echo; echo "[${want} exited ($ec) — you're in a shell now; exit/Ctrl-D to close]"; exec ${shq(TERM_SHELL)} -i`;
    return { cmd: TERM_SHELL, args: ['-c', inner], label: want };
}
const termBridge = {
    ws: null, pty: null, label: null, cols: 80, rows: 24, grace: null,
    running() { return !!this.pty; },
    _bind(ws) {
        this.ws = ws;
        const send = (m) => this.ws === ws && sendWsJson(ws, { type: 'term', ...m }, MAX_TERM_WS_PAYLOAD_BYTES);
        const p = this.pty;
        if (p._sciData && p._sciData.dispose) p._sciData.dispose(); // drop the listener bound to the old ws
        p._sciData = p.onData((d) => send({ kind: 'data', data: d }));
        return send;
    },
    async start(ws, opts = {}) {
        const send0 = (m) => sendWsJson(ws, { type: 'term', ...m }, MAX_TERM_WS_PAYLOAD_BYTES);
        if (!TERM_ENABLED) { send0({ kind: 'error', text: 'terminal disabled — start broker with BROKER_TERM=1' }); return; }
        // Re-attach to a live session (e.g. after a dropped WS) instead of respawning.
        if (this.pty) {
            if (this.grace) { clearTimeout(this.grace); this.grace = null; }
            const send = this._bind(ws);
            this.resize(opts.cols, opts.rows);
            send({ kind: 'started', cmd: this.label, reattached: true });
            try { this.pty.write('\f'); } catch (_) {} // nudge a redraw
            try { setTimeout(() => this.resize((opts.cols || this.cols), (opts.rows || this.rows)), 120); } catch (_) {}
            console.log(`[broker] term '${this.label}' reattached (pid ${this.pty.pid})`);
            return;
        }
        const spec = resolveTermCmd(opts.cmd);
        if (!spec) { send0({ kind: 'error', text: `command not allowed: ${opts.cmd} (allowed: ${TERM_CMDS.join(', ')})` }); return; }
        if ((opts.cmd || 'shell').trim() !== 'shell') {
            const workspaceProblem = agentWorkspaceProblem();
            if (workspaceProblem) { send0({ kind: 'error', text: workspaceProblem }); return; }
        }
        let ptyLib;
        try { ptyLib = (await import('node-pty')).default || (await import('node-pty')); }
        catch (e) { send0({ kind: 'error', text: 'node-pty not installed on the broker host' }); return; }
        if (!fs.existsSync(AGENT_CWD) || !fs.statSync(AGENT_CWD).isDirectory()) {
            send0({ kind: 'error', text: 'terminal workspace does not exist — run the explicit broker setup command first' });
            return;
        }
        const env = { ...spawnEnv(), TERM: 'xterm-256color' };
        this.cols = opts.cols || 80; this.rows = opts.rows || 24;
        let p;
        try {
            p = ptyLib.spawn(spec.cmd, spec.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: AGENT_CWD, env });
        } catch (e) { send0({ kind: 'error', text: 'spawn failed: ' + (e.message || e) }); return; }
        this.pty = p; this.label = spec.label;
        const send = this._bind(ws);
        p.onExit(({ exitCode }) => { if (this.pty === p) { this.pty = null; if (this.grace) { clearTimeout(this.grace); this.grace = null; } send({ kind: 'exit', code: exitCode }); } });
        send({ kind: 'started', cmd: spec.label });
        console.log(`[broker] term '${spec.label}' started (pid ${p.pid})`);
    },
    input(d) { if (this.pty) { try { this.pty.write(d); } catch (_) {} } },
    resize(cols, rows) { if (cols && rows) { this.cols = cols; this.rows = rows; if (this.pty) { try { this.pty.resize(cols, rows); } catch (_) {} } } },
    // WS dropped but no explicit stop: keep the PTY alive briefly so a reconnect
    // restores the same session; reap it if nobody comes back.
    detach(ws) {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.pty && !this.grace) {
            this.grace = setTimeout(() => { this.grace = null; this.stop(); }, TERM_GRACE_MS);
            console.log(`[broker] term detached — keeping pid ${this.pty.pid} alive ${Math.round(TERM_GRACE_MS / 1000)}s`);
        }
    },
    stop() { if (this.grace) { clearTimeout(this.grace); this.grace = null; } if (this.pty) { try { this.pty.kill(); } catch (_) {} this.pty = null; this.label = null; console.log('[broker] term stopped'); } },
};

// ── MCP server (one transient instance per request — stateless Streamable HTTP) ──
function makeMcpServer() {
    const server = new Server({ name: 'scirepl', version: BROKER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        // Surface the app's tools; map our {function:{...}} defs to MCP shape.
        const tools = (appBridge.tools || []).map(d => {
            const f = d.function || d;
            return { name: f.name, description: f.description || '', inputSchema: f.parameters || { type: 'object', properties: {} } };
        });
        return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        const advertised = (appBridge.tools || []).some(definition => {
            const tool = definition.function || definition;
            return tool && tool.name === name;
        });
        if (!advertised) {
            return { content: [{ type: 'text', text: `Error: tool '${name}' is not advertised by the connected SciREPL app` }], isError: true };
        }
        try {
            const output = await appBridge.call(name, args || {});
            const s = String(output ?? '');
            // A data:image result (e.g. read_cell .output.png) → MCP image content so
            // vision-capable agents can SEE the plot, not a base64 blob of text.
            const img = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(s.trim());
            if (img) return { content: [{ type: 'image', data: img[2], mimeType: img[1] }] };
            return { content: [{ type: 'text', text: s }] };
        } catch (e) {
            return { content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true };
        }
    });
    return server;
}

function tokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const actual = Buffer.from(candidate);
    const expected = Buffer.from(TOKEN);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function bearer(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let tooLarge = false;
        req.on('data', c => {
            if (tooLarge) return;
            const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
            bytes += chunk.length;
            if (bytes > MAX_HTTP_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            if (tooLarge) { const e = new Error(`request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`); e.code = 'BODY_TOO_LARGE'; reject(e); return; }
            const data = Buffer.concat(chunks).toString('utf8');
            if (!data) { resolve(undefined); return; }
            try { resolve(JSON.parse(data)); }
            catch { const e = new Error('invalid JSON request body'); e.code = 'INVALID_JSON'; reject(e); }
        });
    });
}

const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/health') {
        const workspaceReady = workspaceInspection().ready;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            brokerVersion: BROKER_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            appConnected: !!appBridge.connected(),
            tools: appBridge.tools.length,
            agentEnabled: AGENT_ENABLED,
            termEnabled: TERM_ENABLED,
            workspaceReady,
        }));
        return;
    }

    // Doctor: GET reports deficiencies (read-only — never modifies). POST applies
    // fixes (create missing + update outdated managed files), backing up each
    // changed file first, then reports. POST is the user's explicit consent (the
    // app asks before calling it). Token-gated.
    if (url.pathname === '/doctor') {
        if (!tokenMatches(bearer(req))) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
        let applied = null;
        if (req.method === 'POST') {
            if (!MANAGE_WORKSPACE) {
                res.writeHead(409, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'workspace repair is disabled; use the explicit setup command or start its generated launcher' }));
                return;
            }
            try { applied = setupWorkspace(WORKSPACE_OPTIONS, { repair: true }); }
            catch (error) {
                res.writeHead(409, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: error.message || String(error), ...doctorReport() }));
                return;
            }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ applied, ...doctorReport() }));
        return;
    }

    if (url.pathname === '/mcp') {
        if (!tokenMatches(bearer(req))) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
            return;
        }
        const server = makeMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        let body;
        try { body = await readBody(req); }
        catch (e) {
            const status = e.code === 'BODY_TOO_LARGE' ? 413 : 400;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: e.message }, id: null }));
            return;
        }
        await transport.handleRequest(req, res, body);
        return;
    }

    res.writeHead(404); res.end('not found');
});
httpServer.headersTimeout = 10_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxHeadersCount = 64;
httpServer.maxRequestsPerSocket = 100;

// ── WS endpoints. Both use noServer + a single upgrade router, because two
//    auto-attached WebSocketServers on one http server fight over 'upgrade'
//    (the non-matching one aborts the socket with 400). ──
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_APP_WS_PAYLOAD_BYTES, perMessageDeflate: false });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: MAX_AGENT_WS_PAYLOAD_BYTES, perMessageDeflate: false });
const termWss = new WebSocketServer({ noServer: true, maxPayload: MAX_TERM_WS_PAYLOAD_BYTES, perMessageDeflate: false });
httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const route = pathname === '/app' ? wss : pathname === '/agent' ? agentWss : pathname === '/term' ? termWss : null;
    if (!route || route.clients.size >= MAX_WS_CONNECTIONS) { socket.destroy(); return; }
    route.handleUpgrade(req, socket, head, (ws) => {
        // ws surfaces protocol/payload failures as 'error' events. Always consume
        // them so an oversized or malformed unauthenticated frame cannot crash
        // the broker through EventEmitter's default behaviour.
        ws.on('error', (e) => console.warn(`[broker] WebSocket ${pathname} closed after protocol error: ${e.code || e.message || 'unknown error'}`));
        route.emit('connection', ws, req);
    });
});

function authDeadline(ws) {
    const timer = setTimeout(() => {
        try { ws.close(1008, 'authentication timeout'); } catch (_) { try { ws.terminate(); } catch (_) {} }
    }, WS_AUTH_TIMEOUT_MS);
    ws.once('close', () => clearTimeout(timer));
    return () => clearTimeout(timer);
}

// /app: the SciREPL app connects out and provides tools.
wss.on('connection', (ws) => {
    let authed = false;
    const authenticated = authDeadline(ws);
    ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'hello') {
            if (!tokenMatches(msg.token)) { sendWsJson(ws, { type: 'error', error: 'unauthorized' }, MAX_APP_WS_PAYLOAD_BYTES); ws.close(1008, 'unauthorized'); return; }
            authenticated();
            authed = true;
            if (appBridge.ws && appBridge.ws !== ws) {
                appBridge.rejectPending('SciREPL app connection was replaced');
                try { appBridge.ws.close(1000, 'replaced by a new app connection'); } catch (_) {}
            }
            appBridge.ws = ws;
            appBridge.tools = Array.isArray(msg.tools) ? msg.tools : [];
            sendWsJson(ws, { type: 'welcome', protocolVersion: PROTOCOL_VERSION, tools: appBridge.tools.length }, MAX_APP_WS_PAYLOAD_BYTES);
            console.log(`[broker] app connected — ${appBridge.tools.length} tools`);
            return;
        }
        if (!authed) return;
        if (msg.type === 'result') appBridge.resolveCall(msg.id, msg.output, msg.error);
    });
    ws.on('close', () => {
        if (appBridge.ws === ws) {
            appBridge.ws = null;
            appBridge.tools = [];
            appBridge.rejectPending('SciREPL app disconnected');
            console.log('[broker] app disconnected');
        }
    });
});

// /agent: the app connects out to chat with a spawned remote agent.
//   {start,agent} spawns; {input,text} sends a user turn; {stop} kills it.
//   The broker streams normalized {type:'agent',kind,...} events back.
agentWss.on('connection', (ws) => {
    let authed = false;
    const authenticated = authDeadline(ws);
    ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'hello') {
            if (!tokenMatches(msg.token)) { sendWsJson(ws, { type: 'agent', kind: 'error', text: 'unauthorized' }, MAX_AGENT_BUFFER_BYTES); ws.close(1008, 'unauthorized'); return; }
            authenticated();
            if (!AGENT_ENABLED) { sendWsJson(ws, { type: 'agent', kind: 'error', text: 'remote agents disabled — restart with BROKER_AGENT=1 after reviewing the host-access warning' }, MAX_AGENT_BUFFER_BYTES); ws.close(1008, 'remote agents disabled'); return; }
            authed = true;
            const configuredAgents = Object.keys(AGENT_PROFILES);
            const availableAgents = configuredAgents.filter(name => hasCmd(AGENT_PROFILES[name].cmd));
            const workspaceReady = !agentWorkspaceProblem();
            // Existing Pro clients read only `agents`, so make that the usable
            // subset. `configuredAgents` preserves discovery/debug information.
            sendWsJson(ws, { type: 'agent', kind: 'welcome', protocolVersion: PROTOCOL_VERSION, agents: workspaceReady ? availableAgents : [], availableAgents, configuredAgents, workspaceReady, running: agentBridge.running() && agentBridge.name }, MAX_AGENT_BUFFER_BYTES);
            return;
        }
        if (!authed) return;
        if (msg.type === 'start') agentBridge.start(ws, msg.agent || 'claude');
        else if (msg.type === 'input') { if (!agentBridge.input(String(msg.text || ''))) sendWsJson(ws, { type: 'agent', kind: 'error', text: 'no agent running' }, MAX_AGENT_BUFFER_BYTES); }
        else if (msg.type === 'stop') agentBridge.stop();
    });
    ws.on('close', () => { if (agentBridge.ws === ws) agentBridge.stop(); });
});

// /term: the app connects out to a real PTY (xterm.js front-end).
//   {start,cmd,cols,rows} spawns; {input,data} writes keystrokes; {resize,cols,rows};
//   {stop} kills. Broker streams {type:'term',kind:'data'|'started'|'exit'|'error',...}.
termWss.on('connection', (ws) => {
    let authed = false;
    const authenticated = authDeadline(ws);
    ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === 'hello') {
            if (!tokenMatches(msg.token)) { sendWsJson(ws, { type: 'term', kind: 'error', text: 'unauthorized' }, MAX_TERM_WS_PAYLOAD_BYTES); ws.close(1008, 'unauthorized'); return; }
            authenticated();
            authed = true;
            sendWsJson(ws, { type: 'term', kind: 'welcome', protocolVersion: PROTOCOL_VERSION, enabled: TERM_ENABLED, cmds: TERM_ENABLED ? TERM_CMDS : [] }, MAX_TERM_WS_PAYLOAD_BYTES);
            return;
        }
        if (!authed) return;
        if (msg.type === 'start') termBridge.start(ws, { cmd: msg.cmd, cols: msg.cols, rows: msg.rows });
        else if (msg.type === 'input') termBridge.input(String(msg.data || ''));
        else if (msg.type === 'resize') termBridge.resize(msg.cols, msg.rows);
        else if (msg.type === 'stop') termBridge.stop();
    });
    ws.on('close', () => termBridge.detach(ws)); // keep PTY alive for reconnect
});

httpServer.listen(PORT, HOST, () => {
    const workspace = workspaceInspection();
    const loopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
    const displayHostname = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    const displayHost = displayHostname.includes(':') ? `[${displayHostname}]` : displayHostname;
    console.log(`[broker] listening on ${HOST}:${PORT}${loopback ? ' (loopback only — reach via tailscale serve or ssh -L)' : ''}`);
    console.log(`[broker]   workspace:     ${AGENT_CWD} (${workspace.ready ? 'prepared' : 'not prepared'}${MANAGE_WORKSPACE ? ', explicit repair enabled' : ''})`);
    console.log(`[broker]   MCP endpoint:  http://${displayHost}:${PORT}/mcp   (Authorization: Bearer <token>)`);
    console.log(`[broker]   app WebSocket: ws://${displayHost}:${PORT}/app`);
    console.log(`[broker]   agent WS:      ${AGENT_ENABLED ? 'ENABLED ws://' + displayHost + ':' + PORT + '/agent (agents: ' + Object.keys(AGENT_PROFILES).join(', ') + ')' : 'disabled (set BROKER_AGENT=1 after reviewing SECURITY.md)'}`);
    if (AGENT_ENABLED) console.log(`[broker]   agent access:  Claude ${AGENT_FULL_ACCESS ? 'full host tools' : 'allowlist ' + AGENT_ALLOWED_TOOLS}; other CLIs may retain normal host capabilities; environment ${AGENT_INHERIT_ENV ? 'inherited' : 'restricted'}`);
    console.log(`[broker]   terminal:      ${TERM_ENABLED ? 'ENABLED ws://' + displayHost + ':' + PORT + '/term (cmds: ' + TERM_CMDS.join(', ') + ')' + (TERM_NO_SHELL ? ' [no-shell: agents only, no shell escape]' : '') : 'disabled (set BROKER_TERM=1 to expose a PTY)'}`);
    console.log(`[broker]   pairing token: ${TOKEN_INFO.source === 'BROKER_TOKEN' ? 'provided by BROKER_TOKEN (not printed)' : 'stored in ' + TOKEN_INFO.source + ' (mode 0600)'}`);
    console.log('[broker] For remote access, keep loopback binding and use Tailscale Serve or an SSH tunnel.');
});

export { httpServer, appBridge, agentBridge, termBridge, TOKEN, PORT, PROTOCOL_VERSION };
