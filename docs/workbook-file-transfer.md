# Workbook file transfer through the broker

Status: **implemented in the broker**. SciREPL Pro's app-side
`export_workbook` and `import_workbook` tools remain the permission-gated source
of truth for serialization and import.

## Implementation deviations and limitations

This is the complete implementation-deviation and limitation list:

- The receipt has two task-required fields beyond the original design:
  `toolCallId` binds it to the MCP JSON-RPC request, and `timestamp` records
  completion as an ISO-8601 UTC instant.
- A receipt represents its resolved destination or source as the non-secret
  `{root, path}` pair. It deliberately never returns the configured absolute
  host path.
- Portable Node.js can reject Node-recognized symbolic links and Windows
  directory junctions, re-check real-path containment, and compare path/handle
  identity. Node core does not expose a cross-platform no-follow open flag or
  every native Windows reparse tag, so a dependency-free implementation cannot
  promise detection of every exotic non-link reparse point. POSIX bind mounts
  have a similar visibility limit. This is part of the documented same-account
  race boundary, not a relaxation of the static traversal, link, or containment
  checks.
- The broker now passes validated destination context to the app, but the
  SciREPL Pro confirmation text does not yet display it. That app-only string
  and localization change is a follow-up; the broker neither fabricates a host
  path for the app nor weakens the existing confirmation in the meantime.

## Purpose and boundary

The app tools carry a complete workbook through an agent's tool context. That is
useful for a one-workbook fidelity pilot, but wasteful for a translation campaign
that repeatedly handles many workbooks and locales. The broker-owned variant
relocates the same payload to or from an allowlisted host directory and returns
only a small receipt to the MCP client.

The trust stack remains layered:

- SciREPL's separate, default-Off **Workbook import/export** permission decides
  whether the app may export or import a workbook. Review mode still blocks
  import.
- The broker configuration decides which host directories may be read or
  written. A per-root project policy can additionally deny writes that Git
  reports as ignored.
- Supervisor review and artifact verification decide whether the workbook on
  disk is acceptable.

The browser never receives an absolute host path and never writes a host file.
It receives only the public root alias and relative path as confirmation
context. The broker must call the app's existing base tools rather than
bypassing them or duplicating their serializer. For import, the broker
necessarily reads the allowlisted file before asking the app to ingest it; the
broker read permission therefore governs host access, while the app permission
governs app mutation.

This design isolates workbook content from the MCP client's model context. It
does not make a same-user coding-agent process an operating-system sandbox.

## Synthetic MCP tools

The broker adds these tools to its MCP-native `tools/list` result only when all
of the following are true:

1. `BROKER_WORKBOOK_IO_CONFIG` was set and passed startup validation.
2. A SciREPL app is connected.
3. The app advertises the corresponding base tool.
4. The synthetic name does not collide with an app-advertised name. A collision
   is a startup/connection error; the broker never silently chooses one tool.

They are broker-owned tools, so their definitions use MCP's
`{name, description, inputSchema}` shape rather than the app's nested function
definition shape.

### `export_workbook_to_file`

Input schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "format": { "type": "string", "enum": ["srwb", "ipynb"] },
    "root": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{0,63}$" },
    "path": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "overwrite": { "type": "boolean", "default": false }
  },
  "required": ["format", "root", "path"]
}
```

The broker calls
`export_workbook({format, brokerRoot: root, brokerPath: path})`, validates the
returned envelope, writes only its exact UTF-8 `content` bytes, and returns only
a receipt. It never uses the app-provided filename to select the host
destination.

### `import_workbook_from_file`

Input schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "format": { "type": "string", "enum": ["srwb", "ipynb"] },
    "root": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{0,63}$" },
    "path": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "mode": { "type": "string", "enum": ["replace", "create"], "default": "replace" },
    "sha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" }
  },
  "required": ["format", "root", "path"]
}
```

The broker opens and validates the allowlisted file, hashes its raw bytes,
decodes it with a fatal UTF-8 decoder, and calls
`import_workbook({format, content, mode, sha256, brokerRoot: root, brokerPath:
path})`. An optional caller-supplied digest must match before any content is
sent to the app.

### Destination context passed to the app

`brokerRoot` and `brokerPath` are reserved broker-to-app context fields. They
contain the already-validated public alias and portable relative path, never the
absolute host path. They are not accepted as client-controlled fields in either
synthetic tool schema, and ordinary direct calls to the base workbook tools may
not claim them. The app must continue to treat them as display-only: the broker
remains the authority on *where*, while the app's default-Off permission remains
the authority on *whether*.

