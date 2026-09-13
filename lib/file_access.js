"use strict";
const fs = require("node:fs");
const path = require("node:path");

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readAllowedFile(filePath, roots, maxBytes) {
  const realRoots = roots.filter(Boolean).map(root => fs.realpathSync(root));
  const resolved = fs.realpathSync(filePath);
  if (!realRoots.some(root => isInside(root, resolved))) throw new Error("path is outside allowed attachment roots");
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("attachment is not a regular file");
    // Linux resolves the actual opened object, including races in parent paths.
    const openedPath = process.platform === "linux" ? fs.realpathSync(`/proc/self/fd/${fd}`) : fs.realpathSync(resolved);
    const current = fs.statSync(openedPath);
    if (!realRoots.some(root => isInside(root, openedPath)) || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error("attachment changed during validation");
    }
    if (stat.size > maxBytes) throw new Error("attachment exceeds file size limit");
    // Bound the read even if the file grows after fstat.
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error("attachment exceeds file size limit");
      chunks.push(buffer.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}

module.exports = { isInside, readAllowedFile };
