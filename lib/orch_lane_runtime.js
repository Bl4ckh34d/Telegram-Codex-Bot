"use strict";

function createOrchLaneRuntime(deps = {}) {
  const {
    path,
    OUT_DIR,
    ORCH_GENERAL_WORKER_ID,
    MAX_QUEUE_SIZE,
    TELEGRAM_CHAT_ACTION_ENABLED,
    TELEGRAM_CHAT_ACTION_DEFAULT,
    TELEGRAM_CHAT_ACTION_VOICE,
    TELEGRAM_CHAT_ACTION_INTERVAL_SEC,
    PROGRESS_UPDATES_ENABLED,
    PROGRESS_INCLUDE_STDERR,
    PROGRESS_FIRST_UPDATE_SEC,
    PROGRESS_UPDATE_INTERVAL_SEC,
    TTS_REPLY_TO_VOICE,
    TTS_ENABLED,
    WORLDMONITOR_ALERT_VOICE_ENABLED,
    WORLDMONITOR_CHECK_VOICE_ENABLED,
    takeNextJobId,
    getShuttingDown,
    sendMessage,
    sendChatAction,
    log,
    redactError,
    getActiveWorkerForChat,
    setActiveWorkerForChat,
    ensureWorkerLane,
    ensureTtsLane,
    totalQueuedJobs,
    touchWorker,
    refreshLaneWorkdir,
    normalizePrompt,
    getActiveSessionForChat,
    createOrchTask,
    normalizeTtsText,
    resolveTtsPresetForChat,
    getLane,
    markOrchTaskRunning,
    runRawCodexJob,
    runTtsJob,
    runTtsBatchJob,
    runWhisperJob,
    runCodexJob,
    setSessionForChatWorker,
    rememberOrchFailureLesson,
    getSessionForChatWorker,
    extractAttachDirectives,
    injectForcedTextOnlySection,
    splitVoiceReplyParts,
    makeSpeakableTextForTts,
    makeWorldMonitorTextTtsFriendly,
    makeWorldMonitorCheckVoiceSummary,
    splitSpeakableTextIntoVoiceChunks,
    extractNonSpeakableInfo,
    normalizeResponse,
    sendAttachments,
    markOrchTaskCompleted,
    maybeTriggerPendingRestart,
    truncateLine,
    isProgressNoiseLine,
  } = deps;

  function nextJobId() {
    if (typeof takeNextJobId === "function") {
      const id = Number(takeNextJobId());
      if (Number.isFinite(id) && id > 0) return Math.trunc(id);
    }
    return Date.now();
  }

  async function enqueueRawCodexCommand(chatId, args, source = "cmd", options = {}) {
    const tokens = Array.isArray(args) ? [...args] : [];
    if (tokens.length === 0) {
      await sendMessage(chatId, "No AIDOLON command to run.");
      return;
    }

    const requestedWorkerId = String(options?.workerId || "").trim();
    const workerId = requestedWorkerId || getActiveWorkerForChat(chatId);
    const lane = ensureWorkerLane(workerId) || ensureWorkerLane(ORCH_GENERAL_WORKER_ID);
    if (!lane) {
      await sendMessage(chatId, "No available worker to run this command.");
      return;
    }

    if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
      await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
      return;
    }

    if (options?.setActiveWorker !== false) {
      setActiveWorkerForChat(chatId, lane.id);
    }
    touchWorker(lane.id);
    const laneWorkdir = refreshLaneWorkdir(lane, { logPrefix: "[enqueue]" });

    const job = {
      id: nextJobId(),
      chatId,
      source,
      kind: "raw",
      workerId: lane.id,
      rawArgs: tokens,
      resumeSessionId: "",
      text: "",
      workdir: laneWorkdir,
      replyToMessageId: Number(options?.replyToMessageId || 0),
      startedAt: 0,
      cancelRequested: false,
      timedOut: false,
      process: null,
      stdoutTail: "",
      stderrTail: "",
      outputFile: "",
    };

    lane.queue.push(job);
    void processLane(lane.id);
  }

  async function enqueuePrompt(chatId, inputText, source, options = {}) {
    const text = normalizePrompt(inputText);
    if (!text) {
      await sendMessage(chatId, "Empty prompt ignored.");
      return;
    }

    const requestedWorkerId = String(options?.workerId || "").trim();
    const workerId = requestedWorkerId || getActiveWorkerForChat(chatId);
    const lane = ensureWorkerLane(workerId) || ensureWorkerLane(ORCH_GENERAL_WORKER_ID);
    if (!lane) {
      await sendMessage(chatId, "No available worker to handle this prompt.");
      return;
    }

    if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
      await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
      return;
    }

    if (options?.setActiveWorker !== false) {
      setActiveWorkerForChat(chatId, lane.id);
    }
    touchWorker(lane.id);
    const laneWorkdir = refreshLaneWorkdir(lane, { logPrefix: "[enqueue]" });

    const resumeSessionId = Object.prototype.hasOwnProperty.call(options || {}, "resumeSessionId")
      ? String(options.resumeSessionId || "").trim()
      : getActiveSessionForChat(chatId, lane.id);
    let taskId = Number(options?.taskId || 0);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      taskId = createOrchTask(chatId, {
        workerId: lane.id,
        prompt: text,
        source: String(source || "").trim().toLowerCase(),
        originMessageId: Number(options?.originMessageId || options?.replyToMessageId || 0),
        replyToMessageId: Number(options?.replyToMessageId || 0),
        splitGroupId: String(options?.splitGroupId || "").trim(),
      });
    }

    const job = {
      id: nextJobId(),
      chatId,
      text,
      source,
      kind: "codex",
      workerId: lane.id,
      replyStyle: String(options.replyStyle || "").trim(),
      resumeSessionId,
      model: String(options.model || "").trim(),
      reasoning: String(options.reasoning || "").trim(),
      imagePaths: Array.isArray(options.imagePaths)
        ? options.imagePaths.map((p) => String(p || "").trim()).filter(Boolean)
        : [],
      replyContext: options?.replyContext && typeof options.replyContext === "object"
        ? { ...options.replyContext }
        : null,
      replyThreadContext: options?.replyThreadContext && typeof options.replyThreadContext === "object"
        ? { ...options.replyThreadContext }
        : null,
      recentHistoryContext: options?.recentHistoryContext && typeof options.recentHistoryContext === "object"
        ? { ...options.recentHistoryContext }
        : null,
      workdir: laneWorkdir,
      taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
      splitGroupId: String(options?.splitGroupId || "").trim(),
      replyToMessageId: Number(options?.replyToMessageId || 0),
      startedAt: 0,
      cancelRequested: false,
      timedOut: false,
      process: null,
      stdoutTail: "",
      stderrTail: "",
      outputFile: path.join(OUT_DIR, `codex-job-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
      forcedTextOnly: String(options.forcedTextOnly || "").trim(),
      onSuccess: typeof options.onSuccess === "function" ? options.onSuccess : null,
    };

    lane.queue.push(job);
    void processLane(lane.id);
  }

  function enqueueTtsLaneJob(lane, job) {
    if (!lane || !Array.isArray(lane.queue)) return;
    const source = String(job?.source || "").trim().toLowerCase();
    if (source !== "voice-reply" || lane.queue.length === 0) {
      lane.queue.push(job);
      return;
    }

    // Prioritize auto voice replies ahead of non-voice-reply TTS jobs to improve perceived responsiveness.
    let insertAt = lane.queue.length;
    for (let i = 0; i < lane.queue.length; i += 1) {
      const queuedSource = String(lane.queue[i]?.source || "").trim().toLowerCase();
      if (queuedSource !== "voice-reply") {
        insertAt = i;
        break;
      }
    }
    lane.queue.splice(insertAt, 0, job);
  }

  async function enqueueTts(chatId, inputText, source, options = {}) {
    const text = normalizeTtsText(inputText);
    if (!text) {
      await sendMessage(chatId, "Empty TTS text ignored.");
      return false;
    }

    const lane = ensureTtsLane();
    if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
      await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
      return false;
    }

    const workerId = String(options?.workerId || "").trim() || getActiveWorkerForChat(chatId);
    const ttsPreset = resolveTtsPresetForChat(chatId, options?.ttsPreset || "");
    const job = {
      id: nextJobId(),
      chatId,
      text,
      source,
      kind: "tts",
      ttsPreset,
      workerId,
      afterText: String(options.afterText || "").trim(),
      skipResultText: options.skipResultText === true,
      voiceCaption: String(options.voiceCaption || "").trim(),
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      replyToMessageId: Number(options?.replyToMessageId || 0),
      taskId: Number(options?.routeTaskId || 0),
      routeSessionId: String(options?.routeSessionId || "").trim(),
      startedAt: 0,
      cancelRequested: false,
      timedOut: false,
      process: null,
      stdoutTail: "",
      stderrTail: "",
    };

    enqueueTtsLaneJob(lane, job);
    void processLane(lane.id);
    return true;
  }

  async function enqueueTtsBatch(chatId, inputTexts, source, options = {}) {
    const raw = Array.isArray(inputTexts) ? inputTexts : [];
    const texts = raw.map((t) => normalizeTtsText(t)).filter(Boolean);
    if (texts.length === 0) {
      await sendMessage(chatId, "Empty TTS text ignored.");
      return false;
    }

    const lane = ensureTtsLane();
    if (MAX_QUEUE_SIZE > 0 && totalQueuedJobs() >= MAX_QUEUE_SIZE) {
      await sendMessage(chatId, `Queue is full (${MAX_QUEUE_SIZE}). Use /queue or /clear.`);
      return false;
    }

    const workerId = String(options?.workerId || "").trim() || getActiveWorkerForChat(chatId);
    const ttsPreset = resolveTtsPresetForChat(chatId, options?.ttsPreset || "");
    const job = {
      id: nextJobId(),
      chatId,
      texts,
      source,
      kind: "tts-batch",
      ttsPreset,
      workerId,
      afterText: String(options.afterText || "").trim(),
      skipResultText: options.skipResultText === true,
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      replyToMessageId: Number(options?.replyToMessageId || 0),
      taskId: Number(options?.routeTaskId || 0),
      routeSessionId: String(options?.routeSessionId || "").trim(),
      startedAt: 0,
      cancelRequested: false,
      timedOut: false,
      process: null,
      stdoutTail: "",
      stderrTail: "",
    };

    enqueueTtsLaneJob(lane, job);
    void processLane(lane.id);
    return true;
  }

  function pickChatActionForJob(job) {
    const kind = String(job?.kind || "").trim().toLowerCase();
    const source = String(job?.source || "").trim().toLowerCase();
    if (
      kind === "tts" ||
      kind === "tts-batch" ||
      source === "voice-reply" ||
      source === "tts-batch-chunk"
    ) {
      return TELEGRAM_CHAT_ACTION_VOICE;
    }
    return TELEGRAM_CHAT_ACTION_DEFAULT;
  }

  function startJobChatActionKeepalive(job, lane) {
    if (!TELEGRAM_CHAT_ACTION_ENABLED) {
      return () => {};
    }

    const chatId = String(job?.chatId || "").trim();
    if (!chatId) {
      return () => {};
    }

    const action = pickChatActionForJob(job);
    const intervalMs = Math.max(1000, Math.trunc(Number(TELEGRAM_CHAT_ACTION_INTERVAL_SEC) || 4) * 1000);
    let stopped = false;
    let timer = null;
    let loggedError = false;

    const tick = async () => {
      if (stopped || getShuttingDown() || lane?.currentJob !== job) return;

      const ok = await sendChatAction(chatId, action, { logErrors: !loggedError });
      if (!ok) loggedError = true;

      if (stopped || getShuttingDown() || lane?.currentJob !== job) return;
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, intervalMs);
    };

    void tick();

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  function startJobProgressUpdates(job, lane) {
    if (!PROGRESS_UPDATES_ENABLED) {
      return () => {};
    }
    // TTS jobs are intentionally noisy (model load, encode, ffmpeg). Don't stream that into Telegram.
    if (String(job?.kind || "") === "tts" || String(job?.kind || "") === "tts-batch") {
      return () => {};
    }
    // Whisper transcription is also noisy and not useful as progress messages.
    if (String(job?.kind || "") === "whisper") {
      return () => {};
    }
    // For voice-note prompts that will be answered via voice notes, avoid sending text "progress" pings.
    // Those pings are output-driven and can leak reply markers/content into the chat.
    if (String(job?.source || "") === "voice" && TTS_REPLY_TO_VOICE && TTS_ENABLED) {
      return () => {};
    }
    // Vision command paths can emit temporary progress chatter that is not useful in chat.
    const source = String(job?.source || "").trim().toLowerCase();
    if (source === "see-screenshot" || source === "ask-image" || source === "image-caption") {
      return () => {};
    }

    let stopped = false;
    let timer = null;

    job.progressStdoutRemainder = "";
    job.progressStderrRemainder = "";
    job.progressPendingLine = "";
    job.progressLastSentLine = "";
    job.progressLastSentAt = 0;

    const debounceMs = 250;

    const flush = async () => {
      if (stopped || getShuttingDown() || lane?.currentJob !== job) return;
      const line = String(job.progressPendingLine || "").trim();
      if (!line) return;
      if (line === String(job.progressLastSentLine || "")) return;

      job.progressPendingLine = "";
      job.progressLastSentLine = line;
      job.progressLastSentAt = Date.now();

      try {
        await sendMessage(job.chatId, line, {
          silent: true,
          replyToMessageId: job.replyToMessageId,
          routeWorkerId: job.workerId,
          routeTaskId: Number(job?.taskId || 0),
          routeSessionId: String(job?.routeSessionId || getSessionForChatWorker(job.chatId, job.workerId) || "").trim(),
        });
      } catch (err) {
        log(`sendMessage(progress) failed: ${redactError(err.message || err)}`);
      }

      if (job.progressPendingLine) {
        schedule();
      }
    };

    const schedule = () => {
      if (stopped || getShuttingDown() || lane?.currentJob !== job) return;
      if (timer) return;
      if (!job.progressPendingLine) return;

      const now = Date.now();
      const gateAt = job.startedAt + Math.max(0, PROGRESS_FIRST_UPDATE_SEC) * 1000;
      const throttleAt = Number(job.progressLastSentAt || 0) + Math.max(0, PROGRESS_UPDATE_INTERVAL_SEC) * 1000;
      const earliestAt = Math.max(gateAt, throttleAt, now + debounceMs);
      const waitMs = Math.max(0, earliestAt - now);

      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, waitMs);
    };

    const ingest = (chunkText, streamName) => {
      if (stopped || getShuttingDown() || lane?.currentJob !== job) return;
      // Forwarding stderr into Telegram tends to produce spammy log lines. Keep it opt-in.
      if (String(streamName || "") === "stderr" && !PROGRESS_INCLUDE_STDERR) return;
      const chunk = String(chunkText || "");
      if (!chunk) return;

      const key = streamName === "stderr" ? "progressStderrRemainder" : "progressStdoutRemainder";
      const prev = String(job[key] || "");
      const combined = `${prev}${chunk}`.replace(/\r/g, "");
      const parts = combined.split("\n");
      let remainder = parts.pop() ?? "";
      if (remainder.length > 10_000) remainder = remainder.slice(-10_000);
      job[key] = remainder;

      for (const rawLine of parts) {
        const line = String(rawLine || "").trim();
        if (!line) continue;
        if (isProgressNoiseLine(line)) continue;
        job.progressPendingLine = truncateLine(line, 3500);
      }

      schedule();
    };

    job.onProgressChunk = ingest;

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      job.onProgressChunk = null;
    };
  }

  async function processLane(laneId) {
    const lane = getLane(laneId);
    if (!lane || getShuttingDown()) return;
    if (lane.currentJob) return;

    while (Array.isArray(lane.queue) && lane.queue.length > 0 && !getShuttingDown()) {
      const job = lane.queue.shift();
      lane.currentJob = job;
      job.startedAt = Date.now();
      markOrchTaskRunning(job);
      // Allow cancellation to abort in-flight fetch() operations (Telegram uploads).
      job.abortController = new AbortController();
      const stopChatActionKeepalive = startJobChatActionKeepalive(job, lane);
      const stopProgressUpdates = startJobProgressUpdates(job, lane);

      let result;
      try {
        try {
          result = job.kind === "raw"
            ? await runRawCodexJob(job)
            : job.kind === "tts"
              ? await runTtsJob(job, lane)
              : job.kind === "tts-batch"
                ? await runTtsBatchJob(job, lane)
                : job.kind === "whisper"
                  ? await runWhisperJob(job, lane)
                  : await runCodexJob(job);
        } catch (err) {
          const msg = String(err?.message || err || "").trim() || "Unknown error";
          result = { ok: false, text: `Job #${job.id} failed unexpectedly: ${msg}` };
        }
      } finally {
        stopProgressUpdates();
      }

      if (result && result.ok) {
        const resolvedSessionId = String(result.sessionId || job.resumeSessionId || "").trim();
        if (resolvedSessionId) {
          const wid = String(job?.workerId || "").trim() || String(lane.id || "").trim() || ORCH_GENERAL_WORKER_ID;
          setSessionForChatWorker(job.chatId, wid, resolvedSessionId);
        }
        if (typeof job?.onSuccess === "function") {
          try {
            await job.onSuccess(result, job);
          } catch (err) {
            log(`job.onSuccess failed for #${job.id}: ${redactError(err?.message || err)}`);
          }
        }
      }
      if (result && !result.ok && !job?.cancelRequested) {
        try {
          rememberOrchFailureLesson(job, result);
        } catch (err) {
          log(`rememberOrchFailureLesson failed for #${job.id}: ${redactError(err?.message || err)}`);
        }
      }

      let emittedMessageIds = [];
      let resolvedSessionIdForTask = "";
      try {
        const routeWorkerId = String(job?.workerId || "").trim() || String(lane.id || "").trim();
        const routeTaskId = Number(job?.taskId || 0);
        const replyToMessageId = Number(job?.replyToMessageId || 0);
        const resolvedSessionId = String(
          result?.sessionId ||
            getSessionForChatWorker(job.chatId, routeWorkerId) ||
            job?.resumeSessionId ||
            "",
        ).trim();
        resolvedSessionIdForTask = resolvedSessionId;
        const collectSentMessageIds = (value) => {
          for (const item of Array.isArray(value) ? value : [value]) {
            const id = Number(item?.message_id || 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            emittedMessageIds.push(Math.trunc(id));
          }
        };

        const attachParsed = extractAttachDirectives(String(result?.text || ""));
        const attachments = Array.isArray(attachParsed.attachments) ? attachParsed.attachments : [];
        const resultAfterText = String(result?.afterText || "").trim();
        const resultAttachments = Array.isArray(result?.attachments) ? result.attachments : [];
        const allAttachments = [...attachments, ...resultAttachments];
        if (result && typeof result === "object") {
          result.text = attachParsed.text;
        }
        const forcedTextOnly = String(job?.forcedTextOnly || "").trim();
        const hasForcedTextOnly = Boolean(forcedTextOnly);
        if (hasForcedTextOnly && result && typeof result === "object") {
          result.text = injectForcedTextOnlySection(String(result.text || ""), forcedTextOnly);
        }

        const shouldVoiceReply = Boolean(
          result?.ok &&
            job?.kind !== "tts" &&
            job?.kind !== "tts-batch" &&
            (
              (String(job?.source || "") === "voice" && TTS_REPLY_TO_VOICE) ||
              (String(job?.source || "") === "worldmonitor-monitor" && WORLDMONITOR_ALERT_VOICE_ENABLED) ||
              (String(job?.source || "") === "worldmonitor-check" && WORLDMONITOR_CHECK_VOICE_ENABLED)
            ) &&
            TTS_ENABLED &&
            String(result?.text || "").trim(),
        );

        const isWorldMonitorAlertJob = String(job?.source || "") === "worldmonitor-monitor";
        const isWorldMonitorCheckJob = String(job?.source || "") === "worldmonitor-check";
        let voiceQueued = false;
        let voiceReplyReadyText = "";
        if (shouldVoiceReply) {
          try {
            let voiceInput = String(result.text || "");
            if (isWorldMonitorCheckJob) {
              voiceInput = makeWorldMonitorCheckVoiceSummary(voiceInput);
            }
            const parts = splitVoiceReplyParts(voiceInput);
            const spokenRaw = makeSpeakableTextForTts(parts.spoken || voiceInput);
            const spoken = (isWorldMonitorAlertJob || isWorldMonitorCheckJob)
              ? makeWorldMonitorTextTtsFriendly(spokenRaw)
              : spokenRaw;
            const { chunks: spokenChunks, overflowText } = splitSpeakableTextIntoVoiceChunks(spoken);
            const modelTextOnly = String(parts.textOnly || "").trim();
            const preferredTextOnly = hasForcedTextOnly ? forcedTextOnly : modelTextOnly;
            const extracted = preferredTextOnly ? "" : extractNonSpeakableInfo(String(result.text || ""));
            let afterText = preferredTextOnly || (extracted ? `Text-only details:\n${extracted}` : "");
            if (overflowText) {
              const moved = `Moved from SPOKEN (too long for voice notes):\n${overflowText}`;
              afterText = afterText ? `${afterText}\n\n${moved}` : moved;
            }

            const chunks = spokenChunks.length > 0 ? spokenChunks : (spoken ? [spoken] : []);
            const queued = chunks.length > 1
              ? await enqueueTtsBatch(job.chatId, chunks, "voice-reply", {
                // Send text/attachments from the main job path so they do not wait for TTS.
                afterText: "",
                // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
                skipResultText: true,
                attachments: [],
                workerId: routeWorkerId,
                replyToMessageId,
                routeTaskId,
                routeSessionId: resolvedSessionId,
              })
              : await enqueueTts(job.chatId, chunks[0] || spoken, "voice-reply", {
                // Send text/attachments from the main job path so they do not wait for TTS.
                afterText: "",
                // Even if TTS_SEND_TEXT=1 globally, don't duplicate the spoken content for voice replies.
                skipResultText: true,
                attachments: [],
                workerId: routeWorkerId,
                replyToMessageId,
                routeTaskId,
                routeSessionId: resolvedSessionId,
              });
            voiceQueued = Boolean(queued);
            if (voiceQueued) {
              voiceReplyReadyText = afterText;
            }
          } catch (err) {
            // If voice enqueue fails, fall back to sending text so the user still gets an answer.
            log(`enqueueTts(voice-reply) failed: ${redactError(err?.message || err)}`);
            voiceQueued = false;
          }
        }

        const shouldSuppressResultTextForQueuedVoice = shouldVoiceReply
          && voiceQueued
          && !isWorldMonitorAlertJob
          && !isWorldMonitorCheckJob;
        const shouldSendForcedTextOnly = hasForcedTextOnly && !shouldVoiceReply;
        if (!result || (result.skipSendMessage !== true && !shouldSuppressResultTextForQueuedVoice)) {
          try {
            const responseText = shouldSendForcedTextOnly
              ? forcedTextOnly
              : normalizeResponse(result?.text);
            const sent = await sendMessage(job.chatId, responseText, {
              replyToMessageId,
              routeWorkerId,
              routeTaskId,
              routeSessionId: resolvedSessionId,
            });
            collectSentMessageIds(sent);
          } catch (err) {
            log(`sendMessage(result) failed: ${redactError(err.message || err)}`);
          }
        }

        const combinedAfterText = [voiceReplyReadyText, resultAfterText].filter(Boolean).join("\n\n").trim();
        if (combinedAfterText) {
          try {
            const sent = await sendMessage(job.chatId, combinedAfterText, {
              replyToMessageId,
              routeWorkerId,
              routeTaskId,
              routeSessionId: resolvedSessionId,
            });
            collectSentMessageIds(sent);
          } catch (err) {
            log(`sendMessage(afterText) failed: ${redactError(err?.message || err)}`);
          }
        }

        // Send attachments from the main job path so they are not blocked on TTS generation.
        if (allAttachments.length > 0) {
          try {
            const sent = await sendAttachments(job.chatId, allAttachments, {
              replyToMessageId,
              routeWorkerId,
              routeTaskId,
              routeSessionId: resolvedSessionId,
            });
            collectSentMessageIds(sent);
          } catch (err) {
            log(`sendAttachments(result) failed: ${redactError(err?.message || err)}`);
          }
        }
      } catch (err) {
        log(`processLane(post) failed: ${redactError(err?.message || err)}`);
      } finally {
        markOrchTaskCompleted(job, result, {
          sessionId: resolvedSessionIdForTask,
          outputMessageIds: [...new Set(emittedMessageIds)],
        });
        stopChatActionKeepalive();
        lane.currentJob = null;
        void maybeTriggerPendingRestart("job completion");
      }
    }
  }

  return {
    enqueueRawCodexCommand,
    enqueuePrompt,
    enqueueTts,
    enqueueTtsBatch,
    processLane,
  };
}

module.exports = {
  createOrchLaneRuntime,
};
