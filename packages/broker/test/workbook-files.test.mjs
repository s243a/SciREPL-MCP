#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    APP_WORKBOOK_MAX_BYTES,
    REQUIRED_APP_WS_PAYLOAD_BYTES,
    createWorkbookFileTransfer,
} from '../src/workbook-files.mjs';

const FIXED_NOW = '2026-08-14T18:27:31.456Z';
const REAL_TMP = fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp');

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function appTool(name) {
    return {
        type: 'function',
        function: {
            name,
            description: `${name} test double`,
            parameters: { type: 'object', properties: {} },
        },
    };
}

function exportEnvelope(format, content, overrides = {}) {
    const bytes = Buffer.from(content, 'utf8');
    return JSON.stringify({
        format,
        filename: `untrusted-${format}.${format}`,
        mimeType: 'application/json',
        encoding: 'utf-8',
        content,
        size: bytes.length,
        sha256: sha256(bytes),
        ...overrides,
    });
}

function importReceipt(format, mode, bytes, overrides = {}) {
    return JSON.stringify({
        ok: true,
        format,
        mode,
        notebookId: 'private-notebook-id',
        name: 'Private notebook name',
        cells: 9,
        size: bytes.length,
        sha256: sha256(bytes),
        ...overrides,
    });
}

function deepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return true;
    seen.add(value);
    return Object.isFrozen(value)
        && Object.values(value).every(child => deepFrozen(child, seen));
}

function writeJson(filename, value, mode = 0o600) {
    fs.writeFileSync(filename, JSON.stringify(value, null, 2), { mode });
    if (process.platform !== 'win32') fs.chmodSync(filename, mode);
}

function runGit(cwd, ...args) {
    const result = spawnSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
    return String(result.stdout || '').trim();
}

function initializeGitRoot(root, gitignore = '') {
    runGit(root, 'init', '--quiet');
    fs.writeFileSync(path.join(root, '.gitignore'), gitignore, 'utf8');
}

function fixture(t, options = {}) {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-files-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    const root = path.join(base, 'artifacts');
    const workspace = path.join(base, 'agent-workspace');
    const configPath = path.join(base, 'workbook-io.json');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);

    const rootConfig = {
        name: 'artifacts',
        path: root,
        read: options.read ?? true,
        write: options.write ?? true,
        allowOverwrite: options.allowOverwrite ?? false,
    };
    if (options.denyGitIgnoredWrites !== undefined) {
        rootConfig.denyGitIgnoredWrites = options.denyGitIgnoredWrites;
    }
    if (options.prepareRoot) options.prepareRoot(root);
    const config = {
        schemaVersion: 1,
        maxContentBytes: options.maxContentBytes ?? APP_WORKBOOK_MAX_BYTES,
        roots: options.roots ?? [rootConfig],
    };
    writeJson(configPath, config);

    const logs = [];
    const log = (...entries) => logs.push(entries.length === 1 ? entries[0] : entries);
    const manager = createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: options.maxAppWsPayloadBytes
            ?? REQUIRED_APP_WS_PAYLOAD_BYTES,
        log,
        now: () => new Date(FIXED_NOW),
        hooks: options.hooks,
    });
    return { base, root, workspace, configPath, config, manager, logs };
}

function gitFixture(t, options = {}) {
    const gitignore = options.gitignore ?? [
        'ignored/',
        '*.blocked.srwb',
        '!allowed.blocked.srwb',
        '',
    ].join('\n');
    return fixture(t, {
        ...options,
        denyGitIgnoredWrites: options.denyGitIgnoredWrites ?? true,
        prepareRoot(root) {
            initializeGitRoot(root, gitignore);
            if (options.prepareRoot) options.prepareRoot(root);
        },
    });
}

function exportArgs(relativePath = 'notebook.srwb', overrides = {}) {
    return {
        format: 'srwb',
        root: 'artifacts',
        path: relativePath,
        ...overrides,
    };
}

function importArgs(relativePath = 'notebook.srwb', overrides = {}) {
    return {
        format: 'srwb',
        root: 'artifacts',
        path: relativePath,
        ...overrides,
    };
}

async function exportCall(manager, args, callApp, toolCallId = 'rpc-export-7') {
    return manager.handleTool('export_workbook_to_file', args, { callApp, toolCallId });
}

async function importCall(manager, args, callApp, toolCallId = 91) {
    return manager.handleTool('import_workbook_from_file', args, { callApp, toolCallId });
}

