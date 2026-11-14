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
  browser-session-ctl type-trusted <ref|name> <text> [--submit] [--no-clear]
  browser-session-ctl press <key>
  browser-session-ctl scroll [up|down]
  browser-session-ctl scroll-trusted [up|down|left|right] [amount] [--selector CSS | --ref eN | --name TEXT] [--step N] [--delay MS]
  browser-session-ctl screenshot [path]
  browser-session-ctl images [--selector CSS] [--min-size N] [--index I,J] [--scroll] [--save DIR] [--prefix NAME]
  browser-session-ctl annotate [on|off]
  browser-session-ctl debug-set-favicon [on|off]
  browser-session-ctl debug-annotate-highlight [action|active|idle]
  browser-session-ctl config
  browser-session-ctl config annotate-new-tabs [on|off]
  browser-session-ctl react [detect|tree|inspect|invoke|setValue|setHookState|...] [json-or-string args...]
  browser-session-ctl angular [detect|survey|globals|component|expando] [json-or-string args...]
  browser-session-ctl reload-extension
  browser-session-ctl plugin.<namespace> [args...]   (an arg of @- reads stdin, @file:<path> reads a file, keeping newlines)
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

scroll-trusted sends real mouse-wheel events through the Chrome DevTools Protocol
(isTrusted), for panes that ignore \`scroll\` / scrollTop changes and only load
more (infinite scroll, chat history) on a genuine wheel gesture. It wheels over the
centre of --selector/--ref/--name (default: the viewport), by [amount] px (default
600) in --step px notches, and reports the scroller's position before and after
(\`moved\`; a chat-style pane can have a negative scrollTop, where up is more
negative). Briefly attaches the debugger, like type-trusted.

type-trusted types via the Chrome DevTools Protocol (real key events, not
page-script dispatchEvent), for fields that ignore synthetic input from
\`type\` — e.g. one that only reacts to trusted keystrokes. Briefly attaches
Chrome's debugger to the tab (shows the "being debugged" bar) and detaches
right after. Clears the field first unless --no-clear is passed.

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
  browser-session-ctl type-trusted e51 "Annhurst"
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

// Plugin args are plain shell words, which flattens multi-line text. "@-" is replaced by stdin and
// "@file:<path>" by that file's contents, so a plugin method can receive text with its newlines intact.
async function expandPluginArgs(args) {
  const out = [];
  for (const arg of args) {
    if (arg === "@-") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      out.push(Buffer.concat(chunks).toString("utf8").replace(/\n$/, ""));
    } else if (arg.startsWith("@file:")) {
      out.push((await readFile(arg.slice("@file:".length), "utf8")).replace(/\n$/, ""));
    } else {
      out.push(arg);
    }
  }
  return out;
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
    printResult(await invokePluginAutoLoad(namespace, await expandPluginArgs(rest), tabId));
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
    case "type-trusted": {
      const submit = rest.includes("--submit");
      const noClear = rest.includes("--no-clear");
      const args = rest.filter((arg) => arg !== "--submit" && arg !== "--no-clear");
      const [target, ...textParts] = args;
      if (!target) throw new Error("ref or name is required");
      printResult(
        await command(
          "page.typeTrusted",
          withTab(
            {
              ...targetParams(target),
              text: textParts.join(" "),
              submit,
              clear: !noClear,
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
    case "scroll-trusted": {
      const p = {};
      const rest2 = [...rest];
      const valued = { "--selector": "selector", "--ref": "ref", "--name": "name", "--step": "step", "--delay": "delay", "--x": "x", "--y": "y" };
      for (let i = 0; i < rest2.length; i += 1) {
        const a = rest2[i];
        if (valued[a]) {
          p[valued[a]] = ["step", "delay", "x", "y"].includes(valued[a]) ? Number(rest2[i + 1]) : rest2[i + 1];
          rest2.splice(i, 2);
          i -= 1;
        }
      }
      for (const a of rest2) {
        if (/^(up|down|left|right)$/i.test(a)) p.direction = a.toLowerCase();
        else if (/^\d+(\.\d+)?$/.test(a)) p.amount = Number(a);
        else throw new Error(`scroll-trusted: unexpected argument "${a}"`);
      }
      printResult(await command("page.scrollTrusted", withTab(p, tabId)));
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
    case "images": {
      // images [--selector CSS] [--min-size N] [--index I,J] [--scroll] [--save DIR] [--prefix NAME]
      // Without --save: list the page's images. With --save: download each
      // original file (extension picked from its type) into DIR.
      const o = { selector: "img", minSize: 0, index: undefined, scroll: false, save: null, prefix: "image" };
      for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i];
        if (a === "--selector") o.selector = rest[(i += 1)];
        else if (a === "--min-size") o.minSize = Number(rest[(i += 1)]) || 0;
        else if (a === "--index") o.index = String(rest[(i += 1)]).split(",").map(Number);
        else if (a === "--scroll") o.scroll = true;
        else if (a === "--save") o.save = rest[(i += 1)];
        else if (a === "--prefix") o.prefix = rest[(i += 1)];
        else if (a === "--url") (o.urls ||= []).push(rest[(i += 1)]);
      }
      const items = await command(
        "page.images",
        withTab(
          { selector: o.selector, minSize: o.minSize, index: o.index, scroll: o.scroll, urls: o.urls, download: Boolean(o.save) },
          tabId
        )
      );
      if (!o.save) {
        printResult(items);
        return;
      }
      await mkdir(o.save, { recursive: true });
      const EXT = { "image/jpeg": "jpg", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
      const saved = [];
      for (const it of items) {
        if (!it.dataUrl) {
          saved.push({ index: it.index, url: it.url, error: it.error || "no data" });
          continue;
        }
        const m = /^data:([^;,]*)(;base64)?,/.exec(it.dataUrl);
        const mime = (m && m[1]) || "application/octet-stream";
        const ext = EXT[mime] || mime.split("/")[1] || "bin";
        const body = it.dataUrl.slice(m ? m[0].length : 0);
        const path = join(o.save, `${o.prefix}-${it.index}.${ext}`);
        await writeFile(path, m && m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body)));
        saved.push({ index: it.index, path, width: it.width, height: it.height, source: it.source, url: it.originalUrl || it.url });
      }
      printResult(saved);
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
    case "angular": {
      const [fn = "detect", ...raw] = rest;
      const args = raw.map((a) => {
        try { return JSON.parse(a); } catch { return a; }
      });
      printResult(await command("angular.call", withTab({ fn, args }, tabId)));
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
