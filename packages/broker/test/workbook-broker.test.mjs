#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_BASE = fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp');
const testRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'scirepl-workbook-broker-'));
let passed = 0;
let failed = 0;

function ok(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.log(`  ✗ ${message}`);
        failed++;
    }
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startBroker(name, additions = {}) {
    const port = await freePort();
    const token = `${name}-token`;
    const logs = [];
    const env = { ...process.env };
    delete env.BROKER_WORKBOOK_IO_CONFIG;
    Object.assign(env, {
        BROKER_PORT: String(port),
        BROKER_HOST: '127.0.0.1',
        BROKER_TOKEN: token,
        BROKER_WORKSPACE: path.join(testRoot, `${name}-workspace`),
        BROKER_AGENT_CWD: path.join(testRoot, `${name}-workspace`),
        BROKER_CALL_TIMEOUT_MS: '5000',
        ...additions,
    });
    const child = spawn(process.execPath, ['src/broker.mjs'], {
        cwd: PACKAGE_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`broker startup timed out:\n${logs.join('')}`)), 8000);
        const inspect = () => {
            if (logs.join('').includes('[broker] listening on')) {
                clearTimeout(deadline);
                resolve();
            }
        };
        child.stdout.on('data', inspect);
        child.once('exit', code => {
            clearTimeout(deadline);
            reject(new Error(`broker exited during startup (${code}):\n${logs.join('')}`));
        });
    });
    return { child, port, token, logs };
}

async function expectBrokerStartupFailure(name, additions, pattern) {
    const port = await freePort();
    const logs = [];
    const env = {
        ...process.env,
        BROKER_PORT: String(port),
        BROKER_HOST: '127.0.0.1',
        BROKER_TOKEN: `${name}-token`,
        BROKER_WORKSPACE: path.join(testRoot, `${name}-workspace`),
        BROKER_AGENT_CWD: path.join(testRoot, `${name}-workspace`),
        ...additions,
    };
    const child = spawn(process.execPath, ['src/broker.mjs'], {
        cwd: PACKAGE_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error(`broker did not fail startup:\n${logs.join('')}`));
        }, 8000);
        child.once('exit', value => {
            clearTimeout(timer);
            resolve(value);
        });
    });
    return code !== 0 && pattern.test(logs.join(''));
}

async function stopBroker(instance) {
    if (!instance || instance.child.exitCode !== null) return;
    instance.child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => instance.child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
    if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
}

async function makeClient(port, token) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'workbook-broker-test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
}

async function rawToolCall(port, token, id, name, args) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
        }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`raw MCP call failed (${response.status}): ${body}`);
    const data = body.split(/\r?\n/).find(line => line.startsWith('data: '));
    if (!data) throw new Error(`raw MCP call returned no SSE data: ${body}`);
    return JSON.parse(data.slice('data: '.length));
}

