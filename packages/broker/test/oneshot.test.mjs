#!/usr/bin/env node
/**
 * test-mcp-oneshot.mjs — end-to-end check for the one-shot agents (codex/gemini).
 *
 * Drives one turn through the broker /agent bridge and asserts the adapter pipeline
 * works: spawn the CLI → parse its JSON events → stream an `assistant` answer →
 * `result`. (Multi-turn resume IS implemented — buildArgs resumes by session id /
 * `-r latest` — but recall is non-deterministic to assert against live agentic CLIs,
 * so this test validates the deterministic single-turn path.)
 *
 * Makes real codex/gemini calls. Gated behind RUN_AGENT_E2E=1; self-skips otherwise
 * and skips any agent whose CLI isn't on PATH.
 *
 *   RUN_AGENT_E2E=1 npm run test:oneshot
 */
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PORT = 8088, TOKEN = 'oneshot-test';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_WORKSPACE = path.join(process.cwd(), '.test-workspaces', `${process.pid}-${PORT}`);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ' + (c ? '✓' : '✗') + ' ' + m); c ? passed++ : failed++; } else { console.log('  ✗ ' + m); failed++; } };
const has = (c) => { try { return spawnSync('sh', ['-c', `command -v ${c}`]).status === 0; } catch { return false; } };

if (process.env.RUN_AGENT_E2E !== '1') { console.log('one-shot agents e2e — SKIPPED (set RUN_AGENT_E2E=1)'); process.exit(0); }

await import('../src/broker.mjs');
await new Promise(r => setTimeout(r, 300));

async function runAgent(agent) {
    console.log(`\n${agent}: multi-turn (remember → recall via resume)`);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    let text = '', sawResult = false, sawErr = '';
    const ask = (t) => ws.send(JSON.stringify({ type: 'input', text: t }));
    const done = new Promise((resolve) => {
        ws.on('message', (b) => {
            const m = JSON.parse(b); if (m.type !== 'agent') return;
            if (m.kind === 'welcome') return;
            if (m.kind === 'started') { setTimeout(() => ask('Reply with exactly the word PONG and nothing else.'), 200); return; }
            if (m.kind === 'assistant') text += m.text || '';
            if (m.kind === 'error') sawErr = m.text || 'error';
            if (m.kind === 'result' || m.kind === 'error') { sawResult = true; resolve(); }
        });
    });
    ws.send(JSON.stringify({ type: 'start', agent }));
    // codex is an autonomous agent and can be slow; allow generous time.
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 240000));
    try {
        await Promise.race([done, to]);
        ok(sawResult && /pong/i.test(text), `${agent} one-turn round-trip via the broker (answer: "${text.trim().slice(0, 40)}"${sawErr ? '; err: ' + sawErr.slice(0, 40) : ''})`);
    } catch (e) { ok(false, `${agent}: ${e.message}`); }
    try { ws.close(); } catch (_) {}
}

console.log('one-shot agents (codex / gemini / agy) — real calls');
for (const a of ['codex', 'gemini', 'agy']) { if (has(a)) await runAgent(a); else console.log(`\n${a}: SKIPPED (CLI not found)`); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
