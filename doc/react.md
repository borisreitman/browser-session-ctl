# React pages

`browser-session-ctl status` reports what the active tab is, including whether it is a React page:

```bash
browser-session-ctl status        # ... "page": { "engine": "react", "react": { "version": "18.3.1", "rootComponents": ["App"], ... }, "counts": {...} }
```

`page.engine` is what `click`, `type` and `press` will use:

- **react** — React page: the command calls React's own prop handlers (`onClick`, `onChange`, `onSubmit`, `onKeyDown`…) with a SyntheticEvent-shaped object, running the capture and bubble chains, honouring `stopPropagation`, and refusing disabled controls the way React does. DOM state (`value`, `checked`, selected options) is set first through the native setters because handlers read `e.target.*`.
- **dom** — anything else: synthetic DOM events, as before.

Each result carries `"engine": "react" | "dom"`. If a control has no React handler, the React path falls back to DOM events for that call and says so (`"via": "dom"`, or `reactError`). Disabled and read-only controls are errors: they are reported, not bypassed.

Force an engine with `--dom` or `--react`.

## How a page is recognised

1. `extension/react-hook.js` runs in the page's MAIN world at `document_start` and installs a `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub (or wraps the real DevTools one). React registers its renderer with it, giving the version, dev/prod build and every commit.
2. `extension/react-probe.js` is injected on demand and scans for React's per-node expandos (`__reactFiber$…`, `__reactProps$…`, `__reactContainer$…`). That finds React even when the hook was too late.

Both must run in the MAIN world: the isolated content-script world cannot see expandos set by page scripts.

## React-only commands

```bash
browser-session-ctl react controls                     # every control: selector, type, label, value, handlers, owning component
browser-session-ctl react fill "#email" me@example.com # text, textarea, number, range, contenteditable
browser-session-ctl react fill Subscribe true          # checkbox (by selector or label); ARIA switch/checkbox divs too
browser-session-ctl react fill "input[name=plan]" pro  # radio group by value or label
browser-session-ctl react fill "#color" Green          # <select> by value or label
browser-session-ctl react fill "#tags" '["a","c"]'     # <select multiple>
browser-session-ctl react fillForm '{"#bio":"hi","#age":7}'
browser-session-ctl react click "#send"
browser-session-ctl react press "#q" Enter             # keydown/keypress/keyup, then implicit form submit
browser-session-ctl react tree                         # component tree
browser-session-ctl react inspect Counter              # props + hook state of a component
browser-session-ctl react setHookState Counter 0 41    # write useState directly (bypasses app handlers)
```

`fill` reports `applied` (did the DOM end up with the requested value?). A controlled input that rewrites its value, say upper-casing or truncating, comes back `applied: false` with `now` showing what React actually kept.

Tests: `npm test` (React fixture in `tests/fixtures/react/`); `node tests/fixtures/react/react-explore.mjs` is an extension-free headless check.
