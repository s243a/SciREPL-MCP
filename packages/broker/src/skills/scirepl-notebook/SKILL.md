---
name: scirepl-notebook
description: Use when working inside a SciREPL session (env SCIREPL_SESSION=1, or an MCP server named "scirepl" is present) to inspect, edit, run, or create the user's notebook cells, or to browse the project's virtual filesystem. Covers the scirepl MCP tools and the per-language conventions (Python/Pyodide, R/webR, Prolog, Lua, Bash, JavaScript, TypR).
---

# Driving a SciREPL notebook

SciREPL is a mobile/PWA multi-language scientific notebook. You were launched by
it through its MCP broker, so the user's work lives in **notebook cells on their
device**, not in files in this working directory. You act on the notebook through
the `scirepl` MCP tools (shown to you as `mcp__scirepl__<tool>`).

## When this applies
- `SCIREPL_SESSION=1` is set in the environment, **or**
- an MCP server named `scirepl` is configured (tools prefixed `mcp__scirepl__`).

If neither holds, you are NOT in a SciREPL session — don't use these tools.

If `SCIREPL_SESSION=1` is set but no `mcp__scirepl__*` tools are mounted, report
that the SciREPL MCP server is not available in this agent turn. Do not try to
edit notebook cells through shell files; ask the user to reconnect the Remote
bridge and restart/reselect the remote agent so the next turn starts with MCP.

## The cell model
A notebook is an ordered list of **cells**. Each cell has an **index** (1-based,
referenced as `In[N]` or just the number), an optional **name**, a **language**,
**code**, and (after running) an **output**. Reference a cell by its name or its
`In[N]`/index.

## Tools
- `mcp__scirepl__list_cells` — list every cell (index, name, language, code
  preview). **Start here** to understand the notebook.
- `mcp__scirepl__read_cell` `{cell, property}` — read `.code` (default),
  `.output`, `.language`, or `.type` of one cell.
- `mcp__scirepl__read_cells` `{range, cells, property, format}` — batch-read
  several cells or a range in one call. Prefer this over repeated `read_cell`
  calls when loading notebook context.
- `mcp__scirepl__write_cell` `{cell, property, value}` — update a cell's `.code`
  (default) or `.language`.
- `mcp__scirepl__create_cell` `{language, code}` — add a new cell. `language` ∈
  markdown, python, r, javascript, lua, bash, prolog, typr, clojurescript, ai.
  **Creating does not run it.**
- `mcp__scirepl__rename_cell` `{cell, name}` — set a cell's display name.
- `mcp__scirepl__execute_cell` `{cell}` — run a cell and return its output.
- `mcp__scirepl__run_cells` `{through}` — run non-empty code cells in order from
  the top through a target (or through the end when omitted).
- `mcp__scirepl__inspect_namespace` `{language}` — inspect live Python or R
  variables and their types/shapes without creating a cell.
- `mcp__scirepl__list_dir` `{path}` / `mcp__scirepl__read_file` `{path}` /
  `mcp__scirepl__grep` `{pattern, path}` — **read-only** access to the virtual
  filesystem. Allowed roots: `/user` (project source), `/shared`, `/tmp`, `/nb`.
  Use these to read project source, e.g. `/user/src/unifyweaver/core`.

## Working etiquette (important)
- **Look before you act.** Call `list_cells` (and `read_cell`) before editing, so
  you reference the right cell and don't clobber work.
- **Permissions are enforced on the user's device.** Writes and executions may pop
  an Ask dialog, or be blocked by Review mode, write scope, a per-tool rule, a
  per-kernel rule, the global JavaScript switch, or revoked remote consent. If a
  tool returns a denial, respect it — explain what you wanted to do and ask; never
  try to route around it.
- **Create vs. run are separate.** `create_cell`/`write_cell` only change content;
  the user (or a separate, separately-gated `execute_cell`) runs it. Prefer
  proposing code and letting the user run it unless they ask you to execute.
- Keep edits minimal and match the cell's existing language/style.

## App permission model

