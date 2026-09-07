const DEFAULT_PORT = 8765;

const restricted = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^https:\/\/chrome(web)?store\.google\.com/i,
];

function isRestricted(url) {
  return !url || restricted.some((re) => re.test(url));
}

async function getPort() {
  const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
  return Number(port) || DEFAULT_PORT;
}

async function setStatus(partial) {
  const current = await chrome.storage.local.get({
    connected: false,
    lastError: "",
    lastSeen: 0,
  });
  const next = { ...current, ...partial };
  await chrome.storage.local.set(next);
  await chrome.action.setBadgeText({ text: next.connected ? "on" : "off" });
  await chrome.action.setBadgeBackgroundColor({
    color: next.connected ? "#1a7f37" : "#cf222e",
  });
}

let socket = null;
let currentUrl = "";
let reconnectTimer = 0;

function sendToSidecar(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return { ok: false, error: "Sidecar socket is not open" };
  }
  socket.send(JSON.stringify(data));
  return { ok: true };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(currentUrl), 1500);
}

function connect(url) {
  if (!url) return;
  if (socket && currentUrl === url && socket.readyState <= WebSocket.OPEN) return;

  currentUrl = url;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }

  try {
    socket = new WebSocket(url);
  } catch (err) {
    setStatus({
      connected: false,
      lastError: err instanceof Error ? err.message : String(err),
      lastSeen: Date.now(),
    });
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    setStatus({ connected: true, lastError: "", lastSeen: Date.now() });
  });

  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleCommand(data)
      .then((result) => sendToSidecar({ id: data.id, ok: true, result }))
      .catch((err) =>
        sendToSidecar({
          id: data.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  });

  socket.addEventListener("close", () => {
    setStatus({
      connected: false,
      lastError: "Disconnected from sidecar",
      lastSeen: Date.now(),
    });
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setStatus({
      connected: false,
      lastError: `Cannot reach ${url}. Is the sidecar running?`,
      lastSeen: Date.now(),
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab");
  return tab;
}

async function tabById(tabId) {
  if (tabId == null) return activeTab();
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`No Chrome tab with id ${tabId}. Run \`browser-session-ctl tabs\` to list ids.`);
  }
}

const PAGE_SCRIPT_VERSION = 4;

async function pageScriptVersion(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__bscVersion || 0,
    });
    return Number(result) || 0;
  } catch {
    return 0;
  }
}

