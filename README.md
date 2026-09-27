# browser-session-ctl

Drive the Chrome window you already have open from the shell — including third-party sites you do not own.

This is not Selenium. Selenium starts a new browser. This loads an unpacked extension into your current session, so a local agent can click, type, and read the same tabs, cookies, and logins you are already using.

This makes it well suited to pairing with an AI coding agent — Claude Code, Cursor, or similar — that already runs shell commands on your machine. Rather than the agent driving a separate, logged-out browser instance, it drives the same Chrome window and tabs you have open, with your existing sessions, so it can read a page you're looking at, fill a form on a site you're already signed into, or hand off a browser task mid-flow without you re-authenticating anywhere.

```
you / agent  --HTTP-->  sidecar :8765  --WebSocket-->  Chrome extension  -->  any http(s) tab
```

The extension asks for access to all websites because the agent has to work on arbitrary pages. It only accepts commands from `127.0.0.1`.

## License

This project is **[GNU GPL v3](LICENSE) or later**.

It can read and act on whatever is in the Chrome profile where you install it. The GPL keeps distributed changes open, so you can always inspect the code that sees those tabs. The extension is shipped as plain JavaScript — do not minify or obfuscate it.

## 1. Start the sidecar

In this repo:

```bash
npm install
npm start
```

Leave that terminal running. You should see:

```
Sidecar listening on http://127.0.0.1:8765
```

If something else is already bound to port 8765, stop it first. The extension cannot connect until this process is up.

## 2. Use a separate Chrome profile

Load this extension in a **new Chrome profile**, not the one you use for email, banking, or work.

The agent can snapshot, click, and read every `http(s)` tab in the profile where the extension is installed. A dedicated profile keeps it away from cookies, logins, and tabs you do not want it to see by accident.

1. In Chrome, click your profile picture (top right) → **Add** → create a profile, for example `Agent`.
2. Open that profile (a new Chrome window). Do all remaining steps in **that** window only.
3. Sign into only the sites this agent should use.

Do not install the extension in your everyday profile.

## 3. Load the unpacked extension

In the Agent profile window:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** (top left). Do not click **Update** — that button checks the Chrome Web Store and will not load this folder.
4. Select the `extension/` directory in this repo (the folder that contains `manifest.json`, not the repo root).
5. Chrome will warn that the extension can read and change all your data on all websites. That is required for third-party sites. Allow it only on a machine you trust.
6. Confirm the card says **browser-session-ctl** and the toggle is on.

After you change extension files later, click the circular **reload** arrow on that card (next to the on/off switch). The version in `extension/manifest.json` should match the version on the card. **Update** at the top of the page is the wrong button.

## 4. Confirm it is connected

1. Open a normal `https://` tab. Chrome settings, `chrome://` pages, and the Web Store cannot be scripted.
2. In a second terminal, from this repo:

```bash
npm run ctl -- status
```

You want:

```json
{
  "ok": true,
  "extensionConnected": true,
  "port": 8765
}
```

If `extensionConnected` is `false`, the sidecar is not running, the extension is disabled, or you still need to reload the unpacked build.

There is no **Reconnect** button on `chrome://extensions`. That page only has Details, Remove, Errors, and the reload arrow. Reconnect lives in the toolbar popup: puzzle-piece icon → pin **browser-session-ctl** → click the icon. You usually do not need it. Connection happens on its own once both the sidecar and the extension are running.

The toolbar badge shows **on** or **off**.

## Global command

`doc/browser-session-ctl` is an example wrapper that runs `npm run ctl` in this repo, from any working directory. Copy it to `~/bin`, then edit `DEFAULT_ROOT` to your clone (or set `$BROWSER_SESSION_CTL_ROOT`):

```bash
cp doc/browser-session-ctl ~/bin/browser-session-ctl
chmod +x ~/bin/browser-session-ctl
```

Then, from anywhere:

```bash
browser-session-ctl status
browser-session-ctl snapshot
```

`~/bin` must be on your `PATH`.

## Commands

```bash
browser-session-ctl tabs
browser-session-ctl active
browser-session-ctl open https://example.com
browser-session-ctl nav https://example.com
browser-session-ctl snapshot
browser-session-ctl click e4
browser-session-ctl click "Sign in"
browser-session-ctl options e9
browser-session-ctl type e2 hello@example.com
browser-session-ctl press Enter
browser-session-ctl text
browser-session-ctl screenshot /tmp/page.png
```

`open [url]` creates a new tab and prints its `id` right away, so you can target it with `--tab <id>` on the very next command without first running `tabs` to look it up. Add `--background` to open it without switching focus. If the currently active tab is blank (`about:blank` or a fresh new-tab page), it reuses that tab instead of opening another one. By default it also turns `annotate` on for the page it opens — see `config annotate-new-tabs` below to change that.

```bash
browser-session-ctl open https://example.com
# { "id": 123456789, "windowId": ..., "title": "Example Domain", "url": "https://example.com/" }
browser-session-ctl snapshot --tab 123456789
```

By default every command uses the **currently active tab** — the selected tab in the Chrome window you last focused. That is looked up again on each command; the sidecar does not remember a tab.

