"use strict";

function createOrchLaneRegistryRuntime(deps = {}) {
  const {
    fs,
    path,
    ROOT,
    CODEX_WORKDIR,
    ORCH_TTS_LANE_ID,
    ORCH_WHISPER_LANE_ID,
    ORCH_GENERAL_WORKER_ID,
    ORCH_MAX_CODEX_WORKERS,
    orchWorkers,
    lanes,
    persistState,
    log,
    getCodexWorker,
    listCodexWorkers,
    findWorkerByWorkdir,
    createRepoWorker,
  } = deps;

  const workers = orchWorkers && typeof orchWorkers === "object" ? orchWorkers : {};
  const lanesMap = lanes instanceof Map ? lanes : new Map();
  const persist = typeof persistState === "function" ? persistState : () => {};
  const writeLog = typeof log === "function" ? log : () => {};
  const getWorker = typeof getCodexWorker === "function" ? getCodexWorker : () => null;
  const listWorkers = typeof listCodexWorkers === "function" ? listCodexWorkers : () => [];
  const findWorkerForWorkdir = typeof findWorkerByWorkdir === "function" ? findWorkerByWorkdir : () => "";
  const createWorker = typeof createRepoWorker === "function" ? createRepoWorker : () => "";

  function getLane(laneId) {
    const key = String(laneId || "").trim();
    if (!key) return null;
    return lanesMap.get(key) || null;
  }

  function makeLane({ id, type, title, workdir, countTowardCap = false } = {}) {
    const laneId = String(id || "").trim();
    if (!laneId) throw new Error("lane id is required");
    const lane = {
      id: laneId,
      type: String(type || "").trim() || "codex",
      title: String(title || laneId).trim() || laneId,
      workdir: String(workdir || "").trim(),
      countTowardCap: Boolean(countTowardCap),
      queue: [],
      currentJob: null,
    };
    lanesMap.set(laneId, lane);
    return lane;
  }

  function ensureTtsLane() {
    let lane = getLane(ORCH_TTS_LANE_ID);
    if (lane) return lane;
    lane = makeLane({
      id: ORCH_TTS_LANE_ID,
      type: "tts",
      title: "TTS",
      workdir: ROOT,
      countTowardCap: false,
    });
    return lane;
  }

  function ensureWhisperLane() {
    let lane = getLane(ORCH_WHISPER_LANE_ID);
    if (lane) return lane;
    lane = makeLane({
      id: ORCH_WHISPER_LANE_ID,
      type: "whisper",
      title: "Whisper",
      workdir: ROOT,
      countTowardCap: false,
    });
    return lane;
  }

  function resolveFallbackWorkdir() {
    if (CODEX_WORKDIR && fs.existsSync(CODEX_WORKDIR)) return CODEX_WORKDIR;
    return ROOT;
  }

  function resolveUsableWorkdir(preferredWorkdir) {
    const preferred = String(preferredWorkdir || "").trim();
    if (preferred && fs.existsSync(preferred)) return preferred;
    return resolveFallbackWorkdir();
  }

  function refreshLaneWorkdir(lane, { logPrefix = "" } = {}) {
    if (!lane || typeof lane !== "object") return resolveFallbackWorkdir();
    const current = String(lane.workdir || "").trim();
    if (current && fs.existsSync(current)) return current;
    const worker = getWorker(String(lane.id || "").trim());
    const next = resolveUsableWorkdir(worker?.workdir || current);
    lane.workdir = next;
    if (current !== next) {
      const prefix = String(logPrefix || "").trim();
      writeLog(
        `${prefix ? `${prefix} ` : ""}worker ${String(lane.id || "").trim() || "unknown"} workdir unavailable: ${current || "(empty)"}; using ${next}.`,
      );
    }
    return next;
  }

  function ensureWorkerLane(workerId) {
    const wid = String(workerId || "").trim();
    if (!wid) return null;
    const existing = getLane(wid);
    if (existing) {
      refreshLaneWorkdir(existing, { logPrefix: "[orch]" });
      return existing;
    }
    const w = getWorker(wid);
    if (!w) return null;
    const workdir = resolveUsableWorkdir(w.workdir);
    return makeLane({
      id: wid,
      type: "codex",
      title: String(w.name || w.title || wid).trim() || wid,
      workdir,
      countTowardCap: true,
    });
  }

  function initOrchLanes() {
    ensureTtsLane();
    ensureWhisperLane();
    // Convenience: ensure the bot's own repo has a dedicated worker when possible.
    try {
      const isRepo = fs.existsSync(path.join(ROOT, ".git"));
      const hasWorker = Boolean(findWorkerForWorkdir(ROOT));
      if (isRepo && !hasWorker && listWorkers().length < ORCH_MAX_CODEX_WORKERS) {
        createWorker(ROOT, path.basename(ROOT) || "Bot Repo");
      }
    } catch {
      // best effort
    }
    // Ensure lanes exist for all known workers (including the general worker).
    for (const w of listWorkers()) {
      ensureWorkerLane(w.id);
    }
    // Enforce the cap at startup (best-effort): keep most recently used workers + general.
    const all = listWorkers();
    const keep = [];
    for (const w of all) {
      if (w.id === ORCH_GENERAL_WORKER_ID) keep.push(w);
    }
    for (const w of all) {
      if (w.id === ORCH_GENERAL_WORKER_ID) continue;
      if (keep.length >= ORCH_MAX_CODEX_WORKERS) break;
      keep.push(w);
    }
    const keepIds = new Set(keep.map((w) => w.id));
    for (const w of all) {
      if (keepIds.has(w.id)) continue;
      delete workers[w.id];
      lanesMap.delete(w.id);
    }
    if (all.length !== keep.length) {
      persist();
    }
  }

  return {
    getLane,
    makeLane,
    ensureTtsLane,
    ensureWhisperLane,
    resolveFallbackWorkdir,
    resolveUsableWorkdir,
    refreshLaneWorkdir,
    ensureWorkerLane,
    initOrchLanes,
  };
}

module.exports = {
  createOrchLaneRegistryRuntime,
};
