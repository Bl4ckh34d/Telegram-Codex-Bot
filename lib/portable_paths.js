"use strict";
const path = require("node:path");

function isForeignAbsolute(value, paths) {
  return paths.sep === "/" ? /^(?:[a-z]:[\\/]|\\\\)/i.test(value) : /^\/(?!\/)/.test(value);
}

// Persist local references relative to the bot checkout. Runtime paths stay absolute.
// A different Windows drive (or a path from another OS) cannot be made relative.
function decodeLocalPath(value, baseDir, paths = path) {
  const raw = String(value || "").trim();
  if (!raw || isForeignAbsolute(raw, paths)) return raw;
  return paths.resolve(baseDir, raw.replace(/\\/g, "/"));
}

function encodeLocalPath(value, baseDir, paths = path) {
  const raw = String(value || "").trim();
  if (!raw || isForeignAbsolute(raw, paths)) return raw;
  const absolute = decodeLocalPath(raw, baseDir, paths);
  return (paths.relative(baseDir, absolute) || ".").replace(/\\/g, "/");
}

function mapStatePaths(state, mapPath) {
  if (!state || typeof state !== "object") return state;
  const result = { ...state };
  if (state.orch?.workers) {
    result.orch = { ...state.orch, workers: Object.fromEntries(Object.entries(state.orch.workers)
      .map(([id, worker]) => [id, worker && typeof worker === "object"
        ? { ...worker, workdir: mapPath(worker.workdir) } : worker])) };
  }
  const mapImage = item => item && typeof item === "object" ? { ...item, path: mapPath(item.path) } : item;
  if (state.lastImages) {
    result.lastImages = Object.fromEntries(Object.entries(state.lastImages).map(([id, entry]) => {
      const image = mapImage(entry);
      if (Array.isArray(entry?.items)) image.items = entry.items.map(mapImage);
      return [id, image];
    }));
  }
  if (Array.isArray(state.orchLessons)) {
    result.orchLessons = state.orchLessons.map(lesson => lesson && typeof lesson === "object"
      ? { ...lesson, workdirKey: mapPath(lesson.workdirKey) } : lesson);
  }
  return result;
}

module.exports = { encodeLocalPath, decodeLocalPath, mapStatePaths, isForeignAbsolute };
