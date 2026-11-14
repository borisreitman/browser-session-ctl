#!/usr/bin/env node
// Experiment: can we detect and drive a React site through React's own
// internals instead of DOM events? Launches headless Chrome, talks CDP over
// the same `ws` dependency the sidecar uses, so it needs neither the extension
// nor the sidecar. Run: node tests/fixtures/react/react-explore.mjs
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = new URL(".", import.meta.url);
const fixture = (n) => new URL(n, here).href;
const plain = new URL("../form.html", import.meta.url).href;
const hookSrc = await readFile(new URL("../../../extension/react-hook.js", here), "utf8");
const probeSrc = await readFile(new URL("../../../extension/react-probe.js", here), "utf8");

async function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await readFile(mac, { flag: "r" }); return mac; } catch {}
  const base = join(homedir(), ".cache/puppeteer/chrome");
  const [v] = await readdir(base);
  return join(base, v, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
}

const dir = await mkdtemp(join(tmpdir(), "bsc-react-"));
const chrome = spawn(await findChrome(), [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error("chrome exited early:\n" + buf)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.once("open", r));
let id = 0;
const pending = new Map();
const waiters = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const w of [...waiters]) if (w.method === msg.method && w.sessionId === msg.sessionId) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
const once = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));

async function newPage({ preHook }) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable"); await s("Runtime.enable");
  if (preHook) await s("Page.addScriptToEvaluateOnNewDocument", { source: hookSrc });
  const page = {
    sessionId,
    async goto(url) {
      const loaded = once("Page.loadEventFired", sessionId);
      await s("Page.navigate", { url });
      await loaded;
      await new Promise((r) => setTimeout(r, 150));
    },
    // Evaluate in the page's MAIN world.
    async main(expr) {
      const r = await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    // Evaluate in an ISOLATED world — what a content script / current plugins see.
    async isolated(expr) {
      const { frameTree } = await s("Page.getFrameTree");
      const { executionContextId } = await s("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "bsc-isolated" });
      const r = await s("Runtime.evaluate", { expression: expr, contextId: executionContextId, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
  };
  return page;
}

let passed = 0; const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok  - ${label}`); }
  else { failures.push(label); console.log(`FAIL  - ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail)}` : ""}`); }
};
const show = (label, v) => console.log(`        ${label}: ${JSON.stringify(v)}`);

