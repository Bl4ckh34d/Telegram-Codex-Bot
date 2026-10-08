"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./core_utils");
const { encodeLocalPath, decodeLocalPath } = require("./portable_paths");

function createJobJournal(filePath, { baseDir = path.dirname(filePath) } = {}) {
  let records;
  try { records = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (err) { if (err.code !== "ENOENT") throw err; records = {}; }
  if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Invalid recovery journal");
  const mapImages = (record, mapPath) => Array.isArray(record?.imagePaths)
    ? { ...record, imagePaths: record.imagePaths.map(p => mapPath(p, baseDir)) } : record;
  records = Object.fromEntries(Object.entries(records).map(([id, record]) => [id, mapImages(record, decodeLocalPath)]));
  const save = () => writeJsonAtomic(filePath, Object.fromEntries(Object.entries(records)
    .map(([id, record]) => [id, mapImages(record, encodeLocalPath)])));
  const keyFor = job => job.journalId || (job.journalId = `${Date.now()}-${job.id}-${Math.random().toString(36).slice(2)}`);
  const update = (job, patch) => {
    const key = keyFor(job);
    records[key] = { ...records[key], ...patch, updatedAt: Date.now() };
    const done = Object.entries(records).filter(([, r]) => r.status === "delivered" || r.status === "canceled")
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [id] of done.slice(100)) delete records[id];
    save();
  };
  return {
    queued(job) {
      update(job, { status: "queued", chatId: String(job.chatId), kind: job.kind,
        prompt: String(job.text || ""), texts: job.texts, workerId: job.workerId,
        fileId: job.fileId, imagePaths: job.imagePaths, resumeSessionId: job.resumeSessionId,
        rawArgs: job.rawArgs, source: job.source });
    },
    running: job => update(job, { status: "running" }),
    result: (job, result) => update(job, { status: "awaiting_delivery", result }),
    delivered: job => update(job, { status: "delivered" }),
    canceled: job => update(job, { status: "canceled" }),
    pending: chatId => Object.entries(records).filter(([, r]) => String(r.chatId) === String(chatId)
      && !["delivered", "canceled"].includes(r.status)).map(([id, r]) => ({ id, ...r })),
    dismiss(id, chatId) {
      if (String(records[id]?.chatId) !== String(chatId)) return false;
      records[id].status = "canceled"; save(); return true;
    },
  };
}
module.exports = { createJobJournal };
