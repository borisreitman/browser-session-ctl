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
        set: "set <index> <text...> — replace one cell's source.",
        run: "run <index> — execute one cell (like Shift+Enter).",
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  fireClick(target) {
    const rect = target.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new PointerEvent("pointerup", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
  }

  // Clicking a cell is how this UI decides which cell subsequent toolbar
  // commands apply to — same as a person clicking into it first.
  async activate(index) {
    this.fireClick(this.cellEl(index));
    await this.sleep(100);
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
    this.fireClick(el);
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
    const cm = this.cellEl(index).querySelector(".cm-content");
    if (!cm) throw new Error(`Cell ${index} has no editor to type into`);
    cm.focus();
    // CodeMirror 6 is a contenteditable div that listens for real browser
    // text-editing commands (it has to, to support IME/autocomplete/etc.),
    // so driving it through execCommand keeps its internal state in sync —
    // directly mutating .textContent would not.
    document.execCommand("selectAll");
    document.execCommand("delete");
    document.execCommand("insertText", false, text);
    await this.sleep(150);
    return this.get(index);
  }

  async run(index) {
    await this.activate(index);
    this.runToolbarCommand("notebook:run-cell-and-select-next");
    await this.sleep(500);
    return this.cells()[Number(index)];
  }

  // There's no toolbar button for changing a cell's type — only the "Cell
  // type" <select> in the main toolbar, a real native <select> that this
  // UI's framework controls, so it needs the same native-setter + event
  // dance as any other framework-controlled input.
  setCellType(type) {
    const select = document.querySelector('select[aria-label="Cell type"]');
    if (!select) throw new Error('No "Cell type" selector found on this page');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, type);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async insert(index, position = "below", type = "code") {
    await this.activate(index);
    const pos = position === "above" ? "above" : "below";
    this.runToolbarCommand(`notebook:insert-cell-${pos}`);
    await this.sleep(150);
    const newIndex = pos === "below" ? Number(index) + 1 : Number(index);
    if (type === "markdown" || type === "raw") {
      await this.activate(newIndex);
      this.setCellType(type);
      await this.sleep(150);
    }
    return this.cells()[newIndex];
  }

  async delete(index) {
    await this.activate(index);
    this.runToolbarCommand("notebook:delete-cell");
    await this.sleep(150);
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
    await this.sleep(300);
    const dialog = document.querySelector(".jp-Dialog");
    if (dialog) {
      const confirmBtn = [...dialog.querySelectorAll("button")].find((b) =>
        /restart/i.test(b.textContent)
      );
      if (!confirmBtn) throw new Error('Restart confirmation dialog appeared but no "Restart" button was found');
      this.fireClick(confirmBtn);
    }
    // Running every cell (especially ones hitting a network/disk/kernel)
    // can take a while; give it real time rather than a fixed short delay.
    for (let i = 0; i < 100; i += 1) {
      await this.sleep(300);
      const indicator = document.querySelector(".jp-Notebook-ExecutionIndicator");
      if (!indicator || !/busy/i.test(indicator.textContent)) break;
    }
    await this.sleep(300);
    return this.cells();
  }
}
