#!/usr/bin/env node
/**
 * test-mcp-session.mjs — multi-turn session continuity for the /agent bridge.
 *
 * Regression for the "fresh process per message" bug: verifies the broker
 *   (a) REUSES a live session on a redundant start (no respawn → context kept), and
 *   (b) RESUMES via the captured session_id after a respawn (e.g. a dropped WS),
 * so the agent remembers across turns either way.
 *
 * Makes a few real `claude` calls (subscription). Gated behind RUN_AGENT_E2E=1.
 *
 *   RUN_AGENT_E2E=1 npm run test:session
 */
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PORT = 8092, TOKEN = 'session-test';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_AGENT = '1';
process.env.BROKER_WORKSPACE = path.join(process.cwd(), '.test-workspaces', `${process.pid}-${PORT}`);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ✓ ' + m); passed++; } else { console.log('  ✗ ' + m); failed++; } };

const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
if (process.env.RUN_AGENT_E2E !== '1' || !hasClaude) {
    console.log('session-continuity e2e — SKIPPED' + (hasClaude ? ' (set RUN_AGENT_E2E=1)' : ' (claude CLI not found)'));
    process.exit(0);
}

const { agentBridge } = await import('../src/broker.mjs');
await new Promise(r => setTimeout(r, 300));
const app = new WebSocket(`ws://127.0.0.1:${PORT}/app`);
await new Promise((res, rej) => { app.on('open', res); app.on('error', rej); });
app.send(JSON.stringify({ type: 'hello', token: TOKEN, tools: [] }));
await new Promise(r => setTimeout(r, 200));
const ag = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
await new Promise((res, rej) => { ag.on('open', res); ag.on('error', rej); });
ag.send(JSON.stringify({ type: 'hello', token: TOKEN }));

console.log('remote-agent session continuity (real claude)\n');

let phase = 0, reusedSeen = false, resumedSeen = false, turn2 = '', turn3 = '';
const ask = (t) => ag.send(JSON.stringify({ type: 'input', text: t }));
const done = new Promise((resolve) => {
    ag.on('message', (b) => {
        const m = JSON.parse(b); if (m.type !== 'agent') return;
        if (m.kind === 'started') { if (m.reused) reusedSeen = true; if (m.resumed) resumedSeen = true; }
        if (m.kind !== 'result') return;
        if (phase === 0) { phase = 1;
            ag.send(JSON.stringify({ type: 'start', agent: 'claude' }));        // redundant start → reuse
            setTimeout(() => ask('What number did I tell you? Reply only the number. No tools.'), 600);
        } else if (phase === 1) { phase = 2; turn2 = String(m.text);
            agentBridge.stop();                                                 // simulate dropped WS / crash
            setTimeout(() => { ag.send(JSON.stringify({ type: 'start', agent: 'claude' }));
                setTimeout(() => ask('What number did I tell you earlier? Reply only the number. No tools.'), 800); }, 600);
        } else { turn3 = String(m.text); resolve(); }
    });
});
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 170000));

try {
    setTimeout(() => { ag.send(JSON.stringify({ type: 'start', agent: 'claude' }));
        setTimeout(() => ask('Remember the number 42. Acknowledge briefly. No tools.'), 500); }, 300);
    await Promise.race([done, timeout]);
    ok(reusedSeen, 'redundant start REUSED the live session (no respawn)');
    ok(turn2.includes('42'), `context kept across redundant start (turn2: "${turn2.slice(0, 40)}")`);
    ok(resumedSeen, 'respawn RESUMED via session_id');
    ok(turn3.includes('42'), `context kept across respawn-resume (turn3: "${turn3.slice(0, 40)}")`);
} catch (e) { console.log('  ✗ ' + (e.message || e)); failed++; }

console.log(`\n${passed} passed, ${failed} failed`);
try { agentBridge.stop(); ag.close(); app.close(); } catch (_) {}
process.exit(failed ? 1 : 0);