async function rejectsWithoutLeak(action, forbidden = []) {
    let error;
    try {
        await action();
    } catch (caught) {
        error = caught;
    }
    assert(error instanceof Error, 'operation should reject with an Error');
    for (const secret of forbidden) {
        if (secret) assert.doesNotMatch(String(error.message), new RegExp(escapeRegExp(secret)));
    }
    return error;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('constants and disabled configuration fail closed', () => {
    assert.equal(APP_WORKBOOK_MAX_BYTES, 8 * 1024 * 1024);
    assert.equal(REQUIRED_APP_WS_PAYLOAD_BYTES, 42_008_576);
    assert(REQUIRED_APP_WS_PAYLOAD_BYTES > APP_WORKBOOK_MAX_BYTES * 4,
        'wire budget must cover worst-case nested JSON escaping plus overhead');
    assert.equal(createWorkbookFileTransfer({
        configPath: undefined,
        agentWorkspace: process.cwd(),
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), null);
    assert.equal(createWorkbookFileTransfer({
        configPath: '',
        agentWorkspace: process.cwd(),
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), null);
});

test('valid configuration is loaded once and retained as a deeply immutable snapshot', async (t) => {
    const h = fixture(t);
    assert.equal(h.manager.enabled, true);
    assert(deepFrozen(h.manager.config), 'configuration snapshot must be deeply frozen');
    assert.throws(() => { h.manager.config.roots[0].read = false; }, TypeError);

    writeJson(h.configPath, {
        schemaVersion: 1,
        maxContentBytes: 1,
        roots: [],
    });
    const content = '{"snapshot":true}';
    const receipt = await exportCall(h.manager, exportArgs(), async () =>
        exportEnvelope('srwb', content));
    assert.equal(receipt.size, Buffer.byteLength(content));
    assert.equal(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8'), content);
});

test('synthetic definitions require their corresponding base tools and reject name collisions', (t) => {
    const { manager } = fixture(t);
    assert.equal(manager.isSyntheticTool('export_workbook_to_file'), true);
    assert.equal(manager.isSyntheticTool('import_workbook_from_file'), true);
    assert.equal(manager.isSyntheticTool('export_workbook'), false);

    assert.deepEqual(manager.getToolDefinitions([]), []);
    assert.deepEqual(
        manager.getToolDefinitions([appTool('export_workbook')]).map(tool => tool.name),
        ['export_workbook_to_file']);
    assert.deepEqual(
        manager.getToolDefinitions([appTool('import_workbook')]).map(tool => tool.name),
        ['import_workbook_from_file']);
    assert.deepEqual(
        manager.getToolDefinitions([appTool('export_workbook'), appTool('import_workbook')])
            .map(tool => tool.name).sort(),
        ['export_workbook_to_file', 'import_workbook_from_file']);

    const definitions = manager.getToolDefinitions([
        appTool('export_workbook'), appTool('import_workbook'),
    ]);
    const exportDefinition = definitions.find(tool => tool.name === 'export_workbook_to_file');
    const importDefinition = definitions.find(tool => tool.name === 'import_workbook_from_file');
    assert.equal(exportDefinition.inputSchema.additionalProperties, false);
    assert.deepEqual(exportDefinition.inputSchema.required, ['format', 'root', 'path']);
    assert.deepEqual(exportDefinition.inputSchema.properties.format.enum, ['srwb', 'ipynb']);
    assert.equal(importDefinition.inputSchema.additionalProperties, false);
    assert.deepEqual(importDefinition.inputSchema.required, ['format', 'root', 'path']);
    assert.deepEqual(importDefinition.inputSchema.properties.mode.enum, ['replace', 'create']);
    assert.match(importDefinition.inputSchema.properties.sha256.pattern, /64/);

    assert.doesNotThrow(() => manager.assertNoCollisions([
        appTool('export_workbook'), appTool('import_workbook'),
    ]));
    assert.throws(() => manager.assertNoCollisions([appTool('export_workbook_to_file')]),
        /collid|synthetic|reserved/i);
    assert.throws(() => manager.assertNoCollisions([appTool('import_workbook_from_file')]),
        /collid|synthetic|reserved/i);
});

test('explicit invalid configuration fails startup instead of disabling the feature', (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-config-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);
    const configPath = path.join(base, 'config.json');
    const goodRoot = { name: 'artifacts', path: root, read: true, write: true };
    const cases = [
        ['unsupported schema', { schemaVersion: 2, maxContentBytes: 10, roots: [goodRoot] }],
        ['zero cap', { schemaVersion: 1, maxContentBytes: 0, roots: [goodRoot] }],
        ['fractional cap', { schemaVersion: 1, maxContentBytes: 1.5, roots: [goodRoot] }],
        ['cap above app limit', { schemaVersion: 1, maxContentBytes: APP_WORKBOOK_MAX_BYTES + 1, roots: [goodRoot] }],
        ['roots is not an array', { schemaVersion: 1, maxContentBytes: 10, roots: {} }],
        ['roots is empty', { schemaVersion: 1, maxContentBytes: 10, roots: [] }],
        ['invalid alias', { schemaVersion: 1, maxContentBytes: 10, roots: [{ ...goodRoot, name: 'Bad Alias' }] }],
        ['duplicate alias', { schemaVersion: 1, maxContentBytes: 10, roots: [goodRoot, { ...goodRoot }] }],
        ['relative root', { schemaVersion: 1, maxContentBytes: 10, roots: [{ ...goodRoot, path: 'relative' }] }],
        ['missing root', { schemaVersion: 1, maxContentBytes: 10, roots: [{ ...goodRoot, path: path.join(base, 'missing') }] }],
        ['non-boolean read', { schemaVersion: 1, maxContentBytes: 10, roots: [{ ...goodRoot, read: 'yes' }] }],
        ['non-boolean overwrite', { schemaVersion: 1, maxContentBytes: 10, roots: [{ ...goodRoot, allowOverwrite: 1 }] }],
        ['non-boolean Git-ignore policy', {
            schemaVersion: 1,
            maxContentBytes: 10,
            roots: [{ ...goodRoot, denyGitIgnoredWrites: 'yes' }],
        }],
    ];
    for (const [label, config] of cases) {
        writeJson(configPath, config);
        assert.throws(() => createWorkbookFileTransfer({
            configPath,
            agentWorkspace: workspace,
            maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
        }), undefined, label);
    }

    fs.writeFileSync(configPath, '{bad json', { mode: 0o600 });
    assert.throws(() => createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /config|JSON|parse/i);
    assert.throws(() => createWorkbookFileTransfer({
        configPath: 'relative-config.json',
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /absolute|config/i);
    assert.throws(() => createWorkbookFileTransfer({
        configPath: root,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /regular|file|config/i);
});

test('configuration rejects insufficient app wire budget', (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-wire-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);
    const configPath = path.join(base, 'config.json');
    writeJson(configPath, {
        schemaVersion: 1,
        maxContentBytes: 1,
        roots: [{ name: 'artifacts', path: root, read: true, write: true }],
    });
    assert.throws(() => createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES - 1,
    }), /payload|wire|WebSocket|budget/i);
});

test('configuration file cannot be in a root, in the agent workspace, or a link', (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-config-location-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);
    const config = {
        schemaVersion: 1,
        maxContentBytes: 1024,
        roots: [{ name: 'artifacts', path: root, read: true, write: true }],
    };

    const inRoot = path.join(root, 'config.json');
    writeJson(inRoot, config);
    assert.throws(() => createWorkbookFileTransfer({
        configPath: inRoot,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /config|root|inside|contain/i);

    const inWorkspace = path.join(workspace, 'config.json');
    writeJson(inWorkspace, config);
    assert.throws(() => createWorkbookFileTransfer({
        configPath: inWorkspace,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /config|workspace|inside|contain/i);

    const target = path.join(base, 'actual-config.json');
    const linked = path.join(base, 'linked-config.json');
    writeJson(target, config);
    try {
        fs.symlinkSync(target, linked, 'file');
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('file-symlink assertion skipped: Windows symlink privilege unavailable');
            return;
        }
        throw error;
    }
    assert.throws(() => createWorkbookFileTransfer({
        configPath: linked,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /config|link|symlink|reparse/i);
});

test('root paths must be real directories rather than links or files', (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-root-kind-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const actual = path.join(base, 'actual');
    const linked = path.join(base, 'linked');
    const workspace = path.join(base, 'workspace');
    const configPath = path.join(base, 'config.json');
    fs.mkdirSync(actual);
    fs.mkdirSync(workspace);

    writeJson(configPath, {
        schemaVersion: 1,
        maxContentBytes: 1024,
        roots: [{ name: 'artifacts', path: configPath, read: true, write: true }],
    });
    assert.throws(() => createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /root|directory/i);

    try {
        fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('root-link assertion skipped: Windows link privilege unavailable');
            return;
        }
        throw error;
    }
    writeJson(configPath, {
        schemaVersion: 1,
        maxContentBytes: 1024,
        roots: [{ name: 'artifacts', path: linked, read: true, write: true }],
    });
    assert.throws(() => createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
    }), /root|link|junction|reparse/i);
});

test('Git-ignore write policy configuration is boolean, write-only, and requires a Git worktree', (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-git-policy-config-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const gitRoot = path.join(base, 'git-root');
    const nonGitRoot = path.join(base, 'plain-root');
    const workspace = path.join(base, 'workspace');
    const configPath = path.join(base, 'config.json');
    fs.mkdirSync(gitRoot);
    fs.mkdirSync(nonGitRoot);
    fs.mkdirSync(workspace);
    initializeGitRoot(gitRoot);

    const create = rootConfig => {
        writeJson(configPath, {
            schemaVersion: 1,
            maxContentBytes: 1024,
            roots: [rootConfig],
        });
        return createWorkbookFileTransfer({
            configPath,
            agentWorkspace: workspace,
            maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
        });
    };

    assert.throws(() => create({
        name: 'artifacts',
        path: gitRoot,
        read: true,
        write: false,
        denyGitIgnoredWrites: true,
    }), /write|export|policy/i, 'a write policy must not be accepted on a non-writable root');

    assert.throws(() => create({
        name: 'artifacts',
        path: nonGitRoot,
        read: true,
        write: true,
        denyGitIgnoredWrites: true,
    }), /Git|worktree|ignore|policy/i);

    const manager = create({
        name: 'artifacts',
        path: gitRoot,
        read: true,
        write: true,
        denyGitIgnoredWrites: true,
    });
    assert.equal(manager.config.roots[0].denyGitIgnoredWrites, true);
});

test('portable path grammar rejects traversal, host-specific paths, ADS, devices, controls, and byte overflows', async (t) => {
    const { manager } = fixture(t);
    const invalidPaths = [
        '../escape.srwb',
        'dir/../escape.srwb',
        './notebook.srwb',
        'dir/./notebook.srwb',
        'dir//notebook.srwb',
        'dir/',
        '/absolute/notebook.srwb',
        '//server/share/notebook.srwb',
        'C:/notebook.srwb',
        'C:\\notebook.srwb',
        '\\\\server\\share\\notebook.srwb',
        '\\\\?\\C:\\notebook.srwb',
        'dir\\notebook.srwb',
        'stream:secret.srwb',
        'dir/file.srwb:stream',
        '~',
        '~/notebook.srwb',
        'CON',
        'con.srwb',
        'NUL.txt',
        'aux',
        'PRN.ipynb',
        'COM1.srwb',
        'com9.anything',
        'LPT1',
        'lpt9.srwb',
        'CONIN$',
        'conout$.srwb',
        'bad\0name.srwb',
        'bad\u0001name.srwb',
        'bad\u001fname.srwb',
        'bad\ud800name.srwb',
        'bad\u2028name.srwb',
        'bad\u202ename.srwb',
        'bad\u2066name.srwb',
        `${'é'.repeat(128)}.srwb`,
        `${'a/'.repeat(510)}éééé.srwb`,
    ];
    if (process.platform === 'win32') invalidPaths.push('trailing./file.srwb', 'trailing /file.srwb');

    for (const relativePath of invalidPaths) {
        let appCalls = 0;
        await assert.rejects(exportCall(manager, exportArgs(relativePath), async () => {
            appCalls++;
            return exportEnvelope('srwb', '{}');
        }), undefined, `path should be rejected: ${JSON.stringify(relativePath)}`);
        assert.equal(appCalls, 0, `invalid path reached app: ${JSON.stringify(relativePath)}`);
    }
});

test('tool argument objects are validated independently of MCP schema validation', async (t) => {
    const { manager } = fixture(t);
    const invalidExportArgs = [
        {},
        exportArgs('file.srwb', { format: 'json' }),
        exportArgs('file.srwb', { root: 'Bad Alias' }),
        exportArgs('file.srwb', { overwrite: 'true' }),
        exportArgs('file.srwb', { surprise: true }),
        null,
    ];
    for (const args of invalidExportArgs) {
        await assert.rejects(exportCall(manager, args, async () => {
            assert.fail('invalid export args reached app');
        }));
    }

    const invalidImportArgs = [
        {},
        importArgs('file.srwb', { format: 'json' }),
        importArgs('file.srwb', { mode: 'merge' }),
        importArgs('file.srwb', { sha256: 'nope' }),
        importArgs('file.srwb', { surprise: true }),
        null,
    ];
    for (const args of invalidImportArgs) {
        await assert.rejects(importCall(manager, args, async () => {
            assert.fail('invalid import args reached app');
        }));
    }
});

test('valid Unicode path writes exact canonical UTF-8 bytes and returns a content-free receipt', async (t) => {
    const h = fixture(t);
    fs.mkdirSync(path.join(h.root, 'español'));
    const content = '{\n  "title": "π, café, 😀",\n  "slash": "\\\\"\n}\n';
    const bytes = Buffer.from(content, 'utf8');
    const appCalls = [];
    const receipt = await exportCall(h.manager,
        exportArgs('español/cálculo.srwb'),
        async (...args) => {
            appCalls.push(args);
            return exportEnvelope('srwb', content, {
                filename: '/host/path/from-app/DO-NOT-USE.srwb',
            });
        });

    assert.deepEqual(appCalls[0][0], 'export_workbook');
    assert.deepEqual(appCalls[0][1], {
        format: 'srwb',
        brokerRoot: 'artifacts',
        brokerPath: 'español/cálculo.srwb',
    });
    assert.equal(appCalls[0][2].maxWireBytes, REQUIRED_APP_WS_PAYLOAD_BYTES);
    assert.deepEqual(fs.readFileSync(path.join(h.root, 'español', 'cálculo.srwb')), bytes);
    assert.deepEqual(receipt, {
        schemaVersion: 1,
        type: 'workbook-file-receipt',
        direction: 'export',
        status: 'written',
        root: 'artifacts',
        path: 'español/cálculo.srwb',
        format: 'srwb',
        size: bytes.length,
        sha256: sha256(bytes),
        overwritten: false,
        toolCallId: 'rpc-export-7',
        timestamp: FIXED_NOW,
    });
    assert.equal(Object.isFrozen(receipt), true);
    const rendered = JSON.stringify(receipt);
    assert.doesNotMatch(rendered, /content|DO-NOT-USE|privateNotebook|host\/path/);
    assert.doesNotMatch(rendered, new RegExp(escapeRegExp(h.root)));
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(h.root, 'español', 'cálculo.srwb')).mode & 0o777, 0o600);
    }
});

test('strict export envelope validation rejects wrong shape, format, encoding, MIME, size, and digest', async (t) => {
    const h = fixture(t, { maxContentBytes: 64 });
    const content = '{"ok":true}';
    const valid = JSON.parse(exportEnvelope('srwb', content));
    const cases = [
        ['not JSON', 'not-json'],
        ['array', JSON.stringify([valid])],
        ['trailing object', `${JSON.stringify(valid)} {}`],
        ['wrong format', JSON.stringify({ ...valid, format: 'ipynb' })],
        ['wrong encoding', JSON.stringify({ ...valid, encoding: 'utf-16' })],
        ['wrong MIME', JSON.stringify({ ...valid, mimeType: 'text/plain' })],
        ['missing content', JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'content')))],
        ['non-string content', JSON.stringify({ ...valid, content: {} })],
        ['fractional size', JSON.stringify({ ...valid, size: 1.5 })],
        ['wrong size', JSON.stringify({ ...valid, size: valid.size + 1 })],
        ['uppercase digest', JSON.stringify({ ...valid, sha256: valid.sha256.toUpperCase() })],
        ['wrong digest', JSON.stringify({ ...valid, sha256: '0'.repeat(64) })],
        ['unknown field', JSON.stringify({ ...valid, notebookMetadata: 'unexpected' })],
        ['over configured cap', exportEnvelope('srwb', 'x'.repeat(65))],
    ];
    for (const [label, output] of cases) {
        const before = fs.readdirSync(h.root).sort();
        await assert.rejects(exportCall(h.manager, exportArgs(), async () => output), undefined, label);
        assert.deepEqual(fs.readdirSync(h.root).sort(), before,
            `${label} left a destination or temporary file`);
    }
});

