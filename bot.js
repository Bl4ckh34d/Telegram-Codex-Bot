#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const OUT_DIR = path.join(RUNTIME_DIR, "out");
const VOICE_DIR = path.join(RUNTIME_DIR, "voice");
const STATE_PATH = path.join(RUNTIME_DIR, "state.json");
const LOCK_PATH = path.join(RUNTIME_DIR, "bot.lock");
const CHAT_LOG_PATH = path.join(RUNTIME_DIR, "chat.log");
const WHISPER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe.py");
const RESTART_EXIT_CODE = 75;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env) || String(process.env[key] || "").trim() === "") {
      process.env[key] = val;
    }
  }
}

function toBool(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function toInt(value, fallback, min = null, max = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = Math.trunc(n);
  if (min !== null && out < min) out = min;
  if (max !== null && out > max) out = max;
  return out;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseArgString(input) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || ""))) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    if (token) out.push(token);
  }
  return out;
}

function sanitizeCodexExtraArgs(inputArgs) {
  const out = [];
  const dropped = [];
  for (let i = 0; i < inputArgs.length; i += 1) {
    const token = String(inputArgs[i] || "");
    if (!token) continue;

    if (token === "-a" || token === "--approval-policy" || token === "--ask-for-approval") {
      dropped.push(token);
      const next = String(inputArgs[i + 1] || "");
      if (next && !next.startsWith("-")) {
        dropped.push(next);
        i += 1;
      }
      continue;
    }

    if (token.startsWith("--approval-policy=") || token.startsWith("--ask-for-approval=")) {
      dropped.push(token);
      continue;
    }

    out.push(token);
  }
  return { args: out, dropped };
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function resolveMaybeRelativePath(value, baseDir = ROOT) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text, maxLen = 3800) {
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > maxLen) {
    let idx = rest.lastIndexOf("\n", maxLen);
    if (idx < 500) idx = maxLen;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx);
  }
  chunks.push(rest || "(empty)");
  return chunks;
}

function appendTail(existing, chunk, limit = 6000) {
  const next = `${existing}${chunk}`;
  return next.length > limit ? next.slice(-limit) : next;
}

function oneLine(text) {
  return String(text || "")
    .replace(/\r?\n/g, " \\n ")
    .replace(/\s+/g, " ")
    .trim();
}