Pass `--tab <id>` only when you want a different tab. It is optional and can go before or after the command:

```bash
browser-session-ctl tabs
browser-session-ctl snapshot --tab 123456789
browser-session-ctl click e4 --tab 123456789
```

Screenshot of a background `--tab` will briefly focus that tab (Chrome can only capture what is on screen).

`snapshot` lists visible controls with refs (`e1`, `e2`, …). Snapshot, act, then snapshot again. On sites you do not control the DOM changes; stale refs fail on purpose.

`options` reads every choice on a dropdown from the DOM (`<select>` options, listbox items, custom menus). If the menu is closed and empty, it opens the control and slurps again.

`annotate on` overlays a small status pill in the bottom-right corner of the page showing the last time this tab was controlled, and updates it on every subsequent command. It has three states: **yellow with a bright red border and a pulse** the instant a command fires, settling to **plain yellow** a few seconds later (still under control, just not that instant), and fading to **black** after 2 minutes with no commands at all. While it's on, every command also flashes the tab's favicon to the extension's own icon (a dark lightning bolt on a bright yellow circle) for the same few seconds as the border — both share one timer (`FLASH_MS`, 5s) that resets on every new command, so back-to-back activity keeps them up rather than letting them flicker. `annotate off` removes both. It only works on a normal `http(s)` page already showing content — like the rest of the commands, it refuses a blank or restricted tab (`about:blank`, a fresh new-tab page, `chrome://…`). Both live in the page itself, so navigating or reloading clears them; run `annotate on` again afterward if you want them back.

```bash
browser-session-ctl annotate on
browser-session-ctl annotate off
```

`debug-set-favicon on` swaps the tab's favicon to that same extension icon and leaves it there (no auto-revert, and it ignores whether `annotate` is on) — a quick way to confirm the swap mechanism itself actually works on a given tab. `debug-set-favicon off` restores it.

```bash
browser-session-ctl debug-set-favicon on
browser-session-ctl debug-set-favicon off
```

`debug-annotate-highlight` forces the bar straight into one of its three states — `action` (yellow + red border + pulse), `active` (plain yellow), or `idle` (black) — instantly, without waiting on a real command or either timeout. Requires `annotate on` already be running on that tab.

```bash
browser-session-ctl debug-annotate-highlight action
browser-session-ctl debug-annotate-highlight active
browser-session-ctl debug-annotate-highlight idle
```

`config annotate-new-tabs [on|off]` is a persistent global setting (stored in the extension, survives restarts) controlling whether `open <url>` automatically turns `annotate` on for the page it opens. **Default: on.** Run it with no value to read the current setting. Run `config` with no setting name at all to print every global setting at once.

```bash
browser-session-ctl config
browser-session-ctl config annotate-new-tabs
browser-session-ctl config annotate-new-tabs off
```

JSON works too:

```bash
curl -s http://127.0.0.1:8765/command \
  -H 'content-type: application/json' \
  -d '{"method":"page.snapshot"}'
```

## Tests

An end-to-end suite (`tests/run.mjs`) drives the sidecar + extension against local fixtures (`tests/fixtures/*.html`, loaded via `file://`) covering native `<select>` dropdowns, custom ARIA comboboxes/listboxes, form fields, and click-by-ref / click-by-text.

1. The sidecar must be running and the extension connected — see [Confirm it is connected](#4-confirm-it-is-connected).
2. Chrome blocks `file://` scripting for extensions by default, so turn on **Allow access to file URLs**: `chrome://extensions` → the **browser-session-ctl** card → **Details** → toggle it on.
3. Run the suite:

   ```bash
   npm test
   ```

It starts from whatever tab is currently active, opens one new tab in the foreground so you can watch it work, and runs every fixture in that tab. A passing run ends with:

```
15 passed, 0 failed
```

The tab is left open afterward for inspection. Set `CLOSE_TAB=1` to have the suite close it automatically instead:

```bash
CLOSE_TAB=1 npm test
```

## Render a trace

A trace is a markdown log of commands, snapshot listings, and viewport screenshots (see [doc/demo-trace.md](doc/demo-trace.md)). Put images in a folder with the same name (`doc/demo-trace/`), then:

```bash
scripts/trace-render.js doc/demo-trace.md
```

Or `npm run trace-render` to render every `doc/**/*.md`. Each source writes `<name>.pdf` beside it. Local Chrome is required (`--print-to-pdf`).

## Limits

- `http://`, `https://`, and `file://` tabs (the last needs **Allow access to file URLs** enabled for the extension, see Tests below). Chrome settings, `chrome://`/`edge://` pages, extension pages, the Web Store, and the PDF viewer are blocked by Chrome.
- Extension clicks are not OS-level “trusted” input. Most sites work; a few bot-sensitive flows may ignore them.
- Password field values are redacted in snapshots.
- The sidecar binds to localhost only. Do not expose port 8765.

## Why not Selenium?

Attaching Playwright or Selenium to your daily profile means quitting Chrome and restarting it with `--remote-debugging-port`. This extension attaches to the session that is already running.
