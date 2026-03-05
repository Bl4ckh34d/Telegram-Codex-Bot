const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.UI_DEMO_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.UI_DEMO_PORT || "4317", 10);
const STATIC_ROOT = path.join(__dirname, "ui_demo");
const RUNTIME_ROOT = path.join(__dirname, "..", "runtime", "ui-demo");
const EVENT_LOG_PATH = path.join(RUNTIME_ROOT, "events.log");
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_BY_EXT = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function safeRelativePath(inputPathname) {
  const clean = inputPathname.replace(/^\/+/, "");
  const normalized = path.normalize(clean);
  if (normalized.startsWith("..")) {
    return null;
  }
  if (normalized === "" || normalized === "." || normalized === path.sep) {
    return "index.html";
  }
  return normalized;
}

async function ensureRuntimeDir() {
  await fs.promises.mkdir(RUNTIME_ROOT, { recursive: true });
}

async function appendEvent(eventRow) {
  await ensureRuntimeDir();
  await fs.promises.appendFile(EVENT_LOG_PATH, `${JSON.stringify(eventRow)}\n`, "utf8");
}

async function readRecentEvents(limit) {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));
  try {
    const raw = await fs.promises.readFile(EVENT_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-boundedLimit);
    const rows = [];
    for (const line of recent) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines instead of failing readback.
      }
    }
    return rows;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", (err) => reject(err));
  });
}

function buildEvent(input) {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  const source = typeof input.source === "string" ? input.source.trim() : "demo-ui";
  const state = input && typeof input.state === "object" && input.state !== null ? input.state : {};
  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    ts: new Date().toISOString(),
    action: action || "unspecified",
    detail: detail || "",
    source,
    state,
  };
}

function serveStatic(req, res, urlObj) {
  const relativePath = safeRelativePath(urlObj.pathname);
  if (!relativePath) {
    sendText(res, 400, "Invalid path.");
    return;
  }
  const filePath = path.join(STATIC_ROOT, relativePath);
  if (!filePath.startsWith(STATIC_ROOT)) {
    sendText(res, 400, "Invalid path.");
    return;
  }
  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      sendText(res, 404, "Not found.");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    stream.pipe(res);
    stream.on("error", () => {
      if (!res.headersSent) {
        sendText(res, 500, "Failed to read file.");
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(req, res) {
  const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const urlObj = new URL(req.url || "/", origin);
  const route = `${req.method || "GET"} ${urlObj.pathname}`;

  if (route === "GET /api/health") {
    sendJson(res, 200, { ok: true, host: HOST, port: PORT });
    return;
  }

  if (route === "GET /api/events") {
    const limitRaw = Number.parseInt(urlObj.searchParams.get("limit") || "100", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
    const rows = await readRecentEvents(limit);
    sendJson(res, 200, { ok: true, count: rows.length, events: rows });
    return;
  }

  if (route === "POST /api/event") {
    const body = await parseJsonBody(req);
    const row = buildEvent(body);
    await appendEvent(row);
    sendJson(res, 200, { ok: true, event: row });
    return;
  }

  if ((req.method || "GET") === "GET") {
    serveStatic(req, res, urlObj);
    return;
  }

  sendText(res, 405, "Method not allowed.");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const message = err && err.message ? err.message : "Unexpected server error.";
    sendJson(res, 500, { ok: false, error: message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[ui-demo] listening on http://${HOST}:${PORT}`);
  console.log(`[ui-demo] event log: ${EVENT_LOG_PATH}`);
});
