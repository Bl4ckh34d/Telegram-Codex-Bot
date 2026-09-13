"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dir = path.resolve(__dirname, "../runtime");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
try {
  fs.writeFileSync(path.join(dir, "companion.json"), JSON.stringify({ token: crypto.randomBytes(32).toString("hex"), port: 47831 }), { flag: "wx", mode: 0o600 });
  console.log("Created private companion configuration.");
} catch (error) { if (error.code !== "EEXIST") throw error; }
