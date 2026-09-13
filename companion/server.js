"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, terminateChildTree, terminateAllChildren } = require("../lib/process_lifecycle");
const ROOT = path.resolve(__dirname, "..");
const ACTIONS = new Set("windows focus click double_click right_click move mouse_down mouse_up drag highlight click_text clipboard_copy clipboard_paste clipboard_read type key scroll wait screenshot".split(" "));

function createCompanion(token, port = 47831) {
  if (!token || token.length < 32) throw new Error("A token of at least 32 characters is required");
  const jobs = new Map();
  let uiBusy = false;
  function start(command, args, cwd, timeout = 120000) {
    if (typeof command !== "string" || !command || !Array.isArray(args) || args.some(x => typeof x !== "string")) throw new Error("command and string args required");
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 86400000) throw new Error("timeout_ms must be 1000..86400000");
    if ([...jobs.values()].filter(j => j.status === "running").length >= 8) throw new Error("Too many running jobs");
    if (jobs.size >= 100) {
      const old = [...jobs.values()].find(j => j.status !== "running");
      if (old) jobs.delete(old.id);
    }
    const job = { id: crypto.randomUUID(), status: "running", stdout: "", stderr: "", exit_code: null };
    const child = spawn(command, args, { cwd: cwd || ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    jobs.set(job.id, job);
    job.child = child;
    job.done = new Promise(resolve => {
      const timer = setTimeout(() => { job.status = "timed_out"; void terminateChildTree(child); }, timeout);
      for (const stream of ["stdout", "stderr"]) child[stream].on("data", data => { job[stream] = (job[stream] + data.toString()).slice(-100000); });
      child.on("error", error => { job.stderr += error.message; });
      child.on("close", code => {
        clearTimeout(timer);
        job.exit_code = code;
        if (job.status === "running") job.status = code === 0 ? "completed" : "failed";
        resolve();
      });
    });
    return job;
  }
  function publicJob(job) {
    const { id, status, stdout, stderr, exit_code } = job;
    return { id, status, stdout, stderr, exit_code };
  }
  async function dispatch(method, input = {}) {
    if (method === "status") return { hostname: os.hostname(), platform: process.platform, pid: process.pid, capabilities: {
      exec: true, desktop_actions: [...ACTIONS], desktop_session_required: true,
      desktop_backend: process.platform === "win32" ? "powershell" : "linux-ui",
      app_bridge_configured: fs.existsSync(path.join(ROOT, "runtime/app-bridge.json")),
      speech: false,
    }, jobs: [...jobs.values()].map(publicJob) };
    if (method === "exec") return publicJob(start(input.command, input.args || [], input.cwd, input.timeout_ms || 120000));
    if (method === "job" || method === "cancel") {
      const job = jobs.get(input.id);
      if (!job) throw new Error("Unknown job (the companion may have restarted)");
      if (method === "cancel" && job.status === "running") {
        job.status = "cancelling";
        await terminateChildTree(job.child);
        await job.done;
        job.status = "cancelled";
      }
      return publicJob(job);
    }
    if (method === "ui") {
      if (!ACTIONS.has(input.action)) throw new Error("Unsupported UI action");
      if (uiBusy) throw new Error("Desktop action already in progress");
      const extra = input.args || [];
      if (!Array.isArray(extra) || extra.some(x => typeof x !== "string")) throw new Error("args must be strings");
      uiBusy = true;
      let shot;
      try {
        let command, args;
        if (process.platform === "win32") {
          command = "powershell.exe";
          args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "tools/ui_automation.ps1"), "-Action", input.action, ...extra];
        } else {
          command = "bash";
          args = [path.join(ROOT, "tools/ui.sh"), "--action", input.action, ...extra];
        }
        if (input.action === "screenshot") {
          if (extra.length) throw new Error("Screenshot takes no extra arguments; captures primary screen");
          fs.mkdirSync(path.join(ROOT, "runtime/out"), { recursive: true });
          shot = path.join(ROOT, "runtime/out", `companion-${crypto.randomUUID()}.png`);
          args.push(process.platform === "win32" ? "-Output" : "--output", shot);
        }
        const job = start(command, args, ROOT, 60000);
        await job.done;
        const result = publicJob(job);
        if (shot && job.status === "completed") {
          if (fs.statSync(shot).size > 16000000) throw new Error("Screenshot exceeds 16 MB");
          result.image = fs.readFileSync(shot).toString("base64");
        }
        return result;
      } finally {
        if (shot) fs.rmSync(shot, { force: true });
        uiBusy = false;
      }
    }
    throw new Error("Unknown method");
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") { res.writeHead(404); res.end("{}"); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ result: await dispatch(body.method, body.input) }));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
  });
  server.requestTimeout = 70000;
  return { server, dispatch, listen: () => new Promise(resolve => server.listen(port, "127.0.0.1", resolve)) };
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || path.join(ROOT, "runtime/companion.json"), "utf8"));
  const companion = createCompanion(config.token, config.port);
  companion.server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  void companion.listen().then(() => console.log(`AIDOLON companion on ${os.hostname()} (loopback only)`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
    companion.server.close(); await terminateAllChildren(); process.exit(0);
  });
}
module.exports = { createCompanion };
