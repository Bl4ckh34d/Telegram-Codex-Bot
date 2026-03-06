"use strict";

function createRuntimeCommandHandlers(deps = {}) {
  const {
    cancelCurrent,
    clearQueue,
    pruneRuntime,
    wipeRuntime,
    handleScreenshotCommand,
    sendMessage,
    parseArgString,
    sendAttachments,
    cancelPendingRestartRequest,
    requestRestartWhenIdle,
  } = deps;

  return {
    "/cancel": async (chatId) => {
      await cancelCurrent(chatId);
      return true;
    },
    "/stop": async (chatId) => {
      await cancelCurrent(chatId);
      return true;
    },
    "/clear": async (chatId) => {
      await clearQueue(chatId);
      return true;
    },
    "/prune": async (chatId) => {
      await pruneRuntime(chatId);
      return true;
    },
    "/wipe": async (chatId) => {
      await wipeRuntime(chatId);
      return true;
    },
    "/screenshot": async (chatId) => {
      try {
        await handleScreenshotCommand(chatId);
      } catch (err) {
        await sendMessage(chatId, `Screenshot failed: ${String(err?.message || err)}`);
      }
      return true;
    },
    "/sendfile": async (chatId, parsed) => {
      const arg = String(parsed.arg || "").trim();
      if (!arg) {
        await sendMessage(chatId, "Usage: /sendfile <relative-path> [caption]");
        return true;
      }
      const parts = parseArgString(arg);
      const relPath = String(parts[0] || "").trim();
      const caption = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
      if (!relPath) {
        await sendMessage(chatId, "Usage: /sendfile <relative-path> [caption]");
        return true;
      }
      await sendAttachments(chatId, [{ path: relPath, caption }]);
      return true;
    },
    "/restart": async (chatId, parsed) => {
      const tokens = parseArgString(parsed.arg || "")
        .map((x) => String(x || "").trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
        .filter(Boolean);
      const wantsCancel = tokens.some((t) => ["cancel", "off", "stop", "abort"].includes(t));
      if (wantsCancel) {
        const hadPending = cancelPendingRestartRequest();
        await sendMessage(chatId, hadPending ? "Queued restart canceled." : "No queued restart is pending.");
        return true;
      }

      const forceNow = tokens.some((t) => ["now", "force", "immediate"].includes(t));
      await requestRestartWhenIdle(chatId, { forceNow });
      return true;
    },
  };
}

module.exports = {
  createRuntimeCommandHandlers,
};
