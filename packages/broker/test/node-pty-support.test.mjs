#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNodePty } from '../src/node-pty-support.mjs';

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

console.log('node-pty platform preparation — deterministic tests\n');

const tempRoot = fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp');
const root = fs.mkdtempSync(path.join(tempRoot, 'scirepl-node-pty-'));
const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
fs.mkdirSync(path.dirname(helper), { recursive: true });
fs.writeFileSync(helper, 'fixture');

if (process.platform === 'win32') {
    const result = prepareNodePty({ platform: 'win32', arch: 'arm64', nodePtyDirectory: root });
    ok(result.status === 'not-darwin', 'native Windows remains untouched');
} else {
    fs.chmodSync(helper, 0o644);
    const repaired = prepareNodePty({ platform: 'darwin', arch: 'arm64', nodePtyDirectory: root });
    ok(repaired.status === 'repaired' && (fs.statSync(helper).mode & 0o111) !== 0,
        'macOS prebuilt spawn-helper receives execute permission');

    const mode = fs.statSync(helper).mode & 0o777;
    const ready = prepareNodePty({ platform: 'darwin', arch: 'arm64', nodePtyDirectory: root });
    ok(ready.status === 'ready' && (fs.statSync(helper).mode & 0o777) === mode,
        'macOS preparation is idempotent');

    fs.chmodSync(helper, 0o644);
    const linux = prepareNodePty({ platform: 'linux', arch: 'arm64', nodePtyDirectory: root });
    ok(linux.status === 'not-darwin' && (fs.statSync(helper).mode & 0o777) === 0o644,
        'Linux dependency files remain untouched');
}

const absent = prepareNodePty({ platform: 'darwin', arch: 'x64', nodePtyDirectory: root });
ok(absent.status === 'no-prebuilt-helper', 'source builds and absent prebuilds require no repair');

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
