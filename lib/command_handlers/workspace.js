"use strict";

function createWorkspaceCommandHandlers(deps = {}) {
  const {
    sendHelp,
    clearAllSessionsForChat,
    setActiveWorkerForChat,
    ORCH_GENERAL_WORKER_ID,
    clearLastImageForChat,
    sendCodexCommandMenu,
    sendStatus,
    sendWorkers,
    sendCapabilities,
    sendQueue,
    sendMessage,
    resolveWorkerIdFromUserInput,
    touchWorker,
    getCodexWorker,
    parseArgString,
    resolveWorkdirInput,
    pathExists,
    findWorkerByWorkdir,
    listCodexWorkers,
    ORCH_MAX_CODEX_WORKERS,
    createRepoWorker,
    retireWorker,
  } = deps;

  return {
    "/help": async (chatId) => {
      await sendHelp(chatId);
      return true;
    },
    "/start": async (chatId) => {
      // Telegram's /start should behave like "new chat": clear any active resumed session.
      clearAllSessionsForChat(chatId);
      setActiveWorkerForChat(chatId, ORCH_GENERAL_WORKER_ID);
      clearLastImageForChat(chatId);
      await sendHelp(chatId);
      return true;
    },
    "/codex": async (chatId) => {
      await sendCodexCommandMenu(chatId);
      return true;
    },
    "/commands": async (chatId) => {
      await sendCodexCommandMenu(chatId);
      return true;
    },
    "/status": async (chatId) => {
      await sendStatus(chatId);
      return true;
    },
    "/workers": async (chatId) => {
      await sendWorkers(chatId);
      return true;
    },
    "/capabilities": async (chatId) => {
      await sendCapabilities(chatId);
      return true;
    },
    "/use": async (chatId, parsed) => {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /use <worker_id, name, or title>\nTip: use /workers to list workers.");
        return true;
      }
      const wid = resolveWorkerIdFromUserInput(arg);
      if (!wid) {
        await sendMessage(chatId, `Unknown worker: ${arg}\nUse /workers to list workers.`);
        return true;
      }
      setActiveWorkerForChat(chatId, wid);
      touchWorker(wid);
      const worker = getCodexWorker(wid);
      const label = worker
        ? `${String(worker.name || worker.title || wid).trim() || wid} (${wid})`
        : wid;
      await sendMessage(chatId, `Active workspace set to: ${label}`);
      return true;
    },
    "/spawn": async (chatId, parsed) => {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /spawn <local-path> [title]\nExample: /spawn C:/path/to/repo MyRepo");
        return true;
      }
      const parts = parseArgString(arg);
      const rawPath = String(parts[0] || "").trim();
      const title = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
      const workdir = resolveWorkdirInput(rawPath);
      if (!workdir || !pathExists(workdir)) {
        await sendMessage(chatId, "That path does not exist. Please send an existing local path.");
        return true;
      }
      const existing = findWorkerByWorkdir(workdir);
      if (existing) {
        setActiveWorkerForChat(chatId, existing);
        touchWorker(existing);
        const worker = getCodexWorker(existing);
        const name = String(worker?.name || worker?.title || existing).trim() || existing;
        const titleInfo = String(worker?.title || "").trim();
        const details = titleInfo && titleInfo !== name ? `${name} (${existing}, ${titleInfo})` : `${name} (${existing})`;
        await sendMessage(chatId, `Using existing workspace ${details}.`);
        return true;
      }
      const count = listCodexWorkers().length;
      if (count >= ORCH_MAX_CODEX_WORKERS) {
        await sendMessage(chatId, `Worker limit reached (${ORCH_MAX_CODEX_WORKERS}). Retire one with /retire <worker_id, name, or title> first, or use an existing worker.`);
        return true;
      }
      let wid = "";
      try {
        wid = createRepoWorker(workdir, title);
      } catch (err) {
        await sendMessage(chatId, `Failed to create workspace: ${String(err?.message || err)}`);
        return true;
      }
      setActiveWorkerForChat(chatId, wid);
      touchWorker(wid);
      {
        const worker = getCodexWorker(wid);
        const name = String(worker?.name || worker?.title || wid).trim() || wid;
        const titleInfo = String(worker?.title || "").trim();
        const details = titleInfo && titleInfo !== name ? `${name} (${wid}, ${titleInfo})` : `${name} (${wid})`;
        await sendMessage(chatId, `Created workspace ${details}.`);
      }
      return true;
    },
    "/retire": async (chatId, parsed) => {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /retire <worker_id, name, or title>\nTip: use /workers to list workers.");
        return true;
      }
      const wid = resolveWorkerIdFromUserInput(arg);
      if (!wid) {
        await sendMessage(chatId, `Unknown worker: ${arg}\nUse /workers to list workers.`);
        return true;
      }
      try {
        retireWorker(wid);
      } catch (err) {
        await sendMessage(chatId, `Failed to retire worker: ${String(err?.message || err)}`);
        return true;
      }
      await sendMessage(chatId, `Retired worker: ${wid}`);
      return true;
    },
    "/queue": async (chatId) => {
      await sendQueue(chatId);
      return true;
    },
  };
}

module.exports = {
  createWorkspaceCommandHandlers,
};
