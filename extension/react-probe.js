// Post-load half of the React integration. Runs in the page's MAIN world:
// React stores its internals as expando properties on DOM nodes
// (__reactFiber$xxxx, __reactProps$xxxx), and an isolated-world content script
// cannot see expandos set by page scripts.
//
// Discovery works with or without react-hook.js having run first:
//   1. DOM scan for React's per-node keys        (any React >= 16, after load)
//   2. __REACT_DEVTOOLS_GLOBAL_HOOK__ renderers  (needs the hook at document_start)
// Then window.__bscReact exposes operations that go through the fiber tree
// (props handlers, hook state) instead of synthesising DOM events.
(() => {
  if (globalThis.__bscReact?.version === 1) return;

  // Fiber tags (stable since React 16.x).
  const TAG = { FunctionComponent: 0, ClassComponent: 1, HostRoot: 3, HostComponent: 5,
    HostText: 6, ContextProvider: 10, ForwardRef: 11, Fragment: 7, Memo: 14, SimpleMemo: 15 };
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

  const keyOf = (el, prefix) => {
    for (const k of Object.keys(el)) if (k.startsWith(prefix)) return k;
    return null;
  };

  function fiberFor(el) {
    if (!el) return null;
    const k = keyOf(el, "__reactFiber$") || keyOf(el, "__reactInternalInstance$");
    return k ? el[k] : null;
  }

  function propsFor(el) {
    const k = keyOf(el, "__reactProps$");
    if (k) return el[k];
    return fiberFor(el)?.memoizedProps ?? null;
  }

  function nameOf(fiber) {
    const t = fiber.type;
    if (!t) return null;
    if (typeof t === "string") return t;
    if (fiber.tag === TAG.ForwardRef) return t.displayName || t.render?.displayName || t.render?.name || "ForwardRef";
    if (fiber.tag === TAG.Memo || fiber.tag === TAG.SimpleMemo) {
      const inner = t.type || t;
      return t.displayName || inner.displayName || inner.name || "Memo";
    }
    return t.displayName || t.name || "Anonymous";
  }

  // ---- discovery -----------------------------------------------------------

  function scan(limit = 50000) {
    const found = { nodes: 0, scanned: 0, containers: [], keys: new Set(), legacyRoots: [] };
    const all = document.querySelectorAll("*");
    for (const el of all) {
      if (found.scanned++ >= limit) break;
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          found.nodes += 1;
          found.keys.add(k.split("$")[0]);
        } else if (k.startsWith("__reactContainer$")) {
          found.containers.push(el);
          found.keys.add("__reactContainer$");
        }
      }
      if (el._reactRootContainer) found.legacyRoots.push(el);
    }
    return found;
  }

  function hostRootOf(fiber) {
    let f = fiber;
    while (f && f.return) f = f.return;
    return f && f.tag === TAG.HostRoot ? f : null;
  }

  function roots() {
    const out = new Map(); // HostRoot fiber -> container element
    const s = scan();
    for (const el of s.containers) {
      const k = keyOf(el, "__reactContainer$");
      // The container key holds the HostRoot fiber from first render; after
      // updates the live tree is on FiberRoot.current (the alternate).
      const hr = el[k]?.stateNode?.current || el[k];
      if (hr) out.set(hr, el);
    }
    for (const el of s.legacyRoots) {
      const hr = el._reactRootContainer?._internalRoot?.current;
      if (hr) out.set(hr, el);
    }
    if (out.size === 0) {
      // No container key (e.g. React 16 / portals): climb from any host fiber.
      for (const el of document.querySelectorAll("*")) {
        let hr = hostRootOf(fiberFor(el));
        hr = hr?.stateNode?.current || hr;
        if (hr && !out.has(hr)) out.set(hr, hr.stateNode?.containerInfo || null);
      }
    }
    return out;
  }

  // Cheap yes/no for per-command routing: stops at the first React marker.
  function isReact() {
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook?.renderers?.size > 0) return true;
    for (const el of document.querySelectorAll("*")) {
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$") || k.startsWith("__reactInternalInstance$")) return true;
      }
      if (el._reactRootContainer) return true;
    }
    return false;
  }

  function detect() {
    const s = scan();
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const renderers = hook?.renderers ? [...hook.renderers.values()] : [];
    const globalReact = globalThis.React && typeof globalThis.React.version === "string"
      ? globalThis.React.version : null;
    const hookInfo = globalThis.__bscReactHook?.summary?.() || null;
    const isReact = s.nodes > 0 || s.containers.length > 0 || s.legacyRoots.length > 0 || renderers.length > 0;
    return {
      isReact,
      evidence: {
        domNodesWithFiber: s.nodes,
        containerKeys: s.containers.length,
        legacyRoots: s.legacyRoots.length,
        keyFamilies: [...s.keys],
        devtoolsHook: Boolean(hook),
        hookRenderers: renderers.map((r) => ({ version: r.version, package: r.rendererPackageName, bundleType: r.bundleType })),
        globalReactVersion: globalReact,
        scannedElements: s.scanned,
      },
      version: renderers[0]?.version || globalReact || null,
      dev: renderers.length ? renderers[0].bundleType === 1 : null, // 1 = development
      hook: hookInfo,
    };
  }

  // ---- reading the tree ----------------------------------------------------

  function hostEl(fiber) {
    // First DOM node under a component fiber.
    let f = fiber;
    while (f) {
      if (f.tag === TAG.HostComponent) return f.stateNode;
      f = f.child;
    }
    return null;
  }

  function classifyHook(h) {
    const ms = h.memoizedState;
    if (h.queue && typeof h.queue.dispatch === "function") {
      const reducer = h.queue.lastRenderedReducer;
      return { kind: reducer?.name === "basicStateReducer" ? "useState" : "useReducer", value: ms, settable: true };
    }
    if (ms && typeof ms === "object" && "create" in ms && "deps" in ms) return { kind: "effect", deps: ms.deps };
    if (ms && typeof ms === "object" && Object.keys(ms).length === 1 && "current" in ms) return { kind: "useRef", value: ms.current };
    if (Array.isArray(ms) && ms.length === 2) return { kind: "memo/callback", value: ms[0] };
    return { kind: "unknown", value: ms };
  }

  function hooksOf(fiber) {
    if (fiber.tag === TAG.ClassComponent) {
      return [{ index: 0, kind: "class.state", value: fiber.stateNode?.state, settable: true }];
    }
    const out = [];
    let h = fiber.memoizedState;
    for (let i = 0; h && typeof h === "object" && i < 100; i += 1, h = h.next) {
      out.push({ index: i, ...classifyHook(h) });
    }
    return out;
  }

  const brief = (v, depth = 0) => {
    if (typeof v === "function") return `ƒ ${v.name || "anonymous"}`;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
    if (depth > 1) return Array.isArray(v) ? `[${v.length}]` : "{…}";
    if (Array.isArray(v)) return v.slice(0, 10).map((x) => brief(x, depth + 1));
    const o = {};
    for (const k of Object.keys(v).slice(0, 20)) o[k] = brief(v[k], depth + 1);
    return o;
  };

  function describe(fiber) {
    const props = {};
    for (const [k, v] of Object.entries(fiber.memoizedProps || {})) if (k !== "children") props[k] = brief(v);
    return {
      name: nameOf(fiber),
      kind: fiber.tag === TAG.ClassComponent ? "class" : "function",
      props,
      hooks: hooksOf(fiber).map((h) => ({ ...h, value: brief(h.value), deps: undefined })),
    };
  }

  function* walk(fiber) {
    for (let f = fiber; f; f = f.sibling) {
      yield f;
      if (f.child) yield* walk(f.child);
    }
  }

  function tree({ maxDepth = 12 } = {}) {
    const build = (f, depth) => {
      const kids = [];
      for (let c = f.child; c; c = c.sibling) {
        const node = build(c, depth + 1);
        if (Array.isArray(node)) kids.push(...node); else if (node) kids.push(node);
      }
      if (COMPONENT_TAGS.has(f.tag)) return { name: nameOf(f), children: depth < maxDepth ? kids : [] };
      return kids; // flatten host nodes: we only chart components
    };
    return [...roots().keys()].map((hr) => build(hr, 0)).flat();
  }

  function findComponents(name) {
    const out = [];
    for (const hr of roots().keys()) {
      for (const f of walk(hr)) if (COMPONENT_TAGS.has(f.tag) && nameOf(f) === name) out.push(f);
    }
    return out;
  }

  function componentChain(el) {
    const names = [];
    for (let f = fiberFor(el); f; f = f.return) if (COMPONENT_TAGS.has(f.tag)) names.push(nameOf(f));
    return names;
  }

  // ---- operating -----------------------------------------------------------

  const resolve = (target) => (typeof target === "string" ? document.querySelector(target) : target);

  function fakeEvent(el, extra = {}) {
    return {
      type: "synthetic", target: el, currentTarget: el, bubbles: true,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, persist() {},
      isDefaultPrevented() { return Boolean(this.defaultPrevented); }, nativeEvent: null, ...extra,
    };
  }

  // Calls a React prop handler (onClick, onChange, onSubmit …) on the element
  // or the nearest ancestor that has one — the same bubbling React itself does.
  function invoke(target, propName, ...args) {
    let el = resolve(target);
    if (!el) throw new Error(`No element for ${target}`);
    for (let n = el; n; n = n.parentElement) {
      const fn = propsFor(n)?.[propName];
      if (typeof fn === "function") {
        const result = fn(fakeEvent(el), ...args);
        return { handledBy: n.tagName.toLowerCase() + (n.id ? `#${n.id}` : ""), result: brief(result) };
      }
    }
    throw new Error(`No ${propName} handler on <${el.tagName.toLowerCase()}> or its ancestors`);
  }


  // ---- controls: discover and operate everything through React props ------
  //
  // A React handler is a plain function in the node's __reactProps$ object, so
  // we call it ourselves with a SyntheticEvent-shaped object, in the order
  // React would (capture chain root→target, then bubble target→root,
  // honouring stopPropagation and React's rule that disabled buttons/inputs
  // ignore mouse events). DOM state (value / checked / selected) is set first,
  // through the native prototype setters, because handlers read e.target.*.
  // Only when a control has no React handler at all do we fall back to real
  // DOM events (reported as via: "dom").

  const EVENT_PROP = {
    click: "Click", mousedown: "MouseDown", mouseup: "MouseUp", dblclick: "DoubleClick",
    keydown: "KeyDown", keyup: "KeyUp", keypress: "KeyPress",
    input: "Input", change: "Change", submit: "Submit", focus: "Focus", blur: "Blur",
  };
  const MOUSE = new Set(["click", "mousedown", "mouseup", "dblclick"]);
  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const CONTROL_SELECTOR = [
    "input", "textarea", "select", "button", "a[href]", "[contenteditable]",
    '[role="checkbox"]', '[role="switch"]', '[role="radio"]', '[role="button"]', '[role="tab"]',
    '[role="option"]', '[role="menuitem"]', '[role="combobox"]', '[role="textbox"]',
  ].join(",");
  const HANDLER_RE = /^on[A-Z]/;

  const sleepTicks = async (n = 5) => {
    for (let i = 0; i < n; i += 1) {
      await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    }
  };

  function setNative(el, prop, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc?.set) desc.set.call(el, value); else el[prop] = value;
  }

  const editable = (el) => ["", "true", "plaintext-only"].includes(el.getAttribute?.("contenteditable"));

  function kindOf(el) {
    if (el instanceof HTMLInputElement) {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "file" || t === "hidden") return t;
      return "text";
    }
    if (el instanceof HTMLTextAreaElement) return "text";
    if (el instanceof HTMLSelectElement) return el.multiple ? "select-multiple" : "select";
    if (el instanceof HTMLButtonElement) return "button";
    if (editable(el)) return "contenteditable";
    const role = el.getAttribute?.("role");
    if (role === "checkbox" || role === "switch") return "aria-toggle";
    if (role === "radio") return "aria-radio";
    if (role === "textbox") return "contenteditable";
    if (el.matches?.("a[href]") || ["button", "tab", "option", "menuitem"].includes(role)) return "button";
    if (typeof propsFor(el)?.onClick === "function") return "clickable";
    return null;
  }

  function labelOf(el) {
    const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const aria = el.getAttribute?.("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute?.("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (t) return t;
    }
    if (el.labels?.length) {
      const t = clean([...el.labels].map((l) => {
        const c = l.cloneNode(true);
        c.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
        return c.textContent;
      }).join(" "));
      if (t) return t;
    }
    return clean(el.getAttribute?.("placeholder") || el.getAttribute?.("title") || el.value && el.tagName === "BUTTON" && el.value || el.textContent).slice(0, 80);
  }

  // form.children is shadowed by a field named "children"; use the real getter.
  const childrenGetter = Object.getOwnPropertyDescriptor(Element.prototype, "children").get;
  const childrenOf = (el) => childrenGetter.call(el);

  function cssPath(el) {
    const unique = (id) => id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
    if (unique(el.id)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (unique(n.id)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const same = n.parentElement ? [...childrenOf(n.parentElement)].filter((c) => c.tagName === n.tagName) : [n];
      parts.unshift(`${n.tagName.toLowerCase()}${same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : ""}`);
    }
    return parts.join(" > ");
  }

  const isDisabled = (el) => Boolean(el.disabled || propsFor(el)?.disabled || el.getAttribute?.("aria-disabled") === "true");

  function stateOf(el, kind = kindOf(el)) {
    switch (kind) {
      case "checkbox": case "radio": return el.checked;
      case "select": return el.value;
      case "select-multiple": return [...el.selectedOptions].map((o) => o.value);
      case "contenteditable": return el.textContent;
      case "aria-toggle": case "aria-radio": return el.getAttribute("aria-checked") === "true";
      case "text": return el.value;
      default: return undefined;
    }
  }

  function controls() {
    const seen = new Set();
    const out = [];
    const candidates = [...document.querySelectorAll(CONTROL_SELECTOR)];
    for (const el of document.querySelectorAll("*")) {
      const p = propsFor(el);
      if (typeof p?.onClick === "function" && !candidates.includes(el)) candidates.push(el);
    }
    for (const el of candidates) {
      if (seen.has(el) || out.length >= 500) continue;
      seen.add(el);
      const kind = kindOf(el);
      if (!kind || kind === "hidden") continue;
      const props = propsFor(el) || {};
      const rect = el.getBoundingClientRect();
      const item = {
        selector: cssPath(el), tag: el.tagName.toLowerCase(), control: kind, name: labelOf(el),
        handlers: Object.keys(props).filter((k) => HANDLER_RE.test(k)),
        owner: componentChain(el)[0] || null,
        disabled: isDisabled(el), visible: rect.width > 0 && rect.height > 0,
      };
      const v = stateOf(el, kind);
      if (v !== undefined) item[kind === "checkbox" || kind === "radio" || kind.startsWith("aria") ? "checked" : "value"] = v;
      if (kind.startsWith("select")) item.options = [...el.options].map((o) => ({ label: o.text.trim(), value: o.value }));
      if ("checked" in props || "value" in props) item.controlled = true;
      if (el.name) item.name_attr = el.name;
      out.push(item);
    }
    return out;
  }

  function resolveControl(target) {
    if (target instanceof Element) return target;
    const text = String(target);
    if (text === ":focus") return document.activeElement || document.body;
    let el = null;
    try { el = document.querySelector(text); } catch { /* not a selector: treat as a label */ }
    if (el instanceof HTMLLabelElement && el.control) el = el.control;
    if (el) return el;
    const needle = text.trim().toLowerCase();
    const list = controls();
    const hit = list.find((c) => c.name.toLowerCase() === needle) || list.find((c) => c.name.toLowerCase().includes(needle));
    if (hit) return document.querySelector(hit.selector);
    throw new Error(`No control matches "${text}" (as selector or label). Try controls().`);
  }

  function nativeEventFor(type, el, init) {
    const base = { bubbles: true, cancelable: true, composed: true, view: window };
    if (MOUSE.has(type)) {
      const r = el.getBoundingClientRect();
      return new MouseEvent(type, { ...base, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    }
    if (type.startsWith("key")) return new KeyboardEvent(type, { ...base, key: init.key, code: init.code });
    if (type === "input") return new InputEvent("input", { bubbles: true, data: init.data ?? null });
    return new Event(type, { bubbles: true, cancelable: type === "submit" });
  }

  function dispatchReact(el, type, init = {}) {
    const name = `on${EVENT_PROP[type] || type[0].toUpperCase() + type.slice(1)}`;
    const path = [];
    for (let n = el; n; n = n.parentElement) path.push(n);
    const native = nativeEventFor(type, el, init);
    let stopped = false;
    const ev = {
      type, target: el, currentTarget: null, nativeEvent: native, bubbles: true,
      cancelable: native.cancelable, defaultPrevented: false, isTrusted: false,
      timeStamp: Date.now(), eventPhase: 0,
      preventDefault() { this.defaultPrevented = true; native.preventDefault(); },
      isDefaultPrevented() { return this.defaultPrevented; },
      stopPropagation() { stopped = true; },
      isPropagationStopped() { return stopped; },
      persist() {},
    };
    if (MOUSE.has(type)) Object.assign(ev, { button: 0, buttons: 1, clientX: native.clientX, clientY: native.clientY, detail: 1 });
    if (type.startsWith("key")) {
      Object.assign(ev, { key: init.key, code: init.code, keyCode: init.keyCode, which: init.keyCode, charCode: type === "keypress" ? init.keyCode : 0,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false });
    }
    if (type === "input") ev.data = init.data ?? null;
    const called = [];
    const run = (n, prop, phase) => {
      const p = propsFor(n);
      const fn = p?.[prop];
      if (typeof fn !== "function") return;
      // React drops mouse events aimed at disabled interactive elements.
      if (MOUSE.has(type) && /^(button|input|select|textarea)$/.test(n.tagName.toLowerCase()) && p.disabled) return;
      ev.currentTarget = n; ev.eventPhase = phase;
      try { fn.call(undefined, ev); } catch (err) {
        throw new Error(`${prop} handler on <${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}> threw: ${err?.message || err}`);
      }
      called.push(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}.${prop}`);
    };
    for (let i = path.length - 1; i >= 0 && !stopped; i -= 1) run(path[i], `${name}Capture`, 1);
    for (let i = 0; i < path.length && !stopped; i += 1) run(path[i], name, i === 0 ? 2 : 3);
    return { called, defaultPrevented: ev.defaultPrevented };
  }

  // After a React handler runs, a controlled element is put back to whatever
  // React state says (ReactDOM's restoreControlledState). Mirror that so a
  // handler that rejects/rewrites the input leaves the DOM truthful.
  function restoreControlled(el) {
    if (!el.isConnected) return;
    const group = el instanceof HTMLInputElement && el.type === "radio" && el.name
      ? [...document.querySelectorAll(`input[type=radio]`)].filter((r) => r.name === el.name && r.form === el.form) : [el];
    for (const n of group) {
      const p = propsFor(n);
      if (!p) continue;
      if (typeof p.checked === "boolean" && n.checked !== p.checked) setNative(n, "checked", p.checked);
      else if (p.value !== undefined && !Array.isArray(p.value) && n.value !== String(p.value) && !(n instanceof HTMLSelectElement && n.multiple)) {
        setNative(n, "value", String(p.value));
      }
    }
  }

  const toBool = (v) => (typeof v === "string" ? !/^(false|0|no|off|unchecked|)$/i.test(v.trim()) : Boolean(v));

  async function finish(el, kind, report, expected) {
    await sleepTicks();
    restoreControlled(el);
    const now = stateOf(el, kind);
    report.now = now;
    report.applied = Array.isArray(expected)
      ? JSON.stringify([...expected].sort()) === JSON.stringify([...now].sort())
      : String(now) === String(expected);
    return report;
  }

  function submitForm(form, report) {
    const r = dispatchReact(form, "submit");
    report.called.push(...r.called);
    if (!r.called.length) { form.requestSubmit(); report.via = "dom"; }
    else if (!r.defaultPrevented) HTMLFormElement.prototype.submit.call(form);
  }

  // opts.fallback === false: when no React handler handles it, do nothing and
  // report via:"none" so the caller can apply its own DOM-event sequence.
  async function click(target, opts = {}) {
    const el = resolveControl(target);
    const kind = kindOf(el);
    if (kind === "checkbox" || kind === "radio") return fill(el, kind === "radio" ? true : undefined, opts);
    if (isDisabled(el)) throw new Error(`${cssPath(el)} is disabled`);
    el.focus?.({ preventScroll: true });
    const report = { target: cssPath(el), control: kind || "element", via: "react", called: [] };
    for (const type of ["mousedown", "mouseup", "click"]) {
      const r = dispatchReact(el, type);
      report.called.push(...r.called);
      report.defaultPrevented = r.defaultPrevented;
    }
    if (!report.called.length) {
      if (opts.fallback === false) report.via = "none";
      else { el.click(); report.via = "dom"; }
    } else if (!report.defaultPrevented) {
      const submit = el.closest?.("button, input");
      const form = submit?.form;
      if (form && submit.type === "submit") {
        submitForm(form, report);
      } else if (el instanceof HTMLAnchorElement && el.href && el.target !== "_blank" && !/^javascript:/i.test(el.href)) {
        report.navigate = el.href; location.href = el.href;
      }
    }
    await sleepTicks();
    return report;
  }

  async function fill(target, value, opts = {}) {
    let el = resolveControl(target);
    let kind = kindOf(el);
    if (!kind) {
      // A wrapper (e.g. a combobox div) around the real field.
      const inner = el.querySelector?.("input:not([type=hidden]):not([type=file]), textarea, select, [contenteditable]");
      if (inner) { el = inner; kind = kindOf(el); }
    }
    if (!kind || kind === "hidden" || kind === "file") throw new Error(`${cssPath(el)} is not a fillable control (${kind || el.tagName})`);
    if (kind === "button" || kind === "clickable") return click(el, opts);
    // A radio selector + string value picks the radio in that group by value/label.
    if (kind === "radio" && typeof value === "string" && !/^(true|false)$/i.test(value) && el.name) {
      const mates = [...document.querySelectorAll("input[type=radio]")].filter((r) => r.name === el.name && r.form === el.form);
      const want = value.trim().toLowerCase();
      const pick = mates.find((r) => r.value === value) || mates.find((r) => labelOf(r).toLowerCase() === want);
      if (!pick) throw new Error(`No radio in group "${el.name}" with value/label "${value}": ${mates.map((r) => r.value).join(", ")}`);
      el = pick; value = true;
    }
    if (isDisabled(el)) throw new Error(`${cssPath(el)} is disabled`);
    if (el.readOnly) throw new Error(`${cssPath(el)} is read-only`);
    const report = { target: typeof target === "string" ? target : cssPath(el), control: kind, owner: componentChain(el)[0] || null, via: "react", called: [] };
    const fire = (type, init) => { const r = dispatchReact(el, type, init); report.called.push(...r.called); return r; };
    const domEvents = () => {
      if (opts.fallback === false) { report.via = "none"; return; }
      report.via = "dom";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    el.focus?.({ preventScroll: true });

    if (kind === "text") {
      const text = String(value ?? "");
      setNative(el, "value", text);
      fire("input", { data: text });
      fire("change");
      if (!report.called.length) domEvents();
      return finish(el, kind, report, text);
    }

    if (kind === "contenteditable") {
      const text = String(value ?? "");
      el.textContent = text;
      fire("input", { data: text });
      if (!report.called.length) {
        if (opts.fallback === false) report.via = "none";
        else { report.via = "dom"; el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text })); }
      }
      return finish(el, kind, report, text);
    }

    if (kind === "checkbox" || kind === "radio") {
      const want = kind === "radio" ? true : value === undefined ? !el.checked : toBool(value);
      if (kind === "radio" && value !== undefined && !toBool(value)) throw new Error("A radio cannot be unchecked; check another radio in the group instead");
      if (el.checked === want) { report.noop = true; report.now = el.checked; report.applied = true; return report; }
      setNative(el, "checked", want);
      const c = fire("click");
      if (c.defaultPrevented) { setNative(el, "checked", !want); } else { fire("change"); }
      if (!report.called.length) {
        setNative(el, "checked", !want);
        if (opts.fallback === false) report.via = "none";
        else { el.click(); report.via = "dom"; }
      }
      return finish(el, kind, report, want);
    }

    if (kind === "aria-toggle" || kind === "aria-radio") {
      const want = kind === "aria-radio" ? true : value === undefined ? el.getAttribute("aria-checked") !== "true" : toBool(value);
      if ((el.getAttribute("aria-checked") === "true") === want) { report.noop = true; report.now = want; report.applied = true; return report; }
      const c = await click(el, opts);
      Object.assign(report, { via: c.via, called: c.called });
      return finish(el, kind, report, want);
    }

    if (kind === "select" || kind === "select-multiple") {
      const wanted = (Array.isArray(value) ? value : [value]).map((v) => String(v));
      const opts = [...el.options];
      const find = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim().toLowerCase() === w.trim().toLowerCase());
      const picks = wanted.map((w) => {
        const o = find(w);
        if (!o) throw new Error(`No option "${w}" in ${cssPath(el)}: ${opts.map((x) => x.text.trim()).join(", ")}`);
        return o;
      });
      if (kind === "select") el.selectedIndex = opts.indexOf(picks[0]);
      else opts.forEach((o) => { o.selected = picks.includes(o); });
      fire("input");
      fire("change");
      if (!report.called.length) domEvents();
      return finish(el, kind, report, kind === "select" ? picks[0].value : picks.map((o) => o.value));
    }

    throw new Error(`Unsupported control ${kind}`);
  }

  async function fillForm(map) {
    const entries = Array.isArray(map) ? map : Object.entries(map || {});
    const results = [];
    for (const [target, value] of entries) {
      try { results.push({ target, ok: true, ...(await fill(target, value)) }); }
      catch (err) { results.push({ target, ok: false, error: err?.message || String(err) }); }
    }
    return results;
  }

  async function press(target, key = "Enter", opts = {}) {
    const el = resolveControl(target);
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: KEYCODES[key] || key.toUpperCase().charCodeAt(0) };
    el.focus?.({ preventScroll: true });
    const report = { target: cssPath(el), key, via: "react", called: [] };
    const down = dispatchReact(el, "keydown", init);
    report.called.push(...down.called);
    if (!down.defaultPrevented && (key.length === 1 || key === "Enter")) report.called.push(...dispatchReact(el, "keypress", init).called);
    report.called.push(...dispatchReact(el, "keyup", init).called);
    if (!down.defaultPrevented && key === "Enter" && el instanceof HTMLInputElement && el.form && kindOf(el) === "text") {
      submitForm(el.form, report); // implicit submission
    }
    if (!report.called.length && opts.fallback === false) {
      report.via = "none";
    } else if (!report.called.length) {
      report.via = "dom";
      for (const t of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(t, { key, code: init.code, bubbles: true, cancelable: true }));
    }
    await sleepTicks();
    return report;
  }

  const setValue = (target, text) => fill(target, text); // kept for earlier callers

  function setHookState(componentName, hookIndex, value, instance = 0) {
    const fiber = findComponents(componentName)[instance];
    if (!fiber) throw new Error(`No component named ${componentName}`);
    if (fiber.tag === TAG.ClassComponent) { fiber.stateNode.setState(value); return { ok: true }; }
    let h = fiber.memoizedState;
    for (let i = 0; i < hookIndex && h; i += 1) h = h.next;
    if (!h?.queue?.dispatch) throw new Error(`Hook ${hookIndex} of ${componentName} is not state`);
    h.queue.dispatch(value);
    return { ok: true };
  }

  function pageInfo() {
    const count = (sel) => document.querySelectorAll(sel).length;
    const d = detect();
    const info = {
      readyState: document.readyState, lang: document.documentElement.lang || null,
      counts: { links: count("a[href]"), buttons: count("button, [role=button]"), inputs: count("input, textarea, select"), forms: count("form"), iframes: count("iframe") },
      react: { isReact: d.isReact },
    };
    if (d.isReact) {
      info.react = { ...d, hook: d.hook ? { commits: d.hook.commits, roots: d.hook.roots.length } : null };
      info.react.rootComponents = tree({ maxDepth: 1 }).map((n) => n.name);
      info.react.controls = controls().length;
    }
    return info;
  }

  globalThis.__bscReact = {
    isReact, pageInfo,
    version: 1,
    detect, roots, tree, fiberFor, propsFor, componentChain, describe, hooksOf,
    findComponents, invoke, setValue, setHookState, hostEl,
    controls, fill, fillForm, click, press,
    focus: (t) => { resolveControl(t).focus(); return true; },
    blur: (t) => { resolveControl(t).blur(); return true; },
    // Convenience: find by component name and describe the first match.
    inspect: (name, instance = 0) => {
      const f = findComponents(name)[instance];
      return f ? describe(f) : null;
    },
  };
})();
