#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { origin } from "./config.mjs";

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

--tab <id>  Override the default and use this tab instead.
            Optional. Allowed anywhere. Use \`tabs\` to list ids.

Examples:
  browser-session-ctl snapshot
  browser-session-ctl click e4
  browser-session-ctl tabs
  browser-session-ctl snapshot --tab 123456789
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

async function main(argv) {
  const { tabId, positional } = parseArgs(argv);
  const [verb, ...rest] = positional;
  if (!verb || verb === "-h" || verb === "--help") {
    printUsage();
    process.exit(verb ? 0 : 1);
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
    default:
      throw new Error(`Unknown command: ${verb}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
