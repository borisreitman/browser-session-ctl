// Pre-load half of the React integration. Must run in the page's MAIN world
// at document_start, before React evaluates (chrome.scripting.registerContentScripts
// with world: "MAIN", runAt: "document_start" — or CDP
// Page.addScriptToEvaluateOnNewDocument in tests).
//
// React DOM looks for window.__REACT_DEVTOOLS_GLOBAL_HOOK__ when it loads and
// calls hook.inject(renderer). If a hook is already present it also calls
// hook.onCommitFiberRoot(id, root) after every commit. We install a minimal,
// DevTools-compatible stub that records renderers and roots. If the real
// DevTools extension is installed it owns the hook; we then wrap its methods
// instead of replacing it.
(() => {
  if (globalThis.__bscReactHook) return;

  const state = {
    renderers: new Map(), // id -> renderer ({ version, rendererPackageName, ... })
    roots: new Map(), // id -> Set<FiberRoot>
    commits: 0,
    unmounts: 0,
    lastCommitAt: 0,
  };

  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => { try { fn(event); } catch {} });

  let nextId = 1;
  const existing = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = existing || {
    supportsFiber: true,
    renderers: state.renderers,
    inject(renderer) {
      const id = nextId++;
      state.renderers.set(id, renderer);
      return id;
    },
    checkDCE() {},
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    isDisabled: false,
  };
  if (!existing) {
    try {
      Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
        value: hook, configurable: true, writable: true,
      });
    } catch {
      globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    }
  }

  const wrap = (name, after) => {
    const orig = hook[name];
    hook[name] = function (...args) {
      try { after(...args); } catch {}
      return typeof orig === "function" ? orig.apply(this, args) : undefined;
    };
  };

  if (existing) {
    // DevTools owns inject(); call it first so we can mirror the id it assigns.
    const origInject = hook.inject;
    hook.inject = function (renderer) {
      const id = origInject.apply(this, arguments);
      state.renderers.set(id, renderer);
      return id;
    };
  }
  wrap("onCommitFiberRoot", (id, root) => {
    let set = state.roots.get(id);
    if (!set) state.roots.set(id, (set = new Set()));
    set.add(root);
    state.commits += 1;
    state.lastCommitAt = Date.now();
    emit({ type: "commit", id, root });
  });
  wrap("onCommitFiberUnmount", () => { state.unmounts += 1; });

  globalThis.__bscReactHook = {
    state,
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    summary() {
      return {
        renderers: [...state.renderers].map(([id, r]) => ({
          id, version: r.version, package: r.rendererPackageName, bundleType: r.bundleType,
        })),
        roots: [...state.roots].map(([id, set]) => ({ id, count: set.size })),
        commits: state.commits,
        unmounts: state.unmounts,
        ownedByDevTools: Boolean(existing),
      };
    },
  };
})();
