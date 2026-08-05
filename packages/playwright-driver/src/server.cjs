#!/usr/bin/env node
/**
 * sciREPL MCP Server
 *
 * Provides automated tools for sciREPL integration:
 * - Connection and navigation
 * - Package/workbook management
 * - Cell execution (run all)
 * - Settings management
 * - Warning resolution
 */

// MCP SDK imports - using package exports (SDK v1.29+)
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PACKAGE_METADATA = require('../package.json');

const SERVER_VERSION = PACKAGE_METADATA.version;
if (typeof SERVER_VERSION !== 'string' || !SERVER_VERSION) {
    throw new Error('package.json must contain a version');
}

const SCIREPL_LANGUAGES = Object.freeze([
    'python',
    'r',
    'typr',
    'prolog',
    'bash',
    'javascript',
    'lua',
    'clojurescript',
]);

function integerSetting(name, fallback, min, max) {
    const raw = process.env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}; received ${JSON.stringify(raw)}`);
    }
    return value;
}

function isSensitiveSettingName(name) {
    return /(api[_-]?key|token|secret|password|credential|authorization|profiles?)/i.test(String(name));
}

// Default configuration
const DEFAULT_CONFIG = {
    sciReplUrl: process.env.SCIREPL_URL || 'http://localhost:8085',
    headless: process.env.SCIREPL_HEADLESS !== 'false',
    timeout: integerSetting('SCIREPL_TIMEOUT', 120000, 1000, 3600000),
    autoAcceptPrivacy: true,
    autoDownloadRuntimes: true,
    debugMode: process.env.SCIREPL_DEBUG_MODE === 'true',
    remoteDebuggingPort: integerSetting('SCIREPL_REMOTE_DEBUGGING_PORT', 9223, 1, 65535),
    connectToBrowserUrl: process.env.SCIREPL_BROWSER_URL || '',
    devPackagesDir: process.env.SCIREPL_DEV_PACKAGES || '',
};

class SciREPLMCP {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.browser = null;
        this.browserContext = null;
        this.page = null;
        this.consoleLogs = [];
        this.isConnected = false;
        this.activeDebugMode = false;
        this.activeBrowserUrl = '';
    }

    /**
     * Initialize and start the MCP server
     */
    async start() {
        const server = new Server(
            {
                name: 'scirepl-mcp',
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        // Register tools
        server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: this.getToolDefinitions(),
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return this.handleToolCall(request.params.name, request.params.arguments);
        });

        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('SciREPL MCP server running on stdio');
    }

    /**
     * Define all available tools
     */
    getToolDefinitions() {
        return [
            {
                name: 'scirepl_connect',
                description: 'Connect to a sciREPL instance and prepare it for automation',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'sciREPL URL (default: http://localhost:8085)' },
                        waitForPyodide: { type: 'boolean', description: 'Wait for Pyodide to be ready' },
                        debugMode: { type: 'boolean', description: 'Enable shared-session browser-debug mode' },
                        browserUrl: { type: 'string', description: 'Attach to an already-debuggable browser via CDP browser URL' },
                        remoteDebuggingPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Remote debugging port to expose when launching Chromium in debug mode' },
                    },
                },
            },
            {
                name: 'scirepl_disconnect',
                description: 'Disconnect from sciREPL and clean up browser resources',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_execute_code',
                description: 'Execute code in a specific language kernel',
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: { type: 'string', description: 'Code to execute' },
                        language: { type: 'string', enum: [...SCIREPL_LANGUAGES], description: 'Language' },
                        waitForOutput: { type: 'boolean', description: 'Wait for execution output' },
                    },
                    required: ['code', 'language'],
                },
            },
            {
                name: 'scirepl_execute_cell',
                description: 'Execute a specific cell by index',
                inputSchema: {
                    type: 'object',
                    properties: {
                        cellIndex: { type: 'integer', minimum: 0, description: 'Zero-based cell index to execute' },
                        timeout: { type: 'integer', minimum: 1, maximum: 3600000, description: 'Execution timeout in milliseconds' },
                    },
                    required: ['cellIndex'],
                },
            },
            {
                name: 'scirepl_run_all_cells',
                description: 'Run all cells in the current workbook programmatically (not via the visible UI menu)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        stopOnError: { type: 'boolean', description: 'Stop execution if a cell errors' },
                        timeout: { type: 'integer', minimum: 1, maximum: 3600000, description: 'Timeout per cell (ms)' },
                    },
                },
            },
            {
                name: 'scirepl_run_all_cells_ui',
                description: 'Run all cells using the visible sciREPL UI menu in the same Playwright browser session',
                inputSchema: {
                    type: 'object',
                    properties: {
                        waitForOutput: { type: 'boolean', description: 'Wait for output or execution state to change after clicking Run All Cells' },
                        timeout: { type: 'integer', minimum: 1, maximum: 3600000, description: 'Timeout in ms for UI execution to finish' },
                    },
                },
            },
            {
                name: 'scirepl_get_cells',
                description: 'Get information about all cells in the current workbook',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_create_cell',
                description: 'Create a new cell with optional code',
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: { type: 'string', description: 'Initial code content' },
                        language: { type: 'string', enum: [...SCIREPL_LANGUAGES], description: 'Language' },
                        type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type' },
                    },
                },
            },
            {
                name: 'scirepl_delete_cell',
                description: 'Delete a cell by index',
                inputSchema: {
                    type: 'object',
                    properties: {
                        cellIndex: { type: 'integer', minimum: 0, description: 'Zero-based cell index to delete' },
                    },
                    required: ['cellIndex'],
                },
            },
            {
                name: 'scirepl_set_cell_language',
                description: 'Set the language for a specific cell',
                inputSchema: {
                    type: 'object',
                    properties: {
                        cellIndex: { type: 'integer', minimum: 0, description: 'Zero-based cell index' },
                        language: { type: 'string', enum: [...SCIREPL_LANGUAGES], description: 'New language' },
                    },
                    required: ['cellIndex', 'language'],
                },
            },
            {
                name: 'scirepl_open_catalog',
                description: 'Open the Browse Packages, Bundles & Workbooks catalog',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_list_catalog',
                description: 'List all available packages and workbooks in the catalog',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_install_package',
                description: 'Install a package or workbook from the catalog by name',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Package/workbook name to install' },
                        waitForComplete: { type: 'boolean', description: 'Wait for installation to complete' },
                    },
                    required: ['name'],
                },
            },
            {
                name: 'scirepl_import_file',
                description: 'Import a SciREPL workbook (.srwb) or Jupyter notebook (.ipynb)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Path to the file to import' },
                    },
                    required: ['filePath'],
                },
            },
            {
                name: 'scirepl_export_workbook',
                description: 'Export the current workbook',
                inputSchema: {
                    type: 'object',
                    properties: {
                        format: { type: 'string', enum: ['srwb', 'ipynb', 'package'], description: 'Export format' },
                        scope: { type: 'string', enum: ['current', 'all'], description: 'Export scope' },
                        outputPath: { type: 'string', description: 'Where to save the file' },
                    },
                    required: ['format', 'outputPath'],
                },
            },
            {
                name: 'scirepl_set_setting',
                description: 'Set a setting value',
                inputSchema: {
                    type: 'object',
                    properties: {
                        setting: { type: 'string', description: 'Setting name' },
                        value: { type: 'string', description: 'Setting value' },
                    },
                    required: ['setting', 'value'],
                },
            },
            {
                name: 'scirepl_get_settings',
                description: 'Get all current settings',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_accept_privacy',
                description: 'Accept the privacy policy',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_get_kernel_status',
                description: 'Get status of all language kernels',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_open_menu',
                description: 'Open the main menu',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_close_modal',
                description: 'Close any open modal dialog',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_get_visible_state',
                description: 'Return visible UI state from the MCP-controlled sciREPL browser session (menus, modals, cells, warnings)',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_get_browser_debug_info',
                description: 'Return browser/session details useful for shared-session debugging (CDP browser URL, mode, page URL, storage/service-worker hints)',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'scirepl_get_cell_outputs_detailed',
                description: 'Inspect notebook cell outputs in detail using both cell model data and DOM-visible rendered output, including Out [n] labels when present',
                inputSchema: {
                    type: 'object',
                    properties: {
                        includeDomText: { type: 'boolean', description: 'Include DOM-derived rendered text for each cell output' },
                        maxOutputChars: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Maximum number of characters per extracted text field' },
                        warningOnly: { type: 'boolean', description: 'Filter to cells whose model or DOM text appears to contain warnings/errors' },
                    },
                },
            },
            {
                name: 'scirepl_get_shared_files',
                description: 'List files in the shared filesystem',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to list (default: /shared/)' },
                    },
                },
            },
            {
                name: 'scirepl_wait_for',
                description: 'Wait for text to appear on the page',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'Text to wait for' },
                        timeout: { type: 'integer', minimum: 1, maximum: 3600000, description: 'Timeout in ms' },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'scirepl_screenshot',
                description: 'Take a screenshot of the current page',
                inputSchema: {
                    type: 'object',
                    properties: {
                        outputPath: { type: 'string', description: 'Where to save the screenshot' },
                    },
                    required: ['outputPath'],
                },
            },
            {
                name: 'scirepl_install_local_package',
                description: 'Install a package from a local zip file instead of the catalog. Bypasses GitHub release downloads.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        zipPath: { type: 'string', description: 'Absolute path to the local .zip package file' },
                        waitForComplete: { type: 'boolean', description: 'Wait for installation to complete' },
                    },
                    required: ['zipPath'],
                },
            },
            {
                name: 'scirepl_vfs_write',
                description: 'Write a local file into the SciREPL virtual filesystem (Emscripten FS for Prolog, or SharedVFS). Use this to overlay individual files after package install for testing.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        localPath: { type: 'string', description: 'Absolute path to the local file to read' },
                        vfsPath: { type: 'string', description: 'Target path in the VFS (e.g. /user/unifyweaver/core/component_registry.pl)' },
                        target: { type: 'string', enum: ['prolog', 'shared'], description: 'Which VFS to write to (default: prolog for .pl files, shared otherwise)' },
                    },
                    required: ['localPath', 'vfsPath'],
                },
            },
            {
                name: 'scirepl_vfs_overlay_dir',
                description: 'Overlay an entire local directory into the VFS. Recursively writes all files from a local directory to a VFS base path. Useful for applying a batch of local changes.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        localDir: { type: 'string', description: 'Absolute path to the local directory' },
                        vfsBasePath: { type: 'string', description: 'Base path in the VFS (e.g. /user/unifyweaver)' },
                        glob: { type: 'string', description: 'Optional glob filter (e.g. "**/*.pl"). Default: all files.' },
                    },
                    required: ['localDir', 'vfsBasePath'],
                },
            },
            {
                name: 'scirepl_vfs_list',
                description: 'List files currently in the Prolog Emscripten VFS at a given path',
                inputSchema: {
                    type: 'object',
                    properties: {
                        vfsPath: { type: 'string', description: 'Path to list (e.g. /user/unifyweaver/core)' },
                        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
                    },
                    required: ['vfsPath'],
                },
            },
        ];
    }

    /**
     * Handle tool calls
     */
    async handleToolCall(name, args) {
        try {
            args = this.validateToolArguments(name, args);
            switch (name) {
                case 'scirepl_connect':
                    return await this.connect(args);
                case 'scirepl_disconnect':
                    return await this.disconnect();
                case 'scirepl_execute_code':
                    return await this.executeCode(args);
                case 'scirepl_execute_cell':
                    return await this.executeCell(args);
                case 'scirepl_run_all_cells':
                    return await this.runAllCells(args);
                case 'scirepl_run_all_cells_ui':
                    return await this.runAllCellsUI(args);
                case 'scirepl_get_cells':
                    return await this.getCells();
                case 'scirepl_create_cell':
                    return await this.createCell(args);
                case 'scirepl_delete_cell':
                    return await this.deleteCell(args);
                case 'scirepl_set_cell_language':
                    return await this.setCellLanguage(args);
                case 'scirepl_open_catalog':
                    return await this.openCatalog();
                case 'scirepl_list_catalog':
                    return await this.listCatalog();
                case 'scirepl_install_package':
                    return await this.installPackage(args);
                case 'scirepl_import_file':
                    return await this.importFile(args);
                case 'scirepl_export_workbook':
                    return await this.exportWorkbook(args);
                case 'scirepl_set_setting':
                    return await this.setSetting(args);
                case 'scirepl_get_settings':
                    return await this.getSettings();
                case 'scirepl_accept_privacy':
                    return await this.acceptPrivacy();
                case 'scirepl_get_kernel_status':
                    return await this.getKernelStatus();
                case 'scirepl_open_menu':
                    return await this.openMenu();
                case 'scirepl_close_modal':
                    return await this.closeModal();
                case 'scirepl_get_visible_state':
                    return await this.getVisibleState();
                case 'scirepl_get_browser_debug_info':
                    return await this.getBrowserDebugInfo();
                case 'scirepl_get_cell_outputs_detailed':
                    return await this.getCellOutputsDetailed(args);
                case 'scirepl_get_shared_files':
                    return await this.getSharedFiles(args);
                case 'scirepl_wait_for':
                    return await this.waitForText(args);
                case 'scirepl_screenshot':
                    return await this.takeScreenshot(args);
                case 'scirepl_install_local_package':
                    return await this.installLocalPackage(args);
                case 'scirepl_vfs_write':
                    return await this.vfsWrite(args);
                case 'scirepl_vfs_overlay_dir':
                    return await this.vfsOverlayDir(args);
                case 'scirepl_vfs_list':
                    return await this.vfsList(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error) {
            if (name === 'scirepl_connect' && this.browser && !this.isConnected) {
                await this.disconnect().catch(() => {});
            }
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    }

    // ==================== Tool Implementations ====================

    async connect(args = {}) {
        if (this.browser) {
            return { content: [{ type: 'text', text: 'Already connected to sciREPL' }] };
        }

        const url = args.url || this.config.sciReplUrl;
        const debugMode = args.debugMode ?? this.config.debugMode;
        const remoteDebuggingPort = args.remoteDebuggingPort || this.config.remoteDebuggingPort;
        const browserUrl = args.browserUrl || this.config.connectToBrowserUrl;

        if (!Number.isSafeInteger(remoteDebuggingPort) || remoteDebuggingPort < 1 || remoteDebuggingPort > 65535) {
            throw new Error('remoteDebuggingPort must be an integer from 1 to 65535');
        }

        try {
            if (browserUrl) {
                this.browser = await chromium.connectOverCDP(browserUrl);
            } else {
                const launchArgs = [];
                if (debugMode) {
                    launchArgs.push(`--remote-debugging-port=${remoteDebuggingPort}`);
                }

                this.browser = await chromium.launch({
                    headless: this.config.headless,
                    args: launchArgs,
                });
            }

            const existingContexts = this.browser.contexts();
            const context = existingContexts[0] || await this.browser.newContext();
            this.browserContext = context;
            this.activeDebugMode = !!debugMode || !!browserUrl;
            this.activeBrowserUrl = browserUrl || (debugMode ? `http://127.0.0.1:${remoteDebuggingPort}` : '');

            // Use a dedicated page even when attaching over CDP, and scope init
            // scripts to it so unrelated pages in the attached context are untouched.
            this.page = await context.newPage();

            // Set up localStorage before page load
            if (this.config.autoAcceptPrivacy) {
                await this.page.addInitScript(() => {
                    localStorage.setItem('scirepl_privacy_accepted', '1');
                });
            }
            if (this.config.autoDownloadRuntimes) {
                await this.page.addInitScript(() => {
                    localStorage.setItem('scirepl_auto_download', '1');
                });
            }

            // Capture console logs
            this.page.on('console', msg => {
                const log = `[${msg.type()}] ${msg.text()}`;
                this.consoleLogs.push(log);
                if (this.consoleLogs.length > 100) this.consoleLogs.shift();
            });

            // Handle dialogs
            this.page.on('dialog', async dialog => {
                await dialog.accept();
            });

            // Navigate to sciREPL
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: this.config.timeout
            });

            // Wait for app to be ready
            await this.page.waitForFunction(() => {
                return window.kernelManager && window._cells !== undefined;
            }, null, { timeout: 30000 });

            this.isConnected = true;

            // Optionally wait for Pyodide
            if (args.waitForPyodide) {
                await this.page.waitForFunction(() => {
                    const km = window.kernelManager;
                    return km && km._instances && km._instances.python && km._instances.python.isReady();
                }, null, { timeout: this.config.timeout });
            }

            return {
                content: [{ type: 'text', text: `Connected to sciREPL at ${url}${debugMode || browserUrl ? ` (browser-debug mode enabled${browserUrl ? ` via ${browserUrl}` : ` on port ${remoteDebuggingPort}`})` : ''}` }],
            };
        } catch (error) {
            await this._cleanupConnection().catch(() => {});
            throw error;
        }
    }

    async _cleanupConnection() {
        const page = this.page;
        const browser = this.browser;
        let cleanupError = null;

        try {
            if (page && (typeof page.isClosed !== 'function' || !page.isClosed())) {
                await page.close({ runBeforeUnload: false });
            }
        } catch (error) {
            cleanupError = error;
        }

        try {
            if (browser) await browser.close();
        } catch (error) {
            cleanupError ||= error;
        } finally {
            this.browser = null;
            this.browserContext = null;
            this.page = null;
            this.isConnected = false;
            this.activeDebugMode = false;
            this.activeBrowserUrl = '';
        }

        if (cleanupError) throw cleanupError;
    }

    async disconnect() {
        await this._cleanupConnection();
        return { content: [{ type: 'text', text: 'Disconnected from sciREPL' }] };
    }

    async executeCode(args) {
        this.ensureConnected();
        const { code, language = 'python', waitForOutput = true } = args;

        const result = await this.page.evaluate(async (params) => {
            const { code, language } = params;
            try {
                const res = await window.kernelManager.execute(code, language);
                return {
                    stdout: res.stdout || '',
                    result: res.result !== undefined ? String(res.result) : null,
                    error: res.error || null,
                };
            } catch (e) {
                return { error: e.message };
            }
        }, { code, language });

        if (result.error) {
            return {
                content: [{ type: 'text', text: `Execution error:\n${result.error}` }],
                isError: true,
            };
        }

        let output = '';
        if (result.stdout) output += `Output:\n${result.stdout}\n`;
        if (result.result !== null) output += `Result: ${result.result}`;
        if (!output) output = 'Code executed successfully (no output)';

        return { content: [{ type: 'text', text: output }] };
    }

    async executeCell(args) {
        this.ensureConnected();
        const { cellIndex, timeout = this.config.timeout } = args;

        const result = await this.page.evaluate(async (params) => {
            const { index, timeout } = params;
            const cell = window._cells[index];
            if (!cell) return { error: `Cell ${index} not found` };

            try {
                let timer;
                try {
                    return await Promise.race([
                        (async () => {
                            const km = window.kernelManager;
                            await km.ensureReady(cell.language);
                            const res = await km.execute(cell.code, cell.language);
                            return {
                                stdout: res.stdout || '',
                                error: res.error || null,
                            };
                        })(),
                        new Promise(resolve => {
                            timer = setTimeout(
                                () => resolve({ error: `Cell ${index} timed out after ${timeout} ms` }),
                                timeout
                            );
                        }),
                    ]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            } catch (e) {
                return { error: e.message };
            }
        }, { index: cellIndex, timeout });

        if (result.error) {
            return {
                content: [{ type: 'text', text: `Cell ${cellIndex} error:\n${result.error}` }],
                isError: true,
            };
        }

        return {
            content: [{ type: 'text', text: `Cell ${cellIndex} output:\n${result.stdout || '(no output)'}` }],
        };
    }

    async runAllCells(args = {}) {
        this.ensureConnected();
        const { stopOnError = true, timeout = 60000 } = args;

        const cells = await this.page.evaluate(() => {
            if (!window._cells || !Array.isArray(window._cells)) {
                return [];
            }
            return window._cells.map((c, i) => ({
                index: i,
                type: c.cellType || c.type || 'code',
                language: c.language || 'python',
                code: c.code || '',
            }));
        });

        if (cells.length === 0) {
            return {
                content: [{ type: 'text', text: 'No cells found in workbook. The package may still be loading or no workbook is open.' }],
            };
        }

        const codeCells = cells.filter(c => c.type === 'code');
        const results = [];

        for (const cell of codeCells) {
            const result = await this.executeCell({ cellIndex: cell.index, timeout });
            results.push({
                cellIndex: cell.index,
                isError: !!result.isError,
                text: result.content[0]?.text || '',
            });

            if (stopOnError && result.isError) {
                break;
            }
        }

        const summary = results.map(r => `Cell ${r.cellIndex}: ${r.isError ? 'ERROR' : 'OK'}`).join('\n');
        return {
            content: [{ type: 'text', text: `Executed ${results.length}/${codeCells.length} code cells:\n${summary}` }],
        };
    }

    async runAllCellsUI(args = {}) {
        this.ensureConnected();
        const { waitForOutput = true, timeout = 60000 } = args;

        await this.page.evaluate(() => {
            if (typeof window.runAllCells !== 'function') {
                throw new Error('SciREPL runAllCells API is unavailable');
            }
            if (window.__scireplMcpRunAll?.started && !window.__scireplMcpRunAll?.finished) {
                throw new Error('A Run All Cells operation is already in progress');
            }
            const original = window.runAllCells;
            window.__scireplMcpRunAllOriginal = original;
            window.__scireplMcpRunAll = { started: false, finished: false, error: null };
            window.runAllCells = async (...callArgs) => {
                window.__scireplMcpRunAll.started = true;
                try {
                    return await original(...callArgs);
                } catch (error) {
                    window.__scireplMcpRunAll.error = error?.message || String(error);
                    throw error;
                } finally {
                    window.__scireplMcpRunAll.finished = true;
                    window.runAllCells = original;
                    delete window.__scireplMcpRunAllOriginal;
                }
            };
        });

        try {
            await this.openMenu();

            await this.page.waitForSelector('button, [role="button"]', { timeout: Math.min(timeout, 10000) });
            await this.page.locator('button').filter({ hasText: 'Run All Cells' }).first().click({ timeout: Math.min(timeout, 10000) });

            if (waitForOutput) {
                await this.page.waitForFunction(
                    () => window.__scireplMcpRunAll?.finished === true,
                    null,
                    { timeout }
                );
                const runError = await this.page.evaluate(() => window.__scireplMcpRunAll?.error || null);
                if (runError) throw new Error(`Run All Cells failed: ${runError}`);
            } else {
                await this.page.waitForTimeout(500);
            }
        } catch (error) {
            await this.page.evaluate(() => {
                if (window.__scireplMcpRunAllOriginal) {
                    window.runAllCells = window.__scireplMcpRunAllOriginal;
                    delete window.__scireplMcpRunAllOriginal;
                }
            }).catch(() => {});
            throw error;
        }

        const visibleState = await this.page.evaluate(() => {
            const cells = Array.isArray(window._cells) ? window._cells : [];
            return cells.map((c, i) => {
                const outputHtml = c.lastOutputHtml ?? c.outputHtml ?? '';
                const outputText = c.lastOutput ?? c.outputText ?? '';
                const preview = outputHtml
                    ? String(outputHtml).replace(/<[^>]+>/g, ' ')
                    : String(outputText);
                return {
                    index: i,
                    type: c.cellType || c.type || 'code',
                    language: c.language || 'python',
                    hasOutput: !!(String(outputHtml).length || String(outputText).length),
                    outputPreview: preview.replace(/\s+/g, ' ').trim().substring(0, 160),
                };
            });
        });

        const warnings = this.consoleLogs.filter(log => log.includes('[warn]') || log.includes('[error]')).slice(-20);
        return {
            content: [{
                type: 'text',
                text: `Run All Cells triggered via visible UI menu in the MCP-controlled browser.\n\nVisible cell state:\n${JSON.stringify(visibleState, null, 2)}\n\nRecent warnings/errors:\n${warnings.length ? warnings.join('\n') : '(none)'}`,
            }],
        };
    }

    async getCells() {
        this.ensureConnected();
        const cells = await this.page.evaluate(() => {
            if (!window._cells || !Array.isArray(window._cells)) {
                return [];
            }
            return window._cells.map((c, i) => {
                const outputHtml = c.lastOutputHtml ?? c.outputHtml ?? '';
                const outputText = c.lastOutput ?? c.outputText ?? '';
                return {
                    index: i,
                    id: c.id,
                    type: c.cellType || c.type || 'code',
                    language: c.language || 'python',
                    code: (c.code || '').substring(0, 100) + ((c.code || '').length > 100 ? '...' : ''),
                    hasOutput: !!(String(outputHtml).length || String(outputText).length),
                };
            });
        });

        if (cells.length === 0) {
            return {
                content: [{ type: 'text', text: 'No cells found in workbook.' }],
            };
        }

        const formatted = cells.map(c =>
            `[${c.index}] ${(c.type || 'code').toUpperCase()} (${c.language || 'python'}): ${c.code.substring(0, 50)}${c.code.length > 50 ? '...' : ''}`
        ).join('\n');

        return {
            content: [{
                type: 'text',
                text: `${cells.length} cells:\n${formatted}\n\nFull details:\n${JSON.stringify(cells, null, 2)}`
            }],
        };
    }

    async createCell(args = {}) {
        this.ensureConnected();
        const { code = '', language = 'python', type = 'code' } = args;

        const result = await this.page.evaluate((params) => {
            const { code, language, type } = params;
            const api = window._appInternals;
            if (!api?.createInputCard || !Array.isArray(window._cells)) {
                return { success: false, error: 'SciREPL cell creation API is unavailable' };
            }

            window._cellCounter = (window._cellCounter || window._cells.length) + 1;
            const cellId = window._cellCounter;
            const inputCard = api.createInputCard(code, cellId, type, language);
            const cell = {
                id: cellId,
                code,
                type,
                language,
                name: '',
                lastOutput: '',
                lastOutputHtml: '',
                inputCard,
                outputCard: null,
            };

            if (type === 'markdown') {
                const outputCard = api.createOutputCard(cellId, 'markdown');
                const body = outputCard.querySelector('.card-body');
                if (body) body.innerHTML = api.renderMarkdown(code);
                const pre = inputCard.querySelector('pre');
                if (pre) pre.style.display = 'none';
                cell.outputCard = outputCard;
            }

            window._cells.push(cell);
            if (window.notebookManager?.saveState) window.notebookManager.saveState();
            else if (api.saveCellsToSession) api.saveCellsToSession();
            return { success: true, cellId };
        }, { code, language, type });

        if (!result.success) throw new Error(result.error);

        await this.page.waitForTimeout(500);
        return { content: [{ type: 'text', text: `Cell ${result.cellId} created` }] };
    }

    async deleteCell(args) {
        this.ensureConnected();
        const { cellIndex } = args;

        const deleted = await this.page.evaluate((index) => {
            const cell = window._cells[index];
            if (cell && window.deleteCell) {
                window.deleteCell(cell.id);
                return true;
            }
            return false;
        }, cellIndex);

        if (!deleted) throw new Error(`Cell ${cellIndex} not found or deletion API unavailable`);

        return { content: [{ type: 'text', text: `Cell ${cellIndex} deleted` }] };
    }

    async setCellLanguage(args) {
        this.ensureConnected();
        const { cellIndex, language } = args;

        const updated = await this.page.evaluate((params) => {
            const { index, language } = params;
            const cell = window._cells[index];
            if (cell) {
                cell.language = language;
                if (window.notebookVFS?._updateCellUI) {
                    window.notebookVFS._updateCellUI(index, 'language');
                } else if (cell.inputCard) {
                    const badge = cell.inputCard.querySelector('.lang-badge');
                    if (badge) {
                        badge.textContent = language;
                        badge.className = `lang-badge lang-${language}`;
                    }
                    cell.inputCard.dataset.language = language;
                }
                if (window.notebookManager?.saveState) window.notebookManager.saveState();
                else if (window._appInternals?.saveCellsToSession) window._appInternals.saveCellsToSession();
                return true;
            }
            return false;
        }, { index: cellIndex, language });

        if (!updated) throw new Error(`Cell ${cellIndex} not found`);

        return { content: [{ type: 'text', text: `Cell ${cellIndex} language set to ${language}` }] };
    }

    async openCatalog() {
        this.ensureConnected();
        await this.openMenu();
        await this.page.click('#btn-browse-packages');
        await this.page.waitForTimeout(500);
        return { content: [{ type: 'text', text: 'Catalog opened' }] };
    }

    async listCatalog() {
        this.ensureConnected();
        const packages = await this.page.evaluate(() => {
            if (!window.packageCatalog) return [];
            return window.packageCatalog.packages.map((p, i) => ({
                index: i,
                name: p.name,
                type: p.type,
                version: p.version,
                description: p.description,
                size: p.size,
                kernels: p.kernels,
            }));
        });

        const formatted = packages.map(p =>
            `[${p.index}] ${p.name} (${p.type})${p.version ? ` v${p.version}` : ''} - ${p.description.substring(0, 60)}...`
        ).join('\n');

        return {
            content: [{ type: 'text', text: `${packages.length} items:\n${formatted}` }],
        };
    }

    async installPackage(args) {
        this.ensureConnected();
        const { name, waitForComplete = true } = args;

        // Check SCIREPL_DEV_PACKAGES for local override
        if (this.config.devPackagesDir) {
            const localZip = this._findDevPackage(name);
            if (localZip) {
                return await this.installLocalPackage({ zipPath: localZip, waitForComplete });
            }
        }

        await this.openCatalog();

        // Find package by name
        const packages = await this.page.evaluate(() => {
            return window.packageCatalog.packages.map((p, i) => ({ index: i, name: p.name }));
        });

        const pkg = packages.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!pkg) {
            return {
                content: [{ type: 'text', text: `Package "${name}" not found. Use list_catalog to see available packages.` }],
                isError: true,
            };
        }

        // Click install button
        await this.page.click(`.pkg-install-btn[data-idx="${pkg.index}"]`);

        if (waitForComplete) {
            // Wait for button text to change to "Installed" or "Failed"
            await this.page.waitForFunction((idx) => {
                const btn = document.querySelector(`.pkg-install-btn[data-idx="${idx}"]`);
                return btn && (btn.textContent === 'Installed' || btn.textContent === 'Failed');
            }, pkg.index, { timeout: 60000 });
        }

        return { content: [{ type: 'text', text: `Installing ${name}...` }] };
    }

    async importFile(args) {
        this.ensureConnected();
        const { filePath } = args;

        if (!fs.existsSync(filePath)) {
            return {
                content: [{ type: 'text', text: `File not found: ${filePath}` }],
                isError: true,
            };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.ipynb') {
            await this.page.evaluate((text) => {
                window.fileIO.importIpynb(text);
            }, content);
        } else if (ext === '.srwb') {
            await this.page.evaluate((text) => {
                window.fileIO.importSrwb(text);
            }, content);
        } else {
            return {
                content: [{ type: 'text', text: `Unsupported file type: ${ext}` }],
                isError: true,
            };
        }

        return { content: [{ type: 'text', text: `Imported ${filePath}` }] };
    }

    async exportWorkbook(args) {
        this.ensureConnected();
        const { format = 'srwb', scope = 'current', outputPath } = args;

        // Open export dialog
        await this.openMenu();
        await this.page.click('#btn-export-workbook');
        await this.page.waitForTimeout(500);

        // Select format
        await this.page.click(`input[name="wb-export-format"][value="${format}"]`);

        // Select scope if applicable
        if (scope) {
            await this.page.click(`input[name="wb-export-scope"][value="${scope}"]`);
        }

        const downloadPromise = this.page.waitForEvent('download', { timeout: this.config.timeout });
        await this.page.click('#btn-do-export-workbook');
        const download = await downloadPromise;
        await download.saveAs(outputPath);

        return { content: [{ type: 'text', text: `Workbook exported to ${outputPath}` }] };
    }

    async setSetting(args) {
        this.ensureConnected();
        const { setting, value } = args;

        await this.page.evaluate((params) => {
            const { setting, value } = params;
            localStorage.setItem(setting, value);
        }, { setting, value });

        const displayValue = isSensitiveSettingName(setting) ? '[REDACTED]' : value;
        return { content: [{ type: 'text', text: `Setting ${setting} = ${displayValue}` }] };
    }

    async getSettings() {
        this.ensureConnected();
        const settings = await this.page.evaluate(() => {
            const keys = Object.keys(localStorage).filter(k => k.startsWith('scirepl_'));
            const result = {};
            for (const key of keys) {
                const isSensitive = /(api[_-]?key|token|secret|password|credential|authorization|profiles?)/i.test(key);
                result[key] = isSensitive ? '[REDACTED]' : localStorage.getItem(key);
            }
            return result;
        });

        const formatted = Object.entries(settings)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');

        return { content: [{ type: 'text', text: `Settings:\n${formatted}` }] };
    }

    async acceptPrivacy() {
        this.ensureConnected();
        await this.page.evaluate(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
        });
        return { content: [{ type: 'text', text: 'Privacy policy accepted' }] };
    }

    async getKernelStatus() {
        this.ensureConnected();
        const status = await this.page.evaluate(() => {
            return window.kernelManager.getLanguageInfo();
        });

        const formatted = status.map(k =>
            `${k.name} (${k.id}): ${k.ready ? 'ready' : 'not loaded'}`
        ).join('\n');

        return { content: [{ type: 'text', text: `Kernels:\n${formatted}` }] };
    }

    async openMenu() {
        this.ensureConnected();
        await this.page.waitForSelector('#menu-btn', { timeout: 10000 });
        await this.page.click('#menu-btn');
        await this.page.waitForFunction(() => {
            const menu = document.querySelector('#menu-modal, .modal:not(.hidden)');
            const buttons = Array.from(document.querySelectorAll('button'));
            return !!menu || buttons.some(btn => (btn.textContent || '').includes('Run All Cells'));
        }, null, { timeout: 10000 });
        return { content: [{ type: 'text', text: 'Menu opened' }] };
    }

    async closeModal() {
        this.ensureConnected();
        // Close any open modal
        await this.page.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
        });
        return { content: [{ type: 'text', text: 'Modals closed' }] };
    }

    async getVisibleState() {
        this.ensureConnected();
        const state = await this.page.evaluate(() => {
            const visibleModals = Array.from(document.querySelectorAll('.modal, [role="dialog"]'))
                .filter(el => {
                    const style = window.getComputedStyle(el);
                    return !el.classList.contains('hidden') && style.display !== 'none' && style.visibility !== 'hidden';
                })
                .map(el => ({
                    id: el.id || null,
                    heading: el.querySelector('h1, h2, h3')?.textContent?.trim() || null,
                    text: (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 300),
                }));

            const cells = Array.isArray(window._cells) ? window._cells.map((c, i) => {
                const outputHtml = c.lastOutputHtml ?? c.outputHtml ?? '';
                const outputText = c.lastOutput ?? c.outputText ?? '';
                const card = c.outputCard || document.querySelector(`.card-output[data-cell-id="${c.id}"]`) || null;
                const body = card?.querySelector('.card-body') || null;
                const preview = outputHtml
                    ? String(outputHtml).replace(/<[^>]+>/g, ' ')
                    : String(outputText);
                return {
                    index: i,
                    type: c.cellType || c.type || 'code',
                    language: c.language || 'python',
                    hasOutput: !!(String(outputHtml).length || String(outputText).length || body?.innerText),
                    outputPreview: preview.replace(/\s+/g, ' ').trim().substring(0, 160),
                    domOutLabel: card?.querySelector('.card-label span:last-child')?.textContent?.trim() || null,
                    domOutputPreview: body?.innerText?.replace(/\s+/g, ' ').trim().substring(0, 160) || '',
                };
            }) : [];

            const buttons = Array.from(document.querySelectorAll('button'))
                .map(btn => (btn.textContent || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, 50);

            return {
                title: document.title,
                readyText: document.body.innerText.includes('ready'),
                visibleModals,
                cells,
                buttons,
            };
        });

        const recentLogs = this.consoleLogs.slice(-20);
        return {
            content: [{
                type: 'text',
                text: `Visible state from the MCP-controlled sciREPL browser:\n${JSON.stringify(state, null, 2)}\n\nRecent console logs:\n${recentLogs.length ? recentLogs.join('\n') : '(none)'}`,
            }],
        };
    }

    async getBrowserDebugInfo() {
        this.ensureConnected();

        const pageInfo = await this.page.evaluate(() => {
            const serviceWorkers = ('serviceWorker' in navigator && navigator.serviceWorker)
                ? (navigator.serviceWorker.getRegistrations ? navigator.serviceWorker.getRegistrations().then(regs => regs.map(r => ({
                    scope: r.scope,
                    active: !!r.active,
                    waiting: !!r.waiting,
                    installing: !!r.installing,
                }))) : Promise.resolve([]))
                : Promise.resolve([]);

            return Promise.all([
                Promise.resolve({
                    url: location.href,
                    title: document.title,
                    readyState: document.readyState,
                    localStorageKeys: Object.keys(localStorage),
                    sessionStorageKeys: Object.keys(sessionStorage),
                    workerSupport: typeof Worker !== 'undefined',
                }),
                serviceWorkers,
            ]).then(([page, workers]) => ({ ...page, serviceWorkers: workers }));
        });

        const browserDebugUrl = this.activeBrowserUrl || null;
        return {
            content: [{
                type: 'text',
                text: `Browser debug info for the MCP-controlled sciREPL session:\n${JSON.stringify({
                    debugMode: this.activeDebugMode,
                    browserDebugUrl,
                    page: pageInfo,
                    recentConsoleLogs: this.consoleLogs.slice(-20),
                }, null, 2)}`,
            }],
        };
    }

    async getCellOutputsDetailed(args = {}) {
        this.ensureConnected();
        const { includeDomText = true, maxOutputChars = 4000, warningOnly = false } = args;

        const details = await this.page.evaluate((opts) => {
            const { includeDomText, maxOutputChars, warningOnly } = opts;
            const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const toText = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const truncate = (text) => text.length > maxOutputChars ? text.substring(0, maxOutputChars) : text;
            const warningRegex = /(warning|error|fail|exception|undefined)/i;

            const cells = Array.isArray(window._cells) ? window._cells : [];

            const results = cells.map((c, i) => {
                const card = c.outputCard || document.querySelector(`.card-output[data-cell-id="${c.id}"]`) || null;
                const labelText = card?.querySelector('.card-label span:last-child')?.textContent?.trim() || null;
                const body = card?.querySelector('.card-body') || null;
                const domText = includeDomText ? truncate(normalizeText(body?.innerText || '')) : '';
                const outputHtml = c.lastOutputHtml ?? c.outputHtml ?? '';
                const outputText = c.lastOutput ?? c.outputText ?? '';
                const modelText = truncate(outputHtml ? toText(outputHtml) : normalizeText(outputText));

                const extraTextCandidates = [
                    outputText,
                    c.stdout,
                    c.stderr,
                    typeof c.result === 'string' ? c.result : c.result?.content,
                    c.error,
                ].map(v => truncate(normalizeText(v || ''))).filter(Boolean);

                const combinedText = [labelText, modelText, domText, ...extraTextCandidates].filter(Boolean).join('\n');
                const hasWarning = warningRegex.test(combinedText);

                return {
                    index: i,
                    id: c.id || null,
                    type: c.cellType || c.type || 'code',
                    language: c.language || 'python',
                    name: c.name || '',
                    codePreview: String(c.code || '').substring(0, 160),
                    hasOutputHtml: !!String(outputHtml).length,
                    rawOutputHtml: truncate(String(outputHtml)),
                    modelOutputText: modelText,
                    domOutputLabel: labelText,
                    domOutputText: domText,
                    extraTextCandidates,
                    hasWarning,
                };
            });

            return warningOnly ? results.filter(r => r.hasWarning) : results;
        }, { includeDomText, maxOutputChars, warningOnly });

        return {
            content: [{
                type: 'text',
                text: `Detailed cell output inspection from the MCP-controlled sciREPL browser:\n${JSON.stringify(details, null, 2)}`,
            }],
        };
    }

    async getSharedFiles(args = {}) {
        this.ensureConnected();
        const { path: vfsPath = '/shared/' } = args;

        const files = await this.page.evaluate((p) => {
            if (!window.sharedVFS) return [];
            const allFiles = [];
            for (const [key, entry] of window.sharedVFS._files) {
                if (key.startsWith(p)) {
                    allFiles.push({
                        path: key,
                        size: entry.size,
                        origin: entry.origin,
                    });
                }
            }
            return allFiles;
        }, vfsPath);

        const formatted = files.map(f => `${f.path} (${f.size}b)`).join('\n');
        return { content: [{ type: 'text', text: `${files.length} files:\n${formatted}` }] };
    }

    async waitForText(args) {
        this.ensureConnected();
        const { text, timeout = 30000 } = args;
        await this.page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
        return { content: [{ type: 'text', text: `Text "${text}" found on page` }] };
    }

    async takeScreenshot(args) {
        this.ensureConnected();
        const { outputPath } = args;
        await this.page.screenshot({ path: outputPath, fullPage: true });
        return { content: [{ type: 'text', text: `Screenshot saved to ${outputPath}` }] };
    }

    // ==================== Local Package & VFS Tools ====================

    /**
     * Install a package from a local zip file.
     * Reads the zip, sends it to the browser as base64, and invokes the package loader.
     */
    async installLocalPackage(args) {
        this.ensureConnected();
        const { zipPath, waitForComplete = true } = args;

        if (!fs.existsSync(zipPath)) {
            return {
                content: [{ type: 'text', text: `File not found: ${zipPath}` }],
                isError: true,
            };
        }

        const zipBuffer = fs.readFileSync(zipPath);
        const base64 = zipBuffer.toString('base64');
        const fileName = path.basename(zipPath);

        const result = await this.page.evaluate(async (params) => {
            const { base64, fileName } = params;
            try {
                // Decode base64 to ArrayBuffer
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }

                // Create a File object (packageLoader.loadFromFile expects this)
                const file = new File([bytes], fileName, { type: 'application/zip' });

                // Use the package loader (primary API)
                if (window.packageLoader && typeof window.packageLoader.loadFromFile === 'function') {
                    const result = await window.packageLoader.loadFromFile(file);
                    return { success: true, method: 'loadFromFile', notebooks: result?.notebooks?.length || 0 };
                }

                return { success: false, error: 'window.packageLoader.loadFromFile not available' };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }, { base64, fileName });

        if (!result.success) {
            return {
                content: [{ type: 'text', text: `Failed to install local package: ${result.error}` }],
                isError: true,
            };
        }

        return {
            content: [{ type: 'text', text: `Installed local package from ${zipPath} (method: ${result.method})` }],
        };
    }

    /**
     * Write a single local file into the SciREPL VFS.
     */
    async vfsWrite(args) {
        this.ensureConnected();
        const { localPath, vfsPath, target } = args;

        if (!fs.existsSync(localPath)) {
            return {
                content: [{ type: 'text', text: `File not found: ${localPath}` }],
                isError: true,
            };
        }

        const content = fs.readFileSync(localPath, 'utf-8');
        const vfsTarget = target || (localPath.endsWith('.pl') ? 'prolog' : 'shared');

        const result = await this.page.evaluate((params) => {
            const { content, vfsPath, vfsTarget } = params;
            try {
                if (vfsTarget === 'prolog') {
                    // Write to Emscripten FS (Prolog kernel)
                    const prolog = window.prologVFS?._prolog || window.kernelManager?._instances?.prolog?._prolog;
                    if (!prolog || !prolog.FS) {
                        return { success: false, error: 'Prolog Emscripten FS not available. Is the Prolog kernel loaded?' };
                    }
                    // Ensure parent directories exist
                    const parts = vfsPath.split('/').filter(Boolean);
                    let current = '';
                    for (let i = 0; i < parts.length - 1; i++) {
                        current += '/' + parts[i];
                        try { prolog.FS.mkdir(current); } catch (e) { /* already exists */ }
                    }
                    prolog.FS.writeFile(vfsPath, content);
                    return { success: true, target: 'prolog', path: vfsPath, size: content.length };
                } else {
                    // Write to SharedVFS
                    if (window.sharedVFS) {
                        window.sharedVFS.writeFile(vfsPath, content);
                        return { success: true, target: 'shared', path: vfsPath, size: content.length };
                    }
                    return { success: false, error: 'SharedVFS not available' };
                }
            } catch (e) {
                return { success: false, error: e.message };
            }
        }, { content, vfsPath, vfsTarget });

        if (!result.success) {
            return {
                content: [{ type: 'text', text: `VFS write failed: ${result.error}` }],
                isError: true,
            };
        }

        return {
            content: [{ type: 'text', text: `Wrote ${result.size} bytes to ${result.target} VFS at ${result.path}` }],
        };
    }

    /**
     * Overlay an entire local directory into the VFS.
     */
    async vfsOverlayDir(args) {
        this.ensureConnected();
        const { localDir, vfsBasePath, glob: globPattern } = args;

        if (!fs.existsSync(localDir)) {
            return {
                content: [{ type: 'text', text: `Directory not found: ${localDir}` }],
                isError: true,
            };
        }

        const files = this._walkDir(localDir, globPattern);
        const results = [];

        for (const relPath of files) {
            const localPath = path.join(localDir, relPath);
            const vfsPath = vfsBasePath.replace(/\/+$/, '') + '/' + relPath.replace(/\\/g, '/');
            const content = fs.readFileSync(localPath, 'utf-8');
            const vfsTarget = localPath.endsWith('.pl') ? 'prolog' : 'shared';

            const result = await this.page.evaluate((params) => {
                const { content, vfsPath, vfsTarget } = params;
                try {
                    if (vfsTarget === 'prolog') {
                        const prolog = window.prologVFS?._prolog || window.kernelManager?._instances?.prolog?._prolog;
                        if (!prolog || !prolog.FS) return { success: false, error: 'Prolog FS not available' };
                        const parts = vfsPath.split('/').filter(Boolean);
                        let current = '';
                        for (let i = 0; i < parts.length - 1; i++) {
                            current += '/' + parts[i];
                            try { prolog.FS.mkdir(current); } catch (e) { /* exists */ }
                        }
                        prolog.FS.writeFile(vfsPath, content);
                        return { success: true };
                    } else {
                        if (window.sharedVFS) {
                            window.sharedVFS.writeFile(vfsPath, content);
                            return { success: true };
                        }
                        return { success: false, error: 'SharedVFS not available' };
                    }
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }, { content, vfsPath, vfsTarget });

            results.push({ path: vfsPath, success: result.success, error: result.error });
        }

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success);
        let text = `Overlaid ${succeeded}/${results.length} files from ${localDir} to ${vfsBasePath}`;
        if (failed.length > 0) {
            text += `\nFailed:\n${failed.map(f => `  ${f.path}: ${f.error}`).join('\n')}`;
        }

        return { content: [{ type: 'text', text }] };
    }

    /**
     * List files in the Prolog Emscripten VFS at a given path.
     */
    async vfsList(args) {
        this.ensureConnected();
        const { vfsPath, recursive = false } = args;

        const result = await this.page.evaluate((params) => {
            const { vfsPath, recursive } = params;
            try {
                const prolog = window.prologVFS?._prolog || window.kernelManager?._instances?.prolog?._prolog;
                if (!prolog || !prolog.FS) return { success: false, error: 'Prolog FS not available' };

                const listDir = (dirPath, recurse) => {
                    const entries = [];
                    try {
                        const items = prolog.FS.readdir(dirPath).filter(n => n !== '.' && n !== '..');
                        for (const name of items) {
                            const fullPath = dirPath.replace(/\/+$/, '') + '/' + name;
                            try {
                                const stat = prolog.FS.stat(fullPath);
                                const isDir = prolog.FS.isDir(stat.mode);
                                entries.push({ path: fullPath, isDir, size: isDir ? 0 : stat.size });
                                if (isDir && recurse) {
                                    entries.push(...listDir(fullPath, true));
                                }
                            } catch (e) {
                                entries.push({ path: fullPath, error: e.message });
                            }
                        }
                    } catch (e) {
                        return [{ path: dirPath, error: e.message }];
                    }
                    return entries;
                };

                return { success: true, entries: listDir(vfsPath, recursive) };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }, { vfsPath, recursive });

        if (!result.success) {
            return {
                content: [{ type: 'text', text: `VFS list failed: ${result.error}` }],
                isError: true,
            };
        }

        const formatted = result.entries.map(e =>
            e.error ? `${e.path} (ERROR: ${e.error})` :
            e.isDir ? `${e.path}/` : `${e.path} (${e.size}b)`
        ).join('\n');

        return {
            content: [{ type: 'text', text: `${result.entries.length} entries at ${vfsPath}:\n${formatted}` }],
        };
    }

    // ==================== Helpers ====================

    /**
     * Find a dev package zip by name in the SCIREPL_DEV_PACKAGES directory.
     * Matches by package name (case-insensitive, spaces to underscores).
     */
    _findDevPackage(name) {
        const dir = this.config.devPackagesDir;
        if (!dir || !fs.existsSync(dir)) return null;

        const normalized = name.toLowerCase().replace(/\s+/g, '_');
        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.toLowerCase().endsWith('.zip') &&
                    entry.toLowerCase().replace('.zip', '').includes(normalized)) {
                    return path.join(dir, entry);
                }
            }
        } catch (e) {
            // Directory read error
        }
        return null;
    }

    /**
     * Recursively walk a directory and return relative paths.
     * Optional glob filter supporting *, **, and ?.
     */
    _walkDir(dir, globPattern) {
        const results = [];
        const walk = (currentDir, relBase) => {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const relPath = relBase ? relBase + '/' + entry.name : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(currentDir, entry.name), relPath);
                } else {
                    if (globPattern && !this._matchesGlob(relPath, globPattern)) continue;
                    results.push(relPath);
                }
            }
        };
        walk(dir, '');
        return results;
    }

    _matchesGlob(relPath, globPattern) {
        const pattern = String(globPattern).replace(/\\/g, '/');
        let source = '^';
        for (let i = 0; i < pattern.length; i++) {
            const char = pattern[i];
            if (char === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
                source += '(?:.*/)?';
                i += 2;
            } else if (char === '*' && pattern[i + 1] === '*') {
                source += '.*';
                i += 1;
            } else if (char === '*') {
                source += '[^/]*';
            } else if (char === '?') {
                source += '[^/]';
            } else {
                source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
            }
        }
        return new RegExp(source + '$').test(String(relPath).replace(/\\/g, '/'));
    }

    validateToolArguments(name, args) {
        const tool = this.getToolDefinitions().find(candidate => candidate.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);

        const value = args == null ? {} : args;
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`Arguments for ${name} must be an object`);
        }

        const schema = tool.inputSchema || { properties: {} };
        for (const required of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, required) || value[required] === undefined) {
                throw new Error(`Missing required argument: ${required}`);
            }
        }

        for (const [key, argument] of Object.entries(value)) {
            const property = schema.properties?.[key];
            if (!property || argument === undefined) continue;
            if (property.type === 'string' && typeof argument !== 'string') {
                throw new Error(`Argument ${key} must be a string`);
            }
            if (property.type === 'boolean' && typeof argument !== 'boolean') {
                throw new Error(`Argument ${key} must be a boolean`);
            }
            if (property.type === 'number' && (typeof argument !== 'number' || !Number.isFinite(argument))) {
                throw new Error(`Argument ${key} must be a finite number`);
            }
            if (property.type === 'integer' && !Number.isSafeInteger(argument)) {
                throw new Error(`Argument ${key} must be an integer`);
            }
            if (property.enum && !property.enum.includes(argument)) {
                throw new Error(`Argument ${key} must be one of: ${property.enum.join(', ')}`);
            }
            if (typeof argument === 'number' && property.minimum !== undefined && argument < property.minimum) {
                throw new Error(`Argument ${key} must be at least ${property.minimum}`);
            }
            if (typeof argument === 'number' && property.maximum !== undefined && argument > property.maximum) {
                throw new Error(`Argument ${key} must be at most ${property.maximum}`);
            }
        }

        return value;
    }

    ensureConnected() {
        if (!this.isConnected || !this.page) {
            throw new Error('Not connected to sciREPL. Call scirepl_connect first.');
        }
    }
}

module.exports = {
    DEFAULT_CONFIG,
    SCIREPL_LANGUAGES,
    SERVER_VERSION,
    SciREPLMCP,
    isSensitiveSettingName,
};

if (require.main === module) {
    const mcp = new SciREPLMCP();
    mcp.start().catch(err => {
        console.error('Failed to start MCP server:', err);
        process.exit(1);
    });
}
