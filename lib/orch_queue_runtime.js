"use strict";

function createOrchQueueRuntime(deps = {}) {
  const {
    lanes,
    fs,
    RESTART_REASON_PATH,
    RESTART_EXIT_CODE,
    getPendingRestartRequest,
    setPendingRestartRequest,
    getShuttingDown,
    getRestartTriggerInFlight,
    setRestartTriggerInFlight,
    sendMessage,
    logSystemEvent,
    shutdown,
    updateOrchTask,
    persistState,
    fmtBold,
    normalizeTtsPresetName,
    getCodexWorker,
    terminateChildTree,
  } = deps;

  function totalQueuedJobs() {
    let n = 0;
    for (const lane of lanes.values()) {
      n += Array.isArray(lane?.queue) ? lane.queue.length : 0;
    }
    return n;
  }

  function listActiveJobs() {
    const out = [];
    for (const lane of lanes.values()) {
      if (lane && lane.currentJob) out.push({ laneId: lane.id, job: lane.currentJob });
    }
    return out;
  }

  function laneWorkloadCounts() {
    let active = 0;
    let queued = 0;
    for (const lane of lanes.values()) {
      if (!lane) continue;
      if (lane.currentJob) active += 1;
      queued += Array.isArray(lane.queue) ? lane.queue.length : 0;
    }
    return { active, queued };
  }

  function hasPendingRestartRequest() {
    const pending = getPendingRestartRequest();
    return Boolean(pending && pending.chatIds instanceof Set);
  }

  function cancelPendingRestartRequest() {
    const hadPending = hasPendingRestartRequest();
    setPendingRestartRequest(null);
    return hadPending;
  }

  function ensurePendingRestartRequest(chatId = "") {
    if (!hasPendingRestartRequest()) {
      setPendingRestartRequest({
        requestedAt: Date.now(),
        chatIds: new Set(),
      });
    }
    const key = String(chatId || "").trim();
    if (!key) return;
    const pending = getPendingRestartRequest();
    if (pending?.chatIds instanceof Set) {
      pending.chatIds.add(key);
    }
  }

  function listRestartNotifyChats() {
    if (!hasPendingRestartRequest()) return [];
    const pending = getPendingRestartRequest();
    return [...pending.chatIds].map((x) => String(x || "").trim()).filter(Boolean);
  }

  function normalizeRestartReasonTag(reason = "") {
    const raw = String(reason || "").trim().toLowerCase();
    if (!raw || raw === "idle") return "manual_idle";
    if (raw === "forced") return "manual_forced";
    return raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "manual_other";
  }

  function persistRestartReason(reasonTag = "") {
    const tag = String(reasonTag || "").trim();
    if (!tag) return;
    try {
      fs.writeFileSync(RESTART_REASON_PATH, `${tag}\n`, "utf8");
    } catch {
      // best effort
    }
  }

  async function triggerRestartNow(reason = "") {
    if (getShuttingDown() || getRestartTriggerInFlight()) return false;
    setRestartTriggerInFlight(true);
    const notifyChats = listRestartNotifyChats();
    setPendingRestartRequest(null);
    const restartReasonTag = normalizeRestartReasonTag(reason);
    const counts = laneWorkloadCounts();
    persistRestartReason(restartReasonTag);
    logSystemEvent(
      `Restart requested (reason=${restartReasonTag}, active=${counts.active}, queued=${counts.queued}, notify_chats=${notifyChats.length}).`,
      "restart",
    );
    const normalizedReason = String(reason || "").trim().toLowerCase();
    let text = "Restart confirmed. Restarting bot now...";
    if (normalizedReason === "forced") {
      text = "Force restart confirmed. Restarting bot now...";
    } else if (normalizedReason === "job completion") {
      text = "Task completed. Restart confirmed. Restarting bot now...";
    } else if (normalizedReason === "idle" || !normalizedReason) {
      text = "All workers are finished. Restart confirmed. Restarting bot now...";
    } else {
      text = `All workers are finished (${reason}). Restart confirmed. Restarting bot now...`;
    }
    for (const chatId of notifyChats) {
      try {
        await sendMessage(chatId, text);
      } catch {
        // best effort
      }
    }
    setTimeout(() => {
      void shutdown(RESTART_EXIT_CODE, `restart:${restartReasonTag}`);
    }, 200);
    return true;
  }

  async function maybeTriggerPendingRestart(reason = "") {
    if (!hasPendingRestartRequest()) return false;
    if (getShuttingDown() || getRestartTriggerInFlight()) return false;
    const { active, queued } = laneWorkloadCounts();
    if (active > 0 || queued > 0) return false;
    return await triggerRestartNow(reason);
  }

  async function requestRestartWhenIdle(chatId, { forceNow = false } = {}) {
    const key = String(chatId || "").trim();
    if (getShuttingDown() || getRestartTriggerInFlight()) {
      if (key) await sendMessage(key, "Restart is already in progress.");
      return;
    }

    const { active, queued } = laneWorkloadCounts();
    if (active > 0 || queued > 0) {
      cancelPendingRestartRequest();
      if (key) {
        await sendMessage(
          key,
          `Restart blocked. Workers are still busy (active=${active}, queued=${queued}). Try again when everything is idle.`,
        );
      }
      return;
    }

    ensurePendingRestartRequest(key);
    await triggerRestartNow(forceNow ? "forced" : "idle");
  }

  function listActiveJobsForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return [];
    return listActiveJobs().filter((x) => String(x?.job?.chatId || "") === key);
  }

  function listQueuedJobsForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return [];
    const out = [];
    for (const lane of lanes.values()) {
      if (!lane || !Array.isArray(lane.queue) || lane.queue.length === 0) continue;
      for (const job of lane.queue) {
        if (String(job?.chatId || "") !== key) continue;
        out.push({ laneId: lane.id, job });
      }
    }
    out.sort((a, b) => Number(a.job?.id || 0) - Number(b.job?.id || 0));
    return out;
  }

  function dropQueuedJobsForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return 0;
    let removed = 0;
    const removedJobs = [];
    for (const lane of lanes.values()) {
      if (!lane || !Array.isArray(lane.queue) || lane.queue.length === 0) continue;
      const kept = [];
      for (const j of lane.queue) {
        if (String(j?.chatId || "") !== key) {
          kept.push(j);
          continue;
        }
        removed += 1;
        removedJobs.push(j);
      }
      lane.queue = kept;
    }
    let changedTasks = 0;
    for (const job of removedJobs) {
      const taskId = Number(job?.taskId || 0);
      if (!Number.isFinite(taskId) || taskId <= 0) continue;
      updateOrchTask(key, taskId, {
        status: "canceled",
        completedAt: Date.now(),
        success: false,
        error: "Canceled while queued.",
      }, { persist: false });
      changedTasks += 1;
    }
    if (changedTasks > 0) {
      persistState();
    }
    return removed;
  }

  async function sendQueue(chatId) {
    const items = listQueuedJobsForChat(chatId);
    if (items.length === 0) {
      await sendMessage(chatId, `${fmtBold("Queue")} is empty.`);
      return;
    }
    const lines = [fmtBold("Queued prompts")];
    for (const entry of items.slice(0, 10)) {
      const item = entry.job;
      const laneId = String(entry.laneId || "").trim();
      const kind = String(item?.kind || "codex");
      const ttsPreset = normalizeTtsPresetName(item?.ttsPreset) || "";
      const presetTag = ttsPreset ? `:${ttsPreset}` : "";
      let preview = "";
      if (kind === "tts-batch") {
        const texts = Array.isArray(item?.texts) ? item.texts : [];
        const count = texts.length;
        const first = String(texts[0] || "").trim();
        const head = first.length > 70 ? `${first.slice(0, 70)}...` : first;
        preview = `[tts-batch${presetTag} x${count || "?"}] ${head || "(empty)"}`;
      } else {
        const t = String(item?.text || "").trim();
        preview = t.length > 90 ? `${t.slice(0, 90)}...` : t || "(empty)";
        if (kind === "tts") preview = `[tts${presetTag}] ${preview}`;
        if (kind === "raw") preview = `[raw] ${preview}`;
      }
      const workerId = String(item?.workerId || "").trim();
      const worker = workerId ? getCodexWorker(workerId) : null;
      const workerName = String(worker?.name || worker?.title || worker?.id || "").trim();
      const label = worker
        ? `${worker.id}:${workerName || worker.id}`
        : laneId || "(unknown)";
      lines.push(`- #${item.id} (${label}): ${preview}`);
    }
    if (items.length > 10) {
      lines.push(`- ...and ${items.length - 10} more`);
    }
    await sendMessage(chatId, lines.join("\n"));
  }

  async function cancelCurrent(chatId) {
    const jobs = listActiveJobsForChat(chatId);
    if (jobs.length === 0) {
      await sendMessage(chatId, "No active AIDOLON run to cancel.");
      await maybeTriggerPendingRestart("idle");
      return;
    }

    for (const item of jobs) {
      const job = item.job;
      if (!job) continue;
      job.cancelRequested = true;
      try {
        if (job.abortController instanceof AbortController) {
          job.abortController.abort();
        }
      } catch {
        // best effort
      }
      if (job.process) {
        terminateChildTree(job.process, { forceAfterMs: 2000 });
      }
    }

    const label = jobs.length === 1 ? `job #${jobs[0].job?.id}` : `${jobs.length} job(s)`;
    await sendMessage(chatId, `Cancellation requested for ${label}.`);
    await maybeTriggerPendingRestart("cancellation");
  }

  async function clearQueue(chatId) {
    const removed = dropQueuedJobsForChat(chatId);
    await sendMessage(chatId, `Cleared ${removed} queued prompt(s).`);
    await maybeTriggerPendingRestart("queue cleared");
  }

  return {
    totalQueuedJobs,
    listActiveJobs,
    laneWorkloadCounts,
    hasPendingRestartRequest,
    cancelPendingRestartRequest,
    triggerRestartNow,
    requestRestartWhenIdle,
    maybeTriggerPendingRestart,
    listActiveJobsForChat,
    listQueuedJobsForChat,
    dropQueuedJobsForChat,
    sendQueue,
    cancelCurrent,
    clearQueue,
  };
}

module.exports = {
  createOrchQueueRuntime,
};
