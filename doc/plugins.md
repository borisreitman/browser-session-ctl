# Plugin load: runtime-load vs inject-load

A plugin is a JS file that defines a class named `Plugin`. The extension git tree does not ship plugin logic. Source lives in `plugins/` (or any file you point at).

The source is loaded **once on the extension**. Tabs inherit that copy. A tab does not get a second load. What each tab cannot share is a live `Plugin` object: the class uses that page's `document`, so each tab constructs its own instance from the shared source.

Neither operation requires reloading the extension when **plugin** source changes. Reload `chrome://extensions` only when you change the extension itself (`manifest.json`, `background.js`, `content.js`).

| Operation | Command | What it does |
| --- | --- | --- |
| **runtime-load** | `plugin-load <namespace> <file.js>` | Store the source on the extension. Every current and future http(s) tab inherits that namespace until `plugin-unload`. |
| **inject-load** | `plugin-inject <namespace> [file.js]` | Read the file on disk, replace the stored source (same map — tabs inherit the new bytes), rewrite `extension/runtime-plugins/<namespace>.js`, and inject that file into **this** tab now. |

`plugin.<namespace> …` does both as needed: the first time the extension does not already have the namespace, it runtime-loads `plugins/<namespace>.js` (if that file exists). Every invocation inject-loads from disk (updates the shared source), then runs the method on this tab. That is the probing loop: edit the plugin, run the command, no extension reload.

```bash
browser-session-ctl plugin.google-flights status
# first time: runtime-load from plugins/google-flights.js, then inject-load and invoke
# later: inject-load from disk (shared source updates) and invoke on this tab

# your own file (not in plugins/):
browser-session-ctl plugin-load hello doc/hello-world-plugin.js
browser-session-ctl plugin.hello greet Boris
# edit the file, then either:
browser-session-ctl plugin-inject hello doc/hello-world-plugin.js
browser-session-ctl plugin.hello greet Boris
browser-session-ctl plugin-unload hello
```

`plugin-inject` with no file path reads `plugins/<namespace>.js`. `plugin-list` shows `loaded` (the extension-level map) and `inRepo`. `plugin-unload` drops the persisted namespace and the generated copy.

If you `plugin-load` and `plugin-inject` the same namespace, they update the **same** stored source. Each push bumps a generation and **taints** every open tab: existing `Plugin` instances are dropped. This tab is rebuilt immediately; other tabs get a new instance on the next `plugin.<ns> …` (or as soon as they receive the taint). Same source bytes still reinit — a push always invalidates `this`.

## Why a generated file

Chrome cannot `eval` / `new Function` plugin source in the content-script world, and many sites (Google Flights is one) also forbid it in the page. So the CLI writes a generated classic script under `extension/runtime-plugins/` and the extension injects that **file**. The generated files are gitignored; they are not a second set of plugins.

## What resets

- Per-page `this` is dropped on every load/inject push (all tabs are tainted). A new instance is built on this tab immediately, and on other tabs at the next invoke or taint delivery. Navigation or reload also drops `this`.
- The persisted **source** stays until `plugin-unload`.
- Changing `extension/` (not `plugins/`) still needs an extension reload, then use the new version number on the card.

## The `bsc` API (core methods inside plugins)

Plugins run in the extension's isolated world, which sees the page's DOM but not its JavaScript, so React internals and the page's own globals are invisible to them. Instead of reimplementing clicks, typing and waiting in every plugin, a plugin uses the global `bsc`, which is the same code the CLI uses.

**A plugin knows how its site is built, so it picks the variant itself.** There is no auto-detection in plugin code. If the site is React, call `bsc.reactClick(el)`; if not, call `bsc.click(el)`. (Auto-detection exists only for the CLI verbs, where the caller is driving an arbitrary page and cannot know.) The React variants throw if the page is not React, and if no React handler takes the element, so a site that changes how it is built breaks the plugin loudly instead of silently misbehaving. Use the plain variant for an element React does not handle (a native link, a third-party widget); use `bsc.react.controls()` on the live page to see which elements have handlers. A site can mix: the same plugin may call `reactClick` for one element and `click` for another.

### Plain DOM events (synchronous, take an element)

| Call | What it does |
| --- | --- |
| `bsc.fireClick(el)` | pointerdown, mousedown, pointerup, mouseup and a synthetic click. |
| `bsc.click(el)` | The same, then `el.click()`. |
| `bsc.fill(el, text, { clear, typing, change })` | Native value setter plus an `input` event, then `change`. `typing` sends an `insertText` InputEvent after focusing; `clear` first empties the field with a `deleteContentBackward` event; `change: false` skips the `change` event. |
| `bsc.select(selectEl, label, { partial })` | Pick an `<option>` by value or label (substring with `partial`), fire `input` and `change`, return the label. |
| `bsc.press(el, key)` | keydown, keypress and keyup on the element, with `keyCode`. |

### React handlers (async, take an element)

| Call | What it does |
| --- | --- |
| `bsc.reactClick(el)` | Runs the element's mousedown, mouseup and click handlers in React's capture and bubble order, honouring `stopPropagation`. A checkbox or radio is toggled the way a click does. Throws for a disabled control. |
| `bsc.reactFill(el, text)` | Sets the DOM value, then calls the field's `onInput` and `onChange`. |
| `bsc.reactSelect(el, label, { partial })` | Same for a `<select>`; returns the label. |
| `bsc.reactPress(el, key)` | keydown, keypress and keyup handlers; Enter in a field also submits its form. |
| `bsc.isReact()` | Whether the page has a React renderer (for a plugin that wants to assert it). |
| `bsc.react.<fn>(...)` | Any function of the page-side probe: `controls`, `inspect`, `tree`, `fill`, `click`, `setHookState`, … Arguments and results are JSON. |

### Helpers and reads

| Call | What it does |
| --- | --- |
| `bsc.sleep(ms)`, `bsc.clean(text)` | Delay; collapse whitespace and trim. |
| `bsc.waitFor(fn, tries = 20, ms = 250)` | First truthy `fn()` (it may be async) or `null`. |
| `bsc.isDisplayed(el, { minSize = 2 })` | Rendered, visible and at least `minSize` px each way. |
| `bsc.dates.looksLikeDate(v)` / `.parse(v)` / `.toIso(v)` | `YYYY-MM-DD` or `MM/DD/YYYY` helpers. |
| `bsc.status()`, `bsc.snapshot()`, `bsc.text()`, `bsc.find(name)`, `bsc.options(target)`, `bsc.scroll(dir)` | The CLI's page reads. |
| `bsc.command(method, params)` | Escape hatch for a page-level command (`page.*`, `react.call`). Other commands are refused and the tab is always the plugin's own. |

```js
class Plugin {
  async sortCheapest() {
    const select = document.querySelector("#sort");
    return await bsc.reactSelect(select, "Price: low to high", { partial: true }); // React site
    // return bsc.select(select, "Price: low to high", { partial: true });        // native site
  }

  async openOffer(index) {
    const button = this.offerButtons()[index];
    await bsc.reactClick(button);
    return await bsc.waitFor(() => document.querySelector(".fare-sheet"), 20, 250);
  }
}
```

Limits: `bsc` needs the isolated world. If a page's CSP forces the main-world fallback (see "Why a generated file"), `bsc` is not defined there. React variants on a disabled control throw rather than doing nothing, so wait for the control first (`await bsc.waitFor(() => !input.disabled)`).