test('configured content cap accepts exact raw-byte boundary for export and import', async (t) => {
    const h = fixture(t, { maxContentBytes: 32 });
    const content = 'é'.repeat(16);
    const bytes = Buffer.from(content, 'utf8');
    assert.equal(bytes.length, 32);

    const exportReceipt = await exportCall(
        h.manager,
        exportArgs('boundary.srwb'),
        async () => exportEnvelope('srwb', content));
    assert.equal(exportReceipt.size, 32);
    assert.deepEqual(fs.readFileSync(path.join(h.root, 'boundary.srwb')), bytes);

    const importReceiptResult = await importCall(
        h.manager,
        importArgs('boundary.srwb'),
        async (_name, args) => {
            assert.equal(args.content, content);
            return importReceipt('srwb', 'replace', bytes);
        });
    assert.equal(importReceiptResult.size, 32);
    assert.equal(importReceiptResult.sha256, sha256(bytes));
});

test('export permission denial is passed through per call and leaves no file or temporary artifact', async (t) => {
    const h = fixture(t);
    let calls = 0;
    const denied = new Error('Tool "export_workbook" is denied because Workbook import/export is Off');
    const error = await rejectsWithoutLeak(() => exportCall(h.manager, exportArgs(), async () => {
        calls++;
        throw denied;
    }), [h.root]);
    assert.match(error.message, /denied|permission/i);
    assert.equal(error.code, 'APP_CALL_FAILED');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(h.root), []);

    const content = '{"now":"allowed"}';
    await exportCall(h.manager, exportArgs(), async () => {
        calls++;
        return exportEnvelope('srwb', content);
    });
    assert.equal(calls, 2, 'the previous denial must not be cached');
});

