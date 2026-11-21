// Isolated-world half of console capture (see console-hook.js). Runs at document_start
// next to the MAIN-world hook, listens for its "bsc-console" DOM events and forwards each
// entry to the background worker, which keeps a per-tab log that survives navigation.
// Forwarding every entry as it happens (instead of draining a buffer later) is what keeps
// the lines logged just before a click navigates the page away.
(() => {
  if (globalThis.__bscConsoleBridge) return;
  globalThis.__bscConsoleBridge = true;

  let pid = null;
  let lastSeq = 0;

  const send = (entry) => {
    try {
      const p = chrome.runtime.sendMessage({ type: "bsc-console", entry });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // extension reloaded or context invalidated: nothing useful to do
    }
  };

  document.addEventListener(
    "bsc-console",
    (e) => {
      let entry;
      try { entry = JSON.parse(e.detail); } catch { return; }
      if (!entry || typeof entry.seq !== "number") return;
      // a new page load gets a new pid: restart the sequence
      if (entry.pid !== pid) { pid = entry.pid; lastSeq = 0; }
      if (entry.seq <= lastSeq) return; // already forwarded (replay)
      lastSeq = entry.seq;
      send(entry);
    },
    true
  );

  // Marks where each page load starts, so a log that spans a navigation reads clearly. When the
  // bridge is attached to a page that is already loaded (injected on demand, or after an
  // extension reload) it says so instead of claiming a page start.
  const early = document.readyState === "loading";
  send({
    level: "page",
    kind: "page",
    t: Date.now(),
    text: early ? `page start ${location.href}` : `console capture attached to existing page ${location.href}`,
    url: location.href,
    seq: 0,
  });

  // Ask the hook to replay anything it logged before this listener existed.
  try { document.dispatchEvent(new CustomEvent("bsc-console-ready")); } catch {}
})();
