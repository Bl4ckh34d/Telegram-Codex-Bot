"use strict";

function createStatePersister({
  writeNow,
  delayMs = 250,
  maxDelayMs = 2000,
  onError = null,
} = {}) {
  if (typeof writeNow !== "function") {
    throw new Error("createStatePersister requires a writeNow function");
  }

  let dirty = false;
  let dirtySince = 0;
  let timer = null;

  const safeDelay = Math.max(0, Number(delayMs) || 0);
  const safeMaxDelay = Math.max(safeDelay, Number(maxDelayMs) || safeDelay);
  const failureRetryDelayMs = safeDelay > 0 ? safeDelay : 250;

  function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function scheduleFailureRetry() {
    clearTimer();
    if (!dirty) return;
    dirtySince = Date.now();
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, failureRetryDelayMs);
  }

  function flush() {
    if (!dirty) return false;
    clearTimer();
    try {
      writeNow();
      dirty = false;
      dirtySince = 0;
      return true;
    } catch (err) {
      if (typeof onError === "function") {
        try {
          onError(err);
        } catch {
          // best effort
        }
      }
      scheduleFailureRetry();
      return false;
    }
  }

  function scheduleTimer() {
    clearTimer();
    if (!dirty) return;

    const elapsed = dirtySince > 0 ? Date.now() - dirtySince : 0;
    const remainingMaxDelay = Math.max(0, safeMaxDelay - elapsed);
    const wait = Math.min(safeDelay, remainingMaxDelay);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, wait);
  }

  function markDirty({ immediate = false } = {}) {
    if (!dirty) {
      dirty = true;
      dirtySince = Date.now();
    }
    if (immediate || safeDelay <= 0) {
      flush();
      return;
    }
    scheduleTimer();
  }

  function hasPending() {
    return dirty;
  }

  return {
    markDirty,
    flush,
    hasPending,
  };
}

module.exports = {
  createStatePersister,
};