function previewForLog(text, maxChars) {
  const normalized = oneLine(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function senderLabel(msg) {
  const from = msg?.from || {};
  const first = String(from.first_name || "").trim();
  const last = String(from.last_name || "").trim();
  const username = String(from.username || "").trim();
  const id = String(from.id || "").trim();
  if (username) return `@${username}${id ? `(${id})` : ""}`;
  const full = `${first} ${last}`.trim();
  if (full) return `${full}${id ? `(${id})` : ""}`;
  return id || "unknown";
}

function logChat(direction, chatId, text, meta = {}) {
  const source = String(meta.source || "").trim() || "message";
  const user = String(meta.user || "").trim() || "-";
  const preview = previewForLog(text, CHAT_LOG_MAX_CHARS);

  if (CHAT_LOG_TO_TERMINAL) {
    log(`[chat:${direction}] chat=${chatId} user=${user} source=${source} text="${preview}"`);
  }

  if (CHAT_LOG_TO_FILE) {
    try {
      const line = [
        nowIso(),
        `direction=${direction}`,
        `chat=${chatId}`,
        `user=${JSON.stringify(user)}`,
        `source=${JSON.stringify(source)}`,
        `text=${JSON.stringify(String(text || ""))}`,
      ].join(" ");
      fs.appendFileSync(CHAT_LOG_PATH, `${line}\n`, "utf8");
    } catch {
      // best effort
    }
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function canSignalProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireProcessLock(lockPath) {
  ensureDir(path.dirname(lockPath));

  if (fs.existsSync(lockPath)) {
    const prev = readJson(lockPath, null);
    const prevPid = Number(prev?.pid || 0);
    if (canSignalProcess(prevPid)) {
      throw new Error(`Another instance is already running (pid ${prevPid}).`);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  }

  writeJsonAtomic(lockPath, {
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
}

function releaseProcessLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // best effort
  }
}

function commandExists(binName) {
  const probe = spawnSync(binName, ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!probe.error) return true;
  if (process.platform !== "win32") return false;

  // On Windows, npm CLI shims are often .cmd and need shell=true.
  const shellProbe = spawnSync(binName, ["--version"], {
    shell: true,
    stdio: "ignore",
    windowsHide: true,
  });
  return !shellProbe.error && shellProbe.status === 0;
}

function commandRuns(binName, args = []) {
  const probe = spawnSync(binName, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

function shouldUseWsl(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
}

function useShellForNativeBin(binName) {
  if (process.platform !== "win32") return false;
  const n = String(binName || "").trim().toLowerCase();
  if (n.endsWith(".cmd") || n.endsWith(".bat")) return true;
  // Plain command names on Windows often resolve to .cmd shims.
  if (!n.includes("\\") && !n.includes("/")) return true;
  return false;
}

function toWslPath(winPath) {
  const input = String(winPath || "").trim();
  if (!input) {
    throw new Error("Failed to convert path to WSL: empty input");
  }
  if (input.startsWith("/")) return input;

  const winMatch = input.match(/^([A-Za-z]):[\\/](.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const tail = winMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${tail}`;
  }

  const probe = spawnSync("wsl.exe", ["-e", "bash", "-lc", `wslpath -a ${shQuote(input)}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) {
    const msg = probe.error?.message || probe.stderr || "unknown error";
    throw new Error(`Failed to convert path to WSL: ${msg}`);
  }
  return String(probe.stdout || "").trim();
}

function redactError(text) {
  return String(text || "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${nowIso()}] ${msg}`);
}

loadEnv(ENV_PATH);
ensureDir(RUNTIME_DIR);
ensureDir(OUT_DIR);
ensureDir(VOICE_DIR);

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const PRIMARY_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const EXTRA_ALLOWED = parseList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
const ALLOWED_CHAT_IDS = new Set([PRIMARY_CHAT_ID, ...EXTRA_ALLOWED].filter(Boolean));
const ALLOW_GROUP_CHAT = toBool(process.env.ALLOW_GROUP_CHAT, false);
const POLL_TIMEOUT_SEC = toInt(process.env.TELEGRAM_POLL_TIMEOUT_SEC, 20, 5, 50);
const STARTUP_MESSAGE = toBool(process.env.STARTUP_MESSAGE, true);
const SKIP_STALE_UPDATES = toBool(process.env.SKIP_STALE_UPDATES, true);
const CHAT_LOG_TO_TERMINAL = toBool(process.env.CHAT_LOG_TO_TERMINAL, true);
const CHAT_LOG_TO_FILE = toBool(process.env.CHAT_LOG_TO_FILE, true);
const CHAT_LOG_MAX_CHARS = toInt(process.env.CHAT_LOG_MAX_CHARS, 700, 80, 8000);
const CODEX_SESSIONS_DIR = resolveMaybeRelativePath(
  process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions"),
);
const RESUME_LIST_LIMIT = toInt(process.env.RESUME_LIST_LIMIT, 8, 1, 20);
const RESUME_SCAN_FILE_LIMIT = toInt(process.env.RESUME_SCAN_FILE_LIMIT, 240, 20, 3000);

const CODEX_BIN = String(process.env.CODEX_BIN || "codex").trim();
const CODEX_USE_WSL = String(process.env.CODEX_USE_WSL || "auto").trim().toLowerCase();
const CODEX_WSL_BIN = String(process.env.CODEX_WSL_BIN || "").trim();
const CODEX_WORKDIR = String(process.env.CODEX_WORKDIR || ROOT).trim();
const CODEX_MODEL = String(process.env.CODEX_MODEL || "gpt-5.3-codex").trim();
const CODEX_REASONING_EFFORT = String(process.env.CODEX_REASONING_EFFORT || "xhigh").trim();
const CODEX_PROFILE = String(process.env.CODEX_PROFILE || "").trim();
const CODEX_DANGEROUS_FULL_ACCESS = toBool(process.env.CODEX_DANGEROUS_FULL_ACCESS, true);
const CODEX_SANDBOX_RAW = String(process.env.CODEX_SANDBOX || "workspace-write").trim();
const CODEX_SANDBOX = ["read-only", "workspace-write", "danger-full-access"].includes(
  CODEX_SANDBOX_RAW,
)
  ? CODEX_SANDBOX_RAW
  : "workspace-write";
const CODEX_APPROVAL_RAW = String(process.env.CODEX_APPROVAL_POLICY || "on-request").trim();
const CODEX_APPROVAL_POLICY = ["untrusted", "on-failure", "on-request", "never"].includes(
  CODEX_APPROVAL_RAW,
)
  ? CODEX_APPROVAL_RAW
  : "on-request";
const CODEX_TIMEOUT_MS = toInt(process.env.CODEX_TIMEOUT_MS, 10 * 60 * 1000, 30_000, 60 * 60 * 1000);
const parsedExtraArgs = parseArgString(process.env.CODEX_EXTRA_ARGS || "");
const { args: CODEX_EXTRA_ARGS, dropped: CODEX_DROPPED_EXTRA_ARGS } = sanitizeCodexExtraArgs(parsedExtraArgs);

const WHISPER_ENABLED = toBool(process.env.WHISPER_ENABLED, true);
const WHISPER_VENV_PATH = resolveMaybeRelativePath(
  process.env.WHISPER_VENV_PATH || ".venv",
);
const WHISPER_PYTHON = process.platform === "win32"
  ? path.join(WHISPER_VENV_PATH, "Scripts", "python.exe")
  : path.join(WHISPER_VENV_PATH, "bin", "python");
const WHISPER_MODEL = String(process.env.WHISPER_MODEL || "base").trim();
const WHISPER_LANGUAGE = String(process.env.WHISPER_LANGUAGE || "auto").trim();
const WHISPER_MAX_FILE_MB = toInt(process.env.WHISPER_MAX_FILE_MB, 20, 1, 100);

const MAX_PROMPT_CHARS = toInt(process.env.MAX_PROMPT_CHARS, 4000, 64, 20000);
const MAX_RESPONSE_CHARS = toInt(process.env.MAX_RESPONSE_CHARS, 30000, 512, 200000);
const MAX_QUEUE_SIZE = toInt(process.env.MAX_QUEUE_SIZE, 10, 1, 100);
const PROGRESS_UPDATES_ENABLED = toBool(process.env.PROGRESS_UPDATES_ENABLED, true);
const PROGRESS_FIRST_UPDATE_SEC = toInt(process.env.PROGRESS_FIRST_UPDATE_SEC, 8, 0, 300);
const PROGRESS_UPDATE_INTERVAL_SEC = toInt(process.env.PROGRESS_UPDATE_INTERVAL_SEC, 30, 10, 600);

if (!TOKEN || !PRIMARY_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

if (!fs.existsSync(CODEX_WORKDIR)) {
  console.error(`CODEX_WORKDIR does not exist: ${CODEX_WORKDIR}`);
  process.exit(1);
}

function resolveCodexMode() {
  if (commandExists(CODEX_BIN)) {
    return {
      mode: "native",
      bin: CODEX_BIN,
      shell: useShellForNativeBin(CODEX_BIN),
      workdir: CODEX_WORKDIR,
      codexPath: CODEX_BIN,
    };
  }

  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA || "").trim();
    const userProfile = String(process.env.USERPROFILE || "").trim();
    const candidates = [];
    if (appData) candidates.push(path.join(appData, "npm", "codex.cmd"));
    if (userProfile) candidates.push(path.join(userProfile, "AppData", "Roaming", "npm", "codex.cmd"));
    for (const npmCodex of candidates) {
      if (!npmCodex || !commandExists(npmCodex)) continue;
      return {
        mode: "native",
        bin: npmCodex,
        shell: true,
        workdir: CODEX_WORKDIR,
        codexPath: npmCodex,
      };
    }
  }

  if (shouldUseWsl(CODEX_USE_WSL) && commandExists("wsl.exe")) {
    const wslCodexPath = CODEX_WSL_BIN || "codex";
    const checkScript = `${shQuote(wslCodexPath)} --version >/dev/null 2>&1`;
    if (commandRuns("wsl.exe", ["-e", "bash", "-lic", checkScript])) {
      return {
        mode: "wsl",
        bin: "wsl.exe",
        codexPath: wslCodexPath,
        workdir: toWslPath(CODEX_WORKDIR),
      };
    }
  }

  throw new Error(
    `AIDOLON CLI not found as '${CODEX_BIN}'. Set CODEX_BIN to the full executable path, or set CODEX_USE_WSL=1 (optionally CODEX_WSL_BIN=/path/to/codex).`,
  );
}

let codexMode;
try {
  codexMode = resolveCodexMode();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}

let lockHeld = false;
try {
  acquireProcessLock(LOCK_PATH);
  lockHeld = true;
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}

const state = readJson(STATE_PATH, { lastUpdateId: 0, chatSessions: {} });
let lastUpdateId = Number(state.lastUpdateId || 0);
const chatSessions = state && typeof state.chatSessions === "object" && state.chatSessions
  ? { ...state.chatSessions }
  : {};

const queue = [];
let currentJob = null;
let nextJobId = 1;
let shuttingDown = false;
const pendingCommandsById = new Map();
const pendingCommandIdByChat = new Map();
let pendingSequence = 1;
let codexTopCommandsCache = {
  loadedAt: 0,
  commands: [],
};

function persistState() {
  try {
    writeJsonAtomic(STATE_PATH, { lastUpdateId, chatSessions });
  } catch {
    // best effort
  }
}

function getActiveSessionForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return "";
  const sessionId = String(chatSessions[key] || "").trim();
  return sessionId;
}

function setActiveSessionForChat(chatId, sessionId) {
  const key = String(chatId || "").trim();
  const sid = String(sessionId || "").trim();
  if (!key || !sid) return;
  chatSessions[key] = sid;
  persistState();
}

function clearActiveSessionForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in chatSessions)) return;
  delete chatSessions[key];
  persistState();
}

function normalizePrompt(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_PROMPT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PROMPT_CHARS)}\n\n[truncated by bot]`;
}

function normalizeResponse(text) {
  const cleaned = String(text || "").trim() || "(empty response)";
  if (cleaned.length <= MAX_RESPONSE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated by bot]`;
}

function formatCodexPrompt(userText) {
  return [
    "You are AIDOLON CLI replying via Telegram.",
    "Keep it concise and practical.",
    "If ambiguous, ask one clear follow-up question.",
    "",
    "User message:",
    userText,
  ].join("\n");
}

function isSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function shortSessionId(value) {
  const sid = String(value || "").trim();
  if (!sid) return "";
  return sid.length > 12 ? `${sid.slice(0, 8)}...` : sid;
}

function extractSessionIdFromText(text) {
  const source = String(text || "");
  const patterns = [
    /session id:\s*([0-9a-f-]{36})/i,
    /"thread_id"\s*:\s*"([0-9a-f-]{36})"/i,
    /\bthread_id=([0-9a-f-]{36})\b/i,
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m && isSessionId(m[1])) return m[1];
  }
  return "";
}

function extractResponseContentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string" && item.trim()) {
      parts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    if (typeof item.summary === "string" && item.summary.trim()) {
      parts.push(item.summary.trim());
      continue;
    }
    if (typeof item.content === "string" && item.content.trim()) {
      parts.push(item.content.trim());
    }
  }
  return parts.join("\n").trim();
}

