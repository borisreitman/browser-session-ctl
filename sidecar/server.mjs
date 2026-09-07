import http from "node:http";
import { WebSocketServer } from "ws";
import { DEFAULT_HOST, port as configuredPort } from "./config.mjs";

const PORT = configuredPort();
const pending = new Map();
let extensionSocket = null;

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

function sendToExtension(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(
        new Error(
          "Extension not connected. Load the unpacked extension, start this sidecar, then open a normal https tab."
        )
      );
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the extension"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    extensionSocket.send(JSON.stringify({ id, ...command }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${DEFAULT_HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      extensionConnected: Boolean(extensionSocket && extensionSocket.readyState === 1),
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
      const result = await sendToExtension({
        method: body.method,
        params: body.params || {},
      });
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
  if (host !== "127.0.0.1" && host !== "::1" && host !== ":ffff:127.0.0.1") {
    socket.close();
    return;
  }

  if (extensionSocket) extensionSocket.close();
  extensionSocket = socket;
  console.log("Extension connected");

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    waiter.resolve(data);
  });

  socket.on("close", () => {
    if (extensionSocket === socket) extensionSocket = null;
    console.log("Extension disconnected");
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error("Extension disconnected"));
    }
  });
});

server.listen(PORT, DEFAULT_HOST, () => {
  console.log(`Sidecar listening on http://${DEFAULT_HOST}:${PORT}`);
  console.log("Load the unpacked extension, then run: browser-session-ctl snapshot");
});
