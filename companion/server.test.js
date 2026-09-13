"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompanion } = require("./server");
const { terminateAllChildren } = require("../lib/process_lifecycle");
test("authenticated service: execution, failure, cancellation, validation", async () => {
  const token = "x".repeat(48);
  const app = createCompanion(token, 0);
  await app.listen();
  const url = `http://127.0.0.1:${app.server.address().port}/rpc`;
  async function rpc(method, input) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, input }) });
    return response.json();
  }
  async function finish(id) {
    for (let i = 0; i < 100; i++) {
      const { result } = await rpc("job", { id });
      if (result.status !== "running") return result;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error("Job did not finish");
  }
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await rpc("status")).result.platform, process.platform);
    const { result: job } = await rpc("exec", { command: process.execPath, args: ["-e", "console.log(process.argv[1])", "literal $() & spaces"] });
    const done = await finish(job.id);
    assert.equal(done.status, "completed");
    assert.equal(done.stdout.trim(), "literal $() & spaces");
    const failed = await rpc("exec", { command: process.execPath, args: ["-e", "process.exit(7)"] });
    assert.equal((await finish(failed.result.id)).exit_code, 7);
    const running = await rpc("exec", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    assert.equal((await rpc("cancel", { id: running.result.id })).result.status, "cancelled");
    assert.match((await rpc("job", { id: "missing" })).error, /Unknown job/);
    assert.match((await rpc("ui", { action: "invalid" })).error, /Unsupported/);
    assert.match((await rpc("exec", { command: "x", timeout_ms: -1 })).error, /timeout/);
  } finally { await terminateAllChildren(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }
});
