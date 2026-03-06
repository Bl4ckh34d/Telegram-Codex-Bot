"use strict";

function createOrchWorkerRuntime(deps = {}) {
  const {
    fs,
    path,
    orchWorkers,
    orchActiveWorkerByChat,
    orchSessionByChatWorker,
    ORCH_GENERAL_WORKER_ID,
    persistState,
    normalizeWorkerDisplayName,
    collectUsedWorkerNameKeys,
    chooseAvailableWorkerName,
    takeNextWorkerIdCandidate,
    ensureWorkerLane,
    getLane,
    lanes,
    terminateChildTree,
    dropReplyRoutesForWorker,
  } = deps;

  const workers = orchWorkers && typeof orchWorkers === "object" ? orchWorkers : {};
  const activeByChat = orchActiveWorkerByChat && typeof orchActiveWorkerByChat === "object"
    ? orchActiveWorkerByChat
    : {};
  const sessionsByChatWorker = orchSessionByChatWorker && typeof orchSessionByChatWorker === "object"
    ? orchSessionByChatWorker
    : {};
  const lanesMap = lanes instanceof Map ? lanes : null;
  const persist = typeof persistState === "function" ? persistState : () => {};
  const normalizeDisplay = typeof normalizeWorkerDisplayName === "function"
    ? normalizeWorkerDisplayName
    : (value) => String(value || "").trim();
  const usedWorkerNames = typeof collectUsedWorkerNameKeys === "function"
    ? collectUsedWorkerNameKeys
    : (workersObj) => {
      const out = new Set();
      for (const raw of Object.values(workersObj || {})) {
        const name = normalizeDisplay(raw?.name || "");
        if (name) out.add(name.toLowerCase());
      }
      return out;
    };
  const chooseWorkerName = typeof chooseAvailableWorkerName === "function"
    ? chooseAvailableWorkerName
    : (used, preferred = "") => {
      const want = normalizeDisplay(preferred);
      if (want && !(used instanceof Set && used.has(want.toLowerCase()))) return want;
      return want || `Worker ${Date.now()}`;
    };
  const nextWorkerIdCandidate = typeof takeNextWorkerIdCandidate === "function"
    ? takeNextWorkerIdCandidate
    : () => `w${Date.now()}`;
  const ensureLane = typeof ensureWorkerLane === "function" ? ensureWorkerLane : () => null;
  const getLaneById = typeof getLane === "function"
    ? getLane
    : (laneId) => (lanesMap ? lanesMap.get(String(laneId || "").trim()) || null : null);
  const terminateTree = typeof terminateChildTree === "function" ? terminateChildTree : () => {};
  const dropReplyRoutes = typeof dropReplyRoutesForWorker === "function"
    ? dropReplyRoutesForWorker
    : () => 0;

  function listCodexWorkers() {
    const out = [];
    for (const [id, w] of Object.entries(workers || {})) {
      if (!w || typeof w !== "object") continue;
      const wid = String(id || "").trim();
      if (!wid) continue;
      out.push({
        id: wid,
        kind: String(w.kind || "").trim() || "repo",
        name: normalizeDisplay(w.name),
        title: String(w.title || wid).trim() || wid,
        workdir: String(w.workdir || "").trim(),
        createdAt: Number(w.createdAt || 0) || 0,
        lastUsedAt: Number(w.lastUsedAt || 0) || 0,
      });
    }
    out.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    return out;
  }

  function getCodexWorker(workerId) {
    const wid = String(workerId || "").trim();
    if (!wid) return null;
    const w = workers[wid];
    if (!w || typeof w !== "object") return null;
    return {
      id: wid,
      kind: String(w.kind || "").trim() || "repo",
      name: normalizeDisplay(w.name),
      title: String(w.title || wid).trim() || wid,
      workdir: String(w.workdir || "").trim(),
      createdAt: Number(w.createdAt || 0) || 0,
      lastUsedAt: Number(w.lastUsedAt || 0) || 0,
    };
  }

  function touchWorker(workerId) {
    const wid = String(workerId || "").trim();
    if (!wid) return;
    const w = workers[wid];
    if (!w || typeof w !== "object") return;
    w.lastUsedAt = Date.now();
    persist();
  }

  function normalizePathKey(inputPath) {
    const raw = String(inputPath || "").trim();
    if (!raw) return "";
    try {
      // Use forward slashes + lowercase so Windows paths compare reliably.
      return path.resolve(raw).replace(/\\/g, "/").toLowerCase();
    } catch {
      return raw.replace(/\\/g, "/").toLowerCase();
    }
  }

  function resolveWorkdirInput(inputPath) {
    const raw = String(inputPath || "").trim();
    if (!raw) return "";
    try {
      return path.resolve(raw);
    } catch {
      return raw;
    }
  }

  function findWorkerByWorkdir(workdir) {
    const key = normalizePathKey(workdir);
    if (!key) return "";
    for (const w of listCodexWorkers()) {
      const wk = normalizePathKey(w.workdir);
      if (wk && wk === key) return w.id;
    }
    return "";
  }

  function createRepoWorker(workdir, title = "") {
    const resolved = resolveWorkdirInput(workdir);
    if (!resolved) throw new Error("workdir is required");
    if (!fs.existsSync(resolved)) throw new Error(`workdir does not exist: ${resolved}`);

    const existing = findWorkerByWorkdir(resolved);
    if (existing) return existing;

    const now = Date.now();
    const baseTitle = String(title || "").trim() || path.basename(resolved) || "Repo";
    const usedNameKeys = usedWorkerNames(workers);
    const workerName = chooseWorkerName(usedNameKeys);

    let id = "";
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const candidate = String(nextWorkerIdCandidate() || "").trim();
      if (!candidate) continue;
      if (!workers[candidate]) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error("Failed to allocate worker id");

    workers[id] = {
      id,
      kind: "repo",
      name: workerName,
      title: baseTitle,
      workdir: resolved,
      createdAt: now,
      lastUsedAt: now,
    };
    persist();
    ensureLane(id);
    return id;
  }

  function retireWorker(workerId, { cancelActive = true } = {}) {
    const wid = String(workerId || "").trim();
    if (!wid) throw new Error("worker id is required");
    if (wid === ORCH_GENERAL_WORKER_ID) throw new Error("Cannot retire the general worker");
    if (!workers[wid]) throw new Error(`Unknown worker: ${wid}`);

    const lane = getLaneById(wid);
    if (lane) {
      try {
        if (cancelActive && lane.currentJob) {
          const job = lane.currentJob;
          job.cancelRequested = true;
          try {
            if (job.abortController instanceof AbortController) {
              job.abortController.abort();
            }
          } catch {
            // best effort
          }
          if (job.process) {
            terminateTree(job.process, { forceAfterMs: 2000 });
          }
        }
        if (Array.isArray(lane.queue)) lane.queue = [];
      } catch {
        // best effort
      }
      if (lanesMap) lanesMap.delete(wid);
    }

    delete workers[wid];

    // If any chat had this as active worker, fall back to general.
    for (const [chatKey, cur] of Object.entries(activeByChat || {})) {
      if (String(cur || "").trim() === wid) {
        activeByChat[chatKey] = ORCH_GENERAL_WORKER_ID;
      }
    }

    // Drop sessions for this worker.
    for (const [chatKey, entry] of Object.entries(sessionsByChatWorker || {})) {
      if (!entry || typeof entry !== "object") continue;
      if (!(wid in entry)) continue;
      const next = { ...entry };
      delete next[wid];
      sessionsByChatWorker[chatKey] = next;
    }

    dropReplyRoutes(wid);
    persist();
  }

  function resolveWorkerIdFromUserInput(input) {
    const raw = String(input || "").trim();
    if (!raw) return "";
    if (workers[raw]) return raw;

    const lower = raw.toLowerCase();
    const workersList = listCodexWorkers();

    // Exact title match.
    for (const w of workersList) {
      if (String(w.title || "").trim().toLowerCase() === lower) return w.id;
    }

    // Exact worker name match.
    for (const w of workersList) {
      if (String(w.name || "").trim().toLowerCase() === lower) return w.id;
    }

    // Basename match (repo folder name).
    for (const w of workersList) {
      const base = String(path.basename(String(w.workdir || "")) || "").trim().toLowerCase();
      if (base && base === lower) return w.id;
    }

    // Substring match (first).
    for (const w of workersList) {
      const name = String(w.name || "").trim().toLowerCase();
      const title = String(w.title || "").trim().toLowerCase();
      const dir = String(w.workdir || "").trim().toLowerCase();
      if ((name && name.includes(lower)) || (title && title.includes(lower)) || (dir && dir.includes(lower))) return w.id;
    }

    return "";
  }

  return {
    listCodexWorkers,
    getCodexWorker,
    touchWorker,
    normalizePathKey,
    resolveWorkdirInput,
    findWorkerByWorkdir,
    createRepoWorker,
    retireWorker,
    resolveWorkerIdFromUserInput,
  };
}

module.exports = {
  createOrchWorkerRuntime,
};
