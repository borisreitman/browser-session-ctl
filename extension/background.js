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

// chrome.storage.local is per Chrome profile, so a random id stored there
// tells the sidecar which profile this extension instance belongs to. The
// label is what you type after --profile; it defaults to a short id.
async function getProfile() {
  let { profileId, profileLabel } = await chrome.storage.local.get({ profileId: "", profileLabel: "" });
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  return { id: profileId, label: profileLabel || `profile-${profileId.slice(0, 4)}` };
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

// Runs window.__bscReact[fn](...args) in the page's MAIN world, where React's
// fiber expandos are visible (the isolated content-script world cannot see
// them). react-hook.js is already there from document_start; react-probe.js is
// injected on demand and is idempotent.
async function probeCall(tab, file, global, label, fn, args) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    files: [file],
  });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [global, label, fn, args],
    func: async (globalName, what, name, callArgs) => {
      try {
        const api = globalThis[globalName];
        if (typeof api?.[name] !== "function") {
          throw new Error(`Unknown ${what} function "${name}". Try: ${Object.keys(api || {}).join(", ")}`);
        }
        const value = await api[name](...callArgs);
        return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  const payload = injection?.result;
  if (!payload?.ok) throw new Error(payload?.error || `${label} call failed`);
  return payload.value;
}

const reactCall = (tab, fn, args) => probeCall(tab, "react-probe.js", "__bscReact", "react", fn, args);

// Same idea for Angular: angular-probe.js is injected on demand, idempotent.
const angularCall = (tab, fn, args) => probeCall(tab, "angular-probe.js", "__bscAngular", "angular", fn, args);

// Which engine drives click/type/press on this tab: React's own handlers when
// the page is React (auto), or plain DOM events. params.engine can force one.
async function useReact(tab, params) {
  if (params.engine === "dom") return false;
  if (params.engine === "react") return true;
  try {
    return Boolean(await reactCall(tab, "isReact", []));
  } catch {
    return false;
  }
}

const refSelector = (ref) => `[data-ba-ref="${String(ref).replace(/"/g, "")}"]`;

// Tries a React-variant action. Returns the result tagged engine:"react", or
// null when the caller should fall back to DOM events. A disabled control is a
// real answer, not a reason to fall back.
async function tryReact(tab, fn, args) {
  try {
    return { ...(await reactCall(tab, fn, args)), engine: "react" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ is disabled| is read-only/.test(message)) throw err;
    return { fallback: true, reactError: message };
  }
}

const asDom = (result, extra) => ({ ...(result && typeof result === "object" ? result : { result }), engine: "dom", ...extra });

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

const PAGE_SCRIPT_VERSION = 27;

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

// page.type dispatches synthetic DOM events (dispatchEvent), same as a
// plugin calling that from the page itself. Most sites treat that exactly
// like real typing. Some don't: a field can be wired to only react to
// trusted, OS-generated input (event.isTrusted, or logic that simply never
// fires without a real keydown/keyup pair), and a synthetic value-set gets
// silently reverted on the next render. page.typeTrusted is for that case:
// it drives the same tab through the Chrome DevTools Protocol, so Chrome
// itself generates the key events — indistinguishable from a person typing.
// It attaches chrome.debugger to the tab for the duration of the call (shows
// Chrome's "is being debugged" bar) and detaches immediately after.
const SPECIAL_KEYS = {
  Backspace: { keyCode: 8, code: "Backspace" },
  End: { keyCode: 35, code: "End" },
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
};

function charKeyDef(ch) {
  if (/[a-z]/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/[A-Z]/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
  const named = {
    " ": ["Space", 32],
    "-": ["Minus", 189],
    "_": ["Minus", 189],
    ".": ["Period", 190],
    ",": ["Comma", 188],
    "(": ["Digit9", 57],
    ")": ["Digit0", 48],
  };
  const [code, keyCode] = named[ch] || ["Unidentified", ch.charCodeAt(0) || 0];
  return { code, keyCode };
}

async function cdpKeyEvent(tabId, type, opts) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type, ...opts });
}

