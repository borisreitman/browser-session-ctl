(() => {
  const VERSION = 4;
  if (globalThis.__bscVersion === VERSION) return;
  if (typeof globalThis.__bscDetach === "function") globalThis.__bscDetach();

  const refs = new Map();

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

  function fireClick(el) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", opts));
  }

  function click(ref) {
    const el = requireEl(ref);
    fireClick(el);
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

  function press(key) {
    const target = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body;
    const opts = { key, code: key, bubbles: true, cancelable: true };
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

  function onMessage(message, _sender, sendResponse) {
    if (!message || message.source !== "browser-session-ctl-v3") return;
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
})();
