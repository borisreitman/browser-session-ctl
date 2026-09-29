#!/usr/bin/env node
import { writeFile, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { origin } from "./config.mjs";

// This repo's plugins/ dir — never shipped with the extension, only ever
// handed to it at runtime via plugin.load. See PLUGINS_DIR below and
// plugin.<namespace>'s auto-load fallback.
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");

const USAGE = `Drive a Chrome tab from the shell.

Default: every command uses the tab that is active right now
(the selected tab in the Chrome window last focused). The target
is resolved again on each command. Nothing is remembered.

Usage:
  browser-session-ctl <command> ...
  browser-session-ctl --tab <id> <command> ...

  browser-session-ctl status
  browser-session-ctl tabs
  browser-session-ctl active
  browser-session-ctl open [url] [--background]
  browser-session-ctl close --tab <id>
  browser-session-ctl nav <url>
  browser-session-ctl back | forward | reload
  browser-session-ctl snapshot
  browser-session-ctl text
  browser-session-ctl click <ref|name>
  browser-session-ctl options <ref|name>
  browser-session-ctl type <ref|name> <text> [--submit]
  browser-session-ctl press <key>
  browser-session-ctl scroll [up|down]
  browser-session-ctl screenshot [path]
  browser-session-ctl annotate [on|off]
  browser-session-ctl debug-set-favicon [on|off]
  browser-session-ctl debug-annotate-highlight [action|active|idle]
  browser-session-ctl config
  browser-session-ctl config annotate-new-tabs [on|off]
  browser-session-ctl plugin.<namespace> [args...]
  browser-session-ctl plugin-list
  browser-session-ctl plugin-load <namespace> <file.js>
  browser-session-ctl plugin-unload <namespace>

--tab <id>  Override the default and use this tab instead.
            Optional. Allowed anywhere. Use \`tabs\` to list ids.

Examples:
  browser-session-ctl snapshot
  browser-session-ctl click e4
  browser-session-ctl tabs
  browser-session-ctl snapshot --tab 123456789
  browser-session-ctl open https://example.com
  browser-session-ctl open https://example.com --background
  browser-session-ctl close --tab 123456789
  browser-session-ctl annotate on
  browser-session-ctl annotate off
  browser-session-ctl debug-set-favicon on
  browser-session-ctl debug-set-favicon off
  browser-session-ctl debug-annotate-highlight action
  browser-session-ctl debug-annotate-highlight active
  browser-session-ctl debug-annotate-highlight idle
  browser-session-ctl config annotate-new-tabs
  browser-session-ctl config annotate-new-tabs off
  browser-session-ctl plugin.jupyter-notebook cells
  browser-session-ctl plugin-list
  browser-session-ctl plugin-load my-thing ./my-thing.js
  browser-session-ctl plugin.my-thing foo bar
  browser-session-ctl plugin-unload my-thing
`;

function printUsage() {
  process.stderr.write(USAGE);
}

async function command(method, params = {}) {
  const response = await fetch(`${origin()}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data.result;
}

function parseArgs(argv) {
  let tabId;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tab" || arg === "-t") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("--tab requires a tab id");
      tabId = Number(value);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`invalid --tab: ${value}`);
      i += 1;
      continue;
    }
    if (arg.startsWith("--tab=")) {
      const value = arg.slice("--tab=".length);
      tabId = Number(value);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`invalid --tab: ${value}`);
      continue;
    }
    positional.push(arg);
  }
  return { tabId, positional };
}

function withTab(params, tabId) {
  return tabId == null ? params : { ...params, tabId };
}

function looksLikeRef(value) {
  return /^e\d+$/i.test(value);
}

function targetParams(value) {
  return looksLikeRef(value) ? { ref: value } : { name: value };
}

function printResult(result) {
  if (result && typeof result.text === "string" && process.stdout.isTTY) {
    process.stdout.write(`${result.text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// The extension itself never ships plugin code — a namespace only exists in
// its runtime plugin map once something has plugin.load'd it. This repo
// ships plugins/*.js as source you can read, not as part of the extension
// package; the CLI is what bridges the two, loading a matching repo file on
// first use so `plugin.<namespace>` still works without an explicit
// plugin-load. A namespace loaded by hand (or from your own file, elsewhere
// on disk) always takes priority, since we only fall back to this when the
// extension reports the namespace as unknown.
async function invokePluginAutoLoad(namespace, args, tabId) {
  try {
    return await command("plugin.invoke", withTab({ namespace, args }, tabId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/^Unknown plugin namespace/.test(message)) throw err;
    const path = join(PLUGINS_DIR, `${namespace}.js`);
    let code;
    try {
      code = await readFile(path, "utf8");
    } catch {
      throw err; // no repo plugin by that name either — surface the original error
    }
    await command("plugin.load", { namespace, code });
    return await command("plugin.invoke", withTab({ namespace, args }, tabId));
  }
}

async function main(argv) {
  const { tabId, positional } = parseArgs(argv);
  const [verb, ...rest] = positional;
  if (!verb || verb === "-h" || verb === "--help") {
    printUsage();
    process.exit(verb ? 0 : 1);
  }

  if (verb.startsWith("plugin.")) {
    const namespace = verb.slice("plugin.".length);
    if (!namespace) throw new Error("plugin namespace is required, e.g. plugin.jupyter-notebook");
    printResult(await invokePluginAutoLoad(namespace, rest, tabId));
    return;
  }

  switch (verb) {
    case "status": {
      const response = await fetch(`${origin()}/health`);
      printResult(await response.json());
      return;
    }
    case "tabs":
      printResult(await command("tabs.list"));
      return;
    case "active":
      printResult(await command("tabs.active"));
      return;
    case "open": {
      const background = rest.includes("--background");
      const args = rest.filter((arg) => arg !== "--background");
      const url = args[0];
      printResult(await command("tabs.open", { url, active: !background }));
      return;
    }
    case "close": {
      if (tabId == null) throw new Error("close requires --tab <id>");
      printResult(await command("tabs.close", { tabId }));
      return;
    }
    case "nav":
    case "navigate": {
      const url = rest[0];
      if (!url) throw new Error("url is required");
      printResult(await command("page.navigate", withTab({ url }, tabId)));
      return;
    }
    case "back":
      printResult(await command("page.back", withTab({}, tabId)));
      return;
    case "forward":
      printResult(await command("page.forward", withTab({}, tabId)));
      return;
    case "reload":
      printResult(await command("page.reload", withTab({}, tabId)));
      return;
    case "snapshot":
      printResult(await command("page.snapshot", withTab({}, tabId)));
      return;
    case "text":
      printResult(await command("page.text", withTab({}, tabId)));
      return;
    case "click": {
      const target = rest.join(" ").trim();
      if (!target) throw new Error("ref or name is required");
      printResult(await command("page.click", withTab(targetParams(target), tabId)));
      return;
    }
    case "options": {
      const target = rest.join(" ").trim();
      if (!target) throw new Error("ref or name is required");
      printResult(await command("page.options", withTab(targetParams(target), tabId)));
      return;
    }
    case "type": {
      const submit = rest.includes("--submit");
      const args = rest.filter((arg) => arg !== "--submit");
      const [target, ...textParts] = args;
      if (!target) throw new Error("ref or name is required");
      printResult(
        await command(
          "page.type",
          withTab(
            {
              ...targetParams(target),
              text: textParts.join(" "),
              submit,
            },
            tabId
          )
        )
      );
      return;
    }
    case "press": {
      const key = rest[0];
      if (!key) throw new Error("key is required");
      printResult(await command("page.press", withTab({ key }, tabId)));
      return;
    }
    case "scroll":
      printResult(
        await command("page.scroll", withTab({ direction: rest[0] || "down" }, tabId))
      );
      return;
    case "screenshot": {
      const result = await command("page.screenshot", withTab({}, tabId));
      const path = rest[0] || `screenshot-${Date.now()}.png`;
      const base64 = String(result.dataUrl || "").replace(/^data:image\/png;base64,/, "");
      await writeFile(path, Buffer.from(base64, "base64"));
      printResult({ path, url: result.url, title: result.title });
      return;
    }
    case "annotate": {
      const arg = (rest[0] || "on").toLowerCase();
      if (arg !== "on" && arg !== "off") throw new Error("annotate expects on or off");
      printResult(await command("page.annotate", withTab({ enabled: arg === "on" }, tabId)));
      return;
    }
    case "debug-set-favicon": {
      const arg = (rest[0] || "on").toLowerCase();
      if (arg !== "on" && arg !== "off") throw new Error("debug-set-favicon expects on or off");
      printResult(
        await command("page.debugSetFavicon", withTab({ enabled: arg === "on" }, tabId))
      );
      return;
    }
    case "debug-annotate-highlight": {
      const arg = (rest[0] || "active").toLowerCase();
      if (!["action", "active", "idle"].includes(arg)) {
        throw new Error("debug-annotate-highlight expects action, active, or idle");
      }
      printResult(
        await command("page.debugAnnotateHighlight", withTab({ state: arg }, tabId))
      );
      return;
    }
    case "config": {
      const SETTINGS = { "annotate-new-tabs": "annotateNewTabs" };
      const name = rest[0];
      if (!name) {
        const settings = await command("settings.get");
        const result = {};
        for (const [settingName, key] of Object.entries(SETTINGS)) {
          result[settingName] = settings[key] ? "on" : "off";
        }
        printResult(result);
        return;
      }
      const key = SETTINGS[name];
      if (!key) {
        throw new Error(`config expects a known setting name, e.g. ${Object.keys(SETTINGS).join(", ")}`);
      }
      if (rest[1] === undefined) {
        const settings = await command("settings.get");
        printResult({ [name]: settings[key] ? "on" : "off" });
        return;
      }
      const value = rest[1].toLowerCase();
      if (value !== "on" && value !== "off") throw new Error("config value must be on or off");
      const settings = await command("settings.set", { key, value: value === "on" });
      printResult({ [name]: settings[key] ? "on" : "off" });
      return;
    }
    case "plugin-list": {
      const { loaded } = await command("plugin.list");
      let inRepo = [];
      try {
        inRepo = (await readdir(PLUGINS_DIR))
          .filter((f) => f.endsWith(".js"))
          .map((f) => f.slice(0, -3));
      } catch {
        // No plugins/ dir — fine, just nothing to offer.
      }
      printResult({ loaded, inRepo });
      return;
    }
    case "plugin-load": {
      const [namespace, filePath] = rest;
      if (!namespace || !filePath) throw new Error("usage: plugin-load <namespace> <file.js>");
      const code = await readFile(filePath, "utf8");
      printResult(await command("plugin.load", { namespace, code }));
      return;
    }
    case "plugin-unload": {
      const namespace = rest[0];
      if (!namespace) throw new Error("usage: plugin-unload <namespace>");
      printResult(await command("plugin.unload", { namespace }));
      return;
    }
    default:
      throw new Error(`Unknown command: ${verb}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
