# jupyter-notebook plugin

Drive a Jupyter Notebook 7 / JupyterLab tab from the shell: list cells, rewrite source, run them, insert, delete, restart-and-run-all.

Source: `plugins/jupyter-notebook.js`. First `plugin.jupyter-notebook …` auto-loads it. The tab must already be an open notebook (`/notebooks/…`), not the Jupyter file browser.

```bash
browser-session-ctl --tab <id> plugin.jupyter-notebook
browser-session-ctl --tab <id> plugin.jupyter-notebook cells
```

There is no public `window.Jupyter` API in this UI. Every action clicks the real DOM the same way a person would: activate a cell, then fire the toolbar command (`data-command="notebook:…"`) or type into CodeMirror 6. That is slower than a kernel API, and it survives notebook UI versions better than reaching into internals.

## Methods

| Method | What it does |
| --- | --- |
| `help` | Describe the methods. Also the fallback when you omit a method name. |
| `cells` | Every cell: `index`, `type` (`code` / `markdown` / `raw`), `source`. |
| `get <index>` | One cell's source. |
| `set <index> <text…>` | Replace that cell's source. Shell words are joined with spaces. |
| `run <index>` | Execute that cell (toolbar: run cell and select next). |
| `insert <index> [above\|below] [code\|markdown\|raw]` | New cell relative to `<index>`. Defaults: below, code. |
| `delete <index>` | Delete that cell. |
| `restartRunAll` | Restart the kernel and run every cell. Clicks **Restart** on the confirmation dialog. |
| `status` | Notebook path, cell count, and the kernel session (name, language, execution state). |

Indexes are 0-based, matching `cells`.

```bash
browser-session-ctl --tab <id> plugin.jupyter-notebook get 2
browser-session-ctl --tab <id> plugin.jupyter-notebook set 2 "print('hi')"
browser-session-ctl --tab <id> plugin.jupyter-notebook run 2
browser-session-ctl --tab <id> plugin.jupyter-notebook insert 2 below markdown
browser-session-ctl --tab <id> plugin.jupyter-notebook delete 5
browser-session-ctl --tab <id> plugin.jupyter-notebook restartRunAll
browser-session-ctl --tab <id> plugin.jupyter-notebook status
```

## How it works

**Activate, then command.** The toolbar always acts on the active cell. The plugin clicks `.jp-Cell` *n*, checks `.jp-mod-active`, then clicks `[data-command="notebook:run-cell-and-select-next"]` (or insert / delete / restart-run-all).

**`set` goes through CodeMirror 6.** The editor is a contenteditable that listens for browser text-editing commands. The plugin focuses `.cm-content`, then `document.execCommand` select-all / delete / insertText. Assigning `.textContent` would show the new source and leave CodeMirror's model stale.

**`status` does not run a cell.** It `fetch`es same-origin `/api/sessions` and `/api/kernelspecs` with the page's cookies, and matches the session whose path is this notebook.

**`restartRunAll` waits on the busy indicator.** After confirming the dialog it polls `.jp-Notebook-ExecutionIndicator` until it is no longer "busy" (up to ~30s). Long kernels may still be running after that; call `status` or `cells` again if you need to wait further.

## Limits

- Notebook 7 / JupyterLab DOM only (`.jp-Cell`, CodeMirror 6, `jp-button data-command`). Classic Notebook (`window.Jupyter`) is a different UI.
- `set` from the CLI flattens newlines (arguments are strings joined by spaces). For a multi-line body, POST JSON to the sidecar so the text stays intact — same pattern as `page.type` in the README.
- Clicking a toolbar command that is not on the page throws (`Toolbar command "…" is not available`).
- Plugin state lives in the page. Reload the notebook tab and you get a fresh `Plugin` instance; the notebook content on disk is unchanged until you save in the UI.