try {
  // --- 1. Negative control: a plain page must not look like React.
  console.log("\n== plain page (form.html) — negative control ==");
  let p = await newPage({ preHook: false });
  await p.goto(plain);
  await p.main(probeSrc);
  let det = await p.main("__bscReact.detect()");
  check("plain page is not reported as React", det.isReact === false, det);

  // --- 2. Isolated vs main world on a real React page.
  console.log("\n== react-app.html — world visibility ==");
  p = await newPage({ preHook: false });
  await p.goto(fixture("react-app.html"));
  const keysIn = (w) => `(() => { const el = document.getElementById("inc"); return Object.keys(el).filter(k => k.startsWith("__react")).length; })()`;
  const isoKeys = await p.isolated(keysIn());
  const mainKeys = await p.main(keysIn());
  show("react expando keys on #inc — isolated world", isoKeys);
  show("react expando keys on #inc — main world", mainKeys);
  check("isolated world cannot see React internals", isoKeys === 0);
  check("main world can", mainKeys >= 2);

  // --- 3. Late discovery (no pre-installed hook): DOM scan only.
  console.log("\n== react-app.html — late discovery (DOM scan, no hook) ==");
  await p.main(probeSrc);
  det = await p.main("__bscReact.detect()");
  show("detect", det);
  check("detected as React", det.isReact === true);
  check("evidence includes fiber + container keys", det.evidence.domNodesWithFiber > 5 && det.evidence.containerKeys === 1);
  check("version via window.React global", det.version === "18.3.1", det.version);
  check("no DevTools hook means no renderer info", det.evidence.hookRenderers.length === 0);

  const tree = await p.main("__bscReact.tree()");
  show("component tree", tree);
  const names = JSON.stringify(tree);
  check("component tree has App > Counter, SearchBox, Todos", ["App", "Counter", "SearchBox", "Todos"].every((n) => names.includes(`"${n}"`)));

  // --- 4. Operate through React instead of DOM events.
  console.log("\n== operating through fibers ==");
  const insp = await p.main(`__bscReact.inspect("Counter")`);
  show("inspect(Counter)", insp);
  check("reads props and state of a component", insp.props.label === "Clicks" && insp.hooks[0].value === 0 && insp.hooks[0].kind === "useState", insp);

  const chain = await p.main(`__bscReact.componentChain(document.getElementById("inc"))`);
  check("maps a DOM node to its owning component chain", chain[0] === "Counter" && chain.includes("App"), chain);

  await p.main(`__bscReact.invoke("#inc", "onClick")`);
  await new Promise((r) => setTimeout(r, 50));
  check("invoke onClick updates React state and DOM", (await p.main(`document.getElementById("count").textContent`)) === "Clicks: 1");

  await p.main(`__bscReact.setHookState("Counter", 0, 41)`);
  await new Promise((r) => setTimeout(r, 50));
  check("setHookState sets useState directly", (await p.main(`document.getElementById("count").textContent`)) === "Clicks: 41");

  await p.main(`__bscReact.setValue("#q", "hello react")`);
  await new Promise((r) => setTimeout(r, 50));
  check("setValue drives a controlled input via onChange", (await p.main(`document.getElementById("q").value`)) === "hello react");
  check("…and component state agrees", (await p.main(`__bscReact.inspect("SearchBox").hooks[0].value`)) === "hello react");

  await p.main(`__bscReact.invoke("form", "onSubmit")`);
  await new Promise((r) => setTimeout(r, 50));
  check("invoke onSubmit on the form lifts state to App", (await p.main(`document.getElementById("last").textContent`)) === "last search: hello react");

  await p.main(`__bscReact.invoke("#add", "onClick")`);
  await new Promise((r) => setTimeout(r, 50));
  const todos = await p.main(`__bscReact.inspect("Todos").hooks[0].value`);
  check("useReducer state readable and dispatch via handler", Array.isArray(todos) && todos.length === 2, todos);
  await p.main(`__bscReact.invoke("li:nth-child(1) input", "onChange")`);
  await new Promise((r) => setTimeout(r, 50));
  check("toggle todo flips checkbox in DOM", (await p.main(`document.querySelector("li input").checked`)) === true);

  const ctx = await p.main(`document.querySelector("section").dataset.theme`);
  check("context value flowed into the tree", ctx === "dark");

  // --- 5. Early discovery with the DevTools-style hook.
  console.log("\n== react-app.html — early hook (document_start) ==");
  p = await newPage({ preHook: true });
  await p.goto(fixture("react-app.html"));
  await p.main(probeSrc);
  det = await p.main("__bscReact.detect()");
  show("detect", det);
  check("renderer registered through the hook", det.evidence.hookRenderers.length === 1 && det.evidence.hookRenderers[0].package === "react-dom", det.evidence.hookRenderers);
  check("hook reports version and dev bundle", det.version === "18.3.1" && det.dev === true);
  check("hook counted commits and saw a root", det.hook.commits >= 1 && det.hook.roots.length === 1, det.hook);
  const before = det.hook.commits;
  await p.main(`__bscReact.invoke("#inc", "onClick")`);
  await new Promise((r) => setTimeout(r, 50));
  const after = await p.main("__bscReactHook.state.commits");
  check("hook observes each re-render (commit)", after > before, { before, after });

  // --- 6. Hook on a non-React page stays inert.
  console.log("\n== early hook on a plain page ==");
  p = await newPage({ preHook: true });
  await p.goto(plain);
  await p.main(probeSrc);
  det = await p.main("__bscReact.detect()");
  check("hook alone does not cause a false positive", det.isReact === false, det);
} finally {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  ws.close(); chrome.kill();
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}
