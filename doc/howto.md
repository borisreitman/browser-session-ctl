# How to drive awkward pages

Notes for third-party sites the agent does not control. Read this before improvising.

Always **snapshot, act, snapshot again**. Refs (`e1`, `e2`, …) are viewport-only and renumber when the page scrolls or the framework re-renders.

Use `--tab <id>` whenever `chrome://extensions` or another window might be focused. `tabs` lists ids.

```bash
browser-session-ctl tabs
browser-session-ctl snapshot --tab 123456789
```

---

## See what actually happened

| Command | What it is | Use it when |
| --- | --- | --- |
| `snapshot` | Visible controls + refs | Choosing what to click or type |
| `text` | Visible inner text | Reading copy, confirming a review or success page |
| `screenshot PATH` | Current **viewport** only | Checking radio/checkbox chrome that snapshot cannot see |

There is no HTML dump and no full-page screenshot. Scroll, then screenshot again.

Custom `role="radio"` / `role="checkbox"` often have **no `checked` flag**. Infer selection from the rest of the page (new fields appeared) or from a screenshot.

---

## Native `<select>` dropdowns

A real `<select>` is snapshotted as `combobox` and may show `options=[...]`.

**Do not** `click` an option label by name. Click-by-name matches the whole `<select>` (all option labels concatenated) and selects nothing.

**Do** set the option by typing the visible label into the combobox ref:

```bash
browser-session-ctl options e8
browser-session-ctl type e8 "The option label"
```

Then snapshot and confirm `value=` is that label.

`options <ref|name>` slurps `<option>` nodes even when the menu is closed. If the list is empty it opens the control and slurps again.

---

## Custom dropdowns (div menus)

If `options` returns nothing useful, the choices are probably not `<option>` / `role="option"` until the menu is open.

```bash
browser-session-ctl click e9
browser-session-ctl snapshot
browser-session-ctl click "The option label"
```

Filter-as-you-type comboboxes (country pickers and similar): click the control, `type` the filter text, snapshot, then click the matching `option` ref. If the value does not stick, try `type … --submit` (Enter on the inner input), then screenshot — snapshot often omits the selected label even when the widget shows it.

`press ArrowDown` / `press Enter` is **synthetic**. Custom widgets usually ignore it. Same for OS-level keystrokes — this tool cannot send those.

`click "Some label"` also walks visible text as a fallback (smallest exact match first). Prefer a fresh ref when you have one.

---

## Long text and framework-controlled inputs

`browser-session-ctl type e2 hello` joins shell words with spaces. For a multi-sentence body, POST JSON so newlines and punctuation stay intact:

```bash
curl -s http://127.0.0.1:8765/command \
  -H 'content-type: application/json' \
  -d '{"method":"page.type","params":{"tabId":123,"ref":"e7","text":"…paragraph…"}}'
```

A framework-controlled field may show the new value in the next snapshot but **not** store it in app state. If a later review step still has the old value:

1. Scroll the field into view.
2. `type` the **ref** (not the name).
3. Click another field (blur).
4. Continue, then `text` the review page to confirm.

Name match can hit the wrong control (`mailto:` links, labels, a second button with the same word).

---

## Labels vs controls

Snapshot includes `<label>` nodes. A click on the label text may hit the label, not the input. Use the textbox/combobox ref.

---

## Radios and choice cards

Native radios and `role="radio"` cards usually work with `click e2` or `click "The visible choice"`.

After the click, snapshot again. Conditional fields appear or disappear.

---

## Fields below the fold

Snapshot skips off-screen controls (except open menu items). `scroll down` / `scroll up` is 600px. Then snapshot.

The 250-control cap fills up fast on a long catalog. Scroll so the field you need is in view, or the refs you want never appear.

---

## Multi-step forms

`Back` / `Continue` keep in-page state if you do not reload the tab. Going back to fix a field, then Continue through later steps, is safe.

Do **not** reload the page tab to pick up extension code. Reload the unpacked **extension** card instead. The next command re-injects the page script.

If a command returns `Unknown method: page.options`, the service worker is stale — reload the extension card (circular arrow). Version on the card should match `extension/manifest.json`.

---

## Shared accessible names

Several textboxes can share the same accessible name (placeholder copy reused on every card). Snapshot after scroll and `type` **refs** (`e11`, `e18`), not the shared name.

---

## What this tool cannot do

- Click by pixel coordinate.
- OS-trusted keystrokes or “real” mouse.
- Set `<input type="file">`. Ask the user.
- Automate `chrome://`, the Web Store, or PDFs.