async function inject(tabId) {
  if ((await pageScriptVersion(tabId)) >= PAGE_SCRIPT_VERSION) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function sendToPage(tab, payload) {
  if (isRestricted(tab.url)) {
    throw new Error(
      `This page cannot be automated (${tab.url}). Switch to a normal http(s) tab.`
    );
  }
  const message = { source: "browser-session-ctl-v3", ...payload };
  await inject(tab.id);
  let lastError;
  for (let i = 0; i < 8; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      lastError = err;
      await inject(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error("Could not reach the page script");
}

function unwrap(response) {
  if (!response) throw new Error("No response from the page. Reload the tab and try again.");
  if (!response.ok) throw new Error(response.error || "Page action failed");
  return response.result;
}

function runInPage(tab, args, func) {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args,
    func,
  });
}

async function clickByVisibleText(tab, name) {
  const [{ result, error }] = await runInPage(tab, [name], (needleRaw) => {
    const needle = String(needleRaw || "").trim().toLowerCase();
    if (!needle) throw new Error("name is required");
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const candidates = [];

    const consider = (el) => {
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const text = clean(el.innerText || el.textContent);
      if (!text || text.length > 120) return;
      const lower = text.toLowerCase();
      const exact = lower === needle;
      const partial = lower.includes(needle);
      if (!exact && !partial) return;
      candidates.push({ el, text, exact, len: text.length });
    };

    const walk = (root) => {
      root.querySelectorAll("*").forEach((node) => {
        consider(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      });
    };
    walk(document);

    candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || a.len - b.len);
    const best = candidates[0];
    if (!best) throw new Error(`No visible control named "${needleRaw}"`);

    const el = best.el;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", opts));
    return { name: best.text, tag: el.tagName };
  });
  if (error) throw new Error(error.message || String(error));
  return result;
}

async function typeByVisibleName(tab, name, text, submit) {
  const [{ result, error }] = await runInPage(tab, [name, text, Boolean(submit)], (needleRaw, value, doSubmit) => {
    const needle = String(needleRaw || "").trim().toLowerCase();
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    let host = null;
    let bestLen = Infinity;
    document.querySelectorAll("*").forEach((el) => {
      const label = clean(
        el.getAttribute("aria-label") ||
          el.innerText ||
          el.getAttribute("placeholder") ||
          ""
      ).toLowerCase();
      if (!label) return;
      if (label === needle || label.includes(needle)) {
        if (label.length < bestLen) {
          host = el;
          bestLen = label.length;
        }
      }
    });
    if (!host) throw new Error(`No visible control named "${needleRaw}"`);
    const el =
      host instanceof HTMLInputElement ||
      host instanceof HTMLTextAreaElement ||
      host instanceof HTMLSelectElement
        ? host
        : host.querySelector("input:not([type=hidden]), textarea, [contenteditable='true']") ||
          host;
    if (!(el instanceof HTMLElement)) throw new Error("Not a field you can type into");
    el.focus({ preventScroll: true });
    if (el instanceof HTMLSelectElement) {
      const match = [...el.options].find(
        (opt) =>
          opt.value === value || clean(opt.text).toLowerCase() === String(value).trim().toLowerCase()
      );
      el.value = match ? match.value : value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else if ("value" in el) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) desc.set.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (doSubmit) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }
    return { name: needleRaw, value };
  });
  if (error) throw new Error(error.message || String(error));
  return result;
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Navigation timed out"));
    }, timeoutMs);

    function onUpdated(id, info, tab) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function handleCommand(message) {
  const { method, params = {} } = message;

  switch (method) {
    case "ping":
      return { pong: true, at: Date.now() };

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        restricted: isRestricted(tab.url),
      }));
    }

    case "tabs.active": {
      const tab = await activeTab();
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        restricted: isRestricted(tab.url),
      };
    }

    case "page.navigate": {
      if (!params.url) throw new Error("url is required");
      const tab = await tabById(params.tabId);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      const done = await waitForComplete(updated.id);
      return { id: done.id, title: done.title, url: done.url };
    }

    case "page.back":
    case "page.forward":
    case "page.reload": {
      const tab = await tabById(params.tabId);
      const finished = waitForComplete(tab.id);
      if (method === "page.back") await chrome.tabs.goBack(tab.id);
      else if (method === "page.forward") await chrome.tabs.goForward(tab.id);
      else await chrome.tabs.reload(tab.id);
      try {
        const done = await finished;
        return { id: done.id, title: done.title, url: done.url };
      } catch {
        const current = await chrome.tabs.get(tab.id);
        return { id: current.id, title: current.title, url: current.url };
      }
    }

    case "page.snapshot": {
      const tab = await tabById(params.tabId);
      return unwrap(await sendToPage(tab, { action: "snapshot" }));
    }

    case "page.text": {
      const tab = await tabById(params.tabId);
      return unwrap(await sendToPage(tab, { action: "text" }));
    }

    case "page.options": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
        ref = found.ref;
      }
      if (!ref) throw new Error("ref or name is required");
      return unwrap(await sendToPage(tab, { action: "options", ref }));
    }

    case "page.click": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        try {
          const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
          ref = found.ref;
        } catch {
          return clickByVisibleText(tab, params.name);
        }
      }
      if (!ref) throw new Error("ref or name is required");
      try {
        return unwrap(await sendToPage(tab, { action: "click", ref }));
      } catch (err) {
        if (params.name) return clickByVisibleText(tab, params.name);
        throw err;
      }
    }

    case "page.type": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        try {
          const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
          ref = found.ref;
        } catch {
          return typeByVisibleName(tab, params.name, params.text ?? "", Boolean(params.submit));
        }
      }
      if (!ref) throw new Error("ref or name is required");
      try {
        return unwrap(
          await sendToPage(tab, {
            action: "type",
            ref,
            text: params.text ?? "",
            submit: Boolean(params.submit),
          })
        );
      } catch (err) {
        if (params.name) {
          return typeByVisibleName(tab, params.name, params.text ?? "", Boolean(params.submit));
        }
        throw err;
      }
    }

    case "page.press": {
      const tab = await tabById(params.tabId);
      if (!params.key) throw new Error("key is required");
      return unwrap(await sendToPage(tab, { action: "press", key: params.key }));
    }

    case "page.scroll": {
      const tab = await tabById(params.tabId);
      return unwrap(
        await sendToPage(tab, {
          action: "scroll",
          direction: params.direction || "down",
          amount: params.amount,
        })
      );
    }

    case "page.screenshot": {
      let tab = await tabById(params.tabId);
      if (!tab.active) {
        tab = await chrome.tabs.update(tab.id, { active: true });
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, url: tab.url, title: tab.title };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.type === "popup-status") {
    chrome.storage.local.get(null).then((state) => {
      sendResponse({
        ...state,
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      });
    });
    return true;
  }

  if (message.type === "popup-reconnect") {
    (async () => {
      if (message.port) await chrome.storage.local.set({ port: Number(message.port) });
      await boot();
      sendResponse({
        ok: true,
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      });
    })().catch((err) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }
});

async function boot() {
  const port = await getPort();
  await chrome.storage.local.set({ port });
  connect(`ws://127.0.0.1:${port}/extension`);
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(boot);
boot();
