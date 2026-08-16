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
process.env.BROKER_MANAGE_WORKSPACE = '1';

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
const antigravityConfig = path.join(workspace, '.agents', 'mcp_config.json');
ok(fs.existsSync(geminiConfig) && fs.existsSync(codexConfig) && fs.existsSync(antigravityConfig),
    'explicit workspace setup creates managed agent configuration');
ok(privateMode(geminiConfig) && privateMode(codexConfig) && privateMode(antigravityConfig),
    'managed configuration containing connection details is private (0600 where supported)');
const antigravity = JSON.parse(fs.readFileSync(antigravityConfig, 'utf8'));
const expectedAntigravity = { mcpServers: { scirepl: {
    serverUrl: `http://127.0.0.1:${PORT}/mcp`,
    headers: { Authorization: `Bearer ${TOKEN}` },
} } };
ok(JSON.stringify(antigravity) === JSON.stringify(expectedAntigravity),
    'Antigravity configuration uses serverUrl and the current broker token');
const workspaceManifest = fs.readFileSync(path.join(workspace, '.scirepl-mcp', 'manifest.json'), 'utf8');
ok(workspaceManifest.includes('.agents/mcp_config.json') && !workspaceManifest.includes(TOKEN),
    'workspace manifest records the managed Antigravity file without exposing its token');

fs.unlinkSync(antigravityConfig);
const missingDoctorResponse = await fetch(`http://127.0.0.1:${PORT}/doctor`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
});
const missingDoctorText = await missingDoctorResponse.text();
const missingDoctor = JSON.parse(missingDoctorText);
ok(missingDoctor.workspaceReady === false && missingDoctor.missing.includes('.agents/mcp_config.json') &&
    missingDoctor.fixable.includes('.agents/mcp_config.json') && !missingDoctorText.includes(TOKEN),
    'doctor reports a missing Antigravity configuration as fixable without exposing credentials');
const createdDoctorResponse = await fetch(`http://127.0.0.1:${PORT}/doctor`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
});
const createdDoctorText = await createdDoctorResponse.text();
const createdDoctor = JSON.parse(createdDoctorText);
ok(createdDoctor.workspaceReady === true && createdDoctor.applied.created.includes('.agents/mcp_config.json') &&
    privateMode(antigravityConfig) && !createdDoctorText.includes(TOKEN),
    'explicit doctor repair recreates the missing Antigravity configuration privately');

if (process.platform !== 'win32') {
    fs.chmodSync(antigravityConfig, 0o644);
    const looseModeDoctor = await (await fetch(`http://127.0.0.1:${PORT}/doctor`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
    })).json();
    ok(looseModeDoctor.workspaceReady === false && looseModeDoctor.outdated.includes('.agents/mcp_config.json'),
        'doctor treats loose permissions on a token-bearing managed file as stale');
    const modeRepairText = await (await fetch(`http://127.0.0.1:${PORT}/doctor`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
    })).text();
    const modeRepair = JSON.parse(modeRepairText);
    const modeBackups = modeRepair.applied.backups.filter(file => path.basename(file).startsWith('mcp_config.json.bak-'));
    ok(modeRepair.workspaceReady === true && modeRepair.applied.updated.includes('.agents/mcp_config.json') &&
        privateMode(antigravityConfig) && modeBackups.length === 1 && privateMode(modeBackups[0]) &&
        !modeRepairText.includes(TOKEN),
        'doctor clamps loose managed-file and backup permissions without returning the token');
}

const editedConfig = JSON.parse(fs.readFileSync(antigravityConfig, 'utf8'));
editedConfig.userEdit = true;
fs.writeFileSync(antigravityConfig, JSON.stringify(editedConfig, null, 2) + '\n');
const outdatedDoctor = await (await fetch(`http://127.0.0.1:${PORT}/doctor`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
})).json();
ok(outdatedDoctor.workspaceReady === false && outdatedDoctor.outdated.includes('.agents/mcp_config.json'),
    'doctor detects an edited Antigravity configuration without changing it on GET');
const repairedDoctor = await (await fetch(`http://127.0.0.1:${PORT}/doctor`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
})).json();
const antigravityBackups = repairedDoctor.applied.backups.filter(file => path.basename(file).startsWith('mcp_config.json.bak-'));
ok(repairedDoctor.workspaceReady === true && repairedDoctor.applied.updated.includes('.agents/mcp_config.json') &&
    antigravityBackups.length === 1 && privateMode(antigravityBackups[0]) &&
    !JSON.parse(fs.readFileSync(antigravityConfig, 'utf8')).userEdit,
    'explicit doctor repair privately backs up and restores an edited Antigravity configuration');

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