test('per-root Git-ignore policy blocks only configured export destinations', async (t) => {
    await t.test('default-off permits a path even when Git considers it ignored', async (t) => {
        const h = gitFixture(t, {
            denyGitIgnoredWrites: false,
            prepareRoot(root) {
                fs.mkdirSync(path.join(root, 'ignored'));
            },
        });
        let appCalls = 0;
        const content = '{"defaultOff":true}';
        const receipt = await exportCall(
            h.manager,
            exportArgs('ignored/notebook.srwb'),
            async (name, args) => {
                appCalls++;
                assert.equal(name, 'export_workbook');
                assert.deepEqual(args, {
                    format: 'srwb',
                    brokerRoot: 'artifacts',
                    brokerPath: 'ignored/notebook.srwb',
                });
                return exportEnvelope('srwb', content);
            });
        assert.equal(appCalls, 1);
        assert.equal(receipt.status, 'written');
        assert.equal(
            fs.readFileSync(path.join(h.root, 'ignored', 'notebook.srwb'), 'utf8'),
            content);
        assert.equal(h.manager.config.roots[0].denyGitIgnoredWrites, false);
    });

    await t.test('enabled policy denies ignored leaves, ignored parents, and Git metadata before app', async (t) => {
        const h = gitFixture(t, {
            prepareRoot(root) {
                fs.mkdirSync(path.join(root, 'ignored'));
            },
        });
        let appCalls = 0;
        const callApp = async () => {
            appCalls++;
            return exportEnvelope('srwb', '{}');
        };
        for (const relativePath of [
            'notebook.blocked.srwb',
            'ignored/notebook.srwb',
            '.git/workbook.srwb',
        ]) {
            await assert.rejects(
                exportCall(h.manager, exportArgs(relativePath), callApp),
                /Git|ignore|metadata|policy|block/i,
                relativePath);
        }
        assert.equal(appCalls, 0);
        assert.equal(fs.existsSync(path.join(h.root, 'notebook.blocked.srwb')), false);
        assert.equal(fs.existsSync(path.join(h.root, 'ignored', 'notebook.srwb')), false);
    });

    await t.test('nonignored and explicitly negated paths remain writable', async (t) => {
        const h = gitFixture(t);
        const written = new Map([
            ['ordinary.srwb', '{"ordinary":true}'],
            ['allowed.blocked.srwb', '{"negated":true}'],
        ]);
        const appPaths = [];
        for (const [relativePath, content] of written) {
            const receipt = await exportCall(
                h.manager,
                exportArgs(relativePath),
                async (name, args) => {
                    assert.equal(name, 'export_workbook');
                    appPaths.push(args.brokerPath);
                    return exportEnvelope('srwb', content);
                });
            assert.equal(receipt.path, relativePath);
            assert.equal(fs.readFileSync(path.join(h.root, relativePath), 'utf8'), content);
        }
        assert.deepEqual(appPaths, [...written.keys()]);
    });

    await t.test('a tracked path matching an ignore pattern may be overwritten with both opt-ins', async (t) => {
        const h = gitFixture(t, {
            allowOverwrite: true,
            prepareRoot(root) {
                fs.writeFileSync(path.join(root, 'tracked.blocked.srwb'), 'old', 'utf8');
                runGit(root, 'add', '-f', '--', 'tracked.blocked.srwb');
            },
        });
        const content = '{"tracked":"updated"}';
        const receipt = await exportCall(
            h.manager,
            exportArgs('tracked.blocked.srwb', { overwrite: true }),
            async () => exportEnvelope('srwb', content));
        assert.equal(receipt.overwritten, true);
        assert.equal(fs.readFileSync(path.join(h.root, 'tracked.blocked.srwb'), 'utf8'), content);
    });

    await t.test('a nested Git worktree is rejected instead of inheriting outer ignore rules', async (t) => {
        const h = gitFixture(t, {
            prepareRoot(root) {
                const nested = path.join(root, 'nested');
                fs.mkdirSync(nested);
                initializeGitRoot(nested, 'private.srwb\n');
            },
        });
        let appCalls = 0;
        await assert.rejects(
            exportCall(h.manager, exportArgs('nested/public.srwb'), async () => {
                appCalls++;
                return exportEnvelope('srwb', '{}');
            }),
            /nested|Git|worktree|policy/i);
        assert.equal(appCalls, 0);
        assert.equal(fs.existsSync(path.join(h.root, 'nested', 'public.srwb')), false);
    });

    await t.test('repository fsmonitor configuration cannot execute during policy checks', async (t) => {
        let sentinel;
        const h = gitFixture(t, {
            prepareRoot(root) {
                sentinel = path.join(path.dirname(root), 'fsmonitor-executed');
                const portableSentinel = sentinel.split(path.sep).join('/');
                runGit(root, 'config', 'core.fsmonitor', `echo invoked > "${portableSentinel}"`);
            },
        });

        // Prove the fixture is active: an unprotected Git query executes the
        // configured monitor. The broker's command-scope empty override must not.
        spawnSync('git', ['-C', h.root, 'check-ignore', '--quiet', '--', 'probe.srwb'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
        });
        assert.equal(fs.existsSync(sentinel), true, 'test fsmonitor command was not exercised');
        fs.unlinkSync(sentinel);

        const content = '{"fsmonitor":"disabled"}';
        await exportCall(
            h.manager,
            exportArgs('safe.srwb'),
            async () => exportEnvelope('srwb', content));
        assert.equal(fs.existsSync(sentinel), false);
        assert.equal(fs.readFileSync(path.join(h.root, 'safe.srwb'), 'utf8'), content);
    });
});

