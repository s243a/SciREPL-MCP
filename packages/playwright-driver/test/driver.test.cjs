'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
    SCIREPL_LANGUAGES,
    SERVER_VERSION,
    SciREPLMCP,
    isSensitiveSettingName,
} = require('../src/server.cjs');

function makeWritableTempDir(prefix) {
    const roots = [
        process.env.SCIREPL_TEST_TMP,
        os.tmpdir(),
        process.platform === 'win32' ? null : '/tmp',
        path.resolve(__dirname, '../.test-workspaces'),
    ].filter(Boolean);

    for (const root of roots) {
        try {
            fs.mkdirSync(root, { recursive: true });
            return fs.mkdtempSync(path.join(root, prefix));
        } catch (error) {
            if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) throw error;
        }
    }
    throw new Error('No writable temporary directory is available for driver tests');
}

async function evaluateWithPageGlobals(callback, argument, { window, document }) {
    const previousWindow = global.window;
    const previousDocument = global.document;
    global.window = window;
    global.document = document;
    try {
        return await callback(argument);
    } finally {
        if (previousWindow === undefined) delete global.window;
        else global.window = previousWindow;
        if (previousDocument === undefined) delete global.document;
        else global.document = previousDocument;
    }
}

test('exports package version and all current SciREPL kernels', () => {
    assert.equal(SERVER_VERSION, require('../package.json').version);
    assert.deepEqual(SCIREPL_LANGUAGES, [
        'python', 'r', 'typr', 'prolog', 'bash', 'javascript', 'lua', 'clojurescript',
    ]);
});

test('advertises a unique, stable tool catalog', () => {
    const tools = new SciREPLMCP().getToolDefinitions();
    const names = tools.map(tool => tool.name);

    assert.equal(tools.length, 31);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('scirepl_connect'));
    assert.ok(names.includes('scirepl_run_all_cells_ui'));
    assert.ok(names.includes('scirepl_get_cell_outputs_detailed'));
    assert.ok(names.includes('scirepl_vfs_overlay_dir'));

    for (const name of ['scirepl_execute_code', 'scirepl_create_cell', 'scirepl_set_cell_language']) {
        const tool = tools.find(candidate => candidate.name === name);
        assert.deepEqual(tool.inputSchema.properties.language.enum, SCIREPL_LANGUAGES);
    }
});

