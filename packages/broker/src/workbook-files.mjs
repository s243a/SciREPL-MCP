/**
 * Broker-owned workbook file transfer.
 *
 * This module deliberately knows nothing about MCP transports.  It validates
 * the immutable host allowlist, exposes the two synthetic tool definitions,
 * and relocates bytes between an allowlisted file and SciREPL's app-side
 * workbook tools.  The caller remains responsible for mapping thrown errors to
 * MCP's isError response shape.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { TextDecoder, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const APP_WORKBOOK_MAX_BYTES = 8_388_608;

// 5 * 8 MiB + 64 KiB.  An app export is JSON, then a string inside the /app
// result JSON.  Requiring this worst-case v1 budget prevents the socket from
// closing before the broker gets a chance to inspect decoded content.
export const REQUIRED_APP_WS_PAYLOAD_BYTES = 42_008_576;

const CONFIG_MAX_BYTES = 1_048_576;
const TOOL_PATH_MAX_BYTES = 1024;
const TOOL_PATH_COMPONENT_MAX_BYTES = 255;
const STREAM_CHUNK_BYTES = 64 * 1024;
const SYNTHETIC_EXPORT = 'export_workbook_to_file';
const SYNTHETIC_IMPORT = 'import_workbook_from_file';
const BASE_EXPORT = 'export_workbook';
const BASE_IMPORT = 'import_workbook';
const ROOT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_INPUT_RE = /^[0-9a-fA-F]{64}$/;
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9]|com[\u00b9\u00b2\u00b3]|lpt[\u00b9\u00b2\u00b3])(?:\.|$)/i;
// Public paths and call bindings appear in receipts and one-line JSON audit
// records. Reject controls, bidi controls, line separators, and unpaired UTF-16
// surrogates so the claimed path is byte-faithful and cannot split or reorder
// the evidence. Ordinary international letters, combining marks, ZWJ/ZWNJ, and
// symbols remain valid.
const UNSAFE_PUBLIC_TEXT_RE = /[\p{Cc}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const GIT_ENV = { ...process.env };
for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
]) delete GIT_ENV[key];
for (const key of Object.keys(GIT_ENV)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete GIT_ENV[key];
}
Object.assign(GIT_ENV, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
});
Object.freeze(GIT_ENV);

class WorkbookFileTransferError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WorkbookFileTransferError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new WorkbookFileTransferError(code, message);
}

function isOwnObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownKeysExactly(value, allowed, context) {
    if (!isOwnObject(value)) fail(`INVALID_${context}`, `${context} must be a JSON object`);
    const allowedSet = new Set(allowed);
    if (Object.keys(value).some(key => !allowedSet.has(key))) {
        fail(`INVALID_${context}`, `${context} contains unsupported fields`);
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}

function sameStableFile(a, b) {
    return sameIdentity(a, b)
        && a.size === b.size
        && a.mtimeNs === b.mtimeNs
        && a.ctimeNs === b.ctimeNs;
}

function portablePathEqual(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function isPathInside(parent, candidate, includeParent = true) {
    const parentPath = path.resolve(parent);
    const candidatePath = path.resolve(candidate);
    if (portablePathEqual(parentPath, candidatePath)) return includeParent;
    let relative = path.relative(parentPath, candidatePath);
    if (process.platform === 'win32') relative = relative.toLowerCase();
    return relative !== ''
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function safeRealpathSync(target, failureCode, message) {
    try {
        return fs.realpathSync.native(target);
    } catch (_) {
        fail(failureCode, message);
    }
}

function safeLstatSync(target, options, failureCode, message) {
    try {
        return fs.lstatSync(target, options);
    } catch (_) {
        fail(failureCode, message);
    }
}

function decodeUtf8Fatal(bytes, code, message) {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (_) {
        fail(code, message);
    }
}

function readConfigSnapshot(configPath) {
    if (typeof configPath !== 'string' || !configPath || !path.isAbsolute(configPath)) {
        fail('INVALID_CONFIG', 'Workbook file configuration must name an absolute regular file');
    }

    const initial = safeLstatSync(
        configPath, { bigint: true }, 'INVALID_CONFIG',
        'Workbook file configuration is not an accessible regular file');
    if (initial.isSymbolicLink() || !initial.isFile()) {
        fail('INVALID_CONFIG', 'Workbook file configuration must be a non-link regular file');
    }
    if (initial.size > BigInt(CONFIG_MAX_BYTES)) {
        fail('INVALID_CONFIG', 'Workbook file configuration exceeds the safety limit');
    }

    let fd;
    try {
        fd = fs.openSync(configPath, fs.constants.O_RDONLY | NOFOLLOW);
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameStableFile(initial, opened)) {
            fail('INVALID_CONFIG', 'Workbook file configuration changed while opening');
        }
        const bytes = fs.readFileSync(fd);
        const final = fs.fstatSync(fd, { bigint: true });
        if (!sameStableFile(opened, final) || BigInt(bytes.byteLength) !== opened.size) {
            fail('INVALID_CONFIG', 'Workbook file configuration changed while reading');
        }
        return {
            parsedText: decodeUtf8Fatal(
                bytes, 'INVALID_CONFIG',
                'Workbook file configuration is not valid UTF-8'),
            realPath: safeRealpathSync(
                configPath, 'INVALID_CONFIG',
                'Workbook file configuration cannot be resolved safely'),
        };
    } catch (error) {
        if (error instanceof WorkbookFileTransferError) throw error;
        fail('INVALID_CONFIG', 'Workbook file configuration cannot be read safely');
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function parseConfig(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch (_) {
        fail('INVALID_CONFIG', 'Workbook file configuration is not valid JSON');
    }
    ownKeysExactly(value, ['schemaVersion', 'maxContentBytes', 'roots'], 'CONFIG');
    if (value.schemaVersion !== 1) {
        fail('INVALID_CONFIG', 'Workbook file configuration schemaVersion must be 1');
    }
    if (!Number.isSafeInteger(value.maxContentBytes)
        || value.maxContentBytes <= 0
        || value.maxContentBytes > APP_WORKBOOK_MAX_BYTES) {
        fail('INVALID_CONFIG', `Workbook maxContentBytes must be from 1 to ${APP_WORKBOOK_MAX_BYTES}`);
    }
    if (!Array.isArray(value.roots) || value.roots.length === 0) {
        fail('INVALID_CONFIG', 'Workbook file configuration roots must be a non-empty array');
    }
    return value;
}

function absoluteComponents(absolutePath) {
    const resolved = path.resolve(absolutePath);
    const parsed = path.parse(resolved);
    const tail = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    const components = [];
    let cursor = parsed.root;
    for (const part of tail) {
        cursor = path.join(cursor, part);
        components.push(cursor);
    }
    return components;
}

function validateConfiguredRoot(rootValue, names) {
    ownKeysExactly(
        rootValue,
        ['name', 'path', 'read', 'write', 'allowOverwrite', 'denyGitIgnoredWrites'],
        'ROOT');
    if (typeof rootValue.name !== 'string' || !ROOT_NAME_RE.test(rootValue.name)) {
        fail('INVALID_CONFIG', 'Workbook root name does not match the required portable grammar');
    }
    if (names.has(rootValue.name)) fail('INVALID_CONFIG', 'Workbook root names must be unique');
    names.add(rootValue.name);

    if (typeof rootValue.path !== 'string' || !rootValue.path || !path.isAbsolute(rootValue.path)) {
        fail('INVALID_CONFIG', `Workbook root '${rootValue.name}' must name an absolute directory`);
    }
    for (const key of ['read', 'write', 'allowOverwrite', 'denyGitIgnoredWrites']) {
        if (rootValue[key] !== undefined && typeof rootValue[key] !== 'boolean') {
            fail('INVALID_CONFIG', `Workbook root '${rootValue.name}' ${key} must be boolean`);
        }
    }
    if (rootValue.denyGitIgnoredWrites === true && rootValue.write !== true) {
        fail(
            'INVALID_CONFIG',
            `Workbook root '${rootValue.name}' denyGitIgnoredWrites requires write: true`);
    }

    // A root path may not acquire meaning through a symbolic intermediate.
    for (const component of absoluteComponents(rootValue.path)) {
        const stat = safeLstatSync(
            component, { bigint: true }, 'INVALID_CONFIG',
            `Workbook root '${rootValue.name}' is not an accessible directory`);
        if (stat.isSymbolicLink()) {
            fail('INVALID_CONFIG', `Workbook root '${rootValue.name}' contains a symbolic or reparse redirect`);
        }
        if (!stat.isDirectory()) {
            fail('INVALID_CONFIG', `Workbook root '${rootValue.name}' contains a non-directory component`);
        }
    }

    const configuredPath = path.resolve(rootValue.path);
    const realPath = safeRealpathSync(
        configuredPath, 'INVALID_CONFIG',
        `Workbook root '${rootValue.name}' cannot be resolved safely`);
    const stat = safeLstatSync(
        realPath, { bigint: true }, 'INVALID_CONFIG',
        `Workbook root '${rootValue.name}' is not an accessible directory`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('INVALID_CONFIG', `Workbook root '${rootValue.name}' must be a real directory`);
    }
    let gitWorktree = null;
    if (rootValue.denyGitIgnoredWrites === true) {
        const git = spawnSync(
            'git', ['-c', 'core.fsmonitor=', '-C', realPath, 'rev-parse', '--show-toplevel'],
            {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true,
                env: GIT_ENV,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        if (git.error || git.status !== 0 || !String(git.stdout || '').trim()) {
            fail(
                'INVALID_CONFIG',
                `Workbook root '${rootValue.name}' requires an accessible Git worktree for denyGitIgnoredWrites`);
        }
        const gitTopLevel = safeRealpathSync(
            String(git.stdout).trim(),
            'INVALID_CONFIG',
            `Workbook root '${rootValue.name}' Git worktree cannot be resolved safely`);
        if (!portablePathEqual(gitTopLevel, realPath)) {
            fail(
                'INVALID_CONFIG',
                `Workbook root '${rootValue.name}' must be the Git worktree root when denyGitIgnoredWrites is enabled`);
        }
        gitWorktree = gitTopLevel;
    }

    return {
        public: {
            name: rootValue.name,
            path: realPath,
            read: rootValue.read === true,
            write: rootValue.write === true,
            allowOverwrite: rootValue.allowOverwrite === true,
            denyGitIgnoredWrites: rootValue.denyGitIgnoredWrites === true,
        },
        internal: {
            name: rootValue.name,
            configuredPath,
            realPath,
            identity: { dev: stat.dev, ino: stat.ino },
            device: stat.dev,
            read: rootValue.read === true,
            write: rootValue.write === true,
            allowOverwrite: rootValue.allowOverwrite === true,
            denyGitIgnoredWrites: rootValue.denyGitIgnoredWrites === true,
            gitWorktree,
        },
    };
}

function validateConfigPlacement(configRealPath, roots, agentWorkspace) {
    for (const root of roots) {
        if (isPathInside(root.realPath, configRealPath, true)) {
            fail('INVALID_CONFIG', 'Workbook file configuration may not be stored inside an allowlisted root');
        }
    }
    if (agentWorkspace === undefined || agentWorkspace === null || agentWorkspace === '') return;
    if (typeof agentWorkspace !== 'string' || !path.isAbsolute(agentWorkspace)) {
        fail('INVALID_CONFIG', 'Agent workspace must be absolute when workbook file transfer is enabled');
    }
    let workspacePath = path.resolve(agentWorkspace);
    try {
        workspacePath = fs.realpathSync.native(workspacePath);
    } catch (_) {
        // The broker may be configured before the optional workspace is created.
        // Lexical containment still prevents placing the config at its future path.
    }
    if (isPathInside(workspacePath, configRealPath, true)) {
        fail('INVALID_CONFIG', 'Workbook file configuration may not be stored inside the agent workspace');
    }
}

function validateToolPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > TOOL_PATH_MAX_BYTES) {
        fail('INVALID_PATH', 'Workbook file path failed portable-path validation');
    }
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength === 0 || byteLength > TOOL_PATH_MAX_BYTES) {
        fail('INVALID_PATH', 'Workbook file path failed portable-path validation');
    }
    if (UNSAFE_PUBLIC_TEXT_RE.test(value)
        || value.includes('\\')
        || value.includes(':')
        || value.startsWith('/')
        || value.startsWith('~')
        || /^[a-zA-Z]:/.test(value)
        || /^[/\\]{2}/.test(value)) {
        fail('INVALID_PATH', 'Workbook file path failed portable-path validation');
    }
    const components = value.split('/');
    if (!components.length) fail('INVALID_PATH', 'Workbook file path failed portable-path validation');
    for (const component of components) {
        if (!component
            || component === '.'
            || component === '..'
            || Buffer.byteLength(component, 'utf8') > TOOL_PATH_COMPONENT_MAX_BYTES
            || WINDOWS_RESERVED_RE.test(component)
            || (process.platform === 'win32'
                && (component.endsWith('.') || component.endsWith(' ')))) {
            fail('INVALID_PATH', 'Workbook file path failed portable-path validation');
        }
    }
    return components.join('/');
}

function validateToolCallId(value) {
    if (typeof value === 'string') {
        if (!value || UNSAFE_PUBLIC_TEXT_RE.test(value) || Buffer.byteLength(value, 'utf8') > 256) {
            fail('INVALID_TOOL_CALL', 'Workbook file tool call has an invalid binding identifier');
        }
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    fail('INVALID_TOOL_CALL', 'Workbook file tool call requires a string or numeric binding identifier');
}

function validateCommonArgs(args, direction) {
    const allowed = direction === 'export'
        ? ['format', 'root', 'path', 'overwrite']
        : ['format', 'root', 'path', 'mode', 'sha256'];
    ownKeysExactly(args, allowed, 'ARGUMENTS');
    if (args.format !== 'srwb' && args.format !== 'ipynb') {
        fail('INVALID_ARGUMENTS', 'Workbook format must be srwb or ipynb');
    }
    if (typeof args.root !== 'string' || !ROOT_NAME_RE.test(args.root)) {
        fail('INVALID_ARGUMENTS', 'Workbook root alias failed validation');
    }
    const relativePath = validateToolPath(args.path);
    if (direction === 'export') {
        if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
            fail('INVALID_ARGUMENTS', 'Workbook overwrite must be boolean');
        }
        return {
            format: args.format,
            root: args.root,
            path: relativePath,
            overwrite: args.overwrite === true,
        };
    }
    if (args.mode !== undefined && args.mode !== 'replace' && args.mode !== 'create') {
        fail('INVALID_ARGUMENTS', 'Workbook import mode must be replace or create');
    }
    if (args.sha256 !== undefined
        && (typeof args.sha256 !== 'string' || !SHA256_INPUT_RE.test(args.sha256))) {
        fail('INVALID_ARGUMENTS', 'Workbook SHA-256 must contain 64 hexadecimal characters');
    }
    return {
        format: args.format,
        root: args.root,
        path: relativePath,
        mode: args.mode || 'replace',
        sha256: args.sha256 === undefined ? undefined : args.sha256.toLowerCase(),
    };
}

function rootForCall(rootsByName, alias, permission) {
    const root = rootsByName.get(alias);
    if (!root) fail('UNKNOWN_ROOT', `Workbook root alias '${alias}' is not configured`);
    if (!root[permission]) {
        fail('ROOT_PERMISSION', `Workbook root alias '${alias}' does not permit this direction`);
    }
    return root;
}

async function lstatMaybe(target) {
    try {
        return await fs.promises.lstat(target, { bigint: true });
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        fail('FILESYSTEM_SAFETY', 'Workbook path could not be inspected safely');
    }
}

async function realpathSafe(target) {
    try {
        return await fs.promises.realpath(target);
    } catch (_) {
        fail('FILESYSTEM_SAFETY', 'Workbook path could not be resolved safely');
    }
}

async function validateRootNow(root) {
    let stat;
    try {
        stat = await fs.promises.lstat(root.configuredPath, { bigint: true });
    } catch (_) {
        fail('FILESYSTEM_SAFETY', `Workbook root alias '${root.name}' is no longer accessible`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, root.identity)) {
        fail('FILESYSTEM_SAFETY', `Workbook root alias '${root.name}' changed after startup`);
    }
    const currentReal = await realpathSafe(root.configuredPath);
    if (!portablePathEqual(currentReal, root.realPath)) {
        fail('FILESYSTEM_SAFETY', `Workbook root alias '${root.name}' changed after startup`);
    }
}

async function resolveCallPath(root, relativePath, { requireLeaf = false } = {}) {
    await validateRootNow(root);
    const components = relativePath.split('/');
    let cursor = root.realPath;

    for (let index = 0; index < components.length - 1; index += 1) {
        cursor = path.join(cursor, components[index]);
        const stat = await lstatMaybe(cursor);
        if (!stat) fail('MISSING_PARENT', 'Workbook destination parent directory does not exist');
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            fail('FILESYSTEM_SAFETY', 'Workbook path contains a link, reparse redirect, or non-directory parent');
        }
        if (stat.dev !== root.device) {
            fail('FILESYSTEM_SAFETY', 'Workbook path crosses a mounted or reparse filesystem boundary');
        }
        const real = await realpathSafe(cursor);
        if (!isPathInside(root.realPath, real, true)) {
            fail('FILESYSTEM_SAFETY', 'Workbook path escaped its configured root');
        }
        cursor = real;
    }

    const parentReal = await realpathSafe(cursor);
    if (!isPathInside(root.realPath, parentReal, true)) {
        fail('FILESYSTEM_SAFETY', 'Workbook path escaped its configured root');
    }
    const target = path.join(parentReal, components.at(-1));
    if (!isPathInside(root.realPath, target, false)) {
        fail('FILESYSTEM_SAFETY', 'Workbook path escaped its configured root');
    }
    const leaf = await lstatMaybe(target);
    if (requireLeaf && !leaf) fail('NOT_FOUND', 'Workbook import source does not exist');
    return { target, parent: parentReal, leaf };
}

function isJsonMimeType(value) {
    return typeof value === 'string'
        && /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"]*"))*$/i.test(value);
}

function parseRawAppObject(raw, kind, maxBytes = undefined) {
    if (typeof raw !== 'string') fail(`INVALID_APP_${kind}`, `SciREPL app returned an invalid ${kind.toLowerCase()}`);
    if (maxBytes !== undefined && Buffer.byteLength(raw, 'utf8') > maxBytes) {
        fail(`INVALID_APP_${kind}`, `SciREPL app returned an oversized ${kind.toLowerCase()}`);
    }
    let value;
    try {
        value = JSON.parse(raw);
    } catch (_) {
        fail(`INVALID_APP_${kind}`, `SciREPL app returned an invalid ${kind.toLowerCase()}`);
    }
    if (!isOwnObject(value)) fail(`INVALID_APP_${kind}`, `SciREPL app returned an invalid ${kind.toLowerCase()}`);
    return value;
}

function validateExportEnvelope(raw, format, maxContentBytes, maxWireBytes) {
    // Verify the actual nested /app result representation, not merely the
    // already-decoded output string.
    let encodedBytes;
    try {
        encodedBytes = Buffer.byteLength(JSON.stringify({
            type: 'result',
            id: '00000000-0000-0000-0000-000000000000',
            output: raw,
        }), 'utf8');
    } catch (_) {
        fail('INVALID_APP_ENVELOPE', 'SciREPL app returned an invalid workbook export envelope');
    }
    if (encodedBytes > maxWireBytes) {
        fail('APP_WIRE_CAP', 'SciREPL workbook export exceeded the configured app transport budget');
    }

    const envelope = parseRawAppObject(raw, 'ENVELOPE');
    ownKeysExactly(
        envelope,
        ['format', 'filename', 'mimeType', 'encoding', 'content', 'size', 'sha256'],
        'APP_ENVELOPE');
    if (envelope.format !== format
        || typeof envelope.filename !== 'string'
        || !isJsonMimeType(envelope.mimeType)
        || envelope.encoding !== 'utf-8'
        || typeof envelope.content !== 'string'
        || !Number.isSafeInteger(envelope.size)
        || envelope.size < 0
        || typeof envelope.sha256 !== 'string'
        || !SHA256_RE.test(envelope.sha256)) {
        fail('INVALID_APP_ENVELOPE', 'SciREPL app returned an invalid workbook export envelope');
    }
    const bytes = Buffer.from(envelope.content, 'utf8');
    if (bytes.byteLength !== envelope.size) {
        fail('INVALID_APP_ENVELOPE', 'SciREPL app workbook export size did not match its content');
    }
    if (bytes.byteLength > APP_WORKBOOK_MAX_BYTES || bytes.byteLength > maxContentBytes) {
        fail('CONTENT_CAP', 'SciREPL workbook export exceeded the configured content limit');
    }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!safeDigestEqual(digest, envelope.sha256)) {
        fail('HASH_MISMATCH', 'SciREPL app workbook export SHA-256 did not match its content');
    }
    return { bytes, size: bytes.byteLength, sha256: digest };
}

function safeDigestEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string'
        || left.length !== 64 || right.length !== 64) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function validateImportReceipt(raw, { format, requestedMode, size, sha256 }) {
    const receipt = parseRawAppObject(raw, 'RECEIPT');
    ownKeysExactly(
        receipt,
        ['ok', 'format', 'mode', 'notebookId', 'name', 'cells', 'size', 'sha256'],
        'APP_RECEIPT');
    if (receipt.ok !== true
        || receipt.format !== format
        || (receipt.mode !== 'replace' && receipt.mode !== 'create')
        || (requestedMode === 'create' && receipt.mode !== 'create')
        || receipt.size !== size
        || receipt.sha256 !== sha256
        || typeof receipt.notebookId !== 'string'
        || !receipt.notebookId
        || typeof receipt.name !== 'string'
        || !Number.isSafeInteger(receipt.cells)
        || receipt.cells < 0) {
        fail('INVALID_APP_RECEIPT', 'SciREPL app returned an invalid workbook import receipt');
    }
    return { mode: receipt.mode };
}

function encodedImportCallBytes(args) {
    try {
        return Buffer.byteLength(JSON.stringify({
            type: 'call',
            id: '00000000-0000-0000-0000-000000000000',
            name: BASE_IMPORT,
            args,
        }), 'utf8');
    } catch (_) {
        fail('APP_WIRE_CAP', 'Workbook import could not be encoded for the app transport');
    }
}

async function readStableImportFile(location, cap, hook) {
    const beforePath = location.leaf;
    if (!beforePath
        || beforePath.isSymbolicLink()
        || !beforePath.isFile()
        || beforePath.dev !== location.rootDevice) {
        fail('FILESYSTEM_SAFETY', 'Workbook import source must be a non-link regular file');
    }
    if (beforePath.size > BigInt(cap)) fail('CONTENT_CAP', 'Workbook import source exceeds the configured content limit');

    let handle;
    try {
        handle = await fs.promises.open(location.target, fs.constants.O_RDONLY | NOFOLLOW);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile()
            || !sameStableFile(beforePath, opened)) {
            fail('FILESYSTEM_RACE', 'Workbook import source changed while opening');
        }
        await hook('afterImportOpen', { root: location.rootName, path: location.relativePath });

        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const hash = crypto.createHash('sha256');
        const chunks = [];
        let total = 0;
        const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > cap || total > APP_WORKBOOK_MAX_BYTES) {
                fail('CONTENT_CAP', 'Workbook import source exceeds the configured content limit');
            }
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            try {
                chunks.push(decoder.decode(chunk, { stream: true }));
            } catch (_) {
                fail('INVALID_UTF8', 'Workbook import source is not valid UTF-8');
            }
        }
        try {
            chunks.push(decoder.decode());
        } catch (_) {
            fail('INVALID_UTF8', 'Workbook import source is not valid UTF-8');
        }

        await hook('afterImportRead', { root: location.rootName, path: location.relativePath });
        const after = await handle.stat({ bigint: true });
        if (!sameStableFile(opened, after) || BigInt(total) !== opened.size) {
            fail('FILESYSTEM_RACE', 'Workbook import source changed while reading');
        }
        const finalPath = await lstatMaybe(location.target);
        if (!finalPath
            || finalPath.isSymbolicLink()
            || !finalPath.isFile()
            || !sameIdentity(after, finalPath)
            || finalPath.size !== after.size) {
            fail('FILESYSTEM_RACE', 'Workbook import source changed while reading');
        }
        return {
            content: chunks.join(''),
            size: total,
            sha256: hash.digest('hex'),
        };
    } catch (error) {
        if (error instanceof WorkbookFileTransferError) throw error;
        fail('FILESYSTEM_SAFETY', 'Workbook import source could not be read safely');
    } finally {
        if (handle) {
            try { await handle.close(); } catch (_) {}
        }
    }
}

async function writeAllAndHash(handle, bytes) {
    const hash = crypto.createHash('sha256');
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
            fail('FILESYSTEM_SAFETY', 'Workbook export temporary file could not be written completely');
        }
        hash.update(bytes.subarray(offset, offset + bytesWritten));
        offset += bytesWritten;
    }
    return hash.digest('hex');
}

async function hashStableFile(target, expectedIdentity, expectedSize) {
    let handle;
    try {
        handle = await fs.promises.open(target, fs.constants.O_RDONLY | NOFOLLOW);
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()
            || !sameStableFile(before, expectedIdentity)
            || before.size !== BigInt(expectedSize)) {
            fail('FILESYSTEM_RACE', 'Workbook export temporary file changed before verification');
        }
        const hash = crypto.createHash('sha256');
        let total = 0;
        const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        if (!sameStableFile(before, after) || total !== expectedSize) {
            fail('FILESYSTEM_RACE', 'Workbook export temporary file changed during verification');
        }
        return hash.digest('hex');
    } catch (error) {
        if (error instanceof WorkbookFileTransferError) throw error;
        fail('FILESYSTEM_SAFETY', 'Workbook export temporary file could not be verified safely');
    } finally {
        if (handle) {
            try { await handle.close(); } catch (_) {}
        }
    }
}

async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
        await handle.sync();
    } catch (error) {
        // Node does not expose a portable directory-fsync operation on Windows;
        // POSIX filesystems may report a narrow unsupported-operation set. Real
        // I/O failures on a host that supports directory fsync remain fatal.
        const unsupported = process.platform === 'win32'
            || ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'].includes(error?.code);
        if (!unsupported) throw error;
    } finally {
        if (handle) {
            try { await handle.close(); } catch (_) {}
        }
    }
}

async function inspectExportDestination(location, root, overwrite) {
    if (overwrite && !root.allowOverwrite) {
        fail('OVERWRITE_DENIED', `Workbook root alias '${root.name}' does not permit overwrite`);
    }
    const leaf = location.leaf;
    if (!leaf) return false;
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.dev !== root.device) {
        fail('FILESYSTEM_SAFETY', 'Workbook export destination is not a safe regular file');
    }
    if (!overwrite) fail('DESTINATION_EXISTS', 'Workbook export destination already exists');
    return true;
}

async function gitExit(root, args) {
    try {
        const result = await execFileAsync(
            'git', ['-c', 'core.fsmonitor=', '-C', root.realPath, ...args], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 65_536,
            env: GIT_ENV,
        });
        return { status: 0, stdout: result.stdout || '' };
    } catch (error) {
        if (Number.isInteger(error?.code) && !error.killed && !error.signal) {
            return { status: error.code, stdout: error.stdout || '' };
        }
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' Git-ignore policy could not be verified`);
    }
}

async function assertGitWorktreeNow(root, relativePath) {
    await validateRootNow(root);
    const top = await gitExit(root, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || !String(top.stdout).trim()) {
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' Git worktree is no longer accessible`);
    }
    let topReal;
    try {
        topReal = await fs.promises.realpath(String(top.stdout).trim());
    } catch (_) {
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' Git worktree changed after startup`);
    }
    if (!portablePathEqual(topReal, root.gitWorktree)
        || !portablePathEqual(topReal, root.realPath)) {
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' Git worktree changed after startup`);
    }

    // A separately initialized repository or submodule below the configured
    // project would otherwise be classified by the outer repository's rules.
    // V1 fails closed at that boundary; configure it as its own root instead.
    const components = relativePath.split('/');
    let cursor = root.realPath;
    for (let index = 0; index < components.length - 1; index += 1) {
        cursor = path.join(cursor, components[index]);
        const parent = await lstatMaybe(cursor);
        if (!parent) break;
        if (parent.isSymbolicLink() || !parent.isDirectory()) break;
        const nestedMarker = await lstatMaybe(path.join(cursor, '.git'));
        if (nestedMarker) {
            fail('WRITE_POLICY', `Workbook root alias '${root.name}' blocks nested Git worktree writes`);
        }
    }
}

async function assertGitWriteAllowed(root, relativePath) {
    if (!root.denyGitIgnoredWrites) return;
    if (relativePath.split('/').some(component => component.toLowerCase() === '.git')) {
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' blocks Git metadata writes`);
    }
    await assertGitWorktreeNow(root, relativePath);

    // Git intentionally reports tracked files as not ignored. This matches the
    // sandbox-parity goal: tracked files are visible to the surrounding agent,
    // while ignored untracked paths are not a broker side door.
    const ignored = await gitExit(root, ['check-ignore', '--quiet', '--', relativePath]);
    if (ignored.status === 1) return;
    if (ignored.status === 0) {
        fail('WRITE_POLICY', `Workbook root alias '${root.name}' blocks writes to Git-ignored paths`);
    }
    fail('WRITE_POLICY', `Workbook root alias '${root.name}' Git-ignore policy could not be verified`);
}

async function publishExport({ location, root, bytes, sha256, overwrite, hook, checkWritePolicy }) {
    const random = crypto.randomBytes(16).toString('hex');
    const tempName = `scirepl-workbook-${process.pid}-${random}`;
    const relativeParent = path.posix.dirname(location.relativePath);
    const tempRelativePath = relativeParent === '.'
        ? tempName
        : `${relativeParent}/${tempName}`;
    const tempPath = path.join(location.parent, tempName);
    let handle;
    let tempExists = false;
    let published = false;
    try {
        await checkWritePolicy(tempRelativePath);
        handle = await fs.promises.open(
            tempPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
            0o600);
        tempExists = true;
        const writtenDigest = await writeAllAndHash(handle, bytes);
        if (!safeDigestEqual(writtenDigest, sha256)) {
            fail('HASH_MISMATCH', 'Workbook export bytes changed while writing');
        }
        await handle.sync();
        const writtenStat = await handle.stat({ bigint: true });
        if (!writtenStat.isFile() || writtenStat.size !== BigInt(bytes.byteLength)) {
            fail('FILESYSTEM_SAFETY', 'Workbook export temporary file has an invalid size');
        }
        await handle.close();
        handle = undefined;

        await hook('afterExportTempSync', {
            root: root.name,
            path: location.relativePath,
            tempPath,
        });
        const rereadDigest = await hashStableFile(tempPath, writtenStat, bytes.byteLength);
        if (!safeDigestEqual(rereadDigest, sha256)) {
            fail('HASH_MISMATCH', 'Workbook export on-disk SHA-256 did not match the app content');
        }

        await hook('beforeExportPublish', {
            root: root.name,
            path: location.relativePath,
            tempPath,
        });
        await checkWritePolicy(location.relativePath);
        await checkWritePolicy(tempRelativePath);
        const publishStat = await lstatMaybe(tempPath);
        if (!publishStat
            || publishStat.isSymbolicLink()
            || !publishStat.isFile()
            || !sameStableFile(writtenStat, publishStat)) {
            fail('FILESYSTEM_RACE', 'Workbook export temporary file changed before publication');
        }

        // Re-walk after the final test hook and policy checks. This catches a
        // target that appeared during the call and makes the overwrite receipt
        // describe the file state immediately before atomic publication.
        const finalLocation = await resolveCallPath(root, location.relativePath);
        finalLocation.rootName = root.name;
        finalLocation.relativePath = location.relativePath;
        const overwritten = await inspectExportDestination(finalLocation, root, overwrite);
        await checkWritePolicy(location.relativePath);
        await checkWritePolicy(tempRelativePath);
        const finalTempStat = await lstatMaybe(tempPath);
        if (!finalTempStat
            || finalTempStat.isSymbolicLink()
            || !finalTempStat.isFile()
            || !sameStableFile(writtenStat, finalTempStat)) {
            fail('FILESYSTEM_RACE', 'Workbook export temporary file changed before publication');
        }

        if (overwrite) {
            await fs.promises.rename(tempPath, finalLocation.target);
            tempExists = false;
            published = true;
        } else {
            try {
                await fs.promises.link(tempPath, finalLocation.target);
            } catch (error) {
                if (error && error.code === 'EEXIST') {
                    fail('DESTINATION_EXISTS', 'Workbook export destination won an atomic no-clobber race');
                }
                fail('NO_CLOBBER_UNAVAILABLE', 'Safe atomic no-clobber publication is unavailable');
            }
            published = true;
            await fs.promises.unlink(tempPath);
            tempExists = false;
        }
        await syncDirectory(finalLocation.parent);
        return { overwritten };
    } catch (error) {
        if (error instanceof WorkbookFileTransferError) throw error;
        fail('FILESYSTEM_SAFETY', published
            ? 'Workbook export was published but final filesystem verification failed'
            : 'Workbook export could not be published safely');
    } finally {
        if (handle) {
            try { await handle.close(); } catch (_) {}
        }
        if (tempExists) {
            try { await fs.promises.unlink(tempPath); } catch (_) {}
        }
    }
}

function toolName(definition) {
    if (!definition || typeof definition !== 'object') return null;
    const candidate = definition.function && typeof definition.function === 'object'
        ? definition.function : definition;
    return typeof candidate.name === 'string' ? candidate.name : null;
}

const EXPORT_DEFINITION = deepFreeze({
    name: SYNTHETIC_EXPORT,
    description: 'Export the active SciREPL workbook through its app permission gate and atomically write the canonical UTF-8 bytes under an allowlisted broker root. Returns only a content-free receipt.',
    inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            format: { type: 'string', enum: ['srwb', 'ipynb'] },
            root: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
            path: { type: 'string', minLength: 1, maxLength: 1024 },
            overwrite: { type: 'boolean', default: false },
        },
        required: ['format', 'root', 'path'],
    },
});

const IMPORT_DEFINITION = deepFreeze({
    name: SYNTHETIC_IMPORT,
    description: 'Read exact UTF-8 workbook bytes from an allowlisted broker root and import them through SciREPL\'s unchanged app permission gate. Returns only a content-free receipt.',
    inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            format: { type: 'string', enum: ['srwb', 'ipynb'] },
            root: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
            path: { type: 'string', minLength: 1, maxLength: 1024 },
            mode: { type: 'string', enum: ['replace', 'create'], default: 'replace' },
            sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        },
        required: ['format', 'root', 'path'],
    },
});

function normalizeTimestamp(now) {
    let value;
    try {
        value = now();
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error('invalid');
        return date.toISOString();
    } catch (_) {
        fail('CLOCK_FAILURE', 'Workbook receipt timestamp could not be created');
    }
}

function filteredReceipt(fields) {
    return Object.freeze({
        schemaVersion: 1,
        type: 'workbook-file-receipt',
        ...fields,
    });
}

function safeCallError(direction) {
    return new WorkbookFileTransferError(
        'APP_CALL_FAILED',
        `SciREPL app ${direction} was denied or failed; app permissions were not bypassed`);
}

/**
 * Load and freeze workbook file-transfer configuration.
 *
 * The function is intentionally synchronous: invalid explicit configuration is
 * a startup failure, before the broker begins accepting connections.
 */
