"use strict";
// CLI fallback for a session that has not loaded the new MCP registration yet.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [config, method, json = "{}"] = process.argv.slice(2);
if (!config || !method) throw new Error("Usage: node companion/call.js CONFIG METHOD [JSON]");
const args = JSON.parse(json);
const child = spawn(process.execPath, [path.join(__dirname, "mcp.js"), config], { stdio: ["pipe", "pipe", "inherit"] });
let answered = false;
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 80000);
child.on("error", error => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
child.on("close", () => {
  clearTimeout(timer);
  if (!answered) { console.error("MCP adapter closed without a response"); process.exitCode = 1; }
});
child.stdin.on("error", () => {});
readline.createInterface({ input: child.stdout }).on("line", line => {
  const reply = JSON.parse(line);
  answered = true;
  if (reply.error) { console.error(reply.error.message); process.exitCode = 1; }
  if (reply.result?.isError) process.exitCode = 1;
  for (const content of reply.result?.content || []) {
    if (content.type === "text") console.log(content.text);
    if (content.type === "image") {
      const dir = path.resolve(__dirname, "../runtime/out");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `companion-${crypto.randomUUID()}.png`);
      fs.writeFileSync(file, Buffer.from(content.data, "base64"));
      console.log(`IMAGE: ${file}`);
    }
  }
  clearTimeout(timer); child.kill();
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `companion_${method}`, arguments: args } }) + "\n");