test('unknown tools fail as MCP tool errors', async () => {
    const result = await new SciREPLMCP().handleToolCall('scirepl_not_real', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
});

test('credential-bearing setting names are redacted', () => {
    for (const name of [
        'scirepl_ai_api_key',
        'scirepl_mcp_token',
        'scirepl_mcp_profiles',
        'scirepl_password',
    ]) {
        assert.equal(isSensitiveSettingName(name), true, name);
    }
    assert.equal(isSensitiveSettingName('scirepl_default_language'), false);
});

test('settings reader does not return stored API keys or pairing tokens', async () => {
    const mcp = new SciREPLMCP();
    mcp.isConnected = true;
    const values = {
        scirepl_default_language: 'typr',
        scirepl_ai_api_key: 'live-secret',
        scirepl_mcp_token: 'pairing-secret',
        scirepl_mcp_profiles: '{"token":"nested-secret"}',
    };
    const localStorage = { ...values };
    Object.defineProperty(localStorage, 'getItem', {
        enumerable: false,
        value: key => values[key] ?? null,
    });
    mcp.page = {
        evaluate: async callback => {
            const previous = global.localStorage;
            global.localStorage = localStorage;
            try {
                return callback();
            } finally {
                if (previous === undefined) delete global.localStorage;
                else global.localStorage = previous;
            }
        },
    };

    const result = await mcp.getSettings();
    const text = result.content[0].text;
    assert.match(text, /scirepl_default_language: typr/);
    assert.doesNotMatch(text, /live-secret|pairing-secret/);
    assert.doesNotMatch(text, /nested-secret/);
    assert.equal((text.match(/\[REDACTED\]/g) || []).length, 3);
});

test('sensitive setting writes do not echo the value', async () => {
    const mcp = new SciREPLMCP();
    mcp.isConnected = true;
    mcp.page = { evaluate: async () => undefined };

    const result = await mcp.handleToolCall('scirepl_set_setting', {
        setting: 'scirepl_ai_api_key',
        value: 'live-secret',
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /\[REDACTED\]/);
    assert.doesNotMatch(result.content[0].text, /live-secret/);
});

test('tool arguments enforce required fields, types, and enums', async () => {
    const mcp = new SciREPLMCP();

    const missing = await mcp.handleToolCall('scirepl_execute_code', { language: 'python' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Missing required argument: code/);

    const wrongType = await mcp.handleToolCall('scirepl_execute_cell', { cellIndex: '0' });
    assert.equal(wrongType.isError, true);
    assert.match(wrongType.content[0].text, /cellIndex must be an integer/);

    const negative = await mcp.handleToolCall('scirepl_execute_cell', { cellIndex: -1 });
    assert.equal(negative.isError, true);
    assert.match(negative.content[0].text, /cellIndex must be at least 0/);

    const wrongEnum = await mcp.handleToolCall('scirepl_execute_code', {
        code: '1 + 1',
        language: 'fortran',
    });
    assert.equal(wrongEnum.isError, true);
    assert.match(wrongEnum.content[0].text, /language must be one of/);
});

test('directory overlay glob supports root and nested matches', () => {
    const root = makeWritableTempDir('scirepl-driver-glob-');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'root.pl'), 'root.');
    fs.writeFileSync(path.join(root, 'root.txt'), 'root');
    fs.writeFileSync(path.join(root, 'nested', 'child.pl'), 'child.');

    try {
        const files = new SciREPLMCP()._walkDir(root, '**/*.pl').sort();
        assert.deepEqual(files, ['nested/child.pl', 'root.pl']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('output inspection reads current SciREPL model fields and output cards', async () => {
    const body = { innerText: 'Rendered result: 42' };
    const label = { textContent: 'Out [7]' };
    const outputCard = {
        querySelector(selector) {
            if (selector === '.card-body') return body;
            if (selector === '.card-label span:last-child') return label;
            return null;
        },
    };
    const pageWindow = {
        _cells: [{
            id: 7,
            type: 'code',
            language: 'typr',
            code: 'print(42)',
            lastOutput: 'Rendered result: 42',
            lastOutputHtml: '<strong>Rendered result: 42</strong>',
            outputCard,
        }],
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    };
    const pageDocument = {
        title: 'SciREPL fixture',
        body: { innerText: 'ready' },
        querySelector: () => null,
        querySelectorAll: () => [],
    };

    const mcp = new SciREPLMCP();
    mcp.isConnected = true;
    mcp.page = {
        evaluate: (callback, argument) => evaluateWithPageGlobals(
            callback,
            argument,
            { window: pageWindow, document: pageDocument },
        ),
    };

    const state = await mcp.getVisibleState();
    assert.match(state.content[0].text, /"hasOutput": true/);
    assert.match(state.content[0].text, /Rendered result: 42/);
    assert.match(state.content[0].text, /Out \[7\]/);

    const details = await mcp.getCellOutputsDetailed();
    assert.match(details.content[0].text, /"hasOutputHtml": true/);
    assert.match(details.content[0].text, /<strong>Rendered result: 42<\/strong>/);
    assert.match(details.content[0].text, /Rendered result: 42/);
});

test('disconnect closes the dedicated page before releasing the browser', async () => {
    const calls = [];
    const mcp = new SciREPLMCP();
    mcp.page = {
        isClosed: () => false,
        close: async options => calls.push(['page', options]),
    };
    mcp.browser = { close: async () => calls.push(['browser']) };
    mcp.browserContext = {};
    mcp.isConnected = true;
    mcp.activeDebugMode = true;
    mcp.activeBrowserUrl = 'http://127.0.0.1:9222';

    await mcp.disconnect();

    assert.deepEqual(calls, [
        ['page', { runBeforeUnload: false }],
        ['browser'],
    ]);
    assert.equal(mcp.page, null);
    assert.equal(mcp.browser, null);
    assert.equal(mcp.browserContext, null);
    assert.equal(mcp.isConnected, false);
    assert.equal(mcp.activeDebugMode, false);
    assert.equal(mcp.activeBrowserUrl, '');
});

test('invalid numeric environment settings fail at startup', () => {
    const server = path.resolve(__dirname, '../src/server.cjs');
    const child = spawnSync(process.execPath, [server], {
        env: { ...process.env, SCIREPL_TIMEOUT: 'not-a-number' },
        encoding: 'utf8',
    });

    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /SCIREPL_TIMEOUT must be an integer/);
});
