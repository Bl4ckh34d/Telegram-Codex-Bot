"use strict";

function createOrchReplyContextRuntime(deps = {}) {
  const {
    orchWorkers,
    orchReplyRouteByChat,
    orchMessageMetaByChat,
    ORCH_MESSAGE_META_MAX_PER_CHAT,
    ORCH_MESSAGE_META_TTL_DAYS,
    ORCH_THREAD_CONTEXT_MAX_DEPTH,
    ORCH_THREAD_CONTEXT_MAX_CHARS,
    ORCH_RECENT_CONTEXT_MESSAGES,
    ORCH_RECENT_CONTEXT_MAX_CHARS,
    persistState,
    normalizeReplySnippet,
    senderLabel,
  } = deps;

  const workers = orchWorkers && typeof orchWorkers === "object" ? orchWorkers : {};
  const replyRouteByChat = orchReplyRouteByChat && typeof orchReplyRouteByChat === "object"
    ? orchReplyRouteByChat
    : {};
  const messageMetaByChat = orchMessageMetaByChat && typeof orchMessageMetaByChat === "object"
    ? orchMessageMetaByChat
    : {};

  const normalizeSnippet = typeof normalizeReplySnippet === "function"
    ? normalizeReplySnippet
    : (text) => String(text || "").trim();
  const labelSender = typeof senderLabel === "function"
    ? senderLabel
    : () => "unknown";
  const persist = typeof persistState === "function"
    ? persistState
    : () => {};

  function normalizeTaskLinks(rawValue) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(rawValue) ? rawValue : []) {
      if (!item || typeof item !== "object") continue;
      const taskIdNum = Number(item.taskId || item.task_id || 0);
      const taskId = Number.isFinite(taskIdNum) && taskIdNum > 0 ? Math.trunc(taskIdNum) : 0;
      const workerId = String(item.workerId || item.worker_id || "").trim();
      const sessionId = String(item.sessionId || item.session_id || "").trim();
      if (!taskId && !workerId) continue;
      const key = `${taskId}|${workerId}|${sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = {};
      if (taskId) entry.taskId = taskId;
      if (workerId) entry.workerId = workerId;
      if (sessionId) entry.sessionId = sessionId;
      out.push(entry);
    }
    return out;
  }

  function mergeTaskLinks(a, b) {
    return normalizeTaskLinks([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  }

  function ensureMessageMetaEntryForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return null;
    const current = messageMetaByChat[key];
    if (current && typeof current === "object") return current;
    const next = {};
    messageMetaByChat[key] = next;
    return next;
  }

  function pruneMessageMetaForChat(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return;
    const entry = messageMetaByChat[key];
    if (!entry || typeof entry !== "object") return;
    const rows = Object.entries(entry);
    if (rows.length === 0) return;

    const ttlDays = Math.max(1, Number(ORCH_MESSAGE_META_TTL_DAYS) || 1);
    const maxPerChat = Math.max(1, Number(ORCH_MESSAGE_META_MAX_PER_CHAT) || 1);
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    rows.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));

    const next = {};
    let kept = 0;
    for (const [messageId, meta] of rows) {
      if (kept >= maxPerChat) break;
      const at = Number(meta?.at || 0);
      if (Number.isFinite(at) && at > 0 && at < cutoff) continue;
      next[messageId] = meta;
      kept += 1;
    }
    messageMetaByChat[key] = next;
  }

  function getMessageMetaEntry(chatId, messageId) {
    const key = String(chatId || "").trim();
    const id = String(messageId || "").trim();
    if (!key || !id) return null;
    const entry = messageMetaByChat[key];
    if (!entry || typeof entry !== "object") return null;
    const hit = entry[id];
    return hit && typeof hit === "object" ? hit : null;
  }

  function recordMessageMeta(chatId, messageId, context = {}, { persist: shouldPersist = true } = {}) {
    const key = String(chatId || "").trim();
    const idNum = Number(messageId || 0);
    if (!key || !Number.isFinite(idNum) || idNum <= 0) return null;
    const id = String(Math.trunc(idNum));
    const byChat = ensureMessageMetaEntryForChat(key);
    if (!byChat) return null;
    const prev = byChat[id] && typeof byChat[id] === "object" ? byChat[id] : {};
    const now = Date.now();
    const next = { ...prev };

    next.messageId = Math.trunc(idNum);
    next.at = now;

    if (Object.prototype.hasOwnProperty.call(context, "parentMessageId")) {
      const parentNum = Number(context.parentMessageId || 0);
      next.parentMessageId = Number.isFinite(parentNum) && parentNum > 0 ? Math.trunc(parentNum) : 0;
    } else if (!Number.isFinite(Number(next.parentMessageId || 0))) {
      next.parentMessageId = 0;
    }

    if (Object.prototype.hasOwnProperty.call(context, "source")) {
      const source = String(context.source || "").trim().toLowerCase();
      if (source) next.source = source;
    }

    if (Object.prototype.hasOwnProperty.call(context, "snippet")) {
      const snippet = normalizeSnippet(context.snippet || "");
      if (snippet) next.snippet = snippet;
    }

    if (Object.prototype.hasOwnProperty.call(context, "from")) {
      const from = String(context.from || "").trim();
      if (from) next.from = from;
    }

    if (Object.prototype.hasOwnProperty.call(context, "fromIsBot")) {
      next.fromIsBot = context.fromIsBot === true;
    }

    if (Object.prototype.hasOwnProperty.call(context, "role")) {
      const role = String(context.role || "").trim().toLowerCase();
      if (role) next.role = role;
    }

    if (Object.prototype.hasOwnProperty.call(context, "workerId")) {
      const workerId = String(context.workerId || "").trim();
      if (workerId) next.workerId = workerId;
    }

    if (Object.prototype.hasOwnProperty.call(context, "taskId")) {
      const taskIdNum = Number(context.taskId || 0);
      if (Number.isFinite(taskIdNum) && taskIdNum > 0) {
        next.taskId = Math.trunc(taskIdNum);
      }
    }

    if (Object.prototype.hasOwnProperty.call(context, "sessionId")) {
      const sessionId = String(context.sessionId || "").trim();
      if (sessionId) next.sessionId = sessionId;
    }

    const incomingTaskLinks = normalizeTaskLinks(context.taskLinks);
    if (incomingTaskLinks.length > 0) {
      next.taskLinks = mergeTaskLinks(next.taskLinks, incomingTaskLinks);
    } else if (!Array.isArray(next.taskLinks)) {
      delete next.taskLinks;
    }

    byChat[id] = next;
    pruneMessageMetaForChat(key);
    if (shouldPersist) persist();
    return next;
  }

  function summarizeTelegramMessageForReplyContext(msg) {
    const text = String(msg?.text || "").trim();
    if (text) {
      return { source: "text", snippet: text };
    }

    const caption = String(msg?.caption || "").trim();
    const photo = Array.isArray(msg?.photo) && msg.photo.length > 0;
    const imageDoc = Boolean(msg?.document && String(msg.document.mime_type || "").toLowerCase().startsWith("image/"));
    if (photo || imageDoc) {
      const fileName = String(msg?.document?.file_name || "").trim();
      const lead = photo ? "[image]" : `[image document${fileName ? `: ${fileName}` : ""}]`;
      return { source: "image", snippet: caption ? `${lead}\n${caption}` : lead };
    }

    const voice = msg?.voice || null;
    if (voice && typeof voice === "object") {
      const sec = Number(voice.duration || 0);
      const lead = sec > 0 ? `[voice ${Math.round(sec)}s]` : "[voice]";
      return { source: "voice", snippet: caption ? `${lead}\n${caption}` : lead };
    }

    const audio = msg?.audio || null;
    if (audio && typeof audio === "object") {
      const sec = Number(audio.duration || 0);
      const title = String(audio.title || "").trim();
      const performer = String(audio.performer || "").trim();
      const label = [performer, title].filter(Boolean).join(" - ");
      const lead = sec > 0
        ? `[audio ${Math.round(sec)}s${label ? `: ${label}` : ""}]`
        : `[audio${label ? `: ${label}` : ""}]`;
      return { source: "audio", snippet: caption ? `${lead}\n${caption}` : lead };
    }

    const doc = msg?.document || null;
    if (doc && typeof doc === "object") {
      const fileName = String(doc.file_name || "").trim();
      const mime = String(doc.mime_type || "").trim();
      const lead = `[document${fileName ? `: ${fileName}` : mime ? `: ${mime}` : ""}]`;
      return { source: "document", snippet: caption ? `${lead}\n${caption}` : lead };
    }

    const sticker = msg?.sticker || null;
    if (sticker && typeof sticker === "object") {
      const emoji = String(sticker.emoji || "").trim();
      return { source: "sticker", snippet: emoji ? `[sticker ${emoji}]` : "[sticker]" };
    }

    const contact = msg?.contact || null;
    if (contact && typeof contact === "object") {
      const name = [String(contact.first_name || "").trim(), String(contact.last_name || "").trim()].filter(Boolean).join(" ").trim();
      return { source: "contact", snippet: name ? `[contact: ${name}]` : "[contact]" };
    }

    const location = msg?.location || null;
    if (location && typeof location === "object") {
      return { source: "location", snippet: "[location]" };
    }

    return { source: "message", snippet: "[non-text message]" };
  }

  function recordIncomingTelegramMessageMeta(msg, context = {}) {
    const chatId = String(msg?.chat?.id || "").trim();
    const messageId = Number(msg?.message_id || 0);
    if (!chatId || !Number.isFinite(messageId) || messageId <= 0) return null;

    const summary = summarizeTelegramMessageForReplyContext(msg);
    const fallbackSource = summary?.source ? `user-${String(summary.source || "").trim().toLowerCase()}` : "user-message";
    const source = Object.prototype.hasOwnProperty.call(context, "source")
      ? String(context.source || "").trim().toLowerCase()
      : fallbackSource;
    const snippet = Object.prototype.hasOwnProperty.call(context, "snippet")
      ? String(context.snippet || "")
      : String(summary?.snippet || "");
    const parentMessageId = Number(msg?.reply_to_message?.message_id || 0);
    const from = labelSender(msg);
    const fromIsBot = msg?.from?.is_bot === true;

    return recordMessageMeta(
      chatId,
      messageId,
      {
        parentMessageId: Number.isFinite(parentMessageId) && parentMessageId > 0 ? Math.trunc(parentMessageId) : 0,
        source,
        snippet,
        from,
        fromIsBot,
        role: fromIsBot ? "assistant" : "user",
        workerId: context.workerId,
        taskId: context.taskId,
        sessionId: context.sessionId,
        taskLinks: context.taskLinks,
      },
      { persist: true },
    );
  }

  function lookupReplyRouteEntry(chatId, messageId) {
    const chatKey = String(chatId || "").trim();
    const msgKey = String(messageId || "").trim();
    if (!chatKey || !msgKey) return null;
    const entry = replyRouteByChat[chatKey];
    if (!entry || typeof entry !== "object") return null;
    const hit = entry[msgKey];
    if (!hit || typeof hit !== "object") return null;

    const workerId = String(hit.workerId || "").trim();
    const source = String(hit.source || "").trim();
    const snippet = normalizeSnippet(hit.snippet || "");
    const sessionId = String(hit.sessionId || "").trim();
    const taskId = Number(hit.taskId || 0);
    const taskLinks = normalizeTaskLinks(hit.taskLinks);
    const at = Number(hit.at || 0);
    return {
      workerId,
      source,
      snippet,
      sessionId,
      taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
      taskLinks,
      at: Number.isFinite(at) && at > 0 ? at : 0,
    };
  }

  function lookupReplyRouteWorker(chatId, messageId) {
    const hit = lookupReplyRouteEntry(chatId, messageId);
    if (!hit) return "";
    const wid = String(hit.workerId || "").trim();
    return wid && workers[wid] ? wid : "";
  }

  function isImageRelatedReplyContext(replyContext) {
    const source = String(replyContext?.source || "").trim().toLowerCase();
    if (!source) return false;
    return (
      source === "image" ||
      source === "bot-photo" ||
      source === "user-image" ||
      source === "user-image-caption" ||
      source === "image-caption" ||
      source === "image-followup" ||
      source === "image-saved" ||
      source === "ask-image" ||
      source === "see-screenshot"
    );
  }

  function buildReplyContextFromIncomingMessage(msg) {
    const chatId = String(msg?.chat?.id || "").trim();
    const reply = msg?.reply_to_message;
    if (!chatId || !reply || typeof reply !== "object") return null;

    const messageId = Number(reply.message_id || 0);
    if (!Number.isFinite(messageId) || messageId <= 0) return null;

    const storedRoute = lookupReplyRouteEntry(chatId, messageId);
    const storedMeta = getMessageMetaEntry(chatId, messageId);
    const workerCandidate = String(
      (storedRoute && storedRoute.workerId) ||
        (storedMeta && storedMeta.workerId) ||
        "",
    ).trim();
    const workerId = workerCandidate && workers[workerCandidate]
      ? workerCandidate
      : "";
    const summary = summarizeTelegramMessageForReplyContext(reply);
    const snippet = normalizeSnippet(
      (storedRoute && storedRoute.snippet) ||
        (storedMeta && storedMeta.snippet) ||
        summary.snippet ||
        "",
    );
    const source = String(
      (storedRoute && storedRoute.source) ||
        (storedMeta && storedMeta.source) ||
        summary.source ||
        "message",
    ).trim().toLowerCase() || "message";
    const from = String((storedMeta && storedMeta.from) || labelSender(reply)).trim();
    const fromIsBot = storedMeta
      ? storedMeta.fromIsBot === true
      : reply?.from?.is_bot === true;
    const taskId = Number((storedRoute && storedRoute.taskId) || (storedMeta && storedMeta.taskId) || 0);
    const sessionId = String(
      (storedRoute && storedRoute.sessionId) ||
        (storedMeta && storedMeta.sessionId) ||
        "",
    ).trim();
    const taskLinks = mergeTaskLinks(
      normalizeTaskLinks(storedRoute?.taskLinks),
      normalizeTaskLinks(storedMeta?.taskLinks),
    );

    return {
      messageId,
      workerId,
      source,
      snippet,
      from,
      fromIsBot,
      at: Number((storedRoute && storedRoute.at) || (storedMeta && storedMeta.at) || 0),
      taskId,
      sessionId,
      taskLinks: mergeTaskLinks(
        taskLinks,
        normalizeTaskLinks([
          {
            taskId,
            workerId,
            sessionId,
          },
        ]),
      ),
    };
  }

  function trimContextBlock(text, maxChars, truncatedLead = "[...older context truncated]") {
    const src = String(text || "").trim();
    const lim = Number(maxChars || 0);
    if (!src || !Number.isFinite(lim) || lim <= 0 || src.length <= lim) return src;
    const budget = Math.max(40, lim - truncatedLead.length - 1);
    return `${truncatedLead}\n${src.slice(src.length - budget).trimStart()}`.trim();
  }

  function formatMessageContextLine(item) {
    const messageId = Number(item?.messageId || 0);
    const idLabel = Number.isFinite(messageId) && messageId > 0 ? `#${Math.trunc(messageId)}` : "#?";
    const from = String(item?.from || "").trim() || "unknown";
    const source = String(item?.source || "").trim() || "message";
    const snippet = normalizeSnippet(item?.snippet || "") || "[no content]";
    const role = String(item?.role || "").trim().toLowerCase();
    const roleLabel = role === "assistant" || role === "bot"
      ? "assistant"
      : role === "user"
        ? "user"
        : item?.fromIsBot === true
          ? "assistant"
          : "user";
    return `- ${idLabel} ${roleLabel} ${from} (${source}): ${snippet}`;
  }

  function buildReplyThreadContextFromIncomingMessage(msg) {
    const chatId = String(msg?.chat?.id || "").trim();
    const reply = msg?.reply_to_message;
    if (!chatId || !reply || typeof reply !== "object") return null;

    const maxDepth = Math.max(1, Number(ORCH_THREAD_CONTEXT_MAX_DEPTH) || 1);
    const visited = new Set();
    const chain = [];
    let cursorMsg = reply;
    let cursorId = Number(reply?.message_id || 0);
    let depth = 0;

    while (depth < maxDepth) {
      if (!Number.isFinite(cursorId) || cursorId <= 0) break;
      const id = Math.trunc(cursorId);
      if (visited.has(id)) break;
      visited.add(id);

      const stored = getMessageMetaEntry(chatId, id);
      const summary = cursorMsg ? summarizeTelegramMessageForReplyContext(cursorMsg) : null;
      const source = String((stored && stored.source) || (summary && summary.source) || "message").trim().toLowerCase() || "message";
      const snippet = normalizeSnippet((stored && stored.snippet) || (summary && summary.snippet) || "") || "[no content]";
      const from = String((stored && stored.from) || (cursorMsg ? labelSender(cursorMsg) : "") || "unknown").trim() || "unknown";
      const fromIsBot = stored
        ? stored.fromIsBot === true
        : cursorMsg?.from?.is_bot === true;
      const role = String(stored?.role || "").trim().toLowerCase() || (fromIsBot ? "assistant" : "user");
      const taskLinks = mergeTaskLinks(
        normalizeTaskLinks(stored?.taskLinks),
        normalizeTaskLinks([
          {
            taskId: Number(stored?.taskId || 0),
            workerId: String(stored?.workerId || "").trim(),
            sessionId: String(stored?.sessionId || "").trim(),
          },
        ]),
      );

      let parentMessageId = 0;
      const directParent = Number(cursorMsg?.reply_to_message?.message_id || 0);
      if (Number.isFinite(directParent) && directParent > 0) {
        parentMessageId = Math.trunc(directParent);
      } else {
        const storedParent = Number(stored?.parentMessageId || 0);
        parentMessageId = Number.isFinite(storedParent) && storedParent > 0 ? Math.trunc(storedParent) : 0;
      }

      chain.push({
        messageId: id,
        parentMessageId,
        source,
        snippet,
        from,
        fromIsBot,
        role,
        taskLinks,
      });

      if (cursorMsg?.reply_to_message && typeof cursorMsg.reply_to_message === "object") {
        cursorMsg = cursorMsg.reply_to_message;
        const nextId = Number(cursorMsg?.message_id || 0);
        cursorId = Number.isFinite(nextId) && nextId > 0 ? Math.trunc(nextId) : parentMessageId;
      } else {
        cursorMsg = null;
        cursorId = parentMessageId;
      }
      depth += 1;
    }

    if (chain.length === 0) return null;
    const ordered = [...chain].reverse();
    const lines = ordered.map((x) => formatMessageContextLine(x));
    const text = trimContextBlock(lines.join("\n"), ORCH_THREAD_CONTEXT_MAX_CHARS);
    const allTaskLinks = normalizeTaskLinks(ordered.flatMap((x) => x.taskLinks || []));
    return {
      depth: ordered.length,
      items: ordered,
      text,
      taskLinks: allTaskLinks,
      messageIds: ordered.map((x) => Number(x.messageId || 0)).filter((x) => Number.isFinite(x) && x > 0),
    };
  }

  function buildRecentHistoryContext(chatId, { excludeMessageIds = [], limit = ORCH_RECENT_CONTEXT_MESSAGES } = {}) {
    const key = String(chatId || "").trim();
    if (!key) return null;
    const maxRows = Math.max(0, Number(limit || 0));
    if (maxRows <= 0) return null;
    const byChat = messageMetaByChat[key];
    if (!byChat || typeof byChat !== "object") return null;
    const exclude = new Set(
      (Array.isArray(excludeMessageIds) ? excludeMessageIds : [])
        .map((x) => Number(x || 0))
        .filter((x) => Number.isFinite(x) && x > 0)
        .map((x) => Math.trunc(x)),
    );

    const rows = Object.values(byChat)
      .filter((x) => x && typeof x === "object")
      .filter((x) => {
        const id = Number(x.messageId || 0);
        if (!Number.isFinite(id) || id <= 0) return false;
        return !exclude.has(Math.trunc(id));
      })
      .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
    if (rows.length === 0) return null;

    const tail = rows.slice(Math.max(0, rows.length - maxRows));
    const items = tail.map((x) => ({
      messageId: Number(x.messageId || 0),
      parentMessageId: Number(x.parentMessageId || 0),
      source: String(x.source || "").trim().toLowerCase() || "message",
      snippet: normalizeSnippet(x.snippet || "") || "[no content]",
      from: String(x.from || "").trim() || "unknown",
      fromIsBot: x.fromIsBot === true,
      role: String(x.role || "").trim().toLowerCase() || (x.fromIsBot === true ? "assistant" : "user"),
    }));
    const lines = items.map((x) => formatMessageContextLine(x));
    const text = trimContextBlock(lines.join("\n"), ORCH_RECENT_CONTEXT_MAX_CHARS, "[...older recent history truncated]");
    return {
      items,
      text,
      count: items.length,
    };
  }

  function recordReplyRoute(chatId, messageId, workerId, context = {}) {
    const chatKey = String(chatId || "").trim();
    const msgKey = String(messageId || "").trim();
    const wid = String(workerId || "").trim();
    if (!chatKey || !msgKey || !wid) return;
    if (!workers[wid]) return;

    const prev = replyRouteByChat[chatKey] && typeof replyRouteByChat[chatKey] === "object"
      ? replyRouteByChat[chatKey]
      : {};
    const current = prev[msgKey] && typeof prev[msgKey] === "object" ? prev[msgKey] : {};
    const sourceRaw = Object.prototype.hasOwnProperty.call(context, "source") ? context.source : current.source;
    const snippetRaw = Object.prototype.hasOwnProperty.call(context, "snippet") ? context.snippet : current.snippet;
    const taskIdRaw = Object.prototype.hasOwnProperty.call(context, "taskId") ? context.taskId : current.taskId;
    const sessionIdRaw = Object.prototype.hasOwnProperty.call(context, "sessionId") ? context.sessionId : current.sessionId;
    const taskLinksRaw = Object.prototype.hasOwnProperty.call(context, "taskLinks") ? context.taskLinks : current.taskLinks;

    const source = String(sourceRaw || "").trim().toLowerCase();
    const snippet = normalizeSnippet(snippetRaw || "");
    const taskId = Number(taskIdRaw || 0);
    const sessionId = String(sessionIdRaw || "").trim();
    const mergedTaskLinks = mergeTaskLinks(
      normalizeTaskLinks(taskLinksRaw),
      normalizeTaskLinks([
        {
          taskId: Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : 0,
          workerId: wid,
          sessionId,
        },
      ]),
    );

    const entry = {
      workerId: wid,
      at: Date.now(),
    };
    if (source) entry.source = source;
    if (snippet) entry.snippet = snippet;
    if (Number.isFinite(taskId) && taskId > 0) entry.taskId = Math.trunc(taskId);
    if (sessionId) entry.sessionId = sessionId;
    if (mergedTaskLinks.length > 0) entry.taskLinks = mergedTaskLinks;
    prev[msgKey] = entry;
    replyRouteByChat[chatKey] = prev;

    recordMessageMeta(
      chatKey,
      msgKey,
      {
        source,
        snippet,
        workerId: wid,
        taskId,
        sessionId,
        taskLinks: mergedTaskLinks,
      },
      { persist: false },
    );

    // Best-effort cleanup: keep the most recent ~600 per chat and drop very old entries.
    const entries = Object.entries(prev);
    if (entries.length > 700) {
      entries.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
      const keep = new Set(entries.slice(0, 600).map((x) => x[0]));
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const next = {};
      for (const [k, v] of entries) {
        const at = Number(v?.at || 0);
        if (!keep.has(k)) continue;
        if (Number.isFinite(at) && at > 0 && at < cutoff) continue;
        next[k] = v;
      }
      replyRouteByChat[chatKey] = next;
    }

    persist();
  }

  function dropReplyRoutesForWorker(workerId) {
    const wid = String(workerId || "").trim();
    if (!wid) return 0;
    let changedChats = 0;
    for (const [chatKey, entry] of Object.entries(replyRouteByChat || {})) {
      if (!entry || typeof entry !== "object") continue;
      let changed = false;
      const next = {};
      for (const [msgId, v] of Object.entries(entry)) {
        const vw = String(v?.workerId || "").trim();
        if (vw && vw === wid) {
          changed = true;
          continue;
        }
        next[msgId] = v;
      }
      if (changed) {
        replyRouteByChat[chatKey] = next;
        changedChats += 1;
      }
    }
    return changedChats;
  }

  function dropChatData(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return false;
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(replyRouteByChat, key)) {
      delete replyRouteByChat[key];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(messageMetaByChat, key)) {
      delete messageMetaByChat[key];
      changed = true;
    }
    return changed;
  }

  return {
    normalizeTaskLinks,
    mergeTaskLinks,
    getMessageMetaEntry,
    recordMessageMeta,
    recordIncomingTelegramMessageMeta,
    summarizeTelegramMessageForReplyContext,
    isImageRelatedReplyContext,
    lookupReplyRouteEntry,
    lookupReplyRouteWorker,
    buildReplyContextFromIncomingMessage,
    trimContextBlock,
    formatMessageContextLine,
    buildReplyThreadContextFromIncomingMessage,
    buildRecentHistoryContext,
    recordReplyRoute,
    dropReplyRoutesForWorker,
    dropChatData,
  };
}

module.exports = {
  createOrchReplyContextRuntime,
};
