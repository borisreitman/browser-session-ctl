const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const portEl = document.getElementById("port");
const labelEl = document.getElementById("label");
const reconnectEl = document.getElementById("reconnect");

function render(state) {
  const connected = Boolean(state.connected);
  statusEl.textContent = connected ? "Connected to sidecar" : "Sidecar not connected";
  statusEl.className = `status ${connected ? "ok" : "bad"}`;
  hintEl.textContent = connected
    ? "Shell commands can drive this Chrome window."
    : state.lastError || "Start the sidecar, then reconnect.";
  if (state.port) portEl.value = String(state.port);
  if (state.profileLabel && document.activeElement !== labelEl) labelEl.value = state.profileLabel;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "popup-status" });
  render(state || {});
}

reconnectEl.addEventListener("click", async () => {
  hintEl.textContent = "Connecting…";
  await chrome.runtime.sendMessage({
    type: "popup-reconnect",
    port: Number(portEl.value),
    label: labelEl.value,
  });
  setTimeout(refresh, 400);
});

refresh();
