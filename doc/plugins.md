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
