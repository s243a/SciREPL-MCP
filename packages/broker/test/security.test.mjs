#!/usr/bin/env node
/**
 * Deterministic checks for private token and managed-config storage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupWorkspace } from '../src/workspace.mjs';

const PORT = 8097;
const root = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'scirepl-mcp-security-'));
const tokenFile = path.join(root, 'broker-token');
const workspace = path.join(root, 'workspace');
process.env.BROKER_PORT = String(PORT);
process.env.BROKER_TOKEN_FILE = tokenFile;
process.env.BROKER_WORKSPACE = workspace;

let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};
const privateMode = (file) => process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o600;

const { httpServer, TOKEN } = await import('../src/broker.mjs');
await new Promise(resolve => setTimeout(resolve, 200));

console.log('Token and managed configuration — security tests\n');

ok(fs.existsSync(tokenFile), 'persistent pairing-token file is created');
ok(/^[0-9a-f]{32}$/.test(TOKEN) && fs.readFileSync(tokenFile, 'utf8').trim() === TOKEN,
    'generated token has 128 bits of random hexadecimal data');
ok(privateMode(tokenFile), 'pairing-token file is private (0600 where supported)');
ok(!fs.existsSync(workspace), 'ordinary broker startup does not seed active agent configuration');

setupWorkspace({ workspace, port: PORT, token: TOKEN, callTimeoutMs: 120000 });

const geminiConfig = path.join(workspace, '.gemini', 'settings.json');
const codexConfig = path.join(workspace, '.codex', 'config.toml');
ok(fs.existsSync(geminiConfig) && fs.existsSync(codexConfig), 'explicit workspace setup creates managed agent configuration');
ok(privateMode(geminiConfig) && privateMode(codexConfig),
    'managed configuration containing connection details is private (0600 where supported)');

const invalid = spawnSync(process.execPath, ['src/broker.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, BROKER_PORT: 'not-a-number', BROKER_TOKEN: 'invalid-config-test' },
    encoding: 'utf8',
});
ok(invalid.status !== 0 && /BROKER_PORT must be an integer/.test(invalid.stderr || ''),
    'invalid numeric security settings fail startup clearly');

console.log(`\n${passed} passed, ${failed} failed`);
await new Promise(resolve => httpServer.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
