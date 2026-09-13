"use strict";
const fs = require("node:fs");
const { conversationKey } = require("./telegram_topics");
const { writeJsonAtomic } = require("./core_utils");

function createTelegramInbox({ filePath, handle, onError, maxPending = 100 }) {
  let records;
  try { records = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (err) { if (err.code !== "ENOENT") throw err; records = {}; }
  if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Invalid recovery journal");
  const chains = new Map();
  const save = () => writeJsonAtomic(filePath, records);
  const schedule = (id) => {
    const entry = records[id];
    const chatId = conversationKey(entry.update.message || entry.update.callback_query?.message);
    const chain = (chains.get(chatId) || Promise.resolve()).then(async () => {
      entry.status = "handling"; save();
      try {
        await handle(entry.update); entry.status = "handled"; entry.update = { update_id: Number(id) };
        const done = Object.entries(records).filter(([, e]) => e.status === "handled").map(([key]) => key).sort((a, b) => Number(b) - Number(a));
        for (const key of done.slice(1000)) delete records[key];
        save();
      }
      catch (err) { entry.status = "interrupted"; entry.error = String(err.message || err); save(); await onError(err, entry.update); }
    });
    const safe = chain.catch(err => onError(err, entry.update));
    chains.set(chatId, safe);
    void safe.finally(() => { if (chains.get(chatId) === safe) chains.delete(chatId); }).catch(() => {});
  };
  // An interrupted handler may already have performed side effects. Retain it for
  // manual recovery; only entries never dispatched are safe to resume automatically.
  for (const entry of Object.values(records)) if (entry.status === "handling") entry.status = "interrupted";
  return {
    enqueue(update) {
      const id = String(update.update_id);
      if (records[id]) return;
      if (Object.values(records).filter(e => e.status !== "handled").length >= maxPending) throw new Error("Telegram inbox is full; use /recover to inspect unfinished input.");
      records[id] = { status: "queued", update };
      save(); schedule(id);
    },
    resume() { for (const [id, entry] of Object.entries(records)) if (entry.status === "queued") schedule(id); },
    pending: chatId => Object.entries(records).filter(([, e]) => e.status !== "handled" && conversationKey(e.update.message || e.update.callback_query?.message) === String(chatId)),
    counts: () => Object.values(records).filter(e => ["queued", "handling"].includes(e.status)).length,
    dismiss(id, chatId) {
      const entry = records[id];
      if (!entry || entry.status !== "interrupted" || conversationKey(entry.update.message || entry.update.callback_query?.message) !== String(chatId)) return false;
      entry.status = "handled"; entry.update = { update_id: Number(id) }; save(); return true;
    },
  };
}
module.exports = { createTelegramInbox };
