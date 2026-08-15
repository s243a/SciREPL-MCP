#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (process.env.RUN_PAIRED_APP_E2E !== '1') {
    console.log('SKIP: set RUN_PAIRED_APP_E2E=1 for the paired SciREPL Pro bench.');
    process.exit(0);
}

const required = [
    'SCIREPL_MCP_URL',
    'SCIREPL_MCP_BEARER',
    'SCIREPL_WORKBOOK_ROOT',
    'SCIREPL_WORKBOOK_RELATIVE_PATH',
    'SCIREPL_WORKBOOK_HOST_PATH',
];
for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required for the paired-app bench`);
}
if (process.env.SCIREPL_PAIRED_CLOCK_FROZEN !== '1') {
    throw new Error(
        'SCIREPL_PAIRED_CLOCK_FROZEN=1 is required after freezing Date in the paired app page; '
        + 'both canonical serializers embed an export timestamp, so sequential calls are otherwise intentionally different');
}

const format = process.env.SCIREPL_WORKBOOK_FORMAT || 'srwb';
const transport = new StreamableHTTPClientTransport(new URL(process.env.SCIREPL_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.SCIREPL_MCP_BEARER}` } },
});
const client = new Client({ name: 'scirepl-workbook-paired-bench', version: '0.0.0' });
await client.connect(transport);

try {
    const relocated = await client.callTool({
        name: 'export_workbook_to_file',
        arguments: {
            format,
            root: process.env.SCIREPL_WORKBOOK_ROOT,
            path: process.env.SCIREPL_WORKBOOK_RELATIVE_PATH,
            overwrite: false,
        },
    });
    if (relocated.isError) throw new Error(relocated.content?.[0]?.text || 'relocated export failed');
    const receipt = JSON.parse(relocated.content[0].text);

    const direct = await client.callTool({ name: 'export_workbook', arguments: { format } });
    if (direct.isError) throw new Error(direct.content?.[0]?.text || 'direct export failed');
    const envelope = JSON.parse(direct.content[0].text);
    const fileBytes = fs.readFileSync(process.env.SCIREPL_WORKBOOK_HOST_PATH);
    const directBytes = Buffer.from(envelope.content, 'utf8');
    const digest = crypto.createHash('sha256').update(fileBytes).digest('hex');

    if (!fileBytes.equals(directBytes)) throw new Error('relocated file differs byte-for-byte from the direct app export');
    if (receipt.size !== fileBytes.length || receipt.sha256 !== digest || envelope.sha256 !== digest) {
        throw new Error('receipt, app envelope, and raw file digest do not agree');
    }
    console.log(JSON.stringify({ ok: true, format, size: fileBytes.length, sha256: digest }));
} finally {
    await transport.close();
}
