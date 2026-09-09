#!/usr/bin/env node

// Keep this bootstrap compatible with pre-Node-20 runtimes. The setup
// implementation and its imported modules intentionally use current syntax,
// so checking here is the only way to give an actionable version error before
// those files are parsed.
const path = require('path');
const { spawnSync } = require('child_process');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    console.error('[setup] error: Node.js 20 or newer is required (found ' +
        process.versions.node + '); select Node 22 first, for example with: nvm use 22');
    process.exitCode = 1;
} else {
    const implementation = path.join(__dirname, 'setup.mjs');
    const result = spawnSync(process.execPath, [implementation].concat(process.argv.slice(2)), {
        stdio: 'inherit',
        shell: false,
    });
    if (result.error) {
        console.error('[setup] error: ' + (result.error.message || result.error));
        process.exitCode = 1;
    } else {
        process.exitCode = typeof result.status === 'number' ? result.status : 1;
    }
}