async function cdpTypeChar(tabId, ch) {
  const { code, keyCode } = charKeyDef(ch);
  const base = { key: ch, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdpKeyEvent(tabId, "rawKeyDown", base);
  await cdpKeyEvent(tabId, "char", { ...base, text: ch, unmodifiedText: ch });
  await cdpKeyEvent(tabId, "keyUp", base);
}

async function cdpPressSpecial(tabId, key) {
  const def = SPECIAL_KEYS[key];
  if (!def) throw new Error(`Unsupported trusted-type key "${key}"`);
  const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  await cdpKeyEvent(tabId, "rawKeyDown", base);
  if (def.text) await cdpKeyEvent(tabId, "char", { ...base, text: def.text, unmodifiedText: def.text });
  await cdpKeyEvent(tabId, "keyUp", base);
}

async function typeTrusted(tab, ref, text, { clear, submit }) {
  const before = unwrap(await sendToPage(tab, { action: "focusOnly", ref }));
  const debuggee = { tabId: tab.id };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    if (clear && before.value) {
      await cdpPressSpecial(tab.id, "End");
      for (let i = 0; i < String(before.value).length; i += 1) {
        await cdpPressSpecial(tab.id, "Backspace");
      }
    }
    for (const ch of String(text)) {
      await cdpTypeChar(tab.id, ch);
    }
    if (submit) await cdpPressSpecial(tab.id, "Enter");
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Already detached (e.g. the tab closed mid-call).
      }
    }
  }
  const after = unwrap(await sendToPage(tab, { action: "fieldValue", ref }));
  return { ref, value: after.value };
}

// page.scroll changes scroll positions from the page (window.scrollBy). Some apps ignore
// that: they load more content from a real wheel/touch gesture, or an IntersectionObserver
// that only fires for user-driven scrolling. page.scrollTrusted sends mouseWheel events
// through the Chrome DevTools Protocol at a point (the centre of a ref/selector/the
// viewport), so Chrome generates them and the page cannot tell them from a person.
// Like typeTrusted it attaches chrome.debugger for the call and detaches right after.
const WHEEL_MAX_EVENTS = 2000;

