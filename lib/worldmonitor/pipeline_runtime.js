"use strict";

function createWorldMonitorPipelineRuntime(deps = {}) {
  const {
    getShuttingDown,
    log,
    redactError,
    ensureWorkerLane,
    getLane,
    fetchWorldMonitorRiskSnapshot,
    evaluateWorldMonitorSnapshot,
    buildWorldMonitorSnapshotSummary,
    evaluateWorldMonitorIntervalReportPolicy,
    worldMonitorFeedAlertLevelRank,
    ensureWorldMonitorWorker,
    buildWorldMonitorAlertPrompt,
    enqueuePrompt,
    normalizeWorldMonitorIntervalReportCounters,
    compactWorldMonitorCountryList,
    nowIso,
    formatRelativeAge,
    fmtBold,
    resolveWorldMonitorRegionName,
    sendMessage,
    runWorldMonitorNativeFeedRefresh,
    fetchWorldMonitorFeedAlerts,
    findWorldMonitorItemForAlert,
    getWorldMonitorItemArticleContext,
    isWorldMonitorAlertForwardable,
    resolveWorldMonitorAlertBestLink,
    translateWorldMonitorHeadlineToEnglish,
    oneLine,
    formatWorldMonitorFeedAlertMessage,
    rememberWorldMonitorFeedAlertKey,
    rememberWorldMonitorFeedAlertTitleKey,
    persistState,
    worldMonitorRuntime,
    worldMonitorMonitor,
    worldMonitorFeedAlertsRuntime,
    worldMonitorNativeRuntime,
    worldMonitorNativeNewsItems,
    worldMonitorFeedAlertSentKeySet,
    worldMonitorFeedAlertSentTitleKeySet,
    WORLDMONITOR_MONITOR_ENABLED,
    WORLDMONITOR_FEED_ALERTS_ENABLED,
    WORLDMONITOR_INTERVAL_ALERT_MODE,
    WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL,
    WORLDMONITOR_FEED_ALERTS_MIN_LEVEL,
    WORLDMONITOR_ALERT_COOLDOWN_SEC,
    WORLDMONITOR_ALERT_CHAT_ID,
    WORLDMONITOR_SUMMARY_MODEL,
    WORLDMONITOR_SUMMARY_REASONING,
    WORLDMONITOR_MIN_COUNTRY_RISK_SCORE,
    WORLDMONITOR_MIN_GLOBAL_RISK_SCORE,
    WORLDMONITOR_MIN_GLOBAL_DELTA,
    WORLDMONITOR_NOTIFY_ERRORS,
    WORLDMONITOR_MONITOR_INTERVAL_SEC,
    WORLDMONITOR_STARTUP_DELAY_SEC,
    WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS,
    WORLDMONITOR_STARTUP_CATCHUP_ENABLED,
    WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS,
    WORLDMONITOR_CHECK_LOOKBACK_HOURS,
    WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE,
    WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE,
    WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE,
    WORLDMONITOR_FEED_ALERTS_CHAT_ID,
    WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC,
  } = deps;

  function getWorldMonitorWorkerLaneState(workerId) {
    const lane = ensureWorkerLane(workerId) || getLane(workerId);
    const busy = Boolean(lane?.currentJob);
    const queued = Array.isArray(lane?.queue) ? lane.queue.length : 0;
    return { busy, queued };
  }

  async function runWorldMonitorMonitorCycle(options = {}) {
    const source = String(options?.source || "interval").trim().toLowerCase() || "interval";
    const allowWhenDisabled = options?.allowWhenDisabled === true;
    const forceAlert = options?.forceAlert === true;
    const replyChatId = String(options?.replyChatId || "").trim();
    const now = Date.now();

    if (!WORLDMONITOR_MONITOR_ENABLED && !allowWhenDisabled) {
      return { ok: false, skipped: "disabled" };
    }
    if (worldMonitorRuntime.inFlight) {
      return { ok: false, skipped: "busy" };
    }

    worldMonitorRuntime.inFlight = true;
    try {
      const snapshot = await fetchWorldMonitorRiskSnapshot();
      const decision = evaluateWorldMonitorSnapshot(snapshot, { forceAlert });
      const summary = buildWorldMonitorSnapshotSummary(snapshot);

      worldMonitorMonitor.lastRunAt = now;
      worldMonitorMonitor.lastRunSource = source;
      worldMonitorMonitor.lastErrorAt = 0;
      worldMonitorMonitor.lastError = "";
      worldMonitorMonitor.lastObservedGlobalScore = Number(snapshot.globalScore || 0);
      worldMonitorMonitor.lastObservedFingerprint = String(decision.fingerprint || "").trim();
      worldMonitorMonitor.lastSnapshotSummary = summary;
      persistState();

      let enqueued = false;
      let enqueueReason = "not triggered";
      let intervalReportPolicy = null;
      const isIntervalSource = source === "interval";
      const intervalMode = isIntervalSource ? WORLDMONITOR_INTERVAL_ALERT_MODE : "report";
      const wantsHeadlines = intervalMode === "headlines" || intervalMode === "smart";
      const wantsReport = intervalMode === "report" || intervalMode === "smart";

      if (isIntervalSource && wantsReport && !forceAlert) {
        intervalReportPolicy = evaluateWorldMonitorIntervalReportPolicy(decision, now);
        if (intervalReportPolicy.changed) persistState();
      }
      const shouldProcessAlertActions = decision.shouldAlert || Boolean(intervalReportPolicy?.shouldReport);

      if (shouldProcessAlertActions) {
        const actionReasons = [];
        const decisionReasonText = String(decision.reasons.join("; ") || "").trim();

        if (intervalMode === "off") {
          enqueueReason = "interval alerts disabled";
          worldMonitorMonitor.lastAlertAt = Date.now();
          worldMonitorMonitor.lastAlertReason = decisionReasonText || "interval alerts disabled";
          worldMonitorMonitor.lastAlertFingerprint = String(decision.fingerprint || "").trim();
          persistState();
        } else {
          if (wantsHeadlines && decision.shouldAlert) {
            const levelNow = String(snapshot?.globalLevel || "unknown").trim().toLowerCase();
            const minLevel = isIntervalSource ? WORLDMONITOR_INTERVAL_HEADLINES_MIN_LEVEL : WORLDMONITOR_FEED_ALERTS_MIN_LEVEL;
            const minRank = worldMonitorFeedAlertLevelRank(minLevel);
            const levelRank = worldMonitorFeedAlertLevelRank(levelNow);
            const cooldownMs = Math.max(0, Number(WORLDMONITOR_ALERT_COOLDOWN_SEC || 0) * 1000);
            const lastAlertAt = Number(worldMonitorMonitor.lastAlertAt || 0) || 0;
            const inCooldown = !forceAlert && cooldownMs > 0 && lastAlertAt > 0 && (now - lastAlertAt) < cooldownMs;
            const duplicate = !forceAlert
              && String(worldMonitorMonitor.lastAlertFingerprint || "").trim()
              && String(worldMonitorMonitor.lastAlertFingerprint || "").trim() === String(decision.fingerprint || "").trim();

            if (!forceAlert && isIntervalSource && minRank > 1 && levelRank < minRank) {
              actionReasons.push(`headlines gated by level (${levelNow || "unknown"} < ${minLevel})`);
            } else if (inCooldown) {
              actionReasons.push("headlines cooldown");
            } else if (duplicate) {
              actionReasons.push("headlines duplicate");
            } else {
              let feedRes = { ok: false, skipped: "feed alerts disabled", sent: 0, seen: 0 };
              if (WORLDMONITOR_FEED_ALERTS_ENABLED) {
                feedRes = await runWorldMonitorFeedAlertsCycle({
                  source: "monitor-headlines",
                  minLevel,
                });
              }
              if (feedRes?.ok) {
                const sent = Math.max(0, Number(feedRes?.sent || 0) || 0);
                const seen = Math.max(0, Number(feedRes?.seen || 0) || 0);
                const skipped = String(feedRes?.skipped || "").trim();
                actionReasons.push(
                  sent > 0
                    ? `headlines sent (${sent}/${seen}, min=${minLevel})`
                    : (skipped ? `headlines ${skipped}` : "headlines no new"),
                );
              } else {
                actionReasons.push(
                  `headlines ${String(feedRes?.skipped || feedRes?.error || "failed").trim() || "failed"}`,
                );
              }
              worldMonitorMonitor.lastAlertAt = Date.now();
              worldMonitorMonitor.lastAlertReason = decisionReasonText || "headlines forwarded";
              worldMonitorMonitor.lastAlertFingerprint = String(decision.fingerprint || "").trim();
              persistState();
            }
          }

          if (wantsReport) {
            let allowReport = true;
            if (isIntervalSource && !forceAlert) {
              if (!intervalReportPolicy) {
                intervalReportPolicy = evaluateWorldMonitorIntervalReportPolicy(decision, now);
                if (intervalReportPolicy.changed) persistState();
              }
              if (!intervalReportPolicy.shouldReport) {
                allowReport = false;
                actionReasons.push(`report ${intervalReportPolicy.reason}`);
              }
            }

            if (allowReport) {
              const cooldownMs = Math.max(0, Number(WORLDMONITOR_ALERT_COOLDOWN_SEC || 0) * 1000);
              const lastAlertAt = Number(worldMonitorMonitor.lastAlertAt || 0) || 0;
              const inCooldown = !forceAlert && !isIntervalSource && cooldownMs > 0 && lastAlertAt > 0 && (now - lastAlertAt) < cooldownMs;
              const duplicate = !forceAlert
                && !isIntervalSource
                && String(worldMonitorMonitor.lastAlertFingerprint || "").trim()
                && String(worldMonitorMonitor.lastAlertFingerprint || "").trim() === String(decision.fingerprint || "").trim();

              if (inCooldown) {
                actionReasons.push("report cooldown");
              } else if (duplicate) {
                actionReasons.push("report duplicate");
              } else {
                const workerId = ensureWorldMonitorWorker();
                const laneState = getWorldMonitorWorkerLaneState(workerId);
                if (laneState.busy || laneState.queued > 0) {
                  actionReasons.push(`report worker busy (queued=${laneState.queued})`);
                } else {
                  const prompt = buildWorldMonitorAlertPrompt(snapshot, decision, source);
                  await enqueuePrompt(WORLDMONITOR_ALERT_CHAT_ID, prompt, "worldmonitor-monitor", {
                    workerId,
                    setActiveWorker: false,
                    model: WORLDMONITOR_SUMMARY_MODEL,
                    reasoning: WORLDMONITOR_SUMMARY_REASONING,
                  });
                  enqueued = true;
                  const alertAt = Date.now();
                  worldMonitorMonitor.workerId = workerId;
                  worldMonitorMonitor.lastAlertAt = alertAt;
                  worldMonitorMonitor.lastAlertReason = decisionReasonText
                    || String(intervalReportPolicy?.reason || "interval report queued").trim();
                  worldMonitorMonitor.lastAlertFingerprint = String(decision.fingerprint || "").trim();
                  if (isIntervalSource) {
                    const normalized = normalizeWorldMonitorIntervalReportCounters(alertAt);
                    worldMonitorMonitor.intervalReportDayKey = normalized.dayKey || worldMonitorMonitor.intervalReportDayKey;
                    worldMonitorMonitor.intervalReportCount = Math.max(0, Number(normalized.count || 0) || 0) + 1;
                    worldMonitorMonitor.intervalReportLastAt = alertAt;
                    worldMonitorMonitor.intervalReportLastReason = String(
                      intervalReportPolicy?.reason || "interval report queued",
                    ).trim();
                  }
                  persistState();
                  actionReasons.push(
                    isIntervalSource
                      ? `report enqueued (${String(intervalReportPolicy?.reason || "interval policy").trim()})`
                      : "report enqueued",
                  );
                }
              }
            }
          }

          enqueueReason = actionReasons.length > 0 ? actionReasons.join("; ") : "no actions";
        }
      }

      if (replyChatId) {
        const factors = Array.isArray(snapshot?.globalFactors) && snapshot.globalFactors.length > 0
          ? snapshot.globalFactors.slice(0, 8).join(", ")
          : "none";
        const hotList = compactWorldMonitorCountryList(decision.hotCountries, 5) || "none";
        const topCountries = Array.isArray(snapshot?.topCountries) ? snapshot.topCountries.slice(0, 5) : [];
        const signedDelta = Number(decision?.globalDeltaSigned || 0);
        const deltaText = Number(decision?.previousGlobalScore || 0) > 0
          ? `${signedDelta >= 0 ? "+" : ""}${signedDelta.toFixed(1)} (prev ${Number(decision.previousGlobalScore || 0).toFixed(1)})`
          : "n/a (first observation)";
        const lines = [
          fmtBold("WorldMonitor Check"),
          `- source: ${source}`,
          `- fetched: ${nowIso(snapshot.fetchedAt)} (${formatRelativeAge(snapshot.fetchedAt)})`,
          `- source_url: ${String(snapshot.sourceUrl || "").trim() || "(unknown)"}`,
          `- global_risk: ${Math.round(snapshot.globalScore)}/${snapshot.globalLevel}`,
          `- delta_vs_last: ${deltaText}`,
          `- global_factors: ${factors}`,
          `- hot_countries(>=${WORLDMONITOR_MIN_COUNTRY_RISK_SCORE}): ${hotList}`,
          `- thresholds: global>=${WORLDMONITOR_MIN_GLOBAL_RISK_SCORE}, country>=${WORLDMONITOR_MIN_COUNTRY_RISK_SCORE}, delta>=${WORLDMONITOR_MIN_GLOBAL_DELTA}`,
          `- trigger: ${decision.shouldAlert ? "yes" : "no"}`,
          `- alert_action: ${enqueued ? "queued_codex_alert" : enqueueReason}`,
        ];
        if (topCountries.length > 0) {
          lines.push("- top_countries:");
          for (let i = 0; i < topCountries.length; i += 1) {
            const it = topCountries[i] || {};
            const region = String(it.region || "").trim().toUpperCase();
            const name = String(it.name || resolveWorldMonitorRegionName(region)).trim();
            const label = !region
              ? (name || "unknown")
              : (name && name.toUpperCase() !== region ? `${name} (${region})` : (name || region));
            lines.push(`  ${i + 1}. ${label}: ${Math.round(Number(it.score || 0))}`);
          }
        } else {
          lines.push("- top_countries: none");
        }
        if (decision.reasons.length > 0) {
          lines.push("- reasons:");
          for (let i = 0; i < decision.reasons.length; i += 1) {
            lines.push(`  ${i + 1}. ${decision.reasons[i]}`);
          }
        }
        await sendMessage(replyChatId, lines.join("\n"));
      }

      return {
        ok: true,
        enqueued,
        enqueueReason,
        decision,
        snapshot,
      };
    } catch (err) {
      const message = String(err?.message || err || "").trim() || "worldmonitor monitor error";
      worldMonitorMonitor.lastRunAt = now;
      worldMonitorMonitor.lastRunSource = source;
      worldMonitorMonitor.lastErrorAt = Date.now();
      worldMonitorMonitor.lastError = message;
      persistState();

      if (WORLDMONITOR_NOTIFY_ERRORS) {
        const cooldownMs = Math.max(0, Number(WORLDMONITOR_ALERT_COOLDOWN_SEC || 0) * 1000);
        const lastNotified = Number(worldMonitorMonitor.lastNotifiedErrorAt || 0) || 0;
        const canNotify = cooldownMs <= 0 || (Date.now() - lastNotified) >= cooldownMs;
        if (canNotify) {
          worldMonitorMonitor.lastNotifiedErrorAt = Date.now();
          persistState();
          await sendMessage(
            WORLDMONITOR_ALERT_CHAT_ID,
            `WorldMonitor monitor error: ${message}`,
            { silent: true },
          );
        }
      }

      if (replyChatId) {
        await sendMessage(replyChatId, `WorldMonitor check failed: ${message}`);
      }

      return { ok: false, error: message };
    } finally {
      worldMonitorRuntime.inFlight = false;
    }
  }

  function stopWorldMonitorMonitorLoop() {
    if (worldMonitorRuntime.timer) {
      clearTimeout(worldMonitorRuntime.timer);
      worldMonitorRuntime.timer = null;
    }
  }

  function buildWorldMonitorStartupCatchupWindow(now = Date.now()) {
    const hardMaxHours = Math.max(24, Math.trunc(Number(WORLDMONITOR_NATIVE_STORE_MAX_AGE_DAYS || 30) * 24) || 24);
    const configuredMinLookback = Math.max(
      6,
      Math.min(hardMaxHours, Number(WORLDMONITOR_STARTUP_CATCHUP_MIN_LOOKBACK_HOURS || WORLDMONITOR_CHECK_LOOKBACK_HOURS || 168)),
    );
    const lastSeenAt = Math.max(
      Number(worldMonitorMonitor.nativeLastRefreshAt || 0) || 0,
      Number(worldMonitorMonitor.feedAlertsLastSeenAt || 0) || 0,
      Number(worldMonitorMonitor.lastRunAt || 0) || 0,
    );
    const downtimeHours = lastSeenAt > 0
      ? Math.max(0, Math.ceil(Math.max(0, now - lastSeenAt) / (60 * 60 * 1000)))
      : 0;
    const dynamicLookback = downtimeHours > 0 ? (downtimeHours + 6) : configuredMinLookback;
    const lookbackHours = Math.max(configuredMinLookback, Math.min(hardMaxHours, dynamicLookback));
    return {
      lookbackHours,
      minPublishedAtMs: Math.max(0, now - (lookbackHours * 60 * 60 * 1000)),
      downtimeHours,
      lastSeenAt,
    };
  }

  async function runWorldMonitorStartupCatchup() {
    if (!WORLDMONITOR_MONITOR_ENABLED || !WORLDMONITOR_STARTUP_CATCHUP_ENABLED) {
      return { ok: false, skipped: "disabled" };
    }
    if (worldMonitorNativeRuntime.startupCatchupPromise) {
      return worldMonitorNativeRuntime.startupCatchupPromise;
    }

    const promise = (async () => {
      const now = Date.now();
      const window = buildWorldMonitorStartupCatchupWindow(now);
      const maxItemsPerSource = Math.max(
        WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE,
        Number(WORLDMONITOR_STARTUP_CATCHUP_ITEMS_PER_SOURCE || WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE) || WORLDMONITOR_NATIVE_FEED_ITEMS_PER_SOURCE,
      );
      const refresh = await runWorldMonitorNativeFeedRefresh({
        force: true,
        minPublishedAtMs: window.minPublishedAtMs,
        maxItemsPerSource,
      });
      const completedAt = Date.now();
      const compactStats = {
        lookback_hours: window.lookbackHours,
        downtime_hours: window.downtimeHours,
        max_items_per_source: maxItemsPerSource,
        refreshed_at: Number(refresh?.refreshedAt || 0) || 0,
        duration_ms: Number(refresh?.durationMs || 0) || 0,
        feeds_total: Math.round(Number(refresh?.stats?.feeds_total || 0) || 0),
        feeds_ok: Math.round(Number(refresh?.stats?.feeds_ok || 0) || 0),
        feeds_failed: Math.round(Number(refresh?.stats?.feeds_failed || 0) || 0),
        new_items: Math.round(Number(refresh?.stats?.new_items || 0) || 0),
        stored_items: Math.round(Number(refresh?.stats?.stored_items || worldMonitorNativeNewsItems.length) || worldMonitorNativeNewsItems.length),
      };
      worldMonitorMonitor.startupCatchupLastRunAt = completedAt;
      worldMonitorMonitor.startupCatchupLastStats = compactStats;
      if (refresh?.ok) {
        worldMonitorMonitor.startupCatchupLastErrorAt = 0;
        worldMonitorMonitor.startupCatchupLastError = "";
        persistState();
        log(
          `WorldMonitor startup catch-up complete (lookback=${window.lookbackHours}h, downtime=${window.downtimeHours}h, per_source=${maxItemsPerSource}, new_items=${compactStats.new_items}, feeds_ok=${compactStats.feeds_ok}/${compactStats.feeds_total}).`,
        );
        return {
          ok: true,
          refreshedAt: Number(refresh?.refreshedAt || completedAt) || completedAt,
          stats: compactStats,
        };
      }

      const message = String(refresh?.error || "startup catch-up failed").trim() || "startup catch-up failed";
      worldMonitorMonitor.startupCatchupLastErrorAt = completedAt;
      worldMonitorMonitor.startupCatchupLastError = message;
      persistState();
      log(`WorldMonitor startup catch-up failed: ${redactError(message)}`);
      return { ok: false, error: message, stats: compactStats };
    })().catch((err) => {
      const message = String(err?.message || err || "startup catch-up failed").trim() || "startup catch-up failed";
      worldMonitorMonitor.startupCatchupLastRunAt = Date.now();
      worldMonitorMonitor.startupCatchupLastErrorAt = Date.now();
      worldMonitorMonitor.startupCatchupLastError = message;
      worldMonitorMonitor.startupCatchupLastStats = {};
      persistState();
      log(`WorldMonitor startup catch-up failed: ${redactError(message)}`);
      return { ok: false, error: message, stats: {} };
    }).finally(() => {
      worldMonitorNativeRuntime.startupCatchupPromise = null;
    });

    worldMonitorNativeRuntime.startupCatchupPromise = promise;
    return promise;
  }

  function scheduleWorldMonitorMonitorLoop(delayMs) {
    if (getShuttingDown() || !WORLDMONITOR_MONITOR_ENABLED) return;
    stopWorldMonitorMonitorLoop();
    const ms = Math.max(1_000, Number(delayMs || 0) || Number(WORLDMONITOR_MONITOR_INTERVAL_SEC) * 1000);
    worldMonitorRuntime.timer = setTimeout(() => {
      worldMonitorRuntime.timer = null;
      void (async () => {
        const res = await runWorldMonitorMonitorCycle({ source: "interval" });
        if (!res?.ok && String(res?.error || "").trim()) {
          log(`worldmonitor monitor cycle failed: ${redactError(res.error)}`);
        }
        scheduleWorldMonitorMonitorLoop(Number(WORLDMONITOR_MONITOR_INTERVAL_SEC) * 1000);
      })();
    }, ms);
  }

  function startWorldMonitorMonitorLoop() {
    if (!WORLDMONITOR_MONITOR_ENABLED) return;
    const initialDelayMs = Math.max(0, Number(WORLDMONITOR_STARTUP_DELAY_SEC || 0) * 1000);
    scheduleWorldMonitorMonitorLoop(initialDelayMs);
  }

  async function runWorldMonitorFeedAlertsCycle(options = {}) {
    const source = String(options?.source || "interval").trim().toLowerCase() || "interval";
    const now = Date.now();
    const configuredFeedMinLevel = worldMonitorFeedAlertLevelRank(WORLDMONITOR_FEED_ALERTS_MIN_LEVEL) > 1
      ? WORLDMONITOR_FEED_ALERTS_MIN_LEVEL
      : "critical";
    const minLevelRaw = String(options?.minLevel || configuredFeedMinLevel || "critical")
      .trim()
      .toLowerCase();
    const minLevel = worldMonitorFeedAlertLevelRank(minLevelRaw) > 1
      ? minLevelRaw
      : configuredFeedMinLevel;
    const minLevelRank = worldMonitorFeedAlertLevelRank(minLevel);

    if (!WORLDMONITOR_MONITOR_ENABLED || !WORLDMONITOR_FEED_ALERTS_ENABLED) {
      return { ok: false, skipped: "disabled" };
    }
    if (worldMonitorFeedAlertsRuntime.inFlight) {
      return { ok: false, skipped: "busy" };
    }

    worldMonitorFeedAlertsRuntime.inFlight = true;
    try {
      if (Number(worldMonitorMonitor.feedAlertsLastSeenAt || 0) <= 0) {
        worldMonitorMonitor.feedAlertsLastSeenAt = now;
        worldMonitorMonitor.feedAlertsLastRunAt = now;
        worldMonitorMonitor.feedAlertsLastErrorAt = 0;
        worldMonitorMonitor.feedAlertsLastError = "";
        persistState();
        return { ok: true, skipped: "warmup", sent: 0, minLevel };
      }

      const sinceMs = Number(worldMonitorMonitor.feedAlertsLastSeenAt || 0) || 0;
      const alerts = await fetchWorldMonitorFeedAlerts({ sinceMs });
      let sent = 0;
      let maxSeenAt = sinceMs;
      const maxPerCycle = Math.max(1, Number(WORLDMONITOR_FEED_ALERTS_MAX_PER_CYCLE || 1));

      for (const alert of alerts) {
        const key = String(alert?.key || "").trim();
        const titleKey = String(alert?.titleKey || "").trim();
        const seenAt = Number(alert?.firstSeenAt || 0) || 0;
        if (seenAt > maxSeenAt) maxSeenAt = seenAt;
        if (worldMonitorFeedAlertLevelRank(alert?.threatLevel) < minLevelRank) {
          continue;
        }
        const item = findWorldMonitorItemForAlert(alert);
        const ctx = getWorldMonitorItemArticleContext(item);
        if (!isWorldMonitorAlertForwardable(alert, item, ctx)) {
          continue;
        }
        if (!key || worldMonitorFeedAlertSentKeySet.has(key)) continue;
        if (titleKey && worldMonitorFeedAlertSentTitleKeySet.has(titleKey)) continue;
        if (sent >= maxPerCycle) break;
        const bestLink = resolveWorldMonitorAlertBestLink(alert, item, ctx);
        const translatedHeadline = await translateWorldMonitorHeadlineToEnglish(String(alert?.title || ""));
        const translatedTitle = oneLine(String(translatedHeadline?.title || "")).trim();
        const outboundAlertBase = bestLink ? { ...alert, link: bestLink } : { ...alert };
        const outboundAlert = translatedTitle
          ? { ...outboundAlertBase, title: translatedTitle }
          : outboundAlertBase;
        await sendMessage(
          WORLDMONITOR_FEED_ALERTS_CHAT_ID,
          formatWorldMonitorFeedAlertMessage(outboundAlert, { item, ctx }),
        );
        rememberWorldMonitorFeedAlertKey(key);
        if (titleKey) rememberWorldMonitorFeedAlertTitleKey(titleKey);
        sent += 1;
      }

      worldMonitorMonitor.feedAlertsLastSeenAt = Math.max(
        Number(worldMonitorMonitor.feedAlertsLastSeenAt || 0) || 0,
        maxSeenAt,
      );
      worldMonitorMonitor.feedAlertsLastRunAt = now;
      worldMonitorMonitor.feedAlertsLastErrorAt = 0;
      worldMonitorMonitor.feedAlertsLastError = "";
      persistState();

      return { ok: true, sent, seen: alerts.length, minLevel, source };
    } catch (err) {
      const message = String(err?.message || err || "").trim() || "worldmonitor feed alerts error";
      worldMonitorMonitor.feedAlertsLastRunAt = now;
      worldMonitorMonitor.feedAlertsLastErrorAt = Date.now();
      worldMonitorMonitor.feedAlertsLastError = message;
      persistState();
      return { ok: false, error: message, source };
    } finally {
      worldMonitorFeedAlertsRuntime.inFlight = false;
    }
  }

  function stopWorldMonitorFeedAlertsLoop() {
    if (worldMonitorFeedAlertsRuntime.timer) {
      clearTimeout(worldMonitorFeedAlertsRuntime.timer);
      worldMonitorFeedAlertsRuntime.timer = null;
    }
  }

  function scheduleWorldMonitorFeedAlertsLoop(delayMs) {
    if (getShuttingDown() || !WORLDMONITOR_MONITOR_ENABLED || !WORLDMONITOR_FEED_ALERTS_ENABLED) return;
    stopWorldMonitorFeedAlertsLoop();
    const ms = Math.max(1_000, Number(delayMs || 0) || Number(WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC) * 1000);
    worldMonitorFeedAlertsRuntime.timer = setTimeout(() => {
      worldMonitorFeedAlertsRuntime.timer = null;
      void (async () => {
        const res = await runWorldMonitorFeedAlertsCycle({ source: "interval" });
        if (!res?.ok && String(res?.error || "").trim()) {
          log(`worldmonitor feed-alert cycle failed: ${redactError(res.error)}`);
        }
        scheduleWorldMonitorFeedAlertsLoop(Number(WORLDMONITOR_FEED_ALERTS_INTERVAL_SEC) * 1000);
      })();
    }, ms);
  }

  function startWorldMonitorFeedAlertsLoop() {
    if (!WORLDMONITOR_MONITOR_ENABLED || !WORLDMONITOR_FEED_ALERTS_ENABLED) return;
    const initialDelayMs = Math.max(0, Number(WORLDMONITOR_STARTUP_DELAY_SEC || 0) * 1000);
    scheduleWorldMonitorFeedAlertsLoop(initialDelayMs);
  }

  return {
    getWorldMonitorWorkerLaneState,
    runWorldMonitorMonitorCycle,
    stopWorldMonitorMonitorLoop,
    buildWorldMonitorStartupCatchupWindow,
    runWorldMonitorStartupCatchup,
    scheduleWorldMonitorMonitorLoop,
    startWorldMonitorMonitorLoop,
    runWorldMonitorFeedAlertsCycle,
    stopWorldMonitorFeedAlertsLoop,
    scheduleWorldMonitorFeedAlertsLoop,
    startWorldMonitorFeedAlertsLoop,
  };
}

module.exports = {
  createWorldMonitorPipelineRuntime,
};