A follow-up SciREPL Pro localization change should include this context in the
per-call confirmation, for example `export to catalog:.pilot/compute-pi-es.srwb`
or `import from agent-brain:<session>/scratch/compute-pi-es.srwb`. Until that
follow-up lands, the current app can ignore the additional fields without
changing the transfer or permission result.

## Receipt and error contract

Successful tools return one MCP text content block whose text is compact JSON.
An export receipt has exactly these fields:

```json
{
  "schemaVersion": 1,
  "type": "workbook-file-receipt",
  "direction": "export",
  "status": "written",
  "root": "catalog",
  "path": ".pilot/es/compute-pi.srwb",
  "format": "srwb",
  "size": 12345,
  "sha256": "64 lowercase hexadecimal characters",
  "toolCallId": 17,
  "timestamp": "2026-08-14T12:34:56.789Z",
  "overwritten": false
}
```

An import receipt uses `"direction":"import"`, `"status":"imported"`, and
has exactly these fields:

```json
{
  "schemaVersion": 1,
  "type": "workbook-file-receipt",
  "direction": "import",
  "status": "imported",
  "root": "catalog",
  "path": ".pilot/es/compute-pi.srwb",
  "format": "srwb",
  "size": 12345,
  "sha256": "64 lowercase hexadecimal characters",
  "toolCallId": "request-17",
  "timestamp": "2026-08-14T12:34:56.789Z",
  "mode": "replace"
}
```

It does **not** forward the app receipt's
notebook name, ID, cell count, source, output, or other workbook-derived
metadata. This filtering preserves the direct-to-file tool's context-isolation
goal. `toolCallId` preserves the MCP JSON-RPC request ID's string-or-number type;
`timestamp` is generated only after the operation succeeds.

Failures use the broker's normal MCP `isError:true` response. Error text may
identify the root alias, relative path, failed validation class, or app denial,
but must never contain workbook bytes, a JSON excerpt, an app-returned notebook
name, or a host path outside the configured public alias.

## Startup configuration

Configuration follows the broker's environment-variable convention while using
a JSON file for the variable-length root list:

```text
BROKER_WORKBOOK_IO_CONFIG=/absolute/path/to/workbook-io.json
```

```json
{
  "schemaVersion": 1,
  "maxContentBytes": 8388608,
  "roots": [
    {
      "name": "catalog",
      "path": "/home/s243a/Projects/SciREPL-Catalog",
      "read": true,
      "write": true,
      "allowOverwrite": false,
      "denyGitIgnoredWrites": true
    },
    {
      "name": "agent-brain",
      "path": "/home/s243a/.gemini/antigravity-cli/brain",
      "read": true,
      "write": true,
      "allowOverwrite": false,
      "denyGitIgnoredWrites": false
    }
  ]
}
```

Rules:

- Unset means disabled; the synthetic tools are absent.
- The config path is absolute and names a pre-existing regular file. The config
  file may not be a symlink/reparse point, may not live inside an allowlisted
  root or the agent working directory, and should be private (`0600` on POSIX;
  an equivalently restricted ACL on Windows).
- The broker loads and validates the file once at startup, retains an immutable
  in-memory snapshot, and never watches or reloads it. A change requires an
  operator-controlled broker restart.
- Explicit but invalid configuration fails broker startup. It never degrades to
  a broader root or silently hides a typo.
- Root names are unique and match `^[a-z][a-z0-9_-]{0,63}$`. Root paths are
  absolute, pre-existing, real directories. `read`, `write`, and
  `allowOverwrite` are explicit booleans and default to false if omitted.
  `denyGitIgnoredWrites` is also an optional boolean and defaults to false.
- `maxContentBytes` is a positive integer no greater than 8 MiB
  (`8388608`), matching the current app hard limit. A broker configuration may
  lower this cap but cannot raise it. A future larger app limit requires
  negotiated capability metadata before the broker accepts it.
- `--workbook-io-config` validates this file and preserves its path in the
  generated Bash and PowerShell launchers. Setup does not place the config in
  the agent-writable workspace and supplies the protocol-v1 `/app` wire budget.

For this translation campaign, configure exactly the two roots above rather
than a session glob or additional project roots. The Catalog root is the
worker's project and enables the ignored-path write gate.
The second root deliberately selects the stable parent of changing
`<session>/scratch/` directories, avoiding an operator config edit and broker
restart for every conversation. This is a broader trust choice: `agent-brain`
permits configured transfers anywhere below that parent, including other
sessions, rather than proving that a path belongs to the active session. The
alias and relative path in the receipt and audit record, the app's per-call
permission, and supervisor review make each use visible, but they do not narrow
that parent automatically. The app confirmation can display the same context
after the documented Pro follow-up.

