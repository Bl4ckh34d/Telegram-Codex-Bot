#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const OUT_DIR = path.join(RUNTIME_DIR, "out");
const VOICE_DIR = path.join(RUNTIME_DIR, "voice");
const IMAGE_DIR = path.join(RUNTIME_DIR, "images");
const TTS_DIR = path.join(RUNTIME_DIR, "tts");
const STATE_PATH = path.join(RUNTIME_DIR, "state.json");
const LOCK_PATH = path.join(RUNTIME_DIR, "bot.lock");
const CHAT_LOG_PATH = path.join(RUNTIME_DIR, "chat.log");
const RESTART_REASON_PATH = path.join(RUNTIME_DIR, "restart.reason");
const WHISPER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe.py");
const WHISPER_SERVER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe_server.py");
const AIDOLON_TTS_SCRIPT_PATH = path.join(ROOT, "aidolon_tts_synthesize.py");
const AIDOLON_TTS_SERVER_SCRIPT_PATH = path.join(ROOT, "aidolon_tts_server.py");
const RESTART_EXIT_CODE = 75;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureDirSafe(dirPath, { label = "", required = false } = {}) {
  try {
    ensureDir(dirPath);
    return true;
  } catch (err) {
    const suffix = label ? ` (${label})` : "";
    console.error(`[startup] Failed to prepare directory${suffix}: ${dirPath}: ${err?.message || err}`);
    if (required) {
      console.error("[startup] This directory is required. Exiting.");
    }
    return false;
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return true;
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch (err) {
    console.error(`[startup] Failed to read .env at ${filePath}: ${err?.message || err}`);
    return false;
  }
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
  return true;
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

function toTimeoutMs(value, fallback, min = null, max = null) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const out = Math.trunc(n);
  // 0 or negative disables the timeout entirely.
  if (out <= 0) return 0;
  let clamped = out;
  if (min !== null && clamped < min) clamped = min;
  if (max !== null && clamped > max) clamped = max;
  return clamped;
}

function combineAbortSignals(signals) {
  const list = Array.isArray(signals) ? signals.filter(Boolean) : [];
  if (list.length === 0) return { signal: undefined, cleanup: () => {} };
  if (globalThis.AbortSignal && typeof globalThis.AbortSignal.any === "function") {
    return { signal: globalThis.AbortSignal.any(list), cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners = [];
  for (const sig of list) {
    try {
      if (sig.aborted) {
        controller.abort();
        break;
      }
      const onAbort = () => controller.abort();
      sig.addEventListener("abort", onAbort, { once: true });
      listeners.push([sig, onAbort]);
    } catch {
      // best effort
    }
  }

  const cleanup = () => {
    for (const [sig, onAbort] of listeners) {
      try {
        sig.removeEventListener("abort", onAbort);
      } catch {
        // best effort
      }
    }
  };

  return { signal: controller.signal, cleanup };
}

function minPositive(values) {
  const list = Array.isArray(values) ? values : [];
  let best = 0;
  for (const raw of list) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!best || n < best) best = n;
  }
  return best;
}

function hardTimeoutRemainingMs(job, hardTimeoutMs) {
  const ms = Number(hardTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const startedAt = Number(job?.startedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ms;
  const remaining = startedAt + ms - Date.now();
  // If the deadline already passed, return a tiny positive value so callers can trip timeouts immediately.
  if (remaining <= 0) return 1;
  return remaining;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const TELEGRAM_CHAT_ACTIONS = new Set([
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
  "record_video_note",
  "upload_video_note",
]);

function normalizeTelegramChatAction(value, fallback = "typing") {
  const normalizedFallback = TELEGRAM_CHAT_ACTIONS.has(String(fallback || "").trim().toLowerCase())
    ? String(fallback || "").trim().toLowerCase()
    : "typing";
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return normalizedFallback;
  return TELEGRAM_CHAT_ACTIONS.has(raw) ? raw : normalizedFallback;
}

function normalizeSubredditName(value) {
  const raw = String(value || "").trim().replace(/^r\//i, "");
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  // Reddit community names are limited to letters, numbers, and underscores.
  if (!/^[a-z0-9_]{2,21}$/.test(normalized)) return "";
  return normalized;
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

function computeExponentialBackoffMs(attempt, baseMs = 300, maxMs = 4000, jitterRatio = 0.2) {
  const n = Math.max(1, Number(attempt) || 1) - 1;
  const base = Number(baseMs);
  const cap = Number(maxMs);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 300;
  const safeCap = Number.isFinite(cap) && cap > 0 ? cap : 4000;
  const raw = Math.min(safeCap, safeBase * (2 ** n));
  const jitter = 1 + ((Math.random() * 2 - 1) * Math.max(0, Number(jitterRatio) || 0));
  return Math.max(50, Math.round(raw * jitter));
}

function chunkText(text, maxLen = 3800) {
  const chunks = [];
  let rest = String(text || "");
  const limitRaw = Number(maxLen);
  // Non-positive disables chunking (may exceed Telegram's per-message limit).
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : Infinity;
  if (!Number.isFinite(limit)) {
    chunks.push(rest || "(empty)");
    return chunks;
  }
  while (rest.length > limit) {
    let idx = rest.lastIndexOf("\n", limit);
    if (idx < 500) idx = limit;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx);
  }
  chunks.push(rest || "(empty)");
  return chunks;
}

function appendTail(existing, chunk, limit = 6000) {
  const next = `${existing}${chunk}`;
  const lim = Number(limit);
  // Non-positive disables tail truncation (may use unbounded memory).
  if (!Number.isFinite(lim) || lim <= 0) return next;
  return next.length > lim ? next.slice(-lim) : next;
}

function oneLine(text) {
  return String(text || "")
    .replace(/\r?\n/g, " \\n ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTtsBackendFatalError(chunk, carry = "") {
  const combined = `${String(carry || "")}${String(chunk || "")}`;
  const window = combined.length > 8000 ? combined.slice(-8000) : combined;
  const nextCarry = window.slice(-1200);
  if (!window.trim()) return { message: "", carry: nextCarry };

  if (/TypeError:\s*TextEncodeInput must be Union\[TextInputSequence,\s*Tuple\[InputSequence,\s*InputSequence\]\]/i.test(window)) {
    return {
      message: "lmdeploy tokenizer rejected prompt input type (TextEncodeInput TypeError).",
      carry: nextCarry,
    };
  }

  const hasLmdeployCallbackTrace =
    /exception calling callback for <future/i.test(window) &&
    /lmdeploy[\\/]+pipeline\.py/i.test(window);
  const hasTokenizerBatchTrace =
    /tokenization_utils_fast\.py/i.test(window) &&
    /_batch_encode_plus/i.test(window);
  if (hasLmdeployCallbackTrace && hasTokenizerBatchTrace) {
    return {
      message: "lmdeploy callback failed during tokenizer batch encoding.",
      carry: nextCarry,
    };
  }

  return { message: "", carry: nextCarry };
}

function previewForLog(text, maxChars) {
  const normalized = oneLine(text);
  const lim = Number(maxChars);
  // Non-positive disables truncation.
  if (!Number.isFinite(lim) || lim <= 0) return normalized;
  if (normalized.length <= lim) return normalized;
  return `${normalized.slice(0, lim)}...`;
}

const NATURAL_NEWS_WORD_TO_DAYS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  few: 3,
});

const NATURAL_COMMAND_ALIASES = Object.freeze({
  help: "/help",
  start: "/start",
  codex: "/codex",
  commands: "/commands",
  command: "/commands",
  c: "/commands",
  status: "/status",
  workers: "/workers",
  worker: "/workers",
  use: "/use",
  spawn: "/spawn",
  retire: "/retire",
  queue: "/queue",
  news: "/news",
  cancel: "/cancel",
  stop: "/stop",
  clear: "/clear",
  screenshot: "/screenshot",
  ss: "/screenshot",
  sendfile: "/sendfile",
  cmd: "/cmd",
  confirm: "/confirm",
  run: "/run",
  reject: "/reject",
  deny: "/deny",
  cancelcmd: "/cancelcmd",
  new: "/new",
  resume: "/resume",
  compress: "/compress",
  ask: "/ask",
  see: "/see",
  imgclear: "/imgclear",
  model: "/model",
  tts: "/tts",
  wipe: "/wipe",
  restart: "/restart",
});

const NATURAL_NO_ARG_COMMANDS = new Set([
  "/help",
  "/start",
  "/codex",
  "/commands",
  "/status",
  "/workers",
  "/queue",
  "/cancel",
  "/stop",
  "/clear",
  "/screenshot",
  "/confirm",
  "/run",
  "/reject",
  "/deny",
  "/cancelcmd",
  "/new",
  "/imgclear",
  "/model",
  "/wipe",
]);

const NATURAL_PREFIX_REQUIRED_COMMANDS = new Set([
  "/use",
  "/spawn",
  "/retire",
  "/sendfile",
  "/cmd",
  "/resume",
  "/ask",
  "/see",
  "/tts",
]);

const NATURAL_DIRECT_COMMANDS = new Set([
  "/help",
  "/start",
  "/codex",
  "/commands",
  "/status",
  "/workers",
  "/queue",
  "/news",
  "/cancel",
  "/stop",
  "/clear",
  "/screenshot",
  "/confirm",
  "/run",
  "/reject",
  "/deny",
  "/cancelcmd",
  "/new",
  "/compress",
  "/imgclear",
  "/model",
  "/wipe",
  "/restart",
]);

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
    const dir = String(direction || "").trim().toLowerCase();
    const isIn = dir === "in";
    const isOut = dir === "out";

    const who = isIn && user && user !== "-" ? ` ${user}` : "";
    const src = isIn && source && !["plain", "message"].includes(source) ? ` (${source})` : "";
    const label = isIn ? "YOU" : isOut ? "BOT" : dir.toUpperCase() || "CHAT";
    const line = `${label}${who}${src}: ${preview}`;

    const noColor = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
    const useColors = !noColor && TERMINAL_COLORS && CHAT_LOG_USE_COLORS && Boolean(process.stdout.isTTY);
    const color = isIn ? "\x1b[36m" : isOut ? "\x1b[32m" : "\x1b[33m"; // cyan / green / yellow
    const reset = "\x1b[0m";
    log(useColors ? `${color}${line}${reset}` : line);
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
    started_at: nowIso(),
  });
}

function releaseProcessLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // best effort
  }
}

const commandExistsCache = new Map(); // key: lowercase bin token on win32, raw token otherwise -> boolean

function commandExists(binName) {
  const token = String(binName || "").trim();
  if (!token) return false;

  const cacheKey = process.platform === "win32" ? token.toLowerCase() : token;
  if (commandExistsCache.has(cacheKey)) {
    return commandExistsCache.get(cacheKey) === true;
  }

  const probe = spawnSync(token, ["--version"], {
    stdio: "ignore",
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
    windowsHide: true,
  });
  if (!probe.error) {
    commandExistsCache.set(cacheKey, true);
    return true;
  }
  if (process.platform !== "win32") {
    commandExistsCache.set(cacheKey, false);
    return false;
  }

  // On Windows, npm CLI shims are often .cmd and need shell=true.
  const shellProbe = spawnSync(token, ["--version"], {
    shell: true,
    stdio: "ignore",
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
    windowsHide: true,
  });
  const ok = !shellProbe.error && shellProbe.status === 0;
  commandExistsCache.set(cacheKey, ok);
  return ok;
}

function commandRuns(binName, args = []) {
  const probe = spawnSync(binName, args, {
    stdio: "ignore",
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
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

function terminateChildTree(child, { forceAfterMs = 2000 } = {}) {
  const pid = Number(child?.pid || 0);
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    // On Windows, killing a shell-wrapped process often leaves the actual worker alive.
    // taskkill /T terminates the whole process tree.
    try {
      spawn("taskkill.exe", ["/PID", String(pid), "/T"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // best effort
    }

    setTimeout(() => {
      try {
        spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        // best effort
      }
    }, Math.max(0, Number(forceAfterMs) || 0));
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }

  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // best effort
    }
  }, Math.max(0, Number(forceAfterMs) || 0));
}

function nowIso(input = null) {
  const d = input instanceof Date ? input : (input === null ? new Date() : new Date(input));
  if (!Number.isFinite(d.getTime())) return nowIso(Date.now());

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  const second = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");

  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(offsetAbs / 60)).padStart(2, "0");
  const offsetMinute = String(offsetAbs % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${sign}${offsetHour}:${offsetMinute}`;
}

function log(msg) {
  console.log(`[${nowIso()}] ${msg}`);
}

loadEnv(ENV_PATH);
const requiredStartupDirsReady = [
  ensureDirSafe(RUNTIME_DIR, { label: "runtime", required: true }),
  ensureDirSafe(OUT_DIR, { label: "output", required: true }),
  ensureDirSafe(VOICE_DIR, { label: "voice", required: true }),
  ensureDirSafe(IMAGE_DIR, { label: "images", required: true }),
  ensureDirSafe(TTS_DIR, { label: "tts", required: true }),
].every(Boolean);
if (!requiredStartupDirsReady) {
  process.exit(1);
}

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const PRIMARY_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const EXTRA_ALLOWED = parseList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
const ALLOWED_CHAT_IDS = new Set([PRIMARY_CHAT_ID, ...EXTRA_ALLOWED].filter(Boolean));
const ALLOW_GROUP_CHAT = toBool(process.env.ALLOW_GROUP_CHAT, false);
const POLL_TIMEOUT_SEC = toInt(process.env.TELEGRAM_POLL_TIMEOUT_SEC, 20);
// Telegram API request timeouts: 0 disables abort-based timeouts entirely.
const TELEGRAM_API_TIMEOUT_MS = toTimeoutMs(process.env.TELEGRAM_API_TIMEOUT_MS, 60_000);
const TELEGRAM_UPLOAD_TIMEOUT_MS = toTimeoutMs(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS, 120_000);
// Per-message chunk size for Telegram sendMessage(). 0 disables chunking (not recommended).
const TELEGRAM_MESSAGE_MAX_CHARS = toInt(process.env.TELEGRAM_MESSAGE_MAX_CHARS, 3800);
const STARTUP_MESSAGE = toBool(process.env.STARTUP_MESSAGE, true);
const SKIP_STALE_UPDATES = toBool(process.env.SKIP_STALE_UPDATES, true);
const TELEGRAM_SET_COMMANDS = toBool(process.env.TELEGRAM_SET_COMMANDS, true);
const TELEGRAM_COMMAND_SCOPES = parseList(process.env.TELEGRAM_COMMAND_SCOPE || "default")
  .map((s) => String(s || "").trim().toLowerCase())
  .filter(Boolean);
const TELEGRAM_FORMAT_BOLD = toBool(process.env.TELEGRAM_FORMAT_BOLD, true);
const TELEGRAM_CHAT_ACTION_ENABLED = toBool(process.env.TELEGRAM_CHAT_ACTION_ENABLED, true);
const TELEGRAM_CHAT_ACTION_INTERVAL_SEC = toInt(process.env.TELEGRAM_CHAT_ACTION_INTERVAL_SEC, 4, 1, 60);
const TELEGRAM_CHAT_ACTION_DEFAULT = normalizeTelegramChatAction(process.env.TELEGRAM_CHAT_ACTION_DEFAULT || "typing");
const TELEGRAM_CHAT_ACTION_VOICE = normalizeTelegramChatAction(
  process.env.TELEGRAM_CHAT_ACTION_VOICE || "record_voice",
  TELEGRAM_CHAT_ACTION_DEFAULT,
);
const CHAT_LOG_TO_TERMINAL = toBool(process.env.CHAT_LOG_TO_TERMINAL, true);
const CHAT_LOG_TO_FILE = toBool(process.env.CHAT_LOG_TO_FILE, true);
const TERMINAL_COLORS = toBool(process.env.TERMINAL_COLORS, true);
const CHAT_LOG_USE_COLORS = toBool(process.env.CHAT_LOG_USE_COLORS, true);
const CHAT_LOG_MAX_CHARS = toInt(process.env.CHAT_LOG_MAX_CHARS, 700);
const LAUNCH_REASON = String(process.env.AIDOLON_LAUNCH_REASON || "startup").trim() || "startup";
const LAUNCH_PREV_EXIT_CODE = String(process.env.AIDOLON_LAUNCH_PREV_EXIT_CODE || "").trim();
const CODEX_SESSIONS_DIR = resolveMaybeRelativePath(
  process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions"),
);
// 0 or negative disables the relevant cap.
const RESUME_LIST_LIMIT = toInt(process.env.RESUME_LIST_LIMIT, 8);
const RESUME_SCAN_FILE_LIMIT = toInt(process.env.RESUME_SCAN_FILE_LIMIT, 240);

const CODEX_BIN = String(process.env.CODEX_BIN || "codex").trim();
const CODEX_USE_WSL = String(process.env.CODEX_USE_WSL || "auto").trim().toLowerCase();
const CODEX_WSL_BIN = String(process.env.CODEX_WSL_BIN || "").trim();
const CODEX_WORKDIR = String(process.env.CODEX_WORKDIR || ROOT).trim();
const CODEX_MODEL = String(process.env.CODEX_MODEL || "gpt-5.3-codex").trim();
const CODEX_MODEL_CHOICES = parseList(process.env.CODEX_MODEL_CHOICES || "");
const CODEX_REASONING_EFFORT = String(process.env.CODEX_REASONING_EFFORT || "xhigh").trim();
const CODEX_REASONING_EFFORT_CHOICES = parseList(process.env.CODEX_REASONING_EFFORT_CHOICES || "");
const CODEX_STREAM_OUTPUT_TO_TERMINAL = toBool(process.env.CODEX_STREAM_OUTPUT_TO_TERMINAL, true);
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
const MAX_TIMEOUT_MS = 2_147_483_647; // Node timers clamp near this anyway (~24.8 days)
// Used for spawnSync()-based probing (ffmpeg filters, command --version).
// 0 disables probing timeouts (not recommended; a hung subprocess can freeze the bot).
const SUBPROCESS_PROBE_TIMEOUT_MS = toTimeoutMs(process.env.SUBPROCESS_PROBE_TIMEOUT_MS, 5000, 0, MAX_TIMEOUT_MS);
// 0 disables the hard wall-clock timeout.
const CODEX_TIMEOUT_MS = toTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0, null, MAX_TIMEOUT_MS);
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
// 0 disables the size cap (Telegram still enforces its own limits).
const WHISPER_MAX_FILE_MB = toInt(process.env.WHISPER_MAX_FILE_MB, 20);
const WHISPER_KEEPALIVE = toBool(process.env.WHISPER_KEEPALIVE, true);
const WHISPER_KEEPALIVE_STARTUP_TIMEOUT_MS = toTimeoutMs(
  process.env.WHISPER_KEEPALIVE_STARTUP_TIMEOUT_MS,
  120_000,
  0,
  MAX_TIMEOUT_MS,
);
const WHISPER_PREWARM_ON_STARTUP = toBool(process.env.WHISPER_PREWARM_ON_STARTUP, true);
const WHISPER_KEEPALIVE_AUTO_RESTART = toBool(process.env.WHISPER_KEEPALIVE_AUTO_RESTART, true);
const WHISPER_STREAM_OUTPUT_TO_TERMINAL = toBool(
  process.env.WHISPER_STREAM_OUTPUT_TO_TERMINAL,
  true,
);

const VISION_ENABLED = toBool(process.env.VISION_ENABLED, false);
// 0 disables the size cap (Telegram still enforces its own limits).
const VISION_MAX_FILE_MB = toInt(process.env.VISION_MAX_FILE_MB, 12);
const VISION_AUTO_FOLLOWUP_SEC = toInt(process.env.VISION_AUTO_FOLLOWUP_SEC, 900);

const TTS_ENABLED = toBool(process.env.TTS_ENABLED, false);
const TTS_STREAM_OUTPUT_TO_TERMINAL = toBool(process.env.TTS_STREAM_OUTPUT_TO_TERMINAL, true);
// Max characters per synthesized chunk. This does not cap total TTS input length.
// Set to 0 to disable chunk-size capping (not recommended; may be slow/unstable for very long inputs).
const TTS_MAX_TEXT_CHARS = toInt(process.env.TTS_MAX_TEXT_CHARS, 1200);
// Voice-note chunking for auto voice replies (SPOKEN -> multiple Telegram voice messages when long).
// Set any of these to 0 to disable that specific chunking constraint.
const TTS_VOICE_MAX_CHARS = toInt(process.env.TTS_VOICE_MAX_CHARS, 450);
const TTS_VOICE_MAX_SENTENCES = toInt(process.env.TTS_VOICE_MAX_SENTENCES, 3);
// 0 = unlimited chunks (no hard cap).
const TTS_VOICE_MAX_CHUNKS = toInt(process.env.TTS_VOICE_MAX_CHUNKS, 0);
// 0 disables the hard wall-clock timeout.
const TTS_TIMEOUT_MS = toTimeoutMs(process.env.TTS_TIMEOUT_MS, 0, null, MAX_TIMEOUT_MS);
// Safety net timeouts for later TTS stages. These apply even if TTS_TIMEOUT_MS=0.
// 0 disables the relevant timeout (not recommended).
const TTS_ENCODE_TIMEOUT_MS = toTimeoutMs(process.env.TTS_ENCODE_TIMEOUT_MS, 120_000, 0, MAX_TIMEOUT_MS);
const TTS_UPLOAD_TIMEOUT_MS = toTimeoutMs(
  process.env.TTS_UPLOAD_TIMEOUT_MS,
  TELEGRAM_UPLOAD_TIMEOUT_MS > 0 ? TELEGRAM_UPLOAD_TIMEOUT_MS : 120_000,
  0,
  MAX_TIMEOUT_MS,
);
// Global safety net so a stuck TTS job can't wedge the queue forever. 0 disables (not recommended).
const TTS_HARD_TIMEOUT_MS = toTimeoutMs(process.env.TTS_HARD_TIMEOUT_MS, 300_000, 0, MAX_TIMEOUT_MS);
// Extra attempts (in addition to the initial attempt) when a TTS stage times out.
// This applies to synthesis and encoding stages.
// Synthesis failures may also be retried (best-effort) to handle flaky backends. 0 disables retries.
const TTS_TIMEOUT_RETRIES = toInt(process.env.TTS_TIMEOUT_RETRIES, 2, 0, 10);
// Upload retries are separate to avoid duplicate sends on timeout/abort (default keeps retries off).
const TTS_UPLOAD_RETRIES = toInt(process.env.TTS_UPLOAD_RETRIES, 0, 0, 10);
// Use chunk-streamed batch flow (send each chunk as it is done) instead of all-at-once batch synthesis.
const TTS_BATCH_PIPELINED = toBool(process.env.TTS_BATCH_PIPELINED, true);
// When pipelined batch mode is enabled, use it only up to this many chunks.
// 0 = always use pipelined mode; larger values switch long replies to one-shot batch synthesis.
const TTS_BATCH_PIPELINED_MAX_CHUNKS = toInt(process.env.TTS_BATCH_PIPELINED_MAX_CHUNKS, 2, 0, 1000);
const TTS_RETRY_BASE_DELAY_MS = toInt(process.env.TTS_RETRY_BASE_DELAY_MS, 300, 50, 30_000);
const TTS_RETRY_MAX_DELAY_MS = toInt(process.env.TTS_RETRY_MAX_DELAY_MS, 4000, 100, 120_000);
const KEEPALIVE_RESTART_BASE_DELAY_MS = toInt(process.env.KEEPALIVE_RESTART_BASE_DELAY_MS, 1500, 200, 120_000);
const KEEPALIVE_RESTART_MAX_DELAY_MS = toInt(process.env.KEEPALIVE_RESTART_MAX_DELAY_MS, 30_000, 1000, 300_000);
const TTS_VENV_PATH = resolveMaybeRelativePath(process.env.TTS_VENV_PATH || path.join(ROOT, ".tts-venv"));
const TTS_MODEL = String(process.env.TTS_MODEL || "").trim();
const TTS_REFERENCE_AUDIO = resolveMaybeRelativePath(process.env.TTS_REFERENCE_AUDIO || "");
const TTS_SAMPLE_RATE = toInt(process.env.TTS_SAMPLE_RATE, 48000);
const TTS_PYTHON = String(process.env.TTS_PYTHON || "").trim();
const TTS_KEEPALIVE = toBool(process.env.TTS_KEEPALIVE, true);
const TTS_KEEPALIVE_STARTUP_TIMEOUT_MS = toTimeoutMs(
  process.env.TTS_KEEPALIVE_STARTUP_TIMEOUT_MS,
  180_000,
  0,
  MAX_TIMEOUT_MS,
);
const TTS_PREWARM_ON_STARTUP = toBool(process.env.TTS_PREWARM_ON_STARTUP, true);
const TTS_KEEPALIVE_AUTO_RESTART = toBool(process.env.TTS_KEEPALIVE_AUTO_RESTART, true);
const TTS_FFMPEG_BIN = String(process.env.TTS_FFMPEG_BIN || "ffmpeg").trim();
const TTS_OPUS_BITRATE_KBPS = toInt(process.env.TTS_OPUS_BITRATE_KBPS, 48);
const TTS_SEND_TEXT = toBool(process.env.TTS_SEND_TEXT, false);
const TTS_REPLY_TO_VOICE = toBool(process.env.TTS_REPLY_TO_VOICE, false);
// Optional post-processing effects for the synthesized WAV before encoding to Opus/OGG.
// This is intentionally ffmpeg-only (no extra deps), and is best-effort: presets approximate Audacity effects.
const TTS_POSTPROCESS_ENABLED = toBool(process.env.TTS_POSTPROCESS_ENABLED, false);
const TTS_POSTPROCESS_PRESET = String(process.env.TTS_POSTPROCESS_PRESET || "").trim().toLowerCase();
// Raw ffmpeg audio filtergraph string passed to `-af` (overrides preset when set).
const TTS_POSTPROCESS_FFMPEG_AF = String(process.env.TTS_POSTPROCESS_FFMPEG_AF || "").trim();
const TTS_POSTPROCESS_DEBUG = toBool(process.env.TTS_POSTPROCESS_DEBUG, false);

let ATTACH_ENABLED = toBool(process.env.ATTACH_ENABLED, true);
// Security: only allow attaching files from within this folder.
// Use relative paths in ATTACH directives and /sendfile.
const ATTACH_ROOT = resolveMaybeRelativePath(process.env.ATTACH_ROOT || OUT_DIR);
// Telegram bot upload limits vary by account/API; keep a sane default and make it configurable.
// 0 disables the size cap.
const ATTACH_MAX_FILE_MB = toInt(process.env.ATTACH_MAX_FILE_MB, 45);
const ATTACH_UPLOAD_TIMEOUT_MS = toTimeoutMs(
  process.env.ATTACH_UPLOAD_TIMEOUT_MS,
  0,
  null,
  MAX_TIMEOUT_MS,
);
// 0 disables timeout (not recommended); protects poll loop from hanging on stuck capture.
const SCREENSHOT_CAPTURE_TIMEOUT_MS = toTimeoutMs(
  process.env.SCREENSHOT_CAPTURE_TIMEOUT_MS,
  20_000,
  0,
  MAX_TIMEOUT_MS,
);
const SCREENSHOT_UPLOAD_TIMEOUT_MS = toTimeoutMs(
  process.env.SCREENSHOT_UPLOAD_TIMEOUT_MS,
  TELEGRAM_UPLOAD_TIMEOUT_MS > 0 ? TELEGRAM_UPLOAD_TIMEOUT_MS : 120_000,
  0,
  MAX_TIMEOUT_MS,
);

if (ATTACH_ENABLED && !ensureDirSafe(ATTACH_ROOT, { label: "attachments", required: false })) {
  ATTACH_ENABLED = false;
  console.error(`[startup] Attachments disabled because ATTACH_ROOT is unavailable: ${ATTACH_ROOT}`);
}

const CODEX_PROMPT_FILE = resolveMaybeRelativePath(
  process.env.CODEX_PROMPT_FILE || path.join(ROOT, "codex_prompt.txt"),
);
const CODEX_VOICE_PROMPT_FILE = resolveMaybeRelativePath(
  process.env.CODEX_VOICE_PROMPT_FILE || path.join(ROOT, "codex_prompt_voice.txt"),
);

// 0 disables bot-side prompt truncation.
const MAX_PROMPT_CHARS = toInt(process.env.MAX_PROMPT_CHARS, 0);
// MAX_RESPONSE_CHARS=0 disables bot-side truncation (Telegram still limits each message).
const MAX_RESPONSE_CHARS = toInt(process.env.MAX_RESPONSE_CHARS, 0);
// 0 disables the queue cap.
const MAX_QUEUE_SIZE = toInt(process.env.MAX_QUEUE_SIZE, 0);
const PROGRESS_UPDATES_ENABLED = toBool(process.env.PROGRESS_UPDATES_ENABLED, false);
// When true, progress updates may include stderr. This is usually noisy (logs), so default is false.
const PROGRESS_INCLUDE_STDERR = toBool(process.env.PROGRESS_INCLUDE_STDERR, false);
const PROGRESS_FIRST_UPDATE_SEC = toInt(process.env.PROGRESS_FIRST_UPDATE_SEC, 0);
const PROGRESS_UPDATE_INTERVAL_SEC = toInt(process.env.PROGRESS_UPDATE_INTERVAL_SEC, 30);

// Orchestration: route messages across multiple Codex "workers" (per-repo workdirs) to avoid head-of-line blocking.
// This is a local in-process scheduler (not MCP); each worker runs at most one Codex job at a time, but workers run in parallel.
const ORCH_MAX_CODEX_WORKERS = toInt(process.env.ORCH_MAX_CODEX_WORKERS, 5, 1, 20);
const ORCH_ROUTER_ENABLED = toBool(process.env.ORCH_ROUTER_ENABLED, true);
const ORCH_ROUTER_MAX_CONCURRENCY = toInt(process.env.ORCH_ROUTER_MAX_CONCURRENCY, 2, 1, 10);
const ORCH_ROUTER_TIMEOUT_MS = toTimeoutMs(process.env.ORCH_ROUTER_TIMEOUT_MS, 0, 0, MAX_TIMEOUT_MS);
const ORCH_ROUTER_MODEL = String(process.env.ORCH_ROUTER_MODEL || "").trim();
const ORCH_ROUTER_REASONING_EFFORT = String(process.env.ORCH_ROUTER_REASONING_EFFORT || "low").trim();
const ORCH_SPLIT_ENABLED = toBool(process.env.ORCH_SPLIT_ENABLED, true);
const ORCH_SPLIT_MAX_TASKS = toInt(process.env.ORCH_SPLIT_MAX_TASKS, 3, 2, 8);
const ORCH_DELEGATION_ACK_ENABLED = toBool(process.env.ORCH_DELEGATION_ACK_ENABLED, true);
const ORCH_DELEGATION_ACK_SILENT = toBool(process.env.ORCH_DELEGATION_ACK_SILENT, true);
const ORCH_ROUTER_PROMPT_FILE = resolveMaybeRelativePath(
  process.env.ORCH_ROUTER_PROMPT_FILE || path.join(ROOT, "codex_prompt_router.txt"),
);
const REDDIT_DIGEST_ENABLED = toBool(process.env.REDDIT_DIGEST_ENABLED, true);
const parsedRedditDigestSubs = parseList(process.env.REDDIT_DIGEST_SUBREDDITS || "singularity,worldnews")
  .map((s) => normalizeSubredditName(s))
  .filter(Boolean);
const REDDIT_DIGEST_SUBREDDITS = parsedRedditDigestSubs.length > 0
  ? [...new Set(parsedRedditDigestSubs)]
  : ["singularity", "worldnews"];
const REDDIT_DIGEST_MAX_DAYS = toInt(process.env.REDDIT_DIGEST_MAX_DAYS, 3, 1, 7);
const REDDIT_DIGEST_TOP_POSTS = toInt(process.env.REDDIT_DIGEST_TOP_POSTS, 10, 1, 25);
const REDDIT_DIGEST_LOOKBACK_DAYS = toInt(process.env.REDDIT_DIGEST_LOOKBACK_DAYS, 7, 1, 365);
const REDDIT_FETCH_TIMEOUT_MS = toTimeoutMs(process.env.REDDIT_FETCH_TIMEOUT_MS, 20_000, 0, MAX_TIMEOUT_MS);
const NATURAL_NEWS_FOLLOWUP_TTL_MS = 5 * 60 * 1000;
const NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW = Number(process.env.NATURAL_SAFE_COMMAND_INTENT_THRESHOLD);
const NATURAL_SAFE_COMMAND_INTENT_THRESHOLD = Number.isFinite(NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW)
  ? Math.max(0, Math.min(1, NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW))
  : 0.84;
const REPLY_CONTEXT_MAX_CHARS = toInt(process.env.REPLY_CONTEXT_MAX_CHARS, 900, 120, 4000);
const ORCH_THREAD_CONTEXT_MAX_DEPTH = toInt(process.env.ORCH_THREAD_CONTEXT_MAX_DEPTH, 24, 1, 80);
const ORCH_THREAD_CONTEXT_MAX_CHARS = toInt(process.env.ORCH_THREAD_CONTEXT_MAX_CHARS, 6000, 400, 20000);
const ORCH_RECENT_CONTEXT_MESSAGES = toInt(process.env.ORCH_RECENT_CONTEXT_MESSAGES, 5, 0, 20);
const ORCH_RECENT_CONTEXT_MAX_CHARS = toInt(process.env.ORCH_RECENT_CONTEXT_MAX_CHARS, 2200, 300, 12000);
const ORCH_MESSAGE_META_MAX_PER_CHAT = toInt(process.env.ORCH_MESSAGE_META_MAX_PER_CHAT, 1400, 200, 5000);
const ORCH_MESSAGE_META_TTL_DAYS = toInt(process.env.ORCH_MESSAGE_META_TTL_DAYS, 30, 1, 180);
const ORCH_TASK_MAX_PER_CHAT = toInt(process.env.ORCH_TASK_MAX_PER_CHAT, 1200, 100, 5000);
const ORCH_TASK_TTL_DAYS = toInt(process.env.ORCH_TASK_TTL_DAYS, 30, 1, 180);
const REDDIT_USER_AGENT = String(
  process.env.REDDIT_USER_AGENT || "AIDOLON-Telegram-Bot/0.1 (+https://github.com/)",
).trim();

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

const state = readJson(STATE_PATH, {
  lastUpdateId: 0,
  chatSessions: {},
  lastImages: {},
  chatPrefs: {},
  redditDigest: {},
  orch: {},
});
let lastUpdateId = Number(state.lastUpdateId || 0);
const lastImages = state && typeof state.lastImages === "object" && state.lastImages
  ? { ...state.lastImages }
  : {};
const chatPrefs = state && typeof state.chatPrefs === "object" && state.chatPrefs
  ? { ...state.chatPrefs }
  : {};
const redditDigest = state && typeof state.redditDigest === "object" && state.redditDigest
  ? { ...state.redditDigest }
  : {};

const ORCH_GENERAL_WORKER_ID = "general";
const ORCH_TTS_LANE_ID = "tts";
const ORCH_WHISPER_LANE_ID = "whisper";
const WORKER_NAME_POOL = Object.freeze([
  "Astra",
  "Orion",
  "Nova",
  "Atlas",
  "Luna",
  "Echo",
  "Milo",
  "Aria",
  "Iris",
  "Kai",
  "Nora",
  "Riven",
  "Sage",
  "Vera",
  "Felix",
  "Quinn",
  "Skye",
  "Rowan",
  "Zara",
  "Alden",
  "Lyra",
  "Juno",
  "Theo",
  "Freya",
  "Silas",
  "Cleo",
  "Dorian",
  "Mira",
  "Cassian",
  "Elara",
  "Ari",
  "Tessa",
]);

function normalizeWorkerDisplayName(value) {
  const clean = oneLine(String(value || "")).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.slice(0, 40);
}

function collectUsedWorkerNameKeys(workersObj, { excludeWorkerId = "" } = {}) {
  const out = new Set();
  const skip = String(excludeWorkerId || "").trim();
  const workers = workersObj && typeof workersObj === "object" ? workersObj : {};
  for (const [wid, raw] of Object.entries(workers)) {
    if (!raw || typeof raw !== "object") continue;
    if (skip && String(wid || "").trim() === skip) continue;
    const name = normalizeWorkerDisplayName(raw.name);
    if (!name) continue;
    out.add(name.toLowerCase());
  }
  return out;
}

function chooseAvailableWorkerName(usedKeys, preferred = "") {
  const used = usedKeys instanceof Set ? usedKeys : new Set();
  const want = normalizeWorkerDisplayName(preferred);
  if (want && !used.has(want.toLowerCase())) return want;

  for (const base of WORKER_NAME_POOL) {
    const key = String(base || "").trim().toLowerCase();
    if (!key) continue;
    if (!used.has(key)) return base;
  }

  for (let n = 2; n < 10_000; n += 1) {
    for (const base of WORKER_NAME_POOL) {
      const candidate = `${base} ${n}`;
      const key = candidate.toLowerCase();
      if (!used.has(key)) return candidate;
    }
  }

  return `Worker ${Date.now()}`;
}

function ensureUniqueWorkerNames(workersObj) {
  const workers = workersObj && typeof workersObj === "object" ? workersObj : {};
  const entries = Object.entries(workers).sort((a, b) => {
    const aid = String(a[0] || "").trim();
    const bid = String(b[0] || "").trim();
    if (aid === ORCH_GENERAL_WORKER_ID && bid !== ORCH_GENERAL_WORKER_ID) return -1;
    if (bid === ORCH_GENERAL_WORKER_ID && aid !== ORCH_GENERAL_WORKER_ID) return 1;
    const aCreated = Number(a[1]?.createdAt || 0) || 0;
    const bCreated = Number(b[1]?.createdAt || 0) || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return aid.localeCompare(bid);
  });

  const used = new Set();
  for (const [, raw] of entries) {
    if (!raw || typeof raw !== "object") continue;
    const current = normalizeWorkerDisplayName(raw.name);
    const key = current.toLowerCase();
    if (current && !used.has(key)) {
      raw.name = current;
      used.add(key);
      continue;
    }
    const fallback = chooseAvailableWorkerName(used, current);
    raw.name = fallback;
    used.add(fallback.toLowerCase());
  }
}

function logSystemEvent(text, source = "system") {
  const message = String(text || "").trim();
  if (!message) return;
  const sourceLabel = String(source || "").trim() || "system";
  log(`[${sourceLabel}] ${message}`);
  if (!CHAT_LOG_TO_FILE) return;
  try {
    const line = [
      nowIso(),
      "direction=system",
      "chat=-",
      `user=${JSON.stringify("-")}`,
      `source=${JSON.stringify(sourceLabel)}`,
      `text=${JSON.stringify(message)}`,
    ].join(" ");
    fs.appendFileSync(CHAT_LOG_PATH, `${line}\n`, "utf8");
  } catch {
    // best effort
  }
}

const orch = normalizeOrchState(state, {
  legacyChatSessions: state && typeof state.chatSessions === "object" && state.chatSessions ? state.chatSessions : {},
});
const orchWorkers = orch.workers; // { [workerId]: { ... } }
const orchActiveWorkerByChat = orch.activeWorkerByChat; // { [chatId]: workerId }
const orchSessionByChatWorker = orch.sessionByChatWorker; // { [chatId]: { [workerId]: sessionId } }
const orchReplyRouteByChat = orch.replyRouteByChat; // { [chatId]: { [messageId]: { workerId, at } } }
const orchMessageMetaByChat = orch.messageMetaByChat; // { [chatId]: { [messageId]: { ... } } }
const orchTasksByChat = orch.tasksByChat; // { [chatId]: { [taskId]: { ... } } }
let orchNextWorkerNum = Number(orch.nextWorkerNum || 1);
let orchNextTaskNum = Number(orch.nextTaskNum || 1);

const lanes = new Map();
initOrchLanes();
let nextJobId = 1;
let shuttingDown = false;
const orchPendingSpawnByChat = new Map(); // chatId -> { desiredWorkdir, title, promptText, source, options, createdAt }
let routerSequence = 1;
let routerInFlight = 0;
const routerWaiters = [];
const pendingCommandsById = new Map();
const pendingCommandIdByChat = new Map();
const backgroundCommandChainByChat = new Map();
const pendingNaturalNewsByChat = new Map(); // chatId -> { at }
let pendingRestartRequest = null; // { requestedAt, chatIds:Set<string> }
let restartTriggerInFlight = false;
const updateFailureCounts = new Map(); // update_id -> consecutive handler failures
let pendingSequence = 1;
const prefButtonsById = new Map();
let prefButtonSequence = 1;
let codexTopCommandsCache = {
  loadedAt: 0,
  commands: [],
};
const ttsKeepalive = {
  proc: null,
  startPromise: null,
  startTimer: null,
  ready: false,
  requestSeq: 1,
  pending: null,
  stdoutBuf: "",
  stderrTail: "",
  stderrScanCarry: "",
  restartTimer: null,
  restartAttempts: 0,
};
const whisperKeepalive = {
  proc: null,
  startPromise: null,
  startTimer: null,
  ready: false,
  requestSeq: 1,
  pending: null,
  stdoutBuf: "",
  stderrTail: "",
  restartTimer: null,
  restartAttempts: 0,
};

function registerPrefButton(chatId, kind, value) {
  const id = `pref${prefButtonSequence++}`;
  prefButtonsById.set(id, {
    id,
    chatId: String(chatId || "").trim(),
    kind: String(kind || "").trim(),
    value: String(value || "").trim(),
    at: Date.now(),
  });
  // Best effort cleanup of old entries.
  if (prefButtonsById.size > 500) {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [k, v] of prefButtonsById.entries()) {
      if (Number(v?.at || 0) < cutoff) prefButtonsById.delete(k);
      if (prefButtonsById.size <= 400) break;
    }
  }
  return id;
}

function consumePrefButton(chatId, id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const entry = prefButtonsById.get(key) || null;
  if (!entry) return null;
  prefButtonsById.delete(key);
  if (String(entry.chatId || "") !== String(chatId || "").trim()) return null;
  return entry;
}

function normalizeOrchState(stateObj, { legacyChatSessions = {} } = {}) {
  const raw = stateObj && typeof stateObj.orch === "object" && stateObj.orch ? stateObj.orch : {};
  const workers = raw && typeof raw.workers === "object" && raw.workers ? { ...raw.workers } : {};
  const activeWorkerByChat = raw && typeof raw.activeWorkerByChat === "object" && raw.activeWorkerByChat
    ? { ...raw.activeWorkerByChat }
    : {};
  const sessionByChatWorker = raw && typeof raw.sessionByChatWorker === "object" && raw.sessionByChatWorker
    ? { ...raw.sessionByChatWorker }
    : {};
  const replyRouteByChat = raw && typeof raw.replyRouteByChat === "object" && raw.replyRouteByChat
    ? { ...raw.replyRouteByChat }
    : {};
  const messageMetaByChat = raw && typeof raw.messageMetaByChat === "object" && raw.messageMetaByChat
    ? { ...raw.messageMetaByChat }
    : {};
  const tasksByChat = raw && typeof raw.tasksByChat === "object" && raw.tasksByChat
    ? { ...raw.tasksByChat }
    : {};
  let nextWorkerNum = Number(raw?.nextWorkerNum || 1);
  if (!Number.isFinite(nextWorkerNum) || nextWorkerNum < 1) nextWorkerNum = 1;
  let nextTaskNum = Number(raw?.nextTaskNum || 1);
  if (!Number.isFinite(nextTaskNum) || nextTaskNum < 1) nextTaskNum = 1;

  const now = Date.now();
  // Ensure a general worker always exists.
  const general = workers[ORCH_GENERAL_WORKER_ID];
  if (!general || typeof general !== "object") {
    workers[ORCH_GENERAL_WORKER_ID] = {
      id: ORCH_GENERAL_WORKER_ID,
      kind: "general",
      name: "Astra",
      title: "General",
      workdir: CODEX_WORKDIR,
      createdAt: now,
      lastUsedAt: now,
    };
  } else {
    // Best-effort normalization.
    workers[ORCH_GENERAL_WORKER_ID] = {
      id: ORCH_GENERAL_WORKER_ID,
      kind: "general",
      name: normalizeWorkerDisplayName(general.name || "Astra") || "Astra",
      title: String(general.title || "General").trim() || "General",
      workdir: String(general.workdir || CODEX_WORKDIR).trim() || CODEX_WORKDIR,
      createdAt: Number(general.createdAt || now) || now,
      lastUsedAt: Number(general.lastUsedAt || now) || now,
    };
  }

  // Migrate legacy per-chat session ids onto the general worker (first run after upgrade).
  if (legacyChatSessions && typeof legacyChatSessions === "object") {
    for (const [chatId, sid] of Object.entries(legacyChatSessions)) {
      const key = String(chatId || "").trim();
      const sessionId = String(sid || "").trim();
      if (!key || !sessionId) continue;
      const prev = sessionByChatWorker[key] && typeof sessionByChatWorker[key] === "object" ? sessionByChatWorker[key] : {};
      if (!prev[ORCH_GENERAL_WORKER_ID]) {
        sessionByChatWorker[key] = { ...prev, [ORCH_GENERAL_WORKER_ID]: sessionId };
      }
      if (!activeWorkerByChat[key]) {
        activeWorkerByChat[key] = ORCH_GENERAL_WORKER_ID;
      }
    }
  }

  ensureUniqueWorkerNames(workers);

  return {
    version: 1,
    workers,
    activeWorkerByChat,
    sessionByChatWorker,
    replyRouteByChat,
    messageMetaByChat,
    tasksByChat,
    nextWorkerNum,
    nextTaskNum,
  };
}

function persistState() {
  try {
    writeJsonAtomic(STATE_PATH, {
      lastUpdateId,
      lastImages,
      chatPrefs,
      redditDigest,
      orch: {
        version: 1,
        workers: orchWorkers,
        activeWorkerByChat: orchActiveWorkerByChat,
        sessionByChatWorker: orchSessionByChatWorker,
        replyRouteByChat: orchReplyRouteByChat,
        messageMetaByChat: orchMessageMetaByChat,
        tasksByChat: orchTasksByChat,
        nextWorkerNum: orchNextWorkerNum,
        nextTaskNum: orchNextTaskNum,
      },
    });
  } catch {
    // best effort
  }
}

function getChatPrefs(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return { model: "", reasoning: "" };
  const entry = chatPrefs[key];
  if (!entry || typeof entry !== "object") return { model: "", reasoning: "" };
  return {
    model: String(entry.model || "").trim(),
    reasoning: String(entry.reasoning || "").trim(),
  };
}

function setChatPrefs(chatId, patch) {
  const key = String(chatId || "").trim();
  if (!key) return;
  const prev = getChatPrefs(key);
  chatPrefs[key] = {
    model: String(patch?.model ?? prev.model ?? "").trim(),
    reasoning: String(patch?.reasoning ?? prev.reasoning ?? "").trim(),
  };
  persistState();
}

function clearChatPrefs(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in chatPrefs)) return;
  delete chatPrefs[key];
  persistState();
}

function getActiveWorkerForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return ORCH_GENERAL_WORKER_ID;
  const raw = String(orchActiveWorkerByChat[key] || "").trim();
  return raw && orchWorkers[raw] ? raw : ORCH_GENERAL_WORKER_ID;
}

function setActiveWorkerForChat(chatId, workerId) {
  const key = String(chatId || "").trim();
  const wid = String(workerId || "").trim();
  if (!key || !wid) return;
  if (!orchWorkers[wid]) return;
  orchActiveWorkerByChat[key] = wid;
  persistState();
}

function getSessionForChatWorker(chatId, workerId) {
  const key = String(chatId || "").trim();
  const wid = String(workerId || "").trim();
  if (!key || !wid) return "";
  const entry = orchSessionByChatWorker[key];
  if (!entry || typeof entry !== "object") return "";
  return String(entry[wid] || "").trim();
}

function setSessionForChatWorker(chatId, workerId, sessionId) {
  const key = String(chatId || "").trim();
  const wid = String(workerId || "").trim();
  const sid = String(sessionId || "").trim();
  if (!key || !wid || !sid) return;
  const prev = orchSessionByChatWorker[key] && typeof orchSessionByChatWorker[key] === "object"
    ? orchSessionByChatWorker[key]
    : {};
  orchSessionByChatWorker[key] = { ...prev, [wid]: sid };
  persistState();
}

function clearSessionForChatWorker(chatId, workerId) {
  const key = String(chatId || "").trim();
  const wid = String(workerId || "").trim();
  if (!key || !wid) return;
  const prev = orchSessionByChatWorker[key];
  if (!prev || typeof prev !== "object") return;
  if (!(wid in prev)) return;
  const next = { ...prev };
  delete next[wid];
  orchSessionByChatWorker[key] = next;
  persistState();
}

function clearAllSessionsForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in orchSessionByChatWorker)) return;
  delete orchSessionByChatWorker[key];
  persistState();
}

function getActiveSessionForChat(chatId, workerId = "") {
  const wid = String(workerId || "").trim() || getActiveWorkerForChat(chatId);
  return getSessionForChatWorker(chatId, wid);
}

function normalizeTaskLinks(rawValue) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(rawValue) ? rawValue : []) {
    if (!item || typeof item !== "object") continue;
    const taskIdNum = Number(item.taskId || item.task_id || 0);
    const taskId = Number.isFinite(taskIdNum) && taskIdNum > 0 ? Math.trunc(taskIdNum) : 0;
    const workerId = String(item.workerId || item.worker_id || "").trim();
    const sessionId = String(item.sessionId || item.session_id || "").trim();
    if (!taskId && !workerId) continue;
    const key = `${taskId}|${workerId}|${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = {};
    if (taskId) entry.taskId = taskId;
    if (workerId) entry.workerId = workerId;
    if (sessionId) entry.sessionId = sessionId;
    out.push(entry);
  }
  return out;
}

function mergeTaskLinks(a, b) {
  return normalizeTaskLinks([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

function ensureMessageMetaEntryForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const current = orchMessageMetaByChat[key];
  if (current && typeof current === "object") return current;
  const next = {};
  orchMessageMetaByChat[key] = next;
  return next;
}

function ensureTaskEntryForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const current = orchTasksByChat[key];
  if (current && typeof current === "object") return current;
  const next = {};
  orchTasksByChat[key] = next;
  return next;
}

function pruneMessageMetaForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  const entry = orchMessageMetaByChat[key];
  if (!entry || typeof entry !== "object") return;
  const rows = Object.entries(entry);
  if (rows.length === 0) return;

  const ttlMs = Math.max(1, ORCH_MESSAGE_META_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  rows.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));

  const next = {};
  let kept = 0;
  for (const [messageId, meta] of rows) {
    if (kept >= ORCH_MESSAGE_META_MAX_PER_CHAT) break;
    const at = Number(meta?.at || 0);
    if (Number.isFinite(at) && at > 0 && at < cutoff) continue;
    next[messageId] = meta;
    kept += 1;
  }
  orchMessageMetaByChat[key] = next;
}

function pruneTasksForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  const entry = orchTasksByChat[key];
  if (!entry || typeof entry !== "object") return;
  const rows = Object.entries(entry);
  if (rows.length === 0) return;

  const ttlMs = Math.max(1, ORCH_TASK_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  rows.sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0));

  const next = {};
  let kept = 0;
  for (const [taskId, meta] of rows) {
    if (kept >= ORCH_TASK_MAX_PER_CHAT) break;
    const createdAt = Number(meta?.createdAt || 0);
    if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < cutoff) continue;
    next[taskId] = meta;
    kept += 1;
  }
  orchTasksByChat[key] = next;
}

function getMessageMetaEntry(chatId, messageId) {
  const key = String(chatId || "").trim();
  const id = String(messageId || "").trim();
  if (!key || !id) return null;
  const entry = orchMessageMetaByChat[key];
  if (!entry || typeof entry !== "object") return null;
  const hit = entry[id];
  return hit && typeof hit === "object" ? hit : null;
}

function recordMessageMeta(chatId, messageId, context = {}, { persist = true } = {}) {
  const key = String(chatId || "").trim();
  const idNum = Number(messageId || 0);
  if (!key || !Number.isFinite(idNum) || idNum <= 0) return null;
  const id = String(Math.trunc(idNum));
  const byChat = ensureMessageMetaEntryForChat(key);
  if (!byChat) return null;
  const prev = byChat[id] && typeof byChat[id] === "object" ? byChat[id] : {};
  const now = Date.now();
  const next = { ...prev };

  next.messageId = Math.trunc(idNum);
  next.at = now;

  if (Object.prototype.hasOwnProperty.call(context, "parentMessageId")) {
    const parentNum = Number(context.parentMessageId || 0);
    next.parentMessageId = Number.isFinite(parentNum) && parentNum > 0 ? Math.trunc(parentNum) : 0;
  } else if (!Number.isFinite(Number(next.parentMessageId || 0))) {
    next.parentMessageId = 0;
  }

  if (Object.prototype.hasOwnProperty.call(context, "source")) {
    const source = String(context.source || "").trim().toLowerCase();
    if (source) next.source = source;
  }

  if (Object.prototype.hasOwnProperty.call(context, "snippet")) {
    const snippet = normalizeReplySnippet(context.snippet || "");
    if (snippet) next.snippet = snippet;
  }

  if (Object.prototype.hasOwnProperty.call(context, "from")) {
    const from = String(context.from || "").trim();
    if (from) next.from = from;
  }

  if (Object.prototype.hasOwnProperty.call(context, "fromIsBot")) {
    next.fromIsBot = context.fromIsBot === true;
  }

  if (Object.prototype.hasOwnProperty.call(context, "role")) {
    const role = String(context.role || "").trim().toLowerCase();
    if (role) next.role = role;
  }

  if (Object.prototype.hasOwnProperty.call(context, "workerId")) {
    const workerId = String(context.workerId || "").trim();
    if (workerId) next.workerId = workerId;
  }

  if (Object.prototype.hasOwnProperty.call(context, "taskId")) {
    const taskIdNum = Number(context.taskId || 0);
    if (Number.isFinite(taskIdNum) && taskIdNum > 0) {
      next.taskId = Math.trunc(taskIdNum);
    }
  }

  if (Object.prototype.hasOwnProperty.call(context, "sessionId")) {
    const sessionId = String(context.sessionId || "").trim();
    if (sessionId) next.sessionId = sessionId;
  }

  const incomingTaskLinks = normalizeTaskLinks(context.taskLinks);
  if (incomingTaskLinks.length > 0) {
    next.taskLinks = mergeTaskLinks(next.taskLinks, incomingTaskLinks);
  } else if (!Array.isArray(next.taskLinks)) {
    delete next.taskLinks;
  }

  byChat[id] = next;
  pruneMessageMetaForChat(key);
  if (persist) persistState();
  return next;
}

function recordIncomingTelegramMessageMeta(msg, context = {}) {
  const chatId = String(msg?.chat?.id || "").trim();
  const messageId = Number(msg?.message_id || 0);
  if (!chatId || !Number.isFinite(messageId) || messageId <= 0) return null;

  const summary = summarizeTelegramMessageForReplyContext(msg);
  const fallbackSource = summary?.source ? `user-${String(summary.source || "").trim().toLowerCase()}` : "user-message";
  const source = Object.prototype.hasOwnProperty.call(context, "source")
    ? String(context.source || "").trim().toLowerCase()
    : fallbackSource;
  const snippet = Object.prototype.hasOwnProperty.call(context, "snippet")
    ? String(context.snippet || "")
    : String(summary?.snippet || "");
  const parentMessageId = Number(msg?.reply_to_message?.message_id || 0);
  const from = senderLabel(msg);
  const fromIsBot = msg?.from?.is_bot === true;

  return recordMessageMeta(
    chatId,
    messageId,
    {
      parentMessageId: Number.isFinite(parentMessageId) && parentMessageId > 0 ? Math.trunc(parentMessageId) : 0,
      source,
      snippet,
      from,
      fromIsBot,
      role: fromIsBot ? "assistant" : "user",
      workerId: context.workerId,
      taskId: context.taskId,
      sessionId: context.sessionId,
      taskLinks: context.taskLinks,
    },
    { persist: true },
  );
}

function allocateOrchTaskId() {
  const next = Number(orchNextTaskNum || 1);
  const id = Number.isFinite(next) && next > 0 ? Math.trunc(next) : 1;
  orchNextTaskNum = id + 1;
  return id;
}

function createOrchTask(chatId, context = {}) {
  const key = String(chatId || "").trim();
  if (!key) return 0;
  const byChat = ensureTaskEntryForChat(key);
  if (!byChat) return 0;

  const taskId = allocateOrchTaskId();
  const now = Date.now();
  const workerId = String(context.workerId || "").trim();
  const prompt = String(context.prompt || "").trim();
  const source = String(context.source || "").trim().toLowerCase() || "message";
  const splitGroupId = String(context.splitGroupId || "").trim();
  const originMessageIdNum = Number(context.originMessageId || 0);
  const originMessageId = Number.isFinite(originMessageIdNum) && originMessageIdNum > 0 ? Math.trunc(originMessageIdNum) : 0;
  const replyToMessageIdNum = Number(context.replyToMessageId || 0);
  const replyToMessageId = Number.isFinite(replyToMessageIdNum) && replyToMessageIdNum > 0 ? Math.trunc(replyToMessageIdNum) : 0;

  const entry = {
    id: taskId,
    status: "queued",
    workerId,
    source,
    prompt: normalizeReplySnippet(prompt),
    createdAt: now,
    updatedAt: now,
    startedAt: 0,
    completedAt: 0,
    success: null,
    sessionId: "",
    outputSnippet: "",
    outputMessageIds: [],
    originMessageId,
    replyToMessageId,
  };
  if (splitGroupId) entry.splitGroupId = splitGroupId;
  byChat[String(taskId)] = entry;
  pruneTasksForChat(key);
  persistState();
  return taskId;
}

function updateOrchTask(chatId, taskId, patch = {}, { persist = true } = {}) {
  const key = String(chatId || "").trim();
  const taskNum = Number(taskId || 0);
  if (!key || !Number.isFinite(taskNum) || taskNum <= 0) return null;
  const byChat = ensureTaskEntryForChat(key);
  if (!byChat) return null;
  const idKey = String(Math.trunc(taskNum));
  const prev = byChat[idKey] && typeof byChat[idKey] === "object"
    ? byChat[idKey]
    : { id: Math.trunc(taskNum), createdAt: Date.now() };
  const now = Date.now();
  const next = { ...prev, updatedAt: now };

  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const status = String(patch.status || "").trim().toLowerCase();
    if (status) next.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "workerId")) {
    const workerId = String(patch.workerId || "").trim();
    if (workerId) next.workerId = workerId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "startedAt")) {
    const startedAt = Number(patch.startedAt || 0);
    next.startedAt = Number.isFinite(startedAt) && startedAt > 0 ? Math.trunc(startedAt) : 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "completedAt")) {
    const completedAt = Number(patch.completedAt || 0);
    next.completedAt = Number.isFinite(completedAt) && completedAt > 0 ? Math.trunc(completedAt) : 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "success")) {
    next.success = patch.success === null ? null : patch.success === true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sessionId")) {
    const sessionId = String(patch.sessionId || "").trim();
    next.sessionId = sessionId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "outputSnippet")) {
    next.outputSnippet = normalizeReplySnippet(String(patch.outputSnippet || ""));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "outputMessageIds")) {
    const ids = Array.isArray(patch.outputMessageIds)
      ? patch.outputMessageIds
          .map((x) => Number(x || 0))
          .filter((x) => Number.isFinite(x) && x > 0)
          .map((x) => Math.trunc(x))
      : [];
    next.outputMessageIds = [...new Set(ids)];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "error")) {
    const err = String(patch.error || "").trim();
    next.error = err;
  }

  byChat[idKey] = next;
  pruneTasksForChat(key);
  if (persist) persistState();
  return next;
}

function markOrchTaskRunning(job) {
  const taskId = Number(job?.taskId || 0);
  if (!Number.isFinite(taskId) || taskId <= 0) return;
  updateOrchTask(
    String(job?.chatId || ""),
    taskId,
    {
      status: "running",
      workerId: String(job?.workerId || "").trim(),
      startedAt: Date.now(),
    },
    { persist: true },
  );
}

function markOrchTaskCompleted(job, result, context = {}) {
  const taskId = Number(job?.taskId || 0);
  if (!Number.isFinite(taskId) || taskId <= 0) return;
  const ok = Boolean(result?.ok);
  const sessionId = String(context.sessionId || result?.sessionId || "").trim();
  const messageIds = Array.isArray(context.outputMessageIds) ? context.outputMessageIds : [];
  const outputText = String(result?.afterText || result?.text || "").trim();
  updateOrchTask(
    String(job?.chatId || ""),
    taskId,
    {
      status: ok ? "completed" : "failed",
      workerId: String(job?.workerId || "").trim(),
      completedAt: Date.now(),
      success: ok,
      sessionId,
      outputSnippet: outputText,
      outputMessageIds: messageIds,
      error: ok ? "" : String(result?.text || "").trim(),
    },
    { persist: true },
  );
}

function getLane(laneId) {
  const key = String(laneId || "").trim();
  if (!key) return null;
  return lanes.get(key) || null;
}

function makeLane({ id, type, title, workdir, countTowardCap = false } = {}) {
  const laneId = String(id || "").trim();
  if (!laneId) throw new Error("lane id is required");
  const lane = {
    id: laneId,
    type: String(type || "").trim() || "codex",
    title: String(title || laneId).trim() || laneId,
    workdir: String(workdir || "").trim(),
    countTowardCap: Boolean(countTowardCap),
    queue: [],
    currentJob: null,
  };
  lanes.set(laneId, lane);
  return lane;
}

function listCodexWorkers() {
  const out = [];
  for (const [id, w] of Object.entries(orchWorkers || {})) {
    if (!w || typeof w !== "object") continue;
    const wid = String(id || "").trim();
    if (!wid) continue;
    out.push({
      id: wid,
      kind: String(w.kind || "").trim() || "repo",
      name: normalizeWorkerDisplayName(w.name),
      title: String(w.title || wid).trim() || wid,
      workdir: String(w.workdir || "").trim(),
      createdAt: Number(w.createdAt || 0) || 0,
      lastUsedAt: Number(w.lastUsedAt || 0) || 0,
    });
  }
  out.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  return out;
}

function getCodexWorker(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return null;
  const w = orchWorkers[wid];
  if (!w || typeof w !== "object") return null;
  return {
    id: wid,
    kind: String(w.kind || "").trim() || "repo",
    name: normalizeWorkerDisplayName(w.name),
    title: String(w.title || wid).trim() || wid,
    workdir: String(w.workdir || "").trim(),
    createdAt: Number(w.createdAt || 0) || 0,
    lastUsedAt: Number(w.lastUsedAt || 0) || 0,
  };
}

function touchWorker(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return;
  const w = orchWorkers[wid];
  if (!w || typeof w !== "object") return;
  w.lastUsedAt = Date.now();
  persistState();
}

function normalizePathKey(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return "";
  try {
    // Use forward slashes + lowercase so Windows paths compare reliably.
    return path.resolve(raw).replace(/\\/g, "/").toLowerCase();
  } catch {
    return raw.replace(/\\/g, "/").toLowerCase();
  }
}

function resolveWorkdirInput(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return "";
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

function findWorkerByWorkdir(workdir) {
  const key = normalizePathKey(workdir);
  if (!key) return "";
  for (const w of listCodexWorkers()) {
    const wk = normalizePathKey(w.workdir);
    if (wk && wk === key) return w.id;
  }
  return "";
}

function createRepoWorker(workdir, title = "") {
  const resolved = resolveWorkdirInput(workdir);
  if (!resolved) throw new Error("workdir is required");
  if (!fs.existsSync(resolved)) throw new Error(`workdir does not exist: ${resolved}`);

  const existing = findWorkerByWorkdir(resolved);
  if (existing) return existing;

  const now = Date.now();
  const baseTitle = String(title || "").trim() || path.basename(resolved) || "Repo";
  const usedNameKeys = collectUsedWorkerNameKeys(orchWorkers);
  const workerName = chooseAvailableWorkerName(usedNameKeys);

  let id = "";
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const candidate = `w${orchNextWorkerNum++}`;
    if (!orchWorkers[candidate]) {
      id = candidate;
      break;
    }
  }
  if (!id) throw new Error("Failed to allocate worker id");

  orchWorkers[id] = {
    id,
    kind: "repo",
    name: workerName,
    title: baseTitle,
    workdir: resolved,
    createdAt: now,
    lastUsedAt: now,
  };
  persistState();
  ensureWorkerLane(id);
  return id;
}

function retireWorker(workerId, { cancelActive = true } = {}) {
  const wid = String(workerId || "").trim();
  if (!wid) throw new Error("worker id is required");
  if (wid === ORCH_GENERAL_WORKER_ID) throw new Error("Cannot retire the general worker");
  if (!orchWorkers[wid]) throw new Error(`Unknown worker: ${wid}`);

  const lane = getLane(wid);
  if (lane) {
    try {
      if (cancelActive && lane.currentJob) {
        const job = lane.currentJob;
        job.cancelRequested = true;
        try {
          if (job.abortController instanceof AbortController) {
            job.abortController.abort();
          }
        } catch {
          // best effort
        }
        if (job.process) {
          terminateChildTree(job.process, { forceAfterMs: 2000 });
        }
      }
      if (Array.isArray(lane.queue)) lane.queue = [];
    } catch {
      // best effort
    }
    lanes.delete(wid);
  }

  delete orchWorkers[wid];

  // If any chat had this as active worker, fall back to general.
  for (const [chatKey, cur] of Object.entries(orchActiveWorkerByChat || {})) {
    if (String(cur || "").trim() === wid) {
      orchActiveWorkerByChat[chatKey] = ORCH_GENERAL_WORKER_ID;
    }
  }

  // Drop sessions for this worker.
  for (const [chatKey, entry] of Object.entries(orchSessionByChatWorker || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (!(wid in entry)) continue;
    const next = { ...entry };
    delete next[wid];
    orchSessionByChatWorker[chatKey] = next;
  }

  // Drop reply-route entries for this worker.
  for (const [chatKey, entry] of Object.entries(orchReplyRouteByChat || {})) {
    if (!entry || typeof entry !== "object") continue;
    let changed = false;
    const next = {};
    for (const [msgId, v] of Object.entries(entry)) {
      const vw = String(v?.workerId || "").trim();
      if (vw && vw === wid) {
        changed = true;
        continue;
      }
      next[msgId] = v;
    }
    if (changed) {
      orchReplyRouteByChat[chatKey] = next;
    }
  }

  persistState();
}

function resolveWorkerIdFromUserInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (orchWorkers[raw]) return raw;

  const lower = raw.toLowerCase();
  const workers = listCodexWorkers();

  // Exact title match.
  for (const w of workers) {
    if (String(w.title || "").trim().toLowerCase() === lower) return w.id;
  }

  // Exact worker name match.
  for (const w of workers) {
    if (String(w.name || "").trim().toLowerCase() === lower) return w.id;
  }

  // Basename match (repo folder name).
  for (const w of workers) {
    const base = String(path.basename(String(w.workdir || "")) || "").trim().toLowerCase();
    if (base && base === lower) return w.id;
  }

  // Substring match (first).
  for (const w of workers) {
    const name = String(w.name || "").trim().toLowerCase();
    const title = String(w.title || "").trim().toLowerCase();
    const dir = String(w.workdir || "").trim().toLowerCase();
    if ((name && name.includes(lower)) || (title && title.includes(lower)) || (dir && dir.includes(lower))) return w.id;
  }

  return "";
}

function ensureTtsLane() {
  let lane = getLane(ORCH_TTS_LANE_ID);
  if (lane) return lane;
  lane = makeLane({
    id: ORCH_TTS_LANE_ID,
    type: "tts",
    title: "TTS",
    workdir: ROOT,
    countTowardCap: false,
  });
  return lane;
}

function ensureWhisperLane() {
  let lane = getLane(ORCH_WHISPER_LANE_ID);
  if (lane) return lane;
  lane = makeLane({
    id: ORCH_WHISPER_LANE_ID,
    type: "whisper",
    title: "Whisper",
    workdir: ROOT,
    countTowardCap: false,
  });
  return lane;
}

function ensureWorkerLane(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return null;
  const existing = getLane(wid);
  if (existing) return existing;
  const w = getCodexWorker(wid);
  if (!w) return null;
  const workdir = w.workdir && fs.existsSync(w.workdir) ? w.workdir : CODEX_WORKDIR;
  return makeLane({
    id: wid,
    type: "codex",
    title: String(w.name || w.title || wid).trim() || wid,
    workdir,
    countTowardCap: true,
  });
}

function initOrchLanes() {
  ensureTtsLane();
  ensureWhisperLane();
  // Convenience: ensure the bot's own repo has a dedicated worker when possible.
  try {
    const isRepo = fs.existsSync(path.join(ROOT, ".git"));
    const hasWorker = Boolean(findWorkerByWorkdir(ROOT));
    if (isRepo && !hasWorker && listCodexWorkers().length < ORCH_MAX_CODEX_WORKERS) {
      createRepoWorker(ROOT, path.basename(ROOT) || "Bot Repo");
    }
  } catch {
    // best effort
  }
  // Ensure lanes exist for all known workers (including the general worker).
  for (const w of listCodexWorkers()) {
    ensureWorkerLane(w.id);
  }
  // Enforce the cap at startup (best-effort): keep most recently used workers + general.
  const all = listCodexWorkers();
  const keep = [];
  for (const w of all) {
    if (w.id === ORCH_GENERAL_WORKER_ID) keep.push(w);
  }
  for (const w of all) {
    if (w.id === ORCH_GENERAL_WORKER_ID) continue;
    if (keep.length >= ORCH_MAX_CODEX_WORKERS) break;
    keep.push(w);
  }
  const keepIds = new Set(keep.map((w) => w.id));
  for (const w of all) {
    if (keepIds.has(w.id)) continue;
    delete orchWorkers[w.id];
    lanes.delete(w.id);
  }
  if (all.length !== keep.length) {
    persistState();
  }
}

function totalQueuedJobs() {
  let n = 0;
  for (const lane of lanes.values()) {
    n += Array.isArray(lane?.queue) ? lane.queue.length : 0;
  }
  return n;
}

function listActiveJobs() {
  const out = [];
  for (const lane of lanes.values()) {
    if (lane && lane.currentJob) out.push({ laneId: lane.id, job: lane.currentJob });
  }
  return out;
}

function laneWorkloadCounts() {
  let active = 0;
  let queued = 0;
  for (const lane of lanes.values()) {
    if (!lane) continue;
    if (lane.currentJob) active += 1;
    queued += Array.isArray(lane.queue) ? lane.queue.length : 0;
  }
  return { active, queued };
}

function hasPendingRestartRequest() {
  return Boolean(pendingRestartRequest && pendingRestartRequest.chatIds instanceof Set);
}

function cancelPendingRestartRequest() {
  const hadPending = hasPendingRestartRequest();
  pendingRestartRequest = null;
  return hadPending;
}

function ensurePendingRestartRequest(chatId = "") {
  if (!hasPendingRestartRequest()) {
    pendingRestartRequest = {
      requestedAt: Date.now(),
      chatIds: new Set(),
    };
  }
  const key = String(chatId || "").trim();
  if (key) pendingRestartRequest.chatIds.add(key);
}

function listRestartNotifyChats() {
  if (!hasPendingRestartRequest()) return [];
  return [...pendingRestartRequest.chatIds].map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeRestartReasonTag(reason = "") {
  const raw = String(reason || "").trim().toLowerCase();
  if (!raw || raw === "idle") return "manual_idle";
  if (raw === "forced") return "manual_forced";
  return raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "manual_other";
}

function persistRestartReason(reasonTag = "") {
  const tag = String(reasonTag || "").trim();
  if (!tag) return;
  try {
    fs.writeFileSync(RESTART_REASON_PATH, `${tag}\n`, "utf8");
  } catch {
    // best effort
  }
}

async function triggerRestartNow(reason = "") {
  if (shuttingDown || restartTriggerInFlight) return false;
  restartTriggerInFlight = true;
  const notifyChats = listRestartNotifyChats();
  pendingRestartRequest = null;
  const restartReasonTag = normalizeRestartReasonTag(reason);
  const counts = laneWorkloadCounts();
  persistRestartReason(restartReasonTag);
  logSystemEvent(
    `Restart requested (reason=${restartReasonTag}, active=${counts.active}, queued=${counts.queued}, notify_chats=${notifyChats.length}).`,
    "restart",
  );
  let text = "Restarting bot now...";
  if (reason === "forced") {
    text = "Force restart requested. Restarting bot now...";
  } else if (reason === "idle" || !reason) {
    text = "All workers are finished. Restarting bot now...";
  } else {
    text = `All workers are finished (${reason}). Restarting bot now...`;
  }
  for (const chatId of notifyChats) {
    try {
      await sendMessage(chatId, text);
    } catch {
      // best effort
    }
  }
  setTimeout(() => {
    void shutdown(RESTART_EXIT_CODE, `restart:${restartReasonTag}`);
  }, 200);
  return true;
}

async function maybeTriggerPendingRestart(reason = "") {
  if (!hasPendingRestartRequest()) return false;
  if (shuttingDown || restartTriggerInFlight) return false;
  const { active, queued } = laneWorkloadCounts();
  if (active > 0 || queued > 0) return false;
  return await triggerRestartNow(reason);
}

async function requestRestartWhenIdle(chatId, { forceNow = false } = {}) {
  const key = String(chatId || "").trim();
  if (shuttingDown || restartTriggerInFlight) {
    if (key) await sendMessage(key, "Restart is already in progress.");
    return;
  }

  const { active, queued } = laneWorkloadCounts();
  if (active > 0 || queued > 0) {
    cancelPendingRestartRequest();
    if (key) {
      await sendMessage(
        key,
        `Restart blocked. Workers are still busy (active=${active}, queued=${queued}). Try again when everything is idle.`,
      );
    }
    return;
  }

  ensurePendingRestartRequest(key);
  await triggerRestartNow(forceNow ? "forced" : "idle");
}

function listActiveJobsForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return [];
  return listActiveJobs().filter((x) => String(x?.job?.chatId || "") === key);
}

function listQueuedJobsForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return [];
  const out = [];
  for (const lane of lanes.values()) {
    if (!lane || !Array.isArray(lane.queue) || lane.queue.length === 0) continue;
    for (const job of lane.queue) {
      if (String(job?.chatId || "") !== key) continue;
      out.push({ laneId: lane.id, job });
    }
  }
  out.sort((a, b) => Number(a.job?.id || 0) - Number(b.job?.id || 0));
  return out;
}

function dropQueuedJobsForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return 0;
  let removed = 0;
  const removedJobs = [];
  for (const lane of lanes.values()) {
    if (!lane || !Array.isArray(lane.queue) || lane.queue.length === 0) continue;
    const kept = [];
    for (const j of lane.queue) {
      if (String(j?.chatId || "") !== key) {
        kept.push(j);
        continue;
      }
      removed += 1;
      removedJobs.push(j);
    }
    lane.queue = kept;
  }
  let changedTasks = 0;
  for (const job of removedJobs) {
    const taskId = Number(job?.taskId || 0);
    if (!Number.isFinite(taskId) || taskId <= 0) continue;
    updateOrchTask(key, taskId, {
      status: "canceled",
      completedAt: Date.now(),
      success: false,
      error: "Canceled while queued.",
    }, { persist: false });
    changedTasks += 1;
  }
  if (changedTasks > 0) {
    persistState();
  }
  return removed;
}

function normalizeReplySnippet(text) {
  const src = String(text || "").replace(/\r/g, "").trim();
  if (!src) return "";
  const lim = Number(REPLY_CONTEXT_MAX_CHARS);
  if (!Number.isFinite(lim) || lim <= 0 || src.length <= lim) return src;
  const clipped = src.slice(0, Math.max(0, lim - 14)).trimEnd();
  return `${clipped}\n...[truncated]`;
}

function lookupReplyRouteEntry(chatId, messageId) {
  const chatKey = String(chatId || "").trim();
  const msgKey = String(messageId || "").trim();
  if (!chatKey || !msgKey) return null;
  const entry = orchReplyRouteByChat[chatKey];
  if (!entry || typeof entry !== "object") return null;
  const hit = entry[msgKey];
  if (!hit || typeof hit !== "object") return null;

  const workerId = String(hit.workerId || "").trim();
  const source = String(hit.source || "").trim();
  const snippet = normalizeReplySnippet(hit.snippet || "");
  const sessionId = String(hit.sessionId || "").trim();
  const taskId = Number(hit.taskId || 0);
  const taskLinks = normalizeTaskLinks(hit.taskLinks);
  const at = Number(hit.at || 0);
  return {
    workerId,
    source,
    snippet,
    sessionId,
    taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
    taskLinks,
    at: Number.isFinite(at) && at > 0 ? at : 0,
  };
}

function summarizeTelegramMessageForReplyContext(msg) {
  const text = String(msg?.text || "").trim();
  if (text) {
    return { source: "text", snippet: text };
  }

  const caption = String(msg?.caption || "").trim();
  const photo = Array.isArray(msg?.photo) && msg.photo.length > 0;
  const imageDoc = Boolean(msg?.document && String(msg.document.mime_type || "").toLowerCase().startsWith("image/"));
  if (photo || imageDoc) {
    const fileName = String(msg?.document?.file_name || "").trim();
    const lead = photo ? "[image]" : `[image document${fileName ? `: ${fileName}` : ""}]`;
    return { source: "image", snippet: caption ? `${lead}\n${caption}` : lead };
  }

  const voice = msg?.voice || null;
  if (voice && typeof voice === "object") {
    const sec = Number(voice.duration || 0);
    const lead = sec > 0 ? `[voice ${Math.round(sec)}s]` : "[voice]";
    return { source: "voice", snippet: caption ? `${lead}\n${caption}` : lead };
  }

  const audio = msg?.audio || null;
  if (audio && typeof audio === "object") {
    const sec = Number(audio.duration || 0);
    const title = String(audio.title || "").trim();
    const performer = String(audio.performer || "").trim();
    const label = [performer, title].filter(Boolean).join(" - ");
    const lead = sec > 0
      ? `[audio ${Math.round(sec)}s${label ? `: ${label}` : ""}]`
      : `[audio${label ? `: ${label}` : ""}]`;
    return { source: "audio", snippet: caption ? `${lead}\n${caption}` : lead };
  }

  const doc = msg?.document || null;
  if (doc && typeof doc === "object") {
    const fileName = String(doc.file_name || "").trim();
    const mime = String(doc.mime_type || "").trim();
    const lead = `[document${fileName ? `: ${fileName}` : mime ? `: ${mime}` : ""}]`;
    return { source: "document", snippet: caption ? `${lead}\n${caption}` : lead };
  }

  const sticker = msg?.sticker || null;
  if (sticker && typeof sticker === "object") {
    const emoji = String(sticker.emoji || "").trim();
    return { source: "sticker", snippet: emoji ? `[sticker ${emoji}]` : "[sticker]" };
  }

  const contact = msg?.contact || null;
  if (contact && typeof contact === "object") {
    const name = [String(contact.first_name || "").trim(), String(contact.last_name || "").trim()].filter(Boolean).join(" ").trim();
    return { source: "contact", snippet: name ? `[contact: ${name}]` : "[contact]" };
  }

  const location = msg?.location || null;
  if (location && typeof location === "object") {
    return { source: "location", snippet: "[location]" };
  }

  return { source: "message", snippet: "[non-text message]" };
}

function isImageRelatedReplyContext(replyContext) {
  const source = String(replyContext?.source || "").trim().toLowerCase();
  if (!source) return false;
  return (
    source === "image" ||
    source === "bot-photo" ||
    source === "user-image" ||
    source === "user-image-caption" ||
    source === "image-caption" ||
    source === "image-followup" ||
    source === "image-saved" ||
    source === "ask-image" ||
    source === "see-screenshot"
  );
}

function buildReplyContextFromIncomingMessage(msg) {
  const chatId = String(msg?.chat?.id || "").trim();
  const reply = msg?.reply_to_message;
  if (!chatId || !reply || typeof reply !== "object") return null;

  const messageId = Number(reply.message_id || 0);
  if (!Number.isFinite(messageId) || messageId <= 0) return null;

  const storedRoute = lookupReplyRouteEntry(chatId, messageId);
  const storedMeta = getMessageMetaEntry(chatId, messageId);
  const workerCandidate = String(
    (storedRoute && storedRoute.workerId) ||
      (storedMeta && storedMeta.workerId) ||
      "",
  ).trim();
  const workerId = workerCandidate && orchWorkers[workerCandidate]
    ? workerCandidate
    : "";
  const summary = summarizeTelegramMessageForReplyContext(reply);
  const snippet = normalizeReplySnippet(
    (storedRoute && storedRoute.snippet) ||
      (storedMeta && storedMeta.snippet) ||
      summary.snippet ||
      "",
  );
  const source = String(
    (storedRoute && storedRoute.source) ||
      (storedMeta && storedMeta.source) ||
      summary.source ||
      "message",
  ).trim().toLowerCase() || "message";
  const from = String((storedMeta && storedMeta.from) || senderLabel(reply)).trim();
  const fromIsBot = storedMeta
    ? storedMeta.fromIsBot === true
    : reply?.from?.is_bot === true;
  const taskId = Number((storedRoute && storedRoute.taskId) || (storedMeta && storedMeta.taskId) || 0);
  const sessionId = String(
    (storedRoute && storedRoute.sessionId) ||
      (storedMeta && storedMeta.sessionId) ||
      "",
  ).trim();
  const taskLinks = mergeTaskLinks(
    normalizeTaskLinks(storedRoute?.taskLinks),
    normalizeTaskLinks(storedMeta?.taskLinks),
  );

  return {
    messageId,
    workerId,
    source,
    snippet,
    from,
    fromIsBot,
    at: Number((storedRoute && storedRoute.at) || (storedMeta && storedMeta.at) || 0),
    taskId,
    sessionId,
    taskLinks: mergeTaskLinks(
      taskLinks,
      normalizeTaskLinks([
        {
          taskId,
          workerId,
          sessionId,
        },
      ]),
    ),
  };
}

function trimContextBlock(text, maxChars, truncatedLead = "[...older context truncated]") {
  const src = String(text || "").trim();
  const lim = Number(maxChars || 0);
  if (!src || !Number.isFinite(lim) || lim <= 0 || src.length <= lim) return src;
  const budget = Math.max(40, lim - truncatedLead.length - 1);
  return `${truncatedLead}\n${src.slice(src.length - budget).trimStart()}`.trim();
}

function formatMessageContextLine(item) {
  const messageId = Number(item?.messageId || 0);
  const idLabel = Number.isFinite(messageId) && messageId > 0 ? `#${Math.trunc(messageId)}` : "#?";
  const from = String(item?.from || "").trim() || "unknown";
  const source = String(item?.source || "").trim() || "message";
  const snippet = normalizeReplySnippet(item?.snippet || "") || "[no content]";
  const role = String(item?.role || "").trim().toLowerCase();
  const roleLabel = role === "assistant" || role === "bot"
    ? "assistant"
    : role === "user"
      ? "user"
      : item?.fromIsBot === true
        ? "assistant"
        : "user";
  return `- ${idLabel} ${roleLabel} ${from} (${source}): ${snippet}`;
}

function buildReplyThreadContextFromIncomingMessage(msg) {
  const chatId = String(msg?.chat?.id || "").trim();
  const reply = msg?.reply_to_message;
  if (!chatId || !reply || typeof reply !== "object") return null;

  const maxDepth = Math.max(1, ORCH_THREAD_CONTEXT_MAX_DEPTH);
  const visited = new Set();
  const chain = [];
  let cursorMsg = reply;
  let cursorId = Number(reply?.message_id || 0);
  let depth = 0;

  while (depth < maxDepth) {
    if (!Number.isFinite(cursorId) || cursorId <= 0) break;
    const id = Math.trunc(cursorId);
    if (visited.has(id)) break;
    visited.add(id);

    const stored = getMessageMetaEntry(chatId, id);
    const summary = cursorMsg ? summarizeTelegramMessageForReplyContext(cursorMsg) : null;
    const source = String((stored && stored.source) || (summary && summary.source) || "message").trim().toLowerCase() || "message";
    const snippet = normalizeReplySnippet((stored && stored.snippet) || (summary && summary.snippet) || "") || "[no content]";
    const from = String((stored && stored.from) || (cursorMsg ? senderLabel(cursorMsg) : "") || "unknown").trim() || "unknown";
    const fromIsBot = stored
      ? stored.fromIsBot === true
      : cursorMsg?.from?.is_bot === true;
    const role = String(stored?.role || "").trim().toLowerCase() || (fromIsBot ? "assistant" : "user");
    const taskLinks = mergeTaskLinks(
      normalizeTaskLinks(stored?.taskLinks),
      normalizeTaskLinks([
        {
          taskId: Number(stored?.taskId || 0),
          workerId: String(stored?.workerId || "").trim(),
          sessionId: String(stored?.sessionId || "").trim(),
        },
      ]),
    );

    let parentMessageId = 0;
    const directParent = Number(cursorMsg?.reply_to_message?.message_id || 0);
    if (Number.isFinite(directParent) && directParent > 0) {
      parentMessageId = Math.trunc(directParent);
    } else {
      const storedParent = Number(stored?.parentMessageId || 0);
      parentMessageId = Number.isFinite(storedParent) && storedParent > 0 ? Math.trunc(storedParent) : 0;
    }

    chain.push({
      messageId: id,
      parentMessageId,
      source,
      snippet,
      from,
      fromIsBot,
      role,
      taskLinks,
    });

    if (cursorMsg?.reply_to_message && typeof cursorMsg.reply_to_message === "object") {
      cursorMsg = cursorMsg.reply_to_message;
      const nextId = Number(cursorMsg?.message_id || 0);
      cursorId = Number.isFinite(nextId) && nextId > 0 ? Math.trunc(nextId) : parentMessageId;
    } else {
      cursorMsg = null;
      cursorId = parentMessageId;
    }
    depth += 1;
  }

  if (chain.length === 0) return null;
  const ordered = [...chain].reverse();
  const lines = ordered.map((x) => formatMessageContextLine(x));
  const text = trimContextBlock(lines.join("\n"), ORCH_THREAD_CONTEXT_MAX_CHARS);
  const allTaskLinks = normalizeTaskLinks(ordered.flatMap((x) => x.taskLinks || []));
  return {
    depth: ordered.length,
    items: ordered,
    text,
    taskLinks: allTaskLinks,
    messageIds: ordered.map((x) => Number(x.messageId || 0)).filter((x) => Number.isFinite(x) && x > 0),
  };
}

function buildRecentHistoryContext(chatId, { excludeMessageIds = [], limit = ORCH_RECENT_CONTEXT_MESSAGES } = {}) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const maxRows = Math.max(0, Number(limit || 0));
  if (maxRows <= 0) return null;
  const byChat = orchMessageMetaByChat[key];
  if (!byChat || typeof byChat !== "object") return null;
  const exclude = new Set(
    (Array.isArray(excludeMessageIds) ? excludeMessageIds : [])
      .map((x) => Number(x || 0))
      .filter((x) => Number.isFinite(x) && x > 0)
      .map((x) => Math.trunc(x)),
  );

  const rows = Object.values(byChat)
    .filter((x) => x && typeof x === "object")
    .filter((x) => {
      const id = Number(x.messageId || 0);
      if (!Number.isFinite(id) || id <= 0) return false;
      return !exclude.has(Math.trunc(id));
    })
    .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
  if (rows.length === 0) return null;

  const tail = rows.slice(Math.max(0, rows.length - maxRows));
  const items = tail.map((x) => ({
    messageId: Number(x.messageId || 0),
    parentMessageId: Number(x.parentMessageId || 0),
    source: String(x.source || "").trim().toLowerCase() || "message",
    snippet: normalizeReplySnippet(x.snippet || "") || "[no content]",
    from: String(x.from || "").trim() || "unknown",
    fromIsBot: x.fromIsBot === true,
    role: String(x.role || "").trim().toLowerCase() || (x.fromIsBot === true ? "assistant" : "user"),
  }));
  const lines = items.map((x) => formatMessageContextLine(x));
  const text = trimContextBlock(lines.join("\n"), ORCH_RECENT_CONTEXT_MAX_CHARS, "[...older recent history truncated]");
  return {
    items,
    text,
    count: items.length,
  };
}

function recordReplyRoute(chatId, messageId, workerId, context = {}) {
  const chatKey = String(chatId || "").trim();
  const msgKey = String(messageId || "").trim();
  const wid = String(workerId || "").trim();
  if (!chatKey || !msgKey || !wid) return;
  if (!orchWorkers[wid]) return;

  const prev = orchReplyRouteByChat[chatKey] && typeof orchReplyRouteByChat[chatKey] === "object"
    ? orchReplyRouteByChat[chatKey]
    : {};
  const current = prev[msgKey] && typeof prev[msgKey] === "object" ? prev[msgKey] : {};
  const sourceRaw = Object.prototype.hasOwnProperty.call(context, "source") ? context.source : current.source;
  const snippetRaw = Object.prototype.hasOwnProperty.call(context, "snippet") ? context.snippet : current.snippet;
  const taskIdRaw = Object.prototype.hasOwnProperty.call(context, "taskId") ? context.taskId : current.taskId;
  const sessionIdRaw = Object.prototype.hasOwnProperty.call(context, "sessionId") ? context.sessionId : current.sessionId;
  const taskLinksRaw = Object.prototype.hasOwnProperty.call(context, "taskLinks") ? context.taskLinks : current.taskLinks;

  const source = String(sourceRaw || "").trim().toLowerCase();
  const snippet = normalizeReplySnippet(snippetRaw || "");
  const taskId = Number(taskIdRaw || 0);
  const sessionId = String(sessionIdRaw || "").trim();
  const mergedTaskLinks = mergeTaskLinks(
    normalizeTaskLinks(taskLinksRaw),
    normalizeTaskLinks([
      {
        taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
        workerId: wid,
        sessionId,
      },
    ]),
  );

  const entry = {
    workerId: wid,
    at: Date.now(),
  };
  if (source) entry.source = source;
  if (snippet) entry.snippet = snippet;
  if (Number.isFinite(taskId) && taskId > 0) entry.taskId = Math.trunc(taskId);
  if (sessionId) entry.sessionId = sessionId;
  if (mergedTaskLinks.length > 0) entry.taskLinks = mergedTaskLinks;
  prev[msgKey] = entry;
  orchReplyRouteByChat[chatKey] = prev;

  recordMessageMeta(
    chatKey,
    msgKey,
    {
      source,
      snippet,
      workerId: wid,
      taskId,
      sessionId,
      taskLinks: mergedTaskLinks,
    },
    { persist: false },
  );

  // Best-effort cleanup: keep the most recent ~600 per chat and drop very old entries.
  const entries = Object.entries(prev);
  if (entries.length > 700) {
    entries.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
    const keep = new Set(entries.slice(0, 600).map((x) => x[0]));
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const next = {};
    for (const [k, v] of entries) {
      const at = Number(v?.at || 0);
      if (!keep.has(k)) continue;
      if (Number.isFinite(at) && at > 0 && at < cutoff) continue;
      next[k] = v;
    }
    orchReplyRouteByChat[chatKey] = next;
  }

  persistState();
}

function lookupReplyRouteWorker(chatId, messageId) {
  const hit = lookupReplyRouteEntry(chatId, messageId);
  if (!hit) return "";
  const wid = String(hit.workerId || "").trim();
  return wid && orchWorkers[wid] ? wid : "";
}

async function acquireRouterSlot() {
  if (routerInFlight < ORCH_ROUTER_MAX_CONCURRENCY) {
    routerInFlight += 1;
    return;
  }
  await new Promise((resolve) => routerWaiters.push(resolve));
  routerInFlight += 1;
}

function releaseRouterSlot() {
  routerInFlight = Math.max(0, routerInFlight - 1);
  const next = routerWaiters.shift();
  if (typeof next === "function") next();
}

function buildRouterPrompt({
  userText,
  activeWorkerId,
  replyHintWorkerId,
  workers,
  cap,
  splitEnabled = false,
  splitMaxTasks = 0,
  replyContext = null,
  replyThreadContext = null,
  recentHistoryContext = null,
}) {
  const safeUserText = String(userText || "").trim();
  const lines = [
    `Max workers: ${Number(cap) || ORCH_MAX_CODEX_WORKERS}`,
    `Active worker: ${String(activeWorkerId || "").trim() || ORCH_GENERAL_WORKER_ID}`,
    `Split routing: ${splitEnabled ? `enabled (max tasks ${Number(splitMaxTasks) || ORCH_SPLIT_MAX_TASKS})` : "disabled"}`,
    replyHintWorkerId ? `Reply hint worker (strong signal): ${String(replyHintWorkerId || "").trim()}` : "",
    "",
    "Workers:",
  ].filter(Boolean);

  for (const w of Array.isArray(workers) ? workers : []) {
    const workdir = String(w?.workdir || "").replace(/\\/g, "/");
    lines.push(`- ${w.id} | kind=${w.kind} | name=${String(w?.name || "").trim()} | title=${w.title} | workdir=${workdir}`);
  }

  if (replyContext && typeof replyContext === "object") {
    const replyMessageId = Number(replyContext.messageId || 0);
    const replySource = String(replyContext.source || "").trim();
    const replyFrom = String(replyContext.from || "").trim();
    const replySnippet = normalizeReplySnippet(replyContext.snippet || "");
    lines.push("", "Reply context:");
    if (Number.isFinite(replyMessageId) && replyMessageId > 0) {
      lines.push(`- Replied message id: ${Math.trunc(replyMessageId)}`);
    }
    if (replyFrom) {
      lines.push(`- Replied sender: ${replyFrom}${replyContext.fromIsBot === true ? " (bot)" : ""}`);
    }
    if (replySource) {
      lines.push(`- Replied type: ${replySource}`);
    }
    if (replySnippet) {
      lines.push("- Replied content:");
      lines.push(replySnippet);
    }
  }

  const threadText = String(replyThreadContext?.text || "").trim();
  if (threadText) {
    lines.push("", "Reply thread context (oldest -> newest):", threadText);
  }

  const recentText = String(recentHistoryContext?.text || "").trim();
  if (recentText) {
    lines.push("", "Recent chat context:", recentText);
  }

  lines.push("", "User message:", safeUserText);
  return lines.join("\n");
}

function parseRouterOutput(text) {
  const src = String(text || "").trim();
  if (!src) return null;

  let routeLine = "";
  const lines = src.split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;
    if (/^ROUTE\s*:/i.test(line)) {
      routeLine = line;
      break;
    }
  }
  if (!routeLine) {
    const idx = src.toUpperCase().lastIndexOf("ROUTE:");
    if (idx >= 0) {
      routeLine = String(src.slice(idx).split(/\r?\n/)[0] || "").trim();
    }
  }
  if (!routeLine) return null;

  const after = routeLine.replace(/^ROUTE\s*:\s*/i, "").trim();
  const start = after.indexOf("{");
  const end = after.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const jsonText = after.slice(start, end + 1);

  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const decision = String(obj.decision || "").trim();
  const workerId = String(obj.worker_id || "").trim();
  const workdir = String(obj.workdir || "").trim();
  const title = String(obj.title || "").trim();
  const question = String(obj.question || "").trim();
  const tasks = Array.isArray(obj.tasks)
    ? obj.tasks
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          workerId: String(item.worker_id || "").trim(),
          workdir: String(item.workdir || "").trim(),
          title: String(item.title || "").trim(),
          prompt: String(item.prompt || "").trim(),
        };
      })
      .filter(Boolean)
    : [];
  if (!decision) return null;

  return { decision, workerId, workdir, title, question, tasks, raw: obj };
}

async function runRouterDecision(
  chatId,
  userText,
  {
    activeWorkerId = "",
    replyHintWorkerId = "",
    replyContext = null,
    replyThreadContext = null,
    recentHistoryContext = null,
  } = {},
) {
  if (!ORCH_ROUTER_ENABLED) return null;
  const workers = listCodexWorkers();
  if (workers.length <= 1) {
    return {
      decision: "use",
      workerId: ORCH_GENERAL_WORKER_ID,
      workdir: "",
      title: "",
      question: "",
      tasks: [],
    };
  }

  const prompt = buildRouterPrompt({
    userText,
    activeWorkerId: String(activeWorkerId || "").trim() || getActiveWorkerForChat(chatId),
    replyHintWorkerId: String(replyHintWorkerId || "").trim(),
    workers,
    cap: ORCH_MAX_CODEX_WORKERS,
    splitEnabled: ORCH_SPLIT_ENABLED,
    splitMaxTasks: ORCH_SPLIT_MAX_TASKS,
    replyContext: replyContext && typeof replyContext === "object" ? replyContext : null,
    replyThreadContext: replyThreadContext && typeof replyThreadContext === "object" ? replyThreadContext : null,
    recentHistoryContext: recentHistoryContext && typeof recentHistoryContext === "object" ? recentHistoryContext : null,
  });

  const outputFile = path.join(OUT_DIR, `router-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const job = {
    id: routerSequence++,
    chatId: "", // router should ignore per-chat model overrides
    text: prompt,
    source: "router",
    kind: "codex",
    workerId: ORCH_GENERAL_WORKER_ID,
    replyStyle: "router",
    resumeSessionId: "",
    model: ORCH_ROUTER_MODEL,
    reasoning: ORCH_ROUTER_REASONING_EFFORT,
    imagePaths: [],
    workdir: String(getCodexWorker(ORCH_GENERAL_WORKER_ID)?.workdir || CODEX_WORKDIR || ROOT).trim() || ROOT,
    replyToMessageId: 0,
    startedAt: Date.now(),
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    timeoutMs: ORCH_ROUTER_TIMEOUT_MS,
    outputFile,
  };

  await acquireRouterSlot();
  try {
    const result = await runCodexJob(job);
    if (!result || !result.ok) {
      return null;
    }
    return parseRouterOutput(String(result.text || ""));
  } finally {
    releaseRouterSlot();
    try {
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch {
      // best effort
    }
  }
}

function buildWorkerRetireKeyboard() {
  const candidates = listCodexWorkers().filter((w) => w.id !== ORCH_GENERAL_WORKER_ID);
  const rows = [];
  for (const w of candidates) {
    const displayName = String(w.name || "").trim() || String(w.title || "").trim() || w.id;
    const context = String(w.title || "").trim();
    const label = context && context !== displayName ? `${displayName} (${context})` : displayName;
    rows.push([{ text: `Retire ${w.id}: ${label}`, callback_data: `orch_retire:${w.id}` }]);
  }
  rows.push([{ text: "Cancel", callback_data: "orch_retire_cancel" }]);
  return { inline_keyboard: rows };
}

function dedupeRouteAssignments(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const workerId = String(raw?.workerId || "").trim();
    const prompt = String(raw?.prompt || "").trim();
    if (!workerId || !prompt) continue;
    const key = `${workerId}\u0000${prompt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ workerId, prompt });
  }
  return out;
}

function describeWorkerForDelegation(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return "";
  const worker = getCodexWorker(wid);
  if (!worker) return wid;
  const name = String(worker.name || "").trim();
  const title = String(worker.title || "").trim();
  if (name && title && title !== name) return `${name} (${wid}, ${title})`;
  if (name) return `${name} (${wid})`;
  return title ? `${wid} (${title})` : wid;
}

function summarizeDelegationQueueState(assignments) {
  const rows = dedupeRouteAssignments(assignments);
  const laneStateByWorker = new Map();
  let queuedCount = 0;

  for (const row of rows) {
    const wid = String(row.workerId || "").trim();
    if (!wid) continue;

    let state = laneStateByWorker.get(wid);
    if (!state) {
      const lane = getLane(wid) || ensureWorkerLane(wid);
      state = {
        busy: Boolean(lane?.currentJob),
        queued: Array.isArray(lane?.queue) ? lane.queue.length : 0,
      };
    }

    const willQueue = state.busy || state.queued > 0;
    if (willQueue) {
      queuedCount += 1;
      state.queued += 1;
    } else {
      state.busy = true;
    }
    laneStateByWorker.set(wid, state);
  }

  const total = rows.length;
  const inProgressCount = Math.max(0, total - queuedCount);
  return {
    total,
    queuedCount,
    inProgressCount,
    allQueued: total > 0 && queuedCount === total,
    allInProgress: total > 0 && queuedCount === 0,
    mixed: total > 0 && queuedCount > 0 && inProgressCount > 0,
  };
}

function buildDelegationAckText(assignments, stateSummary = null) {
  const rows = dedupeRouteAssignments(assignments);
  if (rows.length === 0) return "";
  const summary = stateSummary && typeof stateSummary === "object"
    ? stateSummary
    : summarizeDelegationQueueState(rows);
  const isQueued = Boolean(summary.allQueued);
  if (rows.length === 1) {
    const label = describeWorkerForDelegation(rows[0].workerId);
    return label
      ? `Got it. I delegated this to ${label}, and it is now ${isQueued ? "in queue" : "in progress"}.`
      : `Got it. I delegated this request, and it is now ${isQueued ? "in queue" : "in progress"}.`;
  }
  const labels = [];
  const seen = new Set();
  for (const x of rows) {
    const label = describeWorkerForDelegation(x.workerId);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (summary.mixed) {
    const lead = `Got it. I delegated this into ${rows.length} parallel tasks; ${summary.inProgressCount} are now in progress and ${summary.queuedCount} are in queue.`;
    if (labels.length === 0) return lead;
    return `${lead}\n- ${labels.join("\n- ")}`;
  }
  const stateWord = summary.allQueued ? "in queue" : "in progress";
  if (labels.length === 0) {
    return `Got it. I delegated this into ${rows.length} parallel tasks, and they are now ${stateWord}.`;
  }
  return `Got it. I delegated this into ${rows.length} parallel tasks, and they are now ${stateWord}:\n- ${labels.join("\n- ")}`;
}

function buildUseDecision(workerId, prompt) {
  const wid = String(workerId || "").trim() || ORCH_GENERAL_WORKER_ID;
  const text = String(prompt || "").trim();
  return {
    decision: "use",
    assignments: [{ workerId: wid, prompt: text }],
    question: "",
  };
}

async function resolveRouteTask(task, { fallbackWorkerId = "", defaultPrompt = "" } = {}) {
  const fallback = String(fallbackWorkerId || "").trim() || ORCH_GENERAL_WORKER_ID;
  const defaultText = String(defaultPrompt || "").trim();
  const taskPrompt = String(task?.prompt || "").trim() || defaultText;
  const requestedWorkerId = String(task?.workerId || task?.worker_id || "").trim();
  if (requestedWorkerId && orchWorkers[requestedWorkerId]) {
    return buildUseDecision(requestedWorkerId, taskPrompt);
  }

  const workdirRaw = String(task?.workdir || "").trim();
  const title = String(task?.title || "").trim();
  if (workdirRaw) {
    const resolved = resolveWorkdirInput(workdirRaw);
    if (!resolved || !fs.existsSync(resolved)) {
      return {
        decision: "ask",
        assignments: [],
        workerId: "",
        question: "I could not find that path on disk. What is the correct local path?",
      };
    }

    const existing = findWorkerByWorkdir(resolved);
    if (existing) {
      return buildUseDecision(existing, taskPrompt);
    }

    const workerCount = listCodexWorkers().length;
    if (workerCount >= ORCH_MAX_CODEX_WORKERS) {
      return {
        decision: "need_retire",
        assignments: [],
        workerId: "",
        workdir: resolved,
        title: title || path.basename(resolved) || "Repo",
      };
    }

    let newId = "";
    try {
      newId = createRepoWorker(resolved, title);
    } catch {
      return {
        decision: "ask",
        assignments: [],
        workerId: "",
        question: "I could not create a new workspace for that path. Can you confirm the path and try again?",
      };
    }
    return buildUseDecision(newId, taskPrompt);
  }

  return buildUseDecision(fallback, taskPrompt);
}

async function decideRoutePlanForPrompt(
  chatId,
  userText,
  {
    replyHintWorkerId = "",
    allowSplit = true,
    replyContext = null,
    replyThreadContext = null,
    recentHistoryContext = null,
  } = {},
) {
  const text = String(userText || "").trim();
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const replyHint = String(replyHintWorkerId || "").trim();
  const fallback = replyHint && orchWorkers[replyHint] ? replyHint : activeWorkerId || ORCH_GENERAL_WORKER_ID;

  const route = await runRouterDecision(chatId, text, {
    activeWorkerId,
    replyHintWorkerId: replyHint,
    replyContext,
    replyThreadContext,
    recentHistoryContext,
  }).catch(() => null);
  if (!route) {
    return buildUseDecision(fallback, text);
  }

  const decision = String(route.decision || "").trim().toLowerCase();
  if (decision === "ask") {
    const q = String(route.question || "").trim();
    return {
      decision: "ask",
      assignments: [],
      workerId: "",
      question: q || "Which workspace should I use for this?",
    };
  }

  if (decision === "use") {
    const resolved = await resolveRouteTask(
      { workerId: String(route.workerId || "").trim(), prompt: text },
      { fallbackWorkerId: fallback, defaultPrompt: text },
    );
    return resolved;
  }

  if (decision === "spawn_repo") {
    const workdirRaw = String(route.workdir || "").trim();
    if (!workdirRaw) {
      return {
        decision: "ask",
        assignments: [],
        workerId: "",
        question: "What is the local path to the repo/workspace?",
      };
    }
    const resolved = await resolveRouteTask(
      {
        workdir: workdirRaw,
        title: String(route.title || "").trim(),
        prompt: text,
      },
      { fallbackWorkerId: fallback, defaultPrompt: text },
    );
    if (resolved.decision === "ask" && !resolved.question) {
      return {
        decision: "ask",
        assignments: [],
        workerId: "",
        question: "What is the local path to the repo/workspace?",
      };
    }
    return resolved;
  }

  if (decision === "split" && allowSplit && ORCH_SPLIT_ENABLED) {
    const rawTasks = Array.isArray(route.tasks) ? route.tasks : [];
    const limitedTasks = rawTasks.slice(0, ORCH_SPLIT_MAX_TASKS);
    const assignments = [];

    for (const task of limitedTasks) {
      const resolved = await resolveRouteTask(task, { fallbackWorkerId: fallback, defaultPrompt: text });
      if (resolved.decision === "ask" || resolved.decision === "need_retire") return resolved;
      if (resolved.decision !== "use") continue;
      for (const assignment of Array.isArray(resolved.assignments) ? resolved.assignments : []) {
        assignments.push(assignment);
      }
    }

    const deduped = dedupeRouteAssignments(assignments);
    if (deduped.length >= 2) {
      return {
        decision: "split",
        assignments: deduped,
        workerId: "",
        question: "",
      };
    }
    if (deduped.length === 1) {
      return {
        decision: "use",
        assignments: deduped,
        workerId: deduped[0].workerId,
        question: "",
      };
    }
  }

  // Unknown or unusable router output; fall back.
  return buildUseDecision(fallback, text);
}

async function routeAndEnqueuePrompt(chatId, userText, source, options = {}) {
  const replyToMessageId = Number(options?.replyToMessageId || 0);
  const replyHintWorkerId = String(options?.replyHintWorkerId || "").trim();
  const replyContext = options?.replyContext && typeof options.replyContext === "object"
    ? options.replyContext
    : null;
  const replyThreadContext = options?.replyThreadContext && typeof options.replyThreadContext === "object"
    ? options.replyThreadContext
    : null;
  const recentHistoryContext = options?.recentHistoryContext && typeof options.recentHistoryContext === "object"
    ? options.recentHistoryContext
    : null;
  const originMessageId = Number(options?.originMessageId || 0);
  const originSource = String(options?.originSource || "").trim();
  const originSnippet = String(options?.originSnippet || "").trim();
  const src = String(source || "").trim().toLowerCase();
  const allowSplit = src !== "voice" && src !== "whisper";
  const decision = await decideRoutePlanForPrompt(chatId, userText, {
    replyHintWorkerId,
    allowSplit,
    replyContext,
    replyThreadContext,
    recentHistoryContext,
  });

  if (decision.decision === "ask") {
    await sendMessage(chatId, decision.question || "Which workspace should I use?", {
      replyToMessageId,
    });
    return false;
  }

  if (decision.decision === "need_retire") {
    const workdir = String(decision.workdir || "").trim();
    const title = String(decision.title || "").trim();
    orchPendingSpawnByChat.set(String(chatId || "").trim(), {
      desiredWorkdir: workdir,
      title,
      promptText: String(userText || ""),
      source: String(source || "").trim(),
      options: { ...options },
      createdAt: Date.now(),
    });

    await sendMessage(
      chatId,
      `Worker limit reached (${ORCH_MAX_CODEX_WORKERS}). Pick a worker to retire so I can create a new workspace for:\n- title: ${title}\n- workdir: ${String(workdir || "").replace(/\\\\/g, "/")}`,
      {
        replyToMessageId,
        replyMarkup: buildWorkerRetireKeyboard(),
      },
    );
    return false;
  }

  const assignmentsRaw = Array.isArray(decision.assignments) ? decision.assignments : [];
  const assignments = dedupeRouteAssignments(assignmentsRaw);
  if (assignments.length === 0) {
    const fallbackWorkerId = getActiveWorkerForChat(chatId) || ORCH_GENERAL_WORKER_ID;
    assignments.push({ workerId: fallbackWorkerId, prompt: String(userText || "").trim() });
  }

  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() + assignments.length > MAX_QUEUE_SIZE) {
    await sendMessage(
      chatId,
      `Queue is full (${MAX_QUEUE_SIZE}). Need room for ${assignments.length} job(s). Use /queue or /clear.`,
      { replyToMessageId },
    );
    return false;
  }

  const splitGroupId = assignments.length > 1
    ? `split-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : "";
  const assignmentsWithTasks = assignments.map((assignment) => {
    const workerId = String(assignment.workerId || "").trim();
    const prompt = String(assignment.prompt || "").trim();
    const taskId = createOrchTask(chatId, {
      workerId,
      prompt,
      source: src || "message",
      originMessageId,
      replyToMessageId,
      splitGroupId,
    });
    return {
      ...assignment,
      workerId,
      prompt,
      taskId,
    };
  });

  if (Number.isFinite(originMessageId) && originMessageId > 0 && assignmentsWithTasks.length > 0) {
    const primaryWorkerId = String(assignmentsWithTasks[0]?.workerId || "").trim();
    const primaryTaskId = Number(assignmentsWithTasks[0]?.taskId || 0);
    const snippet = originSnippet || String(userText || "").trim();
    if (primaryWorkerId) {
      recordReplyRoute(chatId, originMessageId, primaryWorkerId, {
        source: originSource || `user-${src || "message"}`,
        snippet,
        taskId: Number.isFinite(primaryTaskId) && primaryTaskId > 0 ? Math.trunc(primaryTaskId) : 0,
        taskLinks: assignmentsWithTasks.map((x) => ({
          taskId: Number(x.taskId || 0),
          workerId: String(x.workerId || "").trim(),
          sessionId: String(getSessionForChatWorker(chatId, String(x.workerId || "").trim()) || "").trim(),
        })),
      });
    }
  }

  if (ORCH_DELEGATION_ACK_ENABLED) {
    const ackStateSummary = summarizeDelegationQueueState(assignmentsWithTasks);
    const ackText = buildDelegationAckText(assignmentsWithTasks, ackStateSummary);
    if (ackText) {
      const ackWorkerId = assignmentsWithTasks.length === 1 ? String(assignmentsWithTasks[0].workerId || "").trim() : "";
      try {
        await sendMessage(chatId, ackText, {
          replyToMessageId,
          routeWorkerId: ackWorkerId,
          silent: ORCH_DELEGATION_ACK_SILENT,
        });
      } catch (err) {
        log(`sendMessage(delegation-ack) failed: ${redactError(err?.message || err)}`);
      }
    }
  }

  for (const assignment of assignmentsWithTasks) {
    await enqueuePrompt(chatId, assignment.prompt, source, {
      ...options,
      replyContext,
      replyThreadContext,
      recentHistoryContext,
      workerId: assignment.workerId,
      taskId: Number(assignment.taskId || 0),
      splitGroupId,
      originMessageId,
      originSource,
      originSnippet: originSnippet || String(userText || "").trim(),
      replyToMessageId,
      // Don't flip active workspace when one user request fans out to multiple workers.
      setActiveWorker: assignmentsWithTasks.length > 1 ? false : options?.setActiveWorker,
    });
  }
  return true;
}

function getLastImageForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const entry = lastImages[key] || null;
  if (!entry || typeof entry !== "object") return null;
  const filePath = String(entry.path || "").trim();
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return {
    path: filePath,
    mime: String(entry.mime || "").trim(),
    name: String(entry.name || "").trim(),
    at: Number(entry.at || 0),
  };
}

function setLastImageForChat(chatId, info) {
  const key = String(chatId || "").trim();
  if (!key) return;
  lastImages[key] = {
    path: String(info?.path || "").trim(),
    mime: String(info?.mime || "").trim(),
    name: String(info?.name || "").trim(),
    at: Date.now(),
  };
  persistState();
}

function clearLastImageForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in lastImages)) return;
  delete lastImages[key];
  persistState();
}

function isUtcDayKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parseDayKeyLocal(value) {
  const raw = String(value || "").trim();
  if (!isUtcDayKey(raw)) return null;
  const [y, m, d] = raw.split("-").map((x) => Number(x));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(y, m - 1, d);
  if (!Number.isFinite(dt.getTime())) return null;
  if (dt.getFullYear() !== y || dt.getMonth() !== (m - 1) || dt.getDate() !== d) return null;
  return dt;
}

function utcDayKeyFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return "";
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function utcDayKeyNow() {
  return utcDayKeyFromMs(Date.now());
}

function addUtcDays(dayKey, deltaDays) {
  const src = String(dayKey || "").trim();
  const d = parseDayKeyLocal(src);
  if (!d) return "";
  const delta = Math.trunc(Number(deltaDays) || 0);
  d.setDate(d.getDate() + delta);
  return utcDayKeyFromMs(d.getTime());
}

function diffUtcDays(fromDay, toDay) {
  const a = String(fromDay || "").trim();
  const b = String(toDay || "").trim();
  const ad = parseDayKeyLocal(a);
  const bd = parseDayKeyLocal(b);
  if (!ad || !bd) return 0;
  const aSerial = Math.floor(Date.UTC(ad.getFullYear(), ad.getMonth(), ad.getDate()) / (24 * 60 * 60 * 1000));
  const bSerial = Math.floor(Date.UTC(bd.getFullYear(), bd.getMonth(), bd.getDate()) / (24 * 60 * 60 * 1000));
  return bSerial - aSerial;
}

function listUtcDays(startDay, endDay) {
  const start = String(startDay || "").trim();
  const end = String(endDay || "").trim();
  if (!isUtcDayKey(start) || !isUtcDayKey(end)) return [];
  const gap = diffUtcDays(start, end);
  if (gap < 0) return [];
  const out = [];
  for (let i = 0; i <= gap; i += 1) {
    const day = addUtcDays(start, i);
    if (day) out.push(day);
  }
  return out;
}

function getRedditDigestCursorForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return "";
  const entry = redditDigest[key];
  if (!entry || typeof entry !== "object") return "";
  const lastDay = String(entry.lastDay || "").trim();
  return isUtcDayKey(lastDay) ? lastDay : "";
}

function setRedditDigestCursorForChat(chatId, dayKey) {
  const key = String(chatId || "").trim();
  const day = String(dayKey || "").trim();
  if (!key || !isUtcDayKey(day)) return;
  redditDigest[key] = {
    lastDay: day,
    updatedAt: Date.now(),
  };
  persistState();
}

function clearRedditDigestCursorForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in redditDigest)) return;
  delete redditDigest[key];
  persistState();
}

function setActiveSessionForChat(chatId, sessionId, workerId = "") {
  const wid = String(workerId || "").trim() || getActiveWorkerForChat(chatId);
  setSessionForChatWorker(chatId, wid, sessionId);
}

function clearActiveSessionForChat(chatId, workerId = "") {
  const wid = String(workerId || "").trim() || getActiveWorkerForChat(chatId);
  clearSessionForChatWorker(chatId, wid);
}

function normalizePrompt(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const lim = Number(MAX_PROMPT_CHARS);
  if (!Number.isFinite(lim) || lim <= 0) return trimmed;
  if (trimmed.length <= lim) return trimmed;
  return `${trimmed.slice(0, lim)}\n\n[truncated by bot]`;
}

function normalizeResponse(text) {
  const cleaned = String(text || "").trim() || "(empty response)";
  if (MAX_RESPONSE_CHARS <= 0) return cleaned;
  if (cleaned.length <= MAX_RESPONSE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated by bot]`;
}

const PROMPT_FILE_CACHE = new Map();

function readTextFileCached(filePath) {
  const key = String(filePath || "").trim();
  if (!key) return "";
  try {
    const st = fs.statSync(key);
    const prev = PROMPT_FILE_CACHE.get(key);
    if (prev && prev.mtimeMs === st.mtimeMs && typeof prev.text === "string") {
      return prev.text;
    }
    const text = fs.readFileSync(key, "utf8");
    PROMPT_FILE_CACHE.set(key, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return "";
  }
}

function defaultPromptPreamble() {
  return [
    "You are AIDOLON CLI replying via Telegram.",
    "Keep it concise and practical.",
    "If ambiguous, ask one clear follow-up question.",
  ].join("\n");
}

function defaultVoicePromptPreamble() {
  return [
    "You are AIDOLON speaking to the user via a Telegram voice message.",
    "Reply in natural conversational language suitable for text-to-speech.",
    "Do not output code blocks, markdown, commands, stack traces, JSON, or file paths.",
    "Do not include URLs in SPOKEN. URLs are allowed in TEXT_ONLY when useful.",
    "Avoid weird symbols and formatting; use plain words and short sentences.",
    "",
    "Output format:",
    "SPOKEN:",
    "<what you want spoken aloud>",
    "",
    "TEXT_ONLY:",
    "<optional: links, commands, paths, code, or any details that should be sent as text>",
    "If ambiguous, ask one clear follow-up question.",
  ].join("\n");
}

function defaultRouterPromptPreamble() {
  return [
    "You are the AIDOLON router.",
    "Your job: decide worker routing for the user's message.",
    "Do not run tools or do the work. Only route.",
    "",
    "You will be given: the user message, the active worker, and a list of existing workers (some pinned to repos).",
    "Choose an existing worker when possible.",
    "If a new repo worker is needed, only propose one if the user message includes an explicit local path.",
    "If the message clearly contains multiple independent sub-tasks for different workers, you may use decision=split.",
    "For split, output 2+ tasks and keep each prompt short and actionable.",
    "If routing is ambiguous, ask one clarifying question.",
    "",
    "Output exactly one line in this format:",
    "ROUTE: {\"decision\":\"use|spawn_repo|ask|split\",\"worker_id\":\"...\",\"workdir\":\"...\",\"title\":\"...\",\"question\":\"...\",\"tasks\":[{\"worker_id\":\"...\",\"workdir\":\"...\",\"title\":\"...\",\"prompt\":\"...\"}]}",
  ].join("\n");
}

function getPromptPreamble(replyStyle) {
  const style = String(replyStyle || "").trim().toLowerCase();
  const isRouter = style === "router";
  const isVoice = style === "voice" || style === "tts" || style === "spoken";
  const filePath = isRouter
    ? ORCH_ROUTER_PROMPT_FILE
    : isVoice
      ? CODEX_VOICE_PROMPT_FILE
      : CODEX_PROMPT_FILE;
  const fallback = isRouter ? defaultRouterPromptPreamble() : isVoice ? defaultVoicePromptPreamble() : defaultPromptPreamble();
  const fromFile = readTextFileCached(filePath).trim();
  return fromFile || fallback;
}

function formatCodexPrompt(userText, options = {}) {
  const hasImages = options && options.hasImages === true;
  const replyStyle = String(options?.replyStyle || "").trim();
  const workdir = String(options?.workdir || "").trim();
  const workerId = String(options?.workerId || "").trim();
  const replyContext = options?.replyContext && typeof options.replyContext === "object"
    ? options.replyContext
    : null;
  const replyThreadContext = options?.replyThreadContext && typeof options.replyThreadContext === "object"
    ? options.replyThreadContext
    : null;
  const recentHistoryContext = options?.recentHistoryContext && typeof options.recentHistoryContext === "object"
    ? options.recentHistoryContext
    : null;
  const worker = workerId ? getCodexWorker(workerId) : null;
  const workerLabel = worker
    ? String(worker.name || worker.title || worker.id || "").trim() || worker.id
    : workerId || "unknown";
  const workspaceLabel = worker ? `${workerLabel} (${worker.kind})` : workerId || "unknown";

  const lines = [getPromptPreamble(replyStyle)];
  if (workdir) {
    lines.push(`Workspace: ${workspaceLabel}`);
    lines.push(`Working directory: ${workdir}`);
  }
  if (hasImages) {
    lines.push("One or more images are attached. Use them to answer the user.");
  }
  if (replyContext) {
    const replyMessageId = Number(replyContext.messageId || 0);
    const replyFrom = String(replyContext.from || "").trim();
    const replySource = String(replyContext.source || "").trim();
    const replySnippet = normalizeReplySnippet(replyContext.snippet || "");
    const replySessionId = String(replyContext.sessionId || "").trim();
    const replyTaskId = Number(replyContext.taskId || 0);
    const replyTaskLinks = normalizeTaskLinks(replyContext.taskLinks);
    lines.push("", "Reply context:");
    if (Number.isFinite(replyMessageId) && replyMessageId > 0) {
      lines.push(`- The user replied to Telegram message id ${replyMessageId}.`);
    }
    if (replyFrom) {
      const fromBot = replyContext.fromIsBot === true ? " (bot)" : "";
      lines.push(`- Replied-to sender: ${replyFrom}${fromBot}`);
    }
    if (replySource) {
      lines.push(`- Replied-to message type: ${replySource}`);
    }
    if (Number.isFinite(replyTaskId) && replyTaskId > 0) {
      lines.push(`- Replied-to task id: ${Math.trunc(replyTaskId)}`);
    }
    if (replySessionId) {
      lines.push(`- Replied-to session id: ${replySessionId}`);
    }
    if (replyTaskLinks.length > 0) {
      const encoded = replyTaskLinks
        .map((x) => {
          const tid = Number(x.taskId || 0);
          const wid = String(x.workerId || "").trim();
          const sid = String(x.sessionId || "").trim();
          const parts = [];
          if (Number.isFinite(tid) && tid > 0) parts.push(`task=${Math.trunc(tid)}`);
          if (wid) parts.push(`worker=${wid}`);
          if (sid) parts.push(`session=${sid}`);
          return parts.join(",");
        })
        .filter(Boolean)
        .join(" | ");
      if (encoded) lines.push(`- Replied-to task links: ${encoded}`);
    }
    if (replySnippet) {
      lines.push("- Replied-to content:");
      lines.push(replySnippet);
    } else {
      lines.push("- Replied-to content: unavailable");
    }
    lines.push("- If the user uses pronouns like it/that/those, resolve them against this reply context first.");
  }

  const threadText = String(replyThreadContext?.text || "").trim();
  if (threadText) {
    lines.push("", "Reply thread context (oldest -> newest):");
    lines.push(threadText);
  }

  const recentText = String(recentHistoryContext?.text || "").trim();
  if (recentText) {
    lines.push("", "Recent chat context:");
    lines.push(recentText);
  }

  lines.push("", "User message:", userText);
  return lines.join("\n");
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
  const scanLim = Number(RESUME_SCAN_FILE_LIMIT);
  const candidates = Number.isFinite(scanLim) && scanLim > 0
    ? files.slice(0, Math.floor(scanLim))
    : files;

  const listLim = Number(limit);
  const maxOut = Number.isFinite(listLim) && listLim > 0 ? Math.floor(listLim) : Infinity;

  const out = [];
  const seen = new Set();
  for (const entry of candidates) {
    if (out.length >= maxOut) break;
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
      timestamp: timestamp || nowIso(entry.mtimeMs),
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
    commands = ["exec", "review", "resume", "cloud", "features", "login", "logout", "debug"];
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

function buildRawCodexSpec(job) {
  const rawArgs = Array.isArray(job?.rawArgs) ? [...job.rawArgs] : [];
  const workdir = String(job?.workdir || CODEX_WORKDIR || ROOT).trim() || ROOT;
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
    cwd: workdir,
  };
}

function buildCodexExecSpec(job) {
  const rawImagePaths = Array.isArray(job?.imagePaths)
    ? job.imagePaths.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  const replyContext = job?.replyContext && typeof job.replyContext === "object"
    ? {
      messageId: Number(job.replyContext.messageId || 0),
      workerId: String(job.replyContext.workerId || "").trim(),
      source: String(job.replyContext.source || "").trim(),
      snippet: normalizeReplySnippet(job.replyContext.snippet || ""),
      from: String(job.replyContext.from || "").trim(),
      fromIsBot: job.replyContext.fromIsBot === true,
      taskId: Number(job.replyContext.taskId || 0),
      sessionId: String(job.replyContext.sessionId || "").trim(),
      taskLinks: normalizeTaskLinks(job.replyContext.taskLinks),
    }
    : null;
  const replyThreadContext = job?.replyThreadContext && typeof job.replyThreadContext === "object"
    ? {
      text: trimContextBlock(String(job.replyThreadContext.text || ""), ORCH_THREAD_CONTEXT_MAX_CHARS),
    }
    : null;
  const recentHistoryContext = job?.recentHistoryContext && typeof job.recentHistoryContext === "object"
    ? {
      text: trimContextBlock(String(job.recentHistoryContext.text || ""), ORCH_RECENT_CONTEXT_MAX_CHARS, "[...older recent history truncated]"),
    }
    : null;
  const workdir = String(job?.workdir || CODEX_WORKDIR || ROOT).trim() || ROOT;
  const codexWorkdir = codexMode.mode === "wsl" ? toWslPath(workdir) : workdir;
  const promptText = formatCodexPrompt(job.text, {
    hasImages: rawImagePaths.length > 0,
    replyStyle: String(job?.replyStyle || ""),
    workdir,
    workerId: String(job?.workerId || "").trim(),
    replyContext,
    replyThreadContext,
    recentHistoryContext,
  });
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
    args.push("--color", "never", "-C", codexWorkdir, "-o", outputPath);
  }
  const prefs = getChatPrefs(job?.chatId);
  const effectiveModel = String(job?.model || prefs.model || CODEX_MODEL || "").trim();
  const effectiveReasoning = String(job?.reasoning || prefs.reasoning || CODEX_REASONING_EFFORT || "").trim();
  if (effectiveModel) args.push("-m", effectiveModel);
  if (effectiveReasoning) {
    args.push("-c", `model_reasoning_effort=\"${effectiveReasoning}\"`);
  }
  // This project does not use MCP servers. Force-disable MCP even if globally configured.
  args.push("-c", "mcp_servers={}");
  if (!isResume && CODEX_PROFILE) args.push("-p", CODEX_PROFILE);
  if (CODEX_EXTRA_ARGS.length > 0) args.push(...CODEX_EXTRA_ARGS);

  if (rawImagePaths.length > 0) {
    for (const imgPath of rawImagePaths) {
      const resolved = codexMode.mode === "wsl" ? toWslPath(imgPath) : imgPath;
      args.push("-i", resolved);
    }
  }

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
    cwd: workdir,
  };
}

async function telegramApi(method, { query = "", body = null, timeoutMs = TELEGRAM_API_TIMEOUT_MS, signal } = {}) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}${query ? `?${query}` : ""}`;

  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const useTimeout = Number.isFinite(ms) && ms > 0;
  const timer = useTimeout ? setTimeout(() => controller.abort(), ms) : null;
  const combined = combineAbortSignals([controller.signal, signal]);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: combined.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const desc = data.description || JSON.stringify(data);
      throw new Error(`Telegram ${method} failed: ${res.status} ${desc}`);
    }
    return data.result;
  } finally {
    combined.cleanup();
    if (timer) clearTimeout(timer);
  }
}

async function telegramApiMultipart(method, formData, timeoutMs = TELEGRAM_UPLOAD_TIMEOUT_MS, { signal } = {}) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const useTimeout = Number.isFinite(ms) && ms > 0;
  const timer = useTimeout ? setTimeout(() => controller.abort(), ms) : null;
  const combined = combineAbortSignals([controller.signal, signal]);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: combined.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const desc = data.description || JSON.stringify(data);
      throw new Error(`Telegram ${method} failed: ${res.status} ${desc}`);
    }
    return data.result;
  } finally {
    combined.cleanup();
    if (timer) clearTimeout(timer);
  }
}

async function fetchJsonUrl(url, { headers = {}, timeoutMs = 0, signal } = {}) {
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const useTimeout = Number.isFinite(ms) && ms > 0;
  const timer = useTimeout ? setTimeout(() => controller.abort(), ms) : null;
  const combined = combineAbortSignals([controller.signal, signal]);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: combined.signal,
    });
    const data = await res.json().catch(() => null);
    if (data === null) {
      throw new Error(`${res.status} Invalid JSON response`);
    }
    if (!res.ok) {
      const reason = data && typeof data === "object"
        ? String(data.message || data.error || JSON.stringify(data))
        : String(res.statusText || "request failed");
      throw new Error(`${res.status} ${reason}`.trim());
    }
    return data;
  } finally {
    combined.cleanup();
    if (timer) clearTimeout(timer);
  }
}

function redditTopWindowForLookback(days) {
  const d = Math.max(1, Math.trunc(Number(days) || 1));
  if (d <= 1) return "day";
  if (d <= 7) return "week";
  if (d <= 31) return "month";
  if (d <= 365) return "year";
  return "all";
}

function normalizeRedditTopPost(item, subreddit) {
  const data = item && typeof item === "object" && item.data && typeof item.data === "object"
    ? item.data
    : null;
  if (!data) return null;
  if (data.stickied) return null;

  const title = oneLine(String(data.title || ""));
  if (!title) return null;
  const lowerTitle = title.toLowerCase();
  if (lowerTitle === "[removed]" || lowerTitle === "[deleted]") return null;

  const createdUtc = Number(data.created_utc || 0);
  if (!Number.isFinite(createdUtc) || createdUtc <= 0) return null;
  const createdAtMs = Math.round(createdUtc * 1000);
  const day = utcDayKeyFromMs(createdAtMs);
  if (!day) return null;

  let snippet = oneLine(String(data.selftext || ""));
  if (snippet.length > 220) snippet = `${snippet.slice(0, 217)}...`;

  const score = Number(data.score || 0);
  const comments = Number(data.num_comments || 0);
  const permalink = String(data.permalink || "").trim();
  const redditUrl = permalink ? `https://www.reddit.com${permalink}` : "";
  const rawUrl = String(data.url_overridden_by_dest || data.url || "").trim();
  const externalUrl = rawUrl && !/^https?:\/\/(?:old\.|www\.)?reddit\.com\//i.test(rawUrl)
    ? rawUrl
    : "";
  const canonicalUrl = externalUrl || redditUrl || rawUrl;

  return {
    subreddit,
    id: String(data.id || "").trim(),
    title,
    day,
    createdAtMs,
    score: Number.isFinite(score) ? score : 0,
    comments: Number.isFinite(comments) ? comments : 0,
    permalink: redditUrl || rawUrl,
    link: canonicalUrl,
    redditUrl,
    externalUrl,
    snippet,
  };
}

async function fetchTopPostsForSubreddit(subreddit, { signal, topWindow } = {}) {
  const sub = normalizeSubredditName(subreddit);
  if (!sub) throw new Error("Invalid subreddit name");

  const requestedWindow = String(topWindow || "").trim().toLowerCase();
  const effectiveTopWindow = ["day", "week", "month", "year", "all"].includes(requestedWindow)
    ? requestedWindow
    : redditTopWindowForLookback(REDDIT_DIGEST_LOOKBACK_DAYS);
  const limit = Math.max(30, Math.min(100, REDDIT_DIGEST_TOP_POSTS * REDDIT_DIGEST_MAX_DAYS * 4));
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=${effectiveTopWindow}&limit=${limit}&raw_json=1`;
  const json = await fetchJsonUrl(url, {
    headers: {
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "application/json",
    },
    timeoutMs: REDDIT_FETCH_TIMEOUT_MS,
    signal,
  });

  const children = Array.isArray(json?.data?.children) ? json.data.children : [];
  const posts = children
    .map((item) => normalizeRedditTopPost(item, sub))
    .filter(Boolean);
  posts.sort((a, b) => {
    const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const commentDiff = Number(b.comments || 0) - Number(a.comments || 0);
    if (commentDiff !== 0) return commentDiff;
    return Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0);
  });
  return posts;
}

function chooseRedditTopWindowForDays(days) {
  const dayCount = Array.isArray(days) ? days.length : 0;
  if (dayCount <= 1) return "day";
  return redditTopWindowForLookback(Math.max(REDDIT_DIGEST_LOOKBACK_DAYS, dayCount));
}

function computeRedditDigestWindow(chatId, { forcedDays = 0 } = {}) {
  const today = utcDayKeyNow();
  if (!today) {
    return {
      days: [],
      missedDays: 0,
      capped: false,
      lastCursorDay: "",
      today: "",
    };
  }

  const forced = Math.trunc(Number(forcedDays) || 0);
  if (forced > 0) {
    const cappedForced = Math.max(1, Math.min(forced, REDDIT_DIGEST_MAX_DAYS));
    const start = addUtcDays(today, -(cappedForced - 1));
    return {
      days: listUtcDays(start, today),
      missedDays: cappedForced,
      capped: forced > cappedForced,
      lastCursorDay: getRedditDigestCursorForChat(chatId),
      today,
    };
  }

  const lastCursorDay = getRedditDigestCursorForChat(chatId);
  if (!lastCursorDay) {
    return {
      days: [today],
      missedDays: 1,
      capped: false,
      lastCursorDay: "",
      today,
    };
  }

  const missedDays = diffUtcDays(lastCursorDay, today);
  if (missedDays <= 0) {
    return {
      days: [],
      missedDays: 0,
      capped: false,
      lastCursorDay,
      today,
    };
  }

  const daysToInclude = Math.min(missedDays, REDDIT_DIGEST_MAX_DAYS);
  const start = addUtcDays(today, -(daysToInclude - 1));
  return {
    days: listUtcDays(start, today),
    missedDays,
    capped: missedDays > daysToInclude,
    lastCursorDay,
    today,
  };
}

function buildRedditDigestBuckets({ postsBySubreddit, days }) {
  const source = postsBySubreddit && typeof postsBySubreddit === "object" ? postsBySubreddit : {};
  const targetDays = Array.isArray(days) ? days.map((d) => String(d || "").trim()).filter(Boolean) : [];
  const isSingleDayWindow = targetDays.length === 1;
  const out = [];

  for (const day of targetDays) {
    const bySub = [];
    for (const sub of REDDIT_DIGEST_SUBREDDITS) {
      const list = Array.isArray(source[sub]) ? source[sub] : [];
      const sorted = [...list].sort((a, b) => {
        const scoreDiff = Number(b?.score || 0) - Number(a?.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const commentDiff = Number(b?.comments || 0) - Number(a?.comments || 0);
        if (commentDiff !== 0) return commentDiff;
        return Number(b?.createdAtMs || 0) - Number(a?.createdAtMs || 0);
      });

      const picked = sorted
        .filter((p) => String(p?.day || "").trim() === day)
        .slice(0, REDDIT_DIGEST_TOP_POSTS);

      if (isSingleDayWindow && picked.length < REDDIT_DIGEST_TOP_POSTS) {
        const seen = new Set(picked.map((p) => String(p?.id || "").trim()).filter(Boolean));
        for (const post of sorted) {
          if (picked.length >= REDDIT_DIGEST_TOP_POSTS) break;
          const id = String(post?.id || "").trim();
          if (id && seen.has(id)) continue;
          picked.push(post);
          if (id) seen.add(id);
        }
      }

      bySub.push({
        subreddit: sub,
        posts: picked,
      });
    }
    out.push({
      day,
      subreddits: bySub,
    });
  }

  return out;
}

function countRedditDigestPosts(buckets) {
  let total = 0;
  for (const day of Array.isArray(buckets) ? buckets : []) {
    for (const sub of Array.isArray(day?.subreddits) ? day.subreddits : []) {
      total += Array.isArray(sub?.posts) ? sub.posts.length : 0;
    }
  }
  return total;
}

function buildRedditDigestTextOnlyFromBuckets(buckets) {
  const safeBuckets = Array.isArray(buckets) ? buckets : [];
  const lines = [];

  for (const dayBlock of safeBuckets) {
    const day = String(dayBlock?.day || "").trim();
    if (!day) continue;
    lines.push(`DAY ${day} (local)`);

    for (const subBlock of Array.isArray(dayBlock?.subreddits) ? dayBlock.subreddits : []) {
      const sub = String(subBlock?.subreddit || "").trim();
      if (!sub) continue;
      lines.push(`SUBREDDIT r/${sub}`);

      const posts = Array.isArray(subBlock?.posts) ? subBlock.posts : [];
      if (posts.length === 0) {
        lines.push("- (no posts found)");
        continue;
      }

      for (let i = 0; i < posts.length; i += 1) {
        const p = posts[i];
        const title = String(p?.title || "").trim();
        if (!title) continue;

        // Prefer direct article URLs; fall back to Reddit post link when no external URL exists.
        const link = String(p?.externalUrl || p?.link || p?.permalink || p?.redditUrl || "").trim();
        if (link) {
          lines.push(`[${i + 1}](${link}) ${title}`);
        } else {
          lines.push(`${i + 1}. ${title}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildRedditDigestPrompt({
  buckets,
  cappedBacklog = false,
  missedDays = 0,
}) {
  const safeBuckets = Array.isArray(buckets) ? buckets : [];
  const lines = [
    "Create a Reddit news digest from the source data below.",
    "Goal: tell the user the news in your own words, not by reading titles.",
    "",
    "Requirements:",
    "- Follow the SPOKEN and TEXT_ONLY output sections exactly.",
    "- SPOKEN: paraphrase the important developments and trends in plain language.",
    "- SPOKEN: keep it concise and easy to listen to.",
    "- SPOKEN: if multiple days are present, narrate in chronological order.",
    "- SPOKEN: do not include URLs.",
    "- Prioritize significance and momentum from top posts, not recency.",
    "- TEXT_ONLY: list the exact original Reddit headlines grouped by day and subreddit.",
    "- TEXT_ONLY: keep every headline text exactly as provided (no paraphrasing).",
    "- TEXT_ONLY: include every headline from SOURCE_HEADLINES in the same order.",
    "- TEXT_ONLY: for each headline include one source URL (article link when available, otherwise Reddit link).",
    "- TEXT_ONLY: use the exact per-headline 'Link:' URL from SOURCE_HEADLINES; do not use subreddit home/listing links.",
    "- TEXT_ONLY: format each linked item as '[<number>](<url>) <exact headline>'.",
    "- TEXT_ONLY: if a headline has no URL, format it as '<number>. <exact headline>'.",
  ];

  if (cappedBacklog) {
    lines.push(
      `- Backlog note: there were ${missedDays} missed day(s); include only the most recent ${REDDIT_DIGEST_MAX_DAYS} day(s).`,
    );
  }

  lines.push("", "SOURCE_HEADLINES:");

  for (const dayBlock of safeBuckets) {
    const day = String(dayBlock?.day || "").trim();
    if (!day) continue;
    lines.push(`DAY ${day} (local)`);
    for (const subBlock of Array.isArray(dayBlock?.subreddits) ? dayBlock.subreddits : []) {
      const sub = String(subBlock?.subreddit || "").trim();
      if (!sub) continue;
      lines.push(`SUBREDDIT r/${sub}`);
      const posts = Array.isArray(subBlock?.posts) ? subBlock.posts : [];
      if (posts.length === 0) {
        lines.push("- (no posts found)");
        continue;
      }
      for (let i = 0; i < posts.length; i += 1) {
        const p = posts[i];
        const title = String(p?.title || "").trim();
        if (!title) continue;
        lines.push(`${i + 1}. ${title}`);
        const link = String(p?.link || "").trim();
        if (link) {
          lines.push(`   Link: ${link}`);
        }
        const snippet = String(p?.snippet || "").trim();
        if (snippet) {
          lines.push(`   Context: ${snippet}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function tryParseMarkdownTextLink(src, startIdx) {
  const i = Number(startIdx);
  if (!Number.isFinite(i) || i < 0) return null;
  if (src[i] !== "[" || src[i - 1] === "!") return null;

  const closeBracket = src.indexOf("]", i + 1);
  if (closeBracket <= i + 1) return null;
  if (src[closeBracket + 1] !== "(") return null;

  let depth = 0;
  let closeParen = -1;
  for (let pos = closeBracket + 2; pos < src.length; pos += 1) {
    const ch = src[pos];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) {
        closeParen = pos;
        break;
      }
      depth -= 1;
    }
  }
  if (closeParen <= closeBracket + 2) return null;

  const label = src.slice(i + 1, closeBracket);
  const url = src.slice(closeBracket + 2, closeParen).trim();
  if (!label || !/^https?:\/\/\S+$/i.test(url)) return null;
  return { label, url, end: closeParen + 1 };
}

function renderTelegramEntities(text) {
  const formatBold = TELEGRAM_FORMAT_BOLD;

  const src = String(text || "");
  const out = [];
  const entities = [];
  let outLen = 0;
  let boldStart = null;
  let inInlineCode = false;
  let inCodeFence = false;

  for (let i = 0; i < src.length; ) {
    if (!inInlineCode && src.startsWith("```", i)) {
      inCodeFence = !inCodeFence;
      out.push("```");
      outLen += 3;
      i += 3;
      continue;
    }

    const ch = src[i];
    if (!inCodeFence && ch === "`") {
      inInlineCode = !inInlineCode;
      out.push(ch);
      outLen += 1;
      i += 1;
      continue;
    }

    if (!inInlineCode && !inCodeFence && ch === "[") {
      const parsedLink = tryParseMarkdownTextLink(src, i);
      if (parsedLink) {
        const labelOffset = outLen;
        out.push(parsedLink.label);
        outLen += parsedLink.label.length;
        entities.push({
          type: "text_link",
          offset: labelOffset,
          length: parsedLink.label.length,
          url: parsedLink.url,
        });
        i = parsedLink.end;
        continue;
      }
    }

    if (formatBold && !inInlineCode && !inCodeFence && src.startsWith("**", i)) {
      if (boldStart === null) {
        boldStart = outLen;
        i += 2;
        continue;
      }
      const len = outLen - boldStart;
      if (len > 0) {
        entities.push({ type: "bold", offset: boldStart, length: len });
      } else {
        // Empty "** **" sequence; keep literal markers.
        out.push("**");
        outLen += 2;
      }
      boldStart = null;
      i += 2;
      continue;
    }

    out.push(ch);
    outLen += 1;
    i += 1;
  }

  if (boldStart !== null) {
    // Unclosed bold: keep the literal opening markers.
    const joined = out.join("");
    const restored = `${joined.slice(0, boldStart)}**${joined.slice(boldStart)}`;
    entities.sort((a, b) => (Number(a.offset || 0) - Number(b.offset || 0)) || (Number(b.length || 0) - Number(a.length || 0)));
    return { text: restored, entities: entities.length > 0 ? entities : null };
  }

  entities.sort((a, b) => (Number(a.offset || 0) - Number(b.offset || 0)) || (Number(b.length || 0) - Number(a.length || 0)));
  return { text: out.join(""), entities: entities.length > 0 ? entities : null };
}

function getTelegramCommandList() {
  return [
    { command: "start", description: "start / help" },
    { command: "help", description: "show help" },
    { command: "status", description: "show worker status" },
    { command: "workers", description: "list workspaces/workers" },
    { command: "use", description: "switch active workspace" },
    { command: "spawn", description: "create a repo workspace" },
    { command: "retire", description: "remove a workspace" },
    { command: "queue", description: "show queued prompts" },
    { command: "news", description: "voice digest from Reddit top posts" },
    { command: "codex", description: "show codex command menu" },
    { command: "commands", description: "show codex command menu" },
    { command: "cmd", description: "stage a raw codex CLI command" },
    { command: "confirm", description: "run staged /cmd" },
    { command: "run", description: "run staged /cmd" },
    { command: "reject", description: "cancel staged /cmd" },
    { command: "deny", description: "cancel staged /cmd" },
    { command: "cancelcmd", description: "cancel staged /cmd" },
    { command: "cancel", description: "cancel the active codex run" },
    { command: "stop", description: "cancel the active codex run" },
    { command: "clear", description: "clear queued prompts" },
    { command: "wipe", description: "wipe runtime artifacts and chat context" },
    { command: "screenshot", description: "send a screenshot image" },
    { command: "sendfile", description: "send a file attachment" },
    { command: "resume", description: "resume a codex session" },
    { command: "new", description: "clear active resumed session" },
    { command: "compress", description: "compress active session context" },
    { command: "ask", description: "ask about your last sent image" },
    { command: "see", description: "take a screenshot and ask about it" },
    { command: "imgclear", description: "clear last image context" },
    { command: "model", description: "pick model + reasoning effort" },
    { command: "tts", description: "speak text as a Telegram voice message" },
    { command: "restart", description: "restart only when all workers are idle" },
  ];
}

async function setTelegramCommands() {
  const commands = getTelegramCommandList();
  const scopes = TELEGRAM_COMMAND_SCOPES.length > 0 ? TELEGRAM_COMMAND_SCOPES : ["default"];
  const uniqueScopes = [];
  for (const s of scopes) {
    const key = String(s || "").trim().toLowerCase();
    if (!key) continue;
    if (!uniqueScopes.includes(key)) uniqueScopes.push(key);
  }
  if (uniqueScopes.length === 0) uniqueScopes.push("default");

  for (const scope of uniqueScopes) {
    const body = { commands };
    if (scope && scope !== "default") {
      body.scope = { type: scope };
    }
    await telegramApi("setMyCommands", { body });
  }
}

async function sendChatAction(chatId, action = TELEGRAM_CHAT_ACTION_DEFAULT, options = {}) {
  if (!TELEGRAM_CHAT_ACTION_ENABLED) return false;
  const chat = String(chatId || "").trim();
  if (!chat) return false;
  const selectedAction = normalizeTelegramChatAction(action, TELEGRAM_CHAT_ACTION_DEFAULT);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : TELEGRAM_API_TIMEOUT_MS;
  try {
    await telegramApi("sendChatAction", {
      body: {
        chat_id: chat,
        action: selectedAction,
      },
      timeoutMs,
      signal: options.signal,
    });
    return true;
  } catch (err) {
    if (options.logErrors !== false) {
      log(`sendChatAction(${selectedAction}) failed: ${redactError(err?.message || err)}`);
    }
    return false;
  }
}

async function sendMessage(chatId, text, options = {}) {
  const silent = options.silent === true;
  const replyMarkup = options.replyMarkup || null;
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const allowSendingWithoutReply = options.allowSendingWithoutReply !== false;
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const routeSource = String(options.routeSource || "").trim().toLowerCase();
  const routeSnippet = String(options.routeSnippet || "").trim();
  const routeTaskId = Number(options.routeTaskId || 0);
  const routeSessionId = String(options.routeSessionId || "").trim();
  const chunks = chunkText(normalizeResponse(text), TELEGRAM_MESSAGE_MAX_CHARS);
  const sent = [];
  let previousSentMessageId = Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const rawChunk = chunks[idx];
    const formatted = renderTelegramEntities(rawChunk);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const body = {
          chat_id: chatId,
          text: formatted.text,
          disable_web_page_preview: true,
          disable_notification: silent,
        };
        if (idx === 0 && Number.isFinite(replyToMessageId) && replyToMessageId > 0) {
          body.reply_to_message_id = replyToMessageId;
          body.allow_sending_without_reply = allowSendingWithoutReply;
        }
        if (formatted.entities) {
          body.entities = formatted.entities;
        }
        if (idx === 0 && replyMarkup) {
          body.reply_markup = replyMarkup;
        }
        const msg = await telegramApi("sendMessage", {
          body,
        });
        if (msg && typeof msg === "object") sent.push(msg);
        if (msg && typeof msg === "object" && msg.message_id) {
          const messageId = Number(msg.message_id || 0);
          if (Number.isFinite(messageId) && messageId > 0) {
            recordMessageMeta(chatId, messageId, {
              parentMessageId: previousSentMessageId,
              source: routeSource || "bot-text",
              snippet: routeSnippet || formatted.text,
              from: "bot",
              fromIsBot: true,
              role: "assistant",
              workerId: routeWorkerId,
              taskId: routeTaskId,
              sessionId: routeSessionId,
            }, { persist: !routeWorkerId });
            previousSentMessageId = Math.trunc(messageId);
          }
        }
        if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
          recordReplyRoute(chatId, msg.message_id, routeWorkerId, {
            source: routeSource || "bot-text",
            snippet: routeSnippet || formatted.text,
            taskId: Number.isFinite(routeTaskId) && routeTaskId > 0 ? Math.trunc(routeTaskId) : 0,
            sessionId: routeSessionId,
          });
        }
        logChat("out", chatId, formatted.text, { source: "telegram-send" });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(350 * attempt);
      }
    }
  }
  return sent;
}

async function sendPhoto(chatId, filePath, options = {}) {
  const silent = options.silent === true;
  const caption = String(options.caption || "").trim();
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const allowSendingWithoutReply = options.allowSendingWithoutReply !== false;
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const routeTaskId = Number(options.routeTaskId || 0);
  const routeSessionId = String(options.routeSessionId || "").trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : TELEGRAM_UPLOAD_TIMEOUT_MS;
  const signal = options.signal;
  const fileName = path.basename(filePath) || "image.png";
  let blob;
  try {
    blob = await fs.openAsBlob(filePath);
    // Ensure a stable content-type for Telegram uploads.
    blob = new Blob([blob], { type: "image/png" });
  } catch {
    const imageBytes = fs.readFileSync(filePath);
    blob = new Blob([imageBytes], { type: "image/png" });
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId || ""));
      form.append("disable_notification", silent ? "true" : "false");
      if (Number.isFinite(replyToMessageId) && replyToMessageId > 0) {
        form.append("reply_to_message_id", String(replyToMessageId));
        form.append("allow_sending_without_reply", allowSendingWithoutReply ? "true" : "false");
      }
      if (caption) form.append("caption", caption);
      form.append("photo", blob, fileName);
      const msg = await telegramApiMultipart("sendPhoto", form, timeoutMs, { signal });
      if (msg && typeof msg === "object" && msg.message_id) {
        recordMessageMeta(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-photo",
          snippet: caption || "[photo]",
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          workerId: routeWorkerId,
          taskId: routeTaskId,
          sessionId: routeSessionId,
        }, { persist: !routeWorkerId });
      }
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId, {
          source: "bot-photo",
          snippet: caption || "[photo]",
          taskId: Number.isFinite(routeTaskId) && routeTaskId > 0 ? Math.trunc(routeTaskId) : 0,
          sessionId: routeSessionId,
        });
      }
      logChat("out", chatId, caption || "[photo]", { source: "telegram-photo" });
      return msg;
    } catch (err) {
      // If we hit our own abort timeout, don't retry multiple times; it'll just stall the bot.
      if (String(err?.name || "").trim() === "AbortError") throw err;
      if (attempt >= 3) throw err;
      await sleep(350 * attempt);
    }
  }
}

async function sendVoice(chatId, filePath, options = {}) {
  const silent = options.silent === true;
  const caption = String(options.caption || "").trim();
  const duration = Number(options.duration || 0);
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const allowSendingWithoutReply = options.allowSendingWithoutReply !== false;
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const routeTaskId = Number(options.routeTaskId || 0);
  const routeSessionId = String(options.routeSessionId || "").trim();
  const replyContextText = String(options.replyContextText || "").trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : TELEGRAM_UPLOAD_TIMEOUT_MS;
  const signal = options.signal;
  const maxAttempts = toInt(options.maxAttempts, 3, 1, 10);
  const fileName = path.basename(filePath) || "voice.ogg";
  let blob;
  try {
    blob = await fs.openAsBlob(filePath);
    // Ensure a stable content-type for Telegram uploads.
    blob = new Blob([blob], { type: "audio/ogg" });
  } catch {
    const voiceBytes = fs.readFileSync(filePath);
    blob = new Blob([voiceBytes], { type: "audio/ogg" });
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId || ""));
      form.append("disable_notification", silent ? "true" : "false");
      if (Number.isFinite(replyToMessageId) && replyToMessageId > 0) {
        form.append("reply_to_message_id", String(replyToMessageId));
        form.append("allow_sending_without_reply", allowSendingWithoutReply ? "true" : "false");
      }
      if (caption) form.append("caption", caption);
      if (Number.isFinite(duration) && duration > 0) {
        form.append("duration", String(Math.round(duration)));
      }
      form.append("voice", blob, fileName);
      const msg = await telegramApiMultipart("sendVoice", form, timeoutMs, { signal });
      if (msg && typeof msg === "object" && msg.message_id) {
        recordMessageMeta(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-voice",
          snippet: replyContextText || caption || "[voice]",
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          workerId: routeWorkerId,
          taskId: routeTaskId,
          sessionId: routeSessionId,
        }, { persist: !routeWorkerId });
      }
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId, {
          source: "bot-voice",
          snippet: replyContextText || caption || "[voice]",
          taskId: Number.isFinite(routeTaskId) && routeTaskId > 0 ? Math.trunc(routeTaskId) : 0,
          sessionId: routeSessionId,
        });
      }
      logChat("out", chatId, caption || "[voice]", { source: "telegram-voice" });
      return msg;
    } catch (err) {
      // If we hit our own abort timeout, don't retry multiple times; it'll just stall the bot.
      if (String(err?.name || "").trim() === "AbortError") throw err;
      if (attempt >= maxAttempts) throw err;
      await sleep(350 * attempt);
    }
  }
}

async function sendDocument(chatId, filePath, options = {}) {
  const silent = options.silent === true;
  const caption = String(options.caption || "").trim();
  const fileName = String(options.fileName || "").trim() || path.basename(filePath) || "file";
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const allowSendingWithoutReply = options.allowSendingWithoutReply !== false;
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const routeTaskId = Number(options.routeTaskId || 0);
  const routeSessionId = String(options.routeSessionId || "").trim();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : ATTACH_UPLOAD_TIMEOUT_MS;
  const signal = options.signal;

  let blob;
  try {
    blob = await fs.openAsBlob(filePath);
    // Telegram infers type from file name; keep a stable binary content-type.
    blob = new Blob([blob], { type: "application/octet-stream" });
  } catch {
    const bytes = fs.readFileSync(filePath);
    blob = new Blob([bytes], { type: "application/octet-stream" });
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId || ""));
      form.append("disable_notification", silent ? "true" : "false");
      if (Number.isFinite(replyToMessageId) && replyToMessageId > 0) {
        form.append("reply_to_message_id", String(replyToMessageId));
        form.append("allow_sending_without_reply", allowSendingWithoutReply ? "true" : "false");
      }
      if (caption) form.append("caption", caption);
      form.append("document", blob, fileName);
      const msg = await telegramApiMultipart("sendDocument", form, timeoutMs, { signal });
      if (msg && typeof msg === "object" && msg.message_id) {
        recordMessageMeta(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-document",
          snippet: caption || `[document] ${fileName}`,
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          workerId: routeWorkerId,
          taskId: routeTaskId,
          sessionId: routeSessionId,
        }, { persist: !routeWorkerId });
      }
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId, {
          source: "bot-document",
          snippet: caption || `[document] ${fileName}`,
          taskId: Number.isFinite(routeTaskId) && routeTaskId > 0 ? Math.trunc(routeTaskId) : 0,
          sessionId: routeSessionId,
        });
      }
      logChat("out", chatId, caption || `[document] ${fileName}`, { source: "telegram-document" });
      return msg;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(350 * attempt);
    }
  }
}

async function runPowerShellScript(psScript, envVars = {}, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : SCREENSHOT_CAPTURE_TIMEOUT_MS;
  const stdoutLimit = Number.isFinite(options.stdoutLimit) ? Number(options.stdoutLimit) : 32_000;
  const stderrLimit = Number.isFinite(options.stderrLimit) ? Number(options.stderrLimit) : 12_000;

  return await new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...envVars,
        },
      },
    );

    let out = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    let timeout = null;

    const finish = (err, value = "") => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (err) reject(err);
      else resolve(value);
    };

    if (stdoutLimit > 0) {
      proc.stdout.on("data", (buf) => {
        out = appendTail(out, String(buf || ""), stdoutLimit);
      });
    }
    proc.stderr.on("data", (buf) => {
      stderr = appendTail(stderr, String(buf || ""), stderrLimit);
    });

    proc.on("error", (err) => {
      finish(new Error(`Failed to start PowerShell: ${err.message || err}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `PowerShell failed with exit ${code}`));
        return;
      }
      finish(null, out);
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // best effort
        }
        killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // best effort
          }
        }, 1500);
        finish(new Error(`PowerShell timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s.`));
      }, timeoutMs);
    }
  });
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
    "$screen = [System.Windows.Forms.Screen]::PrimaryScreen",
    "if ($null -eq $screen) { throw 'No primary screen found' }",
    "$bounds = $screen.Bounds",
    "if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Primary screen bounds are invalid' }",
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

  await runPowerShellScript(
    psScript,
    { TG_SCREENSHOT_PATH: filePath },
    { timeoutMs: SCREENSHOT_CAPTURE_TIMEOUT_MS, stdoutLimit: 1 },
  );

  if (!fs.existsSync(filePath)) {
    throw new Error("Screenshot file was not created.");
  }
}

async function captureAllScreenshots(outputDir, prefix = "screenshot") {
  if (process.platform !== "win32") {
    throw new Error("Screenshot capture is only configured for Windows in this bot.");
  }

  const dir = String(outputDir || "").trim();
  if (!dir) {
    throw new Error("Screenshot output directory is required.");
  }
  ensureDir(dir);

  const safePrefix = String(prefix || "screenshot").trim() || "screenshot";
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$dir = $env:TG_SCREENSHOT_DIR",
    "$prefix = $env:TG_SCREENSHOT_PREFIX",
    "if ([string]::IsNullOrWhiteSpace($dir)) { throw 'Missing TG_SCREENSHOT_DIR' }",
    "if ([string]::IsNullOrWhiteSpace($prefix)) { $prefix = 'screenshot' }",
    "if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
    "$primary = [System.Windows.Forms.Screen]::PrimaryScreen",
    "$primaryName = if ($null -ne $primary) { $primary.DeviceName } else { '' }",
    "$screens = @([System.Windows.Forms.Screen]::AllScreens)",
    "if ($screens.Count -eq 0 -and $null -ne $primary) { $screens = @($primary) }",
    "if ($screens.Count -eq 0) { throw 'No screens detected.' }",
    "$screens = $screens | Sort-Object @{Expression={ if ([string]::IsNullOrWhiteSpace($primaryName)) { $false } else { $_.DeviceName -ne $primaryName } }; Ascending=$true}, @{Expression={ $_.DeviceName }; Ascending=$true}",
    "$idx = 0",
    "foreach ($s in $screens) {",
    "  $bounds = $s.Bounds",
    "  if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }",
    "  $idx = $idx + 1",
    "  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "  $gfx = [System.Drawing.Graphics]::FromImage($bmp)",
    "  try {",
    "    $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    "    $outPath = Join-Path $dir (\"{0}-{1}.png\" -f $prefix, $idx)",
    "    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    Write-Output $outPath",
    "  } finally {",
    "    $gfx.Dispose()",
    "    $bmp.Dispose()",
    "  }",
    "}",
    "if ($idx -eq 0) { throw 'No valid screen bounds found for screenshot capture.' }",
  ].join("; ");

  const stdout = await runPowerShellScript(
    psScript,
    {
      TG_SCREENSHOT_DIR: dir,
      TG_SCREENSHOT_PREFIX: safePrefix,
    },
    { timeoutMs: SCREENSHOT_CAPTURE_TIMEOUT_MS, stdoutLimit: 64_000 },
  );

  const files = String(stdout || "")
    .split(/\r?\n/)
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const existing = [];
  for (const p of files) {
    if (p && fs.existsSync(p)) existing.push(p);
  }
  if (existing.length === 0) {
    throw new Error("No screenshots were created.");
  }

  return existing;
}

async function captureScreenshotsWithFallback(outputDir, prefix = "screenshot") {
  try {
    return await captureAllScreenshots(outputDir, prefix);
  } catch (err) {
    const msg = redactError(err?.message || err);
    log(`captureAllScreenshots failed (${msg}); falling back to primary display.`);
    const dir = String(outputDir || "").trim();
    if (!dir) {
      throw err;
    }
    ensureDir(dir);
    const safePrefix = String(prefix || "screenshot").trim() || "screenshot";
    const fallbackPath = path.join(dir, `${safePrefix}-1.png`);
    await capturePrimaryScreenshot(fallbackPath);
    return [fallbackPath];
  }
}

async function handleScreenshotCommand(chatId) {
  const prefix = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = [];

  try {
    const paths = await captureScreenshotsWithFallback(OUT_DIR, prefix);
    created.push(...paths);
    const stamp = nowIso();
    for (let i = 0; i < paths.length; i += 1) {
      const label = i === 0 ? "Primary" : `Screen ${i + 1}`;
      await sendPhoto(chatId, paths[i], {
        caption: `Screenshot ${stamp} (${label})`,
        timeoutMs: SCREENSHOT_UPLOAD_TIMEOUT_MS,
      });
    }
  } finally {
    try {
      for (const p of created) {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      }
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

function parseNaturalCommand(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.startsWith("/")) return null;

  const squashed = raw.replace(/\s+/g, " ").trim();
  if (!squashed) return null;

  if (/^(?:please\s+)?(?:take|grab|capture|send)(?:\s+me)?(?:\s+an?)?\s+screens?hot(?:s)?(?:\s+(?:please|now))?[.!?]*$/i.test(squashed)) {
    return { cmd: "/screenshot", arg: "" };
  }
  if (/^(?:please\s+)?(?:show|open)\s+(?:the\s+)?(?:commands?|command menu)(?:\s+please)?[.!?]*$/i.test(squashed)) {
    return { cmd: "/commands", arg: "" };
  }

  let candidate = squashed;
  let prefixMode = false;

  const wakeWordMatch = candidate.match(/^(?:(?:hey|ok|okay|yo)\s+)?(?:aidolon|bot)\b[,:-]?\s+(.+)$/i);
  if (wakeWordMatch) {
    candidate = String(wakeWordMatch[1] || "").trim();
    prefixMode = true;
  } else {
    const explicitMatch = candidate.match(/^(?:command|cmd)\s*[:\-]?\s+(.+)$/i);
    if (explicitMatch) {
      candidate = String(explicitMatch[1] || "").trim();
      prefixMode = true;
    }
  }
  if (!candidate) return null;

  const parts = candidate.split(/\s+/);
  const headRaw = String(parts[0] || "").trim();
  if (!headRaw) return null;
  const token = headRaw.replace(/^\/+/, "").replace(/[!?.,:;]+$/g, "").toLowerCase();
  const cmd = NATURAL_COMMAND_ALIASES[token];
  if (!cmd) return null;

  if (!prefixMode && !NATURAL_DIRECT_COMMANDS.has(cmd)) return null;
  if (!prefixMode && NATURAL_PREFIX_REQUIRED_COMMANDS.has(cmd)) return null;

  let arg = parts.slice(1).join(" ").trim();
  if (cmd === "/news") {
    const politeArg = arg.replace(/[.!?]+$/g, "").trim().toLowerCase();
    if (/^(?:please|pls|now|today|latest)$/.test(politeArg)) {
      arg = "";
    } else if (/^(?:reset|clear)(?:\s+please)?$/.test(politeArg)) {
      arg = "reset";
    } else if (arg) {
      const parsedNewsArg = parseNaturalNewsArgFromText(arg, { allowBareValue: true });
      if (parsedNewsArg.ok) {
        arg = String(parsedNewsArg.argText || "").trim();
      } else if (!prefixMode) {
        // Don't hijack regular conversation that happens to begin with "news".
        return null;
      }
    }
  }
  if (cmd === "/restart" && arg && !prefixMode) {
    const cleaned = arg.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
    const allowedRestartTokens = new Set([
      "now",
      "force",
      "immediate",
      "cancel",
      "off",
      "stop",
      "abort",
      "bot",
      "aidolon",
      "yourself",
      "after",
      "when",
      "all",
      "workers",
      "worker",
      "is",
      "are",
      "done",
      "finished",
      "finish",
      "idle",
    ]);
    const tokens = cleaned ? cleaned.split(/\s+/) : [];
    if (tokens.some((tok) => !allowedRestartTokens.has(tok))) return null;
  }

  if (NATURAL_NO_ARG_COMMANDS.has(cmd) && arg && !/^(?:please|pls|now|thanks|thank you|thx)[.!?]*$/i.test(arg)) {
    return null;
  }

  return { cmd, arg };
}

const BACKGROUND_LOCAL_COMMANDS = new Set([
  "/help",
  "/codex",
  "/commands",
  "/status",
  "/workers",
  "/queue",
  "/screenshot",
  "/sendfile",
  "/model",
  "/imgclear",
  "/wipe",
]);

function shouldRunCommandInBackground(parsed) {
  const cmd = String(parsed?.cmd || "").trim().toLowerCase();
  if (!cmd) return false;
  return BACKGROUND_LOCAL_COMMANDS.has(cmd);
}

function enqueueBackgroundCommand(chatId, parsed, runTask) {
  const chatKey = String(chatId || "").trim();
  const cmd = String(parsed?.cmd || "command").trim();
  const run = async () => {
    try {
      await runTask();
    } catch (err) {
      log(`background command ${cmd} failed: ${redactError(err?.message || err)}`);
    }
  };

  if (!chatKey) {
    void run();
    return;
  }

  const prev = backgroundCommandChainByChat.get(chatKey) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(run);
  backgroundCommandChainByChat.set(chatKey, next);
  void next.finally(() => {
    if (backgroundCommandChainByChat.get(chatKey) === next) {
      backgroundCommandChainByChat.delete(chatKey);
    }
  });
}

function fmtBold(text) {
  const t = String(text || "");
  return TELEGRAM_FORMAT_BOLD ? `**${t}**` : t;
}

async function sendHelp(chatId) {
  const lines = [
    `${fmtBold("AIDOLON")} is online.`,
    "",
    fmtBold("Quick start"),
    "- Send plain text (or a voice message) to prompt AIDOLON.",
    "- Use /codex for a menu, or stage a CLI command with /cmd then run it with /confirm.",
    "- Natural command trigger: say things like \"screenshot\", \"c\", or \"command <name> ...\".",
    "",
    fmtBold("Core"),
    "- /status - worker + queue status",
    "- /workers - list workspaces/workers",
    "- /use <worker_id, name, or title> - switch active workspace",
    "- /queue - show queued prompts",
    "- /news [days|reset] - Reddit top-post digest with missed-day catch-up",
    "- Say \"give me the news\" - bot asks for day count then runs /news",
    "- /cancel - stop current AIDOLON run",
    "- /clear - clear queued prompts",
    "- /wipe - wipe runtime files and reset this chat context",
    "",
    fmtBold("CLI flow"),
    "- /cmd <args> - stage a raw AIDOLON CLI command",
    "- /confirm - run staged /cmd command",
    "- /reject - cancel staged /cmd command",
    "",
    fmtBold("Workspaces"),
    "- /spawn <path> [title] - create a new repo workspace",
    "- /retire <worker_id, name, or title> - remove a workspace",
    "",
    fmtBold("Sessions"),
    "- /resume - list recent sessions (prefill buttons)",
    "- /resume <session_id> [text] - resume a session",
    "- /new - clear active resumed session",
    "- /compress [hint] - summarize/compress active session context",
    "",
    fmtBold("Media"),
    "- /screenshot - capture and send screenshot(s) (all monitors when available)",
    "- /see <question> - take a screenshot and analyze it",
    "- /ask <question> - analyze your last sent image",
    "- /imgclear - clear the last image context",
    "- /tts <text> - send a TTS voice message (requires TTS_ENABLED=1)",
    "- /sendfile <path> [caption] - send a file attachment (from ATTACH_ROOT)",
    "",
    fmtBold("Other"),
    "- /codex or /commands - show AIDOLON command menu",
    "- /model - pick the model + reasoning effort for this chat",
    "- /restart - restart only when all workers are idle and queue is empty",
    "- /help - show this help",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

function parseNewsCommandArg(argText) {
  const raw = String(argText || "").trim().toLowerCase();
  if (!raw) {
    return { ok: true, mode: "auto", forcedDays: 0 };
  }
  if (["reset", "clear", "off", "new"].includes(raw)) {
    return { ok: true, mode: "reset", forcedDays: 0 };
  }
  if (/^\d+$/.test(raw)) {
    const n = Math.trunc(Number(raw) || 0);
    if (n > 0) {
      return {
        ok: true,
        mode: "manual",
        forcedDays: Math.max(1, Math.min(n, REDDIT_DIGEST_MAX_DAYS)),
      };
    }
  }
  return {
    ok: false,
    error: `Usage: /news [1-${REDDIT_DIGEST_MAX_DAYS}] | /news reset`,
  };
}

function setPendingNaturalNewsFollowup(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  pendingNaturalNewsByChat.set(key, { at: Date.now() });
}

function clearPendingNaturalNewsFollowup(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  pendingNaturalNewsByChat.delete(key);
}

function getPendingNaturalNewsFollowup(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const entry = pendingNaturalNewsByChat.get(key) || null;
  if (!entry || typeof entry !== "object") return null;
  const at = Number(entry.at || 0);
  if (!Number.isFinite(at) || at <= 0 || (Date.now() - at) > NATURAL_NEWS_FOLLOWUP_TTL_MS) {
    pendingNaturalNewsByChat.delete(key);
    return null;
  }
  return entry;
}

function parseNaturalNewsArgFromText(input, { allowBareValue = false } = {}) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return { ok: false, argText: "" };

  if (/\b(?:auto|catch[- ]?up|default)\b/.test(text)) {
    return { ok: true, argText: "", mode: "auto" };
  }
  if (allowBareValue && /^(?:reset|clear)$/.test(text)) {
    return { ok: true, argText: "reset", mode: "reset" };
  }
  if (/\b(?:reset|clear)\b/.test(text) && /\b(?:news|headlines|digest|cursor|catch[- ]?up)\b/.test(text)) {
    return { ok: true, argText: "reset", mode: "reset" };
  }

  if (/\b(?:today|yesterday|now|right\s+now)\b/.test(text)) {
    return { ok: true, argText: "1", mode: "manual" };
  }
  if (/\b(?:this|last|past)\s+week\b/.test(text)) {
    return { ok: true, argText: "7", mode: "manual" };
  }

  const dayNumber = text.match(/\b(?:for|last|past|previous|about|around|in|over)?\s*(\d{1,3})\s*(?:day|days|d)\b/);
  if (dayNumber) {
    return { ok: true, argText: String(dayNumber[1] || "").trim(), mode: "manual" };
  }

  const dayWord = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s*(?:day|days)\b/);
  if (dayWord) {
    const n = Number(NATURAL_NEWS_WORD_TO_DAYS[dayWord[1]]);
    if (Number.isFinite(n) && n > 0) {
      return { ok: true, argText: String(n), mode: "manual" };
    }
  }

  if (allowBareValue) {
    const bareNumber = text.match(/^\d{1,3}$/);
    if (bareNumber) {
      return { ok: true, argText: String(bareNumber[0] || "").trim(), mode: "manual" };
    }
    const bareWord = text.match(/^(one|two|three|four|five|six|seven|eight|nine|ten|couple|few)$/);
    if (bareWord) {
      const n = Number(NATURAL_NEWS_WORD_TO_DAYS[bareWord[1]]);
      if (Number.isFinite(n) && n > 0) {
        return { ok: true, argText: String(n), mode: "manual" };
      }
    }
  }

  return { ok: false, argText: "" };
}

function looksLikeNaturalNewsRequest(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  if (!/\b(news|headlines)\b/.test(lower)) return false;

  const requestPatterns = [
    /\b(?:give|show|tell|read|send|share|fetch|get|drop)\s+me\b.*\b(?:news|headlines)\b/,
    /\b(?:news|headlines)\s+please\b/,
    /\bupdate me\b.*\b(?:news|headlines)\b/,
    /\bwhat(?:'s| is)\s+(?:the\s+)?(?:latest\s+|today(?:'s)?\s+)?(?:news|headlines)\b/,
  ];
  if (requestPatterns.some((re) => re.test(lower))) return true;

  const compact = lower.replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = compact ? compact.split(" ").length : 0;
  if (wordCount > 0 && wordCount <= 5 && /\b(?:latest|today(?:'s)?)\s+(?:news|headlines)\b/.test(compact)) {
    return true;
  }

  return /^\s*(?:hey|hi|hello|yo|aidolon|man|buddy)\b[\s,!.:-]*(?:please\b[\s,!.:-]*)?(?:news|headlines)\b/.test(lower);
}

function looksLikeNewsCommandMetaText(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  if (!/\b(news|headlines)\b/.test(lower)) return false;

  const commandMentions = [
    /\b\/news\b/,
    /\bslash\s+news\b/,
    /\b(?:news|headlines)\s+(?:request|feature|function|command|commands|handler|trigger|workflow|mode)\b/,
    /\b(?:request|feature|function|command|commands|handler|trigger|workflow|mode)\b.*\b(?:news|headlines)\b/,
  ];
  if (commandMentions.some((re) => re.test(lower))) return true;

  const debugMentions = [
    /\b(?:bug|issue|problem|broken|fix|debug|debugging|check|investigate|verify|test|code|repo|repository|orchestrator)\b.*\b(?:news|headlines)\b/,
    /\b(?:news|headlines)\b.*\b(?:bug|issue|problem|broken|fix|debug|debugging|check|investigate|verify|test|code|repo|repository|orchestrator)\b/,
    /\b(?:say|saying|mention|mentioned|word|term|phrase|keyword|name|named|called)\b.*\b(?:news|headlines)\b/,
    /\b(?:news|headlines)\b.*\b(?:say|saying|mention|mentioned|word|term|phrase|keyword|name|named|called)\b/,
    /\b(?:still waiting|nothing happened|not getting)\b.*\b(?:news|headlines)\b/,
  ];
  return debugMentions.some((re) => re.test(lower));
}

function parseNaturalNewsRequest(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.startsWith("/")) {
    return { matched: false, needsDays: false, argText: "" };
  }
  if (!looksLikeNaturalNewsRequest(raw)) {
    return { matched: false, needsDays: false, argText: "" };
  }
  if (looksLikeNewsCommandMetaText(raw)) {
    return { matched: false, needsDays: false, argText: "" };
  }
  const parsedArg = parseNaturalNewsArgFromText(raw, { allowBareValue: false });
  if (parsedArg.ok) {
    return { matched: true, needsDays: false, argText: parsedArg.argText };
  }
  return { matched: true, needsDays: true, argText: "" };
}

function isLikelyNaturalNewsFollowupText(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  const normalized = lower.replace(/[.!?]+$/g, "").trim();
  if (!normalized) return false;

  if (/^\d{1,3}$/.test(normalized)) return true;
  if (/^\d{1,3}\s*(?:day|days|d)$/.test(normalized)) return true;
  if (/^(one|two|three|four|five|six|seven|eight|nine|ten|couple|few)$/.test(normalized)) return true;
  if (/^(one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s*(?:day|days)$/.test(normalized)) return true;
  if (/^(?:for|last|past|previous|about|around|in|over)\s+\d{1,3}\s*(?:day|days|d)$/.test(normalized)) return true;
  if (/^(?:for|last|past|previous|about|around|in|over)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s*(?:day|days)$/.test(normalized)) return true;
  return /^(?:auto|catch[- ]?up|default|today|yesterday|now|right now|this week|last week|past week|reset|clear|cancel|stop|never ?mind|forget it)(?:\s+please)?$/.test(normalized);
}

async function maybeHandlePendingNaturalNewsFollowup(chatId, text, { replyToMessageId = 0 } = {}) {
  const pending = getPendingNaturalNewsFollowup(chatId);
  if (!pending) return false;

  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;

  if (/\b(?:cancel|stop|never ?mind|forget it)\b/.test(lower)) {
    clearPendingNaturalNewsFollowup(chatId);
    await sendMessage(chatId, "Okay, canceled the news request.", { replyToMessageId });
    return true;
  }

  if (looksLikeNewsCommandMetaText(lower)) {
    clearPendingNaturalNewsFollowup(chatId);
    return false;
  }

  if (!isLikelyNaturalNewsFollowupText(lower)) {
    clearPendingNaturalNewsFollowup(chatId);
    return false;
  }

  const parsedArg = parseNaturalNewsArgFromText(lower, { allowBareValue: true });
  if (parsedArg.ok) {
    clearPendingNaturalNewsFollowup(chatId);
    await handleNewsCommand(chatId, parsedArg.argText);
    return true;
  }

  await sendMessage(
    chatId,
    `I need a day count. Reply with 1-${REDDIT_DIGEST_MAX_DAYS}, or say "auto catch-up".`,
    { replyToMessageId },
  );
  return true;
}

async function maybeHandleNaturalNewsRequest(chatId, text, { replyToMessageId = 0 } = {}) {
  if (await maybeHandlePendingNaturalNewsFollowup(chatId, text, { replyToMessageId })) {
    return true;
  }

  const request = parseNaturalNewsRequest(text);
  if (!request.matched) return false;

  clearPendingNaturalNewsFollowup(chatId);
  if (request.needsDays) {
    setPendingNaturalNewsFollowup(chatId);
    await sendMessage(
      chatId,
      `How many days of news do you want? Reply with 1-${REDDIT_DIGEST_MAX_DAYS}, or say "auto catch-up".`,
      { replyToMessageId },
    );
    return true;
  }

  await handleNewsCommand(chatId, request.argText);
  return true;
}

function looksLikeSafeCommandMetaText(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  if (!/\b(help|status|workers?|workspaces?|queue|queued)\b/.test(lower)) return false;

  const commandMentions = [
    /\b\/(?:help|status|workers|queue)\b/,
    /\bslash\s+(?:help|status|workers?|queue)\b/,
    /\b(?:command|commands|request|feature|function|functions|handler|trigger|workflow|mode)\b/,
  ];
  if (commandMentions.some((re) => re.test(lower))) return true;

  const debugMentions = [
    /\b(?:bug|issue|problem|broken|fix|debug|debugging|investigate|verify|code|repo|repository|orchestrator|implement|add|remove|change|refactor|logs?)\b/,
    /\b(?:say|saying|mention|mentioned|word|term|phrase|keyword|name|named|called)\b/,
    /\b(?:still waiting|nothing happened|not getting)\b/,
  ];
  return debugMentions.some((re) => re.test(lower));
}

function parseNaturalSafeCommandIntent(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.startsWith("/")) {
    return { matched: false, cmd: "", confidence: 0 };
  }

  const lower = raw.toLowerCase();
  if (!/\b(help|status|workers?|workspaces?|queue|queued)\b/.test(lower)) {
    return { matched: false, cmd: "", confidence: 0 };
  }
  if (looksLikeSafeCommandMetaText(lower)) {
    return { matched: false, cmd: "", confidence: 0 };
  }

  const normalized = lower.replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { matched: false, cmd: "", confidence: 0 };
  }

  let candidate = normalized;
  let hadWakePrefix = false;
  let hadPolitePrefix = false;
  const wakeMatch = candidate.match(/^(?:(?:hey|hi|hello|yo|ok|okay)\s+)?(?:aidolon|bot)\b(?:\s+please)?\s*(.+)$/);
  if (wakeMatch) {
    candidate = String(wakeMatch[1] || "").trim();
    hadWakePrefix = true;
  }
  const politeMatch = candidate.match(/^(?:can|could|would|will)\s+you\s+(.+)$/);
  if (politeMatch) {
    candidate = String(politeMatch[1] || "").trim();
    hadPolitePrefix = true;
  }
  candidate = candidate.replace(/^please\s+/, "").trim();
  if (!candidate) {
    return { matched: false, cmd: "", confidence: 0 };
  }

  let bestCmd = "";
  let bestConfidence = 0;
  const consider = (cmd, confidence) => {
    if (confidence > bestConfidence) {
      bestCmd = cmd;
      bestConfidence = confidence;
    }
  };

  if (/^(?:help|help me|i need help)$/.test(candidate)) {
    consider("/help", 0.97);
  }
  if (/^(?:show|open|display|get)\s+(?:me\s+)?(?:the\s+)?help(?:\s+menu)?$/.test(candidate)) {
    consider("/help", 0.92);
  }
  if (/^(?:what can you do|how do i use (?:you|this bot)|how can i use (?:you|this bot)|what commands (?:do you have|are available))$/.test(candidate)) {
    consider("/help", 0.85);
  }

  if (/^(?:status|bot status|system status|worker status|current status)$/.test(candidate)) {
    consider("/status", 0.97);
  }
  if (/^(?:show|check|get|display)\s+(?:me\s+)?(?:the\s+)?(?:bot\s+|system\s+|worker\s+)?status$/.test(candidate)) {
    consider("/status", 0.92);
  }
  if (/^(?:what(?:'s| is)|how(?:'s| is))(?:\s+the)?\s+(?:bot\s+|system\s+|worker\s+)?status$/.test(candidate)) {
    consider("/status", 0.87);
  }

  if (/^(?:workers?|workspaces?)(?:\s+list)?$/.test(candidate)) {
    consider("/workers", 0.97);
  }
  if (/^(?:show|list|display|get)\s+(?:me\s+)?(?:the\s+)?(?:active\s+|available\s+)?(?:workers?|workspaces?)$/.test(candidate)) {
    consider("/workers", 0.92);
  }
  if (/^(?:which|what)\s+(?:workers?|workspaces?)\s+(?:are|is)?\s*(?:active|available|running)?$/.test(candidate)) {
    consider("/workers", 0.87);
  }

  if (/^(?:queue|queued|queue status|job queue)$/.test(candidate)) {
    consider("/queue", 0.96);
  }
  if (/^(?:show|check|get|display)\s+(?:me\s+)?(?:the\s+)?(?:job\s+)?queue$/.test(candidate)) {
    consider("/queue", 0.92);
  }
  if (/^(?:what(?:'s| is)|how(?:'s| is))(?:\s+the)?\s+(?:job\s+)?queue$/.test(candidate)) {
    consider("/queue", 0.88);
  }
  if (/^how many\s+(?:jobs?\s+)?(?:are\s+)?queued$/.test(candidate)) {
    consider("/queue", 0.86);
  }
  if (/^(?:is|are)\s+(?:anything|any jobs?)\s+queued$/.test(candidate)) {
    consider("/queue", 0.86);
  }

  if (!bestCmd) {
    return { matched: false, cmd: "", confidence: 0 };
  }

  const words = candidate.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const distinctIntentKeywords = [
    /\bhelp\b/.test(candidate) ? "help" : "",
    /\bstatus\b/.test(candidate) ? "status" : "",
    /\b(workers?|workspaces?)\b/.test(candidate) ? "workers" : "",
    /\b(queue|queued)\b/.test(candidate) ? "queue" : "",
  ].filter(Boolean);

  let confidence = bestConfidence;
  if (hadWakePrefix) confidence += 0.03;
  if (hadPolitePrefix) confidence -= 0.02;
  if (wordCount > 10) confidence -= 0.12;
  if (wordCount > 16) confidence -= 0.18;
  if (distinctIntentKeywords.length > 1) confidence -= 0.14;
  if (/\b(?:maybe|probably|might|could|would|should|if|when|while|after|before)\b/.test(candidate)) {
    confidence -= 0.08;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    matched: true,
    cmd: bestCmd,
    confidence,
  };
}

async function maybeHandleNaturalSafeCommandRequest(chatId, text) {
  const intent = parseNaturalSafeCommandIntent(text);
  if (!intent.matched) return false;
  if (intent.confidence < NATURAL_SAFE_COMMAND_INTENT_THRESHOLD) return false;
  await handleCommand(chatId, intent.cmd);
  return true;
}

async function handleNewsCommand(chatId, argText) {
  clearPendingNaturalNewsFollowup(chatId);

  if (!REDDIT_DIGEST_ENABLED) {
    await sendMessage(chatId, "Reddit digest is disabled on this bot (REDDIT_DIGEST_ENABLED=0).");
    return;
  }

  const parsed = parseNewsCommandArg(argText);
  if (!parsed.ok) {
    await sendMessage(chatId, parsed.error || "Usage: /news");
    return;
  }

  if (parsed.mode === "reset") {
    clearRedditDigestCursorForChat(chatId);
    await sendMessage(chatId, "News catch-up cursor cleared. Next /news run will start from today.");
    return;
  }

  const window = computeRedditDigestWindow(chatId, { forcedDays: parsed.forcedDays });
  const targetDays = Array.isArray(window.days) ? window.days : [];
  if (targetDays.length === 0) {
    const cursor = getRedditDigestCursorForChat(chatId);
      const last = cursor || window.today || "(unknown)";
      await sendMessage(
        chatId,
        `You are already up to date through ${last} (local).\nUse /news 1 to force a fresh one-day digest.`,
      );
      return;
    }

  const topWindow = chooseRedditTopWindowForDays(targetDays);
  const settled = await Promise.allSettled(
    // Use a narrower top window for one-day digests so each subreddit can fill up to REDDIT_DIGEST_TOP_POSTS items.
    // Weekly windows can under-fill "today" when older posts dominate the ranking.
    REDDIT_DIGEST_SUBREDDITS.map(async (sub) => {
      try {
        const posts = await fetchTopPostsForSubreddit(sub, { topWindow });
        return { subreddit: sub, posts };
      } catch (err) {
        const msg = String(err?.message || err || "").trim() || "unknown error";
        throw new Error(`r/${sub}: ${msg}`);
      }
    }),
  );

  const postsBySubreddit = {};
  const sourceErrors = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      const sub = String(item.value?.subreddit || "").trim();
      if (!sub) continue;
      postsBySubreddit[sub] = Array.isArray(item.value?.posts) ? item.value.posts : [];
      continue;
    }
    const reason = String(item.reason?.message || item.reason || "").trim() || "unknown error";
    sourceErrors.push(reason);
  }

  const buckets = buildRedditDigestBuckets({ postsBySubreddit, days: targetDays });
  const totalPosts = countRedditDigestPosts(buckets);
  if (totalPosts <= 0) {
    const errText = sourceErrors.length > 0
      ? `\n\nSource errors:\n- ${sourceErrors.join("\n- ")}`
      : "";
    await sendMessage(chatId, `No top posts found for the requested day window.${errText}`);
    return;
  }

  if (window.capped) {
    await sendMessage(
      chatId,
      `Catch-up is capped at ${REDDIT_DIGEST_MAX_DAYS} day(s). You missed ${window.missedDays} day(s), so I’m sending the most recent ${targetDays.length} day(s).`,
    );
  }

  const prompt = buildRedditDigestPrompt({
    buckets,
    cappedBacklog: window.capped,
    missedDays: window.missedDays,
  });
  const forcedTextOnly = buildRedditDigestTextOnlyFromBuckets(buckets);

  const latestDay = String(targetDays[targetDays.length - 1] || "").trim();
  const canAutoVoiceReply = TTS_ENABLED && TTS_REPLY_TO_VOICE;
  const canAdvanceCursor = sourceErrors.length === 0;

  await enqueuePrompt(chatId, prompt, canAutoVoiceReply ? "voice" : "reddit-news", {
    replyStyle: "voice",
    forcedTextOnly,
    onSuccess: async () => {
      if (canAdvanceCursor && latestDay) {
        setRedditDigestCursorForChat(chatId, latestDay);
      }
    },
  });

  if (!canAutoVoiceReply) {
    await sendMessage(
      chatId,
      "TTS voice auto-reply is disabled, so this digest will be delivered as text only.",
    );
  }

  if (sourceErrors.length > 0) {
    await sendMessage(
      chatId,
      `Some subreddit sources failed, so I did not advance the catch-up cursor.\n- ${sourceErrors.join("\n- ")}`,
    );
  }
}

async function sendStatus(chatId) {
  const queueCap = MAX_QUEUE_SIZE > 0 ? String(MAX_QUEUE_SIZE) : "unlimited";
  const queued = totalQueuedJobs();
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const activeWorker = activeWorkerId ? getCodexWorker(activeWorkerId) : null;
  const activeWorkerName = String(activeWorker?.name || activeWorker?.title || "").trim();
  const activeWorkerLabel = activeWorkerId
    ? activeWorkerName
      ? `${activeWorkerId} (${activeWorkerName})`
      : activeWorkerId
    : "(none)";
  const activeSession = getActiveSessionForChat(chatId, activeWorkerId);
  const prefs = getChatPrefs(chatId);
  const effectiveModel = String(prefs.model || CODEX_MODEL || "").trim() || "(default)";
  const effectiveReasoning = String(prefs.reasoning || CODEX_REASONING_EFFORT || "").trim() || "(default)";
  const codexWorkers = listCodexWorkers();
  const ttsLane = getLane(ORCH_TTS_LANE_ID);
  const whisperLane = getLane(ORCH_WHISPER_LANE_ID);
  const restartCounts = laneWorkloadCounts();
  const restartState = hasPendingRestartRequest()
    ? `queued (active=${restartCounts.active}, queued=${restartCounts.queued})`
    : "none";
  const routerModel = String(ORCH_ROUTER_MODEL || CODEX_MODEL || "").trim() || "(default)";
  const routerReasoning = String(ORCH_ROUTER_REASONING_EFFORT || "").trim() || "(default)";
  const whisperKeepaliveState = !WHISPER_KEEPALIVE
    ? "off"
    : whisperKeepalive.ready
      ? "ready"
      : whisperKeepalive.startPromise
        ? "warming"
        : whisperKeepalive.proc
          ? "starting"
          : "idle";
  const ttsKeepaliveState = !TTS_KEEPALIVE
    ? "off"
    : ttsKeepalive.ready
      ? "ready"
      : ttsKeepalive.startPromise
        ? "warming"
        : ttsKeepalive.proc
          ? "starting"
          : "idle";
  const ttsBatchMode = !TTS_BATCH_PIPELINED
    ? "batch"
    : TTS_BATCH_PIPELINED_MAX_CHUNKS > 0
      ? `adaptive (pipeline<=${TTS_BATCH_PIPELINED_MAX_CHUNKS})`
      : "pipelined";

  const lines = [
    fmtBold("Status"),
    "",
    fmtBold("Chat"),
    `- active_worker: ${activeWorkerLabel}`,
    `- active_session: ${activeSession ? shortSessionId(activeSession) : "(none)"}`,
    `- model: ${effectiveModel}${prefs.model ? " (chat override)" : ""}`,
    `- reasoning: ${effectiveReasoning}${prefs.reasoning ? " (chat override)" : ""}`,
    "",
    fmtBold("Orchestrator"),
    `- workers: ${codexWorkers.length}/${ORCH_MAX_CODEX_WORKERS}`,
    `- queue: ${queued}/${queueCap}`,
    `- exec_mode: ${codexMode.mode}`,
    `- chat_actions: ${TELEGRAM_CHAT_ACTION_ENABLED ? `enabled (default=${TELEGRAM_CHAT_ACTION_DEFAULT}, voice=${TELEGRAM_CHAT_ACTION_VOICE}, interval=${TELEGRAM_CHAT_ACTION_INTERVAL_SEC}s)` : "disabled"}`,
    `- router: ${ORCH_ROUTER_ENABLED ? "enabled" : "disabled"} (model=${routerModel}, reasoning=${routerReasoning})`,
    `- split_routing: ${ORCH_SPLIT_ENABLED ? "enabled" : "disabled"} (max_tasks=${ORCH_SPLIT_MAX_TASKS})`,
    `- whisper: ${WHISPER_ENABLED ? "enabled" : "disabled"}`,
    `- whisper_keepalive: ${whisperKeepaliveState} (prewarm=${WHISPER_PREWARM_ON_STARTUP}, auto_restart=${WHISPER_KEEPALIVE_AUTO_RESTART})`,
    `- tts_keepalive: ${ttsKeepaliveState} (prewarm=${TTS_PREWARM_ON_STARTUP}, auto_restart=${TTS_KEEPALIVE_AUTO_RESTART})`,
    `- tts_batch_mode: ${ttsBatchMode}`,
    `- tts_lane: ${ttsLane?.currentJob ? "busy" : "idle"} (queued=${ttsLane?.queue?.length || 0})`,
    `- whisper_lane: ${whisperLane?.currentJob ? "busy" : "idle"} (queued=${whisperLane?.queue?.length || 0})`,
    `- restart: ${restartState}`,
    "",
    fmtBold("Config"),
    `- full_access: ${CODEX_DANGEROUS_FULL_ACCESS}`,
    `- sandbox: ${CODEX_SANDBOX}`,
    `- approval: ${CODEX_APPROVAL_POLICY}`,
    `- general_workdir: ${String(getCodexWorker(ORCH_GENERAL_WORKER_ID)?.workdir || CODEX_WORKDIR)}`,
    `- time: ${nowIso()}`,
  ];

  if (codexWorkers.length > 0) {
    lines.push("", fmtBold("Workers"));
    const workersToShow = activeWorkerId
      ? [...codexWorkers].sort((a, b) => {
        if (a.id === activeWorkerId && b.id !== activeWorkerId) return -1;
        if (b.id === activeWorkerId && a.id !== activeWorkerId) return 1;
        return 0;
      })
      : codexWorkers;
    for (const [index, w] of workersToShow.entries()) {
      const lane = getLane(w.id);
      const job = lane?.currentJob || null;
      const busy = Boolean(job);
      const queuedCount = lane?.queue?.length || 0;
      const activeTag = w.id === activeWorkerId ? " (active)" : "";

      let state = busy ? "busy" : "idle";
      if (busy && job) {
        const secs = job.startedAt ? Math.floor((Date.now() - job.startedAt) / 1000) : 0;
        const kind = String(job.kind || "").trim();
        const parts = [];
        if (kind) parts.push(kind);
        if (Number.isFinite(job.id)) parts.push(`#${job.id}`);
        if (Number.isFinite(secs) && secs >= 0) parts.push(`${secs}s`);
        const summary = parts.join(" ");
        if (summary) state = `${state} ${summary}`;
      }

      const sessionId = getSessionForChatWorker(chatId, w.id);
      const sessionShort = sessionId ? shortSessionId(sessionId) : "(none)";
      const wid = w.id === activeWorkerId ? fmtBold(w.id) : w.id;
      const workerName = String(w.name || "").trim() || "(unnamed)";
      if (index > 0) lines.push("");
      lines.push(`- worker: ${wid}${activeTag}`);
      lines.push(`- name: ${workerName}`);
      lines.push(`- title: ${w.title}`);
      lines.push(`- kind: ${w.kind}`);
      lines.push(`- state: ${state}`);
      lines.push(`- queue: ${queuedCount}`);
      lines.push(`- session: ${sessionShort}`);
    }
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function sendWorkers(chatId) {
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const workers = listCodexWorkers();
  const activeWorker = activeWorkerId ? getCodexWorker(activeWorkerId) : null;
  const activeLabel = activeWorker
    ? `${activeWorkerId} (${String(activeWorker.name || activeWorker.title || activeWorkerId).trim()})`
    : activeWorkerId || "(none)";

  const lines = [
    `${fmtBold("Workers")} (${workers.length}/${ORCH_MAX_CODEX_WORKERS})`,
    `- active: ${activeLabel}`,
  ];

  if (workers.length === 0) {
    lines.push("- (none)");
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  lines.push("", fmtBold("List"));
  for (const w of workers) {
    const lane = getLane(w.id);
    const busy = Boolean(lane?.currentJob);
    const queued = lane?.queue?.length || 0;
    const marker = "-";
    const wid = w.id === activeWorkerId ? fmtBold(w.id) : w.id;
    const displayName = String(w.name || "").trim() || String(w.title || "").trim() || w.id;
    const repoTag = w.title && w.title !== displayName ? ` | repo=${w.title}` : "";
    lines.push(
      `${marker} ${wid}: ${displayName} (${w.kind}) | busy=${busy} | queued=${queued}${repoTag} | workdir=${String(w.workdir || "").replace(/\\/g, "/")}`,
    );
  }

  lines.push(
    "",
    fmtBold("Commands"),
    "/use <worker_id, name, or title> - switch active workspace",
    "/spawn <local-path> [title] - create a new repo workspace",
    "/retire <worker_id, name, or title> - remove a workspace",
  );

  await sendMessage(chatId, lines.join("\n"));
}

function getEffectiveModelChoices() {
  const out = [];
  const seen = new Set();
  const add = (m) => {
    const s = String(m || "").trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  add(CODEX_MODEL);
  for (const m of CODEX_MODEL_CHOICES) add(m);
  return out.length > 0 ? out.slice(0, 12) : [];
}

function getEffectiveReasoningChoices() {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const v of CODEX_REASONING_EFFORT_CHOICES) add(v);
  if (out.length === 0) {
    for (const v of ["low", "medium", "high", "xhigh"]) add(v);
  }
  return out.slice(0, 8);
}

async function sendModelPicker(chatId) {
  const prefs = getChatPrefs(chatId);
  const effectiveModel = String(prefs.model || CODEX_MODEL || "").trim() || "(default)";
  const effectiveReasoning = String(prefs.reasoning || CODEX_REASONING_EFFORT || "").trim() || "(default)";

  const lines = [
    fmtBold("Model settings (this chat)"),
    `- model: ${effectiveModel}${prefs.model ? " (override)" : ""}`,
    `- reasoning: ${effectiveReasoning}${prefs.reasoning ? " (override)" : ""}`,
    "",
    fmtBold("Pick a model"),
    fmtBold("Pick a reasoning effort"),
  ];

  const keyboard = [];
  const modelChoices = getEffectiveModelChoices();
  for (let i = 0; i < modelChoices.length; i += 2) {
    const row = [];
    for (const m of modelChoices.slice(i, i + 2)) {
      const id = registerPrefButton(chatId, "model", m);
      row.push({ text: m === effectiveModel ? `* ${m}` : m, callback_data: `pref:${id}` });
    }
    keyboard.push(row);
  }

  const reasoningChoices = getEffectiveReasoningChoices();
  for (let i = 0; i < reasoningChoices.length; i += 2) {
    const row = [];
    for (const r of reasoningChoices.slice(i, i + 2)) {
      const label = r === effectiveReasoning ? `* ${r}` : r;
      const id = registerPrefButton(chatId, "reasoning", r);
      row.push({ text: label, callback_data: `pref:${id}` });
    }
    keyboard.push(row);
  }

  const resetId = registerPrefButton(chatId, "reset", "reset");
  keyboard.push([{ text: "Reset to defaults", callback_data: `pref:${resetId}` }]);

  await sendMessage(chatId, lines.join("\n"), {
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function sendQueue(chatId) {
  const items = listQueuedJobsForChat(chatId);
  if (items.length === 0) {
    await sendMessage(chatId, `${fmtBold("Queue")} is empty.`);
    return;
  }
  const lines = [fmtBold("Queued prompts")];
  for (const entry of items.slice(0, 10)) {
    const item = entry.job;
    const laneId = String(entry.laneId || "").trim();
    const kind = String(item?.kind || "codex");
    let preview = "";
    if (kind === "tts-batch") {
      const texts = Array.isArray(item?.texts) ? item.texts : [];
      const count = texts.length;
      const first = String(texts[0] || "").trim();
      const head = first.length > 70 ? `${first.slice(0, 70)}...` : first;
      preview = `[tts-batch x${count || "?"}] ${head || "(empty)"}`;
    } else {
      const t = String(item?.text || "").trim();
      preview = t.length > 90 ? `${t.slice(0, 90)}...` : t || "(empty)";
      if (kind === "tts") preview = `[tts] ${preview}`;
      if (kind === "raw") preview = `[raw] ${preview}`;
    }
    const workerId = String(item?.workerId || "").trim();
    const worker = workerId ? getCodexWorker(workerId) : null;
    const workerName = String(worker?.name || worker?.title || worker?.id || "").trim();
    const label = worker
      ? `${worker.id}:${workerName || worker.id}`
      : laneId || "(unknown)";
    lines.push(`- #${item.id} (${label}): ${preview}`);
  }
  if (items.length > 10) {
    lines.push(`- ...and ${items.length - 10} more`);
  }
  await sendMessage(chatId, lines.join("\n"));
}

async function sendResumePicker(chatId) {
  const sessions = listRecentCodexSessions(RESUME_LIST_LIMIT);
  if (sessions.length === 0) {
    await sendMessage(chatId, `${fmtBold("Resume")}\nNo local AIDOLON sessions found in:\n${CODEX_SESSIONS_DIR}`);
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

  await sendMessage(chatId, `${fmtBold("Resume")}\nSelect a session:`, {
    replyMarkup: { inline_keyboard: keyboard },
  });
}

async function sendCodexCommandMenu(chatId) {
  const commands = getCodexTopCommands();
  const lines = [
    fmtBold("AIDOLON command menu"),
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
  const jobs = listActiveJobsForChat(chatId);
  if (jobs.length === 0) {
    await sendMessage(chatId, "No active AIDOLON run to cancel.");
    await maybeTriggerPendingRestart("idle");
    return;
  }

  for (const item of jobs) {
    const job = item.job;
    if (!job) continue;
    job.cancelRequested = true;
    try {
      if (job.abortController instanceof AbortController) {
        job.abortController.abort();
      }
    } catch {
      // best effort
    }
    if (job.process) {
      terminateChildTree(job.process, { forceAfterMs: 2000 });
    }
  }

  const label = jobs.length === 1 ? `job #${jobs[0].job?.id}` : `${jobs.length} job(s)`;
  await sendMessage(chatId, `Cancellation requested for ${label}.`);
  await maybeTriggerPendingRestart("cancellation");
}

async function clearQueue(chatId) {
  const removed = dropQueuedJobsForChat(chatId);
  await sendMessage(chatId, `Cleared ${removed} queued prompt(s).`);
  await maybeTriggerPendingRestart("queue cleared");
}

function wipeRecordError(summary, targetPath, err) {
  if (!summary || !Array.isArray(summary.errors)) return;
  if (summary.errors.length >= 8) return;
  const rel = path.relative(ROOT, String(targetPath || "").trim());
  const label = rel && rel !== "." ? rel : String(targetPath || "").trim();
  summary.errors.push(`${label || "(unknown)"}: ${String(err?.message || err)}`);
}

function wipeRemovePathTree(targetPath, summary) {
  let st = null;
  try {
    st = fs.lstatSync(targetPath);
  } catch {
    return;
  }

  if (st.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch (err) {
      wipeRecordError(summary, targetPath, err);
      return;
    }
    for (const entry of entries) {
      wipeRemovePathTree(path.join(targetPath, entry.name), summary);
    }
    try {
      fs.rmdirSync(targetPath);
      summary.deletedDirs += 1;
    } catch (err) {
      wipeRecordError(summary, targetPath, err);
    }
    return;
  }

  if (st.isFile()) {
    summary.deletedFiles += 1;
    summary.deletedBytes += Number(st.size || 0);
  }

  try {
    fs.rmSync(targetPath, { force: true, recursive: false });
  } catch (err) {
    wipeRecordError(summary, targetPath, err);
  }
}

function wipeDirectoryContents(dirPath, summary) {
  try {
    ensureDir(dirPath);
  } catch (err) {
    wipeRecordError(summary, dirPath, err);
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    wipeRecordError(summary, dirPath, err);
    return;
  }
  for (const entry of entries) {
    wipeRemovePathTree(path.join(dirPath, entry.name), summary);
  }
}

function wipeRuntimeArtifacts() {
  const summary = {
    deletedFiles: 0,
    deletedDirs: 0,
    deletedBytes: 0,
    errors: [],
  };

  wipeDirectoryContents(OUT_DIR, summary);
  wipeDirectoryContents(VOICE_DIR, summary);
  wipeDirectoryContents(IMAGE_DIR, summary);
  wipeDirectoryContents(TTS_DIR, summary);
  wipeRemovePathTree(CHAT_LOG_PATH, summary);

  let runtimeEntries = [];
  try {
    runtimeEntries = fs.readdirSync(RUNTIME_DIR, { withFileTypes: true });
  } catch (err) {
    wipeRecordError(summary, RUNTIME_DIR, err);
    return summary;
  }
  for (const entry of runtimeEntries) {
    if (!entry.isFile()) continue;
    if (!/^state\.json\.tmp-/i.test(entry.name)) continue;
    wipeRemovePathTree(path.join(RUNTIME_DIR, entry.name), summary);
  }

  return summary;
}

function wipeChatState(chatId) {
  const key = String(chatId || "").trim();
  const out = {
    queuedRemoved: 0,
    pendingCommandCleared: false,
    stateChanged: false,
  };
  if (!key) return out;

  out.queuedRemoved = dropQueuedJobsForChat(key);
  out.pendingCommandCleared = Boolean(clearPendingCommandForChat(key));
  clearPendingNaturalNewsFollowup(key);

  const dropChatKey = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    delete obj[key];
    return true;
  };

  let changed = false;
  if (dropChatKey(lastImages)) changed = true;
  if (dropChatKey(chatPrefs)) changed = true;
  if (dropChatKey(redditDigest)) changed = true;
  if (dropChatKey(orchActiveWorkerByChat)) changed = true;
  if (dropChatKey(orchSessionByChatWorker)) changed = true;
  if (dropChatKey(orchReplyRouteByChat)) changed = true;
  if (dropChatKey(orchMessageMetaByChat)) changed = true;
  if (dropChatKey(orchTasksByChat)) changed = true;
  if (changed) {
    persistState();
  }

  out.stateChanged = changed;
  return out;
}

async function wipeRuntime(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;

  const { active, queued } = laneWorkloadCounts();
  if (active > 0 || queued > 0) {
    await sendMessage(
      key,
      `Cannot run /wipe while workers are busy (active=${active}, queued=${queued}). Use /cancel and /clear, wait for idle, then retry.`,
    );
    return;
  }

  const runtime = wipeRuntimeArtifacts();
  const chat = wipeChatState(key);
  await maybeTriggerPendingRestart("wipe");

  const lines = [
    "Wipe complete.",
    `- Runtime files deleted: ${runtime.deletedFiles}`,
    `- Runtime directories removed: ${runtime.deletedDirs}`,
    `- Runtime bytes freed: ${runtime.deletedBytes}`,
    `- Queued prompts cleared (this chat): ${chat.queuedRemoved}`,
    `- Pending /cmd cleared (this chat): ${chat.pendingCommandCleared ? "yes" : "no"}`,
    `- Chat context reset in state (this chat): ${chat.stateChanged ? "yes" : "no"}`,
  ];
  if (runtime.errors.length > 0) {
    lines.push(`- Warnings: ${runtime.errors.length}`);
    lines.push(...runtime.errors.slice(0, 3).map((e) => `  - ${e}`));
  }
  await sendMessage(key, lines.join("\n"));
}

async function enqueueRawCodexCommand(chatId, args, source = "cmd", options = {}) {
  const tokens = Array.isArray(args) ? [...args] : [];
  if (tokens.length === 0) {
    await sendMessage(chatId, "No AIDOLON command to run.");
    return;
  }

  const requestedWorkerId = String(options?.workerId || "").trim();
  const workerId = requestedWorkerId || getActiveWorkerForChat(chatId);
  const lane = ensureWorkerLane(workerId) || ensureWorkerLane(ORCH_GENERAL_WORKER_ID);
  if (!lane) {
    await sendMessage(chatId, "No available worker to run this command.");
    return;
  }

  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return;
  }

  if (options?.setActiveWorker !== false) {
    setActiveWorkerForChat(chatId, lane.id);
  }
  touchWorker(lane.id);

  const job = {
    id: nextJobId++,
    chatId,
    source,
    kind: "raw",
    workerId: lane.id,
    rawArgs: tokens,
    resumeSessionId: "",
    text: "",
    workdir: lane.workdir,
    replyToMessageId: Number(options?.replyToMessageId || 0),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    outputFile: "",
  };

  lane.queue.push(job);
  void processLane(lane.id);
}

async function runRawCodexJob(job) {
  let spec;
  try {
    spec = buildRawCodexSpec(job);
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

    const timeout = CODEX_TIMEOUT_MS > 0
      ? setTimeout(() => {
        job.timedOut = true;
        terminateChildTree(child, { forceAfterMs: 3000 });
      }, CODEX_TIMEOUT_MS)
      : null;

    child.stdout.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stdoutTail = appendTail(job.stdoutTail, chunk, 50000);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
    });
    child.stderr.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stderrTail = appendTail(job.stderrTail, chunk, 50000);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
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
  const parsed = parseCommand(text) || parseNaturalCommand(text);
  if (!parsed) return false;

  clearPendingNaturalNewsFollowup(chatId);

  if (shouldRunCommandInBackground(parsed)) {
    enqueueBackgroundCommand(chatId, parsed, async () => {
      await handleParsedCommand(chatId, parsed);
    });
    return true;
  }

  return await handleParsedCommand(chatId, parsed);
}

async function handleParsedCommand(chatId, parsed) {
  switch (parsed.cmd) {
    case "/help":
      await sendHelp(chatId);
      return true;
    case "/start":
      // Telegram's /start should behave like "new chat": clear any active resumed session.
      clearAllSessionsForChat(chatId);
      setActiveWorkerForChat(chatId, ORCH_GENERAL_WORKER_ID);
      clearLastImageForChat(chatId);
      await sendHelp(chatId);
      return true;
    case "/codex":
    case "/commands":
      await sendCodexCommandMenu(chatId);
      return true;
    case "/status":
      await sendStatus(chatId);
      return true;
    case "/workers":
      await sendWorkers(chatId);
      return true;
    case "/use": {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /use <worker_id, name, or title>\nTip: use /workers to list workers.");
        return true;
      }
      const wid = resolveWorkerIdFromUserInput(arg);
      if (!wid) {
        await sendMessage(chatId, `Unknown worker: ${arg}\nUse /workers to list workers.`);
        return true;
      }
      setActiveWorkerForChat(chatId, wid);
      touchWorker(wid);
      const worker = getCodexWorker(wid);
      const label = worker
        ? `${String(worker.name || worker.title || wid).trim() || wid} (${wid})`
        : wid;
      await sendMessage(chatId, `Active workspace set to: ${label}`);
      return true;
    }
    case "/spawn": {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /spawn <local-path> [title]\nExample: /spawn C:/path/to/repo MyRepo");
        return true;
      }
      const parts = parseArgString(arg);
      const rawPath = String(parts[0] || "").trim();
      const title = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
      const workdir = resolveWorkdirInput(rawPath);
      if (!workdir || !fs.existsSync(workdir)) {
        await sendMessage(chatId, "That path does not exist. Please send an existing local path.");
        return true;
      }
      const existing = findWorkerByWorkdir(workdir);
      if (existing) {
        setActiveWorkerForChat(chatId, existing);
        touchWorker(existing);
        const worker = getCodexWorker(existing);
        const name = String(worker?.name || worker?.title || existing).trim() || existing;
        const titleInfo = String(worker?.title || "").trim();
        const details = titleInfo && titleInfo !== name ? `${name} (${existing}, ${titleInfo})` : `${name} (${existing})`;
        await sendMessage(chatId, `Using existing workspace ${details}.`);
        return true;
      }
      const count = listCodexWorkers().length;
      if (count >= ORCH_MAX_CODEX_WORKERS) {
        await sendMessage(chatId, `Worker limit reached (${ORCH_MAX_CODEX_WORKERS}). Retire one with /retire <worker_id, name, or title> first, or use an existing worker.`);
        return true;
      }
      let wid = "";
      try {
        wid = createRepoWorker(workdir, title);
      } catch (err) {
        await sendMessage(chatId, `Failed to create workspace: ${String(err?.message || err)}`);
        return true;
      }
      setActiveWorkerForChat(chatId, wid);
      touchWorker(wid);
      {
        const worker = getCodexWorker(wid);
        const name = String(worker?.name || worker?.title || wid).trim() || wid;
        const titleInfo = String(worker?.title || "").trim();
        const details = titleInfo && titleInfo !== name ? `${name} (${wid}, ${titleInfo})` : `${name} (${wid})`;
        await sendMessage(chatId, `Created workspace ${details}.`);
      }
      return true;
    }
    case "/retire": {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /retire <worker_id, name, or title>\nTip: use /workers to list workers.");
        return true;
      }
      const wid = resolveWorkerIdFromUserInput(arg);
      if (!wid) {
        await sendMessage(chatId, `Unknown worker: ${arg}\nUse /workers to list workers.`);
        return true;
      }
      try {
        retireWorker(wid);
      } catch (err) {
        await sendMessage(chatId, `Failed to retire worker: ${String(err?.message || err)}`);
        return true;
      }
      await sendMessage(chatId, `Retired worker: ${wid}`);
      return true;
    }
    case "/queue":
      await sendQueue(chatId);
      return true;
    case "/news":
      await handleNewsCommand(chatId, parsed.arg || "");
      return true;
    case "/cancel":
    case "/stop":
      await cancelCurrent(chatId);
      return true;
    case "/clear":
      await clearQueue(chatId);
      return true;
    case "/wipe":
      await wipeRuntime(chatId);
      return true;
    case "/screenshot":
      try {
        await handleScreenshotCommand(chatId);
      } catch (err) {
        await sendMessage(chatId, `Screenshot failed: ${String(err?.message || err)}`);
      }
      return true;
    case "/sendfile": {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /sendfile <relative-path> [caption]");
        return true;
      }
      const parts = parseArgString(arg);
      const relPath = String(parts[0] || "").trim();
      const caption = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
      if (!relPath) {
        await sendMessage(chatId, "Usage: /sendfile <relative-path> [caption]");
        return true;
      }
      await sendAttachments(chatId, [{ path: relPath, caption }]);
      return true;
    }
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
    case "/model": {
      const arg = String(parsed.arg || "").trim().toLowerCase();
      if (["clear", "reset", "defaults", "default", "off", "none"].includes(arg)) {
        clearChatPrefs(chatId);
        await sendMessage(chatId, "Model preferences cleared for this chat (back to defaults).");
        return true;
      }
      await sendModelPicker(chatId);
      return true;
    }
    case "/ask": {
      if (!VISION_ENABLED) {
        await sendMessage(chatId, "Vision is disabled on this bot (VISION_ENABLED=0).");
        return true;
      }
      const q = String(parsed.arg || "").trim();
      if (!q) {
        await sendMessage(chatId, "Usage: /ask <question> (analyzes your last sent image)");
        return true;
      }
      const img = getLastImageForChat(chatId);
      if (!img) {
        await sendMessage(chatId, "No image found for this chat. Send an image first (optionally with a caption).");
        return true;
      }
      const activeSession = getActiveSessionForChat(chatId);
      await enqueuePrompt(chatId, q, "ask-image", {
        resumeSessionId: activeSession || "",
        imagePaths: [img.path],
      });
      return true;
    }
    case "/see": {
      if (!VISION_ENABLED) {
        await sendMessage(chatId, "Vision is disabled on this bot (VISION_ENABLED=0).");
        return true;
      }
      const q = String(parsed.arg || "").trim();
      if (!q) {
        await sendMessage(chatId, "Usage: /see <question> (takes a screenshot, then analyzes it)");
        return true;
      }
      if (process.platform !== "win32") {
        await sendMessage(chatId, "Screenshot vision is only configured for Windows in this bot.");
        return true;
      }

      const prefix = `see-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      void (async () => {
        try {
          const paths = await captureScreenshotsWithFallback(IMAGE_DIR, prefix);
          // Keep the primary screenshot as the "last image" context.
          const primaryPath = String(paths[0] || "").trim();
          if (primaryPath) {
            setLastImageForChat(chatId, { path: primaryPath, mime: "image/png", name: path.basename(primaryPath) });
          }
          const activeSession = getActiveSessionForChat(chatId);
          await enqueuePrompt(chatId, q, "see-screenshot", {
            resumeSessionId: activeSession || "",
            imagePaths: paths,
          });
        } catch (err) {
          await sendMessage(chatId, `Screenshot vision failed: ${String(err?.message || err)}`);
        }
      })();
      return true;
    }
    case "/imgclear": {
      clearLastImageForChat(chatId);
      await sendMessage(chatId, "Cleared last image context.");
      return true;
    }
    case "/tts": {
      if (!TTS_ENABLED) {
        await sendMessage(chatId, "TTS is disabled on this bot (TTS_ENABLED=0).");
        return true;
      }
      const q = String(parsed.arg || "").trim();
      if (!q) {
        await sendMessage(chatId, "Usage: /tts <text>");
        return true;
      }
      // Never truncate user input for TTS; split into as many voice notes as needed.
      const { chunks, overflowText } = splitSpeakableTextIntoVoiceChunks(q);
      const all = chunks.length > 0 ? chunks : [q];
      if (overflowText) all.push(overflowText);
      if (all.length > 1) {
        await enqueueTtsBatch(chatId, all, "tts-command");
      } else {
        await enqueueTts(chatId, all[0], "tts-command");
      }
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
    case "/restart": {
      const tokens = parseArgString(parsed.arg || "")
        .map((x) => String(x || "").trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
        .filter(Boolean);
      const wantsCancel = tokens.some((t) => ["cancel", "off", "stop", "abort"].includes(t));
      if (wantsCancel) {
        const hadPending = cancelPendingRestartRequest();
        await sendMessage(chatId, hadPending ? "Queued restart canceled." : "No queued restart is pending.");
        return true;
      }

      const forceNow = tokens.some((t) => ["now", "force", "immediate"].includes(t));
      await requestRestartWhenIdle(chatId, { forceNow });
      return true;
    }
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

  const requestedWorkerId = String(options?.workerId || "").trim();
  const workerId = requestedWorkerId || getActiveWorkerForChat(chatId);
  const lane = ensureWorkerLane(workerId) || ensureWorkerLane(ORCH_GENERAL_WORKER_ID);
  if (!lane) {
    await sendMessage(chatId, "No available worker to handle this prompt.");
    return;
  }

  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return;
  }

  if (options?.setActiveWorker !== false) {
    setActiveWorkerForChat(chatId, lane.id);
  }
  touchWorker(lane.id);

  const resumeSessionId = Object.prototype.hasOwnProperty.call(options || {}, "resumeSessionId")
    ? String(options.resumeSessionId || "").trim()
    : getActiveSessionForChat(chatId, lane.id);
  let taskId = Number(options?.taskId || 0);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    taskId = createOrchTask(chatId, {
      workerId: lane.id,
      prompt: text,
      source: String(source || "").trim().toLowerCase(),
      originMessageId: Number(options?.originMessageId || options?.replyToMessageId || 0),
      replyToMessageId: Number(options?.replyToMessageId || 0),
      splitGroupId: String(options?.splitGroupId || "").trim(),
    });
  }

  const job = {
    id: nextJobId++,
    chatId,
    text,
    source,
    kind: "codex",
    workerId: lane.id,
    replyStyle: String(options.replyStyle || "").trim(),
    resumeSessionId,
    model: String(options.model || "").trim(),
    reasoning: String(options.reasoning || "").trim(),
    imagePaths: Array.isArray(options.imagePaths)
      ? options.imagePaths.map((p) => String(p || "").trim()).filter(Boolean)
      : [],
    replyContext: options?.replyContext && typeof options.replyContext === "object"
      ? { ...options.replyContext }
      : null,
    replyThreadContext: options?.replyThreadContext && typeof options.replyThreadContext === "object"
      ? { ...options.replyThreadContext }
      : null,
    recentHistoryContext: options?.recentHistoryContext && typeof options.recentHistoryContext === "object"
      ? { ...options.recentHistoryContext }
      : null,
    workdir: lane.workdir,
    taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
    splitGroupId: String(options?.splitGroupId || "").trim(),
    replyToMessageId: Number(options?.replyToMessageId || 0),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    outputFile: path.join(OUT_DIR, `codex-job-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
    forcedTextOnly: String(options.forcedTextOnly || "").trim(),
    onSuccess: typeof options.onSuccess === "function" ? options.onSuccess : null,
  };

  lane.queue.push(job);
  void processLane(lane.id);
}

function normalizeTtsText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const squashed = trimmed.replace(/\s+/g, " ").trim();
  return squashed;
}

function splitVoiceReplyParts(text) {
  const src = String(text || "").trim();
  if (!src) return { spoken: "", textOnly: "" };

  // Preferred format (case-insensitive):
  // SPOKEN:
  // ...
  //
  // TEXT_ONLY:
  // ...
  //
  // If the markers are missing, treat everything as spoken and leave textOnly empty.
  // Be tolerant: models sometimes omit the trailing newline after the marker when the section is empty.
  // Also allow same-line content (e.g. "SPOKEN: hello") even though we prefer a newline.
  const spokenRe = /(^|\n)\s*SPOKEN\s*:[ \t]*(?:\r?\n)?/i;
  const textRe = /(^|\n)\s*TEXT[_ ]?ONLY\s*:[ \t]*(?:\r?\n)?/i;

  let spokenMatch = spokenRe.exec(src);
  let textMatch = textRe.exec(src);

  // Fallback: models sometimes compress the format onto a single line, e.g.:
  // "SPOKEN: hello TEXT_ONLY:"
  // In that case TEXT_ONLY isn't at a line start, so the strict regex won't match.
  if (spokenMatch && !textMatch) {
    const spokenStartStrict = spokenMatch.index + spokenMatch[0].length;
    const looseTextRe = /\bTEXT[_ ]?ONLY\s*:[ \t]*(?:\r?\n)?/i;
    const m = looseTextRe.exec(src);
    if (m && m.index >= spokenStartStrict) textMatch = m;
  } else if (textMatch && !spokenMatch) {
    const looseSpokenRe = /\bSPOKEN\s*:[ \t]*(?:\r?\n)?/i;
    const m = looseSpokenRe.exec(src);
    if (m && m.index <= textMatch.index) spokenMatch = m;
  }

  // If a loose TEXT_ONLY match happens to appear before SPOKEN, treat it as normal text.
  if (spokenMatch && textMatch && textMatch.index < spokenMatch.index) {
    textMatch = null;
  }

  if (!spokenMatch && !textMatch) {
    return { spoken: src, textOnly: "" };
  }

  const spokenStart = spokenMatch ? spokenMatch.index + spokenMatch[0].length : 0;
  if (textMatch && textMatch.index < spokenStart) {
    // Likely a false positive / bad marker order.
    textMatch = null;
  }
  const textStart = textMatch ? textMatch.index + textMatch[0].length : -1;

  if (textStart >= 0) {
    const spoken = src.slice(spokenStart, textMatch ? textMatch.index : src.length).trim();
    const textOnly = src.slice(textStart).trim();
    return { spoken, textOnly };
  }

  // Only SPOKEN marker present.
  return { spoken: src.slice(spokenStart).trim(), textOnly: "" };
}

function injectForcedTextOnlySection(text, forcedTextOnly) {
  const fixed = String(forcedTextOnly || "").trim();
  const src = String(text || "").trim();
  if (!fixed) return src;

  const parts = splitVoiceReplyParts(src);
  const spoken = String(parts?.spoken || "").trim();
  if (spoken) {
    return `SPOKEN:\n${spoken}\n\nTEXT_ONLY:\n${fixed}`;
  }
  if (src) {
    return `${src}\n\nTEXT_ONLY:\n${fixed}`;
  }
  return `SPOKEN:\n\nTEXT_ONLY:\n${fixed}`;
}

function _stripOptionalQuotes(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return s;
}

function _isPathInside(rootDir, candidatePath) {
  const rel = path.relative(rootDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveAttachPath(inputPath, options = {}) {
  const raw = String(inputPath || "").trim();
  if (!raw) throw new Error("empty path");

  const workerId = String(options?.workerId || "").trim();
  const worker = workerId ? getCodexWorker(workerId) : null;
  const workerOutDir = worker && worker.kind === "repo" && worker.workdir
    ? path.join(worker.workdir, "runtime", "out")
    : "";

  const allowedRoots = [ATTACH_ROOT, workerOutDir]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => {
      try {
        return path.resolve(p);
      } catch {
        return p;
      }
    });

  const baseDirs = [ATTACH_ROOT, ROOT, worker?.workdir || "", workerOutDir]
    .map((p) => String(p || "").trim())
    .filter(Boolean);

  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    for (const base of baseDirs) {
      try {
        candidates.push(path.resolve(base, raw));
      } catch {
        // best effort
      }
    }
  }

  const uniqueCandidates = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = String(c || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(key);
  }

  const isAllowed = (p) => allowedRoots.some((root) => _isPathInside(root, p));

  let hadAllowedCandidate = false;
  for (const resolved of uniqueCandidates) {
    if (!isAllowed(resolved)) continue;
    hadAllowedCandidate = true;
    if (!fs.existsSync(resolved)) continue;
    const st = fs.statSync(resolved);
    if (!st.isFile()) continue;
    const limMb = Number(ATTACH_MAX_FILE_MB);
    const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
    if (Number.isFinite(maxBytes) && st.size > maxBytes) {
      throw new Error(`file too large (${Math.round(st.size / (1024 * 1024))}MB > ${ATTACH_MAX_FILE_MB}MB)`);
    }
    return resolved;
  }

  if (!hadAllowedCandidate) {
    throw new Error("path is outside allowed attachment roots");
  }
  throw new Error("file does not exist");
}

function extractAttachDirectives(text) {
  const src = String(text || "");
  if (!src) return { text: "", attachments: [] };

  const attachments = [];
  const kept = [];
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*ATTACH(?:_FILE)?\s*:\s*(.+?)\s*$/i.exec(String(line || ""));
    if (!m) {
      kept.push(line);
      continue;
    }
    const rest = String(m[1] || "").trim();
    if (!rest) continue;
    const parts = rest.split("|");
    const p = _stripOptionalQuotes(String(parts[0] || "").trim());
    const caption = parts.length > 1 ? parts.slice(1).join("|").trim() : "";
    if (!p) continue;
    attachments.push({ path: p, caption });
  }

  return { text: kept.join("\n").trim(), attachments };
}

async function sendAttachments(chatId, attachments, options = {}) {
  if (!ATTACH_ENABLED) return [];
  const list = Array.isArray(attachments) ? attachments : [];
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const routeTaskId = Number(options.routeTaskId || 0);
  const routeSessionId = String(options.routeSessionId || "").trim();
  const sent = [];
  for (const item of list) {
    const rawPath = String(item?.path || "").trim();
    if (!rawPath) continue;
    let resolved;
    try {
      resolved = resolveAttachPath(rawPath, { workerId: routeWorkerId });
    } catch (err) {
      const msg = String(err?.message || err);
      const hint = msg === "file does not exist"
        ? " (Tip: ATTACH paths are relative to ATTACH_ROOT; don't include runtime/out/ twice.)"
        : "";
      await sendMessage(chatId, `Attachment skipped: ${rawPath} (${msg})${hint}`);
      continue;
    }

    const caption = String(item?.caption || "").trim();
    const fileName = path.basename(resolved);
    try {
      const msg = await sendDocument(chatId, resolved, {
        caption,
        fileName,
        timeoutMs: ATTACH_UPLOAD_TIMEOUT_MS,
        replyToMessageId,
        routeWorkerId,
        routeTaskId,
        routeSessionId,
      });
      if (msg && typeof msg === "object") sent.push(msg);
    } catch (err) {
      await sendMessage(chatId, `Failed to send attachment ${fileName}: ${String(err?.message || err)}`);
    }
  }
  return sent;
}

function extractNonSpeakableInfo(text) {
  const src = String(text || "");
  const pieces = [];

  // Fenced code blocks.
  const fenceRe = /```[\s\S]*?```/g;
  const fences = src.match(fenceRe) || [];
  if (fences.length > 0) {
    pieces.push("Code/log snippets:");
    pieces.push(fences.join("\n\n"));
  }

  // Inline code.
  const inlineRe = /`([^`\n]{1,200})`/g;
  const inline = [];
  let m;
  while ((m = inlineRe.exec(src)) !== null) {
    inline.push(m[1]);
    if (inline.length >= 12) break;
  }
  if (inline.length > 0) {
    pieces.push("Inline terms:");
    pieces.push(inline.map((s) => `- ${s}`).join("\n"));
  }

  // URLs.
  const urlRe = /\bhttps?:\/\/\S+\b/gi;
  const urls = (src.match(urlRe) || []).slice(0, 10);
  if (urls.length > 0) {
    pieces.push("Links:");
    pieces.push(urls.map((u) => `- ${u}`).join("\n"));
  }

  // File paths (best-effort).
  const pathOut = new Set();
  const winPathRe = /\b[a-zA-Z]:\\[^\s"'`<>|]+/g;
  for (const p of src.match(winPathRe) || []) pathOut.add(p);
  const nixPathRe = /(?:^|\s)(~?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
  while ((m = nixPathRe.exec(src)) !== null) {
    pathOut.add(m[1]);
    if (pathOut.size >= 12) break;
  }
  const paths = [...pathOut].slice(0, 12);
  if (paths.length > 0) {
    pieces.push("Paths:");
    pieces.push(paths.map((p) => `- ${p}`).join("\n"));
  }

  return pieces.join("\n");
}

function makeSpeakableTextForTts(text) {
  // Prefer the model following the voice prompt, but strip common formatting just in case.
  let out = String(text || "").trim();
  if (!out) return "";

  // If the model accidentally includes the voice format markers in the spoken part, strip them.
  // Don't require line breaks; models sometimes inline them ("... TEXT_ONLY:").
  out = out.replace(/\bSPOKEN\s*:\s*/gi, " ");
  out = out.replace(/\bTEXT[_ ]?ONLY\s*:\s*/gi, " ");

  // Remove fenced code blocks.
  out = out.replace(/```[\s\S]*?```/g, " ");

  // Strip inline backticks.
  out = out.replace(/`+/g, "");

  // Markdown links: keep label.
  out = out.replace(/!?\[([^\]]+?)\]\([^\)]+\)/g, "$1");

  // Bare URLs.
  out = out.replace(/\bhttps?:\/\/\S+\b/gi, "a link");

  // Windows and Unix-like file paths (best-effort; avoid over-matching normal text like "and/or").
  out = out.replace(/\b[a-zA-Z]:\\[^\s]+/g, "a file path");
  out = out.replace(/(?:^|\s)~?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g, " a file path");

  // Headings / bullets.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, "");

  // Collapse whitespace.
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function splitTextByMaxChars(text, maxChars) {
  const src = String(text || "").trim();
  if (!src) return [];
  const limit = Number.isFinite(maxChars) && maxChars > 10 ? Math.floor(maxChars) : 200;
  if (src.length <= limit) return [src];

  const words = src.split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const word of words) {
    const w = String(word || "");
    if (!w) continue;
    if (!cur) {
      if (w.length <= limit) {
        cur = w;
        continue;
      }
      for (let i = 0; i < w.length; i += limit) {
        out.push(w.slice(i, i + limit));
      }
      continue;
    }
    if (cur.length + 1 + w.length <= limit) {
      cur = `${cur} ${w}`;
    } else {
      out.push(cur);
      cur = "";
      if (w.length <= limit) {
        cur = w;
      } else {
        for (let i = 0; i < w.length; i += limit) {
          out.push(w.slice(i, i + limit));
        }
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitIntoSentencesBestEffort(text) {
  const src = String(text || "").trim();
  if (!src) return [];

  // Prefer Intl.Segmenter when available (better multilingual handling).
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const out = [];
      for (const item of seg.segment(src)) {
        const part = String(item?.segment || "").trim();
        if (part) out.push(part);
      }
      if (out.length > 0) return out;
    }
  } catch {
    // fall through
  }

  // Fallback: split on sentence punctuation when followed by whitespace/end.
  const out = [];
  let buf = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    buf += ch;
    if (ch === "." || ch === "!" || ch === "?") {
      const next = src[i + 1] || "";
      if (!next || /\s/.test(next)) {
        const piece = buf.trim();
        if (piece) out.push(piece);
        buf = "";
      }
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [src];
}

function splitSpeakableTextIntoVoiceChunks(text) {
  const src = String(text || "").trim();
  if (!src) return { chunks: [], overflowText: "" };

  // 0 disables the relevant cap.
  const maxCharsCandidates = [];
  if (Number.isFinite(TTS_MAX_TEXT_CHARS) && TTS_MAX_TEXT_CHARS > 0) maxCharsCandidates.push(TTS_MAX_TEXT_CHARS);
  if (Number.isFinite(TTS_VOICE_MAX_CHARS) && TTS_VOICE_MAX_CHARS > 0) maxCharsCandidates.push(TTS_VOICE_MAX_CHARS);
  let maxChars = maxCharsCandidates.length > 0 ? Math.min(...maxCharsCandidates) : Infinity;
  if (Number.isFinite(maxChars)) {
    // Extremely small values produce awkward chunks and can cause slow splitting.
    maxChars = Math.max(20, Math.floor(maxChars));
  }

  const maxSentences = Number.isFinite(TTS_VOICE_MAX_SENTENCES) && TTS_VOICE_MAX_SENTENCES > 0
    ? Math.floor(TTS_VOICE_MAX_SENTENCES)
    : Infinity;

  const maxChunks = Number.isFinite(TTS_VOICE_MAX_CHUNKS) && TTS_VOICE_MAX_CHUNKS > 0
    ? Math.floor(TTS_VOICE_MAX_CHUNKS)
    : Infinity;

  const rawSentences = splitIntoSentencesBestEffort(src);
  const units = [];
  for (const s of rawSentences) {
    const piece = String(s || "").trim();
    if (!piece) continue;
    if (piece.length <= maxChars) {
      units.push(piece);
    } else {
      units.push(...splitTextByMaxChars(piece, maxChars));
    }
  }
  if (units.length === 0) return { chunks: [], overflowText: "" };

  const chunks = [];
  let cur = "";
  let curSentenceCount = 0;
  for (const unit of units) {
    const piece = String(unit || "").trim();
    if (!piece) continue;
    if (!cur) {
      cur = piece;
      curSentenceCount = 1;
      continue;
    }
    const candidate = `${cur} ${piece}`;
    if (candidate.length > maxChars || curSentenceCount >= maxSentences) {
      chunks.push(cur.trim());
      cur = piece;
      curSentenceCount = 1;
    } else {
      cur = candidate;
      curSentenceCount += 1;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());

  if (!Number.isFinite(maxChunks) || chunks.length <= maxChunks) {
    return { chunks, overflowText: "" };
  }

  // If a chunk cap is explicitly configured, keep the extras as overflow.
  const kept = chunks.slice(0, maxChunks);
  const overflowText = chunks.slice(maxChunks).join(" ").trim();
  return { chunks: kept, overflowText };
}

function enqueueTtsLaneJob(lane, job) {
  if (!lane || !Array.isArray(lane.queue)) return;
  const source = String(job?.source || "").trim().toLowerCase();
  if (source !== "voice-reply" || lane.queue.length === 0) {
    lane.queue.push(job);
    return;
  }

  // Prioritize auto voice replies ahead of non-voice-reply TTS jobs to improve perceived responsiveness.
  let insertAt = lane.queue.length;
  for (let i = 0; i < lane.queue.length; i += 1) {
    const queuedSource = String(lane.queue[i]?.source || "").trim().toLowerCase();
    if (queuedSource !== "voice-reply") {
      insertAt = i;
      break;
    }
  }
  lane.queue.splice(insertAt, 0, job);
}

async function enqueueTts(chatId, inputText, source, options = {}) {
  const text = normalizeTtsText(inputText);
  if (!text) {
    await sendMessage(chatId, "Empty TTS text ignored.");
    return false;
  }

  const lane = ensureTtsLane();
  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return false;
  }

  const workerId = String(options?.workerId || "").trim() || getActiveWorkerForChat(chatId);
  const job = {
    id: nextJobId++,
    chatId,
    text,
    source,
    kind: "tts",
    workerId,
    afterText: String(options.afterText || "").trim(),
    skipResultText: options.skipResultText === true,
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    replyToMessageId: Number(options?.replyToMessageId || 0),
    taskId: Number(options?.routeTaskId || 0),
    routeSessionId: String(options?.routeSessionId || "").trim(),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
  };

  enqueueTtsLaneJob(lane, job);
  void processLane(lane.id);
  return true;
}

async function enqueueTtsBatch(chatId, inputTexts, source, options = {}) {
  const raw = Array.isArray(inputTexts) ? inputTexts : [];
  const texts = raw.map((t) => normalizeTtsText(t)).filter(Boolean);
  if (texts.length === 0) {
    await sendMessage(chatId, "Empty TTS text ignored.");
    return false;
  }

  const lane = ensureTtsLane();
  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
    return false;
  }

  const workerId = String(options?.workerId || "").trim() || getActiveWorkerForChat(chatId);
  const job = {
    id: nextJobId++,
    chatId,
    texts,
    source,
    kind: "tts-batch",
    workerId,
    afterText: String(options.afterText || "").trim(),
    skipResultText: options.skipResultText === true,
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    replyToMessageId: Number(options?.replyToMessageId || 0),
    taskId: Number(options?.routeTaskId || 0),
    routeSessionId: String(options?.routeSessionId || "").trim(),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
  };

  enqueueTtsLaneJob(lane, job);
  void processLane(lane.id);
  return true;
}

function resolveTtsPythonBin() {
  const override = String(TTS_PYTHON || "").trim();
  if (override) return override;

  const candidates = [];
  const base = String(TTS_VENV_PATH || "").trim();
  if (base) {
    if (process.platform === "win32") {
      candidates.push(path.join(base, "Scripts", "python.exe"));
      candidates.push(path.join(base, "Scripts", "python"));
    } else {
      candidates.push(path.join(base, "bin", "python"));
      candidates.push(path.join(base, "bin", "python3"));
    }
  }

  if (process.platform === "win32") {
    candidates.push("python");
    candidates.push("py");
  } else {
    candidates.push("python3");
    candidates.push("python");
  }

  for (const item of candidates) {
    const token = String(item || "").trim();
    if (!token) continue;
    if (token.includes("\\") || token.includes("/") || path.isAbsolute(token)) {
      if (fs.existsSync(token)) return token;
      continue;
    }
    if (commandExists(token)) return token;
  }

  return "";
}

function resolveTtsFfmpegBin() {
  const override = String(TTS_FFMPEG_BIN || "").trim();
  if (!override) return "";
  if (override.includes("\\") || override.includes("/") || path.isAbsolute(override)) {
    return fs.existsSync(override) ? override : "";
  }
  return commandExists(override) ? override : "";
}

function resolveTtsRuntime() {
  const canUseKeepaliveSynth = TTS_KEEPALIVE && fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH);
  const canUseLegacySynth = fs.existsSync(AIDOLON_TTS_SCRIPT_PATH);

  if (!TTS_ENABLED) {
    return { ok: false, error: "TTS is disabled on this bot (TTS_ENABLED=0)." };
  }
  if (!canUseKeepaliveSynth && !canUseLegacySynth) {
    return {
      ok: false,
      error: `TTS helper scripts missing: ${AIDOLON_TTS_SCRIPT_PATH} / ${AIDOLON_TTS_SERVER_SCRIPT_PATH}`,
    };
  }
  if (!TTS_MODEL) {
    return { ok: false, error: "TTS model is not configured. Set TTS_MODEL in .env." };
  }
  if (!TTS_REFERENCE_AUDIO) {
    return { ok: false, error: "TTS reference audio is not configured. Set TTS_REFERENCE_AUDIO in .env." };
  }

  const pyBin = resolveTtsPythonBin();
  if (!pyBin) {
    return {
      ok: false,
      error: "Python not found for TTS. Set TTS_PYTHON or create a venv at TTS_VENV_PATH (default .tts-venv).",
    };
  }

  const ffmpegBin = resolveTtsFfmpegBin();
  if (!ffmpegBin) {
    return {
      ok: false,
      error: `ffmpeg not found ('${TTS_FFMPEG_BIN}'). Install ffmpeg or set TTS_FFMPEG_BIN.`,
    };
  }

  return {
    ok: true,
    canUseKeepaliveSynth,
    canUseLegacySynth,
    pyBin,
    ffmpegBin,
  };
}

const _ffmpegAudioFilterCache = new Map(); // key: ffmpeg bin path -> Set<string> | null

function getFfmpegAudioFilterSet(ffmpegBin) {
  const key = String(ffmpegBin || "").trim();
  if (!key) return null;
  if (_ffmpegAudioFilterCache.has(key)) return _ffmpegAudioFilterCache.get(key) || null;

  const probe = spawnSync(key, ["-hide_banner", "-filters"], {
    encoding: "utf8",
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.status !== 0) {
    _ffmpegAudioFilterCache.set(key, null);
    return null;
  }

  const set = new Set();
  const out = String(probe.stdout || "");
  for (const rawLine of out.split(/\r?\n/)) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("Filters:")) continue;
    if (line.startsWith("-")) continue;

    // Typical format:
    //  ..C afade            A->A       Fade in/out input audio.
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1] || "";
    const io = parts[2] || "";
    if (!name) continue;
    // The input/output types are expressed in the third column (e.g. "A->A", "N->A", "A->V").
    // We only need to know whether a filter is audio-capable for our -af post-processing.
    if (!io.includes("->")) continue; // skip header legend lines like "T.. = Timeline support"
    if (io.includes("A")) set.add(name);
  }

  _ffmpegAudioFilterCache.set(key, set);
  return set;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function fmtFloat(x, digits = 6) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function buildTtsPostprocessFiltergraph(ffmpegBin) {
  if (!TTS_POSTPROCESS_ENABLED) return "";
  if (TTS_POSTPROCESS_FFMPEG_AF) return TTS_POSTPROCESS_FFMPEG_AF;

  const preset = TTS_POSTPROCESS_PRESET || "audacity-stack";
  const audioFilters = getFfmpegAudioFilterSet(ffmpegBin) || new Set();

  if (preset !== "audacity-stack") return "";

  // Requested (Audacity-like) stack:
  // - Medium "overdrive" distortion (amount=60, output=30)
  // - Phaser (dry/wet=45/255, LFO=2.4Hz, feedback=20%, etc) -> approximated with ffmpeg aphaser
  // - Paulstretch (factor=1.1, time resolution=0.075) -> approximated with atempo=0.909...
  // - Pitch shift (semitones=-5.69) without tempo change -> rubberband if available
  // - Tempo +10% without pitch change -> atempo=1.1
  //
  // Notes:
  // - ffmpeg doesn't expose Audacity's Paulstretch parameters; this is a best-effort approximation.
  // - ffmpeg aphaser doesn't match Audacity phaser 1:1 (stages/depth/start phase), so those are ignored.

  const parts = [];

  // Keep sample rate stable for later filters (especially pitch/tempo).
  if (audioFilters.has("aresample")) parts.push("aresample=48000");

  // Distortion approximation (soft clip) with pregain and a final output trim.
  // amount 60/100: pregain ~2.8, threshold ~0.7, then output level ~0.3.
  const distortionAmount = 60;
  const outputLevel = 30;
  const pregain = 1 + (distortionAmount / 100) * 3.0;
  const threshold = 1 - (distortionAmount / 100) * 0.5;
  const outVol = outputLevel / 100;
  if (audioFilters.has("volume")) parts.push(`volume=${fmtFloat(pregain, 4)}`);
  if (audioFilters.has("asoftclip")) {
    parts.push(`asoftclip=type=tanh:threshold=${fmtFloat(clamp01(threshold), 4)}`);
  }
  if (audioFilters.has("volume")) parts.push(`volume=${fmtFloat(clamp01(outVol), 4)}`);

  // Phaser approximation with dry/wet mix.
  const dryWet = 45 / 255; // requested wet fraction
  const wet = clamp01(dryWet);
  const dry = clamp01(1 - wet);
  const hasSplit = audioFilters.has("asplit");
  const hasMix = audioFilters.has("amix");
  const hasAphaser = audioFilters.has("aphaser");
  if (hasAphaser && hasSplit && hasMix && wet > 0) {
    // ffmpeg's aphaser speed is capped at 2 in common builds; clamp the requested 2.4Hz.
    const speedHz = 2.0;
    const feedbackPct = 20;
    const decay = clamp01(feedbackPct / 100);
    const delayMs = 3.0; // no direct mapping from Audacity depth/stages; keep a mild delay
    // This introduces a graph break (labels), so we emit a single filtergraph string later.
    // We'll splice this after the simple chain.
    const phaserGraph = `asplit=2[dry][wet];[wet]aphaser=speed=${fmtFloat(speedHz, 3)}:decay=${fmtFloat(decay, 3)}:delay=${fmtFloat(delayMs, 3)} [ph];[dry][ph]amix=inputs=2:weights='${fmtFloat(dry, 6)} ${fmtFloat(wet, 6)}'`;
    parts.push(phaserGraph);
  } else if (hasAphaser) {
    // Fall back to 100% wet if we can't do a proper dry/wet mix.
    parts.push(`aphaser=speed=${fmtFloat(2.0, 3)}:decay=${fmtFloat(0.2, 3)}:delay=${fmtFloat(3.0, 3)}`);
  }

  // Paulstretch approximation: slow down by factor 1.1 (i.e., tempo 1/1.1).
  // ffmpeg atempo preserves pitch.
  if (audioFilters.has("atempo")) parts.push(`atempo=${fmtFloat(1 / 1.1, 6)}`);

  // Pitch shift without tempo change (semitones=-5.69). Prefer rubberband if available.
  const semitones = -5.69;
  const pitchRatio = Math.pow(2, semitones / 12);
  if (audioFilters.has("rubberband")) {
    parts.push(`rubberband=pitch=${fmtFloat(pitchRatio, 8)}`);
  } else if (TTS_POSTPROCESS_DEBUG) {
    log("TTS postprocess: ffmpeg filter 'rubberband' not available; skipping pitch shift.");
  }

  // Tempo +10% without pitch change.
  if (audioFilters.has("atempo")) parts.push(`atempo=${fmtFloat(1.1, 6)}`);

  const graph = parts.filter(Boolean).join(",");
  if (TTS_POSTPROCESS_DEBUG) log(`TTS postprocess -af: ${graph || "(none)"}`);
  return graph;
}

function rejectTtsKeepalivePending(err) {
  const pending = ttsKeepalive.pending;
  if (!pending) return;
  ttsKeepalive.pending = null;
  if (pending.abortSignal && typeof pending.abortSignal.removeEventListener === "function" && pending.onAbort) {
    try {
      pending.abortSignal.removeEventListener("abort", pending.onAbort);
    } catch {
      // best effort
    }
  }
  if (pending.timer) clearTimeout(pending.timer);
  const message = String(err?.message || err || "TTS keepalive request failed").trim() || "TTS keepalive request failed";
  pending.reject(new Error(message));
}

function writeChildStdin(proc, payload, onError) {
  const fail = typeof onError === "function" ? onError : () => {};
  const stdin = proc && typeof proc === "object" ? proc.stdin : null;
  if (!stdin) {
    fail(new Error("stdin unavailable"));
    return false;
  }
  if (stdin.destroyed || stdin.writableEnded || !stdin.writable || proc.killed || proc.exitCode !== null) {
    fail(new Error("stdin is not writable (process already exited)."));
    return false;
  }
  try {
    stdin.write(payload, (err) => {
      if (err) fail(err);
    });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

function clearTtsKeepaliveRestartTimer() {
  if (ttsKeepalive.restartTimer) {
    clearTimeout(ttsKeepalive.restartTimer);
    ttsKeepalive.restartTimer = null;
  }
}

function scheduleTtsKeepaliveRestart(reason = "") {
  if (!TTS_KEEPALIVE || !TTS_KEEPALIVE_AUTO_RESTART) return;
  if (shuttingDown) return;
  if (ttsKeepalive.proc || ttsKeepalive.startPromise) return;
  if (ttsKeepalive.restartTimer) return;

  ttsKeepalive.restartAttempts = Math.max(0, Number(ttsKeepalive.restartAttempts || 0)) + 1;
  const delayMs = computeExponentialBackoffMs(
    ttsKeepalive.restartAttempts,
    KEEPALIVE_RESTART_BASE_DELAY_MS,
    KEEPALIVE_RESTART_MAX_DELAY_MS,
    0.15,
  );
  const why = oneLine(String(reason || "").trim());
  log(`Scheduling TTS keepalive restart in ${delayMs}ms${why ? ` (${why})` : ""}.`);

  ttsKeepalive.restartTimer = setTimeout(async () => {
    ttsKeepalive.restartTimer = null;
    if (shuttingDown || !TTS_KEEPALIVE || !TTS_KEEPALIVE_AUTO_RESTART) return;
    if (ttsKeepalive.proc || ttsKeepalive.startPromise) return;
    try {
      const pyBin = resolveTtsPythonBin();
      const proc = await ensureTtsKeepaliveRunning(pyBin);
      if (!proc || !ttsKeepalive.ready) {
        scheduleTtsKeepaliveRestart("not ready");
      }
    } catch (err) {
      log(`TTS keepalive auto-restart failed: ${redactError(err?.message || err)}`);
      scheduleTtsKeepaliveRestart("retry");
    }
  }, delayMs);
}

function failTtsKeepaliveStart(err) {
  if (ttsKeepalive.startTimer) {
    clearTimeout(ttsKeepalive.startTimer);
    ttsKeepalive.startTimer = null;
  }
  const reject = typeof ttsKeepalive.startReject === "function" ? ttsKeepalive.startReject : null;
  ttsKeepalive.startResolve = null;
  ttsKeepalive.startReject = null;
  ttsKeepalive.startPromise = null;
  if (reject) reject(err instanceof Error ? err : new Error(String(err || "TTS keepalive start failed")));
}

function resolveTtsKeepaliveStart() {
  if (ttsKeepalive.startTimer) {
    clearTimeout(ttsKeepalive.startTimer);
    ttsKeepalive.startTimer = null;
  }
  clearTtsKeepaliveRestartTimer();
  ttsKeepalive.restartAttempts = 0;
  const resolve = typeof ttsKeepalive.startResolve === "function" ? ttsKeepalive.startResolve : null;
  ttsKeepalive.startResolve = null;
  ttsKeepalive.startReject = null;
  ttsKeepalive.startPromise = null;
  if (resolve) resolve(ttsKeepalive.proc);
}

function stopTtsKeepalive(reason = "", { allowAutoRestart = true } = {}) {
  const proc = ttsKeepalive.proc;
  ttsKeepalive.proc = null;
  ttsKeepalive.ready = false;
  ttsKeepalive.stdoutBuf = "";
  ttsKeepalive.stderrScanCarry = "";
  if (!allowAutoRestart) {
    clearTtsKeepaliveRestartTimer();
    ttsKeepalive.restartAttempts = 0;
  }
  const why = String(reason || "").trim();
  rejectTtsKeepalivePending(why || "TTS keepalive stopped.");
  if (ttsKeepalive.startReject) {
    failTtsKeepaliveStart(new Error(why || "TTS keepalive stopped before becoming ready."));
  }
  if (!proc) {
    if (allowAutoRestart) scheduleTtsKeepaliveRestart(why || "stopped");
    return;
  }
  try {
    terminateChildTree(proc, { forceAfterMs: 1500 });
  } catch {
    // best effort
  }
  if (allowAutoRestart) scheduleTtsKeepaliveRestart(why || "stopped");
}

function handleTtsKeepaliveLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return;

  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    ttsKeepalive.stderrTail = appendTail(ttsKeepalive.stderrTail, `${line}\n`, 16000);
    return;
  }

  if (!msg || typeof msg !== "object") return;
  const type = String(msg.type || "").trim().toLowerCase();
  if (type === "ready") {
    ttsKeepalive.ready = true;
    resolveTtsKeepaliveStart();
    return;
  }

  if (type !== "result") return;
  const pending = ttsKeepalive.pending;
  if (!pending) return;

  const msgId = String(msg.id || "").trim();
  if (!msgId || msgId !== pending.id) return;

  ttsKeepalive.pending = null;
  if (pending.abortSignal && typeof pending.abortSignal.removeEventListener === "function" && pending.onAbort) {
    try {
      pending.abortSignal.removeEventListener("abort", pending.onAbort);
    } catch {
      // best effort
    }
  }
  if (pending.timer) clearTimeout(pending.timer);

  if (msg.ok === true) {
    pending.resolve(msg);
    return;
  }
  const err = String(msg.error || "TTS keepalive synthesis failed").trim() || "TTS keepalive synthesis failed";
  pending.reject(new Error(err));
}

async function ensureTtsKeepaliveRunning(pyBin) {
  if (!TTS_KEEPALIVE) return null;
  if (!fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH)) return null;
  if (!pyBin) return null;

  if (ttsKeepalive.proc && ttsKeepalive.ready) return ttsKeepalive.proc;
  if (ttsKeepalive.startPromise) return await ttsKeepalive.startPromise;

  ttsKeepalive.startPromise = new Promise((resolve, reject) => {
    ttsKeepalive.startResolve = resolve;
    ttsKeepalive.startReject = reject;
  });
  const startupPromise = ttsKeepalive.startPromise;

  const startupTimeoutMs = Number(TTS_KEEPALIVE_STARTUP_TIMEOUT_MS);
  if (startupTimeoutMs > 0) {
    ttsKeepalive.startTimer = setTimeout(() => {
      failTtsKeepaliveStart(new Error(`TTS keepalive startup timed out after ${Math.round(startupTimeoutMs / 1000)}s.`));
      stopTtsKeepalive("TTS keepalive startup timeout.");
    }, startupTimeoutMs);
  }

  let proc;
  try {
    proc = spawn(pyBin, [
      AIDOLON_TTS_SERVER_SCRIPT_PATH,
      "--model",
      TTS_MODEL,
      "--reference-audio",
      TTS_REFERENCE_AUDIO,
      "--sample-rate",
      String(TTS_SAMPLE_RATE || 48000),
    ], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    failTtsKeepaliveStart(new Error(`Failed to start TTS keepalive process: ${err?.message || err}`));
    scheduleTtsKeepaliveRestart("spawn failed");
    return await startupPromise;
  }

  ttsKeepalive.proc = proc;
  ttsKeepalive.ready = false;
  ttsKeepalive.stdoutBuf = "";
  ttsKeepalive.stderrTail = "";
  ttsKeepalive.stderrScanCarry = "";

  if (proc.stdin && typeof proc.stdin.on === "function") {
    proc.stdin.on("error", (err) => {
      if (ttsKeepalive.proc !== proc) return;
      const msg = `TTS keepalive stdin error: ${err?.message || err}`;
      rejectTtsKeepalivePending(msg);
      stopTtsKeepalive(msg);
    });
  }

  proc.stdout.on("data", (buf) => {
    const chunk = String(buf || "");
    ttsKeepalive.stdoutBuf = appendTail(ttsKeepalive.stdoutBuf, chunk, 24000);
    let src = ttsKeepalive.stdoutBuf;
    let idx;
    while ((idx = src.indexOf("\n")) !== -1) {
      const line = src.slice(0, idx);
      src = src.slice(idx + 1);
      handleTtsKeepaliveLine(line);
    }
    ttsKeepalive.stdoutBuf = src;
  });

  proc.stderr.on("data", (buf) => {
    const chunk = String(buf || "");
    ttsKeepalive.stderrTail = appendTail(ttsKeepalive.stderrTail, chunk, 50000);
    const fatal = detectTtsBackendFatalError(chunk, ttsKeepalive.stderrScanCarry);
    ttsKeepalive.stderrScanCarry = fatal.carry;
    if (fatal.message) {
      const msg = `TTS keepalive backend fatal error: ${fatal.message}`;
      log(msg);
      stopTtsKeepalive(msg);
      return;
    }
    if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
  });

  proc.on("error", (err) => {
    const msg = `TTS keepalive process error: ${err?.message || err}`;
    if (ttsKeepalive.startReject) {
      failTtsKeepaliveStart(new Error(msg));
    }
    stopTtsKeepalive(msg);
  });

  proc.on("close", (code, signal) => {
    const codeText = typeof code === "number" ? `exit ${code}` : "exit";
    const sigText = signal ? ` (${signal})` : "";
    const tail = oneLine(ttsKeepalive.stderrTail || "");
    const msg = `TTS keepalive closed (${codeText}${sigText})${tail ? `: ${tail}` : ""}`;
    if (ttsKeepalive.startReject) {
      failTtsKeepaliveStart(new Error(msg));
    }
    stopTtsKeepalive(msg);
  });

  return await startupPromise;
}

async function requestTtsKeepalive(payload, { abortSignal, timeoutMs = 0, job } = {}) {
  const pyBin = resolveTtsPythonBin();
  const proc = await ensureTtsKeepaliveRunning(pyBin);
  if (!proc) throw new Error("TTS keepalive is unavailable.");

  if (ttsKeepalive.pending) {
    throw new Error("TTS keepalive is busy.");
  }

  const requestId = `tts-${ttsKeepalive.requestSeq++}-${Date.now()}`;
  const body = { ...payload, id: requestId };
  const line = `${JSON.stringify(body)}\n`;
  if (job && typeof job === "object") {
    job.process = proc;
  }

  return await new Promise((resolve, reject) => {
    const pending = {
      id: requestId,
      resolve,
      reject,
      timer: null,
      abortSignal,
      onAbort: null,
    };

    if (abortSignal && typeof abortSignal === "object") {
      const onAbort = () => {
        stopTtsKeepalive("TTS canceled.");
      };
      pending.onAbort = onAbort;
      try {
        if (abortSignal.aborted) {
          onAbort();
        } else if (typeof abortSignal.addEventListener === "function") {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      } catch {
        // best effort
      }
    }

    const ms = Number(timeoutMs);
    if (Number.isFinite(ms) && ms > 0) {
      pending.timer = setTimeout(() => {
        stopTtsKeepalive(`TTS timed out after ${Math.round(ms / 1000)}s.`);
      }, ms);
    }

    ttsKeepalive.pending = pending;
    writeChildStdin(proc, line, (err) => {
      const msg = `Failed to write TTS keepalive request: ${err?.message || err}`;
      rejectTtsKeepalivePending(msg);
      if (ttsKeepalive.proc === proc) {
        stopTtsKeepalive(msg);
      }
    });
  });
}

async function runTtsSynthKeepaliveSingle({ text, outWavPath, timeoutMs = 0, abortSignal, job }) {
  const msg = await requestTtsKeepalive(
    {
      type: "synthesize",
      text,
      out_wav: outWavPath,
    },
    { abortSignal, timeoutMs, job },
  );
  if (msg.ok !== true) {
    throw new Error(String(msg.error || "TTS keepalive synthesis failed."));
  }
  return msg;
}

async function runTtsSynthKeepaliveBatch({ texts, outWavBase, timeoutMs = 0, abortSignal, job }) {
  const msg = await requestTtsKeepalive(
    {
      type: "synthesize_batch",
      texts,
      out_wav_base: outWavBase,
    },
    { abortSignal, timeoutMs, job },
  );
  if (msg.ok !== true) {
    throw new Error(String(msg.error || "TTS keepalive synthesis failed."));
  }
  return msg;
}

async function runTtsJob(job, lane) {
  const isVoiceReply = String(job?.source || "").trim().toLowerCase() === "voice-reply";
  const afterText = String(job?.afterText || "").trim();
  const attachments = Array.isArray(job?.attachments) ? job.attachments : [];
  const text = normalizeTtsText(job?.text);
  const jobAbortController = job?.abortController instanceof AbortController ? job.abortController : null;
  const abortSignal = jobAbortController ? jobAbortController.signal : undefined;

  const formatFailureText = (errMsg) => {
    const err = oneLine(String(errMsg || "").trim());
    if (isVoiceReply && job?.skipResultText === true && text) {
      const cap = err.length > 240 ? `${err.slice(0, 237)}...` : err;
      return cap ? `${text}\n\n(Voice reply failed: ${cap})` : text;
    }
    return err;
  };
  try {
  const runtime = job?.ttsRuntime && job.ttsRuntime.ok
    ? job.ttsRuntime
    : resolveTtsRuntime();
  if (!runtime?.ok) {
    return {
      ok: false,
      text: formatFailureText(runtime?.error || "TTS is unavailable."),
      afterText,
      attachments,
    };
  }
  const canUseKeepaliveSynth = Boolean(runtime.canUseKeepaliveSynth);
  const canUseLegacySynth = Boolean(runtime.canUseLegacySynth);
  const pyBin = String(runtime.pyBin || "").trim();
  const ffmpegBin = String(runtime.ffmpegBin || "").trim();

  if (!text) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }

  const maxStageAttempts = Math.max(1, 1 + Math.max(0, Number(TTS_TIMEOUT_RETRIES) || 0));
  const resetTimeoutState = () => {
    job.timedOut = false;
    job.timedOutMs = 0;
    job.timedOutStage = "";
  };

  let wavPath = "";
  let oggPath = "";

  const runSynthOnce = async (outWavPath) => {
    const timeoutMs = minPositive([TTS_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
    if (canUseKeepaliveSynth) {
      try {
        await runTtsSynthKeepaliveSingle({
          text,
          outWavPath,
          timeoutMs,
          abortSignal,
          job,
        });
        if (!fs.existsSync(outWavPath)) {
          return { ok: false, text: "TTS synthesis finished, but WAV output file is missing." };
        }
        return { ok: true };
      } catch (err) {
        const msg = String(err?.message || err || "").trim();
        if (job.cancelRequested || /tts canceled/i.test(msg)) {
          return { ok: false, text: "TTS canceled." };
        }
        if (/timed out/i.test(msg)) {
          job.timedOut = true;
          job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
          job.timedOutStage = "synth";
          return { ok: false, text: msg };
        }
        if (!canUseLegacySynth) {
          return { ok: false, text: msg || "TTS keepalive synthesis failed." };
        }
        log(`TTS keepalive synth failed; falling back to one-shot process: ${oneLine(msg || "unknown error")}`);
      }
    }

    const synthArgs = [
      AIDOLON_TTS_SCRIPT_PATH,
      "--out-wav",
      outWavPath,
      "--model",
      TTS_MODEL,
      "--reference-audio",
      TTS_REFERENCE_AUDIO,
      "--sample-rate",
      String(TTS_SAMPLE_RATE || 48000),
    ];

    return await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(pyBin, synthArgs, {
          cwd: ROOT,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ ok: false, text: `Failed to start TTS python: ${err.message || err}` });
        return;
      }

      job.process = child;

      try {
        child.stdin.end(text);
      } catch {
        // best effort
      }

      let timeoutForceFinish = null;
      let stderrScanCarry = "";
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          job.timedOut = true;
          job.timedOutMs = timeoutMs;
          job.timedOutStage = "synth";
          terminateChildTree(child, { forceAfterMs: 3000 });
          // Fail-safe: if termination doesn't trigger a close event, finish anyway.
          timeoutForceFinish = setTimeout(() => {
            const tail = job.stderrTail.trim() || job.stdoutTail.trim();
            finish({
              ok: false,
              text: `TTS timed out after ${Math.round(timeoutMs / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
            });
          }, 10_000);
        }, timeoutMs)
        : null;

      child.stdout.on("data", (buf) => {
        const chunk = String(buf || "");
        job.stdoutTail = appendTail(job.stdoutTail, chunk, 50000);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
      });
      child.stderr.on("data", (buf) => {
        const chunk = String(buf || "");
        job.stderrTail = appendTail(job.stderrTail, chunk, 50000);
        const fatal = detectTtsBackendFatalError(chunk, stderrScanCarry);
        stderrScanCarry = fatal.carry;
        if (fatal.message && !job.cancelRequested) {
          const msg = `TTS backend fatal error: ${fatal.message}`;
          clearTimeout(timeout);
          if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
          terminateChildTree(child, { forceAfterMs: 1200 });
          finish({ ok: false, text: msg });
          return;
        }
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        finish({ ok: false, text: `TTS python process error: ${err.message || err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);

        if (job.cancelRequested) {
          finish({ ok: false, text: "TTS canceled." });
          return;
        }
        if (job.timedOut) {
          const ms = Number(job.timedOutMs || 0) || timeoutMs || TTS_HARD_TIMEOUT_MS || 0;
          const tail = job.stderrTail.trim() || job.stdoutTail.trim();
          finish({
            ok: false,
            text: `TTS timed out after ${Math.round(ms / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (typeof code === "number" && code !== 0) {
          const tail = job.stderrTail.trim() || job.stdoutTail.trim();
          finish({
            ok: false,
            text: `TTS synthesis failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }

        if (!fs.existsSync(outWavPath)) {
          finish({ ok: false, text: "TTS synthesis finished, but WAV output file is missing." });
          return;
        }

        finish({ ok: true });
      });
    });
  };

  let synthOk = { ok: false, text: "TTS synthesis failed." };
  for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
    resetTimeoutState();
    job.stdoutTail = "";
    job.stderrTail = "";

    const base = `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const outWav = path.join(TTS_DIR, `${base}.wav`);

    synthOk = await runSynthOnce(outWav);
    if (synthOk.ok) {
      wavPath = outWav;
      break;
    }

    try {
      if (fs.existsSync(outWav)) fs.unlinkSync(outWav);
    } catch {
      // best effort
    }

    if (job.cancelRequested) {
      return { ok: false, text: "TTS canceled." };
    }

    const timedOut = Boolean(job.timedOut && job.timedOutStage === "synth");
    const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
    const canRetryTimeout = timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
    if (canRetryTimeout) {
      log(`TTS: synth attempt ${attempt}/${maxStageAttempts} timed out; retrying...`);
      await sleep(250);
      continue;
    }

    const canRetryFailure = !timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
    if (canRetryFailure) {
      log(`TTS: synth attempt ${attempt}/${maxStageAttempts} failed; retrying...`);
      await sleep(350);
      continue;
    }

    return { ok: false, text: formatFailureText(synthOk.text), afterText, attachments };
  }

  if (!wavPath) {
    return { ok: false, text: formatFailureText(synthOk.text), afterText, attachments };
  }

  if (job.cancelRequested) {
    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch {
      // best effort
    }
    return { ok: false, text: "TTS canceled." };
  }

  if (typeof job.onProgressChunk === "function") {
    job.onProgressChunk("TTS: encoding voice message...\n", "stderr");
  }

  const ttsFxGraph = buildTtsPostprocessFiltergraph(ffmpegBin);
  const runEncodeOnce = async (inWavPath, outOggPath) => {
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inWavPath,
      ...(ttsFxGraph ? ["-af", ttsFxGraph] : []),
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      `${TTS_OPUS_BITRATE_KBPS}k`,
      "-vbr",
      "on",
      "-compression_level",
      "10",
      "-application",
      "voip",
      outOggPath,
    ];

    return await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(ffmpegBin, ffArgs, {
          cwd: ROOT,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ ok: false, text: `Failed to start ffmpeg: ${err.message || err}` });
        return;
      }

      job.process = child;

      const timeoutMs = minPositive([TTS_ENCODE_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
      let timeoutForceFinish = null;
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          job.timedOut = true;
          job.timedOutMs = timeoutMs;
          job.timedOutStage = "encode";
          terminateChildTree(child, { forceAfterMs: 3000 });
          // Fail-safe: if termination doesn't trigger a close event, finish anyway.
          timeoutForceFinish = setTimeout(() => {
            const tail = String(stderr || stdout || "").trim();
            finish({
              ok: false,
              text: `TTS encoding timed out after ${Math.round(timeoutMs / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
            });
          }, 10_000);
        }, timeoutMs)
        : null;

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (buf) => {
        const chunk = String(buf || "");
        stdout = appendTail(stdout, chunk, 50000);
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
      });
      child.stderr.on("data", (buf) => {
        const chunk = String(buf || "");
        stderr = appendTail(stderr, chunk, 50000);
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        finish({ ok: false, text: `ffmpeg error: ${err.message || err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        if (job.cancelRequested) {
          finish({ ok: false, text: "TTS canceled." });
          return;
        }
        if (job.timedOut) {
          const ms = Number(job.timedOutMs || 0) || timeoutMs || TTS_HARD_TIMEOUT_MS || 0;
          const tail = String(stderr || stdout || "").trim();
          finish({
            ok: false,
            text: `TTS encoding timed out after ${Math.round(ms / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (typeof code === "number" && code !== 0) {
          const tail = String(stderr || stdout || "").trim();
          finish({
            ok: false,
            text: `ffmpeg failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (!fs.existsSync(outOggPath)) {
          finish({ ok: false, text: "ffmpeg completed, but OGG output file is missing." });
          return;
        }
        finish({ ok: true });
      });
    });
  };

  let encodeOk = { ok: false, text: "TTS encoding failed." };
  for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
    resetTimeoutState();
    const outOgg = path.join(TTS_DIR, `${path.basename(wavPath, ".wav")}-enc${attempt}.ogg`);

    encodeOk = await runEncodeOnce(wavPath, outOgg);
    if (encodeOk.ok) {
      oggPath = outOgg;
      break;
    }

    try {
      if (fs.existsSync(outOgg)) fs.unlinkSync(outOgg);
    } catch {
      // best effort
    }

    if (job.cancelRequested) {
      break;
    }

    const timedOut = Boolean(job.timedOut && job.timedOutStage === "encode");
    const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
    const canRetry = timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
    if (canRetry) {
      log(`TTS: encode attempt ${attempt}/${maxStageAttempts} timed out; retrying...`);
      await sleep(250);
      continue;
    }

    break;
  }

  try {
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  } catch {
    // best effort
  }

  if (!oggPath) {
    if (job.cancelRequested) {
      return { ok: false, text: "TTS canceled." };
    }
    return { ok: false, text: formatFailureText(encodeOk.text), afterText, attachments };
  }

  if (job.cancelRequested) {
    try {
      if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
    } catch {
      // best effort
    }
    return { ok: false, text: "TTS canceled." };
  }

  if (typeof job.onProgressChunk === "function") {
    job.onProgressChunk("TTS: sending voice message...\n", "stderr");
  }

  let uploadErr = null;
  let lastUploadTimeoutMs = 0;
  const maxUploadAttempts = Math.max(1, 1 + Math.max(0, Number(TTS_UPLOAD_RETRIES) || 0));
  for (let attempt = 1; attempt <= maxUploadAttempts; attempt += 1) {
    const uploadTimeoutMs = minPositive([TTS_UPLOAD_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
    lastUploadTimeoutMs = uploadTimeoutMs;
    try {
      await sendVoice(job.chatId, oggPath, {
        timeoutMs: uploadTimeoutMs,
        signal: abortSignal,
        replyToMessageId: job.replyToMessageId,
        routeWorkerId: job.workerId,
        routeTaskId: Number(job?.taskId || 0),
        routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
        replyContextText: text,
        // Keep send retries explicit in the caller to avoid retry storms.
        maxAttempts: 1,
      });
      uploadErr = null;
      break;
    } catch (err) {
      uploadErr = err;

      if (job.cancelRequested) break;

      const isAbort = String(err?.name || "").trim() === "AbortError";
      const canceledByCaller = Boolean(abortSignal && abortSignal.aborted);
      const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
      // Avoid retrying timeout-aborted uploads by default to reduce duplicate-send risk.
      const canRetry = !isAbort && !canceledByCaller && attempt < maxUploadAttempts && (hardRemaining === 0 || hardRemaining > 1);
      if (canRetry) {
        log(`TTS: upload attempt ${attempt}/${maxUploadAttempts} failed; retrying...`);
        await sleep(computeExponentialBackoffMs(attempt, TTS_RETRY_BASE_DELAY_MS, TTS_RETRY_MAX_DELAY_MS));
        continue;
      }

      break;
    }
  }

  try {
    if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
  } catch {
    // best effort
  }

  if (uploadErr) {
    if (job.cancelRequested) {
      return { ok: false, text: "TTS canceled." };
    }
    if (String(uploadErr?.name || "").trim() === "AbortError") {
      const ms = Number(lastUploadTimeoutMs || 0) || TTS_HARD_TIMEOUT_MS || 0;
      return {
        ok: false,
        text: formatFailureText(`TTS upload timed out after ${Math.round(ms / 1000)}s.`),
        afterText,
        attachments,
      };
    }
    return {
      ok: false,
      text: formatFailureText(`Failed to send Telegram voice message: ${String(uploadErr?.message || uploadErr)}`),
      afterText,
      attachments,
    };
  }

  if (job?.skipResultText === true) {
    return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
  }

  if (TTS_SEND_TEXT) {
    return { ok: true, text, afterText, attachments };
  }

  return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
  } finally {
    // no-op
  }
}

async function runTtsBatchJobPipelined(job, lane) {
  const isVoiceReply = String(job?.source || "").trim().toLowerCase() === "voice-reply";
  const afterText = String(job?.afterText || "").trim();
  const attachments = Array.isArray(job?.attachments) ? job.attachments : [];
  const raw = Array.isArray(job?.texts) ? job.texts : [];
  const texts = raw.map((t) => normalizeTtsText(t)).filter(Boolean);
  const fullText = texts.join(" ").trim();
  const originalSkipResultText = job?.skipResultText === true;

  const formatFailureText = (errMsg, sentCount = 0) => {
    const err = oneLine(String(errMsg || "").trim());
    if (isVoiceReply && job?.skipResultText === true && fullText) {
      const cap = err.length > 240 ? `${err.slice(0, 237)}...` : err;
      if (Number.isFinite(sentCount) && sentCount > 0 && sentCount < texts.length) {
        const remaining = texts.slice(sentCount).join(" ").trim();
        if (!remaining) return cap ? `(Voice reply failed: ${cap})` : "Voice reply failed.";
        return cap
          ? `${remaining}\n\n(Voice reply failed after sending ${sentCount} voice message(s): ${cap})`
          : `${remaining}\n\n(Voice reply failed after sending ${sentCount} voice message(s).)`;
      }
      return cap ? `${fullText}\n\n(Voice reply failed: ${cap})` : fullText;
    }
    return err;
  };

  const runtime = resolveTtsRuntime();
  if (!runtime.ok) {
    return {
      ok: false,
      text: formatFailureText(runtime.error || "TTS is unavailable."),
      afterText,
      attachments,
    };
  }
  if (texts.length === 0) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }

  const original = {
    kind: job.kind,
    text: job.text,
    source: job.source,
    afterText: job.afterText,
    attachments: job.attachments,
    skipResultText: job.skipResultText,
    startedAt: job.startedAt,
    timedOut: job.timedOut,
    timedOutMs: job.timedOutMs,
    timedOutStage: job.timedOutStage,
    stdoutTail: job.stdoutTail,
    stderrTail: job.stderrTail,
    ttsRuntime: job.ttsRuntime,
  };
  const batchStartedAt = Number(original.startedAt) > 0 ? Number(original.startedAt) : Date.now();

  let sentCount = 0;
  let fallbackCount = 0;
  try {
    for (let idx = 0; idx < texts.length; idx += 1) {
      if (job.cancelRequested) {
        return { ok: false, text: "TTS canceled." };
      }

      const chunkText = String(texts[idx] || "").trim();
      if (!chunkText) continue;

      job.kind = "tts";
      job.text = chunkText;
      job.source = idx === 0 ? original.source : (isVoiceReply ? "tts-batch-chunk" : original.source);
      job.afterText = "";
      job.attachments = [];
      job.skipResultText = true;
      job.ttsRuntime = runtime;
      job.startedAt = batchStartedAt;
      job.timedOut = false;
      job.timedOutMs = 0;
      job.timedOutStage = "";
      job.stdoutTail = "";
      job.stderrTail = "";

      const startedAt = Date.now();
      const chunkResult = await runTtsJob(job, lane);
      const elapsedMs = Date.now() - startedAt;

      if (chunkResult?.ok) {
        sentCount += 1;
        log(`TTS batch chunk ${idx + 1}/${texts.length} sent in ${elapsedMs}ms.`);
        continue;
      }

      fallbackCount += 1;
      const errText = oneLine(String(chunkResult?.text || "TTS chunk failed").trim());
      const cappedErr = errText.length > 200 ? `${errText.slice(0, 197)}...` : errText;
      log(
        `TTS batch chunk ${idx + 1}/${texts.length} failed in ${elapsedMs}ms; fallback to text${cappedErr ? ` (${cappedErr})` : ""}.`,
      );

      const prefix = `Voice chunk ${idx + 1}/${texts.length} failed`;
      const fallbackText = isVoiceReply
        ? chunkText
        : cappedErr
          ? `${prefix}: ${cappedErr}\n\n${chunkText}`
          : `${prefix}.\n\n${chunkText}`;
      try {
        await sendMessage(job.chatId, fallbackText, {
          replyToMessageId: job.replyToMessageId,
          routeWorkerId: job.workerId,
          routeTaskId: Number(job?.taskId || 0),
          routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
        });
      } catch (err) {
        log(`TTS fallback send failed for chunk ${idx + 1}/${texts.length}: ${redactError(err?.message || err)}`);
      }
    }

    if (fallbackCount > 0) {
      log(`TTS batch completed with fallbacks: voice_sent=${sentCount}, text_fallbacks=${fallbackCount}, total=${texts.length}`);
    }

    if (originalSkipResultText) {
      return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
    }

    if (TTS_SEND_TEXT) {
      return { ok: true, text: texts.join(" "), afterText, attachments };
    }

    return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
  } finally {
    job.kind = original.kind;
    job.text = original.text;
    job.source = original.source;
    job.afterText = original.afterText;
    job.attachments = original.attachments;
    job.skipResultText = original.skipResultText;
    job.startedAt = original.startedAt;
    job.timedOut = original.timedOut;
    job.timedOutMs = original.timedOutMs;
    job.timedOutStage = original.timedOutStage;
    job.stdoutTail = original.stdoutTail;
    job.stderrTail = original.stderrTail;
    job.ttsRuntime = original.ttsRuntime;
  }
}

function shouldUsePipelinedTtsBatch(job) {
  if (!TTS_BATCH_PIPELINED) return false;
  const maxChunks = Number(TTS_BATCH_PIPELINED_MAX_CHUNKS);
  if (!Number.isFinite(maxChunks) || maxChunks <= 0) return true;
  const raw = Array.isArray(job?.texts) ? job.texts : [];
  let count = 0;
  for (const item of raw) {
    if (!normalizeTtsText(item)) continue;
    count += 1;
    if (count > maxChunks) return false;
  }
  return true;
}

async function runTtsBatchJob(job, lane) {
  if (shouldUsePipelinedTtsBatch(job)) {
    return await runTtsBatchJobPipelined(job, lane);
  }

  const isVoiceReply = String(job?.source || "").trim().toLowerCase() === "voice-reply";
  const afterText = String(job?.afterText || "").trim();
  const attachments = Array.isArray(job?.attachments) ? job.attachments : [];
  const jobAbortController = job?.abortController instanceof AbortController ? job.abortController : null;
  const abortSignal = jobAbortController ? jobAbortController.signal : undefined;

  const raw = Array.isArray(job?.texts) ? job.texts : [];
  const texts = raw.map((t) => normalizeTtsText(t)).filter(Boolean);
  const fullText = texts.join(" ").trim();

  const formatFailureText = (errMsg, sentCount = 0) => {
    const err = oneLine(String(errMsg || "").trim());
    if (isVoiceReply && job?.skipResultText === true && fullText) {
      const cap = err.length > 240 ? `${err.slice(0, 237)}...` : err;
      if (Number.isFinite(sentCount) && sentCount > 0 && sentCount < texts.length) {
        const remaining = texts.slice(sentCount).join(" ").trim();
        if (!remaining) return cap ? `(Voice reply failed: ${cap})` : "Voice reply failed.";
        return cap
          ? `${remaining}\n\n(Voice reply failed after sending ${sentCount} voice message(s): ${cap})`
          : `${remaining}\n\n(Voice reply failed after sending ${sentCount} voice message(s).)`;
      }
      return cap ? `${fullText}\n\n(Voice reply failed: ${cap})` : fullText;
    }
    return err;
  };
  try {
  const runtime = resolveTtsRuntime();
  if (!runtime.ok) {
    return {
      ok: false,
      text: formatFailureText(runtime.error || "TTS is unavailable."),
      afterText,
      attachments,
    };
  }
  const canUseKeepaliveSynth = Boolean(runtime.canUseKeepaliveSynth);
  const canUseLegacySynth = Boolean(runtime.canUseLegacySynth);
  const pyBin = String(runtime.pyBin || "").trim();
  const ffmpegBin = String(runtime.ffmpegBin || "").trim();

  if (texts.length === 0) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }

  const pad3 = (n) => String(n).padStart(3, "0");
  const payload = `${texts.map((t) => JSON.stringify({ text: t })).join("\n")}\n`;

  const maxStageAttempts = Math.max(1, 1 + Math.max(0, Number(TTS_TIMEOUT_RETRIES) || 0));
  const resetTimeoutState = () => {
    job.timedOut = false;
    job.timedOutMs = 0;
    job.timedOutStage = "";
  };

  let base = "";
  let wavBase = "";
  let wavPaths = [];

  const cleanupWavs = () => {
    for (const p of wavPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // best effort
      }
    }
  };

  const runBatchSynthOnce = async (outWavBase) => {
    const timeoutMs = minPositive([TTS_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
    if (canUseKeepaliveSynth) {
      try {
        await runTtsSynthKeepaliveBatch({
          texts,
          outWavBase,
          timeoutMs,
          abortSignal,
          job,
        });
        return { ok: true };
      } catch (err) {
        const msg = String(err?.message || err || "").trim();
        if (job.cancelRequested || /tts canceled/i.test(msg)) {
          return { ok: false, text: "TTS canceled." };
        }
        if (/timed out/i.test(msg)) {
          job.timedOut = true;
          job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
          job.timedOutStage = "synth";
          return { ok: false, text: msg };
        }
        if (!canUseLegacySynth) {
          return { ok: false, text: msg || "TTS keepalive synthesis failed." };
        }
        log(`TTS keepalive batch synth failed; falling back to one-shot process: ${oneLine(msg || "unknown error")}`);
      }
    }

    const synthArgs = [
      AIDOLON_TTS_SCRIPT_PATH,
      "--batch-jsonl",
      "--out-wav-base",
      outWavBase,
      "--model",
      TTS_MODEL,
      "--reference-audio",
      TTS_REFERENCE_AUDIO,
      "--sample-rate",
      String(TTS_SAMPLE_RATE || 48000),
    ];

    return await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(pyBin, synthArgs, {
          cwd: ROOT,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ ok: false, text: `Failed to start TTS python: ${err.message || err}` });
        return;
      }

      job.process = child;

      try {
        child.stdin.end(payload);
      } catch {
        // best effort
      }

      let timeoutForceFinish = null;
      let stderrScanCarry = "";
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          job.timedOut = true;
          job.timedOutMs = timeoutMs;
          job.timedOutStage = "synth";
          terminateChildTree(child, { forceAfterMs: 3000 });
          // Fail-safe: if termination doesn't trigger a close event, finish anyway.
          timeoutForceFinish = setTimeout(() => {
            const tail = job.stderrTail.trim() || job.stdoutTail.trim();
            finish({
              ok: false,
              text: `TTS timed out after ${Math.round(timeoutMs / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
            });
          }, 10_000);
        }, timeoutMs)
        : null;

      child.stdout.on("data", (buf) => {
        const chunk = String(buf || "");
        job.stdoutTail = appendTail(job.stdoutTail, chunk, 50000);
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
      });
      child.stderr.on("data", (buf) => {
        const chunk = String(buf || "");
        job.stderrTail = appendTail(job.stderrTail, chunk, 50000);
        const fatal = detectTtsBackendFatalError(chunk, stderrScanCarry);
        stderrScanCarry = fatal.carry;
        if (fatal.message && !job.cancelRequested) {
          const msg = `TTS backend fatal error: ${fatal.message}`;
          clearTimeout(timeout);
          if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
          terminateChildTree(child, { forceAfterMs: 1200 });
          finish({ ok: false, text: msg });
          return;
        }
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        finish({ ok: false, text: `TTS python process error: ${err.message || err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);

        if (job.cancelRequested) {
          finish({ ok: false, text: "TTS canceled." });
          return;
        }
        if (job.timedOut) {
          const ms = Number(job.timedOutMs || 0) || timeoutMs || TTS_HARD_TIMEOUT_MS || 0;
          const tail = job.stderrTail.trim() || job.stdoutTail.trim();
          finish({
            ok: false,
            text: `TTS timed out after ${Math.round(ms / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (typeof code === "number" && code !== 0) {
          const tail = job.stderrTail.trim() || job.stdoutTail.trim();
          finish({
            ok: false,
            text: `TTS synthesis failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }

        finish({ ok: true });
      });
    });
  };

  let synthOk = { ok: false, text: "TTS synthesis failed." };
  for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
    resetTimeoutState();
    job.stdoutTail = "";
    job.stderrTail = "";

    base = `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    wavBase = path.join(TTS_DIR, base);
    wavPaths = texts.map((_, idx) => `${wavBase}-${pad3(idx)}.wav`);

    synthOk = await runBatchSynthOnce(wavBase);
    if (synthOk.ok) break;

    cleanupWavs();

    if (job.cancelRequested) {
      return { ok: false, text: "TTS canceled." };
    }

    const timedOut = Boolean(job.timedOut && job.timedOutStage === "synth");
    const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
    const canRetryTimeout = timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
    if (canRetryTimeout) {
      log(`TTS: synth attempt ${attempt}/${maxStageAttempts} timed out; retrying...`);
      await sleep(250);
      continue;
    }

    const canRetryFailure = !timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
    if (canRetryFailure) {
      log(`TTS: synth attempt ${attempt}/${maxStageAttempts} failed; retrying...`);
      await sleep(350);
      continue;
    }

    return { ok: false, text: formatFailureText(synthOk.text), afterText, attachments };
  }

  if (!synthOk.ok) {
    cleanupWavs();
    return { ok: false, text: formatFailureText(synthOk.text), afterText, attachments };
  }

  if (job.cancelRequested) {
    cleanupWavs();
    return { ok: false, text: "TTS canceled." };
  }

  for (const p of wavPaths) {
    if (!fs.existsSync(p)) {
      cleanupWavs();
      return { ok: false, text: "TTS synthesis finished, but one or more WAV output files are missing." };
    }
  }

  if (typeof job.onProgressChunk === "function") {
    job.onProgressChunk("TTS: encoding voice messages...\n", "stderr");
  }

  const ttsFxGraph = buildTtsPostprocessFiltergraph(ffmpegBin);
  const runEncodeOnce = async (inWavPath, outOggPath) => {
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inWavPath,
      ...(ttsFxGraph ? ["-af", ttsFxGraph] : []),
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      `${TTS_OPUS_BITRATE_KBPS}k`,
      "-vbr",
      "on",
      "-compression_level",
      "10",
      "-application",
      "voip",
      outOggPath,
    ];

    return await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(ffmpegBin, ffArgs, {
          cwd: ROOT,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        finish({ ok: false, text: `Failed to start ffmpeg: ${err.message || err}` });
        return;
      }

      job.process = child;

      const timeoutMs = minPositive([TTS_ENCODE_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
      let timeoutForceFinish = null;
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          job.timedOut = true;
          job.timedOutMs = timeoutMs;
          job.timedOutStage = "encode";
          terminateChildTree(child, { forceAfterMs: 3000 });
          // Fail-safe: if termination doesn't trigger a close event, finish anyway.
          timeoutForceFinish = setTimeout(() => {
            const tail = String(stderr || stdout || "").trim();
            finish({
              ok: false,
              text: `TTS encoding timed out after ${Math.round(timeoutMs / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
            });
          }, 10_000);
        }, timeoutMs)
        : null;

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (buf) => {
        const chunk = String(buf || "");
        stdout = appendTail(stdout, chunk, 50000);
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
      });
      child.stderr.on("data", (buf) => {
        const chunk = String(buf || "");
        stderr = appendTail(stderr, chunk, 50000);
        if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
        if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        finish({ ok: false, text: `ffmpeg error: ${err.message || err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timeoutForceFinish) clearTimeout(timeoutForceFinish);
        if (job.cancelRequested) {
          finish({ ok: false, text: "TTS canceled." });
          return;
        }
        if (job.timedOut) {
          const ms = Number(job.timedOutMs || 0) || timeoutMs || TTS_HARD_TIMEOUT_MS || 0;
          const tail = String(stderr || stdout || "").trim();
          finish({
            ok: false,
            text: `TTS encoding timed out after ${Math.round(ms / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (typeof code === "number" && code !== 0) {
          const tail = String(stderr || stdout || "").trim();
          finish({
            ok: false,
            text: `ffmpeg failed (exit ${code}${signal ? `, signal ${signal}` : ""}).${tail ? `\n\n${tail}` : ""}`,
          });
          return;
        }
        if (!fs.existsSync(outOggPath)) {
          finish({ ok: false, text: "ffmpeg completed, but OGG output file is missing." });
          return;
        }
        finish({ ok: true });
      });
    });
  };

  for (let idx = 0; idx < wavPaths.length; idx += 1) {
    const wavPath = wavPaths[idx];

    if (job.cancelRequested) {
      cleanupWavs();
      return { ok: false, text: "TTS canceled." };
    }

    let encodeOk = { ok: false, text: "TTS encoding failed." };
    let oggPath = "";
    for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
      resetTimeoutState();
      const outOgg = path.join(TTS_DIR, `${base}-${pad3(idx)}-enc${attempt}.ogg`);

      encodeOk = await runEncodeOnce(wavPath, outOgg);
      if (encodeOk.ok) {
        oggPath = outOgg;
        break;
      }

      try {
        if (fs.existsSync(outOgg)) fs.unlinkSync(outOgg);
      } catch {
        // best effort
      }

      if (job.cancelRequested) break;

      const timedOut = Boolean(job.timedOut && job.timedOutStage === "encode");
      const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
      const canRetry = timedOut && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
      if (canRetry) {
        log(`TTS: encode attempt ${attempt}/${maxStageAttempts} timed out; retrying...`);
        await sleep(250);
        continue;
      }

      break;
    }

    if (!oggPath) {
      cleanupWavs();
      const sentCount = idx;
      if (job.cancelRequested) {
        return { ok: false, text: "TTS canceled." };
      }
      return { ok: false, text: formatFailureText(encodeOk.text, sentCount), afterText, attachments };
    }

    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch {
      // best effort
    }

    if (typeof job.onProgressChunk === "function") {
      job.onProgressChunk(`TTS: sending voice message ${idx + 1}/${wavPaths.length}...\n`, "stderr");
    }

    let sentCount = idx;
    let uploadErr = null;
    let lastUploadTimeoutMs = 0;
    try {
      for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
        const uploadTimeoutMs = minPositive([TTS_UPLOAD_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
        lastUploadTimeoutMs = uploadTimeoutMs;
        try {
          const chunkSpokenText = String(texts[idx] || "").trim();
          await sendVoice(job.chatId, oggPath, {
            timeoutMs: uploadTimeoutMs,
            signal: abortSignal,
            replyToMessageId: job.replyToMessageId,
            routeWorkerId: job.workerId,
            routeTaskId: Number(job?.taskId || 0),
            routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
            replyContextText: chunkSpokenText,
          });
          sentCount = idx + 1;
          uploadErr = null;
          break;
        } catch (err) {
          uploadErr = err;
          if (job.cancelRequested) break;

          const isAbort = String(err?.name || "").trim() === "AbortError";
          const canceledByCaller = Boolean(abortSignal && abortSignal.aborted);
          const hardRemaining = hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS);
          const canRetry = isAbort && !canceledByCaller && attempt < maxStageAttempts && (hardRemaining === 0 || hardRemaining > 1);
          if (canRetry) {
            log(`TTS: upload attempt ${attempt}/${maxStageAttempts} timed out; retrying...`);
            await sleep(350);
            continue;
          }

          break;
        }
      }
    } finally {
      try {
        if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
      } catch {
        // best effort
      }
    }

    if (uploadErr) {
      cleanupWavs();
      if (job.cancelRequested) {
        return { ok: false, text: "TTS canceled." };
      }
      if (String(uploadErr?.name || "").trim() === "AbortError") {
        const ms = Number(lastUploadTimeoutMs || 0) || TTS_HARD_TIMEOUT_MS || 0;
        return {
          ok: false,
          text: formatFailureText(`TTS upload timed out after ${Math.round(ms / 1000)}s.`, sentCount),
          afterText,
          attachments,
        };
      }
      return {
        ok: false,
        text: formatFailureText(`Failed to send Telegram voice message: ${String(uploadErr?.message || uploadErr)}`, sentCount),
        afterText,
        attachments,
      };
    }
  }

  if (job?.skipResultText === true) {
    return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
  }

  if (TTS_SEND_TEXT) {
    return { ok: true, text: texts.join(" "), afterText, attachments };
  }

  return { ok: true, text: "", skipSendMessage: true, afterText, attachments };
  } finally {
    // no-op
  }
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
  // Voice-mode response markers are not useful as "progress" messages.
  if (/^spoken\s*:\s*$/i.test(s)) return true;
  if (/^text[_ ]?only\s*:\s*$/i.test(s)) return true;
  // Suppress internal TTS progress lines if they ever leak into progress updates.
  if (/^tts:\s*/i.test(s)) return true;
  // Suppress typical structured log lines (Rust/Go style) that are noisy in Telegram chats.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\s+(error|warn|info|debug)\b/i.test(s)) {
    return true;
  }
  if (/^(error|warn|info|debug)\s+\S+(?:::\S+)+:/i.test(s)) return true;
  if (/^OpenAI\s+/i.test(s)) return true;
  if (/^Progress\s*\(/i.test(s)) return true;
  if (/^Still working\s*\(/i.test(s)) return true;
  if (/^(workdir|model|provider|approval|sandbox|reasoning|reasoning effort|reasoning summaries|session id):/i.test(s)) {
    return true;
  }
  if (/^You are AIDOLON CLI replying via Telegram\.?$/i.test(s)) return true;
  if (/^Keep it concise and practical\.?$/i.test(s)) return true;
  if (/^If ambiguous, ask one clear follow-up question\.?$/i.test(s)) return true;
  if (/^User message:$/i.test(s)) return true;
  return false;
}

function pickChatActionForJob(job) {
  const kind = String(job?.kind || "").trim().toLowerCase();
  const source = String(job?.source || "").trim().toLowerCase();
  if (
    kind === "tts" ||
    kind === "tts-batch" ||
    source === "voice-reply" ||
    source === "tts-batch-chunk"
  ) {
    return TELEGRAM_CHAT_ACTION_VOICE;
  }
  return TELEGRAM_CHAT_ACTION_DEFAULT;
}

function startJobChatActionKeepalive(job, lane) {
  if (!TELEGRAM_CHAT_ACTION_ENABLED) {
    return () => {};
  }

  const chatId = String(job?.chatId || "").trim();
  if (!chatId) {
    return () => {};
  }

  const action = pickChatActionForJob(job);
  const intervalMs = Math.max(1000, Math.trunc(Number(TELEGRAM_CHAT_ACTION_INTERVAL_SEC) || 4) * 1000);
  let stopped = false;
  let timer = null;
  let loggedError = false;

  const tick = async () => {
    if (stopped || shuttingDown || lane?.currentJob !== job) return;

    const ok = await sendChatAction(chatId, action, { logErrors: !loggedError });
    if (!ok) loggedError = true;

    if (stopped || shuttingDown || lane?.currentJob !== job) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function startJobProgressUpdates(job, lane) {
  if (!PROGRESS_UPDATES_ENABLED) {
    return () => {};
  }
  // TTS jobs are intentionally noisy (model load, encode, ffmpeg). Don't stream that into Telegram.
  if (String(job?.kind || "") === "tts" || String(job?.kind || "") === "tts-batch") {
    return () => {};
  }
  // Whisper transcription is also noisy and not useful as progress messages.
  if (String(job?.kind || "") === "whisper") {
    return () => {};
  }
  // For voice-note prompts that will be answered via voice notes, avoid sending text "progress" pings.
  // Those pings are output-driven and can leak reply markers/content into the chat.
  if (String(job?.source || "") === "voice" && TTS_REPLY_TO_VOICE && TTS_ENABLED) {
    return () => {};
  }
  // Vision command paths can emit temporary progress chatter that is not useful in chat.
  const source = String(job?.source || "").trim().toLowerCase();
  if (source === "see-screenshot" || source === "ask-image" || source === "image-caption") {
    return () => {};
  }

  let stopped = false;
  let timer = null;

  job.progressStdoutRemainder = "";
  job.progressStderrRemainder = "";
  job.progressPendingLine = "";
  job.progressLastSentLine = "";
  job.progressLastSentAt = 0;

  const debounceMs = 250;

  const flush = async () => {
    if (stopped || shuttingDown || lane?.currentJob !== job) return;
    const line = String(job.progressPendingLine || "").trim();
    if (!line) return;
    if (line === String(job.progressLastSentLine || "")) return;

    job.progressPendingLine = "";
    job.progressLastSentLine = line;
    job.progressLastSentAt = Date.now();

    try {
      await sendMessage(job.chatId, line, {
        silent: true,
        replyToMessageId: job.replyToMessageId,
        routeWorkerId: job.workerId,
        routeTaskId: Number(job?.taskId || 0),
        routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
      });
    } catch (err) {
      log(`sendMessage(progress) failed: ${redactError(err.message || err)}`);
    }

    if (job.progressPendingLine) {
      schedule();
    }
  };

  const schedule = () => {
    if (stopped || shuttingDown || lane?.currentJob !== job) return;
    if (timer) return;
    if (!job.progressPendingLine) return;

    const now = Date.now();
    const gateAt = job.startedAt + Math.max(0, PROGRESS_FIRST_UPDATE_SEC) * 1000;
    const throttleAt = Number(job.progressLastSentAt || 0) + Math.max(0, PROGRESS_UPDATE_INTERVAL_SEC) * 1000;
    const earliestAt = Math.max(gateAt, throttleAt, now + debounceMs);
    const waitMs = Math.max(0, earliestAt - now);

    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, waitMs);
  };

  const ingest = (chunkText, streamName) => {
    if (stopped || shuttingDown || lane?.currentJob !== job) return;
    // Forwarding stderr into Telegram tends to produce spammy log lines. Keep it opt-in.
    if (String(streamName || "") === "stderr" && !PROGRESS_INCLUDE_STDERR) return;
    const chunk = String(chunkText || "");
    if (!chunk) return;

    const key = streamName === "stderr" ? "progressStderrRemainder" : "progressStdoutRemainder";
    const prev = String(job[key] || "");
    const combined = `${prev}${chunk}`.replace(/\r/g, "");
    const parts = combined.split("\n");
    let remainder = parts.pop() ?? "";
    if (remainder.length > 10_000) remainder = remainder.slice(-10_000);
    job[key] = remainder;

    for (const rawLine of parts) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      if (isProgressNoiseLine(line)) continue;
      job.progressPendingLine = truncateLine(line, 3500);
    }

    schedule();
  };

  job.onProgressChunk = ingest;

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    job.onProgressChunk = null;
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

    const timeoutMs = Number.isFinite(Number(job?.timeoutMs)) && Number(job.timeoutMs) > 0
      ? Number(job.timeoutMs)
      : CODEX_TIMEOUT_MS;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        job.timedOut = true;
        terminateChildTree(child, { forceAfterMs: 3000 });
      }, timeoutMs)
      : null;

    child.stdout.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stdoutTail = appendTail(job.stdoutTail, chunk);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
    });

    child.stderr.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stderrTail = appendTail(job.stderrTail, chunk);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stderr");
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
          text: `Job #${job.id} timed out after ${Math.round(timeoutMs / 1000)}s.${tail ? `\n\n${tail}` : ""}`,
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

async function processLane(laneId) {
  const lane = getLane(laneId);
  if (!lane || shuttingDown) return;
  if (lane.currentJob) return;

  while (Array.isArray(lane.queue) && lane.queue.length > 0 && !shuttingDown) {
    const job = lane.queue.shift();
    lane.currentJob = job;
    job.startedAt = Date.now();
    markOrchTaskRunning(job);
    // Allow cancellation to abort in-flight fetch() operations (Telegram uploads).
    job.abortController = new AbortController();
    const stopChatActionKeepalive = startJobChatActionKeepalive(job, lane);
    const stopProgressUpdates = startJobProgressUpdates(job, lane);

    let result;
    try {
        try {
          result = job.kind === "raw"
            ? await runRawCodexJob(job)
            : job.kind === "tts"
              ? await runTtsJob(job, lane)
              : job.kind === "tts-batch"
                ? await runTtsBatchJob(job, lane)
                : job.kind === "whisper"
                  ? await runWhisperJob(job, lane)
                  : await runCodexJob(job);
        } catch (err) {
          const msg = String(err?.message || err || "").trim() || "Unknown error";
          result = { ok: false, text: `Job #${job.id} failed unexpectedly: ${msg}` };
        }
    } finally {
      stopProgressUpdates();
    }

    if (result && result.ok) {
      const resolvedSessionId = String(result.sessionId || job.resumeSessionId || "").trim();
      if (resolvedSessionId) {
        const wid = String(job?.workerId || "").trim() || String(lane.id || "").trim() || ORCH_GENERAL_WORKER_ID;
        setSessionForChatWorker(job.chatId, wid, resolvedSessionId);
      }
      if (typeof job?.onSuccess === "function") {
        try {
          await job.onSuccess(result, job);
        } catch (err) {
          log(`job.onSuccess failed for #${job.id}: ${redactError(err?.message || err)}`);
        }
      }
    }

    let emittedMessageIds = [];
    let resolvedSessionIdForTask = "";
    try {
      const routeWorkerId = String(job?.workerId || "").trim() || String(lane.id || "").trim();
      const routeTaskId = Number(job?.taskId || 0);
      const replyToMessageId = Number(job?.replyToMessageId || 0);
      const resolvedSessionId = String(
        result?.sessionId ||
          getSessionForChatWorker(job.chatId, routeWorkerId) ||
          job?.resumeSessionId ||
          "",
      ).trim();
      resolvedSessionIdForTask = resolvedSessionId;
      const collectSentMessageIds = (value) => {
        for (const item of Array.isArray(value) ? value : [value]) {
          const id = Number(item?.message_id || 0);
          if (!Number.isFinite(id) || id <= 0) continue;
          emittedMessageIds.push(Math.trunc(id));
        }
      };

      const attachParsed = extractAttachDirectives(String(result?.text || ""));
      const attachments = Array.isArray(attachParsed.attachments) ? attachParsed.attachments : [];
      const resultAfterText = String(result?.afterText || "").trim();
      const resultAttachments = Array.isArray(result?.attachments) ? result.attachments : [];
      const allAttachments = [...attachments, ...resultAttachments];
      if (result && typeof result === "object") {
        result.text = attachParsed.text;
      }
      const forcedTextOnly = String(job?.forcedTextOnly || "").trim();
      const hasForcedTextOnly = Boolean(forcedTextOnly);
      if (hasForcedTextOnly && result && typeof result === "object") {
        result.text = injectForcedTextOnlySection(String(result.text || ""), forcedTextOnly);
      }

      const shouldVoiceReply = Boolean(
        result?.ok &&
          job?.kind !== "tts" &&
          job?.kind !== "tts-batch" &&
          String(job?.source || "") === "voice" &&
          TTS_REPLY_TO_VOICE &&
          TTS_ENABLED &&
          String(result?.text || "").trim(),
      );

      let voiceQueued = false;
      let voiceReplyReadyText = "";
      if (shouldVoiceReply) {
        try {
          const parts = splitVoiceReplyParts(String(result.text || ""));
          const spoken = makeSpeakableTextForTts(parts.spoken || String(result.text || ""));
          const { chunks: spokenChunks, overflowText } = splitSpeakableTextIntoVoiceChunks(spoken);
          const modelTextOnly = String(parts.textOnly || "").trim();
          const preferredTextOnly = hasForcedTextOnly ? forcedTextOnly : modelTextOnly;
          const extracted = preferredTextOnly ? "" : extractNonSpeakableInfo(String(result.text || ""));
          let afterText = preferredTextOnly || (extracted ? `Text-only details:\n${extracted}` : "");
          if (overflowText) {
            const moved = `Moved from SPOKEN (too long for voice notes):\n${overflowText}`;
            afterText = afterText ? `${afterText}\n\n${moved}` : moved;
          }

          const chunks = spokenChunks.length > 0 ? spokenChunks : (spoken ? [spoken] : []);
          const queued = chunks.length > 1
            ? await enqueueTtsBatch(job.chatId, chunks, "voice-reply", {
              // Send text/attachments from the main job path so they do not wait for TTS.
              afterText: "",
              // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
              skipResultText: true,
              attachments: [],
              workerId: routeWorkerId,
              replyToMessageId,
              routeTaskId,
              routeSessionId: resolvedSessionId,
            })
            : await enqueueTts(job.chatId, chunks[0] || spoken, "voice-reply", {
              // Send text/attachments from the main job path so they do not wait for TTS.
              afterText: "",
              // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
              skipResultText: true,
              attachments: [],
              workerId: routeWorkerId,
              replyToMessageId,
              routeTaskId,
              routeSessionId: resolvedSessionId,
            });
          voiceQueued = Boolean(queued);
          if (voiceQueued) {
            voiceReplyReadyText = afterText;
          }
        } catch (err) {
          // If voice enqueue fails, fall back to sending text so the user still gets an answer.
          log(`enqueueTts(voice-reply) failed: ${redactError(err?.message || err)}`);
          voiceQueued = false;
        }
      }

      const shouldSuppressResultTextForQueuedVoice = shouldVoiceReply && voiceQueued;
      const shouldSendForcedTextOnly = hasForcedTextOnly && !shouldVoiceReply;
      if (!result || (result.skipSendMessage !== true && !shouldSuppressResultTextForQueuedVoice)) {
        try {
          const responseText = shouldSendForcedTextOnly
            ? forcedTextOnly
            : normalizeResponse(result?.text);
          const sent = await sendMessage(job.chatId, responseText, {
            replyToMessageId,
            routeWorkerId,
            routeTaskId,
            routeSessionId: resolvedSessionId,
          });
          collectSentMessageIds(sent);
        } catch (err) {
          log(`sendMessage(result) failed: ${redactError(err.message || err)}`);
        }
      }

      const combinedAfterText = [voiceReplyReadyText, resultAfterText].filter(Boolean).join("\n\n").trim();
      if (combinedAfterText) {
        try {
          const sent = await sendMessage(job.chatId, combinedAfterText, {
            replyToMessageId,
            routeWorkerId,
            routeTaskId,
            routeSessionId: resolvedSessionId,
          });
          collectSentMessageIds(sent);
        } catch (err) {
          log(`sendMessage(afterText) failed: ${redactError(err?.message || err)}`);
        }
      }

      // Send attachments from the main job path so they are not blocked on TTS generation.
      if (allAttachments.length > 0) {
        try {
          const sent = await sendAttachments(job.chatId, allAttachments, {
            replyToMessageId,
            routeWorkerId,
            routeTaskId,
            routeSessionId: resolvedSessionId,
          });
          collectSentMessageIds(sent);
        } catch (err) {
          log(`sendAttachments(result) failed: ${redactError(err?.message || err)}`);
        }
      }
    } catch (err) {
      log(`processLane(post) failed: ${redactError(err?.message || err)}`);
    } finally {
      markOrchTaskCompleted(job, result, {
        sessionId: resolvedSessionIdForTask,
        outputMessageIds: [...new Set(emittedMessageIds)],
      });
      stopChatActionKeepalive();
      lane.currentJob = null;
      void maybeTriggerPendingRestart("job completion");
    }
  }
}

function isRetryableTelegramNetworkError(err) {
  const name = String(err?.name || "").trim();
  if (name === "AbortError") return false;
  const message = String(err?.message || err || "").trim();
  if (!message) return false;
  return (
    /fetch failed/i.test(message) ||
    /network(?:\s+error|\s+request failed)/i.test(message) ||
    /\b(econnreset|econnrefused|enotfound|ehostunreach|etimedout|eai_again|socket hang up|connection reset|und_err)/i.test(
      message,
    )
  );
}

async function getTelegramFileMeta(fileId, { signal } = {}) {
  const params = new URLSearchParams({ file_id: String(fileId || "") });
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await telegramApi("getFile", {
        query: params.toString(),
        signal,
      });
    } catch (err) {
      const isAbort = String(err?.name || "").trim() === "AbortError";
      const retryable = isRetryableTelegramNetworkError(err);
      if (isAbort || !retryable || attempt >= maxAttempts) throw err;
      const delayMs = computeExponentialBackoffMs(attempt, 300, 3000, 0.15);
      log(
        `getTelegramFileMeta attempt ${attempt}/${maxAttempts} failed: ${redactError(err?.message || err)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error("Telegram getFile failed.");
}

async function downloadTelegramFile(filePath, destinationPath, { signal } = {}) {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const delayMs = computeExponentialBackoffMs(attempt, 300, 3000, 0.15);
          log(
            `downloadTelegramFile HTTP ${res.status} on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue;
        }
        throw new Error(`File download failed: HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new Error("File download failed: empty body");
      }

      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destinationPath));
      return fs.statSync(destinationPath).size;
    } catch (err) {
      const isAbort = String(err?.name || "").trim() === "AbortError";
      const retryable = isRetryableTelegramNetworkError(err);
      if (isAbort || !retryable || attempt >= maxAttempts) throw err;
      const delayMs = computeExponentialBackoffMs(attempt, 300, 3000, 0.15);
      log(
        `downloadTelegramFile attempt ${attempt}/${maxAttempts} failed: ${redactError(err?.message || err)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error("File download failed.");
}

function rejectWhisperKeepalivePending(err) {
  const pending = whisperKeepalive.pending;
  if (!pending) return;
  whisperKeepalive.pending = null;
  if (pending.abortSignal && typeof pending.abortSignal.removeEventListener === "function" && pending.onAbort) {
    try {
      pending.abortSignal.removeEventListener("abort", pending.onAbort);
    } catch {
      // best effort
    }
  }
  if (pending.timer) clearTimeout(pending.timer);
  const message = String(err?.message || err || "Whisper keepalive request failed").trim() || "Whisper keepalive request failed";
  pending.reject(new Error(message));
}

function clearWhisperKeepaliveRestartTimer() {
  if (whisperKeepalive.restartTimer) {
    clearTimeout(whisperKeepalive.restartTimer);
    whisperKeepalive.restartTimer = null;
  }
}

function scheduleWhisperKeepaliveRestart(reason = "") {
  if (!WHISPER_KEEPALIVE || !WHISPER_KEEPALIVE_AUTO_RESTART) return;
  if (shuttingDown) return;
  if (whisperKeepalive.proc || whisperKeepalive.startPromise) return;
  if (whisperKeepalive.restartTimer) return;

  whisperKeepalive.restartAttempts = Math.max(0, Number(whisperKeepalive.restartAttempts || 0)) + 1;
  const delayMs = computeExponentialBackoffMs(
    whisperKeepalive.restartAttempts,
    KEEPALIVE_RESTART_BASE_DELAY_MS,
    KEEPALIVE_RESTART_MAX_DELAY_MS,
    0.15,
  );
  const why = oneLine(String(reason || "").trim());
  log(`Scheduling Whisper keepalive restart in ${delayMs}ms${why ? ` (${why})` : ""}.`);

  whisperKeepalive.restartTimer = setTimeout(async () => {
    whisperKeepalive.restartTimer = null;
    if (shuttingDown || !WHISPER_KEEPALIVE || !WHISPER_KEEPALIVE_AUTO_RESTART) return;
    if (whisperKeepalive.proc || whisperKeepalive.startPromise) return;
    try {
      const proc = await ensureWhisperKeepaliveRunning();
      if (!proc || !whisperKeepalive.ready) {
        scheduleWhisperKeepaliveRestart("not ready");
      }
    } catch (err) {
      log(`Whisper keepalive auto-restart failed: ${redactError(err?.message || err)}`);
      scheduleWhisperKeepaliveRestart("retry");
    }
  }, delayMs);
}

function failWhisperKeepaliveStart(err) {
  if (whisperKeepalive.startTimer) {
    clearTimeout(whisperKeepalive.startTimer);
    whisperKeepalive.startTimer = null;
  }
  const reject = typeof whisperKeepalive.startReject === "function" ? whisperKeepalive.startReject : null;
  whisperKeepalive.startResolve = null;
  whisperKeepalive.startReject = null;
  whisperKeepalive.startPromise = null;
  if (reject) reject(err instanceof Error ? err : new Error(String(err || "Whisper keepalive start failed")));
}

function resolveWhisperKeepaliveStart() {
  if (whisperKeepalive.startTimer) {
    clearTimeout(whisperKeepalive.startTimer);
    whisperKeepalive.startTimer = null;
  }
  clearWhisperKeepaliveRestartTimer();
  whisperKeepalive.restartAttempts = 0;
  const resolve = typeof whisperKeepalive.startResolve === "function" ? whisperKeepalive.startResolve : null;
  whisperKeepalive.startResolve = null;
  whisperKeepalive.startReject = null;
  whisperKeepalive.startPromise = null;
  if (resolve) resolve(whisperKeepalive.proc);
}

function stopWhisperKeepalive(reason = "", { allowAutoRestart = true } = {}) {
  const proc = whisperKeepalive.proc;
  whisperKeepalive.proc = null;
  whisperKeepalive.ready = false;
  whisperKeepalive.stdoutBuf = "";
  if (!allowAutoRestart) {
    clearWhisperKeepaliveRestartTimer();
    whisperKeepalive.restartAttempts = 0;
  }
  const why = String(reason || "").trim();
  rejectWhisperKeepalivePending(why || "Whisper keepalive stopped.");
  if (whisperKeepalive.startReject) {
    failWhisperKeepaliveStart(new Error(why || "Whisper keepalive stopped before becoming ready."));
  }
  if (!proc) {
    if (allowAutoRestart) scheduleWhisperKeepaliveRestart(why || "stopped");
    return;
  }
  try {
    terminateChildTree(proc, { forceAfterMs: 1500 });
  } catch {
    // best effort
  }
  if (allowAutoRestart) scheduleWhisperKeepaliveRestart(why || "stopped");
}

function handleWhisperKeepaliveLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return;

  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    whisperKeepalive.stderrTail = appendTail(whisperKeepalive.stderrTail, `${line}\n`, 16000);
    return;
  }

  if (!msg || typeof msg !== "object") return;
  const type = String(msg.type || "").trim().toLowerCase();
  if (type === "ready") {
    whisperKeepalive.ready = true;
    resolveWhisperKeepaliveStart();
    return;
  }

  if (type !== "result") return;
  const pending = whisperKeepalive.pending;
  if (!pending) return;

  const msgId = String(msg.id || "").trim();
  if (!msgId || msgId !== pending.id) return;

  whisperKeepalive.pending = null;
  if (pending.abortSignal && typeof pending.abortSignal.removeEventListener === "function" && pending.onAbort) {
    try {
      pending.abortSignal.removeEventListener("abort", pending.onAbort);
    } catch {
      // best effort
    }
  }
  if (pending.timer) clearTimeout(pending.timer);

  if (msg.ok === true) {
    pending.resolve(msg);
    return;
  }
  const err = String(msg.error || "Whisper keepalive transcription failed").trim() || "Whisper keepalive transcription failed";
  pending.reject(new Error(err));
}

async function ensureWhisperKeepaliveRunning() {
  if (!WHISPER_KEEPALIVE) return null;
  if (!fs.existsSync(WHISPER_SERVER_SCRIPT_PATH)) return null;
  if (!fs.existsSync(WHISPER_PYTHON)) return null;

  if (whisperKeepalive.proc && whisperKeepalive.ready) return whisperKeepalive.proc;
  if (whisperKeepalive.startPromise) return await whisperKeepalive.startPromise;

  whisperKeepalive.startPromise = new Promise((resolve, reject) => {
    whisperKeepalive.startResolve = resolve;
    whisperKeepalive.startReject = reject;
  });
  const startupPromise = whisperKeepalive.startPromise;

  const startupTimeoutMs = Number(WHISPER_KEEPALIVE_STARTUP_TIMEOUT_MS);
  if (startupTimeoutMs > 0) {
    whisperKeepalive.startTimer = setTimeout(() => {
      failWhisperKeepaliveStart(
        new Error(`Whisper keepalive startup timed out after ${Math.round(startupTimeoutMs / 1000)}s.`),
      );
      stopWhisperKeepalive("Whisper keepalive startup timeout.");
    }, startupTimeoutMs);
  }

  let proc;
  try {
    const args = [
      WHISPER_SERVER_SCRIPT_PATH,
      "--model",
      WHISPER_MODEL,
      "--default-language",
      WHISPER_LANGUAGE,
    ];
    proc = spawn(WHISPER_PYTHON, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    failWhisperKeepaliveStart(new Error(`Failed to start Whisper keepalive process: ${err?.message || err}`));
    scheduleWhisperKeepaliveRestart("spawn failed");
    return await startupPromise;
  }

  whisperKeepalive.proc = proc;
  whisperKeepalive.ready = false;
  whisperKeepalive.stdoutBuf = "";
  whisperKeepalive.stderrTail = "";

  if (proc.stdin && typeof proc.stdin.on === "function") {
    proc.stdin.on("error", (err) => {
      if (whisperKeepalive.proc !== proc) return;
      const msg = `Whisper keepalive stdin error: ${err?.message || err}`;
      rejectWhisperKeepalivePending(msg);
      stopWhisperKeepalive(msg);
    });
  }

  proc.stdout.on("data", (buf) => {
    const chunk = String(buf || "");
    whisperKeepalive.stdoutBuf = appendTail(whisperKeepalive.stdoutBuf, chunk, 24000);
    let src = whisperKeepalive.stdoutBuf;
    let idx;
    while ((idx = src.indexOf("\n")) !== -1) {
      const line = src.slice(0, idx);
      src = src.slice(idx + 1);
      handleWhisperKeepaliveLine(line);
    }
    whisperKeepalive.stdoutBuf = src;
  });

  proc.stderr.on("data", (buf) => {
    const chunk = String(buf || "");
    whisperKeepalive.stderrTail = appendTail(whisperKeepalive.stderrTail, chunk, 50000);
    if (WHISPER_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
  });

  proc.on("error", (err) => {
    const msg = `Whisper keepalive process error: ${err?.message || err}`;
    if (whisperKeepalive.startReject) {
      failWhisperKeepaliveStart(new Error(msg));
    }
    stopWhisperKeepalive(msg);
  });

  proc.on("close", (code, signal) => {
    const codeText = typeof code === "number" ? `exit ${code}` : "exit";
    const sigText = signal ? ` (${signal})` : "";
    const tail = oneLine(whisperKeepalive.stderrTail || "");
    const msg = `Whisper keepalive closed (${codeText}${sigText})${tail ? `: ${tail}` : ""}`;
    if (whisperKeepalive.startReject) {
      failWhisperKeepaliveStart(new Error(msg));
    }
    stopWhisperKeepalive(msg);
  });

  return await startupPromise;
}

async function transcribeAudioWithWhisperKeepalive(audioPath, { abortSignal, job } = {}) {
  const proc = await ensureWhisperKeepaliveRunning();
  if (!proc) throw new Error("Whisper keepalive is unavailable.");
  if (whisperKeepalive.pending) throw new Error("Whisper keepalive is busy.");

  const requestId = `whisper-${whisperKeepalive.requestSeq++}-${Date.now()}`;
  if (job && typeof job === "object") {
    job.process = proc;
  }

  return await new Promise((resolve, reject) => {
    const pending = {
      id: requestId,
      resolve,
      reject,
      timer: null,
      abortSignal,
      onAbort: null,
    };

    if (abortSignal && typeof abortSignal === "object") {
      const onAbort = () => {
        stopWhisperKeepalive("Whisper canceled.");
      };
      pending.onAbort = onAbort;
      try {
        if (abortSignal.aborted) {
          onAbort();
        } else if (typeof abortSignal.addEventListener === "function") {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      } catch {
        // best effort
      }
    }

    whisperKeepalive.pending = pending;

    const payload = {
      type: "transcribe",
      id: requestId,
      audio_path: String(audioPath || ""),
      language: WHISPER_LANGUAGE,
    };

    writeChildStdin(proc, `${JSON.stringify(payload)}\n`, (err) => {
      const msg = `Failed to write Whisper keepalive request: ${err?.message || err}`;
      rejectWhisperKeepalivePending(msg);
      if (whisperKeepalive.proc === proc) {
        stopWhisperKeepalive(msg);
      }
    });
  }).then((msg) => String(msg?.text || "").trim());
}

async function transcribeAudioWithWhisper(audioPath, { abortSignal, job } = {}) {
  if (!WHISPER_ENABLED) {
    throw new Error("Voice transcription disabled");
  }
  const canUseKeepalive = WHISPER_KEEPALIVE && fs.existsSync(WHISPER_SERVER_SCRIPT_PATH);
  const canUseLegacy = fs.existsSync(WHISPER_SCRIPT_PATH);
  if (!canUseKeepalive && !canUseLegacy) {
    throw new Error(`Whisper scripts missing: ${WHISPER_SCRIPT_PATH} / ${WHISPER_SERVER_SCRIPT_PATH}`);
  }
  if (!fs.existsSync(WHISPER_PYTHON)) {
    throw new Error(
      `Whisper venv python missing: ${WHISPER_PYTHON}. Run setup-whisper-venv.cmd`,
    );
  }

  if (canUseKeepalive) {
    try {
      return await transcribeAudioWithWhisperKeepalive(audioPath, { abortSignal, job });
    } catch (err) {
      const msg = String(err?.message || err || "").trim();
      if (/whisper canceled/i.test(msg) || /aborted/i.test(msg)) {
        throw new Error("Whisper canceled.");
      }
      if (!canUseLegacy) {
        throw new Error(msg || "Whisper keepalive transcription failed.");
      }
      log(`Whisper keepalive failed; falling back to one-shot process: ${oneLine(msg || "unknown error")}`);
    }
  }

  const args = [WHISPER_SCRIPT_PATH, "--audio", audioPath, "--model", WHISPER_MODEL];
  if (WHISPER_LANGUAGE && WHISPER_LANGUAGE.toLowerCase() !== "auto") {
    args.push("--language", WHISPER_LANGUAGE);
  }

  return await new Promise((resolve, reject) => {
    const py = spawn(WHISPER_PYTHON, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (job && typeof job === "object") {
      job.process = py;
    }

    let stdout = "";
    let stderr = "";

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        terminateChildTree(py, { forceAfterMs: 1500 });
      } catch {
        // best effort
      }
    };
    if (abortSignal && typeof abortSignal === "object") {
      try {
        if (abortSignal.aborted) {
          onAbort();
        } else if (typeof abortSignal.addEventListener === "function") {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      } catch {
        // best effort
      }
    }

    py.stdout.on("data", (buf) => {
      const chunk = String(buf || "");
      stdout = appendTail(stdout, chunk, 20000);
      if (WHISPER_STREAM_OUTPUT_TO_TERMINAL) process.stdout.write(chunk);
    });
    py.stderr.on("data", (buf) => {
      const chunk = String(buf || "");
      stderr = appendTail(stderr, chunk, 20000);
      if (WHISPER_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(chunk);
    });
    py.on("error", (err) => {
      reject(new Error(`Whisper process error: ${err.message || err}`));
    });
    py.on("close", (code) => {
      try {
        if (abortSignal && typeof abortSignal.removeEventListener === "function") {
          abortSignal.removeEventListener("abort", onAbort);
        }
      } catch {
        // best effort
      }
      if (aborted) {
        reject(new Error("Whisper canceled."));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Whisper failed with exit ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function prewarmAudioKeepalives() {
  const tasks = [];

  if (WHISPER_ENABLED && WHISPER_KEEPALIVE && WHISPER_PREWARM_ON_STARTUP) {
    if (!fs.existsSync(WHISPER_SERVER_SCRIPT_PATH)) {
      log(`Whisper prewarm skipped: server script missing at ${WHISPER_SERVER_SCRIPT_PATH}`);
    } else if (!fs.existsSync(WHISPER_PYTHON)) {
      log(`Whisper prewarm skipped: python missing at ${WHISPER_PYTHON}`);
    } else {
      tasks.push((async () => {
        try {
          await ensureWhisperKeepaliveRunning();
          if (whisperKeepalive.proc && whisperKeepalive.ready) {
            log("Whisper keepalive prewarmed.");
          }
        } catch (err) {
          log(`Whisper prewarm failed: ${redactError(err?.message || err)}`);
        }
      })());
    }
  }

  if (TTS_ENABLED && TTS_KEEPALIVE && TTS_PREWARM_ON_STARTUP) {
    const pyBin = resolveTtsPythonBin();
    if (!pyBin) {
      log("TTS prewarm skipped: python not found.");
    } else if (!fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH)) {
      log(`TTS prewarm skipped: server script missing at ${AIDOLON_TTS_SERVER_SCRIPT_PATH}`);
    } else if (!TTS_MODEL) {
      log("TTS prewarm skipped: TTS_MODEL is not set.");
    } else if (!TTS_REFERENCE_AUDIO || !fs.existsSync(TTS_REFERENCE_AUDIO)) {
      log(`TTS prewarm skipped: reference audio missing at ${TTS_REFERENCE_AUDIO || "(unset)"}`);
    } else {
      tasks.push((async () => {
        try {
          await ensureTtsKeepaliveRunning(pyBin);
          if (ttsKeepalive.proc && ttsKeepalive.ready) {
            log("TTS keepalive prewarmed.");
          }
        } catch (err) {
          log(`TTS prewarm failed: ${redactError(err?.message || err)}`);
        }
      })());
    }
  }

  if (tasks.length === 0) return;
  await Promise.all(tasks);
}

async function runWhisperJob(job) {
  const chatId = String(job?.chatId || "").trim();
  if (!chatId) {
    return { ok: false, text: "Voice transcription failed: missing chat id." };
  }
  if (!WHISPER_ENABLED) {
    return { ok: false, text: "Voice messages are disabled." };
  }

  const abortSignal = job?.abortController?.signal;
  const fileId = String(job?.fileId || "").trim();
  const replyContext = job?.replyContext && typeof job.replyContext === "object"
    ? { ...job.replyContext }
    : null;
  const replyThreadContext = job?.replyThreadContext && typeof job.replyThreadContext === "object"
    ? { ...job.replyThreadContext }
    : null;
  const userMessageId = Number(job?.userMessageId || 0);
  if (!fileId) {
    return { ok: false, text: "Voice message missing file id." };
  }

  const limMb = Number(WHISPER_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  const declaredBytes = Number(job?.declaredBytes || 0);
  if (Number.isFinite(maxBytes) && declaredBytes > 0 && declaredBytes > maxBytes) {
    return { ok: false, text: `Voice message too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${WHISPER_MAX_FILE_MB}MB.` };
  }

  let localPath = "";

  try {
    const fileMeta = await getTelegramFileMeta(fileId, { signal: abortSignal });
    const remotePath = String(fileMeta?.file_path || "");
    if (!remotePath) {
      return { ok: false, text: "Could not resolve Telegram voice file path." };
    }

    const ext = path.extname(remotePath) || ".ogg";
    localPath = path.join(
      VOICE_DIR,
      `voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
    );

    await downloadTelegramFile(remotePath, localPath, { signal: abortSignal });

    const transcript = String(await transcribeAudioWithWhisper(localPath, { abortSignal, job })).trim();
    if (job.cancelRequested) {
      return { ok: false, text: "Voice transcription canceled." };
    }
    if (!transcript) {
      return { ok: false, text: "No speech detected in voice message." };
    }

    const user = String(job?.user || "").trim();
    logChat("in", chatId, transcript, { source: "voice-transcript", user: user || "unknown" });
    if (Number.isFinite(userMessageId) && userMessageId > 0) {
      recordReplyRoute(chatId, userMessageId, String(job?.workerId || "").trim(), {
        source: "user-voice",
        snippet: transcript,
      });
    }

    const replyToMessageId = Number(job?.replyToMessageId || 0);
    const replyHintMessageId = Number(job?.replyHintMessageId || 0);
    const replyHintWorkerId = String(replyContext?.workerId || "").trim()
      || (replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "");
    const replyThreadIds = Array.isArray(replyThreadContext?.messageIds)
      ? replyThreadContext.messageIds
      : [];
    const recentHistoryContext = buildRecentHistoryContext(chatId, {
      excludeMessageIds: [userMessageId, ...replyThreadIds],
    });

    const newsHandled = await maybeHandleNaturalNewsRequest(chatId, transcript, { replyToMessageId });
    if (newsHandled) {
      return { ok: true, text: "", skipSendMessage: true };
    }

    const safeCommandHandled = await maybeHandleNaturalSafeCommandRequest(chatId, transcript);
    if (safeCommandHandled) {
      return { ok: true, text: "", skipSendMessage: true };
    }

    const commandHandled = await handleCommand(chatId, transcript);
    if (commandHandled) {
      return { ok: true, text: "", skipSendMessage: true };
    }

    await routeAndEnqueuePrompt(chatId, transcript, "voice", {
      replyStyle: TTS_REPLY_TO_VOICE && TTS_ENABLED ? "voice" : "",
      replyToMessageId,
      replyHintWorkerId,
      replyContext,
      replyThreadContext,
      recentHistoryContext,
      originMessageId: userMessageId,
      originSource: "user-voice",
      originSnippet: transcript,
    });

    // The whisper job itself should not emit a Telegram message; it schedules the real Codex job.
    return { ok: true, text: "", skipSendMessage: true };
  } catch (err) {
    if (job.cancelRequested) {
      return { ok: false, text: "Voice transcription canceled." };
    }
    const msg = String(err?.message || err || "");
    if (/whisper canceled/i.test(msg) || /aborted/i.test(msg)) {
      return { ok: false, text: "Voice transcription canceled." };
    }
    return { ok: false, text: `Voice transcription failed: ${msg}` };
  } finally {
    try {
      if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch {
      // best effort
    }
  }
}

async function handleVoiceMessage(msg, context = {}) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId) return;
  const user = senderLabel(msg);
  const incomingMessageId = Number(msg?.message_id || 0);
  const replyContext = context?.replyContext && typeof context.replyContext === "object"
    ? { ...context.replyContext }
    : buildReplyContextFromIncomingMessage(msg);
  const replyThreadContext = context?.replyThreadContext && typeof context.replyThreadContext === "object"
    ? { ...context.replyThreadContext }
    : buildReplyThreadContextFromIncomingMessage(msg);
  const threadIds = Array.isArray(replyThreadContext?.messageIds) ? replyThreadContext.messageIds : [];
  const recentHistoryContext = context?.recentHistoryContext && typeof context.recentHistoryContext === "object"
    ? { ...context.recentHistoryContext }
    : buildRecentHistoryContext(chatId, { excludeMessageIds: [incomingMessageId, ...threadIds] });

  if (!WHISPER_ENABLED) {
    await sendMessage(chatId, "Voice messages are disabled.");
    return;
  }

  const voice = msg.voice || msg.audio || null;
  const fileId = String(voice?.file_id || "");

  if (!fileId) {
    await sendMessage(chatId, "Voice message missing file id.");
    return;
  }

  const limMb = Number(WHISPER_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  const declaredBytes = Number(voice?.file_size || 0);
  if (Number.isFinite(maxBytes) && declaredBytes > 0 && declaredBytes > maxBytes) {
    await sendMessage(chatId, `Voice message too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${WHISPER_MAX_FILE_MB}MB.`);
    return;
  }

  const replyHintMessageId = Number(replyContext?.messageId || msg?.reply_to_message?.message_id || 0);
  const replyHintWorkerId = String(replyContext?.workerId || "").trim()
    || (replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "");
  const routeWorkerId = replyHintWorkerId || getActiveWorkerForChat(chatId) || ORCH_GENERAL_WORKER_ID;

  const lane = ensureWhisperLane();
  const job = {
    id: nextJobId++,
    chatId,
    kind: "whisper",
    source: "whisper",
    workerId: routeWorkerId,
    fileId,
    declaredBytes,
    user,
    userMessageId: incomingMessageId,
    replyToMessageId: incomingMessageId,
    replyHintMessageId,
    replyContext,
    replyThreadContext,
    recentHistoryContext,
    workdir: lane.workdir,
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
  };

  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
    await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`, {
      replyToMessageId: Number(msg?.message_id || 0),
    });
    return;
  }

  lane.queue.push(job);
  void processLane(lane.id);
}

async function handlePhotoOrImageDocument(msg, context = {}) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId) return;
  const user = senderLabel(msg);
  const incomingMessageId = Number(msg?.message_id || 0);
  const replyContext = context?.replyContext && typeof context.replyContext === "object"
    ? { ...context.replyContext }
    : buildReplyContextFromIncomingMessage(msg);
  const replyThreadContext = context?.replyThreadContext && typeof context.replyThreadContext === "object"
    ? { ...context.replyThreadContext }
    : buildReplyThreadContextFromIncomingMessage(msg);
  const threadIds = Array.isArray(replyThreadContext?.messageIds) ? replyThreadContext.messageIds : [];
  const recentHistoryContext = context?.recentHistoryContext && typeof context.recentHistoryContext === "object"
    ? { ...context.recentHistoryContext }
    : buildRecentHistoryContext(chatId, { excludeMessageIds: [incomingMessageId, ...threadIds] });

  if (!VISION_ENABLED) {
    await sendMessage(chatId, "Image received, but vision is disabled on this bot (VISION_ENABLED=0).");
    return;
  }

  let fileId = "";
  let suggestedName = "";
  let ext = "";
  let declaredBytes = 0;
  const userCaption = String(msg?.caption || "").trim();

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    // Telegram provides multiple sizes; take the biggest.
    const best = msg.photo.reduce((a, b) => (Number(b?.file_size || 0) > Number(a?.file_size || 0) ? b : a), msg.photo[0]);
    fileId = String(best?.file_id || "").trim();
    declaredBytes = Number(best?.file_size || 0);
    ext = ".jpg";
    suggestedName = `photo-${Date.now()}.jpg`;
  } else if (msg.document) {
    const mime = String(msg.document.mime_type || "").toLowerCase();
    if (!mime.startsWith("image/")) {
      await sendMessage(chatId, "Document received, but it is not an image.");
      return;
    }
    fileId = String(msg.document.file_id || "").trim();
    declaredBytes = Number(msg.document.file_size || 0);
    suggestedName = String(msg.document.file_name || "").trim() || `image-${Date.now()}`;
    ext = path.extname(suggestedName) || "";
  }

  if (!fileId) {
    await sendMessage(chatId, "Could not read image file id from message.");
    return;
  }

  const replyHintMessageId = Number(replyContext?.messageId || msg?.reply_to_message?.message_id || 0);
  const replyHintWorkerId = String(replyContext?.workerId || "").trim()
    || (replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "");
  const routeWorkerId = replyHintWorkerId || getActiveWorkerForChat(chatId) || ORCH_GENERAL_WORKER_ID;
  if (Number.isFinite(incomingMessageId) && incomingMessageId > 0) {
    recordReplyRoute(chatId, incomingMessageId, routeWorkerId, {
      source: "user-image",
      snippet: userCaption || "[image message]",
    });
  }

  const limMb = Number(VISION_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  if (Number.isFinite(maxBytes) && declaredBytes > 0 && declaredBytes > maxBytes) {
    await sendMessage(chatId, `Image too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${VISION_MAX_FILE_MB}MB.`);
    return;
  }

  let localPath = "";
  let keepLocalPath = false;
  try {
    const fileMeta = await getTelegramFileMeta(fileId);
    const remotePath = String(fileMeta?.file_path || "");
    if (!remotePath) {
      await sendMessage(chatId, "Could not resolve Telegram image file path.");
      return;
    }

    const remoteExt = path.extname(remotePath) || ext || ".jpg";
    const safeExt = remoteExt.toLowerCase().match(/^\\.(png|jpe?g|webp|gif)$/) ? remoteExt.toLowerCase() : ".img";
    localPath = path.join(
      IMAGE_DIR,
      `img-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`,
    );

    const downloadedBytes = await downloadTelegramFile(remotePath, localPath);
    if (Number.isFinite(maxBytes) && downloadedBytes > maxBytes) {
      await sendMessage(chatId, `Downloaded image too large (${Math.round(downloadedBytes / (1024 * 1024))}MB).`);
      return;
    }

    setLastImageForChat(chatId, { path: localPath, name: suggestedName });
    keepLocalPath = true;

    const caption = userCaption;
    logChat("in", chatId, caption || "[image]", { source: "image", user });

    if (!caption) {
      await sendMessage(chatId, "Image saved. Send your question as a message, or use:\n/ask <question>", {
        routeWorkerId,
        routeSource: "image-saved",
        routeSnippet: "[image saved, waiting for question]",
      });
      return;
    }

    const replyToMessageId = Number(msg?.message_id || 0);
    await routeAndEnqueuePrompt(chatId, caption, "image-caption", {
      imagePaths: [localPath],
      replyToMessageId,
      replyHintWorkerId,
      replyContext,
      replyThreadContext,
      recentHistoryContext,
      originMessageId: incomingMessageId,
      originSource: "user-image-caption",
      originSnippet: caption,
    });
  } catch (err) {
    await sendMessage(chatId, `Image handling failed: ${String(err?.message || err)}`);
  } finally {
    if (!keepLocalPath && localPath) {
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch {
        // best effort
      }
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

  if (data.startsWith("pref:")) {
    const prefId = data.slice("pref:".length).trim();
    const entry = consumePrefButton(chatId, prefId);
    if (!entry) {
      await answerCallbackQuery(id, "Expired");
      return;
    }
    if (entry.kind === "model") {
      setChatPrefs(chatId, { model: entry.value });
      await answerCallbackQuery(id, "Model set");
      await sendMessage(chatId, `Model set for this chat: ${String(entry.value || "").trim() || "(default)"}`);
      return;
    }
    if (entry.kind === "reasoning") {
      setChatPrefs(chatId, { reasoning: entry.value });
      await answerCallbackQuery(id, "Reasoning set");
      await sendMessage(chatId, `Reasoning effort set for this chat: ${String(entry.value || "").trim() || "(default)"}`);
      return;
    }
    if (entry.kind === "reset") {
      clearChatPrefs(chatId);
      await answerCallbackQuery(id, "Reset");
      await sendMessage(chatId, "Model preferences reset to defaults for this chat.");
      return;
    }
    await answerCallbackQuery(id, "OK");
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
    return;
  }

  if (data === "orch_retire_cancel") {
    orchPendingSpawnByChat.delete(String(chatId || "").trim());
    await answerCallbackQuery(id, "Canceled");
    await sendMessage(chatId, "Canceled workspace creation.");
    return;
  }

  if (data.startsWith("orch_retire:")) {
    const retireId = data.slice("orch_retire:".length).trim();
    const pending = orchPendingSpawnByChat.get(String(chatId || "").trim()) || null;
    if (!pending || typeof pending !== "object") {
      await answerCallbackQuery(id, "No pending request");
      return;
    }

    const desiredWorkdir = String(pending.desiredWorkdir || "").trim();
    const title = String(pending.title || "").trim();
    const promptText = String(pending.promptText || "");
    const source = String(pending.source || "plain").trim() || "plain";
    const options = pending.options && typeof pending.options === "object" ? { ...pending.options } : {};
    const replyToMessageId = Number(options.replyToMessageId || 0);

    try {
      retireWorker(retireId);
    } catch (err) {
      await answerCallbackQuery(id, "Failed");
      await sendMessage(chatId, `Failed to retire worker: ${String(err?.message || err)}`, { replyToMessageId });
      return;
    }

    let newWorkerId = "";
    try {
      newWorkerId = createRepoWorker(desiredWorkdir, title);
    } catch (err) {
      await answerCallbackQuery(id, "Failed");
      await sendMessage(chatId, `Failed to create workspace: ${String(err?.message || err)}`, { replyToMessageId });
      return;
    } finally {
      orchPendingSpawnByChat.delete(String(chatId || "").trim());
    }

    await answerCallbackQuery(id, "OK");
    const worker = getCodexWorker(newWorkerId);
    const name = String(worker?.name || worker?.title || newWorkerId).trim() || newWorkerId;
    const titleInfo = String(worker?.title || title || "").trim();
    const details = titleInfo && titleInfo !== name ? `${name} (${newWorkerId}, ${titleInfo})` : `${name} (${newWorkerId})`;
    await sendMessage(chatId, `Using workspace ${details}`, {
      replyToMessageId,
      routeWorkerId: newWorkerId,
    });

    try {
      await enqueuePrompt(chatId, promptText, source, { ...options, workerId: newWorkerId, replyToMessageId });
    } catch (err) {
      await sendMessage(chatId, `Failed to enqueue the request: ${String(err?.message || err)}`, { replyToMessageId });
    }
    return;
  }
}

async function handleIncomingMessage(msg) {
  const chatId = String(msg?.chat?.id || "");
  const user = senderLabel(msg);
  const replyContext = buildReplyContextFromIncomingMessage(msg);
  if (!isAllowedMessage(msg)) {
    log(`[chat:drop] unauthorized chat=${chatId || "unknown"} user=${user}`);
    return;
  }
  recordIncomingTelegramMessageMeta(msg);

  const incomingMessageId = Number(msg?.message_id || 0);
  const replyThreadContext = buildReplyThreadContextFromIncomingMessage(msg);
  const excludeMessageIds = [
    incomingMessageId,
    ...(Array.isArray(replyThreadContext?.messageIds) ? replyThreadContext.messageIds : []),
  ];
  const recentHistoryContext = buildRecentHistoryContext(chatId, { excludeMessageIds });

  if (msg.voice || msg.audio) {
    logChat("in", chatId, "[voice-message]", { source: "voice", user });
    await handleVoiceMessage(msg, { replyContext, replyThreadContext, recentHistoryContext });
    return;
  }

  if ((Array.isArray(msg.photo) && msg.photo.length > 0) || msg.document) {
    const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const isImageDoc = Boolean(msg.document && String(msg.document.mime_type || "").toLowerCase().startsWith("image/"));
    if (isPhoto || isImageDoc) {
      logChat("in", chatId, "[image-message]", { source: "image", user });
      await handlePhotoOrImageDocument(msg, { replyContext, replyThreadContext, recentHistoryContext });
      return;
    }
  }

  const text = String(msg.text || "").trim();
  if (!text) {
    logChat("in", chatId, "[non-text-message]", { source: "non-text", user });
    return;
  }

  logChat("in", chatId, text, { source: text.startsWith("/") ? "command" : "plain", user });

  const replyToMessageId = Number(msg?.message_id || 0);
  if (text.startsWith("/")) {
    const handled = await handleCommand(chatId, text);
    if (handled) return;
  }

  const newsHandled = await maybeHandleNaturalNewsRequest(chatId, text, { replyToMessageId });
  if (newsHandled) return;

  const safeCommandHandled = await maybeHandleNaturalSafeCommandRequest(chatId, text);
  if (safeCommandHandled) return;

  const handled = await handleCommand(chatId, text);
  if (handled) return;

  const replyHintMessageId = Number(replyContext?.messageId || msg?.reply_to_message?.message_id || 0);
  const replyHintWorkerId = String(replyContext?.workerId || "").trim()
    || (replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "");
  const originMessageId = Number(msg?.message_id || 0);

  // If vision is enabled and the user sends plain text while an image is "active",
  // treat it as a question about the last image (unless they explicitly used a slash command).
  const canAutoUseImageContext = !replyContext || isImageRelatedReplyContext(replyContext);
  if (VISION_ENABLED && canAutoUseImageContext) {
    const img = getLastImageForChat(chatId);
    const freshEnough = img && (VISION_AUTO_FOLLOWUP_SEC <= 0 || (Date.now() - Number(img.at || 0)) <= VISION_AUTO_FOLLOWUP_SEC * 1000);
    if (img && freshEnough) {
      await routeAndEnqueuePrompt(chatId, text, "image-followup", {
        imagePaths: [img.path],
        replyToMessageId,
        replyHintWorkerId,
        replyContext,
        replyThreadContext,
        recentHistoryContext,
        originMessageId,
        originSource: "user-text",
        originSnippet: text,
      });
      return;
    }
  }

  await routeAndEnqueuePrompt(chatId, text, "plain", {
    replyToMessageId,
    replyHintWorkerId,
    replyContext,
    replyThreadContext,
    recentHistoryContext,
    originMessageId,
    originSource: "user-text",
    originSnippet: text,
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
  const maxUpdateRetries = 3;

  for (;;) {
    if (shuttingDown) return;
    try {
      const updates = await pollUpdates(POLL_TIMEOUT_SEC);
      for (const upd of updates || []) {
        const id = Number(upd.update_id || 0);
        if (!Number.isFinite(id) || id <= lastUpdateId) continue;

        try {
          const msg = upd.message || null;
          if (msg) {
            await handleIncomingMessage(msg);
          } else {
            const cb = upd.callback_query || null;
            if (cb) {
              await handleCallbackQuery(cb);
            }
          }

          updateFailureCounts.delete(id);
          if (id > lastUpdateId) {
            lastUpdateId = id;
            persistState();
          }
          continue;
        } catch (err) {
          const attempts = Math.max(0, Number(updateFailureCounts.get(id) || 0)) + 1;
          updateFailureCounts.set(id, attempts);
          const detail = oneLine(redactError(err?.stack || err?.message || err));
          if (attempts >= maxUpdateRetries) {
            log(`update ${id} failed ${attempts} time(s); skipping: ${detail}`);
            updateFailureCounts.delete(id);
            if (id > lastUpdateId) {
              lastUpdateId = id;
              persistState();
            }
            continue;
          }
          log(`update ${id} handler failed (attempt ${attempts}/${maxUpdateRetries}): ${detail}`);
          await sleep(Math.min(2000, attempts * 500));
          break;
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

async function shutdown(code = 0, reason = "") {
  if (shuttingDown) return;
  shuttingDown = true;
  const normalizedReason = String(reason || "").trim()
    || (Number(code) === RESTART_EXIT_CODE ? "restart_exit" : Number(code) === 0 ? "clean_exit" : "fatal_exit");
  logSystemEvent(`Shutdown begin (code=${code}, reason=${normalizedReason}).`, "shutdown");

  try {
    for (const item of listActiveJobs()) {
      const job = item.job;
      if (!job) continue;
      job.cancelRequested = true;
      try {
        if (job.abortController instanceof AbortController) {
          job.abortController.abort();
        }
      } catch {
        // best effort
      }
      if (job.process) {
        try {
          terminateChildTree(job.process, { forceAfterMs: 2000 });
        } catch {
          // best effort
        }
      }
    }
    for (const lane of lanes.values()) {
      try {
        if (Array.isArray(lane.queue)) lane.queue = [];
      } catch {
        // best effort
      }
    }
    stopTtsKeepalive("Bot shutdown.", { allowAutoRestart: false });
    stopWhisperKeepalive("Bot shutdown.", { allowAutoRestart: false });
  } catch {
    // best effort
  }

  persistState();
  if (lockHeld) {
    releaseProcessLock(LOCK_PATH);
    lockHeld = false;
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0, "signal:SIGINT"));
process.on("SIGTERM", () => void shutdown(0, "signal:SIGTERM"));
process.on("SIGHUP", () => void shutdown(0, "signal:SIGHUP"));

process.on("uncaughtException", (err) => {
  const message = redactError(err?.stack || err?.message || String(err));
  console.error(`[fatal] ${message}`);
  logSystemEvent(`Fatal uncaught exception: ${message}`, "fatal");
  void shutdown(1, "fatal:uncaught_exception");
});

process.on("unhandledRejection", (err) => {
  const message = redactError(err?.stack || err?.message || String(err));
  console.error(`[fatal] ${message}`);
  logSystemEvent(`Fatal unhandled rejection: ${message}`, "fatal");
  void shutdown(1, "fatal:unhandled_rejection");
});

(async () => {
  try {
    const launchParts = [`Launch reason: ${LAUNCH_REASON}`];
    if (LAUNCH_PREV_EXIT_CODE) launchParts.push(`previous_exit_code=${LAUNCH_PREV_EXIT_CODE}`);
    logSystemEvent(launchParts.join(" "), "startup");

    const me = await telegramApi("getMe");
    log(`Connected as @${me.username || me.id}`);
    log(
      `AIDOLON execution mode: ${codexMode.mode} (${codexMode.mode === "wsl" ? `wsl.exe -e bash -lic <${codexMode.codexPath}>` : `${codexMode.bin}${codexMode.shell ? " via shell" : ""}`})`,
    );
    if (TELEGRAM_SET_COMMANDS) {
      try {
        await setTelegramCommands();
        log("Telegram bot commands updated (setMyCommands).");
      } catch (err) {
        log(`setMyCommands failed: ${redactError(err?.message || err)}`);
      }
    }
    if (CODEX_DROPPED_EXTRA_ARGS.length > 0) {
      log(`Ignored unsupported AIDOLON extra args: ${CODEX_DROPPED_EXTRA_ARGS.join(" ")}`);
    }
    if (WHISPER_ENABLED) {
      const whisperMode = WHISPER_KEEPALIVE ? "keepalive" : "one-shot";
      const hasWhisperServer = fs.existsSync(WHISPER_SERVER_SCRIPT_PATH);
      const hasWhisperLegacy = fs.existsSync(WHISPER_SCRIPT_PATH);
      if (!fs.existsSync(WHISPER_PYTHON)) {
        log(`Whisper venv missing at ${WHISPER_PYTHON} (run setup-whisper-venv.cmd)`);
      } else if (!hasWhisperLegacy && !hasWhisperServer) {
        log(`Whisper scripts missing at ${WHISPER_SCRIPT_PATH} / ${WHISPER_SERVER_SCRIPT_PATH}`);
      } else if (WHISPER_KEEPALIVE && !hasWhisperServer) {
        log(`Whisper keepalive requested, but server script is missing at ${WHISPER_SERVER_SCRIPT_PATH} (falling back to one-shot).`);
        log(`Whisper enabled (model=${WHISPER_MODEL}, language=${WHISPER_LANGUAGE || "auto"}, mode=one-shot)`);
      } else {
        log(`Whisper enabled (model=${WHISPER_MODEL}, language=${WHISPER_LANGUAGE || "auto"}, mode=${whisperMode}, auto_restart=${WHISPER_KEEPALIVE_AUTO_RESTART})`);
      }
    }
    if (TTS_ENABLED) {
      const ttsMode = TTS_KEEPALIVE ? "keepalive" : "one-shot";
      const hasTtsServer = fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH);
      const hasTtsLegacy = fs.existsSync(AIDOLON_TTS_SCRIPT_PATH);
      const pyBin = resolveTtsPythonBin();
      if (!pyBin) {
        log("TTS is enabled but Python is not available (set TTS_PYTHON or create TTS_VENV_PATH).");
      } else if (!hasTtsLegacy && !hasTtsServer) {
        log(`TTS helper scripts missing at ${AIDOLON_TTS_SCRIPT_PATH} / ${AIDOLON_TTS_SERVER_SCRIPT_PATH}`);
      } else if (TTS_KEEPALIVE && !hasTtsServer) {
        log(`TTS keepalive requested, but server script is missing at ${AIDOLON_TTS_SERVER_SCRIPT_PATH} (falling back to one-shot).`);
        log(`TTS enabled (model=${TTS_MODEL || "(unset)"}, mode=one-shot)`);
      } else {
        log(`TTS enabled (model=${TTS_MODEL || "(unset)"}, mode=${ttsMode}, auto_restart=${TTS_KEEPALIVE_AUTO_RESTART})`);
      }
    }
    log(
      `Progress updates: enabled=${PROGRESS_UPDATES_ENABLED} include_stderr=${PROGRESS_INCLUDE_STDERR} first=${PROGRESS_FIRST_UPDATE_SEC}s interval=${PROGRESS_UPDATE_INTERVAL_SEC}s`,
    );
    log(
      `Chat actions: enabled=${TELEGRAM_CHAT_ACTION_ENABLED} default=${TELEGRAM_CHAT_ACTION_DEFAULT} voice=${TELEGRAM_CHAT_ACTION_VOICE} interval=${TELEGRAM_CHAT_ACTION_INTERVAL_SEC}s`,
    );
    log(
      `Chat logging: terminal=${CHAT_LOG_TO_TERMINAL} file=${CHAT_LOG_TO_FILE} max_chars=${CHAT_LOG_MAX_CHARS} file_path=${CHAT_LOG_PATH}`,
    );

    await prewarmAudioKeepalives();
    await skipStaleUpdates();

    if (STARTUP_MESSAGE) {
      await sendMessage(PRIMARY_CHAT_ID, `${fmtBold("AIDOLON")} online. Use /help.`);
    }

    await pollLoop();
  } catch (err) {
    const message = redactError(err?.stack || err?.message || err);
    console.error(`[fatal] ${message}`);
    logSystemEvent(`Fatal startup error: ${message}`, "fatal");
    await shutdown(1, "fatal:startup");
  }
})();