export function createWorkbookFileTransfer({
    configPath,
    agentWorkspace,
    maxAppWsPayloadBytes,
    log = entry => console.log(`[broker] workbook-file ${JSON.stringify(entry)}`),
    now = () => new Date(),
    hooks = {},
} = {}) {
    if (configPath === undefined || configPath === null || configPath === '') return null;
    if (!Number.isSafeInteger(maxAppWsPayloadBytes)
        || maxAppWsPayloadBytes < REQUIRED_APP_WS_PAYLOAD_BYTES) {
        fail(
            'APP_WIRE_CAP',
            `Workbook file transfer requires BROKER_MAX_APP_WS_PAYLOAD_BYTES >= ${REQUIRED_APP_WS_PAYLOAD_BYTES}`);
    }
    if (typeof log !== 'function') fail('INVALID_CONFIG', 'Workbook audit logger must be a function');
    if (typeof now !== 'function') fail('INVALID_CONFIG', 'Workbook receipt clock must be a function');
    if (!isOwnObject(hooks)) fail('INVALID_CONFIG', 'Workbook transfer test hooks must be an object');
    const allowedHooks = new Set([
        'afterImportOpen',
        'afterImportRead',
        'afterExportTempSync',
        'beforeExportPublish',
    ]);
    for (const [name, callback] of Object.entries(hooks)) {
        if (!allowedHooks.has(name) || typeof callback !== 'function') {
            fail('INVALID_CONFIG', 'Workbook transfer contains an unsupported test hook');
        }
    }

    const snapshot = readConfigSnapshot(configPath);
    const parsed = parseConfig(snapshot.parsedText);
    const names = new Set();
    const validated = parsed.roots.map(root => validateConfiguredRoot(root, names));
    const internalRoots = validated.map(item => item.internal);
    validateConfigPlacement(snapshot.realPath, internalRoots, agentWorkspace);
    const publicConfig = deepFreeze({
        schemaVersion: 1,
        maxContentBytes: parsed.maxContentBytes,
        roots: validated.map(item => item.public),
    });
    const rootsByName = new Map(internalRoots.map(root => [root.name, root]));

    const invokeHook = async (name, value) => {
        const callback = hooks[name];
        if (callback) await callback(Object.freeze({ ...value }));
    };

    const audit = async entry => {
        const filtered = Object.freeze({
            direction: entry.direction,
            root: entry.root,
            path: entry.path,
            format: entry.format,
            size: entry.size ?? null,
            sha256: entry.sha256 ?? null,
            overwrite: entry.overwrite === true,
            outcome: entry.outcome,
        });
        await log(filtered);
    };

    const handleExport = async (args, context) => {
        const request = validateCommonArgs(args, 'export');
        const toolCallId = validateToolCallId(context.toolCallId);
        const root = rootForCall(rootsByName, request.root, 'write');
        let size = null;
        let sha256 = null;
        try {
            await assertGitWriteAllowed(root, request.path);
            let location = await resolveCallPath(root, request.path);
            location.rootName = root.name;
            location.relativePath = request.path;
            await inspectExportDestination(location, root, request.overwrite);

            let raw;
            try {
                raw = await context.callApp(
                    BASE_EXPORT,
                    {
                        format: request.format,
                        brokerRoot: request.root,
                        brokerPath: request.path,
                    },
                    { maxWireBytes: maxAppWsPayloadBytes });
            } catch (_) {
                throw safeCallError('workbook export');
            }
            const envelope = validateExportEnvelope(
                raw, request.format, publicConfig.maxContentBytes, maxAppWsPayloadBytes);
            size = envelope.size;
            sha256 = envelope.sha256;

            // Re-resolve after the permission-gated app call before creating a
            // host-side temporary file.
            location = await resolveCallPath(root, request.path);
            location.rootName = root.name;
            location.relativePath = request.path;
            await inspectExportDestination(location, root, request.overwrite);
            await assertGitWriteAllowed(root, request.path);
            const publication = await publishExport({
                location,
                root,
                bytes: envelope.bytes,
                sha256,
                overwrite: request.overwrite,
                hook: invokeHook,
                checkWritePolicy: relativePath => assertGitWriteAllowed(root, relativePath),
            });
            await audit({
                direction: 'export', root: request.root, path: request.path,
                format: request.format, size, sha256,
                overwrite: request.overwrite, outcome: 'written',
            });
            return filteredReceipt({
                direction: 'export',
                status: 'written',
                root: request.root,
                path: request.path,
                format: request.format,
                size,
                sha256,
                toolCallId,
                timestamp: normalizeTimestamp(now),
                overwritten: publication.overwritten,
            });
        } catch (error) {
            try {
                await audit({
                    direction: 'export', root: request.root, path: request.path,
                    format: request.format, size, sha256,
                    overwrite: request.overwrite, outcome: 'failed',
                });
            } catch (_) {}
            if (error instanceof WorkbookFileTransferError) throw error;
            throw new WorkbookFileTransferError(
                'TRANSFER_FAILED', 'Workbook export failed a broker safety check');
        }
    };

    const handleImport = async (args, context) => {
        const request = validateCommonArgs(args, 'import');
        const toolCallId = validateToolCallId(context.toolCallId);
        const root = rootForCall(rootsByName, request.root, 'read');
        let size = null;
        let sha256 = null;
        try {
            const location = await resolveCallPath(root, request.path, { requireLeaf: true });
            location.rootName = root.name;
            location.relativePath = request.path;
            location.rootDevice = root.device;
            const file = await readStableImportFile(
                location, publicConfig.maxContentBytes, invokeHook);
            size = file.size;
            sha256 = file.sha256;
            if (request.sha256 && !safeDigestEqual(request.sha256, sha256)) {
                fail('HASH_MISMATCH', 'Workbook import source SHA-256 did not match the requested digest');
            }
            const appArgs = {
                format: request.format,
                content: file.content,
                mode: request.mode,
                sha256,
                brokerRoot: request.root,
                brokerPath: request.path,
            };
            if (encodedImportCallBytes(appArgs) > maxAppWsPayloadBytes) {
                fail('APP_WIRE_CAP', 'Workbook import exceeded the configured app transport budget');
            }
            let raw;
            try {
                raw = await context.callApp(
                    BASE_IMPORT,
                    appArgs,
                    { maxWireBytes: maxAppWsPayloadBytes });
            } catch (_) {
                throw safeCallError('workbook import');
            }
            const appReceipt = validateImportReceipt(raw, {
                format: request.format,
                requestedMode: request.mode,
                size,
                sha256,
            });
            await audit({
                direction: 'import', root: request.root, path: request.path,
                format: request.format, size, sha256,
                overwrite: false, outcome: 'imported',
            });
            return filteredReceipt({
                direction: 'import',
                status: 'imported',
                root: request.root,
                path: request.path,
                format: request.format,
                size,
                sha256,
                toolCallId,
                timestamp: normalizeTimestamp(now),
                mode: appReceipt.mode,
            });
        } catch (error) {
            try {
                await audit({
                    direction: 'import', root: request.root, path: request.path,
                    format: request.format, size, sha256,
                    overwrite: false, outcome: 'failed',
                });
            } catch (_) {}
            if (error instanceof WorkbookFileTransferError) throw error;
            throw new WorkbookFileTransferError(
                'TRANSFER_FAILED', 'Workbook import failed a broker safety check');
        }
    };

    const manager = {
        enabled: true,
        config: publicConfig,
        isSyntheticTool(name) {
            return name === SYNTHETIC_EXPORT || name === SYNTHETIC_IMPORT;
        },
        assertNoCollisions(appTools) {
            for (const definition of Array.isArray(appTools) ? appTools : []) {
                const name = toolName(definition);
                if (name === SYNTHETIC_EXPORT || name === SYNTHETIC_IMPORT) {
                    fail('TOOL_COLLISION', `SciREPL app tool '${name}' collides with a broker-owned workbook tool`);
                }
            }
        },
        getToolDefinitions(appTools) {
            this.assertNoCollisions(appTools);
            const names = new Set((Array.isArray(appTools) ? appTools : []).map(toolName).filter(Boolean));
            const result = [];
            if (names.has(BASE_EXPORT)) result.push(EXPORT_DEFINITION);
            if (names.has(BASE_IMPORT)) result.push(IMPORT_DEFINITION);
            return result;
        },
        async handleTool(name, args, context = {}) {
            if (name !== SYNTHETIC_EXPORT && name !== SYNTHETIC_IMPORT) {
                fail('UNKNOWN_TOOL', 'Unknown broker-owned workbook tool');
            }
            if (!context || typeof context.callApp !== 'function') {
                fail('INVALID_TOOL_CALL', 'Workbook file tool requires an app-call bridge');
            }
            return name === SYNTHETIC_EXPORT
                ? handleExport(args, context)
                : handleImport(args, context);
        },
    };
    return Object.freeze(manager);
}
