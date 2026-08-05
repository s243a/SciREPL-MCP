# SciREPL MCP Playwright driver

This stdio MCP server controls SciREPL through a dedicated Chromium session. It
supports visible UI automation as well as direct notebook operations, making it
useful for workbook testing, screenshots, package installation, and diagnosis of
browser-specific problems.

It works with a local SciREPL development server or a hosted PWA such as
<https://s243a.github.io/SciREPL/>. It is independent of the
[app-connected broker](https://github.com/s243a/SciREPL-MCP/tree/main/packages/broker).

## Requirements

- Node.js 20 or newer; Node.js 22 is recommended.
- A reachable SciREPL URL.
- Chromium installed through Playwright, or an existing Chromium instance with
  a CDP endpoint.

## Install

```bash
git clone https://github.com/s243a/SciREPL-MCP.git
cd SciREPL-MCP/packages/playwright-driver
npm ci
npx playwright install chromium
npm test
```

Start the stdio server with:

```bash
npm start
```

An MCP client normally starts the process itself. Use an absolute path in its
configuration:

```json
{
  "mcpServers": {
    "scirepl-playwright": {
      "command": "node",
      "args": [
        "/absolute/path/to/SciREPL-MCP/packages/playwright-driver/src/server.cjs"
      ],
      "env": {
        "SCIREPL_URL": "https://s243a.github.io/SciREPL/",
        "SCIREPL_HEADLESS": "true"
      }
    }
  }
}
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SCIREPL_URL` | `http://localhost:8085` | SciREPL page to open |
| `SCIREPL_HEADLESS` | `true` | Set to `false` to show the controlled browser |
| `SCIREPL_TIMEOUT` | `120000` | Operation timeout in milliseconds |
| `SCIREPL_DEBUG_MODE` | `false` | Launch Chromium with a CDP debugging port |
| `SCIREPL_REMOTE_DEBUGGING_PORT` | `9223` | CDP port used in debug mode |
| `SCIREPL_BROWSER_URL` | empty | Attach to an existing browser through its CDP URL instead of launching one |
| `SCIREPL_DEV_PACKAGES` | empty | Optional directory containing local package zip files |

Numeric settings are validated at startup. Invalid or out-of-range values fail
closed instead of silently changing the driver's behaviour.

## Available tools

### Browser and diagnostics

| Tool | Purpose |
| --- | --- |
| `scirepl_connect` | Launch or attach to Chromium, navigate to SciREPL, and prepare the session |
| `scirepl_disconnect` | Close the controlled browser |
| `scirepl_open_menu` | Open the main menu |
| `scirepl_close_modal` | Close an open modal |
| `scirepl_get_visible_state` | Inspect visible cells, controls, warnings, and recent console messages |
| `scirepl_get_browser_debug_info` | Report page, storage-key, service-worker, and CDP details |
| `scirepl_get_cell_outputs_detailed` | Inspect model-backed and DOM-rendered cell output |
| `scirepl_screenshot` | Save a full-page screenshot |
| `scirepl_wait_for` | Wait for visible text |

### Cells and kernels

| Tool | Purpose |
| --- | --- |
| `scirepl_execute_code` | Execute code in a selected kernel |
| `scirepl_execute_cell` | Execute one existing cell |
| `scirepl_run_all_cells` | Run all cells through the app API |
| `scirepl_run_all_cells_ui` | Open the visible menu and click **Run All Cells** |
| `scirepl_get_cells` | List cells and their metadata |
| `scirepl_create_cell` | Add a code or Markdown cell |
| `scirepl_delete_cell` | Delete a cell |
| `scirepl_set_cell_language` | Change a cell's kernel |
| `scirepl_get_kernel_status` | Report kernel readiness |

The language schemas include Python, R, TypR, Prolog, Bash, JavaScript, Lua,
and ClojureScript.

### Packages, workbooks, and files

| Tool | Purpose |
| --- | --- |
| `scirepl_open_catalog` | Open **Browse Packages, Bundles & Workbooks** |
| `scirepl_list_catalog` | List the catalog |
| `scirepl_install_package` | Install a catalog package, bundle, or workbook |
| `scirepl_install_local_package` | Install a package from a host-side zip |
| `scirepl_import_file` | Import a host-side workbook or notebook |
| `scirepl_export_workbook` | Trigger workbook export |
| `scirepl_get_shared_files` | List SharedVFS files |
| `scirepl_vfs_write` | Copy one host-side file into a SciREPL VFS |
| `scirepl_vfs_overlay_dir` | Copy a filtered host-side directory into a SciREPL VFS |
| `scirepl_vfs_list` | List the Prolog Emscripten VFS |

### Settings

| Tool | Purpose |
| --- | --- |
| `scirepl_get_settings` | Read SciREPL settings; credential-bearing values are redacted |
| `scirepl_set_setting` | Set a SciREPL local-storage setting |
| `scirepl_accept_privacy` | Record local acceptance of the privacy notice |

## Recommended workflow

Use one controlled browser for an entire SciREPL task:

```text
1. scirepl_connect
2. scirepl_install_package or scirepl_import_file
3. scirepl_run_all_cells_ui
4. scirepl_get_cell_outputs_detailed
5. scirepl_screenshot
6. scirepl_disconnect
```

`scirepl_run_all_cells_ui` is the right choice when visible behaviour is part
of the test. `scirepl_run_all_cells` is faster for programmatic batch checks.

Do not open the same notebook in a second browser automation session and then
combine observations from both. Their storage, service workers, and in-memory
workbook state are independent.

### CDP debugging

For cache, worker, or storage investigation, call `scirepl_connect` with
`debugMode: true`, or set `SCIREPL_DEBUG_MODE=true`. The reported CDP URL can be
used by tooling that explicitly supports attaching with `connectOverCDP`.
Navigating an unrelated browser to the CDP URL does not attach it to the
SciREPL session.

## Local package development

Set `SCIREPL_DEV_PACKAGES` to a directory containing package zip files. When a
matching catalog item is installed, the driver prefers the local zip. The
directory is supplied by the user; this package has no source-relative default.

For surgical changes, install the normal package and then use `scirepl_vfs_write`
or `scirepl_vfs_overlay_dir`. Glob filters such as `**/*.pl` are supported.

## Security boundary

This is a trusted local-development tool, not a sandbox. The MCP client can use
it to:

- execute JavaScript and other kernels in the controlled SciREPL page;
- read host files named in import, local-package, and VFS-overlay calls;
- enumerate host directories selected for an overlay; and
- write screenshots to host paths.

The process inherits the operating-system access of the account that starts it.
Run it with only the permissions and browser profile needed for the task. The
settings reader redacts obvious credentials, including API keys, tokens, and
MCP profiles, but an agent with JavaScript execution can still control the page.
See the repository
[security policy](https://github.com/s243a/SciREPL-MCP/blob/main/SECURITY.md).

## Tests

```bash
npm run check
npm test
npm run audit
```

The deterministic suite validates tool definitions, redaction, glob handling,
configuration failure, and MCP initialize/list-tools over stdio. Browser binaries
are not needed for those tests. CI also performs a Chromium launch smoke test.

An opt-in smoke test can connect to a real local or hosted SciREPL page:

```bash
SCIREPL_E2E_URL=https://s243a.github.io/SciREPL/ npm run test:scirepl
```

## License and provenance

MIT. See [LICENSE](LICENSE). This driver was migrated from the public
UnifyWeaver repository; the exact source revision is recorded in
[PROVENANCE.md](https://github.com/s243a/SciREPL-MCP/blob/main/PROVENANCE.md).