async function connectApp(port, token, tools, onCall) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/app`);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const welcomed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('app was not welcomed')), 3000);
        ws.on('message', buf => {
            const message = JSON.parse(buf.toString());
            if (message.type === 'welcome') {
                clearTimeout(timer);
                resolve(message);
            } else if (message.type === 'call') {
                Promise.resolve(onCall(message)).then(result => {
                    ws.send(JSON.stringify({ type: 'result', id: message.id, ...result }));
                });
            }
        });
    });
    ws.send(JSON.stringify({ type: 'hello', token, tools }));
    await welcomed;
    return ws;
}

const tool = (name) => ({
    type: 'function',
    function: {
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
    },
});

const BASE_TOOLS = [tool('echo'), tool('export_workbook'), tool('import_workbook')];

console.log('Workbook direct-to-file broker integration\n');

let bare;
let configured;
let bareApp;
let app;
let bareClient;
let clientConnection;
try {
    bare = await startBroker('unconfigured');
    bareApp = await connectApp(bare.port, bare.token, BASE_TOOLS, message => ({
        output: message.name === 'echo' ? `echo:${message.args.value}` : '{}',
    }));
    bareClient = await makeClient(bare.port, bare.token);
    const bareTools = await bareClient.client.listTools();
    const bareNames = bareTools.tools.map(entry => entry.name);
    ok(bareNames.includes('export_workbook') && bareNames.includes('import_workbook') &&
        !bareNames.includes('export_workbook_to_file') && !bareNames.includes('import_workbook_from_file'),
    'unconfigured broker exposes the app tools but no direct-to-file wrappers');
    const echo = await bareClient.client.callTool({ name: 'echo', arguments: { value: 'unchanged' } });
    ok(echo.content?.[0]?.text === 'echo:unchanged', 'ordinary MCP relay behavior remains unchanged');
    await bareClient.transport.close();
    bareApp.close();
    await stopBroker(bare);

    const allowedRoot = path.join(testRoot, 'allowed');
    const configDir = path.join(testRoot, 'private');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'workbook-io.json');
    fs.writeFileSync(configPath, JSON.stringify({
        schemaVersion: 1,
        maxContentBytes: 1024 * 1024,
        roots: [{ name: 'artifacts', path: allowedRoot, read: true, write: true, allowOverwrite: true }],
    }), { mode: 0o600 });

    configured = await startBroker('configured', {
        BROKER_WORKBOOK_IO_CONFIG: configPath,
        BROKER_MAX_APP_WS_PAYLOAD_BYTES: '42008576',
    });

    const preApp = await makeClient(configured.port, configured.token);
    const preAppTools = await preApp.client.listTools();
    ok(!preAppTools.tools.some(entry =>
        entry.name === 'export_workbook_to_file' || entry.name === 'import_workbook_from_file'),
    'configured broker exposes no wrappers before a paired app advertises the base tools');
    await preApp.transport.close();

    ok(await expectBrokerStartupFailure('wire-cap-failure', {
        BROKER_WORKBOOK_IO_CONFIG: configPath,
        BROKER_MAX_APP_WS_PAYLOAD_BYTES: '16777216',
    }, /42008576|APP_WIRE|payload|wire/i),
    'configured workbook transfer fails startup under the default 16 MiB app wire cap');

    const workbookContent = JSON.stringify({
        format: 'srwb',
        marker: 'PAYLOAD-MUST-NOT-ENTER-THE-RECEIPT',
        unicode: '漢字',
        quoted: '"hello"',
        slash: '\\path',
    }, null, 2);
    const workbookBytes = Buffer.from(workbookContent, 'utf8');
    const workbookSha = sha256(workbookBytes);
    const calls = [];
    let permission = 'deny';
    let importedState = 0;
    app = await connectApp(configured.port, configured.token, BASE_TOOLS, message => {
        calls.push({ name: message.name, args: message.args });
        if (message.name === 'echo') return { output: `echo:${message.args.value}` };
        if (message.name === 'export_workbook') {
            if (permission === 'deny') return { error: 'Workbook import/export permission denied by the app' };
            return { output: JSON.stringify({
                format: message.args.format,
                filename: `ignored.${message.args.format}`,
                mimeType: 'application/json',
                encoding: 'utf-8',
                content: workbookContent,
                size: workbookBytes.length,
                sha256: workbookSha,
            }) };
        }
        if (message.name === 'import_workbook') {
            if (permission === 'deny') return { error: 'Workbook import/export permission denied by the app' };
            importedState++;
            return { output: JSON.stringify({
                ok: true,
                format: message.args.format,
                mode: message.args.mode,
                notebookId: 'filtered-id',
                name: 'filtered-name',
                cells: 3,
                size: Buffer.byteLength(message.args.content, 'utf8'),
                sha256: message.args.sha256,
            }) };
        }
        return { error: 'unexpected app tool' };
    });

    clientConnection = await makeClient(configured.port, configured.token);
    const { client } = clientConnection;
    const listed = await client.listTools();
    const names = listed.tools.map(entry => entry.name);
    const exportDefinition = listed.tools.find(entry => entry.name === 'export_workbook_to_file');
    const importDefinition = listed.tools.find(entry => entry.name === 'import_workbook_from_file');
    ok(names.includes('export_workbook_to_file') && names.includes('import_workbook_from_file'),
        'configured broker exposes both wrappers when the app advertises both base tools');
    ok(exportDefinition?.inputSchema?.additionalProperties === false &&
        importDefinition?.inputSchema?.additionalProperties === false,
    'synthetic schemas are closed to unknown properties');

    const deniedPath = 'denied/export.srwb';
    fs.mkdirSync(path.join(allowedRoot, 'denied'));
    const deniedExport = await client.callTool({
        name: 'export_workbook_to_file',
        arguments: { format: 'srwb', root: 'artifacts', path: deniedPath },
    });
    ok(deniedExport.isError === true && !fs.existsSync(path.join(allowedRoot, ...deniedPath.split('/'))),
        'app permission denial creates no export file');

    permission = 'allow';
    const exportPath = 'locale/demo.srwb';
    fs.mkdirSync(path.join(allowedRoot, 'locale'));
    const exported = await client.callTool({
        name: 'export_workbook_to_file',
        arguments: { format: 'srwb', root: 'artifacts', path: exportPath },
    });
    const exportReceipt = JSON.parse(exported.content?.[0]?.text || '{}');
    const onDisk = fs.readFileSync(path.join(allowedRoot, ...exportPath.split('/')));
    ok(exported.isError !== true && onDisk.equals(workbookBytes),
        'export writes byte-identical canonical content from the app envelope');
    ok(exportReceipt.direction === 'export' && exportReceipt.root === 'artifacts' &&
        exportReceipt.path === exportPath && exportReceipt.size === workbookBytes.length &&
        exportReceipt.sha256 === workbookSha && exportReceipt.overwritten === false &&
        ['string', 'number'].includes(typeof exportReceipt.toolCallId) &&
        !Number.isNaN(Date.parse(exportReceipt.timestamp)),
    'export receipt contains the public path, raw-byte digest, call binding, and timestamp');
    const exportReceiptText = JSON.stringify(exportReceipt);
    ok(!exportReceiptText.includes(workbookContent) &&
        !exportReceiptText.includes('PAYLOAD-MUST-NOT-ENTER-THE-RECEIPT') &&
        !exportReceiptText.includes(allowedRoot) && !('content' in exportReceipt),
    'export receipt contains neither workbook bytes nor an absolute host path');
    const exportCall = calls.find(entry => entry.name === 'export_workbook' &&
        entry.args.brokerPath === exportPath);
    ok(exportCall && JSON.stringify(exportCall.args) === JSON.stringify({
        format: 'srwb',
        brokerRoot: 'artifacts',
        brokerPath: exportPath,
    }), 'export wrapper forwards only format and validated destination context to the app gate');

    const rawRequestId = 'supervision-call-42';
    const rawResponse = await rawToolCall(
        configured.port,
        configured.token,
        rawRequestId,
        'export_workbook_to_file',
        { format: 'srwb', root: 'artifacts', path: 'locale/bound.srwb' });
    const boundReceipt = JSON.parse(rawResponse.result?.content?.[0]?.text || '{}');
    ok(rawResponse.id === rawRequestId && boundReceipt.toolCallId === rawRequestId,
        'receipt toolCallId exactly binds to the caller-visible MCP JSON-RPC request ID');

    const direct = await client.callTool({ name: 'export_workbook', arguments: { format: 'srwb' } });
    const directEnvelope = JSON.parse(direct.content?.[0]?.text || '{}');
    ok(Buffer.from(directEnvelope.content, 'utf8').equals(onDisk),
        'simulated paired-app check: direct and relocated export bytes are identical');

    const callsBeforeSpoof = calls.length;
    const spoofedExport = await client.callTool({
        name: 'export_workbook',
        arguments: {
            format: 'srwb',
            brokerRoot: 'fake-root',
            brokerPath: 'fake/path.srwb',
        },
    });
    const spoofedImport = await client.callTool({
        name: 'import_workbook',
        arguments: {
            format: 'srwb',
            content: '{}',
            mode: 'replace',
            brokerRoot: 'fake-root',
            brokerPath: 'fake/path.srwb',
        },
    });
    ok(spoofedExport.isError === true && spoofedImport.isError === true && calls.length === callsBeforeSpoof,
        'ordinary base-tool calls cannot spoof broker-owned source or destination context');

    permission = 'deny';
    const deniedAgainPath = 'denied/again.srwb';
    const deniedAgain = await client.callTool({
        name: 'export_workbook_to_file',
        arguments: { format: 'srwb', root: 'artifacts', path: deniedAgainPath },
    });
    ok(deniedAgain.isError === true && !fs.existsSync(path.join(allowedRoot, ...deniedAgainPath.split('/'))) &&
        calls.filter(entry => entry.name === 'export_workbook').length >= 4,
    'deny→allow→deny decisions are forwarded per call and never cached');

    const importFile = path.join(allowedRoot, 'locale', 'import.srwb');
    fs.writeFileSync(importFile, workbookBytes);
    const importsBeforeDeny = calls.filter(entry => entry.name === 'import_workbook').length;
    const deniedImport = await client.callTool({
        name: 'import_workbook_from_file',
        arguments: { format: 'srwb', root: 'artifacts', path: 'locale/import.srwb', mode: 'create' },
    });
    ok(deniedImport.isError === true && importedState === 0 &&
        calls.filter(entry => entry.name === 'import_workbook').length === importsBeforeDeny + 1,
    'import permission denial reaches the app and causes no simulated mutation');

    permission = 'allow';
    const imported = await client.callTool({
        name: 'import_workbook_from_file',
        arguments: { format: 'srwb', root: 'artifacts', path: 'locale/import.srwb', mode: 'create', sha256: workbookSha },
    });
    const importReceipt = JSON.parse(imported.content?.[0]?.text || '{}');
    const importCall = calls.filter(entry => entry.name === 'import_workbook').at(-1);
    ok(imported.isError !== true && importCall.args.content === workbookContent &&
        importCall.args.sha256 === workbookSha && importCall.args.mode === 'create' &&
        importCall.args.brokerRoot === 'artifacts' && importCall.args.brokerPath === 'locale/import.srwb' &&
        importedState === 1,
    'import streams the exact UTF-8 file bytes and recomputed digest to the app');
    ok(importReceipt.direction === 'import' && importReceipt.status === 'imported' &&
        importReceipt.mode === 'create' && importReceipt.root === 'artifacts' &&
        importReceipt.path === 'locale/import.srwb' && importReceipt.size === workbookBytes.length &&
        importReceipt.sha256 === workbookSha && !('name' in importReceipt) &&
        !('notebookId' in importReceipt) && !('cells' in importReceipt) && !('content' in importReceipt),
    'import receipt filters all app and workbook metadata');

    const importCallsBeforeMismatch = calls.filter(entry => entry.name === 'import_workbook').length;
    const mismatch = await client.callTool({
        name: 'import_workbook_from_file',
        arguments: { format: 'srwb', root: 'artifacts', path: 'locale/import.srwb', sha256: '0'.repeat(64) },
    });
    ok(mismatch.isError === true &&
        calls.filter(entry => entry.name === 'import_workbook').length === importCallsBeforeMismatch,
    'caller digest mismatch is rejected before contacting the app');

    const auditText = configured.logs.join('');
    ok(auditText.includes('"direction":"export"') && auditText.includes('"direction":"import"') &&
        auditText.includes('"root":"artifacts"') && auditText.includes(`"sha256":"${workbookSha}"`) &&
        !auditText.includes('PAYLOAD-MUST-NOT-ENTER-THE-RECEIPT') && !auditText.includes(allowedRoot),
    'broker audit records direction and digest without content or absolute paths');
    const auditRecords = auditText.split(/\r?\n/)
        .filter(line => line.includes('[broker] workbook-file {'))
        .map(line => JSON.parse(line.slice(line.indexOf('{'))));
    ok(auditRecords.length >= 4 && auditRecords.every(record =>
        JSON.stringify(Object.keys(record).sort()) === JSON.stringify([
            'direction', 'format', 'outcome', 'overwrite', 'path', 'root', 'sha256', 'size',
        ].sort())) && auditRecords.some(record => record.outcome === 'failed') &&
        auditRecords.some(record => record.outcome === 'written') &&
        auditRecords.some(record => record.outcome === 'imported'),
    'audit channel uses the exact content-free success/failure evidence schema');

    const collision = new WebSocket(`ws://127.0.0.1:${configured.port}/app`);
    collision.on('error', () => {});
    await new Promise((resolve, reject) => { collision.once('open', resolve); collision.once('error', reject); });
    const collisionClosed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('collision connection stayed open')), 3000);
        collision.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    collision.send(JSON.stringify({
        type: 'hello',
        token: configured.token,
        tools: [tool('export_workbook_to_file')],
    }));
    ok(await collisionClosed === 1008, 'an app-advertised synthetic-name collision is rejected');
    const postCollisionEcho = await client.callTool({ name: 'echo', arguments: { value: 'still-live' } });
    ok(postCollisionEcho.content?.[0]?.text === 'echo:still-live',
        'a rejected collision does not replace the valid connected app');

    app.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterDisconnect = await client.listTools();
    ok(!afterDisconnect.tools.some(entry =>
        entry.name === 'export_workbook_to_file' || entry.name === 'import_workbook_from_file'),
    'direct-to-file wrappers disappear when the paired app disconnects');
} catch (error) {
    console.log(`  ✗ unexpected error: ${error.stack || error}`);
    failed++;
} finally {
    try { await bareClient?.transport.close(); } catch (_) {}
    try { bareApp?.close(); } catch (_) {}
    try { await clientConnection?.transport.close(); } catch (_) {}
    try { app?.close(); } catch (_) {}
    await stopBroker(bare);
    await stopBroker(configured);
    fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
