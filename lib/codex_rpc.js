"use strict";
const { spawn, terminateChildTree } = require("./process_lifecycle");
const readline = require("node:readline");

async function withCodexRpc(spec, action, { timeoutMs = 15000 } = {}) {
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, shell: Boolean(spec.shell), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 0;
  let failure;
  const pending = new Map();
  const listeners = new Set();
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  const fail = err => {
    failure = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear(); rejectFatal(err);
  };
  const timer = setTimeout(() => fail(new Error("Codex app-server request timed out")), timeoutMs);
  child.on("error", fail);
  child.on("close", () => fail(new Error("Codex app-server closed")));
  child.stdin.on("error", fail);
  child.stderr.on("data", () => {});
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (request && ("result" in message || "error" in message)) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ method, params }) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    return await Promise.race([fatal, (async () => {
      await request("initialize", { clientInfo: { name: "aidolon-telegram", version: "0.1.0" }, capabilities: {} });
      notify("initialized", {});
      return await action({ request, listeners });
    })()]);
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end();
    void terminateChildTree(child, { forceAfterMs: 500 });
  }
}
module.exports = { withCodexRpc };
