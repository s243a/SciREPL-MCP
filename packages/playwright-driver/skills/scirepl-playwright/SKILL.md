---
name: scirepl-playwright
description: Automate SciREPL workbooks in a dedicated Chromium session with the scirepl_* MCP tools.
---

# SciREPL Playwright workflow

Use this skill when a task requires running, inspecting, or troubleshooting a
SciREPL workbook through the Playwright driver.

## Session rule

Complete one workflow in one `scirepl_*` browser session. A separate general
browser or Playwright MCP normally has different storage and in-memory state.
Only treat another client as the same browser when it explicitly attaches to
the CDP URL with `connectOverCDP`.

## Standard workflow

```text
1. scirepl_connect
2. scirepl_install_package or scirepl_import_file, when needed
3. scirepl_run_all_cells_ui for visible testing, or scirepl_run_all_cells for batch execution
4. scirepl_get_cell_outputs_detailed
5. scirepl_get_visible_state and scirepl_screenshot for supporting evidence
6. scirepl_disconnect
```

Prefer `scirepl_run_all_cells_ui` when the user mentions the menu, visible
output, warnings, browser behaviour, or screenshots.

## Diagnosing output

1. Reproduce the issue through the requested run path.
2. Read `scirepl_get_cell_outputs_detailed`; it combines app-model output with
   DOM-rendered text and includes `Out [n]` labels where present.
3. Capture a screenshot for layout and rendering evidence.
4. Use console messages from `scirepl_get_visible_state` as supporting evidence,
   not as a substitute for the visible cell result.
5. If the user sees output that the tool omits, treat that as an instrumentation
   gap and inspect the driver before concluding the output is absent.

## Browser-state investigation

For stale assets, cache, storage, workers, or PWA-update issues:

```text
1. scirepl_connect(debugMode: true, remoteDebuggingPort: 9223)
2. scirepl_get_browser_debug_info
3. Continue the ordinary workflow in that same session
4. If necessary, attach a CDP-capable debugger to the reported URL
```

Opening the debugger URL as a web page is not equivalent to attaching through
CDP.

## Supported kernels

Python, R, TypR, SWI-Prolog, Bash, JavaScript, Lua, and ClojureScript.

## Local package iteration

- Set `SCIREPL_DEV_PACKAGES` to a user-selected directory of local package zip
  files, then use `scirepl_install_package`.
- Use `scirepl_install_local_package` when the exact zip path is known.
- Use `scirepl_vfs_write` for one-file overlays.
- Use `scirepl_vfs_overlay_dir` for directory overlays; filters such as
  `**/*.pl` are supported.

## Safety

The driver is not a filesystem sandbox. Local import, package, overlay, and
screenshot tools read or write paths with the server process's OS permissions.
Do not expose the server to untrusted MCP clients. The settings reader redacts
credential-bearing values, but JavaScript execution still gives the client
control of the SciREPL page.