function extractUserMessageSnippet(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  const marker = "User message:";
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    const after = text.slice(idx + marker.length).trim();
    const first = after.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
    if (first) return first;
  }
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  return firstLine;
}

function collectFilesRecursive(rootDir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".jsonl")) continue;
    try {
      const stat = fs.statSync(fullPath);
      out.push({ path: fullPath, mtimeMs: stat.mtimeMs || 0 });
    } catch {
      // best effort
    }
  }
}

function listRecentCodexSessions(limit = RESUME_LIST_LIMIT) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];

  const files = [];
  collectFilesRecursive(CODEX_SESSIONS_DIR, files);
  if (files.length === 0) return [];

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = files.slice(0, RESUME_SCAN_FILE_LIMIT);

  const out = [];
  const seen = new Set();
  for (const entry of candidates) {
    if (out.length >= limit) break;
    let lines = [];
    try {
      lines = fs.readFileSync(entry.path, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }

    let sessionId = "";
    let timestamp = "";
    let cwd = "";
    let snippet = "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const type = String(obj?.type || "");
      const payload = obj?.payload || {};
      if (type === "session_meta") {
        sessionId = String(payload.id || "").trim();
        timestamp = String(payload.timestamp || "").trim();
        cwd = String(payload.cwd || "").trim();
        continue;
      }
      if (snippet) continue;
      if (type === "response_item" && String(payload.role || "").toLowerCase() === "user") {
        const raw = extractResponseContentText(payload.content);
        snippet = extractUserMessageSnippet(raw);
      }
    }

    if (!isSessionId(sessionId) || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({
      id: sessionId,
      timestamp: timestamp || new Date(entry.mtimeMs).toISOString(),
      cwd,
      snippet,
    });
  }

  return out;
}

function buildResumePrefill(sessionId) {
  return `/resume ${sessionId} `;
}

function formatSessionLabel(sessionInfo, index) {
  const ts = new Date(sessionInfo.timestamp);
  const when = Number.isNaN(ts.getTime())
    ? sessionInfo.timestamp
    : ts.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const snippet = previewForLog(sessionInfo.snippet || "(no user prompt)", 42);
  return `${index + 1}. ${when} - ${snippet}`;
}

function makePendingCommandId() {
  const seq = pendingSequence;
  pendingSequence += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

function clearPendingCommandForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const existingId = pendingCommandIdByChat.get(key);
  if (!existingId) return null;
  pendingCommandIdByChat.delete(key);
  const existing = pendingCommandsById.get(existingId) || null;
  pendingCommandsById.delete(existingId);
  return existing;
}

function setPendingCommandForChat(chatId, rawLine, args) {
  const key = String(chatId || "").trim();
  if (!key) return "";
  clearPendingCommandForChat(key);
  const id = makePendingCommandId();
  pendingCommandsById.set(id, {
    id,
    chatId: key,
    rawLine: String(rawLine || "").trim(),
    args: Array.isArray(args) ? [...args] : [],
    createdAt: Date.now(),
  });
  pendingCommandIdByChat.set(key, id);
  return id;
}

function takePendingCommandById(chatId, pendingId) {
  const key = String(chatId || "").trim();
  const id = String(pendingId || "").trim();
  if (!key || !id) return null;
  const cmd = pendingCommandsById.get(id);
  if (!cmd) return null;
  if (String(cmd.chatId) !== key) return null;
  pendingCommandsById.delete(id);
  if (pendingCommandIdByChat.get(key) === id) {
    pendingCommandIdByChat.delete(key);
  }
  return cmd;
}

function takePendingCommandByChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const id = pendingCommandIdByChat.get(key);
  if (!id) return null;
  return takePendingCommandById(key, id);
}

function createPendingCommandSummary(commandLine, pendingId) {
  return [
    "Pending AIDOLON command (confirmation required):",
    `codex ${commandLine}`,
    "",
    "Use /confirm to run or /reject to cancel.",
    `id: ${pendingId}`,
  ].join("\n");
}

function buildPendingCommandMarkup(pendingId) {
  return {
    inline_keyboard: [
      [
        { text: "Run", callback_data: `cmd_run:${pendingId}` },
        { text: "Cancel", callback_data: `cmd_cancel:${pendingId}` },
      ],
    ],
  };
}

function parseCodexCommandsFromHelpText(helpText) {
  const text = String(helpText || "");
  const lines = text.split(/\r?\n/);
  const out = [];
  let inCommands = false;

  for (const line of lines) {
    if (!inCommands) {
      if (/^\s*Commands:\s*$/i.test(line)) {
        inCommands = true;
      }
      continue;
    }
    if (/^\s*(Arguments|Options):\s*$/i.test(line)) break;
    const m = line.match(/^\s{2,}([a-z0-9][a-z0-9-]*)\s{2,}/i);
    if (!m) continue;
    const cmd = m[1].toLowerCase();
    if (!out.includes(cmd)) out.push(cmd);
  }
  return out;
}

function getCodexTopCommands() {
  const now = Date.now();
  if (codexTopCommandsCache.commands.length > 0 && now - codexTopCommandsCache.loadedAt < 5 * 60 * 1000) {
    return [...codexTopCommandsCache.commands];
  }

  let stdout = "";
  let stderr = "";
  try {
    if (codexMode.mode === "wsl") {
      const cmd = `${shQuote(codexMode.codexPath || "codex")} --help`;
      const probe = spawnSync("wsl.exe", ["-e", "bash", "-lic", cmd], {
        encoding: "utf8",
        windowsHide: true,
      });
      stdout = String(probe.stdout || "");
      stderr = String(probe.stderr || "");
    } else {
      const probe = spawnSync(codexMode.bin, ["--help"], {
        encoding: "utf8",
        shell: Boolean(codexMode.shell),
        windowsHide: true,
      });
      stdout = String(probe.stdout || "");
      stderr = String(probe.stderr || "");
    }
  } catch {
    // best effort
  }

  let commands = parseCodexCommandsFromHelpText(`${stdout}\n${stderr}`);
  if (commands.length === 0) {
    commands = ["exec", "review", "resume", "mcp", "cloud", "features", "login", "logout", "debug"];
  }

  codexTopCommandsCache = {
    loadedAt: now,
    commands: commands.slice(0, 20),
  };
  return [...codexTopCommandsCache.commands];
}

