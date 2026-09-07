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
    throw new Error(`No Chrome tab with id ${tabId}. Run \`browser-ctl tabs\` to list ids.`);
  }
}

async function inject(tabId) {
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
  const message = { source: "browser-automate", ...payload };
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await inject(tab.id);
    let lastError;
    for (let i = 0; i < 8; i += 1) {
      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError || new Error("Could not reach the page script");
  }
}

function unwrap(response) {
  if (!response) throw new Error("No response from the page. Reload the tab and try again.");
  if (!response.ok) throw new Error(response.error || "Page action failed");
  return response.result;
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

    case "page.click": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
        ref = found.ref;
      }
      if (!ref) throw new Error("ref or name is required");
      return unwrap(await sendToPage(tab, { action: "click", ref }));
    }

    case "page.type": {
      const tab = await tabById(params.tabId);
      let ref = params.ref;
      if (!ref && params.name) {
        const found = unwrap(await sendToPage(tab, { action: "find", name: params.name }));
        ref = found.ref;
      }
      if (!ref) throw new Error("ref or name is required");
      return unwrap(
        await sendToPage(tab, {
          action: "type",
          ref,
          text: params.text ?? "",
          submit: Boolean(params.submit),
        })
      );
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
