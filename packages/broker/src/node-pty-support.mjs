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
