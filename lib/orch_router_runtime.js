"use strict";

function createOrchRouterRuntime(deps = {}) {
  const {
    fs,
    path,
    OUT_DIR,
    ROOT,
    CODEX_WORKDIR,
    ORCH_GENERAL_WORKER_ID,
    ORCH_MAX_CODEX_WORKERS,
    ORCH_ROUTER_ENABLED,
    ORCH_ROUTER_MAX_CONCURRENCY,
    ORCH_ROUTER_TIMEOUT_MS,
    ORCH_ROUTER_MODEL,
    ORCH_ROUTER_REASONING_EFFORT,
    ORCH_SPLIT_ENABLED,
    ORCH_SPLIT_MAX_TASKS,
    MAX_QUEUE_SIZE,
    ORCH_DELEGATION_ACK_ENABLED,
    ORCH_DELEGATION_ACK_SILENT,
    orchPendingSpawnByChat,
    listCodexWorkers,
    getCodexWorker,
    hasWorker,
    getActiveWorkerForChat,
    ensureWorkerLane,
    getLane,
    runCodexJob,
    createRepoWorker,
    resolveWorkdirInput,
    findWorkerByWorkdir,
    createOrchTask,
    getSessionForChatWorker,
    totalQueuedJobs,
    enqueuePrompt,
    sendMessage,
    log,
    redactError,
    normalizeReplySnippet,
    recordReplyRoute,
  } = deps;

  let routerSequence = 1;
  let routerInFlight = 0;
  const routerWaiters = [];

  function dedupeRouteAssignments(items) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(items) ? items : []) {
      const workerId = String(raw?.workerId || "").trim();
      const prompt = String(raw?.prompt || "").trim();
      if (!workerId || !prompt) continue;
      const key = `${workerId}\u0000${prompt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ workerId, prompt });
    }
    return out;
  }

  function describeWorkerForDelegation(workerId) {
    const wid = String(workerId || "").trim();
    if (!wid) return "";
    const worker = getCodexWorker(wid);
    if (!worker) return wid;
    const name = String(worker.name || "").trim();
    const title = String(worker.title || "").trim();
    if (name && title && title !== name) return `${name} (${wid}, ${title})`;
    if (name) return `${name} (${wid})`;
    return title ? `${wid} (${title})` : wid;
  }

  function summarizeDelegationQueueState(assignments) {
    const rows = dedupeRouteAssignments(assignments);
    const laneStateByWorker = new Map();
    let queuedCount = 0;

    for (const row of rows) {
      const wid = String(row.workerId || "").trim();
      if (!wid) continue;

      let state = laneStateByWorker.get(wid);
      if (!state) {
        const lane = getLane(wid) || ensureWorkerLane(wid);
        state = {
          busy: Boolean(lane?.currentJob),
          queued: Array.isArray(lane?.queue) ? lane.queue.length : 0,
        };
      }

      const willQueue = state.busy || state.queued > 0;
      if (willQueue) {
        queuedCount += 1;
        state.queued += 1;
      } else {
        state.busy = true;
      }
      laneStateByWorker.set(wid, state);
    }

    const total = rows.length;
    const inProgressCount = Math.max(0, total - queuedCount);
    return {
      total,
      queuedCount,
      inProgressCount,
      allQueued: total > 0 && queuedCount === total,
      allInProgress: total > 0 && queuedCount === 0,
      mixed: total > 0 && queuedCount > 0 && inProgressCount > 0,
    };
  }

  function buildDelegationAckText(assignments, stateSummary = null) {
    const rows = dedupeRouteAssignments(assignments);
    if (rows.length === 0) return "";
    const summary = stateSummary && typeof stateSummary === "object"
      ? stateSummary
      : summarizeDelegationQueueState(rows);
    const isQueued = Boolean(summary.allQueued);
    if (rows.length === 1) {
      const label = describeWorkerForDelegation(rows[0].workerId);
      return label
        ? `Got it. I delegated this to ${label}, and it is now ${isQueued ? "in queue" : "in progress"}.`
        : `Got it. I delegated this request, and it is now ${isQueued ? "in queue" : "in progress"}.`;
    }
    const labels = [];
    const seen = new Set();
    for (const x of rows) {
      const label = describeWorkerForDelegation(x.workerId);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    if (summary.mixed) {
      const lead = `Got it. I delegated this into ${rows.length} parallel tasks; ${summary.inProgressCount} are now in progress and ${summary.queuedCount} are in queue.`;
      if (labels.length === 0) return lead;
      return `${lead}\n- ${labels.join("\n- ")}`;
    }
    const stateWord = summary.allQueued ? "in queue" : "in progress";
    if (labels.length === 0) {
      return `Got it. I delegated this into ${rows.length} parallel tasks, and they are now ${stateWord}.`;
    }
    return `Got it. I delegated this into ${rows.length} parallel tasks, and they are now ${stateWord}:\n- ${labels.join("\n- ")}`;
  }

  async function acquireRouterSlot() {
    if (routerInFlight < ORCH_ROUTER_MAX_CONCURRENCY) {
      routerInFlight += 1;
      return;
    }
    await new Promise((resolve) => routerWaiters.push(resolve));
    routerInFlight += 1;
  }

  function releaseRouterSlot() {
    routerInFlight = Math.max(0, routerInFlight - 1);
    const next = routerWaiters.shift();
    if (typeof next === "function") next();
  }

  function buildRouterPrompt({
    userText,
    activeWorkerId,
    replyHintWorkerId,
    workers,
    cap,
    splitEnabled = false,
    splitMaxTasks = 0,
    replyContext = null,
    replyThreadContext = null,
    recentHistoryContext = null,
  }) {
    const safeUserText = String(userText || "").trim();
    const lines = [
      `Max workers: ${Number(cap) || ORCH_MAX_CODEX_WORKERS}`,
      `Active worker: ${String(activeWorkerId || "").trim() || ORCH_GENERAL_WORKER_ID}`,
      `Split routing: ${splitEnabled ? `enabled (max tasks ${Number(splitMaxTasks) || ORCH_SPLIT_MAX_TASKS})` : "disabled"}`,
      replyHintWorkerId ? `Reply hint worker (strong signal): ${String(replyHintWorkerId || "").trim()}` : "",
      "",
      "Workers:",
    ].filter(Boolean);

    for (const w of Array.isArray(workers) ? workers : []) {
      const workdir = String(w?.workdir || "").replace(/\\/g, "/");
      lines.push(`- ${w.id} | kind=${w.kind} | name=${String(w?.name || "").trim()} | title=${w.title} | workdir=${workdir}`);
    }

    if (replyContext && typeof replyContext === "object") {
      const replyMessageId = Number(replyContext.messageId || 0);
      const replySource = String(replyContext.source || "").trim();
      const replyFrom = String(replyContext.from || "").trim();
      const replySnippet = normalizeReplySnippet(replyContext.snippet || "");
      lines.push("", "Reply context:");
      if (Number.isFinite(replyMessageId) && replyMessageId > 0) {
        lines.push(`- Replied message id: ${Math.trunc(replyMessageId)}`);
      }
      if (replyFrom) {
        lines.push(`- Replied sender: ${replyFrom}${replyContext.fromIsBot === true ? " (bot)" : ""}`);
      }
      if (replySource) {
        lines.push(`- Replied type: ${replySource}`);
      }
      if (replySnippet) {
        lines.push("- Replied content:");
        lines.push(replySnippet);
      }
    }

    const threadText = String(replyThreadContext?.text || "").trim();
    if (threadText) {
      lines.push("", "Reply thread context (oldest -> newest):", threadText);
    }

    const recentText = String(recentHistoryContext?.text || "").trim();
    if (recentText) {
      lines.push("", "Recent chat context:", recentText);
    }

    lines.push("", "User message:", safeUserText);
    return lines.join("\n");
  }

  function parseRouterOutput(text) {
    const src = String(text || "").trim();
    if (!src) return null;

    let routeLine = "";
    const lines = src.split(/\r?\n/);
    for (const raw of lines) {
      const line = String(raw || "").trim();
      if (!line) continue;
      if (/^ROUTE\s*:/i.test(line)) {
        routeLine = line;
        break;
      }
    }
    if (!routeLine) {
      const idx = src.toUpperCase().lastIndexOf("ROUTE:");
      if (idx >= 0) {
        routeLine = String(src.slice(idx).split(/\r?\n/)[0] || "").trim();
      }
    }
    if (!routeLine) return null;

    const after = routeLine.replace(/^ROUTE\s*:\s*/i, "").trim();
    const start = after.indexOf("{");
    const end = after.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) return null;
    const jsonText = after.slice(start, end + 1);

    let obj;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    const decision = String(obj.decision || "").trim();
    const workerId = String(obj.worker_id || "").trim();
    const workdir = String(obj.workdir || "").trim();
    const title = String(obj.title || "").trim();
    const question = String(obj.question || "").trim();
    const tasks = Array.isArray(obj.tasks)
      ? obj.tasks
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          return {
            workerId: String(item.worker_id || "").trim(),
            workdir: String(item.workdir || "").trim(),
            title: String(item.title || "").trim(),
            prompt: String(item.prompt || "").trim(),
          };
        })
        .filter(Boolean)
      : [];
    if (!decision) return null;

    return { decision, workerId, workdir, title, question, tasks, raw: obj };
  }

  async function runRouterDecision(
    chatId,
    userText,
    {
      activeWorkerId = "",
      replyHintWorkerId = "",
      replyContext = null,
      replyThreadContext = null,
      recentHistoryContext = null,
    } = {},
  ) {
    if (!ORCH_ROUTER_ENABLED) return null;
    const workers = listCodexWorkers();
    if (workers.length <= 1) {
      return {
        decision: "use",
        workerId: ORCH_GENERAL_WORKER_ID,
        workdir: "",
        title: "",
        question: "",
        tasks: [],
      };
    }

    const prompt = buildRouterPrompt({
      userText,
      activeWorkerId: String(activeWorkerId || "").trim() || getActiveWorkerForChat(chatId),
      replyHintWorkerId: String(replyHintWorkerId || "").trim(),
      workers,
      cap: ORCH_MAX_CODEX_WORKERS,
      splitEnabled: ORCH_SPLIT_ENABLED,
      splitMaxTasks: ORCH_SPLIT_MAX_TASKS,
      replyContext: replyContext && typeof replyContext === "object" ? replyContext : null,
      replyThreadContext: replyThreadContext && typeof replyThreadContext === "object" ? replyThreadContext : null,
      recentHistoryContext: recentHistoryContext && typeof recentHistoryContext === "object" ? recentHistoryContext : null,
    });

    const outputFile = path.join(OUT_DIR, `router-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const job = {
      id: routerSequence++,
      chatId: "", // router should ignore per-chat model overrides
      text: prompt,
      source: "router",
      kind: "codex",
      workerId: ORCH_GENERAL_WORKER_ID,
      replyStyle: "router",
      resumeSessionId: "",
      model: ORCH_ROUTER_MODEL,
      reasoning: ORCH_ROUTER_REASONING_EFFORT,
      imagePaths: [],
      workdir: String(getCodexWorker(ORCH_GENERAL_WORKER_ID)?.workdir || CODEX_WORKDIR || ROOT).trim() || ROOT,
      replyToMessageId: 0,
      startedAt: Date.now(),
      cancelRequested: false,
      timedOut: false,
      process: null,
      stdoutTail: "",
      stderrTail: "",
      timeoutMs: ORCH_ROUTER_TIMEOUT_MS,
      outputFile,
    };

    await acquireRouterSlot();
    try {
      const result = await runCodexJob(job);
      if (!result || !result.ok) {
        return null;
      }
      return parseRouterOutput(String(result.text || ""));
    } finally {
      releaseRouterSlot();
      try {
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
      } catch {
        // best effort
      }
    }
  }

  function buildWorkerRetireKeyboard() {
    const candidates = listCodexWorkers().filter((w) => w.id !== ORCH_GENERAL_WORKER_ID);
    const rows = [];
    for (const w of candidates) {
      const displayName = String(w.name || "").trim() || String(w.title || "").trim() || w.id;
      const context = String(w.title || "").trim();
      const label = context && context !== displayName ? `${displayName} (${context})` : displayName;
      rows.push([{ text: `Retire ${w.id}: ${label}`, callback_data: `orch_retire:${w.id}` }]);
    }
    rows.push([{ text: "Cancel", callback_data: "orch_retire_cancel" }]);
    return { inline_keyboard: rows };
  }

  function buildUseDecision(workerId, prompt) {
    const wid = String(workerId || "").trim() || ORCH_GENERAL_WORKER_ID;
    const text = String(prompt || "").trim();
    return {
      decision: "use",
      assignments: [{ workerId: wid, prompt: text }],
      question: "",
    };
  }

  async function resolveRouteTask(task, { fallbackWorkerId = "", defaultPrompt = "" } = {}) {
    const fallback = String(fallbackWorkerId || "").trim() || ORCH_GENERAL_WORKER_ID;
    const defaultText = String(defaultPrompt || "").trim();
    const taskPrompt = String(task?.prompt || "").trim() || defaultText;
    const requestedWorkerId = String(task?.workerId || task?.worker_id || "").trim();
    if (requestedWorkerId && hasWorker(requestedWorkerId)) {
      return buildUseDecision(requestedWorkerId, taskPrompt);
    }

    const workdirRaw = String(task?.workdir || "").trim();
    const title = String(task?.title || "").trim();
    if (workdirRaw) {
      const resolved = resolveWorkdirInput(workdirRaw);
      if (!resolved || !fs.existsSync(resolved)) {
        return {
          decision: "ask",
          assignments: [],
          workerId: "",
          question: "I could not find that path on disk. What is the correct local path?",
        };
      }

      const existing = findWorkerByWorkdir(resolved);
      if (existing) {
        return buildUseDecision(existing, taskPrompt);
      }

      const workerCount = listCodexWorkers().length;
      if (workerCount >= ORCH_MAX_CODEX_WORKERS) {
        return {
          decision: "need_retire",
          assignments: [],
          workerId: "",
          workdir: resolved,
          title: title || path.basename(resolved) || "Repo",
        };
      }

      let newId = "";
      try {
        newId = createRepoWorker(resolved, title);
      } catch {
        return {
          decision: "ask",
          assignments: [],
          workerId: "",
          question: "I could not create a new workspace for that path. Can you confirm the path and try again?",
        };
      }
      return buildUseDecision(newId, taskPrompt);
    }

    return buildUseDecision(fallback, taskPrompt);
  }

  async function decideRoutePlanForPrompt(
    chatId,
    userText,
    {
      replyHintWorkerId = "",
      allowSplit = true,
      replyContext = null,
      replyThreadContext = null,
      recentHistoryContext = null,
    } = {},
  ) {
    const text = String(userText || "").trim();
    const activeWorkerId = getActiveWorkerForChat(chatId);
    const replyHint = String(replyHintWorkerId || "").trim();
    const fallback = replyHint && hasWorker(replyHint) ? replyHint : activeWorkerId || ORCH_GENERAL_WORKER_ID;

    const route = await runRouterDecision(chatId, text, {
      activeWorkerId,
      replyHintWorkerId: replyHint,
      replyContext,
      replyThreadContext,
      recentHistoryContext,
    }).catch(() => null);
    if (!route) {
      return buildUseDecision(fallback, text);
    }

    const decision = String(route.decision || "").trim().toLowerCase();
    if (decision === "ask") {
      const q = String(route.question || "").trim();
      return {
        decision: "ask",
        assignments: [],
        workerId: "",
        question: q || "Which workspace should I use for this?",
      };
    }

    if (decision === "use") {
      const resolved = await resolveRouteTask(
        { workerId: String(route.workerId || "").trim(), prompt: text },
        { fallbackWorkerId: fallback, defaultPrompt: text },
      );
      return resolved;
    }

    if (decision === "spawn_repo") {
      const workdirRaw = String(route.workdir || "").trim();
      if (!workdirRaw) {
        return {
          decision: "ask",
          assignments: [],
          workerId: "",
          question: "What is the local path to the repo/workspace?",
        };
      }
      const resolved = await resolveRouteTask(
        {
          workdir: workdirRaw,
          title: String(route.title || "").trim(),
          prompt: text,
        },
        { fallbackWorkerId: fallback, defaultPrompt: text },
      );
      if (resolved.decision === "ask" && !resolved.question) {
        return {
          decision: "ask",
          assignments: [],
          workerId: "",
          question: "What is the local path to the repo/workspace?",
        };
      }
      return resolved;
    }

    if (decision === "split" && allowSplit && ORCH_SPLIT_ENABLED) {
      const rawTasks = Array.isArray(route.tasks) ? route.tasks : [];
      const limitedTasks = rawTasks.slice(0, ORCH_SPLIT_MAX_TASKS);
      const assignments = [];

      for (const task of limitedTasks) {
        const resolved = await resolveRouteTask(task, { fallbackWorkerId: fallback, defaultPrompt: text });
        if (resolved.decision === "ask" || resolved.decision === "need_retire") return resolved;
        if (resolved.decision !== "use") continue;
        for (const assignment of Array.isArray(resolved.assignments) ? resolved.assignments : []) {
          assignments.push(assignment);
        }
      }

      const deduped = dedupeRouteAssignments(assignments);
      if (deduped.length >= 2) {
        return {
          decision: "split",
          assignments: deduped,
          workerId: "",
          question: "",
        };
      }
      if (deduped.length === 1) {
        return {
          decision: "use",
          assignments: deduped,
          workerId: deduped[0].workerId,
          question: "",
        };
      }
    }

    // Unknown or unusable router output; fall back.
    return buildUseDecision(fallback, text);
  }

  async function routeAndEnqueuePrompt(chatId, userText, source, options = {}) {
    const replyToMessageId = Number(options?.replyToMessageId || 0);
    const replyHintWorkerId = String(options?.replyHintWorkerId || "").trim();
    const replyContext = options?.replyContext && typeof options.replyContext === "object"
      ? options.replyContext
      : null;
    const replyThreadContext = options?.replyThreadContext && typeof options.replyThreadContext === "object"
      ? options.replyThreadContext
      : null;
    const recentHistoryContext = options?.recentHistoryContext && typeof options.recentHistoryContext === "object"
      ? options.recentHistoryContext
      : null;
    const originMessageId = Number(options?.originMessageId || 0);
    const originSource = String(options?.originSource || "").trim();
    const originSnippet = String(options?.originSnippet || "").trim();
    const src = String(source || "").trim().toLowerCase();
    const allowSplit = src !== "voice" && src !== "whisper";
    const decision = await decideRoutePlanForPrompt(chatId, userText, {
      replyHintWorkerId,
      allowSplit,
      replyContext,
      replyThreadContext,
      recentHistoryContext,
    });

    if (decision.decision === "ask") {
      await sendMessage(chatId, decision.question || "Which workspace should I use?", {
        replyToMessageId,
      });
      return false;
    }

    if (decision.decision === "need_retire") {
      const workdir = String(decision.workdir || "").trim();
      const title = String(decision.title || "").trim();
      orchPendingSpawnByChat.set(String(chatId || "").trim(), {
        desiredWorkdir: workdir,
        title,
        promptText: String(userText || ""),
        source: String(source || "").trim(),
        options: { ...options },
        createdAt: Date.now(),
      });

      await sendMessage(
        chatId,
        `Worker limit reached (${ORCH_MAX_CODEX_WORKERS}). Pick a worker to retire so I can create a new workspace for:\n- title: ${title}\n- workdir: ${String(workdir || "").replace(/\\\\/g, "/")}`,
        {
          replyToMessageId,
          replyMarkup: buildWorkerRetireKeyboard(),
        },
      );
      return false;
    }

    const assignmentsRaw = Array.isArray(decision.assignments) ? decision.assignments : [];
    const assignments = dedupeRouteAssignments(assignmentsRaw);
    if (assignments.length === 0) {
      const fallbackWorkerId = getActiveWorkerForChat(chatId) || ORCH_GENERAL_WORKER_ID;
      assignments.push({ workerId: fallbackWorkerId, prompt: String(userText || "").trim() });
    }

    if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() + assignments.length > MAX_QUEUE_SIZE) {
      await sendMessage(
        chatId,
        `Queue is full (${MAX_QUEUE_SIZE}). Need room for ${assignments.length} job(s). Use /queue or /clear.`,
        { replyToMessageId },
      );
      return false;
    }

    const splitGroupId = assignments.length > 1
      ? `split-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : "";
    const assignmentsWithTasks = assignments.map((assignment) => {
      const workerId = String(assignment.workerId || "").trim();
      const prompt = String(assignment.prompt || "").trim();
      const taskId = createOrchTask(chatId, {
        workerId,
        prompt,
        source: src || "message",
        originMessageId,
        replyToMessageId,
        splitGroupId,
      });
      return {
        ...assignment,
        workerId,
        prompt,
        taskId,
      };
    });

    if (Number.isFinite(originMessageId) && originMessageId > 0 && assignmentsWithTasks.length > 0) {
      const primaryWorkerId = String(assignmentsWithTasks[0]?.workerId || "").trim();
      const primaryTaskId = Number(assignmentsWithTasks[0]?.taskId || 0);
      const snippet = originSnippet || String(userText || "").trim();
      if (primaryWorkerId) {
        recordReplyRoute(chatId, originMessageId, primaryWorkerId, {
          source: originSource || `user-${src || "message"}`,
          snippet,
          taskId: Number.isFinite(primaryTaskId) && primaryTaskId > 0 ? Math.trunc(primaryTaskId) : 0,
          taskLinks: assignmentsWithTasks.map((x) => ({
            taskId: Number(x.taskId || 0),
            workerId: String(x.workerId || "").trim(),
            sessionId: String(getSessionForChatWorker(chatId, String(x.workerId || "").trim()) || "").trim(),
          })),
        });
      }
    }

    if (ORCH_DELEGATION_ACK_ENABLED) {
      const ackStateSummary = summarizeDelegationQueueState(assignmentsWithTasks);
      const ackText = buildDelegationAckText(assignmentsWithTasks, ackStateSummary);
      if (ackText) {
        const ackWorkerId = assignmentsWithTasks.length === 1 ? String(assignmentsWithTasks[0].workerId || "").trim() : "";
        try {
          await sendMessage(chatId, ackText, {
            replyToMessageId,
            routeWorkerId: ackWorkerId,
            silent: ORCH_DELEGATION_ACK_SILENT,
          });
        } catch (err) {
          log(`sendMessage(delegation-ack) failed: ${redactError(err?.message || err)}`);
        }
      }
    }

    for (const assignment of assignmentsWithTasks) {
      await enqueuePrompt(chatId, assignment.prompt, source, {
        ...options,
        replyContext,
        replyThreadContext,
        recentHistoryContext,
        workerId: assignment.workerId,
        taskId: Number(assignment.taskId || 0),
        splitGroupId,
        originMessageId,
        originSource,
        originSnippet: originSnippet || String(userText || "").trim(),
        replyToMessageId,
        // Don't flip active workspace when one user request fans out to multiple workers.
        setActiveWorker: assignmentsWithTasks.length > 1 ? false : options?.setActiveWorker,
      });
    }
    return true;
  }

  return {
    dedupeRouteAssignments,
    summarizeDelegationQueueState,
    buildDelegationAckText,
    decideRoutePlanForPrompt,
    routeAndEnqueuePrompt,
  };
}

module.exports = {
  createOrchRouterRuntime,
};
