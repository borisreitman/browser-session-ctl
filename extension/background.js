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

function isBlankTab(url) {
  return !url || /^about:blank$/i.test(url) || /^chrome:\/\/newtab\/?$/i.test(url);
}

async function getPort() {
  const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
  return Number(port) || DEFAULT_PORT;
}

const DEFAULT_SETTINGS = { annotateNewTabs: true };

async function getSettings() {
  const { settings } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
  const settings = await getSettings();
  settings[key] = value;
  await chrome.storage.local.set({ settings });
  return settings;
}

// Annotate is per tab, not per document. The bar is painted into the page, so
// a reload would wipe it unless we remember the tab id and put the bar back.
const annotateTabIdsMemory = new Set();

async function getAnnotateTabIds() {
  if (chrome.storage.session) {
    const { annotateTabIds } = await chrome.storage.session.get({ annotateTabIds: [] });
    return new Set((annotateTabIds || []).map(Number).filter((id) => Number.isInteger(id)));
  }
  return annotateTabIdsMemory;
}

async function setTabAnnotate(tabId, enabled) {
  if (chrome.storage.session) {
    const ids = await getAnnotateTabIds();
    if (enabled) ids.add(tabId);
    else ids.delete(tabId);
    await chrome.storage.session.set({ annotateTabIds: [...ids] });
    return;
  }
  if (enabled) annotateTabIdsMemory.add(tabId);
  else annotateTabIdsMemory.delete(tabId);
}

async function tabAnnotateEnabled(tabId) {
  return (await getAnnotateTabIds()).has(tabId);
}

async function applyAnnotateIfEnabled(tab) {
  if (!tab?.id || isRestricted(tab.url) || isBlankTab(tab.url)) return;
  if (!(await tabAnnotateEnabled(tab.id))) return;
  try {
    await sendToPage(tab, { action: "annotate", enabled: true });
  } catch {
    // Page script not ready, or the tab went restricted mid-load.
  }
}

// runtime-load (plugin.load): persist source once on the extension so every
// current and future tab inherits that namespace until plugin.unload.
//
// inject-load (plugin.inject, and plugin.invoke): rewrite
// extension/runtime-plugins/<ns>.js from disk, update that same stored
// source (tabs inherit the new bytes), and inject the file into the tab
// you are driving. Changing plugin source does not require reloading the
// extension; changing this file / content.js / the manifest still does.
const runtimePlugins = new Map(); // namespace -> source code
const pluginEpochs = new Map(); // namespace -> generation; bumped on every load/inject push

const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*$/i;

