/**
 * Windows-aware process launch and stdio-close finalization.
 *
 * Node's spawn() cannot execute npm-style .cmd shims even when PATH/PATHEXT
 * are present. cross-spawn resolves PATHEXT and invokes cmd.exe with escaped
 * arguments (not shell:true), so prompts with metacharacters stay literal.
 */
import { createRequire } from 'node:module';
import { configureUtf8Pipes } from './utf8-pipes.mjs';

const require = createRequire(import.meta.url);
const crossSpawn = require('cross-spawn');

export function spawnChildProcess(command, args = [], options = {}) {
    return crossSpawn(command, args, options);
}

export function spawnUtf8Child(command, args, options) {
    const child = spawnChildProcess(command, args, options);
    configureUtf8Pipes(child);
    return child;
}

/**
 * Record exit status, then invoke onClose once after stdio has closed.
 * Spawn failures are reported once and suppress the later close callback.
 */
export function finalizeAfterStdioClose(child, { onClose, onSpawnError } = {}) {
    let exitCode = null;
    let finalized = false;
    let spawnFailed = false;
    child.once('exit', (code) => { exitCode = code; });
    child.once('error', (err) => {
        if (finalized || spawnFailed) return;
        spawnFailed = true;
        finalized = true;
        onSpawnError?.(err);
    });
    child.once('close', () => {
        if (finalized || spawnFailed) return;
        finalized = true;
        onClose?.(exitCode);
    });
    return child;
}
