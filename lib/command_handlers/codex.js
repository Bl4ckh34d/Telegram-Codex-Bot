"use strict";

function createCodexCommandHandlers(deps = {}) {
  const {
    sendMessage,
    sanitizeRawCodexArgs,
    setPendingCommandForChat,
    createPendingCommandSummary,
    buildPendingCommandMarkup,
    takePendingCommandByChat,
    enqueueRawCodexCommand,
    clearPendingCommandForChat,
    clearActiveSessionForChat,
    sendResumePicker,
    resolveResumeSessionId,
    setActiveSessionForChat,
    shortSessionId,
    enqueuePrompt,
    getActiveSessionForChat,
  } = deps;

  return {
    "/cmd": async (chatId, parsed) => {
      if (!parsed.arg) {
        await sendMessage(chatId, "Usage: /cmd <codex command and args>\nExample: /cmd exec review --uncommitted");
        return true;
      }
      let args;
      try {
        args = sanitizeRawCodexArgs(parsed.arg);
      } catch (err) {
        await sendMessage(chatId, String(err?.message || err));
        return true;
      }
      if (args.length === 0) {
        await sendMessage(chatId, "No command parsed. Example: /cmd exec review --uncommitted");
        return true;
      }
      const rawLine = args.join(" ");
      const pendingId = setPendingCommandForChat(chatId, rawLine, args);
      await sendMessage(chatId, createPendingCommandSummary(rawLine, pendingId), {
        replyMarkup: buildPendingCommandMarkup(pendingId),
      });
      return true;
    },
    "/confirm": async (chatId) => {
      const pending = takePendingCommandByChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command for this chat.");
        return true;
      }
      await enqueueRawCodexCommand(chatId, pending.args, "cmd-confirm");
      return true;
    },
    "/run": async (chatId) => {
      const pending = takePendingCommandByChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command for this chat.");
        return true;
      }
      await enqueueRawCodexCommand(chatId, pending.args, "cmd-confirm");
      return true;
    },
    "/reject": async (chatId) => {
      const pending = clearPendingCommandForChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command to cancel.");
        return true;
      }
      await sendMessage(chatId, `Canceled pending command:\ncodex ${pending.rawLine}`);
      return true;
    },
    "/deny": async (chatId) => {
      const pending = clearPendingCommandForChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command to cancel.");
        return true;
      }
      await sendMessage(chatId, `Canceled pending command:\ncodex ${pending.rawLine}`);
      return true;
    },
    "/cancelcmd": async (chatId) => {
      const pending = clearPendingCommandForChat(chatId);
      if (!pending) {
        await sendMessage(chatId, "No pending command to cancel.");
        return true;
      }
      await sendMessage(chatId, `Canceled pending command:\ncodex ${pending.rawLine}`);
      return true;
    },
    "/new": async (chatId) => {
      clearActiveSessionForChat(chatId);
      await sendMessage(chatId, "Active resumed session cleared. New messages start fresh sessions.");
      return true;
    },
    "/resume": async (chatId, parsed) => {
      if (!parsed.arg) {
        await sendResumePicker(chatId);
        return true;
      }

      const rawArg = String(parsed.arg || "").trim();
      if (["clear", "off", "none", "new"].includes(rawArg.toLowerCase())) {
        clearActiveSessionForChat(chatId);
        await sendMessage(chatId, "Active resumed session cleared.");
        return true;
      }

      const [sessionToken, ...rest] = rawArg.split(/\s+/);
      const sessionId = resolveResumeSessionId(sessionToken);
      if (!sessionId) {
        await sendMessage(chatId, "No session found. Use /resume to list recent sessions.");
        return true;
      }

      setActiveSessionForChat(chatId, sessionId);
      const resumePrompt = rest.join(" ").trim();
      if (!resumePrompt) {
        await sendMessage(
          chatId,
          `Active session set to ${shortSessionId(sessionId)}.\nSend your next message to continue this session.`,
        );
        return true;
      }

      await enqueuePrompt(chatId, resumePrompt, "resume-command", {
        resumeSessionId: sessionId,
      });
      return true;
    },
    "/compress": async (chatId, parsed) => {
      const activeSession = getActiveSessionForChat(chatId);
      if (!activeSession) {
        await sendMessage(chatId, "No active resumed session. Use /resume first.");
        return true;
      }
      const hint = String(parsed.arg || "").trim();
      const prompt = [
        "Compress this conversation context for efficient continuation.",
        "Keep important decisions, constraints, and next steps.",
        hint ? `Focus: ${hint}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await enqueuePrompt(chatId, prompt, "compress", {
        resumeSessionId: activeSession,
      });
      return true;
    },
  };
}

module.exports = {
  createCodexCommandHandlers,
};
