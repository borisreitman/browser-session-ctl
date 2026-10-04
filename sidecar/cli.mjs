#!/usr/bin/env node
import { writeFile, readFile, readdir, mkdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { origin, profileFromEnv } from "./config.mjs";

// This repo's plugins/ dir — never shipped with the extension, only ever
// handed to it at runtime via plugin.load. See PLUGINS_DIR below and
// plugin.<namespace>'s auto-load fallback.
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const RUNTIME_PLUGINS_DIR = join(EXTENSION_DIR, "runtime-plugins");
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*$/i;

const USAGE = `Drive a Chrome tab from the shell.

Default: every command uses the tab that is active right now
(the selected tab in the Chrome window last focused). The target
is resolved again on each command. Nothing is remembered.

Usage:
  browser-session-ctl <command> ...
  browser-session-ctl --tab <id> <command> ...

  browser-session-ctl status
  browser-session-ctl profiles
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
  browser-session-ctl react [detect|tree|inspect|invoke|setValue|setHookState|...] [json-or-string args...]
  browser-session-ctl reload-extension
  browser-session-ctl plugin.<namespace> [args...]
  browser-session-ctl plugin-list
  browser-session-ctl plugin-load <namespace> <file.js>
  browser-session-ctl plugin-inject <namespace> [file.js]
  browser-session-ctl plugin-unload <namespace>

--dom | --react
            click / type / press auto-detect React pages and drive them through
            React's own handlers (see \`status\`). These flags force plain DOM
            events or React handlers instead.
--profile <name>
            Which Chrome profile to drive when several are connected to the
            sidecar (also BROWSER_SESSION_CTL_PROFILE). Optional when only one
            is connected. \`profiles\` lists them; rename in the extension popup.
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
  browser-session-ctl plugin-inject my-thing ./my-thing.js
  browser-session-ctl plugin.my-thing foo bar
  browser-session-ctl plugin-unload my-thing
`;

function printUsage() {
  process.stderr.write(USAGE);
}

// Set from --dom / --react: forces the engine for click/type/press. Unset means
// auto: the extension drives React pages through React's own handlers.
let engine;
// Set from --profile / BROWSER_SESSION_CTL_PROFILE: which connected Chrome profile gets commands.
let profile = profileFromEnv();

async function command(method, params = {}) {
  if (engine && method.startsWith("page.")) params = { ...params, engine };
  const response = await fetch(`${origin()}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, profile: profile || undefined }),
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
    if (arg === "--profile" || arg === "-p") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("--profile requires a profile name");
      profile = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
      continue;
    }
    if (arg === "--dom" || arg === "--react") {
      engine = arg.slice(2);
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

// Two plugin operations:
//
// runtime-load (`plugin-load`): persist source in the extension so every
// current and future tab has the namespace until plugin-unload.
//
// inject-load (`plugin-inject`, and every `plugin.<ns> …`): rewrite
// extension/runtime-plugins/<ns>.js from the current file on disk, replace
// the same stored source (tabs inherit), and inject into this tab. Edit the
// plugin, run a command — no chrome://extensions reload. The extension's
// own files (background, content, manifest) still need a reload when *they*
// change.

function requireNamespace(namespace) {
  if (!namespace || !NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid plugin namespace "${namespace}". Use letters, digits, and dashes, e.g. "jupyter-notebook".`
    );
  }
  return namespace;
}

function sourceHash(code) {
  let hash = 2166136261;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function wrapRuntimePlugin(namespace, code) {
  return `"use strict";
// inject-load ${sourceHash(code)}
globalThis.__bscPluginExports = globalThis.__bscPluginExports || {};
(function () {
${code}
  if (typeof Plugin !== "function") {
    throw new Error('Plugin file must define a class named "Plugin".');
  }
  globalThis.__bscPluginExports[${JSON.stringify(namespace)}] = Plugin;
})();
`;
}

async function writeRuntimePlugin(namespace, code) {
  requireNamespace(namespace);
  await mkdir(RUNTIME_PLUGINS_DIR, { recursive: true });
  await writeFile(join(RUNTIME_PLUGINS_DIR, `${namespace}.js`), wrapRuntimePlugin(namespace, code), "utf8");
}

async function removeRuntimePlugin(namespace) {
  try {
    requireNamespace(namespace);
    await unlink(join(RUNTIME_PLUGINS_DIR, `${namespace}.js`));
  } catch {
    // File was never written, or already gone.
  }
}

async function repoPluginCode(namespace) {
  try {
    return await readFile(join(PLUGINS_DIR, `${namespace}.js`), "utf8");
  } catch {
    return null;
  }
}

async function resolvePluginFile(namespace, filePath) {
  requireNamespace(namespace);
  if (filePath) return readFile(filePath, "utf8");
  const repoCode = await repoPluginCode(namespace);
  if (repoCode) return repoCode;
  throw new Error(
    `No file given and plugins/${namespace}.js is missing. usage: plugin-inject <namespace> [file.js]`
  );
}

async function invokePluginAutoLoad(namespace, args, tabId) {
  const repoCode = await repoPluginCode(namespace);
  if (repoCode) await writeRuntimePlugin(namespace, repoCode);
  const invokeParams = withTab({ namespace, args, ...(repoCode ? { code: repoCode } : {}) }, tabId);
  try {
    return await command("plugin.invoke", invokeParams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/^Unknown plugin namespace/.test(message)) throw err;
    if (!repoCode) throw err;
    await writeRuntimePlugin(namespace, repoCode);
    await command("plugin.load", { namespace, code: repoCode });
    return await command("plugin.invoke", invokeParams);
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
      const health = await response.json();
      if (health.extensionConnected && (profile || health.profiles.length === 1)) {
        try {
          health.page = await command("page.status", withTab({}, tabId));
        } catch (err) {
          health.page = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      printResult(health);
      return;
    }
    case "profiles": {
      const health = await (await fetch(`${origin()}/health`)).json();
      printResult(health.profiles || []);
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
    case "react": {
      const [fn = "detect", ...raw] = rest;
      const args = raw.map((a) => {
        try { return JSON.parse(a); } catch { return a; }
      });
      printResult(await command("react.call", withTab({ fn, args }, tabId)));
      return;
    }
    case "reload-extension":
      printResult(await command("ext.reload", {}));
      return;
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
      await writeRuntimePlugin(namespace, code);
      printResult(await command("plugin.load", { namespace, code }));
      return;
    }
    case "plugin-inject": {
      const [namespace, filePath] = rest;
      if (!namespace) throw new Error("usage: plugin-inject <namespace> [file.js]");
      const code = await resolvePluginFile(namespace, filePath);
      await writeRuntimePlugin(namespace, code);
      printResult(await command("plugin.inject", withTab({ namespace, code }, tabId)));
      return;
    }
    case "plugin-unload": {
      const namespace = rest[0];
      if (!namespace) throw new Error("usage: plugin-unload <namespace>");
      printResult(await command("plugin.unload", { namespace }));
      await removeRuntimePlugin(namespace);
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