test('Git-ignore policy is rechecked after app confirmation and immediately before publication', async (t) => {
    await t.test('an ignore rule added during the app call prevents temporary-file creation', async (t) => {
        const h = gitFixture(t);
        let appCalls = 0;
        await assert.rejects(
            exportCall(h.manager, exportArgs('late-app.srwb'), async (name, args) => {
                appCalls++;
                assert.equal(name, 'export_workbook');
                assert.equal(args.brokerRoot, 'artifacts');
                assert.equal(args.brokerPath, 'late-app.srwb');
                fs.writeFileSync(path.join(h.root, '.gitignore'), 'late-app.srwb\n', 'utf8');
                return exportEnvelope('srwb', '{"late":"app"}');
            }),
            /Git|ignore|policy|block/i);
        assert.equal(appCalls, 1);
        assert.equal(fs.existsSync(path.join(h.root, 'late-app.srwb')), false);
        assert.equal(
            fs.readdirSync(h.root).some(name => name.startsWith('scirepl-workbook-')),
            false);
    });

    await t.test('an ignore rule added at the publication boundary removes the verified temp', async (t) => {
        let hookCalls = 0;
        const h = gitFixture(t, {
            hooks: {
                beforeExportPublish({ tempPath }) {
                    hookCalls++;
                    fs.writeFileSync(
                        path.join(path.dirname(tempPath), '.gitignore'),
                        'late-publish.srwb\n',
                        'utf8');
                },
            },
        });
        await assert.rejects(
            exportCall(
                h.manager,
                exportArgs('late-publish.srwb'),
                async () => exportEnvelope('srwb', '{"late":"publish"}')),
            /Git|ignore|policy|block/i);
        assert.equal(hookCalls, 1);
        assert.equal(fs.existsSync(path.join(h.root, 'late-publish.srwb')), false);
        assert.equal(
            fs.readdirSync(h.root).some(name => name.startsWith('scirepl-workbook-')),
            false);
    });
});

