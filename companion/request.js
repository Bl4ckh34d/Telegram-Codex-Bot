"use strict";
// Runs over SSH on the companion machine; credentials never cross stdout.
const fs = require("node:fs");
const path = require("node:path");
async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2] || path.resolve(__dirname, "../runtime/companion.json"), "utf8"));
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 1024 * 1024) throw new Error("Request too large");
  }
  const message = JSON.parse(data);
  if (message.method === "app") {
    const result = await require("./app-bridge").appRequest(message.input || {});
    process.stdout.write(JSON.stringify({ result }));
    return;
  }
  const response = await fetch(`http://127.0.0.1:${config.port || 47831}/rpc`, {
    method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: data, signal: AbortSignal.timeout(70000),
  });
  process.stdout.write(await response.text());
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
