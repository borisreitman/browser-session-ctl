// Unit test for the page side of console capture: extension/console-hook.js and
// extension/console-bridge.js, run in a sandbox with a fake window/document/chrome.
// No browser needed:   node tests/console-unit.mjs
// (The background worker half is covered live: see "console" in README.md.)
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const hookSrc = fs.readFileSync(path.join(dir, "console-hook.js"), "utf8");
const bridgeSrc = fs.readFileSync(path.join(dir, "console-bridge.js"), "utf8");

// A sandbox page. `window` records its listeners so the test can fire fake error events at them.
function makePage({ readyState = "loading", href = "http://example.test/page" } = {}) {
  const document = new EventTarget();
  document.readyState = readyState;
  const handlers = {};
  const window = {
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
  };
  window.window = window;
  const originalCalls = [];
  const consoleFake = {};
  for (const m of ["log", "info", "warn", "error", "debug", "trace", "assert"]) {
    consoleFake[m] = function (...a) { originalCalls.push([m, a]); return `ret-${m}`; };
  }
  const sent = []; // what the bridge forwards to the background worker
  const chrome = { runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); } } };
  const ctx = vm.createContext({
    window, document, console: consoleFake, chrome, CustomEvent, Event, EventTarget,
    location: { href }, globalThis: undefined, Date, JSON, Math, WeakSet, Map, Set, Error, ArrayBuffer,
  });
  ctx.globalThis = ctx;
  const events = []; // every bsc-console entry announced on the DOM
  document.addEventListener("bsc-console", (e) => events.push(JSON.parse(e.detail)));
  return {
    ctx, window, document, handlers, console: consoleFake, originalCalls, sent, events,
    run: (src) => vm.runInContext(src, ctx),
    fire: (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev)),
  };
}

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (err) { console.log(`FAIL ${name}\n     ${err.message}`); process.exitCode = 1; }
};

test("console methods still call the original and keep its return value", () => {
  const p = makePage();
  p.run(hookSrc);
  assert.equal(p.console.log("a", 1), "ret-log");
  assert.equal(p.console.warn("w"), "ret-warn");
  assert.deepEqual(p.originalCalls, [["log", ["a", 1]], ["warn", ["w"]]]);
});