The concrete scratch parent happens to be named
`~/.gemini/antigravity-cli/brain/`; neither the allowlist nor the ignored-path
policy assumes Gemini, Agy, or any other particular model or agent. Any MCP
client receives the same broker enforcement.

### Per-root ignored-path write policy

`denyGitIgnoredWrites:true` is an optional export-only policy for a particular
project root. Startup requires `write:true` and requires the configured root to
be exactly the top level of an accessible Git worktree; a nested worktree or
submodule must be configured as a separate root. Before asking the app to
export, again after the app returns, and immediately before publication, the
broker asks Git whether the requested relative path is ignored under its normal
ignore sources, including `.gitignore`, `.git/info/exclude`, and configured
global excludes. It applies the same check to the same-directory temporary
file. An ignored path, any `.git` path component, a nested Git boundary, or an
inability to evaluate the worktree fails closed. Tracked files remain writable
because Git does not classify tracked paths as ignored; replacement still needs
both overwrite opt-ins. The broker disables `core.fsmonitor` at command scope
so a repository cannot turn this read-only classification into execution of a
configured monitor program. Import reads are unaffected and remain controlled
by the root's `read` permission.

This is an agent-sandbox parity control: it prevents the workbook file tool from
becoming a write side door around an environment that treats ignored project
paths as outside its writable project. It is scoped per root because that rule
makes sense for `SciREPL-Catalog` but not for the changing scratch directories
below `agent-brain`. It does not claim that every agent has such a sandbox, and
it is independent of which model or agent made the MCP call.

## Path resolution and filesystem safety

Tool paths use `/` as a portable separator and are relative to a configured root
alias. Apply the same grammar on every host so a request does not acquire a
different meaning on Windows and POSIX.

Reject a path that contains a NUL/control character, an unpaired UTF-16
surrogate, a bidirectional-control or line-separator character, backslash, empty
segment, `.` or `..` segment, leading `/`, `~` expansion, a drive/UNC/device
prefix, a colon (including NTFS alternate data streams), or a Windows reserved
device component such as `CON`, `NUL`, `COM1`, or `LPT1`. On Windows also reject
components ending in a dot or space. Bound the UTF-8 path length and component
length before filesystem access.

At startup and per call:

1. Resolve the configured root to its real path.
2. Walk each existing component with no-follow metadata checks. Reject symbolic
   links, junctions, mount/reparse redirects, and non-directory parents.
3. Re-check real-path containment with platform-correct case handling.
4. Import only a regular file opened without following links. Compare `fstat`
   identity and size before and after reading so replacement or growth fails the
   call.
5. Export requires every parent directory to exist. Version 1 does not create
   directories. The destination must be absent, or a regular file when both the
   root and call explicitly permit overwrite.

Import uses a file handle, enforces the byte cap while reading, hashes the exact
raw bytes, and uses a fatal UTF-8 decoder. Replacement characters are not an
acceptable conversion because they would make the app content differ from the
hashed file.

Export writes a same-directory temporary file opened with exclusive creation
and no-follow flags, mode `0600`, hashes while writing, flushes and closes it,
then publishes it. With overwrite disabled, publication must use an atomic
no-clobber primitive (for example a same-filesystem hard-link publication where
supported) and fail on `EEXIST`; a check followed by ordinary rename is not
sufficient. If the platform cannot provide safe no-clobber publication, fail
the call rather than weaken the policy. With overwrite enabled, atomically
replace only after both opt-ins and a final target check. Remove the temporary
file on every failure and sync the containing directory where the platform
supports it.

Portable Node.js does not provide descriptor-relative `openat2` containment on
every supported platform. The checks above prevent static traversal and link
escapes, but cannot promise protection from a malicious process running as the
same OS account that races parent-directory replacements between checks and
path-based operations. Document this limitation; operators needing that threat
model must add OS-level isolation or a platform-native descriptor-relative
implementation. A coding agent with ordinary same-account host access is
already outside the broker allowlist's sandbox boundary.

## Envelope, size, and transport validation

The broker treats every app result and host file as untrusted input.

For export, parse the app output as exactly one JSON object and require:

- the requested `format`;
- `encoding:"utf-8"` and a JSON MIME type;
- a string `content`;
- an integer `size` equal to `Buffer.byteLength(content, "utf8")`;
- a lowercase 64-hex `sha256` equal to a broker recomputation; and
- content size at or below both the app's 8 MiB hard cap and the configured
  lower cap.

