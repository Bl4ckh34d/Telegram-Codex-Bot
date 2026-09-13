"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { loadCompanionHosts } = require("../lib/companion_hosts");
const hosts = loadCompanionHosts(process.argv[2]);
const properties = {
  hosts: {},
  status: {},
  ui: { action: { type: "string" }, args: { type: "array", items: { type: "string" } } },
  exec: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeout_ms: { type: "integer" } },
  job: { id: { type: "string" } }, cancel: { id: { type: "string" } },
};
for (const [name, props] of Object.entries(properties)) if (name !== "hosts") props.host_id = {type:"string", description:"Companion host ID from companion_hosts. Always pass it when working with multiple hosts."};
const descriptions = {
  hosts: "List configured companion computers without exposing connection credentials.",
  status: "Identify the companion machine and its jobs.",
  ui: "Perform one desktop action on the companion. Screenshot returns an image. Uses existing AIDOLON UI scripts: Windows args use -Title/-Text/-Keys/-X; Linux uses --title/--text/--keys/--x. Focus, screenshot, act, screenshot. Primary screen capture takes no args.",
  exec: "Start a local executable on the companion with an argument array and optional working directory. Returns job ID immediately. Use for files, builds, or the installed Codex CLI. Poll with job; never infer completion from elapsed time. No shell interpolation unless explicitly invoking a shell.",
  job: "Poll a companion job, including output and terminal status.",
  cancel: "Cancel a companion job and its process tree.",
};
function request(method, input) {
  if (method === "hosts") return Promise.resolve({hosts:hosts.list()});
  const {host_id, ...remoteInput} = input;
  const config = hosts.get(host_id).config;
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...(config.ssh_args || []), config.destination, config.remote_command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", exceeded = false;
    const timer = setTimeout(() => child.kill(), 75000);
    child.stdout.on("data", data => { out += data; if (out.length > 24000000) { exceeded = true; child.kill(); } });
    child.stderr.on("data", data => { err = (err + data).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer);
      if (exceeded || code !== 0) return reject(new Error(exceeded ? "Response too large" : err || "SSH request failed"));
      try { const reply = JSON.parse(out); if (reply.error) throw new Error(reply.error); resolve(reply.result); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ method, input: remoteInput }));
  });
}
async function handle(message) {
  if (message.id === undefined) return;
  let result;
  try {
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aidolon-companion", version: "0.1.0" } };
    else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") result = { tools: Object.entries(properties).map(([name, props]) => ({ name: `companion_${name}`, description: descriptions[name], inputSchema: { type: "object", properties: props, additionalProperties: false, required: name === "ui" ? ["action"] : name === "exec" ? ["command"] : ["job", "cancel"].includes(name) ? ["id"] : [] } })) };
    else if (message.method === "tools/call") {
      const name = String(message.params.name).replace(/^companion_/, "");
      if (!Object.hasOwn(properties, name)) throw new Error("Unknown tool");
      const data = await request(name, message.params.arguments || {});
      const { image, ...rest } = data;
      result = { content: [{ type: "text", text: JSON.stringify(rest) }], isError: ["failed", "timed_out"].includes(data.status) };
      if (image) result.content.push({ type: "image", mimeType: "image/png", data: image });
    } else throw new Error("Unknown method");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } }) + "\n"); }
}
readline.createInterface({ input: process.stdin }).on("line", line => { try { void handle(JSON.parse(line)); } catch {} });
