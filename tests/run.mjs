#!/usr/bin/env node
// End-to-end test suite. Requires the sidecar running and the extension
// connected (npm start). Opens one background tab, drives it through the
// local fixtures in tests/fixtures/, and closes the tab when done.
import { origin } from "../sidecar/config.mjs";

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
