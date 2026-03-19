"use strict";

const fs = require("fs");
const path = require("path");

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

function withPromiseTimeout(promise, timeoutMs, timeoutMessage = "operation timed out") {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function hardTimeoutRemainingMs(job, hardTimeoutMs) {
  const ms = Number(hardTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const startedAt = Number(job?.startedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ms;
  const remaining = startedAt + ms - Date.now();
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
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function resolveMaybeRelativePath(value, baseDir = process.cwd()) {
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

  // Tokenizer callback/type errors can be transient and are handled by Python-side
  // retry/reload logic. Treating them as "fatal" here causes false-positive kills.
  if (/TypeError:\s*TextEncodeInput must be Union\[TextInputSequence,\s*Tuple\[InputSequence,\s*InputSequence\]\]/i.test(window)) {
    return { message: "", carry: nextCarry };
  }
  const hasLmdeployCallbackTrace = /exception calling callback for <future/i.test(window);
  const hasTokenizerBatchTrace =
    /tokenization_utils_fast\.py/i.test(window) ||
    /_batch_encode_plus/i.test(window) ||
    /lmdeploy[\\/]+pipeline\.py/i.test(window);
  if (hasLmdeployCallbackTrace && hasTokenizerBatchTrace) {
    return { message: "", carry: nextCarry };
  }

  return { message: "", carry: nextCarry };
}

function stripTtsBackendNoise(chunk, carry = "") {
  const carryState = (carry && typeof carry === "object")
    ? {
      lineCarry: String(carry.lineCarry || ""),
      dropLmdeployTokenizerTrace: carry.dropLmdeployTokenizerTrace === true,
    }
    : {
      lineCarry: String(carry || ""),
      dropLmdeployTokenizerTrace: false,
    };

  const combined = `${carryState.lineCarry}${String(chunk || "")}`;
  if (!combined) {
    return {
      text: "",
      carry: { lineCarry: "", dropLmdeployTokenizerTrace: carryState.dropLmdeployTokenizerTrace === true },
      dropped: 0,
    };
  }

  const parts = combined.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(combined);
  const nextLineCarry = hasTrailingNewline ? "" : (parts.pop() || "");
  if (hasTrailingNewline && parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

  let dropped = 0;
  let dropLmdeployTokenizerTrace = carryState.dropLmdeployTokenizerTrace === true;
  const kept = [];
  for (const rawLine of parts) {
    const line = String(rawLine || "");

    if (/^\s*\[TM\]\[ERROR\]\s*smem_size\s*=\s*\d+\s*$/i.test(line)) {
      dropped += 1;
      continue;
    }

    if (dropLmdeployTokenizerTrace) {
      dropped += 1;
      if (
        /TypeError:\s*TextEncodeInput must be Union\[TextInputSequence,\s*Tuple\[InputSequence,\s*InputSequence\]\]\s*$/i
          .test(line)
      ) {
        dropLmdeployTokenizerTrace = false;
      }
      continue;
    }

    if (/^\s*exception calling callback for <Future\b.*\bTypeError>\s*$/i.test(line)) {
      dropLmdeployTokenizerTrace = true;
      dropped += 1;
      continue;
    }

    kept.push(line);
  }

  return {
    text: kept.length ? `${kept.join("\n")}\n` : "",
    carry: {
      lineCarry: nextLineCarry,
      dropLmdeployTokenizerTrace,
    },
    dropped,
  };
}

function previewForLog(text, maxChars) {
  const normalized = oneLine(text);
  const lim = Number(maxChars);
  if (!Number.isFinite(lim) || lim <= 0) return normalized;
  if (normalized.length <= lim) return normalized;
  return `${normalized.slice(0, lim)}...`;
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

function normalizeDnsResultOrder(rawValue) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return process.platform === "win32" ? "ipv4first" : "";
  }
  if (["off", "none", "disabled", "0", "false", "no"].includes(raw)) return "";
  if (["ipv4first", "ipv6first", "verbatim"].includes(raw)) return raw;
  return "";
}

function redactError(text) {
  return String(text || "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

module.exports = {
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
  TELEGRAM_CHAT_ACTIONS,
  normalizeTelegramChatAction,
  normalizeSubredditName,
  parseArgString,
  sanitizeCodexExtraArgs,
  shQuote,
  resolveMaybeRelativePath,
  sleep,
  computeExponentialBackoffMs,
  chunkText,
  appendTail,
  oneLine,
  detectTtsBackendFatalError,
  stripTtsBackendNoise,
  previewForLog,
  nowIso,
  normalizeDnsResultOrder,
  redactError,
};
