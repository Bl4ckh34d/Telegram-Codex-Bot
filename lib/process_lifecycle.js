"use strict";

const { spawn: nativeSpawn } = require("node:child_process");
const children = new Set();
const stopping = new WeakMap();
const activeStops = new Set();

function spawn(command, args, options = {}) {
  const child = nativeSpawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function terminateChildTree(child, { forceAfterMs = 2000 } = {}) {
  if (!child?.pid) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const signalTree = (force) => {
    if (process.platform === "win32") {
      const killer = nativeSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {});
      return;
    }
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch (err) { if (err.code !== "ESRCH") { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} } }
  };
  signalTree(false);
  const done = new Promise(resolve => {
    // Keep escalation alive even if the group leader exits before its descendants.
    setTimeout(() => { signalTree(true); resolve(); }, Math.max(0, Number(forceAfterMs) || 0));
  });
  stopping.set(child, done);
  activeStops.add(done);
  void done.finally(() => activeStops.delete(done));
  return done;
}

async function terminateAllChildren() {
  const current = [...children].map(child => terminateChildTree(child));
  await Promise.all([...current, ...activeStops]);
}

module.exports = { spawn, terminateChildTree, terminateAllChildren };
