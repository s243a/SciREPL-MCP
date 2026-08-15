#!/usr/bin/env node
/**
 * Regression for split multi-byte UTF-8 on child stdout/stderr. The catalog
 * translation campaign exposed silent U+FFFD corruption when each OS chunk was
 * decoded independently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { configureUtf8Pipes, truncateCodePoints } from '../src/utf8-pipes.mjs';

const SENTINEL = 'côtés · 日本語 · বাংলা · 👩‍🔬';
const STDERR_SENTINEL = 'diagnóstico · العربية · 👩‍🔬\n';
let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

console.log('Agent UTF-8 streaming — regression tests\n');

async function decodeOneByteAtATime(streamName) {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    configureUtf8Pipes(child);
    const stream = child[streamName];
    let decoded = '';
    stream.on('data', chunk => { decoded += chunk; });
    const bytes = Buffer.from(SENTINEL);
    for (let index = 0; index < bytes.length; index++) stream.write(bytes.subarray(index, index + 1));
    stream.end();
    await once(stream, 'end');
    return decoded;
}

for (const streamName of ['stdout', 'stderr']) {
    const decoded = await decodeOneByteAtATime(streamName);
    ok(decoded === SENTINEL && !decoded.includes('\uFFFD'),
        `${streamName} preserves 2-, 3-, and 4-byte characters across one-byte chunks`);
}

const boundaryDiagnostic = 'a'.repeat(499) + '😀' + 'tail';
const truncatedDiagnostic = truncateCodePoints(boundaryDiagnostic, 500);
ok(truncatedDiagnostic === 'a'.repeat(499) + '😀' && !truncatedDiagnostic.includes('\uFFFD'),
    'stderr diagnostics are bounded without splitting a surrogate pair at the limit');

// Agent mode is supported through WSL rather than native Windows. The portable
// stream assertions above still exercise the production decoder on Windows CI.
if (process.platform !== 'win32') {
    const PORT = 8094;
    const TOKEN = 'utf8-agent-test-token';
    const testRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'scirepl-mcp-utf8-agent-'));
    const binDir = path.join(testRoot, 'bin');
    const workspace = path.join(testRoot, 'workspace');
    const temporary = path.join(testRoot, 'tmp');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(temporary, { recursive: true });

    const fixture = path.join(binDir, 'fake-agent.cjs');
    const fixtureSource = [
        "'use strict';",
        `const SENTINEL = ${JSON.stringify(SENTINEL)};`,
        `const STDERR_SENTINEL = ${JSON.stringify(STDERR_SENTINEL)};`,
        "const mode = process.argv[2];",
        "function splitWrite(stream, text, done) {",
        "  const bytes = Buffer.from(text, 'utf8');",
        "  const marker = Buffer.from('👩', 'utf8');",
        "  const at = bytes.indexOf(marker);",
        "  if (at < 0) throw new Error('split marker missing from fixture payload');",
        "  const cut = at + 1;",
        "  if ((bytes[cut] & 0xc0) !== 0x80) throw new Error('fixture cut is not inside a UTF-8 sequence');",
        "  stream.write(bytes.subarray(0, cut));",
        "  setTimeout(() => stream.write(bytes.subarray(cut), done), 30);",
        "}",
        "function emit(stdoutText, exitAfter) {",
        "  splitWrite(process.stderr, STDERR_SENTINEL, () => {",
        "    setTimeout(() => splitWrite(process.stdout, stdoutText, () => {",
        "      if (exitAfter) setTimeout(() => process.exit(0), 10);",
        "    }), 30);",
        "  });",
        "}",
        "const persistentPayload = () =>",
        "  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: SENTINEL }] } }) + '\\n' +",
        "  JSON.stringify({ type: 'result', result: '' }) + '\\n';",
        "const oneShotPayload = () =>",
        "  JSON.stringify({ type: 'message', role: 'assistant', content: SENTINEL }) + '\\n' +",
        "  JSON.stringify({ type: 'result', stats: {} }) + '\\n';",
        "if (mode === 'claude') {",
        "  let input = '';",
        "  process.stdin.setEncoding('utf8');",
        "  process.stdin.on('data', chunk => {",
        "    input += chunk;",
        "    if (input.includes('\\n')) emit(persistentPayload(), false);",
        "  });",
        "} else if (mode === 'gemini') emit(oneShotPayload(), true);",
        "else if (mode === 'agy') emit(SENTINEL + '\\n', true);",
        "else process.exit(2);",
        '',
    ].join('\n');
    fs.writeFileSync(fixture, fixtureSource, { mode: 0o700 });
    const shQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
    for (const name of ['claude', 'gemini', 'agy']) {
        const wrapper = path.join(binDir, name);
        fs.writeFileSync(wrapper,
            `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(fixture)} ${shQuote(name)} "$@"\n`,
            { mode: 0o700 });
    }

    process.env.BROKER_PORT = String(PORT);
    process.env.BROKER_TOKEN = TOKEN;
    process.env.BROKER_AGENT = '1';
    process.env.BROKER_ALLOW_UNMANAGED_AGENT_WORKSPACE = '1';
    process.env.BROKER_WORKSPACE = workspace;
    process.env.TMPDIR = temporary;
    process.env.PATH = binDir + path.delimiter + process.env.PATH;

    const { httpServer, agentBridge } = await import('../src/broker.mjs');
    await new Promise(resolve => setTimeout(resolve, 150));
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const messages = [];
    const listeners = new Set();
    ws.on('message', buffer => {
        messages.push(JSON.parse(buffer.toString()));
        for (const listener of listeners) listener();
    });
    const waitUntil = (predicate, description, timeoutMs = 4000) => new Promise((resolve, reject) => {
        const check = () => {
            if (!predicate()) return;
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
        };
        const timer = setTimeout(() => {
            listeners.delete(check);
            reject(new Error(`timed out waiting for ${description}; recent messages: ${JSON.stringify(messages.slice(-6))}`));
        }, timeoutMs);
        listeners.add(check);
        check();
    });

    try {
        ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
        await waitUntil(() => messages.some(message => message.kind === 'welcome'), 'welcome');

        for (const name of ['claude', 'gemini', 'agy']) {
            const start = messages.length;
            ws.send(JSON.stringify({ type: 'start', agent: name }));
            await waitUntil(() => messages.slice(start).some(message => message.kind === 'started'), `${name} start`);
            const turn = messages.length;
            ws.send(JSON.stringify({ type: 'input', text: 'emit the UTF-8 sentinel' }));
            await waitUntil(() => {
                const recent = messages.slice(turn);
                return recent.some(message => message.kind === 'assistant') &&
                    recent.some(message => message.kind === 'result') &&
                    recent.filter(message => message.kind === 'stderr').map(message => message.text || '').join('') === STDERR_SENTINEL;
            }, `${name} output`);
            const recent = messages.slice(turn);
            const assistant = recent.filter(message => message.kind === 'assistant').map(message => message.text || '').join('');
            const stderr = recent.filter(message => message.kind === 'stderr').map(message => message.text || '').join('');
            ok(assistant === SENTINEL && stderr === STDERR_SENTINEL &&
                !assistant.includes('\uFFFD') && !stderr.includes('\uFFFD'),
            `${name} preserves split UTF-8 through the /agent stdout and stderr path`);
        }
    } catch (error) {
        ok(false, error.stack || String(error));
    } finally {
        try { agentBridge.reset(); } catch (_) {}
        try { ws.terminate(); } catch (_) {}
        await new Promise(resolve => httpServer.close(resolve));
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
} else {
    console.log('  - fake-CLI /agent integration skipped on native Windows (use WSL)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
