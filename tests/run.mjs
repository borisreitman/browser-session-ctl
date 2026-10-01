#!/usr/bin/env node
// End-to-end test suite. Requires the sidecar running and the extension
// connected (npm start). Opens one tab, drives it through the local fixtures
// in tests/fixtures/ (page snapshot/click plus the eDreams plugin against
// captured results DOM), and closes the tab when CLOSE_TAB=1.
import { origin } from "../sidecar/config.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = (name) => new URL(`fixtures/${name}`, import.meta.url).href;

let passed = 0;
const failures = [];

async function command(method, params = {}) {
  const response = await fetch(`${origin()}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data.result;
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  - ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

// A <label> wrapping (or "for="-linked to) a control gets snapshotted too,
// with the same accessible name and doc order ahead of the control itself,
// so callers must say which role they actually want.
function findByName(snapshot, name, role) {
  return snapshot.elements.find((el) => el.name === name && el.role === role);
}

async function waitFor(fn, { timeout = 3000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

async function testDropdown(tabId) {
  console.log("\n== dropdown.html (native <select>) ==");
  const snap = await command("page.snapshot", { tabId });
  const select = findByName(snap, "Favorite color", "combobox");
  check("native select is visible in snapshot", Boolean(select), JSON.stringify(snap.elements));
  if (!select) return;

  const opts = await command("page.options", { tabId, ref: select.ref });
  const names = opts.options.map((o) => o.name);
  check(
    "options lists all <option> labels",
    ["Choose one", "Red", "Green", "Blue"].every((n) => names.includes(n)),
    `got: ${JSON.stringify(names)}`
  );

  await command("page.type", { tabId, ref: select.ref, text: "Green" });
  const after = await command("page.snapshot", { tabId });
  const selectAfter = findByName(after, "Favorite color", "combobox");
  check("typing a label selects that option", selectAfter?.value === "Green", `value: ${selectAfter?.value}`);
}

async function testCombobox(tabId) {
  console.log("\n== combobox.html (custom listbox) ==");
  await command("page.navigate", { tabId, url: fixture("combobox.html") });
  const snap = await command("page.snapshot", { tabId });

  const fruit = findByName(snap, "Pick a fruit", "combobox");
  check("static combobox trigger is visible", Boolean(fruit));
  if (fruit) {
    const opts = await command("page.options", { tabId, ref: fruit.ref });
    const names = opts.options.map((o) => o.name);
    check(
      "options reachable via aria-controls without opening the menu",
      !opts.opened && ["Apple", "Banana", "Cherry"].every((n) => names.includes(n)),
      `opened=${opts.opened} got=${JSON.stringify(names)}`
    );
  }

  const size = findByName(snap, "Pick a size", "combobox");
  check("dynamic combobox trigger is visible", Boolean(size));
  if (size) {
    const opts = await command("page.options", { tabId, ref: size.ref });
    const names = opts.options.map((o) => o.name);
    check(
      "options only appear after the trigger is clicked open",
      opts.opened && ["Small", "Medium", "Large"].every((n) => names.includes(n)),
      `opened=${opts.opened} got=${JSON.stringify(names)}`
    );
  }
}

async function testForm(tabId) {
  console.log("\n== form.html (inputs, checkbox, radio, submit) ==");
  await command("page.navigate", { tabId, url: fixture("form.html") });
  let snap = await command("page.snapshot", { tabId });

  const name = findByName(snap, "Full name", "textbox");
  await command("page.type", { tabId, ref: name.ref, text: "Ada Lovelace" });

  const bio = findByName(snap, "Bio", "textbox");
  await command("page.type", { tabId, ref: bio.ref, text: "Mathematician" });

  const subscribe = findByName(snap, "Subscribe to newsletter", "checkbox");
  await command("page.click", { tabId, ref: subscribe.ref });

  const pro = findByName(snap, "Pro", "radio");
  await command("page.click", { tabId, ref: pro.ref });

  snap = await command("page.snapshot", { tabId });
  check("typed text stuck in the name field", findByName(snap, "Full name", "textbox")?.value === "Ada Lovelace");
  check("typed text stuck in the textarea", findByName(snap, "Bio", "textbox")?.value === "Mathematician");
  check("checkbox is checked after click", findByName(snap, "Subscribe to newsletter", "checkbox")?.checked === true);
  check("radio is checked after click", findByName(snap, "Pro", "radio")?.checked === true);

  const submit = findByName(snap, "Submit", "button");
  await command("page.click", { tabId, ref: submit.ref });
  const text = await command("page.text", { tabId });
  check(
    "submit handler saw the typed and checked values",
    text.text.includes("fullname=Ada Lovelace") &&
      text.text.includes("subscribe=on") &&
      text.text.includes("plan=pro"),
    text.text
  );
}

async function testLinksAndClicks(tabId) {
  console.log("\n== links.html (click-by-ref, click-by-text, navigation) ==");
  await command("page.navigate", { tabId, url: fixture("links.html") });
  const snap = await command("page.snapshot", { tabId });

  const counter = findByName(snap, "Clicked 0 times", "button");
  check("button label reflects initial state", Boolean(counter));
  if (counter) {
    await command("page.click", { tabId, ref: counter.ref });
    const after = await command("page.text", { tabId });
    check("click-by-ref updates the button label", after.text.includes("Clicked 1 times"), after.text);
  }

  await command("page.click", { tabId, name: "Go to form" });
  const navigated = await waitFor(async () => {
    const snap = await command("page.snapshot", { tabId });
    return snap.url.endsWith("form.html") ? snap : null;
  });
  check(
    "click-by-visible-text follows the link",
    Boolean(navigated),
    navigated?.url
  );
}

async function loadRepoPlugin(namespace) {
  const code = await readFile(new URL(`../plugins/${namespace}.js`, import.meta.url), "utf8");
  const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "runtime-plugins");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, `${namespace}.js`),
    `"use strict";
globalThis.__bscPluginExports = globalThis.__bscPluginExports || {};
(function () {
${code}
  if (typeof Plugin !== "function") throw new Error('Plugin file must define a class named "Plugin".');
  globalThis.__bscPluginExports[${JSON.stringify(namespace)}] = Plugin;
})();
`,
    "utf8"
  );
  await command("plugin.load", { namespace, code });
}

async function repoPlugin(tabId, namespace, ...args) {
  const result = await command("plugin.invoke", { tabId, namespace, args });
  return result.value;
}

async function edreamsPlugin(tabId, ...args) {
  const result = await command("plugin.invoke", {
    tabId,
    namespace: "edreams",
    args,
  });
  return result.value;
}

async function testEdreams(tabId) {
  console.log("\n== edreams plugin (captured results DOM) ==");
  await loadRepoPlugin("edreams");

  const resultsUrl =
    fixture("edreams-results.html") +
    "#results/type=R;dep=2026-10-20;from=LGW;to=LCA;ret=2026-10-27";
  await command("page.navigate", { tabId, url: resultsUrl });

  const beforeClose = await command("page.text", { tabId });
  check(
    "consent overlay is on the captured page",
    beforeClose.text.includes("Continue without agreeing"),
    beforeClose.text.slice(0, 200)
  );

  const results = await edreamsPlugin(tabId, "results");
  check("results reads nested itinerary cards", results.count >= 2, JSON.stringify({ count: results.count, matching: results.matching }));
  check(
    "matching counter is the painted total, not the itinerary count",
    results.matching === "25 of 457 flights match",
    results.matching
  );
  check("sort is the selected tab", results.sort === "recommended", results.sort);

  const ba = results.flights?.[0];
  check("first card is the nested Genius BA itinerary", ba?.airlines?.includes("British Airways"), JSON.stringify(ba?.airlines));
  check("first card parses LGW→LCA departure", ba?.legs?.[0]?.from === "LGW" && ba?.legs?.[0]?.to === "LCA" && ba?.legs?.[0]?.depart === "11:35", JSON.stringify(ba?.legs?.[0]));
  check("first card parses LCA→LGW return", ba?.legs?.[1]?.from === "LCA" && ba?.legs?.[1]?.way === "return", JSON.stringify(ba?.legs?.[1]));
  check("plain fare is the non-discounted price", /817/.test(ba?.price || ""), ba?.price);
  check("Prime fare is the discounted price", /739/.test(ba?.primePrice || ""), ba?.primePrice);
  check("Prime card carries a prime marker", ba?.prime === true, JSON.stringify({ prime: ba?.prime, primePrice: ba?.primePrice }));

  const overnight = results.flights?.find((f) => f.airlines?.includes("Multiple airlines"));
  check(
    "connecting card parses overnight arrive +1 and airports",
    overnight?.legs?.[0]?.depart === "18:10" &&
      overnight?.legs?.[0]?.arrive === "10:30+1" &&
      overnight?.legs?.[0]?.from === "LGW" &&
      overnight?.legs?.[0]?.to === "LCA" &&
      overnight?.legs?.[0]?.stops === "1 stop",
    JSON.stringify(overnight?.legs?.[0])
  );

  const fallback = results.flights?.find((f) => f.airlines?.includes("Vueling"));
  check("list child without itinerary test id is still a card", Boolean(fallback), JSON.stringify(results.flights?.map((f) => f.airlines)));
  check("plain Price card is not Prime", fallback?.prime === false && !fallback?.primePrice, JSON.stringify(fallback));

  const afterResults = await command("page.text", { tabId });
  check(
    "results dismissed Continue without agreeing, not Agree",
    !afterResults.text.includes("Continue without agreeing") && !afterResults.text.includes("Agree & Close"),
    afterResults.text.slice(0, 200)
  );

  const sorted = await edreamsPlugin(tabId, "sort", "cheapest");
  check("sort cheapest clicks the tab", sorted.sort === "cheapest" && sorted.applied === true, JSON.stringify(sorted));

  const selected = await edreamsPlugin(tabId, "select", "0");
  const picked = await command("page.text", { tabId });
  check("select clicks the non-discounted fare", picked.text.includes("selected-non-discounted"), picked.text.slice(-200));
  check("select returns the BA offer", selected.selected?.airlines?.includes("British Airways"), JSON.stringify(selected.selected?.airlines));

  const airlines = await edreamsPlugin(tabId, "airlines");
  check(
    "airlines lists captured carrier checkboxes",
    airlines.some((a) => a.code === "BA" && a.checked) && airlines.some((a) => a.code === "U2"),
    JSON.stringify(airlines)
  );

  console.log("\n== edreams plugin (deferred virtual-list paint) ==");
  await command("page.navigate", {
    tabId,
    url: fixture("edreams-deferred.html") + "#results/type=R;dep=2026-10-20;from=LGW;to=LCA",
  });
  const deferred = await edreamsPlugin(tabId, "results");
  check(
    "results waits through 0 of N until the nested card paints",
    deferred.count === 1 && deferred.flights?.[0]?.airlines?.includes("British Airways"),
    JSON.stringify({ count: deferred.count, matching: deferred.matching, airlines: deferred.flights?.[0]?.airlines })
  );
  check(
    "deferred matching updates after paint",
    deferred.matching === "25 of 457 flights match",
    deferred.matching
  );

  console.log("\n== edreams plugin (finished empty search) ==");
  await command("page.navigate", {
    tabId,
    url: fixture("edreams-empty.html") + "#results/type=O;dep=2026-10-20;from=LGW;to=LCA",
  });
  const empty = await edreamsPlugin(tabId, "results");
  check(
    "results returns count 0 when the search finished with no cards",
    empty.count === 0 && empty.matching === "0 of 100 flights match" && Array.isArray(empty.flights),
    JSON.stringify(empty)
  );

  console.log("\n== edreams plugin (expired search) ==");
  await command("page.navigate", {
    tabId,
    url: fixture("edreams-expired.html") + "#results/type=R;dep=2026-10-22;from=LAX;to=LCA",
  });
  let expiredError = "";
  try {
    await edreamsPlugin(tabId, "results");
  } catch (err) {
    expiredError = err instanceof Error ? err.message : String(err);
  }
  check(
    "results fails fast when the search has expired",
    /expired/i.test(expiredError),
    expiredError
  );
}

async function testRyanair(tabId) {
  console.log("\n== ryanair plugin (captured results DOM) ==");
  await loadRepoPlugin("ryanair");
  await command("page.navigate", {
    tabId,
    url:
      fixture("ryanair-results.html") +
      "?adults=1&dateOut=2026-10-20&dateIn=2026-10-27&isReturn=true&originIata=STN&destinationIata=BGY",
  });
  const results = await repoPlugin(tabId, "ryanair", "results");
  check(
    "results reads outbound and return cards",
    results.outbound?.length === 3 && results.inbound?.length === 2,
    JSON.stringify({ outbound: results.outbound?.length, inbound: results.inbound?.length })
  );
  check(
    "first outbound is FR2738 in the morning",
    results.outbound?.[0]?.flight === "FR2738" && results.outbound?.[0]?.depart === "05:55",
    JSON.stringify(results.outbound?.[0])
  );
  check(
    "Malta Air operated card keeps flight number and operator",
    results.outbound?.[2]?.flight === "FR2734" && results.outbound?.[2]?.operatedBy === "Malta Air",
    JSON.stringify(results.outbound?.[2])
  );
  check(
    "return card reports seats left",
    results.inbound?.[1]?.flight === "FR2735" && results.inbound?.[1]?.seatsLeft === 2,
    JSON.stringify(results.inbound?.[1])
  );

  const after = await command("page.text", { tabId });
  check(
    "results dismissed No, thanks, not Yes I agree",
    !after.text.includes("No, thanks") && after.text.includes("Yes, I agree"),
    after.text.slice(0, 180)
  );

  const selected = await repoPlugin(tabId, "ryanair", "select", "return", "1");
  const picked = await command("page.text", { tabId });
  check("select return 1 clicks FR2735", picked.text.includes("selected-fr2735"), picked.text.slice(-80));
  check("select returns the FR2735 offer", selected.selected?.flight === "FR2735", JSON.stringify(selected.selected));
}

async function testReact(tabId) {
  console.log("\n== react-app.html (React internals via MAIN world) ==");
  const react = (fn, ...args) => command("react.call", { tabId, fn, args });
  const settle = () => new Promise((r) => setTimeout(r, 100));

  await command("page.navigate", { tabId, url: fixture("react/react-app.html") });
  const det = await waitFor(async () => {
    const d = await react("detect");
    return d.isReact ? d : null;
  }, { timeout: 4000 });
  check("detect reports React", det?.isReact === true, JSON.stringify(det));
  check(
    "document_start hook registered the renderer (version, dev build)",
    det?.version === "18.3.1" && det?.dev === true && det?.evidence.hookRenderers.length === 1,
    JSON.stringify(det?.evidence)
  );
  check("hook saw the root commit", det?.hook?.commits >= 1 && det?.hook?.roots.length === 1, JSON.stringify(det?.hook));

  const tree = JSON.stringify(await react("tree"));
  check("tree lists App, Counter, SearchBox, Todos", ["App", "Counter", "SearchBox", "Todos"].every((n) => tree.includes(`"${n}"`)), tree);

  const counter = await react("inspect", "Counter");
  check("inspect reads props and useState", counter?.props.label === "Clicks" && counter.hooks[0].value === 0, JSON.stringify(counter));

  const countText = async () => (await command("page.text", { tabId })).text;
  await react("invoke", "#inc", "onClick");
  await settle();
  check("invoke onClick re-renders", (await countText()).includes("Clicks: 1"), (await countText()).slice(0, 120));

  await react("setHookState", "Counter", 0, 41);
  await settle();
  check("setHookState writes useState", (await countText()).includes("Clicks: 41"));

  await react("setValue", "#q", "hello react");
  await settle();
  const snap = await command("page.snapshot", { tabId });
  check("setValue shows in the normal snapshot too", Boolean(snap.elements.find((e) => e.value === "hello react")), snap.text);
  check("SearchBox state matches", (await react("inspect", "SearchBox")).hooks[0].value === "hello react");

  await react("invoke", "form", "onSubmit");
  await settle();
  check("onSubmit lifts state to App", (await countText()).includes("last search: hello react"));

  await react("invoke", "#add", "onClick");
  await react("invoke", "li:nth-child(1) input", "onChange");
  await settle();
  const todos = (await react("inspect", "Todos")).hooks[0].value;
  check("useReducer dispatch via handlers", todos.length === 2 && todos[0].done === true, JSON.stringify(todos));

  const live = await command("page.snapshot", { tabId });
  const box = live.elements.find((e) => e.role === "checkbox" && e.name === "write fixture");
  check("DOM reflects the toggle (checkbox checked)", box?.checked === true, JSON.stringify(live.elements.filter((e) => e.role === "checkbox")));

  // --- every control type, through React props ---
  const state = async () => (await react("inspect", "Controls")).hooks[0].value;
  const controls = await react("controls");
  const byId = (id) => controls.find((c) => c.selector === `#${id}`);
  check(
    "controls lists checkbox/select/text/switch with handlers and owner",
    byId("subscribe")?.control === "checkbox" && byId("subscribe").handlers.includes("onChange") &&
      byId("color")?.options.length === 3 && byId("notify")?.control === "aria-toggle" && byId("subscribe").owner === "Controls",
    JSON.stringify(controls.map((c) => [c.selector, c.control]))
  );
  check("controls flags disabled and uncontrolled", byId("locked")?.disabled === true && !byId("plain")?.controlled && byId("code")?.controlled === true);

  let r = await react("fill", "#subscribe", true);
  check("checkbox: handler reading e.target.checked sees true", (await state()).subscribe === true && r.via === "react" && r.applied, JSON.stringify(r));
  r = await react("fill", "#subscribe", true);
  check("checkbox: already checked is a no-op", r.noop === true);
  r = await react("fill", "Subscribe", false);
  check("checkbox: fill by label, uncheck", (await state()).subscribe === false && r.applied, JSON.stringify(r));

  r = await react("fill", "input[name=plan]", "pro");
  check("radio: pick by value within the group", (await state()).plan === "pro" && r.applied, JSON.stringify(r));
  r = await react("fill", "input[name=plan]", "Plan free");
  check("radio: pick by label", (await state()).plan === "free", JSON.stringify(await state()));

  r = await react("fill", "#color", "Green");
  check("select: option by visible label", (await state()).color === "green" && r.applied, JSON.stringify(r));
  r = await react("fill", "#tags", ["a", "c"]);
  check("select multiple: sets all picked options", JSON.stringify((await state()).tags) === '["a","c"]' && r.applied, JSON.stringify(r));
  let bad = "";
  try { await react("fill", "#color", "Purple"); } catch (e) { bad = e.message; }
  check("select: unknown option lists the choices", /No option "Purple".*Green/.test(bad), bad);

  await react("fill", "#bio", "line1\nline2");
  await react("fill", "#age", 42);
  await react("fill", "#volume", 80);
  const st = await state();
  check("textarea / number / range", st.bio === "line1\nline2" && st.age === "42" && st.volume === "80", JSON.stringify(st));

  r = await react("fill", "#code", "abcdefgh");
  check(
    "controlled input that rewrites: DOM shows what React kept, applied=false",
    (await state()).code === "ABCD" && r.now === "ABCD" && r.applied === false,
    JSON.stringify(r)
  );

  r = await react("fill", "#plain", "typed");
  check("no React handler: falls back to DOM events", r.via === "dom" && r.now === "typed", JSON.stringify(r));

  r = await react("fill", "#notify", true);
  check("ARIA switch div with onClick", (await state()).notify === true && r.applied, JSON.stringify(r));

  bad = "";
  try { await react("click", "#locked"); } catch (e) { bad = e.message; }
  check("click on disabled button is refused, handler not run", /disabled/.test(bad) && !(await state()).log.includes("locked clicked"), bad);

  await react("click", "#inner");
  check("stopPropagation stops the bubble to #outer", JSON.stringify((await state()).log) === '["inner"]', JSON.stringify((await state()).log));

  await react("click", "#send");
  check("submit button click runs form onSubmit", (await state()).log.includes("submit"));

  await react("fill", "#q", "via enter");
  await react("press", "#q", "Enter");
  check("press Enter in a field submits its form", (await countText()).includes("last search: via enter"), (await countText()).slice(0, 160));

  const batch = await react("fillForm", { "#bio": "batch", "#age": 7, "#nope": "x" });
  check(
    "fillForm reports per-field results and keeps going after an error",
    batch[0].ok && batch[1].ok && batch[2].ok === false && (await state()).age === "7",
    JSON.stringify(batch)
  );

  // --- status + automatic engine selection on the plain CLI verbs ---
  const status = await command("page.status", { tabId });
  check(
    "status reports React, version, engine, components",
    status.engine === "react" && status.react.isReact && status.react.version === "18.3.1" &&
      status.react.rootComponents.includes("App") && status.react.controls > 10 && status.url.endsWith("react-app.html"),
    JSON.stringify(status)
  );

  let snapNow = await command("page.snapshot", { tabId });
  const refOf = (name, role) => snapNow.elements.find((e) => e.name === name && e.role === role)?.ref;
  let out = await command("page.type", { tabId, ref: refOf("Bio", "textbox"), text: "auto engine" });
  check("type auto-routes to React on a React page", out.engine === "react" && (await state()).bio === "auto engine", JSON.stringify(out));
  out = await command("page.type", { tabId, name: "Search", text: "named", submit: true });
  check("type by label + submit goes through React (fill + Enter)", out.engine === "react" && (await countText()).includes("last search: named"), JSON.stringify(out));
  out = await command("page.click", { tabId, ref: refOf("Subscribe", "checkbox") });
  check("click on a checkbox ref toggles through React", out.engine === "react" && (await state()).subscribe === true, JSON.stringify(out));
  out = await command("page.click", { tabId, name: "Increment" });
  check("click by name uses React", out.engine === "react" && (await countText()).includes("Clicks: 42"), JSON.stringify(out));
  out = await command("page.click", { tabId, name: "Increment", engine: "dom" });
  check("engine=dom forces plain DOM events", out.engine === "dom" && (await countText()).includes("Clicks: 43"), JSON.stringify(out));
  await command("page.type", { tabId, ref: refOf("Bio", "textbox"), text: "x" });
  out = await command("page.press", { tabId, key: "Enter" });
  check("press auto-routes to React", out.engine === "react", JSON.stringify(out));
  let refused = "";
  try { await command("page.click", { tabId, name: "Locked" }); } catch (e) { refused = e.message; }
  check("click on a disabled control surfaces the error, no silent fallback", /disabled/.test(refused), refused);

  await command("page.navigate", { tabId, url: fixture("form.html") });
  const plain = await waitFor(async () => {
    const d = await react("detect");
    return d && !d.isReact ? d : null;
  }, { timeout: 4000 });
  check("non-React page reports isReact=false", plain?.isReact === false, JSON.stringify(plain));

  const plainStatus = await command("page.status", { tabId });
  check("status on a plain page says engine=dom", plainStatus.engine === "dom" && plainStatus.react.isReact === false, JSON.stringify(plainStatus));
  const plainSnap = await command("page.snapshot", { tabId });
  const nameBox = plainSnap.elements.find((e) => e.name === "Full name");
  const typed = await command("page.type", { tabId, ref: nameBox.ref, text: "Ada" });
  check("type on a plain page stays on DOM events", typed.engine === "dom", JSON.stringify(typed));
}

async function main() {
  const health = await fetch(`${origin()}/health`).then((r) => r.json());
  if (!health.ok || !health.extensionConnected) {
    throw new Error("Sidecar is not running or the extension is not connected.");
  }

  const before = await command("tabs.active");
  console.log(`Starting from active tab: ${before.title} (${before.url})`);

  const opened = await command("tabs.open", { url: fixture("dropdown.html"), active: true });
  const tabId = opened.id;
  console.log(`Opened tab ${tabId} for testing (in the foreground so you can watch it)`);

  // Left open on purpose for now so the run can be inspected after the fact.
  // Set CLOSE_TAB=1 to have the suite clean up after itself again.
  await testDropdown(tabId);
  await testCombobox(tabId);
  await testForm(tabId);
  await testLinksAndClicks(tabId);
  await testEdreams(tabId);
  await testRyanair(tabId);
  await testReact(tabId);

  if (process.env.CLOSE_TAB === "1") {
    await command("tabs.close", { tabId });
    console.log(`\nClosed tab ${tabId}`);
  } else {
    console.log(`\nLeaving tab ${tabId} open for inspection (set CLOSE_TAB=1 to auto-close)`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
