import http from "node:http";
import { WebSocketServer } from "ws";
import { DEFAULT_HOST, port as configuredPort } from "./config.mjs";

const PORT = configuredPort();
const pending = new Map();
const profiles = new Map(); // profile id -> { id, label, socket, connectedAt }

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

const isOpen = (p) => p.socket.readyState === 1;

function describeProfiles() {
  return [...profiles.values()].filter(isOpen).map((p) => ({ id: p.id, label: p.label, connectedAt: p.connectedAt }));
}

// Match by exact id, exact label, then unique label/id prefix.
function resolveProfile(wanted) {
  const open = [...profiles.values()].filter(isOpen);
  const names = () => open.map((p) => p.label).join(", ");
  if (!open.length) {
    throw new Error(
      "Extension not connected. Load the unpacked extension, start this sidecar, then open a normal https tab."
    );
  }
  if (!wanted) {
    if (open.length === 1) return open[0];
    throw new Error(`Several Chrome profiles are connected (${names()}). Pick one with --profile <name>.`);
  }
  const w = String(wanted).toLowerCase();
  const exact = open.filter((p) => p.id === wanted || p.label.toLowerCase() === w);
  const hits = exact.length ? exact : open.filter((p) => p.label.toLowerCase().startsWith(w) || p.id.startsWith(wanted));
  if (hits.length === 1) return hits[0];
  throw new Error(
    hits.length
      ? `Profile "${wanted}" is ambiguous (${hits.map((p) => p.label).join(", ")}).`
      : `No connected profile "${wanted}". Connected: ${names()}.`
  );
}

function sendToExtension(command, wanted, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let profile;
    try {
      profile = resolveProfile(wanted);
    } catch (err) {
      reject(err);
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the extension"));
    }, timeoutMs);
    pending.set(id, {
      profileId: profile.id,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    profile.socket.send(JSON.stringify({ id, ...command }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${DEFAULT_HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      extensionConnected: describeProfiles().length > 0,
      profiles: describeProfiles(),
      port: PORT,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/command") {
    try {
      const body = await readBody(req);
      if (!body.method) {
        json(res, 400, { ok: false, error: "method is required" });
        return;
      }
      const result = await sendToExtension(
        { method: body.method, params: body.params || {} },
        body.profile || url.searchParams.get("profile")
      );
      json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      json(res, 503, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  json(res, 404, { ok: false, error: "Not found" });
});

const wss = new WebSocketServer({ server, path: "/extension" });

wss.on("connection", (socket, req) => {
  const host = req.socket.remoteAddress;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "::ffff:127.0.0.1") {
    socket.close();
    return;
  }

  const q = new URL(req.url, "http://localhost").searchParams;
  const id = q.get("id") || "default";
  const label = q.get("label") || `profile-${id.slice(0, 4)}`;
  const previous = profiles.get(id);
  if (previous) previous.socket.close();
  const profile = { id, label, socket, connectedAt: Date.now() };
  profiles.set(id, profile);
  console.log(`Extension connected: ${label} (${id.slice(0, 8)})`);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const waiter = pending.get(data.id);
    if (!waiter || waiter.profileId !== id) return;
    pending.delete(data.id);
    waiter.resolve(data);
  });

  socket.on("close", () => {
    // A reconnect from the same profile may already have replaced this socket.
    if (profiles.get(id) !== profile) return;
    profiles.delete(id);
    console.log(`Extension disconnected: ${label}`);
    for (const [reqId, waiter] of pending) {
      if (waiter.profileId !== id) continue;
      pending.delete(reqId);
      waiter.reject(new Error("Extension disconnected"));
    }
  });
});

server.listen(PORT, DEFAULT_HOST, () => {
  console.log(`Sidecar listening on http://${DEFAULT_HOST}:${PORT}`);
  console.log("Load the unpacked extension, then run: browser-session-ctl snapshot");
});
