const fs = require("fs-extra");
const path = require("path");
const { checksumJson } = require("../core/hash");
const {
  diffHistory,
  applyLocalSnapshot,
} = require("../diff/historyDiffEngine");
const {
  relativeAppDataPath,
  isHistoryPath,
  parseHistoryIdentity,
} = require("../utils/pathRules");
const { readStableJson } = require("../watcher/stableFileReader");
const { shouldAdvanceIndexForLocalObservation } = require("./modePolicy");

async function walkRecentHistories(appDataRoot, currentDir, maxAgeMs, visitor) {
  if (!(await fs.pathExists(currentDir))) return;
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkRecentHistories(appDataRoot, fullPath, maxAgeMs, visitor);
      continue;
    }
    const relativePath = relativeAppDataPath(appDataRoot, fullPath);
    if (!isHistoryPath(relativePath)) continue;
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    if (Date.now() - stat.mtimeMs > maxAgeMs) continue;
    await visitor(fullPath, relativePath, stat);
  }
}

function createLocalAudit(
  config,
  localIndex,
  offlineQueue,
  writeIntentLock,
  logger,
  options = {}
) {
  let timer = null;
  let stopped = true;
  let running = false;
  let modeProvider = options.modeProvider || (() => "uninitialized");
  const intervalMs = Number(config.localAuditIntervalMs || 10 * 60 * 1000);
  const recentHistoryMaxAgeMs = Number(
    config.localAuditRecentHistoryMaxAgeMs || 24 * 60 * 60 * 1000
  );

  async function auditHistory(filePath, relativePath, context) {
    const identity = parseHistoryIdentity(relativePath, {
      appDataPath: config.appDataPath,
    });
    if (!identity)
      return {
        skipped: true,
        reason: "history_identity_missing",
        relativePath,
      };

    const read = await readStableJson(filePath);
    if (!read.ok)
      return {
        skipped: true,
        reason: "corrupt_json",
        relativePath,
        error: read.error,
      };

    const lockChecksum = checksumJson(read.value);
    if (await writeIntentLock.isLocked(relativePath, lockChecksum)) {
      return { skipped: true, reason: "write_intent_lock", relativePath };
    }

    const diff = await diffHistory(identity, read.value, localIndex, context);
    const mode = context.mode || "uninitialized";
    const enqueued = await offlineQueue.enqueueMany(diff.operations, { mode });
    if (shouldAdvanceIndexForLocalObservation(mode)) {
      await applyLocalSnapshot(localIndex, diff, enqueued);
    }
    return {
      relativePath,
      type: "history",
      operations: diff.operations.length,
      enqueued: enqueued.length,
      skipped: diff.skipped.length,
    };
  }

  async function processOnce(processOptions = {}) {
    if (running) return { skipped: true, reason: "already_running" };
    running = true;
    try {
      const mode = processOptions.mode || modeProvider();
      const context = {
        ...options,
        ...processOptions,
        mode,
        profile: processOptions.profile || options.profile || "runtime_audit",
        deviceId: config.deviceId,
        config,
      };
      const summary = { histories: 0, operations: 0, enqueued: 0, skipped: 0 };
      await walkRecentHistories(
        config.appDataPath,
        config.appDataPath,
        recentHistoryMaxAgeMs,
        async (filePath, relativePath) => {
          try {
            const result = await auditHistory(filePath, relativePath, context);
            if (result.type === "history") summary.histories += 1;
            if (result.operations) summary.operations += result.operations;
            if (result.enqueued) summary.enqueued += result.enqueued;
            if (result.skipped) summary.skipped += result.skipped;
          } catch (error) {
            summary.skipped += 1;
            logger.warn("local sync audit history failed", {
              relativePath,
              error: error.message,
            });
          }
        }
      );
      if (summary.operations > 0 || summary.skipped > 0) {
        logger.info("local sync audit completed", {
          ...summary,
          recent_history_max_age_ms: recentHistoryMaxAgeMs,
        });
      }
      return summary;
    } finally {
      running = false;
    }
  }

  async function loop() {
    if (stopped) return;
    await processOnce().catch((error) => {
      logger.warn("local sync audit failed", { error: error.message });
    });
    if (!stopped) timer = setTimeout(loop, intervalMs);
  }

  return {
    processOnce,
    async start(startOptions = {}) {
      if (startOptions.modeProvider) modeProvider = startOptions.modeProvider;
      stopped = false;
      timer = setTimeout(loop, Math.min(intervalMs, 5000));
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stats() {
      return {
        interval_ms: intervalMs,
        recent_history_max_age_ms: recentHistoryMaxAgeMs,
        running,
        stopped,
      };
    },
  };
}

module.exports = { createLocalAudit };
