// Page half of console capture. Runs in the page's MAIN world at document_start
// (manifest content_scripts, world: "MAIN"), so it sees console calls made by the
// page's own scripts from the very first line, and when `browser-session-ctl console`
// finds a tab that was open before the extension loaded it is injected on demand.
//
// It does four things and nothing else:
//   1. wraps console.log/info/warn/error/debug/trace/assert, still calling the original;
//   2. records uncaught errors, failed <script>/<link>/<img> loads, unhandled promise
//      rejections and CSP violations (things DevTools shows in red that never go
//      through console.*);
//   3. keeps the last MAX_BUF entries in memory;
//   4. announces each entry as a DOM CustomEvent ("bsc-console") that the isolated-world
//      bridge (console-bridge.js) forwards to the background worker. The DOM is the one
//      thing both worlds share (see react-hook.js, which does the same for React).
//
// Page JS can read and alter all of this, so treat the log as diagnostic, not trusted.
(() => {
  if (globalThis.__bscConsoleHook) return;

  const MAX_BUF = 500; // entries kept in the page for replay
  const MAX_TEXT = 4000; // characters kept per entry
  const pid = Math.random().toString(36).slice(2, 10); // one id per page load
  let seq = 0;
  const buf = [];

  // ---- formatting ----------------------------------------------------------

  const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}... [+${s.length - MAX_TEXT} chars]` : s);

  const describeNode = (n) => {
    try {
      const id = n.id ? `#${n.id}` : "";
      const cls = typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : "";
      return `<${String(n.tagName || n.nodeName).toLowerCase()}${id}${cls}>`;
    } catch {
      return "[Node]";
    }
  };

  const fmt = (v, depth = 0, seen = new WeakSet()) => {
    if (typeof v === "string") return depth ? JSON.stringify(v) : v;
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    if (typeof v === "symbol") return v.toString();
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (v instanceof Error) return v.stack ? String(v.stack) : `${v.name}: ${v.message}`;
    if (typeof Node !== "undefined" && v instanceof Node) return describeNode(v);
    if (typeof Window !== "undefined" && v === window) return "[Window]";
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[Circular]";
    if (depth >= 3) return Array.isArray(v) ? `[Array(${v.length})]` : "[Object]";
    seen.add(v);
    try {
      if (v instanceof Map) return `Map(${v.size}) {${[...v].slice(0, 20).map(([k, x]) => `${fmt(k, depth + 1, seen)} => ${fmt(x, depth + 1, seen)}`).join(", ")}}`;
      if (v instanceof Set) return `Set(${v.size}) {${[...v].slice(0, 20).map((x) => fmt(x, depth + 1, seen)).join(", ")}}`;
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const items = Array.from(v).slice(0, 50).map((x) => fmt(x, depth + 1, seen));
        return `[${items.join(", ")}${v.length > 50 ? `, ... ${v.length - 50} more` : ""}]`;
      }
      const keys = Object.keys(v);
      const body = keys.slice(0, 50).map((k) => {
        const label = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
        let val;
        try { val = v[k]; } catch { return `${label}: [Getter threw]`; }
        return `${label}: ${fmt(val, depth + 1, seen)}`;
      });
      // Compare by name, not identity: an object from another frame has a different `Object`.
      const cname = v.constructor && v.constructor.name;
      const name = cname && cname !== "Object" ? `${cname} ` : "";
      return `${name}{${body.join(", ")}${keys.length > 50 ? `, ... ${keys.length - 50} more` : ""}}`;
    } catch {
      return "[Unprintable]";
    }
  };

  // console.log("a %s b %d", x, y) style substitution, as browsers do it. %c (CSS) is consumed and dropped.
  const formatArgs = (args) => {
    if (typeof args[0] === "string" && args[0].includes("%") && args.length > 1) {
      let i = 1;
      const head = args[0].replace(/%([sdifoOjc%])/g, (m, t) => {
        if (t === "%") return "%";
        if (i >= args.length) return m;
        const a = args[i++];
        if (t === "c") return "";
        if (t === "s") return typeof a === "string" ? a : fmt(a, 1);
        if (t === "d" || t === "i") return String(typeof a === "number" ? Math.trunc(a) : Number.NaN);
        if (t === "f") return String(typeof a === "number" ? a : Number.NaN);
        return fmt(a, 1);
      });
      return [head, ...args.slice(i).map((a) => fmt(a))].join(" ");
    }
    return args.map((a) => fmt(a)).join(" ");
  };

  // ---- recording -----------------------------------------------------------

  const announce = (entry, replay) => {
    try {
      document.dispatchEvent(new CustomEvent("bsc-console", { detail: JSON.stringify({ ...entry, replay: replay || undefined }) }));
    } catch {}
  };

  const record = (level, text, extra) => {
    const entry = { pid, seq: ++seq, t: Date.now(), level, text: clip(String(text)), url: location.href, ...extra };
    buf.push(entry);
    if (buf.length > MAX_BUF) buf.shift();
    announce(entry, false);
  };

  // The bridge may attach after the first log lines (isolated and MAIN scripts at
  // document_start run in no guaranteed order). It asks for a replay; it de-duplicates by seq.
  document.addEventListener("bsc-console-ready", () => buf.forEach((e) => announce(e, true)), true);

  // ---- console.* -----------------------------------------------------------

  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    const wrapped = function (...args) {
      try { record(level, formatArgs(args)); } catch {}
      return orig.apply(this, args);
    };
    try { Object.defineProperty(wrapped, "name", { value: orig.name }); } catch {}
    console[level] = wrapped;
  }
  const origAssert = console.assert;
  if (typeof origAssert === "function") {
    console.assert = function (cond, ...args) {
      try { if (!cond) record("error", `Assertion failed${args.length ? `: ${formatArgs(args)}` : ""}`); } catch {}
      return origAssert.apply(this, [cond, ...args]);
    };
  }

  // ---- things that never go through console.* -----------------------------

  window.addEventListener(
    "error",
    (e) => {
      try {
        const t = e.target;
        if (t && t !== window && t.tagName) {
          // a resource failed to load (blocked, 404, DNS, CSP, ad blocker)
          record("error", `failed to load <${t.tagName.toLowerCase()}> ${t.src || t.href || ""}`.trim(), { kind: "resource" });
        } else {
          const where = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : "";
          const stack = e.error && e.error.stack ? `\n${e.error.stack}` : "";
          // Chrome's own message already starts with "Uncaught " for thrown errors
          const msg = e.message || "error";
          record("error", `${/^Uncaught\b/.test(msg) ? "" : "Uncaught "}${msg}${where}${stack}`, { kind: "uncaught" });
        }
      } catch {}
    },
    true
  );
  window.addEventListener("unhandledrejection", (e) => {
    try { record("error", `Unhandled promise rejection: ${fmt(e.reason)}`, { kind: "rejection" }); } catch {}
  });
  document.addEventListener("securitypolicyviolation", (e) => {
    try { record("error", `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.effectiveDirective})`, { kind: "csp" }); } catch {}
  });

  globalThis.__bscConsoleHook = { pid, version: 1, count: () => seq };
})();
