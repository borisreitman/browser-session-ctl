// Built-in plugin: manipulate a Jupyter Notebook 7 / JupyterLab notebook tab.
//
//   browser-session-ctl --tab <id> plugin.jupyter-notebook cells
//   browser-session-ctl --tab <id> plugin.jupyter-notebook get 2
//   browser-session-ctl --tab <id> plugin.jupyter-notebook set 2 "print('hi')"
//   browser-session-ctl --tab <id> plugin.jupyter-notebook run 2
//   browser-session-ctl --tab <id> plugin.jupyter-notebook insert 2 below code
//   browser-session-ctl --tab <id> plugin.jupyter-notebook delete 5
//
// This UI (Notebook 7 / JupyterLab) has no public `window.Jupyter` API to
// call into, so every action here drives the real DOM the same way a user
// would: click a cell to make it active, then invoke the same toolbar
// command the UI itself uses (via its `data-command` attribute) or edit the
// CodeMirror 6 editor via the browser's own text-insertion commands. This is
// slower than a real API but works with whatever's actually rendered, and
// survives across notebook UI versions better than reaching into internals.
class Plugin {
  help() {
    return {
      namespace: "jupyter-notebook",
      methods: {
        help: "Show this message.",
        cells: "List every cell: index, type, and source.",
        get: "get <index> — return one cell's source.",
        set: "set <index> <text...> — replace one cell's source (works on rendered markdown cells too). For multi-line text pass @- (stdin) or @file:<path> as the text.",
        run: "run <index> — execute one cell (like Shift+Enter). Returns after ~0.5s; the cell may still be running.",
        output:
          "output <index> — structured outputs of one cell: executionCount (null while running, '*'), and a list of items: {type: 'table', columns, rows} for rendered DataFrames, {type: 'text', text} for streams/plain results, {type: 'error', text}, {type: 'image', mime, bytes}, {type: 'html', text} otherwise.",
        runWait:
          "runWait <index> [timeoutSeconds=60] — run one cell, wait until it finishes, and return its output (same shape as `output`).",
        insert:
          "insert <index> [above|below] [code|markdown|raw] — insert a new cell relative to <index> (default: below, code).",
        delete: "delete <index> — delete one cell.",
        restartRunAll:
          "restartRunAll — restart the kernel and run every cell top to bottom (confirms the dialog for you).",
        status:
          "status — dump this notebook's status: path, cell count, and the kernel backing it (name, executable, language, state).",
      },
    };
  }

  cellEl(index) {
    const i = Number(index);
    const cells = document.querySelectorAll(".jp-Cell");
    const el = cells[i];
    if (!el) throw new Error(`No cell at index ${index} (notebook has ${cells.length} cells)`);
    return el;
  }

  cellType(cellEl) {
    return cellEl.className.match(/jp-(Code|Markdown|Raw)Cell/)?.[1]?.toLowerCase() || "unknown";
  }

