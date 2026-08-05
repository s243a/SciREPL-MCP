'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SciREPLMCP } = require('../src/server.cjs');

test('connects to a real SciREPL page', { timeout: 90000 }, async () => {
    const url = process.env.SCIREPL_E2E_URL;
    assert.ok(url, 'SCIREPL_E2E_URL must name a SciREPL page');

    const mcp = new SciREPLMCP({ headless: true, timeout: 60000 });
    try {
        const connected = await mcp.connect({ url });
        assert.match(connected.content[0].text, /Connected to sciREPL/);

        const kernels = await mcp.getKernelStatus();
        assert.match(kernels.content[0].text, /Kernels:/);

        const menu = await mcp.openMenu();
        assert.match(menu.content[0].text, /Menu opened/);
        await mcp.closeModal();

        const created = await mcp.handleToolCall('scirepl_create_cell', {
            code: '"SCIREPL_MCP_SMOKE_42"',
            language: 'javascript',
            type: 'code',
        });
        assert.equal(created.isError, undefined);

        const run = await mcp.handleToolCall('scirepl_run_all_cells_ui', {
            waitForOutput: true,
            timeout: 30000,
        });
        assert.equal(run.isError, undefined);

        const outputs = await mcp.getCellOutputsDetailed({ maxOutputChars: 1000 });
        assert.match(outputs.content[0].text, /SCIREPL_MCP_SMOKE_42/);

        const deleted = await mcp.handleToolCall('scirepl_delete_cell', { cellIndex: 0 });
        assert.equal(deleted.isError, undefined);
    } finally {
        await mcp.disconnect();
    }
});
