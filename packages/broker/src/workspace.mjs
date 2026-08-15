import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(SOURCE_DIR, '../templates');

export const WORKSPACE_MARKER = '.scirepl-mcp/manifest.json';

function template(name) {
    return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

function codexConfig(port, callTimeoutMs) {
    return [
        '[mcp_servers.scirepl]',
        `url = "http://127.0.0.1:${port}/mcp"`,
        'bearer_token_env_var = "SCIREPL_MCP_BEARER"',
        'required = true',
        'default_tools_approval_mode = "approve"',
        `tool_timeout_sec = ${Math.ceil(callTimeoutMs / 1000)}`,
        '',
    ].join('\n');
}

function geminiConfig(port, token) {
    return JSON.stringify({
        mcpServers: {
            scirepl: {
                url: `http://127.0.0.1:${port}/mcp`,
                type: 'http',
                headers: { Authorization: `Bearer ${token}` },
                trust: true,
            },
        },
    }, null, 2) + '\n';
}

function antigravityConfig(port, token) {
    return JSON.stringify({
        mcpServers: {
            scirepl: {
                serverUrl: `http://127.0.0.1:${port}/mcp`,
                headers: { Authorization: `Bearer ${token}` },
            },
        },
    }, null, 2) + '\n';
}

function manifestContent(files) {
    return JSON.stringify({
        schemaVersion: 1,
        generatedBy: 'SciREPL-MCP explicit broker setup',
        notice: 'Files listed here are active agent instructions only inside this dedicated workspace.',
        managedFiles: files,
    }, null, 2) + '\n';
}

export function workspaceTargets({ workspace, port, token, callTimeoutMs }) {
    const context = template('session-context.md.template');
    const skill = template('scirepl-notebook-skill.md.template');
    const definitions = [
        ['CLAUDE.md', context],
        ['AGENTS.md', context],
        ['GEMINI.md', context],
        ['.agents/AGENTS.md', context],
        ['.scirepl-mcp/context/scirepl-notebook-guide.md', skill],
        ['.claude/skills/scirepl-notebook/SKILL.md', skill],
        ['.agents/skills/scirepl-notebook/SKILL.md', skill],
        ['.codex/config.toml', codexConfig(port, callTimeoutMs)],
        ['.gemini/settings.json', geminiConfig(port, token)],
        ['.agents/mcp_config.json', antigravityConfig(port, token)],
    ];
    definitions.push([WORKSPACE_MARKER, manifestContent(definitions.map(([rel]) => rel))]);
    return definitions.map(([rel, content]) => ({
        rel,
        abs: path.join(workspace, ...rel.split('/')),
        content: Buffer.from(content),
    }));
}

export function targetState(target) {
    try {
        const stat = fs.lstatSync(target.abs);
        if (stat.isSymbolicLink()) return 'unsafe-symlink';
        if (!stat.isFile()) return 'unsafe-type';
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return 'outdated';
        return fs.readFileSync(target.abs).equals(target.content) ? 'current' : 'outdated';
    } catch (error) {
        return error.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
}

export function inspectWorkspace(options) {
    const files = {};
    const missing = [];
    const outdated = [];
    const unsafe = [];
    for (const target of workspaceTargets(options)) {
        let state;
        try {
            assertSafeTarget(options.workspace, target.abs);
            state = targetState(target);
        } catch (_) {
            state = 'unsafe-path';
        }
        files[target.rel] = state;
        if (state === 'missing') missing.push(target.rel);
        else if (state === 'outdated') outdated.push(target.rel);
        else if (state !== 'current') unsafe.push(target.rel);
    }
    return {
        ready: missing.length === 0 && outdated.length === 0 && unsafe.length === 0,
        files,
        missing,
        outdated,
        unsafe,
    };
}

function assertRealPath(workspace) {
    const resolved = path.resolve(workspace);
    let existing = resolved;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
    }
    if (fs.existsSync(existing) && fs.realpathSync(existing) !== path.resolve(existing)) {
        throw new Error(`workspace path crosses a symbolic link: ${existing}`);
    }
    if (fs.existsSync(resolved) && (fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isDirectory())) {
        throw new Error(`workspace must be a real directory: ${resolved}`);
    }
    return resolved;
}

function assertSafeWorkspace(workspace) {
    const resolved = assertRealPath(workspace);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(resolved, 0o700); } catch (_) {}
    return resolved;
}

function assertSafeTarget(workspace, target) {
    const rootPath = path.resolve(workspace);
    const root = rootPath + path.sep;
    const resolved = path.resolve(target);
    if (!resolved.startsWith(root)) throw new Error(`managed path escapes workspace: ${resolved}`);

    let current = path.dirname(resolved);
    while (current === rootPath || current.startsWith(root)) {
        if (fs.existsSync(current)) {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) throw new Error(`managed path crosses a symbolic link: ${current}`);
            if (!stat.isDirectory()) throw new Error(`managed path crosses a non-directory: ${current}`);
        }
        if (current === rootPath) break;
        current = path.dirname(current);
    }
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`managed file must not be a symbolic link: ${resolved}`);
    }
}

export function writePrivateFile(file, content, { exclusive = false } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (exclusive && fs.existsSync(file)) {
        const error = new Error(`refusing to replace existing file: ${file}`);
        error.code = 'EEXIST';
        throw error;
    }
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    let descriptor;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, file);
        try { fs.chmodSync(file, 0o600); } catch (_) {}
    } finally {
        if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    }
}

function backupFile(file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(backup, 0o600); } catch (_) {}
    return backup;
}

export function preflightWorkspace(options, { repair = false } = {}) {
    const workspace = assertRealPath(options.workspace);
    const targets = workspaceTargets({ ...options, workspace });
    const states = targets.map(target => {
        try {
            assertSafeTarget(workspace, target.abs);
            return { target, state: targetState(target) };
        } catch (_) {
            return { target, state: 'unsafe-path' };
        }
    });
    const unsafe = states.filter(({ state }) => state.startsWith('unsafe') || state === 'unreadable');
    if (unsafe.length) {
        throw new Error(`refusing unsafe managed paths: ${unsafe.map(({ target }) => target.rel).join(', ')}`);
    }
    const conflicts = states.filter(({ state }) => state === 'outdated');
    if (conflicts.length && !repair) {
        const error = new Error(`workspace contains edited or stale generated files: ${conflicts.map(({ target }) => target.rel).join(', ')}; rerun with --repair to back them up and replace them`);
        error.code = 'WORKSPACE_CONFLICT';
        throw error;
    }
    return { workspace, targets, states };
}

export function setupWorkspace(options, { repair = false } = {}) {
    const preflight = preflightWorkspace(options, { repair });
    const workspace = assertSafeWorkspace(preflight.workspace);
    const states = preflight.states;

    const result = { created: [], updated: [], backups: [], unchanged: [] };
    for (const { target, state } of states) {
        assertSafeTarget(workspace, target.abs);
        if (state === 'current') {
            result.unchanged.push(target.rel);
            continue;
        }
        if (state === 'outdated') {
            result.backups.push(backupFile(target.abs));
            writePrivateFile(target.abs, target.content);
            result.updated.push(target.rel);
            continue;
        }
        writePrivateFile(target.abs, target.content, { exclusive: true });
        result.created.push(target.rel);
    }
    return result;
}

export function randomToken() {
    return crypto.randomBytes(16).toString('hex');
}
