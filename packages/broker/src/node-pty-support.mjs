import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function installedNodePtyDirectory() {
    try {
        return path.dirname(require.resolve('node-pty/package.json'));
    } catch (_) {
        return null;
    }
}

function nodePtySpawn() {
    const pty = require('node-pty');
    const spawn = typeof pty.spawn === 'function' ? pty.spawn : pty.default?.spawn;
    if (typeof spawn !== 'function') throw new Error('node-pty.spawn is not a function');
    return spawn;
}

/**
 * Load the native addon and spawn a throwaway PTY. Resolving the package path
 * is not enough: a broken prebuild can still be "installed".
 */
export function nodePtyUsable() {
    try {
        const spawn = nodePtySpawn();
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
            name: 'xterm-256color',
            cols: 2,
            rows: 2,
            cwd: process.cwd(),
            env: process.env,
        });
        try { child.kill(); } catch (_) {}
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * node-pty 1.1.0's macOS prebuilds package spawn-helper without an executable
 * bit. Restoring that bit is narrowly scoped to the helper selected on Darwin;
 * source builds and every other platform are left untouched.
 */
export function prepareNodePty({
    platform = process.platform,
    arch = process.arch,
    nodePtyDirectory = installedNodePtyDirectory(),
} = {}) {
    if (platform !== 'darwin') return { status: 'not-darwin' };
    if (!nodePtyDirectory) return { status: 'not-installed' };

    const helper = path.join(nodePtyDirectory, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (!fs.existsSync(helper)) return { status: 'no-prebuilt-helper' };

    const stat = fs.lstatSync(helper);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`refusing unexpected node-pty spawn-helper path: ${helper}`);
    }

    const mode = stat.mode & 0o777;
    if ((mode & 0o111) !== 0) return { status: 'ready', helper };
    fs.chmodSync(helper, mode | 0o111);
    return { status: 'repaired', helper };
}
