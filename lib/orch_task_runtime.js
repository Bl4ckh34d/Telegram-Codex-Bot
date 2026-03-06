"use strict";

function createOrchTaskRuntime(deps = {}) {
  const {
    orchTasksByChat,
    ORCH_TASK_MAX_PER_CHAT,
    ORCH_TASK_TTL_DAYS,
    takeNextTaskId,
    persistState,
    normalizeReplySnippet,
  } = deps;

  const tasksByChat = orchTasksByChat && typeof orchTasksByChat === "object" ? orchTasksByChat : {};
  const nextTaskId = typeof takeNextTaskId === "function"
    ? takeNextTaskId
    : () => Date.now();
  const persist = typeof persistState === "function" ? persistState : () => {};
  const normalizeSnippet = typeof normalizeReplySnippet === "function"
    ? normalizeReplySnippet
    : (text) => String(text || "").trim();

  function ensureTaskEntryForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return null;
    const current = tasksByChat[key];
    if (current && typeof current === "object") return current;
    const next = {};
    tasksByChat[key] = next;
    return next;
  }

  function pruneTasksForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return;
    const entry = tasksByChat[key];
    if (!entry || typeof entry !== "object") return;
    const rows = Object.entries(entry);
    if (rows.length === 0) return;

    const ttlDays = Math.max(1, Number(ORCH_TASK_TTL_DAYS) || 1);
    const maxPerChat = Math.max(1, Number(ORCH_TASK_MAX_PER_CHAT) || 1);
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    rows.sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0));

    const next = {};
    let kept = 0;
    for (const [taskId, meta] of rows) {
      if (kept >= maxPerChat) break;
      const createdAt = Number(meta?.createdAt || 0);
      if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < cutoff) continue;
      next[taskId] = meta;
      kept += 1;
    }
    tasksByChat[key] = next;
  }

  function createOrchTask(chatId, context = {}) {
    const key = String(chatId || "").trim();
    if (!key) return 0;
    const byChat = ensureTaskEntryForChat(key);
    if (!byChat) return 0;

    const rawTaskId = Number(nextTaskId());
    const taskId = Number.isFinite(rawTaskId) && rawTaskId > 0 ? Math.trunc(rawTaskId) : 0;
    if (!taskId) return 0;
    const now = Date.now();
    const workerId = String(context.workerId || "").trim();
    const prompt = String(context.prompt || "").trim();
    const source = String(context.source || "").trim().toLowerCase() || "message";
    const splitGroupId = String(context.splitGroupId || "").trim();
    const originMessageIdNum = Number(context.originMessageId || 0);
    const originMessageId = Number.isFinite(originMessageIdNum) && originMessageIdNum > 0 ? Math.trunc(originMessageIdNum) : 0;
    const replyToMessageIdNum = Number(context.replyToMessageId || 0);
    const replyToMessageId = Number.isFinite(replyToMessageIdNum) && replyToMessageIdNum > 0 ? Math.trunc(replyToMessageIdNum) : 0;

    const entry = {
      id: taskId,
      status: "queued",
      workerId,
      source,
      prompt: normalizeSnippet(prompt),
      createdAt: now,
      updatedAt: now,
      startedAt: 0,
      completedAt: 0,
      success: null,
      sessionId: "",
      outputSnippet: "",
      outputMessageIds: [],
      originMessageId,
      replyToMessageId,
    };
    if (splitGroupId) entry.splitGroupId = splitGroupId;
    byChat[String(taskId)] = entry;
    pruneTasksForChat(key);
    persist();
    return taskId;
  }

  function updateOrchTask(chatId, taskId, patch = {}, { persist: shouldPersist = true } = {}) {
    const key = String(chatId || "").trim();
    const taskNum = Number(taskId || 0);
    if (!key || !Number.isFinite(taskNum) || taskNum <= 0) return null;
    const byChat = ensureTaskEntryForChat(key);
    if (!byChat) return null;
    const idKey = String(Math.trunc(taskNum));
    const prev = byChat[idKey] && typeof byChat[idKey] === "object"
      ? byChat[idKey]
      : { id: Math.trunc(taskNum), createdAt: Date.now() };
    const now = Date.now();
    const next = { ...prev, updatedAt: now };

    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      const status = String(patch.status || "").trim().toLowerCase();
      if (status) next.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "workerId")) {
      const workerId = String(patch.workerId || "").trim();
      if (workerId) next.workerId = workerId;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "startedAt")) {
      const startedAt = Number(patch.startedAt || 0);
      next.startedAt = Number.isFinite(startedAt) && startedAt > 0 ? Math.trunc(startedAt) : 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "completedAt")) {
      const completedAt = Number(patch.completedAt || 0);
      next.completedAt = Number.isFinite(completedAt) && completedAt > 0 ? Math.trunc(completedAt) : 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "success")) {
      next.success = patch.success === null ? null : patch.success === true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "sessionId")) {
      const sessionId = String(patch.sessionId || "").trim();
      next.sessionId = sessionId;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "outputSnippet")) {
      next.outputSnippet = normalizeSnippet(String(patch.outputSnippet || ""));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "outputMessageIds")) {
      const ids = Array.isArray(patch.outputMessageIds)
        ? patch.outputMessageIds
            .map((x) => Number(x || 0))
            .filter((x) => Number.isFinite(x) && x > 0)
            .map((x) => Math.trunc(x))
        : [];
      next.outputMessageIds = [...new Set(ids)];
    }
    if (Object.prototype.hasOwnProperty.call(patch, "error")) {
      const err = String(patch.error || "").trim();
      next.error = err;
    }

    byChat[idKey] = next;
    pruneTasksForChat(key);
    if (shouldPersist) persist();
    return next;
  }

  function markOrchTaskRunning(job) {
    const taskId = Number(job?.taskId || 0);
    if (!Number.isFinite(taskId) || taskId <= 0) return;
    updateOrchTask(
      String(job?.chatId || ""),
      taskId,
      {
        status: "running",
        workerId: String(job?.workerId || "").trim(),
        startedAt: Date.now(),
      },
      { persist: true },
    );
  }

  function markOrchTaskCompleted(job, result, context = {}) {
    const taskId = Number(job?.taskId || 0);
    if (!Number.isFinite(taskId) || taskId <= 0) return;
    const ok = Boolean(result?.ok);
    const sessionId = String(context.sessionId || result?.sessionId || "").trim();
    const messageIds = Array.isArray(context.outputMessageIds) ? context.outputMessageIds : [];
    const outputText = String(result?.afterText || result?.text || "").trim();
    updateOrchTask(
      String(job?.chatId || ""),
      taskId,
      {
        status: ok ? "completed" : "failed",
        workerId: String(job?.workerId || "").trim(),
        completedAt: Date.now(),
        success: ok,
        sessionId,
        outputSnippet: outputText,
        outputMessageIds: messageIds,
        error: ok ? "" : String(result?.text || "").trim(),
      },
      { persist: true },
    );
  }

  return {
    createOrchTask,
    updateOrchTask,
    markOrchTaskRunning,
    markOrchTaskCompleted,
  };
}

module.exports = {
  createOrchTaskRuntime,
};
