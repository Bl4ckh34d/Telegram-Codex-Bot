#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const MAX_OUTPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 30000;
const UI_ACTIONS = new Set([
  "windows",
  "focus",
  "click",
  "double_click",
  "right_click",
  "move",
  "mouse_down",
  "mouse_up",
  "drag",
  "highlight",
  "click_text",
  "clipboard_copy",
  "clipboard_paste",
  "clipboard_read",
  "type",
  "key",
  "scroll",
  "wait",
  "screenshot",
]);

function findRepoRoot() {
  const candidates = [
    process.env.AIDOLON_REPO_ROOT,
    process.cwd(),
    __dirname,
  ].filter(Boolean);

  for (const start of candidates) {
    let cur = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
      if (
        fs.existsSync(path.join(cur, "bot.js")) &&
        fs.existsSync(path.join(cur, "tools"))
      ) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  throw new Error("AIDOLON repo root not found. Set AIDOLON_REPO_ROOT.");
}

function scriptFor(repoRoot, linuxName, winName) {
  if (process.platform === "win32") return path.join(repoRoot, "tools", winName);
  return path.join(repoRoot, "tools", linuxName);
}

function commandForScript(scriptPath) {
  if (process.platform === "win32" && scriptPath.toLowerCase().endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }
  return { command: scriptPath, args: [] };
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "")).filter((item) => item.length > 0);
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd || findRepoRoot(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      finish({
        ok: false,
        text: `Timed out after ${Math.round(timeoutMs / 1000)}s.`,
      });
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      stdout = `${stdout}${String(buf || "")}`.slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on("data", (buf) => {
      stderr = `${stderr}${String(buf || "")}`.slice(-MAX_OUTPUT_CHARS);
    });
    child.on("error", (err) => {
      finish({ ok: false, text: String(err?.message || err) });
    });
    child.on("close", (code, signal) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
      if (code === 0) {
        finish({ ok: true, text: output || "Completed." });
      } else {
        finish({
          ok: false,
          text: `Failed${Number.isFinite(code) ? ` (exit ${code})` : ""}${signal ? ` (${signal})` : ""}.${output ? `\n\n${output}` : ""}`,
        });
      }
    });
  });
}

function textContent(text) {
  return [{ type: "text", text: String(text || "") }];
}

async function callTool(name, input) {
  const repoRoot = findRepoRoot();
  const args = input && typeof input === "object" ? input : {};

  if (name === "aidolon_ui_action") {
    const action = String(args.action || "").trim();
    if (!UI_ACTIONS.has(action)) throw new Error(`Unsupported UI action: ${action}`);
    const script = scriptFor(repoRoot, "ui.sh", "ui.cmd");
    const result = await runProcess(script, ["--action", action, ...asStringArray(args.args)], {
      cwd: repoRoot,
      timeoutMs: args.timeout_ms,
    });
    return { content: textContent(result.text), isError: !result.ok };
  }

  if (name === "aidolon_tv_power") {
    const action = String(args.action || "toggle").trim();
    const script = scriptFor(repoRoot, "tv_power.sh", "tv_power.ps1");
    const base = commandForScript(script);
    const result = await runProcess(base.command, [...base.args, "--action", action], {
      cwd: repoRoot,
      timeoutMs: args.timeout_ms,
    });
    return { content: textContent(result.text), isError: !result.ok };
  }

  if (name === "aidolon_tv_open_app") {
    const app = String(args.app || "").trim();
    if (!app) throw new Error("app is required");
    const script = scriptFor(repoRoot, "tv_open_app.sh", "tv_open_app.ps1");
    const base = commandForScript(script);
    const result = await runProcess(base.command, [...base.args, "--action", app], {
      cwd: repoRoot,
      timeoutMs: args.timeout_ms,
    });
    return { content: textContent(result.text), isError: !result.ok };
  }

  if (name === "aidolon_tv_close_app") {
    const app = String(args.app || "").trim();
    if (!app) throw new Error("app is required");
    const script = scriptFor(repoRoot, "tv_close_app.sh", "tv_close_app.ps1");
    const base = commandForScript(script);
    const result = await runProcess(base.command, [...base.args, "--action", app], {
      cwd: repoRoot,
      timeoutMs: args.timeout_ms,
    });
    return { content: textContent(result.text), isError: !result.ok };
  }

  if (name === "aidolon_tv_capture") {
    const script = scriptFor(repoRoot, "tv_capture.sh", "tv_capture.ps1");
    const base = commandForScript(script);
    const extraArgs = asStringArray(args.args);
    const result = await runProcess(base.command, [...base.args, ...extraArgs], {
      cwd: repoRoot,
      timeoutMs: args.timeout_ms,
    });
    return { content: textContent(result.text), isError: !result.ok };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}

const tools = [
  tool(
    "aidolon_ui_action",
    "Run one safe AIDOLON desktop UI automation action through tools/ui.sh or tools/ui.cmd.",
    {
      action: { type: "string", enum: [...UI_ACTIONS] },
      args: { type: "array", items: { type: "string" } },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    ["action"],
  ),
  tool(
    "aidolon_tv_power",
    "Wake, sleep, or toggle the Android TV power state.",
    {
      action: { type: "string", enum: ["on", "off", "toggle", "wake", "sleep"] },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    },
  ),
  tool(
    "aidolon_tv_open_app",
    "Open a supported Android TV app.",
    {
      app: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    ["app"],
  ),
  tool(
    "aidolon_tv_close_app",
    "Close a supported Android TV app.",
    {
      app: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    ["app"],
  ),
  tool(
    "aidolon_tv_capture",
    "Capture the Android TV screen using the repo TV capture script.",
    {
      args: { type: "array", items: { type: "string" } },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    },
  ),
];

function send(id, result, error = null) {
  const msg = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(message) {
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  const method = String(message.method || "");
  try {
    if (method === "initialize") {
      send(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aidolon-native-control", version: "0.1.0" },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      send(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const params = message.params || {};
      send(id, await callTool(String(params.name || ""), params.arguments || {}));
      return;
    }
    if (id !== null) {
      send(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  } catch (err) {
    if (id !== null) {
      send(id, null, { code: -32000, message: String(err?.message || err) });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handle(message);
});