Reject extra payload shapes that could cause the broker to choose the wrong
bytes. Filename is informational only and is never used for filesystem
resolution. Import similarly verifies raw byte size and digest before UTF-8
decoding, passes the recomputed digest to the app, and accepts success only after
parsing a valid app receipt. The broker then emits its own filtered receipt.

Content bytes and wire bytes are different limits. In protocol v1, canonical
JSON content is embedded in an app envelope and then again in the `/app` result
message. Backslashes and quotes can make an export result approach four times
the canonical content size. A configured 8 MiB content cap therefore does not
fit safely inside the broker's default 16 MiB inbound `/app` payload limit.

The implementation uses the first of these transport strategies:

- require an inbound `/app` payload budget that covers the app's full 8 MiB
  hard cap after worst-case nested JSON escaping (plus bounded envelope
  overhead), and precompute/reject oversized outbound import-call JSON; or
- negotiate a lower app export cap; or
- implement a protocol-v2 chunk/binary transfer.

Specifically, enabled workbook transfer requires
`BROKER_MAX_APP_WS_PAYLOAD_BYTES >= 42008576`, and the broker computes the
encoded import-call size before sending content to the app. The other two
strategies remain future protocol options.

Merely checking decoded content after receipt is too late: the WebSocket server
may already have closed the app connection with code 1009. The current
`sendWsJson` buffered-amount check is backpressure control, not an encoded
message-size check, and must not be treated as one.

Protocol v1 still buffers one complete app message and one complete UTF-8 string
even when file I/O itself uses streams. That is acceptable for the pilot and
keeps workbook bytes out of model context, but it is not true end-to-end
streaming. Protocol v2 should use ordered per-call chunks with declared length,
sequence numbers, running SHA-256, cancellation, and a final digest before
publication or app mutation. That protocol would require an app change and is
separate from these broker wrappers.

## Audit and tests

Each directional broker audit record has exactly `direction`, `root`, `path`,
`format`, `size`, `sha256`, `overwrite`, and `outcome`. On an early failure,
`size` and `sha256` are `null`; import always logs `overwrite:false`; and
`outcome` is `written`, `imported`, or `failed`. Never log content, the absolute
resolved path, the app receipt, a tool-call ID, a timestamp, or notebook
metadata.

The implementation in `packages/broker/src/workbook-files.mjs` integrates the
synthetic list/call paths in `broker.mjs` and covers at least:

- wrappers absent when configuration or base app tools are absent;
- permission denial leaves no export destination and import causes no app
  mutation;
- strict envelope, UTF-8, size, SHA-256, and content-free receipt checks;
- traversal, absolute, drive, UNC, ADS, reserved-name, symlink, junction/reparse,
  non-regular-file, and containment failures;
- missing parents, default no-overwrite, both overwrite opt-ins, atomic
  no-clobber races, and temporary-file cleanup;
- per-root Git-ignore denial, `.git` metadata denial, policy re-checks, and
  fail-closed Git/configuration errors;
- encoded WebSocket payload limits and connection behavior; and
- unchanged canonical bytes between the app envelope and exported file.

The automated broker suite uses real temporary directories, runs
platform-specific Windows cases in CI, and byte-compares a simulated app's
in-context export against the relocated file. A real paired-app check is an
opt-in bench:

```bash
RUN_PAIRED_APP_E2E=1 SCIREPL_PAIRED_CLOCK_FROZEN=1 \
  npm run test:workbook:paired-app
```

It additionally requires `SCIREPL_MCP_URL`, `SCIREPL_MCP_BEARER`,
`SCIREPL_WORKBOOK_ROOT`, `SCIREPL_WORKBOOK_RELATIVE_PATH`, and
`SCIREPL_WORKBOOK_HOST_PATH`; `SCIREPL_WORKBOOK_FORMAT` defaults to `srwb`.
Freeze `Date` in the paired app page before both export calls and set
`SCIREPL_PAIRED_CLOCK_FROZEN=1` only after doing so. Both canonical serializers
embed an export timestamp, so two sequential exports with a running clock are
correctly different even when the underlying notebook is unchanged.

## Recommendation

Continue the one-workbook pilot through the context-carrying app tools in
parallel with broker validation. Use the implemented broker wrappers before the
15-workbook by 12-locale second-pass translation campaign: the context savings
and reviewable on-disk artifacts justify them at that scale. Implement
protocol-v2 chunking only if measured workbook sizes or encoded v1 messages do
not fit the validated transport budget; it is not required merely to prove the
pilot workflow.