test("each level is recorded with the right level and text", () => {
  const p = makePage();
  p.run(hookSrc);
  p.console.log("l"); p.console.info("i"); p.console.warn("w"); p.console.error("e"); p.console.debug("d");
  assert.deepEqual(p.events.map((e) => [e.level, e.text]), [["log", "l"], ["info", "i"], ["warn", "w"], ["error", "e"], ["debug", "d"]]);
  assert.deepEqual(p.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

test("formats objects, arrays, errors, circular refs, nested and Map/Set", () => {
  const p = makePage();
  p.run(hookSrc);
  const circ = { name: "c" }; circ.self = circ;
  p.console.log({ a: 1, b: "x", c: [1, 2], d: null, e: undefined });
  p.console.log(circ);
  p.console.log(new Error("boom"));
  p.console.log({ l1: { l2: { l3: { l4: 1 } } } });
  p.console.log(new Map([["k", 1]]), new Set([1, 2]));
  p.console.log(() => {}, Symbol("s"), 10n);
  const t = p.events.map((e) => e.text);
  assert.equal(t[0], '{a: 1, b: "x", c: [1, 2], d: null, e: undefined}');
  assert.equal(t[1], "{name: \"c\", self: [Circular]}");
  assert.match(t[2], /^Error: boom/);
  assert.equal(t[3], "{l1: {l2: {l3: [Object]}}}");
  assert.equal(t[4], 'Map(1) {"k" => 1} Set(2) {1, 2}');
  assert.equal(t[5], "[Function anonymous] Symbol(s) 10");
});

test("printf-style substitution, and %c is consumed", () => {
  const p = makePage();
  p.run(hookSrc);
  p.console.log("%s is %d years, %c styled", "Ann", 7.9, "color:red", "extra");
  p.console.log("100%");
  assert.equal(p.events[0].text, "Ann is 7 years,  styled extra");
  assert.equal(p.events[1].text, "100%");
});

test("long output is clipped", () => {
  const p = makePage();
  p.run(hookSrc);
  p.console.log("x".repeat(10000));
  assert.ok(p.events[0].text.length < 4100);
  assert.match(p.events[0].text, /\[\+6000 chars\]$/);
});

test("console.assert only records when the assertion fails", () => {
  const p = makePage();
  p.run(hookSrc);
  p.console.assert(true, "fine");
  p.console.assert(false, "broken", 3);
  assert.equal(p.events.length, 1);
  assert.deepEqual([p.events[0].level, p.events[0].text], ["error", "Assertion failed: broken 3"]);
});

test("uncaught errors, failed resource loads, rejections and CSP violations are recorded", () => {
  const p = makePage();
  p.run(hookSrc);
  p.fire("error", { target: p.window, message: "boom", filename: "a.js", lineno: 3, colno: 9, error: { stack: "Error: boom\n  at a.js:3:9" } });
  p.fire("error", { target: { tagName: "SCRIPT", src: "https://www.googletagmanager.com/gtag/js?id=G-1" } });
  p.fire("unhandledrejection", { reason: new Error("nope") });
  p.document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { violatedDirective: "script-src", effectiveDirective: "script-src-elem", blockedURI: "https://x/y.js" }));
  const e = p.events;
  assert.equal(e.length, 4);
  assert.match(e[0].text, /^Uncaught boom at a\.js:3:9\nError: boom/);
  assert.equal(e[0].kind, "uncaught");
  assert.equal(e[1].text, "failed to load <script> https://www.googletagmanager.com/gtag/js?id=G-1");
  assert.equal(e[1].kind, "resource");
  assert.match(e[2].text, /^Unhandled promise rejection: Error: nope/);
  assert.equal(e[3].text, "CSP violation: script-src blocked https://x/y.js (script-src-elem)");
});

test("an uncaught error whose message already starts with 'Uncaught' is not prefixed twice", () => {
  const p = makePage();
  p.run(hookSrc);
  p.fire("error", { target: p.window, message: "Uncaught Error: late", filename: "a.js", lineno: 1, colno: 2 });
  assert.equal(p.events[0].text, "Uncaught Error: late at a.js:1:2");
});

test("hook is idempotent: a second injection does not double-wrap", () => {
  const p = makePage();
  p.run(hookSrc); p.run(hookSrc);
  p.console.log("once");
  assert.equal(p.events.length, 1);
  assert.equal(p.originalCalls.length, 1);
});

test("a throwing getter or hostile object cannot break console.log", () => {
  const p = makePage();
  p.run(hookSrc);
  const hostile = { get boom() { throw new Error("getter"); } };
  assert.doesNotThrow(() => p.console.log(hostile));
  assert.equal(p.originalCalls.length, 1);
  assert.match(p.events[0].text, /boom: \[Getter threw\]/);
});

test("bridge forwards each entry once, restarts the sequence for a new page, and marks page start", () => {
  const p = makePage();
  p.run(hookSrc); p.run(bridgeSrc);
  p.console.log("one"); p.console.log("two");
  const sent = p.sent.map((m) => m.entry);
  assert.equal(sent[0].kind, "page");
  assert.match(sent[0].text, /^page start http:\/\/example\.test\/page/);
  assert.deepEqual(sent.slice(1).map((e) => e.text), ["one", "two"]);
  // the same entry announced again (replay) is dropped
  p.document.dispatchEvent(new CustomEvent("bsc-console", { detail: JSON.stringify({ pid: sent[1].pid, seq: 1, level: "log", text: "one", t: 1 }) }));
  assert.equal(p.sent.length, 3);
  // a different pid is a new page load: its seq 1 is accepted again
  p.document.dispatchEvent(new CustomEvent("bsc-console", { detail: JSON.stringify({ pid: "other", seq: 1, level: "log", text: "fresh", t: 2 }) }));
  assert.equal(p.sent.at(-1).entry.text, "fresh");
});

test("entries logged before the bridge attached are replayed to it, once", () => {
  const p = makePage();
  p.run(hookSrc);
  p.console.log("early 1"); p.console.error("early 2");
  p.run(bridgeSrc); // attaches late, asks for a replay
  const texts = p.sent.map((m) => m.entry.text);
  assert.deepEqual(texts.slice(1), ["early 1", "early 2"]);
  p.run(bridgeSrc); // a second bridge injection in the same world is a no-op
  assert.equal(p.sent.length, 3);
});

test("a bridge attached to an already-loaded page says so instead of claiming a page start", () => {
  const p = makePage({ readyState: "complete" });
  p.run(hookSrc); p.run(bridgeSrc);
  assert.match(p.sent[0].entry.text, /^console capture attached to existing page /);
});

test("a dead extension context (reload) cannot break the page", () => {
  const p = makePage();
  p.ctx.chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
  p.run(hookSrc); p.run(bridgeSrc);
  assert.doesNotThrow(() => p.console.log("still fine"));
  assert.equal(p.originalCalls.length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