  cellSource(cellEl) {
    const cm = cellEl.querySelector(".cm-content");
    if (!cm) return null;
    return [...cm.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
  }

  activeIndex() {
    return [...document.querySelectorAll(".jp-Cell")].findIndex((c) =>
      c.classList.contains("jp-mod-active")
    );
  }

  // Clicking a cell is how this UI decides which cell subsequent toolbar
  // commands apply to — same as a person clicking into it first.
  async activate(index) {
    bsc.fireClick(this.cellEl(index));
    await bsc.sleep(100);
    const got = this.activeIndex();
    if (got !== Number(index)) {
      throw new Error(`Could not select cell ${index} (notebook reports active cell ${got})`);
    }
  }

  // The notebook toolbar (and several cell-context buttons) are custom
  // <jp-button data-command="..."> elements, not native <button>s. Each one
  // always acts on whatever cell is currently active.
  runToolbarCommand(command) {
    const el = document.querySelector(`[data-command="${command}"]`);
    if (!el) throw new Error(`Toolbar command "${command}" is not available on this page`);
    bsc.fireClick(el);
  }

  cells() {
    return [...document.querySelectorAll(".jp-Cell")].map((cellEl, index) => ({
      index,
      type: this.cellType(cellEl),
      source: this.cellSource(cellEl),
    }));
  }

  get(index) {
    return this.cellSource(this.cellEl(index));
  }

  async set(index, ...textParts) {
    const text = textParts.join(" ");
    await this.activate(index);
    const cellEl = this.cellEl(index);
    // A rendered markdown cell keeps a hidden editor, so typing into it silently does nothing. A
    // double-click is how a person opens it for editing; run it afterwards to render it again.
    const wasRendered = this.cellType(cellEl) === "markdown" && cellEl.classList.contains("jp-mod-rendered");
    if (wasRendered) {
      cellEl.querySelector(".jp-RenderedMarkdown")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await bsc.sleep(200);
    }
    const cm = cellEl.querySelector(".cm-content");
    if (!cm) throw new Error(`Cell ${index} has no editor to type into`);
    cm.focus();
    // CodeMirror 6 is a contenteditable div that listens for real browser
    // text-editing commands (it has to, to support IME/autocomplete/etc.),
    // so driving it through execCommand keeps its internal state in sync —
    // directly mutating .textContent would not.
    document.execCommand("selectAll");
    document.execCommand("delete");
    document.execCommand("insertText", false, text);
    await bsc.sleep(150);
    if (wasRendered) await this.renderMarkdown(index);
    return this.get(index);
  }

  // "Run" on a markdown cell renders it, but run-and-select-next adds a cell when this is the last one.
  async renderMarkdown(index) {
    const before = document.querySelectorAll(".jp-Cell").length;
    await this.activate(index);
    this.runToolbarCommand("notebook:run-cell-and-select-next");
    await bsc.sleep(300);
    if (document.querySelectorAll(".jp-Cell").length > before) {
      await this.activate(before);
      this.runToolbarCommand("notebook:delete-cell");
      await bsc.sleep(150);
    }
  }

  // Structured view of a cell's rendered output so callers don't need screenshots. A rendered pandas
  // DataFrame is an HTML <table>: header cells in <thead>, and in each body row the index <th> followed by
  // <td>s. Note pandas itself truncates long frames (display.max_rows) before they ever reach the DOM.
  output(index) {
    const cellEl = this.cellEl(index);
    const prompt = cellEl.querySelector(".jp-InputPrompt")?.textContent?.match(/\[(.*?)\]/)?.[1] ?? null;
    const running = prompt === "*";
    const items = [];
    const text = (el) => el.textContent.replace(/\u00a0/g, " ").trim();
    for (const out of cellEl.querySelectorAll(".jp-OutputArea-output")) {
      const table = out.querySelector("table");
      if (table) {
        const headRows = [...table.querySelectorAll("thead tr")].map((tr) => [...tr.children].map(text));
        const columns = headRows.length ? headRows[headRows.length - 1] : [];
        const rows = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map(text));
        items.push({ type: "table", columns, rows });
        continue;
      }
      const mime = out.getAttribute("data-mime-type") || "";
      if (/application\/vnd\.jupyter\.stderr/.test(mime) || out.closest(".jp-OutputArea-child")?.querySelector(".jp-RenderedText[data-mime-type*='error']")) {
        items.push({ type: "error", text: text(out) });
      } else if (out.querySelector("img")) {
        const img = out.querySelector("img");
        items.push({ type: "image", mime: mime || "image", bytes: (img.getAttribute("src") || "").length });
      } else if (out.querySelector("pre") || /text\/plain|stdout|stderr/.test(mime)) {
        items.push({ type: "text", text: out.querySelector("pre")?.textContent ?? text(out) });
      } else {
        items.push({ type: "html", text: text(out).slice(0, 2000) });
      }
    }
    return { index: Number(index), executionCount: prompt, running, outputs: items };
  }

  async runWait(index, timeoutSeconds = 60) {
    await this.run(index);
    const deadline = Date.now() + Number(timeoutSeconds) * 1000;
    while (Date.now() < deadline) {
      if (!this.output(index).running) return this.output(index);
      await bsc.sleep(300);
    }
    throw new Error(`Cell ${index} still running after ${timeoutSeconds}s`);
  }

