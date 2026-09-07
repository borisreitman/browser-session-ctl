# Browser Automate

Drive the Chrome window you already have open from the shell — including third-party sites you do not own.

This is not Selenium. Selenium starts a new browser. This loads an unpacked extension into your current session, so a local agent can click, type, and read the same tabs, cookies, and logins you are already using.

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
6. Confirm the card says **Browser Automate** and the toggle is on.

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

There is no **Reconnect** button on `chrome://extensions`. That page only has Details, Remove, Errors, and the reload arrow. Reconnect lives in the toolbar popup: puzzle-piece icon → pin **Browser Automate** → click the icon. You usually do not need it. Connection happens on its own once both the sidecar and the extension are running.

The toolbar badge shows **on** or **off**.

## Global command

`bin/browser-ctl` runs `npm run ctl` in this repo, from any working directory. Copy it to `~/bin`:

```bash
cp bin/browser-ctl ~/bin/browser-ctl
chmod +x ~/bin/browser-ctl
```

Then, from anywhere:

```bash
browser-ctl status
browser-ctl snapshot
```

The script looks for this project at `/Users/boris/work/experiment/browser-automate`, or at `$BROWSER_AUTOMATE_ROOT` if you set that. `~/bin` must be on your `PATH`.

## Commands

```bash
browser-ctl tabs
browser-ctl active
browser-ctl nav https://example.com
browser-ctl snapshot
browser-ctl click e4
browser-ctl click "Sign in"
browser-ctl type e2 hello@example.com
browser-ctl press Enter
browser-ctl text
browser-ctl screenshot /tmp/page.png
```

By default every command uses the **currently active tab** — the selected tab in the Chrome window you last focused. That is looked up again on each command; the sidecar does not remember a tab.

Pass `--tab <id>` only when you want a different tab. It is optional and can go before or after the command:

```bash
browser-ctl tabs
browser-ctl snapshot --tab 123456789
browser-ctl click e4 --tab 123456789
```

Screenshot of a background `--tab` will briefly focus that tab (Chrome can only capture what is on screen).

`snapshot` lists visible controls with refs (`e1`, `e2`, …). Snapshot, act, then snapshot again. On sites you do not control the DOM changes; stale refs fail on purpose.

JSON works too:

```bash
curl -s http://127.0.0.1:8765/command \
  -H 'content-type: application/json' \
  -d '{"method":"page.snapshot"}'
```

## Limits

- Only `http://` and `https://` tabs. Chrome settings, the Web Store, and the PDF viewer are blocked by Chrome.
- Extension clicks are not OS-level “trusted” input. Most sites work; a few bot-sensitive flows may ignore them.
- Password field values are redacted in snapshots.
- The sidecar binds to localhost only. Do not expose port 8765.

## Why not Selenium?

Attaching Playwright or Selenium to your daily profile means quitting Chrome and restarting it with `--remote-debugging-port`. This extension attaches to the session that is already running.
