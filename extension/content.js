(() => {
  if (globalThis.__browserAutomateLoaded) return;
  globalThis.__browserAutomateLoaded = true;

  const refs = new Map();

  const INTERACTIVE =
    'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="switch"], [role="combobox"], [role="option"], [contenteditable="true"], [contenteditable=""]';

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
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
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

  function fieldValue(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      if (el instanceof HTMLSelectElement) return el.value;
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

    for (const el of [...queryAllDeep(CONTEXT), ...queryAllDeep(INTERACTIVE)]) {
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
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        item.checked = el.checked;
      }
      if (el instanceof HTMLAnchorElement && el.href) item.href = el.href;
      items.push(item);
      if (items.length >= 250) break;
    }

    const lines = items.map((item) => {
      const bits = [`[${item.ref}]`, item.role];
      if (item.name) bits.push(JSON.stringify(item.name));
      if (item.value !== undefined) bits.push(`value=${JSON.stringify(item.value)}`);
      if (item.checked !== undefined) bits.push(item.checked ? "checked" : "unchecked");
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
    ensureSnapshotIfNeeded();
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

  function click(ref) {
    const el = requireEl(ref);
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    el.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window })
    );
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    el.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, cancelable: true, view: window })
    );
    el.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    if (typeof el.click === "function") el.click();
    else {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
    }
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

  function type(ref, text, submit) {
    const el = requireEl(ref);
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });

    if (el instanceof HTMLSelectElement) {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ref, value: el.value };
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== "browser-automate") return;
    try {
      let result;
      switch (message.action) {
        case "snapshot":
          result = snapshot();
          break;
        case "text":
          result = { title: document.title, url: location.href, text: visibleText() };
          break;
        case "click":
          result = click(message.ref);
          break;
        case "type":
          result = type(message.ref, message.text ?? "", Boolean(message.submit));
          break;
        case "press":
          result = press(message.key);
          break;
        case "scroll":
          result = scroll(message.direction, message.amount);
          break;
        case "find": {
          const ref = findByName(message.name);
          if (!ref) throw new Error(`No visible control named "${message.name}"`);
          result = { ref };
          break;
        }
        default:
          throw new Error(`Unknown page action: ${message.action}`);
      }
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  });
})();