The security level provides defaults, and the user can add more specific rules:

- **Open** normally allows notebook tools and kernel execution without prompts,
  but still respects the separate **Allow source browsing** setting and
  **Agent writes** scope.
- **Full control** also overrides those two coarse source/write switches while it
  is selected. It does not override Review mode, remote-data consent, a global
  JavaScript disable, or an explicit per-tool/per-kernel Ask or Deny. Treat Full
  control as permission to perform the user's requested work, not permission to
  expand its scope.
- **Per-kernel access** is configured from **Menu → Languages → AI Kernel
  Access…** or **AI Settings → Kernels…**. Default inherits the security level;
  Allow runs without a kernel prompt, Ask requires device confirmation, and Deny
  blocks execution. A multi-kernel request is checked before it starts.
- **Review mode** remains authoritative at every security level: do not run code,
  edit or delete existing cells, or attempt a workaround. If the user enabled the
  separate review-note option, `create_cell` may append only to the dedicated
  **AI Review** worksheet and will not execute the cell.
- **Remote-data consent** is checked when the app connects or reconnects and again
  before a remote call. If it is absent or revoked, stop and ask the user to review
  the disclosure and reconnect; no security level substitutes for consent.

Kernel rules are app-side execution authorization, not capability isolation or a
general sandbox guarantee. JavaScript executes natively in SciREPL's browser
context, and Python and ClojureScript can reach browser JavaScript APIs through
their runtime bridges. The global JavaScript switch applies only to the JavaScript
kernel. The app can block or ask before normal kernel execution starts, but after
code is allowed to run, in-app data and network restrictions are best-effort.
Never promise that allowed notebook code is isolated from app-held data, and never
use one kernel's browser bridge to bypass a denied notebook or filesystem action.

## Per-language conventions
The kernel preludes provide helpers; use them rather than reinventing.

### Python (Pyodide)
- `plot(x, y)` → interactive Plotly chart; `mplot()` + `plt.show()` → matplotlib.
- `from sympy import *` then **return** the expression (don't print) → renders as
  LaTeX. `import numpy as np` is available.
- `nb_read(cell, prop)` / `nb_write(cell, prop, val)` for cross-cell data.
- `%pip install <pkg>` for pure-Python packages. Trailing `;` suppresses output.

### R (webR), Prolog (SWI-WASM), Lua, Bash, JavaScript, TypR
- Write idiomatic code for the cell's language. These runtimes do not all have the
  same isolation model: JavaScript runs in the native browser context; Python and
  ClojureScript use browser-hosted runtimes that can bridge to JavaScript APIs;
  other languages use their configured browser or WebAssembly runtimes.
- TypR compiles to R and then executes through the R runtime. AI-initiated TypR
  execution therefore needs both TypR and R kernel permission; Ask or Deny on
  either dependency applies to the whole run.
- Cross-language data sharing goes through the shared VFS (`/shared`) and the
  notebook cell properties — not in-memory globals.

## Mirroring a session log (mobile-friendly)
Terminal scrollback is limited on a phone, and a full-screen TUI has none — so when
a session produces history worth keeping, mirror a **cleaned summary** into a
notebook cell with `create_cell` (markdown), or append to a dedicated "Session log"
cell with `write_cell`. Keep: commands run, key outputs, decisions, conclusions.
Strip: verbose tool-call dumps, terminal redraw/escape noise, repeated prompts.
Ask before writing a large log, and don't write in Review mode.

## Typical workflows
- **Review a notebook:** `list_cells` → `read_cell` each → summarize logic, flag
  errors/typos, suggest fixes. (In Review mode you can only read.)
- **Add an analysis:** `list_cells` to find context → `create_cell` with the new
  code → tell the user it's ready to run (or `execute_cell` if they asked).
- **Fix a bug:** `read_cell .code` + `.output` → propose the fix → `write_cell`
  the corrected code → optionally `execute_cell` and check `.output`.
- **Use project source:** `grep`/`read_file` under `/user/src/...` to ground your
  answer in the actual UnifyWeaver/SciREPL code.