function sanitizeRawCodexArgs(rawLine) {
  const raw = String(rawLine || "").trim();
  if (!raw) return [];
  const tokens = parseArgString(raw);
  if (tokens.length === 0) return [];

  // Let users type either "/cmd exec ..." or "/cmd codex exec ..."
  if (tokens[0].toLowerCase() === "codex") {
    tokens.shift();
  }

  for (const tok of tokens) {
    if (/[&|><`]/.test(tok)) {
      throw new Error("Shell operator tokens are not allowed in /cmd. Use plain AIDOLON args only.");
    }
  }
  return tokens;
}

function buildRawCodexSpec(args) {
  const rawArgs = Array.isArray(args) ? [...args] : [];
  if (codexMode.mode === "wsl") {
    const shellCmd = [codexMode.codexPath || "codex", ...rawArgs].map(shQuote).join(" ");
    return {
      bin: "wsl.exe",
      args: ["-e", "bash", "-lic", shellCmd],
      cwd: ROOT,
    };
  }
  return {
    bin: codexMode.bin,
    args: rawArgs,
    shell: Boolean(codexMode.shell),
    cwd: CODEX_WORKDIR,
  };
}

function buildCodexExecSpec(job) {
  const promptText = formatCodexPrompt(job.text);
  const outputFile = String(job?.outputFile || "");
  const outputPath = codexMode.mode === "wsl" ? toWslPath(outputFile) : outputFile;
  const args = ["exec"];
  const resumeSessionId = String(job?.resumeSessionId || "").trim();
  const isResume = Boolean(resumeSessionId);
  if (isResume) {
    args.push("resume", resumeSessionId);
  }

  if (CODEX_DANGEROUS_FULL_ACCESS) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--full-auto");
    if (!isResume) args.push("-s", CODEX_SANDBOX);
  }

  if (!isResume) {
    args.push("--color", "never", "-C", codexMode.workdir, "-o", outputPath);
  }
  if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
  if (CODEX_REASONING_EFFORT) {
    args.push("-c", `model_reasoning_effort=\"${CODEX_REASONING_EFFORT}\"`);
  }
  if (!isResume && CODEX_PROFILE) args.push("-p", CODEX_PROFILE);
  if (CODEX_EXTRA_ARGS.length > 0) args.push(...CODEX_EXTRA_ARGS);
  args.push("-");
  if (codexMode.mode === "wsl") {
    const shellCmd = [codexMode.codexPath || "codex", ...args].map(shQuote).join(" ");
    return {
      bin: "wsl.exe",
      args: ["-e", "bash", "-lic", shellCmd],
      stdinText: promptText,
      cwd: ROOT,
    };
  }
  return {
    bin: codexMode.bin,
    args,
    shell: Boolean(codexMode.shell),
    stdinText: promptText,
    cwd: CODEX_WORKDIR,
  };
}

async function telegramApi(method, { query = "", body = null, timeoutMs = 30_000 } = {}) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}${query ? `?${query}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const desc = data.description || JSON.stringify(data);
      throw new Error(`Telegram ${method} failed: ${res.status} ${desc}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function telegramApiMultipart(method, formData, timeoutMs = 30_000) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const desc = data.description || JSON.stringify(data);
      throw new Error(`Telegram ${method} failed: ${res.status} ${desc}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(chatId, text, options = {}) {
  const silent = options.silent === true;
  const replyMarkup = options.replyMarkup || null;
  const chunks = chunkText(normalizeResponse(text));
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx];
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const body = {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
          disable_notification: silent,
        };
        if (idx === 0 && replyMarkup) {
          body.reply_markup = replyMarkup;
        }
        await telegramApi("sendMessage", {
          body,
        });
        logChat("out", chatId, chunk, { source: "telegram-send" });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(350 * attempt);
      }
    }
  }
}

async function sendPhoto(chatId, filePath, options = {}) {
  const silent = options.silent === true;
  const caption = String(options.caption || "").trim();
  const fileName = path.basename(filePath) || "image.png";
  const imageBytes = fs.readFileSync(filePath);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId || ""));
      form.append("disable_notification", silent ? "true" : "false");
      if (caption) form.append("caption", caption);
      form.append("photo", new Blob([imageBytes], { type: "image/png" }), fileName);
      await telegramApiMultipart("sendPhoto", form, 45_000);
      logChat("out", chatId, caption || "[photo]", { source: "telegram-photo" });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(350 * attempt);
    }
  }
}

async function capturePrimaryScreenshot(filePath) {
  if (process.platform !== "win32") {
    throw new Error("Screenshot capture is only configured for Windows in this bot.");
  }

  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$target = $env:TG_SCREENSHOT_PATH",
    "if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing TG_SCREENSHOT_PATH' }",
    "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
    "try {",
    "  $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    "  $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)",
    "} finally {",
    "  $gfx.Dispose()",
    "  $bmp.Dispose()",
    "}",
  ].join("; ");

  await new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TG_SCREENSHOT_PATH: filePath,
        },
      },
    );

    let stderr = "";
    proc.stderr.on("data", (buf) => {
      stderr = appendTail(stderr, String(buf || ""), 12_000);
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to start PowerShell: ${err.message || err}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell failed with exit ${code}`));
        return;
      }
      resolve();
    });
  });

  if (!fs.existsSync(filePath)) {
    throw new Error("Screenshot file was not created.");
  }
}

