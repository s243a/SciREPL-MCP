#!/usr/bin/env node
/**
 * test-mcp-agent.mjs — end-to-end test for the remote-agent bridge (/agent).
 *
 * Proves the self-hosting loop: broker spawns `claude -p` (stream-json), the app
 * connects on /app advertising a notebook tool, the agent connects on /agent and
 * is told to USE that tool — its call must travel claude → /mcp → /app → back,
 * and the agent's final answer must contain the sentinel the app returned.
 *
 * This makes ONE real `claude` call (uses the subscription). Gated behind a flag
 * so it never runs by accident.
 *
 *   RUN_AGENT_E2E=1 npm run test:agent
 *
 * Without the flag (and without the `claude` CLI) it self-skips and exits 0.
 */
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PORT = 8098, TOKEN = 'agent-test-token';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_WORKSPACE = path.join(process.cwd(), '.test-workspaces', `${process.pid}-${PORT}`);

const SENTINEL = 'NOTEBOOK_SENTINEL_4242';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ✓ ' + m); passed++; } else { console.log('  ✗ ' + m); failed++; } };

// Self-skip unless explicitly enabled and `claude` is installed.
const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
if (process.env.RUN_AGENT_E2E !== '1' || !hasClaude) {
    console.log('remote-agent e2e — SKIPPED' +
        (hasClaude ? ' (set RUN_AGENT_E2E=1 to run a real claude call)' : ' (claude CLI not found)'));
    process.exit(0);
}

const { agentBridge } = await import('../src/broker.mjs');
await new Promise(r => setTimeout(r, 300));

// ── Simulated app: advertises list_cells, answers calls with the sentinel ──
let appGotCall = false;
const APP_TOOLS = [
    { type: 'function', function: { name: 'list_cells', description: 'List the notebook cells.', parameters: { type: 'object', properties: {} } } },
];
const app = new WebSocket(`ws://127.0.0.1:${PORT}/app`);
await new Promise((res, rej) => { app.on('open', res); app.on('error', rej); });
app.send(JSON.stringify({ type: 'hello', token: TOKEN, tools: APP_TOOLS }));
app.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === 'call' && msg.name === 'list_cells') {
        appGotCall = true;
        app.send(JSON.stringify({ type: 'result', id: msg.id, output: JSON.stringify({ cells: [{ index: 1, name: SENTINEL }] }) }));
    }
});
await new Promise(r => setTimeout(r, 200));

console.log('remote-agent bridge — end-to-end (real claude call)\n');

// ── Connect on /agent, drive one tool-using turn ──
const ag = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
await new Promise((res, rej) => { ag.on('open', res); ag.on('error', rej); });
ag.send(JSON.stringify({ type: 'hello', token: TOKEN }));

let welcomed = false, started = false, sawToolUse = false, finalText = '';
const done = new Promise((resolve) => {
    ag.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.type !== 'agent') return;
        if (m.kind === 'welcome') { welcomed = (m.agents || []).includes('claude'); ag.send(JSON.stringify({ type: 'start', agent: 'claude' })); }
        else if (m.kind === 'started') {
            started = true;
            ag.send(JSON.stringify({ type: 'input', text:
                `Call the list_cells tool, then reply with ONLY the name of the first cell. Nothing else.` }));
        }
        else if (m.kind === 'tool_use') { sawToolUse = true; }
        else if (m.kind === 'result') { finalText = m.text || ''; resolve(); }
        else if (m.kind === 'stderr') { /* surface in debug */ if (process.env.DEBUG) console.error('[agent stderr]', m.text); }
    });
});

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout (90s)')), 90000));
try {
    await Promise.race([done, timeout]);
    ok(welcomed, 'welcome lists the claude agent');
    ok(started, 'agent session started (claude spawned)');
    ok(appGotCall, 'agent drove the notebook tool through the /mcp→/app loop');
    ok(sawToolUse, 'a tool_use event was streamed to the app');
    ok(finalText.includes(SENTINEL), `agent answer contains the notebook sentinel (got: "${finalText.slice(0, 60)}")`);
} catch (e) {
    console.log('  ✗ ' + (e.message || e));
    failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
try { agentBridge.stop(); ag.close(); app.close(); } catch (_) {}
process.exit(failed ? 1 : 0);
