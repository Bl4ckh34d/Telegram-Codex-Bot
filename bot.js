#!/usr/bin/env node
"use strict";

const fs = require("fs");
const dns = require("dns");
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
const WORKFLOW_CATALOG_PATH = (() => {
  const configured = String(process.env.ORCH_WORKFLOW_CATALOG_PATH || "").trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
  }
  const baseDir = String(process.env.APPDATA || "").trim() || path.join(os.homedir(), ".aidolon");
  return path.join(baseDir, "workflow-catalog.json");
})();
const WORLDMONITOR_NATIVE_STORE_PATH = path.join(RUNTIME_DIR, "worldmonitor-native-store.json");
const WORLDMONITOR_NATIVE_SIGNALS_PATH = path.join(RUNTIME_DIR, "worldmonitor-native-signals.json");
const RESTART_REASON_PATH = path.join(RUNTIME_DIR, "restart.reason");
const WHISPER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe.py");
const WHISPER_SERVER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe_server.py");
const AIDOLON_TTS_SERVER_SCRIPT_PATH = path.join(ROOT, "aidolon_tts_server.py");
const RESTART_EXIT_CODE = 75;

const {
  ensureDir,
  ensureDirSafe,
  loadEnv,
  writeJsonAtomic,
  readJson,
  toBool,
  toInt,
  toTimeoutMs,
  combineAbortSignals,
  minPositive,
  withPromiseTimeout,
  hardTimeoutRemainingMs,
  parseList,
  normalizeTelegramChatAction,
  normalizeSubredditName,
  parseArgString,
  sanitizeCodexExtraArgs,
  shQuote,
  resolveMaybeRelativePath: coreResolveMaybeRelativePath,
  sleep,
  computeExponentialBackoffMs,
  chunkText,
  appendTail,
  oneLine,
  detectTtsBackendFatalError,
  stripTtsBackendNoise,
  previewForLog,
} = require("./lib/core_utils");
const {
  NATURAL_COMMAND_ALIASES,
  NATURAL_NO_ARG_COMMANDS,
  NATURAL_PREFIX_REQUIRED_COMMANDS,
  NATURAL_DIRECT_COMMANDS,
} = require("./lib/natural_commands");
const { createStatePersister } = require("./lib/state_persistence");
const { createOrchQueueRuntime } = require("./lib/orch_queue_runtime");
const { createOrchLaneRuntime } = require("./lib/orch_lane_runtime");
const { createOrchRouterRuntime } = require("./lib/orch_router_runtime");
const { createOrchReplyContextRuntime } = require("./lib/orch_reply_context_runtime");
const { createOrchTaskRuntime } = require("./lib/orch_task_runtime");
const { createOrchWorkerRuntime } = require("./lib/orch_worker_runtime");
const { createOrchLaneRegistryRuntime } = require("./lib/orch_lane_registry_runtime");
const { createTelegramRouteMetaRuntime } = require("./lib/telegram_route_meta_runtime");
const { createParsedCommandRouter } = require("./lib/command_handlers");
const { createWorldMonitorPipelineRuntime } = require("./lib/worldmonitor/pipeline_runtime");
const {
  WORLDMONITOR_NATIVE_SEVERITY_DIRECT_TAGS,
  WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_TAGS,
  WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_ATTRS,
  WORLDMONITOR_TAIWAN_KEYWORDS,
  WORLDMONITOR_COUNTRY_PATTERNS,
  WORLDMONITOR_MARKET_SYMBOLS,
  WORLDMONITOR_NATIVE_ADSB_REGION,
  WORLDMONITOR_NATIVE_ADSB_THEATERS,
  WORLDMONITOR_MILITARY_CALLSIGN_PREFIXES,
  WORLDMONITOR_COMMERCIAL_CALLSIGN_PREFIXES,
  WORLDMONITOR_NATIVE_SERVICE_SOURCES,
  WORLDMONITOR_NATIVE_MACRO_SYMBOLS,
  WORLDMONITOR_NATIVE_PREDICTION_TAIWAN_PATTERN,
  WORLDMONITOR_NATIVE_MARITIME_REGION_PATTERNS,
} = require("./lib/worldmonitor/constants");

function resolveMaybeRelativePath(value, baseDir = ROOT) {
  return coreResolveMaybeRelativePath(value, baseDir);
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

const chatLogPendingLines = [];
let chatLogFlushTimer = null;
let chatLogFlushInFlight = false;

function scheduleChatLogFlush(delayMs = CHAT_LOG_FLUSH_INTERVAL_MS) {
  if (chatLogFlushTimer) return;
  const waitMs = Math.max(0, Number(delayMs) || 0);
  chatLogFlushTimer = setTimeout(() => {
    chatLogFlushTimer = null;
    flushChatLogBufferAsync();
  }, waitMs);
}

function flushChatLogBufferAsync() {
  if (!CHAT_LOG_TO_FILE) return;
  if (chatLogFlushInFlight) return;
  if (chatLogPendingLines.length <= 0) return;

  const payload = chatLogPendingLines.splice(0, chatLogPendingLines.length).join("");
  chatLogFlushInFlight = true;
  fs.appendFile(CHAT_LOG_PATH, payload, "utf8", () => {
    chatLogFlushInFlight = false;
    if (chatLogPendingLines.length > 0) {
      scheduleChatLogFlush(0);
    }
  });
}

function flushChatLogBufferSync() {
  if (chatLogFlushTimer) {
    clearTimeout(chatLogFlushTimer);
    chatLogFlushTimer = null;
  }
  if (chatLogPendingLines.length <= 0) return;
  const payload = chatLogPendingLines.splice(0, chatLogPendingLines.length).join("");
  try {
    fs.appendFileSync(CHAT_LOG_PATH, payload, "utf8");
  } catch {
    // best effort
  }
}

function enqueueChatLogLine(line) {
  if (!CHAT_LOG_TO_FILE) return;
  chatLogPendingLines.push(`${line}\n`);
  if (chatLogPendingLines.length >= CHAT_LOG_BUFFER_MAX_LINES) {
    if (chatLogFlushTimer) {
      clearTimeout(chatLogFlushTimer);
      chatLogFlushTimer = null;
    }
    flushChatLogBufferAsync();
    return;
  }
  scheduleChatLogFlush(CHAT_LOG_FLUSH_INTERVAL_MS);
}

const CHAT_WORKER_STRONG_COLORS = Object.freeze([
  "\x1b[32m", // green
  "\x1b[36m", // cyan
  "\x1b[34m", // blue
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
]);

function logChat(direction, chatId, text, meta = {}) {
  const source = String(meta.source || "").trim() || "message";
  const user = String(meta.user || "").trim() || "-";
  const workerId = String(meta.routeWorkerId || meta.workerId || "").trim();
  const preview = previewForLog(text, CHAT_LOG_MAX_CHARS);

  if (CHAT_LOG_TO_TERMINAL) {
    const dir = String(direction || "").trim().toLowerCase();
    const isIn = dir === "in";
    const isOut = dir === "out";

    const who = isIn && user && user !== "-" ? ` ${user}` : "";
    const workerTag = isOut && workerId ? ` [${workerId}]` : "";
    const src = isIn && source && !["plain", "message"].includes(source) ? ` (${source})` : "";
    const label = isIn ? "YOU" : isOut ? "BOT" : dir.toUpperCase() || "CHAT";
    const line = `${label}${workerTag}${who}${src}: ${preview}`;

    const noColor = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
    const useColors = !noColor && TERMINAL_COLORS && CHAT_LOG_USE_COLORS && Boolean(process.stdout.isTTY);
    const workerColor = getWorkerTerminalColors(workerId).strong;
    const color = isIn
      ? "\x1b[36m"
      : isOut
        ? (workerColor || "\x1b[32m")
        : "\x1b[33m"; // cyan / worker palette (or green) / yellow
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
        `worker=${JSON.stringify(workerId || "-")}`,
        `source=${JSON.stringify(source)}`,
        `text=${JSON.stringify(String(text || ""))}`,
      ].join(" ");
      enqueueChatLogLine(line);
    } catch {
      // best effort
    }
  }
}

function normalizeLessonText(value, maxChars = ORCH_LESSON_MAX_TEXT_CHARS) {
  const text = oneLine(String(value || ""));
  if (!text) return "";
  const lim = Number(maxChars || 0);
  if (!Number.isFinite(lim) || lim <= 0 || text.length <= lim) return text;
  return `${text.slice(0, Math.max(1, lim - 3)).trimEnd()}...`;
}

function normalizeOrchLessonSignature(value) {
  const cleaned = normalizeLessonText(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120);
}

function normalizeOrchLessonEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signature = normalizeOrchLessonSignature(raw.signature || raw.key || "");
  const lesson = normalizeLessonText(raw.lesson || raw.prevention || "", ORCH_LESSON_MAX_TEXT_CHARS);
  if (!signature || !lesson) return null;

  const firstSeenRaw = Number(raw.firstSeenAt || raw.createdAt || 0);
  const lastSeenRaw = Number(raw.lastSeenAt || raw.updatedAt || firstSeenRaw || 0);
  const now = Date.now();
  const firstSeenAt = Number.isFinite(firstSeenRaw) && firstSeenRaw > 0 ? Math.trunc(firstSeenRaw) : now;
  const lastSeenAt = Number.isFinite(lastSeenRaw) && lastSeenRaw > 0 ? Math.trunc(lastSeenRaw) : firstSeenAt;
  const failCountRaw = Number(raw.failCount || 1);
  const failCount = Number.isFinite(failCountRaw) && failCountRaw > 0 ? Math.min(9999, Math.trunc(failCountRaw)) : 1;

  return {
    signature,
    lesson,
    trigger: normalizeLessonText(raw.trigger || "", 160),
    category: normalizeLessonText(raw.category || "runtime", 32).toLowerCase() || "runtime",
    source: normalizeLessonText(raw.source || "", 40).toLowerCase(),
    chatId: normalizeLessonText(raw.chatId || "", 80),
    workerId: normalizeLessonText(raw.workerId || "", 80),
    workdirKey: normalizeLessonText(raw.workdirKey || "", 260).toLowerCase(),
    failCount,
    firstSeenAt,
    lastSeenAt,
    lastError: normalizeLessonText(raw.lastError || "", ORCH_LESSON_MAX_TEXT_CHARS),
  };
}

function makeOrchLessonDedupeKey(entry) {
  const worker = String(entry?.workerId || "").trim();
  const workdir = String(entry?.workdirKey || "").trim().toLowerCase();
  const sig = String(entry?.signature || "").trim();
  return `${workdir}\u0000${worker}\u0000${sig}`;
}

function normalizeOrchLessons(rawValue) {
  const rows = Array.isArray(rawValue) ? rawValue : [];
  const merged = new Map();

  for (const raw of rows) {
    const lesson = normalizeOrchLessonEntry(raw);
    if (!lesson) continue;
    const key = makeOrchLessonDedupeKey(lesson);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, lesson);
      continue;
    }

    prev.failCount = Math.min(9999, Number(prev.failCount || 0) + Number(lesson.failCount || 0));
    if (Number(lesson.firstSeenAt || 0) > 0 && Number(lesson.firstSeenAt || 0) < Number(prev.firstSeenAt || 0)) {
      prev.firstSeenAt = lesson.firstSeenAt;
    }
    if (Number(lesson.lastSeenAt || 0) >= Number(prev.lastSeenAt || 0)) {
      prev.lastSeenAt = lesson.lastSeenAt;
      if (lesson.lesson) prev.lesson = lesson.lesson;
      if (lesson.trigger) prev.trigger = lesson.trigger;
      if (lesson.category) prev.category = lesson.category;
      if (lesson.source) prev.source = lesson.source;
      if (lesson.lastError) prev.lastError = lesson.lastError;
      if (lesson.chatId) prev.chatId = lesson.chatId;
      if (lesson.workerId) prev.workerId = lesson.workerId;
      if (lesson.workdirKey) prev.workdirKey = lesson.workdirKey;
    }
  }

  const ttlMs = Math.max(1, ORCH_LESSON_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  const out = [...merged.values()]
    .filter((entry) => Number(entry.lastSeenAt || 0) >= cutoff)
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));

  if (ORCH_LESSONS_MAX_ITEMS > 0 && out.length > ORCH_LESSONS_MAX_ITEMS) {
    return out.slice(0, ORCH_LESSONS_MAX_ITEMS);
  }
  return out;
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

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
});

const SOURCE_FALLBACK_COLORS = Object.freeze([
  ANSI.cyan,
  ANSI.brightCyan,
  ANSI.blue,
  ANSI.brightBlue,
  ANSI.magenta,
  ANSI.brightMagenta,
  ANSI.brightGreen,
  ANSI.yellow,
]);

function hasAnsi(text) {
  return /\x1b\[[0-9;]*m/.test(String(text || ""));
}

function useTerminalColorsForLogs() {
  const noColor = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  return !noColor && TERMINAL_COLORS && Boolean(process.stdout.isTTY);
}

function useWorkerStreamColors() {
  return useTerminalColorsForLogs() && CHAT_LOG_USE_COLORS;
}

function paint(text, color) {
  return `${color}${text}${ANSI.reset}`;
}

function hashText(text) {
  const s = String(text || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function toBrightAnsiColor(color) {
  const c = String(color || "");
  const m = c.match(/\x1b\[(3[0-7]|9[0-7])m/);
  if (!m) return c;
  const code = Number(m[1]);
  if (code >= 90 && code <= 97) return c;
  return c.replace(/\x1b\[3([0-7])m/, "\x1b[9$1m");
}

function getWorkerTerminalColors(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return { strong: "", light: "" };
  const strong = CHAT_WORKER_STRONG_COLORS[hashText(wid) % CHAT_WORKER_STRONG_COLORS.length] || "";
  if (!strong) return { strong: "", light: "" };
  return { strong, light: `${ANSI.dim}${toBrightAnsiColor(strong)}` };
}

function writeWorkerStreamChunk(chunk, { workerId = "", stream = "stdout" } = {}) {
  const text = String(chunk || "");
  if (!text) return;
  const out = String(stream || "").toLowerCase() === "stderr" ? process.stderr : process.stdout;
  if (!useWorkerStreamColors() || hasAnsi(text)) {
    out.write(text);
    return;
  }
  const color = getWorkerTerminalColors(workerId).light;
  if (!color) {
    out.write(text);
    return;
  }
  out.write(`${color}${text}${ANSI.reset}`);
}

function detectSeverityTag(source, rest) {
  const src = String(source || "").trim().toLowerCase();
  const body = String(rest || "").trim().toLowerCase();
  if (!body) return "neutral";
  if (src === "fatal") return "error";
  if (/\b(fatal|error|failed|exception|traceback|timeout|rejected|crash|denied)\b/i.test(body)) return "error";
  if (/\b(warn|warning|fallback|retry|blocked|unavailable|degrad|stale)\b/i.test(body)) return "warn";
  if (/\b(ready|started|completed|success|succeeded|connected|healthy|ok)\b/i.test(body)) return "ok";
  return "neutral";
}

function getSourceColor(source) {
  const s = String(source || "").trim().toLowerCase();
  if (!s) return ANSI.cyan;
  if (["fatal"].includes(s)) return ANSI.brightRed;
  if (["error"].includes(s)) return ANSI.red;
  if (["warning", "warn"].includes(s)) return ANSI.yellow;
  if (["bot-text", "telegram-send", "telegram-document", "worldmonitor"].includes(s)) return ANSI.brightGreen;
  if (["bot-voice", "telegram-voice", "tts"].includes(s)) return ANSI.brightMagenta;
  if (["telegram-photo", "whisper"].includes(s)) return ANSI.brightBlue;
  if (["startup", "shutdown", "restart"].includes(s)) return ANSI.brightYellow;
  if (["orch", "enqueue", "run"].includes(s)) return ANSI.cyan;
  const idx = hashText(s) % SOURCE_FALLBACK_COLORS.length;
  return SOURCE_FALLBACK_COLORS[idx];
}

function formatLogMessageForTerminal(rawMessage) {
  const msg = String(rawMessage || "");
  if (!useTerminalColorsForLogs() || !msg || hasAnsi(msg)) return msg;
  const m = msg.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) {
    const sev = detectSeverityTag("", msg);
    if (sev === "error") return paint(msg, ANSI.red);
    if (sev === "warn") return paint(msg, ANSI.yellow);
    return msg;
  }
  const source = m[1];
  const rest = m[2];
  const sourceColor = getSourceColor(source);
  const sev = detectSeverityTag(source, rest);
  let restOut = rest;
  if (sev === "error") restOut = paint(rest, ANSI.red);
  else if (sev === "warn") restOut = paint(rest, ANSI.yellow);
  else if (sev === "ok") restOut = paint(rest, ANSI.brightGreen);
  return `${paint(`[${source}]`, sourceColor)}${rest ? ` ${restOut}` : ""}`;
}

function log(msg) {
  const ts = `[${nowIso()}]`;
  if (useTerminalColorsForLogs()) {
    console.log(`${paint(ts, ANSI.dim)} ${formatLogMessageForTerminal(msg)}`);
    return;
  }
  console.log(`${ts} ${msg}`);
}

function normalizeDnsResultOrder(rawValue) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return process.platform === "win32" ? "ipv4first" : "";
  }
  if (["off", "none", "disabled", "0", "false", "no"].includes(raw)) return "";
  if (["ipv4first", "ipv6first", "verbatim"].includes(raw)) return raw;
  return "";
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
const TELEGRAM_DNS_RESULT_ORDER = normalizeDnsResultOrder(process.env.TELEGRAM_DNS_RESULT_ORDER || "auto");
const TELEGRAM_STARTUP_MAX_ATTEMPTS = toInt(process.env.TELEGRAM_STARTUP_MAX_ATTEMPTS, 8, 1, 120);
const TELEGRAM_STARTUP_RETRY_BASE_MS = toInt(process.env.TELEGRAM_STARTUP_RETRY_BASE_MS, 1500, 100, 120_000);
const TELEGRAM_STARTUP_RETRY_MAX_MS = toInt(process.env.TELEGRAM_STARTUP_RETRY_MAX_MS, 15_000, 500, 180_000);
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
const BOT_REQUIRE_TTY = toBool(process.env.BOT_REQUIRE_TTY, true);
const BOT_EXIT_ON_SIGHUP = toBool(process.env.BOT_EXIT_ON_SIGHUP, process.platform !== "win32");
const CHAT_LOG_TO_TERMINAL = toBool(process.env.CHAT_LOG_TO_TERMINAL, true);
const CHAT_LOG_TO_FILE = toBool(process.env.CHAT_LOG_TO_FILE, true);
const TERMINAL_COLORS = toBool(process.env.TERMINAL_COLORS, true);
const CHAT_LOG_USE_COLORS = toBool(process.env.CHAT_LOG_USE_COLORS, true);
const CHAT_LOG_MAX_CHARS = toInt(process.env.CHAT_LOG_MAX_CHARS, 700);
const CHAT_LOG_FLUSH_INTERVAL_MS = toInt(process.env.CHAT_LOG_FLUSH_INTERVAL_MS, 400, 50, 10_000);
const CHAT_LOG_BUFFER_MAX_LINES = toInt(process.env.CHAT_LOG_BUFFER_MAX_LINES, 120, 10, 10_000);
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
function normalizeCodexModelName(value) {
  const model = String(value || "").trim();
  if (!model) return "";
  if (model.toLowerCase() === "gpt-5.4-codex") return "gpt-5.4";
  return model;
}

const CODEX_MODEL = normalizeCodexModelName(process.env.CODEX_MODEL || "gpt-5.4");
const CODEX_MODEL_CHOICES = parseList(process.env.CODEX_MODEL_CHOICES || "")
  .map((model) => normalizeCodexModelName(model))
  .filter(Boolean);
const CODEX_REASONING_EFFORT = String(process.env.CODEX_REASONING_EFFORT || "xhigh").trim();
const CODEX_REASONING_EFFORT_CHOICES = parseList(process.env.CODEX_REASONING_EFFORT_CHOICES || "");
const CODEX_DEFAULT_MODEL_CHOICES = Object.freeze([
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
]);
const CODEX_REASONING_EFFORTS_BY_MODEL = Object.freeze({
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.2-codex": ["low", "medium", "high"],
  "gpt-5.1-codex": ["low", "medium", "high"],
});
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
// 0 = always use pipelined mode; larger values switch long replies to all-at-once keepalive batch synthesis.
const TTS_BATCH_PIPELINED_MAX_CHUNKS = toInt(process.env.TTS_BATCH_PIPELINED_MAX_CHUNKS, 2, 0, 1000);
const TTS_RETRY_BASE_DELAY_MS = toInt(process.env.TTS_RETRY_BASE_DELAY_MS, 300, 50, 30_000);
const TTS_RETRY_MAX_DELAY_MS = toInt(process.env.TTS_RETRY_MAX_DELAY_MS, 4000, 100, 120_000);
const KEEPALIVE_RESTART_BASE_DELAY_MS = toInt(process.env.KEEPALIVE_RESTART_BASE_DELAY_MS, 1500, 200, 120_000);
const KEEPALIVE_RESTART_MAX_DELAY_MS = toInt(process.env.KEEPALIVE_RESTART_MAX_DELAY_MS, 30_000, 1000, 300_000);
const TTS_VENV_PATH = resolveMaybeRelativePath(process.env.TTS_VENV_PATH || path.join(ROOT, ".tts-venv"));
const TTS_MODEL = String(process.env.TTS_MODEL || "").trim();
const TTS_REFERENCE_AUDIO = resolveMaybeRelativePath(process.env.TTS_REFERENCE_AUDIO || "");
const TTS_REFERENCE_AUDIO_ZH_TW = resolveMaybeRelativePath(process.env.TTS_REFERENCE_AUDIO_ZH_TW || "");
const TTS_SAMPLE_RATE = toInt(process.env.TTS_SAMPLE_RATE, 48000);
const TTS_PYTHON = String(process.env.TTS_PYTHON || "").trim();
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
const TTS_STARSHIP_BEEP_START = resolveMaybeRelativePath(
  process.env.TTS_STARSHIP_BEEP_START || path.join("resources", "tts", "a11-comms-start.wav"),
);
const TTS_STARSHIP_BEEP_END = resolveMaybeRelativePath(
  process.env.TTS_STARSHIP_BEEP_END || path.join("resources", "tts", "a11-comms-end.wav"),
);
const TTS_POSTPROCESS_DEBUG = toBool(process.env.TTS_POSTPROCESS_DEBUG, false);
const TTS_WORKER_PRESET_MAP_RAW = String(process.env.TTS_WORKER_PRESET_MAP || "").trim();

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
const STATE_WRITE_DEBOUNCE_MS = toInt(process.env.STATE_WRITE_DEBOUNCE_MS, 250, 0, 10_000);
const STATE_WRITE_MAX_DELAY_MS = toInt(process.env.STATE_WRITE_MAX_DELAY_MS, 2000, 100, 60_000);
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
const ORCH_LESSONS_ENABLED = toBool(process.env.ORCH_LESSONS_ENABLED, true);
const ORCH_LESSONS_MAX_ITEMS = toInt(process.env.ORCH_LESSONS_MAX_ITEMS, 240, 20, 2000);
const ORCH_LESSONS_PER_PROMPT = toInt(process.env.ORCH_LESSONS_PER_PROMPT, 4, 0, 12);
const ORCH_LESSONS_PROMPT_MAX_CHARS = toInt(process.env.ORCH_LESSONS_PROMPT_MAX_CHARS, 1200, 180, 6000);
const ORCH_LESSON_MAX_TEXT_CHARS = toInt(process.env.ORCH_LESSON_MAX_TEXT_CHARS, 220, 80, 1000);
const ORCH_LESSON_TTL_DAYS = toInt(process.env.ORCH_LESSON_TTL_DAYS, 45, 1, 365);
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
const WORLDMONITOR_MONITOR_ENABLED = toBool(process.env.WORLDMONITOR_MONITOR_ENABLED, false);
const WORLDMONITOR_NATIVE_FEEDS_PATH = resolveMaybeRelativePath(
  process.env.WORLDMONITOR_NATIVE_FEEDS_PATH || path.join(ROOT, "worldmonitor_native_feeds.json"),
);
const WORLDMONITOR_MONITOR_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_MONITOR_INTERVAL_SEC, 300, 30, 3600);
const WORLDMONITOR_INTERVAL_ALERT_MODE = (() => {
  const raw = String(process.env.WORLDMONITOR_INTERVAL_ALERT_MODE || "smart").trim().toLowerCase();
  if (raw === "smart" || raw === "hybrid" || raw === "mixed") return "smart";
  if (raw === "report" || raw === "summary") return "report";
  if (raw === "off" || raw === "none" || raw === "disabled" || raw === "silent") return "off";
  return "headlines";
})();
const WORLDMONITOR_STARTUP_DELAY_SEC = toInt(process.env.WORLDMONITOR_STARTUP_DELAY_SEC, 25, 0, 600);
const WORLDMONITOR_NATIVE_FEED_TIMEOUT_MS = toTimeoutMs(process.env.WORLDMONITOR_NATIVE_FEED_TIMEOUT_MS, 9_000, 0, MAX_TIMEOUT_MS);
const WORLDMONITOR_NATIVE_FEED_FETCH_CONCURRENCY = toInt(process.env.WORLDMONITOR_NATIVE_FEED_FETCH_CONCURRENCY, 10, 2, 40);
const WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE = toInt(process.env.WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE, 24, 4, 120);
const WORLDMONITOR_NATIVE_STORE_MAX_ITEMS = toInt(process.env.WORLDMONITOR_NATIVE_STORE_MAX_ITEMS, 16_000, 500, 100_000);
const WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS = toInt(process.env.WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS, 30, 2, 365);
const WORLDMONITOR_NATIVE_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_REFRESH_MIN_INTERVAL_SEC, 240, 30, 3600);
const WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS = toTimeoutMs(
  process.env.WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS,
  180_000,
  0,
  MAX_TIMEOUT_MS,
);
const WORLDMONITOR_NEWS_LIST_MAX_ITEMS = toInt(process.env.WORLDMONITOR_NEWS_LIST_MAX_ITEMS, 50, 1, 200);
const WORLDMONITOR_NEWS_LIST_REFRESH_STALE_SEC = toInt(process.env.WORLDMONITOR_NEWS_LIST_REFRESH_STALE_SEC, 180, 0, 3600);
const WORLDMONITOR_TRANSLATE_HEADLINES_TO_EN = toBool(
  process.env.WORLDMONITOR_TRANSLATE_HEADLINES_TO_EN,
  true,
);
const WORLDMONITOR_TRANSLATE_HEADLINES_TIMEOUT_MS = toTimeoutMs(
  process.env.WORLDMONITOR_TRANSLATE_HEADLINES_TIMEOUT_MS,
  4000,
  0,
  MAX_TIMEOUT_MS,
);
const WORLDMONITOR_TRANSLATE_HEADLINES_CONCURRENCY = toInt(
  process.env.WORLDMONITOR_TRANSLATE_HEADLINES_CONCURRENCY,
  4,
  1,
  12,
);
const WORLDMONITOR_TRANSLATE_HEADLINES_CACHE_SIZE = toInt(
  process.env.WORLDMONITOR_TRANSLATE_HEADLINES_CACHE_SIZE,
  5000,
  200,
  100000,
);
const WORLDMONITOR_BLOCKED_OUTLET_NAMES = parseList(
  process.env.WORLDMONITOR_BLOCKED_OUTLETS || "Bild,Blick,The Telegraph,Fox News",
)
  .map((x) => String(x || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
  .filter(Boolean);
const WORLDMONITOR_BLOCKED_OUTLET_NAME_SET = new Set(WORLDMONITOR_BLOCKED_OUTLET_NAMES);
const WORLDMONITOR_BLOCKED_OUTLET_DOMAINS = parseList(
  process.env.WORLDMONITOR_BLOCKED_OUTLET_DOMAINS || "bild.de,blick.ch,telegraph.co.uk,foxnews.com",
)
  .map((x) => String(x || "").trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "").replace(/^www\./, ""))
  .filter(Boolean);
const WORLDMONITOR_BLOCKED_OUTLET_DOMAIN_SET = new Set(WORLDMONITOR_BLOCKED_OUTLET_DOMAINS);
const WORLDMONITOR_NATIVE_SIGNAL_TIMEOUT_MS = toTimeoutMs(process.env.WORLDMONITOR_NATIVE_SIGNAL_TIMEOUT_MS, 10_000, 0, MAX_TIMEOUT_MS);
const WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS = toInt(process.env.WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS, 90, 7, 365);
const WORLDMONITOR_NATIVE_SIGNALS_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_SIGNALS_REFRESH_MIN_INTERVAL_SEC, 300, 60, 3600);
const WORLDMONITOR_NATIVE_SEISMIC_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_SEISMIC_REFRESH_MIN_INTERVAL_SEC, 900, 120, 7200);
const WORLDMONITOR_NATIVE_ADSB_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_ADSB_REFRESH_MIN_INTERVAL_SEC, 600, 120, 7200);
const WORLDMONITOR_NATIVE_DISASTER_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_DISASTER_REFRESH_MIN_INTERVAL_SEC, 1800, 300, 21600);
const WORLDMONITOR_NATIVE_MARITIME_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_MARITIME_REFRESH_MIN_INTERVAL_SEC, 1800, 300, 21600);
const WORLDMONITOR_NATIVE_SERVICE_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_SERVICE_REFRESH_MIN_INTERVAL_SEC, 1800, 300, 21600);
const WORLDMONITOR_NATIVE_MACRO_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_MACRO_REFRESH_MIN_INTERVAL_SEC, 900, 180, 7200);
const WORLDMONITOR_NATIVE_PREDICTION_REFRESH_MIN_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_NATIVE_PREDICTION_REFRESH_MIN_INTERVAL_SEC, 1200, 180, 7200);
const WORLDMONITOR_DEEP_INGEST_ENABLED = toBool(process.env.WORLDMONITOR_DEEP_INGEST_ENABLED, true);
const WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS = toTimeoutMs(process.env.WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS, 15_000, 0, MAX_TIMEOUT_MS);
const WORLDMONITOR_DEEP_INGEST_CONCURRENCY = toInt(process.env.WORLDMONITOR_DEEP_INGEST_CONCURRENCY, 3, 1, 24);
const WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS = toTimeoutMs(
  process.env.WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS,
  45_000,
  0,
  MAX_TIMEOUT_MS,
);
const WORLDMONITOR_DEEP_INGEST_RETRY_COOLDOWN_SEC = toInt(process.env.WORLDMONITOR_DEEP_INGEST_RETRY_COOLDOWN_SEC, 43_200, 60, 604_800);
const WORLDMONITOR_DEEP_INGEST_MAX_TEXT_CHARS = toInt(process.env.WORLDMONITOR_DEEP_INGEST_MAX_TEXT_CHARS, 18_000, 1_200, 120_000);
const WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS = toInt(process.env.WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS, 140, 40, 500);
const WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_CHARS = toInt(process.env.WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_CHARS, 900, 180, 5000);
const WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE_RAW = Number(process.env.WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE);
const WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE = Number.isFinite(WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE_RAW)
  ? Math.max(0, Math.trunc(WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE_RAW))
  : 0;
const WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE = toInt(
  process.env.WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE,
  12,
  0,
  200,
);
const WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS_RAW = Number(process.env.WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS);
const WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS = Number.isFinite(WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS_RAW)
  ? Math.max(0, Math.trunc(WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS_RAW))
  : 0;
const WORLDMONITOR_ALERT_COOLDOWN_SEC = toInt(process.env.WORLDMONITOR_ALERT_COOLDOWN_SEC, 300, 30, 86400);
const WORLDMONITOR_MIN_GLOBAL_RISK_SCORE = toInt(process.env.WORLDMONITOR_MIN_GLOBAL_RISK_SCORE, 60, 0, 100);
const WORLDMONITOR_MIN_COUNTRY_RISK_SCORE = toInt(process.env.WORLDMONITOR_MIN_COUNTRY_RISK_SCORE, 75, 0, 100);
const WORLDMONITOR_MIN_GLOBAL_DELTA = toInt(process.env.WORLDMONITOR_MIN_GLOBAL_DELTA, 12, 1, 100);
const WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY = toInt(
  process.env.WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY,
  1,
  0,
  12,
);
const WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY_RAW = Number(process.env.WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY);
// 0 means unlimited reports per day.
const WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY = Number.isFinite(WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY_RAW)
  ? Math.max(0, Math.trunc(WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY_RAW))
  : 0;
const WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC_RAW = Number(process.env.WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC);
// 0 disables spacing between interval reports.
const WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC = Number.isFinite(WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC_RAW)
  ? Math.max(0, Math.min(24 * 60 * 60, Math.trunc(WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC_RAW)))
  : 0;
const WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA = toInt(
  process.env.WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA,
  WORLDMONITOR_MIN_GLOBAL_DELTA,
  1,
  100,
);
const WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL = String(
  process.env.WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL || "critical",
).trim().toLowerCase() || "critical";
const WORLDMONITOR_TOP_COUNTRIES = toInt(process.env.WORLDMONITOR_TOP_COUNTRIES, 5, 1, 12);
const WORLDMONITOR_ALERT_CHAT_ID = String(process.env.WORLDMONITOR_ALERT_CHAT_ID || PRIMARY_CHAT_ID).trim() || PRIMARY_CHAT_ID;
const WORLDMONITOR_WORKDIR = resolveMaybeRelativePath(process.env.WORLDMONITOR_WORKDIR || "");
const WORLDMONITOR_WORKER_TITLE = String(process.env.WORLDMONITOR_WORKER_TITLE || "WorldMonitor Intel").trim() || "WorldMonitor Intel";
const WORLDMONITOR_SUMMARY_MODEL = String(process.env.WORLDMONITOR_SUMMARY_MODEL || "").trim();
const WORLDMONITOR_SUMMARY_REASONING = String(process.env.WORLDMONITOR_SUMMARY_REASONING || "low").trim();
const WORLDMONITOR_NOTIFY_ERRORS = toBool(process.env.WORLDMONITOR_NOTIFY_ERRORS, false);
const WORLDMONITOR_ALERT_VOICE_ENABLED = toBool(process.env.WORLDMONITOR_ALERT_VOICE_ENABLED, true);
// 0 disables WorldMonitor alert pre-truncation before TTS chunking.
const WORLDMONITOR_ALERT_VOICE_MAX_CHARS = toInt(process.env.WORLDMONITOR_ALERT_VOICE_MAX_CHARS, 0, 0, 4000);
const WORLDMONITOR_FEED_ALERTS_ENABLED = toBool(process.env.WORLDMONITOR_FEED_ALERTS_ENABLED, true);
const WORLDMONITOR_FEED_ALERTS_MIN_LEVEL = String(
  process.env.WORLDMONITOR_FEED_ALERTS_MIN_LEVEL || "critical",
).trim().toLowerCase() || "critical";
const WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC = toInt(process.env.WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC, 300, 15, 3600);
const WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE = toInt(process.env.WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE, 20, 1, 200);
const WORLDMONITOR_FEED_ALERTS_CHAT_ID = String(
  process.env.WORLDMONITOR_FEED_ALERTS_CHAT_ID || WORLDMONITOR_ALERT_CHAT_ID,
).trim() || WORLDMONITOR_ALERT_CHAT_ID;
const WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS = toInt(
  process.env.WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS,
  6,
  6,
  24 * 30,
);
const WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP = toInt(
  process.env.WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP,
  5000,
  500,
  100000,
);
const WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS = toBool(
  process.env.WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS,
  true,
);
const WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS = toBool(
  process.env.WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS,
  true,
);
const WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY = toBool(
  process.env.WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY,
  true,
);
const WORLDMONITOR_CHECK_LOOKBACK_HOURS = toInt(process.env.WORLDMONITOR_CHECK_LOOKBACK_HOURS, 72, 6, 168);
const WORLDMONITOR_CHECK_MAX_HEADLINES = toInt(process.env.WORLDMONITOR_CHECK_MAX_HEADLINES, 16, 4, 60);
const WORLDMONITOR_CHECK_FETCH_TIMEOUT_MS = toTimeoutMs(
  process.env.WORLDMONITOR_CHECK_FETCH_TIMEOUT_MS,
  180_000,
  0,
  MAX_TIMEOUT_MS,
);
const WORLDMONITOR_STARTUP_CATCHUP_ENABLED = toBool(process.env.WORLDMONITOR_STARTUP_CATCHUP_ENABLED, true);
const WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE = toInt(
  process.env.WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE,
  Math.max(WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE, 72),
  WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE,
  240,
);
const WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS = toInt(
  process.env.WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS,
  WORLDMONITOR_CHECK_LOOKBACK_HOURS,
  6,
  24 * 30,
);
const WORLDMONITOR_CHECK_TAIWAN_COUNTRY_CODE = String(
  process.env.WORLDMONITOR_CHECK_TAIWAN_COUNTRY_CODE || "TW",
).trim().toUpperCase() || "TW";
const WORLDMONITOR_CHECK_ANNOUNCE_QUEUED = toBool(process.env.WORLDMONITOR_CHECK_ANNOUNCE_QUEUED, false);
const WORLDMONITOR_CHECK_VOICE_ENABLED = toBool(process.env.WORLDMONITOR_CHECK_VOICE_ENABLED, true);
// 0 disables WorldMonitor check pre-truncation before TTS chunking.
const WORLDMONITOR_CHECK_VOICE_MAX_CHARS = toInt(process.env.WORLDMONITOR_CHECK_VOICE_MAX_CHARS, 0, 0, 1200);
const WEATHER_DAILY_ENABLED = toBool(process.env.WEATHER_DAILY_ENABLED, true);
const WEATHER_DAILY_CHAT_ID = String(process.env.WEATHER_DAILY_CHAT_ID || PRIMARY_CHAT_ID).trim() || PRIMARY_CHAT_ID;
const WEATHER_DAILY_HOUR = toInt(process.env.WEATHER_DAILY_HOUR, 6, 0, 23);
const WEATHER_DAILY_MINUTE = toInt(process.env.WEATHER_DAILY_MINUTE, 0, 0, 59);
const WEATHER_DAILY_TIMEZONE = "Asia/Taipei";
const WEATHER_DAILY_LOCATION_NAME = String(process.env.WEATHER_DAILY_LOCATION_NAME || "").trim();
const WEATHER_DAILY_LAT_RAW = Number(process.env.WEATHER_DAILY_LAT);
const WEATHER_DAILY_LON_RAW = Number(process.env.WEATHER_DAILY_LON);
const WEATHER_DAILY_LAT = Number.isFinite(WEATHER_DAILY_LAT_RAW) ? WEATHER_DAILY_LAT_RAW : null;
const WEATHER_DAILY_LON = Number.isFinite(WEATHER_DAILY_LON_RAW) ? WEATHER_DAILY_LON_RAW : null;
const WEATHER_DAILY_VOICE_ENABLED = toBool(process.env.WEATHER_DAILY_VOICE_ENABLED, true);
const WEATHER_DAILY_NOTIFY_ERRORS = toBool(process.env.WEATHER_DAILY_NOTIFY_ERRORS, true);
const WEATHER_FORECAST_TIMEOUT_MS = toTimeoutMs(process.env.WEATHER_FORECAST_TIMEOUT_MS, 12_000, 0, MAX_TIMEOUT_MS);
const WEATHER_GEOCODING_TIMEOUT_MS = toTimeoutMs(process.env.WEATHER_GEOCODING_TIMEOUT_MS, 10_000, 0, MAX_TIMEOUT_MS);
const NATURAL_NEWS_FOLLOWUP_TTL_MS = 5 * 60 * 1000;
const NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW = Number(process.env.NATURAL_SAFE_COMMAND_INTENT_THRESHOLD);
const NATURAL_SAFE_COMMAND_INTENT_THRESHOLD = Number.isFinite(NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW)
  ? Math.max(0, Math.min(1, NATURAL_SAFE_COMMAND_INTENT_THRESHOLD_RAW))
  : 0.84;
const REPLY_CONTEXT_MAX_CHARS = toInt(process.env.REPLY_CONTEXT_MAX_CHARS, 900, 120, 4000);
const ORCH_THREAD_CONTEXT_MAX_DEPTH = toInt(process.env.ORCH_THREAD_CONTEXT_MAX_DEPTH, 24, 1, 80);
const ORCH_THREAD_CONTEXT_MAX_CHARS = toInt(process.env.ORCH_THREAD_CONTEXT_MAX_CHARS, 6000, 400, 20000);
const ORCH_RECENT_CONTEXT_MESSAGES = toInt(process.env.ORCH_RECENT_CONTEXT_MESSAGES, 10, 0, 20);
const ORCH_RECENT_CONTEXT_MAX_CHARS = toInt(process.env.ORCH_RECENT_CONTEXT_MAX_CHARS, 2200, 300, 12000);
const ORCH_MESSAGE_META_MAX_PER_CHAT = toInt(process.env.ORCH_MESSAGE_META_MAX_PER_CHAT, 1400, 200, 5000);
const ORCH_MESSAGE_META_TTL_DAYS = toInt(process.env.ORCH_MESSAGE_META_TTL_DAYS, 30, 1, 180);
const ORCH_TASK_MAX_PER_CHAT = toInt(process.env.ORCH_TASK_MAX_PER_CHAT, 1200, 100, 5000);
const ORCH_TASK_TTL_DAYS = toInt(process.env.ORCH_TASK_TTL_DAYS, 30, 1, 180);
const REDDIT_USER_AGENT = String(
  process.env.REDDIT_USER_AGENT || "AIDOLON-Telegram-Bot/0.1 (+https://github.com/)",
).trim();

if (TELEGRAM_DNS_RESULT_ORDER) {
  try {
    dns.setDefaultResultOrder(TELEGRAM_DNS_RESULT_ORDER);
  } catch (err) {
    console.error(`[startup] Failed to set DNS result order (${TELEGRAM_DNS_RESULT_ORDER}): ${err?.message || err}`);
  }
}

if (!TOKEN || !PRIMARY_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

if (BOT_REQUIRE_TTY && !process.stdout?.isTTY && !process.stderr?.isTTY) {
  console.error("Refusing to start without an interactive terminal (BOT_REQUIRE_TTY=1).");
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
  chatAutomationPrefs: {},
  orchLessons: [],
  redditDigest: {},
  worldMonitorMonitor: {},
  weatherDaily: {},
  weatherLocationsByChat: {},
  orch: {},
});
const workflowCatalogState = readJson(WORKFLOW_CATALOG_PATH, {
  chatAutomationPrefs: {},
});
let lastUpdateId = Number(state.lastUpdateId || 0);
const lastImages = state && typeof state.lastImages === "object" && state.lastImages
  ? { ...state.lastImages }
  : {};
const chatPrefs = state && typeof state.chatPrefs === "object" && state.chatPrefs
  ? { ...state.chatPrefs }
  : {};
const chatAutomationPrefs = mergeChatAutomationPrefsByUpdatedAt(
  normalizeChatAutomationPrefs(state?.chatAutomationPrefs),
  normalizeChatAutomationPrefs(workflowCatalogState?.chatAutomationPrefs),
);
const redditDigest = state && typeof state.redditDigest === "object" && state.redditDigest
  ? { ...state.redditDigest }
  : {};
const orchLessons = normalizeOrchLessons(state?.orchLessons);
const worldMonitorMonitorRaw = state && typeof state.worldMonitorMonitor === "object" && state.worldMonitorMonitor
  ? state.worldMonitorMonitor
  : {};
const weatherDailyRaw = state && typeof state.weatherDaily === "object" && state.weatherDaily
  ? state.weatherDaily
  : {};
const weatherLocationsByChatRaw = state && typeof state.weatherLocationsByChat === "object" && state.weatherLocationsByChat
  ? state.weatherLocationsByChat
  : {};
const weatherLocationsByChat = {};
for (const [rawChatId, rawEntry] of Object.entries(weatherLocationsByChatRaw)) {
  const chatKey = String(rawChatId || "").trim();
  if (!chatKey || !rawEntry || typeof rawEntry !== "object") continue;
  const lat = Number(rawEntry.latitude);
  const lon = Number(rawEntry.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) continue;
  weatherLocationsByChat[chatKey] = {
    latitude: lat,
    longitude: lon,
    name: String(rawEntry.name || "").trim(),
    timezone: String(rawEntry.timezone || "").trim(),
    updatedAt: Number(rawEntry.updatedAt || 0) || 0,
  };
}
const worldMonitorMonitor = {
  workerId: String(worldMonitorMonitorRaw.workerId || "").trim(),
  lastRunAt: Number(worldMonitorMonitorRaw.lastRunAt || 0) || 0,
  lastRunSource: String(worldMonitorMonitorRaw.lastRunSource || "").trim(),
  lastErrorAt: Number(worldMonitorMonitorRaw.lastErrorAt || 0) || 0,
  lastError: String(worldMonitorMonitorRaw.lastError || "").trim(),
  lastAlertAt: Number(worldMonitorMonitorRaw.lastAlertAt || 0) || 0,
  lastAlertReason: String(worldMonitorMonitorRaw.lastAlertReason || "").trim(),
  lastAlertFingerprint: String(worldMonitorMonitorRaw.lastAlertFingerprint || "").trim(),
  lastObservedGlobalScore: Number(worldMonitorMonitorRaw.lastObservedGlobalScore || 0) || 0,
  lastObservedFingerprint: String(worldMonitorMonitorRaw.lastObservedFingerprint || "").trim(),
  lastSnapshotSummary: String(worldMonitorMonitorRaw.lastSnapshotSummary || "").trim(),
  intervalReportDayKey: isUtcDayKey(worldMonitorMonitorRaw.intervalReportDayKey)
    ? String(worldMonitorMonitorRaw.intervalReportDayKey || "").trim()
    : "",
  intervalReportCount: Math.max(0, Number(worldMonitorMonitorRaw.intervalReportCount || 0) || 0),
  intervalReportLastAt: Number(worldMonitorMonitorRaw.intervalReportLastAt || 0) || 0,
  intervalReportLastReason: String(worldMonitorMonitorRaw.intervalReportLastReason || "").trim(),
  lastNotifiedErrorAt: Number(worldMonitorMonitorRaw.lastNotifiedErrorAt || 0) || 0,
  feedAlertsLastRunAt: Number(worldMonitorMonitorRaw.feedAlertsLastRunAt || 0) || 0,
  feedAlertsLastSeenAt: Number(worldMonitorMonitorRaw.feedAlertsLastSeenAt || 0) || 0,
  feedAlertsLastErrorAt: Number(worldMonitorMonitorRaw.feedAlertsLastErrorAt || 0) || 0,
  feedAlertsLastError: String(worldMonitorMonitorRaw.feedAlertsLastError || "").trim(),
  feedAlertsSentKeys: Array.isArray(worldMonitorMonitorRaw.feedAlertsSentKeys)
    ? worldMonitorMonitorRaw.feedAlertsSentKeys
      .map((k) => String(k || "").trim())
      .filter(Boolean)
      .slice(-1200)
    : [],
  feedAlertsSentTitleKeys: Array.isArray(worldMonitorMonitorRaw.feedAlertsSentTitleKeys)
    ? worldMonitorMonitorRaw.feedAlertsSentTitleKeys
      .map((k) => String(k || "").trim())
      .filter(Boolean)
      .slice(-1200)
    : [],
  nativeLastRefreshAt: Number(worldMonitorMonitorRaw.nativeLastRefreshAt || 0) || 0,
  nativeLastRefreshDurationMs: Number(worldMonitorMonitorRaw.nativeLastRefreshDurationMs || 0) || 0,
  nativeLastRefreshErrorAt: Number(worldMonitorMonitorRaw.nativeLastRefreshErrorAt || 0) || 0,
  nativeLastRefreshError: String(worldMonitorMonitorRaw.nativeLastRefreshError || "").trim(),
  nativeLastRefreshStats: worldMonitorMonitorRaw.nativeLastRefreshStats
    && typeof worldMonitorMonitorRaw.nativeLastRefreshStats === "object"
    ? { ...worldMonitorMonitorRaw.nativeLastRefreshStats }
    : {},
  nativeSignalsLastRefreshAt: Number(worldMonitorMonitorRaw.nativeSignalsLastRefreshAt || 0) || 0,
  nativeSignalsLastRefreshDurationMs: Number(worldMonitorMonitorRaw.nativeSignalsLastRefreshDurationMs || 0) || 0,
  nativeSignalsLastRefreshErrorAt: Number(worldMonitorMonitorRaw.nativeSignalsLastRefreshErrorAt || 0) || 0,
  nativeSignalsLastRefreshError: String(worldMonitorMonitorRaw.nativeSignalsLastRefreshError || "").trim(),
  nativeSignalsLastRefreshStats: worldMonitorMonitorRaw.nativeSignalsLastRefreshStats
    && typeof worldMonitorMonitorRaw.nativeSignalsLastRefreshStats === "object"
    ? { ...worldMonitorMonitorRaw.nativeSignalsLastRefreshStats }
    : {},
  nativeDeepIngestLastRunAt: Number(worldMonitorMonitorRaw.nativeDeepIngestLastRunAt || 0) || 0,
  nativeDeepIngestLastDurationMs: Number(worldMonitorMonitorRaw.nativeDeepIngestLastDurationMs || 0) || 0,
  nativeDeepIngestLastErrorAt: Number(worldMonitorMonitorRaw.nativeDeepIngestLastErrorAt || 0) || 0,
  nativeDeepIngestLastError: String(worldMonitorMonitorRaw.nativeDeepIngestLastError || "").trim(),
  nativeDeepIngestLastStats: worldMonitorMonitorRaw.nativeDeepIngestLastStats
    && typeof worldMonitorMonitorRaw.nativeDeepIngestLastStats === "object"
    ? { ...worldMonitorMonitorRaw.nativeDeepIngestLastStats }
    : {},
  startupCatchupLastRunAt: Number(worldMonitorMonitorRaw.startupCatchupLastRunAt || 0) || 0,
  startupCatchupLastErrorAt: Number(worldMonitorMonitorRaw.startupCatchupLastErrorAt || 0) || 0,
  startupCatchupLastError: String(worldMonitorMonitorRaw.startupCatchupLastError || "").trim(),
  startupCatchupLastStats: worldMonitorMonitorRaw.startupCatchupLastStats
    && typeof worldMonitorMonitorRaw.startupCatchupLastStats === "object"
    ? { ...worldMonitorMonitorRaw.startupCatchupLastStats }
    : {},
};
const weatherDailyState = {
  lastRunAt: Number(weatherDailyRaw.lastRunAt || 0) || 0,
  lastSentAt: Number(weatherDailyRaw.lastSentAt || 0) || 0,
  lastSentDayKey: isUtcDayKey(weatherDailyRaw.lastSentDayKey)
    ? String(weatherDailyRaw.lastSentDayKey || "").trim()
    : "",
  lastErrorAt: Number(weatherDailyRaw.lastErrorAt || 0) || 0,
  lastError: String(weatherDailyRaw.lastError || "").trim(),
};
const worldMonitorFeedAlertSentKeySet = new Set(worldMonitorMonitor.feedAlertsSentKeys);
const worldMonitorFeedAlertSentTitleKeySet = new Set(worldMonitorMonitor.feedAlertsSentTitleKeys);
const worldMonitorNativeStoreRaw = readJson(WORLDMONITOR_NATIVE_STORE_PATH, { version: 1, items: [] });
const worldMonitorNativeNewsItems = Array.isArray(worldMonitorNativeStoreRaw?.items)
  ? worldMonitorNativeStoreRaw.items
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const next = { ...x };
      const source = String(next.threatLevelSource || "").trim().toLowerCase();
      if (source !== "native-feed-metadata") {
        next.threatLevel = "low";
        next.threatLevelSource = "native-feed-metadata";
        return next;
      }
      next.threatLevel = worldMonitorNormalizeNativeThreatLevel(next.threatLevel) || "low";
      next.threatLevelSource = "native-feed-metadata";
      return next;
    })
    .filter(Boolean)
    .filter((item) => !isWorldMonitorBlockedOutletItem(item))
    .slice(-WORLDMONITOR_NATIVE_STORE_MAX_ITEMS)
  : [];
const worldMonitorNativeSignalsRaw = readJson(WORLDMONITOR_NATIVE_SIGNALS_PATH, {
  version: 1,
  marketSeries: [],
  cryptoSeries: [],
  seismicSeries: [],
  infrastructureSeries: [],
  adsbSeries: [],
  disasterSeries: [],
  maritimeSeries: [],
  serviceSeries: [],
  macroSeries: [],
  predictionSeries: [],
});
const worldMonitorNativeSignals = {
  marketSeries: Array.isArray(worldMonitorNativeSignalsRaw?.marketSeries)
    ? worldMonitorNativeSignalsRaw.marketSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  cryptoSeries: Array.isArray(worldMonitorNativeSignalsRaw?.cryptoSeries)
    ? worldMonitorNativeSignalsRaw.cryptoSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  seismicSeries: Array.isArray(worldMonitorNativeSignalsRaw?.seismicSeries)
    ? worldMonitorNativeSignalsRaw.seismicSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  infrastructureSeries: Array.isArray(worldMonitorNativeSignalsRaw?.infrastructureSeries)
    ? worldMonitorNativeSignalsRaw.infrastructureSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  adsbSeries: Array.isArray(worldMonitorNativeSignalsRaw?.adsbSeries)
    ? worldMonitorNativeSignalsRaw.adsbSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  disasterSeries: Array.isArray(worldMonitorNativeSignalsRaw?.disasterSeries)
    ? worldMonitorNativeSignalsRaw.disasterSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  maritimeSeries: Array.isArray(worldMonitorNativeSignalsRaw?.maritimeSeries)
    ? worldMonitorNativeSignalsRaw.maritimeSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  serviceSeries: Array.isArray(worldMonitorNativeSignalsRaw?.serviceSeries)
    ? worldMonitorNativeSignalsRaw.serviceSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  macroSeries: Array.isArray(worldMonitorNativeSignalsRaw?.macroSeries)
    ? worldMonitorNativeSignalsRaw.macroSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
  predictionSeries: Array.isArray(worldMonitorNativeSignalsRaw?.predictionSeries)
    ? worldMonitorNativeSignalsRaw.predictionSeries
      .map((x) => (x && typeof x === "object" ? { ...x } : null))
      .filter(Boolean)
    : [],
};
let worldMonitorNativeFeedManifest = [];

function persistWorldMonitorNativeStore() {
  try {
    writeJsonAtomic(WORLDMONITOR_NATIVE_STORE_PATH, {
      version: 1,
      updatedAt: Date.now(),
      items: worldMonitorNativeNewsItems.slice(-WORLDMONITOR_NATIVE_STORE_MAX_ITEMS),
    });
  } catch {
    // best effort
  }
}

function persistWorldMonitorNativeSignalsStore() {
  try {
    writeJsonAtomic(WORLDMONITOR_NATIVE_SIGNALS_PATH, {
      version: 1,
      updatedAt: Date.now(),
      marketSeries: Array.isArray(worldMonitorNativeSignals.marketSeries) ? worldMonitorNativeSignals.marketSeries : [],
      cryptoSeries: Array.isArray(worldMonitorNativeSignals.cryptoSeries) ? worldMonitorNativeSignals.cryptoSeries : [],
      seismicSeries: Array.isArray(worldMonitorNativeSignals.seismicSeries) ? worldMonitorNativeSignals.seismicSeries : [],
      infrastructureSeries: Array.isArray(worldMonitorNativeSignals.infrastructureSeries) ? worldMonitorNativeSignals.infrastructureSeries : [],
      adsbSeries: Array.isArray(worldMonitorNativeSignals.adsbSeries) ? worldMonitorNativeSignals.adsbSeries : [],
      disasterSeries: Array.isArray(worldMonitorNativeSignals.disasterSeries) ? worldMonitorNativeSignals.disasterSeries : [],
      maritimeSeries: Array.isArray(worldMonitorNativeSignals.maritimeSeries) ? worldMonitorNativeSignals.maritimeSeries : [],
      serviceSeries: Array.isArray(worldMonitorNativeSignals.serviceSeries) ? worldMonitorNativeSignals.serviceSeries : [],
      macroSeries: Array.isArray(worldMonitorNativeSignals.macroSeries) ? worldMonitorNativeSignals.macroSeries : [],
      predictionSeries: Array.isArray(worldMonitorNativeSignals.predictionSeries) ? worldMonitorNativeSignals.predictionSeries : [],
    });
  } catch {
    // best effort
  }
}

pruneWorldMonitorNativeStore(Date.now());
pruneWorldMonitorNativeSignals(Date.now());

function rememberWorldMonitorFeedAlertKey(key) {
  const clean = String(key || "").trim();
  if (!clean) return;
  worldMonitorFeedAlertSentKeySet.add(clean);
  while (worldMonitorFeedAlertSentKeySet.size > WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP) {
    const oldest = worldMonitorFeedAlertSentKeySet.values().next().value;
    if (!oldest) break;
    worldMonitorFeedAlertSentKeySet.delete(oldest);
  }
  worldMonitorMonitor.feedAlertsSentKeys = [...worldMonitorFeedAlertSentKeySet];
}

function rememberWorldMonitorFeedAlertTitleKey(key) {
  const clean = String(key || "").trim();
  if (!clean) return;
  worldMonitorFeedAlertSentTitleKeySet.add(clean);
  while (worldMonitorFeedAlertSentTitleKeySet.size > WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP) {
    const oldest = worldMonitorFeedAlertSentTitleKeySet.values().next().value;
    if (!oldest) break;
    worldMonitorFeedAlertSentTitleKeySet.delete(oldest);
  }
  worldMonitorMonitor.feedAlertsSentTitleKeys = [...worldMonitorFeedAlertSentTitleKeySet];
}

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
let statePersister = null;
let pendingStatePersist = false;
let pendingStatePersistImmediate = false;
const orchWorkerRuntime = createOrchWorkerRuntime({
  fs,
  path,
  orchWorkers,
  orchActiveWorkerByChat,
  orchSessionByChatWorker,
  ORCH_GENERAL_WORKER_ID,
  persistState,
  normalizeWorkerDisplayName,
  collectUsedWorkerNameKeys,
  chooseAvailableWorkerName,
  takeNextWorkerIdCandidate: () => `w${orchNextWorkerNum++}`,
  ensureWorkerLane,
  getLane,
  lanes,
  terminateChildTree,
  dropReplyRoutesForWorker: (...args) => orchReplyContextRuntime.dropReplyRoutesForWorker(...args),
});
const orchLaneRegistryRuntime = createOrchLaneRegistryRuntime({
  fs,
  path,
  ROOT,
  CODEX_WORKDIR,
  ORCH_TTS_LANE_ID,
  ORCH_WHISPER_LANE_ID,
  ORCH_GENERAL_WORKER_ID,
  ORCH_MAX_CODEX_WORKERS,
  orchWorkers,
  lanes,
  persistState,
  log,
  getCodexWorker,
  listCodexWorkers,
  findWorkerByWorkdir,
  createRepoWorker,
});
initOrchLanes();
let nextJobId = 1;
let shuttingDown = false;
const orchPendingSpawnByChat = new Map(); // chatId -> { desiredWorkdir, title, promptText, source, options, createdAt }
const pendingCommandsById = new Map();
const pendingCommandIdByChat = new Map();
const backgroundCommandChainByChat = new Map();
const pendingNaturalNewsByChat = new Map(); // chatId -> { at }
const pendingWeatherLocationByChat = new Map(); // chatId -> { at }
const worldMonitorRuntime = {
  timer: null,
  inFlight: false,
};
const worldMonitorComprehensiveRuntime = {
  inFlight: false,
  lastStartedAt: 0,
};
const worldMonitorFeedAlertsRuntime = {
  timer: null,
  inFlight: false,
};
const worldMonitorNativeRuntime = {
  inFlight: false,
  refreshPromise: null,
  refreshStartedAt: 0,
  signalsPromise: null,
  deepIngestPromise: null,
  startupCatchupPromise: null,
};
const weatherDailyRuntime = {
  timer: null,
  inFlight: false,
  nextRunAt: 0,
};
const worldMonitorHeadlineTranslationCache = new Map();
const worldMonitorHeadlineTranslationInFlight = new Map();
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
  stderrNoiseCarry: "",
  restartTimer: null,
  restartAttempts: 0,
  startCount: 0,
  readyCount: 0,
  closeCount: 0,
  errorCount: 0,
  requestCount: 0,
  requestFailureCount: 0,
  timeoutCount: 0,
  fallbackSingleCount: 0,
  fallbackBatchCount: 0,
  restartScheduledCount: 0,
  restartFailureCount: 0,
  lastStartAt: 0,
  lastReadyAt: 0,
  lastCloseAt: 0,
  lastCloseReason: "",
  lastErrorAt: 0,
  lastError: "",
  stopCount: 0,
  lastStopAt: 0,
  lastStopReason: "",
  lastRestartAt: 0,
  lastRestartDelayMs: 0,
  lastRestartReason: "",
  lastFallbackAt: 0,
  lastFallbackReason: "",
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
      workdir: ROOT,
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
      workdir: ROOT,
      createdAt: Number(general.createdAt || now) || now,
      lastUsedAt: Number(general.lastUsedAt || now) || now,
    };
  }
  for (const [workerId, rawWorker] of Object.entries(workers)) {
    const wid = String(workerId || "").trim();
    const worker = rawWorker && typeof rawWorker === "object" ? rawWorker : null;
    if (!wid || !worker) continue;
    if (String(worker.kind || "").trim().toLowerCase() === "repo") continue;
    worker.workdir = ROOT;
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

function buildStateSnapshot() {
  return {
    lastUpdateId,
    lastImages,
    chatPrefs,
    chatAutomationPrefs,
    orchLessons,
    redditDigest,
    worldMonitorMonitor,
    weatherDaily: weatherDailyState,
    weatherLocationsByChat,
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
  };
}

function buildWorkflowCatalogSnapshot() {
  return {
    version: 1,
    updatedAt: Date.now(),
    chatAutomationPrefs,
  };
}

function flushPendingStatePersistence() {
  if (!statePersister || !pendingStatePersist) return;
  statePersister.markDirty({ immediate: pendingStatePersistImmediate });
  pendingStatePersist = false;
  pendingStatePersistImmediate = false;
}

statePersister = createStatePersister({
  writeNow: () => {
    writeJsonAtomic(STATE_PATH, buildStateSnapshot());
    try {
      writeJsonAtomic(WORKFLOW_CATALOG_PATH, buildWorkflowCatalogSnapshot());
    } catch (err) {
      console.error(`[state] Failed to write workflow catalog: ${err?.message || err}`);
    }
  },
  delayMs: STATE_WRITE_DEBOUNCE_MS,
  maxDelayMs: STATE_WRITE_MAX_DELAY_MS,
  onError: () => {
    // best effort
  },
});
flushPendingStatePersistence();

function persistState({ immediate = false } = {}) {
  if (!statePersister) {
    pendingStatePersist = true;
    pendingStatePersistImmediate = pendingStatePersistImmediate || immediate;
    return;
  }
  statePersister.markDirty({ immediate });
}

function flushStatePersistence() {
  flushPendingStatePersistence();
  if (!statePersister) return;
  statePersister.flush();
}

const orchReplyContextRuntime = createOrchReplyContextRuntime({
  orchWorkers,
  orchReplyRouteByChat,
  orchMessageMetaByChat,
  ORCH_MESSAGE_META_MAX_PER_CHAT,
  ORCH_MESSAGE_META_TTL_DAYS,
  ORCH_THREAD_CONTEXT_MAX_DEPTH,
  ORCH_THREAD_CONTEXT_MAX_CHARS,
  ORCH_RECENT_CONTEXT_MESSAGES,
  ORCH_RECENT_CONTEXT_MAX_CHARS,
  persistState,
  normalizeReplySnippet,
  senderLabel,
});

const orchTaskRuntime = createOrchTaskRuntime({
  orchTasksByChat,
  ORCH_TASK_MAX_PER_CHAT,
  ORCH_TASK_TTL_DAYS,
  takeNextTaskId: () => {
    const next = Number(orchNextTaskNum || 1);
    const id = Number.isFinite(next) && next > 0 ? Math.trunc(next) : 1;
    orchNextTaskNum = id + 1;
    return id;
  },
  persistState,
  normalizeReplySnippet,
});

function getChatPrefs(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return {
    model: "",
    reasoning: "",
    ttsPreset: "",
    ttsMode: "",
  };
  const entry = chatPrefs[key];
  if (!entry || typeof entry !== "object") return {
    model: "",
    reasoning: "",
    ttsPreset: "",
    ttsMode: "",
  };
  const ttsPreset = normalizeTtsPresetName(entry.ttsPreset, { allowDefault: true });
  const ttsMode = normalizeTtsVoiceMode(entry.ttsMode, { allowDefault: true });
  return {
    model: normalizeCodexModelName(entry.model),
    reasoning: String(entry.reasoning || "").trim(),
    ttsPreset: ttsPreset === "default" ? "" : ttsPreset,
    ttsMode: ttsMode === "default" ? "" : ttsMode,
  };
}

function normalizeChatAutomationPrefEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const approveArtemisPrompts = raw.approveArtemisPrompts === true;
  const openFirefoxFullscreenOnTvForWatch = raw.openFirefoxFullscreenOnTvForWatch === true;
  const ensureSunshineBeforeTvPcConnect = raw.ensureSunshineBeforeTvPcConnect === true;
  const useStrictTvPcConnectionOrder = raw.useStrictTvPcConnectionOrder === true;
  const selectTvPresentInArtemisAfterConnect = raw.selectTvPresentInArtemisAfterConnect === true;
  const askWhatToWatchAfterSiteEntry = raw.askWhatToWatchAfterSiteEntry === true;
  const playAndFullscreenAfterSelection = raw.playAndFullscreenAfterSelection === true;
  const sunshineStartCommand = String(raw.sunshineStartCommand || "").trim();
  const watchSites = Array.isArray(raw.watchSites)
    ? raw.watchSites
      .map((site) => String(site || "").trim())
      .filter((site) => site.length > 0)
    : [];
  const tvShowSearchSite = String(raw.tvShowSearchSite || "").trim();
  const movieSearchSite = String(raw.movieSearchSite || "").trim();
  const askSeasonEpisodeForShows = raw.askSeasonEpisodeForShows === true;
  if (
    !approveArtemisPrompts
    && !openFirefoxFullscreenOnTvForWatch
    && !ensureSunshineBeforeTvPcConnect
    && !useStrictTvPcConnectionOrder
    && !selectTvPresentInArtemisAfterConnect
    && !askWhatToWatchAfterSiteEntry
    && !playAndFullscreenAfterSelection
    && !sunshineStartCommand
    && watchSites.length === 0
    && !tvShowSearchSite
    && !movieSearchSite
    && !askSeasonEpisodeForShows
  ) return null;
  return {
    approveArtemisPrompts,
    openFirefoxFullscreenOnTvForWatch,
    ensureSunshineBeforeTvPcConnect,
    useStrictTvPcConnectionOrder,
    selectTvPresentInArtemisAfterConnect,
    askWhatToWatchAfterSiteEntry,
    playAndFullscreenAfterSelection,
    sunshineStartCommand,
    watchSites,
    tvShowSearchSite,
    movieSearchSite,
    askSeasonEpisodeForShows,
    updatedAt: Number(raw.updatedAt || 0) || 0,
  };
}

function normalizeChatAutomationPrefs(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [chatIdRaw, entryRaw] of Object.entries(raw)) {
    const key = String(chatIdRaw || "").trim();
    if (!key) continue;
    const entry = normalizeChatAutomationPrefEntry(entryRaw);
    if (!entry) continue;
    out[key] = entry;
  }
  return out;
}

function mergeChatAutomationPrefsByUpdatedAt(...sources) {
  const out = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [chatIdRaw, rawEntry] of Object.entries(source)) {
      const chatId = String(chatIdRaw || "").trim();
      if (!chatId) continue;
      const entry = normalizeChatAutomationPrefEntry(rawEntry);
      if (!entry) continue;
      const prev = normalizeChatAutomationPrefEntry(out[chatId]);
      const entryUpdatedAt = Number(entry.updatedAt || 0) || 0;
      const prevUpdatedAt = Number(prev?.updatedAt || 0) || 0;
      if (!prev || entryUpdatedAt >= prevUpdatedAt) {
        out[chatId] = entry;
      }
    }
  }
  return out;
}

function getChatAutomationPrefs(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const entry = normalizeChatAutomationPrefEntry(chatAutomationPrefs[key]);
  return entry || null;
}

function rememberChatAutomationPrefsFromText(chatId, text) {
  const key = String(chatId || "").trim();
  const raw = String(text || "").trim();
  if (!key || !raw) return false;
  const lower = raw.toLowerCase();

  const patch = {};
  if (
    (/\bpermission\b/.test(lower) || /\bpairing\b/.test(lower))
    && (/\bapprove\b/.test(lower) || /\ballow\b/.test(lower) || /\bokay\b/.test(lower) || /\byes\b/.test(lower))
  ) {
    patch.approveArtemisPrompts = true;
  }
  const hasWatchTvComputer = /\bwatch\b/.test(lower) && /\btv\b/.test(lower) && /\bcomputer\b/.test(lower);
  const hasFirefoxWindowMaximizeIntent = /\bfirefox\b/.test(lower)
    && (/\bfull\s*screen\b/.test(lower) || /\bfullscreen\b/.test(lower) || /\bmaximiz(?:e|ed|ing)\b/.test(lower));
  const hasSecondMonitor = /\bsecond monitor\b/.test(lower)
    || /\btv as .*monitor\b/.test(lower)
    || /\btv monitor\b/.test(lower)
    || /\bthat monitor\b/.test(lower);
  if (hasWatchTvComputer && hasFirefoxWindowMaximizeIntent && hasSecondMonitor) {
    patch.openFirefoxFullscreenOnTvForWatch = true;
  }
  const hasSunshineStartOrRestart = /\bsunshine\b/.test(lower)
    && (/\bstart(?:ing)?\b/.test(lower) || /\brestart(?:ing)?\b/.test(lower));
  const hasTvPcFlowIntent = (/\btv\b/.test(lower) && (/\bpc\b/.test(lower) || /\bcomputer\b/.test(lower)))
    && (/\bconnect(?:s|ion|ing)?\b/.test(lower) || /\bflow\b/.test(lower) || /\broutine\b/.test(lower));
  if (hasSunshineStartOrRestart && hasTvPcFlowIntent) {
    patch.ensureSunshineBeforeTvPcConnect = true;
  }
  const hasTurnOnTv = /\bturn on tv\b/.test(lower)
    || /\bpower on tv\b/.test(lower)
    || /\bwake tv\b/.test(lower);
  const hasOpenArtemis = /\bopen artemis\b/.test(lower);
  const hasConnectSunshineArtemis = (/\bsunshine\b/.test(lower) && /\bartemis\b/.test(lower))
    && /\bconnect(?:s|ion|ing)?\b/.test(lower);
  if ((hasSunshineStartOrRestart || /start sunshine/.test(lower))
    && hasTurnOnTv
    && hasOpenArtemis
    && (hasTvPcFlowIntent || hasConnectSunshineArtemis)) {
    patch.useStrictTvPcConnectionOrder = true;
    patch.ensureSunshineBeforeTvPcConnect = true;
  }
  if (/\bselect\b/.test(lower) && /\bartemis\b/.test(lower) && /\btv\b/.test(lower) && /\bonce connected\b/.test(lower)) {
    patch.selectTvPresentInArtemisAfterConnect = true;
  }
  const hasFirefoxOpenIntent = /\bfirefox\b/.test(lower)
    && (/\bopen\b/.test(lower) || /\bopened\b/.test(lower) || /\bnew window\b/.test(lower));
  const hasSto = /\bs\.to\b/.test(lower);
  const hasSflix = /\bsflix\.(?:to|ps)\b/.test(lower);
  if (hasFirefoxOpenIntent && hasSto && hasSflix) {
    patch.watchSites = ["https://s.to", "https://sflix.ps"];
    patch.openFirefoxFullscreenOnTvForWatch = true;
  }
  const hasSearchFlow = /\bsearch\b/.test(lower) || /\bsearch bar\b/.test(lower) || /\bwrite\b/.test(lower);
  const hasSelectFlow = /\bselect\b/.test(lower) || /\bchoose\b/.test(lower);
  const hasTvShowFlow = (/\btv show\b/.test(lower) || /\bshow\b/.test(lower) || /\bseries\b/.test(lower))
    && hasSto
    && hasSearchFlow
    && hasSelectFlow;
  const hasMovieFlow = /\bmovie\b/.test(lower)
    && hasSflix
    && hasSearchFlow;
  if (hasTvShowFlow) {
    patch.tvShowSearchSite = "https://s.to";
    patch.askSeasonEpisodeForShows = true;
  }
  if (hasMovieFlow) {
    patch.movieSearchSite = "https://sflix.ps";
  }
  if ((/\bask me\b/.test(lower) || /\bask\b/.test(lower)) && /\bwhat\b/.test(lower) && /\bwatch\b/.test(lower)) {
    patch.askWhatToWatchAfterSiteEntry = true;
  }
  if ((/\bclick play\b/.test(lower) || /\bplay back\b/.test(lower) || /\bplay\b/.test(lower))
    && (/\bfull\s*screen\b/.test(lower) || /\bfullscreen\b/.test(lower) || /\bmaximiz(?:e|ed|ing)\b/.test(lower))) {
    patch.playAndFullscreenAfterSelection = true;
  }
  const sunshinePathMatch = raw.match(/([a-z]:\\[^\r\n"'<>|?*]+?\.(?:cmd|bat|ps1))/i);
  if (sunshinePathMatch) {
    const candidatePath = String(sunshinePathMatch[1] || "").trim();
    if (candidatePath && /sunshine/i.test(candidatePath)) {
      patch.sunshineStartCommand = candidatePath;
      patch.ensureSunshineBeforeTvPcConnect = true;
    }
  }

  if (Object.keys(patch).length === 0) return false;

  const prev = getChatAutomationPrefs(key) || {
    approveArtemisPrompts: false,
    openFirefoxFullscreenOnTvForWatch: false,
    ensureSunshineBeforeTvPcConnect: false,
    useStrictTvPcConnectionOrder: false,
    selectTvPresentInArtemisAfterConnect: false,
    askWhatToWatchAfterSiteEntry: false,
    playAndFullscreenAfterSelection: false,
    sunshineStartCommand: "",
    watchSites: [],
    tvShowSearchSite: "",
    movieSearchSite: "",
    askSeasonEpisodeForShows: false,
    updatedAt: 0,
  };
  const patchWatchSites = Array.isArray(patch.watchSites)
    ? patch.watchSites.map((site) => String(site || "").trim()).filter((site) => site.length > 0)
    : [];
  const prevWatchSites = Array.isArray(prev.watchSites)
    ? prev.watchSites.map((site) => String(site || "").trim()).filter((site) => site.length > 0)
    : [];
  const next = {
    approveArtemisPrompts: prev.approveArtemisPrompts || patch.approveArtemisPrompts === true,
    openFirefoxFullscreenOnTvForWatch:
      prev.openFirefoxFullscreenOnTvForWatch || patch.openFirefoxFullscreenOnTvForWatch === true,
    ensureSunshineBeforeTvPcConnect:
      prev.ensureSunshineBeforeTvPcConnect || patch.ensureSunshineBeforeTvPcConnect === true,
    useStrictTvPcConnectionOrder:
      prev.useStrictTvPcConnectionOrder || patch.useStrictTvPcConnectionOrder === true,
    selectTvPresentInArtemisAfterConnect:
      prev.selectTvPresentInArtemisAfterConnect || patch.selectTvPresentInArtemisAfterConnect === true,
    askWhatToWatchAfterSiteEntry:
      prev.askWhatToWatchAfterSiteEntry || patch.askWhatToWatchAfterSiteEntry === true,
    playAndFullscreenAfterSelection:
      prev.playAndFullscreenAfterSelection || patch.playAndFullscreenAfterSelection === true,
    sunshineStartCommand: String(patch.sunshineStartCommand || prev.sunshineStartCommand || "").trim(),
    watchSites: patchWatchSites.length > 0 ? patchWatchSites : prevWatchSites,
    tvShowSearchSite: String(patch.tvShowSearchSite || prev.tvShowSearchSite || "").trim(),
    movieSearchSite: String(patch.movieSearchSite || prev.movieSearchSite || "").trim(),
    askSeasonEpisodeForShows: prev.askSeasonEpisodeForShows || patch.askSeasonEpisodeForShows === true,
    updatedAt: Date.now(),
  };
  const nextWatchSitesKey = JSON.stringify(next.watchSites || []);
  const prevWatchSitesKey = JSON.stringify(prevWatchSites);

  if (
    next.approveArtemisPrompts === prev.approveArtemisPrompts
    && next.openFirefoxFullscreenOnTvForWatch === prev.openFirefoxFullscreenOnTvForWatch
    && next.ensureSunshineBeforeTvPcConnect === prev.ensureSunshineBeforeTvPcConnect
    && next.useStrictTvPcConnectionOrder === (prev.useStrictTvPcConnectionOrder === true)
    && next.selectTvPresentInArtemisAfterConnect === (prev.selectTvPresentInArtemisAfterConnect === true)
    && next.askWhatToWatchAfterSiteEntry === (prev.askWhatToWatchAfterSiteEntry === true)
    && next.playAndFullscreenAfterSelection === (prev.playAndFullscreenAfterSelection === true)
    && next.sunshineStartCommand === String(prev.sunshineStartCommand || "").trim()
    && nextWatchSitesKey === prevWatchSitesKey
    && next.tvShowSearchSite === String(prev.tvShowSearchSite || "").trim()
    && next.movieSearchSite === String(prev.movieSearchSite || "").trim()
    && next.askSeasonEpisodeForShows === (prev.askSeasonEpisodeForShows === true)
  ) {
    return false;
  }

  chatAutomationPrefs[key] = next;
  persistState({ immediate: true });
  return true;
}

function buildChatAutomationPromptContext(chatId) {
  const prefs = getChatAutomationPrefs(chatId);
  if (!prefs) return "";
  const lines = [];
  if (prefs.tvShowSearchSite) {
    lines.push(
      `- TV show flow: use computer tools to open ${prefs.tvShowSearchSite}, search for the show name, and select the matching show.`,
    );
  }
  if (prefs.askSeasonEpisodeForShows) {
    lines.push("- After selecting a TV show, ask the user which season and episode to play.");
  }
  if (prefs.movieSearchSite) {
    lines.push(
      `- Movie flow: use computer tools to open ${prefs.movieSearchSite} and search/select the requested movie.`,
    );
  }
  if (prefs.askWhatToWatchAfterSiteEntry) {
    lines.push("- After entering the site main page, ask the user what they want to watch before searching.");
  }
  if (prefs.playAndFullscreenAfterSelection) {
    lines.push("- After navigation to the selected title/episode, click play in preview and keep Firefox maximized on the TV monitor.");
  }
  return lines.join("\n");
}

function setChatPrefs(chatId, patch) {
  const key = String(chatId || "").trim();
  if (!key) return;
  const prev = getChatPrefs(key);
  const hasPatch = patch && typeof patch === "object";
  const hasPreset = hasPatch && Object.prototype.hasOwnProperty.call(patch, "ttsPreset");
  const hasMode = hasPatch && Object.prototype.hasOwnProperty.call(patch, "ttsMode");
  const normalizedPreset = hasPreset
    ? normalizeTtsPresetName(patch.ttsPreset, { allowDefault: true })
    : normalizeTtsPresetName(prev.ttsPreset, { allowDefault: true });
  const normalizedMode = hasMode
    ? normalizeTtsVoiceMode(patch.ttsMode, { allowDefault: true })
    : normalizeTtsVoiceMode(prev.ttsMode, { allowDefault: true });
  const next = {
    model: normalizeCodexModelName(patch?.model ?? prev.model ?? ""),
    reasoning: String(patch?.reasoning ?? prev.reasoning ?? "").trim(),
    ttsPreset: normalizedPreset === "default" ? "" : normalizedPreset,
    ttsMode: normalizedMode === "default" ? "" : normalizedMode,
  };
  if (!next.model && !next.reasoning && !next.ttsPreset && !next.ttsMode) {
    if (Object.prototype.hasOwnProperty.call(chatPrefs, key)) {
      delete chatPrefs[key];
      persistState();
    }
    return;
  }
  chatPrefs[key] = next;
  persistState({ immediate: true });
}

function clearChatPrefs(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  if (!(key in chatPrefs)) return;
  delete chatPrefs[key];
  persistState();
}

function pruneOrchLessons({ persist = false } = {}) {
  const normalized = normalizeOrchLessons(orchLessons);
  const fingerprint = (rows) => rows
    .map((row) => [
      makeOrchLessonDedupeKey(row),
      String(row.lesson || ""),
      String(row.trigger || ""),
      String(row.category || ""),
      String(row.source || ""),
      String(row.chatId || ""),
      Number(row.failCount || 0),
      Number(row.firstSeenAt || 0),
      Number(row.lastSeenAt || 0),
      String(row.lastError || ""),
    ].join("|"))
    .join("\n");
  const changed = fingerprint(normalized) !== fingerprint(orchLessons);
  if (!changed) return false;
  orchLessons.splice(0, orchLessons.length, ...normalized);
  if (persist) persistState();
  return true;
}

function inferOrchFailureLesson(job, result) {
  if (!ORCH_LESSONS_ENABLED) return null;
  const raw = String(result?.text || "").trim();
  if (!raw) return null;

  const source = String(job?.source || "").trim().toLowerCase();
  if (source === "router" || source.startsWith("worldmonitor") || source.startsWith("weather")) return null;

  const kind = String(job?.kind || "codex").trim().toLowerCase();
  const text = oneLine(raw);
  const lower = text.toLowerCase();
  const timedOut = Boolean(job?.timedOut) || /\btimed out\b/.test(lower);
  const voiceRelated = kind === "tts" || source.includes("voice") || source.includes("tts");
  const uiRelated = source.includes("screenshot")
    || source.includes("vision")
    || source.includes("ui")
    || /\bwindow\b.*\bnot found\b/.test(lower);

  const make = (signature, trigger, lesson, category = "runtime") => ({
    signature,
    trigger,
    lesson,
    category,
  });

  if (/unexpected argument ['"]?-a['"]? found/i.test(lower) || /older bot process is still running/i.test(lower)) {
    return make(
      "stale-codex-process-arg-a",
      "the runner reports unexpected argument -a",
      "stop old bot terminals and restart one bot instance before retrying the same action",
      "process",
    );
  }

  if (/failed to send telegram voice message|voice reply failed|tts synthesis failed|tts encoding failed|tts upload timed out|tts is unavailable/i.test(lower)) {
    return make(
      "voice-delivery-failure",
      "voice delivery fails",
      "send a text fallback immediately and restart the voice pipeline before the next voice reply",
      "voice",
    );
  }

  if (timedOut && uiRelated) {
    return make(
      "ui-timeout-loop-too-large",
      "a UI automation run times out",
      "use short loops only: focus window, screenshot, one action, screenshot, then continue",
      "ui",
    );
  }

  if (timedOut && voiceRelated) {
    return make(
      "voice-timeout",
      "voice processing times out",
      "split the spoken response into smaller chunks and confirm delivery after each chunk",
      "voice",
    );
  }

  if (timedOut) {
    return make(
      "job-timeout",
      "a task times out",
      "break the task into smaller steps and report progress after each step instead of repeating one long run",
      "timeout",
    );
  }

  if (/screenshot failed|image handling failed|\bwindow\b.*\bnot found\b|ui automation/i.test(lower)) {
    return make(
      "ui-capture-or-focus-failure",
      "UI capture or focus fails",
      "verify the target window is focused and visible before each action, and capture before/after screenshots",
      "ui",
    );
  }

  if (/failed to prepare aidolon execution|failed to start aidolon|aidolon process error/i.test(lower)) {
    return make(
      "aidolon-launch-failure",
      "the runner fails before task execution starts",
      "validate runtime prerequisites first, then retry once; if still failing, report the blocker instead of looping",
      "runtime",
    );
  }

  if (/failed unexpectedly|unknown error/i.test(lower)) {
    return make(
      "unexpected-job-failure",
      "an unexpected failure appears",
      "state the exact blocker and change strategy on the next attempt rather than retrying the same step",
      "runtime",
    );
  }

  return null;
}

function rememberOrchFailureLesson(job, result) {
  if (!ORCH_LESSONS_ENABLED) return null;
  const inferred = inferOrchFailureLesson(job, result);
  if (!inferred) return null;

  const now = Date.now();
  const source = String(job?.source || "").trim().toLowerCase();
  const candidate = normalizeOrchLessonEntry({
    signature: inferred.signature,
    trigger: inferred.trigger,
    lesson: inferred.lesson,
    category: inferred.category,
    source,
    chatId: String(job?.chatId || "").trim(),
    workerId: String(job?.workerId || "").trim(),
    workdirKey: normalizePathKey(String(job?.workdir || "").trim()),
    failCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    lastError: String(result?.text || ""),
  });
  if (!candidate) return null;

  const dedupeKey = makeOrchLessonDedupeKey(candidate);
  let existing = null;
  for (const item of orchLessons) {
    if (makeOrchLessonDedupeKey(item) !== dedupeKey) continue;
    existing = item;
    break;
  }

  if (existing) {
    existing.failCount = Math.min(9999, Number(existing.failCount || 0) + 1);
    existing.lastSeenAt = now;
    if (candidate.lesson) existing.lesson = candidate.lesson;
    if (candidate.trigger) existing.trigger = candidate.trigger;
    if (candidate.category) existing.category = candidate.category;
    if (candidate.source) existing.source = candidate.source;
    if (candidate.chatId) existing.chatId = candidate.chatId;
    if (candidate.workerId) existing.workerId = candidate.workerId;
    if (candidate.workdirKey) existing.workdirKey = candidate.workdirKey;
    if (candidate.lastError) existing.lastError = candidate.lastError;
  } else {
    orchLessons.push(candidate);
  }

  pruneOrchLessons({ persist: false });
  persistState();
  return existing || candidate;
}

function buildOrchLessonPromptContext({ chatId = "", workerId = "", workdir = "", source = "", replyStyle = "" } = {}) {
  if (!ORCH_LESSONS_ENABLED || ORCH_LESSONS_PER_PROMPT <= 0) return "";
  if (!Array.isArray(orchLessons) || orchLessons.length === 0) return "";

  pruneOrchLessons({ persist: false });
  if (orchLessons.length === 0) return "";

  const wantedChatId = String(chatId || "").trim();
  const wantedWorkerId = String(workerId || "").trim();
  const wantedWorkdirKey = normalizePathKey(workdir);
  const sourceKey = String(source || "").trim().toLowerCase();
  const styleKey = String(replyStyle || "").trim().toLowerCase();
  const wantsVoice = styleKey === "voice" || styleKey === "tts" || styleKey === "spoken" || sourceKey.includes("voice");
  const now = Date.now();

  const ranked = [];
  for (const lesson of orchLessons) {
    if (!lesson || typeof lesson !== "object") continue;
    let score = 0;
    const hasScope = Boolean(
      String(lesson.workdirKey || "").trim()
      || String(lesson.workerId || "").trim()
      || String(lesson.chatId || "").trim(),
    );

    if (wantedWorkdirKey && lesson.workdirKey && lesson.workdirKey === wantedWorkdirKey) score += 90;
    else if (wantedWorkerId && lesson.workerId && lesson.workerId === wantedWorkerId) score += 50;
    else if (wantedChatId && lesson.chatId && lesson.chatId === wantedChatId) score += 30;
    else if (hasScope) continue;
    else score += 5;

    const category = String(lesson.category || "").trim().toLowerCase();
    if (wantsVoice && category === "voice") score += 10;
    if (!wantsVoice && category === "ui") score += 4;

    const failCount = Math.max(1, Number(lesson.failCount || 1));
    score += Math.min(15, failCount);

    const ageMs = Math.max(0, now - Number(lesson.lastSeenAt || 0));
    const ageHours = ageMs / (60 * 60 * 1000);
    score += Math.max(0, 18 - ageHours / 4);

    if (score <= 0) continue;
    ranked.push({ lesson, score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Number(b.lesson?.lastSeenAt || 0) - Number(a.lesson?.lastSeenAt || 0);
  });

  const lines = [];
  const seenSignatures = new Set();
  for (const row of ranked) {
    const lesson = row.lesson;
    const sig = String(lesson.signature || "").trim();
    if (!sig || seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    const trigger = normalizeLessonText(lesson.trigger || "", 120);
    const advice = normalizeLessonText(lesson.lesson || "", ORCH_LESSON_MAX_TEXT_CHARS);
    if (!advice) continue;
    const count = Math.max(1, Number(lesson.failCount || 1));
    const seenSuffix = count > 1 ? ` (seen ${count} times)` : "";
    const prefix = trigger ? `If ${trigger}, ` : "";
    lines.push(`- ${prefix}${advice}${seenSuffix}.`);
    if (lines.length >= ORCH_LESSONS_PER_PROMPT) break;
  }

  if (lines.length === 0) return "";
  return trimContextBlock(lines.join("\n"), ORCH_LESSONS_PROMPT_MAX_CHARS, "[...older lessons truncated]");
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
  return orchReplyContextRuntime.normalizeTaskLinks(rawValue);
}

function mergeTaskLinks(a, b) {
  return orchReplyContextRuntime.mergeTaskLinks(a, b);
}

function getMessageMetaEntry(chatId, messageId) {
  return orchReplyContextRuntime.getMessageMetaEntry(chatId, messageId);
}

function recordMessageMeta(chatId, messageId, context = {}, options = {}) {
  return orchReplyContextRuntime.recordMessageMeta(chatId, messageId, context, options);
}

function recordIncomingTelegramMessageMeta(msg, context = {}) {
  return orchReplyContextRuntime.recordIncomingTelegramMessageMeta(msg, context);
}

function createOrchTask(chatId, context = {}) {
  return orchTaskRuntime.createOrchTask(chatId, context);
}

function updateOrchTask(chatId, taskId, patch = {}, { persist = true } = {}) {
  return orchTaskRuntime.updateOrchTask(chatId, taskId, patch, { persist });
}

function markOrchTaskRunning(job) {
  orchTaskRuntime.markOrchTaskRunning(job);
}

function markOrchTaskCompleted(job, result, context = {}) {
  orchTaskRuntime.markOrchTaskCompleted(job, result, context);
}

function getLane(laneId) {
  return orchLaneRegistryRuntime.getLane(laneId);
}

function makeLane({ id, type, title, workdir, countTowardCap = false } = {}) {
  return orchLaneRegistryRuntime.makeLane({ id, type, title, workdir, countTowardCap });
}

function listCodexWorkers() {
  return orchWorkerRuntime.listCodexWorkers();
}

function getCodexWorker(workerId) {
  return orchWorkerRuntime.getCodexWorker(workerId);
}

function touchWorker(workerId) {
  orchWorkerRuntime.touchWorker(workerId);
}

function normalizePathKey(inputPath) {
  return orchWorkerRuntime.normalizePathKey(inputPath);
}

function resolveWorkdirInput(inputPath) {
  return orchWorkerRuntime.resolveWorkdirInput(inputPath);
}

function findWorkerByWorkdir(workdir) {
  return orchWorkerRuntime.findWorkerByWorkdir(workdir);
}

function createRepoWorker(workdir, title = "") {
  return orchWorkerRuntime.createRepoWorker(workdir, title);
}

function retireWorker(workerId, { cancelActive = true } = {}) {
  orchWorkerRuntime.retireWorker(workerId, { cancelActive });
}

function resolveWorkerIdFromUserInput(input) {
  return orchWorkerRuntime.resolveWorkerIdFromUserInput(input);
}

function summarizeWorkerCapabilities(worker) {
  if (!worker || typeof worker !== "object") return "";
  const kind = String(worker.kind || "").trim().toLowerCase();
  const workdir = String(worker.workdir || "").trim().replace(/\\/g, "/");
  const scope = kind !== "repo"
    ? "general requests, web research, local PC/system tasks, and TV control"
    : workdir
      ? `repo work in ${workdir}`
      : "workspace-specific coding tasks";
  return `best_for=${scope}; tools=files, shell, git, web lookup, Windows UI automation, TV ADB control via tv_power/tv_open_app/tv_close_app/tv_capture; channels=text/voice`;
}

function listWorkerCapabilities() {
  return listCodexWorkers().map((worker) => ({
    workerId: String(worker.id || "").trim(),
    summary: summarizeWorkerCapabilities(worker),
  }));
}

function getWorkerCapabilitySummary(workerId) {
  return summarizeWorkerCapabilities(getCodexWorker(workerId));
}

function ensureTtsLane() {
  return orchLaneRegistryRuntime.ensureTtsLane();
}

function ensureWhisperLane() {
  return orchLaneRegistryRuntime.ensureWhisperLane();
}

function resolveFallbackWorkdir() {
  return orchLaneRegistryRuntime.resolveFallbackWorkdir();
}

function resolveUsableWorkdir(preferredWorkdir) {
  return orchLaneRegistryRuntime.resolveUsableWorkdir(preferredWorkdir);
}

function refreshLaneWorkdir(lane, { logPrefix = "" } = {}) {
  return orchLaneRegistryRuntime.refreshLaneWorkdir(lane, { logPrefix });
}

function ensureWorkerLane(workerId) {
  return orchLaneRegistryRuntime.ensureWorkerLane(workerId);
}

function initOrchLanes() {
  orchLaneRegistryRuntime.initOrchLanes();
}

const orchQueueRuntime = createOrchQueueRuntime({
  lanes,
  fs,
  RESTART_REASON_PATH,
  RESTART_EXIT_CODE,
  getPendingRestartRequest: () => pendingRestartRequest,
  setPendingRestartRequest: (value) => {
    pendingRestartRequest = value;
  },
  getShuttingDown: () => shuttingDown,
  getRestartTriggerInFlight: () => restartTriggerInFlight,
  setRestartTriggerInFlight: (value) => {
    restartTriggerInFlight = Boolean(value);
  },
  sendMessage,
  logSystemEvent,
  shutdown,
  updateOrchTask,
  persistState,
  fmtBold,
  normalizeTtsPresetName,
  getCodexWorker,
  terminateChildTree,
});

const orchLaneRuntime = createOrchLaneRuntime({
  path,
  OUT_DIR,
  ORCH_GENERAL_WORKER_ID,
  MAX_QUEUE_SIZE,
  TELEGRAM_CHAT_ACTION_ENABLED,
  TELEGRAM_CHAT_ACTION_DEFAULT,
  TELEGRAM_CHAT_ACTION_VOICE,
  TELEGRAM_CHAT_ACTION_INTERVAL_SEC,
  PROGRESS_UPDATES_ENABLED,
  PROGRESS_INCLUDE_STDERR,
  PROGRESS_FIRST_UPDATE_SEC,
  PROGRESS_UPDATE_INTERVAL_SEC,
  TTS_REPLY_TO_VOICE,
  TTS_ENABLED,
  WORLDMONITOR_ALERT_VOICE_ENABLED,
  WORLDMONITOR_CHECK_VOICE_ENABLED,
  takeNextJobId: () => nextJobId++,
  getShuttingDown: () => shuttingDown,
  sendMessage,
  sendChatAction,
  log,
  redactError,
  getActiveWorkerForChat,
  listCodexWorkers,
  setActiveWorkerForChat,
  ensureWorkerLane,
  ensureTtsLane,
  totalQueuedJobs,
  touchWorker,
  refreshLaneWorkdir,
  normalizePrompt,
  getActiveSessionForChat,
  createOrchTask,
  normalizeTtsText,
  resolveTtsPresetForChat,
  getLane,
  markOrchTaskRunning,
  runRawCodexJob,
  runTtsJob,
  runTtsBatchJob,
  runWhisperJob,
  runCodexJob,
  setSessionForChatWorker,
  rememberOrchFailureLesson,
  getSessionForChatWorker,
  extractAttachDirectives,
  injectForcedTextOnlySection,
  splitVoiceReplyParts,
  makeSpeakableTextForTts,
  makeWorldMonitorTextTtsFriendly,
  makeWorldMonitorCheckVoiceSummary,
  splitSpeakableTextIntoVoiceChunks,
  extractNonSpeakableInfo,
  normalizeResponse,
  sendAttachments,
  markOrchTaskCompleted,
  maybeTriggerPendingRestart,
  truncateLine,
  isProgressNoiseLine,
});

const orchRouterRuntime = createOrchRouterRuntime({
  fs,
  path,
  OUT_DIR,
  ROOT,
  CODEX_WORKDIR,
  ORCH_GENERAL_WORKER_ID,
  ORCH_MAX_CODEX_WORKERS,
  ORCH_ROUTER_ENABLED,
  ORCH_ROUTER_MAX_CONCURRENCY,
  ORCH_ROUTER_TIMEOUT_MS,
  ORCH_ROUTER_MODEL,
  ORCH_ROUTER_REASONING_EFFORT,
  ORCH_SPLIT_ENABLED,
  ORCH_SPLIT_MAX_TASKS,
  MAX_QUEUE_SIZE,
  ORCH_DELEGATION_ACK_ENABLED,
  ORCH_DELEGATION_ACK_SILENT,
  orchPendingSpawnByChat,
  listCodexWorkers,
  getCodexWorker,
  hasWorker: (workerId) => {
    const wid = String(workerId || "").trim();
    return Boolean(wid && orchWorkers[wid]);
  },
  getActiveWorkerForChat,
  ensureWorkerLane,
  getLane,
  runCodexJob,
  createRepoWorker,
  resolveWorkdirInput,
  findWorkerByWorkdir,
  createOrchTask,
  getSessionForChatWorker,
  totalQueuedJobs,
  enqueuePrompt,
  sendMessage,
  log,
  redactError,
  normalizeReplySnippet,
  recordReplyRoute,
  getWorkerCapabilitySummary,
});

function totalQueuedJobs() {
  return orchQueueRuntime.totalQueuedJobs();
}

function listActiveJobs() {
  return orchQueueRuntime.listActiveJobs();
}

function laneWorkloadCounts() {
  return orchQueueRuntime.laneWorkloadCounts();
}

function hasPendingRestartRequest() {
  return orchQueueRuntime.hasPendingRestartRequest();
}

function cancelPendingRestartRequest() {
  return orchQueueRuntime.cancelPendingRestartRequest();
}

async function triggerRestartNow(reason = "") {
  return await orchQueueRuntime.triggerRestartNow(reason);
}

async function maybeTriggerPendingRestart(reason = "") {
  return await orchQueueRuntime.maybeTriggerPendingRestart(reason);
}

async function requestRestartWhenIdle(chatId, { forceNow = false } = {}) {
  return await orchQueueRuntime.requestRestartWhenIdle(chatId, { forceNow });
}

function listActiveJobsForChat(chatId) {
  return orchQueueRuntime.listActiveJobsForChat(chatId);
}

function listQueuedJobsForChat(chatId) {
  return orchQueueRuntime.listQueuedJobsForChat(chatId);
}

function dropQueuedJobsForChat(chatId) {
  return orchQueueRuntime.dropQueuedJobsForChat(chatId);
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
  return orchReplyContextRuntime.lookupReplyRouteEntry(chatId, messageId);
}

function summarizeTelegramMessageForReplyContext(msg) {
  return orchReplyContextRuntime.summarizeTelegramMessageForReplyContext(msg);
}

function isImageRelatedReplyContext(replyContext) {
  return orchReplyContextRuntime.isImageRelatedReplyContext(replyContext);
}

function buildReplyContextFromIncomingMessage(msg) {
  return orchReplyContextRuntime.buildReplyContextFromIncomingMessage(msg);
}

function trimContextBlock(text, maxChars, truncatedLead = "[...older context truncated]") {
  return orchReplyContextRuntime.trimContextBlock(text, maxChars, truncatedLead);
}

function formatMessageContextLine(item) {
  return orchReplyContextRuntime.formatMessageContextLine(item);
}

function buildReplyThreadContextFromIncomingMessage(msg) {
  return orchReplyContextRuntime.buildReplyThreadContextFromIncomingMessage(msg);
}

function buildRecentHistoryContext(chatId, { excludeMessageIds = [], limit = ORCH_RECENT_CONTEXT_MESSAGES } = {}) {
  return orchReplyContextRuntime.buildRecentHistoryContext(chatId, { excludeMessageIds, limit });
}

function recordReplyRoute(chatId, messageId, workerId, context = {}) {
  orchReplyContextRuntime.recordReplyRoute(chatId, messageId, workerId, context);
}

function lookupReplyRouteWorker(chatId, messageId) {
  return orchReplyContextRuntime.lookupReplyRouteWorker(chatId, messageId);
}

const telegramRouteMetaRuntime = createTelegramRouteMetaRuntime({
  recordMessageMeta,
  recordReplyRoute,
});

function dedupeRouteAssignments(items) {
  return orchRouterRuntime.dedupeRouteAssignments(items);
}

function summarizeDelegationQueueState(assignments) {
  return orchRouterRuntime.summarizeDelegationQueueState(assignments);
}

function buildDelegationAckText(assignments, stateSummary = null) {
  return orchRouterRuntime.buildDelegationAckText(assignments, stateSummary);
}

async function decideRoutePlanForPrompt(chatId, userText, options = {}) {
  return await orchRouterRuntime.decideRoutePlanForPrompt(chatId, userText, options);
}

async function routeAndEnqueuePrompt(chatId, userText, source, options = {}) {
  return await orchRouterRuntime.routeAndEnqueuePrompt(chatId, userText, source, options);
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

const TAIPEI_UTC_OFFSET_MINUTES = 8 * 60;

function taipeiPseudoDateFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return new Date(NaN);
  return new Date(n + (TAIPEI_UTC_OFFSET_MINUTES * 60 * 1000));
}

function taipeiDayKeyFromMs(ms) {
  const d = taipeiPseudoDateFromMs(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function taipeiClockTimeFromMs(ms) {
  const d = taipeiPseudoDateFromMs(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function utcMsFromTaipeiLocalDay(dayKey, hour, minute = 0, second = 0) {
  const key = String(dayKey || "").trim();
  if (!isUtcDayKey(key)) return 0;
  const dt = parseDayKeyLocal(key);
  if (!dt) return 0;
  return Date.UTC(
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate(),
    Math.max(0, Math.min(23, Math.trunc(Number(hour) || 0))),
    Math.max(0, Math.min(59, Math.trunc(Number(minute) || 0))),
    Math.max(0, Math.min(59, Math.trunc(Number(second) || 0))),
  ) - (TAIPEI_UTC_OFFSET_MINUTES * 60 * 1000);
}

function computeNextWeatherDailyRunAt(nowMs = Date.now()) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return Date.now() + 60_000;
  const todayKey = taipeiDayKeyFromMs(now);
  let nextAt = utcMsFromTaipeiLocalDay(todayKey, WEATHER_DAILY_HOUR, WEATHER_DAILY_MINUTE, 0);
  if (!Number.isFinite(nextAt) || nextAt <= 0) return now + 60_000;
  if (nextAt <= (now + 1000)) {
    nextAt += 24 * 60 * 60 * 1000;
  }
  return nextAt;
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
    "Language policy: reply only in English, German, or Chinese.",
    "If the user writes in another language, reply in English.",
    "Default to English unless the user explicitly asks for German or Chinese.",
    "If ambiguous, ask one clear follow-up question.",
    "",
    "Front-end UI handling (Windows desktop automation):",
    "- You can drive real browser UI with tools/ui_automation.ps1 (or tools/ui.cmd).",
    "- Supported actions: windows, focus, click, double_click, right_click, move, mouse_down, mouse_up, drag, highlight, click_text, clipboard_copy, clipboard_paste, clipboard_read, type, key, scroll, wait, screenshot.",
    "- Cursor movement should glide from current position to target (no teleport jumps); drag supports start/end points and duration; move still supports DragLeft.",
    "- click_text uses OCR and can target visible text; click actions can preview with HighlightBeforeClick.",
    "- Clipboard actions support copy, paste, and read. For key Enter, use key action with Enter (or Return). Scroll accepts positive and negative delta.",
    "- For short UI text input, prefer typewriter-style character-by-character typing with slight random delays; for large text blocks, direct insert or clipboard paste is acceptable.",
    "- For adjacent form fields, avoid a second coordinate guess: anchor the first field by visible label (click_text), type, then use key Tab to move to the next field.",
    "- For paired fields like display name + email, never type both values into one field; if focus is wrong, refocus by label and retry that field only.",
    "- For UX testing, use short loops: focus window, screenshot, one action, screenshot again.",
    "- For sliders and other draggable controls, prefer drag over move-with-held-mouse and avoid blind coordinate guesses when label anchoring is available.",
    "- After slider drags, verify that value/position/log changed; if not, retry once with a clearly different offset instead of repeating the same drag.",
    "- Ask one short confirmation question before destructive actions.",
    "",
    "TV control tools (ADB):",
    "- Use tools/tv_power.ps1 (or tools/tv_power_on.cmd / tools/tv_power_off.cmd) to wake, sleep, or toggle the TV.",
    "- Use tools/tv_open_app.ps1 and tools/tv_close_app.ps1 to launch or close TV apps such as YouTube, Netflix, Sunshine, Artemis, RetroArch, VLC, Spotify, or a custom package.",
    "- Use tools/tv_capture.ps1 to capture a screenshot from the connected TV and pull it locally.",
    "- Refer to tools/README.md for parameters when needed.",
  ].join("\n");
}

function defaultVoicePromptPreamble() {
  return [
    "You are AIDOLON speaking to the user via a Telegram voice message.",
    "Reply in natural conversational language suitable for text-to-speech.",
    "Language policy: reply only in English, German, or Chinese.",
    "If the user writes in another language, reply in English.",
    "Default to English unless the user explicitly asks for German or Chinese.",
    "Do not output code blocks, markdown, commands, stack traces, JSON, or file paths.",
    "Do not include URLs in SPOKEN. URLs are allowed in TEXT_ONLY when useful.",
    "Avoid weird symbols and formatting; use plain words and short sentences.",
    "If you refer to workers, use their proper names only, not IDs like w1 or W2.",
    "",
    "Front-end UI handling (Windows desktop automation):",
    "- Voice mode does not reduce capabilities. You can use tools/ui_automation.ps1 (or tools/ui.cmd).",
    "- Supported actions: windows, focus, click, double_click, right_click, move, mouse_down, mouse_up, drag, highlight, click_text, clipboard_copy, clipboard_paste, clipboard_read, type, key, scroll, wait, screenshot.",
    "- Cursor movement should glide from current position to target (no teleport jumps); drag supports start/end points and duration; move still supports DragLeft.",
    "- click_text uses OCR and can target visible text; click actions can preview with HighlightBeforeClick.",
    "- Clipboard actions support copy, paste, and read. For key Enter, use key action with Enter (or Return). Scroll accepts positive and negative delta.",
    "- For short UI text input, prefer typewriter-style character-by-character typing with slight random delays; for large text blocks, direct insert or clipboard paste is acceptable.",
    "- For adjacent form fields, avoid a second coordinate guess: anchor the first field by visible label (click_text), type, then use key Tab to move to the next field.",
    "- For paired fields like display name + email, never type both values into one field; if focus is wrong, refocus by label and retry that field only.",
    "- For UX testing, run short loops: focus window, screenshot, one action, screenshot again.",
    "- For sliders and other draggable controls, prefer drag over move-with-held-mouse and avoid blind coordinate guesses when label anchoring is available.",
    "- After slider drags, verify that value/position/log changed; if not, retry once with a clearly different offset instead of repeating the same drag.",
    "- Ask one short confirmation question before destructive actions.",
    "",
    "TV control tools (ADB):",
    "- Voice mode does not limit these tools either.",
    "- Use tools/tv_power.ps1 (or tools/tv_power_on.cmd / tools/tv_power_off.cmd) to wake, sleep, or toggle the TV.",
    "- Use tools/tv_open_app.ps1 and tools/tv_close_app.ps1 to launch or close TV apps such as YouTube, Netflix, Sunshine, Artemis, RetroArch, VLC, Spotify, or a custom package.",
    "- Use tools/tv_capture.ps1 to capture a screenshot from the connected TV and pull it locally.",
    "- Refer to tools/README.md for parameters when needed.",
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
  const chatId = String(options?.chatId || "").trim();
  const source = String(options?.source || "").trim();
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
  if (String(replyStyle || "").trim().toLowerCase() !== "router") {
    lines.push("Language policy: reply only in English, German, or Chinese.");
    lines.push("If the user writes in another language, reply in English.");
    lines.push("Default to English unless the user explicitly asks for German or Chinese.");
  }
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

  if (String(replyStyle || "").trim().toLowerCase() !== "router") {
    const lessonContext = buildOrchLessonPromptContext({
      chatId,
      workerId,
      workdir,
      source,
      replyStyle,
    });
    if (lessonContext) {
      lines.push("", "Process memory (learned from previous mistakes):");
      lines.push(lessonContext);
    }
    const automationContext = buildChatAutomationPromptContext(chatId);
    if (automationContext) {
      lines.push("", "User workflow memory:");
      lines.push(automationContext);
    }
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
  const workdir = String(job?.workdir || ROOT).trim() || ROOT;
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
  const workdir = String(job?.workdir || ROOT).trim() || ROOT;
  const codexWorkdir = codexMode.mode === "wsl" ? toWslPath(workdir) : workdir;
  const promptText = formatCodexPrompt(job.text, {
    hasImages: rawImagePaths.length > 0,
    replyStyle: String(job?.replyStyle || ""),
    workdir,
    workerId: String(job?.workerId || "").trim(),
    chatId: String(job?.chatId || "").trim(),
    source: String(job?.source || "").trim(),
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
  const effectiveModel = normalizeCodexModelName(job?.model || prefs.model || CODEX_MODEL || "");
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

function parseTelegramStatusFromError(err) {
  const message = String(err?.message || err || "");
  const match = message.match(/Telegram\s+\S+\s+failed:\s*(\d{3})\b/i);
  const status = Number(match?.[1] || 0);
  return Number.isFinite(status) ? status : 0;
}

function isRetryableTelegramStartupError(err) {
  const status = parseTelegramStatusFromError(err);
  if (status > 0) {
    return status === 429 || status >= 500;
  }

  const code = String(err?.cause?.code || err?.code || "").trim().toUpperCase();
  if ([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
    "ABORT_ERR",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
  ].includes(code)) {
    return true;
  }

  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("fetch failed")
    || message.includes("network")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("socket hang up")
  );
}

async function getTelegramIdentityWithRetry() {
  const attempts = Math.max(1, TELEGRAM_STARTUP_MAX_ATTEMPTS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegramApi("getMe");
    } catch (err) {
      lastError = err;
      if (!isRetryableTelegramStartupError(err) || attempt >= attempts) {
        throw err;
      }

      const waitMs = computeExponentialBackoffMs(
        attempt,
        TELEGRAM_STARTUP_RETRY_BASE_MS,
        TELEGRAM_STARTUP_RETRY_MAX_MS,
        0.2,
      );
      const code = String(err?.cause?.code || err?.code || "").trim().toUpperCase();
      const detail = oneLine(redactError(err?.message || err));
      const waitSec = Math.max(1, Math.round(waitMs / 1000));
      log(
        `Telegram getMe failed (attempt ${attempt}/${attempts})${code ? ` [${code}]` : ""}: ${detail}. Retrying in ${waitSec}s...`,
      );
      await sleep(waitMs);
    }
  }

  throw lastError || new Error("Telegram getMe failed");
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
    { command: "capabilities", description: "show worker capability map" },
    { command: "use", description: "switch active workspace" },
    { command: "spawn", description: "create a repo workspace" },
    { command: "retire", description: "remove a workspace" },
    { command: "queue", description: "show queued prompts" },
    { command: "weather", description: "show weather update (/weather [city])" },
    { command: "news", description: "show ranked worldmonitor headlines" },
    { command: "newsreport", description: "worldmonitor global+taiwan AI check" },
    { command: "newsstatus", description: "worldmonitor monitor status" },
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
    { command: "prune", description: "prune runtime artifacts and logs" },
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
    { command: "voice", description: "pick/set live TTS voice preset" },
    { command: "tts", description: "speak text as a Telegram voice message" },
    { command: "abtest", description: "A/B test all voice presets" },
    { command: "restart", description: "restart only when all workers are idle" },
  ];
}

function getTelegramCommandScopesForSync() {
  const allowed = new Set([
    "default",
    "all_private_chats",
    "all_group_chats",
    "all_chat_administrators",
  ]);
  const requested = TELEGRAM_COMMAND_SCOPES.length > 0 ? TELEGRAM_COMMAND_SCOPES : ["default"];
  const ordered = ["default", ...requested];
  const out = [];
  const seen = new Set();
  for (const rawScope of ordered) {
    const scope = String(rawScope || "").trim().toLowerCase();
    if (!scope || seen.has(scope)) continue;
    if (!allowed.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  if (out.length === 0) out.push("default");
  return out;
}

async function setTelegramCommands() {
  const commands = getTelegramCommandList();

  // Remove stale per-chat overrides so global command scopes stay authoritative.
  for (const rawChatId of ALLOWED_CHAT_IDS) {
    const chatId = String(rawChatId || "").trim();
    if (!chatId) continue;
    try {
      await telegramApi("deleteMyCommands", {
        body: {
          scope: { type: "chat", chat_id: chatId },
        },
      });
    } catch (err) {
      log(`deleteMyCommands(chat:${chatId}) failed: ${redactError(err?.message || err)}`);
    }
  }

  const scopes = getTelegramCommandScopesForSync();
  for (const scope of scopes) {
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
            telegramRouteMetaRuntime.recordOutgoingMessage(chatId, messageId, {
              parentMessageId: previousSentMessageId,
              source: routeSource || "bot-text",
              snippet: routeSnippet || formatted.text,
              from: "bot",
              fromIsBot: true,
              role: "assistant",
              routeWorkerId,
              routeTaskId,
              routeSessionId,
            });
            previousSentMessageId = Math.trunc(messageId);
          }
        }
        logChat("out", chatId, formatted.text, { source: "telegram-send", routeWorkerId });
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
        telegramRouteMetaRuntime.recordOutgoingMessage(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-photo",
          snippet: caption || "[photo]",
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          routeWorkerId,
          routeTaskId,
          routeSessionId,
        });
      }
      logChat("out", chatId, caption || "[photo]", { source: "telegram-photo", routeWorkerId });
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
        telegramRouteMetaRuntime.recordOutgoingMessage(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-voice",
          snippet: replyContextText || caption || "[voice]",
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          routeWorkerId,
          routeTaskId,
          routeSessionId,
        });
      }
      logChat("out", chatId, caption || "[voice]", { source: "telegram-voice", routeWorkerId });
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
        telegramRouteMetaRuntime.recordOutgoingMessage(chatId, msg.message_id, {
          parentMessageId: Number.isFinite(replyToMessageId) && replyToMessageId > 0 ? Math.trunc(replyToMessageId) : 0,
          source: "bot-document",
          snippet: caption || `[document] ${fileName}`,
          from: "bot",
          fromIsBot: true,
          role: "assistant",
          routeWorkerId,
          routeTaskId,
          routeSessionId,
        });
      }
      logChat("out", chatId, caption || `[document] ${fileName}`, { source: "telegram-document", routeWorkerId });
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
  if (
    /\ba[\s/-]?b(?:\s+test)?\b/i.test(squashed) &&
    /\bvoice\b/i.test(squashed) &&
    /\b(?:preset|presets|profile|profiles|compare|comparison)\b/i.test(squashed)
  ) {
    return { cmd: "/abtest", arg: "" };
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
    if (/^(?:please|pls|now|today|latest|last(?:\s+24h)?|last\s+24\s+hours?)$/.test(politeArg)) {
      arg = "";
    } else if (arg) {
      const parsedNewsArg = parseNewsListCommandArg(arg);
      if (parsedNewsArg.ok) {
        arg = String(parsedNewsArg.argText || "").trim();
      } else if (!prefixMode) {
        // Don't hijack regular conversation that happens to begin with "news".
        return null;
      } else {
        arg = "";
      }
    }
  }
  if (cmd === "/newsreport") {
    const politeArg = arg.replace(/[.!?]+$/g, "").trim().toLowerCase();
    if (/^(?:please|pls|now|today|latest)$/.test(politeArg)) {
      arg = "";
    } else if (arg) {
      const parsedNewsArg = parseNaturalNewsArgFromText(arg, { allowBareValue: true });
      if (parsedNewsArg.ok) {
        arg = String(parsedNewsArg.argText || "").trim();
      } else if (!prefixMode) {
        return null;
      } else {
        arg = "";
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
  // Keep slash commands synchronous by default so users get immediate,
  // in-order command responses instead of delayed background output.
  // /news can take longer when a feed refresh runs, so process it in background.
  "/news",
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
    "- /capabilities - show the worker capability map",
    "- /use <worker_id, name, or title> - switch active workspace",
    "- /queue - show queued prompts",
    "- /weather [city] - today/tomorrow forecast (voice when TTS is enabled)",
    "- /news [force] [count] - severity-ranked WorldMonitor headlines (today first, then previous days)",
    "- /newsreport [force|raw] - WorldMonitor AI check (global + Taiwan)",
    "- Say \"give me the news\" - runs the same /newsreport check flow",
    "- /newsstatus - show WorldMonitor monitor state and last alerts",
    "- /cancel - stop current AIDOLON run",
    "- /clear - clear queued prompts",
    "- /prune - prune runtime files/logs (keeps chat context)",
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
    "- /voice [name|single|worker|list|default] - set TTS mode/preset (live, no restart)",
    "- /tts <text> - send a TTS voice message (requires TTS_ENABLED=1)",
    "- /abtest [text] - send one sample per voice preset for A/B listening",
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
  const forceAlert = /\b(?:force|alert)\b/.test(raw);
  const rawMode = /\b(?:raw|legacy)\b/.test(raw);
  const argNormalized = [
    forceAlert ? "force" : "",
    rawMode ? "raw" : "",
  ].filter(Boolean).join(" ");
  return {
    ok: true,
    forceAlert,
    rawMode,
    argText: argNormalized,
  };
}

function parseNewsListCommandArg(argText) {
  const raw = String(argText || "").trim().toLowerCase();
  if (!raw) {
    return {
      ok: true,
      forceRefresh: false,
      maxItems: WORLDMONITOR_NEWS_LIST_MAX_ITEMS,
      argText: "",
    };
  }

  const normalized = raw
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = normalized ? normalized.split(" ").filter(Boolean) : [];
  if (tokens.length === 0) {
    return {
      ok: true,
      forceRefresh: false,
      maxItems: WORLDMONITOR_NEWS_LIST_MAX_ITEMS,
      argText: "",
    };
  }

  let forceRefresh = false;
  let maxItems = WORLDMONITOR_NEWS_LIST_MAX_ITEMS;
  const allowed = new Set([
    "force",
    "refresh",
    "update",
    "latest",
    "today",
    "now",
    "last",
    "24h",
    "24hr",
    "24hrs",
    "24",
    "hours",
    "hour",
    "h",
    "articles",
    "article",
    "news",
    "please",
    "pls",
    "top",
    "show",
    "limit",
    "max",
  ]);

  for (const token of tokens) {
    if (token === "force" || token === "refresh" || token === "update") {
      forceRefresh = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      maxItems = toInt(Number(token), WORLDMONITOR_NEWS_LIST_MAX_ITEMS, 1, 200);
      continue;
    }
    if (!allowed.has(token)) {
      return {
        ok: false,
        forceRefresh,
        maxItems: WORLDMONITOR_NEWS_LIST_MAX_ITEMS,
        argText: "",
      };
    }
  }

  const argParts = [];
  if (forceRefresh) argParts.push("force");
  if (maxItems !== WORLDMONITOR_NEWS_LIST_MAX_ITEMS) argParts.push(String(maxItems));
  return {
    ok: true,
    forceRefresh,
    maxItems,
    argText: argParts.join(" "),
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

  const forceAlert = /\b(?:force|alert)\b/.test(text);
  const rawMode = /\b(?:raw|legacy)\b/.test(text);
  const newsNowHint = /\b(?:latest|today|now|right\s+now|auto|default|catch[- ]?up)\b/.test(text);

  if (forceAlert || rawMode || newsNowHint) {
    const argText = [
      forceAlert ? "force" : "",
      rawMode ? "raw" : "",
    ].filter(Boolean).join(" ");
    return { ok: true, argText };
  }

  if (allowBareValue && /^(?:force|alert|raw|legacy)$/.test(text)) {
    const argText = /^(?:force|alert)$/.test(text) ? "force" : "raw";
    return { ok: true, argText };
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
    /\b\/newsreport\b/,
    /\bslash\s+news\b/,
    /\bslash\s+newsreport\b/,
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
  return { matched: true, needsDays: false, argText: parsedArg.ok ? parsedArg.argText : "" };
}

function isLikelyNaturalNewsFollowupText(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  const normalized = lower.replace(/[.!?]+$/g, "").trim();
  if (!normalized) return false;

  if (/^(?:force|alert|raw|legacy)$/.test(normalized)) return true;
  if (/^(?:force|alert)\s+(?:raw|legacy)$/.test(normalized)) return true;
  if (/^(?:raw|legacy)\s+(?:force|alert)$/.test(normalized)) return true;
  return /^(?:latest|today|now|right now|auto|default|catch[- ]?up|cancel|stop|never ?mind|forget it)(?:\s+please)?$/.test(normalized);
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
    await handleNewsReportCommand(chatId, parsedArg.argText);
    return true;
  }

  clearPendingNaturalNewsFollowup(chatId);
  await sendMessage(
    chatId,
    "Use /news for severity-ranked headlines, or /newsreport (/newsreport force or /newsreport raw) for checks.",
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
  await handleNewsReportCommand(chatId, request.argText);
  return true;
}

function looksLikeSafeCommandMetaText(text) {
  const lower = String(text || "").trim().toLowerCase();
  if (!lower) return false;
  if (!/\b(help|status|workers?|workspaces?|queue|queued|restart|reboot|reload)\b/.test(lower)) return false;

  const commandMentions = [
    /\b\/(?:help|status|workers|queue|restart)\b/,
    /\bslash\s+(?:help|status|workers?|queue|restart)\b/,
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
  if (!/\b(help|status|workers?|workspaces?|queue|queued|restart|reboot|reload)\b/.test(lower)) {
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

  if (/^(?:restart|reboot|reload)(?:\s+the)?\s+(?:bot|aidolon|system)?(?:\s+now)?$/.test(candidate)) {
    consider("/restart", 0.97);
  }
  if (/^(?:please\s+)?(?:restart|reboot|reload)(?:\s+bot|\s+aidolon|\s+the\s+bot|\s+the\s+system)?(?:\s+now)?$/.test(candidate)) {
    consider("/restart", 0.94);
  }
  if (/^(?:show|run|do)\s+(?:a\s+)?(?:bot\s+)?restart$/.test(candidate)) {
    consider("/restart", 0.89);
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
    /\b(restart|reboot|reload)\b/.test(candidate) ? "restart" : "",
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

async function runWorldMonitorCheckCommand(chatId, argText, options = {}) {
  const parsed = parseNewsCommandArg(argText);
  const forceAlert = parsed?.forceAlert === true;
  const rawMode = parsed?.rawMode === true;
  const announceStart = options?.announceStart !== false;
  if (rawMode) {
    await runWorldMonitorMonitorCycle({
      source: "manual",
      allowWhenDisabled: true,
      forceAlert,
      replyChatId: chatId,
    });
    return;
  }
  void runWorldMonitorComprehensiveCheck({
    chatId,
    forceAlert,
    announceStart,
    announceQueued: WORLDMONITOR_CHECK_ANNOUNCE_QUEUED,
  }).catch((err) => {
    log(`worldmonitor comprehensive check failed: ${redactError(err?.message || err)}`);
  });
}

function worldMonitorHeadlineTranslationKey(title) {
  return normalizeWorldMonitorTitleForKey(oneLine(String(title || "")).trim());
}

function rememberWorldMonitorHeadlineTranslation(key, value) {
  if (!key) return;
  if (worldMonitorHeadlineTranslationCache.has(key)) {
    worldMonitorHeadlineTranslationCache.delete(key);
  }
  worldMonitorHeadlineTranslationCache.set(key, value);
  while (worldMonitorHeadlineTranslationCache.size > WORLDMONITOR_TRANSLATE_HEADLINES_CACHE_SIZE) {
    const oldest = worldMonitorHeadlineTranslationCache.keys().next().value;
    if (!oldest) break;
    worldMonitorHeadlineTranslationCache.delete(oldest);
  }
}

function parseWorldMonitorHeadlineTranslationPayload(payload) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(payload || ""));
  } catch {
    return { title: "", sourceLang: "" };
  }
  const chunks = Array.isArray(parsed?.[0]) ? parsed[0] : [];
  const title = chunks
    .map((chunk) => (Array.isArray(chunk) ? String(chunk[0] || "") : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const sourceLang = String(parsed?.[2] || "").trim().toLowerCase();
  return { title, sourceLang };
}

async function translateWorldMonitorHeadlineToEnglish(rawTitle, options = {}) {
  const normalizedTitle = oneLine(String(rawTitle || "")).trim();
  if (!normalizedTitle) {
    return {
      title: "",
      sourceLang: "",
      translated: false,
      ok: false,
      skipped: "empty",
    };
  }
  if (!WORLDMONITOR_TRANSLATE_HEADLINES_TO_EN) {
    return {
      title: normalizedTitle,
      sourceLang: "",
      translated: false,
      ok: true,
      skipped: "disabled",
    };
  }

  const cacheKey = worldMonitorHeadlineTranslationKey(normalizedTitle);
  if (cacheKey && worldMonitorHeadlineTranslationCache.has(cacheKey)) {
    const cached = worldMonitorHeadlineTranslationCache.get(cacheKey) || {};
    return {
      title: String(cached.title || normalizedTitle).trim() || normalizedTitle,
      sourceLang: String(cached.sourceLang || "").trim(),
      translated: cached.translated === true,
      ok: true,
      cacheHit: true,
    };
  }
  if (cacheKey && worldMonitorHeadlineTranslationInFlight.has(cacheKey)) {
    return await worldMonitorHeadlineTranslationInFlight.get(cacheKey);
  }

  const timeoutMs = Number(options?.timeoutMs || WORLDMONITOR_TRANSLATE_HEADLINES_TIMEOUT_MS);
  const translationPromise = (async () => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(normalizedTitle)}`;
      const response = await fetchTextUrl(url, { timeoutMs });
      const parsed = parseWorldMonitorHeadlineTranslationPayload(response?.text || "");
      const translatedTitle = oneLine(String(parsed?.title || "")).trim();
      const sourceLang = oneLine(String(parsed?.sourceLang || "")).toLowerCase().trim();
      const sourceLangBase = sourceLang.split(/[-_]/)[0];
      const title = translatedTitle || normalizedTitle;
      const translated = Boolean(
        (sourceLangBase && sourceLangBase !== "en" && sourceLangBase !== "und")
        || (translatedTitle && worldMonitorHeadlineTranslationKey(translatedTitle) !== cacheKey),
      );
      if (cacheKey) {
        rememberWorldMonitorHeadlineTranslation(cacheKey, {
          title,
          sourceLang,
          translated,
          at: Date.now(),
        });
      }
      return { title, sourceLang, translated, ok: true };
    } catch {
      return {
        title: normalizedTitle,
        sourceLang: "",
        translated: false,
        ok: false,
        skipped: "translate_failed",
      };
    }
  })();

  if (cacheKey) {
    worldMonitorHeadlineTranslationInFlight.set(cacheKey, translationPromise);
  }
  try {
    return await translationPromise;
  } finally {
    if (cacheKey) {
      worldMonitorHeadlineTranslationInFlight.delete(cacheKey);
    }
  }
}

async function translateWorldMonitorHeadlineBatchToEnglish(headlines, options = {}) {
  const items = Array.isArray(headlines) ? headlines : [];
  const unique = [];
  const seenKeys = new Set();
  for (const headline of items) {
    const title = oneLine(String(headline || "")).trim();
    if (!title) continue;
    const key = worldMonitorHeadlineTranslationKey(title);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push({ key, title });
  }
  const translatedByKey = new Map();
  if (unique.length === 0) return translatedByKey;
  const concurrency = Math.max(
    1,
    Number(options?.concurrency || WORLDMONITOR_TRANSLATE_HEADLINES_CONCURRENCY || 1) || 1,
  );
  let cursor = 0;
  async function workerLoop() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= unique.length) break;
      const row = unique[idx];
      const translated = await translateWorldMonitorHeadlineToEnglish(row.title, options);
      translatedByKey.set(row.key, oneLine(String(translated?.title || row.title)).trim() || row.title);
    }
  }
  const workers = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(workerLoop());
  }
  await Promise.all(workers);
  return translatedByKey;
}

async function runWorldMonitorNewsListCommand(chatId, argText) {
  const parsed = parseNewsListCommandArg(argText);
  if (!parsed.ok) {
    await sendMessage(chatId, "Usage: /news [force] [count]");
    return;
  }

  const targetMaxItems = toInt(parsed.maxItems, WORLDMONITOR_NEWS_LIST_MAX_ITEMS, 1, 200);
  const refreshLookbackHours = Math.max(48, Number(WORLDMONITOR_CHECK_LOOKBACK_HOURS || 168));
  const refreshSinceMs = Date.now() - (refreshLookbackHours * 60 * 60 * 1000);
  const nowMs = Date.now();
  const lastRefreshAt = Number(worldMonitorMonitor.nativeLastRefreshAt || 0) || 0;
  const hasCachedItems = Array.isArray(worldMonitorNativeNewsItems) && worldMonitorNativeNewsItems.length > 0;
  const staleWindowMs = WORLDMONITOR_NEWS_LIST_REFRESH_STALE_SEC > 0
    ? WORLDMONITOR_NEWS_LIST_REFRESH_STALE_SEC * 1000
    : 0;
  const staleByAge = staleWindowMs > 0 && (!lastRefreshAt || (nowMs - lastRefreshAt) >= staleWindowMs);
  const shouldRefresh = parsed.forceRefresh === true || !hasCachedItems || staleByAge;

  let refreshError = "";
  if (shouldRefresh) {
    const refresh = await runWorldMonitorNativeFeedRefresh({
      force: parsed.forceRefresh === true,
      minPublishedAtMs: refreshSinceMs,
    });
    refreshError = !refresh?.ok ? String(refresh?.error || "").trim() : "";
  }

  const selected = selectWorldMonitorNewsListItems({
    maxItems: targetMaxItems,
    startDay: utcDayKeyNow(),
  });
  const shownItems = Array.isArray(selected?.items) ? selected.items : [];
  if (shownItems.length === 0) {
    const lines = [
      `${fmtBold("News")} no tracked articles found for today or recent fallback days.`,
    ];
    if (refreshError) {
      lines.push(`Refresh warning: ${refreshError}`);
    }
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  const poolSize = Math.max(0, Number(selected?.poolSize || 0) || 0);
  const hiddenCount = Math.max(0, poolSize - shownItems.length);
  const dayCount = Math.max(0, Array.isArray(selected?.dayKeys) ? selected.dayKeys.length : 0);

  const lines = [
    `${fmtBold("News")} showing ${shownItems.length} article${shownItems.length === 1 ? "" : "s"} ranked critical -> high -> medium -> low${dayCount > 0 ? ` across ${dayCount} day${dayCount === 1 ? "" : "s"}` : ""}.`,
  ];
  if (refreshError) {
    lines.push(`Refresh warning: ${refreshError}`);
  }
  if (hiddenCount > 0) {
    lines.push(`Use /news ${Math.min(200, poolSize)} to show more, or /news force to refresh.`);
  }
  lines.push("");
  const translatedTitleByKey = await translateWorldMonitorHeadlineBatchToEnglish(
    shownItems.map((x) => oneLine(String(x?.title || "").trim())),
  );

  for (let i = 0; i < shownItems.length; i += 1) {
    const item = shownItems[i];
    const level = String(item?.threatLevel || "low").trim().toLowerCase() || "low";
    const source = oneLine(String(item?.source || "Unknown").trim() || "Unknown");
    const rawTitle = oneLine(String(item?.title || "").trim());
    const titleKey = worldMonitorHeadlineTranslationKey(rawTitle);
    const title = titleKey
      ? (translatedTitleByKey.get(titleKey) || rawTitle || "(untitled)")
      : (rawTitle || "(untitled)");
    const ts = Number(item?.publishedAt || item?.firstSeenAt || 0) || 0;
    const age = ts > 0 ? formatRelativeAge(ts) : "time unknown";
    const link = normalizeWorldMonitorLink(item?.link || "");
    lines.push(`${i + 1}. [${level}] ${formatWorldMonitorHeadlineLink(title, link)}`);
    lines.push(`   ${source} | ${age}`);
  }

  await sendMessage(chatId, lines.join("\n"));
}

function formatWorldMonitorHeadlineLink(title, link) {
  const safeTitle = oneLine(String(title || "").trim())
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    || "(untitled)";
  const safeLink = normalizeWorldMonitorLink(link || "");
  if (!safeLink) return safeTitle;
  return `[${safeTitle}](${safeLink})`;
}

async function handleNewsCommand(chatId, argText) {
  clearPendingNaturalNewsFollowup(chatId);
  const parsed = parseNewsListCommandArg(argText);
  if (!parsed.ok) {
    await sendMessage(chatId, "Usage: /news [force] [count]");
    return;
  }

  const ack = parsed.forceRefresh
    ? "News request received. Refreshing feeds and preparing severity-ranked headlines..."
    : "News request received. Preparing severity-ranked headlines...";
  await sendMessage(chatId, ack);

  await runWorldMonitorNewsListCommand(chatId, parsed.argText);
}

async function handleNewsReportCommand(chatId, argText) {
  clearPendingNaturalNewsFollowup(chatId);
  await runWorldMonitorCheckCommand(chatId, argText, { announceStart: true });
}

async function fetchTextUrl(url, { headers = {}, timeoutMs = 0, signal } = {}) {
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
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`${res.status} ${String(res.statusText || "request failed").trim()}`.trim());
    }
    return {
      status: Number(res.status || 0) || 0,
      text: String(text || ""),
      contentType: String(res.headers.get("content-type") || "").trim().toLowerCase(),
      finalUrl: String(res.url || url || "").trim(),
    };
  } finally {
    combined.cleanup();
    if (timer) clearTimeout(timer);
  }
}

function formatRelativeAge(timestampMs) {
  const n = Number(timestampMs || 0);
  if (!Number.isFinite(n) || n <= 0) return "never";
  let deltaMs = Date.now() - n;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) deltaMs = 0;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function decodeWorldMonitorXmlText(raw) {
  const text = String(raw || "");
  const withoutCdata = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return withoutCdata
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripWorldMonitorHtml(raw) {
  const text = decodeWorldMonitorXmlText(raw);
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWorldMonitorTitleForKey(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\s+[|]\s+[\p{L}\p{N} .,&'()/-]{2,50}$/u, "")
    .replace(/\s+-\s+[\p{L}\p{N} .,&'()/-]{2,50}$/u, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeWorldMonitorLink(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    const u = new URL(raw);
    const dropKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ocid"];
    for (const k of dropKeys) {
      if (u.searchParams.has(k)) u.searchParams.delete(k);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

function normalizeWorldMonitorOutletName(rawName) {
  return String(rawName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeWorldMonitorOutletHost(rawHost) {
  let host = String(rawHost || "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!host) return "";
  host = host.split(":")[0];
  if (!host) return "";
  return host.startsWith("www.") ? host.slice(4) : host;
}

function worldMonitorOutletHostFromUrl(rawUrl) {
  const url = normalizeWorldMonitorLink(rawUrl || "");
  if (!url) return "";
  try {
    return normalizeWorldMonitorOutletHost(String(new URL(url).hostname || ""));
  } catch {
    return "";
  }
}

function isWorldMonitorBlockedOutletName(rawName) {
  const normalized = normalizeWorldMonitorOutletName(rawName);
  if (!normalized) return false;
  if (WORLDMONITOR_BLOCKED_OUTLET_NAME_SET.has(normalized)) return true;
  for (const blocked of WORLDMONITOR_BLOCKED_OUTLET_NAME_SET) {
    if (!blocked) continue;
    if (normalized.includes(blocked)) return true;
  }
  return false;
}

function isWorldMonitorBlockedOutletHost(rawHost) {
  const normalizedHost = normalizeWorldMonitorOutletHost(rawHost);
  if (!normalizedHost) return false;
  for (const blocked of WORLDMONITOR_BLOCKED_OUTLET_DOMAIN_SET) {
    if (!blocked) continue;
    if (normalizedHost === blocked || normalizedHost.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function isWorldMonitorBlockedOutletSource({ name = "", url = "", host = "" } = {}) {
  if (isWorldMonitorBlockedOutletName(name)) return true;
  const candidateHost = normalizeWorldMonitorOutletHost(host) || worldMonitorOutletHostFromUrl(url);
  return isWorldMonitorBlockedOutletHost(candidateHost);
}

function isWorldMonitorBlockedOutletItem(item) {
  const source = String(item?.source || "").trim();
  const link = String(item?.link || "").trim();
  return isWorldMonitorBlockedOutletSource({ name: source, url: link });
}

function worldMonitorNormalizeNativeThreatLevel(rawValue) {
  const lower = oneLine(String(rawValue || "")).toLowerCase();
  if (!lower) return "";
  const clean = lower
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";

  if (/\b(?:sev(?:erity)?\s*1|priority\s*1|p\s*1)\b/i.test(clean)) return "critical";
  if (/\b(?:sev(?:erity)?\s*2|priority\s*2|p\s*2)\b/i.test(clean)) return "high";
  if (/\b(?:sev(?:erity)?\s*3|priority\s*3|p\s*3)\b/i.test(clean)) return "medium";
  if (/\b(?:sev(?:erity)?\s*4|priority\s*4|p\s*4)\b/i.test(clean)) return "low";

  if (clean === "critical" || clean === "severe" || clean === "emergency") return "critical";
  if (clean === "high" || clean === "major") return "high";
  if (clean === "medium" || clean === "moderate") return "medium";
  if (clean === "low" || clean === "minor" || clean === "info" || clean === "informational") return "low";

  const hasLevelMarker = /\b(?:severity|priority|alert|threat|risk|urgency)\b/.test(clean);
  if (hasLevelMarker && /\b(?:critical|severe|emergency)\b/.test(clean)) return "critical";
  if (hasLevelMarker && /\b(?:high|major)\b/.test(clean)) return "high";
  if (hasLevelMarker && /\b(?:medium|moderate)\b/.test(clean)) return "medium";
  if (hasLevelMarker && /\b(?:low|minor|info|informational)\b/.test(clean)) return "low";
  return "";
}

function worldMonitorThreatLevelForItem(block) {
  const candidates = [
    ...worldMonitorExtractAllXmlTagText(block, WORLDMONITOR_NATIVE_SEVERITY_DIRECT_TAGS),
    ...worldMonitorExtractXmlTagAttributeValues(
      block,
      WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_TAGS,
      WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_ATTRS,
    ),
    ...worldMonitorExtractAllXmlTagText(block, WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_TAGS),
  ];
  for (const value of candidates) {
    const level = worldMonitorNormalizeNativeThreatLevel(value);
    if (level) return level;
  }
  return "low";
}

function worldMonitorTaiwanRelevanceScore(title) {
  const lower = String(title || "").trim().toLowerCase();
  if (!lower) return 0;
  let score = 0;
  for (const kw of WORLDMONITOR_TAIWAN_KEYWORDS) {
    if (!kw) continue;
    if (lower.includes(kw)) score += (kw === "taiwan" || kw === "taipei" || kw === "taiwan strait") ? 3 : 1;
  }
  return score;
}

function worldMonitorSourceWeight(sourceName, feedSection) {
  const lower = String(sourceName || "").toLowerCase();
  if (!lower) return 1;
  if (lower.includes("reuters") || lower.includes("ap news") || lower.includes("bbc") || lower.includes("pentagon")) {
    return 1.35;
  }
  if (String(feedSection || "").toLowerCase() === "intel") return 1.25;
  return 1;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function worldMonitorExtractCountryCodes(title) {
  const lower = String(title || "").toLowerCase();
  if (!lower) return [];
  const out = new Set();
  for (const item of WORLDMONITOR_COUNTRY_PATTERNS) {
    if (!item?.code || !Array.isArray(item.patterns)) continue;
    for (const raw of item.patterns) {
      const token = String(raw || "").trim().toLowerCase();
      if (!token) continue;
      const has = token.endsWith(" ")
        ? lower.includes(token)
        : new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(lower);
      if (has) {
        out.add(item.code);
        break;
      }
    }
  }
  return [...out];
}

function worldMonitorExtractFirstXmlTag(block, tagNames) {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "i");
    const m = String(block || "").match(re);
    if (m && m[1]) {
      const text = stripWorldMonitorHtml(m[1]);
      if (text) return text;
    }
  }
  return "";
}

function worldMonitorExtractAllXmlTagText(block, tagNames) {
  const src = String(block || "");
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  const out = [];
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "gi");
    let m;
    while ((m = re.exec(src)) !== null) {
      const text = stripWorldMonitorHtml(m[1]);
      if (text) out.push(text);
    }
  }
  return out;
}

function worldMonitorExtractXmlTagAttributeValues(block, tagNames, attrNames) {
  const src = String(block || "");
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames];
  const wanted = new Set(
    (Array.isArray(attrNames) ? attrNames : [attrNames])
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const out = [];
  for (const rawTag of tags) {
    const tag = String(rawTag || "").trim();
    if (!tag) continue;
    const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}\\b([^>]*)\\/?>`, "gi");
    let m;
    while ((m = re.exec(src)) !== null) {
      const attrs = String(m[1] || "");
      const attrRe = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let a;
      while ((a = attrRe.exec(attrs)) !== null) {
        const keyRaw = String(a[1] || "").trim().toLowerCase();
        if (!keyRaw) continue;
        const keyBase = keyRaw.includes(":") ? keyRaw.split(":").pop() : keyRaw;
        if (!wanted.has(keyRaw) && !wanted.has(keyBase)) continue;
        const value = decodeWorldMonitorXmlText(String(a[2] || a[3] || a[4] || "").trim());
        if (value) out.push(value);
      }
    }
  }
  return out;
}

function worldMonitorExtractLinkFromItem(block) {
  const src = String(block || "");
  let m = src.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (m && m[1]) return normalizeWorldMonitorLink(m[1]);
  m = src.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (m && m[1]) {
    const inline = stripWorldMonitorHtml(m[1]);
    if (inline && /^https?:\/\//i.test(inline)) return normalizeWorldMonitorLink(inline);
  }
  m = src.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  if (m && m[1]) {
    const guid = stripWorldMonitorHtml(m[1]);
    if (guid && /^https?:\/\//i.test(guid)) return normalizeWorldMonitorLink(guid);
  }
  m = src.match(/<id\b[^>]*>([\s\S]*?)<\/id>/i);
  if (m && m[1]) {
    const id = stripWorldMonitorHtml(m[1]);
    if (id && /^https?:\/\//i.test(id)) return normalizeWorldMonitorLink(id);
  }
  return "";
}

function parseWorldMonitorFeedXml(xmlText, feed, fetchedAt, options = {}) {
  const src = String(xmlText || "");
  if (!src) return [];
  const items = [];
  const blocks = [];
  const itemMatches = src.matchAll(/<item\b[\s\S]*?<\/item>/gi);
  for (const m of itemMatches) blocks.push(m[0]);
  const entryMatches = src.matchAll(/<entry\b[\s\S]*?<\/entry>/gi);
  for (const m of entryMatches) blocks.push(m[0]);
  if (blocks.length === 0) return items;
  const minPublishedAtMsRaw = Number(options?.minPublishedAtMs || 0);
  const minPublishedAtMs = Number.isFinite(minPublishedAtMsRaw)
    ? Math.max(0, Math.trunc(minPublishedAtMsRaw))
    : 0;
  const itemCapRaw = Number(options?.maxItemsPerSource || 0);
  const itemCap = Number.isFinite(itemCapRaw) && itemCapRaw > 0
    ? Math.max(1, Math.trunc(itemCapRaw))
    : WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE;

  for (const block of blocks) {
    const title = worldMonitorExtractFirstXmlTag(block, ["title"]);
    const link = worldMonitorExtractLinkFromItem(block);
    if (!title || !link) continue;
    const sourceName = String(feed?.name || "Unknown").trim() || "Unknown";
    if (isWorldMonitorBlockedOutletSource({ name: sourceName, url: link })) continue;
    const publishedRaw = worldMonitorExtractFirstXmlTag(block, ["pubDate", "published", "updated", "dc:date", "date"]);
    const publishedAt = Number(Date.parse(publishedRaw)) || Number(fetchedAt || Date.now());
    if (minPublishedAtMs > 0 && publishedAt > 0 && publishedAt < minPublishedAtMs) continue;
    const articleKey = normalizeWorldMonitorLink(link)
      || `${String(feed?.name || "").toLowerCase()}|${normalizeWorldMonitorTitleForKey(title)}|${utcDayKeyFromMs(publishedAt)}`;
    const threatLevel = worldMonitorThreatLevelForItem(block);
    const taiwanScore = worldMonitorTaiwanRelevanceScore(title);
    const countries = worldMonitorExtractCountryCodes(title);
    items.push({
      articleKey,
      source: sourceName,
      feedSection: String(feed?.section || "").trim().toLowerCase(),
      feedCategory: String(feed?.category || "").trim().toLowerCase(),
      title: String(title || "").trim(),
      link: normalizeWorldMonitorLink(link),
      publishedAt,
      firstSeenAt: Number(fetchedAt || Date.now()),
      lastSeenAt: Number(fetchedAt || Date.now()),
      threatLevel,
      threatLevelSource: "native-feed-metadata",
      taiwanScore,
      countries,
    });
  }

  const dedup = new Map();
  for (const item of items) {
    const key = String(item.articleKey || "").trim();
    if (!key) continue;
    const prev = dedup.get(key);
    if (!prev) {
      dedup.set(key, item);
      continue;
    }
    if (Number(item.publishedAt || 0) > Number(prev.publishedAt || 0)) dedup.set(key, item);
  }
  return [...dedup.values()]
    .sort((a, b) => Number(b.publishedAt || b.firstSeenAt || 0) - Number(a.publishedAt || a.firstSeenAt || 0))
    .slice(0, itemCap);
}

function decodeWorldMonitorHtmlEntities(raw) {
  const text = decodeWorldMonitorXmlText(raw);
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(String(hex || ""), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#([0-9]+);/g, (_m, dec) => {
      const code = Number.parseInt(String(dec || ""), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : " ";
    });
}

function parseWorldMonitorHtmlMetaMap(htmlText) {
  const src = String(htmlText || "");
  const out = {};
  const tags = src.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const re = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(tag)) !== null) {
      const key = String(m[1] || "").trim().toLowerCase();
      const value = decodeWorldMonitorHtmlEntities(String(m[2] || m[3] || m[4] || "").trim());
      if (!key || !value) continue;
      attrs[key] = value;
    }
    const metaKey = String(attrs.property || attrs.name || "").trim().toLowerCase();
    const content = String(attrs.content || "").trim();
    if (!metaKey || !content) continue;
    if (!(metaKey in out)) out[metaKey] = content;
  }
  return out;
}

function parseWorldMonitorJsonSafe(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some publishers wrap JSON-LD in invalid trailing markers; apply minimal cleanup.
  }
  const cleaned = text
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function appendWorldMonitorJsonLdNodes(target, node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) appendWorldMonitorJsonLdNodes(target, x);
    return;
  }
  if (typeof node !== "object") return;
  const graph = node["@graph"];
  if (Array.isArray(graph) && graph.length > 0) {
    for (const x of graph) appendWorldMonitorJsonLdNodes(target, x);
  }
  target.push(node);
}

function parseWorldMonitorJsonLdNodes(htmlText) {
  const src = String(htmlText || "");
  const nodes = [];
  const matches = src.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of matches) {
    const parsed = parseWorldMonitorJsonSafe(m && m[1] ? m[1] : "");
    appendWorldMonitorJsonLdNodes(nodes, parsed);
  }
  return nodes;
}

function extractWorldMonitorAuthorName(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return oneLine(raw);
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const name = extractWorldMonitorAuthorName(x);
      if (name) return name;
    }
    return "";
  }
  if (typeof raw === "object") {
    const name = oneLine(String(raw.name || raw.alternateName || ""));
    if (name) return name;
  }
  return "";
}

function extractWorldMonitorArticleMetaFromJsonLd(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let best = null;
  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    const typeRaw = node["@type"];
    const types = Array.isArray(typeRaw) ? typeRaw : [typeRaw];
    const joined = types.map((x) => String(x || "").toLowerCase()).join("|");
    if (!joined.includes("article") && !joined.includes("news") && !joined.includes("report")) continue;
    const body = decodeWorldMonitorHtmlEntities(String(node.articleBody || node.text || "")).replace(/\s+/g, " ").trim();
    const headline = oneLine(String(node.headline || node.name || ""));
    const description = oneLine(String(node.description || ""));
    const dateRaw = String(node.datePublished || node.dateCreated || node.uploadDate || "");
    const publishedAt = Number(Date.parse(dateRaw)) || 0;
    const siteName = oneLine(String(node?.publisher?.name || node?.isPartOf?.name || ""));
    const author = extractWorldMonitorAuthorName(node.author);
    const score = (body.length * 2) + (headline.length > 0 ? 300 : 0) + description.length;
    if (!best || score > best.score) {
      best = {
        score,
        headline,
        description,
        body,
        publishedAt,
        siteName,
        author,
      };
    }
  }
  return best;
}

function extractWorldMonitorLargestTagBlock(htmlText, tagNames) {
  const src = String(htmlText || "");
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames];
  let best = "";
  for (const rawTag of tags) {
    const tag = String(rawTag || "").trim();
    if (!tag) continue;
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    const matches = src.match(re) || [];
    for (const block of matches) {
      if (String(block || "").length > best.length) best = String(block || "");
    }
  }
  return best;
}

function isWorldMonitorBoilerplateLine(line) {
  const lower = String(line || "").trim().toLowerCase();
  if (!lower) return true;
  if (lower.length < 30) return true;
  return (
    lower.startsWith("subscribe ")
    || lower.startsWith("sign up ")
    || lower.startsWith("all rights reserved")
    || lower.startsWith("copyright ")
    || lower.startsWith("advertisement")
    || lower.startsWith("read more")
    || lower.startsWith("related")
    || lower.startsWith("recommended")
    || lower.startsWith("follow us")
    || lower.startsWith("cookie ")
    || lower.startsWith("privacy ")
    || lower.startsWith("terms ")
  );
}

function extractWorldMonitorTextFromHtml(htmlText) {
  const src = String(htmlText || "");
  if (!src) return "";
  const articleBlock = extractWorldMonitorLargestTagBlock(src, ["article"]);
  const mainBlock = extractWorldMonitorLargestTagBlock(src, ["main"]);
  const bodyBlock = extractWorldMonitorLargestTagBlock(src, ["body"]);
  let block = articleBlock || mainBlock || bodyBlock || src;
  block = block
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<(br|\/p|\/div|\/section|\/article|\/main|\/li|\/h[1-6]|\/tr|\/td|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const raw = decodeWorldMonitorHtmlEntities(block);
  const lines = raw.split(/\n+/).map((x) => oneLine(x)).filter(Boolean);
  const dedup = new Set();
  const kept = [];
  for (const line of lines) {
    if (isWorldMonitorBoilerplateLine(line)) continue;
    const key = normalizeWorldMonitorTitleForKey(line);
    if (!key || dedup.has(key)) continue;
    dedup.add(key);
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function trimWorldMonitorWords(text, maxWords) {
  const src = String(text || "").trim();
  if (!src) return "";
  const limit = Math.max(1, Math.trunc(Number(maxWords || 1)));
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return src;
  return words.slice(0, limit).join(" ");
}

function buildWorldMonitorArticleKeywords(item, title, description) {
  const raw = [
    String(item?.title || ""),
    String(title || ""),
    String(description || ""),
    ...WORLDMONITOR_TAIWAN_KEYWORDS,
  ].join(" ");
  const tokens = normalizeWorldMonitorTitleForKey(raw)
    .split(/\s+/)
    .map((x) => String(x || "").trim())
    .filter((x) => x.length >= 4);
  const stop = new Set([
    "with", "from", "that", "this", "were", "have", "into", "after", "before", "about",
    "their", "there", "which", "while", "where", "over", "more", "than", "when", "what",
    "said", "says", "will", "would", "could", "should", "news", "report", "reports", "today",
  ]);
  const out = [];
  for (const t of tokens) {
    if (stop.has(t)) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= 28) break;
  }
  return out;
}

function scoreWorldMonitorSummarySentence(sentence, keywords) {
  const text = String(sentence || "").trim();
  if (!text) return -100;
  const lower = text.toLowerCase();
  if (isWorldMonitorBoilerplateLine(text)) return -100;
  let score = 0;
  if (text.length >= 50 && text.length <= 260) score += 3;
  else if (text.length >= 35 && text.length <= 340) score += 1;
  if (/\b\d{2,}\b/.test(text)) score += 1;
  if (/(said|announced|reported|warned|confirmed|deployed|launched|sanction|ceasefire|exercise)/i.test(text)) score += 1.3;
  if (/(taiwan|china|beijing|strait|south china sea|east china sea|military|missile|naval)/i.test(lower)) score += 1.2;
  for (const kw of keywords) {
    if (!kw) continue;
    if (lower.includes(kw)) score += 0.35;
  }
  return score;
}

function summarizeWorldMonitorArticleText(item, title, description, articleText) {
  const text = String(articleText || "").replace(/\s+/g, " ").trim();
  const desc = oneLine(String(description || ""));
  const merged = [desc, text].filter(Boolean).join(" ");
  const sentences = splitIntoSentencesBestEffort(merged)
    .map((x) => oneLine(x))
    .filter((x) => x.length >= 35);
  const keywords = buildWorldMonitorArticleKeywords(item, title, description);
  const scored = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    const score = scoreWorldMonitorSummarySentence(sentence, keywords);
    if (score <= -10) continue;
    scored.push({ sentence, score, idx: i });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });

  const selected = [];
  const seen = new Set();
  for (const row of scored) {
    const key = normalizeWorldMonitorTitleForKey(row.sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(row.sentence);
    if (selected.length >= 5) break;
  }

  let summary = selected.join(" ").trim();
  if (!summary) {
    summary = desc || text || oneLine(String(title || item?.title || ""));
  }
  summary = trimWorldMonitorWords(summary, WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS);
  summary = summary.slice(0, WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_CHARS).trim();

  const keyPoints = selected
    .slice(0, 3)
    .map((x) => x.slice(0, 260).trim())
    .filter(Boolean);
  return {
    summary,
    keyPoints,
  };
}

async function fetchAndSummarizeWorldMonitorArticle(item, options = {}) {
  const link = normalizeWorldMonitorLink(item?.link || "");
  if (!/^https?:\/\//i.test(link)) {
    throw new Error("invalid article link");
  }
  const timeoutMs = Number(options?.timeoutMs || 0);
  const signal = options?.signal;
  const resp = await fetchTextUrl(link, {
    timeoutMs,
    signal,
    headers: {
      "User-Agent": REDDIT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
    },
  });
  const html = String(resp?.text || "");
  if (!html) {
    throw new Error("empty html");
  }
  const meta = parseWorldMonitorHtmlMetaMap(html);
  const jsonLdNodes = parseWorldMonitorJsonLdNodes(html);
  const articleMeta = extractWorldMonitorArticleMetaFromJsonLd(jsonLdNodes);
  const title = oneLine(
    String(
      articleMeta?.headline
      || meta["og:title"]
      || meta["twitter:title"]
      || worldMonitorExtractFirstXmlTag(html, ["title"])
      || item?.title
      || "",
    ),
  );
  const description = oneLine(
    String(
      articleMeta?.description
      || meta["og:description"]
      || meta["twitter:description"]
      || meta.description
      || "",
    ),
  );
  const articleBody = String(articleMeta?.body || "").trim();
  const bodyFromHtml = extractWorldMonitorTextFromHtml(html);
  let text = articleBody.length >= 280 ? articleBody : [description, bodyFromHtml].filter(Boolean).join(" ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > WORLDMONITOR_DEEP_INGEST_MAX_TEXT_CHARS) {
    text = text.slice(0, WORLDMONITOR_DEEP_INGEST_MAX_TEXT_CHARS).trim();
  }
  if (text.length < 220 && description) {
    text = [description, text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  if (text.length < 120) {
    throw new Error("article text too short");
  }

  const lang = String(
    meta["og:locale"]
    || (String(html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1] || "").trim())
    || "",
  ).trim().toLowerCase();
  const publishedAt = Number(articleMeta?.publishedAt || 0)
    || Number(Date.parse(String(meta["article:published_time"] || meta["og:published_time"] || "")))
    || 0;
  const siteName = oneLine(
    String(articleMeta?.siteName || meta["og:site_name"] || meta["application-name"] || ""),
  );
  const author = oneLine(String(articleMeta?.author || meta.author || ""));
  const summaryPack = summarizeWorldMonitorArticleText(item, title, description, text);
  const textWords = text.split(/\s+/).filter(Boolean).length;

  return {
    status: "ok",
    fetchedAt: Date.now(),
    finalUrl: String(resp?.finalUrl || link || "").trim(),
    contentType: String(resp?.contentType || "").trim(),
    articleTitle: title || oneLine(String(item?.title || "")),
    description: description || "",
    summary: String(summaryPack.summary || "").trim(),
    keyPoints: Array.isArray(summaryPack.keyPoints) ? summaryPack.keyPoints : [],
    articlePublishedAt: publishedAt > 0 ? publishedAt : 0,
    siteName: siteName || "",
    author: author || "",
    lang: lang || "",
    textChars: text.length,
    textWords,
  };
}

function getWorldMonitorItemArticleContext(item) {
  return item && typeof item.articleContext === "object" && item.articleContext
    ? item.articleContext
    : null;
}

function isAbortLikeError(err) {
  const name = String(err?.name || "").trim();
  if (name === "AbortError") return true;
  const message = String(err?.message || err || "").trim().toLowerCase();
  return (
    message.includes("aborted")
    || message.includes("abort")
    || message.includes("canceled")
    || message.includes("cancelled")
  );
}

function worldMonitorDeepIngestCapLabel() {
  if (WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE > 0) {
    return String(WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE);
  }
  if (WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE > 0) {
    return `auto:${WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE}`;
  }
  return "unlimited";
}

function resolveWorldMonitorDeepIngestTargetCount(candidateCount, options = {}) {
  const total = Math.max(0, Math.trunc(Number(candidateCount || 0)));
  if (total <= 0) return 0;
  const configuredCap = Math.max(0, Number(WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE || 0));
  const autoCap = Math.max(0, Number(WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE || 0));
  let cap = configuredCap > 0 ? configuredCap : autoCap;
  const stageBudgetMsRaw = Number(options?.stageBudgetMs || options?.budgetMs || 0);
  const stageBudgetMs = Number.isFinite(stageBudgetMsRaw) && stageBudgetMsRaw > 0
    ? Math.max(1_000, Math.trunc(stageBudgetMsRaw))
    : 0;
  if (stageBudgetMs > 0) {
    const timeoutMs = Math.max(1_000, Number(WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS || 0) || 1_000);
    const estimatedPerArticleMs = Math.max(1_000, Math.min(8_000, Math.round(timeoutMs * 0.65)));
    const budgetCap = Math.max(1, Math.floor(stageBudgetMs / estimatedPerArticleMs));
    cap = cap > 0 ? Math.min(cap, budgetCap) : budgetCap;
  }
  if (cap <= 0) return total;
  return Math.max(1, Math.min(total, cap));
}

function resolveWorldMonitorDeepIngestConcurrency(candidateCount, options = {}) {
  const configured = Math.max(1, Number(WORLDMONITOR_DEEP_INGEST_CONCURRENCY || 1));
  const count = Math.max(0, Math.trunc(Number(candidateCount || 0)));
  if (count <= 0) return 1;
  let effective = configured;
  if (count >= 24) {
    effective = Math.min(effective, 2);
  } else if (count >= 12) {
    effective = Math.min(effective, 3);
  }
  const stageBudgetMsRaw = Number(options?.stageBudgetMs || 0);
  const stageBudgetMs = Number.isFinite(stageBudgetMsRaw) && stageBudgetMsRaw > 0
    ? Math.max(1_000, Math.trunc(stageBudgetMsRaw))
    : 0;
  if (stageBudgetMs > 0) {
    effective = Math.min(effective, 2);
  }
  return Math.max(1, Math.min(effective, count));
}

function buildWorldMonitorDeepIngestCandidates(options = {}) {
  const force = options?.force === true;
  const now = Date.now();
  const retryCooldownMs = Math.max(0, Number(WORLDMONITOR_DEEP_INGEST_RETRY_COOLDOWN_SEC || 0) * 1000);
  const lookbackHours = Math.max(0, Number(WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS || 0));
  const lookbackMs = lookbackHours > 0 ? (lookbackHours * 60 * 60 * 1000) : 0;
  const seedSet = new Set(
    (Array.isArray(options?.seedKeys) ? options.seedKeys : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean),
  );
  const candidates = [];
  for (const item of worldMonitorNativeNewsItems) {
    const link = normalizeWorldMonitorLink(item?.link || "");
    if (!/^https?:\/\//i.test(link)) continue;
    const ts = Number(item?.publishedAt || item?.firstSeenAt || item?.lastSeenAt || 0) || 0;
    if (lookbackMs > 0 && ts > 0 && (now - ts) > lookbackMs) continue;
    const ctx = getWorldMonitorItemArticleContext(item);
    if (!force && ctx && String(ctx.status || "").toLowerCase() === "ok" && String(ctx.summary || "").trim()) {
      continue;
    }
    if (
      !force
      && ctx
      && String(ctx.status || "").toLowerCase() === "error"
      && Number(ctx.fetchedAt || 0) > 0
      && (now - Number(ctx.fetchedAt || 0)) < retryCooldownMs
    ) {
      continue;
    }

    let score = 0;
    const articleKey = String(item?.articleKey || "").trim();
    if (articleKey && seedSet.has(articleKey)) score += 200;
    score += worldMonitorFeedAlertLevelRank(item?.threatLevel || "low") * 30;
    score += Math.min(36, Math.max(0, Number(item?.taiwanScore || 0)) * 8);
    if (String(item?.feedSection || "").toLowerCase() === "intel") score += 10;
    if (String(item?.feedCategory || "").toLowerCase().includes("middleeast")) score += 2;
    if (String(item?.feedCategory || "").toLowerCase().includes("asia")) score += 4;
    const ageH = ts > 0 ? ((now - ts) / (60 * 60 * 1000)) : 9999;
    if (Number.isFinite(ageH) && ageH >= 0) {
      score += Math.max(0, (72 - ageH) / 3);
    }
    if (!ctx || !ctx.fetchedAt) score += 8;
    candidates.push({ item, score, ts });
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Number(b.ts || 0) - Number(a.ts || 0);
  });
  return candidates;
}

function buildWorldMonitorDeepIngestStatsBase() {
  return {
    enabled: WORLDMONITOR_DEEP_INGEST_ENABLED,
    timeout_ms: WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS,
    concurrency: WORLDMONITOR_DEEP_INGEST_CONCURRENCY,
    max_per_cycle: WORLDMONITOR_DEEP_INGEST_MAX_PER_CYCLE,
    auto_max_per_cycle: WORLDMONITOR_DEEP_INGEST_AUTO_MAX_PER_CYCLE,
    stage_budget_config_ms: WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS,
    lookback_hours: WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS,
    summary_max_words: WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS,
    selected: 0,
    effective_concurrency: 0,
    stage_budget_ms: 0,
    stage_budget_hit: false,
    scanned: 0,
    completed: 0,
    errors: 0,
    remaining_pending: 0,
    sample_errors: [],
  };
}

async function runWorldMonitorNativeDeepIngest(options = {}) {
  if (!WORLDMONITOR_DEEP_INGEST_ENABLED) {
    const stats = buildWorldMonitorDeepIngestStatsBase();
    stats.skipped = "disabled";
    return { ok: true, skipped: "disabled", stats };
  }
  if (worldMonitorNativeRuntime.deepIngestPromise) {
    return worldMonitorNativeRuntime.deepIngestPromise;
  }

  const promise = (async () => {
    const startedAt = Date.now();
    const stats = buildWorldMonitorDeepIngestStatsBase();
    const stageBudgetMsRaw = Number(options?.stageBudgetMs || 0);
    const stageBudgetMs = Number.isFinite(stageBudgetMsRaw) && stageBudgetMsRaw > 0
      ? Math.max(1_000, Math.trunc(stageBudgetMsRaw))
      : 0;
    stats.stage_budget_ms = stageBudgetMs;
    const allCandidates = buildWorldMonitorDeepIngestCandidates(options);
    const targetCount = resolveWorldMonitorDeepIngestTargetCount(allCandidates.length, { stageBudgetMs });
    const candidates = targetCount > 0 ? allCandidates.slice(0, targetCount) : [];
    stats.scanned = allCandidates.length;
    stats.selected = candidates.length;
    if (candidates.length <= 0) {
      worldMonitorMonitor.nativeDeepIngestLastRunAt = Date.now();
      worldMonitorMonitor.nativeDeepIngestLastDurationMs = Date.now() - startedAt;
      worldMonitorMonitor.nativeDeepIngestLastErrorAt = 0;
      worldMonitorMonitor.nativeDeepIngestLastError = "";
      worldMonitorMonitor.nativeDeepIngestLastStats = stats;
      persistState();
      return {
        ok: true,
        refreshedAt: worldMonitorMonitor.nativeDeepIngestLastRunAt,
        durationMs: worldMonitorMonitor.nativeDeepIngestLastDurationMs,
        stats,
      };
    }

    let stageBudgetHit = false;
    const deadlineAt = stageBudgetMs > 0 ? (startedAt + stageBudgetMs) : 0;
    const stageController = stageBudgetMs > 0 ? new AbortController() : null;
    const stageTimer = stageBudgetMs > 0
      ? setTimeout(() => {
        stageBudgetHit = true;
        if (stageController && !stageController.signal.aborted) {
          stageController.abort();
        }
      }, stageBudgetMs)
      : null;
    let cursor = 0;
    const concurrency = resolveWorldMonitorDeepIngestConcurrency(candidates.length, { stageBudgetMs });
    stats.effective_concurrency = concurrency;
    async function workerLoop() {
      for (;;) {
        if (stageBudgetHit) break;
        if (deadlineAt > 0 && Date.now() >= deadlineAt) {
          stageBudgetHit = true;
          if (stageController && !stageController.signal.aborted) {
            stageController.abort();
          }
          break;
        }
        const idx = cursor;
        cursor += 1;
        if (idx >= candidates.length) break;
        const candidate = candidates[idx];
        const item = candidate && candidate.item ? candidate.item : null;
        if (!item) continue;
        try {
          const packed = await fetchAndSummarizeWorldMonitorArticle(item, {
            timeoutMs: WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS,
            signal: stageController ? stageController.signal : undefined,
          });
          item.articleContext = packed;
          stats.completed += 1;
        } catch (err) {
          stats.errors += 1;
          const message = String(err?.message || err || "deep ingest failed").trim() || "deep ingest failed";
          const budgetAbort = Boolean(
            stageController
            && stageController.signal.aborted
            && stageBudgetMs > 0
            && isAbortLikeError(err),
          );
          if (budgetAbort) {
            stageBudgetHit = true;
            stats.errors = Math.max(0, stats.errors - 1);
            break;
          }
          item.articleContext = {
            status: "error",
            fetchedAt: Date.now(),
            error: message.slice(0, 220),
          };
          if (stats.sample_errors.length < 12) {
            const src = oneLine(String(item?.source || "Unknown"));
            const title = oneLine(String(item?.title || "")).slice(0, 80);
            stats.sample_errors.push(`${src}: ${title || "untitled"} (${message})`);
          }
        } finally {
          // Yield to keep the event loop responsive between article parses.
          await sleep(0);
        }
      }
    }
    try {
      const workers = [];
      for (let i = 0; i < concurrency; i += 1) workers.push(workerLoop());
      await Promise.all(workers);
    } finally {
      if (stageTimer) clearTimeout(stageTimer);
    }

    const pendingNow = buildWorldMonitorDeepIngestCandidates({ force: false, seedKeys: [] }).length;
    stats.remaining_pending = pendingNow;
    stats.stage_budget_hit = stageBudgetHit;

    worldMonitorMonitor.nativeDeepIngestLastRunAt = Date.now();
    worldMonitorMonitor.nativeDeepIngestLastDurationMs = Date.now() - startedAt;
    worldMonitorMonitor.nativeDeepIngestLastErrorAt = 0;
    worldMonitorMonitor.nativeDeepIngestLastError = "";
    worldMonitorMonitor.nativeDeepIngestLastStats = stats;
    persistState();

    return {
      ok: true,
      refreshedAt: Number(worldMonitorMonitor.nativeDeepIngestLastRunAt || Date.now()) || Date.now(),
      durationMs: Number(worldMonitorMonitor.nativeDeepIngestLastDurationMs || 0) || 0,
      stats,
    };
  })().catch((err) => {
    const message = String(err?.message || err || "native deep ingest failed").trim() || "native deep ingest failed";
    worldMonitorMonitor.nativeDeepIngestLastErrorAt = Date.now();
    worldMonitorMonitor.nativeDeepIngestLastError = message;
    persistState();
    return { ok: false, error: message, refreshedAt: Date.now(), stats: buildWorldMonitorDeepIngestStatsBase() };
  }).finally(() => {
    worldMonitorNativeRuntime.deepIngestPromise = null;
  });

  worldMonitorNativeRuntime.deepIngestPromise = promise;
  return promise;
}

function loadWorldMonitorNativeFeedManifest() {
  if (Array.isArray(worldMonitorNativeFeedManifest) && worldMonitorNativeFeedManifest.length > 0) {
    return worldMonitorNativeFeedManifest;
  }
  const raw = readJson(WORLDMONITOR_NATIVE_FEEDS_PATH, []);
  const list = Array.isArray(raw) ? raw : [];
  const dedup = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const url = normalizeWorldMonitorLink(String(item.url || "").trim());
    const name = String(item.name || "").trim();
    if (!name || !url) continue;
    if (isWorldMonitorBlockedOutletSource({ name, url })) continue;
    const key = url.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.set(key, {
      name,
      url,
      section: String(item.section || "").trim().toLowerCase(),
      category: String(item.category || "").trim().toLowerCase(),
    });
  }
  worldMonitorNativeFeedManifest = [...dedup.values()];
  return worldMonitorNativeFeedManifest;
}

function pruneWorldMonitorNativeStore(nowMs = Date.now()) {
  const maxAgeMs = Math.max(1, Number(WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS || 30)) * 24 * 60 * 60 * 1000;
  const minTime = Number(nowMs || Date.now()) - maxAgeMs;
  const kept = [];
  for (const item of worldMonitorNativeNewsItems) {
    if (isWorldMonitorBlockedOutletItem(item)) continue;
    const lastSeen = Number(item?.lastSeenAt || item?.firstSeenAt || item?.publishedAt || 0) || 0;
    if (lastSeen < minTime) continue;
    kept.push(item);
  }
  kept.sort((a, b) => Number(a.lastSeenAt || 0) - Number(b.lastSeenAt || 0));
  while (kept.length > WORLDMONITOR_NATIVE_STORE_MAX_ITEMS) kept.shift();
  worldMonitorNativeNewsItems.length = 0;
  worldMonitorNativeNewsItems.push(...kept);
}

function worldMonitorNonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function worldMonitorLatestSeriesItem(series) {
  if (!Array.isArray(series) || series.length <= 0) return null;
  return series[series.length - 1] || null;
}

function worldMonitorIsLikelyMilitaryCallsign(callsign) {
  const clean = String(callsign || "").toUpperCase().trim();
  if (!clean) return false;
  for (const prefix of WORLDMONITOR_MILITARY_CALLSIGN_PREFIXES) {
    if (clean.startsWith(prefix)) return true;
  }
  if (/^[A-Z]{4,}\d{1,3}$/.test(clean)) return true;
  if (/^[A-Z]{3}\d{1,2}$/.test(clean)) {
    if (!WORLDMONITOR_COMMERCIAL_CALLSIGN_PREFIXES.has(clean.slice(0, 3))) return true;
  }
  return false;
}

function worldMonitorAdsbAircraftClass(callsign) {
  const clean = String(callsign || "").toUpperCase().trim();
  if (!clean) return "unknown";
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(clean)) return "tanker";
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(clean)) return "awacs";
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(clean)) return "transport";
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(clean)) return "drone";
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(clean)) return "bomber";
  return "unknown";
}

function worldMonitorAdsbInBounds(lat, lon, bounds) {
  if (!bounds || typeof bounds !== "object") return false;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  return la >= Number(bounds.south) && la <= Number(bounds.north) && lo >= Number(bounds.west) && lo <= Number(bounds.east);
}

function normalizeWorldMonitorServiceIndicator(indicator) {
  const clean = String(indicator || "").trim().toLowerCase();
  if (!clean) return "unknown";
  if (clean === "none" || clean === "operational") return "ok";
  if (clean === "minor" || clean === "degraded") return "degraded";
  if (clean === "major" || clean === "critical" || clean === "outage") return "outage";
  return clean;
}

function pruneWorldMonitorNativeSignals(nowMs = Date.now()) {
  const maxAgeMs = Math.max(1, Number(WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS || 90)) * 24 * 60 * 60 * 1000;
  const minTs = Number(nowMs || Date.now()) - maxAgeMs;
  const maxPerSeries = Math.max(400, Math.trunc((WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS || 90) * (24 * 60 / 5) * 1.25));
  const keys = ["marketSeries", "cryptoSeries", "seismicSeries", "infrastructureSeries", "adsbSeries", "disasterSeries", "maritimeSeries", "serviceSeries", "macroSeries", "predictionSeries"];
  for (const key of keys) {
    const src = Array.isArray(worldMonitorNativeSignals[key]) ? worldMonitorNativeSignals[key] : [];
    const kept = src
      .filter((x) => Number(x?.ts || 0) >= minTs)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    while (kept.length > maxPerSeries) kept.shift();
    worldMonitorNativeSignals[key] = kept;
  }
}

function pushWorldMonitorSignalSample(seriesKey, sample) {
  if (!sample || typeof sample !== "object") return;
  const ts = Number(sample.ts || 0) || Date.now();
  const normalized = { ...sample, ts };
  const arr = Array.isArray(worldMonitorNativeSignals[seriesKey]) ? worldMonitorNativeSignals[seriesKey] : [];
  arr.push(normalized);
  worldMonitorNativeSignals[seriesKey] = arr;
}

function parseYahooChartPoint(data) {
  const chart = data?.chart && typeof data.chart === "object" ? data.chart : null;
  const result = Array.isArray(chart?.result) && chart.result[0] ? chart.result[0] : null;
  if (!result) return null;
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  if (ts.length === 0 || closes.length === 0) return null;
  const points = [];
  for (let i = 0; i < Math.min(ts.length, closes.length); i += 1) {
    const close = Number(closes[i]);
    const t = Number(ts[i]) * 1000;
    if (!Number.isFinite(close) || !Number.isFinite(t) || t <= 0) continue;
    points.push({ close, t });
  }
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const changePct = prev && Number(prev.close || 0) !== 0
    ? ((Number(last.close || 0) - Number(prev.close || 0)) / Number(prev.close || 1)) * 100
    : 0;
  return {
    price: Number(last.close),
    prevClose: prev ? Number(prev.close) : Number(last.close),
    changePct: Number(changePct),
    asOf: Number(last.t),
  };
}

function parseYahooCloseSeries(data) {
  const chart = data?.chart && typeof data.chart === "object" ? data.chart : null;
  const result = Array.isArray(chart?.result) && chart.result[0] ? chart.result[0] : null;
  if (!result) return [];
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  if (ts.length === 0 || closes.length === 0) return [];
  const points = [];
  for (let i = 0; i < Math.min(ts.length, closes.length); i += 1) {
    const close = Number(closes[i]);
    const t = Number(ts[i]) * 1000;
    if (!Number.isFinite(close) || !Number.isFinite(t) || t <= 0) continue;
    points.push({ t, close });
  }
  return points;
}

function rateOfChangeFromSeries(points, periodsBack) {
  const series = Array.isArray(points) ? points : [];
  const back = Math.max(1, Math.trunc(Number(periodsBack) || 1));
  if (series.length <= back) return null;
  const latest = Number(series[series.length - 1]?.close);
  const past = Number(series[series.length - 1 - back]?.close);
  if (!Number.isFinite(latest) || !Number.isFinite(past) || past === 0) return null;
  return ((latest - past) / past) * 100;
}

async function fetchYahooQuote(symbol, timeoutMs) {
  const encoded = encodeURIComponent(String(symbol || "").trim());
  if (!encoded) throw new Error("symbol missing");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const point = parseYahooChartPoint(data);
  if (!point) throw new Error("chart point unavailable");
  return point;
}

async function fetchYahooSeries(symbol, timeoutMs, { range = "1y", interval = "1d" } = {}) {
  const encoded = encodeURIComponent(String(symbol || "").trim());
  if (!encoded) throw new Error("symbol missing");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  return parseYahooCloseSeries(data);
}

async function fetchWorldMonitorNativeMarketSnapshot(timeoutMs) {
  const out = {};
  const errors = [];
  const symbols = Object.keys(WORLDMONITOR_MARKET_SYMBOLS);
  const jobs = symbols.map((symbol) => (async () => {
    const label = WORLDMONITOR_MARKET_SYMBOLS[symbol];
    try {
      const point = await fetchYahooQuote(symbol, timeoutMs);
      out[label] = {
        price: Number(point.price || 0),
        changePct: Number(point.changePct || 0),
        asOf: Number(point.asOf || 0),
      };
    } catch (err) {
      if (errors.length < 12) {
        errors.push(`${label}: ${String(err?.message || err || "").trim() || "fetch failed"}`);
      }
    }
  })());
  await Promise.all(jobs);
  return {
    ts: Date.now(),
    metrics: out,
    errorCount: errors.length,
    sampleErrors: errors,
  };
}

async function fetchWorldMonitorNativeCryptoSnapshot(timeoutMs) {
  const ids = [
    "bitcoin", "ethereum", "tether", "usd-coin", "binancecoin", "solana", "ripple", "cardano",
  ];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true`;
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const map = {
    bitcoin: "BTC",
    ethereum: "ETH",
    tether: "USDT",
    "usd-coin": "USDC",
    binancecoin: "BNB",
    solana: "SOL",
    ripple: "XRP",
    cardano: "ADA",
  };
  const metrics = {};
  for (const [id, label] of Object.entries(map)) {
    const row = worldMonitorNonEmptyObject(data?.[id]);
    const usd = Number(row.usd);
    const ch24 = Number(row.usd_24h_change);
    if (!Number.isFinite(usd)) continue;
    metrics[label] = {
      usd,
      change24hPct: Number.isFinite(ch24) ? ch24 : 0,
    };
  }
  return {
    ts: Date.now(),
    metrics,
  };
}

async function fetchWorldMonitorNativeSeismicSnapshot(timeoutMs) {
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const features = Array.isArray(data?.features) ? data.features : [];
  const events = features
    .map((f) => ({
      mag: Number(f?.properties?.mag || 0) || 0,
      place: String(f?.properties?.place || "").trim(),
      time: Number(f?.properties?.time || 0) || 0,
      url: normalizeWorldMonitorLink(String(f?.properties?.url || "").trim()),
    }))
    .filter((x) => Number.isFinite(x.mag) && x.time > 0)
    .sort((a, b) => Number(b.mag || 0) - Number(a.mag || 0));
  const major = events.filter((x) => Number(x.mag || 0) >= 5).slice(0, 8);
  return {
    ts: Date.now(),
    count24h: events.length,
    majorCount24h: major.length,
    maxMag24h: events.length > 0 ? Number(events[0].mag || 0) : 0,
    majorEvents: major,
  };
}

async function fetchWorldMonitorNativeAdsbSnapshot(timeoutMs) {
  const bounds = WORLDMONITOR_NATIVE_ADSB_REGION;
  const qs = new URLSearchParams({
    lamin: String(bounds.lamin),
    lamax: String(bounds.lamax),
    lomin: String(bounds.lomin),
    lomax: String(bounds.lomax),
  });
  const url = `https://opensky-network.org/api/states/all?${qs.toString()}`;
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const rows = Array.isArray(data?.states) ? data.states : [];
  const byId = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const idRaw = String(row?.[0] || "").trim().toLowerCase();
    const callsign = String(row?.[1] || "").trim().toUpperCase();
    const lon = Number(row?.[5]);
    const lat = Number(row?.[6]);
    const onGround = row?.[8] === true;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || onGround) continue;
    const id = idRaw || `${callsign}|${Math.round(lat * 100)}|${Math.round(lon * 100)}`;
    if (!id || byId.has(id)) continue;
    const military = worldMonitorIsLikelyMilitaryCallsign(callsign);
    byId.set(id, {
      id,
      callsign,
      lat,
      lon,
      military,
      type: military ? worldMonitorAdsbAircraftClass(callsign) : "unknown",
    });
  }
  const flights = [...byId.values()];
  const militaryFlights = flights.filter((x) => x.military);
  const byType = {
    tanker: 0,
    awacs: 0,
    transport: 0,
    drone: 0,
    bomber: 0,
    unknown: 0,
  };
  for (const f of militaryFlights) {
    const type = String(f?.type || "unknown").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(byType, type)) byType[type] += 1;
    else byType.unknown += 1;
  }

  const theaterCounts = WORLDMONITOR_NATIVE_ADSB_THEATERS.map((theater) => {
    const inTheater = flights.filter((f) => worldMonitorAdsbInBounds(f.lat, f.lon, theater.bounds));
    const militaryInTheater = inTheater.filter((f) => f.military);
    const typeCounts = {
      tanker: 0,
      awacs: 0,
      transport: 0,
      drone: 0,
      bomber: 0,
      unknown: 0,
    };
    for (const f of militaryInTheater) {
      const type = String(f?.type || "unknown").toLowerCase();
      if (Object.prototype.hasOwnProperty.call(typeCounts, type)) typeCounts[type] += 1;
      else typeCounts.unknown += 1;
    }
    return {
      id: theater.id,
      name: theater.name,
      totalFlights: inTheater.length,
      militaryFlights: militaryInTheater.length,
      byType: typeCounts,
    };
  });

  const taiwanTheater = theaterCounts.find((x) => x.id === "taiwan_strait");
  const sampleCallsigns = militaryFlights
    .map((x) => String(x?.callsign || "").trim())
    .filter(Boolean)
    .slice(0, 14);

  return {
    ts: Date.now(),
    source: "opensky",
    queryBounds: bounds,
    totalFlights: flights.length,
    militaryFlights: militaryFlights.length,
    militaryRatioPct: flights.length > 0 ? (militaryFlights.length / flights.length) * 100 : 0,
    taiwanTheaterFlights: Number(taiwanTheater?.totalFlights || 0) || 0,
    taiwanMilitaryFlights: Number(taiwanTheater?.militaryFlights || 0) || 0,
    byType,
    theaterCounts,
    sampleCallsigns,
  };
}

async function fetchWorldMonitorNativeDisasterSnapshot(timeoutMs) {
  const url = "https://www.gdacs.org/xml/rss.xml";
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const useTimeout = Number.isFinite(ms) && ms > 0;
  const timer = useTimeout ? setTimeout(() => controller.abort(), ms) : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent": REDDIT_USER_AGENT,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${String(res.statusText || "request failed").trim()}`.trim());
    }
    const blocks = [];
    for (const m of String(text || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
      blocks.push(m[0]);
      if (blocks.length >= 260) break;
    }

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const events = [];
    for (const block of blocks) {
      const title = worldMonitorExtractFirstXmlTag(block, ["title"]);
      if (!title) continue;
      const link = worldMonitorExtractLinkFromItem(block);
      const country = worldMonitorExtractFirstXmlTag(block, ["country", "gdacs:country"]);
      const eventTypeRaw = worldMonitorExtractFirstXmlTag(block, ["eventtype", "gdacs:eventtype", "dc:subject"]);
      const eventType = String(eventTypeRaw || "").toUpperCase().trim().slice(0, 12);
      const pubRaw = worldMonitorExtractFirstXmlTag(block, ["pubDate", "dateadded", "gdacs:dateadded", "datemodified", "gdacs:datemodified"]);
      const publishedAt = Number(Date.parse(pubRaw)) || 0;
      const isCurrentRaw = worldMonitorExtractFirstXmlTag(block, ["iscurrent", "gdacs:iscurrent"]);
      const isCurrent = isCurrentRaw
        ? /^true$/i.test(String(isCurrentRaw).trim())
        : (publishedAt > 0 ? (now - publishedAt) <= (14 * dayMs) : false);
      const alertRaw = worldMonitorExtractFirstXmlTag(block, ["alertlevel", "gdacs:alertlevel", "episodealertlevel", "gdacs:episodealertlevel"]);
      const fallbackMatch = String(title).match(/\b(Red|Orange|Green)\b/i);
      const level = String(alertRaw || (fallbackMatch ? fallbackMatch[1] : "green")).toLowerCase().trim();
      events.push({
        title: String(title || "").trim(),
        link,
        country: String(country || "").trim(),
        eventType,
        level,
        isCurrent,
        publishedAt,
      });
    }

    const recent72h = events.filter((x) => Number(x?.publishedAt || 0) >= (now - (72 * 60 * 60 * 1000)));
    const current = events.filter((x) => x.isCurrent);
    const currentRed = current.filter((x) => x.level === "red");
    const currentOrange = current.filter((x) => x.level === "orange");
    const taiwanRegionPattern = /(taiwan|china|japan|korea|philippines|south china sea|east china sea|pacific)/i;
    const taiwanRegionCurrent = current.filter((x) => {
      const hay = `${String(x.title || "")} ${String(x.country || "")}`.toLowerCase();
      return taiwanRegionPattern.test(hay);
    });
    const taiwanRegionOrangeOrRed = taiwanRegionCurrent.filter((x) => x.level === "orange" || x.level === "red");

    const byType = {};
    for (const x of current) {
      const key = String(x?.eventType || "OTHER").trim() || "OTHER";
      byType[key] = Number(byType[key] || 0) + 1;
    }

    const topAlerts = current
      .filter((x) => x.level === "red" || x.level === "orange")
      .sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0))
      .slice(0, 10)
      .map((x) => ({
        title: x.title,
        level: x.level,
        eventType: x.eventType,
        country: x.country,
        publishedAt: Number(x.publishedAt || 0) || 0,
        link: x.link,
      }));

    return {
      ts: now,
      source: "gdacs",
      totalParsed: events.length,
      recent72h: recent72h.length,
      currentTotal: current.length,
      currentRed: currentRed.length,
      currentOrange: currentOrange.length,
      currentGreen: current.filter((x) => x.level === "green").length,
      taiwanRegionCurrent: taiwanRegionCurrent.length,
      taiwanRegionOrangeOrRed: taiwanRegionOrangeOrRed.length,
      byType,
      topAlerts,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWorldMonitorNativeMaritimeSnapshot(timeoutMs) {
  const url = "https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A";
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const rows = Array.isArray(data?.["broadcast-warn"])
    ? data["broadcast-warn"]
    : Array.isArray(data?.broadcastWarn)
      ? data.broadcastWarn
      : [];
  const regionCounts = {};
  for (const r of WORLDMONITOR_NATIVE_MARITIME_REGION_PATTERNS) {
    regionCounts[r.id] = 0;
  }
  const militaryKeywords = /(exercise|gunnery|firing|missile|rocket|naval|warship|submarine|military)/i;
  const keyWarnings = [];
  let militaryRelated = 0;
  for (const row of rows.slice(0, 900)) {
    const text = String(row?.text || row?.message || "").trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    let matchedAnyRegion = false;
    for (const r of WORLDMONITOR_NATIVE_MARITIME_REGION_PATTERNS) {
      if (r.regex.test(lower)) {
        regionCounts[r.id] = Number(regionCounts[r.id] || 0) + 1;
        matchedAnyRegion = true;
      }
    }
    const military = militaryKeywords.test(lower);
    if (military) militaryRelated += 1;
    if ((matchedAnyRegion || military) && keyWarnings.length < 12) {
      keyWarnings.push({
        id: `${String(row?.msgYear || "").trim()}-${String(row?.msgNumber || "").trim()}`,
        navArea: String(row?.navArea || "").trim(),
        subregion: String(row?.subregion || "").trim(),
        text: oneLine(text).slice(0, 260),
        military,
      });
    }
  }
  const taiwanRegionWarnings = Number(regionCounts.taiwan_strait || 0)
    + Number(regionCounts.south_china_sea || 0)
    + Number(regionCounts.east_china_sea || 0);
  return {
    ts: Date.now(),
    source: "nga_broadcast_warn",
    totalWarnings: rows.length,
    militaryRelated,
    regionCounts,
    taiwanRegionWarnings,
    keyWarnings,
  };
}

async function fetchWorldMonitorNativeServiceSnapshot(timeoutMs) {
  const results = [];
  const errors = [];
  for (const source of WORLDMONITOR_NATIVE_SERVICE_SOURCES) {
    try {
      const data = await fetchJsonUrl(source.url, {
        headers: {
          Accept: "application/json",
          "User-Agent": REDDIT_USER_AGENT,
        },
        timeoutMs,
      });
      const statusObj = worldMonitorNonEmptyObject(data?.status);
      const rawIndicator = String(statusObj?.indicator || statusObj?.status || "").trim().toLowerCase();
      const indicator = normalizeWorldMonitorServiceIndicator(rawIndicator);
      results.push({
        id: source.id,
        name: source.name,
        indicator,
        description: oneLine(String(statusObj?.description || "")).slice(0, 140),
      });
    } catch (err) {
      const message = String(err?.message || err || "").trim() || "fetch failed";
      results.push({
        id: source.id,
        name: source.name,
        indicator: "unknown",
        description: "",
      });
      if (errors.length < 12) errors.push(`${source.name}: ${message}`);
    }
  }
  const okCount = results.filter((x) => x.indicator === "ok").length;
  const degradedCount = results.filter((x) => x.indicator === "degraded").length;
  const outageCount = results.filter((x) => x.indicator === "outage").length;
  return {
    ts: Date.now(),
    source: "public_status_pages",
    totalServices: results.length,
    okCount,
    degradedCount,
    outageCount,
    services: results,
    errorCount: errors.length,
    sampleErrors: errors,
  };
}

async function fetchWorldMonitorNativeMacroSnapshot(timeoutMs) {
  const errors = [];
  const seriesMap = {};
  const symbolEntries = Object.entries(WORLDMONITOR_NATIVE_MACRO_SYMBOLS);
  await Promise.all(symbolEntries.map(([symbol, label]) => (async () => {
    try {
      const series = await fetchYahooSeries(symbol, timeoutMs, { range: "1y", interval: "1d" });
      seriesMap[label] = series;
    } catch (err) {
      if (errors.length < 12) {
        errors.push(`${label}: ${String(err?.message || err || "fetch failed")}`);
      }
      seriesMap[label] = [];
    }
  })()));

  const [fearGreedResult, mempoolResult] = await Promise.allSettled([
    fetchJsonUrl("https://api.alternative.me/fng/?limit=30&format=json", {
      headers: { Accept: "application/json", "User-Agent": REDDIT_USER_AGENT },
      timeoutMs,
    }),
    fetchJsonUrl("https://mempool.space/api/v1/mining/hashrate/1m", {
      headers: { Accept: "application/json", "User-Agent": REDDIT_USER_AGENT },
      timeoutMs,
    }),
  ]);

  let fearGreedValue = null;
  let fearGreedLabel = "unknown";
  let fearGreedHistory = [];
  if (fearGreedResult.status === "fulfilled") {
    const rows = Array.isArray(fearGreedResult.value?.data) ? fearGreedResult.value.data : [];
    if (rows.length > 0) {
      const v = Number.parseInt(String(rows[0]?.value || ""), 10);
      fearGreedValue = Number.isFinite(v) ? v : null;
      fearGreedLabel = String(rows[0]?.value_classification || "").trim().toLowerCase() || "unknown";
      fearGreedHistory = rows
        .slice(0, 30)
        .map((x) => ({
          value: Number.parseInt(String(x?.value || ""), 10),
          timestamp: Number.parseInt(String(x?.timestamp || ""), 10) * 1000,
        }))
        .filter((x) => Number.isFinite(x.value) && Number.isFinite(x.timestamp) && x.timestamp > 0);
    }
  } else if (errors.length < 12) {
    errors.push(`fear-greed: ${String(fearGreedResult.reason?.message || fearGreedResult.reason || "failed")}`);
  }

  let hashRateChange30dPct = null;
  if (mempoolResult.status === "fulfilled") {
    const rows = Array.isArray(mempoolResult.value) ? mempoolResult.value : Array.isArray(mempoolResult.value?.hashrates) ? mempoolResult.value.hashrates : [];
    const normalized = rows
      .map((x) => Number(x?.avgHashrate ?? x))
      .filter((x) => Number.isFinite(x) && x > 0);
    if (normalized.length >= 2) {
      const first = normalized[0];
      const last = normalized[normalized.length - 1];
      hashRateChange30dPct = ((last - first) / first) * 100;
    }
  } else if (errors.length < 12) {
    errors.push(`hashrate: ${String(mempoolResult.reason?.message || mempoolResult.reason || "failed")}`);
  }

  const btcSeries = Array.isArray(seriesMap.BTC) ? seriesMap.BTC : [];
  const qqqSeries = Array.isArray(seriesMap.QQQ) ? seriesMap.QQQ : [];
  const xlpSeries = Array.isArray(seriesMap.XLP) ? seriesMap.XLP : [];
  const jpySeries = Array.isArray(seriesMap.USD_JPY) ? seriesMap.USD_JPY : [];

  const metrics = {
    btcRoc5Pct: rateOfChangeFromSeries(btcSeries, 5),
    qqqRoc5Pct: rateOfChangeFromSeries(qqqSeries, 5),
    qqqRoc20Pct: rateOfChangeFromSeries(qqqSeries, 20),
    xlpRoc20Pct: rateOfChangeFromSeries(xlpSeries, 20),
    jpyRoc30Pct: rateOfChangeFromSeries(jpySeries, 30),
    fearGreedValue,
    fearGreedLabel,
    hashRateChange30dPct,
  };

  let riskOnSignals = 0;
  let knownSignals = 0;
  if (Number.isFinite(metrics.jpyRoc30Pct)) {
    knownSignals += 1;
    if (Number(metrics.jpyRoc30Pct) > -2) riskOnSignals += 1;
  }
  if (Number.isFinite(metrics.btcRoc5Pct) && Number.isFinite(metrics.qqqRoc5Pct)) {
    knownSignals += 1;
    if (Math.abs(Number(metrics.btcRoc5Pct) - Number(metrics.qqqRoc5Pct)) <= 5) riskOnSignals += 1;
  }
  if (Number.isFinite(metrics.qqqRoc20Pct) && Number.isFinite(metrics.xlpRoc20Pct)) {
    knownSignals += 1;
    if (Number(metrics.qqqRoc20Pct) > Number(metrics.xlpRoc20Pct)) riskOnSignals += 1;
  }
  if (Number.isFinite(metrics.fearGreedValue)) {
    knownSignals += 1;
    if (Number(metrics.fearGreedValue) > 50) riskOnSignals += 1;
  }
  if (Number.isFinite(metrics.hashRateChange30dPct)) {
    knownSignals += 1;
    if (Number(metrics.hashRateChange30dPct) > 0) riskOnSignals += 1;
  }

  const riskRegime = knownSignals <= 0
    ? "unknown"
    : (riskOnSignals / knownSignals >= 0.57 ? "risk_on" : "risk_off");

  return {
    ts: Date.now(),
    source: "macro_public_feeds",
    metrics,
    riskRegime,
    riskOnSignals,
    knownSignals,
    fearGreedHistory: fearGreedHistory.slice(0, 30),
    seriesCoverage: {
      btc: btcSeries.length,
      qqq: qqqSeries.length,
      xlp: xlpSeries.length,
      usd_jpy: jpySeries.length,
    },
    errorCount: errors.length,
    sampleErrors: errors,
  };
}

function parsePolymarketYesPrice(market) {
  try {
    const raw = market?.outcomePrices;
    if (!raw) return null;
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length <= 0) return null;
    const value = Number(arr[0]);
    if (!Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

async function fetchWorldMonitorNativePredictionSnapshot(timeoutMs) {
  const url = `https://gamma-api.polymarket.com/events?${new URLSearchParams({
    closed: "false",
    active: "true",
    archived: "false",
    end_date_min: new Date().toISOString(),
    order: "volume",
    ascending: "false",
    limit: "80",
  }).toString()}`;
  const data = await fetchJsonUrl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": REDDIT_USER_AGENT,
    },
    timeoutMs,
  });
  const events = Array.isArray(data) ? data : [];
  const normalized = events.map((event) => {
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const topMarket = markets[0] || null;
    const title = String(topMarket?.question || event?.title || "").trim();
    const volume = Number(event?.volume ?? topMarket?.volumeNum ?? topMarket?.volume ?? 0) || 0;
    const yesPrice = parsePolymarketYesPrice(topMarket);
    const closesAt = Number(Date.parse(String(topMarket?.endDate || event?.endDate || ""))) || 0;
    const slug = String(event?.slug || topMarket?.slug || "").trim();
    const link = slug ? `https://polymarket.com/event/${slug}` : "";
    const taiwanRelated = WORLDMONITOR_NATIVE_PREDICTION_TAIWAN_PATTERN.test(title);
    return {
      id: String(event?.id || slug || title).trim(),
      title,
      volume,
      yesPrice,
      closesAt,
      link,
      taiwanRelated,
    };
  }).filter((x) => x.id && x.title);

  const topByVolume = [...normalized]
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 16);
  const highVolumeUncertain = normalized.filter((x) => {
    const yp = Number(x?.yesPrice);
    return Number(x?.volume || 0) >= 100_000
      && Number.isFinite(yp)
      && yp >= 0.35
      && yp <= 0.65;
  });
  const taiwanRelated = normalized.filter((x) => x.taiwanRelated);
  return {
    ts: Date.now(),
    source: "polymarket_gamma",
    totalActiveEvents: normalized.length,
    taiwanRelatedCount: taiwanRelated.length,
    highVolumeUncertainCount: highVolumeUncertain.length,
    topByVolume: topByVolume.map((x) => ({
      title: x.title,
      volume: Number(x.volume || 0) || 0,
      yesPrice: Number.isFinite(Number(x.yesPrice)) ? Number(x.yesPrice) : null,
      closesAt: Number(x.closesAt || 0) || 0,
      link: x.link,
      taiwanRelated: x.taiwanRelated,
    })),
    taiwanRelatedTop: taiwanRelated
      .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
      .slice(0, 10)
      .map((x) => ({
        title: x.title,
        volume: Number(x.volume || 0) || 0,
        yesPrice: Number.isFinite(Number(x.yesPrice)) ? Number(x.yesPrice) : null,
        closesAt: Number(x.closesAt || 0) || 0,
        link: x.link,
      })),
  };
}

function buildWorldMonitorInfrastructureSnapshot(nowMs = Date.now()) {
  const now = Number(nowMs || Date.now()) || Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const items24 = worldMonitorNativeNewsItems.filter((x) => Number(x?.publishedAt || x?.firstSeenAt || 0) >= (now - dayMs));
  const itemsPrev24 = worldMonitorNativeNewsItems.filter((x) => {
    const ts = Number(x?.publishedAt || x?.firstSeenAt || 0);
    return ts >= (now - (2 * dayMs)) && ts < (now - dayMs);
  });
  function countKeywords(items, pattern) {
    const seen = new Set();
    let count = 0;
    for (const item of items) {
      const title = String(item?.title || "").toLowerCase();
      if (!title || !pattern.test(title)) continue;
      const key = normalizeWorldMonitorTitleForKey(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
    return count;
  }
  const cables24 = countKeywords(items24, /(subsea|undersea|sea cable|internet cable|cable cut|cable damage)/i);
  const ports24 = countKeywords(items24, /(port|harbor|harbour|terminal|container ship|shipping lane|chokepoint|suez|panama canal)/i);
  const pipelines24 = countKeywords(items24, /(pipeline|lng terminal|gas pipeline|oil pipeline|refinery)/i);
  const cablesPrev = countKeywords(itemsPrev24, /(subsea|undersea|sea cable|internet cable|cable cut|cable damage)/i);
  const portsPrev = countKeywords(itemsPrev24, /(port|harbor|harbour|terminal|container ship|shipping lane|chokepoint|suez|panama canal)/i);
  const pipelinesPrev = countKeywords(itemsPrev24, /(pipeline|lng terminal|gas pipeline|oil pipeline|refinery)/i);
  const total24 = cables24 + ports24 + pipelines24;
  const totalPrev24 = cablesPrev + portsPrev + pipelinesPrev;
  const deltaPct = totalPrev24 > 0 ? ((total24 - totalPrev24) / totalPrev24) * 100 : (total24 > 0 ? 100 : 0);
  return {
    ts: now,
    cables24h: cables24,
    ports24h: ports24,
    pipelines24h: pipelines24,
    total24h: total24,
    totalPrev24h: totalPrev24,
    deltaPct,
  };
}

function worldMonitorAddSignalsPenalty() {
  const market = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.marketSeries);
  const crypto = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.cryptoSeries);
  const seismic = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.seismicSeries);
  const infra = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.infrastructureSeries);
  const adsb = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.adsbSeries);
  const disaster = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.disasterSeries);
  const maritime = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.maritimeSeries);
  const service = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.serviceSeries);
  const macro = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.macroSeries);
  const prediction = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.predictionSeries);
  let penalty = 0;
  if (market?.metrics && typeof market.metrics === "object") {
    const tw = Number(market.metrics?.TWSE?.changePct || 0);
    const hsi = Number(market.metrics?.HANG_SENG?.changePct || 0);
    const spx = Number(market.metrics?.SP500?.changePct || 0);
    const oil = Number(market.metrics?.WTI_OIL?.changePct || 0);
    const gold = Number(market.metrics?.GOLD?.changePct || 0);
    if (tw <= -2.2) penalty += 3;
    if (hsi <= -2.2) penalty += 3;
    if (spx <= -2.8) penalty += 2;
    if (oil >= 4.5) penalty += 2;
    if (gold >= 2.5) penalty += 1;
  }
  if (crypto?.metrics && typeof crypto.metrics === "object") {
    const btc = Number(crypto.metrics?.BTC?.change24hPct || 0);
    const eth = Number(crypto.metrics?.ETH?.change24hPct || 0);
    const usdt = Number(crypto.metrics?.USDT?.usd || 1);
    const usdc = Number(crypto.metrics?.USDC?.usd || 1);
    if (btc <= -5 || eth <= -7) penalty += 2;
    if (Math.abs(usdt - 1) >= 0.01 || Math.abs(usdc - 1) >= 0.01) penalty += 2;
  }
  if (seismic && Number(seismic.maxMag24h || 0) >= 6.8) penalty += 2;
  if (infra && Number(infra.total24h || 0) >= 8 && Number(infra.deltaPct || 0) >= 50) penalty += 2;
  if (adsb) {
    const twMilitary = Number(adsb.taiwanMilitaryFlights || 0);
    const totalMilitary = Number(adsb.militaryFlights || 0);
    const tankers = Number(adsb?.byType?.tanker || 0);
    const awacs = Number(adsb?.byType?.awacs || 0);
    if (twMilitary >= 10) penalty += 3;
    else if (twMilitary >= 6) penalty += 2;
    if (totalMilitary >= 24) penalty += 2;
    if ((tankers + awacs) >= 4) penalty += 2;
  }
  if (disaster) {
    const currentRed = Number(disaster.currentRed || 0);
    const currentOrange = Number(disaster.currentOrange || 0);
    const twRegional = Number(disaster.taiwanRegionOrangeOrRed || 0);
    if (currentRed >= 2) penalty += 2;
    if ((currentRed + currentOrange) >= 10) penalty += 1;
    if (twRegional >= 1) penalty += 1;
  }
  if (maritime) {
    const tw = Number(maritime.taiwanRegionWarnings || 0);
    const military = Number(maritime.militaryRelated || 0);
    if (tw >= 8) penalty += 2;
    else if (tw >= 4) penalty += 1;
    if (military >= 30) penalty += 1;
  }
  if (service) {
    const degraded = Number(service.degradedCount || 0);
    const outage = Number(service.outageCount || 0);
    if (outage >= 2) penalty += 1;
    if ((degraded + outage) >= 4) penalty += 1;
  }
  if (macro) {
    const regime = String(macro.riskRegime || "").toLowerCase();
    const fearGreed = Number(macro?.metrics?.fearGreedValue);
    if (regime === "risk_off") penalty += 2;
    if (Number.isFinite(fearGreed) && fearGreed <= 15) penalty += 1;
  }
  if (prediction) {
    const tw = Number(prediction.taiwanRelatedCount || 0);
    const uncertain = Number(prediction.highVolumeUncertainCount || 0);
    if (tw >= 3) penalty += 1;
    if (uncertain >= 6) penalty += 1;
  }
  if (WORLDMONITOR_DEEP_INGEST_ENABLED) {
    const sinceMs = Date.now() - (24 * 60 * 60 * 1000);
    const themeSnap = buildWorldMonitorArticleThemeSnapshot(sinceMs);
    const scores = new Map(
      (Array.isArray(themeSnap?.top_themes) ? themeSnap.top_themes : [])
        .map((x) => [String(x?.theme || ""), Number(x?.score || 0) || 0]),
    );
    if (Number(scores.get("military") || 0) >= 12) penalty += 1;
    if (Number(scores.get("taiwan_china") || 0) >= 10) penalty += 1;
    if (Number(scores.get("infrastructure") || 0) >= 10) penalty += 1;
  }
  return Math.max(0, Math.min(20, penalty));
}

async function runWorldMonitorNativeSignalsRefresh(options = {}) {
  const force = options?.force === true;
  const now = Date.now();
  const minIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_SIGNALS_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const seismicMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_SEISMIC_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const adsbMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_ADSB_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const disasterMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_DISASTER_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const maritimeMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_MARITIME_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const serviceMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_SERVICE_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const macroMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_MACRO_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const predictionMinIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_PREDICTION_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const lastAt = Number(worldMonitorMonitor.nativeSignalsLastRefreshAt || 0) || 0;
  const shouldSkip = !force && lastAt > 0 && (now - lastAt) < minIntervalMs;
  if (shouldSkip) {
    return {
      ok: true,
      skipped: "fresh",
      refreshedAt: lastAt,
      stats: worldMonitorMonitor.nativeSignalsLastRefreshStats || {},
    };
  }

  if (worldMonitorNativeRuntime.signalsPromise) {
    return worldMonitorNativeRuntime.signalsPromise;
  }

  const promise = (async () => {
    const startedAt = Date.now();
    const timeoutMs = Number(WORLDMONITOR_NATIVE_SIGNAL_TIMEOUT_MS || 0);
    const stats = {
      market: "skipped",
      crypto: "skipped",
      seismic: "skipped",
      adsb: "skipped",
      disaster: "skipped",
      maritime: "skipped",
      services: "skipped",
      macro: "skipped",
      prediction: "skipped",
      infrastructure: "ok",
      errors: [],
    };

    try {
      const [marketResult, cryptoResult] = await Promise.allSettled([
        fetchWorldMonitorNativeMarketSnapshot(timeoutMs),
        fetchWorldMonitorNativeCryptoSnapshot(timeoutMs),
      ]);

      if (marketResult.status === "fulfilled") {
        pushWorldMonitorSignalSample("marketSeries", marketResult.value);
        stats.market = "ok";
      } else {
        stats.market = "error";
        if (stats.errors.length < 8) {
          stats.errors.push(`market: ${String(marketResult.reason?.message || marketResult.reason || "failed")}`);
        }
      }

      if (cryptoResult.status === "fulfilled") {
        pushWorldMonitorSignalSample("cryptoSeries", cryptoResult.value);
        stats.crypto = "ok";
      } else {
        stats.crypto = "error";
        if (stats.errors.length < 8) {
          stats.errors.push(`crypto: ${String(cryptoResult.reason?.message || cryptoResult.reason || "failed")}`);
        }
      }

      const lastSeismic = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.seismicSeries);
      const shouldRefreshSeismic = force
        || !lastSeismic
        || (now - Number(lastSeismic.ts || 0) >= seismicMinIntervalMs);
      if (shouldRefreshSeismic) {
        try {
          const seismic = await fetchWorldMonitorNativeSeismicSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("seismicSeries", seismic);
          stats.seismic = "ok";
        } catch (err) {
          stats.seismic = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`seismic: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.seismic = "stale-ok";
      }

      const lastAdsb = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.adsbSeries);
      const shouldRefreshAdsb = force
        || !lastAdsb
        || (now - Number(lastAdsb.ts || 0) >= adsbMinIntervalMs);
      if (shouldRefreshAdsb) {
        try {
          const adsb = await fetchWorldMonitorNativeAdsbSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("adsbSeries", adsb);
          stats.adsb = "ok";
        } catch (err) {
          stats.adsb = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`adsb: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.adsb = "stale-ok";
      }

      const lastDisaster = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.disasterSeries);
      const shouldRefreshDisaster = force
        || !lastDisaster
        || (now - Number(lastDisaster.ts || 0) >= disasterMinIntervalMs);
      if (shouldRefreshDisaster) {
        try {
          const disaster = await fetchWorldMonitorNativeDisasterSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("disasterSeries", disaster);
          stats.disaster = "ok";
        } catch (err) {
          stats.disaster = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`disaster: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.disaster = "stale-ok";
      }

      const lastMaritime = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.maritimeSeries);
      const shouldRefreshMaritime = force
        || !lastMaritime
        || (now - Number(lastMaritime.ts || 0) >= maritimeMinIntervalMs);
      if (shouldRefreshMaritime) {
        try {
          const maritime = await fetchWorldMonitorNativeMaritimeSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("maritimeSeries", maritime);
          stats.maritime = "ok";
        } catch (err) {
          stats.maritime = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`maritime: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.maritime = "stale-ok";
      }

      const lastService = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.serviceSeries);
      const shouldRefreshService = force
        || !lastService
        || (now - Number(lastService.ts || 0) >= serviceMinIntervalMs);
      if (shouldRefreshService) {
        try {
          const service = await fetchWorldMonitorNativeServiceSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("serviceSeries", service);
          stats.services = "ok";
        } catch (err) {
          stats.services = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`services: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.services = "stale-ok";
      }

      const lastMacro = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.macroSeries);
      const shouldRefreshMacro = force
        || !lastMacro
        || (now - Number(lastMacro.ts || 0) >= macroMinIntervalMs);
      if (shouldRefreshMacro) {
        try {
          const macro = await fetchWorldMonitorNativeMacroSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("macroSeries", macro);
          stats.macro = "ok";
        } catch (err) {
          stats.macro = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`macro: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.macro = "stale-ok";
      }

      const lastPrediction = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.predictionSeries);
      const shouldRefreshPrediction = force
        || !lastPrediction
        || (now - Number(lastPrediction.ts || 0) >= predictionMinIntervalMs);
      if (shouldRefreshPrediction) {
        try {
          const prediction = await fetchWorldMonitorNativePredictionSnapshot(timeoutMs);
          pushWorldMonitorSignalSample("predictionSeries", prediction);
          stats.prediction = "ok";
        } catch (err) {
          stats.prediction = "error";
          if (stats.errors.length < 8) {
            stats.errors.push(`prediction: ${String(err?.message || err || "failed")}`);
          }
        }
      } else {
        stats.prediction = "stale-ok";
      }

      try {
        const infra = buildWorldMonitorInfrastructureSnapshot(now);
        pushWorldMonitorSignalSample("infrastructureSeries", infra);
        stats.infrastructure = "ok";
      } catch (err) {
        stats.infrastructure = "error";
        if (stats.errors.length < 8) {
          stats.errors.push(`infrastructure: ${String(err?.message || err || "failed")}`);
        }
      }

      pruneWorldMonitorNativeSignals(now);
      persistWorldMonitorNativeSignalsStore();

      worldMonitorMonitor.nativeSignalsLastRefreshAt = Date.now();
      worldMonitorMonitor.nativeSignalsLastRefreshDurationMs = Date.now() - startedAt;
      worldMonitorMonitor.nativeSignalsLastRefreshErrorAt = 0;
      worldMonitorMonitor.nativeSignalsLastRefreshError = "";
      worldMonitorMonitor.nativeSignalsLastRefreshStats = {
        ...stats,
        market_points: Array.isArray(worldMonitorNativeSignals.marketSeries) ? worldMonitorNativeSignals.marketSeries.length : 0,
        crypto_points: Array.isArray(worldMonitorNativeSignals.cryptoSeries) ? worldMonitorNativeSignals.cryptoSeries.length : 0,
        seismic_points: Array.isArray(worldMonitorNativeSignals.seismicSeries) ? worldMonitorNativeSignals.seismicSeries.length : 0,
        infrastructure_points: Array.isArray(worldMonitorNativeSignals.infrastructureSeries) ? worldMonitorNativeSignals.infrastructureSeries.length : 0,
        adsb_points: Array.isArray(worldMonitorNativeSignals.adsbSeries) ? worldMonitorNativeSignals.adsbSeries.length : 0,
        disaster_points: Array.isArray(worldMonitorNativeSignals.disasterSeries) ? worldMonitorNativeSignals.disasterSeries.length : 0,
        maritime_points: Array.isArray(worldMonitorNativeSignals.maritimeSeries) ? worldMonitorNativeSignals.maritimeSeries.length : 0,
        service_points: Array.isArray(worldMonitorNativeSignals.serviceSeries) ? worldMonitorNativeSignals.serviceSeries.length : 0,
        macro_points: Array.isArray(worldMonitorNativeSignals.macroSeries) ? worldMonitorNativeSignals.macroSeries.length : 0,
        prediction_points: Array.isArray(worldMonitorNativeSignals.predictionSeries) ? worldMonitorNativeSignals.predictionSeries.length : 0,
      };
      persistState();
      return {
        ok: true,
        refreshedAt: Number(worldMonitorMonitor.nativeSignalsLastRefreshAt || Date.now()) || Date.now(),
        durationMs: Number(worldMonitorMonitor.nativeSignalsLastRefreshDurationMs || 0) || 0,
        stats: worldMonitorMonitor.nativeSignalsLastRefreshStats,
      };
    } catch (err) {
      const message = String(err?.message || err || "").trim() || "signals refresh failed";
      worldMonitorMonitor.nativeSignalsLastRefreshErrorAt = Date.now();
      worldMonitorMonitor.nativeSignalsLastRefreshError = message;
      persistState();
      return { ok: false, error: message, refreshedAt: Date.now(), stats };
    } finally {
      worldMonitorNativeRuntime.signalsPromise = null;
    }
  })();

  worldMonitorNativeRuntime.signalsPromise = promise;
  return promise;
}

async function runWorldMonitorNativeFeedRefresh(options = {}) {
  const minIntervalMs = Math.max(0, Number(WORLDMONITOR_NATIVE_REFRESH_MIN_INTERVAL_SEC || 0) * 1000);
  const force = options?.force === true;
  const minPublishedAtMsRaw = Number(options?.minPublishedAtMs || 0);
  const minPublishedAtMs = Number.isFinite(minPublishedAtMsRaw)
    ? Math.max(0, Math.trunc(minPublishedAtMsRaw))
    : 0;
  const maxItemsPerSourceRaw = Number(options?.maxItemsPerSource || 0);
  const maxItemsPerSource = Number.isFinite(maxItemsPerSourceRaw) && maxItemsPerSourceRaw > 0
    ? Math.max(1, Math.trunc(maxItemsPerSourceRaw))
    : WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE;
  const startedAt = Date.now();
  if (
    !force
    && Number(worldMonitorMonitor.nativeLastRefreshAt || 0) > 0
    && (startedAt - Number(worldMonitorMonitor.nativeLastRefreshAt || 0)) < minIntervalMs
  ) {
    return {
      ok: true,
      skipped: "fresh",
      stats: worldMonitorMonitor.nativeLastRefreshStats || {},
      refreshedAt: Number(worldMonitorMonitor.nativeLastRefreshAt || 0) || startedAt,
    };
  }

  if (worldMonitorNativeRuntime.refreshPromise) {
    const lockStartedAt = Number(worldMonitorNativeRuntime.refreshStartedAt || 0) || 0;
    const lockAgeMs = lockStartedAt > 0 ? Math.max(0, startedAt - lockStartedAt) : 0;
    const lockTimedOut = (
      Number(WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS || 0) > 0
      && lockAgeMs > Number(WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS || 0)
    );
    if (!lockTimedOut) {
      return worldMonitorNativeRuntime.refreshPromise;
    }
    log(
      `worldmonitor native refresh: clearing stale in-flight refresh lock after ${Math.round(lockAgeMs / 1000)}s.`,
    );
    worldMonitorNativeRuntime.refreshPromise = null;
    worldMonitorNativeRuntime.refreshStartedAt = 0;
  }

  const refreshCorePromise = (async () => {
    const feeds = loadWorldMonitorNativeFeedManifest();
    if (!Array.isArray(feeds) || feeds.length === 0) {
      throw new Error(`No native feed manifest entries loaded from ${WORLDMONITOR_NATIVE_FEEDS_PATH}`);
    }

    const timeoutMs = Number(WORLDMONITOR_NATIVE_FEED_TIMEOUT_MS || 0);
    const concurrency = Math.max(1, Number(WORLDMONITOR_NATIVE_FEED_FETCH_CONCURRENCY || 1));
    const fetchedAt = Date.now();
    const feedFetchStartedAt = Date.now();
    const existingByKey = new Map();
    for (const item of worldMonitorNativeNewsItems) {
      const key = String(item?.articleKey || "").trim();
      if (!key) continue;
      existingByKey.set(key, item);
    }

    let cursor = 0;
    let feedsOk = 0;
    let feedsFail = 0;
    let newItems = 0;
    const newItemKeys = [];
    const errors = [];
    const feedSamples = [];

    async function workerLoop() {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= feeds.length) break;
        const feed = feeds[idx];
        const feedStartedAt = Date.now();
        let parsedCount = 0;
        let sampleError = "";
        let sampleOk = false;
        try {
          const controller = new AbortController();
          const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
          let text = "";
          try {
            const resp = await fetch(String(feed.url), {
              method: "GET",
              headers: {
                "User-Agent": REDDIT_USER_AGENT,
                Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
                "Cache-Control": "no-cache",
              },
              signal: controller.signal,
            });
            if (!resp.ok) {
              throw new Error(`HTTP ${resp.status}`);
            }
            text = await resp.text();
          } finally {
            if (timer) clearTimeout(timer);
          }
          const parsed = parseWorldMonitorFeedXml(text, feed, fetchedAt, {
            minPublishedAtMs,
            maxItemsPerSource,
          });
          parsedCount = parsed.length;
          for (const next of parsed) {
            const key = String(next.articleKey || "").trim();
            if (!key) continue;
            const prev = existingByKey.get(key);
            if (prev && typeof prev === "object") {
              prev.lastSeenAt = fetchedAt;
              if (!prev.publishedAt || Number(next.publishedAt || 0) > Number(prev.publishedAt || 0)) {
                prev.publishedAt = Number(next.publishedAt || prev.publishedAt || fetchedAt) || fetchedAt;
              }
              prev.threatLevel = worldMonitorNormalizeNativeThreatLevel(next.threatLevel) || "low";
              prev.threatLevelSource = "native-feed-metadata";
              if (Number(next.taiwanScore || 0) > Number(prev.taiwanScore || 0)) prev.taiwanScore = Number(next.taiwanScore || 0);
              if ((!Array.isArray(prev.countries) || prev.countries.length === 0) && Array.isArray(next.countries)) {
                prev.countries = next.countries.slice(0, 6);
              }
              continue;
            }
            existingByKey.set(key, next);
            worldMonitorNativeNewsItems.push(next);
            newItemKeys.push(key);
            newItems += 1;
          }
          feedsOk += 1;
          sampleOk = true;
        } catch (err) {
          feedsFail += 1;
          sampleError = String(err?.message || err || "").trim() || "fetch failed";
          if (errors.length < 12) {
            errors.push(`${feed.name}: ${sampleError}`);
          }
        } finally {
          feedSamples.push({
            source: oneLine(String(feed?.name || feed?.url || `feed-${idx + 1}`)).slice(0, 90),
            ok: sampleOk,
            duration_ms: Date.now() - feedStartedAt,
            parsed_items: parsedCount,
            error: sampleOk ? "" : sampleError.slice(0, 140),
          });
        }
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(workerLoop());
    }
    await Promise.all(workers);
    const feedFetchDurationMs = Date.now() - feedFetchStartedAt;

    pruneWorldMonitorNativeStore(fetchedAt);
    persistWorldMonitorNativeStore();
    const hardTimeoutMs = Number(WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS || 0);
    const elapsedBeforePostMs = Date.now() - startedAt;
    const configuredDeepIngestBudgetMs = Math.max(0, Number(WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS || 0));
    let deepIngestBudgetMs = configuredDeepIngestBudgetMs;
    if (hardTimeoutMs > 0) {
      const remainingWithinHardTimeout = hardTimeoutMs - elapsedBeforePostMs - 2_000;
      if (remainingWithinHardTimeout <= 0) {
        deepIngestBudgetMs = 0;
      } else if (deepIngestBudgetMs > 0) {
        deepIngestBudgetMs = Math.min(deepIngestBudgetMs, remainingWithinHardTimeout);
      } else {
        deepIngestBudgetMs = remainingWithinHardTimeout;
      }
    }
    if (deepIngestBudgetMs > 0) {
      if (hardTimeoutMs > 0 && deepIngestBudgetMs < 1_000) {
        deepIngestBudgetMs = 0;
      } else {
        deepIngestBudgetMs = Math.max(1_000, Math.trunc(deepIngestBudgetMs));
      }
    }
    let deepIngestDurationMs = 0;
    let signalsDurationMs = 0;
    let deepIngestTimedOut = false;
    let deepIngestError = "";
    let deepIngestBudgetHit = false;
    const deepIngestPromise = (async () => {
      const phaseStartedAt = Date.now();
      try {
        const task = runWorldMonitorNativeDeepIngest({
          force,
          seedKeys: newItemKeys,
          stageBudgetMs: deepIngestBudgetMs,
        });
        if (deepIngestBudgetMs > 0) {
          return await withPromiseTimeout(
            task,
            deepIngestBudgetMs + 2_000,
            `native deep ingest stage did not stop within ${Math.round(deepIngestBudgetMs / 1000)}s budget`,
          );
        }
        return await task;
      } catch (err) {
        deepIngestError = String(err?.message || err || "").trim() || "native deep ingest failed";
        deepIngestTimedOut = /timed out|did not stop within/i.test(deepIngestError);
        return {
          ok: false,
          error: deepIngestError,
          skipped: deepIngestTimedOut ? "timed_out" : "error",
          stats: {},
        };
      } finally {
        deepIngestDurationMs = Date.now() - phaseStartedAt;
      }
    })();
    const signalsPromise = (async () => {
      const phaseStartedAt = Date.now();
      try {
        return await runWorldMonitorNativeSignalsRefresh({ force });
      } finally {
        signalsDurationMs = Date.now() - phaseStartedAt;
      }
    })();
    const [deepIngestResult, signalsResult] = await Promise.all([deepIngestPromise, signalsPromise]);
    deepIngestBudgetHit = Boolean(deepIngestResult?.stats?.stage_budget_hit);

    const durationMs = Date.now() - startedAt;
    if (deepIngestTimedOut) {
      log(
        `worldmonitor native refresh: deep ingest exceeded stage budget `
        + `(${Math.round(deepIngestBudgetMs / 1000)}s) and did not stop cleanly.`,
      );
    } else if (deepIngestBudgetHit) {
      log(
        `worldmonitor native refresh: deep ingest reached stage budget `
        + `(${Math.round(deepIngestBudgetMs / 1000)}s) and deferred remaining items.`,
      );
    } else if (deepIngestError) {
      log(`worldmonitor native refresh: deep ingest stage error (${redactError(deepIngestError)})`);
    }
    if (hardTimeoutMs > 0 && durationMs >= Math.max(45_000, Math.floor(hardTimeoutMs * 0.7))) {
      log(
        `worldmonitor native refresh: slow run ${Math.round(durationMs / 1000)}s `
        + `(feeds=${Math.round(feedFetchDurationMs / 1000)}s, `
        + `deep_ingest=${Math.round(deepIngestDurationMs / 1000)}s, `
        + `signals=${Math.round(signalsDurationMs / 1000)}s, `
        + `watchdog=${Math.round(hardTimeoutMs / 1000)}s).`,
      );
    }
    const slowFeeds = feedSamples
      .slice()
      .sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0))
      .slice(0, 10);
    const stats = {
      duration_ms: durationMs,
      phase_durations_ms: {
        feed_fetch: feedFetchDurationMs,
        deep_ingest: deepIngestDurationMs,
        signals: signalsDurationMs,
      },
      deep_ingest_budget_ms: deepIngestBudgetMs,
      deep_ingest_timed_out: deepIngestTimedOut,
      deep_ingest_stage_budget_hit: deepIngestBudgetHit,
      feeds_total: feeds.length,
      feeds_ok: feedsOk,
      feeds_failed: feedsFail,
      new_items: newItems,
      stored_items: worldMonitorNativeNewsItems.length,
      slow_feeds: slowFeeds,
      deep_ingest_ok: Boolean(deepIngestResult?.ok),
      deep_ingest_run_at: Number(deepIngestResult?.refreshedAt || 0) || 0,
      deep_ingest: deepIngestResult?.stats && typeof deepIngestResult.stats === "object"
        ? deepIngestResult.stats
        : {},
      signals_ok: Boolean(signalsResult?.ok),
      signals_refresh_at: Number(signalsResult?.refreshedAt || 0) || 0,
      signals: signalsResult?.stats && typeof signalsResult.stats === "object" ? signalsResult.stats : {},
      min_published_at: minPublishedAtMs > 0 ? nowIso(minPublishedAtMs) : "",
      max_items_per_source: maxItemsPerSource,
      sample_errors: errors,
    };
    worldMonitorMonitor.nativeLastRefreshAt = Date.now();
    worldMonitorMonitor.nativeLastRefreshDurationMs = durationMs;
    worldMonitorMonitor.nativeLastRefreshErrorAt = 0;
    worldMonitorMonitor.nativeLastRefreshError = "";
    worldMonitorMonitor.nativeLastRefreshStats = stats;
    persistState();
    return {
      ok: true,
      refreshedAt: Number(worldMonitorMonitor.nativeLastRefreshAt || Date.now()) || Date.now(),
      durationMs,
      stats,
    };
  })();

  const guardedRefreshPromise = withPromiseTimeout(
    refreshCorePromise,
    WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS,
    `native feed refresh timed out after ${Math.round(Number(WORLDMONITOR_NATIVE_REFRESH_HARD_TIMEOUT_MS || 0) / 1000)}s`,
  );

  const refreshPromise = guardedRefreshPromise.catch((err) => {
    const message = String(err?.message || err || "").trim() || "native feed refresh failed";
    worldMonitorMonitor.nativeLastRefreshErrorAt = Date.now();
    worldMonitorMonitor.nativeLastRefreshError = message;
    persistState();
    return { ok: false, error: message, refreshedAt: Date.now(), stats: {} };
  }).finally(() => {
    if (worldMonitorNativeRuntime.refreshPromise === refreshPromise) {
      worldMonitorNativeRuntime.refreshPromise = null;
      worldMonitorNativeRuntime.refreshStartedAt = 0;
    }
  });

  worldMonitorNativeRuntime.refreshPromise = refreshPromise;
  worldMonitorNativeRuntime.refreshStartedAt = startedAt;
  return refreshPromise;
}

function getWorldMonitorNativeRecentItems(options = {}) {
  const lookbackHours = Math.max(1, Number(options?.lookbackHours || WORLDMONITOR_CHECK_LOOKBACK_HOURS || 168));
  const minTs = Date.now() - (lookbackHours * 60 * 60 * 1000);
  return worldMonitorNativeNewsItems
    .filter((x) => !isWorldMonitorBlockedOutletItem(x))
    .filter((x) => Number(x?.publishedAt || x?.firstSeenAt || 0) >= minTs)
    .sort((a, b) => Number(b.publishedAt || b.firstSeenAt || 0) - Number(a.publishedAt || a.firstSeenAt || 0));
}

function worldMonitorItemTimestampMs(item) {
  const ts = Number(item?.publishedAt || item?.firstSeenAt || 0);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

function worldMonitorSortBySeverityThenRecency(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  return list.sort((a, b) => {
    const aRank = worldMonitorFeedAlertLevelRank(a?.threatLevel || "low");
    const bRank = worldMonitorFeedAlertLevelRank(b?.threatLevel || "low");
    if (bRank !== aRank) return bRank - aRank;
    const tsDelta = worldMonitorItemTimestampMs(b) - worldMonitorItemTimestampMs(a);
    if (tsDelta !== 0) return tsDelta;
    const sourceDelta = String(a?.source || "").localeCompare(String(b?.source || ""), undefined, { sensitivity: "base" });
    if (sourceDelta !== 0) return sourceDelta;
    return String(a?.title || "").localeCompare(String(b?.title || ""), undefined, { sensitivity: "base" });
  });
}

function selectWorldMonitorNewsListItems(options = {}) {
  const sourceItems = Array.isArray(options?.items) ? options.items : worldMonitorNativeNewsItems;
  const maxItems = toInt(options?.maxItems, WORLDMONITOR_NEWS_LIST_MAX_ITEMS, 1, 200);
  const maxDaysBack = toInt(options?.maxDaysBack, WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS, 1, WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS);
  const requestedStartDay = String(options?.startDay || utcDayKeyNow()).trim();
  const startDay = isUtcDayKey(requestedStartDay) ? requestedStartDay : utcDayKeyNow();

  const dedup = new Map();
  for (const item of sourceItems) {
    if (isWorldMonitorBlockedOutletItem(item)) continue;
    const ts = worldMonitorItemTimestampMs(item);
    if (ts <= 0) continue;
    const dayKey = utcDayKeyFromMs(ts);
    if (!dayKey) continue;
    const dedupeKey = String(item?.articleKey || "").trim()
      || normalizeWorldMonitorLink(item?.link || "")
      || `${normalizeWorldMonitorTitleForKey(item?.title || "")}|${dayKey}`;
    if (!dedupeKey) continue;
    const prev = dedup.get(dedupeKey);
    if (!prev || ts > worldMonitorItemTimestampMs(prev)) dedup.set(dedupeKey, item);
  }
  if (dedup.size <= 0) {
    return {
      items: [],
      dayKeys: [],
      poolSize: 0,
    };
  }

  const itemsByDay = new Map();
  for (const item of dedup.values()) {
    const ts = worldMonitorItemTimestampMs(item);
    if (ts <= 0) continue;
    const dayKey = utcDayKeyFromMs(ts);
    if (!dayKey) continue;
    const list = itemsByDay.get(dayKey);
    if (list) {
      list.push(item);
    } else {
      itemsByDay.set(dayKey, [item]);
    }
  }

  const pool = [];
  const pickedDayKeys = [];
  let dayCursor = startDay;
  for (let i = 0; i < maxDaysBack && dayCursor; i += 1) {
    const dayItems = itemsByDay.get(dayCursor);
    if (Array.isArray(dayItems) && dayItems.length > 0) {
      pool.push(...dayItems);
      pickedDayKeys.push(dayCursor);
      if (pool.length >= maxItems) break;
    }
    const prevDay = addUtcDays(dayCursor, -1);
    if (!prevDay || prevDay === dayCursor) break;
    dayCursor = prevDay;
  }

  // If today/fallback window had nothing, fall back to newest available days.
  if (pool.length <= 0) {
    const fallbackDays = [...itemsByDay.keys()].sort((a, b) => b.localeCompare(a));
    for (const dayKey of fallbackDays) {
      const dayItems = itemsByDay.get(dayKey);
      if (!Array.isArray(dayItems) || dayItems.length <= 0) continue;
      pool.push(...dayItems);
      pickedDayKeys.push(dayKey);
      if (pool.length >= maxItems) break;
    }
  }

  const ordered = worldMonitorSortBySeverityThenRecency(pool);
  return {
    items: ordered.slice(0, maxItems),
    dayKeys: pickedDayKeys,
    poolSize: pool.length,
  };
}

function getWorldMonitorNativeFactors(items) {
  const buckets = {
    military: 0,
    diplomacy: 0,
    economy: 0,
    cyber: 0,
    humanitarian: 0,
    unrest: 0,
  };
  for (const item of items) {
    const title = String(item?.title || "").toLowerCase();
    const w = worldMonitorFeedAlertLevelRank(item?.threatLevel || "low");
    if (/(war|military|missile|airstrike|naval|troop|drone|exercise|invasion)/i.test(title)) buckets.military += w;
    if (/(ceasefire|summit|talks|diplomacy|sanctions|embassy|treaty)/i.test(title)) buckets.diplomacy += w;
    if (/(inflation|rate|economy|oil|gas|market|tariff|trade|supply)/i.test(title)) buckets.economy += w;
    if (/(cyber|ransomware|breach|malware|hack)/i.test(title)) buckets.cyber += w;
    if (/(humanitarian|refugee|displacement|aid|famine|earthquake|wildfire)/i.test(title)) buckets.humanitarian += w;
    if (/(protest|riot|unrest|coup|martial law)/i.test(title)) buckets.unrest += w;
  }
  return Object.entries(buckets)
    .filter(([, score]) => Number(score || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 6)
    .map(([k]) => k.toUpperCase());
}

function worldMonitorCountryNamesFromCodes(codes, limit = 3) {
  const max = Math.max(1, Number(limit || 3) || 3);
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(codes) ? codes : []) {
    const code = String(raw || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const name = String(resolveWorldMonitorRegionName(code) || "").trim() || code;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function buildWorldMonitorSnapshotHeadlineContext(items, topCountries, options = {}) {
  const maxGlobal = toInt(options?.maxGlobal, 10, 1, 20);
  const maxCountries = toInt(options?.maxCountries, 5, 1, 10);
  const maxPerCountry = toInt(options?.maxPerCountry, 2, 1, 5);

  const dedup = new Map();
  const sorted = worldMonitorSortBySeverityThenRecency(Array.isArray(items) ? items : []);
  for (const item of sorted) {
    const title = oneLine(String(item?.title || "")).trim();
    if (!title) continue;
    const key = worldMonitorFeedAlertTitleKey({ title })
      || normalizeWorldMonitorLink(item?.link || "")
      || normalizeWorldMonitorTitleForKey(title);
    if (!key || dedup.has(key)) continue;
    dedup.set(key, item);
  }

  const ranked = worldMonitorSortBySeverityThenRecency([...dedup.values()]);
  const toHeadline = (item) => {
    const title = oneLine(String(item?.title || "")).trim();
    if (!title) return null;
    const ts = worldMonitorItemTimestampMs(item);
    return {
      threat_level: String(item?.threatLevel || "low").trim().toLowerCase(),
      title: title.slice(0, 220),
      source: String(item?.source || "Unknown").trim() || "Unknown",
      published_at: ts > 0 ? nowIso(ts) : "",
      countries: worldMonitorCountryNamesFromCodes(item?.countries, 3),
    };
  };

  const globalHeadlines = ranked
    .slice(0, maxGlobal)
    .map(toHeadline)
    .filter(Boolean);

  const byCountry = [];
  const countryList = Array.isArray(topCountries) ? topCountries.slice(0, maxCountries) : [];
  for (const country of countryList) {
    const region = String(country?.region || "").trim().toUpperCase();
    if (!region) continue;
    const countryName = String(country?.name || resolveWorldMonitorRegionName(region) || region).trim() || region;
    const score = Math.round(Number(country?.score || 0) || 0);
    const headlines = ranked
      .filter((item) => Array.isArray(item?.countries)
        && item.countries.some((c) => String(c || "").trim().toUpperCase() === region))
      .slice(0, maxPerCountry)
      .map(toHeadline)
      .filter(Boolean);
    byCountry.push({
      country: countryName,
      score,
      headlines,
    });
  }

  return {
    globalHeadlines,
    countryHeadlines: byCountry,
  };
}

function buildWorldMonitorNativeRiskSnapshot() {
  const items = getWorldMonitorNativeRecentItems({ lookbackHours: WORLDMONITOR_CHECK_LOOKBACK_HOURS });
  const seenCluster = new Set();
  const dedupedItems = [];
  const countryScores = new Map();
  let weightedPoints = 0;

  for (const item of items) {
    const titleKey = worldMonitorFeedAlertTitleKey({ title: String(item?.title || "") })
      || normalizeWorldMonitorTitleForKey(item?.title || "");
    if (!titleKey || seenCluster.has(titleKey)) continue;
    seenCluster.add(titleKey);
    dedupedItems.push(item);
    const level = String(item?.threatLevel || "low").toLowerCase();
    const base = level === "critical"
      ? 6
      : level === "high"
        ? 3.5
        : level === "medium"
          ? 2
          : 1;
    const taiwanBoost = Number(item?.taiwanScore || 0) > 0 ? 1.15 : 1;
    const sourceW = worldMonitorSourceWeight(item?.source || "", item?.feedSection || "");
    const points = base * taiwanBoost * sourceW;
    weightedPoints += points;
    const countries = Array.isArray(item?.countries) ? item.countries : [];
    for (const code of countries.slice(0, 3)) {
      const prev = Number(countryScores.get(code) || 0) || 0;
      countryScores.set(code, prev + points);
    }
  }

  const baseGlobalScore = Math.round(Math.min(100, 100 * (1 - Math.exp(-(weightedPoints / 130)))));
  const signalPenalty = worldMonitorAddSignalsPenalty();
  const globalScore = Math.max(0, Math.min(100, Math.round(baseGlobalScore + signalPenalty)));
  const globalLevel = globalScore >= 80
    ? "critical"
    : globalScore >= 62
      ? "high"
      : globalScore >= 38
        ? "medium"
        : "low";
  const topCountries = [...countryScores.entries()]
    .map(([region, pts]) => ({
      region,
      name: resolveWorldMonitorRegionName(region),
      score: Math.round(Math.min(100, 100 * (1 - Math.exp(-(Number(pts || 0) / 28))))),
    }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, WORLDMONITOR_TOP_COUNTRIES);

  const signalFactors = [];
  const market = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.marketSeries);
  const crypto = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.cryptoSeries);
  const seismic = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.seismicSeries);
  const infra = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.infrastructureSeries);
  const adsb = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.adsbSeries);
  const disaster = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.disasterSeries);
  const maritime = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.maritimeSeries);
  const service = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.serviceSeries);
  const macro = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.macroSeries);
  const prediction = worldMonitorLatestSeriesItem(worldMonitorNativeSignals.predictionSeries);
  if (market?.metrics && Number(market.metrics?.TWSE?.changePct || 0) <= -2) signalFactors.push("MARKET_TW_STRESS");
  if (market?.metrics && Number(market.metrics?.WTI_OIL?.changePct || 0) >= 4) signalFactors.push("ENERGY_SPIKE");
  if (crypto?.metrics && Math.abs(Number(crypto.metrics?.USDT?.usd || 1) - 1) >= 0.01) signalFactors.push("STABLECOIN_DEPEG");
  if (seismic && Number(seismic.maxMag24h || 0) >= 6.8) signalFactors.push("SEISMIC_MAJOR");
  if (infra && Number(infra.total24h || 0) >= 8 && Number(infra.deltaPct || 0) >= 50) signalFactors.push("INFRA_DISRUPTION_SPIKE");
  if (adsb && Number(adsb.taiwanMilitaryFlights || 0) >= 6) signalFactors.push("ADSB_TW_STRESS");
  if (adsb && (Number(adsb?.byType?.tanker || 0) + Number(adsb?.byType?.awacs || 0)) >= 3) signalFactors.push("ADSB_FORCE_PROJECTION");
  if (disaster && Number(disaster.currentRed || 0) >= 1) signalFactors.push("DISASTER_RED_ALERT");
  if (disaster && Number(disaster.taiwanRegionOrangeOrRed || 0) >= 1) signalFactors.push("DISASTER_WESTPAC_ALERT");
  if (maritime && Number(maritime.taiwanRegionWarnings || 0) >= 4) signalFactors.push("MARITIME_TW_WARNING_CLUSTER");
  if (maritime && Number(maritime.militaryRelated || 0) >= 25) signalFactors.push("MARITIME_MIL_WARNING_SPIKE");
  if (service && Number(service.outageCount || 0) >= 2) signalFactors.push("SERVICE_OUTAGE_CLUSTER");
  if (macro && String(macro.riskRegime || "").toLowerCase() === "risk_off") signalFactors.push("MACRO_RISK_OFF");
  if (macro && Number(macro?.metrics?.fearGreedValue || 50) <= 15) signalFactors.push("MACRO_EXTREME_FEAR");
  if (prediction && Number(prediction.taiwanRelatedCount || 0) >= 3) signalFactors.push("PREDICTION_TW_ACTIVITY");
  if (prediction && Number(prediction.highVolumeUncertainCount || 0) >= 6) signalFactors.push("PREDICTION_UNCERTAINTY_SPIKE");

  const headlineContext = buildWorldMonitorSnapshotHeadlineContext(dedupedItems, topCountries, {
    maxGlobal: 10,
    maxCountries: 5,
    maxPerCountry: 2,
  });

  return {
    fetchedAt: Date.now(),
    sourceUrl: "native://worldmonitor-feed-engine",
    globalScore,
    globalLevel,
    globalFactors: [...new Set([...getWorldMonitorNativeFactors(dedupedItems), ...signalFactors])].slice(0, 8),
    topCountries,
    headlineEvidence: headlineContext.globalHeadlines,
    countryHeadlineEvidence: headlineContext.countryHeadlines,
  };
}

function buildWorldMonitorNativeFeedAlerts(sinceMs = 0) {
  const minSeen = Math.max(0, Number(sinceMs || 0) || 0);
  const groups = new Map();
  for (const item of worldMonitorNativeNewsItems) {
    if (isWorldMonitorBlockedOutletItem(item)) continue;
    const seenAt = Number(item?.firstSeenAt || item?.publishedAt || 0) || 0;
    if (seenAt <= 0 || seenAt < minSeen) continue;
    const title = String(item?.title || "").trim();
    const link = normalizeWorldMonitorLink(item?.link || "");
    if (!title || !link) continue;
    const titleKey = worldMonitorFeedAlertTitleKey({ title });
    const dedupeKey = titleKey || `${String(item?.source || "").toLowerCase()}|${normalizeWorldMonitorTitleForKey(title)}`;
    const prev = groups.get(dedupeKey);
    const candidate = {
      key: String(item?.articleKey || `${dedupeKey}|${link}`).trim(),
      titleKey,
      source: String(item?.source || "Unknown").trim() || "Unknown",
      title,
      link,
      threatLevel: String(item?.threatLevel || "low").trim().toLowerCase(),
      publishedAt: Number(item?.publishedAt || item?.firstSeenAt || 0) || 0,
      firstSeenAt: seenAt,
    };
    if (!prev) {
      groups.set(dedupeKey, candidate);
      continue;
    }
    const prevRank = worldMonitorFeedAlertLevelRank(prev.threatLevel);
    const nextRank = worldMonitorFeedAlertLevelRank(candidate.threatLevel);
    if (nextRank > prevRank || (nextRank === prevRank && candidate.firstSeenAt < prev.firstSeenAt)) {
      groups.set(dedupeKey, candidate);
    }
  }
  return [...groups.values()]
    .sort((a, b) => Number(a.firstSeenAt || 0) - Number(b.firstSeenAt || 0));
}

function findWorldMonitorItemForAlert(alert) {
  const key = String(alert?.key || "").trim();
  const link = normalizeWorldMonitorLink(alert?.link || "");
  const titleKey = worldMonitorFeedAlertTitleKey({ title: String(alert?.title || "") });

  if (key) {
    for (let i = worldMonitorNativeNewsItems.length - 1; i >= 0; i -= 1) {
      const item = worldMonitorNativeNewsItems[i];
      if (String(item?.articleKey || "").trim() === key) return item;
    }
  }
  if (link) {
    for (let i = worldMonitorNativeNewsItems.length - 1; i >= 0; i -= 1) {
      const item = worldMonitorNativeNewsItems[i];
      if (normalizeWorldMonitorLink(item?.link || "") === link) return item;
    }
  }
  if (titleKey) {
    for (let i = worldMonitorNativeNewsItems.length - 1; i >= 0; i -= 1) {
      const item = worldMonitorNativeNewsItems[i];
      const k = worldMonitorFeedAlertTitleKey({ title: String(item?.title || "") });
      if (k && k === titleKey) return item;
    }
  }
  return null;
}

function compactWorldMonitorArticleContext(context) {
  const ctx = context && typeof context === "object" ? context : null;
  if (!ctx || String(ctx.status || "").toLowerCase() !== "ok") return null;
  const summary = String(ctx.summary || "").trim();
  if (!summary) return null;
  return {
    summary: summary.slice(0, WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_CHARS),
    key_points: Array.isArray(ctx.keyPoints)
      ? ctx.keyPoints.map((x) => oneLine(x)).filter(Boolean).slice(0, 3)
      : [],
    source_title: oneLine(String(ctx.articleTitle || "")),
    site_name: oneLine(String(ctx.siteName || "")),
    lang: oneLine(String(ctx.lang || "")),
    author: oneLine(String(ctx.author || "")),
    published_at: Number(ctx.articlePublishedAt || 0) > 0 ? nowIso(Number(ctx.articlePublishedAt || 0)) : "",
    fetched_at: Number(ctx.fetchedAt || 0) > 0 ? nowIso(Number(ctx.fetchedAt || 0)) : "",
  };
}

function buildWorldMonitorArticleContextStats(sinceMs = 0) {
  const minTs = Math.max(0, Number(sinceMs || 0) || 0);
  let total = 0;
  let ok = 0;
  let errors = 0;
  let pending = 0;
  let taiwanRelated = 0;
  let taiwanSummarized = 0;
  for (const item of worldMonitorNativeNewsItems) {
    const ts = Number(item?.publishedAt || item?.firstSeenAt || 0) || 0;
    if (minTs > 0 && ts < minTs) continue;
    total += 1;
    const tw = Number(item?.taiwanScore || 0) > 0;
    if (tw) taiwanRelated += 1;
    const ctx = getWorldMonitorItemArticleContext(item);
    const status = String(ctx?.status || "").toLowerCase();
    if (status === "ok" && String(ctx?.summary || "").trim()) {
      ok += 1;
      if (tw) taiwanSummarized += 1;
    } else if (status === "error") {
      errors += 1;
    } else {
      pending += 1;
    }
  }
  return {
    total_items: total,
    summarized_items: ok,
    errored_items: errors,
    pending_items: pending,
    coverage_pct: total > 0 ? Math.round((ok / total) * 1000) / 10 : 0,
    taiwan_items: taiwanRelated,
    taiwan_summarized_items: taiwanSummarized,
    taiwan_coverage_pct: taiwanRelated > 0 ? Math.round((taiwanSummarized / taiwanRelated) * 1000) / 10 : 0,
  };
}

function buildWorldMonitorArticleThemeSnapshot(sinceMs = 0) {
  const minTs = Math.max(0, Number(sinceMs || 0) || 0);
  const themes = [
    { id: "military", re: /(military|troop|exercise|missile|airstrike|drone|naval|warship|fighter|defense)/i },
    { id: "taiwan_china", re: /(taiwan|taipei|taiwan strait|china|beijing|pla|south china sea|east china sea)/i },
    { id: "diplomacy", re: /(summit|talks|negotiation|ceasefire|treaty|sanction|embassy|diplomatic)/i },
    { id: "economy", re: /(market|inflation|rate|bond|oil|gas|trade|tariff|currency|supply chain)/i },
    { id: "cyber", re: /(cyber|ransomware|hack|malware|breach|ddos)/i },
    { id: "humanitarian", re: /(refugee|displacement|aid|humanitarian|famine|casualties|evacuation)/i },
    { id: "infrastructure", re: /(port|harbor|harbour|pipeline|subsea|cable|shipping|chokepoint)/i },
    { id: "disaster", re: /(earthquake|wildfire|flood|storm|typhoon|drought|disaster)/i },
  ];
  const counts = new Map(themes.map((x) => [x.id, 0]));
  let summarized = 0;
  for (const item of worldMonitorNativeNewsItems) {
    const ts = Number(item?.publishedAt || item?.firstSeenAt || 0) || 0;
    if (minTs > 0 && ts < minTs) continue;
    const ctx = getWorldMonitorItemArticleContext(item);
    if (!ctx || String(ctx.status || "").toLowerCase() !== "ok") continue;
    const summary = String(ctx.summary || "").trim();
    if (!summary) continue;
    summarized += 1;
    const text = `${String(item?.title || "")} ${summary}`.toLowerCase();
    const weight = Math.max(1, worldMonitorFeedAlertLevelRank(item?.threatLevel || "low") - 1);
    for (const theme of themes) {
      if (theme.re.test(text)) {
        const prev = Number(counts.get(theme.id) || 0) || 0;
        counts.set(theme.id, prev + weight);
      }
    }
  }
  const topThemes = [...counts.entries()]
    .map(([id, count]) => ({ theme: id, score: Number(count || 0) || 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  return {
    summarized_items: summarized,
    top_themes: topThemes,
  };
}

function parseWorldMonitorQueryTerms(query) {
  const src = String(query || "").trim();
  if (!src) return [];
  return src
    .replace(/[()"]/g, " ")
    .split(/\bOR\b|\bAND\b|[,\n]+/i)
    .map((x) => normalizeWorldMonitorTitleForKey(x))
    .filter((x) => x && x.length >= 3 && !["site", "when", "sourcelang", "date", "sort"].includes(x))
    .slice(0, 24);
}

function buildWorldMonitorNativeSignalContext() {
  const now = Date.now();
  const dayAgo = now - (24 * 60 * 60 * 1000);
  const marketSeries = Array.isArray(worldMonitorNativeSignals.marketSeries) ? worldMonitorNativeSignals.marketSeries : [];
  const cryptoSeries = Array.isArray(worldMonitorNativeSignals.cryptoSeries) ? worldMonitorNativeSignals.cryptoSeries : [];
  const seismicSeries = Array.isArray(worldMonitorNativeSignals.seismicSeries) ? worldMonitorNativeSignals.seismicSeries : [];
  const infraSeries = Array.isArray(worldMonitorNativeSignals.infrastructureSeries) ? worldMonitorNativeSignals.infrastructureSeries : [];
  const adsbSeries = Array.isArray(worldMonitorNativeSignals.adsbSeries) ? worldMonitorNativeSignals.adsbSeries : [];
  const disasterSeries = Array.isArray(worldMonitorNativeSignals.disasterSeries) ? worldMonitorNativeSignals.disasterSeries : [];
  const maritimeSeries = Array.isArray(worldMonitorNativeSignals.maritimeSeries) ? worldMonitorNativeSignals.maritimeSeries : [];
  const serviceSeries = Array.isArray(worldMonitorNativeSignals.serviceSeries) ? worldMonitorNativeSignals.serviceSeries : [];
  const macroSeries = Array.isArray(worldMonitorNativeSignals.macroSeries) ? worldMonitorNativeSignals.macroSeries : [];
  const predictionSeries = Array.isArray(worldMonitorNativeSignals.predictionSeries) ? worldMonitorNativeSignals.predictionSeries : [];

  const marketLatest = worldMonitorLatestSeriesItem(marketSeries);
  const cryptoLatest = worldMonitorLatestSeriesItem(cryptoSeries);
  const seismicLatest = worldMonitorLatestSeriesItem(seismicSeries);
  const infraLatest = worldMonitorLatestSeriesItem(infraSeries);
  const adsbLatest = worldMonitorLatestSeriesItem(adsbSeries);
  const disasterLatest = worldMonitorLatestSeriesItem(disasterSeries);
  const maritimeLatest = worldMonitorLatestSeriesItem(maritimeSeries);
  const serviceLatest = worldMonitorLatestSeriesItem(serviceSeries);
  const macroLatest = worldMonitorLatestSeriesItem(macroSeries);
  const predictionLatest = worldMonitorLatestSeriesItem(predictionSeries);

  const market24 = marketSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const crypto24 = cryptoSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const infra24 = infraSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const adsb24 = adsbSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const disaster24 = disasterSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const maritime24 = maritimeSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const service24 = serviceSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const macro24 = macroSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);
  const prediction24 = predictionSeries.filter((x) => Number(x?.ts || 0) >= dayAgo);

  function metricDeltaPct(series, pathA, pathB = null) {
    if (!Array.isArray(series) || series.length < 2) return 0;
    const first = series[0];
    const last = series[series.length - 1];
    const get = (obj, keyPath) => {
      const keys = String(keyPath || "").split(".").filter(Boolean);
      let cur = obj;
      for (const k of keys) {
        if (!cur || typeof cur !== "object") return NaN;
        cur = cur[k];
      }
      return Number(cur);
    };
    const start = get(first, pathA);
    const end = pathB ? get(last, pathB) : get(last, pathA);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return 0;
    return ((end - start) / Math.abs(start)) * 100;
  }

  return {
    source_mode: "native",
    refresh: {
      feed_last_at: Number(worldMonitorMonitor.nativeLastRefreshAt || 0) || 0,
      signals_last_at: Number(worldMonitorMonitor.nativeSignalsLastRefreshAt || 0) || 0,
    },
    market: marketLatest ? {
      ts: Number(marketLatest.ts || 0) || 0,
      metrics: worldMonitorNonEmptyObject(marketLatest.metrics),
      twse_24h_delta_pct: metricDeltaPct(market24, "metrics.TWSE.price"),
      oil_24h_delta_pct: metricDeltaPct(market24, "metrics.WTI_OIL.price"),
      dxy_24h_delta_pct: metricDeltaPct(market24, "metrics.DOLLAR_INDEX.price"),
    } : null,
    crypto: cryptoLatest ? {
      ts: Number(cryptoLatest.ts || 0) || 0,
      metrics: worldMonitorNonEmptyObject(cryptoLatest.metrics),
      btc_24h_delta_pct: metricDeltaPct(crypto24, "metrics.BTC.usd"),
      eth_24h_delta_pct: metricDeltaPct(crypto24, "metrics.ETH.usd"),
    } : null,
    seismic: seismicLatest ? {
      ts: Number(seismicLatest.ts || 0) || 0,
      count24h: Number(seismicLatest.count24h || 0) || 0,
      majorCount24h: Number(seismicLatest.majorCount24h || 0) || 0,
      maxMag24h: Number(seismicLatest.maxMag24h || 0) || 0,
      majorEvents: Array.isArray(seismicLatest.majorEvents) ? seismicLatest.majorEvents.slice(0, 6) : [],
    } : null,
    infrastructure: infraLatest ? {
      ts: Number(infraLatest.ts || 0) || 0,
      cables24h: Number(infraLatest.cables24h || 0) || 0,
      ports24h: Number(infraLatest.ports24h || 0) || 0,
      pipelines24h: Number(infraLatest.pipelines24h || 0) || 0,
      total24h: Number(infraLatest.total24h || 0) || 0,
      totalPrev24h: Number(infraLatest.totalPrev24h || 0) || 0,
      deltaPct: Number(infraLatest.deltaPct || 0) || 0,
      trend_24h_delta_pct: metricDeltaPct(infra24, "total24h"),
    } : null,
    adsb: adsbLatest ? {
      ts: Number(adsbLatest.ts || 0) || 0,
      totalFlights: Number(adsbLatest.totalFlights || 0) || 0,
      militaryFlights: Number(adsbLatest.militaryFlights || 0) || 0,
      militaryRatioPct: Number(adsbLatest.militaryRatioPct || 0) || 0,
      taiwanTheaterFlights: Number(adsbLatest.taiwanTheaterFlights || 0) || 0,
      taiwanMilitaryFlights: Number(adsbLatest.taiwanMilitaryFlights || 0) || 0,
      byType: worldMonitorNonEmptyObject(adsbLatest.byType),
      theaterCounts: Array.isArray(adsbLatest.theaterCounts) ? adsbLatest.theaterCounts.slice(0, 6) : [],
      taiwan_military_24h_delta_pct: metricDeltaPct(adsb24, "taiwanMilitaryFlights"),
      military_24h_delta_pct: metricDeltaPct(adsb24, "militaryFlights"),
    } : null,
    disaster: disasterLatest ? {
      ts: Number(disasterLatest.ts || 0) || 0,
      totalParsed: Number(disasterLatest.totalParsed || 0) || 0,
      recent72h: Number(disasterLatest.recent72h || 0) || 0,
      currentTotal: Number(disasterLatest.currentTotal || 0) || 0,
      currentRed: Number(disasterLatest.currentRed || 0) || 0,
      currentOrange: Number(disasterLatest.currentOrange || 0) || 0,
      currentGreen: Number(disasterLatest.currentGreen || 0) || 0,
      taiwanRegionCurrent: Number(disasterLatest.taiwanRegionCurrent || 0) || 0,
      taiwanRegionOrangeOrRed: Number(disasterLatest.taiwanRegionOrangeOrRed || 0) || 0,
      byType: worldMonitorNonEmptyObject(disasterLatest.byType),
      topAlerts: Array.isArray(disasterLatest.topAlerts) ? disasterLatest.topAlerts.slice(0, 8) : [],
      current_red_24h_delta_pct: metricDeltaPct(disaster24, "currentRed"),
      current_orange_24h_delta_pct: metricDeltaPct(disaster24, "currentOrange"),
    } : null,
    maritime: maritimeLatest ? {
      ts: Number(maritimeLatest.ts || 0) || 0,
      totalWarnings: Number(maritimeLatest.totalWarnings || 0) || 0,
      militaryRelated: Number(maritimeLatest.militaryRelated || 0) || 0,
      taiwanRegionWarnings: Number(maritimeLatest.taiwanRegionWarnings || 0) || 0,
      regionCounts: worldMonitorNonEmptyObject(maritimeLatest.regionCounts),
      keyWarnings: Array.isArray(maritimeLatest.keyWarnings) ? maritimeLatest.keyWarnings.slice(0, 8) : [],
      taiwan_region_24h_delta_pct: metricDeltaPct(maritime24, "taiwanRegionWarnings"),
      military_related_24h_delta_pct: metricDeltaPct(maritime24, "militaryRelated"),
    } : null,
    services: serviceLatest ? {
      ts: Number(serviceLatest.ts || 0) || 0,
      totalServices: Number(serviceLatest.totalServices || 0) || 0,
      okCount: Number(serviceLatest.okCount || 0) || 0,
      degradedCount: Number(serviceLatest.degradedCount || 0) || 0,
      outageCount: Number(serviceLatest.outageCount || 0) || 0,
      services: Array.isArray(serviceLatest.services) ? serviceLatest.services.slice(0, 12) : [],
      degraded_24h_delta_pct: metricDeltaPct(service24, "degradedCount"),
      outage_24h_delta_pct: metricDeltaPct(service24, "outageCount"),
    } : null,
    macro: macroLatest ? {
      ts: Number(macroLatest.ts || 0) || 0,
      riskRegime: String(macroLatest.riskRegime || "").toLowerCase(),
      riskOnSignals: Number(macroLatest.riskOnSignals || 0) || 0,
      knownSignals: Number(macroLatest.knownSignals || 0) || 0,
      metrics: worldMonitorNonEmptyObject(macroLatest.metrics),
      seriesCoverage: worldMonitorNonEmptyObject(macroLatest.seriesCoverage),
      fearGreedHistory: Array.isArray(macroLatest.fearGreedHistory) ? macroLatest.fearGreedHistory.slice(0, 20) : [],
      qqq_24h_delta_pct: metricDeltaPct(macro24, "metrics.qqqRoc20Pct"),
      fear_greed_24h_delta_pct: metricDeltaPct(macro24, "metrics.fearGreedValue"),
    } : null,
    prediction: predictionLatest ? {
      ts: Number(predictionLatest.ts || 0) || 0,
      totalActiveEvents: Number(predictionLatest.totalActiveEvents || 0) || 0,
      taiwanRelatedCount: Number(predictionLatest.taiwanRelatedCount || 0) || 0,
      highVolumeUncertainCount: Number(predictionLatest.highVolumeUncertainCount || 0) || 0,
      topByVolume: Array.isArray(predictionLatest.topByVolume) ? predictionLatest.topByVolume.slice(0, 10) : [],
      taiwanRelatedTop: Array.isArray(predictionLatest.taiwanRelatedTop) ? predictionLatest.taiwanRelatedTop.slice(0, 8) : [],
      taiwan_related_24h_delta_pct: metricDeltaPct(prediction24, "taiwanRelatedCount"),
      uncertainty_24h_delta_pct: metricDeltaPct(prediction24, "highVolumeUncertainCount"),
    } : null,
  };
}

async function fetchWorldMonitorNativeRiskSnapshot(options = {}) {
  const refresh = await runWorldMonitorNativeFeedRefresh({ force: options?.force === true });
  if (!refresh?.ok) {
    throw new Error(String(refresh?.error || "native refresh failed"));
  }
  return buildWorldMonitorNativeRiskSnapshot();
}

async function fetchWorldMonitorNativeFeedAlerts(options = {}) {
  const refresh = await runWorldMonitorNativeFeedRefresh({ force: options?.force === true });
  if (!refresh?.ok) {
    throw new Error(String(refresh?.error || "native refresh failed"));
  }
  return buildWorldMonitorNativeFeedAlerts(Number(options?.sinceMs || 0));
}

async function fetchWorldMonitorNativeCountryIntelBrief(countryCode, options = {}) {
  const code = String(countryCode || "").trim().toUpperCase() || "TW";
  const label = resolveWorldMonitorRegionName(code) || code;
  const force = options?.force === true;
  await runWorldMonitorNativeFeedRefresh({ force });
  const relevant = getWorldMonitorNativeRecentItems({ lookbackHours: WORLDMONITOR_CHECK_LOOKBACK_HOURS })
    .filter((x) => {
      const countries = Array.isArray(x?.countries) ? x.countries : [];
      if (countries.includes(code)) return true;
      if (code === "TW") return Number(x?.taiwanScore || 0) > 0;
      return false;
    })
    .slice(0, 40);
  if (relevant.length === 0) {
    return {
      countryCode: code,
      countryName: label,
      brief: `No strong ${label} signal in the most recent feed window.`,
      model: "native-feed-engine",
      generatedAt: Date.now(),
    };
  }
  const counts = { critical: 0, high: 0, medium: 0 };
  for (const x of relevant) {
    const lvl = String(x?.threatLevel || "").toLowerCase();
    if (lvl === "critical" || lvl === "high" || lvl === "medium") counts[lvl] += 1;
  }
  const top = relevant.slice(0, 4).map((x) => String(x?.title || "").trim()).filter(Boolean);
  const brief = [
    `${label}: ${relevant.length} relevant headlines in the last ${WORLDMONITOR_CHECK_LOOKBACK_HOURS}h.`,
    `Risk mix: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}.`,
    top.length > 0 ? `Recent signals: ${top.join(" | ")}` : "",
  ].filter(Boolean).join(" ");
  return {
    countryCode: code,
    countryName: label,
    brief: oneLine(brief),
    model: "native-feed-engine",
    generatedAt: Date.now(),
  };
}

async function fetchWorldMonitorNativePizzintStatus(options = {}) {
  const force = options?.force === true;
  await runWorldMonitorNativeFeedRefresh({ force });
  const items = getWorldMonitorNativeRecentItems({ lookbackHours: WORLDMONITOR_CHECK_LOOKBACK_HOURS });
  const keyItems = items.filter((x) => worldMonitorFeedAlertLevelRank(x?.threatLevel || "low") >= 3);
  const countryCount = new Set(keyItems.flatMap((x) => Array.isArray(x?.countries) ? x.countries : [])).size;
  const pairDefs = [
    ["US_RU", "United States vs Russia", ["US", "RU"]],
    ["RU_UA", "Russia vs Ukraine", ["RU", "UA"]],
    ["US_CN", "United States vs China", ["US", "CN"]],
    ["CN_TW", "China vs Taiwan", ["CN", "TW"]],
    ["US_IR", "United States vs Iran", ["US", "IR"]],
    ["US_KP", "United States vs North Korea", ["US", "KP"]],
  ];
  const pairs = pairDefs.map(([id, label, members]) => {
    const hit = keyItems.filter((x) => {
      const countries = new Set(Array.isArray(x?.countries) ? x.countries : []);
      return members.every((c) => countries.has(c));
    }).length;
    const score = Math.round(Math.min(100, hit * 11));
    return {
      id,
      label,
      score,
      trend: "stable",
      changePercent: 0,
    };
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const maxPairScore = Number(pairs[0]?.score || 0);
  const defconLevel = maxPairScore >= 80 ? 2 : maxPairScore >= 60 ? 3 : maxPairScore >= 35 ? 4 : 5;
  const defconLabel = defconLevel <= 2 ? "high" : defconLevel === 3 ? "elevated" : "guarded";
  return {
    defconLevel,
    defconLabel,
    aggregateActivity: keyItems.length,
    activeSpikes: keyItems.filter((x) => String(x?.threatLevel || "").toLowerCase() === "critical").length,
    locationsOpen: countryCount,
    updatedAt: Date.now(),
    tensionPairs: pairs.slice(0, 8),
  };
}

async function fetchWorldMonitorNativeGdeltDocuments(query, options = {}) {
  await runWorldMonitorNativeFeedRefresh({ force: options?.force === true });
  const terms = parseWorldMonitorQueryTerms(query);
  const limit = Math.max(1, Number(options?.maxRecords || 8) || 8);
  const items = getWorldMonitorNativeRecentItems({ lookbackHours: WORLDMONITOR_CHECK_LOOKBACK_HOURS });
  const matched = [];
  for (const item of items) {
    const title = String(item?.title || "").toLowerCase();
    if (!title) continue;
    if (terms.length > 0 && !terms.some((term) => title.includes(term))) continue;
    const articleCtx = compactWorldMonitorArticleContext(getWorldMonitorItemArticleContext(item));
    matched.push({
      title: String(item?.title || "").trim(),
      source: String(item?.source || "").trim() || "Unknown",
      url: normalizeWorldMonitorLink(item?.link || ""),
      date: nowIso(Number(item?.publishedAt || item?.firstSeenAt || Date.now()) || Date.now()),
      article_context: articleCtx,
    });
    if (matched.length >= limit) break;
  }
  return {
    query: String(query || "").trim(),
    error: "",
    articles: matched,
  };
}

async function fetchWorldMonitorCountryIntelBrief(countryCode, options = {}) {
  return fetchWorldMonitorNativeCountryIntelBrief(countryCode, options);
}

async function fetchWorldMonitorPizzintStatus(options = {}) {
  return fetchWorldMonitorNativePizzintStatus(options);
}

async function fetchWorldMonitorGdeltDocuments(query, options = {}) {
  return fetchWorldMonitorNativeGdeltDocuments(query, options);
}

function isTaiwanRelevantHeadline(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("taiwan")
    || lower.includes("taipei")
    || lower.includes("taiwan strait")
    || lower.includes("strait")
    || lower.includes("china")
    || lower.includes("beijing")
    || lower.includes("pla")
    || lower.includes("prc")
    || lower.includes("kinmen")
    || lower.includes("matsu")
    || lower.includes("penghu")
    || lower.includes("south china sea")
    || lower.includes("east china sea")
  );
}

function worldMonitorAlertUrlHost(rawUrl) {
  return worldMonitorOutletHostFromUrl(rawUrl);
}

function isWorldMonitorAggregatorHost(host) {
  const clean = String(host || "").trim().toLowerCase();
  if (!clean) return false;
  return (
    clean === "news.google.com"
    || clean === "news.yahoo.com"
    || clean.endsWith(".googlenews.com")
  );
}

function isWorldMonitorDocumentUrl(rawUrl) {
  const url = normalizeWorldMonitorLink(rawUrl || "");
  if (!url) return false;
  return (
    /\.(pdf|doc|docx|ppt|pptx|xls|xlsx)(?:$|[?#])/i.test(url)
    || /[?&](?:format|output)=pdf(?:[&#]|$)/i.test(url)
    || /\/(?:download|attachment)(?:\/|$)/i.test(url)
  );
}

function isWorldMonitorLowQualityArticleContext(ctx) {
  const context = ctx && typeof ctx === "object" ? ctx : null;
  if (!context || String(context.status || "").toLowerCase() !== "ok") return true;
  const summary = oneLine(String(context.summary || ""));
  if (!summary) return true;
  const lower = summary.toLowerCase();
  if (summary.length < 90) return true;
  if (
    lower.includes("comprehensive up-to-date news coverage")
    || lower.includes("aggregated from sources all over the world")
    || lower.includes("google news")
  ) {
    return true;
  }
  return false;
}

function resolveWorldMonitorAlertBestLink(alert, item, ctx = null) {
  const urls = [
    normalizeWorldMonitorLink(ctx?.finalUrl || ""),
    normalizeWorldMonitorLink(item?.link || ""),
    normalizeWorldMonitorLink(alert?.link || ""),
  ].filter(Boolean);
  const nonAggregator = urls.filter((u) => !isWorldMonitorAggregatorHost(worldMonitorAlertUrlHost(u)));
  return nonAggregator[0] || urls[0] || "";
}

function isWorldMonitorAlertForwardable(alert, item = null, ctx = null) {
  const now = Date.now();
  const publishedAt = Number(alert?.publishedAt || item?.publishedAt || 0) || 0;
  if (publishedAt > 0) {
    const ageMs = now - publishedAt;
    const maxAgeMs = Math.max(1, Number(WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS || 6)) * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) return false;
  }

  const urls = [
    normalizeWorldMonitorLink(alert?.link || ""),
    normalizeWorldMonitorLink(item?.link || ""),
    normalizeWorldMonitorLink(ctx?.finalUrl || ""),
  ].filter(Boolean);
  if (urls.length <= 0) return false;

  if (WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS) {
    const candidate = resolveWorldMonitorAlertBestLink(alert, item, ctx);
    if (!candidate || isWorldMonitorDocumentUrl(candidate)) return false;
  }

  if (WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS) {
    const candidate = resolveWorldMonitorAlertBestLink(alert, item, ctx);
    const host = worldMonitorAlertUrlHost(candidate);
    if (!host || isWorldMonitorAggregatorHost(host)) return false;
  }

  if (WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY && WORLDMONITOR_DEEP_INGEST_ENABLED) {
    if (isWorldMonitorLowQualityArticleContext(ctx)) return false;
  }
  return true;
}

function worldMonitorSelectMixedAlerts(alerts, limit = 16) {
  const source = Array.isArray(alerts) ? alerts : [];
  const maxItems = Math.max(4, Number(limit) || 16);
  const buckets = {
    critical: [],
    high: [],
    medium: [],
    low: [],
    other: [],
  };
  for (const alert of source) {
    const level = String(alert?.threatLevel || "").trim().toLowerCase();
    if (level === "critical" || level === "high" || level === "medium" || level === "low") {
      buckets[level].push(alert);
    } else {
      buckets.other.push(alert);
    }
  }

  const selected = [];
  const seen = new Set();
  const add = (alert) => {
    if (!alert || selected.length >= maxItems) return false;
    const key = String(alert?.key || "").trim()
      || String(alert?.titleKey || "").trim()
      || normalizeWorldMonitorTitleForKey(alert?.title || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    selected.push(alert);
    return true;
  };

  const quotas = {
    critical: Math.max(0, Math.min(buckets.critical.length, Math.round(maxItems * 0.28))),
    high: Math.max(0, Math.min(buckets.high.length, Math.round(maxItems * 0.30))),
    medium: Math.max(0, Math.min(buckets.medium.length, Math.round(maxItems * 0.27))),
    low: Math.max(0, Math.min(buckets.low.length, Math.round(maxItems * 0.15))),
  };

  for (let i = 0; i < quotas.critical; i += 1) add(buckets.critical[i]);
  for (let i = 0; i < quotas.high; i += 1) add(buckets.high[i]);
  for (let i = 0; i < quotas.medium; i += 1) add(buckets.medium[i]);
  for (let i = 0; i < quotas.low; i += 1) add(buckets.low[i]);

  for (const alert of source) {
    if (selected.length >= maxItems) break;
    add(alert);
  }

  return {
    items: selected,
    selected_by_level: {
      critical: selected.filter((x) => String(x?.threatLevel || "").toLowerCase() === "critical").length,
      high: selected.filter((x) => String(x?.threatLevel || "").toLowerCase() === "high").length,
      medium: selected.filter((x) => String(x?.threatLevel || "").toLowerCase() === "medium").length,
      low: selected.filter((x) => String(x?.threatLevel || "").toLowerCase() === "low").length,
      other: selected.filter((x) => {
        const level = String(x?.threatLevel || "").toLowerCase();
        return level !== "critical" && level !== "high" && level !== "medium" && level !== "low";
      }).length,
    },
  };
}

function buildWorldMonitorComprehensivePrompt(packet) {
  return [
    "You are producing a concise but thorough strategic WorldMonitor brief for a user living in Taiwan.",
    "Use only the telemetry packet.",
    "The packet can include multi-signal context (news, market/crypto moves, seismic, infrastructure stress).",
    "Use mixed news levels (critical/high/medium/low) to infer trend direction, not only crisis spikes.",
    "",
    "Output format exactly:",
    "HEADLINE:",
    "- One sentence, <= 20 words.",
    "EVIDENCE_CHAIN:",
    "- 3 to 5 bullets in the form: [level] concrete headline/signal (source) -> what it indicates -> why it changes risk.",
    "GLOBAL:",
    "- 3 to 4 bullets in the form: signal -> why it matters now.",
    "TAIWAN:",
    "- 3 to 4 bullets focused on Taiwan-China security, diplomacy, economic spillover, and info-domain risk.",
    "RISK:",
    "- Global level: <critical|high|medium|low> (score X/100, trend up|flat|down).",
    "- Taiwan posture: <escalating|elevated|stable|easing> with a short reason.",
    "- Key triggers: 1-2 short lines naming strongest trigger conditions that were met.",
    "WATCH_24H:",
    "- 3 concrete indicators to monitor in the next 24 hours.",
    "BOTTOM_LINE:",
    "- One sentence plain-language takeaway.",
    "CONFIDENCE: low|medium|high",
    "",
    "Rules:",
    "- Use full country names, never ISO codes (no TW/UA/etc).",
    "- Keep language clear and easy to read aloud (TTS-friendly).",
    "- In EVIDENCE_CHAIN, use at least 3 concrete items from feed_alerts, key_evidence, gdelt, or signal_context.",
    "- Include at least 2 headline-level references (title + source) when available.",
    "- Include one brief counter-signal if data shows one.",
    "- If article_context summaries are present, prioritize them over headline-only interpretation.",
    "- Never invent facts, links, or numbers not in the packet.",
    "- Keep total output under 340 words.",
    "- If data is missing or stale, mention that briefly.",
    "",
    `TELEMETRY_PACKET=${JSON.stringify(packet)}`,
  ].join("\n");
}

function worldMonitorFeedAlertLevelRank(level) {
  const clean = String(level || "").trim().toLowerCase();
  if (clean === "critical") return 5;
  if (clean === "high") return 4;
  if (clean === "medium") return 3;
  if (clean === "low") return 2;
  return 1;
}

const WORLDMONITOR_FEED_ALERT_TITLE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but",
  "to", "for", "of", "in", "on", "at", "by", "from", "with", "without", "into", "over", "under",
  "after", "before", "during", "amid", "amidst", "as",
  "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "their", "his", "her", "they", "he", "she", "we",
  "new", "latest", "breaking", "live", "update", "updates", "analysis", "watch",
  "video", "videos", "photo", "photos", "report", "reports",
]);

function normalizeWorldMonitorFeedAlertTitleToken(rawToken) {
  let token = String(rawToken || "").trim().toLowerCase();
  if (!token) return "";
  if (/^\d+$/.test(token)) return "";
  if (token.length > 5 && token.endsWith("ing")) {
    token = token.slice(0, -3);
  } else if (token.length > 4 && token.endsWith("ed")) {
    token = token.slice(0, -2);
  } else if (token.length > 4 && token.endsWith("es")) {
    token = token.slice(0, -2);
  } else if (token.length > 4 && token.endsWith("s")) {
    token = token.slice(0, -1);
  }
  if (token.length < 3) return "";
  if (WORLDMONITOR_FEED_ALERT_TITLE_STOPWORDS.has(token)) return "";
  return token;
}

function worldMonitorFeedAlertTitleKey(raw) {
  const title = String(raw?.title || "").trim();
  if (!title) return "";
  const withoutTrailer = title
    .replace(/\s+[|]\s+[\p{L}\p{N} .,&'()/-]{2,50}$/u, "")
    .replace(/\s+-\s+[\p{L}\p{N} .,&'()/-]{2,50}$/u, "");
  const normalized = normalizeWorldMonitorTitleForKey(withoutTrailer)
    .replace(/\b\d{1,2}[:.]\d{2}(?:\s?[ap]m)?\b/g, " ")
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|utc|gmt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  const reduced = [];
  const seen = new Set();
  const tokens = normalized.split(" ");
  for (const token of tokens) {
    const compact = normalizeWorldMonitorFeedAlertTitleToken(token);
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    reduced.push(compact);
    if (reduced.length >= 16) break;
  }
  if (reduced.length <= 0) return normalized.slice(0, 220);
  const anchor = reduced.slice(0, 8).join(" ");
  const bag = reduced.slice().sort().join(" ");
  return `${anchor}|${bag}`.slice(0, 220);
}

function buildWorldMonitorFeedAlertSummary(alert, item = null, ctx = null) {
  const context = ctx && typeof ctx === "object" ? ctx : null;
  const seeds = [];
  const ctxSummary = oneLine(String(context?.summary || ""));
  if (ctxSummary) seeds.push(ctxSummary);
  const keyPoints = Array.isArray(context?.keyPoints)
    ? context.keyPoints.map((x) => oneLine(x)).filter(Boolean).slice(0, 3)
    : [];
  if (keyPoints.length > 0) {
    seeds.push(
      keyPoints
        .map((x) => (
          /[.!?]$/.test(x.trim())
            ? x.trim()
            : `${x.trim()}.`
        ))
        .join(" "),
    );
  }

  const fallbackSeed = oneLine(String(alert?.title || item?.title || ""));
  const sourceSeed = seeds.join(" ").trim() || fallbackSeed;
  const sentences = splitIntoSentencesBestEffort(sourceSeed)
    .map((x) => oneLine(x))
    .filter(Boolean);
  const selected = [];
  const seen = new Set();
  for (const sentence of sentences) {
    const key = normalizeWorldMonitorTitleForKey(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(sentence.trim());
    if (selected.length >= 3) break;
  }

  const level = String(alert?.threatLevel || item?.threatLevel || "low").trim().toLowerCase() || "low";
  const source = oneLine(String(alert?.source || item?.source || "")).trim();
  if (selected.length === 0 && fallbackSeed) {
    selected.push(/[.!?]$/.test(fallbackSeed) ? fallbackSeed : `${fallbackSeed}.`);
  }
  if (selected.length === 1) {
    selected.push(`This item is currently tagged ${level} by the WorldMonitor feed.`);
  }
  if (selected.length < 3 && source) {
    selected.push(`Source: ${source}.`);
  }

  return selected
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 680);
}

function formatWorldMonitorFeedAlertMessage(alert, options = {}) {
  const item = options?.item && typeof options.item === "object" ? options.item : null;
  const ctx = options?.ctx && typeof options.ctx === "object" ? options.ctx : null;
  const level = String(alert?.threatLevel || "low").trim().toLowerCase() || "low";
  const levelTag = level.toUpperCase();
  const source = oneLine(String(alert?.source || "").trim());
  const rawTitle = String(alert?.title || "").replace(/\s+/g, " ").trim();
  const rawLink = String(alert?.link || "").trim();
  const safeTitle = rawTitle.replace(/[\[\]]/g, "").trim();
  const hasLink = /^https?:\/\/\S+$/i.test(rawLink);
  const summary = buildWorldMonitorFeedAlertSummary(alert, item, ctx);
  const header = `${fmtBold("WorldMonitor Alert")} [${levelTag}]`;
  const lines = [header];
  if (safeTitle && hasLink) {
    lines.push(`[${safeTitle}](${rawLink})`);
  } else if (rawTitle) {
    lines.push(rawTitle);
  }
  if (summary) lines.push(summary);
  if (source) lines.push(`source: ${source}`);
  if (rawLink && !(safeTitle && hasLink)) lines.push(rawLink);
  return lines.join("\n");
}

const WORLDMONITOR_REGION_NAME_OVERRIDES = Object.freeze({
  XK: "Kosovo",
  KP: "North Korea",
  KR: "South Korea",
  TW: "Taiwan",
  RU: "Russia",
  US: "United States",
  GB: "United Kingdom",
  IR: "Iran",
  SY: "Syria",
  YE: "Yemen",
  IL: "Israel",
  UA: "Ukraine",
});
let worldMonitorRegionDisplayNames = null;

function resolveWorldMonitorRegionName(region) {
  const code = String(region || "").trim().toUpperCase();
  if (!code) return "";
  if (code === "GLOBAL") return "Global";
  if (WORLDMONITOR_REGION_NAME_OVERRIDES[code]) return WORLDMONITOR_REGION_NAME_OVERRIDES[code];
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      if (!worldMonitorRegionDisplayNames) {
        worldMonitorRegionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
      }
      const label = String(worldMonitorRegionDisplayNames.of(code) || "").trim();
      if (label && label.toUpperCase() !== code) return label;
    }
  } catch {
    // ignore and fall back to raw code
  }
  return code;
}

function compactWorldMonitorCountryCodeList(items, limit = 3) {
  const source = Array.isArray(items) ? items : [];
  const maxItems = Math.max(1, Number(limit) || 1);
  return source
    .map((x) => ({
      region: String(x?.region || "??").trim().toUpperCase() || "??",
      score: Math.round(Number(x?.score || 0)),
    }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.region.localeCompare(b.region))
    .slice(0, maxItems)
    .map((x) => `${x.region}:${x.score}`)
    .join(", ");
}

function compactWorldMonitorCountryList(items, limit = 3) {
  const source = Array.isArray(items) ? items : [];
  const maxItems = Math.max(1, Number(limit) || 1);
  return source
    .slice(0, maxItems)
    .map((x) => {
      const region = String(x?.region || "").trim().toUpperCase();
      const name = String(x?.name || resolveWorldMonitorRegionName(region)).trim();
      const score = Math.round(Number(x?.score || 0));
      const label = !region
        ? (name || "unknown")
        : (name && name.toUpperCase() !== region ? `${name} (${region})` : (name || region));
      return `${label}:${score}`;
    })
    .join(", ");
}

function ensureWorldMonitorWorker() {
  const stored = String(worldMonitorMonitor.workerId || "").trim();
  if (stored && getCodexWorker(stored)) return stored;

  let workerId = "";

  const configuredWorkdir = String(WORLDMONITOR_WORKDIR || "").trim();
  if (configuredWorkdir && fs.existsSync(configuredWorkdir)) {
    workerId = findWorkerByWorkdir(configuredWorkdir);
    if (!workerId && listCodexWorkers().length < ORCH_MAX_CODEX_WORKERS) {
      try {
        workerId = createRepoWorker(configuredWorkdir, WORLDMONITOR_WORKER_TITLE);
      } catch (err) {
        log(`worldmonitor worker create failed: ${redactError(err?.message || err)}`);
      }
    }
  }

  if (!workerId) {
    const wantedTitle = String(WORLDMONITOR_WORKER_TITLE || "").trim().toLowerCase();
    if (wantedTitle) {
      for (const w of listCodexWorkers()) {
        const title = String(w.title || "").trim().toLowerCase();
        if (title && title === wantedTitle) {
          workerId = w.id;
          break;
        }
      }
    }
  }

  if (!workerId) workerId = ORCH_GENERAL_WORKER_ID;

  if (String(worldMonitorMonitor.workerId || "").trim() !== workerId) {
    worldMonitorMonitor.workerId = workerId;
    persistState();
  }
  return workerId;
}

async function fetchWorldMonitorRiskSnapshot(options = {}) {
  return fetchWorldMonitorNativeRiskSnapshot(options);
}

async function fetchWorldMonitorFeedAlerts(options = {}) {
  return fetchWorldMonitorNativeFeedAlerts(options);
}

function evaluateWorldMonitorSnapshot(snapshot, options = {}) {
  const prevScore = Number(worldMonitorMonitor.lastObservedGlobalScore || 0) || 0;
  const reasons = [];
  const hotCountries = (Array.isArray(snapshot?.topCountries) ? snapshot.topCountries : [])
    .filter((x) => Number(x?.score || 0) >= WORLDMONITOR_MIN_COUNTRY_RISK_SCORE);
  const globalScore = Number(snapshot?.globalScore || 0);
  const globalDeltaSigned = prevScore > 0 ? (globalScore - prevScore) : 0;
  const globalDelta = prevScore > 0 ? Math.abs(globalScore - prevScore) : 0;

  if (globalScore >= WORLDMONITOR_MIN_GLOBAL_RISK_SCORE) {
    reasons.push(`global risk ${Math.round(globalScore)} >= ${WORLDMONITOR_MIN_GLOBAL_RISK_SCORE}`);
  }
  if (hotCountries.length > 0) {
    reasons.push(
      `country risk spike (${compactWorldMonitorCountryList(hotCountries, 3)}) >= ${WORLDMONITOR_MIN_COUNTRY_RISK_SCORE}`,
    );
  }
  if (prevScore > 0 && globalDelta >= WORLDMONITOR_MIN_GLOBAL_DELTA) {
    reasons.push(
      `global risk moved ${globalDelta.toFixed(1)} points (${prevScore.toFixed(1)} -> ${globalScore.toFixed(1)})`,
    );
  }

  const fingerprint = [
    `${Math.round(globalScore)}`,
    `${String(snapshot?.globalLevel || "unknown").toLowerCase()}`,
    compactWorldMonitorCountryCodeList(snapshot?.topCountries, 4),
    compactWorldMonitorCountryCodeList(hotCountries, 3),
  ].join("|");

  const forceAlert = options?.forceAlert === true;
  const shouldAlert = forceAlert || reasons.length > 0;

  return {
    shouldAlert,
    reasons,
    previousGlobalScore: prevScore,
    currentGlobalScore: globalScore,
    globalDeltaSigned,
    globalDelta,
    hotCountries,
    fingerprint,
  };
}

function buildWorldMonitorSnapshotSummary(snapshot) {
  const globalScore = Math.round(Number(snapshot?.globalScore || 0));
  const level = String(snapshot?.globalLevel || "unknown").toLowerCase();
  const top = compactWorldMonitorCountryList(snapshot?.topCountries, 4) || "none";
  const factors = Array.isArray(snapshot?.globalFactors) && snapshot.globalFactors.length > 0
    ? snapshot.globalFactors.slice(0, 4).join(", ")
    : "none";
  return `global=${globalScore}/${level}; top=${top}; factors=${factors}`;
}

function normalizeWorldMonitorIntervalReportCounters(nowMs = Date.now()) {
  const dayKey = utcDayKeyFromMs(nowMs);
  const prevDayKey = String(worldMonitorMonitor.intervalReportDayKey || "").trim();
  const prevCountRaw = Number(worldMonitorMonitor.intervalReportCount || 0) || 0;
  const prevCount = Number.isFinite(prevCountRaw) ? Math.max(0, Math.trunc(prevCountRaw)) : 0;
  let changed = false;

  if (dayKey && prevDayKey !== dayKey) {
    worldMonitorMonitor.intervalReportDayKey = dayKey;
    worldMonitorMonitor.intervalReportCount = 0;
    changed = true;
  } else if (prevCountRaw !== prevCount) {
    worldMonitorMonitor.intervalReportCount = prevCount;
    changed = true;
  }

  return {
    dayKey,
    count: Math.max(0, Number(worldMonitorMonitor.intervalReportCount || 0) || 0),
    changed,
  };
}

function worldMonitorIntervalReportMaxLabel() {
  const maxPerDay = Math.max(0, Number(WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY || 0) || 0);
  return maxPerDay > 0 ? `${Math.trunc(maxPerDay)}` : "unlimited";
}

function evaluateWorldMonitorIntervalReportPolicy(decision, nowMs = Date.now()) {
  const normalized = normalizeWorldMonitorIntervalReportCounters(nowMs);
  const configuredMaxPerDay = Math.max(0, Number(WORLDMONITOR_INTERVAL_REPORT_MAX_PER_DAY || 0) || 0);
  const hasDailyCap = configuredMaxPerDay > 0;
  const maxPerDay = hasDailyCap ? Math.max(1, Math.trunc(configuredMaxPerDay)) : 0;
  const configuredBaselinePerDay = Math.max(0, Number(WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY || 0) || 0);
  const baselinePerDay = hasDailyCap
    ? Math.max(0, Math.min(maxPerDay, Math.trunc(configuredBaselinePerDay)))
    : Math.max(0, Math.trunc(configuredBaselinePerDay));
  const countToday = Math.max(0, Number(normalized.count || 0) || 0);
  const minSpacingMs = Math.max(0, Number(WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC || 0) * 1000);
  const lastReportAt = Number(worldMonitorMonitor.intervalReportLastAt || 0) || 0;
  const spacingRemainingMs = (minSpacingMs > 0 && lastReportAt > 0)
    ? Math.max(0, minSpacingMs - Math.max(0, nowMs - lastReportAt))
    : 0;
  const significantThreshold = Math.max(
    1,
    Number(WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA || WORLDMONITOR_MIN_GLOBAL_DELTA) || 1,
  );
  const delta = Math.max(0, Number(decision?.globalDelta || 0) || 0);
  const significantDelta = delta >= significantThreshold;
  const baselineDue = countToday < baselinePerDay;

  if (hasDailyCap && countToday >= maxPerDay) {
    return {
      ...normalized,
      shouldReport: false,
      reason: `report daily cap (${countToday}/${maxPerDay})`,
      baselineDue,
      significantDelta,
      countToday,
      maxPerDay,
    };
  }
  if (!baselineDue && spacingRemainingMs > 0) {
    const mins = Math.max(1, Math.ceil(spacingRemainingMs / 60_000));
    return {
      ...normalized,
      shouldReport: false,
      reason: `report spacing (${mins}m remaining)`,
      baselineDue,
      significantDelta,
      countToday,
      maxPerDay,
    };
  }
  if (baselineDue) {
    return {
      ...normalized,
      shouldReport: true,
      reason: hasDailyCap
        ? `daily baseline report (${countToday + 1}/${maxPerDay})`
        : `daily baseline report (${countToday + 1})`,
      baselineDue,
      significantDelta,
      countToday,
      maxPerDay,
    };
  }
  if (!significantDelta) {
    return {
      ...normalized,
      shouldReport: false,
      reason: `delta ${delta.toFixed(1)} < ${significantThreshold}`,
      baselineDue,
      significantDelta,
      countToday,
      maxPerDay,
    };
  }
  return {
    ...normalized,
    shouldReport: true,
    reason: `significant delta ${delta.toFixed(1)} >= ${significantThreshold}`,
    baselineDue,
    significantDelta,
    countToday,
    maxPerDay,
  };
}

function buildWorldMonitorAlertPrompt(snapshot, decision, source = "interval") {
  const packet = {
    monitor_source: source,
    fetched_at: nowIso(snapshot?.fetchedAt || Date.now()),
    trigger_reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    global_risk: {
      score: Number(snapshot?.globalScore || 0),
      level: String(snapshot?.globalLevel || "").toLowerCase(),
      factors: Array.isArray(snapshot?.globalFactors) ? snapshot.globalFactors : [],
    },
    top_countries: Array.isArray(snapshot?.topCountries) ? snapshot.topCountries : [],
    country_score_explain_threshold: Number(WORLDMONITOR_MIN_COUNTRY_RISK_SCORE || 75),
    headline_evidence: Array.isArray(snapshot?.headlineEvidence) ? snapshot.headlineEvidence : [],
    country_headline_evidence: Array.isArray(snapshot?.countryHeadlineEvidence) ? snapshot.countryHeadlineEvidence : [],
    source_url: String(snapshot?.sourceUrl || "").trim(),
  };

  return [
    "You are monitoring WorldMonitor risk telemetry for actionable geopolitical alerts.",
    "Produce a concise operator alert for Telegram.",
    "",
    "Output format:",
    "ALERT_LEVEL: low|medium|high",
    "SUMMARY: 2-4 lines on what changed and why it matters now.",
    "HEADLINE_NARRATIVE:",
    "- One short paragraph (3-5 sentences) that names concrete current headlines and directly explains why specific country scores are high.",
    "PRIMARY_TRIGGERS:",
    "- 2-4 bullets in the form: trigger condition -> evidence -> operational impact.",
    "EVIDENCE:",
    "- 3-5 bullets. Each bullet must cite one concrete headline or telemetry datapoint from the packet.",
    "IMPLICATIONS:",
    "- bullet 1",
    "- bullet 2",
    "WATCHLIST:",
    "- 3-5 concrete indicators to track in the next 6-24h.",
    "CONFIDENCE: low|medium|high",
    "",
    "Rules:",
    "- Use only the provided telemetry packet.",
    "- In HEADLINE_NARRATIVE include at least 2 concrete headline references in the form: headline title (source).",
    "- If any top country has score >= country_score_explain_threshold, explain that country's score using at least one country-specific headline from country_headline_evidence when available.",
    "- In PRIMARY_TRIGGERS include strongest threshold crossings (global risk, country spikes, or delta) when available.",
    "- In EVIDENCE include threat level and source when available (example: [critical] Headline (Source) -> why).",
    "- If headline evidence is missing for a high-score country, state that data gap explicitly.",
    "- If confidence is low, say so explicitly.",
    "- Use full country names (for example, 'Ukraine') and avoid ISO codes like 'UA'.",
    "- Write in plain spoken language that sounds natural in text-to-speech.",
    "- Do not invent headlines, links, or causal claims beyond the packet.",
    "- If evidence is sparse, say so and cite data gaps.",
    "- Keep total output under 280 words.",
    "",
    `TELEMETRY_PACKET=${JSON.stringify(packet)}`,
  ].join("\n");
}

const worldMonitorPipelineRuntime = createWorldMonitorPipelineRuntime({
  getShuttingDown: () => shuttingDown,
  log,
  redactError,
  ensureWorkerLane,
  getLane,
  fetchWorldMonitorRiskSnapshot,
  evaluateWorldMonitorSnapshot,
  buildWorldMonitorSnapshotSummary,
  evaluateWorldMonitorIntervalReportPolicy,
  worldMonitorFeedAlertLevelRank,
  ensureWorldMonitorWorker,
  buildWorldMonitorAlertPrompt,
  enqueuePrompt,
  normalizeWorldMonitorIntervalReportCounters,
  compactWorldMonitorCountryList,
  nowIso,
  formatRelativeAge,
  fmtBold,
  resolveWorldMonitorRegionName,
  sendMessage,
  runWorldMonitorNativeFeedRefresh,
  fetchWorldMonitorFeedAlerts,
  findWorldMonitorItemForAlert,
  getWorldMonitorItemArticleContext,
  isWorldMonitorAlertForwardable,
  resolveWorldMonitorAlertBestLink,
  translateWorldMonitorHeadlineToEnglish,
  oneLine,
  formatWorldMonitorFeedAlertMessage,
  rememberWorldMonitorFeedAlertKey,
  rememberWorldMonitorFeedAlertTitleKey,
  persistState,
  worldMonitorRuntime,
  worldMonitorMonitor,
  worldMonitorFeedAlertsRuntime,
  worldMonitorNativeRuntime,
  worldMonitorNativeNewsItems,
  worldMonitorFeedAlertSentKeySet,
  worldMonitorFeedAlertSentTitleKeySet,
  WORLDMONITOR_MONITOR_ENABLED,
  WORLDMONITOR_FEED_ALERTS_ENABLED,
  WORLDMONITOR_INTERVAL_ALERT_MODE,
  WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL,
  WORLDMONITOR_FEED_ALERTS_MIN_LEVEL,
  WORLDMONITOR_ALERT_COOLDOWN_SEC,
  WORLDMONITOR_ALERT_CHAT_ID,
  WORLDMONITOR_SUMMARY_MODEL,
  WORLDMONITOR_SUMMARY_REASONING,
  WORLDMONITOR_MIN_COUNTRY_RISK_SCORE,
  WORLDMONITOR_MIN_GLOBAL_RISK_SCORE,
  WORLDMONITOR_MIN_GLOBAL_DELTA,
  WORLDMONITOR_NOTIFY_ERRORS,
  WORLDMONITOR_MONITOR_INTERVAL_SEC,
  WORLDMONITOR_STARTUP_DELAY_SEC,
  WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS,
  WORLDMONITOR_STARTUP_CATCHUP_ENABLED,
  WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS,
  WORLDMONITOR_CHECK_LOOKBACK_HOURS,
  WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE,
  WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE,
  WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE,
  WORLDMONITOR_FEED_ALERTS_CHAT_ID,
  WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC,
});

function getWorldMonitorWorkerLaneState(workerId) {
  return worldMonitorPipelineRuntime.getWorldMonitorWorkerLaneState(workerId);
}

async function runWorldMonitorMonitorCycle(options = {}) {
  return await worldMonitorPipelineRuntime.runWorldMonitorMonitorCycle(options);
}

async function runWorldMonitorComprehensiveCheck(options = {}) {
  const chatId = String(options?.chatId || "").trim();
  if (!chatId) return { ok: false, error: "chatId missing" };

  if (worldMonitorComprehensiveRuntime.inFlight) {
    await sendMessage(chatId, "WorldMonitor comprehensive check is already running. Please wait for the current report.");
    return { ok: false, skipped: "busy" };
  }
  worldMonitorComprehensiveRuntime.inFlight = true;
  worldMonitorComprehensiveRuntime.lastStartedAt = Date.now();

  if (options?.announceStart !== false) {
    await sendMessage(chatId, `${fmtBold("WorldMonitor Check")} started. Gathering telemetry and drafting report...`);
  }

  try {
    const now = Date.now();
    const lookbackMs = Math.max(1, Number(WORLDMONITOR_CHECK_LOOKBACK_HOURS || 168)) * 60 * 60 * 1000;
    const sinceMs = now - lookbackMs;
    const maxHeadlines = Math.max(4, Number(WORLDMONITOR_CHECK_MAX_HEADLINES || 16));
    const force = options?.forceAlert === true;
    const fetchTimeoutMs = Number(WORLDMONITOR_CHECK_FETCH_TIMEOUT_MS || 0);
    const fetchWithTimeout = (promise, label) => {
      if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0) return promise;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(fetchTimeoutMs / 1000)}s`));
        }, fetchTimeoutMs);
        Promise.resolve(promise).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    };

  const [
    riskResult,
    feedResult,
    taiwanBriefResult,
    pizzintResult,
    gdeltTaiwanResult,
    gdeltGlobalResult,
  ] = await Promise.allSettled([
    fetchWithTimeout(fetchWorldMonitorRiskSnapshot({ force }), "risk snapshot"),
    fetchWithTimeout(fetchWorldMonitorFeedAlerts({ sinceMs, force }), "feed alerts"),
    fetchWithTimeout(
      fetchWorldMonitorCountryIntelBrief(WORLDMONITOR_CHECK_TAIWAN_COUNTRY_CODE, { force }),
      "taiwan country brief",
    ),
    fetchWithTimeout(fetchWorldMonitorPizzintStatus({ force }), "pizzint status"),
    fetchWithTimeout(fetchWorldMonitorGdeltDocuments(
      '(Taiwan OR Taiwan Strait OR Taipei OR China OR PLA OR South China Sea)',
      { maxRecords: 10, timespan: `${WORLDMONITOR_CHECK_LOOKBACK_HOURS}h`, sort: "date", force },
    ), "gdelt taiwan"),
    fetchWithTimeout(fetchWorldMonitorGdeltDocuments(
      '(military exercise OR troop deployment OR airstrike OR naval exercise OR sanctions OR ceasefire)',
      { maxRecords: 10, timespan: `${WORLDMONITOR_CHECK_LOOKBACK_HOURS}h`, sort: "date", force },
    ), "gdelt global"),
  ]);

  const dataGaps = [];
  let riskSnapshot = null;
  if (riskResult.status === "fulfilled" && riskResult.value) {
    riskSnapshot = riskResult.value;
  } else {
    const fallbackSnapshot = buildWorldMonitorNativeRiskSnapshot();
    if (fallbackSnapshot && Number.isFinite(Number(fallbackSnapshot?.globalScore))) {
      riskSnapshot = fallbackSnapshot;
      dataGaps.push("risk_snapshot_live_refresh_failed_using_cached_snapshot");
      const reason = String(riskResult.reason?.message || riskResult.reason || "").trim();
      if (reason) {
        log(`worldmonitor comprehensive check: using cached risk snapshot (${redactError(reason)})`);
      }
    } else {
      const message = String(riskResult.reason?.message || riskResult.reason || "risk snapshot failed");
      await sendMessage(chatId, `WorldMonitor comprehensive check failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  const allFeedAlerts = feedResult.status === "fulfilled" ? feedResult.value : [];
  const recentAlerts = allFeedAlerts
    .filter((x) => Number(x?.firstSeenAt || 0) >= sinceMs)
    .sort((a, b) => Number(b.firstSeenAt || 0) - Number(a.firstSeenAt || 0));
  const mixedGlobalSelection = worldMonitorSelectMixedAlerts(recentAlerts, maxHeadlines);
  const topGlobalAlerts = mixedGlobalSelection.items;
  const taiwanSelection = worldMonitorSelectMixedAlerts(
    recentAlerts.filter((x) => isTaiwanRelevantHeadline(x?.title || "")),
    Math.min(maxHeadlines, 10),
  );
  const taiwanAlerts = taiwanSelection.items;

  const alertLevelCounts = {
    critical: recentAlerts.filter((x) => String(x?.threatLevel || "").toLowerCase() === "critical").length,
    high: recentAlerts.filter((x) => String(x?.threatLevel || "").toLowerCase() === "high").length,
    medium: recentAlerts.filter((x) => String(x?.threatLevel || "").toLowerCase() === "medium").length,
    low: recentAlerts.filter((x) => String(x?.threatLevel || "").toLowerCase() === "low").length,
  };
  const articleContextStats = buildWorldMonitorArticleContextStats(sinceMs);
  const articleThemeSnapshot = buildWorldMonitorArticleThemeSnapshot(sinceMs);

  const taiwanBrief = taiwanBriefResult.status === "fulfilled" ? taiwanBriefResult.value : null;
  const pizzint = pizzintResult.status === "fulfilled" ? pizzintResult.value : null;
  const gdeltTaiwan = gdeltTaiwanResult.status === "fulfilled" ? gdeltTaiwanResult.value : null;
  const gdeltGlobal = gdeltGlobalResult.status === "fulfilled" ? gdeltGlobalResult.value : null;

  if (feedResult.status !== "fulfilled") dataGaps.push("feed_alert_bridge_unavailable");
  if (taiwanBriefResult.status !== "fulfilled" || !String(taiwanBrief?.brief || "").trim()) dataGaps.push("taiwan_country_brief_unavailable");
  if (pizzintResult.status !== "fulfilled") dataGaps.push("pizzint_unavailable");
  if (gdeltTaiwanResult.status !== "fulfilled" || (gdeltTaiwan?.error && !gdeltTaiwan?.articles?.length)) dataGaps.push("gdelt_taiwan_unavailable");
  if (gdeltGlobalResult.status !== "fulfilled" || (gdeltGlobal?.error && !gdeltGlobal?.articles?.length)) dataGaps.push("gdelt_global_unavailable");
  const nativeHistory = (() => {
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const last7d = worldMonitorNativeNewsItems.filter((x) => Number(x?.publishedAt || x?.firstSeenAt || 0) >= (nowMs - 7 * dayMs));
    const prev7d = worldMonitorNativeNewsItems.filter((x) => {
      const ts = Number(x?.publishedAt || x?.firstSeenAt || 0);
      return ts >= (nowMs - 14 * dayMs) && ts < (nowMs - 7 * dayMs);
    });
    const taiwan7d = last7d.filter((x) => Number(x?.taiwanScore || 0) > 0);
    const prevTaiwan7d = prev7d.filter((x) => Number(x?.taiwanScore || 0) > 0);
    return {
      source_mode: "native",
      store_items_total: worldMonitorNativeNewsItems.length,
      retention_days: WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS,
      last_7d_items: last7d.length,
      prev_7d_items: prev7d.length,
      last_7d_taiwan_items: taiwan7d.length,
      prev_7d_taiwan_items: prevTaiwan7d.length,
    };
  })();
  const nativeSignalContext = buildWorldMonitorNativeSignalContext();
  if (!nativeSignalContext?.market) dataGaps.push("native_market_signals_unavailable");
  if (!nativeSignalContext?.crypto) dataGaps.push("native_crypto_signals_unavailable");
  if (!nativeSignalContext?.seismic) dataGaps.push("native_seismic_signals_unavailable");
  if (!nativeSignalContext?.infrastructure) dataGaps.push("native_infrastructure_signals_unavailable");
  if (!nativeSignalContext?.adsb) dataGaps.push("native_adsb_signals_unavailable");
  if (!nativeSignalContext?.disaster) dataGaps.push("native_disaster_signals_unavailable");
  if (!nativeSignalContext?.maritime) dataGaps.push("native_maritime_signals_unavailable");
  if (!nativeSignalContext?.services) dataGaps.push("native_service_signals_unavailable");
  if (!nativeSignalContext?.macro) dataGaps.push("native_macro_signals_unavailable");
  if (!nativeSignalContext?.prediction) dataGaps.push("native_prediction_signals_unavailable");
  if (WORLDMONITOR_DEEP_INGEST_ENABLED && Number(articleContextStats.summarized_items || 0) <= 0) {
    dataGaps.push("article_context_unavailable");
  }
  const mapAlertRow = (x) => {
    const row = {
      title: String(x?.title || "").trim(),
      source: String(x?.source || "").trim(),
      threat_level: String(x?.threatLevel || "").trim().toLowerCase(),
      first_seen_at: nowIso(Number(x?.firstSeenAt || 0) || now),
      link: String(x?.link || "").trim(),
    };
    const item = findWorldMonitorItemForAlert(x);
    const articleContext = compactWorldMonitorArticleContext(getWorldMonitorItemArticleContext(item));
    if (articleContext) row.article_context = articleContext;
    return row;
  };
  const mapEvidenceRow = (x, scope = "global") => {
    const firstSeenAt = Number(x?.firstSeenAt || 0) || now;
    const item = findWorldMonitorItemForAlert(x);
    const articleContext = compactWorldMonitorArticleContext(getWorldMonitorItemArticleContext(item));
    const row = {
      scope: String(scope || "global").trim().toLowerCase() || "global",
      title: String(x?.title || "").trim(),
      source: String(x?.source || "").trim(),
      threat_level: String(x?.threatLevel || "").trim().toLowerCase(),
      first_seen_at: nowIso(firstSeenAt),
      age_hours: Math.round((Math.max(0, now - firstSeenAt) / (60 * 60 * 1000)) * 10) / 10,
      link: String(x?.link || "").trim(),
    };
    if (articleContext?.summary) {
      row.context_summary = String(articleContext.summary || "").trim().slice(0, 260);
    }
    if (Array.isArray(articleContext?.key_points) && articleContext.key_points.length > 0) {
      row.context_key_points = articleContext.key_points.slice(0, 2);
    }
    return row;
  };
  const keyEvidence = (() => {
    const seen = new Set();
    const merged = [];
    const pushUnique = (alert, scope) => {
      const a = alert && typeof alert === "object" ? alert : null;
      if (!a) return;
      const key = String(a.key || "").trim()
        || normalizeWorldMonitorLink(a.link || "")
        || worldMonitorFeedAlertTitleKey({ title: String(a.title || "") });
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({ alert: a, scope });
    };
    for (const alert of topGlobalAlerts) pushUnique(alert, "global");
    for (const alert of taiwanAlerts) pushUnique(alert, "taiwan");
    for (const alert of recentAlerts) {
      if (worldMonitorFeedAlertLevelRank(alert?.threatLevel) < 4) continue;
      pushUnique(alert, "global");
      if (merged.length >= 14) break;
    }
    return merged
      .sort((a, b) => (
        worldMonitorFeedAlertLevelRank(b?.alert?.threatLevel)
        - worldMonitorFeedAlertLevelRank(a?.alert?.threatLevel)
      ) || (
        (Number(b?.alert?.firstSeenAt || 0) || 0)
        - (Number(a?.alert?.firstSeenAt || 0) || 0)
      ))
      .slice(0, 8)
      .map((row) => mapEvidenceRow(row.alert, row.scope));
  })();

  const packet = {
    mode: "comprehensive_manual_check",
    requested_at: nowIso(now),
    lookback_hours: Number(WORLDMONITOR_CHECK_LOOKBACK_HOURS || 168),
    force_requested: force,
    risk_snapshot: {
      fetched_at: nowIso(riskSnapshot?.fetchedAt || now),
      source_url: String(riskSnapshot?.sourceUrl || "").trim(),
      global_risk: {
        score: Number(riskSnapshot?.globalScore || 0),
        level: String(riskSnapshot?.globalLevel || "").trim().toLowerCase(),
        factors: Array.isArray(riskSnapshot?.globalFactors) ? riskSnapshot.globalFactors : [],
      },
      top_countries: Array.isArray(riskSnapshot?.topCountries) ? riskSnapshot.topCountries : [],
    },
    feed_alerts: {
      total: recentAlerts.length,
      by_level: alertLevelCounts,
      selection_mode: "mixed_levels_recency",
      selected_global_by_level: mixedGlobalSelection.selected_by_level,
      selected_taiwan_by_level: taiwanSelection.selected_by_level,
      top_global: topGlobalAlerts.map(mapAlertRow),
      taiwan_related: taiwanAlerts.map(mapAlertRow),
    },
    key_evidence: keyEvidence,
    taiwan_brief: {
      country_code: WORLDMONITOR_CHECK_TAIWAN_COUNTRY_CODE,
      country_name: String(taiwanBrief?.countryName || "Taiwan").trim(),
      generated_at: taiwanBrief?.generatedAt ? nowIso(Number(taiwanBrief.generatedAt)) : "",
      model: String(taiwanBrief?.model || "").trim(),
      brief: String(taiwanBrief?.brief || "").trim(),
    },
    pizzint: pizzint ? {
      defcon_level: Number(pizzint?.defconLevel || 0),
      defcon_label: String(pizzint?.defconLabel || "").trim(),
      aggregate_activity: Number(pizzint?.aggregateActivity || 0),
      active_spikes: Number(pizzint?.activeSpikes || 0),
      locations_open: Number(pizzint?.locationsOpen || 0),
      updated_at: pizzint?.updatedAt ? nowIso(Number(pizzint.updatedAt)) : "",
      top_tension_pairs: Array.isArray(pizzint?.tensionPairs) ? pizzint.tensionPairs.slice(0, 6) : [],
    } : null,
    gdelt: {
      taiwan_query: String(gdeltTaiwan?.query || "").trim(),
      taiwan_error: String(gdeltTaiwan?.error || "").trim(),
      taiwan_articles: Array.isArray(gdeltTaiwan?.articles) ? gdeltTaiwan.articles.slice(0, 8) : [],
      global_query: String(gdeltGlobal?.query || "").trim(),
      global_error: String(gdeltGlobal?.error || "").trim(),
      global_articles: Array.isArray(gdeltGlobal?.articles) ? gdeltGlobal.articles.slice(0, 8) : [],
    },
    native_history: nativeHistory,
    article_context: {
      ...articleContextStats,
      theme_snapshot: articleThemeSnapshot,
      deep_ingest_enabled: WORLDMONITOR_DEEP_INGEST_ENABLED,
      deep_ingest_last_run_at: Number(worldMonitorMonitor.nativeDeepIngestLastRunAt || 0) > 0
        ? nowIso(Number(worldMonitorMonitor.nativeDeepIngestLastRunAt || 0))
        : "",
      deep_ingest_last_error: String(worldMonitorMonitor.nativeDeepIngestLastError || "").trim(),
      deep_ingest_last_stats: worldMonitorMonitor.nativeDeepIngestLastStats
        && typeof worldMonitorMonitor.nativeDeepIngestLastStats === "object"
        ? worldMonitorMonitor.nativeDeepIngestLastStats
        : {},
    },
    signal_context: nativeSignalContext,
    data_gaps: dataGaps,
  };

  const prompt = buildWorldMonitorComprehensivePrompt(packet);
  const workerId = ensureWorldMonitorWorker();
  await enqueuePrompt(chatId, prompt, "worldmonitor-check", {
    workerId,
    setActiveWorker: false,
    model: WORLDMONITOR_SUMMARY_MODEL,
    reasoning: WORLDMONITOR_SUMMARY_REASONING,
  });

  if (options?.announceQueued === true) {
    const lineA = `${fmtBold("WorldMonitor Check")} comprehensive report queued`;
    const lineB = `- scope: global + Taiwan (${WORLDMONITOR_CHECK_LOOKBACK_HOURS}h lookback)`;
    const signalLinePart = ` market=${nativeSignalContext?.market ? "ok" : "unavailable"} crypto=${nativeSignalContext?.crypto ? "ok" : "unavailable"} seismic=${nativeSignalContext?.seismic ? "ok" : "unavailable"} infra=${nativeSignalContext?.infrastructure ? "ok" : "unavailable"} adsb=${nativeSignalContext?.adsb ? "ok" : "unavailable"} disaster=${nativeSignalContext?.disaster ? "ok" : "unavailable"} maritime=${nativeSignalContext?.maritime ? "ok" : "unavailable"} services=${nativeSignalContext?.services ? "ok" : "unavailable"} macro=${nativeSignalContext?.macro ? "ok" : "unavailable"} prediction=${nativeSignalContext?.prediction ? "ok" : "unavailable"}`;
    const lineC = `- sources: risk=${riskSnapshot?.sourceUrl ? "ok" : "ok"} feed_alerts=${feedResult.status === "fulfilled" ? recentAlerts.length : "unavailable"} article_context=${articleContextStats.summarized_items}/${articleContextStats.total_items} (${articleContextStats.coverage_pct}%) gdelt_tw=${gdeltTaiwanResult.status === "fulfilled" ? (gdeltTaiwan?.articles?.length || 0) : "unavailable"} gdelt_global=${gdeltGlobalResult.status === "fulfilled" ? (gdeltGlobal?.articles?.length || 0) : "unavailable"}${signalLinePart}`;
    const lineD = dataGaps.length > 0 ? `- data_gaps: ${dataGaps.join(", ")}` : "- data_gaps: none";
    await sendMessage(chatId, [lineA, lineB, lineC, lineD].join("\n"));
  }

  return { ok: true, queued: true };
  } catch (err) {
    const message = String(err?.message || err || "").trim() || "comprehensive check failed";
    log(`worldmonitor comprehensive check failed: ${redactError(message)}`);
    await sendMessage(chatId, `WorldMonitor comprehensive check failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    worldMonitorComprehensiveRuntime.inFlight = false;
  }
}

function stopWorldMonitorMonitorLoop() {
  worldMonitorPipelineRuntime.stopWorldMonitorMonitorLoop();
}

function buildWorldMonitorStartupCatchupWindow(now = Date.now()) {
  return worldMonitorPipelineRuntime.buildWorldMonitorStartupCatchupWindow(now);
}

async function runWorldMonitorStartupCatchup() {
  return await worldMonitorPipelineRuntime.runWorldMonitorStartupCatchup();
}

function scheduleWorldMonitorMonitorLoop(delayMs) {
  worldMonitorPipelineRuntime.scheduleWorldMonitorMonitorLoop(delayMs);
}

function startWorldMonitorMonitorLoop() {
  worldMonitorPipelineRuntime.startWorldMonitorMonitorLoop();
}

async function runWorldMonitorFeedAlertsCycle(options = {}) {
  return await worldMonitorPipelineRuntime.runWorldMonitorFeedAlertsCycle(options);
}

function stopWorldMonitorFeedAlertsLoop() {
  worldMonitorPipelineRuntime.stopWorldMonitorFeedAlertsLoop();
}

function scheduleWorldMonitorFeedAlertsLoop(delayMs) {
  worldMonitorPipelineRuntime.scheduleWorldMonitorFeedAlertsLoop(delayMs);
}

function startWorldMonitorFeedAlertsLoop() {
  worldMonitorPipelineRuntime.startWorldMonitorFeedAlertsLoop();
}

function describeOpenMeteoWeatherCode(rawCode) {
  const code = Math.trunc(Number(rawCode));
  if (!Number.isFinite(code)) return "Unknown conditions";
  if (code === 0) return "Clear sky";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if ([51, 53, 55].includes(code)) return "Drizzle";
  if ([56, 57].includes(code)) return "Freezing drizzle";
  if ([61, 63, 65].includes(code)) return "Rain";
  if ([66, 67].includes(code)) return "Freezing rain";
  if ([71, 73, 75].includes(code)) return "Snow";
  if (code === 77) return "Snow grains";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([85, 86].includes(code)) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm with hail";
  return "Unknown conditions";
}

function isValidWeatherCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function parseWeatherCityArg(argText) {
  const raw = String(argText || "").trim();
  if (!raw) return "";
  const tokens = parseArgString(raw);
  if (tokens.length > 0) {
    return tokens.join(" ").trim();
  }
  return raw.replace(/^["']|["']$/g, "").trim();
}

function formatOpenMeteoLocationName(result, fallback = "") {
  if (!result || typeof result !== "object") return String(fallback || "").trim();
  const name = String(result.name || "").trim();
  const admin1 = String(result.admin1 || "").trim();
  const country = String(result.country || "").trim();
  const parts = [];
  if (name) parts.push(name);
  if (admin1 && admin1.toLowerCase() !== name.toLowerCase()) parts.push(admin1);
  if (country && country.toLowerCase() !== name.toLowerCase() && country.toLowerCase() !== admin1.toLowerCase()) parts.push(country);
  const label = parts.join(", ").trim();
  return label || String(fallback || "").trim();
}

function buildWeatherLocationSummary(location) {
  if (!location || typeof location !== "object") return "(unset)";
  const name = String(location.name || "").trim() || "weather location";
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  if (!isValidWeatherCoordinates(lat, lon)) return name;
  return `${name} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
}

function getConfiguredWeatherLocation() {
  if (!isValidWeatherCoordinates(WEATHER_DAILY_LAT, WEATHER_DAILY_LON)) return null;
  return {
    source: "config",
    name: String(WEATHER_DAILY_LOCATION_NAME || "").trim() || "Configured location",
    latitude: Number(WEATHER_DAILY_LAT),
    longitude: Number(WEATHER_DAILY_LON),
    timezone: "auto",
  };
}

function getSavedWeatherLocationForChat(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return null;
  const entry = weatherLocationsByChat[key];
  if (!entry || typeof entry !== "object") return null;
  const latitude = Number(entry.latitude);
  const longitude = Number(entry.longitude);
  if (!isValidWeatherCoordinates(latitude, longitude)) return null;
  return {
    source: "chat-gps",
    name: String(entry.name || "").trim() || "Shared location",
    latitude,
    longitude,
    timezone: String(entry.timezone || "").trim() || "auto",
  };
}

function setSavedWeatherLocationForChat(chatId, location) {
  const key = String(chatId || "").trim();
  if (!key || !location || typeof location !== "object") return false;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!isValidWeatherCoordinates(latitude, longitude)) return false;
  weatherLocationsByChat[key] = {
    name: String(location.name || "").trim() || "Shared location",
    latitude,
    longitude,
    timezone: String(location.timezone || "").trim() || "auto",
    updatedAt: Date.now(),
  };
  persistState();
  return true;
}

function resolveDefaultWeatherLocationForChat(chatId) {
  const configured = getConfiguredWeatherLocation();
  if (configured) return configured;
  return getSavedWeatherLocationForChat(chatId);
}

async function resolveWeatherLocationFromCity(cityQuery, options = {}) {
  const query = String(cityQuery || "").trim();
  if (!query) throw new Error("City name is required.");
  const params = new URLSearchParams({
    name: query,
    count: "5",
    language: "en",
    format: "json",
  });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
  const payload = await fetchJsonUrl(url, {
    headers: { Accept: "application/json" },
    timeoutMs: WEATHER_GEOCODING_TIMEOUT_MS,
    signal: options?.signal,
  });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const hit = results.find((item) => isValidWeatherCoordinates(item?.latitude, item?.longitude)) || null;
  if (!hit) {
    throw new Error(`No weather location matched "${query}".`);
  }
  return {
    source: "city",
    name: formatOpenMeteoLocationName(hit, query) || query,
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
    timezone: String(hit.timezone || "").trim() || "auto",
  };
}

async function resolveWeatherLocationFromCoordinates(latitude, longitude, options = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!isValidWeatherCoordinates(lat, lon)) return null;
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    count: "1",
    language: "en",
    format: "json",
  });
  const url = `https://geocoding-api.open-meteo.com/v1/reverse?${params.toString()}`;
  const payload = await fetchJsonUrl(url, {
    headers: { Accept: "application/json" },
    timeoutMs: WEATHER_GEOCODING_TIMEOUT_MS,
    signal: options?.signal,
  });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const hit = results.find((item) => isValidWeatherCoordinates(item?.latitude, item?.longitude)) || null;
  if (!hit) return null;
  return {
    name: formatOpenMeteoLocationName(hit, "Shared location"),
    timezone: String(hit.timezone || "").trim() || "auto",
  };
}

function formatCelsius(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${Math.round(n)}°C`;
}

function formatMm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(Math.max(0, n) * 10) / 10;
  return `${rounded % 1 === 0 ? Math.trunc(rounded) : rounded} mm`;
}

function buildWeatherBriefing(payload, { locationName = "Weather" } = {}) {
  const daily = payload && typeof payload.daily === "object" && payload.daily ? payload.daily : {};
  const dayKeys = Array.isArray(daily.time) ? daily.time : [];
  const weatherCodes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
  const maxTemps = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const minTemps = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const rainProbMax = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const rainSum = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];
  if (dayKeys.length < 2) {
    throw new Error("Weather API response is missing today/tomorrow data.");
  }

  const forecastLines = [];
  for (let i = 0; i < 2; i += 1) {
    const label = i === 0 ? "Today" : "Tomorrow";
    const condition = describeOpenMeteoWeatherCode(weatherCodes[i]);
    const low = formatCelsius(minTemps[i]);
    const high = formatCelsius(maxTemps[i]);
    const rainProb = Number(rainProbMax[i]);
    const rainMm = Number(rainSum[i]);
    const pieces = [`${label}: ${condition}.`];
    if (low && high) {
      pieces.push(`Temperature ${low} to ${high}.`);
    } else if (high) {
      pieces.push(`High around ${high}.`);
    } else if (low) {
      pieces.push(`Low around ${low}.`);
    }
    if (Number.isFinite(rainProb)) {
      pieces.push(`Rain chance up to ${Math.max(0, Math.round(rainProb))}%.`);
    }
    if (Number.isFinite(rainMm)) {
      if (rainMm <= 0.05) {
        pieces.push("Little to no rainfall expected.");
      } else {
        pieces.push(`Rainfall around ${formatMm(rainMm)}.`);
      }
    }
    forecastLines.push(pieces.join(" "));
  }

  const current = payload && typeof payload.current === "object" && payload.current ? payload.current : {};
  const currentTemp = formatCelsius(current.temperature_2m);
  const currentCondition = describeOpenMeteoWeatherCode(current.weather_code);
  const timezone = String(payload?.timezone || "").trim();
  const updatedAt = String(current.time || "").trim();
  const locationLabel = String(locationName || "").trim() || "Weather";

  const textLines = [
    fmtBold(`${locationLabel} Weather`),
    updatedAt
      ? `Updated: ${updatedAt}${timezone ? ` (${timezone})` : ""}`
      : timezone
        ? `Timezone: ${timezone}`
        : "Timezone: local",
  ];
  const spokenLines = [
    `${locationLabel} weather update.`,
  ];
  if (currentTemp) {
    const nowLine = `Now: ${currentCondition}, ${currentTemp}.`;
    textLines.push(nowLine);
    spokenLines.push(nowLine);
  }
  textLines.push(...forecastLines);
  spokenLines.push(...forecastLines);

  const firstDay = String(dayKeys[0] || "").trim();
  return {
    text: textLines.join("\n"),
    spoken: spokenLines.join(" "),
    dayKey: isUtcDayKey(firstDay) ? firstDay : "",
  };
}

async function fetchWeatherBriefing(location, options = {}) {
  if (!location || typeof location !== "object") {
    throw new Error("Weather location is not configured.");
  }
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!isValidWeatherCoordinates(latitude, longitude)) {
    throw new Error("Weather location is invalid.");
  }
  const timezone = String(location.timezone || "").trim() || "auto";
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone,
    current: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    forecast_days: "3",
    temperature_unit: "celsius",
    precipitation_unit: "mm",
    wind_speed_unit: "kmh",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const payload = await fetchJsonUrl(url, {
    headers: { Accept: "application/json" },
    timeoutMs: WEATHER_FORECAST_TIMEOUT_MS,
    signal: options?.signal,
  });
  return buildWeatherBriefing(payload, {
    locationName: String(location.name || "").trim() || "Weather",
  });
}

function buildWeatherLocationRequestKeyboard() {
  return {
    keyboard: [[{ text: "Share weather location", request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    selective: true,
  };
}

async function promptForWeatherLocationShare(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;
  pendingWeatherLocationByChat.set(key, { at: Date.now() });
  await sendMessage(
    key,
    "No default weather location is set yet. Share your current location, or run /weather <city>.",
    { replyMarkup: buildWeatherLocationRequestKeyboard() },
  );
}

async function handleWeatherLocationMessage(msg) {
  const chatId = String(msg?.chat?.id || "").trim();
  if (!chatId) return false;
  if (!pendingWeatherLocationByChat.has(chatId)) return false;

  const latitude = Number(msg?.location?.latitude);
  const longitude = Number(msg?.location?.longitude);
  if (!isValidWeatherCoordinates(latitude, longitude)) {
    pendingWeatherLocationByChat.delete(chatId);
    await sendMessage(chatId, "That location was invalid. Run /weather again and share your location.", {
      replyMarkup: { remove_keyboard: true },
    });
    return true;
  }

  let locationName = "Shared location";
  let timezone = "auto";
  try {
    const resolved = await resolveWeatherLocationFromCoordinates(latitude, longitude);
    if (resolved) {
      if (String(resolved.name || "").trim()) locationName = String(resolved.name || "").trim();
      if (String(resolved.timezone || "").trim()) timezone = String(resolved.timezone || "").trim();
    }
  } catch {
    // Keep fallback label/timezone when reverse geocoding fails.
  }

  const saved = {
    source: "chat-gps",
    name: locationName,
    latitude,
    longitude,
    timezone,
  };
  setSavedWeatherLocationForChat(chatId, saved);
  pendingWeatherLocationByChat.delete(chatId);

  try {
    const briefing = await fetchWeatherBriefing(saved);
    await sendMessage(chatId, `Saved weather location: ${buildWeatherLocationSummary(saved)}.`, {
      replyMarkup: { remove_keyboard: true },
    });
    await sendMessage(chatId, briefing.text);
    if (TTS_ENABLED) {
      await enqueueTts(chatId, briefing.spoken, "weather-command", {
        skipResultText: true,
      });
    }
  } catch (err) {
    const message = String(err?.message || err || "weather update failed").trim() || "weather update failed";
    await sendMessage(chatId, `Saved weather location: ${buildWeatherLocationSummary(saved)}.`, {
      replyMarkup: { remove_keyboard: true },
    });
    await sendMessage(chatId, `Weather update failed: ${oneLine(message)}`);
  }
  return true;
}

async function handleWeatherCommand(chatId, argText = "") {
  const cityQuery = parseWeatherCityArg(argText);
  try {
    let location = null;
    if (cityQuery) {
      location = await resolveWeatherLocationFromCity(cityQuery);
    } else {
      location = resolveDefaultWeatherLocationForChat(chatId);
      if (!location) {
        await promptForWeatherLocationShare(chatId);
        return;
      }
    }
    pendingWeatherLocationByChat.delete(String(chatId || "").trim());
    const briefing = await fetchWeatherBriefing(location);
    await sendMessage(chatId, briefing.text);
    if (TTS_ENABLED) {
      await enqueueTts(chatId, briefing.spoken, "weather-command", {
        skipResultText: true,
      });
    }
  } catch (err) {
    const message = String(err?.message || err || "weather update failed").trim() || "weather update failed";
    await sendMessage(chatId, `Weather update failed: ${oneLine(message)}`);
  }
}

async function runWeatherDailyCycle(options = {}) {
  const source = String(options?.source || "interval").trim().toLowerCase() || "interval";
  const force = options?.force === true;
  const chatId = String(options?.chatId || WEATHER_DAILY_CHAT_ID).trim();
  const now = Date.now();
  const dayKey = taipeiDayKeyFromMs(now);

  if (!WEATHER_DAILY_ENABLED && !force) return { ok: false, skipped: "disabled" };
  if (!chatId) return { ok: false, skipped: "missing_chat_id" };
  if (weatherDailyRuntime.inFlight) return { ok: false, skipped: "busy" };
  if (!force && dayKey && dayKey === String(weatherDailyState.lastSentDayKey || "").trim()) {
    weatherDailyState.lastRunAt = now;
    persistState();
    return { ok: true, skipped: "already_sent", dayKey };
  }

  weatherDailyRuntime.inFlight = true;
  try {
    const location = resolveDefaultWeatherLocationForChat(chatId);
    if (!location) {
      throw new Error(
        "No default weather location is configured. Set WEATHER_DAILY_LAT and WEATHER_DAILY_LON, or run /weather and share your location once.",
      );
    }
    const briefing = await fetchWeatherBriefing(location);
    await sendMessage(chatId, briefing.text);
    let voiceQueued = false;
    if (WEATHER_DAILY_VOICE_ENABLED && TTS_ENABLED) {
      voiceQueued = await enqueueTts(chatId, briefing.spoken, "weather-daily", {
        skipResultText: true,
      });
    }
    weatherDailyState.lastRunAt = now;
    weatherDailyState.lastSentAt = Date.now();
    weatherDailyState.lastSentDayKey = dayKey || String(briefing?.dayKey || "").trim();
    weatherDailyState.lastErrorAt = 0;
    weatherDailyState.lastError = "";
    persistState();
    return { ok: true, sent: true, source, dayKey: weatherDailyState.lastSentDayKey, voiceQueued };
  } catch (err) {
    const message = String(err?.message || err || "daily weather update failed").trim() || "daily weather update failed";
    weatherDailyState.lastRunAt = now;
    weatherDailyState.lastErrorAt = Date.now();
    weatherDailyState.lastError = message;
    persistState();
    if (WEATHER_DAILY_NOTIFY_ERRORS) {
      try {
        await sendMessage(chatId, `Daily weather update failed: ${oneLine(message)}`);
      } catch {
        // best effort
      }
    }
    return { ok: false, error: message, source };
  } finally {
    weatherDailyRuntime.inFlight = false;
  }
}

function stopWeatherDailyLoop() {
  if (weatherDailyRuntime.timer) {
    clearTimeout(weatherDailyRuntime.timer);
    weatherDailyRuntime.timer = null;
  }
  weatherDailyRuntime.nextRunAt = 0;
}

function scheduleWeatherDailyLoop(delayMs = 0) {
  if (shuttingDown || !WEATHER_DAILY_ENABLED) return;
  if (!WEATHER_DAILY_CHAT_ID) return;
  stopWeatherDailyLoop();
  const customDelay = Number(delayMs);
  const ms = Number.isFinite(customDelay) && customDelay > 0
    ? Math.max(1000, Math.trunc(customDelay))
    : Math.max(1000, computeNextWeatherDailyRunAt(Date.now()) - Date.now());
  weatherDailyRuntime.nextRunAt = Date.now() + ms;
  weatherDailyRuntime.timer = setTimeout(() => {
    weatherDailyRuntime.timer = null;
    weatherDailyRuntime.nextRunAt = 0;
    void (async () => {
      const res = await runWeatherDailyCycle({ source: "interval" });
      if (!res?.ok && String(res?.error || "").trim()) {
        log(`weather daily cycle failed: ${redactError(res.error)}`);
      }
      scheduleWeatherDailyLoop(0);
    })();
  }, ms);
}

function startWeatherDailyLoop() {
  if (!WEATHER_DAILY_ENABLED) return;
  if (!WEATHER_DAILY_CHAT_ID) return;
  scheduleWeatherDailyLoop(0);
}

async function sendWorldMonitorStatus(chatId) {
  const workerId = String(worldMonitorMonitor.workerId || "").trim()
    || (WORLDMONITOR_MONITOR_ENABLED ? ensureWorldMonitorWorker() : "");
  const worker = workerId ? getCodexWorker(workerId) : null;
  const laneState = workerId ? getWorldMonitorWorkerLaneState(workerId) : { busy: false, queued: 0 };
  const nativeStats = worldMonitorMonitor.nativeLastRefreshStats && typeof worldMonitorMonitor.nativeLastRefreshStats === "object"
    ? worldMonitorMonitor.nativeLastRefreshStats
    : {};
  const deepIngestStats = worldMonitorMonitor.nativeDeepIngestLastStats && typeof worldMonitorMonitor.nativeDeepIngestLastStats === "object"
    ? worldMonitorMonitor.nativeDeepIngestLastStats
    : {};
  const startupCatchupStats = worldMonitorMonitor.startupCatchupLastStats && typeof worldMonitorMonitor.startupCatchupLastStats === "object"
    ? worldMonitorMonitor.startupCatchupLastStats
    : {};
  const nativeFeeds = loadWorldMonitorNativeFeedManifest();
  const nativeFeedCount = Array.isArray(nativeFeeds) ? nativeFeeds.length : 0;
  const lines = [
    fmtBold("WorldMonitor Monitor"),
    `- enabled: ${WORLDMONITOR_MONITOR_ENABLED}`,
    `- source_mode: native`,
    `- feed_manifest_path: ${WORLDMONITOR_NATIVE_FEEDS_PATH}`,
    `- feed_manifest_count: ${nativeFeedCount}`,
    `- native_store_items: ${worldMonitorNativeNewsItems.length}`,
    `- native_last_refresh: ${worldMonitorMonitor.nativeLastRefreshAt ? `${nowIso(worldMonitorMonitor.nativeLastRefreshAt)} (${formatRelativeAge(worldMonitorMonitor.nativeLastRefreshAt)})` : "never"}`,
    `- native_refresh_duration_ms: ${Math.round(Number(worldMonitorMonitor.nativeLastRefreshDurationMs || 0) || 0)}`,
    `- native_feed_stats: total=${Math.round(Number(nativeStats.feeds_total || 0) || 0)}, ok=${Math.round(Number(nativeStats.feeds_ok || 0) || 0)}, failed=${Math.round(Number(nativeStats.feeds_failed || 0) || 0)}, new=${Math.round(Number(nativeStats.new_items || 0) || 0)}`,
    `- native_article_context_refresh: ${worldMonitorMonitor.nativeDeepIngestLastRunAt ? `${nowIso(worldMonitorMonitor.nativeDeepIngestLastRunAt)} (${formatRelativeAge(worldMonitorMonitor.nativeDeepIngestLastRunAt)})` : "never"}`,
    `- native_article_context_duration_ms: ${Math.round(Number(worldMonitorMonitor.nativeDeepIngestLastDurationMs || 0) || 0)}`,
    `- native_article_context_stats: scanned=${Math.round(Number(deepIngestStats.scanned || 0) || 0)}, selected=${Math.round(Number(deepIngestStats.selected || 0) || 0)}, ok=${Math.round(Number(deepIngestStats.completed || 0) || 0)}, errors=${Math.round(Number(deepIngestStats.errors || 0) || 0)}, pending=${Math.round(Number(deepIngestStats.remaining_pending || 0) || 0)}, budget_hit=${Boolean(deepIngestStats.stage_budget_hit)}`,
    `- native_signals_refresh: ${worldMonitorMonitor.nativeSignalsLastRefreshAt ? `${nowIso(worldMonitorMonitor.nativeSignalsLastRefreshAt)} (${formatRelativeAge(worldMonitorMonitor.nativeSignalsLastRefreshAt)})` : "never"}`,
    `- native_signals_points: market=${Array.isArray(worldMonitorNativeSignals.marketSeries) ? worldMonitorNativeSignals.marketSeries.length : 0}, crypto=${Array.isArray(worldMonitorNativeSignals.cryptoSeries) ? worldMonitorNativeSignals.cryptoSeries.length : 0}, seismic=${Array.isArray(worldMonitorNativeSignals.seismicSeries) ? worldMonitorNativeSignals.seismicSeries.length : 0}, infra=${Array.isArray(worldMonitorNativeSignals.infrastructureSeries) ? worldMonitorNativeSignals.infrastructureSeries.length : 0}, adsb=${Array.isArray(worldMonitorNativeSignals.adsbSeries) ? worldMonitorNativeSignals.adsbSeries.length : 0}, disaster=${Array.isArray(worldMonitorNativeSignals.disasterSeries) ? worldMonitorNativeSignals.disasterSeries.length : 0}, maritime=${Array.isArray(worldMonitorNativeSignals.maritimeSeries) ? worldMonitorNativeSignals.maritimeSeries.length : 0}, services=${Array.isArray(worldMonitorNativeSignals.serviceSeries) ? worldMonitorNativeSignals.serviceSeries.length : 0}, macro=${Array.isArray(worldMonitorNativeSignals.macroSeries) ? worldMonitorNativeSignals.macroSeries.length : 0}, prediction=${Array.isArray(worldMonitorNativeSignals.predictionSeries) ? worldMonitorNativeSignals.predictionSeries.length : 0}`,
    `- startup_catchup: ${WORLDMONITOR_STARTUP_CATCHUP_ENABLED ? "enabled" : "disabled"} (min_lookback_h=${WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS}, per_source=${WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE})`,
    `- startup_catchup_last_run: ${worldMonitorMonitor.startupCatchupLastRunAt ? `${nowIso(worldMonitorMonitor.startupCatchupLastRunAt)} (${formatRelativeAge(worldMonitorMonitor.startupCatchupLastRunAt)})` : "never"}`,
    `- startup_catchup_stats: lookback_h=${Math.round(Number(startupCatchupStats.lookback_hours || 0) || 0)}, downtime_h=${Math.round(Number(startupCatchupStats.downtime_hours || 0) || 0)}, per_source=${Math.round(Number(startupCatchupStats.max_items_per_source || 0) || 0)}, feeds_ok=${Math.round(Number(startupCatchupStats.feeds_ok || 0) || 0)}/${Math.round(Number(startupCatchupStats.feeds_total || 0) || 0)}, new=${Math.round(Number(startupCatchupStats.new_items || 0) || 0)}, stored=${Math.round(Number(startupCatchupStats.stored_items || 0) || 0)}`,
    `- interval_sec: ${WORLDMONITOR_MONITOR_INTERVAL_SEC}`,
    `- interval_alert_mode: ${WORLDMONITOR_INTERVAL_ALERT_MODE}`,
    `- interval_headlines_min_level: ${WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL}`,
    `- interval_report_policy: baseline_per_day=${WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY}, max_per_day=${worldMonitorIntervalReportMaxLabel()}, min_interval_sec=${WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC}, significant_delta>=${WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA}`,
    `- cooldown_sec: ${WORLDMONITOR_ALERT_COOLDOWN_SEC}`,
    `- article_context: ${WORLDMONITOR_DEEP_INGEST_ENABLED ? `enabled (concurrency=${WORLDMONITOR_DEEP_INGEST_CONCURRENCY}, timeout=${WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS}ms, stage_budget=${WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS}ms, max_per_cycle=${worldMonitorDeepIngestCapLabel()}, lookback_hours=${WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS})` : "disabled"}`,
    `- thresholds: global>=${WORLDMONITOR_MIN_GLOBAL_RISK_SCORE}, country>=${WORLDMONITOR_MIN_COUNTRY_RISK_SCORE}, delta>=${WORLDMONITOR_MIN_GLOBAL_DELTA}`,
    `- feed_alerts: ${WORLDMONITOR_FEED_ALERTS_ENABLED ? `enabled (interval=${WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC}s, engine=native, min_level=${WORLDMONITOR_FEED_ALERTS_MIN_LEVEL}, max_article_age_h=${WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS}, sent_key_cap=${WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP}, skip_aggregators=${WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS}, skip_documents=${WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS}, require_context_quality=${WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY})` : "disabled"}`,
    `- voice_alerts: ${WORLDMONITOR_ALERT_VOICE_ENABLED ? "enabled (uncapped)" : "disabled"}`,
    `- check_voice: ${WORLDMONITOR_CHECK_VOICE_ENABLED ? "enabled (uncapped)" : "disabled"}`,
    `- worker: ${workerId ? `${workerId}${worker ? ` (${String(worker.name || worker.title || workerId).trim() || workerId})` : ""}` : "(none)"}`,
    `- worker_queue: busy=${laneState.busy} queued=${laneState.queued}`,
    `- last_run: ${worldMonitorMonitor.lastRunAt ? `${nowIso(worldMonitorMonitor.lastRunAt)} (${formatRelativeAge(worldMonitorMonitor.lastRunAt)})` : "never"}`,
    `- last_alert: ${worldMonitorMonitor.lastAlertAt ? `${nowIso(worldMonitorMonitor.lastAlertAt)} (${formatRelativeAge(worldMonitorMonitor.lastAlertAt)})` : "never"}`,
    `- interval_reports_today: ${Math.max(0, Number(worldMonitorMonitor.intervalReportCount || 0) || 0)} (day=${String(worldMonitorMonitor.intervalReportDayKey || "").trim() || "n/a"})`,
    `- interval_report_last: ${worldMonitorMonitor.intervalReportLastAt ? `${nowIso(worldMonitorMonitor.intervalReportLastAt)} (${formatRelativeAge(worldMonitorMonitor.intervalReportLastAt)})` : "never"}`,
    `- feed_last_run: ${worldMonitorMonitor.feedAlertsLastRunAt ? `${nowIso(worldMonitorMonitor.feedAlertsLastRunAt)} (${formatRelativeAge(worldMonitorMonitor.feedAlertsLastRunAt)})` : "never"}`,
    `- feed_last_seen_at: ${worldMonitorMonitor.feedAlertsLastSeenAt ? `${nowIso(worldMonitorMonitor.feedAlertsLastSeenAt)} (${formatRelativeAge(worldMonitorMonitor.feedAlertsLastSeenAt)})` : "never"}`,
    `- last_alert_reason: ${String(worldMonitorMonitor.lastAlertReason || "").trim() || "(none)"}`,
    `- interval_report_last_reason: ${String(worldMonitorMonitor.intervalReportLastReason || "").trim() || "(none)"}`,
    `- snapshot: ${String(worldMonitorMonitor.lastSnapshotSummary || "").trim() || "(none)"}`,
    `- last_error: ${String(worldMonitorMonitor.lastError || "").trim() || "(none)"}`,
    `- feed_last_error: ${String(worldMonitorMonitor.feedAlertsLastError || "").trim() || "(none)"}`,
    `- native_last_error: ${String(worldMonitorMonitor.nativeLastRefreshError || "").trim() || "(none)"}`,
    `- native_article_context_last_error: ${String(worldMonitorMonitor.nativeDeepIngestLastError || "").trim() || "(none)"}`,
    `- native_signals_last_error: ${String(worldMonitorMonitor.nativeSignalsLastRefreshError || "").trim() || "(none)"}`,
    `- startup_catchup_last_error: ${String(worldMonitorMonitor.startupCatchupLastError || "").trim() || "(none)"}`,
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function sendStatus(chatId) {
  const queueCap = MAX_QUEUE_SIZE > 0 ? String(MAX_QUEUE_SIZE) : "unlimited";
  const queued = totalQueuedJobs();
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const activeWorker = activeWorkerId ? getCodexWorker(activeWorkerId) : null;
  const activeWorkerName = String(activeWorker?.name || activeWorker?.title || "").trim();
  const activeWorkerLabel = activeWorkerId
    ? activeWorkerName || activeWorkerId
    : "(none)";
  const activeSession = getActiveSessionForChat(chatId, activeWorkerId);
  const prefs = getChatPrefs(chatId);
  const effectiveModel = String(prefs.model || CODEX_MODEL || "").trim() || "(default)";
  const effectiveReasoning = String(prefs.reasoning || CODEX_REASONING_EFFORT || "").trim() || "(default)";
  const chatVoiceMode = resolveTtsVoiceModeForPrefs(prefs);
  const chatVoicePreset = normalizeTtsPresetName(prefs.ttsPreset, { allowDefault: true });
  const effectiveVoicePreset = resolveTtsPresetForChat(chatId, "", activeWorkerId);
  const defaultVoicePreset = getDefaultTtsPresetName();
  const codexWorkers = listCodexWorkers();
  const capabilityCount = codexWorkers.length;
  const ttsLane = getLane(ORCH_TTS_LANE_ID);
  const whisperLane = getLane(ORCH_WHISPER_LANE_ID);
  const restartCounts = laneWorkloadCounts();
  const restartState = hasPendingRestartRequest()
    ? `queued (active=${restartCounts.active}, queued=${restartCounts.queued})`
    : "none";
  const routerModel = String(ORCH_ROUTER_MODEL || CODEX_MODEL || "").trim() || "(default)";
  const routerReasoning = String(ORCH_ROUTER_REASONING_EFFORT || "").trim() || "(default)";
  if (ORCH_LESSONS_ENABLED) pruneOrchLessons({ persist: false });
  const lessonsCount = Array.isArray(orchLessons) ? orchLessons.length : 0;
  const lessonsLastAt = lessonsCount > 0
    ? Math.max(...orchLessons.map((x) => Number(x?.lastSeenAt || 0)))
    : 0;
  const whisperKeepaliveState = !WHISPER_KEEPALIVE
    ? "off"
    : whisperKeepalive.ready
      ? "ready"
      : whisperKeepalive.startPromise
        ? "warming"
        : whisperKeepalive.proc
          ? "starting"
          : "idle";
  const ttsKeepaliveState = ttsKeepalive.ready
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
  const ttsKeepaliveLastClose = ttsKeepalive.lastCloseAt
    ? `${formatRelativeAge(ttsKeepalive.lastCloseAt)} (${oneLine(ttsKeepalive.lastCloseReason || "").slice(0, 180) || "unknown"})`
    : "never";
  const ttsKeepaliveLastError = ttsKeepalive.lastErrorAt
    ? `${formatRelativeAge(ttsKeepalive.lastErrorAt)} (${oneLine(ttsKeepalive.lastError || "").slice(0, 180) || "unknown"})`
    : "never";
  const ttsKeepaliveLastFallback = ttsKeepalive.lastFallbackAt
    ? `${formatRelativeAge(ttsKeepalive.lastFallbackAt)} (${oneLine(ttsKeepalive.lastFallbackReason || "").slice(0, 140) || "unknown"})`
    : "never";
  const ttsKeepaliveLastRestart = ttsKeepalive.lastRestartAt
    ? `${formatRelativeAge(ttsKeepalive.lastRestartAt)} (delay=${Math.max(0, Math.round(Number(ttsKeepalive.lastRestartDelayMs || 0)))}ms, reason=${oneLine(ttsKeepalive.lastRestartReason || "").slice(0, 120) || "unknown"})`
    : "never";
  const ttsKeepaliveLastStop = ttsKeepalive.lastStopAt
    ? `${formatRelativeAge(ttsKeepalive.lastStopAt)} (${oneLine(ttsKeepalive.lastStopReason || "").slice(0, 180) || "unknown"})`
    : "never";
  const worldMonitorWorkerId = String(worldMonitorMonitor.workerId || "").trim()
    || (WORLDMONITOR_MONITOR_ENABLED ? ensureWorldMonitorWorker() : "");
  const worldMonitorWorker = worldMonitorWorkerId ? getCodexWorker(worldMonitorWorkerId) : null;
  const worldMonitorLane = worldMonitorWorkerId
    ? getWorldMonitorWorkerLaneState(worldMonitorWorkerId)
    : { busy: false, queued: 0 };
  const worldMonitorWorkerLabel = worldMonitorWorkerId
    ? `${worldMonitorWorkerId}${worldMonitorWorker ? ` (${String(worldMonitorWorker.name || worldMonitorWorker.title || worldMonitorWorkerId).trim() || worldMonitorWorkerId})` : ""}`
    : "(none)";
  const startupCatchupStats = worldMonitorMonitor.startupCatchupLastStats && typeof worldMonitorMonitor.startupCatchupLastStats === "object"
    ? worldMonitorMonitor.startupCatchupLastStats
    : {};
  const weatherNextRunLabel = Number(weatherDailyRuntime.nextRunAt || 0) > 0
    ? nowIso(Number(weatherDailyRuntime.nextRunAt || 0))
    : "not scheduled";
  const configuredWeatherLocation = getConfiguredWeatherLocation();
  const configuredWeatherLocationLabel = configuredWeatherLocation
    ? buildWeatherLocationSummary(configuredWeatherLocation)
    : "(unset)";
  const sharedWeatherLocationChats = Object.keys(weatherLocationsByChat).length;

  const lines = [
    fmtBold("Status"),
    "",
    fmtBold("Chat"),
    `- active_worker: ${activeWorkerLabel}`,
    `- active_session: ${activeSession ? shortSessionId(activeSession) : "(none)"}`,
    `- model: ${effectiveModel}${prefs.model ? " (chat override)" : ""}`,
    `- reasoning: ${effectiveReasoning}${prefs.reasoning ? " (chat override)" : ""}`,
    `- voice_mode: ${chatVoiceMode}`,
    `- voice_preset: ${effectiveVoicePreset}${chatVoicePreset ? " (chat override)" : ` (default=${defaultVoicePreset})`}`,
    "",
    fmtBold("Orchestrator"),
    `- workers: ${codexWorkers.length}/${ORCH_MAX_CODEX_WORKERS}`,
    `- capabilities: ${capabilityCount} worker summaries`,
    `- queue: ${queued}/${queueCap}`,
    `- exec_mode: ${codexMode.mode}`,
    `- chat_actions: ${TELEGRAM_CHAT_ACTION_ENABLED ? `enabled (default=${TELEGRAM_CHAT_ACTION_DEFAULT}, voice=${TELEGRAM_CHAT_ACTION_VOICE}, interval=${TELEGRAM_CHAT_ACTION_INTERVAL_SEC}s)` : "disabled"}`,
    `- router: ${ORCH_ROUTER_ENABLED ? "enabled" : "disabled"} (model=${routerModel}, reasoning=${routerReasoning})`,
    `- split_routing: ${ORCH_SPLIT_ENABLED ? "enabled" : "disabled"} (max_tasks=${ORCH_SPLIT_MAX_TASKS})`,
    `- lesson_memory: ${ORCH_LESSONS_ENABLED ? "enabled" : "disabled"} (stored=${lessonsCount}, per_prompt=${ORCH_LESSONS_PER_PROMPT}, last=${lessonsLastAt ? formatRelativeAge(lessonsLastAt) : "never"})`,
    `- whisper: ${WHISPER_ENABLED ? "enabled" : "disabled"}`,
    `- whisper_keepalive: ${whisperKeepaliveState} (prewarm=${WHISPER_PREWARM_ON_STARTUP}, auto_restart=${WHISPER_KEEPALIVE_AUTO_RESTART})`,
    `- tts_keepalive: ${ttsKeepaliveState} (prewarm=${TTS_PREWARM_ON_STARTUP}, auto_restart=${TTS_KEEPALIVE_AUTO_RESTART})`,
    `- tts_keepalive_diag: starts=${ttsKeepalive.startCount} ready=${ttsKeepalive.readyCount} closes=${ttsKeepalive.closeCount} stops=${ttsKeepalive.stopCount} errors=${ttsKeepalive.errorCount} restarts=${ttsKeepalive.restartScheduledCount}/${ttsKeepalive.restartFailureCount} req_fail=${ttsKeepalive.requestFailureCount}/${ttsKeepalive.requestCount} timeouts=${ttsKeepalive.timeoutCount} fallback(single=${ttsKeepalive.fallbackSingleCount},batch=${ttsKeepalive.fallbackBatchCount})`,
    `- tts_keepalive_last_close: ${ttsKeepaliveLastClose}`,
    `- tts_keepalive_last_stop: ${ttsKeepaliveLastStop}`,
    `- tts_keepalive_last_error: ${ttsKeepaliveLastError}`,
    `- tts_keepalive_last_restart: ${ttsKeepaliveLastRestart}`,
    `- tts_keepalive_last_fallback: ${ttsKeepaliveLastFallback}`,
    `- tts_batch_mode: ${ttsBatchMode}`,
    `- tts_lane: ${ttsLane?.currentJob ? "busy" : "idle"} (queued=${ttsLane?.queue?.length || 0})`,
    `- whisper_lane: ${whisperLane?.currentJob ? "busy" : "idle"} (queued=${whisperLane?.queue?.length || 0})`,
    `- worldmonitor_source_mode: native`,
    `- worldmonitor_monitor: ${WORLDMONITOR_MONITOR_ENABLED ? "enabled" : "disabled"} (interval=${WORLDMONITOR_MONITOR_INTERVAL_SEC}s, interval_alert_mode=${WORLDMONITOR_INTERVAL_ALERT_MODE}, headlines_min_level=${WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL}, report_baseline=${WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY}/day, report_max=${worldMonitorIntervalReportMaxLabel()}/day, report_min_interval=${WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC}s, report_sig_delta>=${WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA}, cooldown=${WORLDMONITOR_ALERT_COOLDOWN_SEC}s)`,
    `- worldmonitor_feed_alerts: ${WORLDMONITOR_FEED_ALERTS_ENABLED ? "enabled" : "disabled"} (interval=${WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC}s, engine=native, min_level=${WORLDMONITOR_FEED_ALERTS_MIN_LEVEL}, max_article_age_h=${WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS}, sent_key_cap=${WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP}, skip_aggregators=${WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS}, skip_documents=${WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS}, require_context_quality=${WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY})`,
    `- worldmonitor_startup_catchup: ${WORLDMONITOR_STARTUP_CATCHUP_ENABLED ? "enabled" : "disabled"} (min_lookback_h=${WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS}, per_source=${WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE})`,
    `- worldmonitor_article_context: ${WORLDMONITOR_DEEP_INGEST_ENABLED ? "enabled" : "disabled"} (concurrency=${WORLDMONITOR_DEEP_INGEST_CONCURRENCY}, timeout=${WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS}ms, stage_budget=${WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS}ms, max_per_cycle=${worldMonitorDeepIngestCapLabel()}, lookback_hours=${WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS})`,
    `- worldmonitor_worker: ${worldMonitorWorkerLabel} | busy=${worldMonitorLane.busy} queued=${worldMonitorLane.queued}`,
    `- worldmonitor_check: ${worldMonitorComprehensiveRuntime.inFlight ? `running (${formatRelativeAge(worldMonitorComprehensiveRuntime.lastStartedAt)})` : "idle"}`,
    `- worldmonitor_last_run: ${worldMonitorMonitor.lastRunAt ? `${formatRelativeAge(worldMonitorMonitor.lastRunAt)}` : "never"}`,
    `- worldmonitor_last_alert: ${worldMonitorMonitor.lastAlertAt ? `${formatRelativeAge(worldMonitorMonitor.lastAlertAt)}` : "never"}`,
    `- worldmonitor_feed_last_run: ${worldMonitorMonitor.feedAlertsLastRunAt ? `${formatRelativeAge(worldMonitorMonitor.feedAlertsLastRunAt)}` : "never"}`,
    `- worldmonitor_native_refresh: ${worldMonitorMonitor.nativeLastRefreshAt ? `${formatRelativeAge(worldMonitorMonitor.nativeLastRefreshAt)}` : "never"} (items=${worldMonitorNativeNewsItems.length})`,
    `- worldmonitor_startup_catchup_last_run: ${worldMonitorMonitor.startupCatchupLastRunAt ? `${formatRelativeAge(worldMonitorMonitor.startupCatchupLastRunAt)}` : "never"} (lookback_h=${Math.round(Number(startupCatchupStats.lookback_hours || 0) || 0)}, new=${Math.round(Number(startupCatchupStats.new_items || 0) || 0)}, feeds_ok=${Math.round(Number(startupCatchupStats.feeds_ok || 0) || 0)}/${Math.round(Number(startupCatchupStats.feeds_total || 0) || 0)})`,
    `- worldmonitor_article_context_refresh: ${worldMonitorMonitor.nativeDeepIngestLastRunAt ? `${formatRelativeAge(worldMonitorMonitor.nativeDeepIngestLastRunAt)}` : "never"} (scanned=${Math.round(Number(worldMonitorMonitor?.nativeDeepIngestLastStats?.scanned || 0) || 0)}, selected=${Math.round(Number(worldMonitorMonitor?.nativeDeepIngestLastStats?.selected || 0) || 0)}, ok=${Math.round(Number(worldMonitorMonitor?.nativeDeepIngestLastStats?.completed || 0) || 0)}, errors=${Math.round(Number(worldMonitorMonitor?.nativeDeepIngestLastStats?.errors || 0) || 0)}, pending=${Math.round(Number(worldMonitorMonitor?.nativeDeepIngestLastStats?.remaining_pending || 0) || 0)}, budget_hit=${Boolean(worldMonitorMonitor?.nativeDeepIngestLastStats?.stage_budget_hit)})`,
    `- worldmonitor_native_signals_refresh: ${worldMonitorMonitor.nativeSignalsLastRefreshAt ? `${formatRelativeAge(worldMonitorMonitor.nativeSignalsLastRefreshAt)}` : "never"} (market=${Array.isArray(worldMonitorNativeSignals.marketSeries) ? worldMonitorNativeSignals.marketSeries.length : 0}, crypto=${Array.isArray(worldMonitorNativeSignals.cryptoSeries) ? worldMonitorNativeSignals.cryptoSeries.length : 0}, seismic=${Array.isArray(worldMonitorNativeSignals.seismicSeries) ? worldMonitorNativeSignals.seismicSeries.length : 0}, infra=${Array.isArray(worldMonitorNativeSignals.infrastructureSeries) ? worldMonitorNativeSignals.infrastructureSeries.length : 0}, adsb=${Array.isArray(worldMonitorNativeSignals.adsbSeries) ? worldMonitorNativeSignals.adsbSeries.length : 0}, disaster=${Array.isArray(worldMonitorNativeSignals.disasterSeries) ? worldMonitorNativeSignals.disasterSeries.length : 0}, maritime=${Array.isArray(worldMonitorNativeSignals.maritimeSeries) ? worldMonitorNativeSignals.maritimeSeries.length : 0}, services=${Array.isArray(worldMonitorNativeSignals.serviceSeries) ? worldMonitorNativeSignals.serviceSeries.length : 0}, macro=${Array.isArray(worldMonitorNativeSignals.macroSeries) ? worldMonitorNativeSignals.macroSeries.length : 0}, prediction=${Array.isArray(worldMonitorNativeSignals.predictionSeries) ? worldMonitorNativeSignals.predictionSeries.length : 0})`,
    `- worldmonitor_last_error: ${String(worldMonitorMonitor.lastError || "").trim() || "(none)"}`,
    `- worldmonitor_feed_last_error: ${String(worldMonitorMonitor.feedAlertsLastError || "").trim() || "(none)"}`,
    `- worldmonitor_native_error: ${String(worldMonitorMonitor.nativeLastRefreshError || "").trim() || "(none)"}`,
    `- worldmonitor_article_context_error: ${String(worldMonitorMonitor.nativeDeepIngestLastError || "").trim() || "(none)"}`,
    `- worldmonitor_native_signals_error: ${String(worldMonitorMonitor.nativeSignalsLastRefreshError || "").trim() || "(none)"}`,
    `- worldmonitor_startup_catchup_error: ${String(worldMonitorMonitor.startupCatchupLastError || "").trim() || "(none)"}`,
    `- worldmonitor_check_voice: ${WORLDMONITOR_CHECK_VOICE_ENABLED ? "enabled (uncapped)" : "disabled"}`,
    `- weather_daily: ${WEATHER_DAILY_ENABLED ? "enabled" : "disabled"} (chat=${WEATHER_DAILY_CHAT_ID || "(unset)"}, time=${String(WEATHER_DAILY_HOUR).padStart(2, "0")}:${String(WEATHER_DAILY_MINUTE).padStart(2, "0")} ${WEATHER_DAILY_TIMEZONE}, configured_location=${configuredWeatherLocationLabel}, shared_gps_chats=${sharedWeatherLocationChats}, voice=${WEATHER_DAILY_VOICE_ENABLED ? "on" : "off"})`,
    `- weather_daily_next: ${weatherNextRunLabel}`,
    `- weather_daily_last_sent: ${weatherDailyState.lastSentAt ? `${formatRelativeAge(weatherDailyState.lastSentAt)} (day=${String(weatherDailyState.lastSentDayKey || "").trim() || "n/a"})` : "never"}`,
    `- weather_daily_last_error: ${String(weatherDailyState.lastError || "").trim() || "(none)"}`,
    `- restart: ${restartState}`,
    "",
    fmtBold("Config"),
    `- full_access: ${CODEX_DANGEROUS_FULL_ACCESS}`,
    `- sandbox: ${CODEX_SANDBOX}`,
    `- approval: ${CODEX_APPROVAL_POLICY}`,
    `- general_workdir: ${String(getCodexWorker(ORCH_GENERAL_WORKER_ID)?.workdir || ROOT)}`,
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
      const workerName = String(w.name || "").trim() || "(unnamed)";
      if (index > 0) lines.push("");
      lines.push(`- worker: ${workerName}${activeTag}`);
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
    ? String(activeWorker.name || activeWorker.title || activeWorkerId).trim()
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
    const displayName = String(w.name || "").trim() || String(w.title || "").trim() || w.id;
    const repoTag = w.title && w.title !== displayName ? ` | repo=${w.title}` : "";
    lines.push(
      `${marker} ${displayName} (${w.kind}) | busy=${busy} | queued=${queued}${repoTag} | workdir=${String(w.workdir || "").replace(/\\/g, "/")}`,
    );
  }

  lines.push(
    "",
    fmtBold("Commands"),
    "/use <worker_id, name, or title> - switch active workspace",
    "/spawn <local-path> [title] - create a new repo workspace",
    "/retire <worker_id, name, or title> - remove a workspace",
    "/newsstatus - worldmonitor monitor state",
  );

  await sendMessage(chatId, lines.join("\n"));
}

async function sendCapabilities(chatId) {
  const workers = listCodexWorkers();
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const rows = listWorkerCapabilities();
  const rowByWorker = new Map(rows.map((row) => [String(row.workerId || "").trim(), row]));

  const lines = [
    `${fmtBold("Capability Map")} (${rows.length} workers)`,
  ];

  if (workers.length === 0) {
    lines.push("- no workers");
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  for (const worker of workers) {
    const wid = String(worker.id || "").trim();
    if (!wid) continue;
    const marker = wid === activeWorkerId ? " (active)" : "";
    const display = String(worker.name || worker.title || wid).trim() || wid;
    const row = rowByWorker.get(wid) || null;
    const summary = String(row?.summary || getWorkerCapabilitySummary(wid) || "").trim() || "(missing capability summary)";
    lines.push("", `- worker: ${display}${marker}`, `- summary: ${summary}`);
  }

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
  for (const m of CODEX_DEFAULT_MODEL_CHOICES) add(m);
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

function getEffectiveReasoningChoicesForModel(model) {
  const cleanModel = normalizeCodexModelName(model).toLowerCase();
  const modelSpecific = Array.isArray(CODEX_REASONING_EFFORTS_BY_MODEL[cleanModel])
    ? CODEX_REASONING_EFFORTS_BY_MODEL[cleanModel]
    : [];
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const value of modelSpecific) add(value);
  if (out.length <= 0) {
    for (const value of getEffectiveReasoningChoices()) add(value);
  }
  return out.slice(0, 8);
}

function pickDefaultReasoningForModel(model) {
  const choices = getEffectiveReasoningChoicesForModel(model);
  const preferred = String(CODEX_REASONING_EFFORT || "").trim().toLowerCase();
  if (preferred && choices.includes(preferred)) return preferred;
  return choices[0] || preferred || "";
}

function normalizeReasoningForModel(model, reasoning) {
  const choices = getEffectiveReasoningChoicesForModel(model);
  const cleanReasoning = String(reasoning || "").trim().toLowerCase();
  if (!cleanReasoning) return "";
  return choices.includes(cleanReasoning) ? cleanReasoning : "";
}

function buildModelPickerPayload(chatId) {
  const prefs = getChatPrefs(chatId);
  const effectiveModel = String(prefs.model || CODEX_MODEL || "").trim() || CODEX_MODEL || "(default)";
  const reasoningChoices = getEffectiveReasoningChoicesForModel(effectiveModel);
  const effectiveReasoning = normalizeReasoningForModel(
    effectiveModel,
    String(prefs.reasoning || CODEX_REASONING_EFFORT || "").trim(),
  ) || "(default)";

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

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  };
}

async function sendModelPicker(chatId) {
  const payload = buildModelPickerPayload(chatId);
  await sendMessage(chatId, payload.text, {
    replyMarkup: payload.replyMarkup,
  });
}

async function refreshModelPickerMessage(chatId, messageId) {
  const msgId = Number(messageId || 0);
  if (!Number.isFinite(msgId) || msgId <= 0) {
    await sendModelPicker(chatId);
    return;
  }
  const payload = buildModelPickerPayload(chatId);
  const formatted = renderTelegramEntities(normalizeResponse(payload.text));
  const body = {
    chat_id: chatId,
    message_id: msgId,
    text: formatted.text,
    disable_web_page_preview: true,
    reply_markup: payload.replyMarkup,
  };
  if (formatted.entities) body.entities = formatted.entities;
  try {
    await telegramApi("editMessageText", { body });
  } catch (err) {
    const message = String(err?.message || err || "");
    const status = parseTelegramStatusFromError(err);
    if (status === 400 && /message is not modified/i.test(message)) return;
    log(`edit model picker failed: ${redactError(message)}`);
    await sendMessage(chatId, payload.text, { replyMarkup: payload.replyMarkup });
  }
}

function buildVoicePresetPickerPayload(chatId) {
  const prefs = getChatPrefs(chatId);
  const ttsMode = resolveTtsVoiceModeForPrefs(prefs);
  const chatPreset = normalizeTtsPresetName(prefs.ttsPreset, { allowDefault: true });
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const effective = resolveTtsPresetForChat(chatId, "", activeWorkerId);
  const defaultPreset = getDefaultTtsPresetName();
  const effectiveDesc = getTtsPresetDescription(effective);
  const defaultDesc = getTtsPresetDescription(defaultPreset);
  const chatLabel = chatPreset && chatPreset !== "default" ? chatPreset : "(none)";
  const chatDesc = chatPreset && chatPreset !== "default" ? getTtsPresetDescription(chatPreset) : "";
  const modeLabel = ttsMode === TTS_VOICE_MODE_SINGLE ? "single (one voice for all)" : "worker (each worker + orchestrator)";

  const lines = [
    fmtBold("Voice preset (this chat)"),
    `- mode: ${modeLabel}`,
    `- effective: ${effective}${effectiveDesc ? ` (${effectiveDesc})` : ""}`,
    `- chat_override: ${chatLabel}${chatDesc ? ` (${chatDesc})` : ""}`,
    `- bot_default: ${defaultPreset}${defaultDesc ? ` (${defaultDesc})` : ""}`,
    "",
    "Tap mode first, then pick a preset (preset tap switches to single mode).",
  ];

  const keyboard = [];
  const modeWorkerId = registerPrefButton(chatId, "tts-mode", TTS_VOICE_MODE_WORKER);
  const modeSingleId = registerPrefButton(chatId, "tts-mode", TTS_VOICE_MODE_SINGLE);
  keyboard.push([
    { text: ttsMode === TTS_VOICE_MODE_WORKER ? "* Worker voices" : "Worker voices", callback_data: `pref:${modeWorkerId}` },
    { text: ttsMode === TTS_VOICE_MODE_SINGLE ? "* Single voice" : "Single voice", callback_data: `pref:${modeSingleId}` },
  ]);
  const presetChoices = getAvailableTtsPresetNames();
  for (let i = 0; i < presetChoices.length; i += 2) {
    const row = [];
    for (const preset of presetChoices.slice(i, i + 2)) {
      const id = registerPrefButton(chatId, "tts-preset", preset);
      row.push({ text: preset === effective ? `* ${preset}` : preset, callback_data: `pref:${id}` });
    }
    keyboard.push(row);
  }

  const resetId = registerPrefButton(chatId, "tts-preset-reset", "default");
  keyboard.push([{ text: "Clear shared preset", callback_data: `pref:${resetId}` }]);

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  };
}

async function sendVoicePresetPicker(chatId) {
  const payload = buildVoicePresetPickerPayload(chatId);
  await sendMessage(chatId, payload.text, {
    replyMarkup: payload.replyMarkup,
  });
}

async function refreshVoicePresetPickerMessage(chatId, messageId) {
  const msgId = Number(messageId || 0);
  if (!Number.isFinite(msgId) || msgId <= 0) {
    await sendVoicePresetPicker(chatId);
    return;
  }
  const payload = buildVoicePresetPickerPayload(chatId);
  const formatted = renderTelegramEntities(normalizeResponse(payload.text));
  const body = {
    chat_id: chatId,
    message_id: msgId,
    text: formatted.text,
    disable_web_page_preview: true,
    reply_markup: payload.replyMarkup,
  };
  if (formatted.entities) body.entities = formatted.entities;
  try {
    await telegramApi("editMessageText", { body });
  } catch (err) {
    const message = String(err?.message || err || "");
    const status = parseTelegramStatusFromError(err);
    if (status === 400 && /message is not modified/i.test(message)) return;
    log(`edit voice preset picker failed: ${redactError(message)}`);
    await sendMessage(chatId, payload.text, { replyMarkup: payload.replyMarkup });
  }
}

async function sendQueue(chatId) {
  return await orchQueueRuntime.sendQueue(chatId);
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
  return await orchQueueRuntime.cancelCurrent(chatId);
}

async function clearQueue(chatId) {
  return await orchQueueRuntime.clearQueue(chatId);
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
    lessonsRemoved: 0,
    stateChanged: false,
  };
  if (!key) return out;

  out.queuedRemoved = dropQueuedJobsForChat(key);
  out.pendingCommandCleared = Boolean(clearPendingCommandForChat(key));
  clearPendingNaturalNewsFollowup(key);
  pendingWeatherLocationByChat.delete(key);

  const dropChatKey = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    delete obj[key];
    return true;
  };

  let changed = false;
  if (dropChatKey(lastImages)) changed = true;
  if (dropChatKey(chatPrefs)) changed = true;
  if (dropChatKey(chatAutomationPrefs)) changed = true;
  if (dropChatKey(redditDigest)) changed = true;
  if (dropChatKey(weatherLocationsByChat)) changed = true;
  if (dropChatKey(orchActiveWorkerByChat)) changed = true;
  if (dropChatKey(orchSessionByChatWorker)) changed = true;
  if (dropChatKey(orchReplyRouteByChat)) changed = true;
  if (dropChatKey(orchMessageMetaByChat)) changed = true;
  if (dropChatKey(orchTasksByChat)) changed = true;
  if (Array.isArray(orchLessons) && orchLessons.length > 0) {
    const kept = orchLessons.filter((entry) => String(entry?.chatId || "").trim() !== key);
    if (kept.length !== orchLessons.length) {
      out.lessonsRemoved = Math.max(0, orchLessons.length - kept.length);
      orchLessons.splice(0, orchLessons.length, ...kept);
      changed = true;
    }
  }
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
    `- Learned lessons cleared (this chat): ${chat.lessonsRemoved}`,
    `- Chat context reset in state (this chat): ${chat.stateChanged ? "yes" : "no"}`,
  ];
  if (runtime.errors.length > 0) {
    lines.push(`- Warnings: ${runtime.errors.length}`);
    lines.push(...runtime.errors.slice(0, 3).map((e) => `  - ${e}`));
  }
  await sendMessage(key, lines.join("\n"));
}

async function pruneRuntime(chatId) {
  const key = String(chatId || "").trim();
  if (!key) return;

  const { active, queued } = laneWorkloadCounts();
  if (active > 0 || queued > 0) {
    await sendMessage(
      key,
      `Cannot run /prune while workers are busy (active=${active}, queued=${queued}). Use /cancel and /clear, wait for idle, then retry.`,
    );
    return;
  }

  const runtime = wipeRuntimeArtifacts();
  await maybeTriggerPendingRestart("prune");

  const lines = [
    "Prune complete.",
    `- Runtime files deleted: ${runtime.deletedFiles}`,
    `- Runtime directories removed: ${runtime.deletedDirs}`,
    `- Runtime bytes freed: ${runtime.deletedBytes}`,
    "- Chat context kept: yes",
  ];
  if (runtime.errors.length > 0) {
    lines.push(`- Warnings: ${runtime.errors.length}`);
    lines.push(...runtime.errors.slice(0, 3).map((e) => `  - ${e}`));
  }
  await sendMessage(key, lines.join("\n"));
}

async function enqueueRawCodexCommand(chatId, args, source = "cmd", options = {}) {
  return await orchLaneRuntime.enqueueRawCodexCommand(chatId, args, source, options);
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
  const requestedCwd = String(spec?.cwd || "").trim();
  const safeCwd = resolveUsableWorkdir(requestedCwd);
  if (requestedCwd !== safeCwd) {
    log(`[run] raw worker cwd unavailable: ${requestedCwd || "(empty)"}; using ${safeCwd}.`);
  }
  spec.cwd = safeCwd;

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
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) writeWorkerStreamChunk(chunk, { workerId: job?.workerId, stream: "stdout" });
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
    });
    child.stderr.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stderrTail = appendTail(job.stderrTail, chunk, 50000);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) writeWorkerStreamChunk(chunk, { workerId: job?.workerId, stream: "stderr" });
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

let parsedCommandRouter = null;

function getParsedCommandRouter() {
  if (parsedCommandRouter) return parsedCommandRouter;
  parsedCommandRouter = createParsedCommandRouter({
    // Workspace / help
    sendHelp,
    clearAllSessionsForChat,
    setActiveWorkerForChat,
    ORCH_GENERAL_WORKER_ID,
    clearLastImageForChat,
    sendCodexCommandMenu,
    sendStatus,
    sendWorkers,
    sendCapabilities,
    sendQueue,
    resolveWorkerIdFromUserInput,
    touchWorker,
    getCodexWorker,
    parseArgString,
    resolveWorkdirInput,
    pathExists: (targetPath) => fs.existsSync(targetPath),
    findWorkerByWorkdir,
    listCodexWorkers,
    ORCH_MAX_CODEX_WORKERS,
    createRepoWorker,
    retireWorker,

    // Monitor / news / weather
    handleWeatherCommand,
    handleNewsCommand,
    handleNewsReportCommand,
    sendWorldMonitorStatus,

    // Runtime operations
    cancelCurrent,
    clearQueue,
    pruneRuntime,
    wipeRuntime,
    handleScreenshotCommand,
    sendAttachments,
    cancelPendingRestartRequest,
    requestRestartWhenIdle,

    // Codex CLI + sessions
    sanitizeRawCodexArgs,
    setPendingCommandForChat,
    createPendingCommandSummary,
    buildPendingCommandMarkup,
    takePendingCommandByChat,
    enqueueRawCodexCommand,
    clearPendingCommandForChat,
    clearActiveSessionForChat,
    sendResumePicker,
    resolveResumeSessionId,
    setActiveSessionForChat,
    shortSessionId,

    // Vision + model + TTS
    setChatPrefs,
    sendModelPicker,
    VISION_ENABLED,
    getLastImageForChat,
    captureScreenshotsWithFallback,
    IMAGE_DIR,
    setLastImageForChat,
    pathBasename: path.basename,
    platform: process.platform,
    handleVoicePresetCommand,
    handleTtsAbTestCommand,
    TTS_ENABLED,
    parseTtsCommandInput,
    splitSpeakableTextIntoVoiceChunks,
    enqueueTtsBatch,
    enqueueTts,

    // Shared helpers
    getActiveSessionForChat,
    enqueuePrompt,
    sendMessage,
  });
  return parsedCommandRouter;
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
  return await getParsedCommandRouter()(chatId, parsed);
}

async function enqueuePrompt(chatId, inputText, source, options = {}) {
  return await orchLaneRuntime.enqueuePrompt(chatId, inputText, source, options);
}

function normalizeTtsText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const fixed = applyCommonTtsPronunciationFixes(trimmed);
  const squashed = fixed.replace(/\s+/g, " ").trim();
  return squashed;
}

const TTS_PRESET_ORDER = Object.freeze([
  "off",
  "hologram-ai",
  "starship-comms",
  "cyber-oracle",
  "alien-terminal",
  "anonymous",
  "custom",
]);

const TTS_PRESET_ALIAS_MAP = Object.freeze({
  off: "off",
  none: "off",
  disable: "off",
  disabled: "off",
  bypass: "off",
  clean: "off",
  hologram: "hologram-ai",
  "hologram-ai": "hologram-ai",
  hologramai: "hologram-ai",
  starship: "starship-comms",
  comms: "starship-comms",
  radio: "starship-comms",
  "starship-comms": "starship-comms",
  cyber: "cyber-oracle",
  oracle: "cyber-oracle",
  "cyber-oracle": "cyber-oracle",
  alien: "alien-terminal",
  terminal: "alien-terminal",
  "alien-terminal": "alien-terminal",
  anonymous: "anonymous",
  current: "anonymous",
  baseline: "anonymous",
  legacy: "anonymous",
  audacity: "anonymous",
  "audacity-stack": "anonymous",
  custom: "custom",
  raw: "custom",
});

const TTS_PRESET_DESCRIPTIONS = Object.freeze({
  off: "No post-processing.",
  "hologram-ai": "Brighter, louder hologram sheen with layered modulation.",
  "starship-comms": "Bridge comms with start/end beeps, radio grit, and short interference bursts.",
  "cyber-oracle": "Low-pitched oracle tone with slow steady pitch drift and synthetic space.",
  "alien-terminal": "Layered alien machine timbre with moderate modulation.",
  anonymous: "Legacy chain (kept for A/B comparisons; strong down-pitch).",
  custom: "Use raw ffmpeg filtergraph from env.",
});

// Per-preset output gain calibration from /abtest loudness feedback (100 = target).
const TTS_PRESET_OUTPUT_GAINS = Object.freeze({
  "hologram-ai": 2.6,
  "starship-comms": 0.95,
  "cyber-oracle": 3.8,
  "alien-terminal": 3.1,
  anonymous: 6.5,
});
const TTS_WORKER_PRESET_AUTO_ORDER = Object.freeze([
  "hologram-ai",
  "starship-comms",
  "cyber-oracle",
  "alien-terminal",
  "anonymous",
  "off",
]);
const TTS_WORKER_PRESET_DEFAULT_MAP = Object.freeze({
  nova: "cyber-oracle",
});
const TTS_WORKER_PRESET_MAP = parseWorkerTtsPresetMap(TTS_WORKER_PRESET_MAP_RAW);
const TTS_VOICE_MODE_SINGLE = "single";
const TTS_VOICE_MODE_WORKER = "worker";
const TTS_ORCHESTRATOR_ROLE_PRESET = "starship-comms";
const TTS_GENERAL_WORKER_ROLE_KEYS = Object.freeze(["general", "astra", "orchestrator"]);

function normalizeTtsPresetName(name, { allowDefault = false } = {}) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const key = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").replace(/[_\s]+/g, "-");
  if (allowDefault && ["default", "auto", "bot", "env"].includes(key)) return "default";
  return TTS_PRESET_ALIAS_MAP[key] || "";
}

function getTtsPresetOutputGain(name) {
  const key = normalizeTtsPresetName(name);
  const gain = Number(TTS_PRESET_OUTPUT_GAINS[key]);
  if (!Number.isFinite(gain) || gain <= 0) return 1;
  return gain;
}

function getAvailableTtsPresetNames() {
  return TTS_PRESET_ORDER.filter((name) => name !== "custom" || Boolean(TTS_POSTPROCESS_FFMPEG_AF));
}

function getTtsPresetDescription(name) {
  const key = normalizeTtsPresetName(name) || String(name || "").trim().toLowerCase();
  return String(TTS_PRESET_DESCRIPTIONS[key] || "").trim();
}

function formatTtsPresetChoicesInline() {
  return getAvailableTtsPresetNames().join(", ");
}

const TTS_ABTEST_DEFAULT_SAMPLE = "This is AIDOLON. Same line, different preset, for an A B voice comparison.";

function getDefaultTtsPresetName() {
  if (!TTS_POSTPROCESS_ENABLED) return "off";
  if (TTS_POSTPROCESS_FFMPEG_AF) return "custom";
  const normalized = normalizeTtsPresetName(TTS_POSTPROCESS_PRESET);
  return normalized || "anonymous";
}

function normalizeTtsVoiceMode(mode, { allowDefault = false } = {}) {
  const raw = String(mode || "").trim().toLowerCase();
  if (!raw) return "";
  const key = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").replace(/[_\s]+/g, "-");
  if (allowDefault && ["default", "auto", "bot"].includes(key)) return "default";
  if (["single", "shared", "global", "same", "one"].includes(key)) return TTS_VOICE_MODE_SINGLE;
  if (["worker", "workers", "role", "roles", "per-worker", "perrole"].includes(key)) return TTS_VOICE_MODE_WORKER;
  return "";
}

function resolveTtsVoiceModeForPrefs(prefs = {}) {
  const explicit = normalizeTtsVoiceMode(prefs?.ttsMode, { allowDefault: true });
  if (explicit && explicit !== "default") return explicit;
  const chatPreset = normalizeTtsPresetName(prefs?.ttsPreset, { allowDefault: true });
  if (chatPreset && chatPreset !== "default") return TTS_VOICE_MODE_SINGLE;
  return TTS_VOICE_MODE_WORKER;
}

function pickAvailableTtsPreset(preferredPreset, fallbackPreset = "") {
  const preferred = normalizeTtsPresetName(preferredPreset);
  const fallback = normalizeTtsPresetName(fallbackPreset);
  const available = getAvailableTtsPresetNames();
  if (preferred && available.includes(preferred)) return preferred;
  if (fallback && available.includes(fallback)) return fallback;
  return getDefaultTtsPresetName();
}

function normalizeWorkerPresetMapKey(value) {
  return oneLine(String(value || "")).replace(/\s+/g, " ").trim().toLowerCase();
}

function parseWorkerTtsPresetMap(rawValue) {
  const src = String(rawValue || "").trim();
  const out = new Map();
  if (!src) return out;

  const addPair = (rawKey, rawPreset) => {
    const key = normalizeWorkerPresetMapKey(rawKey);
    if (!key) return;
    const preset = normalizeTtsPresetName(rawPreset, { allowDefault: true });
    if (!preset || preset === "default") return;
    out.set(key, preset);
  };

  if (src.startsWith("{")) {
    try {
      const parsed = JSON.parse(src);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) addPair(k, v);
      }
    } catch {
      // fall through to plain text parsing
    }
  }

  if (out.size > 0) return out;

  for (const part of src.split(/[,\n;]+/)) {
    const token = String(part || "").trim();
    if (!token) continue;
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    addPair(token.slice(0, idx), token.slice(idx + 1));
  }
  return out;
}

function getWorkerPresetKeyCandidates(workerId) {
  const out = [];
  const push = (value) => {
    const key = normalizeWorkerPresetMapKey(value);
    if (!key || out.includes(key)) return;
    out.push(key);
  };
  const wid = String(workerId || "").trim();
  if (!wid) return out;
  push(wid);
  const worker = getCodexWorker(wid);
  if (!worker) return out;
  push(worker.name);
  push(worker.title);
  return out;
}

function resolveMappedWorkerTtsPreset(workerId) {
  const keys = getWorkerPresetKeyCandidates(workerId);
  if (TTS_WORKER_PRESET_MAP instanceof Map && TTS_WORKER_PRESET_MAP.size > 0) {
    for (const key of keys) {
      const preset = normalizeTtsPresetName(TTS_WORKER_PRESET_MAP.get(key));
      if (preset) return preset;
    }
  }
  for (const key of keys) {
    const preset = normalizeTtsPresetName(TTS_WORKER_PRESET_DEFAULT_MAP[key]);
    if (preset) return preset;
  }
  return "";
}

function resolveAutoWorkerTtsPreset(workerId) {
  const wid = String(workerId || "").trim();
  if (!wid) return "";
  const workers = listCodexWorkers();
  if (!Array.isArray(workers) || workers.length < 2) return "";

  const allChoices = TTS_WORKER_PRESET_AUTO_ORDER
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .filter((name) => getAvailableTtsPresetNames().includes(name));
  if (allChoices.length === 0) return "";
  // Keep the orchestrator role voice reserved so worker auto-assignment is less likely to collide.
  const choices = allChoices.filter((name) => name !== TTS_ORCHESTRATOR_ROLE_PRESET);
  const effectiveChoices = choices.length > 0 ? choices : allChoices;

  const orderedWorkerIds = workers
    .slice()
    .filter((w) => String(w?.id || "").trim() !== ORCH_GENERAL_WORKER_ID)
    .sort((a, b) => {
      const aCreated = Number(a?.createdAt || 0) || 0;
      const bCreated = Number(b?.createdAt || 0) || 0;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    })
    .map((w) => String(w?.id || "").trim())
    .filter(Boolean);

  const index = orderedWorkerIds.indexOf(wid);
  if (index < 0) return "";
  return effectiveChoices[index % effectiveChoices.length] || "";
}

function resolveRoleBasedTtsPreset(workerId) {
  const wid = String(workerId || "").trim();
  const worker = wid ? getCodexWorker(wid) : null;
  const workerNameKey = normalizeWorkerPresetMapKey(worker?.name || "");
  const workerTitleKey = normalizeWorkerPresetMapKey(worker?.title || "");
  const isGeneralRole = !wid
    || wid === ORCH_GENERAL_WORKER_ID
    || TTS_GENERAL_WORKER_ROLE_KEYS.includes(workerNameKey)
    || TTS_GENERAL_WORKER_ROLE_KEYS.includes(workerTitleKey);
  if (isGeneralRole) {
    return pickAvailableTtsPreset(TTS_ORCHESTRATOR_ROLE_PRESET, getDefaultTtsPresetName());
  }

  const mappedWorkerPreset = resolveMappedWorkerTtsPreset(wid);
  if (mappedWorkerPreset) return mappedWorkerPreset;
  const autoWorkerPreset = resolveAutoWorkerTtsPreset(wid);
  if (autoWorkerPreset) return autoWorkerPreset;
  return getDefaultTtsPresetName();
}

function resolveTtsPresetForChat(chatId, overridePreset = "", workerId = "", options = {}) {
  const override = normalizeTtsPresetName(overridePreset, { allowDefault: true });
  if (override && override !== "default") return override;
  const forceWorkerMode = options?.forceWorkerMode === true;
  if (forceWorkerMode) {
    return resolveRoleBasedTtsPreset(workerId);
  }
  const prefs = getChatPrefs(chatId);
  const ttsMode = resolveTtsVoiceModeForPrefs(prefs);
  const chatPreset = normalizeTtsPresetName(prefs.ttsPreset, { allowDefault: true });
  if (ttsMode === TTS_VOICE_MODE_WORKER) {
    return resolveRoleBasedTtsPreset(workerId);
  }
  if (ttsMode === TTS_VOICE_MODE_SINGLE) {
    if (chatPreset && chatPreset !== "default") return chatPreset;
    return getDefaultTtsPresetName();
  }
  if (chatPreset && chatPreset !== "default") return chatPreset;
  const mappedWorkerPreset = resolveMappedWorkerTtsPreset(workerId);
  if (mappedWorkerPreset) return mappedWorkerPreset;
  const autoWorkerPreset = resolveAutoWorkerTtsPreset(workerId);
  if (autoWorkerPreset) return autoWorkerPreset;
  return getDefaultTtsPresetName();
}

function parseTtsCommandInput(argText) {
  const raw = String(argText || "").trim();
  if (!raw) {
    return {
      ok: false,
      error: `Usage: /tts <text>\nOptional: /tts [preset:<name>] <text>\nPresets: ${formatTtsPresetChoicesInline()}`,
    };
  }

  let text = raw;
  let presetRaw = "";

  const tagged = raw.match(/^\[(?:preset|voice)\s*[:=]\s*([^\]]+)\]\s*([\s\S]*)$/i);
  if (tagged) {
    presetRaw = String(tagged[1] || "").trim();
    text = String(tagged[2] || "").trim();
  } else {
    const piped = raw.match(/^(?:preset|voice)\s*[:=]\s*([a-z0-9 _-]+)\s*\|\s*([\s\S]+)$/i);
    if (piped) {
      presetRaw = String(piped[1] || "").trim();
      text = String(piped[2] || "").trim();
    }
  }

  if (!text) {
    return {
      ok: false,
      error: `Usage: /tts <text>\nOptional: /tts [preset:<name>] <text>\nPresets: ${formatTtsPresetChoicesInline()}`,
    };
  }

  let preset = "";
  if (presetRaw) {
    const normalized = normalizeTtsPresetName(presetRaw, { allowDefault: true });
    if (!normalized) {
      return {
        ok: false,
        error: `Unknown preset: ${presetRaw}\nAvailable: ${formatTtsPresetChoicesInline()}`,
      };
    }
    if (normalized === "custom" && !TTS_POSTPROCESS_FFMPEG_AF) {
      return {
        ok: false,
        error: "Preset 'custom' is unavailable because TTS_POSTPROCESS_FFMPEG_AF is not set.",
      };
    }
    preset = normalized === "default" ? "" : normalized;
  }

  return { ok: true, text, preset };
}

function parseTtsAbTestCommandInput(argText) {
  const raw = String(argText || "").trim();
  const lower = raw.toLowerCase();
  if (["help", "-h", "--help", "?"].includes(lower)) {
    return {
      ok: false,
      error: "Usage: /abtest [text]\nRuns the same one-line sample across all available voice presets.",
    };
  }

  const sample = normalizeTtsText(raw || TTS_ABTEST_DEFAULT_SAMPLE);
  if (!sample) {
    return {
      ok: false,
      error: "Usage: /abtest [text]\nRuns the same one-line sample across all available voice presets.",
    };
  }

  const split = splitSpeakableTextIntoVoiceChunks(sample);
  const chunks = Array.isArray(split?.chunks) ? split.chunks.filter(Boolean) : [];
  const overflowText = String(split?.overflowText || "").trim();
  if (chunks.length + (overflowText ? 1 : 0) > 1) {
    return {
      ok: false,
      error: "Please keep /abtest text short enough for one voice note so every preset reads the exact same line.",
    };
  }

  const text = String(chunks[0] || sample).trim();
  if (!text) {
    return {
      ok: false,
      error: "Usage: /abtest [text]\nRuns the same one-line sample across all available voice presets.",
    };
  }
  return { ok: true, text };
}

function resolveVoicePresetCommandAction(rawArg) {
  const raw = String(rawArg || "").trim();
  const arg = raw.toLowerCase();
  const normalizedMode = normalizeTtsVoiceMode(raw, { allowDefault: true });

  if (!raw || ["list", "ls", "show", "status"].includes(arg)) {
    return { action: "status" };
  }
  if (normalizedMode === TTS_VOICE_MODE_SINGLE) {
    return { action: "mode-single" };
  }
  if (normalizedMode === TTS_VOICE_MODE_WORKER) {
    return { action: "mode-worker" };
  }
  const modeArg = raw.match(/^mode\s*[:=]?\s*(.+)$/i);
  if (modeArg) {
    const parsedMode = normalizeTtsVoiceMode(modeArg[1], { allowDefault: true });
    if (parsedMode === TTS_VOICE_MODE_SINGLE) return { action: "mode-single" };
    if (parsedMode === TTS_VOICE_MODE_WORKER) return { action: "mode-worker" };
    return { action: "error", text: "Unknown voice mode. Use 'single' or 'worker'." };
  }
  if (["default", "reset", "clear", "auto", "bot"].includes(arg)) {
    return { action: "reset" };
  }

  const normalized = normalizeTtsPresetName(raw, { allowDefault: true });
  if (!normalized) {
    return {
      action: "error",
      text: `Unknown preset: ${raw}\nAvailable: ${formatTtsPresetChoicesInline()}`,
    };
  }
  if (normalized === "custom" && !TTS_POSTPROCESS_FFMPEG_AF) {
    return {
      action: "error",
      text: "Preset 'custom' is unavailable because TTS_POSTPROCESS_FFMPEG_AF is not set.",
    };
  }
  if (normalized === "default") {
    return { action: "reset" };
  }
  return { action: "set", preset: normalized };
}

async function handleVoicePresetCommand(chatId, rawArg) {
  const decision = resolveVoicePresetCommandAction(rawArg);
  if (decision.action === "status") {
    await sendVoicePresetPicker(chatId);
    return true;
  }
  if (decision.action === "error") {
    await sendMessage(chatId, decision.text || "Invalid voice preset.");
    return true;
  }
  if (decision.action === "reset") {
    setChatPrefs(chatId, { ttsPreset: "", ttsMode: TTS_VOICE_MODE_WORKER });
    const activeWorkerId = getActiveWorkerForChat(chatId);
    await sendMessage(chatId, `Voice mode set to worker voices. Effective preset: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}.`);
    return true;
  }
  if (decision.action === "mode-single") {
    setChatPrefs(chatId, { ttsMode: TTS_VOICE_MODE_SINGLE });
    const activeWorkerId = getActiveWorkerForChat(chatId);
    await sendMessage(chatId, `Voice mode set to single voice. Effective preset: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}.`);
    return true;
  }
  if (decision.action === "mode-worker") {
    setChatPrefs(chatId, { ttsMode: TTS_VOICE_MODE_WORKER });
    const activeWorkerId = getActiveWorkerForChat(chatId);
    await sendMessage(chatId, `Voice mode set to worker voices. Effective preset: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}.`);
    return true;
  }
  setChatPrefs(chatId, { ttsPreset: decision.preset, ttsMode: TTS_VOICE_MODE_SINGLE });
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const effective = resolveTtsPresetForChat(chatId, "", activeWorkerId);
  await sendMessage(chatId, `Voice preset set to ${effective}. Use /tts [preset:<name>] <text> for one-off comparisons.`);
  return true;
}

async function handleTtsAbTestCommand(chatId, rawArg) {
  if (!TTS_ENABLED) {
    await sendMessage(chatId, "TTS is disabled on this bot (TTS_ENABLED=0).");
    return true;
  }

  const parsed = parseTtsAbTestCommandInput(rawArg);
  if (!parsed.ok) {
    await sendMessage(chatId, parsed.error || "Usage: /abtest [text]");
    return true;
  }

  const sample = String(parsed.text || "").trim();
  const presets = getAvailableTtsPresetNames();
  if (presets.length === 0) {
    await sendMessage(chatId, "No TTS presets are currently available.");
    return true;
  }

  if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() + presets.length > MAX_QUEUE_SIZE) {
    await sendMessage(
      chatId,
      `Queue is too full for /abtest (${presets.length} jobs needed, max queued=${MAX_QUEUE_SIZE}). Use /queue or /clear, then retry.`,
    );
    return true;
  }

  await sendMessage(
    chatId,
    `A/B test queued: ${presets.length} presets.\nOrder: ${presets.join(", ")}\nSample: "${sample}"`,
  );

  let queued = 0;
  for (let i = 0; i < presets.length; i += 1) {
    const preset = presets[i];
    const ok = await enqueueTts(chatId, sample, "tts-abtest", {
      ttsPreset: preset,
      skipResultText: true,
      voiceCaption: `A/B ${i + 1}/${presets.length}: ${preset}`,
    });
    if (!ok) break;
    queued += 1;
  }

  if (queued > 0 && queued < presets.length) {
    await sendMessage(chatId, `Queued ${queued}/${presets.length} samples before the queue filled.`);
  }

  if (queued === 0) {
    await sendMessage(chatId, "Could not queue A/B samples.");
  }

  return true;
}

function formatClockTimeForTts(hoursRaw, minutesRaw) {
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return `${hoursRaw}:${minutesRaw}`;

  if (hours === 0 && minutes === 0) return "midnight";
  if (hours === 12 && minutes === 0) return "noon";

  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const period = hours < 12 ? "a m" : "p m";
  if (minutes === 0) return `${hour12} o'clock ${period}`;
  if (minutes < 10) return `${hour12} oh ${minutes} ${period}`;
  return `${hour12} ${minutes} ${period}`;
}

const TTS_CARDINAL_UNDER_20 = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TTS_CARDINAL_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const TTS_CARDINAL_SCALES = [
  { value: 1000000000000000, word: "quadrillion" },
  { value: 1000000000000, word: "trillion" },
  { value: 1000000000, word: "billion" },
  { value: 1000000, word: "million" },
  { value: 1000, word: "thousand" },
];

const TTS_ORDINAL_SPECIALS = new Map([
  ["zero", "zeroth"],
  ["one", "first"],
  ["two", "second"],
  ["three", "third"],
  ["four", "fourth"],
  ["five", "fifth"],
  ["six", "sixth"],
  ["seven", "seventh"],
  ["eight", "eighth"],
  ["nine", "ninth"],
  ["ten", "tenth"],
  ["eleven", "eleventh"],
  ["twelve", "twelfth"],
  ["thirteen", "thirteenth"],
  ["fourteen", "fourteenth"],
  ["fifteen", "fifteenth"],
  ["sixteen", "sixteenth"],
  ["seventeen", "seventeenth"],
  ["eighteen", "eighteenth"],
  ["nineteen", "nineteenth"],
  ["twenty", "twentieth"],
  ["thirty", "thirtieth"],
  ["forty", "fortieth"],
  ["fifty", "fiftieth"],
  ["sixty", "sixtieth"],
  ["seventy", "seventieth"],
  ["eighty", "eightieth"],
  ["ninety", "ninetieth"],
  ["hundred", "hundredth"],
  ["thousand", "thousandth"],
  ["million", "millionth"],
  ["billion", "billionth"],
  ["trillion", "trillionth"],
  ["quadrillion", "quadrillionth"],
]);

function cardinalUnderThousandToWords(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1000) return "";
  if (n < 20) return TTS_CARDINAL_UNDER_20[n];

  const parts = [];
  const hundreds = Math.trunc(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${TTS_CARDINAL_UNDER_20[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) {
      parts.push(TTS_CARDINAL_UNDER_20[rest]);
    } else {
      const tens = Math.trunc(rest / 10);
      const ones = rest % 10;
      parts.push(ones > 0 ? `${TTS_CARDINAL_TENS[tens]}-${TTS_CARDINAL_UNDER_20[ones]}` : TTS_CARDINAL_TENS[tens]);
    }
  }
  return parts.join(" ");
}

function integerToCardinalWords(value) {
  if (!Number.isSafeInteger(value)) return "";
  if (value === 0) return "zero";

  const abs = Math.abs(value);
  let remainder = abs;
  const parts = [];

  for (const scale of TTS_CARDINAL_SCALES) {
    if (remainder < scale.value) continue;
    const chunk = Math.trunc(remainder / scale.value);
    remainder %= scale.value;
    const chunkWords = cardinalUnderThousandToWords(chunk);
    if (!chunkWords) return "";
    parts.push(`${chunkWords} ${scale.word}`);
  }

  if (remainder > 0) {
    const tail = cardinalUnderThousandToWords(remainder);
    if (!tail) return "";
    parts.push(tail);
  }

  const joined = parts.join(" ");
  return value < 0 ? `minus ${joined}` : joined;
}

function cardinalWordToOrdinalWord(word) {
  const raw = String(word || "").trim().toLowerCase();
  if (!raw) return raw;
  if (TTS_ORDINAL_SPECIALS.has(raw)) return TTS_ORDINAL_SPECIALS.get(raw);

  if (raw.includes("-")) {
    const parts = raw.split("-");
    if (parts.length > 1) {
      const head = parts.slice(0, -1).join("-");
      const tail = parts[parts.length - 1];
      const tailOrdinal = cardinalWordToOrdinalWord(tail);
      if (head && tailOrdinal) return `${head}-${tailOrdinal}`;
    }
  }

  if (raw.endsWith("y") && raw.length > 1) return `${raw.slice(0, -1)}ieth`;
  return `${raw}th`;
}

function integerToOrdinalWords(value) {
  if (!Number.isSafeInteger(value)) return "";
  const cardinal = integerToCardinalWords(value);
  if (!cardinal) return "";

  const sign = cardinal.startsWith("minus ") ? "minus " : "";
  const base = sign ? cardinal.slice("minus ".length) : cardinal;
  const words = base.split(" ").filter(Boolean);
  if (words.length === 0) return cardinal;

  words[words.length - 1] = cardinalWordToOrdinalWord(words[words.length - 1]);
  return `${sign}${words.join(" ")}`.trim();
}

function applyCommonTtsPronunciationFixes(text) {
  let out = String(text || "");
  if (!out) return "";
  out = out.normalize("NFKC");

  // Normalize apostrophe variants (including escaped forms) before expansion.
  out = out.replace(/\\+([`´‘’‚‛ʼʻʹʽʾʿ′＇ꞌ'])/g, "$1");
  out = out.replace(/[`´‘’‚‛ʼʻʹʽʾʿ′＇ꞌ]/g, "'");

  // Expand common contractions for smoother TTS while preserving possessives.
  const contractionRules = [
    [/\b([A-Za-z]+)\s*'\s*m\b/gi, "$1 am"],
    [/\b([A-Za-z]+)\s*'\s*re\b/gi, "$1 are"],
    [/\b([A-Za-z]+)\s*'\s*ve\b/gi, "$1 have"],
    [/\b([A-Za-z]+)\s*'\s*ll\b/gi, "$1 will"],
    [/\b([A-Za-z]+)\s*'\s*d\b/gi, "$1 would"],
    [/\b([A-Za-z]+)\s*n\s*'\s*t\b/gi, "$1 not"],
    [/\b(?:it|he|she|that|there|here|what|who|where|when|how)\s*'\s*s\b/gi, (m) => m.replace(/\s*'\s*s$/i, " is")],
  ];
  for (const [pattern, replacement] of contractionRules) {
    out = out.replace(pattern, replacement);
  }

  const replaceDegreesUnit = (input, unitPattern, unitLabel) => {
    let result = String(input || "");
    result = result.replace(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*°\\s*${unitPattern}\\b`, "gi"), (_match, valueRaw) => {
      const value = Number(valueRaw);
      const singular = Number.isFinite(value) && Math.abs(value) === 1;
      return `${valueRaw} ${singular ? "degree" : "degrees"} ${unitLabel}`;
    });
    result = result.replace(new RegExp(`°\\s*${unitPattern}\\b`, "gi"), `degrees ${unitLabel}`);
    return result;
  };

  out = replaceDegreesUnit(out, "C", "Celsius");
  out = replaceDegreesUnit(out, "F", "Fahrenheit");
  out = replaceDegreesUnit(out, "K", "Kelvin");

  // Convert ordinals like 1st, 2nd, 11th, 103rd, 29,362nd to spoken words.
  out = out.replace(/(^|[^A-Za-z0-9])(-?\d{1,3}(?:,\d{3})*|-?\d+)(st|nd|rd|th)\b/gi, (match, prefix, numberRaw) => {
    const cleaned = String(numberRaw || "").replace(/,/g, "");
    if (!/^-?\d+$/.test(cleaned)) return match;
    const value = Number(cleaned);
    if (!Number.isSafeInteger(value)) return match;
    const spoken = integerToOrdinalWords(value);
    if (!spoken) return match;
    return `${prefix}${spoken}`;
  });

  // Convert plain clock tokens (e.g. 06:00) while avoiding ISO stamps and UTC offsets.
  out = out.replace(/(^|[^A-Za-z0-9+-])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g, (_match, prefix, hhRaw, mmRaw) => {
    const spoken = formatClockTimeForTts(hhRaw, mmRaw);
    return `${prefix}${spoken}`;
  });

  return out;
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
    const m = /^\s*(ATTACH(?:_FILE|_IMAGE)?)\s*:\s*(.+?)\s*$/i.exec(String(line || ""));
    if (!m) {
      kept.push(line);
      continue;
    }
    const directive = String(m[1] || "ATTACH").toUpperCase();
    const rest = String(m[2] || "").trim();
    if (!rest) continue;
    const parts = rest.split("|");
    const p = _stripOptionalQuotes(String(parts[0] || "").trim());
    const caption = parts.length > 1 ? parts.slice(1).join("|").trim() : "";
    if (!p) continue;
    const forceMode = directive === "ATTACH_FILE"
      ? "document"
      : directive === "ATTACH_IMAGE"
        ? "photo"
        : "";
    attachments.push({ path: p, caption, forceMode });
  }

  return { text: kept.join("\n").trim(), attachments };
}

function isPhotoAttachmentPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return ext === ".png"
    || ext === ".jpg"
    || ext === ".jpeg"
    || ext === ".webp"
    || ext === ".gif"
    || ext === ".bmp";
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
    const forceMode = String(item?.forceMode || "").trim().toLowerCase();
    try {
      const preferPhoto = forceMode === "photo" || (forceMode !== "document" && isPhotoAttachmentPath(fileName));
      const msg = preferPhoto
        ? await sendPhoto(chatId, resolved, {
          caption,
          timeoutMs: ATTACH_UPLOAD_TIMEOUT_MS,
          replyToMessageId,
          routeWorkerId,
          routeTaskId,
          routeSessionId,
        })
        : await sendDocument(chatId, resolved, {
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

function makeWorldMonitorTextTtsFriendly(text) {
  let out = String(text || "").trim();
  if (!out) return "";

  // Make section markers read naturally.
  out = out.replace(/\bALERT_LEVEL\s*:\s*/gi, "Alert level ");
  out = out.replace(/\bSUMMARY\s*:\s*/gi, "Summary ");
  out = out.replace(/\bPRIMARY_TRIGGERS\s*:\s*/gi, "Primary triggers ");
  out = out.replace(/\bEVIDENCE_CHAIN\s*:\s*/gi, "Evidence chain ");
  out = out.replace(/\bEVIDENCE\s*:\s*/gi, "Evidence ");
  out = out.replace(/\bIMPLICATIONS\s*:\s*/gi, "Implications ");
  out = out.replace(/\bWATCHLIST\s*:\s*/gi, "Watch list ");

  // Expand common abbreviations for clearer speech.
  out = out.replace(/\bUS\b/g, "United States");
  out = out.replace(/\bUK\b/g, "United Kingdom");
  out = out.replace(/\bEU\b/g, "European Union");
  out = out.replace(/\bUN\b/g, "United Nations");
  out = out.replace(/\bUAE\b/g, "United Arab Emirates");
  out = out.replace(/\bPRC\b/g, "China");
  out = out.replace(/\bDPRK\b/g, "North Korea");

  // Replace compact country-score tokens like "UA:59" or "UA 59".
  out = out.replace(/\b([A-Z]{2})\s*:\s*(\d{1,3})(?!\d)/g, (m, code, scoreRaw) => {
    const score = Number(scoreRaw);
    if (!Number.isFinite(score) || score < 0 || score > 100) return m;
    const name = resolveWorldMonitorRegionName(code);
    const c = String(code || "").trim().toUpperCase();
    if (!name || String(name).trim().toUpperCase() === c) return m;
    return `${name} score ${scoreRaw}`;
  });
  out = out.replace(/\b([A-Z]{2})\s+(\d{1,3})(?!\d)/g, (m, code, scoreRaw) => {
    const score = Number(scoreRaw);
    if (!Number.isFinite(score) || score < 0 || score > 100) return m;
    const name = resolveWorldMonitorRegionName(code);
    const c = String(code || "").trim().toUpperCase();
    if (!name || String(name).trim().toUpperCase() === c) return m;
    return `${name} score ${scoreRaw}`;
  });

  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function makeWorldMonitorCheckVoiceSummary(text) {
  const src = String(text || "").trim();
  if (!src) return "";

  const cleanBullet = (line) => oneLine(String(line || "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/[*_`]/g, "")
    .trim());
  const lines = src
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sectionFirstBullet = (sectionName) => {
    let inSection = false;
    for (const line of lines) {
      if (/^[A-Z_ ]+:\s*$/i.test(line)) {
        inSection = new RegExp(`^${sectionName}\\s*:\\s*$`, "i").test(line);
        continue;
      }
      if (!inSection) continue;
      if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
        const cleaned = cleanBullet(line);
        if (cleaned) return cleaned;
      }
    }
    return "";
  };

  const headline = sectionFirstBullet("HEADLINE");
  const global = sectionFirstBullet("GLOBAL");
  const taiwan = sectionFirstBullet("TAIWAN");
  const watch = sectionFirstBullet("WATCH_24H");
  const confidenceMatch = src.match(/\bCONFIDENCE\s*:\s*(low|medium|high)\b/i);
  const confidence = confidenceMatch ? String(confidenceMatch[1] || "").toLowerCase() : "";

  const parts = [];
  if (headline) parts.push(headline);
  if (global) parts.push(`Global: ${global}.`);
  if (taiwan) parts.push(`Taiwan: ${taiwan}.`);
  if (watch) parts.push(`Watch next 24 hours: ${watch}.`);
  if (confidence) parts.push(`Confidence ${confidence}.`);

  let summary = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!summary) {
    summary = oneLine(src.replace(/[*_`]/g, "")).replace(/\s+/g, " ").trim();
  }
  return summary;
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

  const mergeOrderedListMarkers = (segments) => {
    const inSegs = Array.isArray(segments) ? segments : [];
    if (inSegs.length === 0) return [];
    const out = [];
    for (const raw of inSegs) {
      const part = String(raw || "").trim();
      if (!part) continue;
      const isStandaloneMarker = /^\d{1,3}[.)]$/.test(part);
      if (isStandaloneMarker && out.length > 0) {
        // Keep ordered list markers (e.g., "1.") attached to the next text chunk.
        out.push(`${part} `);
        continue;
      }
      if (out.length > 0 && /\d{1,3}[.)]\s*$/.test(out[out.length - 1])) {
        out[out.length - 1] = `${out[out.length - 1]}${part}`.trim();
      } else {
        out.push(part);
      }
    }
    return out;
  };

  // Prefer Intl.Segmenter when available (better multilingual handling).
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const out = [];
      for (const item of seg.segment(src)) {
        const part = String(item?.segment || "").trim();
        if (part) out.push(part);
      }
      if (out.length > 0) return mergeOrderedListMarkers(out);
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
  const merged = mergeOrderedListMarkers(out);
  if (merged.length > 0) return merged;
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

async function enqueueTts(chatId, inputText, source, options = {}) {
  return await orchLaneRuntime.enqueueTts(chatId, inputText, source, options);
}

async function enqueueTtsBatch(chatId, inputTexts, source, options = {}) {
  return await orchLaneRuntime.enqueueTtsBatch(chatId, inputTexts, source, options);
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
  const hasKeepaliveSynth = fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH);

  if (!TTS_ENABLED) {
    return { ok: false, error: "TTS is disabled on this bot (TTS_ENABLED=0)." };
  }
  if (!hasKeepaliveSynth) {
    return {
      ok: false,
      error: `TTS keepalive script missing: ${AIDOLON_TTS_SERVER_SCRIPT_PATH}`,
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
    pyBin,
    ffmpegBin,
  };
}

const HAN_SCRIPT_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

function containsHanScript(text) {
  const value = String(text || "");
  if (!value) return false;
  return HAN_SCRIPT_CHAR_RE.test(value);
}

function resolveTtsReferenceAudioForText(text) {
  const twRef = String(TTS_REFERENCE_AUDIO_ZH_TW || "").trim();
  if (!twRef) return TTS_REFERENCE_AUDIO;
  if (!containsHanScript(text)) return TTS_REFERENCE_AUDIO;
  if (!fs.existsSync(twRef)) return TTS_REFERENCE_AUDIO;
  return twRef;
}

const _ffmpegAudioFilterCache = new Map(); // key: ffmpeg bin path -> Set<string> | null
// Some filters are audio-usable but reported as generic/dynamic I/O (for example N->N or |->N).
const FFMPEG_AUDIO_COMPAT_FILTER_NAMES = new Set([
  "amovie",
  "concat",
]);

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
    // We mainly need audio-capable filters for -af post-processing, plus a short allow-list
    // of generic filters used in starship-comms -filter_complex graphing.
    if (!io.includes("->")) continue; // skip header legend lines like "T.. = Timeline support"
    if (io.includes("A") || FFMPEG_AUDIO_COMPAT_FILTER_NAMES.has(name)) set.add(name);
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

function escapeFfmpegFilterPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildStarshipCommsComplexSpec(audioFilters) {
  const requiredFilters = [
    "amovie",
    "anoisesrc",
    "concat",
    "amix",
    "afade",
    "atrim",
    "adelay",
    "aresample",
    "highpass",
    "lowpass",
    "acompressor",
    "volume",
  ];
  if (!requiredFilters.every((name) => audioFilters.has(name))) return null;

  if (!TTS_STARSHIP_BEEP_START || !fs.existsSync(TTS_STARSHIP_BEEP_START)) {
    if (TTS_POSTPROCESS_DEBUG) {
      log(`TTS postprocess (starship-comms): missing start beep WAV at ${TTS_STARSHIP_BEEP_START || "(unset)"}.`);
    }
    return null;
  }
  if (!TTS_STARSHIP_BEEP_END || !fs.existsSync(TTS_STARSHIP_BEEP_END)) {
    if (TTS_POSTPROCESS_DEBUG) {
      log(`TTS postprocess (starship-comms): missing end beep WAV at ${TTS_STARSHIP_BEEP_END || "(unset)"}.`);
    }
    return null;
  }

  const startBeepPath = escapeFfmpegFilterPath(TTS_STARSHIP_BEEP_START);
  const endBeepPath = escapeFfmpegFilterPath(TTS_STARSHIP_BEEP_END);

  const radioChain = [
    "highpass=f=260",
    "lowpass=f=3300",
    "acompressor=threshold=-30dB:ratio=5.4:attack=1.5:release=92:makeup=7.4",
  ];
  if (audioFilters.has("acrusher")) radioChain.push("acrusher=bits=8:mode=log:mix=0.28");

  const graphParts = [
    "[0:a]aresample=48000[voice_src]",
    `[voice_src]${radioChain.join(",")}[radio]`,
    `amovie='${startBeepPath}':loop=0,aresample=48000,atrim=0:0.18,afade=t=in:st=0:d=0.008,afade=t=out:st=0.13:d=0.05,volume=0.26[beep_start]`,
    `amovie='${endBeepPath}':loop=0,aresample=48000,atrim=0:0.2,afade=t=in:st=0:d=0.008,afade=t=out:st=0.145:d=0.055,volume=0.26[beep_end]`,
    "anoisesrc=color=white:amplitude=0.055:r=48000:d=1.2,highpass=f=1400,lowpass=f=5200,atrim=0:0.055,afade=t=in:st=0:d=0.005,afade=t=out:st=0.042:d=0.013,adelay=340|340[burst1]",
    "anoisesrc=color=white:amplitude=0.052:r=48000:d=1.8,highpass=f=1500,lowpass=f=5300,atrim=0:0.06,afade=t=in:st=0:d=0.006,afade=t=out:st=0.045:d=0.015,adelay=1040|1040[burst2]",
    "anoisesrc=color=white:amplitude=0.058:r=48000:d=2.8,highpass=f=1350,lowpass=f=5000,atrim=0:0.07,afade=t=in:st=0:d=0.008,afade=t=out:st=0.053:d=0.017,adelay=1920|1920[burst3]",
    "[radio][burst1][burst2][burst3]amix=inputs=4:normalize=0[radio_dirty]",
    "[beep_start][radio_dirty][beep_end]concat=n=3:v=0:a=1[comms]",
  ];

  let outputLabel = "comms";
  if (audioFilters.has("asoftclip")) {
    graphParts.push(`[${outputLabel}]asoftclip=type=tanh:threshold=0.76[comms_clip]`);
    outputLabel = "comms_clip";
  }
  if (audioFilters.has("alimiter")) {
    graphParts.push(`[${outputLabel}]alimiter=limit=0.86[comms_limited]`);
    outputLabel = "comms_limited";
  }

  const outputGain = getTtsPresetOutputGain("starship-comms");
  if (audioFilters.has("volume") && Math.abs(outputGain - 1) > 1e-4) {
    graphParts.push(`[${outputLabel}]volume=${fmtFloat(outputGain, 4)}[comms_gain]`);
    outputLabel = "comms_gain";
  }

  return { graph: graphParts.join(";"), outputLabel };
}

function buildTtsPresetFiltergraph(preset, audioFilters) {
  const key = normalizeTtsPresetName(preset);
  if (!key || key === "off") return "";
  if (key === "custom") return TTS_POSTPROCESS_FFMPEG_AF || "";

  const parts = [];
  const add = (filterName, expr) => {
    if (audioFilters.has(filterName)) parts.push(expr);
  };
  const addPitchShift = (semitones, presetName) => {
    const semitonesNum = Number(semitones);
    if (!Number.isFinite(semitonesNum) || semitonesNum === 0) return;
    if (audioFilters.has("rubberband")) {
      const pitchRatio = Math.pow(2, semitonesNum / 12);
      parts.push(`rubberband=pitch=${fmtFloat(pitchRatio, 8)}`);
      return;
    }
    if (TTS_POSTPROCESS_DEBUG) {
      log(`TTS postprocess (${presetName || "preset"}): ffmpeg filter 'rubberband' not available; skipping pitch shift.`);
    }
  };
  const addPresetOutputGain = (presetName = key) => {
    const gain = getTtsPresetOutputGain(presetName);
    if (Math.abs(gain - 1) <= 1e-4) return;
    add("volume", `volume=${fmtFloat(gain, 4)}`);
  };

  if (key === "hologram-ai") {
    add("aresample", "aresample=48000");
    add("highpass", "highpass=f=140");
    add("lowpass", "lowpass=f=7800");
    addPitchShift(2.1, "hologram-ai");
    add("aphaser", "aphaser=speed=1.9:decay=0.42:delay=2.2");
    add("chorus", "chorus=0.35:0.75:28|42:0.2|0.16:0.35|0.27:1.4|2.1");
    add("aecho", "aecho=0.72:0.4:26|52:0.24|0.12");
    add("acompressor", "acompressor=threshold=-27dB:ratio=3.3:attack=4:release=150:makeup=7.4");
    add("volume", "volume=1.72");
    addPresetOutputGain("hologram-ai");
    add("alimiter", "alimiter=limit=0.94");
    return parts.join(",");
  }

  if (key === "starship-comms") {
    if (TTS_POSTPROCESS_DEBUG) {
      log("TTS postprocess (starship-comms): complex beep pipeline unavailable; using fallback chain.");
    }
    add("aresample", "aresample=48000");
    add("highpass", "highpass=f=260");
    add("lowpass", "lowpass=f=3300");
    add("acompressor", "acompressor=threshold=-30dB:ratio=5.2:attack=1.5:release=90:makeup=6.8");
    add("acrusher", "acrusher=bits=8:mode=log:mix=0.25");
    add("tremolo", "tremolo=f=8.5:d=0.045");
    add("asoftclip", "asoftclip=type=tanh:threshold=0.78");
    addPresetOutputGain("starship-comms");
    add("alimiter", "alimiter=limit=0.85");
    return parts.join(",");
  }

  if (key === "cyber-oracle") {
    add("aresample", "aresample=48000");
    add("highpass", "highpass=f=100");
    add("lowpass", "lowpass=f=7000");
    addPitchShift(-3.2, "cyber-oracle");
    // ffmpeg lacks stable random pitch drift in this chain; use slow LFO wobble instead.
    add("vibrato", "vibrato=f=1.05:d=0.09");
    add("aphaser", "aphaser=speed=0.34:decay=0.6:delay=3.1");
    add("chorus", "chorus=0.36:0.7:34|50|66:0.22|0.17|0.1:0.24|0.36|0.5:1.7|2.4|3.1");
    add("aecho", "aecho=0.6:0.38:78|166:0.22|0.13");
    add("acompressor", "acompressor=threshold=-27dB:ratio=3.1:attack=7:release=220:makeup=5.9");
    add("volume", "volume=1.38");
    addPresetOutputGain("cyber-oracle");
    add("alimiter", "alimiter=limit=0.93");
    return parts.join(",");
  }

  if (key === "alien-terminal") {
    add("aresample", "aresample=48000");
    add("highpass", "highpass=f=170");
    add("lowpass", "lowpass=f=5100");
    addPitchShift(-2.1, "alien-terminal");
    add("acrusher", "acrusher=bits=7:mode=log:mix=0.34");
    add("vibrato", "vibrato=f=5.4:d=0.055");
    add("aphaser", "aphaser=speed=0.62:decay=0.54:delay=2.4");
    add("chorus", "chorus=0.33:0.72:22|38:0.18|0.13:0.22|0.33:1.15|1.75");
    add("acompressor", "acompressor=threshold=-28dB:ratio=3.9:attack=3:release=155:makeup=4.2");
    add("asoftclip", "asoftclip=type=tanh:threshold=0.72");
    add("volume", "volume=0.98");
    addPresetOutputGain("alien-terminal");
    add("alimiter", "alimiter=limit=0.88");
    return parts.join(",");
  }

  if (key === "anonymous") {
    // Legacy Audacity-like stack kept as an explicit preset for A/B tests.
    add("aresample", "aresample=48000");
    const distortionAmount = 60;
    const outputLevel = 30;
    const pregain = 1 + (distortionAmount / 100) * 3.0;
    const threshold = 1 - (distortionAmount / 100) * 0.5;
    const outVol = outputLevel / 100;
    add("volume", `volume=${fmtFloat(pregain, 4)}`);
    add("asoftclip", `asoftclip=type=tanh:threshold=${fmtFloat(clamp01(threshold), 4)}`);
    add("volume", `volume=${fmtFloat(clamp01(outVol), 4)}`);
    add("aphaser", `aphaser=speed=${fmtFloat(2.0, 3)}:decay=${fmtFloat(0.2, 3)}:delay=${fmtFloat(3.0, 3)}`);
    add("atempo", `atempo=${fmtFloat(1 / 1.1, 6)}`);
    const pitchRatio = Math.pow(2, -5.69 / 12);
    if (audioFilters.has("rubberband")) {
      parts.push(`rubberband=pitch=${fmtFloat(pitchRatio, 8)}`);
    } else if (TTS_POSTPROCESS_DEBUG) {
      log("TTS postprocess: ffmpeg filter 'rubberband' not available; skipping pitch shift.");
    }
    add("atempo", `atempo=${fmtFloat(1.1, 6)}`);
    addPresetOutputGain("anonymous");
    add("alimiter", "alimiter=limit=0.92");
    return parts.join(",");
  }

  return "";
}

function buildTtsPostprocessConfig(ffmpegBin, presetName = "") {
  let preset = normalizeTtsPresetName(presetName, { allowDefault: true });
  if (!preset || preset === "default") preset = getDefaultTtsPresetName();
  if (!preset || preset === "off") {
    if (TTS_POSTPROCESS_DEBUG) log("TTS postprocess disabled (preset=off).");
    return { mode: "none", graph: "", mapLabel: "" };
  }
  if (preset === "custom" && !TTS_POSTPROCESS_FFMPEG_AF) {
    if (TTS_POSTPROCESS_DEBUG) log("TTS postprocess preset 'custom' requested but no raw filtergraph is configured.");
    return { mode: "none", graph: "", mapLabel: "" };
  }

  const audioFilters = getFfmpegAudioFilterSet(ffmpegBin) || new Set();
  if (preset === "starship-comms") {
    const complexSpec = buildStarshipCommsComplexSpec(audioFilters);
    if (complexSpec && complexSpec.graph) {
      if (TTS_POSTPROCESS_DEBUG) log(`TTS postprocess preset=${preset} -filter_complex: ${complexSpec.graph}`);
      return { mode: "complex", graph: complexSpec.graph, mapLabel: complexSpec.outputLabel || "" };
    }
  }

  const graph = buildTtsPresetFiltergraph(preset, audioFilters);
  if (TTS_POSTPROCESS_DEBUG) log(`TTS postprocess preset=${preset} -af: ${graph || "(none)"}`);
  if (!graph) return { mode: "none", graph: "", mapLabel: "" };
  return { mode: "af", graph, mapLabel: "" };
}

function buildTtsPostprocessFfmpegArgs(config) {
  const mode = String(config?.mode || "none");
  const graph = String(config?.graph || "").trim();
  if (!graph) return [];
  if (mode === "complex") {
    const mapLabel = String(config?.mapLabel || "").trim();
    const mapTarget = mapLabel ? `[${mapLabel}]` : "0:a";
    return ["-filter_complex", graph, "-map", mapTarget];
  }
  if (mode === "af") {
    return ["-af", graph];
  }
  return [];
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

function noteTtsKeepaliveError(errLike) {
  const msg = oneLine(String(errLike || "").trim());
  ttsKeepalive.errorCount = Math.max(0, Number(ttsKeepalive.errorCount || 0)) + 1;
  ttsKeepalive.lastErrorAt = Date.now();
  ttsKeepalive.lastError = msg;
}

function noteTtsKeepaliveFallback(mode, reason) {
  if (String(mode || "").toLowerCase() === "batch") {
    ttsKeepalive.fallbackBatchCount = Math.max(0, Number(ttsKeepalive.fallbackBatchCount || 0)) + 1;
  } else {
    ttsKeepalive.fallbackSingleCount = Math.max(0, Number(ttsKeepalive.fallbackSingleCount || 0)) + 1;
  }
  ttsKeepalive.lastFallbackAt = Date.now();
  ttsKeepalive.lastFallbackReason = oneLine(String(reason || "").trim());
}

function scheduleTtsKeepaliveRestart(reason = "") {
  if (!TTS_KEEPALIVE_AUTO_RESTART) return;
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
  ttsKeepalive.restartScheduledCount = Math.max(0, Number(ttsKeepalive.restartScheduledCount || 0)) + 1;
  ttsKeepalive.lastRestartAt = Date.now();
  ttsKeepalive.lastRestartDelayMs = delayMs;
  ttsKeepalive.lastRestartReason = why;
  log(`Scheduling TTS keepalive restart in ${delayMs}ms${why ? ` (${why})` : ""}.`);

  ttsKeepalive.restartTimer = setTimeout(async () => {
    ttsKeepalive.restartTimer = null;
    if (shuttingDown || !TTS_KEEPALIVE_AUTO_RESTART) return;
    if (ttsKeepalive.proc || ttsKeepalive.startPromise) return;
    try {
      const pyBin = resolveTtsPythonBin();
      const proc = await ensureTtsKeepaliveRunning(pyBin);
      if (!proc || !ttsKeepalive.ready) {
        scheduleTtsKeepaliveRestart("not ready");
      }
    } catch (err) {
      ttsKeepalive.restartFailureCount = Math.max(0, Number(ttsKeepalive.restartFailureCount || 0)) + 1;
      noteTtsKeepaliveError(err?.message || err);
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

function stopTtsKeepalive(reason = "", { allowAutoRestart = true, preserveStopReason = false } = {}) {
  const proc = ttsKeepalive.proc;
  ttsKeepalive.proc = null;
  ttsKeepalive.ready = false;
  ttsKeepalive.stdoutBuf = "";
  ttsKeepalive.stderrScanCarry = "";
  ttsKeepalive.stderrNoiseCarry = "";
  if (!allowAutoRestart) {
    clearTtsKeepaliveRestartTimer();
    ttsKeepalive.restartAttempts = 0;
  }
  const why = String(reason || "").trim();
  ttsKeepalive.stopCount = Math.max(0, Number(ttsKeepalive.stopCount || 0)) + 1;
  if (!preserveStopReason || !String(ttsKeepalive.lastStopReason || "").trim()) {
    ttsKeepalive.lastStopAt = Date.now();
    ttsKeepalive.lastStopReason = why;
  }
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
    ttsKeepalive.readyCount = Math.max(0, Number(ttsKeepalive.readyCount || 0)) + 1;
    ttsKeepalive.lastReadyAt = Date.now();
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
  ttsKeepalive.requestFailureCount = Math.max(0, Number(ttsKeepalive.requestFailureCount || 0)) + 1;
  noteTtsKeepaliveError(err);
  pending.reject(new Error(err));
}

async function ensureTtsKeepaliveRunning(pyBin) {
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
    ttsKeepalive.startCount = Math.max(0, Number(ttsKeepalive.startCount || 0)) + 1;
    ttsKeepalive.lastStartAt = Date.now();
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
    noteTtsKeepaliveError(err?.message || err);
    failTtsKeepaliveStart(new Error(`Failed to start TTS keepalive process: ${err?.message || err}`));
    scheduleTtsKeepaliveRestart("spawn failed");
    return await startupPromise;
  }

  ttsKeepalive.proc = proc;
  ttsKeepalive.ready = false;
  ttsKeepalive.stdoutBuf = "";
  ttsKeepalive.stderrTail = "";
  ttsKeepalive.stderrScanCarry = "";
  ttsKeepalive.stderrNoiseCarry = "";

  if (proc.stdin && typeof proc.stdin.on === "function") {
    proc.stdin.on("error", (err) => {
      if (ttsKeepalive.proc !== proc) return;
      const msg = `TTS keepalive stdin error: ${err?.message || err}`;
      noteTtsKeepaliveError(msg);
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
    const noise = stripTtsBackendNoise(chunk, ttsKeepalive.stderrNoiseCarry);
    ttsKeepalive.stderrNoiseCarry = noise.carry;
    const filteredChunk = noise.text;
    if (!filteredChunk) return;
    ttsKeepalive.stderrTail = appendTail(ttsKeepalive.stderrTail, filteredChunk, 50000);
    const fatal = detectTtsBackendFatalError(filteredChunk, ttsKeepalive.stderrScanCarry);
    ttsKeepalive.stderrScanCarry = fatal.carry;
    if (fatal.message) {
      const msg = `TTS keepalive backend fatal error: ${fatal.message}`;
      noteTtsKeepaliveError(msg);
      log(msg);
      // Keepalive server has its own in-process recovery for tokenizer failures.
      // Force-killing here causes restart thrash under load and defeats that recovery path.
      return;
    }
    if (TTS_STREAM_OUTPUT_TO_TERMINAL) process.stderr.write(filteredChunk);
  });

  proc.on("error", (err) => {
    const msg = `TTS keepalive process error: ${err?.message || err}`;
    noteTtsKeepaliveError(msg);
    if (ttsKeepalive.startReject) {
      failTtsKeepaliveStart(new Error(msg));
    }
    stopTtsKeepalive(msg, { preserveStopReason: true });
  });

  proc.on("close", (code, signal) => {
    const codeText = typeof code === "number" ? `exit ${code}` : "exit";
    const sigText = signal ? ` (${signal})` : "";
    const tail = oneLine(ttsKeepalive.stderrTail || "");
    const msg = `TTS keepalive closed (${codeText}${sigText})${tail ? `: ${tail}` : ""}`;
    ttsKeepalive.closeCount = Math.max(0, Number(ttsKeepalive.closeCount || 0)) + 1;
    ttsKeepalive.lastCloseAt = Date.now();
    ttsKeepalive.lastCloseReason = msg;
    if (Number(code) !== 0) noteTtsKeepaliveError(msg);
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
        ttsKeepalive.timeoutCount = Math.max(0, Number(ttsKeepalive.timeoutCount || 0)) + 1;
        stopTtsKeepalive(`TTS timed out after ${Math.round(ms / 1000)}s.`);
      }, ms);
    }

    ttsKeepalive.pending = pending;
    ttsKeepalive.requestCount = Math.max(0, Number(ttsKeepalive.requestCount || 0)) + 1;
    writeChildStdin(proc, line, (err) => {
      const msg = `Failed to write TTS keepalive request: ${err?.message || err}`;
      ttsKeepalive.requestFailureCount = Math.max(0, Number(ttsKeepalive.requestFailureCount || 0)) + 1;
      noteTtsKeepaliveError(msg);
      rejectTtsKeepalivePending(msg);
      if (ttsKeepalive.proc === proc) {
        stopTtsKeepalive(msg);
      }
    });
  });
}

async function runTtsSynthKeepaliveSingle({
  text,
  outWavPath,
  timeoutMs = 0,
  abortSignal,
  job,
  referenceAudioPath = "",
}) {
  const payload = {
    type: "synthesize",
    text,
    out_wav: outWavPath,
  };
  const ref = String(referenceAudioPath || "").trim();
  if (ref) payload.reference_audio = ref;
  const msg = await requestTtsKeepalive(
    payload,
    { abortSignal, timeoutMs, job },
  );
  if (msg.ok !== true) {
    throw new Error(String(msg.error || "TTS keepalive synthesis failed."));
  }
  return msg;
}

async function runTtsSynthKeepaliveBatch({
  texts,
  outWavBase,
  timeoutMs = 0,
  abortSignal,
  job,
  referenceAudioPath = "",
}) {
  const payload = {
    type: "synthesize_batch",
    texts,
    out_wav_base: outWavBase,
  };
  const ref = String(referenceAudioPath || "").trim();
  if (ref) payload.reference_audio = ref;
  const msg = await requestTtsKeepalive(
    payload,
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
  const shouldForceTtsKeepaliveRestart = (errMsg) => {
    const msg = String(errMsg || "").toLowerCase();
    if (!msg) return false;
    return /tts backend fatal error/.test(msg);
  };
  const forceTtsKeepaliveRestartIfFatal = (errMsg, reason) => {
    if (!shouldForceTtsKeepaliveRestart(errMsg)) return;
    stopTtsKeepalive(
      reason || "TTS backend fatal error during synthesis; forcing keepalive restart before next voice reply.",
    );
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
  const ffmpegBin = String(runtime.ffmpegBin || "").trim();

  if (!text) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }
  const referenceAudioPath = resolveTtsReferenceAudioForText(text);

  const maxStageAttempts = Math.max(1, 1 + Math.max(0, Number(TTS_TIMEOUT_RETRIES) || 0));
  const resetTimeoutState = () => {
    job.timedOut = false;
    job.timedOutMs = 0;
    job.timedOutStage = "";
  };

  let wavPath = "";
  let oggPath = "";
  let keepaliveFatalRetryUsedSingle = false;

  const runSynthOnce = async (outWavPath) => {
    const timeoutMs = minPositive([TTS_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
    try {
      await runTtsSynthKeepaliveSingle({
        text,
        outWavPath,
        timeoutMs,
        abortSignal,
        job,
        referenceAudioPath,
      });
      if (!fs.existsSync(outWavPath)) {
        return { ok: false, text: "TTS synthesis finished, but WAV output file is missing." };
      }
      return { ok: true };
    } catch (err) {
      let msg = String(err?.message || err || "").trim();
      if (job.cancelRequested || /tts canceled/i.test(msg)) {
        return { ok: false, text: "TTS canceled." };
      }
      if (/timed out/i.test(msg)) {
        job.timedOut = true;
        job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
        job.timedOutStage = "synth";
        return { ok: false, text: msg };
      }
      if (!keepaliveFatalRetryUsedSingle && shouldForceTtsKeepaliveRestart(msg)) {
        keepaliveFatalRetryUsedSingle = true;
        stopTtsKeepalive("TTS keepalive fatal synthesis error; restarting and retrying once.");
        await sleep(250);
        try {
          await runTtsSynthKeepaliveSingle({
            text,
            outWavPath,
            timeoutMs,
            abortSignal,
            job,
            referenceAudioPath,
          });
          if (!fs.existsSync(outWavPath)) {
            return { ok: false, text: "TTS synthesis finished, but WAV output file is missing." };
          }
          return { ok: true };
        } catch (retryErr) {
          msg = String(retryErr?.message || retryErr || "").trim();
          if (job.cancelRequested || /tts canceled/i.test(msg)) {
            return { ok: false, text: "TTS canceled." };
          }
          if (/timed out/i.test(msg)) {
            job.timedOut = true;
            job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
            job.timedOutStage = "synth";
            return { ok: false, text: msg };
          }
        }
      }
      return { ok: false, text: msg || "TTS keepalive synthesis failed." };
    }
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

    forceTtsKeepaliveRestartIfFatal(synthOk.text);
    return { ok: false, text: formatFailureText(synthOk.text), afterText, attachments };
  }

  if (!wavPath) {
    forceTtsKeepaliveRestartIfFatal(synthOk.text);
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

  const ttsFxConfig = buildTtsPostprocessConfig(ffmpegBin, job?.ttsPreset);
  const runEncodeOnce = async (inWavPath, outOggPath) => {
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inWavPath,
      ...buildTtsPostprocessFfmpegArgs(ttsFxConfig),
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
        caption: String(job?.voiceCaption || "").trim(),
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
    stopTtsKeepalive("TTS voice delivery failure; forcing keepalive restart before next voice reply.");
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
    ttsPreset: job.ttsPreset,
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
  const failedVoiceChunks = [];
  let firstFallbackError = "";
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

      if (
        /tts backend fatal error/i.test(
          String(chunkResult?.text || ""),
        )
      ) {
        stopTtsKeepalive("TTS batch chunk backend fatal error; forcing keepalive restart before next voice reply.");
      }
      fallbackCount += 1;
      const errText = oneLine(String(chunkResult?.text || "TTS chunk failed").trim());
      const cappedErr = errText.length > 200 ? `${errText.slice(0, 197)}...` : errText;
      log(
        `TTS batch chunk ${idx + 1}/${texts.length} failed in ${elapsedMs}ms; fallback to text${cappedErr ? ` (${cappedErr})` : ""}.`,
      );

      if (isVoiceReply) {
        failedVoiceChunks.push(chunkText);
        if (!firstFallbackError && cappedErr) firstFallbackError = cappedErr;
      } else {
        const prefix = `Voice chunk ${idx + 1}/${texts.length} failed`;
        const fallbackText = cappedErr
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
    }

    if (fallbackCount > 0) {
      log(`TTS batch completed with fallbacks: voice_sent=${sentCount}, text_fallbacks=${fallbackCount}, total=${texts.length}`);
    }
    if (isVoiceReply && failedVoiceChunks.length > 0) {
      const failedText = failedVoiceChunks.join(" ").trim();
      const suffix = firstFallbackError
        ? `\n\n(Voice reply failed for ${failedVoiceChunks.length} chunk(s): ${firstFallbackError})`
        : `\n\n(Voice reply failed for ${failedVoiceChunks.length} chunk(s).)`;
      const mergedFallbackText = `${failedText}${suffix}`;
      try {
        await sendMessage(job.chatId, mergedFallbackText, {
          replyToMessageId: job.replyToMessageId,
          routeWorkerId: job.workerId,
          routeTaskId: Number(job?.taskId || 0),
          routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
        });
      } catch (err) {
        log(`TTS merged fallback send failed: ${redactError(err?.message || err)}`);
      }
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
    job.ttsPreset = original.ttsPreset;
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
  const ffmpegBin = String(runtime.ffmpegBin || "").trim();

  if (texts.length === 0) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }
  const referenceAudioPath = resolveTtsReferenceAudioForText(fullText);

  const pad3 = (n) => String(n).padStart(3, "0");
  const maxStageAttempts = Math.max(1, 1 + Math.max(0, Number(TTS_TIMEOUT_RETRIES) || 0));
  const resetTimeoutState = () => {
    job.timedOut = false;
    job.timedOutMs = 0;
    job.timedOutStage = "";
  };

  let base = "";
  let wavBase = "";
  let wavPaths = [];
  let keepaliveFatalRetryUsedBatch = false;

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
    try {
      await runTtsSynthKeepaliveBatch({
        texts,
        outWavBase,
        timeoutMs,
        abortSignal,
        job,
        referenceAudioPath,
      });
      return { ok: true };
    } catch (err) {
      let msg = String(err?.message || err || "").trim();
      if (job.cancelRequested || /tts canceled/i.test(msg)) {
        return { ok: false, text: "TTS canceled." };
      }
      if (/timed out/i.test(msg)) {
        job.timedOut = true;
        job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
        job.timedOutStage = "synth";
        return { ok: false, text: msg };
      }
      if (!keepaliveFatalRetryUsedBatch && shouldForceTtsKeepaliveRestart(msg)) {
        keepaliveFatalRetryUsedBatch = true;
        stopTtsKeepalive("TTS keepalive fatal batch synthesis error; restarting and retrying once.");
        await sleep(250);
        try {
          await runTtsSynthKeepaliveBatch({
            texts,
            outWavBase,
            timeoutMs,
            abortSignal,
            job,
            referenceAudioPath,
          });
          return { ok: true };
        } catch (retryErr) {
          msg = String(retryErr?.message || retryErr || "").trim();
          if (job.cancelRequested || /tts canceled/i.test(msg)) {
            return { ok: false, text: "TTS canceled." };
          }
          if (/timed out/i.test(msg)) {
            job.timedOut = true;
            job.timedOutMs = timeoutMs || Number(job.timedOutMs || 0);
            job.timedOutStage = "synth";
            return { ok: false, text: msg };
          }
        }
      }
      return { ok: false, text: msg || "TTS keepalive synthesis failed." };
    }
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

  const ttsFxConfig = buildTtsPostprocessConfig(ffmpegBin, job?.ttsPreset);
  const runEncodeOnce = async (inWavPath, outOggPath) => {
    const ffArgs = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inWavPath,
      ...buildTtsPostprocessFfmpegArgs(ttsFxConfig),
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
      stopTtsKeepalive("TTS voice delivery failure; forcing keepalive restart before next voice reply.");
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
  const requestedCwd = String(spec?.cwd || "").trim();
  const safeCwd = resolveUsableWorkdir(requestedCwd);
  if (requestedCwd !== safeCwd) {
    log(`[run] worker cwd unavailable: ${requestedCwd || "(empty)"}; using ${safeCwd}.`);
  }
  spec.cwd = safeCwd;
 
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
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) writeWorkerStreamChunk(chunk, { workerId: job?.workerId, stream: "stdout" });
      if (typeof job.onProgressChunk === "function") job.onProgressChunk(chunk, "stdout");
    });

    child.stderr.on("data", (buf) => {
      const chunk = String(buf || "");
      job.stderrTail = appendTail(job.stderrTail, chunk);
      if (CODEX_STREAM_OUTPUT_TO_TERMINAL) writeWorkerStreamChunk(chunk, { workerId: job?.workerId, stream: "stderr" });
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
  return await orchLaneRuntime.processLane(laneId);
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
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
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
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
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

  if (TTS_ENABLED && TTS_PREWARM_ON_STARTUP) {
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
    rememberChatAutomationPrefsFromText(chatId, transcript);

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
    const pickerMessageId = Number(cb?.message?.message_id || 0) || 0;
    if (!entry) {
      await answerCallbackQuery(id, "Expired");
      return;
    }
    if (entry.kind === "model") {
      const nextModel = String(entry.value || "").trim();
      const prevPrefs = getChatPrefs(chatId);
      const keptReasoning = normalizeReasoningForModel(nextModel, prevPrefs.reasoning);
      const nextReasoning = keptReasoning || pickDefaultReasoningForModel(nextModel);
      setChatPrefs(chatId, {
        model: nextModel,
        reasoning: nextReasoning,
      });
      await answerCallbackQuery(id, "Model set");
      await refreshModelPickerMessage(chatId, pickerMessageId);
      return;
    }
    if (entry.kind === "reasoning") {
      const prefs = getChatPrefs(chatId);
      const activeModel = String(prefs.model || CODEX_MODEL || "").trim();
      const selectedReasoning = String(entry.value || "").trim().toLowerCase();
      const normalized = normalizeReasoningForModel(activeModel, selectedReasoning);
      if (!normalized) {
        await answerCallbackQuery(id, "Not supported for selected model");
        await refreshModelPickerMessage(chatId, pickerMessageId);
        return;
      }
      setChatPrefs(chatId, { reasoning: normalized });
      await answerCallbackQuery(id, "Reasoning set");
      await refreshModelPickerMessage(chatId, pickerMessageId);
      return;
    }
    if (entry.kind === "tts-preset") {
      const selected = normalizeTtsPresetName(entry.value, { allowDefault: true });
      if (!selected) {
        await answerCallbackQuery(id, "Invalid preset");
        await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
        return;
      }
      if (selected === "custom" && !TTS_POSTPROCESS_FFMPEG_AF) {
        await answerCallbackQuery(id, "Custom preset unavailable");
        await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
        return;
      }
      setChatPrefs(chatId, {
        ttsPreset: selected === "default" ? "" : selected,
        ttsMode: TTS_VOICE_MODE_SINGLE,
      });
      const activeWorkerId = getActiveWorkerForChat(chatId);
      await answerCallbackQuery(id, `Voice preset: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}`);
      await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
      return;
    }
    if (entry.kind === "tts-mode") {
      const selectedMode = normalizeTtsVoiceMode(entry.value, { allowDefault: true });
      if (!selectedMode || selectedMode === "default") {
        await answerCallbackQuery(id, "Invalid mode");
        await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
        return;
      }
      setChatPrefs(chatId, { ttsMode: selectedMode });
      const activeWorkerId = getActiveWorkerForChat(chatId);
      await answerCallbackQuery(id, `Mode: ${selectedMode}; voice: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}`);
      await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
      return;
    }
    if (entry.kind === "tts-preset-reset") {
      setChatPrefs(chatId, { ttsPreset: "" });
      const activeWorkerId = getActiveWorkerForChat(chatId);
      await answerCallbackQuery(id, `Voice preset: ${resolveTtsPresetForChat(chatId, "", activeWorkerId)}`);
      await refreshVoicePresetPickerMessage(chatId, pickerMessageId);
      return;
    }
    if (entry.kind === "reset") {
      setChatPrefs(chatId, { model: "", reasoning: "" });
      await answerCallbackQuery(id, "Reset");
      await refreshModelPickerMessage(chatId, pickerMessageId);
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

  if (msg.location && typeof msg.location === "object") {
    logChat("in", chatId, "[location-message]", { source: "location", user });
    const locationHandled = await handleWeatherLocationMessage(msg);
    if (locationHandled) return;
  }

  const text = String(msg.text || "").trim();
  if (!text) {
    logChat("in", chatId, "[non-text-message]", { source: "non-text", user });
    return;
  }

  logChat("in", chatId, text, { source: text.startsWith("/") ? "command" : "plain", user });
  rememberChatAutomationPrefsFromText(chatId, text);

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
    stopWorldMonitorMonitorLoop();
    stopWorldMonitorFeedAlertsLoop();
    stopWeatherDailyLoop();
  } catch {
    // best effort
  }

  flushChatLogBufferSync();
  persistState({ immediate: true });
  flushStatePersistence();
  if (lockHeld) {
    releaseProcessLock(LOCK_PATH);
    lockHeld = false;
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0, "signal:SIGINT"));
process.on("SIGTERM", () => void shutdown(0, "signal:SIGTERM"));
process.on("SIGHUP", () => {
  if (!BOT_EXIT_ON_SIGHUP) {
    log("signal:SIGHUP received; ignoring shutdown (BOT_EXIT_ON_SIGHUP=0).");
    return;
  }
  void shutdown(0, "signal:SIGHUP");
});
process.on("beforeExit", () => {
  flushChatLogBufferSync();
  flushStatePersistence();
});

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

    const me = await getTelegramIdentityWithRetry();
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
      const hasTtsServer = fs.existsSync(AIDOLON_TTS_SERVER_SCRIPT_PATH);
      const pyBin = resolveTtsPythonBin();
      if (!pyBin) {
        log("TTS is enabled but Python is not available (set TTS_PYTHON or create TTS_VENV_PATH).");
      } else if (!hasTtsServer) {
        log(`TTS keepalive server script is missing at ${AIDOLON_TTS_SERVER_SCRIPT_PATH}.`);
      } else {
        log(`TTS enabled (model=${TTS_MODEL || "(unset)"}, mode=keepalive, auto_restart=${TTS_KEEPALIVE_AUTO_RESTART})`);
      }
    }
    log(
      `Progress updates: enabled=${PROGRESS_UPDATES_ENABLED} include_stderr=${PROGRESS_INCLUDE_STDERR} first=${PROGRESS_FIRST_UPDATE_SEC}s interval=${PROGRESS_UPDATE_INTERVAL_SEC}s`,
    );
    log(
      `Chat actions: enabled=${TELEGRAM_CHAT_ACTION_ENABLED} default=${TELEGRAM_CHAT_ACTION_DEFAULT} voice=${TELEGRAM_CHAT_ACTION_VOICE} interval=${TELEGRAM_CHAT_ACTION_INTERVAL_SEC}s`,
    );
    log(
      `Chat logging: terminal=${CHAT_LOG_TO_TERMINAL} file=${CHAT_LOG_TO_FILE} max_chars=${CHAT_LOG_MAX_CHARS} flush_interval_ms=${CHAT_LOG_FLUSH_INTERVAL_MS} buffer_max_lines=${CHAT_LOG_BUFFER_MAX_LINES} file_path=${CHAT_LOG_PATH}`,
    );
    log(`State persistence: debounce=${STATE_WRITE_DEBOUNCE_MS}ms max_delay=${STATE_WRITE_MAX_DELAY_MS}ms`);
    log(`Signal policy: exit_on_sighup=${BOT_EXIT_ON_SIGHUP}`);
    if (WORLDMONITOR_MONITOR_ENABLED) {
      const configuredWorkdir = String(WORLDMONITOR_WORKDIR || "").trim();
      if (configuredWorkdir && !fs.existsSync(configuredWorkdir)) {
        log(`WorldMonitor monitor workdir does not exist: ${configuredWorkdir} (will use general worker fallback).`);
      }
      const feeds = loadWorldMonitorNativeFeedManifest();
      log(
        `WorldMonitor monitor enabled (source=native, feeds=${feeds.length}, manifest=${WORLDMONITOR_NATIVE_FEEDS_PATH}, interval=${WORLDMONITOR_MONITOR_INTERVAL_SEC}s, interval_alert_mode=${WORLDMONITOR_INTERVAL_ALERT_MODE}, headlines_min_level=${WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL}, report_baseline=${WORLDMONITOR_INTERVAL_REPORT_BASELINE_PER_DAY}/day, report_max=${worldMonitorIntervalReportMaxLabel()}/day, report_min_interval=${WORLDMONITOR_INTERVAL_REPORT_MIN_INTERVAL_SEC}s, report_sig_delta>=${WORLDMONITOR_INTERVAL_REPORT_SIGNIFICANT_DELTA}, cooldown=${WORLDMONITOR_ALERT_COOLDOWN_SEC}s).`,
      );
      if (WORLDMONITOR_FEED_ALERTS_ENABLED) {
        log(
          `WorldMonitor feed-alert relay enabled (engine=native, interval=${WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC}s, max_per_cycle=${WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE}, min_level=${WORLDMONITOR_FEED_ALERTS_MIN_LEVEL}, max_article_age_h=${WORLDMONITOR_FEED_ALERTS_MAX_ARTICLE_AGE_HOURS}, sent_key_cap=${WORLDMONITOR_FEED_ALERTS_SENT_KEY_CAP}, skip_aggregators=${WORLDMONITOR_FEED_ALERTS_SKIP_AGGREGATOR_LINKS}, skip_documents=${WORLDMONITOR_FEED_ALERTS_SKIP_DOCUMENT_LINKS}, require_context_quality=${WORLDMONITOR_FEED_ALERTS_REQUIRE_CONTEXT_QUALITY}).`,
        );
      } else {
        log("WorldMonitor feed-alert relay disabled (WORLDMONITOR_FEED_ALERTS_ENABLED=0).");
      }
      log(
        `WorldMonitor native signals enabled (timeout=${WORLDMONITOR_NATIVE_SIGNAL_TIMEOUT_MS}ms, refresh=${WORLDMONITOR_NATIVE_SIGNALS_REFRESH_MIN_INTERVAL_SEC}s, seismic_refresh=${WORLDMONITOR_NATIVE_SEISMIC_REFRESH_MIN_INTERVAL_SEC}s, adsb_refresh=${WORLDMONITOR_NATIVE_ADSB_REFRESH_MIN_INTERVAL_SEC}s, disaster_refresh=${WORLDMONITOR_NATIVE_DISASTER_REFRESH_MIN_INTERVAL_SEC}s, maritime_refresh=${WORLDMONITOR_NATIVE_MARITIME_REFRESH_MIN_INTERVAL_SEC}s, service_refresh=${WORLDMONITOR_NATIVE_SERVICE_REFRESH_MIN_INTERVAL_SEC}s, macro_refresh=${WORLDMONITOR_NATIVE_MACRO_REFRESH_MIN_INTERVAL_SEC}s, prediction_refresh=${WORLDMONITOR_NATIVE_PREDICTION_REFRESH_MIN_INTERVAL_SEC}s, retention_days=${WORLDMONITOR_NATIVE_SIGNALS_MAX_AGE_DAYS}).`,
      );
      log(
        `WorldMonitor article-context deep ingest ${WORLDMONITOR_DEEP_INGEST_ENABLED ? "enabled" : "disabled"} (timeout=${WORLDMONITOR_DEEP_INGEST_TIMEOUT_MS}ms, stage_budget=${WORLDMONITOR_DEEP_INGEST_STAGE_BUDGET_MS}ms, concurrency=${WORLDMONITOR_DEEP_INGEST_CONCURRENCY}, max_per_cycle=${worldMonitorDeepIngestCapLabel()}, lookback_hours=${WORLDMONITOR_DEEP_INGEST_LOOKBACK_HOURS}, summary_words=${WORLDMONITOR_DEEP_INGEST_SUMMARY_MAX_WORDS}).`,
      );
      log(
        `WorldMonitor startup catch-up ${WORLDMONITOR_STARTUP_CATCHUP_ENABLED ? "enabled" : "disabled"} (min_lookback_hours=${WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS}, per_source=${WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE}).`,
      );
    } else {
      log("WorldMonitor monitor disabled (WORLDMONITOR_MONITOR_ENABLED=0).");
    }
    if (WEATHER_DAILY_ENABLED) {
      if (!WEATHER_DAILY_CHAT_ID) {
        log("Daily weather report is enabled but WEATHER_DAILY_CHAT_ID is empty.");
      } else {
        const nextAt = computeNextWeatherDailyRunAt(Date.now());
        const configuredWeatherLocation = getConfiguredWeatherLocation();
        const configuredWeatherLabel = configuredWeatherLocation
          ? buildWeatherLocationSummary(configuredWeatherLocation)
          : "unset (will use per-chat shared GPS location)";
        log(
          `Daily weather report enabled (configured_location=${configuredWeatherLabel}, shared_gps_chats=${Object.keys(weatherLocationsByChat).length}, time=${String(WEATHER_DAILY_HOUR).padStart(2, "0")}:${String(WEATHER_DAILY_MINUTE).padStart(2, "0")} ${WEATHER_DAILY_TIMEZONE}, voice=${WEATHER_DAILY_VOICE_ENABLED}, next_run=${nowIso(nextAt)}).`,
        );
      }
    } else {
      log("Daily weather report disabled (WEATHER_DAILY_ENABLED=0).");
    }

    await prewarmAudioKeepalives();
    await skipStaleUpdates();
    if (WORLDMONITOR_MONITOR_ENABLED && WORLDMONITOR_STARTUP_CATCHUP_ENABLED) {
      void runWorldMonitorStartupCatchup();
    }
    startWorldMonitorMonitorLoop();
    startWorldMonitorFeedAlertsLoop();
    startWeatherDailyLoop();

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
