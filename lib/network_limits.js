"use strict";
const { Transform } = require("node:stream");
function byteLimit(maxBytes) {
  let total = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    if (total > maxBytes) callback(new Error("Download exceeds size limit"));
    else callback(null, chunk);
  } });
}
async function readTextLimited(response, maxBytes = 8 * 1024 * 1024) {
  const parts = [];
  let total = 0;
  for await (const chunk of response.body || []) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Response exceeds size limit");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, total).toString("utf8");
}
module.exports = { byteLimit, readTextLimited };
