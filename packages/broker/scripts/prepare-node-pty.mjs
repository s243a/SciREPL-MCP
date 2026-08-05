#!/usr/bin/env node

import { prepareNodePty } from '../src/node-pty-support.mjs';

try {
    const result = prepareNodePty();
    if (result.status === 'repaired') {
        console.log('[setup] restored execute permission on node-pty\'s macOS spawn-helper');
    }
} catch (error) {
    console.error(`[setup] unable to prepare node-pty: ${error.message || error}`);
    process.exit(1);
}
