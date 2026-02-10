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
const WHISPER_SCRIPT_PATH = path.join(ROOT, "whisper_transcribe.py");
const AIDOLON_TTS_SCRIPT_PATH = path.join(ROOT, "aidolon_tts_synthesize.py");
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

function previewForLog(text, maxChars) {
  const normalized = oneLine(text);
  const lim = Number(maxChars);
  // Non-positive disables truncation.
  if (!Number.isFinite(lim) || lim <= 0) return normalized;
  if (normalized.length <= lim) return normalized;
  return `${normalized.slice(0, lim)}...`;
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
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
    windowsHide: true,
  });
  if (!probe.error) return true;
  if (process.platform !== "win32") return false;

  // On Windows, npm CLI shims are often .cmd and need shell=true.
  const shellProbe = spawnSync(binName, ["--version"], {
    shell: true,
    stdio: "ignore",
    timeout: SUBPROCESS_PROBE_TIMEOUT_MS > 0 ? SUBPROCESS_PROBE_TIMEOUT_MS : undefined,
    windowsHide: true,
  });
  return !shellProbe.error && shellProbe.status === 0;
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
ensureDir(IMAGE_DIR);
ensureDir(TTS_DIR);

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
const CHAT_LOG_TO_TERMINAL = toBool(process.env.CHAT_LOG_TO_TERMINAL, true);
const CHAT_LOG_TO_FILE = toBool(process.env.CHAT_LOG_TO_FILE, true);
const TERMINAL_COLORS = toBool(process.env.TERMINAL_COLORS, true);
const CHAT_LOG_USE_COLORS = toBool(process.env.CHAT_LOG_USE_COLORS, true);
const CHAT_LOG_MAX_CHARS = toInt(process.env.CHAT_LOG_MAX_CHARS, 700);
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
// This applies to synth/encode timeouts and (best-effort) upload timeouts.
// Synthesis failures may also be retried (best-effort) to handle flaky backends. 0 disables retries.
const TTS_TIMEOUT_RETRIES = toInt(process.env.TTS_TIMEOUT_RETRIES, 2, 0, 10);
const TTS_VENV_PATH = resolveMaybeRelativePath(process.env.TTS_VENV_PATH || path.join(ROOT, ".tts-venv"));
const TTS_MODEL = String(process.env.TTS_MODEL || "").trim();
const TTS_REFERENCE_AUDIO = resolveMaybeRelativePath(process.env.TTS_REFERENCE_AUDIO || "");
const TTS_SAMPLE_RATE = toInt(process.env.TTS_SAMPLE_RATE, 48000);
const TTS_PYTHON = String(process.env.TTS_PYTHON || "").trim();
const TTS_FFMPEG_BIN = String(process.env.TTS_FFMPEG_BIN || "ffmpeg").trim();
const TTS_OPUS_BITRATE_KBPS = toInt(process.env.TTS_OPUS_BITRATE_KBPS, 48);
const TTS_SEND_TEXT = toBool(process.env.TTS_SEND_TEXT, false);
const TTS_REPLY_TO_VOICE = toBool(process.env.TTS_REPLY_TO_VOICE, false);
// When auto-replying to voice notes with TTS, optionally send a small "still working" ping
// if generation takes longer than this many seconds. 0 disables.
const TTS_VOICE_REPLY_NOTIFY_AFTER_SEC = toInt(process.env.TTS_VOICE_REPLY_NOTIFY_AFTER_SEC, 0, 0, 3600);
// Optional post-processing effects for the synthesized WAV before encoding to Opus/OGG.
// This is intentionally ffmpeg-only (no extra deps), and is best-effort: presets approximate Audacity effects.
const TTS_POSTPROCESS_ENABLED = toBool(process.env.TTS_POSTPROCESS_ENABLED, false);
const TTS_POSTPROCESS_PRESET = String(process.env.TTS_POSTPROCESS_PRESET || "").trim().toLowerCase();
// Raw ffmpeg audio filtergraph string passed to `-af` (overrides preset when set).
const TTS_POSTPROCESS_FFMPEG_AF = String(process.env.TTS_POSTPROCESS_FFMPEG_AF || "").trim();
const TTS_POSTPROCESS_DEBUG = toBool(process.env.TTS_POSTPROCESS_DEBUG, false);

const ATTACH_ENABLED = toBool(process.env.ATTACH_ENABLED, true);
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

ensureDir(ATTACH_ROOT);

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
const ORCH_ROUTER_PROMPT_FILE = resolveMaybeRelativePath(
  process.env.ORCH_ROUTER_PROMPT_FILE || path.join(ROOT, "codex_prompt_router.txt"),
);

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

const state = readJson(STATE_PATH, { lastUpdateId: 0, chatSessions: {}, lastImages: {}, chatPrefs: {}, orch: {} });
let lastUpdateId = Number(state.lastUpdateId || 0);
const lastImages = state && typeof state.lastImages === "object" && state.lastImages
  ? { ...state.lastImages }
  : {};
const chatPrefs = state && typeof state.chatPrefs === "object" && state.chatPrefs
  ? { ...state.chatPrefs }
  : {};

const ORCH_GENERAL_WORKER_ID = "general";
const ORCH_TTS_LANE_ID = "tts";
const ORCH_WHISPER_LANE_ID = "whisper";