async function scrollTrusted(tab, params) {
  const target = { ref: params.ref, selector: params.selector };
  if (!target.ref && params.name) {
    target.ref = unwrap(await sendToPage(tab, { action: "find", name: params.name })).ref;
  }
  const point = unwrap(await sendToPage(tab, { action: "scrollPoint", ...target }));
  const x = params.x ?? point.x;
  const y = params.y ?? point.y;

  const dir = String(params.direction || "down").toLowerCase();
  if (!["up", "down", "left", "right"].includes(dir)) throw new Error(`direction must be up, down, left or right (got "${dir}")`);
  const amount = Math.max(1, Number(params.amount ?? 600));
  const step = Math.max(1, Number(params.step ?? 120)); // one wheel notch
  const delay = Math.max(0, Number(params.delay ?? 12));
  const sign = dir === "up" || dir === "left" ? -1 : 1;
  const horizontal = dir === "left" || dir === "right";
  const events = Math.min(WHEEL_MAX_EVENTS, Math.ceil(amount / step));

  const debuggee = { tabId: tab.id };
  let attached = false;
  let sent = 0;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let i = 0; i < events; i += 1) {
      const d = sign * Math.min(step, amount - i * step);
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: horizontal ? d : 0,
        deltaY: horizontal ? 0 : d,
      });
      sent += 1;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    // Let the page react (smooth scrolling, lazy loads) before reading back.
    await new Promise((resolve) => setTimeout(resolve, params.settle ?? 150));
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Already detached (e.g. the tab closed mid-call).
      }
    }
  }
  const after = unwrap(await sendToPage(tab, { action: "scrollPoint", ...target }));
  const key = horizontal ? "scrollLeft" : "scrollTop";
  return {
    x,
    y,
    direction: dir,
    wheelEvents: sent,
    scroller: point.scroller,
    before: { scrollTop: point.scrollTop, scrollLeft: point.scrollLeft, scrollHeight: point.scrollHeight },
    after: { scrollTop: after.scrollTop, scrollLeft: after.scrollLeft, scrollHeight: after.scrollHeight },
    moved: after[key] - point[key],
    grew: after.scrollHeight - point.scrollHeight,
  };
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
      const react = await useReact(tab, params);
      let ref = params.ref;
      let note;
      if (react && !ref && params.name) {
        const r = await tryReact(tab, "click", [params.name]);
        if (!r.fallback) return r;
        note = { reactError: r.reactError };
      }
      if (!ref && params.name) {
        try {
          const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
          ref = found.ref;
        } catch {
          return asDom(await clickByVisibleText(tab, params.name), note);
        }
      }
      if (!ref) throw new Error("ref or name is required");
      if (react) {
        const r = await tryReact(tab, "click", [refSelector(ref)]);
        if (!r.fallback) return { ref, ...r };
        note = { reactError: r.reactError };
      }
      try {
        return asDom(unwrap(await sendToPage(tab, { action: "click", ref })), note);
      } catch (err) {
        if (params.name) return asDom(await clickByVisibleText(tab, params.name), note);
        throw err;
      }
    }

    case "page.type": {
      const tab = await tabById(params.tabId);
      const react = await useReact(tab, params);
      const text = params.text ?? "";
      const submit = Boolean(params.submit);
      let ref = params.ref;
      let note;
      const viaReact = async (selector) => {
        const r = await tryReact(tab, "fill", [selector, text]);
        if (r.fallback) { note = { reactError: r.reactError }; return null; }
        if (submit) {
          const k = await tryReact(tab, "press", [selector, "Enter"]);
          if (k.fallback) { note = { reactError: k.reactError }; return null; }
          r.submitted = k.called;
        }
        return { ref, value: r.now, ...r };
      };
      if (react && !ref && params.name) {
        const done = await viaReact(params.name);
        if (done) return done;
      }
      if (!ref && params.name) {
        try {
          const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
          ref = found.ref;
        } catch {
          return asDom(await typeByVisibleName(tab, params.name, text, submit), note);
        }
      }
      if (!ref) throw new Error("ref or name is required");
      if (react) {
        const done = await viaReact(refSelector(ref));
        if (done) return done;
      }
      try {
        return asDom(unwrap(await sendToPage(tab, { action: "type", ref, text, submit })), note);
      } catch (err) {
        if (params.name) return asDom(await typeByVisibleName(tab, params.name, text, submit), note);
        throw err;
      }
    }

    // Same shape as page.type, but the keystrokes are dispatched by Chrome
    // itself over the debugger protocol instead of as page-script
    // dispatchEvent calls — see typeTrusted() for why that's sometimes the
    // only thing a page will actually respond to.
    case "page.typeTrusted": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
        ref = found.ref;
      }
      if (!ref) throw new Error("ref or name is required");
      return typeTrusted(tab, ref, params.text ?? "", {
        clear: params.clear !== false,
        submit: Boolean(params.submit),
      });
    }

    case "page.scrollTrusted": {
      const tab = await tabById(params.tabId);
      return scrollTrusted(tab, params);
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
      let note;
      if (await useReact(tab, params)) {
        const r = await tryReact(tab, "press", [":focus", params.key]);
        if (!r.fallback) return r;
        note = { reactError: r.reactError };
      }
      return asDom(unwrap(await sendToPage(tab, { action: "press", key: params.key })), note);
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

    // Images on the page. Listing happens in the page (it knows which <img>s
    // are loaded); with params.download the bytes are fetched here in the
    // service worker, where <all_urls> host permission lets the request skip
    // the page's CORS rules and carry the site's cookies — so the original
    // file comes back, not a re-encoded canvas. If that fetch fails, fall
    // back to drawing a crossOrigin="anonymous" copy on a canvas in the page.
    case "page.images": {
      const tab = await tabById(params.tabId);
      // params.urls: download exactly these URLs (no page listing).
      const items = Array.isArray(params.urls)
        ? params.urls.map((url, i) => ({ index: i + 1, url, width: null, height: null, alt: "" }))
        : unwrap(
            await sendToPage(tab, {
              action: "images",
              selector: params.selector || "img",
              minSize: Number(params.minSize) || 0,
              scroll: Boolean(params.scroll),
            })
          );
      const only = Array.isArray(params.index) ? params.index : null;
      const chosen = only ? items.filter((it) => only.includes(it.index)) : items;
      if (!params.download) return chosen;
      const fetchAsDataUrl = async (url) => {
        if (url.startsWith("data:")) return url;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
      };
      for (const it of chosen) {
        try {
          // Prefer the full-size file when the page showed a resized copy;
          // if that can't be fetched, take what the page displayed.
          let got = null;
          if (it.originalUrl) {
            try {
              got = await fetchAsDataUrl(it.originalUrl);
              it.source = "original";
            } catch {
              got = null;
            }
          }
          if (!got) {
            got = await fetchAsDataUrl(it.url);
            it.source = "displayed";
          }
          it.dataUrl = got;
        } catch (fetchErr) {
          try {
            it.dataUrl = unwrap(await sendToPage(tab, { action: "imageCanvas", url: it.url }));
          } catch (canvasErr) {
            it.error = `fetch: ${fetchErr.message || fetchErr}; canvas: ${canvasErr.message || canvasErr}`;
          }
        }
      }
      return chosen;
    }

    case "page.screenshot": {
      let tab = await tabById(params.tabId);
      if (!tab.active) {
        tab = await chrome.tabs.update(tab.id, { active: true });
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, url: tab.url, title: tab.title };
    }

    case "react.call": {
      const tab = await tabById(params.tabId);
      const value = await reactCall(tab, String(params.fn || "detect"), Array.isArray(params.args) ? params.args : []);
      sendToPage(tab, { action: "touch" }).catch(() => {});
      return value;
    }

    case "angular.call": {
      const tab = await tabById(params.tabId);
      const value = await angularCall(tab, String(params.fn || "detect"), Array.isArray(params.args) ? params.args : []);
      sendToPage(tab, { action: "touch" }).catch(() => {});
      return value;
    }

    case "page.status": {
      const tab = params.tabId == null ? await activeTab() : await getTabOrThrow(params.tabId);
      const base = { tabId: tab.id, url: tab.url, title: tab.title, loading: tab.status === "loading" };
      if (isRestricted(tab.url) || isBlankTab(tab.url)) {
        return { ...base, automatable: false, engine: null, note: "restricted or blank page" };
      }
      try {
        const info = await reactCall(tab, "pageInfo", []);
        return { ...base, automatable: true, engine: info.react.isReact ? "react" : "dom", ...info };
      } catch (err) {
        return { ...base, automatable: true, engine: "dom", error: err instanceof Error ? err.message : String(err) };
      }
    }

    case "ext.reload":
      // Dev loop: pick up edits to manifest/background/content without
      // clicking the reload arrow on chrome://extensions.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };

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

const PLUGIN_COMMANDS = new Set([
  "page.snapshot", "page.text", "page.options", "page.click", "page.type", "page.press",
  "page.scroll", "page.scrollTrusted", "page.status", "page.annotate", "react.call", "angular.call", "page.images",
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  // Plugins (isolated-world code) reach the core commands through this. The
  // tab is always the sender's, and only page-level commands are allowed.
  if (message.type === "bsc-command") {
    const tabId = sender.tab?.id;
    (async () => {
      if (!PLUGIN_COMMANDS.has(message.method)) throw new Error(`Plugins may not call ${message.method}`);
      if (tabId == null) throw new Error("No tab for this plugin call");
      const result = await handleCommand({ method: message.method, params: { ...(message.params || {}), tabId } });
      sendResponse({ ok: true, result: result === undefined ? null : result });
    })().catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

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
    chrome.storage.local.get(null).then(async (state) => {
      sendResponse({
        ...state,
        profileLabel: (await getProfile()).label,
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      });
    });
    return true;
  }

  if (message.type === "popup-reconnect") {
    (async () => {
      if (message.port) await chrome.storage.local.set({ port: Number(message.port) });
      if (typeof message.label === "string") {
        await chrome.storage.local.set({ profileLabel: message.label.trim().slice(0, 40) });
      }
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
  const profile = await getProfile();
  const query = new URLSearchParams({ id: profile.id, label: profile.label });
  connect(`ws://127.0.0.1:${port}/extension?${query}`);
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