  async run(index) {
    await this.activate(index);
    this.runToolbarCommand("notebook:run-cell-and-select-next");
    await bsc.sleep(500);
    return this.cells()[Number(index)];
  }

  // There's no toolbar button for changing a cell's type — only the "Cell
  // type" <select> in the main toolbar, a real native <select> that this
  // UI's framework controls, so it needs the same native-setter + event
  // dance as any other framework-controlled input.
  setCellType(type) {
    const select = document.querySelector('select[aria-label="Cell type"]');
    if (!select) throw new Error('No "Cell type" selector found on this page');
    bsc.select(select, type);
  }

  async insert(index, position = "below", type = "code") {
    await this.activate(index);
    const pos = position === "above" ? "above" : "below";
    this.runToolbarCommand(`notebook:insert-cell-${pos}`);
    await bsc.sleep(150);
    const newIndex = pos === "below" ? Number(index) + 1 : Number(index);
    if (type === "markdown" || type === "raw") {
      await this.activate(newIndex);
      this.setCellType(type);
      await bsc.sleep(150);
    }
    return this.cells()[newIndex];
  }

  async delete(index) {
    await this.activate(index);
    this.runToolbarCommand("notebook:delete-cell");
    await bsc.sleep(150);
    return { cellCount: document.querySelectorAll(".jp-Cell").length };
  }

  // Reads the Jupyter Server REST API directly (same origin as this page,
  // so the browser sends its session cookie automatically) instead of
  // running code in a cell — this doesn't touch notebook content at all.
  async status() {
    const path = decodeURIComponent(location.pathname.replace(/^\/notebooks\//, ""));
    const sessionsRes = await fetch(`${location.origin}/api/sessions`, { credentials: "same-origin" });
    if (!sessionsRes.ok) throw new Error(`GET /api/sessions failed (${sessionsRes.status})`);
    const sessions = await sessionsRes.json();
    const session = sessions.find((s) => s.path === path);
    if (!session) throw new Error(`No running kernel session found for "${path}"`);

    const specsRes = await fetch(`${location.origin}/api/kernelspecs`, { credentials: "same-origin" });
    const specs = specsRes.ok ? await specsRes.json() : null;
    const spec = specs?.kernelspecs?.[session.kernel.name]?.spec;

    return {
      notebookPath: path,
      title: document.title,
      cellCount: document.querySelectorAll(".jp-Cell").length,
      kernel: {
        id: session.kernel.id,
        name: session.kernel.name,
        executionState: session.kernel.execution_state,
        connections: session.kernel.connections,
        lastActivity: session.kernel.last_activity,
        displayName: spec?.display_name ?? null,
        language: spec?.language ?? null,
        executable: spec?.argv?.[0] ?? null,
      },
    };
  }

  // "Restart Kernel and Run All Cells" pops a confirmation dialog (a real
  // user could Cancel this by accident, so this UI doesn't skip it) —
  // confirm it the same way a person would, by clicking its "Restart" button.
  async restartRunAll() {
    this.runToolbarCommand("notebook:restart-run-all");
    await bsc.sleep(300);
    const dialog = document.querySelector(".jp-Dialog");
    if (dialog) {
      const confirmBtn = [...dialog.querySelectorAll("button")].find((b) =>
        /restart/i.test(b.textContent)
      );
      if (!confirmBtn) throw new Error('Restart confirmation dialog appeared but no "Restart" button was found');
      bsc.fireClick(confirmBtn);
    }
    // Running every cell (especially ones hitting a network/disk/kernel)
    // can take a while; give it real time rather than a fixed short delay.
    for (let i = 0; i < 100; i += 1) {
      await bsc.sleep(300);
      const indicator = document.querySelector(".jp-Notebook-ExecutionIndicator");
      if (!indicator || !/busy/i.test(indicator.textContent)) break;
    }
    await bsc.sleep(300);
    return this.cells();
  }
}
