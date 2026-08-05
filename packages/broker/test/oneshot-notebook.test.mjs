#!/usr/bin/env node
/**
 * test-mcp-oneshot-notebook.mjs — codex/gemini drive the notebook via the scirepl MCP.
 *
 * A fake app connects on /app advertising list_cells (returns a sentinel). codex /
 * gemini are told to call the scirepl notebook tool and report the first cell name.
 * Proves the MCP wiring: agent → broker /mcp → /app → tool → back into the answer.
 *
 * Real codex/gemini calls. Gated behind RUN_AGENT_E2E=1; self-skips otherwise and
 * skips any agent whose CLI isn't on PATH.
 *
 *   RUN_AGENT_E2E=1 npm run test:oneshot:notebook
 */
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PORT = 8086, TOKEN = 'oneshot-nb-test';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_WORKSPACE = path.join(process.cwd(), '.test-workspaces', `${process.pid}-${PORT}`);
const SENTINEL = 'CELL_SENTINEL_7777';

let passed = 0, failed = 0;
const ok = (c, m) => { console.log('  ' + (c ? '✓' : '✗') + ' ' + m); c ? passed++ : failed++; };
const has = (c) => { try { return spawnSync('sh', ['-c', `command -v ${c}`]).status === 0; } catch { return false; } };

if (process.env.RUN_AGENT_E2E !== '1') { console.log('one-shot notebook e2e — SKIPPED (set RUN_AGENT_E2E=1)'); process.exit(0); }

await import('../src/broker.mjs');
await new Promise(r => setTimeout(r, 300));

// fake app: advertises list_cells, answers with the sentinel
let appCalls = 0;
const app = new WebSocket(`ws://127.0.0.1:${PORT}/app`);
await new Promise((res, rej) => { app.on('open', res); app.on('error', rej); });
app.send(JSON.stringify({ type: 'hello', token: TOKEN, tools: [{ type: 'function', function: { name: 'list_cells', description: 'List the notebook cells.', parameters: { type: 'object', properties: {} } } }] }));
app.on('message', (b) => { const m = JSON.parse(b); if (m.type === 'call' && m.name === 'list_cells') { appCalls++; app.send(JSON.stringify({ type: 'result', id: m.id, output: JSON.stringify({ cells: [{ index: 1, name: SENTINEL }] }) })); } });
await new Promise(r => setTimeout(r, 200));

async function runAgent(agent) {
    console.log(`\n${agent}: drive notebook via scirepl MCP`);
    const before = appCalls;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    let text = '', tool = false;
    const done = new Promise((resolve) => {
        ws.on('message', (b) => {
            const m = JSON.parse(b); if (m.type !== 'agent') return;
            if (m.kind === 'started') { setTimeout(() => ws.send(JSON.stringify({ type: 'input', text: 'Use the scirepl list_cells tool to list the notebook cells, then reply with ONLY the name of the first cell.' })), 200); return; }
            if (m.kind === 'assistant') text += m.text || '';
            if (m.kind === 'tool_use') tool = true;
            if (m.kind === 'result' || m.kind === 'error') resolve();
        });
    });
    ws.send(JSON.stringify({ type: 'start', agent }));
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 240000));
    try {
        await Promise.race([done, to]);
        const called = appCalls > before;
        ok(called, `${agent} called the scirepl tool through /mcp → /app (calls: ${appCalls - before})`);
        ok(text.includes(SENTINEL), `${agent} reported the notebook sentinel (got: "${text.trim().slice(0, 50)}")`);
    } catch (e) { ok(false, `${agent}: ${e.message}`); }
    try { ws.close(); } catch (_) {}
}

// Only gemini is wired for notebook-MCP (codex cancels tool calls against the
// stateless streamable-HTTP /mcp — a codex compat issue; chat-only for now).
console.log('one-shot agents drive the notebook (gemini) — real calls');
for (const a of ['gemini']) { if (has(a)) await runAgent(a); else console.log(`\n${a}: SKIPPED (CLI not found)`); }

console.log(`\n${passed} passed, ${failed} failed`);
try { app.close(); } catch (_) {}
process.exit(failed ? 1 : 0);
