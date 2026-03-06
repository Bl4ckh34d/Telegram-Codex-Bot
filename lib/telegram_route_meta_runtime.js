"use strict";

function createTelegramRouteMetaRuntime(deps = {}) {
  const {
    recordMessageMeta,
    recordReplyRoute,
  } = deps;

  const recordMeta = typeof recordMessageMeta === "function" ? recordMessageMeta : () => null;
  const recordRoute = typeof recordReplyRoute === "function" ? recordReplyRoute : () => {};

  function toPositiveInt(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  function recordOutgoingMessage(chatId, messageId, context = {}) {
    const msgId = toPositiveInt(messageId);
    if (!msgId) return;

    const routeWorkerId = String(context.routeWorkerId || "").trim();
    const routeTaskId = toPositiveInt(context.routeTaskId);
    const routeSessionId = String(context.routeSessionId || "").trim();
    const source = String(context.source || "").trim().toLowerCase();
    const snippet = String(context.snippet || "").trim();
    const persistIfNoRoute = context.persistIfNoRoute !== false;

    recordMeta(
      chatId,
      msgId,
      {
        parentMessageId: toPositiveInt(context.parentMessageId),
        source,
        snippet,
        from: String(context.from || "bot").trim() || "bot",
        fromIsBot: context.fromIsBot !== false,
        role: String(context.role || "assistant").trim().toLowerCase() || "assistant",
        workerId: routeWorkerId,
        taskId: routeTaskId,
        sessionId: routeSessionId,
        taskLinks: context.taskLinks,
      },
      { persist: persistIfNoRoute ? !routeWorkerId : true },
    );

    if (!routeWorkerId) return;
    recordRoute(chatId, msgId, routeWorkerId, {
      source,
      snippet,
      taskId: routeTaskId,
      sessionId: routeSessionId,
      taskLinks: context.taskLinks,
    });
  }

  return {
    recordOutgoingMessage,
  };
}

module.exports = {
  createTelegramRouteMetaRuntime,
};