test('Git-ignore write policy does not restrict imports from an ignored file', async (t) => {
    const content = '{"ignoredImport":true}';
    const bytes = Buffer.from(content, 'utf8');
    const h = gitFixture(t, {
        prepareRoot(root) {
            fs.writeFileSync(path.join(root, 'incoming.blocked.srwb'), bytes);
        },
    });
    let appCalls = 0;
    const receipt = await importCall(
        h.manager,
        importArgs('incoming.blocked.srwb'),
        async (name, args) => {
            appCalls++;
            assert.equal(name, 'import_workbook');
            assert.deepEqual(args, {
                format: 'srwb',
                content,
                mode: 'replace',
                sha256: sha256(bytes),
                brokerRoot: 'artifacts',
                brokerPath: 'incoming.blocked.srwb',
            });
            return importReceipt('srwb', 'replace', bytes);
        });
    assert.equal(appCalls, 1);
    assert.equal(receipt.status, 'imported');
    assert.equal(receipt.sha256, sha256(bytes));
});

test('export requires an existing real parent and rejects link escapes and non-regular targets', async (t) => {
    const h = fixture(t);
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.srwb'), 'outside');
    let appCalls = 0;
    const callApp = async () => {
        appCalls++;
        return exportEnvelope('srwb', '{}');
    };

    await assert.rejects(exportCall(h.manager, exportArgs('missing/file.srwb'), callApp));
    assert.equal(appCalls, 0);

    fs.writeFileSync(path.join(h.root, 'parent-file'), 'not a directory');
    await assert.rejects(exportCall(h.manager, exportArgs('parent-file/child.srwb'), callApp));
    assert.equal(appCalls, 0, 'a regular allowlisted file cannot be traversed as a parent');

    fs.mkdirSync(path.join(h.root, 'directory.srwb'));
    await assert.rejects(exportCall(h.manager, exportArgs('directory.srwb'), callApp));
    assert.equal(appCalls, 0);

    const leafLink = path.join(h.root, 'linked-leaf.srwb');
    let leafLinkCreated = false;
    try {
        fs.symlinkSync(path.join(outside, 'secret.srwb'), leafLink, 'file');
        leafLinkCreated = true;
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('export leaf-symlink assertion skipped: Windows symlink privilege unavailable');
        } else {
            throw error;
        }
    }
    if (leafLinkCreated) {
        await assert.rejects(exportCall(
            h.manager,
            exportArgs('linked-leaf.srwb', { overwrite: true }),
            callApp));
        assert.equal(appCalls, 0);
        assert.equal(fs.readFileSync(path.join(outside, 'secret.srwb'), 'utf8'), 'outside');
    }

    const link = path.join(h.root, 'linked-parent');
    try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('parent junction assertion skipped: Windows privilege unavailable');
            return;
        }
        throw error;
    }
    const error = await rejectsWithoutLeak(
        () => exportCall(h.manager, exportArgs('linked-parent/escaped.srwb'), callApp),
        [outside]);
    assert.match(error.message, /link|junction|reparse|redirect|parent|path/i);
    assert.equal(appCalls, 0);
    assert.equal(fs.existsSync(path.join(outside, 'escaped.srwb')), false);
});

test('replacing the configured root after startup is detected per call', async (t) => {
    const h = fixture(t);
    const original = path.join(h.base, 'original-root');
    fs.renameSync(h.root, original);
    fs.mkdirSync(h.root);
    let appCalls = 0;
    await assert.rejects(exportCall(h.manager, exportArgs(), async () => {
        appCalls++;
        return exportEnvelope('srwb', '{}');
    }));
    assert.equal(appCalls, 0);
    assert.deepEqual(fs.readdirSync(h.root), []);
});