const orch = normalizeOrchState(state, {
  legacyChatSessions: state && typeof state.chatSessions === "object" && state.chatSessions ? state.chatSessions : {},
});
const orchWorkers = orch.workers; // { [workerId]: { ... } }
const orchActiveWorkerByChat = orch.activeWorkerByChat; // { [chatId]: workerId }
const orchSessionByChatWorker = orch.sessionByChatWorker; // { [chatId]: { [workerId]: sessionId } }
const orchReplyRouteByChat = orch.replyRouteByChat; // { [chatId]: { [messageId]: { workerId, at } } }
let orchNextWorkerNum = Number(orch.nextWorkerNum || 1);

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
let pendingSequence = 1;
const prefButtonsById = new Map();
let prefButtonSequence = 1;
let codexTopCommandsCache = {
  loadedAt: 0,
  commands: [],
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
  let nextWorkerNum = Number(raw?.nextWorkerNum || 1);
  if (!Number.isFinite(nextWorkerNum) || nextWorkerNum < 1) nextWorkerNum = 1;

  const now = Date.now();
  // Ensure a general worker always exists.
  const general = workers[ORCH_GENERAL_WORKER_ID];
  if (!general || typeof general !== "object") {
    workers[ORCH_GENERAL_WORKER_ID] = {
      id: ORCH_GENERAL_WORKER_ID,
      kind: "general",
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

  return {
    version: 1,
    workers,
    activeWorkerByChat,
    sessionByChatWorker,
    replyRouteByChat,
    nextWorkerNum,
  };
}

function persistState() {
  try {
    writeJsonAtomic(STATE_PATH, {
      lastUpdateId,
      lastImages,
      chatPrefs,
      orch: {
        version: 1,
        workers: orchWorkers,
        activeWorkerByChat: orchActiveWorkerByChat,
        sessionByChatWorker: orchSessionByChatWorker,
        replyRouteByChat: orchReplyRouteByChat,
        nextWorkerNum: orchNextWorkerNum,
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

  // Basename match (repo folder name).
  for (const w of workers) {
    const base = String(path.basename(String(w.workdir || "")) || "").trim().toLowerCase();
    if (base && base === lower) return w.id;
  }

  // Substring match (first).
  for (const w of workers) {
    const title = String(w.title || "").trim().toLowerCase();
    const dir = String(w.workdir || "").trim().toLowerCase();
    if ((title && title.includes(lower)) || (dir && dir.includes(lower))) return w.id;
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
    title: w.title,
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
  for (const lane of lanes.values()) {
    if (!lane || !Array.isArray(lane.queue) || lane.queue.length === 0) continue;
    const before = lane.queue.length;
    lane.queue = lane.queue.filter((j) => String(j?.chatId || "") !== key);
    removed += before - lane.queue.length;
  }
  return removed;
}

function recordReplyRoute(chatId, messageId, workerId) {
  const chatKey = String(chatId || "").trim();
  const msgKey = String(messageId || "").trim();
  const wid = String(workerId || "").trim();
  if (!chatKey || !msgKey || !wid) return;
  if (!orchWorkers[wid]) return;

  const prev = orchReplyRouteByChat[chatKey] && typeof orchReplyRouteByChat[chatKey] === "object"
    ? orchReplyRouteByChat[chatKey]
    : {};
  prev[msgKey] = { workerId: wid, at: Date.now() };
  orchReplyRouteByChat[chatKey] = prev;

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
  const chatKey = String(chatId || "").trim();
  const msgKey = String(messageId || "").trim();
  if (!chatKey || !msgKey) return "";
  const entry = orchReplyRouteByChat[chatKey];
  if (!entry || typeof entry !== "object") return "";
  const hit = entry[msgKey];
  if (!hit || typeof hit !== "object") return "";
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

function buildRouterPrompt({ userText, activeWorkerId, replyHintWorkerId, workers, cap }) {
  const safeUserText = String(userText || "").trim();
  const lines = [
    `Max workers: ${Number(cap) || ORCH_MAX_CODEX_WORKERS}`,
    `Active worker: ${String(activeWorkerId || "").trim() || ORCH_GENERAL_WORKER_ID}`,
    replyHintWorkerId ? `Reply hint worker (strong signal): ${String(replyHintWorkerId || "").trim()}` : "",
    "",
    "Workers:",
  ].filter(Boolean);

  for (const w of Array.isArray(workers) ? workers : []) {
    const workdir = String(w?.workdir || "").replace(/\\/g, "/");
    lines.push(`- ${w.id} | kind=${w.kind} | title=${w.title} | workdir=${workdir}`);
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
  if (!decision) return null;

  return { decision, workerId, workdir, title, question, raw: obj };
}

async function runRouterDecision(chatId, userText, { activeWorkerId = "", replyHintWorkerId = "" } = {}) {
  if (!ORCH_ROUTER_ENABLED) return null;
  const workers = listCodexWorkers();
  if (workers.length <= 1) return { decision: "use", workerId: ORCH_GENERAL_WORKER_ID, workdir: "", title: "", question: "" };

  const prompt = buildRouterPrompt({
    userText,
    activeWorkerId: String(activeWorkerId || "").trim() || getActiveWorkerForChat(chatId),
    replyHintWorkerId: String(replyHintWorkerId || "").trim(),
    workers,
    cap: ORCH_MAX_CODEX_WORKERS,
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
    rows.push([{ text: `Retire ${w.id}: ${w.title}`, callback_data: `orch_retire:${w.id}` }]);
  }
  rows.push([{ text: "Cancel", callback_data: "orch_retire_cancel" }]);
  return { inline_keyboard: rows };
}

async function decideWorkerForPrompt(chatId, userText, { replyHintWorkerId = "" } = {}) {
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const replyHint = String(replyHintWorkerId || "").trim();
  const fallback = replyHint && orchWorkers[replyHint] ? replyHint : activeWorkerId || ORCH_GENERAL_WORKER_ID;

  const route = await runRouterDecision(chatId, userText, { activeWorkerId, replyHintWorkerId: replyHint }).catch(() => null);
  if (!route) {
    return { decision: "use", workerId: fallback, question: "" };
  }

  const decision = String(route.decision || "").trim().toLowerCase();
  if (decision === "ask") {
    const q = String(route.question || "").trim();
    return { decision: "ask", workerId: "", question: q || "Which workspace should I use for this?" };
  }

  if (decision === "use") {
    const wid = String(route.workerId || "").trim();
    if (wid && orchWorkers[wid]) {
      return { decision: "use", workerId: wid, question: "" };
    }
    return { decision: "use", workerId: fallback, question: "" };
  }

  if (decision === "spawn_repo") {
    const workdirRaw = String(route.workdir || "").trim();
    const title = String(route.title || "").trim();
    if (!workdirRaw) {
      return { decision: "ask", workerId: "", question: "What is the local path to the repo/workspace?" };
    }

    const resolved = resolveWorkdirInput(workdirRaw);
    if (!resolved || !fs.existsSync(resolved)) {
      return { decision: "ask", workerId: "", question: `I could not find that path on disk. What is the correct local path?` };
    }

    const existing = findWorkerByWorkdir(resolved);
    if (existing) {
      return { decision: "use", workerId: existing, question: "" };
    }

    const workerCount = listCodexWorkers().length;
    if (workerCount >= ORCH_MAX_CODEX_WORKERS) {
      return { decision: "need_retire", workerId: "", workdir: resolved, title: title || path.basename(resolved) || "Repo" };
    }

    let newId = "";
    try {
      newId = createRepoWorker(resolved, title);
    } catch {
      return { decision: "ask", workerId: "", question: "I could not create a new workspace for that path. Can you confirm the path and try again?" };
    }
    return { decision: "use", workerId: newId, question: "" };
  }

  // Unknown router output; fall back.
  return { decision: "use", workerId: fallback, question: "" };
}

async function routeAndEnqueuePrompt(chatId, userText, source, options = {}) {
  const replyToMessageId = Number(options?.replyToMessageId || 0);
  const replyHintWorkerId = String(options?.replyHintWorkerId || "").trim();
  const decision = await decideWorkerForPrompt(chatId, userText, { replyHintWorkerId });

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

  const workerId = String(decision.workerId || "").trim() || getActiveWorkerForChat(chatId);
  await enqueuePrompt(chatId, userText, source, { ...options, workerId, replyToMessageId });
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
    "Do not output code blocks, markdown, commands, stack traces, JSON, URLs, or file paths.",
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
    "Your job: pick which worker should handle the user's message.",
    "Do not run tools or do the work. Only route.",
    "",
    "You will be given: the user message, the active worker, and a list of existing workers (some pinned to repos).",
    "Choose an existing worker when possible.",
    "If a new repo worker is needed, only propose one if the user message includes an explicit local path.",
    "If routing is ambiguous, ask one clarifying question.",
    "",
    "Output exactly one line in this format:",
    "ROUTE: {\"decision\":\"use|spawn_repo|ask\",\"worker_id\":\"...\",\"workdir\":\"...\",\"title\":\"...\",\"question\":\"...\"}",
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
  const worker = workerId ? getCodexWorker(workerId) : null;
  const workspaceLabel = worker ? `${worker.title} (${worker.kind})` : workerId || "unknown";

  const lines = [getPromptPreamble(replyStyle)];
  if (workdir) {
    lines.push(`Workspace: ${workspaceLabel}`);
    lines.push(`Working directory: ${workdir}`);
  }
  if (hasImages) {
    lines.push("One or more images are attached. Use them to answer the user.");
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
  const workdir = String(job?.workdir || CODEX_WORKDIR || ROOT).trim() || ROOT;
  const codexWorkdir = codexMode.mode === "wsl" ? toWslPath(workdir) : workdir;
  const promptText = formatCodexPrompt(job.text, {
    hasImages: rawImagePaths.length > 0,
    replyStyle: String(job?.replyStyle || ""),
    workdir,
    workerId: String(job?.workerId || "").trim(),
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

function renderTelegramEntities(text) {
  if (!TELEGRAM_FORMAT_BOLD) {
    return { text: String(text || ""), entities: null };
  }

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

    if (!inInlineCode && !inCodeFence && src.startsWith("**", i)) {
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
    return { text: restored, entities: entities.length > 0 ? entities : null };
  }

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
    { command: "restart", description: "restart the bot process" },
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

async function sendMessage(chatId, text, options = {}) {
  const silent = options.silent === true;
  const replyMarkup = options.replyMarkup || null;
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const allowSendingWithoutReply = options.allowSendingWithoutReply !== false;
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  const chunks = chunkText(normalizeResponse(text), TELEGRAM_MESSAGE_MAX_CHARS);
  const sent = [];
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
        if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
          recordReplyRoute(chatId, msg.message_id, routeWorkerId);
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
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId);
      }
      logChat("out", chatId, caption || "[photo]", { source: "telegram-photo" });
      return msg;
    } catch (err) {
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
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : TELEGRAM_UPLOAD_TIMEOUT_MS;
  const signal = options.signal;
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
      if (Number.isFinite(duration) && duration > 0) {
        form.append("duration", String(Math.round(duration)));
      }
      form.append("voice", blob, fileName);
      const msg = await telegramApiMultipart("sendVoice", form, timeoutMs, { signal });
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId);
      }
      logChat("out", chatId, caption || "[voice]", { source: "telegram-voice" });
      return msg;
    } catch (err) {
      // If we hit our own abort timeout, don't retry multiple times; it'll just stall the bot.
      if (String(err?.name || "").trim() === "AbortError") throw err;
      if (attempt >= 3) throw err;
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
      if (routeWorkerId && msg && typeof msg === "object" && msg.message_id) {
        recordReplyRoute(chatId, msg.message_id, routeWorkerId);
      }
      logChat("out", chatId, caption || `[document] ${fileName}`, { source: "telegram-document" });
      return msg;
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
    "$primaryName = [System.Windows.Forms.Screen]::PrimaryScreen.DeviceName",
    "$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object @{Expression={ $_.DeviceName -ne $primaryName }; Ascending=$true}, DeviceName",
    "$idx = 0",
    "foreach ($s in $screens) {",
    "  $idx = $idx + 1",
    "  $bounds = $s.Bounds",
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
  ].join("; ");

  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TG_SCREENSHOT_DIR: dir,
          TG_SCREENSHOT_PREFIX: safePrefix,
        },
      },
    );

    let out = "";
    let stderr = "";
    proc.stdout.on("data", (buf) => {
      out = appendTail(out, String(buf || ""), 32_000);
    });
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
      resolve(out);
    });
  });

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

async function handleScreenshotCommand(chatId) {
  const prefix = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = [];

  try {
    const paths = await captureAllScreenshots(OUT_DIR, prefix);
    created.push(...paths);
    const stamp = nowIso();
    for (let i = 0; i < paths.length; i += 1) {
      const label = i === 0 ? "Primary" : `Screen ${i + 1}`;
      await sendPhoto(chatId, paths[i], {
        caption: `Screenshot ${stamp} (${label})`,
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

async function sendHelp(chatId) {
  const lines = [
    "AIDOLON is online.",
    "",
    "Send plain text (or a voice message) to prompt AIDOLON.",
    "Commands:",
    "/help - this help",
    "/codex or /commands - show AIDOLON command menu",
    "/cmd <args> - stage a raw AIDOLON CLI command (needs /confirm)",
    "/confirm - run pending /cmd command",
    "/reject - cancel pending /cmd command",
    "/status - worker status",
    "/workers - list workspaces/workers",
    "/use <worker_id> - switch active workspace",
    "/spawn <path> [title] - create a new repo workspace",
    "/retire <worker_id> - remove a workspace",
    "/queue - show pending prompts",
    "/cancel - stop current AIDOLON run",
    "/clear - clear queued prompts",
    "/screenshot - capture and send screenshot(s) (all monitors when available)",
    "/sendfile <path> [caption] - send a file attachment (from ATTACH_ROOT)",
    "/resume - list recent AIDOLON sessions with prefill buttons",
    "/resume <session_id> [text] - resume a session, optionally with text",
    "/new - clear active resumed session",
    "/compress [hint] - summarize/compress active session context",
    "/ask <question> - analyze your last sent image",
    "/see <question> - take a screenshot and analyze it",
    "/imgclear - clear the last image context (so plain text goes back to AIDOLON)",
    "/model - pick the model + reasoning effort for this chat",
    "/tts <text> - send a TTS voice message (requires TTS_ENABLED=1)",
    "/restart - restart the bot process",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function sendStatus(chatId) {
  const queueCap = MAX_QUEUE_SIZE > 0 ? String(MAX_QUEUE_SIZE) : "unlimited";
  const queued = totalQueuedJobs();
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const activeSession = getActiveSessionForChat(chatId, activeWorkerId);
  const prefs = getChatPrefs(chatId);
  const effectiveModel = String(prefs.model || CODEX_MODEL || "").trim() || "(default)";
  const effectiveReasoning = String(prefs.reasoning || CODEX_REASONING_EFFORT || "").trim() || "(default)";
  const codexWorkers = listCodexWorkers();
  const ttsLane = getLane(ORCH_TTS_LANE_ID);
  const whisperLane = getLane(ORCH_WHISPER_LANE_ID);
  const routerModel = String(ORCH_ROUTER_MODEL || CODEX_MODEL || "").trim() || "(default)";
  const routerReasoning = String(ORCH_ROUTER_REASONING_EFFORT || "").trim() || "(default)";

  const lines = [
    "Bot status",
    `- workers: ${codexWorkers.length}/${ORCH_MAX_CODEX_WORKERS}`,
    `- active_worker: ${activeWorkerId}`,
    `- queue: ${queued}/${queueCap}`,
    `- active_session: ${activeSession ? shortSessionId(activeSession) : "(none)"}`,
    `- exec_mode: ${codexMode.mode}`,
    `- router: ${ORCH_ROUTER_ENABLED ? "enabled" : "disabled"} (model=${routerModel}, reasoning=${routerReasoning})`,
    `- model: ${effectiveModel}${prefs.model ? " (chat override)" : ""}`,
    `- reasoning: ${effectiveReasoning}${prefs.reasoning ? " (chat override)" : ""}`,
    `- full_access: ${CODEX_DANGEROUS_FULL_ACCESS}`,
    `- sandbox: ${CODEX_SANDBOX}`,
    `- approval: ${CODEX_APPROVAL_POLICY}`,
    `- whisper: ${WHISPER_ENABLED ? "enabled" : "disabled"}`,
    `- general_workdir: ${String(getCodexWorker(ORCH_GENERAL_WORKER_ID)?.workdir || CODEX_WORKDIR)}`,
    `- tts: ${ttsLane?.currentJob ? "busy" : "idle"} (queued=${ttsLane?.queue?.length || 0})`,
    `- whisper_lane: ${whisperLane?.currentJob ? "busy" : "idle"} (queued=${whisperLane?.queue?.length || 0})`,
    `- time: ${nowIso()}`,
  ];

  if (codexWorkers.length > 0) {
    lines.push("", "Workers:");
    for (const w of codexWorkers) {
      const lane = getLane(w.id);
      const busy = Boolean(lane?.currentJob);
      const queuedCount = lane?.queue?.length || 0;
      const cur = busy && lane?.currentJob
        ? `#${lane.currentJob.id} ${Math.floor((Date.now() - lane.currentJob.startedAt) / 1000)}s`
        : "none";
      const sessionId = getSessionForChatWorker(chatId, w.id);
      const sessionShort = sessionId ? shortSessionId(sessionId) : "(none)";
      lines.push(
        `- ${w.id}: ${w.title} (${w.kind}) busy=${busy} current=${cur} queued=${queuedCount} session=${sessionShort}`,
      );
    }
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function sendWorkers(chatId) {
  const activeWorkerId = getActiveWorkerForChat(chatId);
  const workers = listCodexWorkers();

  const lines = [
    `Workers (${workers.length}/${ORCH_MAX_CODEX_WORKERS})`,
    `- active: ${activeWorkerId}`,
  ];

  if (workers.length === 0) {
    lines.push("- (none)");
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  lines.push("", "List:");
  for (const w of workers) {
    const lane = getLane(w.id);
    const busy = Boolean(lane?.currentJob);
    const queued = lane?.queue?.length || 0;
    const marker = w.id === activeWorkerId ? "*" : "-";
    lines.push(
      `${marker} ${w.id}: ${w.title} (${w.kind}) busy=${busy} queued=${queued} workdir=${String(w.workdir || "").replace(/\\/g, "/")}`,
    );
  }

  lines.push(
    "",
    "Commands:",
    "/use <worker_id or title> - switch active workspace",
    "/spawn <local-path> [title] - create a new repo workspace",
    "/retire <worker_id> - remove a workspace",
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
    "Model settings (this chat)",
    `- model: ${effectiveModel}${prefs.model ? " (override)" : ""}`,
    `- reasoning: ${effectiveReasoning}${prefs.reasoning ? " (override)" : ""}`,
    "",
    "Pick a model:",
    "Pick a reasoning effort:",
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
    await sendMessage(chatId, "Queue is empty.");
    return;
  }
  const lines = ["Queued prompts:"];
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
    const label = worker ? `${worker.id}:${worker.title}` : laneId || "(unknown)";
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
  const jobs = listActiveJobsForChat(chatId);
  if (jobs.length === 0) {
    await sendMessage(chatId, "No active AIDOLON run to cancel.");
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
}

async function clearQueue(chatId) {
  const removed = dropQueuedJobsForChat(chatId);
  await sendMessage(chatId, `Cleared ${removed} queued prompt(s).`);
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
  const parsed = parseCommand(text);
  if (!parsed) return false;

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
        await sendMessage(chatId, "Usage: /use <worker_id or title>\nTip: use /workers to list workers.");
        return true;
      }
      const wid = resolveWorkerIdFromUserInput(arg);
      if (!wid) {
        await sendMessage(chatId, `Unknown worker: ${arg}\nUse /workers to list workers.`);
        return true;
      }
      setActiveWorkerForChat(chatId, wid);
      touchWorker(wid);
      await sendMessage(chatId, `Active workspace set to: ${wid}`);
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
        await sendMessage(chatId, `Using existing workspace ${existing} (${String(getCodexWorker(existing)?.title || existing)}).`);
        return true;
      }
      const count = listCodexWorkers().length;
      if (count >= ORCH_MAX_CODEX_WORKERS) {
        await sendMessage(chatId, `Worker limit reached (${ORCH_MAX_CODEX_WORKERS}). Retire one with /retire <worker_id> first, or use an existing worker.`);
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
      await sendMessage(chatId, `Created workspace ${wid} (${String(getCodexWorker(wid)?.title || wid)}).`);
      return true;
    }
    case "/retire": {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /retire <worker_id>\nTip: use /workers to list workers.");
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
      try {
        await sendMessage(chatId, "Taking screenshot...");
        const paths = await captureAllScreenshots(IMAGE_DIR, prefix);
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
    workdir: lane.workdir,
    replyToMessageId: Number(options?.replyToMessageId || 0),
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
    outputFile: path.join(OUT_DIR, `codex-job-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
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

function resolveAttachPath(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) throw new Error("empty path");

  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ATTACH_ROOT, raw);
  if (!_isPathInside(ATTACH_ROOT, resolved)) {
    throw new Error("path is outside ATTACH_ROOT");
  }
  if (!fs.existsSync(resolved)) throw new Error("file does not exist");
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw new Error("not a file");
  const limMb = Number(ATTACH_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  if (Number.isFinite(maxBytes) && st.size > maxBytes) {
    throw new Error(`file too large (${Math.round(st.size / (1024 * 1024))}MB > ${ATTACH_MAX_FILE_MB}MB)`);
  }
  return resolved;
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
  if (!ATTACH_ENABLED) return;
  const list = Array.isArray(attachments) ? attachments : [];
  const replyToMessageId = Number(options.replyToMessageId || 0);
  const routeWorkerId = String(options.routeWorkerId || "").trim();
  for (const item of list) {
    const rawPath = String(item?.path || "").trim();
    if (!rawPath) continue;
    let resolved;
    try {
      resolved = resolveAttachPath(rawPath);
    } catch (err) {
      await sendMessage(chatId, `Attachment skipped: ${rawPath} (${String(err?.message || err)})`);
      continue;
    }

    const caption = String(item?.caption || "").trim();
    const fileName = path.basename(resolved);
    try {
      await sendDocument(chatId, resolved, {
        caption,
        fileName,
        timeoutMs: ATTACH_UPLOAD_TIMEOUT_MS,
        replyToMessageId,
        routeWorkerId,
      });
    } catch (err) {
      await sendMessage(chatId, `Failed to send attachment ${fileName}: ${String(err?.message || err)}`);
    }
  }
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
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
  };

  lane.queue.push(job);
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
    startedAt: 0,
    cancelRequested: false,
    timedOut: false,
    process: null,
    stdoutTail: "",
    stderrTail: "",
  };

  lane.queue.push(job);
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

async function runTtsJob(job, lane) {
  let slowNotifyTimer = null;
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
  if (!TTS_ENABLED) {
    return {
      ok: false,
      text: formatFailureText("TTS is disabled on this bot (TTS_ENABLED=0)."),
      afterText,
      attachments,
    };
  }
  if (!fs.existsSync(AIDOLON_TTS_SCRIPT_PATH)) {
    return {
      ok: false,
      text: formatFailureText(`TTS helper script missing: ${AIDOLON_TTS_SCRIPT_PATH}`),
      afterText,
      attachments,
    };
  }

  if (!TTS_MODEL) {
    return {
      ok: false,
      text: formatFailureText("TTS model is not configured. Set TTS_MODEL in .env."),
      afterText,
      attachments,
    };
  }
  if (!TTS_REFERENCE_AUDIO) {
    return {
      ok: false,
      text: formatFailureText("TTS reference audio is not configured. Set TTS_REFERENCE_AUDIO in .env."),
      afterText,
      attachments,
    };
  }

  const pyBin = resolveTtsPythonBin();
  if (!pyBin) {
    return {
      ok: false,
      text: formatFailureText(
        "Python not found for TTS. Set TTS_PYTHON or create a venv at TTS_VENV_PATH (default .tts-venv).",
      ),
      afterText,
      attachments,
    };
  }

  const ffmpegBin = resolveTtsFfmpegBin();
  if (!ffmpegBin) {
    return {
      ok: false,
      text: formatFailureText(
        `ffmpeg not found ('${TTS_FFMPEG_BIN}'). Install ffmpeg or set TTS_FFMPEG_BIN.`,
      ),
      afterText,
      attachments,
    };
  }

  if (!text) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }

  if (
    TTS_VOICE_REPLY_NOTIFY_AFTER_SEC > 0 &&
    String(job?.source || "").trim().toLowerCase() === "voice-reply"
  ) {
    slowNotifyTimer = setTimeout(() => {
      if (shuttingDown) return;
      if (lane?.currentJob !== job) return;
      if (job.cancelRequested) return;
      void sendMessage(
        job.chatId,
        "Still generating a voice reply. Use /stop to cancel if needed.",
        { silent: true, replyToMessageId: job.replyToMessageId, routeWorkerId: job.workerId },
      ).catch(() => {});
    }, TTS_VOICE_REPLY_NOTIFY_AFTER_SEC * 1000);
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

      const timeoutMs = minPositive([TTS_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
      let timeoutForceFinish = null;
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
  for (let attempt = 1; attempt <= maxStageAttempts; attempt += 1) {
    const uploadTimeoutMs = minPositive([TTS_UPLOAD_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
    lastUploadTimeoutMs = uploadTimeoutMs;
    try {
      await sendVoice(job.chatId, oggPath, { timeoutMs: uploadTimeoutMs, signal: abortSignal, replyToMessageId: job.replyToMessageId, routeWorkerId: job.workerId });
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
    if (slowNotifyTimer) {
      clearTimeout(slowNotifyTimer);
    }
  }
}

async function runTtsBatchJob(job, lane) {
  let slowNotifyTimer = null;
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
  if (!TTS_ENABLED) {
    return {
      ok: false,
      text: formatFailureText("TTS is disabled on this bot (TTS_ENABLED=0)."),
      afterText,
      attachments,
    };
  }
  if (!fs.existsSync(AIDOLON_TTS_SCRIPT_PATH)) {
    return {
      ok: false,
      text: formatFailureText(`TTS helper script missing: ${AIDOLON_TTS_SCRIPT_PATH}`),
      afterText,
      attachments,
    };
  }

  if (!TTS_MODEL) {
    return {
      ok: false,
      text: formatFailureText("TTS model is not configured. Set TTS_MODEL in .env."),
      afterText,
      attachments,
    };
  }
  if (!TTS_REFERENCE_AUDIO) {
    return {
      ok: false,
      text: formatFailureText("TTS reference audio is not configured. Set TTS_REFERENCE_AUDIO in .env."),
      afterText,
      attachments,
    };
  }

  const pyBin = resolveTtsPythonBin();
  if (!pyBin) {
    return {
      ok: false,
      text: formatFailureText(
        "Python not found for TTS. Set TTS_PYTHON or create a venv at TTS_VENV_PATH (default .tts-venv).",
      ),
      afterText,
      attachments,
    };
  }

  const ffmpegBin = resolveTtsFfmpegBin();
  if (!ffmpegBin) {
    return {
      ok: false,
      text: formatFailureText(
        `ffmpeg not found ('${TTS_FFMPEG_BIN}'). Install ffmpeg or set TTS_FFMPEG_BIN.`,
      ),
      afterText,
      attachments,
    };
  }

  if (texts.length === 0) {
    return { ok: false, text: formatFailureText("Empty TTS text."), afterText, attachments };
  }

  if (
    TTS_VOICE_REPLY_NOTIFY_AFTER_SEC > 0 &&
    String(job?.source || "").trim().toLowerCase() === "voice-reply"
  ) {
    slowNotifyTimer = setTimeout(() => {
      if (shuttingDown) return;
      if (lane?.currentJob !== job) return;
      if (job.cancelRequested) return;
      void sendMessage(
        job.chatId,
        "Still generating a voice reply. Use /stop to cancel if needed.",
        { silent: true, replyToMessageId: job.replyToMessageId, routeWorkerId: job.workerId },
      ).catch(() => {});
    }, TTS_VOICE_REPLY_NOTIFY_AFTER_SEC * 1000);
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

      const timeoutMs = minPositive([TTS_TIMEOUT_MS, hardTimeoutRemainingMs(job, TTS_HARD_TIMEOUT_MS)]);
      let timeoutForceFinish = null;
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
          await sendVoice(job.chatId, oggPath, { timeoutMs: uploadTimeoutMs, signal: abortSignal, replyToMessageId: job.replyToMessageId, routeWorkerId: job.workerId });
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
    if (slowNotifyTimer) {
      clearTimeout(slowNotifyTimer);
    }
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
    // Allow cancellation to abort in-flight fetch() operations (Telegram uploads).
    job.abortController = new AbortController();
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
    }

    try {
      const routeWorkerId = String(job?.workerId || "").trim() || String(lane.id || "").trim();
      const replyToMessageId = Number(job?.replyToMessageId || 0);

      const attachParsed = extractAttachDirectives(String(result?.text || ""));
      const attachments = Array.isArray(attachParsed.attachments) ? attachParsed.attachments : [];
      const resultAfterText = String(result?.afterText || "").trim();
      const resultAttachments = Array.isArray(result?.attachments) ? result.attachments : [];
      const allAttachments = [...attachments, ...resultAttachments];
      if (result && typeof result === "object") {
        result.text = attachParsed.text;
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
      if (shouldVoiceReply) {
        try {
          const parts = splitVoiceReplyParts(String(result.text || ""));
          const spoken = makeSpeakableTextForTts(parts.spoken || String(result.text || ""));
          const { chunks: spokenChunks, overflowText } = splitSpeakableTextIntoVoiceChunks(spoken);
          const modelTextOnly = String(parts.textOnly || "").trim();
          const extracted = modelTextOnly ? "" : extractNonSpeakableInfo(String(result.text || ""));
          let afterText = modelTextOnly || (extracted ? `Text-only details:\n${extracted}` : "");
          if (overflowText) {
            const moved = `Moved from SPOKEN (too long for voice notes):\n${overflowText}`;
            afterText = afterText ? `${afterText}\n\n${moved}` : moved;
          }

          const chunks = spokenChunks.length > 0 ? spokenChunks : (spoken ? [spoken] : []);
          voiceQueued = chunks.length > 1
            ? await enqueueTtsBatch(job.chatId, chunks, "voice-reply", {
              afterText,
              // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
              skipResultText: true,
              attachments,
              workerId: routeWorkerId,
              replyToMessageId,
            })
            : await enqueueTts(job.chatId, chunks[0] || spoken, "voice-reply", {
              afterText,
              // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
              skipResultText: true,
              attachments,
              workerId: routeWorkerId,
              replyToMessageId,
            });
        } catch (err) {
          // If voice enqueue fails, fall back to sending text so the user still gets an answer.
          log(`enqueueTts(voice-reply) failed: ${redactError(err?.message || err)}`);
          voiceQueued = false;
        }
      }

      if (!result || (result.skipSendMessage !== true && !(shouldVoiceReply && voiceQueued))) {
        try {
          await sendMessage(job.chatId, normalizeResponse(result?.text), {
            replyToMessageId,
            routeWorkerId,
          });
        } catch (err) {
          log(`sendMessage(result) failed: ${redactError(err.message || err)}`);
        }
      }

      if (resultAfterText && !(shouldVoiceReply && voiceQueued)) {
        try {
          await sendMessage(job.chatId, resultAfterText, { replyToMessageId, routeWorkerId });
        } catch (err) {
          log(`sendMessage(afterText) failed: ${redactError(err?.message || err)}`);
        }
      }

      // If we replied via voice, attachments will be sent by the TTS job(s) to keep ordering sane.
      if (allAttachments.length > 0 && !(shouldVoiceReply && voiceQueued)) {
        try {
          await sendAttachments(job.chatId, allAttachments, { replyToMessageId, routeWorkerId });
        } catch (err) {
          log(`sendAttachments(result) failed: ${redactError(err?.message || err)}`);
        }
      }
    } catch (err) {
      log(`processLane(post) failed: ${redactError(err?.message || err)}`);
    } finally {
      lane.currentJob = null;
    }
  }
}

async function getTelegramFileMeta(fileId, { signal } = {}) {
  const params = new URLSearchParams({ file_id: String(fileId || "") });
  return await telegramApi("getFile", {
    query: params.toString(),
    signal,
  });
}

async function downloadTelegramFile(filePath, destinationPath, { signal } = {}) {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`File download failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("File download failed: empty body");
  }

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destinationPath));
  return fs.statSync(destinationPath).size;
}

async function transcribeAudioWithWhisper(audioPath, { abortSignal, job } = {}) {
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
  if (!fileId) {
    return { ok: false, text: "Voice message missing file id." };
  }

  const limMb = Number(WHISPER_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  const declaredBytes = Number(job?.declaredBytes || 0);
  if (Number.isFinite(maxBytes) && declaredBytes > 0 && declaredBytes > maxBytes) {
    return { ok: false, text: `Voice message too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${WHISPER_MAX_FILE_MB}MB.` };
  }

  const fileMeta = await getTelegramFileMeta(fileId, { signal: abortSignal });
  const remotePath = String(fileMeta?.file_path || "");
  if (!remotePath) {
    return { ok: false, text: "Could not resolve Telegram voice file path." };
  }

  const ext = path.extname(remotePath) || ".ogg";
  const localPath = path.join(
    VOICE_DIR,
    `voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );

  try {
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

    const replyToMessageId = Number(job?.replyToMessageId || 0);
    const replyHintMessageId = Number(job?.replyHintMessageId || 0);
    const replyHintWorkerId = replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "";

    await routeAndEnqueuePrompt(chatId, transcript, "voice", {
      replyStyle: TTS_REPLY_TO_VOICE && TTS_ENABLED ? "voice" : "",
      replyToMessageId,
      replyHintWorkerId,
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
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch {
      // best effort
    }
  }
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

  const replyHintMessageId = Number(msg?.reply_to_message?.message_id || 0);
  const replyHintWorkerId = replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "";
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
    replyToMessageId: Number(msg?.message_id || 0),
    replyHintMessageId,
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

async function handlePhotoOrImageDocument(msg) {
  const chatId = String(msg?.chat?.id || "");
  if (!chatId) return;
  const user = senderLabel(msg);

  if (!VISION_ENABLED) {
    await sendMessage(chatId, "Image received, but vision is disabled on this bot (VISION_ENABLED=0).");
    return;
  }

  let fileId = "";
  let suggestedName = "";
  let ext = "";
  let declaredBytes = 0;

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

  const limMb = Number(VISION_MAX_FILE_MB);
  const maxBytes = Number.isFinite(limMb) && limMb > 0 ? limMb * 1024 * 1024 : Infinity;
  if (Number.isFinite(maxBytes) && declaredBytes > 0 && declaredBytes > maxBytes) {
    await sendMessage(chatId, `Image too large (${Math.round(declaredBytes / (1024 * 1024))}MB). Max is ${VISION_MAX_FILE_MB}MB.`);
    return;
  }

  const fileMeta = await getTelegramFileMeta(fileId);
  const remotePath = String(fileMeta?.file_path || "");
  if (!remotePath) {
    await sendMessage(chatId, "Could not resolve Telegram image file path.");
    return;
  }

  const remoteExt = path.extname(remotePath) || ext || ".jpg";
  const safeExt = remoteExt.toLowerCase().match(/^\\.(png|jpe?g|webp|gif)$/) ? remoteExt.toLowerCase() : ".img";
  const localPath = path.join(
    IMAGE_DIR,
    `img-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`,
  );

  let downloadedBytes = 0;
  try {
    downloadedBytes = await downloadTelegramFile(remotePath, localPath);
    if (Number.isFinite(maxBytes) && downloadedBytes > maxBytes) {
      await sendMessage(chatId, `Downloaded image too large (${Math.round(downloadedBytes / (1024 * 1024))}MB).`);
      return;
    }

    setLastImageForChat(chatId, { path: localPath, name: suggestedName });

    const caption = String(msg.caption || "").trim();
    logChat("in", chatId, caption || "[image]", { source: "image", user });

    if (!caption) {
      await sendMessage(chatId, "Image saved. Send your question as a message, or use:\n/ask <question>");
      return;
    }

    const replyToMessageId = Number(msg?.message_id || 0);
    const replyHintMessageId = Number(msg?.reply_to_message?.message_id || 0);
    const replyHintWorkerId = replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "";
    await routeAndEnqueuePrompt(chatId, caption, "image-caption", {
      imagePaths: [localPath],
      replyToMessageId,
      replyHintWorkerId,
    });
  } catch (err) {
    await sendMessage(chatId, `Image handling failed: ${String(err?.message || err)}`);
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
    await sendMessage(chatId, `Using workspace ${newWorkerId}: ${String(getCodexWorker(newWorkerId)?.title || title || newWorkerId)}`, {
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
  if (!isAllowedMessage(msg)) {
    log(`[chat:drop] unauthorized chat=${chatId || "unknown"} user=${user}`);
    return;
  }

  if (msg.voice || msg.audio) {
    logChat("in", chatId, "[voice-message]", { source: "voice", user });
    await handleVoiceMessage(msg);
    return;
  }

  if ((Array.isArray(msg.photo) && msg.photo.length > 0) || msg.document) {
    const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const isImageDoc = Boolean(msg.document && String(msg.document.mime_type || "").toLowerCase().startsWith("image/"));
    if (isPhoto || isImageDoc) {
      logChat("in", chatId, "[image-message]", { source: "image", user });
      await handlePhotoOrImageDocument(msg);
      return;
    }
  }

  const text = String(msg.text || "").trim();
  if (!text) {
    logChat("in", chatId, "[non-text-message]", { source: "non-text", user });
    return;
  }

  logChat("in", chatId, text, { source: text.startsWith("/") ? "command" : "plain", user });

  const handled = await handleCommand(chatId, text);
  if (handled) return;

  const replyToMessageId = Number(msg?.message_id || 0);
  const replyHintMessageId = Number(msg?.reply_to_message?.message_id || 0);
  const replyHintWorkerId = replyHintMessageId > 0 ? lookupReplyRouteWorker(chatId, replyHintMessageId) : "";

  // If vision is enabled and the user sends plain text while an image is "active",
  // treat it as a question about the last image (unless they explicitly used a slash command).
  if (VISION_ENABLED) {
    const img = getLastImageForChat(chatId);
    const freshEnough = img && (VISION_AUTO_FOLLOWUP_SEC <= 0 || (Date.now() - Number(img.at || 0)) <= VISION_AUTO_FOLLOWUP_SEC * 1000);
    if (img && freshEnough) {
      await routeAndEnqueuePrompt(chatId, text, "image-followup", {
        imagePaths: [img.path],
        replyToMessageId,
        replyHintWorkerId,
      });
      return;
    }
  }

  await routeAndEnqueuePrompt(chatId, text, "plain", {
    replyToMessageId,
    replyHintWorkerId,
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
      if (!fs.existsSync(WHISPER_PYTHON)) {
        log(`Whisper venv missing at ${WHISPER_PYTHON} (run setup-whisper-venv.cmd)`);
      } else if (!fs.existsSync(WHISPER_SCRIPT_PATH)) {
        log(`Whisper script missing at ${WHISPER_SCRIPT_PATH}`);
      } else {
        log(`Whisper enabled (model=${WHISPER_MODEL}, language=${WHISPER_LANGUAGE || "auto"})`);
      }
    }
    log(
      `Progress updates: enabled=${PROGRESS_UPDATES_ENABLED} include_stderr=${PROGRESS_INCLUDE_STDERR} first=${PROGRESS_FIRST_UPDATE_SEC}s interval=${PROGRESS_UPDATE_INTERVAL_SEC}s`,
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
