#!/usr/bin/env node
/**
 * End-to-end test for the standalone SciREPL MCP broker.
 *
 * Spins the broker, a SIMULATED SciREPL app (WS client that advertises tools and
 * answers calls), and a real MCP SDK client, then asserts a tool call round-trips
 * MCP-client → broker → app → back. Also checks auth rejection, status reporting,
 * disabled privileged endpoints, and request-size limits. No browser/device.
 *
 * Run: npm test
 */
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8099, TOKEN = 'test-token';
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN = TOKEN;
process.env.BROKER_MAX_HTTP_BODY_BYTES = '8192';
process.env.BROKER_MAX_AGENT_WS_PAYLOAD_BYTES = '1024';
const testRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-mcp-broker-'));
process.env.BROKER_WORKSPACE = path.join(testRoot, 'workspace');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { console.log('  ✓ ' + m); passed++; } else { console.log('  ✗ ' + m); failed++; } };

// Start the broker (listens on import).
const { appBridge } = await import('../src/broker.mjs');
await new Promise(r => setTimeout(r, 300));

// ── Simulated SciREPL app: WS client that advertises tools + answers calls ──
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LARGE_PNG_PLACEHOLDER = 'A'.repeat(1048580); // valid base64 alphabet; just over 1 MiB
let unadvertisedCalls = 0;
const APP_TOOLS = [
    { type: 'function', function: { name: 'echo', description: 'echo back a message', parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } } },
    { type: 'function', function: { name: 'list_cells', description: 'list cells', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_cell', description: 'read a cell property', parameters: { type: 'object', properties: { cell: { type: 'string' }, property: { type: 'string' } } } } },
    { type: 'function', function: { name: 'hang', description: 'intentionally never replies', parameters: { type: 'object', properties: {} } } },
];
const app = new WebSocket(`ws://127.0.0.1:${PORT}/app`);
await new Promise((res, rej) => { app.on('open', res); app.on('error', rej); });
app.send(JSON.stringify({ type: 'hello', token: TOKEN, tools: APP_TOOLS }));
app.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === 'call') {
        let output;
        if (msg.name === 'echo') output = 'echo: ' + (msg.args.msg || '');
        else if (msg.name === 'list_cells') output = JSON.stringify({ cells: [{ index: 1, name: 'demo' }] });
        else if (msg.name === 'read_cell') {
            if (msg.args.property === '.output.png') output = 'data:image/png;base64,' + PNG_1x1;
            else if (msg.args.property === '.output.large.png') output = 'data:image/png;base64,' + LARGE_PNG_PLACEHOLDER;
            else output = 'cell code';
        } else if (msg.name === 'hang') return;
        else { unadvertisedCalls++; output = 'unknown'; }
        app.send(JSON.stringify({ type: 'result', id: msg.id, output }));
    }
});
await new Promise(r => setTimeout(r, 200));

console.log('MCP broker — end-to-end tests\n');

// ── Real MCP client over Streamable HTTP, authenticated ──
async function makeClient(token) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
}

try {
    const { client, transport } = await makeClient(TOKEN);

    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name).sort();
    ok(names.length === 4 && names.includes('echo') && names.includes('list_cells') && names.includes('read_cell') && names.includes('hang'), 'tools/list returns the app-advertised tools (' + names.join(',') + ')');
    ok(!!tools.tools.find(t => t.name === 'echo').inputSchema, 'tool input schema forwarded');

    const r1 = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    ok(r1.content?.[0]?.text === 'echo: hi', 'tools/call round-trips MCP→broker→app→back (' + r1.content?.[0]?.text + ')');

    const r2 = await client.callTool({ name: 'list_cells', arguments: {} });
    ok(/"name":"demo"/.test(r2.content?.[0]?.text || ''), 'second tool call works');

    // #2: a data:image result comes back as an MCP image content block (vision)
    const ri = await client.callTool({ name: 'read_cell', arguments: { cell: '1', property: '.output.png' } });
    ok(ri.content?.[0]?.type === 'image' && ri.content[0].mimeType === 'image/png' && ri.content[0].data === PNG_1x1,
        'data:image result → MCP image content block (type=' + ri.content?.[0]?.type + ')');
    const rt = await client.callTool({ name: 'read_cell', arguments: { cell: '1', property: '.code' } });
    ok(rt.content?.[0]?.type === 'text', 'non-image result stays a text block');
    const ril = await client.callTool({ name: 'read_cell', arguments: { cell: '1', property: '.output.large.png' } });
    ok(ril.content?.[0]?.type === 'image' && ril.content[0].data.length === LARGE_PNG_PLACEHOLDER.length,
        'app bridge accepts a plot result larger than 1 MiB');

    const r3 = await client.callTool({ name: 'nope', arguments: {} });
    ok(r3.isError === true && /not advertised/i.test(r3.content?.[0]?.text || '') && unadvertisedCalls === 0,
        'unadvertised tool is rejected by the broker and never forwarded to the app');

    // Auth rejection
    let rejected = false;
    try {
        const bad = await makeClient('wrong-token');
        await bad.client.listTools();
        await bad.transport.close();
    } catch (e) { rejected = true; }
    ok(rejected, 'wrong pairing token is rejected (401)');

    const healthResponse = await fetch(`http://127.0.0.1:${PORT}/health`);
    const health = await healthResponse.json();
    ok(healthResponse.status === 200 && health.ok === true && health.protocolVersion === 1 &&
        health.appConnected === true && health.tools === APP_TOOLS.length &&
        health.agentEnabled === false && health.termEnabled === false,
    'health reports protocol, app connection, tools, and disabled privileged features');

    const agent = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    await new Promise((res, rej) => { agent.on('open', res); agent.on('error', rej); });
    const disabledAgentMessage = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('disabled /agent did not respond')), 2000);
        agent.once('message', (buf) => { clearTimeout(timer); resolve(JSON.parse(buf.toString())); });
    });
    agent.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    const agentReply = await disabledAgentMessage;
    ok(agentReply.kind === 'error' && /disabled/i.test(agentReply.text || ''),
        'remote-agent endpoint fails closed unless BROKER_AGENT=1');
    try { agent.close(); } catch (_) {}

    const oversized = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(8192) }),
    });
    ok(oversized.status === 413, 'oversized MCP request body is rejected (413)');

    const oversizedSocket = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    oversizedSocket.on('error', () => {});
    await new Promise((res, rej) => { oversizedSocket.on('open', res); oversizedSocket.on('error', rej); });
    const oversizedClosed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('oversized WebSocket was not closed')), 2000);
        oversizedSocket.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    oversizedSocket.send('x'.repeat(2048));
    const oversizedCloseCode = await oversizedClosed;
    const postOversizeHealth = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    ok(oversizedCloseCode === 1009 && postOversizeHealth.ok === true,
        'oversized unauthenticated WebSocket closes without crashing the broker');

    const hangingCall = client.callTool({ name: 'hang', arguments: {} });
    await new Promise(resolve => setTimeout(resolve, 50));
    app.close();
    const disconnected = await Promise.race([
        hangingCall,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pending call was not rejected on app disconnect')), 1500)),
    ]);
    ok(disconnected.isError === true && /disconnected/i.test(disconnected.content?.[0]?.text || '') && appBridge.pending.size === 0,
        'app disconnect immediately rejects and clears pending tool calls');
    await transport.close();

} catch (e) {
    console.log('  ✗ unexpected error: ' + (e.stack || e));
    failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
try { app.close(); } catch (_) {}
fs.rmSync(testRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
