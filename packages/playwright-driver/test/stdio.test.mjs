import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../src/server.cjs');

test('initializes over stdio and lists tools without launching a browser', { timeout: 15000 }, async () => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        stderr: 'pipe',
    });
    const client = new Client({ name: 'scirepl-driver-test', version: '1.0.0' });

    try {
        await client.connect(transport);
        const result = await client.listTools();
        assert.equal(result.tools.length, 31);
        assert.ok(result.tools.some(tool => tool.name === 'scirepl_connect'));
        assert.ok(result.tools.some(tool => tool.name === 'scirepl_vfs_overlay_dir'));
    } finally {
        await client.close();
    }
});