async function handleScreenshotCommand(chatId) {
  const screenshotPath = path.join(
    OUT_DIR,
    `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );

  try {
    await capturePrimaryScreenshot(screenshotPath);
    await sendPhoto(chatId, screenshotPath, {
      caption: `Screenshot ${nowIso()}`,
    });
  } finally {
    try {
      if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    } catch {
      // best effort
    }
  }
}

function parseCommand(text) {
  let t = String(text || "").trim();
  if (!t) return null;

  // Buttons using `switch_inline_query_current_chat` prefill input like:
  // "@BotUserName /resume <id>" (inline-mode style). Normalize to "/resume <id>".
  const inlinePrefill = t.match(/^@\S+\s+(\/.*)$/);
  if (inlinePrefill) {
    t = String(inlinePrefill[1] || "").trim();
  }

  if (!t.startsWith("/")) return null;

  const [head, ...rest] = t.split(/\s+/);
  return {
    cmd: head.split("@")[0].toLowerCase(),
    arg: rest.join(" ").trim(),
  };
}

async function sendHelp(chatId) {
  const lines = [
    "AIDOLON is online.",
    "",
    "Send plain text (or a voice note) to prompt AIDOLON.",
    "Commands:",
    "/help - this help",
    "/codex or /commands - show AIDOLON command menu",
    "/cmd <args> - stage a raw AIDOLON CLI command (needs /confirm)",
    "/confirm - run pending /cmd command",
    "/reject - cancel pending /cmd command",
    "/status - worker status",
    "/queue - show pending prompts",
    "/cancel - stop current AIDOLON run",
    "/clear - clear queued prompts",
    "/screenshot - capture and send primary screen",
    "/resume - list recent AIDOLON sessions with prefill buttons",
    "/resume <session_id> [text] - resume a session, optionally with text",
    "/new - clear active resumed session",
    "/compress [hint] - summarize/compress active session context",
    "/restart - restart the bot process",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function sendStatus(chatId) {
  const current = currentJob
    ? `#${currentJob.id} for ${Math.floor((Date.now() - currentJob.startedAt) / 1000)}s`
    : "none";
  const queued = queue.length;
  const activeSession = getActiveSessionForChat(chatId);
  const lines = [
    "Bot status",
    `- busy: ${Boolean(currentJob)}`,
    `- current: ${current}`,
    `- queue: ${queued}/${MAX_QUEUE_SIZE}`,
    `- active_session: ${activeSession ? shortSessionId(activeSession) : "(none)"}`,
    `- exec_mode: ${codexMode.mode}`,
    `- model: ${CODEX_MODEL || "(default)"}`,
    `- reasoning: ${CODEX_REASONING_EFFORT || "(default)"}`,
    `- full_access: ${CODEX_DANGEROUS_FULL_ACCESS}`,
    `- sandbox: ${CODEX_SANDBOX}`,
    `- approval: ${CODEX_APPROVAL_POLICY}`,
    `- whisper: ${WHISPER_ENABLED ? "enabled" : "disabled"}`,
    `- workdir: ${codexMode.workdir}`,
    `- time: ${nowIso()}`,
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function sendQueue(chatId) {
  if (queue.length === 0) {
    await sendMessage(chatId, "Queue is empty.");
    return;
  }
  const lines = ["Queued prompts:"];
  for (const item of queue.slice(0, 10)) {
    const preview = item.text.length > 90 ? `${item.text.slice(0, 90)}...` : item.text;
    lines.push(`- #${item.id}: ${preview}`);
  }
  if (queue.length > 10) {
    lines.push(`- ...and ${queue.length - 10} more`);
  }
  await sendMessage(chatId, lines.join("\n"));
}

async function sendResumePicker(chatId) {
  const sessions = listRecentCodexSessions(RESUME_LIST_LIMIT);
  if (sessions.length === 0) {
    await sendMessage(chatId, `No local AIDOLON sessions found in:\n${CODEX_SESSIONS_DIR}`);
    return;
  }

  const keyboard = [];

  for (let i = 0; i < sessions.length; i += 1) {
    const sessionInfo = sessions[i];
    const label = formatSessionLabel(sessionInfo, i);
    const buttonText = label.length > 64 ? `${label.slice(0, 61)}...` : label;
    keyboard.push([
      {
        text: buttonText,
        switch_inline_query_current_chat: buildResumePrefill(sessionInfo.id),
      },
    ]);
  }

  await sendMessage(chatId, "Select a session:", {
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function sendCodexCommandMenu(chatId) {
  const commands = getCodexTopCommands();
  const lines = [
    "AIDOLON command menu",
    "Tap a command to prefill `/cmd <command> ...` in this chat.",
    "",
    `Detected commands: ${commands.join(", ")}`,
    "",
    "Flow: pick command -> edit args -> send -> /confirm.",
  ];

  const keyboard = [];
  for (let i = 0; i < commands.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, commands.length); j += 1) {
      const cmd = commands[j];
      row.push({
        text: cmd,
        switch_inline_query_current_chat: `/cmd ${cmd} `,
      });
    }
    keyboard.push(row);
  }

  keyboard.push([
    { text: "Resume Sessions", switch_inline_query_current_chat: "/resume " },
    { text: "Compress Session", switch_inline_query_current_chat: "/compress " },
  ]);
  keyboard.push([
    { text: "Run Pending", switch_inline_query_current_chat: "/confirm" },
    { text: "Cancel Pending", switch_inline_query_current_chat: "/reject" },
  ]);

  await sendMessage(chatId, lines.join("\n"), {
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function cancelCurrent(chatId) {
  if (!currentJob || !currentJob.process) {
    await sendMessage(chatId, "No active AIDOLON run to cancel.");
    return;
  }
  currentJob.cancelRequested = true;
  try {
    currentJob.process.kill("SIGTERM");
  } catch {
    // best effort
  }
  await sendMessage(chatId, `Cancellation requested for job #${currentJob.id}.`);
}

async function clearQueue(chatId) {
  const count = queue.length;
  queue.length = 0;
  await sendMessage(chatId, `Cleared ${count} queued prompt(s).`);
}

async function enqueueRawCodexCommand(chatId, args, source = "cmd") {
  const tokens = Array.isArray(args) ? [...args] : [];
  if (tokens.length === 0) {
    await sendMessage(chatId, "No AIDOLON command to run.");
    return;
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return;
  }

  const job = {
    id: nextJobId++,
    chatId,
    source,
    kind: "raw",
    rawArgs: tokens,
    resumeSessionId: "",
    text: "",
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    outputFile: "",
  };

  queue.push(job);
  void processQueue();
}

async function runRawCodexJob(job) {
  let spec;
  try {
    spec = buildRawCodexSpec(job.rawArgs);
  } catch (err) {
    return {
      ok: false,
      text: `Failed to prepare AIDOLON command: ${err.message || err}`,
    };
  }

  return await new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(spec.bin, spec.args, {
        cwd: spec.cwd,
        shell: Boolean(spec.shell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, text: `Failed to start AIDOLON: ${err.message || err}` });
      return;
    }

    job.process = child;
    try {
      child.stdin.end();
    } catch {
      // best effort
    }

    const timeout = setTimeout(() => {
      job.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      setTimeout(() => {
        if (!done) {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
        }
      }, 3000);
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (buf) => {
      job.stdoutTail = appendTail(job.stdoutTail, String(buf || ""), 50000);
    });
    child.stderr.on("data", (buf) => {
      job.stderrTail = appendTail(job.stderrTail, String(buf || ""), 50000);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, text: `AIDOLON process error: ${err.message || err}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const stdout = String(job.stdoutTail || "").trim();
      const stderr = String(job.stderrTail || "").trim();
      const combined = [stdout, stderr].filter(Boolean).join("\n\n");
      const sessionId = extractSessionIdFromText(combined);

      if (job.cancelRequested) {
        finish({ ok: false, sessionId, text: "Command canceled." });
        return;
      }
      if (job.timedOut) {
        finish({
          ok: false,
          sessionId,
          text: `Command timed out after ${Math.round(CODEX_TIMEOUT_MS / 1000)}s.${combined ? `\n\n${combined}` : ""}`,
        });
        return;
      }

      if (typeof code === "number" && code !== 0) {
        finish({
          ok: false,
          sessionId,
          text: `AIDOLON command failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${combined ? `\n\n${combined}` : ""}`,
        });
        return;
      }

      finish({
        ok: true,
        sessionId,
        text: stdout || stderr || "Command completed with no output.",
      });
    });
  });
}

function resolveResumeSessionId(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "--last" || lower === "last") {
    const latest = listRecentCodexSessions(1);
    return String(latest[0]?.id || "").trim();
  }
  return raw;
}

async function handleCommand(chatId, text) {
  const parsed = parseCommand(text);
  if (!parsed) return false;

  switch (parsed.cmd) {
    case "/start":
    case "/help":
      await sendHelp(chatId);
      return true;
    case "/codex":
    case "/commands":
      await sendCodexCommandMenu(chatId);
      return true;
    case "/status":
      await sendStatus(chatId);
      return true;
    case "/queue":
      await sendQueue(chatId);
      return true;
    case "/cancel":
    case "/stop":
      await cancelCurrent(chatId);
      return true;
    case "/clear":
      await clearQueue(chatId);
      return true;
    case "/screenshot":
      try {
        await handleScreenshotCommand(chatId);
      } catch (err) {
        await sendMessage(chatId, `Screenshot failed: ${String(err?.message || err)}`);
      }
      return true;
    case "/cmd": {
      if (!parsed.arg) {
        await sendMessage(chatId, "Usage: /cmd <codex command and args>\nExample: /cmd exec review --uncommitted");
        return true;
      }
      let args;
      try {
        args = sanitizeRawCodexArgs(parsed.arg);
      } catch (err) {
        await sendMessage(chatId, String(err?.message || err));
        return true;
      }
      if (args.length === 0) {
        await sendMessage(chatId, "No command parsed. Example: /cmd exec review --uncommitted");
        return true;
      }
      const rawLine = args.join(" ");
      const pendingId = setPendingCommandForChat(chatId, rawLine, args);
      await sendMessage(chatId, createPendingCommandSummary(rawLine, pendingId), {
        replyMarkup: buildPendingCommandMarkup(pendingId),
      });
      return true;
    }
    case "/confirm":
    case "/run": {
      const pending = takePendingCommandByChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command for this chat.");
        return true;
      }
      await enqueueRawCodexCommand(chatId, pending.args, "cmd-confirm");
      return true;
    }
    case "/reject":
    case "/deny":
    case "/cancelcmd": {
      const pending = clearPendingCommandForChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command to cancel.");
        return true;
      }
      await sendMessage(chatId, `Canceled pending command:\ncodex ${pending.rawLine}`);
      return true;
    }
    case "/new":
      clearActiveSessionForChat(chatId);
      await sendMessage(chatId, "Active resumed session cleared. New messages start fresh sessions.");
      return true;
    case "/resume": {
      if (!parsed.arg) {
        await sendResumePicker(chatId);
        return true;
      }

      const rawArg = String(parsed.arg || "").trim();
      if (["clear", "off", "none", "new"].includes(rawArg.toLowerCase())) {
        clearActiveSessionForChat(chatId);
        await sendMessage(chatId, "Active resumed session cleared.");
        return true;
      }

      const [sessionToken, ...rest] = rawArg.split(/\s+/);
      const sessionId = resolveResumeSessionId(sessionToken);
      if (!sessionId) {
        await sendMessage(chatId, "No session found. Use /resume to list recent sessions.");
        return true;
      }

      setActiveSessionForChat(chatId, sessionId);
      const resumePrompt = rest.join(" ").trim();
      if (!resumePrompt) {
        await sendMessage(
          chatId,
          `Active session set to ${shortSessionId(sessionId)}.\nSend your next message to continue this session.`,
        );
        return true;
      }

      await enqueuePrompt(chatId, resumePrompt, "resume-command", {
        resumeSessionId: sessionId,
      });
      return true;
    }
    case "/compress": {
      const activeSession = getActiveSessionForChat(chatId);
      if (!activeSession) {
        await sendMessage(chatId, "No active resumed session. Use /resume first.");
        return true;
      }
      const hint = String(parsed.arg || "").trim();
      const prompt = [
        "Compress this conversation context for efficient continuation.",
        "Keep important decisions, constraints, and next steps.",
        hint ? `Focus: ${hint}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await enqueuePrompt(chatId, prompt, "compress", {
        resumeSessionId: activeSession,
      });
      return true;
    }
    case "/restart":
      await sendMessage(chatId, "Restart requested. Restarting bot now...");
      setTimeout(() => {
        void shutdown(RESTART_EXIT_CODE);
      }, 200);
      return true;
    default: {
      const activeSession = getActiveSessionForChat(chatId);
      if (activeSession) {
        const rawSlashPrompt = `${parsed.cmd}${parsed.arg ? ` ${parsed.arg}` : ""}`;
        await enqueuePrompt(chatId, rawSlashPrompt, "slash-forward", {
          resumeSessionId: activeSession,
        });
        return true;
      }
      await sendMessage(chatId, `Unknown command: ${parsed.cmd}`);
      return true;
    }
  }
}

async function enqueuePrompt(chatId, inputText, source, options = {}) {
  const text = normalizePrompt(inputText);
  if (!text) {
    await sendMessage(chatId, "Empty prompt ignored.");
    return;
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return;
  }

  const job = {
    id: nextJobId++,
    chatId,
    text,
    source,
    resumeSessionId: String(options.resumeSessionId || "").trim(),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    outputFile: path.join(OUT_DIR, `codex-job-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
  };

  queue.push(job);
  void processQueue();
}

function formatElapsedSeconds(totalSeconds) {
  const sec = Math.max(0, Number(totalSeconds) || 0);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) return `${min}m`;
  return `${min}m ${rem}s`;
}

function truncateLine(text, maxChars = 220) {
  const s = oneLine(text);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isProgressNoiseLine(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  if (s === "--------" || /^-+$/.test(s)) return true;
  if (/^(user|assistant)$/i.test(s)) return true;
  if (/^OpenAI\\s+/i.test(s)) return true;
  if (/^(workdir|model|provider|approval|sandbox|reasoning|reasoning effort|reasoning summaries|session id):/i.test(s)) {
    return true;
  }
  if (/^You are AIDOLON CLI replying via Telegram\\.?$/i.test(s)) return true;
  if (/^Keep it concise and practical\\.?$/i.test(s)) return true;
  if (/^If ambiguous, ask one clear follow-up question\\.?$/i.test(s)) return true;
  if (/^User message:$/i.test(s)) return true;
  return false;
}

function extractProgressLinesFromJob(job, maxLines = 2) {
  const combined = `${String(job?.stderrTail || "")}\\n${String(job?.stdoutTail || "")}`.replace(/\\r/g, "");
  if (!combined.trim()) return [];

  const all = combined
    .split("\\n")
    .map((l) => String(l || "").trim())
    .filter(Boolean);

  const tail = all.slice(-140);
  const filtered = [];
  for (const line of tail) {
    if (isProgressNoiseLine(line)) continue;
    if (filtered.length > 0 && filtered[filtered.length - 1] === line) continue;
    filtered.push(line);
  }
  if (filtered.length === 0) return [];

  const statusRe = /(reconnecting|running|execut|download|install|search|apply|review|tool|command|mcp|error|warning|warn)/i;
  const status = filtered.filter((l) => statusRe.test(l));
  const pickFrom = status.length > 0 ? status : filtered;
  const picked = pickFrom.slice(-Math.max(1, maxLines)).map((l) => truncateLine(l, 260));
  return picked;
}

function startJobProgressUpdates(job) {
  if (!PROGRESS_UPDATES_ENABLED) {
    return () => {};
  }

  let stopped = false;
  let firstTimer = null;
  let intervalTimer = null;
  let lastProgressKey = "";
  let lastAnyUpdateAt = 0;

  const notify = async (isFirst = false) => {
    if (stopped || shuttingDown || currentJob !== job) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
    const progressLines = extractProgressLinesFromJob(job, 2);
    const progressKey = progressLines.join("\\n");

    // Prefer sending meaningful progress lines when available. Otherwise, keep a low-noise heartbeat.
    let text = "";
    if (progressLines.length > 0) {
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        text = `Progress (${formatElapsedSeconds(elapsedSec)}):\\n${progressLines.join("\\n")}`;
      } else if (elapsedSec >= 60 && Date.now() - lastAnyUpdateAt >= Math.max(60_000, PROGRESS_UPDATE_INTERVAL_SEC * 2000)) {
        text = `Still working (${formatElapsedSeconds(elapsedSec)}). Last:\\n${progressLines[progressLines.length - 1]}`;
      } else if (isFirst) {
        // If we have progress output but it doesn't look "new", still show it once.
        text = `Progress (${formatElapsedSeconds(elapsedSec)}):\\n${progressLines.join("\\n")}`;
      } else {
        return;
      }
    } else if (isFirst) {
      text = "Working on it...";
    } else if (elapsedSec >= 60 && Date.now() - lastAnyUpdateAt >= Math.max(60_000, PROGRESS_UPDATE_INTERVAL_SEC * 2000)) {
      text = `Still working (${formatElapsedSeconds(elapsedSec)}).`;
    } else {
      return;
    }

    try {
      await sendMessage(job.chatId, text, { silent: true });
      lastAnyUpdateAt = Date.now();
    } catch (err) {
      log(`sendMessage(progress) failed: ${redactError(err.message || err)}`);
    }
  };

  const startInterval = () => {
    if (stopped || intervalTimer) return;
    intervalTimer = setInterval(() => {
      void notify(false);
    }, PROGRESS_UPDATE_INTERVAL_SEC * 1000);
  };

  if (PROGRESS_FIRST_UPDATE_SEC <= 0) {
    void notify(true);
    startInterval();
  } else {
    firstTimer = setTimeout(() => {
      firstTimer = null;
      void notify(true);
      startInterval();
    }, PROGRESS_FIRST_UPDATE_SEC * 1000);
  }

  return () => {
    stopped = true;
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };
}

async function runCodexJob(job) {
  let spec;
  try {
    spec = buildCodexExecSpec(job);
  } catch (err) {
    return {
      ok: false,
      text: `Failed to prepare AIDOLON execution: ${err.message || err}`,
    };
  }

  return await new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(spec.bin, spec.args, {
        cwd: spec.cwd,
        shell: Boolean(spec.shell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, text: `Failed to start AIDOLON: ${err.message || err}` });
      return;
    }

    job.process = child;
    if (typeof spec.stdinText === "string") {
      try {
        child.stdin.end(spec.stdinText);
      } catch {
        // best effort
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        // best effort
      }
    }

    const timeout = setTimeout(() => {
      job.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      setTimeout(() => {
        if (!done) {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
        }
      }, 3000);
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (buf) => {
      job.stdoutTail = appendTail(job.stdoutTail, String(buf || ""));
    });

    child.stderr.on("data", (buf) => {
      job.stderrTail = appendTail(job.stderrTail, String(buf || ""));
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, text: `AIDOLON process error: ${err.message || err}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      let output = "";
      try {
        if (fs.existsSync(job.outputFile)) {
          output = fs.readFileSync(job.outputFile, "utf8").trim();
        }
      } catch {
        // best effort
      }

      if (!output && job.stdoutTail.trim()) {
        output = job.stdoutTail.trim();
      }
      const sessionId = extractSessionIdFromText(
        `${job.stderrTail || ""}\n${job.stdoutTail || ""}\n${output || ""}`,
      );

      if (job.cancelRequested) {
        finish({ ok: false, text: `Job #${job.id} canceled.`, sessionId });
        return;
      }

      if (job.timedOut) {
        const tail = job.stderrTail.trim() || job.stdoutTail.trim();
        finish({
          ok: false,
          sessionId,
          text: `Job #${job.id} timed out after ${Math.round(CODEX_TIMEOUT_MS / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
        });
        return;
      }

      if (typeof code === "number" && code !== 0) {
        const errText = job.stderrTail.trim() || job.stdoutTail.trim();
        const staleProcessHint = /unexpected argument ['"]?-a['"]? found/i.test(errText)
          ? "\n\nHint: this usually means an older bot process is still running. Stop all old bot windows, then restart with start.cmd."
          : "";
        if (output) {
          finish({
            ok: false,
            sessionId,
            text: `${output}\n\n[AIDOLON exit ${code}${signal ? ` (${signal})` : ""}]${staleProcessHint}`,
          });
        } else {
          finish({
            ok: false,
            sessionId,
            text: `AIDOLON failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${errText ? `\n\n${errText}` : ""}${staleProcessHint}`,
          });
        }
        return;
      }

      finish({ ok: true, sessionId, text: output || "AIDOLON finished with no output." });
    });
  });
}

async function processQueue() {
  if (currentJob || shuttingDown) return;

  while (queue.length > 0 && !shuttingDown) {
    const job = queue.shift();
    currentJob = job;
    job.startedAt = Date.now();
    const stopProgressUpdates = startJobProgressUpdates(job);

    let result;
    try {
      result = job.kind === "raw"
        ? await runRawCodexJob(job)
        : await runCodexJob(job);
    } finally {
      stopProgressUpdates();
    }

    if (result.ok) {
      const resolvedSessionId = String(result.sessionId || job.resumeSessionId || "").trim();
      if (resolvedSessionId) {
        setActiveSessionForChat(job.chatId, resolvedSessionId);
      }
    }

    try {
      await sendMessage(job.chatId, normalizeResponse(result.text));
    } catch (err) {
      log(`sendMessage(result) failed: ${redactError(err.message || err)}`);
    }

    currentJob = null;
  }
}

async function getTelegramFileMeta(fileId) {
  const params = new URLSearchParams({ file_id: String(fileId || "") });
  return await telegramApi("getFile", {
    query: params.toString(),
    timeoutMs: 15_000,
  });
}

async function downloadTelegramFile(filePath, destinationPath) {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`File download failed: HTTP ${res.status}`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destinationPath, data);
  return data.length;
}

async function transcribeAudioWithWhisper(audioPath) {
  if (!WHISPER_ENABLED) {
    throw new Error("Voice transcription disabled");
  }
  if (!fs.existsSync(WHISPER_SCRIPT_PATH)) {
    throw new Error(`Whisper script missing: ${WHISPER_SCRIPT_PATH}`);
  }
  if (!fs.existsSync(WHISPER_PYTHON)) {
    throw new Error(
      `Whisper venv python missing: ${WHISPER_PYTHON}. Run setup-whisper-venv.cmd`,
    );
  }

  const args = [WHISPER_SCRIPT_PATH, "--audio", audioPath, "--model", WHISPER_MODEL];
  if (WHISPER_LANGUAGE && WHISPER_LANGUAGE.toLowerCase() !== "auto") {
    args.push("--language", WHISPER_LANGUAGE);
  }

  return await new Promise((resolve, reject) => {
    const py = spawn(WHISPER_PYTHON, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (buf) => {
      stdout = appendTail(stdout, String(buf || ""), 20000);
    });
    py.stderr.on("data", (buf) => {
      stderr = appendTail(stderr, String(buf || ""), 20000);
    });
    py.on("error", (err) => {
      reject(new Error(`Whisper process error: ${err.message || err}`));
    });
    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Whisper failed with exit ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function handleVoiceMessage(msg) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId) return;
  const user = senderLabel(msg);

  if (!WHISPER_ENABLED) {
    await sendMessage(chatId, "Voice messages are disabled.");
    return;
  }

  const voice = msg.voice || msg.audio || null;
  const fileId = String(voice?.file_id || "");
  const declaredBytes = Number(voice?.file_size || 0);
  const maxBytes = WHISPER_MAX_FILE_MB * 1024 * 1024;

  if (!fileId) {
    await sendMessage(chatId, "Voice message missing file id.");
    return;
  }
  if (declaredBytes > 0 && declaredBytes > maxBytes) {
    await sendMessage(
      chatId,
      `Voice file too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${WHISPER_MAX_FILE_MB}MB.`,
    );
    return;
  }

  const fileMeta = await getTelegramFileMeta(fileId);
  const remotePath = String(fileMeta?.file_path || "");
  if (!remotePath) {
    await sendMessage(chatId, "Could not resolve Telegram voice file path.");
    return;
  }

  const ext = path.extname(remotePath) || ".ogg";
  const localPath = path.join(
    VOICE_DIR,
    `voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );

  let downloadedBytes = 0;
  try {
    downloadedBytes = await downloadTelegramFile(remotePath, localPath);
    if (downloadedBytes > maxBytes) {
      await sendMessage(
        chatId,
        `Downloaded voice file too large (${Math.round(downloadedBytes / (1024 * 1024))}MB).`,
      );
      return;
    }

    const transcript = String(await transcribeAudioWithWhisper(localPath)).trim();
    if (!transcript) {
      await sendMessage(chatId, "No speech detected in voice message.");
      return;
    }

    logChat("in", chatId, transcript, { source: "voice-transcript", user });
    const activeSession = getActiveSessionForChat(chatId);
    await enqueuePrompt(chatId, transcript, "voice", {
      resumeSessionId: activeSession || "",
    });
  } catch (err) {
    await sendMessage(chatId, `Voice transcription failed: ${err.message || err}`);
  } finally {
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch {
      // best effort
    }
  }
}

function isAllowedMessage(msg) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId || !ALLOWED_CHAT_IDS.has(chatId)) return false;
  if (!ALLOW_GROUP_CHAT && String(msg?.chat?.type || "") !== "private") return false;
  return true;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  const id = String(callbackQueryId || "").trim();
  if (!id) return;
  try {
    await telegramApi("answerCallbackQuery", {
      body: {
        callback_query_id: id,
        text: String(text || ""),
        show_alert: false,
      },
    });
  } catch {
    // best effort
  }
}

async function handleCallbackQuery(cb) {
  const id = String(cb?.id || "").trim();
  const data = String(cb?.data || "").trim();
  const chatId = String(cb?.message?.chat?.id || "");
  const chatType = String(cb?.message?.chat?.type || "");

  if (!id || !data || !chatId) return;
  const pseudoMsg = { chat: { id: chatId, type: chatType } };
  if (!isAllowedMessage(pseudoMsg)) {
    await answerCallbackQuery(id, "Not allowed");
    return;
  }

  if (data.startsWith("cmd_run:")) {
    const pendingId = data.slice("cmd_run:".length).trim();
    const pending = takePendingCommandById(chatId, pendingId);
    if (!pending) {
      await answerCallbackQuery(id, "Command expired");
      await sendMessage(chatId, "Pending command no longer exists.");
      return;
    }
    await answerCallbackQuery(id, "Running");
    await enqueueRawCodexCommand(chatId, pending.args, "cmd-button-run");
    return;
  }

  if (data.startsWith("cmd_cancel:")) {
    const pendingId = data.slice("cmd_cancel:".length).trim();
    const pending = takePendingCommandById(chatId, pendingId);
    await answerCallbackQuery(id, pending ? "Canceled" : "Already gone");
    if (pending) {
      await sendMessage(chatId, `Canceled pending command:\ncodex ${pending.rawLine}`);
    }
  }
}

async function handleIncomingMessage(msg) {
  const chatId = String(msg?.chat?.id || "");
  const user = senderLabel(msg);
  if (!isAllowedMessage(msg)) {
    log(`[chat:drop] unauthorized chat=${chatId || "unknown"} user=${user}`);
    return;
  }

  if (msg.voice || msg.audio) {
    logChat("in", chatId, "[voice-message]", { source: "voice", user });
    await handleVoiceMessage(msg);
    return;
  }

  const text = String(msg.text || "").trim();
  if (!text) {
    logChat("in", chatId, "[non-text-message]", { source: "non-text", user });
    return;
  }

  logChat("in", chatId, text, { source: text.startsWith("/") ? "command" : "plain", user });

  const handled = await handleCommand(chatId, text);
  if (handled) return;

  const activeSession = getActiveSessionForChat(chatId);
  await enqueuePrompt(chatId, text, activeSession ? "plain-resume" : "plain", {
    resumeSessionId: activeSession || "",
  });
}

async function pollUpdates(timeoutSec) {
  const params = new URLSearchParams({
    offset: String(lastUpdateId + 1),
    timeout: String(Math.max(0, timeoutSec)),
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  return await telegramApi("getUpdates", {
    query: params.toString(),
    timeoutMs: Math.max(15_000, (timeoutSec + 10) * 1000),
  });
}

async function skipStaleUpdates() {
  if (!SKIP_STALE_UPDATES) return;
  const stale = await pollUpdates(0);
  if (!Array.isArray(stale) || stale.length === 0) return;

  for (const upd of stale) {
    const id = Number(upd.update_id || 0);
    if (id > lastUpdateId) lastUpdateId = id;
  }
  persistState();
  log(`Skipped ${stale.length} stale update(s) on startup.`);
}

async function pollLoop() {
  for (;;) {
    if (shuttingDown) return;
    try {
      const updates = await pollUpdates(POLL_TIMEOUT_SEC);
      for (const upd of updates || []) {
        const id = Number(upd.update_id || 0);
        if (id > lastUpdateId) lastUpdateId = id;
        persistState();

        const msg = upd.message || null;
        if (msg) {
          await handleIncomingMessage(msg);
          continue;
        }
        const cb = upd.callback_query || null;
        if (cb) {
          await handleCallbackQuery(cb);
        }
      }
    } catch (err) {
      const message = redactError(err.message || String(err));
      if (/\b409\b/.test(message)) {
        log("Telegram getUpdates conflict (another poller is active). Retrying in 5s...");
        await sleep(5000);
      } else {
        log(`poll error: ${message}`);
        await sleep(2500);
      }
    }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (currentJob?.process) {
    try {
      currentJob.cancelRequested = true;
      currentJob.process.kill("SIGTERM");
    } catch {
      // best effort
    }
  }

  persistState();
  if (lockHeld) {
    releaseProcessLock(LOCK_PATH);
    lockHeld = false;
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));

process.on("uncaughtException", (err) => {
  console.error(`[fatal] ${redactError(err?.stack || err?.message || String(err))}`);
  void shutdown(1);
});

process.on("unhandledRejection", (err) => {
  console.error(`[fatal] ${redactError(err?.stack || err?.message || String(err))}`);
  void shutdown(1);
});

(async () => {
  try {
    const me = await telegramApi("getMe");
    log(`Connected as @${me.username || me.id}`);
    log(
      `AIDOLON execution mode: ${codexMode.mode} (${codexMode.mode === "wsl" ? `wsl.exe -e bash -lic <${codexMode.codexPath}>` : `${codexMode.bin}${codexMode.shell ? " via shell" : ""}`})`,
    );
    if (CODEX_DROPPED_EXTRA_ARGS.length > 0) {
      log(`Ignored unsupported AIDOLON extra args: ${CODEX_DROPPED_EXTRA_ARGS.join(" ")}`);
    }
    if (WHISPER_ENABLED) {
      if (!fs.existsSync(WHISPER_PYTHON)) {
        log(`Whisper venv missing at ${WHISPER_PYTHON} (run setup-whisper-venv.cmd)`);
      } else if (!fs.existsSync(WHISPER_SCRIPT_PATH)) {
        log(`Whisper script missing at ${WHISPER_SCRIPT_PATH}`);
      } else {
        log(`Whisper enabled (model=${WHISPER_MODEL}, language=${WHISPER_LANGUAGE || "auto"})`);
      }
    }
    log(
      `Progress updates: enabled=${PROGRESS_UPDATES_ENABLED} first=${PROGRESS_FIRST_UPDATE_SEC}s interval=${PROGRESS_UPDATE_INTERVAL_SEC}s`,
    );
    log(
      `Chat logging: terminal=${CHAT_LOG_TO_TERMINAL} file=${CHAT_LOG_TO_FILE} max_chars=${CHAT_LOG_MAX_CHARS} file_path=${CHAT_LOG_PATH}`,
    );

    await skipStaleUpdates();

    if (STARTUP_MESSAGE) {
      await sendMessage(PRIMARY_CHAT_ID, "AIDOLON online. Use /help.");
    }

    await pollLoop();
  } catch (err) {
    console.error(`[fatal] ${redactError(err.message || err)}`);
    await shutdown(1);
  }
})();