test('overwrite requires both the root opt-in and the per-call opt-in', async (t) => {
    const content = '{"new":true}';

    await t.test('root denies overwrite even when call requests it', async (t) => {
        const h = fixture(t, { allowOverwrite: false });
        fs.writeFileSync(path.join(h.root, 'notebook.srwb'), 'old');
        await assert.rejects(exportCall(h.manager,
            exportArgs('notebook.srwb', { overwrite: true }),
            async () => exportEnvelope('srwb', content)));
        assert.equal(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8'), 'old');
    });

    await t.test('call denies overwrite even when root allows it', async (t) => {
        const h = fixture(t, { allowOverwrite: true });
        fs.writeFileSync(path.join(h.root, 'notebook.srwb'), 'old');
        await assert.rejects(exportCall(h.manager,
            exportArgs('notebook.srwb', { overwrite: false }),
            async () => exportEnvelope('srwb', content)));
        assert.equal(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8'), 'old');
    });

    await t.test('both opt-ins atomically replace a regular file', async (t) => {
        const h = fixture(t, { allowOverwrite: true });
        fs.writeFileSync(path.join(h.root, 'notebook.srwb'), 'old');
        const receipt = await exportCall(h.manager,
            exportArgs('notebook.srwb', { overwrite: true }),
            async () => exportEnvelope('srwb', content));
        assert.equal(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8'), content);
        assert.equal(receipt.overwritten, true);
        assert.deepEqual(fs.readdirSync(h.root), ['notebook.srwb']);
    });
});

test('concurrent no-overwrite publication is atomic: exactly one export wins', async (t) => {
    const h = fixture(t);
    const first = '{"writer":1}';
    const second = '{"writer":2}';
    let calls = 0;
    const makeCall = content => exportCall(h.manager, exportArgs(), async () => {
        calls++;
        await new Promise(resolve => setImmediate(resolve));
        return exportEnvelope('srwb', content);
    });
    const results = await Promise.allSettled([makeCall(first), makeCall(second)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert([first, second].includes(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8')));
    assert.equal(calls >= 1, true);
    assert.deepEqual(fs.readdirSync(h.root), ['notebook.srwb'], 'losing temp file must be cleaned');
});

test('export re-reads the synced temporary file and cleans it on hash mismatch', async (t) => {
    let hookCalls = 0;
    const h = fixture(t, {
        hooks: {
            async afterExportTempSync({ tempPath }) {
                hookCalls++;
                fs.writeFileSync(tempPath, '{"tampered":true}', 'utf8');
            },
        },
    });
    await assert.rejects(exportCall(h.manager, exportArgs(), async () =>
        exportEnvelope('srwb', '{"original":true}')), /SHA|hash|digest|changed|verify|size/i);
    assert.equal(hookCalls, 1);
    assert.deepEqual(fs.readdirSync(h.root), [], 'verification failure leaked a temp file');
});

test('no-clobber publication rejects a destination created after temp verification', async (t) => {
    let hookCalls = 0;
    const h = fixture(t, {
        hooks: {
            async beforeExportPublish() {
                hookCalls++;
                fs.writeFileSync(path.join(h.root, 'notebook.srwb'), 'racing-writer', 'utf8');
            },
        },
    });
    await assert.rejects(exportCall(h.manager, exportArgs(), async () =>
        exportEnvelope('srwb', '{"broker":true}')), /exist|race|overwrite|publish|target/i);
    assert.equal(hookCalls, 1);
    assert.equal(fs.readFileSync(path.join(h.root, 'notebook.srwb'), 'utf8'), 'racing-writer');
    assert.deepEqual(fs.readdirSync(h.root), ['notebook.srwb'], 'publish race leaked a temp file');
});

test('export rejects a temporary file replaced after verification and before publication', async (t) => {
    let replacementPath;
    const h = fixture(t, {
        hooks: {
            beforeExportPublish({ tempPath }) {
                replacementPath = tempPath;
                fs.unlinkSync(tempPath);
                fs.writeFileSync(tempPath, '{"replaced":true}', { mode: 0o600 });
            },
        },
    });
    await assert.rejects(
        exportCall(h.manager, exportArgs(), async () => exportEnvelope('srwb', '{"trusted":true}')),
        /changed|race|temporary|publish/i);
    assert.equal(fs.existsSync(path.join(h.root, 'notebook.srwb')), false);
    assert.equal(fs.existsSync(replacementPath), false);
    assert.deepEqual(fs.readdirSync(h.root), []);
});

test('import hashes raw bytes, decodes fatal UTF-8, forwards exact args, and filters the app receipt', async (t) => {
    const h = fixture(t);
    const content = '{\n  "title": "café 😀",\n  "escaped": "\\\\\\\""\n}\n';
    const bytes = Buffer.from(content, 'utf8');
    fs.writeFileSync(path.join(h.root, 'notebook.srwb'), bytes);
    const calls = [];
    const receipt = await importCall(h.manager,
        importArgs('notebook.srwb', { mode: 'create', sha256: sha256(bytes).toUpperCase() }),
        async (...args) => {
            calls.push(args);
            return importReceipt('srwb', 'create', bytes);
        });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'import_workbook');
    assert.deepEqual(calls[0][1], {
        format: 'srwb',
        content,
        mode: 'create',
        sha256: sha256(bytes),
        brokerRoot: 'artifacts',
        brokerPath: 'notebook.srwb',
    });
    assert(calls[0][2] && Number.isSafeInteger(calls[0][2].maxWireBytes),
        'import call must carry a precomputed outbound wire-byte limit');
    assert.deepEqual(receipt, {
        schemaVersion: 1,
        type: 'workbook-file-receipt',
        direction: 'import',
        status: 'imported',
        root: 'artifacts',
        path: 'notebook.srwb',
        format: 'srwb',
        size: bytes.length,
        sha256: sha256(bytes),
        mode: 'create',
        toolCallId: 91,
        timestamp: FIXED_NOW,
    });
    assert.equal(Object.isFrozen(receipt), true);
    const rendered = JSON.stringify(receipt);
    assert.doesNotMatch(rendered, /content|Private notebook|private-notebook-id|cells/);
    assert.doesNotMatch(rendered, new RegExp(escapeRegExp(h.root)));
});

test('import caller hash mismatch, invalid UTF-8, cap, and non-regular files fail before app mutation', async (t) => {
    const h = fixture(t, { maxContentBytes: 32 });
    let appCalls = 0;
    const callApp = async () => {
        appCalls++;
        return '{}';
    };

    fs.writeFileSync(path.join(h.root, 'hash.srwb'), '{}');
    await assert.rejects(importCall(h.manager,
        importArgs('hash.srwb', { sha256: '0'.repeat(64) }), callApp), /SHA|digest|hash/i);

    fs.writeFileSync(path.join(h.root, 'invalid.srwb'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(importCall(h.manager, importArgs('invalid.srwb'), callApp),
        /UTF-8|UTF8|decode|encoding/i);

    fs.writeFileSync(path.join(h.root, 'large.srwb'), 'x'.repeat(33));
    await assert.rejects(importCall(h.manager, importArgs('large.srwb'), callApp),
        /size|large|limit|cap|bytes/i);

    fs.mkdirSync(path.join(h.root, 'directory.srwb'));
    await assert.rejects(importCall(h.manager, importArgs('directory.srwb'), callApp),
        /regular|file/i);
    assert.equal(appCalls, 0);
});

test('import detects a file that changes between read and final metadata verification', async (t) => {
    let hookCalls = 0;
    const h = fixture(t, {
        hooks: {
            async afterImportRead() {
                hookCalls++;
                fs.appendFileSync(path.join(h.root, 'notebook.srwb'), 'x');
            },
        },
    });
    fs.writeFileSync(path.join(h.root, 'notebook.srwb'), '{"stable":true}');
    let appCalls = 0;
    await assert.rejects(importCall(h.manager, importArgs(), async () => {
        appCalls++;
        return '{}';
    }), /changed|size|replace|stable|identity|modified/i);
    assert.equal(hookCalls, 1);
    assert.equal(appCalls, 0);
});

test('import rejects symlink/junction targets and linked parent escapes', async (t) => {
    const h = fixture(t);
    const outside = path.join(h.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.srwb'), '{"outside":true}');
    let appCalls = 0;
    const callApp = async () => { appCalls++; return '{}'; };

    const targetLink = path.join(h.root, 'target.srwb');
    let targetLinkCreated = false;
    try {
        fs.symlinkSync(path.join(outside, 'secret.srwb'), targetLink, 'file');
        targetLinkCreated = true;
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('import leaf-symlink assertion skipped: Windows symlink privilege unavailable');
        } else {
            throw error;
        }
    }
    if (targetLinkCreated) {
        await rejectsWithoutLeak(
            () => importCall(h.manager, importArgs('target.srwb'), callApp), [outside]);
    }

    const parentLink = path.join(h.root, 'linked-parent');
    fs.symlinkSync(outside, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
    await rejectsWithoutLeak(
        () => importCall(h.manager, importArgs('linked-parent/secret.srwb'), callApp), [outside]);
    assert.equal(appCalls, 0);
});

test('strict app import receipt validation rejects malformed and mismatched claims', async (t) => {
    const h = fixture(t);
    const bytes = Buffer.from('{"fixture":true}', 'utf8');
    fs.writeFileSync(path.join(h.root, 'notebook.srwb'), bytes);
    const valid = JSON.parse(importReceipt('srwb', 'replace', bytes));
    const cases = [
        ['not JSON', 'not-json'],
        ['array', JSON.stringify([valid])],
        ['not ok', JSON.stringify({ ...valid, ok: false })],
        ['wrong format', JSON.stringify({ ...valid, format: 'ipynb' })],
        ['invalid mode', JSON.stringify({ ...valid, mode: 'merge' })],
        ['wrong size', JSON.stringify({ ...valid, size: bytes.length + 1 })],
        ['wrong digest', JSON.stringify({ ...valid, sha256: '0'.repeat(64) })],
        ['unsupported field', JSON.stringify({ ...valid, content: 'must not be accepted' })],
    ];
    for (const [label, output] of cases) {
        await assert.rejects(importCall(h.manager, importArgs(), async () => output), undefined, label);
    }
});

test('import permission is passed through on every call and never pre-answered or cached', async (t) => {
    const h = fixture(t);
    const bytes = Buffer.from('{"fixture":true}', 'utf8');
    fs.writeFileSync(path.join(h.root, 'notebook.srwb'), bytes);
    let attempt = 0;
    const callApp = async () => {
        attempt++;
        if (attempt !== 2) {
            throw new Error('Tool "import_workbook" is denied because Workbook import/export is Off');
        }
        return importReceipt('srwb', 'replace', bytes);
    };
    await assert.rejects(importCall(h.manager, importArgs(), callApp), /denied/i);
    const receipt = await importCall(h.manager, importArgs(), callApp);
    assert.equal(receipt.status, 'imported');
    await assert.rejects(importCall(h.manager, importArgs(), callApp), /denied/i);
    assert.equal(attempt, 3);
});

test('directional audit records contain only public receipt evidence and no content or host paths', async (t) => {
    const h = fixture(t, { allowOverwrite: true });
    const exportContent = '{"audit-secret-export":"do not log"}';
    const exportBytes = Buffer.from(exportContent);
    await exportCall(h.manager, exportArgs(), async () =>
        exportEnvelope('srwb', exportContent, { filename: 'private-app-name.srwb' }));

    const importContent = '{"audit-secret-import":"do not log"}';
    const importBytes = Buffer.from(importContent);
    fs.writeFileSync(path.join(h.root, 'incoming.srwb'), importBytes);
    await importCall(h.manager, importArgs('incoming.srwb'), async () =>
        importReceipt('srwb', 'replace', importBytes, { name: 'private import name' }));

    const audit = JSON.stringify(h.logs);
    assert.match(audit, /export/);
    assert.match(audit, /import/);
    assert.match(audit, /artifacts/);
    assert.match(audit, /notebook\.srwb/);
    assert.match(audit, /incoming\.srwb/);
    assert.match(audit, new RegExp(sha256(exportBytes)));
    assert.match(audit, new RegExp(sha256(importBytes)));
    assert.match(audit, /written|imported|success/);
    assert.doesNotMatch(audit, /audit-secret|do not log|private-app-name|private import name/);
    assert.doesNotMatch(audit, new RegExp(escapeRegExp(h.root)));
    assert.doesNotMatch(audit, new RegExp(escapeRegExp(h.configPath)));
});

test('unknown roots, missing files, and direction-disabled roots fail before calling the app', async (t) => {
    const base = fs.mkdtempSync(path.join(REAL_TMP, 'scirepl-workbook-direction-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    const workspace = path.join(base, 'workspace');
    const configPath = path.join(base, 'config.json');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);
    writeJson(configPath, {
        schemaVersion: 1,
        maxContentBytes: 1024,
        roots: [{ name: 'artifacts', path: root }],
    });
    const manager = createWorkbookFileTransfer({
        configPath,
        agentWorkspace: workspace,
        maxAppWsPayloadBytes: REQUIRED_APP_WS_PAYLOAD_BYTES,
        now: () => new Date(FIXED_NOW),
    });
    let appCalls = 0;
    const callApp = async () => { appCalls++; return '{}'; };
    await assert.rejects(exportCall(manager, exportArgs(), callApp), /write|permission|root|disabled|allow/i);
    fs.writeFileSync(path.join(root, 'notebook.srwb'), '{}');
    await assert.rejects(importCall(manager, importArgs(), callApp), /read|permission|root|disabled|allow/i);
    await assert.rejects(exportCall(manager, exportArgs('file.srwb', { root: 'unknown' }), callApp),
        /root|unknown|alias/i);
    await assert.rejects(importCall(manager, importArgs('missing.srwb'), callApp),
        /missing|exist|file|ENOENT/i);
    assert.equal(appCalls, 0);
});

test('tool-call binding accepts only an actual string or finite numeric request ID', async (t) => {
    const h = fixture(t);
    const callApp = async () => exportEnvelope('srwb', '{}');
    for (const invalidId of [undefined, null, NaN, Infinity, {}, true, '\ud800', 'bidi\u202eid']) {
        await assert.rejects(
            h.manager.handleTool('export_workbook_to_file', exportArgs(), {
                callApp,
                toolCallId: invalidId,
            }),
            /tool.?call|request|id/i);
    }
    assert.deepEqual(fs.readdirSync(h.root), []);
});
