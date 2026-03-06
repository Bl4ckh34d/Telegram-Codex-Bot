"use strict";

const { createWorkspaceCommandHandlers } = require("./workspace");
const { createMonitorCommandHandlers } = require("./monitor");
const { createRuntimeCommandHandlers } = require("./runtime");
const { createCodexCommandHandlers } = require("./codex");
const { createMediaCommandHandlers } = require("./media");

function createParsedCommandRouter(deps = {}) {
  const handlers = Object.assign(
    {},
    createWorkspaceCommandHandlers(deps),
    createMonitorCommandHandlers(deps),
    createRuntimeCommandHandlers(deps),
    createCodexCommandHandlers(deps),
    createMediaCommandHandlers(deps),
  );

  const { getActiveSessionForChat, enqueuePrompt, sendMessage } = deps;

  return async function routeParsedCommand(chatId, parsed) {
    const cmd = String(parsed?.cmd || "").trim();
    if (!cmd) return false;

    const handler = handlers[cmd];
    if (typeof handler === "function") {
      return await handler(chatId, parsed);
    }

    const activeSession = getActiveSessionForChat(chatId);
    if (activeSession) {
      const rawSlashPrompt = `${cmd}${parsed?.arg ? ` ${parsed.arg}` : ""}`;
      await enqueuePrompt(chatId, rawSlashPrompt, "slash-forward", {
        resumeSessionId: activeSession,
      });
      return true;
    }
    await sendMessage(chatId, `Unknown command: ${cmd}`);
    return true;
  };
}

module.exports = {
  createParsedCommandRouter,
};