function requireNamespace(namespace) {
  if (!namespace || !NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid plugin namespace "${namespace}". Use letters, digits, and dashes, e.g. "jupyter-notebook".`
    );
  }
  return namespace;
}

const pluginsReady = restorePlugins();

async function restorePlugins() {
  const { runtimePlugins: stored, pluginEpochs: storedEpochs } = await chrome.storage.local.get({
    runtimePlugins: {},
    pluginEpochs: {},
  });
  runtimePlugins.clear();
  pluginEpochs.clear();
  for (const [ns, code] of Object.entries(stored || {})) {
    if (typeof ns === "string" && NAMESPACE_RE.test(ns) && typeof code === "string" && code.trim()) {
      runtimePlugins.set(ns, code);
    }
  }
  for (const [ns, epoch] of Object.entries(storedEpochs || {})) {
    if (runtimePlugins.has(ns) && Number.isFinite(epoch) && epoch > 0) {
      pluginEpochs.set(ns, epoch);
    }
  }
}

async function savePlugins() {
  await chrome.storage.local.set({
    runtimePlugins: Object.fromEntries(runtimePlugins),
    pluginEpochs: Object.fromEntries(pluginEpochs),
  });
}

function pluginEpoch(namespace) {
  return pluginEpochs.get(namespace) || 0;
}

function bumpPluginEpoch(namespace) {
  const epoch = pluginEpoch(namespace) + 1;
  pluginEpochs.set(namespace, epoch);
  return epoch;
}

function pluginsPayload() {
  return { plugins: pluginsObject(), epochs: Object.fromEntries(pluginEpochs) };
}

async function persistPlugin(namespace, code) {
  runtimePlugins.set(namespace, code);
  const epoch = bumpPluginEpoch(namespace);
  await savePlugins();
  await broadcastPlugins({ action: "taint", namespace, code, epoch });
}

function pluginSource(namespace) {
  if (runtimePlugins.has(namespace)) return runtimePlugins.get(namespace);
  throw new Error(`Unknown plugin namespace "${namespace}". Load it first with plugin.load.`);
}

function pluginsObject() {
  return Object.fromEntries(runtimePlugins);
}

async function runPluginInPage(namespace, code, action, rest, epoch) {
  try {
    window.__bscPluginState = window.__bscPluginState || {};
    const slot = (window.__bscPluginState[namespace] ||= {});
    epoch = epoch || 0;
    if (
      !slot.instance ||
      slot.tainted ||
      slot.source !== code ||
      slot.instanceEpoch !== epoch
    ) {
      const PluginClass = new Function(`"use strict";\n${code}\n;return Plugin;`)();
      if (typeof PluginClass !== "function") {
        throw new Error('Plugin file must define a class named "Plugin".');
      }
      slot.instance = new PluginClass();
      slot.source = code;
      slot.tainted = false;
      slot.instanceEpoch = epoch;
    }
    const resolvedAction = action || (typeof slot.instance.help === "function" ? "help" : null);
    if (!resolvedAction) {
      throw new Error(
        `A method name is required, e.g. plugin.${namespace} <method> [args...]. This plugin has no help() to fall back to.`
      );
    }
    const method = slot.instance[resolvedAction];
    if (typeof method !== "function") {
      throw new Error(`Plugin "${namespace}" has no method "${resolvedAction}"`);
    }
    const value = await method.apply(slot.instance, resolvedAction === action ? rest : []);
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isCompileBlocked(error) {
  return /Trusted Type|unsafe-eval|EvalError|Content Security Policy|dynamically imported module|Failed to fetch/i.test(
    String(error || "")
  );
}

class RuntimePluginFileError extends Error {}

function resolvePluginCode(namespace, liveCode) {
  if (typeof liveCode === "string" && liveCode.trim()) return liveCode;
  return pluginSource(namespace);
}

async function runPluginFromInjectedFile(namespace, code, action, rest, epoch) {
  try {
    window.__bscPluginState = window.__bscPluginState || {};
    const slot = (window.__bscPluginState[namespace] ||= {});
    const PluginClass = globalThis.__bscPluginExports?.[namespace];
    if (typeof PluginClass !== "function") {
      throw new Error(`Unknown plugin namespace "${namespace}". Runtime-load it with plugin-load, or inject-load first.`);
    }
    epoch = epoch || 0;
    if (
      !slot.instance ||
      slot.tainted ||
      slot.source !== code ||
      slot.instanceEpoch !== epoch
    ) {
      slot.instance = new PluginClass();
      slot.source = code;
      slot.tainted = false;
      slot.instanceEpoch = epoch;
    }
    const resolvedAction = action || (typeof slot.instance.help === "function" ? "help" : null);
    if (!resolvedAction) {
      throw new Error(
        `A method name is required, e.g. plugin.${namespace} <method> [args...]. This plugin has no help() to fall back to.`
      );
    }
    const method = slot.instance[resolvedAction];
    if (typeof method !== "function") {
      throw new Error(`Plugin "${namespace}" has no method "${resolvedAction}"`);
    }
    const value = await method.apply(slot.instance, resolvedAction === action ? rest : []);
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function bindInjectedPlugin(namespace, code, epoch) {
  try {
    window.__bscPluginState = window.__bscPluginState || {};
    const slot = (window.__bscPluginState[namespace] ||= {});
    const PluginClass = globalThis.__bscPluginExports?.[namespace];
    if (typeof PluginClass !== "function") {
      throw new Error(`Unknown plugin namespace "${namespace}". Runtime-load it with plugin-load, or inject-load first.`);
    }
    slot.instance = new PluginClass();
    slot.source = code;
    slot.tainted = false;
    slot.instanceEpoch = epoch || 0;
    return { ok: true, value: { namespace, injected: true } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function injectPluginFile(tab, namespace) {
  await inject(tab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      files: [`runtime-plugins/${namespace}.js`],
    });
  } catch (err) {
    throw new RuntimePluginFileError(err instanceof Error ? err.message : String(err));
  }
}

async function invokePluginFromFile(tab, namespace, args, code) {
  const [action, ...rest] = args;
  await injectPluginFile(tab, namespace);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    args: [namespace, code, action ?? null, rest, pluginEpoch(namespace)],
    func: runPluginFromInjectedFile,
  });
  const payload = injection?.result;
  if (!payload?.ok) throw new Error(payload?.error || "Plugin failed with no error message");
  sendToPage(tab, { action: "touch" }).catch(() => {});
  return payload.value;
}

async function injectLoadPlugin(tab, namespace, code) {
  await injectPluginFile(tab, namespace);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    args: [namespace, code, pluginEpoch(namespace)],
    func: bindInjectedPlugin,
  });
  const payload = injection?.result;
  if (!payload?.ok) throw new Error(payload?.error || "Plugin inject-load failed");
  sendToPage(tab, { action: "touch" }).catch(() => {});
  return payload.value;
}

async function invokePluginInMain(tab, namespace, args, code) {
  const [action, ...rest] = args;
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [namespace, code, action ?? null, rest, pluginEpoch(namespace)],
    func: runPluginInPage,
  });
  const payload = injection?.result;
  if (!payload?.ok) throw new Error(payload?.error || "Plugin failed with no error message");
  return payload.value;
}

async function pushPluginMessage(tab, payload) {
  if (!tab?.id || isRestricted(tab.url) || isBlankTab(tab.url)) return;
  try {
    await inject(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      source: "browser-session-ctl-plugin",
      ...payload,
    });
  } catch {
    // Tab has no content script yet, or went restricted mid-flight.
  }
}

async function broadcastPlugins(payload) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => pushPluginMessage(tab, payload)));
}

async function invokePlugin(tab, namespace, args, liveCode) {
  await pluginsReady;
  requireNamespace(namespace);
  const code = resolvePluginCode(namespace, liveCode);
  const [action, ...rest] = args;
  try {
    return await invokePluginFromFile(tab, namespace, args, code);
  } catch (err) {
    if (!(err instanceof RuntimePluginFileError)) throw err;
  }
  try {
    return unwrap(
      await sendToPage(tab, {
        action: "plugin",
        namespace,
        code,
        method: action ?? null,
        args: rest,
        epoch: pluginEpoch(namespace),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCompileBlocked(message) || /Unknown plugin namespace/.test(message)) {
      return invokePluginInMain(tab, namespace, args, code);
    }
    throw err;
  }
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
  if (!isRestricted(tab.url)) return tab;

  const all = await chrome.tabs.query({});
  const normal = all.filter((t) => !isRestricted(t.url));
  normal.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const fallback = normal[0];
  if (!fallback) {
    throw new Error(
      `The focused tab (${tab.url}) cannot be automated and no other normal http(s) tab is open.`
    );
  }
  return fallback;
}

async function tabById(tabId) {
  const tab = tabId == null ? await activeTab() : await getTabOrThrow(tabId);
  if (isRestricted(tab.url)) {
    throw new Error(
      `This page cannot be automated (${tab.url}). Switch to a normal http(s) tab.`
    );
  }
  return tab;
}

async function getTabOrThrow(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`No Chrome tab with id ${tabId}. Run \`browser-session-ctl tabs\` to list ids.`);
  }
}

