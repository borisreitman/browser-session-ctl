(() => {
  const VERSION = 27;
  if (globalThis.__bscVersion === VERSION) return;
  if (typeof globalThis.__bscDetach === "function") globalThis.__bscDetach();

  const refs = new Map();
  const ANNOTATE_BAR_ID = "__browser-session-ctl-annotate-bar__";
  // Shared by the bar's red border and the flashed favicon: how long each
  // stays up after a command before reverting (plain yellow / the page's
  // own favicon). Each new command resets both timers, so back-to-back
  // activity keeps them up rather than letting them flicker between commands.
  const FLASH_MS = 5000;
  // Three states, not two:
  //  - "action": a command just fired within the last FLASH_MS — yellow + red border.
  //  - "active": under control, but not that recently — plain yellow.
  //  - "idle":   hasn't been touched in a while — black.
  // How long the bar stays yellow after the last command before fading to
  // black. Tune this if it feels too eager or too sluggish.
  const ANNOTATE_ACTIVE_MS = 120000;
  const ANNOTATE_BG = { action: "#facc15", active: "#facc15", idle: "#111827" };
  const ANNOTATE_FG = { action: "#111827", active: "#111827", idle: "#ffffff" };
  const ANNOTATE_BORDER = { action: "#dc2626", active: "transparent", idle: "transparent" };
  let lastControlledAt = null;
  let annotateIdleTimer = null;
  let annotateBorderTimer = null;

  // The extension's own icon, shown briefly as the tab's favicon.
  const FAVICON_FLASH_URI = chrome.runtime.getURL("icons/favicon-flash.svg");
  let faviconState = null; // { links: [{el, href}], created } | null
  let faviconTimer = null;

  function restoreFavicon() {
    clearTimeout(faviconTimer);
    faviconTimer = null;
    if (!faviconState) return;
    if (faviconState.created) {
      faviconState.created.remove();
    } else {
      for (const { el, href } of faviconState.links) {
        if (href === null) el.removeAttribute("href");
        else el.setAttribute("href", href);
      }
    }
    faviconState = null;
  }

  function applyFaviconFlash() {
    if (!faviconState) {
      const links = [...document.querySelectorAll('link[rel~="icon"]')];
      if (links.length === 0) {
        const link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
        faviconState = { links: [], created: link };
      } else {
        faviconState = {
          links: links.map((el) => ({ el, href: el.getAttribute("href") })),
          created: null,
        };
      }
    }
    const targets = faviconState.created ? [faviconState.created] : faviconState.links.map((l) => l.el);
    for (const el of targets) el.setAttribute("href", FAVICON_FLASH_URI);
  }

  // Blinks the tab's favicon to the extension's own icon for a moment, so
  // it is visible that something just controlled this tab. Only while
  // annotate is on — the bar's presence is the on/off flag for this too.
  function flashFavicon() {
    if (!document.getElementById(ANNOTATE_BAR_ID)) return;
    clearTimeout(faviconTimer);
    applyFaviconFlash();
    faviconTimer = setTimeout(restoreFavicon, FLASH_MS);
  }

  // Unlike flashFavicon, ignores the annotate on/off state and doesn't
  // auto-revert — for `debug-set-favicon` to confirm the swap mechanism
  // actually works on a given tab, independent of the annotate feature.
  function debugSetFavicon(enabled) {
    clearTimeout(faviconTimer);
    faviconTimer = null;
    if (!enabled) {
      restoreFavicon();
      return { enabled: false };
    }
    applyFaviconFlash();
    return { enabled: true };
  }

  function renderAnnotateBar() {
    const bar = document.getElementById(ANNOTATE_BAR_ID);
    if (!bar) return;
    const when = lastControlledAt ? new Date(lastControlledAt).toLocaleTimeString() : "never";
    bar.textContent = `browser-session-ctl — last controlled ${when}`;
  }

  function setAnnotateState(state) {
    const bar = document.getElementById(ANNOTATE_BAR_ID);
    if (!bar) return;
    bar.style.background = ANNOTATE_BG[state];
    bar.style.color = ANNOTATE_FG[state];
    bar.style.borderColor = ANNOTATE_BORDER[state];
  }

  // A one-shot ring pulse so each individual command is visible, even if
  // the bar was already yellow from a previous one moments ago.
  function pulseAnnotateBar() {
    const bar = document.getElementById(ANNOTATE_BAR_ID);
    if (!bar || typeof bar.animate !== "function") return;
    bar.animate(
      [
        { boxShadow: "0 0 0 0 rgba(220, 38, 38, 0.9)" },
        { boxShadow: "0 0 0 6px rgba(220, 38, 38, 0)" },
        { boxShadow: "0 0 0 0 rgba(220, 38, 38, 0)" },
      ],
      { duration: 450, easing: "ease-out" }
    );
  }

  // "action" (yellow + red border) right when a command fires, settling to
  // plain "active" (yellow) shortly after, then to "idle" (black) once
  // it's been quiet for a while.
  function markAnnotateActive() {
    clearTimeout(annotateBorderTimer);
    clearTimeout(annotateIdleTimer);
    if (!document.getElementById(ANNOTATE_BAR_ID)) return;
    setAnnotateState("action");
    pulseAnnotateBar();
    annotateBorderTimer = setTimeout(() => setAnnotateState("active"), FLASH_MS);
    annotateIdleTimer = setTimeout(() => setAnnotateState("idle"), ANNOTATE_ACTIVE_MS);
  }

  // Forces the bar straight into one of its three states without waiting
  // for a real command or either timeout — for `debug-annotate-highlight`
  // to confirm each one actually renders correctly on a given tab.
  function debugAnnotateStatusHighlight(state) {
    if (!document.getElementById(ANNOTATE_BAR_ID)) {
      throw new Error("annotate is not on for this tab — run `annotate on` first");
    }
    clearTimeout(annotateBorderTimer);
    clearTimeout(annotateIdleTimer);
    if (state === "action") {
      setAnnotateState("action");
      pulseAnnotateBar();
      return { state: "action" };
    }
    if (state === "idle") {
      setAnnotateState("idle");
      return { state: "idle" };
    }
    setAnnotateState("active");
    return { state: "active" };
  }

  function setAnnotate(enabled) {
    let bar = document.getElementById(ANNOTATE_BAR_ID);
    if (!enabled) {
      clearTimeout(annotateIdleTimer);
      restoreFavicon();
      bar?.remove();
      return { enabled: false };
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = ANNOTATE_BAR_ID;
      bar.style.cssText = [
        "position: fixed",
        "bottom: 8px",
        "right: 8px",
        "z-index: 2147483647",
        "box-sizing: border-box",
        "font: 12px/1.6 -apple-system, BlinkMacSystemFont, sans-serif",
        "text-align: right",
        "padding: 2px 8px",
        "border-radius: 4px",
        "border: 2px solid transparent",
        "pointer-events: none",
        "transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease",
      ].join("; ");
      (document.body || document.documentElement).appendChild(bar);
    }
    renderAnnotateBar();
    markAnnotateActive();
    return { enabled: true };
  }

  const INTERACTIVE =
    'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="switch"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"] [role="menuitem"], [contenteditable="true"], [contenteditable=""]';

  const MENU_ITEMS =
    '[role="option"], [role="menuitem"], [role="listbox"] li, [role="menu"] li, [data-radix-collection-item]';

  const CONTEXT = "h1, h2, h3, [role='heading']";

  function queryAllDeep(selector, root = document) {
    const out = [];
    try {
      root.querySelectorAll(selector).forEach((el) => out.push(el));
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) out.push(...queryAllDeep(selector, el.shadowRoot));
      });
    } catch {
      // Invalid selector in a weird document — skip.
    }
    return out;
  }

  function isMenuItem(el) {
    if (!(el instanceof Element)) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "option" || role === "menuitem") return true;
    if (el.closest('[role="listbox"], [role="menu"], [role="list"]')) return true;
    return false;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (isMenuItem(el)) return true;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > innerHeight || rect.left > innerWidth) return false;
    return true;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return clean(label.innerText);
      } catch {
        // ignore
      }
    }
    const wrapped = el.closest("label");
    if (wrapped) {
      const clone = wrapped.cloneNode(true);
      clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
      const text = clean(clone.innerText);
      if (text) return text;
    }
    return clean(
      el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.innerText ||
        ""
    );
  }

  function clean(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "label") return "label";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "li" && isMenuItem(el)) return "option";
    if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
    if (el.isContentEditable) return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "file", "image"].includes(type)) {
        return "button";
      }
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "password") return "textbox";
      return "textbox";
    }
    return tag;
  }

  function isChecked(el) {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      return el.checked;
    }
    const aria = el.getAttribute("aria-checked") || el.getAttribute("aria-selected");
    if (aria === "true") return true;
    if (aria === "false") return false;
    return undefined;
  }

  function fieldValue(el) {
    if (el.getAttribute("role") === "combobox") {
      const typed = el.querySelector?.("input, textarea")?.value;
      const shown = clean(el.innerText);
      return typed || shown || undefined;
    }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      if (el instanceof HTMLSelectElement) {
        const picked = el.selectedOptions?.[0]?.text;
        return clean(picked || el.value) || undefined;
      }
      if (el.isContentEditable) return clean(el.innerText);
      return undefined;
    }
    const type = (el.type || "").toLowerCase();
    if (type === "password") return el.value ? "••••" : "";
    if (type === "hidden") return undefined;
    return String(el.value || "").slice(0, 200);
  }

  function resolve(ref) {
    return refs.get(ref) || document.querySelector(`[data-ba-ref="${ref}"]`);
  }

  function snapshot() {
    refs.clear();
    document.querySelectorAll("[data-ba-ref]").forEach((el) => {
      delete el.dataset.baRef;
    });

    const seen = new Set();
    const items = [];
    let n = 1;

    for (const el of [
      ...queryAllDeep(CONTEXT),
      ...queryAllDeep(INTERACTIVE),
      ...queryAllDeep(MENU_ITEMS),
    ]) {
      if (seen.has(el) || !isVisible(el)) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      seen.add(el);

      const ref = `e${n++}`;
      refs.set(ref, el);
      el.dataset.baRef = ref;

      const item = {
        ref,
        role: roleOf(el),
        name: accessibleName(el),
      };
      const value = fieldValue(el);
      if (value !== undefined && value !== "") item.value = value;
      const checked = isChecked(el);
      if (checked !== undefined) item.checked = checked;
      if (el instanceof HTMLAnchorElement && el.href) item.href = el.href;
      const role = item.role;
      if (role === "combobox" || role === "listbox" || el instanceof HTMLSelectElement) {
        const names = slurpOptions(el).map((opt) => opt.name).filter(Boolean);
        if (names.length) item.options = names.slice(0, 40);
      }
      items.push(item);
      if (items.length >= 250) break;
    }

    const lines = items.map((item) => {
      const bits = [`[${item.ref}]`, item.role];
      if (item.name) bits.push(JSON.stringify(item.name));
      if (item.value !== undefined) bits.push(`value=${JSON.stringify(item.value)}`);
      if (item.checked !== undefined) bits.push(item.checked ? "checked" : "unchecked");
      if (item.options?.length) bits.push(`options=${item.options.length}`);
      return bits.join(" ");
    });

    return {
      title: document.title,
      url: location.href,
      text: `${document.title}\n${location.href}\n\n${lines.join("\n")}`,
      elements: items,
    };
  }

  function visibleText() {
    const body = document.body;
    if (!body) return "";
    const clone = body.cloneNode(true);
    clone
      .querySelectorAll("script, style, noscript, svg, canvas")
      .forEach((n) => n.remove());
    return String(clone.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20000);
  }

  function ensureSnapshotIfNeeded() {
    if (refs.size === 0) snapshot();
  }

  function findByName(name) {
    snapshot();
    const needle = name.trim().toLowerCase();
    if (!needle) return null;
    for (const [ref, el] of refs) {
      const label = accessibleName(el).toLowerCase();
      if (label === needle) return ref;
    }
    for (const [ref, el] of refs) {
      const label = accessibleName(el).toLowerCase();
      if (label.includes(needle)) return ref;
    }
    return null;
  }

  function requireEl(ref) {
    ensureSnapshotIfNeeded();
    const el = resolve(ref);
    if (!el) {
      throw new Error(`Unknown ref "${ref}". Run snapshot again — the page may have changed.`);
    }
    return el;
  }

  function fromSelect(select) {
    return [...select.options].map((opt) => ({
      name: clean(opt.text),
      value: opt.value,
      selected: Boolean(opt.selected),
      disabled: Boolean(opt.disabled),
    }));
  }

  function optionRecord(el) {
    const name = accessibleName(el) || clean(el.innerText || el.textContent);
    if (!name) return null;
    return {
      name,
      value: el.getAttribute("data-value") || el.getAttribute("value") || name,
      selected: isChecked(el) === true || el.getAttribute("aria-selected") === "true",
      disabled: el.getAttribute("aria-disabled") === "true" || el.disabled === true,
    };
  }

  function collectOptionNodes(root, into) {
    if (!root) return;
    if (root instanceof HTMLSelectElement) {
      fromSelect(root).forEach((opt) => into.push(opt));
      return;
    }
    const nodes = [
      ...root.querySelectorAll(
        'option, [role="option"], [role="menuitem"], [role="listbox"] li, [role="menu"] li, [data-radix-collection-item]'
      ),
    ];
    if (nodes.length === 0) {
      root.querySelectorAll(":scope > *").forEach((child) => {
        const text = clean(child.innerText || child.textContent);
        if (text && text.length <= 80 && ![...child.children].some((c) => clean(c.innerText).length > 0 && c.children.length > 0)) {
          nodes.push(child);
        }
      });
    }
    for (const node of nodes) {
      const rec = optionRecord(node);
      if (rec) into.push(rec);
    }
  }

  function slurpOptions(host) {
    const out = [];
    const seen = new Set();
    const addAll = (rows) => {
      for (const row of rows) {
        const key = `${row.name}\0${row.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
    };

    if (host instanceof HTMLSelectElement) return fromSelect(host);
    const inner = host.querySelector?.("select");
    if (inner) return fromSelect(inner);

    const owned = `${host.getAttribute("aria-controls") || ""} ${host.getAttribute("aria-owns") || ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const id of owned) {
      const box = document.getElementById(id);
      if (box) collectOptionNodes(box, out);
    }
    collectOptionNodes(host, out);

    for (const box of queryAllDeep(
      '[role="listbox"], [role="menu"], [data-radix-select-content], [data-headlessui-state]'
    )) {
      if (getComputedStyle(box).display === "none") continue;
      const rows = [];
      collectOptionNodes(box, rows);
      addAll(rows);
    }

    const deduped = [];
    const keys = new Set();
    for (const row of out) {
      const key = `${row.name}\0${row.value}`;
      if (keys.has(key)) continue;
      keys.add(key);
      deduped.push(row);
    }
    return deduped;
  }

  function listOptions(ref) {
    return new Promise((resolve) => {
      const el = requireEl(ref);
      const first = slurpOptions(el);
      if (first.length > 0) {
        resolve({ ref, name: accessibleName(el), options: first, opened: false });
        return;
      }
      fireClick(el);
      setTimeout(() => {
        resolve({
          ref,
          name: accessibleName(el),
          options: slurpOptions(el),
          opened: true,
        });
      }, 200);
    });
  }

  // The one click sequence. Presets:
  //   CLI / core click:  { scroll, focus, synthetic: false, native: true }
  //   plugins' fireClick: { synthetic: true }              (events only)
  //   plugins' clickEl:   { synthetic: true, native: true } (events, then el.click())
  function fireClick(el, { scroll = false, focus = false, synthetic = true, native = false } = {}) {
    if (scroll) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (focus && el instanceof HTMLElement) el.focus({ preventScroll: true });
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.max(rect.width / 2, 1),
      clientY: rect.top + Math.max(rect.height / 2, 1),
      button: 0,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    if (synthetic) el.dispatchEvent(new MouseEvent("click", opts));
    if (native) {
      if (typeof el.click === "function") el.click();
      else if (!synthetic) el.dispatchEvent(new MouseEvent("click", opts));
    }
  }

  function click(ref) {
    const el = requireEl(ref);
    fireClick(el, { scroll: true, focus: true, synthetic: false, native: true });
    return { ref, name: accessibleName(el) };
  }

  function setNativeValue(el, text) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, text);
    else el.value = text;
  }

  function typeable(el) {
    if (!el) return null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
    if (el instanceof HTMLSelectElement) return el;
    if (el.isContentEditable) return el;
    const inner = el.querySelector?.("input:not([type=hidden]), textarea, [contenteditable='true']");
    return inner || null;
  }

  function type(ref, text, submit) {
    const host = requireEl(ref);
    const el = typeable(host) || host;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });

    if (el instanceof HTMLSelectElement) {
      const match = [...el.options].find(
        (opt) =>
          opt.value === text ||
          clean(opt.text).toLowerCase() === String(text).trim().toLowerCase()
      );
      el.value = match ? match.value : text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ref, value: clean(el.selectedOptions?.[0]?.text || el.value) };
    }

    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      throw new Error(`Ref ${ref} is not a field you can type into`);
    }

    if (submit) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
      );
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else if (form) form.submit();
    }

    return { ref, value: fieldValue(el) };
  }

  async function compilePluginClass(code) {
    const source = `${code}\nexport default Plugin;\n`;
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const mod = await import(blobUrl);
      if (typeof mod.default !== "function") {
        throw new Error('Plugin file must define a class named "Plugin".');
      }
      return mod.default;
    } catch (blobErr) {
      const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
      try {
        const mod = await import(dataUrl);
        if (typeof mod.default !== "function") {
          throw new Error('Plugin file must define a class named "Plugin".');
        }
        return mod.default;
      } catch {
        throw blobErr;
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  function taintPlugin(namespace, epoch) {
    globalThis.__bscPluginState = globalThis.__bscPluginState || {};
    const slot = (globalThis.__bscPluginState[namespace] ||= {});
    delete slot.instance;
    slot.tainted = true;
    if (epoch != null) slot.epoch = epoch;
  }

  async function installPlugin(namespace, code, epoch) {
    if (!namespace || typeof code !== "string" || !code.trim()) return;
    taintPlugin(namespace, epoch);
    const slot = globalThis.__bscPluginState[namespace];
    const PluginClass = await compilePluginClass(code);
    slot.instance = new PluginClass();
    slot.source = code;
    slot.tainted = false;
    slot.instanceEpoch = epoch || 0;
  }

  function dropPlugin(namespace) {
    if (globalThis.__bscPluginState && namespace) delete globalThis.__bscPluginState[namespace];
  }

  async function installAll(plugins, epochs) {
    for (const [ns, code] of Object.entries(plugins || {})) {
      try {
        await installPlugin(ns, code, epochs?.[ns]);
      } catch {
        // One bad plugin must not block the rest. Instance stays tainted.
      }
    }
  }

  async function runPlugin(namespace, code, method, rest, epoch) {
    const slot = globalThis.__bscPluginState?.[namespace];
    const stale =
      !slot?.instance ||
      slot.tainted ||
      (code && slot.source !== code) ||
      (epoch != null && slot.instanceEpoch !== epoch);
    if (code && stale) await installPlugin(namespace, code, epoch);
    const ready = globalThis.__bscPluginState?.[namespace];
    if (!ready?.instance) {
      throw new Error(`Unknown plugin namespace "${namespace}". Load it first with plugin.load.`);
    }
    const resolved = method || (typeof ready.instance.help === "function" ? "help" : null);
    if (!resolved) {
      throw new Error(
        `A method name is required, e.g. plugin.${namespace} <method> [args...]. This plugin has no help() to fall back to.`
      );
    }
    const fn = ready.instance[resolved];
    if (typeof fn !== "function") {
      throw new Error(`Plugin "${namespace}" has no method "${resolved}"`);
    }
    const value = await fn.apply(ready.instance, resolved === method ? rest : []);
    return value === undefined ? null : value;
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

  function press(key, el) {
    const target = el || (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
    const keyCode = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { key };
  }

  function scroll(direction, amount = 600) {
    const delta = direction === "up" ? -amount : amount;
    window.scrollBy({ top: delta, behavior: "instant" });
    return { y: window.scrollY };
  }

  // ---- API for plugins -------------------------------------------------
  //
  // Plugins run in this same isolated world, so `bsc` is a plain global to
  // them. A plugin is written for one site and knows how that site is built, so
  // there is no auto-detection: it calls bsc.click(el) for plain DOM events or
  // bsc.reactClick(el) for React handlers (likewise fill/reactFill,
  // select/reactSelect, press/reactPress). The React variants throw when the
  // page is not React, so a site that changes implementation breaks the plugin.
  function bscCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "bsc-command", method, params }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response?.ok) return reject(new Error(response?.error || `${method} failed`));
          resolve(response.result);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  const bscTarget = (t) => (/^e\d+$/i.test(String(t)) ? { ref: String(t) } : { name: String(t) });
  const bscReactCall = (fn, ...args) => bscCommand("react.call", { fn, args });
  const bscAngularCall = (fn, ...args) => bscCommand("angular.call", { fn, args });

  // react-hook.js marks <html data-bsc-react="18.3.1"> when a renderer registers.
  // Without the marker (a tab opened before the extension loaded) ask the probe.
  let reactProbeAt = 0;
  let reactProbeVal = false;
  async function isReactPage() {
    if (document.documentElement.hasAttribute("data-bsc-react")) return true;
    if (Date.now() - reactProbeAt < 1500) return reactProbeVal;
    try { reactProbeVal = Boolean(await bscReactCall("isReact")); } catch { reactProbeVal = false; }
    reactProbeAt = Date.now();
    return reactProbeVal;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cleanText = (text) => String(text || "").replace(/\s+/g, " ").trim();

  function isDisplayed(el, { minSize = 2 } = {}) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < minSize) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0;
  }

  // First truthy fn() within tries*ms, else null.
  async function waitFor(fn, tries = 20, ms = 250) {
    for (let i = 0; i < tries; i += 1) {
      const v = await fn();
      if (v) return v;
      await sleep(ms);
    }
    return null;
  }

  const dates = {
    looksLikeDate: (v) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v),
    parse(value) {
      const us = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (us) return { y: Number(us[3]), m: Number(us[1]), d: Number(us[2]) };
      const iso = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
      throw new Error(`Unrecognized date "${value}". Use YYYY-MM-DD or MM/DD/YYYY.`);
    },
    toIso(value) {
      const { y, m, d } = dates.parse(value);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    },
  };

  // Native DOM-event versions. Synchronous.
  function setValueDom(el, text, { clear = false, typing = false, change = true } = {}) {
    if (typing || clear) el.focus?.();
    if (clear) {
      setNativeValue(el, "");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    }
    setNativeValue(el, text);
    el.dispatchEvent(typing
      ? new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      : new Event("input", { bubbles: true }));
    if (change) el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findOption(select, label, partial) {
    const want = cleanText(label).toLowerCase();
    const opts = [...select.options];
    return opts.find((o) => o.value === String(label))
      || opts.find((o) => cleanText(o.text).toLowerCase() === want)
      || (partial ? opts.find((o) => cleanText(o.text).toLowerCase().includes(want)) : undefined);
  }

  function selectDom(select, label, { partial = false } = {}) {
    const option = findOption(select, label, partial);
    if (!option) throw new Error(`No option matching "${label}" (has: ${[...select.options].map((o) => cleanText(o.text)).join(", ")})`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return cleanText(option.text);
  }

  // Elements can't cross into the main world, so lend them a temporary ref
  // the page-side probe can find with a selector.
  let adoptSeq = 0;
  async function withRef(el, fn) {
    const ref = `p${++adoptSeq}`;
    refs.set(ref, el);
    el.setAttribute("data-ba-ref", ref);
    try {
      return await fn(`[data-ba-ref="${ref}"]`);
    } finally {
      refs.delete(ref);
      if (el.getAttribute("data-ba-ref") === ref) el.removeAttribute("data-ba-ref");
    }
  }

  // React variants: drive the element's own React handler (onClick / onChange …)
  // through the page-side probe. They throw if the page is not React, and if no
  // React handler takes the element — there is no silent fallback to DOM events.
  // A plugin picks the variant per element by calling click vs reactClick, etc.
  async function reactOp(el, fn, ...args) {
    if (!el) throw new Error(`${fn}: no element`);
    if (!(await isReactPage())) {
      throw new Error(`react ${fn} was called but this page is not React. The site has changed; the plugin needs updating.`);
    }
    const r = await withRef(el, (sel) => bscReactCall(fn, sel, ...args, { fallback: false }));
    if (r.via === "none") {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const hook = el.getAttribute("data-hook") || el.getAttribute("data-testid") || "";
      throw new Error(`No React handler on <${tag}${id}${hook ? ` ${hook}` : ""}> or its ancestors for ${fn}; this element is not driven by React`);
    }
    return r;
  }

  globalThis.bsc = {
    // Plain DOM events on an element. Synchronous.
    fireClick: (el) => fireClick(el, { synthetic: true }),               // pointer/mouse events incl. a synthetic click
    click: (el) => fireClick(el, { synthetic: true, native: true }),     // the same, then el.click()
    fill: setValueDom,                                                   // (el, text, { clear, typing, change })
    select: selectDom,                                                   // (selectEl, label, { partial }) -> option label
    press: (el, key) => press(key, el),                                  // keydown/keypress/keyup on el

    // React handlers on an element. Async; see reactOp.
    reactClick: (el) => reactOp(el, "click"),
    reactFill: (el, text) => reactOp(el, "fill", text),
    reactSelect: async (el, label, { partial = false } = {}) => {
      const option = findOption(el, label, partial);
      if (!option) throw new Error(`No option matching "${label}" (has: ${[...el.options].map((o) => cleanText(o.text)).join(", ")})`);
      await reactOp(el, "fill", option.value);
      return cleanText(option.text);
    },
    reactPress: (el, key) => reactOp(el, "press", key),
    isReact: isReactPage,
    // Any function of the page's React probe: bsc.react.controls(), .inspect("Cart"), .fill("#q", "x") ...
    react: new Proxy(
      { call: bscReactCall },
      { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? (...args) => bscReactCall(name, ...args) : undefined) }
    ),

    // Any function of the page's Angular probe: bsc.angular.detect(), .survey(), .component("#el") ...
    angular: new Proxy(
      { call: bscAngularCall },
      { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? (...args) => bscAngularCall(name, ...args) : undefined) }
    ),

    sleep, clean: cleanText, waitFor, isDisplayed, dates,

    // Page reads and the extension's own commands.
    command: bscCommand, // page-level only: page.* and react.call
    status: () => bscCommand("page.status"),
    snapshot: async () => snapshot(),
    text: async () => ({ title: document.title, url: location.href, text: visibleText() }),
    find: async (name) => findByName(name),
    options: async (target) => {
      const ref = /^e\d+$/i.test(String(target)) ? String(target) : findByName(String(target));
      if (!ref) throw new Error(`No visible control named "${target}"`);
      return listOptions(ref);
    },
    scroll: async (direction, amount) => scroll(direction, amount),
  };

  function onPluginSync(message, sendResponse) {
    const reply = (work) => {
      Promise.resolve()
        .then(work)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
    };
    switch (message.action) {
      case "taint":
        reply(async () => {
          taintPlugin(message.namespace, message.epoch);
          if (message.code) {
            try {
              await installPlugin(message.namespace, message.code, message.epoch);
            } catch {
              // Compile can fail on a strict CSP page; the slot stays tainted
              // so the next invoke builds a new instance from the injected file.
            }
          }
          return { namespace: message.namespace, epoch: message.epoch };
        });
        break;
      case "install":
        reply(async () => {
          await installPlugin(message.namespace, message.code, message.epoch);
          return { namespace: message.namespace };
        });
        break;
      case "uninstall":
        reply(() => {
          dropPlugin(message.namespace);
          return { namespace: message.namespace };
        });
        break;
      case "install-all":
        reply(async () => {
          await installAll(message.plugins, message.epochs);
          return { count: Object.keys(message.plugins || {}).length };
        });
        break;
      default:
        reply(() => {
          throw new Error(`Unknown plugin sync action: ${message.action}`);
        });
    }
  }

  function onMessage(message, _sender, sendResponse) {
    if (!message) return;
    if (message.source === "browser-session-ctl-plugin") {
      onPluginSync(message, sendResponse);
      return true;
    }
    if (message.source !== "browser-session-ctl-v3") return;
    lastControlledAt = Date.now();
    renderAnnotateBar();
    markAnnotateActive();
    flashFavicon();
    const reply = (work) => {
      Promise.resolve()
        .then(work)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
    };
    switch (message.action) {
      case "snapshot":
        reply(() => snapshot());
        break;
      case "text":
        reply(() => ({ title: document.title, url: location.href, text: visibleText() }));
        break;
      case "click":
        reply(() => click(message.ref));
        break;
      case "type":
        reply(() => type(message.ref, message.text ?? "", Boolean(message.submit)));
        break;
      case "press":
        reply(() => press(message.key));
        break;
      case "scroll":
        reply(() => scroll(message.direction, message.amount));
        break;
      case "find":
        reply(() => {
          const ref = findByName(message.name);
          if (!ref) throw new Error(`No visible control named "${message.name}"`);
          return { ref };
        });
        break;
      case "options":
        reply(() => listOptions(message.ref));
        break;
      case "annotate":
        reply(() => setAnnotate(message.enabled !== false));
        break;
      case "debug-set-favicon":
        reply(() => debugSetFavicon(message.enabled !== false));
        break;
      case "debug-annotate-highlight":
        reply(() =>
          debugAnnotateStatusHighlight(
            ["action", "active", "idle"].includes(message.state) ? message.state : "active"
          )
        );
        break;
      case "plugin":
        reply(() =>
          runPlugin(
            message.namespace,
            message.code,
            message.method ?? null,
            message.args || [],
            message.epoch
          )
        );
        break;
      case "touch":
        reply(() => null);
        break;
      default:
        reply(() => {
          throw new Error(`Unknown page action: ${message.action}`);
        });
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__bscDetach = () => chrome.runtime.onMessage.removeListener(onMessage);
  globalThis.__bscVersion = VERSION;

  chrome.runtime.sendMessage({ type: "annotate-query" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.enabled) setAnnotate(true);
  });

  chrome.runtime.sendMessage({ type: "plugin-query" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.plugins) installAll(response.plugins, response.epochs).catch(() => {});
  });
})();
