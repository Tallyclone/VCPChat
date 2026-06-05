const { readState, writeState } = require("./state");
const {
  projectEvents,
  applyPendingTopicActivityOrder,
} = require("../projector/appDataProjector");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPullLoop(
  config,
  centerClient,
  localIndex,
  writeIntentLock,
  logger
) {
  let stopped = true;
  let timer = null;
  let activityOrderTimer = null;
  let ws = null;
  let running = false;
  let retryMs = config.pullIntervalMs || 15000;
  const activityOrderIntervalMs =
    config.topicActivityOrderIntervalMs || 30 * 60 * 1000;
  const metrics = {
    last_reason: null,
    last_started_at: null,
    last_finished_at: null,
    last_duration_ms: 0,
    last_applied: 0,
    last_error: null,
    blocked_seq: null,
    blocked_attempts: 0,
    blocked_since: null,
    blocked_event: null,
    total_pulls: 0,
    total_events_applied: 0,
    last_activity_order_sync_at: null,
    last_activity_order_sync_result: null,
    last_activity_order_sync_error: null,
  };
  const poisonFailures = new Map();

  async function advanceStateTo(seq) {
    const state = await readState(config, logger);
    state.last_applied_seq = seq;
    state.last_pull_at = new Date().toISOString();
    await writeState(config, state, logger);
  }

  function rememberProjectionFailure(projection, events) {
    const failedSeq = projection.failedSeq;
    if (failedSeq === null || failedSeq === undefined) return;
    const key = String(failedSeq);
    const previous = poisonFailures.get(key) || {
      attempts: 0,
      first_seen_at: new Date().toISOString(),
    };
    previous.attempts += 1;
    previous.last_seen_at = new Date().toISOString();
    previous.error = projection.error ? projection.error.message : null;
    previous.event =
      events.find((event) => Number(event.seq) === Number(failedSeq)) || null;
    poisonFailures.set(key, previous);

    metrics.blocked_seq = failedSeq;
    metrics.blocked_attempts = previous.attempts;
    metrics.blocked_since = previous.first_seen_at;
    metrics.blocked_event = previous.event
      ? {
          seq: previous.event.seq,
          operation_id: previous.event.operation_id,
          entity_type: previous.event.entity_type,
          action: previous.event.action,
          device_id: previous.event.device_id,
        }
      : null;

    if (previous.attempts >= 3 && logger && logger.error) {
      logger.error("pull loop blocked by repeatedly failing projection seq", {
        failedSeq,
        attempts: previous.attempts,
        error: previous.error,
        event: metrics.blocked_event,
      });
    }
  }

  function clearProjectionBlock() {
    poisonFailures.clear();
    metrics.blocked_seq = null;
    metrics.blocked_attempts = 0;
    metrics.blocked_since = null;
    metrics.blocked_event = null;
  }

  async function pullOnce(reason = "poll") {
    if (running) return { skipped: true, reason: "already_running" };
    if (!centerClient.isConfigured())
      return { skipped: true, reason: "center_not_configured" };
    running = true;
    const startedAt = Date.now();
    metrics.last_reason = reason;
    metrics.last_started_at = new Date(startedAt).toISOString();
    metrics.last_error = null;
    try {
      let state = await readState(config, logger);
      const mode = String(state.mode || "uninitialized")
        .trim()
        .toLowerCase();
      if (mode !== "active") {
        const finishedAt = new Date().toISOString();
        stopped = true;
        metrics.last_finished_at = finishedAt;
        metrics.last_duration_ms = Date.now() - startedAt;
        metrics.last_applied = 0;
        metrics.last_error = null;
        if (timer) clearTimeout(timer);
        timer = null;
        if (activityOrderTimer) clearTimeout(activityOrderTimer);
        activityOrderTimer = null;
        if (ws) ws.close();
        ws = null;
        logger.warn("pull skipped because adapter mode is not active", {
          mode,
          reason,
        });
        return {
          ok: true,
          skipped: true,
          reason: "mode_not_active",
          mode,
        };
      }
      let afterSeq = Number(state.last_applied_seq || 0);
      let totalApplied = 0;
      let hasMore = true;

      while (hasMore && !stopped) {
        const changes = await centerClient.getChanges(afterSeq, 1000);
        const events = (changes.events || []).sort(
          (a, b) => Number(a.seq) - Number(b.seq)
        );

        if (events.length > 0) {
          const projection = await projectEvents(
            events.filter((event) => event.device_id !== config.deviceId),
            {
              config,
              localIndex,
              writeIntentLock,
              logger,
              centerClient,
              syncProfileConfig: config.syncProfileConfig,
            }
          );
          if (projection.error) {
            rememberProjectionFailure(projection, events);
            logger.error(
              "change projection failed; state cursor not advanced past failed seq",
              {
                failedSeq: projection.failedSeq,
                attempts: metrics.blocked_attempts,
                error: projection.error.message,
              }
            );
            throw projection.error;
          }
          clearProjectionBlock();
          const remoteSeqs = projection.appliedSeqs.map((seq) =>
            Number(seq || 0)
          );
          const ownSeqs = events
            .filter((event) => event.device_id === config.deviceId)
            .map((event) => Number(event.seq || 0));
          const checkpointSeq = Number(
            changes.checkpoint_seq || changes.next_after_seq || 0
          );
          const appliedMaxSeq = Math.max(
            afterSeq,
            checkpointSeq,
            ...remoteSeqs,
            ...ownSeqs
          );
          if (appliedMaxSeq > afterSeq) {
            afterSeq = appliedMaxSeq;
            await advanceStateTo(afterSeq);
          }
          totalApplied += projection.appliedSeqs.length;
        } else if (changes.checkpoint_seq || changes.next_after_seq) {
          const checkpointSeq = Number(
            changes.checkpoint_seq || changes.next_after_seq || 0
          );
          if (checkpointSeq > afterSeq) {
            afterSeq = checkpointSeq;
            await advanceStateTo(afterSeq);
          }
        }

        hasMore = !!changes.has_more;
        if (hasMore) await wait(50);
      }

      retryMs = config.pullIntervalMs || 15000;
      const durationMs = Date.now() - startedAt;
      metrics.last_finished_at = new Date().toISOString();
      metrics.last_duration_ms = durationMs;
      metrics.last_applied = totalApplied;
      metrics.total_pulls += 1;
      metrics.total_events_applied += totalApplied;
      return {
        ok: true,
        reason,
        applied: totalApplied,
        duration_ms: durationMs,
        last_applied_seq: afterSeq,
      };
    } catch (error) {
      metrics.last_error = error.message;
      metrics.last_finished_at = new Date().toISOString();
      metrics.last_duration_ms = Date.now() - startedAt;
      throw error;
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await pullOnce("poll");
      } catch (error) {
        logger.warn("pull loop failed; will retry", { error: error.message });
        retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
      }
      schedule(retryMs);
    }, delayMs);
  }

  async function syncActivityOrder(filter = {}) {
    try {
      const result = await applyPendingTopicActivityOrder(
        {
          config,
          localIndex,
          writeIntentLock,
          logger,
          centerClient,
          syncProfileConfig: config.syncProfileConfig,
        },
        filter
      );
      metrics.last_activity_order_sync_at = new Date().toISOString();
      metrics.last_activity_order_sync_result = result;
      metrics.last_activity_order_sync_error = null;
      if (logger && logger.info) {
        logger.info("pending topic activity order synced", result);
      }
      return result;
    } catch (error) {
      metrics.last_activity_order_sync_error = error.message;
      if (logger && logger.warn) {
        logger.warn("pending topic activity order sync failed", {
          error: error.message,
        });
      }
      throw error;
    }
  }

  function scheduleActivityOrderSync(delayMs = activityOrderIntervalMs) {
    if (stopped) return;
    if (activityOrderTimer) clearTimeout(activityOrderTimer);
    activityOrderTimer = setTimeout(async () => {
      try {
        await syncActivityOrder();
      } catch (error) {
        // syncActivityOrder 已记录错误；继续按固定 30 分钟节奏重试。
      }
      scheduleActivityOrderSync(activityOrderIntervalMs);
    }, delayMs);
  }

  return {
    pullOnce,
    syncActivityOrder,
    stats() {
      return {
        ...metrics,
        running,
        stopped,
        retry_ms: retryMs,
        activity_order_interval_ms: activityOrderIntervalMs,
      };
    },
    async start() {
      stopped = false;
      if (centerClient.isConfigured()) {
        ws = centerClient.connectLatestSeq(() => {
          pullOnce("websocket_latest_seq").catch((error) => {
            logger.warn("websocket-triggered pull failed", {
              error: error.message,
            });
          });
        });
      }
      schedule(1000);
      scheduleActivityOrderSync(activityOrderIntervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (activityOrderTimer) clearTimeout(activityOrderTimer);
      activityOrderTimer = null;
      if (ws) ws.close();
      ws = null;
    },
  };
}

module.exports = { createPullLoop };