const PAGE_SCRIPT_VERSION = 23;

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

    case "settings.get":
      return await getSettings();

    case "settings.set": {
      if (!params.key) throw new Error("key is required");
      return await setSetting(params.key, Boolean(params.value));
    }

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        restricted: isRestricted(tab.url),
        favIconUrl: tab.favIconUrl,
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

    case "tabs.open": {
      const active = params.active !== false;
      const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const reusable = current && isBlankTab(current.url);

      let tab;
      if (reusable && params.url) {
        tab = await chrome.tabs.update(current.id, { url: params.url, active });
      } else if (reusable) {
        tab = current;
      } else {
        tab = await chrome.tabs.create({ url: params.url || undefined, active });
      }

      if (!params.url) {
        return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url };
      }

      let finalTab;
      try {
        finalTab = await waitForComplete(tab.id);
      } catch {
        finalTab = await chrome.tabs.get(tab.id);
      }

      if (!isRestricted(finalTab.url)) {
        const settings = await getSettings();
        if (settings.annotateNewTabs) {
          await setTabAnnotate(finalTab.id, true);
          try {
            await sendToPage(finalTab, { action: "annotate", enabled: true });
          } catch {
            // Best effort — don't fail the open just because annotate couldn't attach.
            // The tab stays marked; applyAnnotateIfEnabled will paint after the next load.
          }
        }
      }

      return { id: finalTab.id, windowId: finalTab.windowId, title: finalTab.title, url: finalTab.url };
    }

    case "tabs.close": {
      if (params.tabId == null) throw new Error("tabId is required");
      const tab = await getTabOrThrow(params.tabId);
      await chrome.tabs.remove(tab.id);
      return { id: tab.id, closed: true };
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

    case "page.annotate": {
      const tab = await tabById(params.tabId);
      const enabled = params.enabled !== false;
      await setTabAnnotate(tab.id, enabled);
      return unwrap(await sendToPage(tab, { action: "annotate", enabled }));
    }

    case "page.debugSetFavicon": {
      const tab = await tabById(params.tabId);
      return unwrap(
        await sendToPage(tab, { action: "debug-set-favicon", enabled: params.enabled !== false })
      );
    }

    case "page.debugAnnotateHighlight": {
      const tab = await tabById(params.tabId);
      const state = ["action", "active", "idle"].includes(params.state) ? params.state : "active";
      return unwrap(await sendToPage(tab, { action: "debug-annotate-highlight", state }));
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

    case "plugin.list": {
      await pluginsReady;
      return { loaded: [...runtimePlugins.keys()] };
    }

    case "plugin.load": {
      await pluginsReady;
      const namespace = requireNamespace(params.namespace);
      if (typeof params.code !== "string" || !params.code.trim()) {
        throw new Error("code is required");
      }
      await persistPlugin(namespace, params.code);
      return { namespace, loaded: true };
    }

    case "plugin.unload": {
      await pluginsReady;
      const namespace = requireNamespace(params.namespace);
      const existed = runtimePlugins.delete(namespace);
      pluginEpochs.delete(namespace);
      if (existed) {
        await savePlugins();
        await broadcastPlugins({ action: "uninstall", namespace });
      }
      return { namespace, unloaded: existed };
    }

    case "plugin.invoke": {
      const namespace = requireNamespace(params.namespace);
      const tab = await tabById(params.tabId);
      const args = Array.isArray(params.args) ? params.args.map(String) : [];
      const value = await invokePlugin(tab, namespace, args, params.code);
      return { namespace, value };
    }

    case "plugin.inject": {
      await pluginsReady;
      const namespace = requireNamespace(params.namespace);
      if (typeof params.code !== "string" || !params.code.trim()) {
        throw new Error("code is required");
      }
      await persistPlugin(namespace, params.code);
      const tab = await tabById(params.tabId);
      return await injectLoadPlugin(tab, namespace, params.code);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "plugin-query") {
    (async () => {
      await pluginsReady;
      sendResponse(pluginsPayload());
    })().catch(() => sendResponse({ plugins: {} }));
    return true;
  }

  if (message.type === "annotate-query") {
    const tabId = sender.tab?.id;
    (async () => {
      sendResponse({ enabled: tabId != null && (await tabAnnotateEnabled(tabId)) });
    })().catch(() => sendResponse({ enabled: false }));
    return true;
  }

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
  await pluginsReady;
  const port = await getPort();
  await chrome.storage.local.set({ port });
  connect(`ws://127.0.0.1:${port}/extension`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  setTabAnnotate(tabId, false).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  applyAnnotateIfEnabled(tab || { id: tabId, url: info.url });
  pluginsReady
    .then(() => {
      if (!runtimePlugins.size) return;
      return pushPluginMessage(tab || { id: tabId, url: info.url }, {
        action: "install-all",
        ...pluginsPayload(),
      });
    })
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(boot);
boot();
