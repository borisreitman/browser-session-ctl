// Angular integration, page half. Runs in the page's MAIN world, injected on
// demand (like react-probe.js): Angular keeps its internals as expandos and
// globals that an isolated-world content script cannot see.
//
// "Angular" is three different things and the hooks do not carry over:
//   ivy        Angular 9+.   ng-version attr, __ngContext__ on nodes, and in dev
//                            builds the global `ng` (getComponent, applyChanges).
//   angularjs  1.x.          window.angular, .ng-scope nodes, element.scope().
//   dart       AngularDart / Google's compiled apps (ads.google.com). `ng-app`
//                            and _ngcontent-* attrs, but no version, no
//                            __ngContext__, and no `ng` unless built in debug.
// detect() says which one this page is; survey()/globals() show what is there
// to hook when it is none of the documented ones.
(() => {
  if (globalThis.__bscAngular?.version === 2) return;

  const NATIVE = (() => {
    // Own props every element has on a fresh page: anything else is an expando.
    const probe = document.createElement("div");
    return new Set(Object.getOwnPropertyNames(probe));
  })();

  const describe = (el) => {
    if (!el || !el.tagName) return null;
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const find = (target) => {
    if (target && target.nodeType === 1) return target;
    const el = document.querySelector(String(target));
    if (!el) throw new Error(`No element matches ${target}`);
    return el;
  };

  function detect() {
    const ng = globalThis.ng;
    const root = document.querySelector("[ng-version]");
    const out = {
      kind: null,
      version: root?.getAttribute("ng-version") || globalThis.angular?.version?.full || null,
      ngGlobal: typeof ng === "object" || typeof ng === "function" ? Object.keys(ng).slice(0, 20) : null,
      ngAppAttr: document.querySelector("[ng-app]")?.tagName.toLowerCase() || null,
      encapsulated: scanEncapsulation(),
      ngContextNodes: 0,
      angularJs: Boolean(globalThis.angular?.element),
      rootElements: typeof globalThis.getAllAngularRootElements === "function" ? globalThis.getAllAngularRootElements().map(describe) : null,
    };
    for (const el of document.querySelectorAll("*")) if ("__ngContext__" in el) out.ngContextNodes += 1;
    out.kind = out.ngContextNodes || root || typeof ng?.getComponent === "function" ? "ivy"
      : out.angularJs ? "angularjs"
      : out.ngAppAttr || out.encapsulated ? "dart"
      : null;
    return out;
  }

  // View encapsulation marks nodes with _ngcontent-*/_nghost-*: as attributes in
  // Angular, as class names in AngularDart.
  function scanEncapsulation() {
    for (const el of document.querySelectorAll("*")) {
      if (el.getAttributeNames().some((a) => a.startsWith("_ngcontent") || a.startsWith("_nghost"))) return true;
      for (const c of el.classList) if (c.startsWith("_ngcontent-") || c.startsWith("_nghost-")) return true;
    }
    return false;
  }

  // Which non-standard properties page scripts hung on DOM nodes, grouped by
  // key. The framework's per-node bookkeeping is almost always one of these.
  function survey(limit = 20000) {
    const keys = new Map();
    let scanned = 0;
    for (const el of document.querySelectorAll("*")) {
      if (scanned++ >= limit) break;
      for (const k of Object.getOwnPropertyNames(el)) {
        if (NATIVE.has(k)) continue;
        const slot = keys.get(k) || { key: k, count: 0, sample: null, type: null };
        slot.count += 1;
        if (!slot.sample) { slot.sample = describe(el); slot.type = typeof el[k]; }
        keys.set(k, slot);
      }
    }
    return { scanned, expandos: [...keys.values()].sort((a, b) => b.count - a.count).slice(0, 40) };
  }

  // Globals the page itself defined: compare against a pristine window.
  function globals() {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    document.documentElement.appendChild(frame);
    const clean = new Set(Object.getOwnPropertyNames(frame.contentWindow));
    frame.remove();
    const own = Object.getOwnPropertyNames(globalThis).filter((k) => !clean.has(k));
    return {
      count: own.length,
      framework: own.filter((k) => /^(ng|angular|__ng|goog|_ds|ads|aw|boq|wiz|jsaction|Zone|zone)/i.test(k)),
      sample: own.slice(0, 60),
    };
  }

  // The component behind an element, by whichever hook this page has.
  function component(target) {
    const el = find(target);
    const ng = globalThis.ng;
    if (typeof ng?.getComponent === "function") {
      const c = ng.getComponent(el) || ng.getOwningComponent?.(el);
      return { via: "ng.getComponent", name: c?.constructor?.name || null, keys: c ? Object.keys(c).slice(0, 40) : [] };
    }
    if (typeof ng?.probe === "function") {
      const p = ng.probe(el);
      return { via: "ng.probe", name: p?.componentInstance?.constructor?.name || null, keys: p ? Object.keys(p.componentInstance || {}).slice(0, 40) : [] };
    }
    if (globalThis.angular?.element) {
      const scope = globalThis.angular.element(el).scope?.();
      return { via: "angular.element().scope", keys: scope ? Object.keys(scope).filter((k) => !k.startsWith("$")).slice(0, 40) : [] };
    }
    const ctx = "__ngContext__" in el ? el.__ngContext__ : undefined;
    if (ctx !== undefined) return { via: "__ngContext__", type: Array.isArray(ctx) ? `lView[${ctx.length}]` : typeof ctx };
    return { via: null, note: "no Angular hook found for this element; try survey() for per-node expandos" };
  }

  // Inspect any own expando on an element (value type and shape, no cycles).
  function expando(target, key) {
    const el = find(target);
    const v = el[key];
    if (v === undefined) throw new Error(`${describe(el)} has no property ${key}`);
    const shape = (x) => (x === null ? "null" : Array.isArray(x) ? `array(${x.length})` : typeof x === "object" ? `${x.constructor?.name || "object"}{${Object.keys(x).slice(0, 12).join(",")}}` : typeof x);
    return { type: shape(v), keys: v && typeof v === "object" ? Object.keys(v).slice(0, 30).map((k) => `${k}: ${shape(v[k])}`) : [] };
  }

  // Angular's testability registry: the framework's own "am I idle?" signal.
  // Present in Angular (ng.getAllAngularTestabilities) and AngularDart
  // (window.ngTestabilityRegistries). Waiting on it beats sleeping.
  function testabilities() {
    const out = [];
    for (const reg of globalThis.ngTestabilityRegistries || []) {
      const list = typeof reg.getAllTestabilities === "function" ? reg.getAllTestabilities() : [];
      for (const t of list) out.push(t);
    }
    if (!out.length && typeof globalThis.getAllAngularTestabilities === "function") out.push(...globalThis.getAllAngularTestabilities());
    return out;
  }

  const methodsOf = (o) => {
    const names = new Set();
    for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) if (typeof o[k] === "function" && k !== "constructor") names.add(k);
    }
    return [...names].slice(0, 40);
  };

  function testability() {
    const regs = globalThis.ngTestabilityRegistries;
    const list = regs ? testabilities() : [];
    return {
      registries: regs ? regs.length : 0,
      registryMethods: regs?.[0] ? methodsOf(regs[0]) : [],
      testabilities: list.length,
      methods: list[0] ? methodsOf(list[0]) : [],
      stable: list.map((t) => (typeof t.isStable === "function" ? t.isStable() : null)),
      pending: list.map((t) => (typeof t.getPendingRequestCount === "function" ? t.getPendingRequestCount() : null)),
    };
  }

  const isStable = () => {
    const list = testabilities();
    return list.length ? list.every((t) => (typeof t.isStable === "function" ? t.isStable() : true)) : null;
  };

  // Resolve once every testability reports stable (or after timeoutMs).
  // Polls isStable so it works even where whenStable's callback is not exposed.
  async function whenStable(timeoutMs = 10000, quietMs = 150) {
    const start = Date.now();
    let quietSince = 0;
    while (Date.now() - start < timeoutMs) {
      const stable = isStable();
      if (stable === null) return { stable: null, note: "no testability registry on this page" };
      if (stable) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= quietMs) return { stable: true, waitedMs: Date.now() - start };
      } else {
        quietSince = 0;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { stable: false, waitedMs: Date.now() - start };
  }

  globalThis.__bscAngular = { version: 2, detect, survey, globals, component, expando, testability, isStable, whenStable };
})();
